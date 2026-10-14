-- Stage 3: project_task_card_page returns the same cards as project_task_cards, a page at a
-- time, with the group's total. A non-member, including a workspace admin who is not a member,
-- gets nothing.
--
--   b3b3…01 page-owner@example.com   owner of the project
--   b3b3…02 page-other@example.com   allowlisted, not a member
--   b3b3…03 page-admin@example.com   workspace admin, not a member

\set ON_ERROR_STOP 1

reset role;

insert into public.allowed_emails (email, note) values
  ('page-owner@example.com', 'perf step 3'),
  ('page-other@example.com', 'perf step 3'),
  ('page-admin@example.com', 'perf step 3');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b3b3b3b3-0000-4000-8000-000000000001', 'page-owner@example.com', now(), '{"full_name":"Page Owner"}'),
  ('b3b3b3b3-0000-4000-8000-000000000002', 'page-other@example.com', now(), '{"full_name":"Page Other"}'),
  ('b3b3b3b3-0000-4000-8000-000000000003', 'page-admin@example.com', now(), '{"full_name":"Page Admin"}');
insert into public.workspace_admins (workspace_id, profile_id)
values ('00000000-0000-4000-8000-000000000001', 'b3b3b3b3-0000-4000-8000-000000000003');

do $$
begin
  assert has_function_privilege(
    'authenticated',
    'public.project_task_card_page(uuid, jsonb, text, text, jsonb, integer, jsonb)',
    'execute'
  ), 'signed-in members can page the cards';
  assert not has_function_privilege(
    'anon',
    'public.project_task_card_page(uuid, jsonb, text, text, jsonb, integer, jsonb)',
    'execute'
  ), 'anon cannot page the cards';
  assert (
    select prosecdef from pg_proc
    where oid = 'public.project_task_card_page(uuid, jsonb, text, text, jsonb, integer, jsonb)'::regprocedure
  ), 'the page function is security definer';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b3b3b3b3-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  p uuid;
  section uuid;
  ids uuid[] := '{}';
  task uuid;
  i integer;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Page P') returning id into p;
  insert into public.sections (project_id, name, sort_order) values (p, 'Doing', 1024) returning id into section;
  for i in 1..5 loop
    task := public.create_task(p, section, 'Card ' || i);
    update public.tasks set completed_at = now() where id = task and i = 3;
    update public.task_projects set sort_order = i * 1024
    where task_id = task and project_id = p and deleted_at is null;
    ids := ids || task;
  end loop;
  perform set_config('alhc.page_project', p::text, false);
  perform set_config('alhc.page_section', section::text, false);
  perform set_config('alhc.page_ids', ids::text, false);
end $$;

-- Default list: incomplete tasks, manual order, two per page. Walking the pages rebuilds the full set.
do $$
declare
  p uuid := current_setting('alhc.page_project')::uuid;
  section uuid := current_setting('alhc.page_section')::uuid;
  key text := 'section-' || section::text;
  all_cards jsonb;
  page jsonb;
  wider jsonb;
  group_row jsonb;
  expected jsonb;
begin
  select coalesce(jsonb_agg(c order by (c->>'sort_order')::float8, c->>'id'), '[]'::jsonb)
  into all_cards
  from jsonb_array_elements(public.project_task_cards(p, null)) c
  where c->>'completed_at' is null;

  page := public.project_task_card_page(p, '{}'::jsonb, 'UTC', 'section', null, 2, '{}'::jsonb);
  assert jsonb_array_length(page->'groups') = 1, 'one section group';
  group_row := page->'groups'->0;
  assert group_row->>'key' = key, format('group key, got %s', group_row->>'key');
  assert (group_row->>'total')::int = jsonb_array_length(all_cards), 'total is every incomplete task';
  assert jsonb_array_length(group_row->'cards') = 2, 'first page is two cards';
  assert group_row->'cards' = (select jsonb_agg(c) from jsonb_array_elements(all_cards) with ordinality t(c, n) where n <= 2),
    'first page matches the full list';
  assert group_row->>'next_id' = all_cards->2->>'id', 'next id is the third incomplete task';

  wider := public.project_task_card_page(
    p, '{}'::jsonb, 'UTC', 'section', null, 2,
    jsonb_build_object(key, 4)
  )->'groups'->0;
  assert (wider->>'total')::int = jsonb_array_length(all_cards), 'a longer page keeps the same total';
  assert jsonb_array_length(wider->'cards') = 4, 'the longer page returns every incomplete task';
  assert wider->'cards' = all_cards, 'pages together are the full card list';
  assert wider->>'next_id' is null, 'nothing is left after the last card';

  -- Every card object is the one project_task_cards built, not a second shape.
  select c into expected from jsonb_array_elements(all_cards) c where c->>'title' = 'Card 1';
  assert (wider->'cards'->0) = expected, 'a paged card equals the full-list card';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b3b3b3b3-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  p uuid := current_setting('alhc.page_project')::uuid;
begin
  assert public.project_task_card_page(p) = '{"groups":[]}'::jsonb, 'no membership, no page';
  assert public.project_task_cards(p, null) = '[]'::jsonb, 'no membership, no full list either';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b3b3b3b3-0000-4000-8000-000000000003', false) is not null as ok \gset

do $$
declare
  p uuid := current_setting('alhc.page_project')::uuid;
begin
  assert public.project_task_card_page(p) = '{"groups":[]}'::jsonb,
    'a workspace admin who is not a member sees no page';
end $$;

select 'perf step 3 smoke: all assertions passed' as result;
