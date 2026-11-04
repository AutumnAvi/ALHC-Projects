-- Nov 4 notes, batch 22 (20261104030000_nov4_batch22_a.sql): the screen loaders. Each returns what the
-- separate reads it replaces return, through RLS as the caller, and nothing for someone who can't read it.
--   b2200000…11 b22-ana@example.com   Ana Owner   (owns the project, is assigned tasks)
--   b2200000…12 b22-ben@example.com   Ben Editor  (a member)
--   b2200000…13 b22-cat@example.com   Cat Outside (allowlisted, not a member)

\set ON_ERROR_STOP 1

create temporary table b22_ids (name text primary key, id uuid) on commit preserve rows;
grant all on b22_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('b22-ana@example.com', 'batch 22'),
  ('b22-ben@example.com', 'batch 22'),
  ('b22-cat@example.com', 'batch 22');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b2200000-0000-4000-8000-000000000011', 'b22-ana@example.com', now(), '{"full_name":"Ana Owner"}'),
  ('b2200000-0000-4000-8000-000000000012', 'b22-ben@example.com', now(), '{"full_name":"Ben Editor"}'),
  ('b2200000-0000-4000-8000-000000000013', 'b22-cat@example.com', now(), '{"full_name":"Cat Outside"}');

-- The functions: invoker, stable, an empty search_path, authenticated only.
do $$
declare
  fn regprocedure;
begin
  foreach fn in array array[
    'public.viewer_member()', 'public.app_shell()', 'public.project_frame(uuid)',
    'public.project_view_page(uuid, jsonb, text, text, jsonb, integer, jsonb)', 'public.my_task_bundle(uuid[])',
    'public.my_tasks_screen()', 'public.home_screen(text)', 'public.task_pane_rows(uuid, integer, integer)'
  ]::regprocedure[] loop
    assert not (select prosecdef from pg_catalog.pg_proc where oid = fn), format('%s is security invoker', fn);
    assert (select provolatile from pg_catalog.pg_proc where oid = fn) = 's', format('%s is stable', fn);
    assert (select proconfig from pg_catalog.pg_proc where oid = fn) = array['search_path=""'],
      format('%s has an empty search_path', fn);
    assert has_function_privilege('authenticated', fn, 'execute'), format('%s: authenticated executes it', fn);
    assert not has_function_privilege('anon', fn, 'execute'), format('%s: nothing for anon', fn);
  end loop;
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b2200000-0000-4000-8000-000000000011', false) is not null as ok \gset
do $$
declare
  p uuid;
  s uuid;
  t uuid;
  sub uuid;
  f uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B22 Project') returning id into p;
  insert into public.sections (project_id, name) values (p, 'Doing') returning id into s;
  perform public.add_project_member(p, 'b22-ben@example.com', 'editor');
  insert into public.custom_fields (project_id, name, field_type) values (p, 'B22 Notes', 'text') returning id into f;
  t := public.create_task(p, s, 'B22 Task');
  update public.tasks set assignee_id = 'b2200000-0000-4000-8000-000000000011', due_on = current_date where id = t;
  sub := public.create_subtask(t, 'B22 Subtask', null);
  update public.tasks set assignee_id = 'b2200000-0000-4000-8000-000000000011' where id = sub;
  insert into public.comments (task_id, author_id, body) values (t, 'b2200000-0000-4000-8000-000000000011', 'B22 hello');
  perform public.set_project_starred(p, true);
  insert into b22_ids values ('p', p), ('s', s), ('t', t), ('sub', sub), ('f', f);
end $$;

-- Ana (the owner): every loader returns what the separate reads return.
do $$
declare
  p uuid := (select id from b22_ids where name = 'p');
  t uuid := (select id from b22_ids where name = 't');
  sub uuid := (select id from b22_ids where name = 'sub');
  me uuid := 'b2200000-0000-4000-8000-000000000011';
  v jsonb := public.viewer_member();
  shell jsonb := public.app_shell();
  frame jsonb := public.project_frame(p);
  pane jsonb := public.task_pane_rows(t);
  bundle jsonb := public.my_task_bundle();
  page jsonb;
