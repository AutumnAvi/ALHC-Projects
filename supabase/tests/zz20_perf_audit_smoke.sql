-- Behavioural checks for the performance pass: project_task_cards, project_section_task_counts,
-- and task_comment_page. A member sees the same cards the row queries showed. A person who is
-- not a member, workspace admin included, sees nothing. Counts hide projects and predecessors
-- the caller cannot open.
--
--   c0c0…01 perf-owner@example.com   Ora Owner: owner of Perf P and Perf Hidden
--   c0c0…02 perf-mate@example.com    Max Mate: Editor of Perf P only
--   c0c0…03 perf-admin@example.com   Ada Admin: workspace admin, in no project

\set ON_ERROR_STOP 1

insert into public.allowed_emails (email, note) values
  ('perf-owner@example.com', 'perf suite'),
  ('perf-mate@example.com', 'perf suite'),
  ('perf-admin@example.com', 'perf suite');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('c0c0c0c0-0000-4000-8000-000000000001', 'perf-owner@example.com', now(), '{"full_name":"Ora Owner"}'),
  ('c0c0c0c0-0000-4000-8000-000000000002', 'perf-mate@example.com', now(), '{"full_name":"Max Mate"}'),
  ('c0c0c0c0-0000-4000-8000-000000000003', 'perf-admin@example.com', now(), '{"full_name":"Ada Admin"}');
insert into public.workspace_admins (workspace_id, profile_id)
values ('00000000-0000-4000-8000-000000000001', 'c0c0c0c0-0000-4000-8000-000000000003');

create temporary table perf_ids (name text primary key, id uuid) on commit preserve rows;
grant all on perf_ids to authenticated, anon, service_role;

do $$
begin
  assert has_function_privilege('authenticated', 'public.project_task_cards(uuid, uuid[])', 'execute')
    and has_function_privilege('authenticated', 'public.project_section_task_counts(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.task_comment_page(uuid, timestamp with time zone, uuid, integer)', 'execute'),
    'signed-in members can call the list and comment functions';
  assert not has_function_privilege('anon', 'public.project_task_cards(uuid, uuid[])', 'execute')
    and not has_function_privilege('anon', 'public.project_section_task_counts(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.task_comment_page(uuid, timestamp with time zone, uuid, integer)', 'execute'),
    'anon cannot call them';
  assert (select prosecdef from pg_proc where oid = 'public.project_task_cards(uuid, uuid[])'::regprocedure)
    and (select prosecdef from pg_proc where oid = 'public.project_section_task_counts(uuid)'::regprocedure)
    and (select prosecdef from pg_proc where oid = 'public.task_comment_page(uuid, timestamp with time zone, uuid, integer)'::regprocedure),
    'the three functions are security definer';
  assert exists (select 1 from pg_indexes where indexname = 'comments_task_timeline_idx'),
    'comment pages have a timeline index';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'c0c0c0c0-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  me uuid := 'c0c0c0c0-0000-4000-8000-000000000001';
  p uuid;
  hidden uuid;
  section uuid;
  visible_task uuid;
  other_task uuid;
  gone uuid;
  pred uuid;
  secret_pred uuid;
  child uuid;
  done_child uuid;
  field uuid;
  secret_field uuid;
  tag uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Perf P') returning id into p;
  insert into public.projects (workspace_id, name) values (ws, 'Perf Hidden') returning id into hidden;
  insert into public.sections (project_id, name, sort_order) values (p, 'Doing', 1024) returning id into section;
  perform public.add_project_member(p, 'perf-mate@example.com', 'editor');

  visible_task := public.create_task(p, section, 'Visible');
  other_task := public.create_task(p, section, 'Other');
  gone := public.create_task(p, section, 'Gone');
  update public.tasks set deleted_at = now() where id = gone;
  pred := public.create_task(p, section, 'Predecessor');
  secret_pred := public.create_task(hidden, null, 'Secret predecessor');

  insert into public.task_projects (task_id, project_id, section_id, sort_order)
  values (visible_task, hidden, null, 2048);

  perform public.set_task_dependency(pred, visible_task, 'finish_to_start', 0);
  perform public.set_task_dependency(secret_pred, visible_task, 'finish_to_start', 0);

  child := public.create_subtask(visible_task, 'Child', null);
  done_child := public.create_subtask(visible_task, 'Done child', null);
  update public.tasks set completed_at = now() where id = done_child;

  insert into public.custom_fields (project_id, name, field_type, show_in_views)
  values (p, 'Priority', 'text', true) returning id into field;
  insert into public.custom_fields (project_id, name, field_type)
  values (hidden, 'Secret', 'text') returning id into secret_field;
  insert into public.task_field_values (task_id, field_id, value)
  values (visible_task, field, '"High"'::jsonb),
         (visible_task, secret_field, '"Nope"'::jsonb);

  insert into public.tags (workspace_id, name, color) values (ws, 'Perf tag', 'blue') returning id into tag;
  insert into public.task_tags (task_id, tag_id) values (visible_task, tag);

  insert into public.comments (task_id, author_id, body, created_at) values
    (visible_task, me, 'one', '2026-01-01T00:00:00Z'),
    (visible_task, me, 'two', '2026-01-02T00:00:00Z'),
    (visible_task, me, 'three', '2026-01-03T00:00:00Z');

  insert into perf_ids values
    ('p', p), ('hidden', hidden), ('section', section),
    ('visible', visible_task), ('other', other_task), ('pred', pred),
    ('field', field), ('secret_field', secret_field), ('tag', tag);
