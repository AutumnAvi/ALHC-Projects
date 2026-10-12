-- Behavioural checks for Phase: Asana parity, batch 4: rule branches (Check if / Else if / Otherwise)
-- through run_rule, validate_rule, delayed jobs, the secret stash, and copies; field descriptions, the
-- field library (list_field_library), and "notify collaborators when changed"; Heading and Email form
-- questions; and the Browse projects people / last modified (browse_project_people).
-- Fresh people for this suite:
--   fdfd…01 ap4-owner@example.com    owner of AP4 P and AP4 Team P (lead of AP4 Team)
--   fdfd…02 ap4-editor@example.com   Editor of AP4 P
--   fdfd…03 ap4-viewer@example.com   Viewer of AP4 P, member of AP4 Team
--   fdfd…04 ap4-other@example.com    no memberships, not in AP4 Team
--   fdfd…05 ap4-admin@example.com    workspace admin, no memberships

\set ON_ERROR_STOP 1

create temporary table ap4_ids (name text primary key, id uuid) on commit preserve rows;
grant all on ap4_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('ap4-owner@example.com', 'asana parity 4 suite'),
  ('ap4-editor@example.com', 'asana parity 4 suite'),
  ('ap4-viewer@example.com', 'asana parity 4 suite'),
  ('ap4-other@example.com', 'asana parity 4 suite'),
  ('ap4-admin@example.com', 'asana parity 4 suite');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('fdfdfdfd-0000-4000-8000-000000000001', 'ap4-owner@example.com', now(), '{"full_name":"Orla Owner"}'),
  ('fdfdfdfd-0000-4000-8000-000000000002', 'ap4-editor@example.com', now(), '{"full_name":"Eli Editor"}'),
  ('fdfdfdfd-0000-4000-8000-000000000003', 'ap4-viewer@example.com', now(), '{"full_name":"Vera Viewer"}'),
  ('fdfdfdfd-0000-4000-8000-000000000004', 'ap4-other@example.com', now(), '{"full_name":"Otto Other"}'),
  ('fdfdfdfd-0000-4000-8000-000000000005', 'ap4-admin@example.com', now(), '{"full_name":"Ada Admin"}');
insert into public.workspace_admins (workspace_id, profile_id)
values ('00000000-0000-4000-8000-000000000001', 'fdfdfdfd-0000-4000-8000-000000000005');

-- EXECUTE surface: the two new definer RPCs are for signed-in people only; helpers stay internal. -------

do $$
begin
  assert has_function_privilege('authenticated', 'public.list_field_library()', 'execute'), 'members list the library';
  assert has_function_privilege('authenticated', 'public.browse_project_people(uuid)', 'execute'), 'members browse';
  assert not has_function_privilege('anon', 'public.list_field_library()', 'execute'), 'anon can''t list the library';
  assert not has_function_privilege('anon', 'public.browse_project_people(uuid)', 'execute'), 'anon can''t browse';
  assert not has_function_privilege('authenticated', 'public.rule_pick_branch(public.rules, uuid, jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.rule_pick_branch(public.rules, uuid, jsonb)', 'execute'),
    'branch picking runs inside run_rule only';
  assert not has_function_privilege('authenticated', 'public.on_task_field_value_notify()', 'execute')
    and not has_function_privilege('anon', 'public.on_task_field_value_notify()', 'execute'),
    'the notify trigger isn''t callable';
  assert not has_function_privilege('anon', 'public.validate_rule_branches(jsonb, jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.rule_branch_items(jsonb, integer)', 'execute')
    and not has_function_privilege('anon', 'public.rule_branch_count(jsonb, jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.rule_item_branch(jsonb)', 'execute'), 'anon gets no helper';
  assert (select prosecdef from pg_proc where oid = 'public.list_field_library()'::regprocedure)
    and (select prosecdef from pg_proc where oid = 'public.browse_project_people(uuid)'::regprocedure),
    'both RPCs are definer (pinned in suite 60)';
  assert not (select prosecdef from pg_proc where oid = 'public.rule_pick_branch(public.rules, uuid, jsonb)'::regprocedure),
    'rule_pick_branch is invoker';
  assert (select array_agg(attname::text order by attnum) from pg_attribute
          where attrelid = 'public.custom_fields'::regclass and attname in ('description', 'notify_on_change', 'in_library'))
         = array['notify_on_change', 'in_library', 'description'], 'the new field columns exist';