begin
  assert v ->> 'allowlisted' = 'true' and v -> 'profile' ->> 'full_name' = 'Ana Owner', 'viewer_member: Ana';

  -- app_shell: the projects, stars, roles, people, and inbox count the sidebar reads.
  assert (select array_agg(x ->> 'id' order by ord) from jsonb_array_elements(shell -> 'projects') with ordinality as e(x, ord))
       = (select array_agg(pr.id::text order by pr.sort_order, pr.created_at) from public.projects pr where pr.deleted_at is null),
    'app_shell.projects = the readable projects, in order';
  assert shell -> 'star_ids' @> to_jsonb(array[p]), 'app_shell.star_ids has the starred project';
  assert (shell -> 'own_roles') @> jsonb_build_array(jsonb_build_object('project_id', p, 'role', 'owner')), 'own role';
  assert (shell ->> 'unread_count')::int = public.inbox_unread_count(), 'unread count';
  assert jsonb_array_length(shell -> 'profiles') = (select count(*) from public.profiles), 'every readable profile';
  assert (shell -> 'workspace' ->> 'id')::uuid = (
    select w.id from public.workspaces w where w.deleted_at is null order by w.created_at limit 1), 'the workspace';

  -- project_frame: the project, role, and each list the project layout reads.
  assert frame -> 'project' ->> 'name' = 'B22 Project' and frame ->> 'role' = 'owner', 'project and role';
  assert frame -> 'access_status' = 'null'::jsonb, 'no access status for a member';
  assert (select array_agg(x ->> 'id') from jsonb_array_elements(frame -> 'views') x)
       = (select array_agg(pv.id::text order by pv.sort_order, pv.created_at) from public.project_views pv
          where pv.project_id = p and pv.deleted_at is null), 'views, in order';
  assert (select array_agg(x ->> 'id') from jsonb_array_elements(frame -> 'sections') x)
       = (select array_agg(se.id::text order by se.sort_order, se.created_at) from public.sections se
          where se.project_id = p and se.deleted_at is null), 'sections, in order';
  assert (select array_agg(x ->> 'profile_id' order by x ->> 'profile_id') from jsonb_array_elements(frame -> 'members') x)
       = array['b2200000-0000-4000-8000-000000000011', 'b2200000-0000-4000-8000-000000000012'], 'members';
  assert jsonb_array_length(frame -> 'fields') = 1 and frame -> 'fields' -> 0 ->> 'name' = 'B22 Notes', 'fields';

  -- project_view_page: project_task_card_page's own answer, plus labels and section counts.
  page := public.project_view_page(p, '{}', 'UTC', 'section', '[]', 50, '{}');
  assert page -> 'page' = public.project_task_card_page(p, '{}', 'UTC', 'section', '[]', 50, '{}'), 'the card page';
  assert page -> 'section_counts' = public.project_section_task_counts(p), 'section counts';

  -- my_task_bundle / screens: my_task_cards' own answer and the rows the app combines.
  assert bundle -> 'cards' = public.my_task_cards(), 'the cards';
  assert (public.my_tasks_screen() -> 'tasks' -> 'cards') = public.my_task_cards(), 'my_tasks_screen.tasks';
  assert (public.home_screen('UTC') -> 'dashboard') = public.home_dashboard('UTC'), 'home_screen.dashboard';
  assert (public.home_screen('UTC') -> 'inbox') = public.inbox_page('activity'), 'home_screen.inbox';
  assert (select count(*) from jsonb_array_elements(bundle -> 'access_tasks') x where (x ->> 'id')::uuid in (t, sub)) = 2,
    'access rows for both assigned tasks';
  assert bundle -> 'access_memberships' @> jsonb_build_array(jsonb_build_object('task_id', t, 'project_id', p)),
    'the top-level task''s project';

  -- task_pane_rows: the task and the reads the pane makes.
  assert pane -> 'task' ->> 'title' = 'B22 Task', 'the task';
  assert (select array_agg(x ->> 'id') from jsonb_array_elements(pane -> 'subtasks') x) = array[sub::text], 'subtasks';
  assert pane -> 'memberships' -> 0 ->> 'project_id' = p::text, 'memberships';
  assert pane -> 'comment_page' = public.task_comment_page(t, null, null, 100), 'the comment page';
  assert pane ->> 'task_role' = public.task_role(t), 'task role';
  assert (pane ->> 'blocker_count')::int = public.open_blocker_count(t), 'blocker count';
  assert jsonb_array_length(pane -> 'stories') = (select count(*) from public.task_stories st where st.task_id = t), 'stories';
  assert (public.task_pane_rows(sub) -> 'task' ->> 'parent_task_id')::uuid = t, 'a subtask''s pane';
end $$;

-- Cat (allowlisted, not a member): nothing about the project or its tasks.
select set_config('request.jwt.claim.sub', 'b2200000-0000-4000-8000-000000000013', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b22_ids where name = 'p');
  t uuid := (select id from b22_ids where name = 't');
  shell jsonb := public.app_shell();
  frame jsonb := public.project_frame(p);
  page jsonb := public.project_view_page(p, '{}', 'UTC', 'section', '[]', 50, '{}');
begin
  assert not (shell -> 'projects') @> jsonb_build_array(jsonb_build_object('id', p)), 'not in the sidebar';
  assert not exists (select 1 from jsonb_array_elements(shell -> 'projects') x where (x ->> 'id')::uuid = p), 'no project row';
  assert frame -> 'project' = 'null'::jsonb and frame -> 'role' = 'null'::jsonb, 'no project, no role';
  assert frame ->> 'access_status' = public.project_access_status(p), 'only the request page''s answer';
  assert frame -> 'views' = '[]' and frame -> 'sections' = '[]' and frame -> 'members' = '[]' and frame -> 'fields' = '[]'
    and frame -> 'forms' = '[]' and frame -> 'rules' = '[]' and frame -> 'task_templates' = '[]', 'no lists';
  assert not exists (
    select 1 from jsonb_array_elements(coalesce(page -> 'page' -> 'groups', '[]')) g,
      jsonb_array_elements(coalesce(g -> 'cards', '[]')) c
    where (c ->> 'id')::uuid = t), 'no cards';
  assert public.task_pane_rows(t) -> 'task' = 'null'::jsonb, 'no task pane';
  assert public.task_pane_rows(t) - 'version' = '{"task": null}'::jsonb, 'and nothing else about it';
  assert not exists (select 1 from jsonb_array_elements(public.my_task_bundle() -> 'access_tasks') x
                     where (x ->> 'id')::uuid = t), 'not among her tasks';
end $$;

-- Someone not allowlisted reads nothing at all.
select set_config('request.jwt.claim.sub', 'b2200000-0000-4000-8000-0000000000ff', false) is not null as ok \gset
do $$
declare
  shell jsonb := public.app_shell();
begin
  assert public.viewer_member() ->> 'allowlisted' = 'false' and public.viewer_member() -> 'profile' = 'null'::jsonb, 'not allowlisted';
  assert shell -> 'projects' = '[]' and shell -> 'profiles' = '[]' and shell -> 'workspace' = 'null'::jsonb, 'an empty shell';
end $$;

reset role;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset

select 'zz52_nov4_batch22_smoke: ok';
