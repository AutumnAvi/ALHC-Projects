-- Nov 2 notes, batch 14 (20261102020000_nov2_batch14_a.sql): views, search by number, project roles,
-- templates, and Slack connected once per workspace.
--   94 validate_view_config takes section_order (this project's sections, once each); each person's own
--      version of a shared view (set_view_personal_config) is theirs alone; only Owners change the shared one.
--   100 request_number_query reads "task 5", "request 7"; search_tasks finds a number written with any
--      project's own prefix ("des 42" = "DES-0042"), only in projects the caller can read, number matches first.
--   95 project_roles / task_role_links (Editors+, a member fills a role), set_task_role_link,
--      set_project_role_person (updates open tasks), the unlink when someone reassigns by hand, automations'
--      project_role:<id> (resolve_rule_person, validate_rule, Send email to a role), templates and
--      Duplicate project carrying roles, and create_project_from_template_custom.
--   105 Slack: the fixture project's old webhook became a workspace destination; manage_slack_workspace
--      (workspace admins), slack_settings (names only), set_project_slack_destination (project Admins),
--      and Send Slack message through a channel (chat.postMessage with the bot token) or a saved webhook.
--   a3100140…01 b14-owner@example.com   Olga Owner (workspace admin; owns P)
--   a3100140…02 b14-editor@example.com  Eddie Editor (Editor of P)
--   a3100140…03 b14-viewer@example.com  Vera Viewer (Viewer of P)
--   a3100140…04 b14-other@example.com   Otto Other (in nothing)

\set ON_ERROR_STOP 1

create temporary table b14_ids (name text primary key, id uuid) on commit preserve rows;
grant all on b14_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('b14-owner@example.com', 'batch 14'),
  ('b14-editor@example.com', 'batch 14'),
  ('b14-viewer@example.com', 'batch 14'),
  ('b14-other@example.com', 'batch 14');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a3100140-0000-4000-8000-000000000001', 'b14-owner@example.com', now(), '{"full_name":"Olga Owner"}'),
  ('a3100140-0000-4000-8000-000000000002', 'b14-editor@example.com', now(), '{"full_name":"Eddie Editor"}'),
  ('a3100140-0000-4000-8000-000000000003', 'b14-viewer@example.com', now(), '{"full_name":"Vera Viewer"}'),
  ('a3100140-0000-4000-8000-000000000004', 'b14-other@example.com', now(), '{"full_name":"Otto Other"}');
select public.seed_workspace_admin('b14-owner@example.com');

-- ---------------------------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['project_view_personal_configs', 'project_roles', 'task_role_links', 'slack_connections', 'slack_destinations'] loop
    assert (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass), t || ': RLS on';
    assert not has_table_privilege('anon', 'public.' || t, 'select'), t || ': nothing for anon';
    assert not has_table_privilege('authenticated', 'public.' || t, 'truncate'), t || ': no truncate';
  end loop;
  foreach t in array array['slack_connections', 'slack_destinations'] loop
    assert not has_table_privilege('authenticated', 'public.' || t, 'select')
      and not has_table_privilege('authenticated', 'public.' || t, 'insert')
      and not has_table_privilege('authenticated', 'public.' || t, 'update'), t || ': no client access at all';
  end loop;
  assert not has_column_privilege('authenticated', 'public.project_integrations', 'slack_destination_id', 'select'),
    'project integrations stay out of reach';

  assert (select prosecdef from pg_proc where oid = 'public.create_project_from_template_custom(uuid, text, date, jsonb)'::regprocedure),
    'customized template creation is a definer (it reads the template''s snapshot like create_project_from_template)';
  foreach t in array array['slack_settings()', 'manage_slack_workspace(text, jsonb)', 'set_project_slack_destination(uuid, uuid)', 'slack_destination_usable(uuid, text)'] loop
    assert (select prosecdef from pg_proc where oid = ('public.' || t)::regprocedure), t || ' is a definer';
    assert has_function_privilege('authenticated', 'public.' || t, 'execute'), t || ': signed-in people call it';
    assert not has_function_privilege('anon', 'public.' || t, 'execute'), t || ': not anon';
  end loop;
  foreach t in array array['set_view_personal_config(uuid, jsonb)', 'set_project_role_person(uuid, uuid, boolean)',
                           'set_task_role_link(uuid, uuid, text, boolean)', 'normalized_task_label(text)',
                           'customize_template_snapshot(jsonb, jsonb)'] loop
    assert not (select prosecdef from pg_proc where oid = ('public.' || t)::regprocedure), t || ' runs as the caller';
    assert not has_function_privilege('anon', 'public.' || t, 'execute'), t || ': not anon';
  end loop;
  assert not has_function_privilege('authenticated', 'public.slack_bot_token(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.slack_bot_token(uuid)', 'execute')
    and has_function_privilege('service_role', 'public.slack_bot_token(uuid)', 'execute'), 'the bot token: service role only';
  foreach t in array array['project_roles_snapshot(uuid, boolean)', 'task_roles_snapshot(uuid, uuid)',
                           'template_role_person(uuid, jsonb, boolean, uuid)', 'apply_task_role_links(uuid, jsonb, jsonb, uuid)',
                           'on_task_assignee_role_unlink()'] loop
    assert not has_function_privilege('authenticated', 'public.' || t, 'execute'), t || ' is internal';
  end loop;
  assert not has_function_privilege('authenticated', 'public.alhc_patch_function(regprocedure, text[])', 'execute'),
    'the patch helper stays internal';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 105 (data): the fixture project's own Slack webhook moved to a workspace destination
-- ---------------------------------------------------------------------------------------------

do $$
declare
  d public.slack_destinations;
begin
  select * into d from public.slack_destinations
  where webhook_url = 'https://hooks.slack.com/services/T000/B000/legacyTokenAbcd' and deleted_at is null;
  assert found, 'the old project webhook is a workspace destination now';
  assert d.kind = 'webhook' and d.name like 'Legacy Slack%', format('named after its project, got %s', d.name);
  assert (select slack_destination_id from public.project_integrations
    where project_id = 'f14f14f1-0000-4000-8000-0000000000a1') = d.id, 'and the project uses it';
  assert (select slack_webhook_url from public.project_integrations
    where project_id = 'f14f14f1-0000-4000-8000-0000000000a1') is not null, 'the old column is kept for the release on main';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Setup: P with sections, members, numbering, and tasks
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100140-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid;
  q uuid;
  s1 uuid;
  s2 uuid;
  qs uuid;
  t uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B14 P') returning id into p;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B14 Q') returning id into q;
  perform public.add_project_member(p, 'b14-editor@example.com', 'editor');
  perform public.add_project_member(p, 'b14-viewer@example.com', 'viewer');
  insert into public.sections (project_id, name, sort_order) values (p, 'Intake', 1024) returning id into s1;
  insert into public.sections (project_id, name, sort_order) values (p, 'Design', 2048) returning id into s2;
  insert into public.sections (project_id, name, sort_order) values (q, 'Q section', 1024) returning id into qs;
  perform public.apply_task_numbering(p, jsonb_build_object('enabled', true, 'template', 'DES-{n:4}', 'number_scope', 'all_tasks'), 'save');
  insert into b14_ids values ('p', p), ('q', q), ('s1', s1), ('s2', s2), ('qs', qs);
  t := public.create_task(p, s1, 'Logo concepts');
  insert into b14_ids values ('t1', t);
  t := public.create_task(p, s2, 'Brand guide');
  insert into b14_ids values ('t2', t);
  t := public.create_task(p, s2, 'Already shipped');
  update public.tasks set completed_at = now() where id = t;
  insert into b14_ids values ('t3', t);
  t := public.create_task(p, s1, 'Sign-off');
  update public.tasks set kind = 'approval' where id = t;
  insert into b14_ids values ('approval', t);
