-- Nov 2 notes, batch 15 (20261102040000_nov2_batch15_a.sql).
--   111 project_task_cards returns blocker_ids: the visible open blockers it counts in blocked_by (never a
--       task the caller can't read).
--   117 project_view_settings.hidden_view_ids: shared view tabs hidden for everyone; Editors+ write it,
--       the guard keeps only this project's live shared views, once each.
--   b1500150…01 b15-owner@example.com   Ona Owner (owns P and Q)
--   b1500150…02 b15-editor@example.com  Ed Editor (Editor of P; not in Q)
--   b1500150…03 b15-viewer@example.com  Vi Viewer (Viewer of P)

\set ON_ERROR_STOP 1

create temporary table b15_ids (name text primary key, id uuid) on commit preserve rows;
grant all on b15_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('b15-owner@example.com', 'batch 15'),
  ('b15-editor@example.com', 'batch 15'),
  ('b15-viewer@example.com', 'batch 15');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b1500150-0000-4000-8000-000000000001', 'b15-owner@example.com', now(), '{"full_name":"Ona Owner"}'),
  ('b1500150-0000-4000-8000-000000000002', 'b15-editor@example.com', now(), '{"full_name":"Ed Editor"}'),
  ('b1500150-0000-4000-8000-000000000003', 'b15-viewer@example.com', now(), '{"full_name":"Vi Viewer"}');

-- ---------------------------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------------------------

do $$
begin
  assert (select column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'project_view_settings' and column_name = 'hidden_view_ids') = '''{}''::uuid[]',
    'hidden view tabs default to none';
  assert has_column_privilege('authenticated', 'public.project_view_settings', 'hidden_view_ids', 'UPDATE'), 'Editors write it (RLS decides)';
  assert has_column_privilege('authenticated', 'public.project_view_settings', 'hidden_view_ids', 'INSERT'), 'and on insert';
  assert not has_column_privilege('anon', 'public.project_view_settings', 'hidden_view_ids', 'SELECT'), 'nothing for anon';
  assert not (select prosecdef from pg_proc where oid = 'public.guard_project_view_hidden_views()'::regprocedure), 'the guard is invoker';
  assert not has_function_privilege('anon', 'public.guard_project_view_hidden_views()', 'execute'), 'anon can''t run it';
  assert exists (select 1 from pg_trigger where tgname = 'project_view_settings_06_hidden_views' and not tgisinternal), 'the guard is on';
  assert not has_function_privilege('authenticated', 'public.alhc_patch_function(regprocedure, text[])', 'execute'),
    'the patch helper stays internal';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Setup
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'b1500150-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid;
  q uuid;
  s uuid;
  qs uuid;
  a uuid;
  b uuid;
  c uuid;
  hidden_q uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B15 P') returning id into p;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B15 Q') returning id into q;
  perform public.add_project_member(p, 'b15-editor@example.com', 'editor');
  perform public.add_project_member(p, 'b15-viewer@example.com', 'viewer');
  insert into public.sections (project_id, name) values (p, 'Doing') returning id into s;
  insert into public.sections (project_id, name) values (q, 'Q doing') returning id into qs;
  a := public.create_task(p, s, 'Blocker A');
  b := public.create_task(p, s, 'Blocked B');
  hidden_q := public.create_task(q, qs, 'Blocker in Q');
  -- B waits on A (in P) and on a task of Q that only the owner can read.
  perform public.set_task_dependency(a, b, 'finish_to_start', 0);
  perform public.set_task_dependency(hidden_q, b, 'finish_to_start', 0);
  insert into public.project_views (project_id, name, layout) values (q, 'Q list', 'list') returning id into c;
  insert into b15_ids values ('p', p), ('q', q), ('a', a), ('b', b), ('hq', hidden_q), ('qview', c);
end $$;

-- ---------------------------------------------------------------------------------------------
-- 111 blocker_ids
-- ---------------------------------------------------------------------------------------------

do $$
declare
  card jsonb;
begin
  select x into card from jsonb_array_elements(public.project_task_cards((select id from b15_ids where name = 'p'), null)) x
  where x ->> 'id' = (select id::text from b15_ids where name = 'b');
  assert (card ->> 'blocked_by')::int = 2, 'the owner sees both blockers';
  assert jsonb_array_length(card -> 'blocker_ids') = 2, 'and both ids';
  select x into card from jsonb_array_elements(public.project_task_cards((select id from b15_ids where name = 'p'), null)) x
  where x ->> 'id' = (select id::text from b15_ids where name = 'a');
  assert card -> 'blocker_ids' = '[]'::jsonb, 'an unblocked task lists none';
end $$;

select set_config('request.jwt.claim.sub', 'b1500150-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  card jsonb;
begin
  select x into card from jsonb_array_elements(public.project_task_cards((select id from b15_ids where name = 'p'), null)) x
  where x ->> 'id' = (select id::text from b15_ids where name = 'b');
  assert (card ->> 'blocked_by')::int = 1, 'the viewer counts only the blocker they can read';
  assert card -> 'blocker_ids' = jsonb_build_array((select id::text from b15_ids where name = 'a')),
    'and never names the one in a project they aren''t in';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 117 hidden view tabs
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'b1500150-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b15_ids where name = 'p');
  board uuid := (select v.id from public.project_views v where v.project_id = p and v.layout = 'board' and v.owner_id is null limit 1);
  list uuid := (select v.id from public.project_views v where v.project_id = p and v.layout = 'list' and v.owner_id is null limit 1);
  mine uuid;
  saved uuid[];
begin
  assert board is not null and list is not null, 'the project has its default views';
  insert into public.project_views (project_id, name, layout, owner_id) values (p, 'My own', 'list', auth.uid()) returning id into mine;
  insert into public.project_view_settings (project_id, hidden_view_ids)
  values (p, array[board, board, mine, (select id from b15_ids where name = 'qview'), 'b1500150-0000-4000-8000-0000000000ff']);
  select hidden_view_ids into saved from public.project_view_settings where project_id = p;
  assert saved = array[board], 'only this project''s shared views, once each (not a personal view, another project''s, or an unknown id)';
  update public.project_view_settings set hidden_view_ids = array[board, list] where project_id = p;
  select hidden_view_ids into saved from public.project_view_settings where project_id = p;
  assert cardinality(saved) = 2, 'an Editor hides another one';
  -- Removing a view leaves a stale id in the array; it's dropped at the next change.
  update public.project_view_settings set hidden_view_ids = array[list] where project_id = p;
  assert (select hidden_view_ids from public.project_view_settings where project_id = p) = array[list], 'and shows one again';
end $$;

select set_config('request.jwt.claim.sub', 'b1500150-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  n integer;
begin
  update public.project_view_settings set hidden_view_ids = '{}' where project_id = (select id from b15_ids where name = 'p');
  get diagnostics n = row_count;
  assert n = 0, 'a Viewer can''t show or hide tabs';
  assert (select cardinality(hidden_view_ids) from public.project_view_settings where project_id = (select id from b15_ids where name = 'p')) = 1,
    'a Viewer reads which tabs are hidden';
end $$;

reset role;

select 'nov2 batch15 smoke: all assertions passed' as result;
