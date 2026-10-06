-- Behavioural checks for Phase: Templates: saving a project as a template (Admin+ only, no people or
-- completion, dates as day offsets, integration secrets stripped), creating a project from a template
-- (offsets resolved from the chosen start date, ids remapped in rules / forms / views, copied rules
-- disabled, no task stories / inbox items / rule runs, one project story), Duplicate project and its
-- options, the copy-context mute itself, role denial on rename / delete, the seeded example, and task
-- templates from quick-add. People from earlier suites:
--   1111… member@example.com   "Member One"   (owner of the source project)
--   5555… viewer@example.com   "Vera Viewer"  (viewer; never Admin+ anywhere)
--   7777… editor@example.com   "Eddie Editor" (editor of the source project)
--   9999… nonmember@example.com

\set ON_ERROR_STOP 1

create temporary table tp_ids (name text primary key, id uuid) on commit preserve rows;
grant all on tp_ids to authenticated, anon, service_role;

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset

-- Fixtures ---------------------------------------------------------------------------------------

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  p uuid;
  s_a uuid;
  s_b uuid;
  f_pri uuid;
  f_launch uuid;
  f_people uuid;
  form uuid;
  t1 uuid;
  t2 uuid;
  t3 uuid;
  t4 uuid;
begin
  insert into public.projects (workspace_id, name, description) values (ws, 'Tpl source', 'Source description')
  returning id into p;
  insert into public.sections (project_id, name, sort_order) values (p, 'Plan', 1024) returning id into s_a;
  insert into public.sections (project_id, name, sort_order) values (p, 'Ship', 2048) returning id into s_b;
  insert into public.custom_fields (project_id, name, field_type, options, show_in_views)
  values (p, 'Priority', 'single_select', '[{"id": "hi", "name": "High", "color": "red"}, {"id": "lo", "name": "Low", "color": "zinc"}]', true)
  returning id into f_pri;
  insert into public.custom_fields (project_id, name, field_type) values (p, 'Launch', 'date') returning id into f_launch;
  insert into public.custom_fields (project_id, name, field_type) values (p, 'Reviewers', 'people') returning id into f_people;
  perform public.add_project_member(p, 'editor@example.com', 'editor');
  perform public.add_project_member(p, 'viewer@example.com', 'viewer');

  insert into public.forms (project_id, title, questions, destination_section_id, accepting_responses)
  values (p, 'Intake', jsonb_build_array(
    jsonb_build_object('id', 'q1', 'type', 'short_text', 'label', 'What', 'maps_to', jsonb_build_object('target', 'title')),
    jsonb_build_object('id', 'q2', 'type', 'single_select', 'label', 'Priority',
      'options', '[{"id": "hi", "label": "High"}, {"id": "lo", "label": "Low"}]'::jsonb,
      'maps_to', jsonb_build_object('target', 'field', 'field_id', f_pri::text))
  ), s_b, true)
  returning id into form;

  -- Enabled rules in the source: they must arrive disabled, with ids pointing at the copies.
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values (p, 'Welcome', true, 'task_created', '[{"type": "add_comment", "body": "Welcome"}]');
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions)
  values (p, 'Moved to Ship', true, 'section_changed', jsonb_build_object('section_id', s_b),
    jsonb_build_array(jsonb_build_object('type', 'set_field', 'field_id', f_pri, 'value', 'hi')));
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions)
  values (p, 'Form intake', true, 'form_submitted', jsonb_build_object('form_id', form),
    jsonb_build_array(jsonb_build_object('type', 'move_section', 'section_id', s_a)));
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values (p, 'Tell Slack', true, 'task_created',
    '[{"type": "send_slack", "message": "New: {task}", "webhook_url": "https://hooks.slack.com/services/T1/B1/secretTok"}]');

  insert into public.project_views (project_id, name, layout, config, sort_order)
  values (p, 'By priority', 'list', jsonb_build_object(
    'filters', jsonb_build_object('sections', jsonb_build_array(s_a)),
    'group_by', 'field:' || f_pri,
    'columns', jsonb_build_array('due', 'field:' || f_pri)
  ), 512);

  t1 := public.create_task(p, s_a, 'Kickoff');
  t2 := public.create_task(p, s_b, 'Launch post');
  t3 := public.create_task(p, null, 'Undated');
  insert into tp_ids values ('p', p), ('s_a', s_a), ('s_b', s_b), ('f_pri', f_pri), ('f_launch', f_launch),
    ('f_people', f_people), ('form', form), ('t1', t1), ('t2', t2), ('t3', t3);
