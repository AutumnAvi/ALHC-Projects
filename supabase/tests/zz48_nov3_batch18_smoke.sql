-- Nov 3 notes, batch 18 (20261103010000_nov3_batch18_a.sql).
--   135 The tasks, task_projects, and rule_runs read policies decide with the caller's readable projects /
--       automations once per statement (viewer_project_ids, viewer_rule_ids) — the same rows as the
--       per-row role helpers: members (any role, archived projects included) read, others don't, a person
--       taken off the allowlist reads nothing, trashed tasks stay Editors+ only. task_project_labels keeps
--       its output.
--   b1800180…11 b18-owner@example.com   Ona Owner (owns P)
--   b1800180…12 b18-viewer@example.com  Vi Viewer (Viewer of P)
--   b1800180…13 b18-out@example.com     Oz Outsider (no membership)

\set ON_ERROR_STOP 1

create temporary table b18_ids (name text primary key, id uuid) on commit preserve rows;
grant all on b18_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('b18-owner@example.com', 'batch 18'),
  ('b18-viewer@example.com', 'batch 18'),
  ('b18-out@example.com', 'batch 18');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b1800180-0000-4000-8000-000000000011', 'b18-owner@example.com', now(), '{"full_name":"Ona Owner"}'),
  ('b1800180-0000-4000-8000-000000000012', 'b18-viewer@example.com', now(), '{"full_name":"Vi Viewer"}'),
  ('b1800180-0000-4000-8000-000000000013', 'b18-out@example.com', now(), '{"full_name":"Oz Outsider"}');

-- ---------------------------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------------------------

do $$
begin
  assert (select prosecdef from pg_proc where oid = 'public.viewer_project_ids()'::regprocedure), 'viewer_project_ids is definer';
  assert (select prosecdef from pg_proc where oid = 'public.viewer_rule_ids()'::regprocedure), 'viewer_rule_ids is definer';
  assert has_function_privilege('authenticated', 'public.viewer_project_ids()', 'execute');
  assert has_function_privilege('authenticated', 'public.viewer_rule_ids()', 'execute');
  assert not has_function_privilege('anon', 'public.viewer_project_ids()', 'execute'), 'nothing for anon';
  assert not has_function_privilege('anon', 'public.viewer_rule_ids()', 'execute'), 'nothing for anon';
  assert not (select prosecdef from pg_proc where oid = 'public.task_project_labels(uuid[])'::regprocedure),
    'task_project_labels stays invoker';
  assert has_function_privilege('authenticated', 'public.task_project_labels(uuid[])', 'execute'), 'grants kept';
  assert (select pg_get_expr(polqual, polrelid) from pg_policy where polname = 'task_projects_select_viewer') like '%viewer_project_ids%';
  assert (select pg_get_expr(polqual, polrelid) from pg_policy where polname = 'rule_runs_select_viewer') like '%viewer_rule_ids%';
  assert (select pg_get_expr(polqual, polrelid) from pg_policy where polname = 'tasks_select_viewer') like '%viewer_project_ids%';
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    assert exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'rule_runs'),
      'rule_runs is in Realtime';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Setup (as the owner): P with an open task, a trashed task, a subtask, and an automation run.
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'b1800180-0000-4000-8000-000000000011', false) is not null as ok \gset
do $$
declare
  p uuid;
  s uuid;
  a uuid;
  gone uuid;
  sub uuid;
  r uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B18 P') returning id into p;
  perform public.add_project_member(p, 'b18-viewer@example.com', 'viewer');
  insert into public.sections (project_id, name) values (p, 'Doing') returning id into s;
  a := public.create_task(p, s, 'B18 A');
  gone := public.create_task(p, s, 'B18 Gone');
  sub := public.create_subtask(a, 'B18 Sub', null);
  update public.tasks set deleted_at = now() where id = gone;
  insert into public.rules (project_id, name, trigger_type, actions)
  values (p, 'B18 rule', 'task_created', '[{"type":"add_comment","body":"hi"}]') returning id into r;
  insert into b18_ids values ('p', p), ('a', a), ('gone', gone), ('sub', sub), ('rule', r);
  assert public.viewer_project_ids() @> array[p], 'the owner reads P';
end $$;
reset role;

