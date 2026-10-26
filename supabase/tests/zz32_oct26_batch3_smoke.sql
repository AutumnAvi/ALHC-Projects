-- Oct 26 notes, batch 3 (20261026010000_oct26_batch3_a.sql).
--   b3b30026…01 b3-owner@example.com     owns the project
--   b3b30026…02 b3-outsider@example.com  allowlisted, not a member
--   b3b30026…03 b3-other@example.com     another allowlisted person
--   b3b30026…04 b3-admin@example.com     a workspace admin (no project access)

\set ON_ERROR_STOP 1

insert into public.allowed_emails (email, note) values
  ('b3-owner@example.com', 'oct 26 batch 3'),
  ('b3-outsider@example.com', 'oct 26 batch 3'),
  ('b3-other@example.com', 'oct 26 batch 3'),
  ('b3-admin@example.com', 'oct 26 batch 3');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b3b30026-0000-4000-8000-000000000001', 'b3-owner@example.com', now(), '{"full_name":"Olive Owner"}'),
  ('b3b30026-0000-4000-8000-000000000002', 'b3-outsider@example.com', now(), '{"full_name":"Oscar Outsider"}'),
  ('b3b30026-0000-4000-8000-000000000003', 'b3-other@example.com', now(), '{"full_name":"Otto Other"}'),
  ('b3b30026-0000-4000-8000-000000000004', 'b3-admin@example.com', now(), '{"full_name":"Ada Admin"}');
select public.seed_workspace_admin('b3-admin@example.com');

create temporary table b3_ids (name text primary key, id uuid);
grant all on b3_ids to authenticated, anon;

-- ---------------------------------------------------------------------------------------------
-- 3. Requests to be added to a project
-- ---------------------------------------------------------------------------------------------

do $$
begin
  assert (select relrowsecurity from pg_class where oid = 'public.project_access_requests'::regclass), 'RLS on';
  assert not has_table_privilege('authenticated', 'public.project_access_requests', 'INSERT'), 'no client inserts';
  assert not has_table_privilege('authenticated', 'public.project_access_requests', 'UPDATE'), 'no client updates';
  assert not has_table_privilege('anon', 'public.project_access_requests', 'SELECT'), 'nothing for anon';
  assert not has_function_privilege('anon', 'public.request_project_access(uuid)', 'execute'), 'anon can''t ask';
  assert not has_function_privilege('authenticated', 'public.mark_access_request_items(uuid)', 'execute'), 'internal';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b3b30026-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid;
  gone uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'Private brief')
    returning id into p;
  insert into b3_ids values ('p', p);
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'Gone soon')
    returning id into gone;
  insert into b3_ids values ('gone', gone);
  update public.projects set deleted_at = now() where id = gone;
  assert public.project_access_status(p) = 'member', 'the owner is a member';
end $$;