end $$;

-- Later transactions: details on the tasks, Req # numbering, a dependency, completion.
do $$
declare
  p uuid := (select id from tp_ids where name = 'p');
  t1 uuid := (select id from tp_ids where name = 't1');
  t2 uuid := (select id from tp_ids where name = 't2');
  t4 uuid;
begin
  update public.tasks set start_on = '2026-11-05', due_on = '2026-11-10', notes = 'Kickoff notes',
    assignee_id = '77777777-7777-4777-8777-777777777777' where id = t1;
  update public.tasks set due_on = '2026-11-12' where id = t2;
  insert into public.task_field_values (task_id, field_id, value) values
    (t1, (select id from tp_ids where name = 'f_pri'), '"hi"'),
    (t1, (select id from tp_ids where name = 'f_launch'), '"2026-11-20"'),
    (t1, (select id from tp_ids where name = 'f_people'), '["77777777-7777-4777-8777-777777777777"]');
  insert into public.subtasks (task_id, title, sort_order) values (t1, 'Agenda', 1024), (t1, 'Invite', 2048);
  update public.subtasks set completed_at = now() where task_id = t1 and title = 'Agenda';
  perform public.add_task_dependency(t1, t2);
  update public.tasks set completed_at = now() where id = t1;

  insert into public.request_sequences (project_id, enabled, assign_to, add_to_title)
  values (p, true, 'all_tasks', true);
  t4 := public.create_task(p, (select id from tp_ids where name = 's_b'), 'Numbered');
  insert into tp_ids values ('t4', t4);
end $$;

do $$
begin
  assert (select title from public.tasks where id = (select id from tp_ids where name = 't4')) = '[Req #1] Numbered',
    'fixture: the source numbers its tasks';
end $$;

-- Save as template: Admin+ only ---------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
begin
  begin
    perform public.save_project_as_template((select id from tp_ids where name = 'p'), 'Nope');
    raise exception 'an editor must not save a template';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '99999999-9999-4999-8999-999999999999', false) is not null as ok \gset
do $$
begin
  begin
    perform public.save_project_as_template((select id from tp_ids where name = 'p'), 'Nope');
    raise exception 'a non-member must not save a template';
  exception when no_data_found then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset
do $$
declare
  tpl uuid;
  c jsonb;
  kickoff jsonb;
begin
  tpl := public.save_project_as_template((select id from tp_ids where name = 'p'), 'Launch plan', 'Reusable', '2026-11-01');
  insert into tp_ids values ('tpl', tpl);
  select content into c from public.project_templates where id = tpl;

  assert (select summary ->> 'tasks' from public.project_templates where id = tpl) = '4', 'summary counts four tasks';
  assert (select summary ->> 'rules' from public.project_templates where id = tpl) = '4', 'summary counts four rules';
  select t into kickoff from jsonb_array_elements(c -> 'tasks') t where t ->> 'title' = 'Kickoff';
  -- Offsets are days from the template's start date (Nov 1).
  assert (kickoff ->> 'start_offset')::int = 4, format('start offset 4: %s', kickoff);
  assert (kickoff ->> 'due_offset')::int = 9, format('due offset 9: %s', kickoff);
  assert exists (select 1 from jsonb_array_elements(kickoff -> 'fields') f where (f ->> 'offset')::int = 19),
    'date field values become offsets too';
  assert kickoff -> 'assignee_id' = 'null'::jsonb, 'templates carry no assignee';
  assert not exists (select 1 from jsonb_array_elements(kickoff -> 'fields') f
                     where f ->> 'field_id' = (select id from tp_ids where name = 'f_people')::text),
    'templates carry no people values';
  assert (kickoff ->> 'completed')::boolean = false, 'template tasks are incomplete';
  assert not exists (select 1 from jsonb_array_elements(kickoff -> 'subtasks') s where (s ->> 'completed')::boolean),
    'template subtasks are incomplete';
  assert exists (select 1 from jsonb_array_elements(c -> 'tasks') t where t ->> 'title' = 'Numbered'),
    'the Req # prefix is stripped from the title';
  assert c::text not like '%secretTok%' and c::text not like '%webhook_ref%' and c::text not like '%webhook_hint%',
    'integration URLs and refs are never copied into a template';
  assert jsonb_array_length(c -> 'members') = 0, 'templates carry no members';
  assert jsonb_array_length(c -> 'dependencies') = 1, 'the dependency is kept';