end $$;

-- ---------------------------------------------------------------------------------------------
-- 94 section_order and personal versions of a view
-- ---------------------------------------------------------------------------------------------

do $$
declare
  p uuid := (select id from b14_ids where name = 'p');
  s1 uuid := (select id from b14_ids where name = 's1');
  s2 uuid := (select id from b14_ids where name = 's2');
  qs uuid := (select id from b14_ids where name = 'qs');
  v uuid;
begin
  perform public.validate_view_config(p, jsonb_build_object('section_order', jsonb_build_array(s2, s1)));
  begin
    perform public.validate_view_config(p, jsonb_build_object('section_order', jsonb_build_array(qs)));
    raise exception 'another project''s section should fail';
  exception when check_violation then null;
  end;
  begin
    perform public.validate_view_config(p, jsonb_build_object('section_order', jsonb_build_array(s1, s1)));
    raise exception 'a repeated section should fail';
  exception when check_violation then null;
  end;
  begin
    perform public.validate_view_config(p, jsonb_build_object('section_order', 'nope'));
    raise exception 'a non-list should fail';
  exception when check_violation then null;
  end;
  select id into v from public.project_views where project_id = p and layout = 'list' and owner_id is null and deleted_at is null limit 1;
  insert into b14_ids values ('view', v);
  -- The Owner saves it for everyone (the existing Owner-only path).
  update public.project_views set config = jsonb_build_object('section_order', jsonb_build_array(s2, s1)) where id = v;
  assert (select config -> 'section_order' from public.project_views where id = v) = jsonb_build_array(s2, s1), 'saved for everyone';