insert into public.rule_runs (rule_id, task_id, trigger_type, status, detail, actor_id)
select (select id from b18_ids where name = 'rule'), (select id from b18_ids where name = 'a'), 'task_created', 'succeeded',
  '{"actions":[{"step":1,"type":"add_comment","outcome":"done"}]}', 'b1800180-0000-4000-8000-000000000011';

-- ---------------------------------------------------------------------------------------------
-- The owner, the Viewer, and the outsider
-- ---------------------------------------------------------------------------------------------

set role authenticated;
do $$
declare
  p uuid := (select id from b18_ids where name = 'p');
  a uuid := (select id from b18_ids where name = 'a');
  gone uuid := (select id from b18_ids where name = 'gone');
  sub uuid := (select id from b18_ids where name = 'sub');
  labels jsonb;
begin
  -- Owner (Editor+): the active task, the subtask, the trashed task, the membership, the run.
  perform set_config('request.jwt.claim.sub', 'b1800180-0000-4000-8000-000000000011', true);
  assert (select count(*) from public.tasks where id in (a, gone, sub)) = 3, 'the owner reads all three';
  assert (select count(*) from public.task_projects where project_id = p) = 2, 'the owner reads the memberships';
  assert (select count(*) from public.rule_runs where task_id = a) = 1, 'the owner reads the run';
  labels := public.task_project_labels(array[a, sub]);
  assert labels -> a::text -> 0 ->> 'project_name' = 'B18 P', format('labels: %s', labels);
  assert labels -> sub::text -> 0 ->> 'project_id' = p::text, 'a subtask is labelled with its top-level task''s project';

  -- Viewer: the active task and subtask, not the trashed one; the memberships and the run.
  perform set_config('request.jwt.claim.sub', 'b1800180-0000-4000-8000-000000000012', true);
  assert public.viewer_project_ids() @> array[p], 'the Viewer reads P';
  assert (select count(*) from public.tasks where id in (a, sub)) = 2, 'the Viewer reads the open task and subtask';
  assert not exists (select 1 from public.tasks where id = gone), 'trashed tasks stay Editors+ only';
  assert (select count(*) from public.task_projects where project_id = p) = 2, 'the Viewer reads the memberships';
  assert (select count(*) from public.rule_runs where task_id = a) = 1, 'the Viewer reads the run';
  assert public.viewer_rule_ids() @> array[(select id from b18_ids where name = 'rule')];

  -- Outsider: nothing.
  perform set_config('request.jwt.claim.sub', 'b1800180-0000-4000-8000-000000000013', true);
  assert not (public.viewer_project_ids() @> array[p]), 'the outsider reads no P';
  assert not exists (select 1 from public.tasks where id in (a, gone, sub)), 'the outsider reads no task';
  assert not exists (select 1 from public.task_projects where project_id = p), 'the outsider reads no membership';
  assert not exists (select 1 from public.rule_runs where task_id = a), 'the outsider reads no run';
  assert public.task_project_labels(array[a, sub]) = '{}'::jsonb, 'the outsider gets no labels';
end $$;
reset role;

-- Archived: the Viewer still reads (every member counts as Viewer). Off the allowlist: nothing.
update public.projects set archived_at = now() where id = (select id from b18_ids where name = 'p');
update public.allowed_emails set removed_at = now() where email = 'b18-owner@example.com';
set role authenticated;
do $$
declare
  p uuid := (select id from b18_ids where name = 'p');
  a uuid := (select id from b18_ids where name = 'a');
begin
  perform set_config('request.jwt.claim.sub', 'b1800180-0000-4000-8000-000000000012', true);
  assert exists (select 1 from public.tasks where id = a), 'an archived project''s Viewer still reads';
  assert exists (select 1 from public.rule_runs where task_id = a), 'and its runs';
  perform set_config('request.jwt.claim.sub', 'b1800180-0000-4000-8000-000000000011', true);
  assert public.viewer_project_ids() = '{}'::uuid[], 'off the allowlist: no projects';
  assert not exists (select 1 from public.tasks where id = a), 'off the allowlist: no tasks';
  assert not exists (select 1 from public.task_projects where project_id = p), 'off the allowlist: no memberships';
  assert not exists (select 1 from public.rule_runs where task_id = a), 'off the allowlist: no runs';
end $$;
reset role;
update public.allowed_emails set removed_at = null where email = 'b18-owner@example.com';
update public.projects set archived_at = null where id = (select id from b18_ids where name = 'p');

select 'nov3 batch 18 smoke: all assertions passed' as result;