end $$;

-- Create a project from the template (anyone allowlisted) --------------------------------------------

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
declare
  result jsonb;
  np uuid;
  new_a uuid;
  new_b uuid;
  new_pri uuid;
  new_form uuid;
  kickoff public.tasks;
begin
  result := public.create_project_from_template((select id from tp_ids where name = 'tpl'), 'From template', '2027-01-01');
  np := (result ->> 'project_id')::uuid;
  insert into tp_ids values ('from_tpl', np);
  assert (result ->> 'tasks')::int = 4, format('four tasks: %s', result);
  assert (result ->> 'rules')::int = 4 and (result ->> 'rules_skipped')::int = 0, format('four rules copied: %s', result);
  assert public.project_role(np) = 'owner', 'the creator owns the new project';
  assert (select description from public.projects where id = np) = 'Source description', 'description copied';

  select id into new_a from public.sections where project_id = np and name = 'Plan' and deleted_at is null;
  select id into new_b from public.sections where project_id = np and name = 'Ship' and deleted_at is null;
  select id into new_pri from public.custom_fields where project_id = np and name = 'Priority';
  assert new_a is not null and new_b is not null and new_pri is not null, 'sections and fields copied';
  assert (select options from public.custom_fields where id = new_pri) @> '[{"id": "hi"}]', 'option ids kept';

  -- Date offset resolution from the chosen start date (Jan 1, 2027).
  select t.* into kickoff from public.tasks t join public.task_projects tp on tp.task_id = t.id and tp.project_id = np
  where t.title like '%Kickoff';
  assert kickoff.start_on = '2027-01-05' and kickoff.due_on = '2027-01-10',
    format('dates resolve from the start date: %s → %s', kickoff.start_on, kickoff.due_on);
  assert (select value from public.task_field_values v join public.custom_fields f on f.id = v.field_id
          where v.task_id = kickoff.id and f.name = 'Launch') = '"2027-01-20"', 'date field values resolve too';
  assert (select value from public.task_field_values where task_id = kickoff.id and field_id = new_pri) = '"hi"',
    'select values copied with the same option id';
  assert kickoff.completed_at is null and kickoff.assignee_id is null and kickoff.notes = 'Kickoff notes',
    'incomplete, unassigned, notes copied';
  assert (select section_id from public.task_projects where task_id = kickoff.id and project_id = np) = new_a,
    'the task lands in the copied section';
  assert (select count(*) from public.subtasks where task_id = kickoff.id and completed_at is null) = 2, 'subtasks copied open';
  assert (select due_on from public.tasks t join public.task_projects tp on tp.task_id = t.id and tp.project_id = np
          where t.title like '%Undated') is null, 'undated tasks stay undated';
  assert exists (select 1 from public.tasks t join public.task_projects tp on tp.task_id = t.id and tp.project_id = np
                 where t.title ~ '^\[Req #[1-4]\] Numbered$'), 'Req # restarts in the new project (one prefix, new number)';
  assert exists (select 1 from public.task_dependencies d where d.project_id = np and d.predecessor_id = kickoff.id),
    'dependency copied between the new tasks';

  -- Copied rules: disabled, ids remapped, secrets stripped.
  assert (select count(*) from public.rules where project_id = np and deleted_at is null) = 4, 'four rules';
  assert not exists (select 1 from public.rules where project_id = np and enabled), 'every copied rule is disabled';
  assert (select trigger_config ->> 'section_id' from public.rules where project_id = np and name = 'Moved to Ship') = new_b::text,
    'section ids in rules point at the copies';
  assert (select actions -> 0 ->> 'field_id' from public.rules where project_id = np and name = 'Moved to Ship') = new_pri::text,
    'field ids in rule actions point at the copies';
  select id into new_form from public.forms where project_id = np;
  assert (select trigger_config ->> 'form_id' from public.rules where project_id = np and name = 'Form intake') = new_form::text,
    'form ids in rules point at the copies';
  assert (select not (actions -> 0 ? 'webhook_ref') and actions -> 0 ->> 'message' = 'New: {task}'
          from public.rules where project_id = np and name = 'Tell Slack'), 'the Slack rule keeps its message, not the URL';

  -- Forms land closed, pointing at the copies; the custom view replaced the default tabs.
  assert (select not accepting_responses and destination_section_id = new_b from public.forms where id = new_form),
    'the copied form is closed and targets the copied section';
  assert (select questions -> 1 -> 'maps_to' ->> 'field_id' from public.forms where id = new_form) = new_pri::text,
    'form field mappings point at the copies';
  assert (select count(*) from public.project_views where project_id = np and deleted_at is null) = 5,
    'saved views copied (By priority + the four defaults the source had)';
  assert (select config ->> 'group_by' from public.project_views where project_id = np and name = 'By priority' and deleted_at is null)
    = 'field:' || new_pri, 'view group_by points at the copied field';

  -- Quiet copy: no task stories, inbox items, or rule runs; one project story.
  assert not exists (select 1 from public.task_stories s join public.task_projects tp on tp.task_id = s.task_id
                     where tp.project_id = np), 'no task stories for copied tasks';
  assert not exists (select 1 from public.inbox_items i join public.task_projects tp on tp.task_id = i.task_id
                     where tp.project_id = np), 'no inbox items for copied tasks';
  assert not exists (select 1 from public.rule_runs r join public.task_projects tp on tp.task_id = r.task_id
                     where tp.project_id = np), 'no rule runs for copied tasks';
  assert (select count(*) from public.project_stories where project_id = np) = 1, 'one story for the created project';
  assert (select kind = 'created_from_template' and data ->> 'template_name' = 'Launch plan'
          from public.project_stories where project_id = np), 'the story names the template';
  assert not exists (select 1 from public.task_followers f join public.task_projects tp on tp.task_id = f.task_id
                     where tp.project_id = np and f.deleted_at is null and f.profile_id = auth.uid()),
    'the creator does not follow every copied task';