end $$;

-- Owner sees both projects and both blockers.
do $$
declare
  p uuid := (select id from perf_ids where name = 'p');
  section uuid := (select id from perf_ids where name = 'section');
  visible uuid := (select id from perf_ids where name = 'visible');
  field uuid := (select id from perf_ids where name = 'field');
  secret_field uuid := (select id from perf_ids where name = 'secret_field');
  tag uuid := (select id from perf_ids where name = 'tag');
  cards jsonb := public.project_task_cards(p, null);
  card jsonb;
begin
  assert jsonb_array_length(cards) = 3, 'owner cards skip the task in the Trash';
  select c into card from jsonb_array_elements(cards) c where c->>'id' = visible::text;
  assert card->>'title' = 'Visible';
  assert (card->>'subtask_count')::int = 2 and (card->>'subtask_done_count')::int = 1, 'direct subtask counts';
  assert (card->>'project_count')::int = 2, 'owner can see the other project';
  assert (card->>'blocked_by')::int = 2, 'owner can see both open predecessors';
  assert (card->>'comment_count')::int = 3;
  assert card->'field_values'->>field::text = 'High';
  assert not (card->'field_values' ? secret_field::text), 'a field from another project stays off this card';
  assert card->'tag_ids' ? tag::text;
  assert (public.project_section_task_counts(p)->>section::text)::int = 3, 'section counts include every live task';
  assert jsonb_array_length(public.project_task_cards(p, array[visible])) = 1, 'only_ids keeps just those tasks';
  assert public.project_task_cards(p, '{}'::uuid[]) = '[]'::jsonb, 'an empty id list is an empty page';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'c0c0c0c0-0000-4000-8000-000000000002', false) is not null as ok \gset

-- Mate is not in the hidden project.
do $$
declare
  p uuid := (select id from perf_ids where name = 'p');
  hidden uuid := (select id from perf_ids where name = 'hidden');
  visible uuid := (select id from perf_ids where name = 'visible');
  card jsonb;
begin
  select c into card
  from jsonb_array_elements(public.project_task_cards(p, null)) c
  where c->>'id' = visible::text;
  assert (card->>'project_count')::int = 1, 'a project the caller cannot open is not counted';
  assert (card->>'blocked_by')::int = 1, 'a predecessor the caller cannot open is not counted';
  assert public.project_task_cards(hidden, null) = '[]'::jsonb, 'no membership, no cards';
  assert public.project_section_task_counts(hidden) = '{}'::jsonb, 'no membership, no section counts';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'c0c0c0c0-0000-4000-8000-000000000003', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from perf_ids where name = 'p');
  visible uuid := (select id from perf_ids where name = 'visible');
  page jsonb;
begin
  assert public.project_task_cards(p, null) = '[]'::jsonb, 'a workspace admin who is not a member sees no cards';
  assert public.project_section_task_counts(p) = '{}'::jsonb, 'and no section counts';
  page := public.task_comment_page(visible, null, null, 10);
  assert page->'comments' = '[]'::jsonb and (page->>'total')::int = 0, 'and no comments';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'c0c0c0c0-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  visible uuid := (select id from perf_ids where name = 'visible');
  page jsonb := public.task_comment_page(visible, null, null, 2);
  older jsonb;
  first_body text;
  cursor_at timestamp with time zone;
  cursor_id uuid;
begin
  assert (page->>'total')::int = 3, 'total counts comments that are still there';
  assert (page->>'has_more')::boolean, 'two of three leaves an older page';
  assert jsonb_array_length(page->'comments') = 2;
  assert (page->'comments'->0->>'body') = 'two';
  assert (page->'comments'->1->>'body') = 'three';
  cursor_at := (page->'comments'->0->>'created_at')::timestamptz;
  cursor_id := (page->'comments'->0->>'id')::uuid;
  older := public.task_comment_page(visible, cursor_at, cursor_id, 2);
  assert (older->>'has_more')::boolean = false;
  assert jsonb_array_length(older->'comments') = 1;
  assert older->'comments'->0->>'body' = 'one';
  first_body := page->'comments'->0->>'body';
  assert first_body = 'two';

  update public.comments set deleted_at = now()
  where task_id = visible and body = 'one';
  older := public.task_comment_page(visible, cursor_at, cursor_id, 2);
  assert (older->>'total')::int = 2, 'a removed comment drops out of the total';
  assert older->'comments'->0->>'body' = '', 'a removed comment keeps its place with an empty body';
  assert older->'comments'->0->>'deleted_at' is not null;
  assert older->'comments'->0->'mention_ids' = '[]'::jsonb;
  assert older->'comments'->0->'reactions' = '[]'::jsonb;
end $$;

select 'perf audit smoke: all assertions passed' as result;