end $$;

-- Setup: AP4 P with sections, a Priority field, and members ------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'fdfdfdfd-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  p uuid;
  f uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'AP4 P') returning id into p;
  perform public.add_project_member(p, 'ap4-editor@example.com', 'editor');
  perform public.add_project_member(p, 'ap4-viewer@example.com', 'viewer');
  insert into ap4_ids values ('p', p);
  insert into public.sections (project_id, name, sort_order) values (p, 'Intake', 1024) returning id into f;
  insert into ap4_ids values ('s_intake', f);
  insert into public.sections (project_id, name, sort_order) values (p, 'Review', 2048) returning id into f;
  insert into ap4_ids values ('s_review', f);
  insert into public.sections (project_id, name, sort_order) values (p, 'Done', 3072) returning id into f;
  insert into ap4_ids values ('s_done', f);
  insert into public.custom_fields (project_id, name, field_type, options)
  values (p, 'Priority', 'single_select',
    '[{"id": "hi", "name": "High", "color": "red"}, {"id": "lo", "name": "Low", "color": "green"}]')
  returning id into f;
  insert into ap4_ids values ('f_priority', f);
end $$;

-- Rule branches ----------------------------------------------------------------------------------------

do $$
declare
  p uuid := (select id from ap4_ids where name = 'p');
  f uuid := (select id from ap4_ids where name = 'f_priority');
  review uuid := (select id from ap4_ids where name = 's_review');
  r uuid;
  stored jsonb;
begin
  -- Check if Priority = High → "high"; Else if assigned → "assigned"; Otherwise → "otherwise".
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, conditions, actions)
  values (p, 'Branches', true, 'section_changed', jsonb_build_object('section_id', review),
    jsonb_build_array(
      jsonb_build_object('type', 'field_equals', 'field_id', f, 'value', 'hi'),
      jsonb_build_object('type', 'assignee_is_set', 'branch', 1)
    ),
    jsonb_build_array(
      jsonb_build_object('type', 'add_comment', 'body', 'high'),
      jsonb_build_object('type', 'add_comment', 'body', 'assigned', 'branch', 1),
      jsonb_build_object('type', 'add_comment', 'body', 'otherwise', 'branch', 2)
    ))
  returning id into r;
  insert into ap4_ids values ('r_branches', r);
  assert public.rule_branch_count((select conditions from public.rules where id = r), (select actions from public.rules where id = r)) = 3,
    'three branches';

  -- An unbranched rule: every condition must pass and every action runs, as before.
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, conditions, actions)
  values (p, 'Plain', true, 'section_changed', jsonb_build_object('section_id', (select id from ap4_ids where name = 's_done')),
    '[{"type": "is_incomplete"}]'::jsonb,
    '[{"type": "add_comment", "body": "plain one"}, {"type": "add_comment", "body": "plain two"}]'::jsonb)
  returning id into r;
  insert into ap4_ids values ('r_plain', r);

  -- Validation.
  begin
    insert into public.rules (project_id, name, trigger_type, actions)
    values (p, 'Bad key', 'task_created', '[{"type": "add_comment", "body": "x", "branch": "one"}]');
    raise exception 'a non-numeric branch must be refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.rules (project_id, name, trigger_type, conditions, actions)
    values (p, 'Too many', 'task_created', '[{"type": "is_complete"}]',
      '[{"type": "add_comment", "body": "x"}, {"type": "add_comment", "body": "y", "branch": 5}]');
    raise exception 'a branch above 4 must be refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.rules (project_id, name, trigger_type, conditions, actions)
    values (p, 'Empty branch', 'task_created', '[{"type": "is_complete"}, {"type": "is_incomplete", "branch": 1}]',
      '[{"type": "add_comment", "body": "x"}]');
    raise exception 'a branch without actions must be refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.rules (project_id, name, trigger_type, conditions, actions)
    values (p, 'Early otherwise', 'task_created', '[{"type": "is_complete", "branch": 1}]',
      '[{"type": "add_comment", "body": "x"}, {"type": "add_comment", "body": "y", "branch": 1}]');
    raise exception 'only the last branch may have no conditions';
  exception when check_violation then null;
  end;
  begin
    insert into public.rules (project_id, name, trigger_type, conditions, actions)
    values (p, 'Fractional', 'task_created', '[{"type": "is_complete"}]',
      '[{"type": "add_comment", "body": "x"}, {"type": "add_comment", "body": "y", "branch": 1.5}]');
    raise exception 'a fractional branch must be refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.rules (project_id, name, trigger_type, conditions, actions)
    values (p, 'Eleven', 'task_created', '[{"type": "is_complete"}]',
      (select jsonb_agg(jsonb_build_object('type', 'add_comment', 'body', 'x' || i)) from generate_series(1, 11) i)
      || '[{"type": "add_comment", "body": "else", "branch": 1}]'::jsonb);
    raise exception 'more than 10 actions in a branch must be refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.rules (project_id, name, trigger_type, actions)
    values (p, 'Still eleven', 'task_created',
      (select jsonb_agg(jsonb_build_object('type', 'add_comment', 'body', 'x' || i)) from generate_series(1, 11) i));
    raise exception 'an unbranched rule keeps the 10-action limit';
  exception when check_violation then null;
  end;
  -- Ten actions in each of two branches is fine (and the Otherwise branch may have no conditions).
  insert into public.rules (project_id, name, trigger_type, conditions, actions)
  values (p, 'Twenty', 'task_created', '[{"type": "is_complete"}]',
    (select jsonb_agg(jsonb_build_object('type', 'add_comment', 'body', 'x' || i)) from generate_series(1, 10) i)
    || (select jsonb_agg(jsonb_build_object('type', 'add_comment', 'body', 'y' || i, 'branch', 1)) from generate_series(1, 10) i));

  -- A Slack URL typed into an Else-if action is stashed like any other (the branch key stays).
  insert into public.rules (project_id, name, trigger_type, conditions, actions)
  values (p, 'Stash', 'task_created', '[{"type": "is_complete"}]',
    '[{"type": "add_comment", "body": "x"},
      {"type": "send_slack", "message": "hi", "webhook_url": "https://hooks.slack.com/services/T000/B000/abcd1234", "branch": 1}]')
  returning id into r;
  stored := (select actions -> 1 from public.rules where id = r);
  assert not stored ? 'webhook_url' and stored ? 'webhook_ref' and stored ->> 'branch' = '1',
    'the URL leaves the rule, the branch key stays';
  insert into ap4_ids values ('r_stash', r);