end $$;

-- Duplicate project ---------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset
do $$
begin
  begin
    perform public.duplicate_project((select id from tp_ids where name = 'p'), 'Viewer copy');
    raise exception 'a viewer must not duplicate';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset
do $$
declare
  result jsonb;
  np uuid;
  kickoff public.tasks;
begin
  -- Everything, with members: dates unchanged (no start date given), completion and assignees kept.
  result := public.duplicate_project((select id from tp_ids where name = 'p'), 'Full copy',
    '{"members": true, "assignees": true, "dates": true, "rules": true}');
  np := (result ->> 'project_id')::uuid;
  insert into tp_ids values ('dup', np);
  assert (result ->> 'members')::int = 2, format('editor and viewer copied: %s', result);
  assert (select role from public.project_members where project_id = np and deleted_at is null
          and profile_id = '77777777-7777-4777-8777-777777777777') = 'editor', 'roles copied';
  select t.* into kickoff from public.tasks t join public.task_projects tp on tp.task_id = t.id and tp.project_id = np
  where t.title like '%Kickoff';
  assert kickoff.start_on = '2026-11-05' and kickoff.due_on = '2026-11-10', 'dates unchanged without a new start date';
  assert kickoff.completed_at is not null, 'completion is kept by Duplicate';
  assert kickoff.assignee_id = '77777777-7777-4777-8777-777777777777', 'the assignee (a copied member) is kept';
  assert exists (select 1 from public.task_field_values v join public.custom_fields f on f.id = v.field_id
                 where v.task_id = kickoff.id and f.name = 'Reviewers'), 'people values kept with assignees';
  assert not exists (select 1 from public.rules where project_id = np and enabled), 'duplicated rules are disabled';
  -- The assignee would normally get an "assigned" item; a copy notifies nobody and fires no rules.
  assert not exists (select 1 from public.inbox_items i join public.task_projects tp on tp.task_id = i.task_id
                     where tp.project_id = np), 'no inbox items from a duplicate';
  assert not exists (select 1 from public.rule_runs r join public.task_projects tp on tp.task_id = r.task_id
                     where tp.project_id = np), 'no rule runs from a duplicate';
  assert (select kind = 'duplicated' and data ->> 'source_project_name' = 'Tpl source'
          from public.project_stories where project_id = np), 'one duplicated story';

  -- Options off: no tasks, no rules, no members.
  result := public.duplicate_project((select id from tp_ids where name = 'p'), 'Shell copy',
    '{"tasks": false, "rules": false, "members": false, "forms": false}');
  np := (result ->> 'project_id')::uuid;
  assert (result ->> 'tasks')::int = 0, 'no tasks';
  assert not exists (select 1 from public.rules where project_id = np), 'no rules';
  assert not exists (select 1 from public.forms where project_id = np), 'no forms';
  assert (select count(*) from public.project_members where project_id = np and deleted_at is null) = 1, 'only the owner';
  assert (select count(*) from public.sections where project_id = np and deleted_at is null) = 2, 'sections still copied';

  -- Without dates, and with assignees off.
  result := public.duplicate_project((select id from tp_ids where name = 'p'), 'Undated copy',
    '{"dates": false, "assignees": false}');
  np := (result ->> 'project_id')::uuid;
  assert not exists (select 1 from public.tasks t join public.task_projects tp on tp.task_id = t.id and tp.project_id = np
                     where t.due_on is not null or t.start_on is not null or t.assignee_id is not null),
    'no dates or assignees when those options are off';
  -- Shifted: a new start date moves every date by the same number of days.
  result := public.duplicate_project((select id from tp_ids where name = 'p'), 'Shifted copy', '{"start_on": "2026-12-05"}');
  np := (result ->> 'project_id')::uuid;
  assert (select t.due_on from public.tasks t join public.task_projects tp on tp.task_id = t.id and tp.project_id = np
          where t.title like '%Kickoff') = '2026-12-10', 'dates shift from the new start date';