select set_config('request.jwt.claim.sub', 'b3b30026-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b3_ids where name = 'p');
begin
  assert not exists (select 1 from public.projects where id = p), 'the outsider can''t read the project';
  assert public.project_access_status(p) = 'can_request', 'but can ask';
  assert public.project_access_status((select id from b3_ids where name = 'gone')) = 'missing', 'deleted = Not found';
  assert public.project_access_status(gen_random_uuid()) = 'missing', 'unknown = Not found';
  assert public.request_project_access(p) = 'requested', 'asked';
  assert public.request_project_access(p) = 'requested', 'asking again keeps the one request';
  assert public.project_access_status(p) = 'requested', 'shows as requested';
  assert (select count(*) from public.project_access_requests where project_id = p) = 1, 'one request, readable by its requester';
  begin
    perform public.request_project_access((select id from b3_ids where name = 'gone'));
    raise exception 'a deleted project can''t be asked about';
  exception when no_data_found then null;
  end;
end $$;

-- Nobody else reads the request (workspace admins included).
select set_config('request.jwt.claim.sub', 'b3b30026-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.project_access_requests), 'a workspace admin sees no requests';
  begin
    perform public.decide_project_access_request(
      (select r.id from public.project_access_requests r limit 1), 'approve', 'editor');
    raise exception 'unreachable';
  exception when no_data_found then null;
  end;
end $$;
reset role;
do $$
declare
  req uuid := (select id from public.project_access_requests where project_id = (select id from b3_ids where name = 'p'));
begin
  insert into b3_ids values ('req', req);
  assert exists (
    select 1 from public.inbox_items
    where recipient_id = 'b3b30026-0000-4000-8000-000000000001' and kind = 'rule'
      and data ->> 'access_request_id' = req::text and data ->> 'access_request_status' = 'pending'
  ), 'the owner is told';
  assert not exists (
    select 1 from public.inbox_items where recipient_id = 'b3b30026-0000-4000-8000-000000000004' and data ? 'access_request'
  ), 'the workspace admin is not';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b3b30026-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
begin
  begin
    perform public.decide_project_access_request((select id from b3_ids where name = 'req'), 'approve', 'editor');
    raise exception 'only the project''s admins decide';
  exception when no_data_found then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'b3b30026-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b3_ids where name = 'p');
  req uuid := (select id from b3_ids where name = 'req');
begin
  assert exists (select 1 from public.project_access_requests where id = req), 'the owner reads it';
  assert public.decide_project_access_request(req, 'approve', 'viewer') = 'approved', 'approved';
  assert (select role from public.project_members where project_id = p and profile_id = 'b3b30026-0000-4000-8000-000000000002'
    and deleted_at is null) = 'viewer', 'added with the chosen role';
  assert public.decide_project_access_request(req, 'decline') = 'approved', 'a decided request stays decided';
  assert (select data ->> 'access_request_status' from public.inbox_items
    where recipient_id = 'b3b30026-0000-4000-8000-000000000001' and data ->> 'access_request_id' = req::text) = 'approved',
    'the owner''s card says so';
end $$;
select set_config('request.jwt.claim.sub', 'b3b30026-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  assert public.project_access_status((select id from b3_ids where name = 'p')) = 'member', 'now a member';
  assert exists (select 1 from public.inbox_items where data ->> 'access_granted' = 'true'), 'and told so';
end $$;

-- Declining, and joining another way closes an open request.
select set_config('request.jwt.claim.sub', 'b3b30026-0000-4000-8000-000000000003', false) is not null as ok \gset
select public.request_project_access((select id from b3_ids where name = 'p')) = 'requested' as ok \gset
select set_config('request.jwt.claim.sub', 'b3b30026-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b3_ids where name = 'p');
  req uuid := (select id from public.project_access_requests where project_id = p
    and requester_id = 'b3b30026-0000-4000-8000-000000000003' and status = 'pending');
begin
  assert public.decide_project_access_request(req, 'decline') = 'declined', 'declined';
end $$;
select set_config('request.jwt.claim.sub', 'b3b30026-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b3_ids where name = 'p');
begin
  assert public.project_access_status(p) = 'can_request', 'a declined person may ask again';
  assert public.request_project_access(p) = 'requested', 'and does';
end $$;
select set_config('request.jwt.claim.sub', 'b3b30026-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b3_ids where name = 'p');
begin
  perform public.add_project_member(p, 'b3-other@example.com', 'editor');
  assert not exists (select 1 from public.project_access_requests where project_id = p and status = 'pending'),
    'adding them closes the open request';
end $$;
reset role;

-- ---------------------------------------------------------------------------------------------
-- 4. The workspace's Tags switch
-- ---------------------------------------------------------------------------------------------

do $$
begin
  assert (select column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'workspaces' and column_name = 'tags_enabled') = 'false',
    'tags are off by default';
  assert has_column_privilege('authenticated', 'public.workspaces', 'tags_enabled', 'UPDATE'), 'grantable to admins (RLS decides)';
  assert not has_column_privilege('anon', 'public.workspaces', 'tags_enabled', 'UPDATE'), 'not anon';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b3b30026-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b3_ids where name = 'p');
  t uuid;
  g uuid;
begin
  t := public.create_task(p, null, 'Spring flyer');
  insert into b3_ids values ('tagged_task', t);
  insert into public.tags (workspace_id, name, color) values ('00000000-0000-4000-8000-000000000001', 'Zebracorn', 'red')
    returning id into g;
  insert into public.task_tags (task_id, tag_id) values (t, g);
  assert exists (select 1 from public.search_tasks('zebracorn', 10) where id = t), 'found by tag name while tags are on';
  -- A member who isn't a workspace admin can't flip it.
  update public.workspaces set tags_enabled = false;
  assert (select tags_enabled from public.workspaces where id = '00000000-0000-4000-8000-000000000001'),
    'members can''t turn tags off';
end $$;

select set_config('request.jwt.claim.sub', 'b3b30026-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
declare
  n integer;
begin
  update public.workspaces set tags_enabled = false where id = '00000000-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  assert n = 1, 'a workspace admin turns tags off';
end $$;

select set_config('request.jwt.claim.sub', 'b3b30026-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b3_ids where name = 'tagged_task');
begin
  assert not exists (select 1 from public.search_tasks('zebracorn', 10) where id = t), 'no tag-name matches while off';
  assert exists (select 1 from public.search_tasks('spring flyer', 10) where id = t), 'title search still works';
  assert exists (select 1 from public.task_tags where task_id = t and deleted_at is null), 'the tag link is kept';
  assert exists (select 1 from public.tags where name = 'Zebracorn' and deleted_at is null), 'and the tag';
end $$;

select set_config('request.jwt.claim.sub', 'b3b30026-0000-4000-8000-000000000004', false) is not null as ok \gset
update public.workspaces set tags_enabled = true where id = '00000000-0000-4000-8000-000000000001';
select set_config('request.jwt.claim.sub', 'b3b30026-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  assert exists (select 1 from public.search_tasks('zebracorn', 10) where id = (select id from b3_ids where name = 'tagged_task')),
    'back on: found by tag name again';
end $$;
reset role;

do $$ begin raise notice 'oct 26 batch 3 smoke: all assertions passed'; end $$;