end $$;

-- Tasks for the branches (created in their own transaction, so moves fire section rules).
select set_config('request.jwt.claim.sub', 'fdfdfdfd-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from ap4_ids where name = 'p');
  intake uuid := (select id from ap4_ids where name = 's_intake');
  t uuid;
begin
  t := public.create_task(p, intake, 'High one');
  insert into public.task_field_values (task_id, field_id, value) values (t, (select id from ap4_ids where name = 'f_priority'), '"hi"');
  update public.tasks set assignee_id = 'fdfdfdfd-0000-4000-8000-000000000002' where id = t;
  insert into ap4_ids values ('t_high', t);
  t := public.create_task(p, intake, 'Assigned one');
  update public.tasks set assignee_id = 'fdfdfdfd-0000-4000-8000-000000000002' where id = t;
  insert into ap4_ids values ('t_assigned', t);
  t := public.create_task(p, intake, 'Plain one');
  insert into ap4_ids values ('t_plain', t);
end $$;

do $$
declare
  review uuid := (select id from ap4_ids where name = 's_review');
  r uuid := (select id from ap4_ids where name = 'r_branches');
  t_high uuid := (select id from ap4_ids where name = 't_high');
  t_assigned uuid := (select id from ap4_ids where name = 't_assigned');
  t_plain uuid := (select id from ap4_ids where name = 't_plain');
begin
  update public.task_projects set section_id = review where task_id in (t_high, t_assigned, t_plain);

  assert (select array_agg(body order by body) from public.comments where task_id = t_high and rule_id = r) = array['high'],
    'Check if wins (even though the Else if would match too): only its actions run';
  assert (select array_agg(body order by body) from public.comments where task_id = t_assigned and rule_id = r) = array['assigned'],
    'the Else if runs when the Check if fails';
  assert (select array_agg(body order by body) from public.comments where task_id = t_plain and rule_id = r) = array['otherwise'],
    'Otherwise runs when nothing else matches';
  assert (select (detail ->> 'branch')::int from public.rule_runs where rule_id = r and task_id = t_high) = 0
    and (select (detail ->> 'branch')::int from public.rule_runs where rule_id = r and task_id = t_assigned) = 1
    and (select (detail ->> 'branch')::int from public.rule_runs where rule_id = r and task_id = t_plain) = 2,
    'the run log records the branch taken';

  -- The unbranched rule behaves as before.
  update public.task_projects set section_id = (select id from ap4_ids where name = 's_done') where task_id = t_plain;
  assert (select array_agg(body order by body) from public.comments
          where task_id = t_plain and rule_id = (select id from ap4_ids where name = 'r_plain')) = array['plain one', 'plain two'],
    'every action of an unbranched rule runs';
  assert not (select detail ? 'branch' from public.rule_runs
              where rule_id = (select id from ap4_ids where name = 'r_plain') and task_id = t_plain),
    'unbranched runs log no branch';
end $$;

-- No branch matches (and nothing is otherwise): the run is a conditions miss, nothing happens.
select set_config('request.jwt.claim.sub', 'fdfdfdfd-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from ap4_ids where name = 'p');
  r uuid;
  t uuid;
begin
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, conditions, actions)
  values (p, 'No otherwise', true, 'section_changed', jsonb_build_object('section_id', (select id from ap4_ids where name = 's_intake')),
    '[{"type": "is_complete"}, {"type": "assignee_is_set", "branch": 1}]',
    '[{"type": "add_comment", "body": "done"}, {"type": "add_comment", "body": "assigned", "branch": 1},
      {"type": "delay", "hours": 1, "branch": 1}, {"type": "add_comment", "body": "assigned later", "branch": 1}]')
  returning id into r;
  insert into ap4_ids values ('r_delay', r);
  t := public.create_task(p, (select id from ap4_ids where name = 's_done'), 'Nobody');
  insert into ap4_ids values ('t_nobody', t);
  t := public.create_task(p, (select id from ap4_ids where name = 's_done'), 'Somebody');
  update public.tasks set assignee_id = 'fdfdfdfd-0000-4000-8000-000000000002' where id = t;
  insert into ap4_ids values ('t_somebody', t);
  t := public.create_task(p, (select id from ap4_ids where name = 's_done'), 'Somebody else');
  update public.tasks set assignee_id = 'fdfdfdfd-0000-4000-8000-000000000002' where id = t;
  insert into ap4_ids values ('t_unassigned_later', t);
end $$;

do $$
declare
  r uuid := (select id from ap4_ids where name = 'r_delay');
  intake uuid := (select id from ap4_ids where name = 's_intake');
begin
  update public.task_projects set section_id = intake
  where task_id in ((select id from ap4_ids where name = 't_nobody'), (select id from ap4_ids where name = 't_somebody'),
                    (select id from ap4_ids where name = 't_unassigned_later'));
  assert not exists (select 1 from public.comments where task_id = (select id from ap4_ids where name = 't_nobody') and rule_id = r),
    'no branch matched: nothing ran';
  assert not exists (select 1 from public.rule_runs where rule_id = r and task_id = (select id from ap4_ids where name = 't_nobody')),
    'a conditions miss is not logged (as before)';
  assert (select array_agg(body) from public.comments where task_id = (select id from ap4_ids where name = 't_somebody') and rule_id = r)
         = array['assigned'], 'the Else if ran up to its delay';
  assert (select count(*) from public.scheduled_rule_actions where rule_id = r and status = 'pending') = 2, 'both delays are scheduled';
  assert (select actions -> 0 ->> 'branch' from public.scheduled_rule_actions
          where rule_id = r and task_id = (select id from ap4_ids where name = 't_somebody')) = '1',
    'the remaining actions keep their branch';
  -- One of them stops matching its branch before the delay ends.
  update public.tasks set assignee_id = null where id = (select id from ap4_ids where name = 't_unassigned_later');
end $$;

reset role;
update public.scheduled_rule_actions set run_at = now() - interval '1 minute'
where rule_id = (select id from ap4_ids where name = 'r_delay');
set role service_role;
select public.workflow_tick() is not null as ticked \gset
reset role;

do $$
declare
  r uuid := (select id from ap4_ids where name = 'r_delay');
begin
  assert (select array_agg(body order by body) from public.comments
          where task_id = (select id from ap4_ids where name = 't_somebody') and rule_id = r) = array['assigned', 'assigned later'],
    'the delayed job resumed its branch (its own condition still holds)';
  assert (select status from public.scheduled_rule_actions
          where rule_id = r and task_id = (select id from ap4_ids where name = 't_unassigned_later')) = 'cancelled',
    'a delayed job whose branch stopped matching is cancelled';
  assert not exists (select 1 from public.comments
                     where task_id = (select id from ap4_ids where name = 't_unassigned_later') and body = 'assigned later'),
    'and its remaining actions never run';
end $$;

-- A delayed job whose branch was deleted from the rule meanwhile is cancelled, not run unchecked.
set role authenticated;
select set_config('request.jwt.claim.sub', 'fdfdfdfd-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from ap4_ids where name = 'p');
  t uuid;
begin
  t := public.create_task(p, (select id from ap4_ids where name = 's_done'), 'Orphaned delay');
  update public.tasks set assignee_id = 'fdfdfdfd-0000-4000-8000-000000000002' where id = t;
  insert into ap4_ids values ('t_orphan', t);
end $$;

do $$
declare
  r uuid := (select id from ap4_ids where name = 'r_delay');
  t uuid := (select id from ap4_ids where name = 't_orphan');
begin
  update public.task_projects set section_id = (select id from ap4_ids where name = 's_intake') where task_id = t;
  assert exists (select 1 from public.scheduled_rule_actions where rule_id = r and task_id = t and status = 'pending'),
    'the Else if scheduled its remaining actions';
  update public.rules set conditions = '[{"type": "is_complete"}]', actions = '[{"type": "add_comment", "body": "done"}]'
  where id = r;
end $$;

reset role;
update public.scheduled_rule_actions set run_at = now() - interval '1 minute'
where rule_id = (select id from ap4_ids where name = 'r_delay');
set role service_role;
select public.workflow_tick() is not null as ticked \gset
reset role;

do $$
declare
  r uuid := (select id from ap4_ids where name = 'r_delay');
  t uuid := (select id from ap4_ids where name = 't_orphan');
begin
  assert (select status from public.scheduled_rule_actions where rule_id = r and task_id = t) = 'cancelled',
    'the job of a branch that no longer exists is cancelled';
  assert not exists (select 1 from public.comments where task_id = t and body = 'assigned later'),
    'and its remaining actions never run';
end $$;

-- Copies keep branches (and land disabled like every copied rule).
set role authenticated;
select set_config('request.jwt.claim.sub', 'fdfdfdfd-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  copy uuid;
  result jsonb;
begin
  result := public.duplicate_project((select id from ap4_ids where name = 'p'), 'AP4 P copy',
    '{"tasks": false, "rules": true, "forms": false, "members": false}');
  copy := (result ->> 'project_id')::uuid;
  assert (select conditions -> 1 ->> 'branch' = '1' and actions -> 2 ->> 'branch' = '2' and not enabled
          from public.rules where project_id = copy and name = 'Branches'),
    'a duplicated rule keeps its branches and starts off';
  assert (select actions -> 1 ->> 'branch' = '1' and not (actions -> 1 ? 'webhook_ref')
          from public.rules where project_id = copy and name = 'Stash'),
    'a copied Slack action keeps its branch but not the saved URL';
end $$;

-- Fields: description, notify, library --------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'fdfdfdfd-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from ap4_ids where name = 'p');
  f uuid := (select id from ap4_ids where name = 'f_priority');
  status_field uuid;
begin
  update public.custom_fields
  set description = 'How urgent it is', notify_on_change = true, in_library = true
  where id = f;
  assert (select description = 'How urgent it is' and notify_on_change and in_library from public.custom_fields where id = f),
    'an Editor sets the description, notify, and library flags';
  begin
    update public.custom_fields set description = repeat('x', 2001) where id = f;
    raise exception 'descriptions are limited to 2000 characters';
  exception when check_violation then null;
  end;

  insert into public.custom_fields (project_id, name, field_type, bound_to_sections, show_in_views)
  values (p, 'Status', 'single_select', true, true) returning id into status_field;
  begin
    update public.custom_fields set notify_on_change = true where id = status_field;
    raise exception 'the section-bound Status can''t notify';
  exception when check_violation then null;
  end;
  begin
    update public.custom_fields set in_library = true where id = status_field;
    raise exception 'the section-bound Status can''t join the library';
  exception when check_violation then null;
  end;

  insert into public.custom_fields (project_id, name, field_type, in_library, description)
  values (p, 'Gone later', 'text', true, 'Removed below') returning id into status_field;
  insert into ap4_ids values ('f_gone', status_field);
  insert into public.custom_fields (project_id, name, field_type) values (p, 'Not shared', 'number');
end $$;

select set_config('request.jwt.claim.sub', 'fdfdfdfd-0000-4000-8000-000000000003', false) is not null as ok \gset

do $$
begin
  update public.custom_fields set in_library = false where id = (select id from ap4_ids where name = 'f_priority');
  assert (select in_library from public.custom_fields where id = (select id from ap4_ids where name = 'f_priority')),
    'a Viewer can''t change a field';
end $$;

-- Someone with no membership sees library fields (name, type, description, options) and nothing else.
select set_config('request.jwt.claim.sub', 'fdfdfdfd-0000-4000-8000-000000000004', false) is not null as ok \gset

do $$
declare
  lib record;
begin
  assert not exists (select 1 from public.custom_fields where id = (select id from ap4_ids where name = 'f_priority')),
    'the field itself stays unreadable to non-members';
  select * into lib from public.list_field_library() where field_id = (select id from ap4_ids where name = 'f_priority');
  assert lib.name = 'Priority' and lib.field_type = 'single_select' and lib.description = 'How urgent it is'
    and jsonb_array_length(lib.options) = 2, 'the library lists the definition';
  assert exists (select 1 from public.list_field_library() where name = 'Gone later'), 'every library field is listed';
  assert not exists (select 1 from public.list_field_library() where name in ('Not shared', 'Status')),
    'fields outside the library (and the Status field) are not';
  assert (select array_agg(name order by ordinality) from unnest((select proargnames from pg_proc
          where oid = 'public.list_field_library()'::regprocedure)) with ordinality name)
         = array['field_id', 'name', 'field_type', 'description', 'options'],
    'it returns the definition only: no project name or id';
end $$;

select set_config('request.jwt.claim.sub', 'fdfdfdfd-0000-4000-8000-000000000002', false) is not null as ok \gset
update public.custom_fields set deleted_at = now() where id = (select id from ap4_ids where name = 'f_gone');

select set_config('request.jwt.claim.sub', 'fdfdfdfd-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.list_field_library() where name = 'Gone later'), 'deleted fields leave the library';
end $$;

-- Notify collaborators when changed.
select set_config('request.jwt.claim.sub', 'fdfdfdfd-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from ap4_ids where name = 'p');
  f uuid := (select id from ap4_ids where name = 'f_priority');
  t uuid;
begin
  t := public.create_task(p, (select id from ap4_ids where name = 's_done'), 'Watched');
  -- Set while the task is being created: nobody is told.
  insert into public.task_field_values (task_id, field_id, value) values (t, f, '"lo"');
  insert into public.task_followers (task_id, profile_id) values (t, 'fdfdfdfd-0000-4000-8000-000000000003');
  insert into public.task_followers (task_id, profile_id) values (t, 'fdfdfdfd-0000-4000-8000-000000000001');
  insert into ap4_ids values ('t_watched', t);
end $$;

do $$
declare
  t uuid := (select id from ap4_ids where name = 't_watched');
begin
  assert not exists (select 1 from public.inbox_items where task_id = t and data ? 'field_change'),
    'values set while creating the task notify nobody';
end $$;

do $$
declare
  t uuid := (select id from ap4_ids where name = 't_watched');
  f uuid := (select id from ap4_ids where name = 'f_priority');
begin
  update public.task_field_values set value = '"hi"' where task_id = t and field_id = f;
end $$;

reset role;
do $$
declare
  t uuid := (select id from ap4_ids where name = 't_watched');
  item record;
begin
  select * into item from public.inbox_items
  where task_id = t and recipient_id = 'fdfdfdfd-0000-4000-8000-000000000003' and data ? 'field_change';
  assert item.kind = 'rule' and item.actor_id = 'fdfdfdfd-0000-4000-8000-000000000002'
    and item.data ->> 'message' = 'Priority changed to High' and item.data ->> 'field_name' = 'Priority'
    and item.data ->> 'value_text' = 'High', 'a follower hears about the change (kind rule, field_change)';
  assert exists (select 1 from public.inbox_items
                 where task_id = t and recipient_id = 'fdfdfdfd-0000-4000-8000-000000000001' and data ? 'field_change'),
    'every follower does';
  assert not exists (select 1 from public.inbox_items
                     where task_id = t and recipient_id = 'fdfdfdfd-0000-4000-8000-000000000002' and data ? 'field_change'),
    'the person who changed it (a follower too) doesn''t';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'fdfdfdfd-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from ap4_ids where name = 't_watched');
  f uuid := (select id from ap4_ids where name = 'f_priority');
begin
  update public.task_field_values set value = 'null' where task_id = t and field_id = f;
  update public.task_field_values set value = 'null' where task_id = t and field_id = f;
end $$;
reset role;
do $$
declare
  t uuid := (select id from ap4_ids where name = 't_watched');
begin
  assert (select count(*) from public.inbox_items
          where task_id = t and recipient_id = 'fdfdfdfd-0000-4000-8000-000000000003'
            and data ->> 'message' = 'Priority was cleared') = 1, 'clearing notifies once (no change, no item)';
  update public.custom_fields set notify_on_change = false where id = (select id from ap4_ids where name = 'f_priority');
  update public.task_field_values set value = '"lo"' where task_id = t and field_id = (select id from ap4_ids where name = 'f_priority');
  assert (select count(*) from public.inbox_items
          where task_id = t and recipient_id = 'fdfdfdfd-0000-4000-8000-000000000003' and data ? 'field_change') = 2,
    'with the option off, changes notify nobody';
end $$;

-- Forms: heading and email questions --------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'fdfdfdfd-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from ap4_ids where name = 'p');
  fo uuid;
begin
  insert into public.forms (project_id, title, accepting_responses, questions)
  values (p, 'AP4 intake', true, '[
    {"id": "h1", "type": "heading", "label": "About you", "help": "So we can reach you"},
    {"id": "who", "type": "email", "label": "Manager email", "required": true, "maps_to": {"target": "title"}},
    {"id": "what", "type": "long_text", "label": "Details", "maps_to": {"target": "notes"}}
  ]') returning id into fo;
  insert into ap4_ids values ('form', fo);

  begin
    update public.forms set questions = '[{"id": "h", "type": "heading", "label": "Required?", "required": true}]' where id = fo;
    raise exception 'a heading can''t be required';
  exception when check_violation then null;
  end;
  begin
    update public.forms set questions = '[{"id": "h", "type": "heading", "label": "Mapped", "maps_to": {"target": "notes"}}]' where id = fo;
    raise exception 'a heading can''t be mapped';
  exception when check_violation then null;
  end;
  begin
    update public.forms set questions = '[{"id": "h", "type": "heading", "label": "H"},
      {"id": "q", "type": "short_text", "label": "Q", "show_if": {"question_id": "h", "option_ids": ["true"]}}]' where id = fo;
    raise exception 'a heading can''t drive branching';
  exception when check_violation then null;
  end;
  begin
    update public.forms set questions = '[{"id": "e", "type": "email", "label": "E", "maps_to": {"target": "due_on"}}]' where id = fo;
    raise exception 'an email can''t set the due date';
  exception when check_violation then null;
  end;
end $$;

reset role;
set role anon;
do $$
declare
  fo uuid := (select id from ap4_ids where name = 'form');
  result jsonb;
  t uuid;
begin
  begin
    perform public.submit_form(fo, 'requester@example.org', '{"who": "not an email"}');
    raise exception 'an invalid email answer must be refused';
  exception when check_violation then null;
  end;
  result := public.submit_form(fo, 'requester@example.org',
    '{"h1": "ignored", "who": "  Boss@Example.ORG ", "what": "Please help"}');
  t := (result ->> 'task_id')::uuid;
  insert into ap4_ids values ('form_task', t);
end $$;
reset role;

do $$
declare
  t uuid := (select id from ap4_ids where name = 'form_task');
begin
  assert (select title from public.tasks where id = t) = 'boss@example.org', 'the email answer (lowercased) names the task';
  assert (select answers from public.form_submissions where task_id = t) = '{"who": "boss@example.org", "what": "Please help"}'::jsonb,
    'a heading never has an answer';
  assert (select notes from public.tasks where id = t) like 'Please help%Manager email: boss@example.org%',
    'the summary lists the email answer';
end $$;

-- Browse projects: people and last modified -------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'fdfdfdfd-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  team uuid;
  p uuid;
begin
  insert into public.teams (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'AP4 Team') returning id into team;
  perform public.add_team_member(team, 'ap4-viewer@example.com', 'member');
  insert into ap4_ids values ('team', team);
  insert into public.projects (workspace_id, name, team_id, visibility)
  values ('00000000-0000-4000-8000-000000000001', 'AP4 Team P', team, 'team') returning id into p;
  insert into ap4_ids values ('team_p', p);
  insert into public.projects (workspace_id, name, team_id, visibility)
  values ('00000000-0000-4000-8000-000000000001', 'AP4 Secret P', team, 'private') returning id into p;
  insert into ap4_ids values ('secret_p', p);
end $$;

-- The Viewer of AP4 P is on the team: they see the team project's people without being a member.
select set_config('request.jwt.claim.sub', 'fdfdfdfd-0000-4000-8000-000000000003', false) is not null as ok \gset

do $$
declare
  row record;
begin
  assert (select count(*) from public.browse_project_people()) = (select count(*) from public.browse_projects()),
    'one people row per browse row';
  assert not exists (
    select project_id from public.browse_project_people()
    except select project_id from public.browse_projects()
  ), 'exactly the browse rows';
  select * into row from public.browse_project_people() where project_id = (select id from ap4_ids where name = 'team_p');
  assert row.owner_ids = array['fdfdfdfd-0000-4000-8000-000000000001'::uuid] and row.member_ids = row.owner_ids
    and row.modified_at is not null, 'a joinable project shows its owner, members, and last change';
  assert not exists (select 1 from public.browse_project_people() where project_id = (select id from ap4_ids where name = 'secret_p')),
    'a private project of others never shows';
  select * into row from public.browse_project_people() where project_id = (select id from ap4_ids where name = 'p');
  assert row.owner_ids[1] = 'fdfdfdfd-0000-4000-8000-000000000001' and cardinality(row.member_ids) = 3
    and row.member_ids[1] = 'fdfdfdfd-0000-4000-8000-000000000001', 'own projects list every member, owners first';
  assert exists (select 1 from public.browse_project_people((select id from ap4_ids where name = 'team')))
    and not exists (select 1 from public.browse_project_people((select id from ap4_ids where name = 'team'))
                    where project_id = (select id from ap4_ids where name = 'p')), 'the team filter applies';
end $$;

-- Someone outside the team and the projects sees none of them; a workspace admin gets nothing extra.
select set_config('request.jwt.claim.sub', 'fdfdfdfd-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
begin
  assert not exists (
    select 1 from public.browse_project_people()
    where project_id in (select id from ap4_ids where name in ('p', 'team_p', 'secret_p'))
  ), 'non-members outside the team see none of them';
end $$;

select set_config('request.jwt.claim.sub', 'fdfdfdfd-0000-4000-8000-000000000005', false) is not null as ok \gset
do $$
begin
  assert public.is_workspace_admin(), 'the admin is a workspace admin';
  assert not exists (
    select 1 from public.browse_project_people()
    where project_id in (select id from ap4_ids where name in ('p', 'team_p', 'secret_p'))
  ), 'workspace admins see nothing extra';
end $$;

reset role;

do $$
begin
  assert not has_function_privilege('authenticated', 'public.alhc_patch_function(regprocedure, text[])', 'execute'),
    'the patch helper stays internal';
end $$;

select 'zz13 asana parity 4 smoke: ok' as result;