end $$;

-- The copy context mutes rules and notifications (same pattern as the importer) ----------------------

do $$
begin
  -- A normal task in the source fires its enabled task_created rules at commit (control).
  insert into tp_ids values ('control', public.create_task((select id from tp_ids where name = 'p'), null, 'Control'));
end $$;

do $$
begin
  perform set_config('alhc.copy_id', gen_random_uuid()::text, true);
  insert into tp_ids values ('muted', public.create_task((select id from tp_ids where name = 'p'), null, 'Muted'));
  update public.tasks set assignee_id = '77777777-7777-4777-8777-777777777777'
  where id = (select id from tp_ids where name = 'muted');
end $$;

do $$
begin
  assert exists (select 1 from public.rule_runs where task_id = (select id from tp_ids where name = 'control')),
    'control: rules fire for a normal task';
  assert not exists (select 1 from public.rule_runs where task_id = (select id from tp_ids where name = 'muted')),
    'no rule runs while the copy context is set';
  assert not exists (select 1 from public.inbox_items where task_id = (select id from tp_ids where name = 'muted')),
    'no inbox items while the copy context is set';
  assert not exists (select 1 from public.task_stories where task_id = (select id from tp_ids where name = 'muted')),
    'no task stories while the copy context is set';
  assert current_setting('alhc.copy_id', true) is null or current_setting('alhc.copy_id', true) = '',
    'the copy context ends with its transaction';
end $$;

reset role;
do $$
declare
  r uuid;