end $$;

select set_config('request.jwt.claim.sub', 'a3100140-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  v uuid := (select id from b14_ids where name = 'view');
  s1 uuid := (select id from b14_ids where name = 's1');
  stored jsonb;
  n integer;
begin
  -- An Editor's change to the shared view is refused (Owners only) ...
  update public.project_views set config = '{"group_by": "assignee"}'::jsonb where id = v;
  get diagnostics n = row_count;
  assert n = 0 or (select config from public.project_views where id = v) <> '{"group_by": "assignee"}'::jsonb,
    'an Editor never changes what everyone sees';
exception when insufficient_privilege or check_violation then null;
end $$;

do $$
declare
  v uuid := (select id from b14_ids where name = 'view');
  s1 uuid := (select id from b14_ids where name = 's1');
  stored jsonb;
begin
  -- ... but saves their own version.
  stored := public.set_view_personal_config(v, jsonb_build_object('group_by', 'assignee', 'section_order', jsonb_build_array(s1)));
  assert stored ->> 'group_by' = 'assignee', 'the version is stored';
  assert (select count(*) from public.project_view_personal_configs where view_id = v) = 1, 'the Editor sees their own row';
  assert (select config ->> 'group_by' from public.project_views where id = v) is distinct from 'assignee', 'the shared view is unchanged';
  begin
    perform public.set_view_personal_config(v, '{"surprise": true}'::jsonb);
    raise exception 'an invalid config should fail';
  exception when check_violation then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'a3100140-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  v uuid := (select id from b14_ids where name = 'view');
begin
  assert (select count(*) from public.project_view_personal_configs where view_id = v) = 0, 'nobody else reads it';
  perform public.set_view_personal_config(v, '{"group_by": "none"}'::jsonb);
  assert (select count(*) from public.project_view_personal_configs where view_id = v) = 1, 'a Viewer keeps a version too';
  assert public.set_view_personal_config(v, null) is null, 'and clears it (Reset to default)';
end $$;

select set_config('request.jwt.claim.sub', 'a3100140-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
begin
  perform public.set_view_personal_config((select id from b14_ids where name = 'view'), '{}'::jsonb);
  raise exception 'an outsider should not save a version';
exception when no_data_found then null;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 100 Search by number with any prefix
-- ---------------------------------------------------------------------------------------------

do $$
begin
  assert public.request_number_query('task 5') = '5' and public.request_number_query('Task #5') = '5'
    and public.request_number_query('request 7') = '7' and public.request_number_query('Req #7') = '7'
    and public.request_number_query('req 7') = '7' and public.request_number_query('#12') = '12'
    and public.request_number_query('12') = '12' and public.request_number_query('[Req #484.1]') = '484.1',
    'generic words before a number';
  assert public.request_number_query('logo 2') is null and public.request_number_query('logo') is null,
    'other words are a text search';
  assert public.normalized_task_label('DES-0042') = public.normalized_task_label('des 42')
    and public.normalized_task_label('Des #42') = 'des42', 'a project''s own prefix, loosely';
  assert public.normalized_task_label('Design 2026-14') = public.normalized_task_label('design 2026 14');
  assert public.normalized_task_label('no digits') = '', 'nothing to match without a number';
end $$;

select set_config('request.jwt.claim.sub', 'a3100140-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  t2 uuid := (select id from b14_ids where name = 't2');
  label text;
begin
  select req_label into label from public.tasks where id = t2;
  assert label = 'DES-0002', format('numbered with the prefix, got %s', label);
  assert (select id from public.search_tasks('des 2', 10) limit 1) = t2, 'the custom prefix, typed loosely';
  assert (select id from public.search_tasks('DES-0002', 10) limit 1) = t2, 'the label as written';
  assert (select id from public.search_tasks('task 2', 10) limit 1) = t2, 'a generic word';
  assert (select id from public.search_tasks('2', 10) limit 1) = t2, 'the bare number, first';
  assert exists (select 1 from public.search_tasks('logo', 10) where id = (select id from b14_ids where name = 't1')),
    'text search unchanged';
end $$;

select set_config('request.jwt.claim.sub', 'a3100140-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
begin
  assert (select count(*) from public.search_tasks('des 2', 10)) = 0, 'an outsider finds nothing by number';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 95 Project roles
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'a3100140-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
begin
  insert into public.project_roles (project_id, name) values ((select id from b14_ids where name = 'p'), 'Nope');
  raise exception 'a Viewer should not add roles';
exception when insufficient_privilege then null;
end $$;

select set_config('request.jwt.claim.sub', 'a3100140-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b14_ids where name = 'p');
  designer uuid;
  approver uuid;
begin
  insert into public.project_roles (project_id, name, profile_id) values (p, '  Designer ', 'a3100140-0000-4000-8000-000000000002')
  returning id into designer;
  assert (select name from public.project_roles where id = designer) = 'Designer', 'names are trimmed';
  insert into public.project_roles (project_id, name) values (p, 'Approver') returning id into approver;
  insert into b14_ids values ('designer', designer), ('approver_role', approver);
  begin
    insert into public.project_roles (project_id, name) values (p, 'designer');
    raise exception 'a repeated name should fail';
  exception when unique_violation then null;
  end;
  begin
    update public.project_roles set profile_id = 'a3100140-0000-4000-8000-000000000004' where id = approver;
    raise exception 'someone outside the project can''t fill a role';
  exception when check_violation then null;
  end;
  update public.project_roles set profile_id = 'a3100140-0000-4000-8000-000000000001' where id = approver;
end $$;

do $$
declare
  t1 uuid := (select id from b14_ids where name = 't1');
  t3 uuid := (select id from b14_ids where name = 't3');
  approval uuid := (select id from b14_ids where name = 'approval');
  designer uuid := (select id from b14_ids where name = 'designer');
  approver uuid := (select id from b14_ids where name = 'approver_role');
  result jsonb;
begin
  result := public.set_task_role_link(t1, designer, 'assignee', true);
  assert (select assignee_id from public.tasks where id = t1) = 'a3100140-0000-4000-8000-000000000002',
    'linking a role assigns its person';
  perform public.set_task_role_link(t3, designer, 'assignee', true);
  perform public.set_task_role_link(t1, designer, 'follower', true);
  perform public.set_task_role_link(approval, approver, 'approver', true);
  assert exists (select 1 from public.task_approvers where task_id = approval
    and profile_id = 'a3100140-0000-4000-8000-000000000001' and deleted_at is null), 'the role''s person approves';
  begin
    perform public.set_task_role_link(t1, designer, 'boss', true);
    raise exception 'unknown slots fail';
  exception when check_violation then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'a3100140-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
begin
  assert (select count(*) from public.task_role_links where task_id = (select id from b14_ids where name = 't1')) = 2,
    'Viewers read the links with the task';
  perform public.set_task_role_link((select id from b14_ids where name = 't2'), (select id from b14_ids where name = 'designer'), 'assignee', true);
  raise exception 'a Viewer should not link roles';
exception when insufficient_privilege then null;
end $$;

select set_config('request.jwt.claim.sub', 'a3100140-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t1 uuid := (select id from b14_ids where name = 't1');
  t3 uuid := (select id from b14_ids where name = 't3');
  designer uuid := (select id from b14_ids where name = 'designer');
  result jsonb;
begin
  -- The Designer is now the Owner: the open task follows, the completed one stays.
  result := public.set_project_role_person(designer, 'a3100140-0000-4000-8000-000000000001', true);
  assert (result ->> 'updated')::int >= 1, format('open tasks updated, got %s', result);
  assert (select assignee_id from public.tasks where id = t1) = 'a3100140-0000-4000-8000-000000000001', 'open task reassigned';
  assert (select assignee_id from public.tasks where id = t3) = 'a3100140-0000-4000-8000-000000000002', 'completed task left alone';
  assert exists (select 1 from public.task_followers where task_id = t1 and profile_id = 'a3100140-0000-4000-8000-000000000001'
    and deleted_at is null), 'the new person follows';
  -- Assigning by hand to someone else: the task stops following the role.
  update public.tasks set assignee_id = 'a3100140-0000-4000-8000-000000000003' where id = t1;
  assert not exists (select 1 from public.task_role_links where task_id = t1 and slot = 'assignee' and deleted_at is null),
    'a manual reassignment unlinks the assignee role';
  -- Without update_open_tasks only the role changes.
  perform public.set_task_role_link(t1, designer, 'assignee', true);
  perform public.set_project_role_person(designer, 'a3100140-0000-4000-8000-000000000002', false);
  assert (select assignee_id from public.tasks where id = t1) = 'a3100140-0000-4000-8000-000000000001', 'tasks keep their person';
  assert (select profile_id from public.project_roles where id = designer) = 'a3100140-0000-4000-8000-000000000002';
end $$;

-- Automations: "the person in role X".
select set_config('request.jwt.claim.sub', 'a3100140-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b14_ids where name = 'p');
  q uuid := (select id from b14_ids where name = 'q');
  designer uuid := (select id from b14_ids where name = 'designer');
  qrole uuid;
  r uuid;
begin
  insert into public.rules (project_id, name, trigger_type, trigger_config, actions)
  values (p, 'To the designer', 'section_changed', jsonb_build_object('section_id', (select id from b14_ids where name = 's2')),
    jsonb_build_array(
      jsonb_build_object('type', 'set_assignee', 'assignee', 'project_role:' || designer),
      jsonb_build_object('type', 'add_followers', 'people', jsonb_build_array('project_role:' || designer)),
      jsonb_build_object('type', 'send_email', 'to', 'role', 'role_id', designer, 'template', 'custom', 'subject', 'Hi', 'message', 'New work')
    ))
  returning id into r;
  insert into b14_ids values ('role_rule', r);
  insert into public.project_roles (project_id, name) values (q, 'Q lead') returning id into qrole;
  begin
    insert into public.rules (project_id, name, trigger_type, trigger_config, actions)
    values (p, 'Wrong project role', 'task_created', '{}'::jsonb,
      jsonb_build_array(jsonb_build_object('type', 'set_assignee', 'assignee', 'project_role:' || qrole)));
    raise exception 'another project''s role should fail';
  exception when check_violation then null;
  end;
  begin
    insert into public.rules (project_id, name, trigger_type, trigger_config, actions)
    values (p, 'Email a missing role', 'task_created', '{}'::jsonb,
      jsonb_build_array(jsonb_build_object('type', 'send_email', 'to', 'role', 'role_id', qrole, 'template', 'custom')));
    raise exception 'Send email to another project''s role should fail';
  exception when check_violation then null;
  end;
  -- Run it: move t2 into Design again through the rule's trigger.
  update public.rules set enabled = true where id = r;
  update public.task_projects set section_id = (select id from b14_ids where name = 's1')
  where task_id = (select id from b14_ids where name = 't2') and project_id = p;
  update public.task_projects set section_id = (select id from b14_ids where name = 's2')
  where task_id = (select id from b14_ids where name = 't2') and project_id = p;
  assert (select assignee_id from public.tasks where id = (select id from b14_ids where name = 't2'))
    = 'a3100140-0000-4000-8000-000000000002', 'the automation assigned the role''s person';
  update public.rules set enabled = false where id = r;
end $$;

reset role;
do $$
begin
  assert public.resolve_rule_person(to_jsonb('project_role:' || (select id from b14_ids where name = 'designer')),
    (select id from b14_ids where name = 't2')) = 'a3100140-0000-4000-8000-000000000002', 'resolves to whoever fills the role';
  assert exists (select 1 from public.email_outbox where to_email = 'b14-editor@example.com' and subject is not null),
    'Send email reached the role''s person';
end $$;
set role authenticated;

-- Templates and Duplicate project carry roles; the customize step.
select set_config('request.jwt.claim.sub', 'a3100140-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b14_ids where name = 'p');
  s1 uuid := (select id from b14_ids where name = 's1');
  t2 uuid := (select id from b14_ids where name = 't2');
  designer uuid := (select id from b14_ids where name = 'designer');
  tpl uuid;
  content jsonb;
  created jsonb;
  np uuid;
  new_designer uuid;
  dup jsonb;
begin
  tpl := public.save_project_as_template(p, 'B14 template', 'With roles', current_date);
  select t.content into content from public.project_templates t where t.id = tpl;
  assert jsonb_array_length(content -> 'roles') >= 2, format('the template carries the roles, got %s', content -> 'roles');
  assert not exists (select 1 from jsonb_array_elements(content -> 'roles') r where r ->> 'profile_id' is not null),
    'never the people';
  assert exists (select 1 from jsonb_array_elements(content -> 'tasks') t, jsonb_array_elements(t -> 'roles') l
    where l ->> 'role_id' = designer::text), 'and the tasks'' role links';

  created := public.create_project_from_template_custom(tpl, 'B14 from template', current_date, jsonb_build_object(
    'sections', jsonb_build_object(s1::text, jsonb_build_object('skip', true)),
    'tasks', jsonb_build_object(t2::text, jsonb_build_object('title', 'Brand guide v2')),
    'added_tasks', jsonb_build_array(jsonb_build_object('section_id', (select id from b14_ids where name = 's2'), 'title', 'Extra task')),
    'roles', jsonb_build_object(designer::text, 'a3100140-0000-4000-8000-000000000004')
  ));
  np := (created ->> 'project_id')::uuid;
  insert into b14_ids values ('custom_project', np);
  assert not exists (select 1 from public.sections where project_id = np and name = 'Intake' and deleted_at is null), 'section left out';
  assert not exists (select 1 from public.tasks where home_project_id = np and title = 'Logo concepts'), 'with its tasks';
  assert exists (select 1 from public.tasks where home_project_id = np and title = 'Brand guide v2'), 'task renamed';
  assert exists (select 1 from public.tasks where home_project_id = np and title = 'Extra task'), 'task added';
  select id into new_designer from public.project_roles where project_id = np and name = 'Designer' and deleted_at is null;
  assert (select profile_id from public.project_roles where id = new_designer) = 'a3100140-0000-4000-8000-000000000004',
    'the role has the person picked';
  assert exists (select 1 from public.project_members where project_id = np and profile_id = 'a3100140-0000-4000-8000-000000000004'
    and role = 'editor' and deleted_at is null), 'who joins as an Editor';
  assert exists (select 1 from public.rules r where r.project_id = np and r.actions::text like '%project_role:' || new_designer || '%'),
    'the automation points at the copy''s role';
  assert not exists (select 1 from public.rules r where r.project_id = np and r.actions::text like '%' || designer || '%'),
    'never the template project''s role';

  dup := public.duplicate_project(p, 'B14 duplicate', jsonb_build_object('assignees', true));
  assert (select profile_id from public.project_roles where project_id = (dup ->> 'project_id')::uuid and name = 'Designer')
    is null, 'Duplicate keeps a role''s person only when they''re in the copy (members weren''t copied)';
  assert (select count(*) from public.project_roles where project_id = (dup ->> 'project_id')::uuid) >= 2, 'Duplicate keeps the roles';
end $$;

-- The new person sees their assigned task in the customized project.
select set_config('request.jwt.claim.sub', 'a3100140-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
begin
  assert (select count(*) from public.project_roles where project_id = (select id from b14_ids where name = 'custom_project')) >= 1,
    'the person picked for a role can read the project';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 105 Slack connected once per workspace
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'a3100140-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  perform public.manage_slack_workspace('add_webhook', '{"name": "x", "url": "https://hooks.slack.com/services/T1/B1/abcdefghijk"}'::jsonb);
  raise exception 'a member should not manage Slack';
exception when insufficient_privilege then null;
end $$;

select set_config('request.jwt.claim.sub', 'a3100140-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  result jsonb;
begin
  begin
    perform public.manage_slack_workspace('connect', '{"token": "not-a-token"}'::jsonb);
    raise exception 'a bad token should fail';
  exception when check_violation then null;
  end;
  begin
    perform public.manage_slack_workspace('add_webhook', '{"name": "x", "url": "https://example.com/hook"}'::jsonb);
    raise exception 'only Slack webhooks';
  exception when check_violation then null;
  end;
  result := public.manage_slack_workspace('connect', jsonb_build_object(
    'token', 'xoxb-1111-2222-abcdefghijklmnop', 'team_id', 'T999', 'team_name', 'Autumn Lake',
    'channels', jsonb_build_array(
      jsonb_build_object('id', 'C0001AAAA', 'name', 'design'),
      jsonb_build_object('id', 'C0002BBBB', 'name', 'secret', 'is_private', true))));
  assert (result ->> 'channels')::int = 2, 'two channels';
  result := public.manage_slack_workspace('add_webhook', '{"name": "Marketing", "url": "https://hooks.slack.com/services/T1/B1/abcdefghijk"}'::jsonb);
  insert into b14_ids values ('hook_dest', (result ->> 'id')::uuid);
  -- A refresh that no longer sees "secret" takes it off the list.
  perform public.manage_slack_workspace('sync_channels', jsonb_build_object('channels',
    jsonb_build_array(jsonb_build_object('id', 'C0001AAAA', 'name', 'design-team'))));
end $$;

select set_config('request.jwt.claim.sub', 'a3100140-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  s jsonb := public.slack_settings();
begin
  assert (s ->> 'connected')::boolean and s ->> 'team_name' = 'Autumn Lake', 'everyone sees that Slack is connected';
  assert s::text not like '%xoxb%' and s::text not like '%abcdefghijk%' and s::text not like '%legacyTokenAbcd%',
    'never a token or a webhook URL';
  assert exists (select 1 from jsonb_array_elements(s -> 'destinations') d where d ->> 'name' = 'design-team' and d ->> 'kind' = 'channel'),
    'channels by name';
  assert not exists (select 1 from jsonb_array_elements(s -> 'destinations') d where d ->> 'name' = 'secret'), 'gone after refresh';
  assert s -> 'legacy_projects' = 'null'::jsonb, 'the legacy count is for admins only';
  begin
    perform public.set_project_slack_destination((select id from b14_ids where name = 'p'), null);
    raise exception 'a Viewer should not pick the channel';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'a3100140-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b14_ids where name = 'p');
  s1 uuid := (select id from b14_ids where name = 's1');
  s2 uuid := (select id from b14_ids where name = 's2');
  t uuid := (select id from b14_ids where name = 't2');
  channel uuid;
  hook uuid := (select id from b14_ids where name = 'hook_dest');
  r1 uuid;
  r2 uuid;
  settings jsonb;
begin
  select (d ->> 'id')::uuid into channel from jsonb_array_elements(public.slack_settings() -> 'destinations') d
  where d ->> 'name' = 'design-team';
  perform public.set_project_slack_destination(p, channel);
  settings := public.get_project_integrations(p);
  assert settings -> 'slack_destination' ->> 'name' = 'design-team', format('the project''s channel, got %s', settings);
  begin
    insert into public.rules (project_id, name, trigger_type, trigger_config, actions)
    values (p, 'Bad dest', 'task_created', '{}'::jsonb,
      '[{"type": "send_slack", "message": "x", "destination_id": "00000000-0000-4000-8000-00000000dead"}]');
    raise exception 'an unknown destination should fail';
  exception when check_violation then null;
  end;
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions)
  values (p, 'Project channel', true, 'section_changed', jsonb_build_object('section_id', s1),
    '[{"type": "send_slack", "message": "{task} moved", "use_project_webhook": true}]') returning id into r1;
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions)
  values (p, 'Own webhook dest', true, 'section_changed', jsonb_build_object('section_id', s1),
    jsonb_build_array(jsonb_build_object('type', 'send_slack', 'message', 'hello', 'destination_id', hook))) returning id into r2;
  insert into b14_ids values ('slack_rule_channel', r1), ('slack_rule_hook', r2);
  update public.task_projects set section_id = s1 where task_id = t and project_id = p;
end $$;

reset role;
do $$
declare
  o public.integration_outbox;
begin
  select * into o from public.integration_outbox where rule_id = (select id from b14_ids where name = 'slack_rule_channel');
  assert found, 'the channel message was queued';
  assert o.target_url = 'https://slack.com/api/chat.postMessage', 'through Slack''s Web API';
  assert o.headers ->> 'Authorization' = 'Bearer xoxb-1111-2222-abcdefghijklmnop', 'with the bot token (no client reads the outbox)';
  assert o.payload ->> 'channel' = 'C0001AAAA' and o.payload ->> 'text' like '%moved%', format('to the channel, got %s', o.payload);
  assert o.target_hint = '#design-team', 'the delivery log names the channel';
  select * into o from public.integration_outbox where rule_id = (select id from b14_ids where name = 'slack_rule_hook');
  assert o.target_url = 'https://hooks.slack.com/services/T1/B1/abcdefghijk' and o.headers = '{}'::jsonb,
    'a saved webhook posts to its URL, no token';
  assert exists (select 1 from public.task_stories s where s.task_id = (select id from b14_ids where name = 't2')
    and s.kind = 'integration_queued' and s.data ->> 'target' = '#design-team'), 'the story names the channel, never a URL';
end $$;

-- Disconnecting stops channel posts with a clear error; the saved webhook still works.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100140-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b14_ids where name = 'p');
begin
  perform public.manage_slack_workspace('disconnect', '{}'::jsonb);
  assert not (public.slack_settings() ->> 'connected')::boolean, 'disconnected';
  update public.task_projects set section_id = (select id from b14_ids where name = 's2')
  where task_id = (select id from b14_ids where name = 't2') and project_id = p;
  update public.task_projects set section_id = (select id from b14_ids where name = 's1')
  where task_id = (select id from b14_ids where name = 't2') and project_id = p;
  assert exists (select 1 from public.rule_runs rr where rr.rule_id = (select id from b14_ids where name = 'slack_rule_channel')
    and rr.status = 'failed' and rr.detail::text like '%isn''t connected%'), 'channel posts fail with a clear reason';
  perform public.manage_slack_workspace('remove', jsonb_build_object('id', (select id from b14_ids where name = 'hook_dest')));
  update public.rules set enabled = false where project_id = p;
end $$;

reset role;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
select 'nov2 batch14 smoke: all assertions passed' as result;