begin
  -- Even a snapshot (or caller) that asks for an enabled rule gets a disabled one during a copy.
  perform set_config('alhc.copy_id', gen_random_uuid()::text, true);
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values ((select id from tp_ids where name = 'from_tpl'), 'Sneaky', true, 'task_created', '[{"type": "add_comment", "body": "x"}]')
  returning id into r;
  assert not (select enabled from public.rules where id = r), 'rules inserted during a copy are always disabled';
  update public.rules set deleted_at = now() where id = r;
end $$;
set role authenticated;

-- Rename / delete: Admin+ only ----------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
begin
  assert not public.can_manage_project_template((select id from tp_ids where name = 'tpl')),
    'an editor of the source cannot manage its template';
  begin
    perform public.delete_project_template((select id from tp_ids where name = 'tpl'));
    raise exception 'an editor must not delete a template';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.update_project_template((select id from tp_ids where name = 'tpl'), 'Renamed');
    raise exception 'an editor must not rename a template';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.save_project_as_template((select id from tp_ids where name = 'from_tpl'), 'Hijack', null, null,
      (select id from tp_ids where name = 'tpl'));
    raise exception 'an editor must not replace a template';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset
do $$
begin
  assert not exists (
    select 1 from public.project_members m join public.projects p on p.id = m.project_id and p.deleted_at is null
    where m.profile_id = '55555555-5555-4555-8555-555555555555' and m.deleted_at is null and m.role in ('owner', 'admin')
  ), 'fixture: the viewer is not Admin+ anywhere';
  -- Everyone allowlisted sees the gallery, including the seeded example.
  assert exists (select 1 from public.project_templates where name = 'Creative Requests' and is_example and deleted_at is null),
    'the seeded example is visible';
  assert exists (select 1 from public.project_templates where id = (select id from tp_ids where name = 'tpl')),
    'saved templates are visible workspace-wide';
  begin
    perform public.delete_project_template('00000000-0000-4000-8000-0000000000c1');
    raise exception 'a non-admin must not delete the example';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.project_templates set deleted_at = now() where id = (select id from tp_ids where name = 'tpl');
    raise exception 'clients cannot write templates directly';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset
do $$
begin
  assert public.can_manage_project_template((select id from tp_ids where name = 'tpl')), 'the source owner manages it';
  perform public.update_project_template((select id from tp_ids where name = 'tpl'), 'Launch plan v2', 'Updated');
  assert (select name from public.project_templates where id = (select id from tp_ids where name = 'tpl')) = 'Launch plan v2',
    'renamed';
  perform public.delete_project_template((select id from tp_ids where name = 'tpl'));
  assert (select deleted_at is not null from public.project_templates where id = (select id from tp_ids where name = 'tpl')),
    'soft-deleted';
  begin
    perform public.create_project_from_template((select id from tp_ids where name = 'tpl'), 'Too late');
    raise exception 'a deleted template cannot be used';
  exception when no_data_found then null;
  end;
end $$;

-- The seeded example ----------------------------------------------------------------------------------

do $$
declare
  result jsonb;
  np uuid;
begin
  result := public.create_project_from_template('00000000-0000-4000-8000-0000000000c1', 'Creative Requests');
  np := (result ->> 'project_id')::uuid;
  assert (select string_agg(name, ',' order by sort_order) from public.sections where project_id = np and deleted_at is null)
    = 'Intake,In Progress,Review,Approved,Delivered', 'example sections';
  assert (select string_agg(name, ',' order by sort_order) from public.custom_fields where project_id = np and deleted_at is null)
    = 'Request type,Due date priority', 'example fields';
  assert (select count(*) from public.tasks where home_project_id = np) = 0, 'nothing more specific than that';
  assert (select count(*) from public.project_views where project_id = np and deleted_at is null) = 4, 'default view tabs';
  -- The member owns a project, so (with no live source project) they can manage the example.
  assert public.can_manage_project_template('00000000-0000-4000-8000-0000000000c1'), 'project admins manage the example';
end $$;

-- Task templates ----------------------------------------------------------------------------------------

do $$
declare
  p uuid := (select id from tp_ids where name = 'p');
  tt uuid;
  t uuid;
begin
  tt := public.save_task_as_template((select id from tp_ids where name = 't1'), p, 'Kickoff template', true);
  insert into tp_ids values ('tt', tt);
  assert (select title = 'Kickoff' and notes = 'Kickoff notes' and jsonb_array_length(subtasks) = 2
            and assignee_id = '77777777-7777-4777-8777-777777777777'
          from public.task_templates where id = tt), 'task template captures title, notes, subtasks, assignee';
  assert (select jsonb_array_length(field_values) from public.task_templates where id = tt) = 3, 'and field values';

  t := public.create_task_from_template(tt, (select id from tp_ids where name = 's_b'), 'From quick-add');
  insert into tp_ids values ('tt_task', t);
  assert (select title from public.tasks where id = t) like '[Req #%] From quick-add', 'typed title wins (and gets a Req #)';
  assert (select assignee_id from public.tasks where id = t) = '77777777-7777-4777-8777-777777777777', 'assignee set';
  assert (select count(*) from public.subtasks where task_id = t and completed_at is null) = 2, 'subtasks created open';
  assert (select count(*) from public.task_field_values where task_id = t) = 3, 'field values set';
  assert (select section_id from public.task_projects where task_id = t and project_id = p)
    = (select id from tp_ids where name = 's_b'), 'lands in the chosen section';
end $$;

-- Inbox items are recipient-only, so check as the database owner.
reset role;
do $$
declare
  t uuid := (select id from tp_ids where name = 'tt_task');
begin
  -- A task from a task template is a normal task: stories, the assignee's inbox item, rules at commit.
  assert exists (select 1 from public.task_stories where task_id = t and kind = 'created'), 'created story';
  assert exists (select 1 from public.inbox_items where task_id = t and kind = 'assigned'), 'the assignee is notified';
  assert exists (select 1 from public.rule_runs where task_id = t), 'task_created rules fire';
end $$;
set role authenticated;

select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset
do $$
begin
  assert exists (select 1 from public.task_templates where id = (select id from tp_ids where name = 'tt')), 'viewers can see task templates';
  begin
    perform public.create_task_from_template((select id from tp_ids where name = 'tt'));
    raise exception 'a viewer must not use a task template';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '99999999-9999-4999-8999-999999999999', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.task_templates where id = (select id from tp_ids where name = 'tt')),
    'non-members never see a project''s task templates';
end $$;

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
begin
  -- Editors can rename task templates but only Admins can delete them.
  update public.task_templates set name = 'Kickoff (edited)' where id = (select id from tp_ids where name = 'tt');
  assert (select name from public.task_templates where id = (select id from tp_ids where name = 'tt')) = 'Kickoff (edited)',
    'editors edit task templates';
  begin
    update public.task_templates set deleted_at = now() where id = (select id from tp_ids where name = 'tt');
    raise exception 'an editor must not delete a task template';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset
do $$
begin
  update public.task_templates set deleted_at = now() where id = (select id from tp_ids where name = 'tt');
  assert (select deleted_at is not null from public.task_templates where id = (select id from tp_ids where name = 'tt')),
    'admins delete task templates (soft)';
  begin
    insert into public.task_templates (project_id, name, title, subtasks)
    values ((select id from tp_ids where name = 'p'), 'Bad', 'Bad', '[1, 2]');
    raise exception 'subtasks must be titles';
  exception when check_violation then null;
  end;
end $$;

reset role;

do $$
begin
  assert not has_function_privilege('anon', 'public.create_project_from_template(uuid, text, date)', 'execute'),
    'anon cannot use templates';
  assert not has_function_privilege('authenticated', 'public.project_snapshot(uuid, jsonb)', 'execute'),
    'the snapshot helper is internal';
  assert not has_function_privilege('authenticated', 'public.instantiate_project_snapshot(jsonb, text, date, uuid, text, jsonb)', 'execute'),
    'the instantiate helper is internal';
  assert not (select prosecdef from pg_proc where proname = 'create_task_from_template'),
    'task templates run as the caller';
end $$;

select 'templates smoke: all assertions passed' as result;
