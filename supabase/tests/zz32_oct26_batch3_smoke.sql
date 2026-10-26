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

-- ---------------------------------------------------------------------------------------------
-- 5. Personal sidebar folders: private to each person
-- ---------------------------------------------------------------------------------------------

do $$
begin
  assert (select relrowsecurity from pg_class where oid = 'public.sidebar_folders'::regclass), 'RLS on folders';
  assert (select relrowsecurity from pg_class where oid = 'public.sidebar_folder_projects'::regclass), 'RLS on placements';
  assert not has_table_privilege('anon', 'public.sidebar_folders', 'SELECT'), 'nothing for anon';
  assert not has_table_privilege('authenticated', 'public.sidebar_folders', 'DELETE'), 'no hard deletes';
  assert not has_table_privilege('authenticated', 'public.sidebar_folder_projects', 'DELETE'), 'no hard deletes';
  assert not has_column_privilege('authenticated', 'public.sidebar_folders', 'profile_id', 'UPDATE'), 'the owner is fixed';
  assert not has_column_privilege('authenticated', 'public.sidebar_folder_projects', 'project_id', 'UPDATE'), 'the project is fixed';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b3b30026-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  f uuid;
  p uuid := (select id from b3_ids where name = 'p');
begin
  insert into public.sidebar_folders (name, sort_order) values ('  Clients  ', 1024) returning id into f;
  insert into b3_ids values ('folder', f);
  assert (select name from public.sidebar_folders where id = f) = 'Clients', 'names are trimmed';
  assert (select profile_id from public.sidebar_folders where id = f) = 'b3b30026-0000-4000-8000-000000000001', 'mine';
  insert into public.sidebar_folder_projects (folder_id, project_id, sort_order) values (f, p, 1024);
  update public.sidebar_folders set collapsed = true, name = 'Client work' where id = f;
  assert (select collapsed from public.sidebar_folders where id = f), 'collapsed';
end $$;

-- Another person (a member of the same project) sees and changes nothing of it.
select set_config('request.jwt.claim.sub', 'b3b30026-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  f uuid := (select id from b3_ids where name = 'folder');
  p uuid := (select id from b3_ids where name = 'p');
  n integer;
begin
  assert not exists (select 1 from public.sidebar_folders), 'someone else''s folders are invisible';
  assert not exists (select 1 from public.sidebar_folder_projects), 'and so are their placements';
  update public.sidebar_folders set name = 'Hijacked' where id = f;
  get diagnostics n = row_count;
  assert n = 0, 'nobody renames someone else''s folder';
  update public.sidebar_folders set deleted_at = now() where id = f;
  get diagnostics n = row_count;
  assert n = 0, 'or removes it';
  begin
    insert into public.sidebar_folder_projects (folder_id, project_id) values (f, p);
    raise exception 'filing into someone else''s folder should be refused';
  exception when no_data_found then null;
  end;
  begin
    insert into public.sidebar_folders (profile_id, name) values ('b3b30026-0000-4000-8000-000000000001', 'Planted');
    raise exception 'a folder can''t be made for someone else';
  exception when insufficient_privilege then null;
  end;
  -- Their own folder for the same project is theirs alone.
  insert into public.sidebar_folders (name) values ('Mine too') returning id into f;
  insert into public.sidebar_folder_projects (folder_id, project_id) values (f, p);
  assert (select count(*) from public.sidebar_folder_projects) = 1, 'one placement of their own';
end $$;

-- Not a member: a project they can't open can't be filed.
select set_config('request.jwt.claim.sub', 'b3b30026-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
begin
  insert into public.sidebar_folder_projects (project_id) values ((select id from b3_ids where name = 'p'));
  raise exception 'a project you can''t open can''t be filed';
exception when insufficient_privilege then null;
end $$;

-- Removing a folder puts its projects back under Projects; the other person's folder is untouched.
select set_config('request.jwt.claim.sub', 'b3b30026-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  f uuid := (select id from b3_ids where name = 'folder');
begin
  update public.sidebar_folders set deleted_at = now() where id = f;
  assert (select folder_id from public.sidebar_folder_projects where project_id = (select id from b3_ids where name = 'p')) is null,
    'the project is back under Projects';
  begin
    update public.sidebar_folders set deleted_at = null where id = f;
    raise exception 'a removed folder stays removed';
  exception when check_violation then null;
  end;
end $$;
reset role;
do $$
begin
  assert (select count(*) from public.sidebar_folders where name = 'Mine too' and deleted_at is null) = 1,
    'the other person''s folder is untouched';
  assert (select folder_id from public.sidebar_folder_projects
    where profile_id = 'b3b30026-0000-4000-8000-000000000002') is not null, 'and so is their placement';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 6. Reply attachments: a blocked type is a reason the card can show
-- ---------------------------------------------------------------------------------------------

do $$
begin
  assert pg_get_functiondef('public.note_reply_skipped_files(uuid, jsonb)'::regprocedure) like '%''blocked_type''%',
    'blocked_type is kept as a reason';
  assert not has_function_privilege('authenticated', 'public.note_reply_skipped_files(uuid, jsonb)', 'execute'),
    'still service role only';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 7. Review checks: hashed, expiring links; only the round's own files; one decision
-- ---------------------------------------------------------------------------------------------

do $$
begin
  assert not has_column_privilege('authenticated', 'public.review_checks', 'token_hash', 'SELECT'), 'nobody reads the hash';
  assert has_column_privilege('authenticated', 'public.review_checks', 'status', 'SELECT'), 'the round is readable';
  assert not has_table_privilege('authenticated', 'public.review_checks', 'INSERT'), 'no client inserts';
  assert not has_table_privilege('authenticated', 'public.review_checks', 'UPDATE'), 'no client updates';
  assert not has_table_privilege('authenticated', 'public.review_check_pins', 'INSERT'), 'pins come from the decision';
  assert not has_table_privilege('anon', 'public.review_checks', 'SELECT'), 'anon reads no table';
  assert not has_table_privilege('anon', 'public.review_check_files', 'SELECT'), 'anon reads no table';
  assert has_function_privilege('anon', 'public.review_check_view(text)', 'execute'), 'the page runs as anon';
  assert not has_function_privilege('authenticated', 'public.review_check_view(text)', 'execute'), 'only through the page';
  assert not has_function_privilege('anon', 'public.create_review_check(uuid, uuid[], text, text, text)', 'execute'), 'anon sends nothing';
  assert not has_function_privilege('anon', 'public.review_check_by_token(text)', 'execute'), 'internal';
  assert not has_function_privilege('authenticated', 'public.review_check_hit(uuid)', 'execute'), 'internal';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b3b30026-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b3_ids where name = 'p');
  t uuid;
  other_task uuid;
  a1 uuid;
  a2 uuid;
  stranger uuid;
  result jsonb;
begin
  t := public.create_task(p, null, 'Poster design');
  insert into b3_ids values ('rt', t);
  update public.tasks set assignee_id = 'b3b30026-0000-4000-8000-000000000003' where id = t;
  insert into public.task_attachments (task_id, storage_path, file_name, content_type, size_bytes)
    values (t, t::text || '/a1-poster.png', 'poster.png', 'image/png', 1000) returning id into a1;
  insert into public.task_attachments (task_id, storage_path, file_name, content_type, size_bytes)
    values (t, t::text || '/a2-proof.pdf', 'proof.pdf', 'application/pdf', 2000) returning id into a2;
  other_task := public.create_task(p, null, 'Another task');
  insert into public.task_attachments (task_id, storage_path, file_name, content_type, size_bytes)
    values (other_task, other_task::text || '/x-other.png', 'other.png', 'image/png', 10) returning id into stranger;
  insert into b3_ids values ('a1', a1), ('a2', a2);

  begin
    perform public.create_review_check(t, array[stranger], 'client@example.org');
    raise exception 'files of another task can''t be sent';
  exception when check_violation then null;
  end;
  begin
    perform public.create_review_check(t, array[a1], 'not an email');
    raise exception 'a bad address is refused';
  exception when check_violation then null;
  end;

  result := public.create_review_check(t, array[a1, a2], ' Client@Example.org ', 'Cara Client', 'Please check the poster');
  assert (result ->> 'round')::int = 1, 'v1';
  assert result ->> 'token' ~ '^alhc_rev_[0-9a-f]{64}$', 'a long random token, once';
  insert into b3_ids values ('rc1', (result ->> 'id')::uuid);
  create temporary table if not exists b3_tokens (name text primary key, token text);
  insert into b3_tokens values ('v1', result ->> 'token');
  assert (select recipient_email from public.review_checks where id = (result ->> 'id')::uuid) = 'client@example.org', 'lowercased';
  assert (select count(*) from public.review_check_assets where review_id = (result ->> 'id')::uuid) = 2, 'two files';
end $$;
reset role;
grant all on b3_tokens to anon, authenticated;
do $$
begin
  assert (select token_hash from public.review_checks where id = (select id from b3_ids where name = 'rc1'))
    = encode(sha256(convert_to((select token from b3_tokens where name = 'v1'), 'UTF8')), 'hex'), 'only the hash is stored';
  assert not exists (select 1 from public.review_checks where token_hash like 'alhc_rev_%'), 'never the token';
end $$;

-- A Viewer of the project reads the round but can't send one; a workspace admin outside it sees nothing.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b3b30026-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  assert exists (select 1 from public.review_checks where id = (select id from b3_ids where name = 'rc1')), 'Viewers read it';
  begin
    perform public.create_review_check((select id from b3_ids where name = 'rt'), array[(select id from b3_ids where name = 'a1')], 'x@example.org');
    raise exception 'Viewers can''t send';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', 'b3b30026-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.review_checks), 'outside the project: nothing';
  assert not exists (select 1 from public.review_check_assets), 'nothing';
  begin
    perform public.create_review_check((select id from b3_ids where name = 'rt'), array[(select id from b3_ids where name = 'a1')], 'x@example.org');
    raise exception 'outsiders can''t send';
  exception when no_data_found then null;
  end;
end $$;

-- The public page, as anon with only the token.
reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
do $$
declare
  token text := (select token from b3_tokens where name = 'v1');
  view jsonb;
  asset uuid;
  started jsonb;
begin
  assert public.review_check_view('nope') ->> 'status' = 'unknown', 'malformed';
  assert public.review_check_view('alhc_rev_' || repeat('0', 64)) ->> 'status' = 'unknown', 'well-formed but unknown';
  assert public.review_check_view(upper(token)) ->> 'status' = 'unknown', 'exact token only';
  view := public.review_check_view(token);
  assert view ->> 'status' = 'ok', 'the link works';
  assert jsonb_array_length(view -> 'assets') = 2, 'its two files';
  assert view -> 'review' ->> 'task_title' = 'Poster design';
  assert not (view -> 'review' ? 'token_hash') and not (view::text like '%' || token || '%'), 'nothing secret comes back';
  asset := (view -> 'assets' -> 0 ->> 'id')::uuid;
  insert into b3_ids values ('asset1', asset);
  assert public.review_check_file(token, asset) ->> 'status' = 'ok', 'a file of the round';
  assert public.review_check_file(token, (select id from b3_ids where name = 'a1')) ->> 'status' = 'unknown',
    'by asset id only, never a raw attachment id';
  assert public.review_check_file(token, gen_random_uuid()) ->> 'status' = 'unknown', 'nothing else';

  assert public.review_check_upload_start(token, 'setup.exe', 'application/octet-stream', 100) ->> 'status' = 'blocked_type', 'no programs';
  assert public.review_check_upload_start(token, 'page.html', 'text/html', 100) ->> 'status' = 'blocked_type', 'no web pages';
  assert public.review_check_upload_start(token, 'huge.mov', 'video/quicktime', 26214401) ->> 'status' = 'too_large', '25 MB';
  started := public.review_check_upload_start(token, 'Final poster.png', 'image/png', 5000);
  assert started ->> 'status' = 'ok', 'a file back';
  assert started ->> 'path' like (select id from b3_ids where name = 'rt')::text || '/%-review-Final_poster.png', 'in the task''s folder';
  insert into b3_ids values ('upload', (started ->> 'file_id')::uuid);
  insert into b3_tokens values ('upload_path', started ->> 'path');
  assert public.review_check_upload_finish(token, (started ->> 'file_id')::uuid) ->> 'status' = 'missing', 'not there yet';

  assert public.review_check_decide(token, 'changes_requested') ->> 'status' = 'empty', 'feedback needs words';
  assert public.review_check_decide(token, 'changes_requested', null, jsonb_build_array(
    jsonb_build_object('asset_id', asset, 'x', 0.5, 'y', 0.5, 'body', 'fine'),
    jsonb_build_object('asset_id', gen_random_uuid(), 'x', 0.5, 'y', 0.5, 'body', 'x'))) ->> 'status' = 'invalid',
    'a pin on someone else''s file is refused';
  assert public.review_check_decide(token, 'changes_requested', null,
    jsonb_build_array(jsonb_build_object('asset_id', repeat('-', 36), 'x', 0.5, 'y', 0.5, 'body', 'x'))) ->> 'status' = 'invalid',
    'a malformed id is refused, not an error';
  assert public.review_check_decide(token, 'changes_requested', null,
    jsonb_build_array(jsonb_build_object('asset_id', asset, 'page', 'two', 'x', 0.5, 'y', 0.5, 'body', 'x'))) ->> 'status' = 'invalid',
    'a page that isn''t a number is refused';
  assert public.review_check_decide(token, 'changes_requested', null,
    jsonb_build_array(jsonb_build_object('asset_id', asset, 'x', 1.5, 'y', 0.5, 'body', 'x'))) ->> 'status' = 'invalid',
    'a pin outside the file is refused';
  assert public.review_check_decide(token, 'maybe') ->> 'status' = 'invalid', 'two answers only';
  begin
    perform 1 from public.review_checks;
    raise exception 'anon reads no table';
  exception when insufficient_privilege then null;
  end;
end $$;

-- The upload lands in Storage (the app's signed upload link); finishing makes it part of the round.
reset role;
insert into storage.objects (bucket_id, name, metadata)
values ('task-attachments', (select token from b3_tokens where name = 'upload_path'), '{"size": 4321, "mimetype": "image/png"}');
set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
do $$
declare
  token text := (select token from b3_tokens where name = 'v1');
  asset uuid := (select id from b3_ids where name = 'asset1');
  result jsonb;
begin
  result := public.review_check_upload_finish(token, (select id from b3_ids where name = 'upload'));
  assert result ->> 'status' = 'ok', 'finished';
  assert (result -> 'file' ->> 'size')::int = 4321, 'the size Storage saw';
  assert jsonb_array_length(public.review_check_view(token) -> 'files') = 1, 'listed on the page';
  assert public.review_check_file(token, (select id from b3_ids where name = 'upload')) ->> 'status' = 'ok', 'and openable';

  result := public.review_check_decide(token, 'changes_requested', 'Bigger logo please', jsonb_build_array(
    jsonb_build_object('asset_id', asset, 'x', 0.25, 'y', 0.75, 'body', 'Make this bigger'),
    jsonb_build_object('asset_id', asset, 'page', 2, 'x', 0.5, 'y', 0.5, 'body', 'Typo here'),
    jsonb_build_object('asset_id', asset, 'time', 12.4, 'body', 'Cut here')
  ));
  assert result ->> 'status' = 'ok' and result ->> 'review_status' = 'changes_requested', 'feedback sent';
  assert public.review_check_decide(token, 'approved') ->> 'status' = 'closed', 'one decision per round';
  assert public.review_check_upload_start(token, 'late.png', 'image/png', 10) ->> 'status' = 'closed', 'no uploads after it';
  assert public.review_check_view(token) ->> 'status' = 'ok', 'still viewable until it expires';
end $$;
reset role;
do $$
declare
  rc uuid := (select id from b3_ids where name = 'rc1');
  c public.comments;
begin
  select * into c from public.comments where review_check_id = rc;
  assert c.id is not null, 'the outcome is a comment on the task';
  assert c.author_id is null and c.email_direction = 'received' and c.email_address = 'client@example.org', 'from the reviewer';
  assert c.body like 'Requested changes (review v1)%' and c.body like '%1. poster.png: Make this bigger%'
    and c.body like '%2. poster.png, page 2: Typo here%' and c.body like '%3. poster.png at 0:12: Cut here%'
    and c.body like '%Files sent back: Final poster.png%', format('pins summarized: %s', c.body);
  assert (select count(*) from public.review_check_pins where review_id = rc) = 3,
    'three pins (the refused attempts left none behind)';
  assert public.review_time_label(170) = '2:50' and public.review_time_label(12.4) = '0:12'
    and public.review_time_label(3725) = '1:02:05', 'video times';
  assert (select comment_id from public.review_checks where id = rc) = c.id, 'linked';
  assert exists (
    select 1 from public.inbox_items i
    where i.recipient_id = 'b3b30026-0000-4000-8000-000000000003' and i.kind = 'approval_decided'
      and i.data ->> 'review_check_id' = rc::text and i.data ->> 'status' = 'changes_requested'
  ), 'the assignee is told';
end $$;

-- Round 2 supersedes an open round 1; a new link replaces the old one; links expire; too many requests stop.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b3b30026-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  result jsonb;
  rotated jsonb;
begin
  result := public.create_review_check((select id from b3_ids where name = 'rt'), array[(select id from b3_ids where name = 'a1')], 'client@example.org');
  assert (result ->> 'round')::int = 2, 'v2';
  insert into b3_tokens values ('v2', result ->> 'token');
  insert into b3_ids values ('rc2', (result ->> 'id')::uuid);
  result := public.create_review_check((select id from b3_ids where name = 'rt'), array[(select id from b3_ids where name = 'a2')], 'client@example.org');
  assert (result ->> 'round')::int = 3, 'v3';
  insert into b3_tokens values ('v3', result ->> 'token');
  insert into b3_ids values ('rc3', (result ->> 'id')::uuid);
  assert (select status from public.review_checks where id = (select id from b3_ids where name = 'rc2')) = 'superseded', 'v2 superseded by v3';
  rotated := public.rotate_review_check_token((result ->> 'id')::uuid);
  insert into b3_tokens values ('v3b', rotated ->> 'token');
  assert public.cancel_review_check((select id from b3_ids where name = 'rc1')) = 'changes_requested', 'a decided round stays decided';
  begin
    insert into public.comments (task_id, body, review_check_id)
    values ((select id from b3_ids where name = 'rt'), 'Approved (review v3)', (select id from b3_ids where name = 'rc3'));
    raise exception 'clients can''t pass a comment off as a review''s outcome';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
do $$
begin
  assert public.review_check_decide((select token from b3_tokens where name = 'v2'), 'approved') ->> 'status' = 'closed',
    'a superseded round can''t be answered';
  assert public.review_check_view((select token from b3_tokens where name = 'v2')) ->> 'status' = 'superseded',
    'a superseded round says only that';
  assert public.review_check_file((select token from b3_tokens where name = 'v2'), (select id from b3_ids where name = 'asset1')) ->> 'status' = 'unknown',
    'and serves no files';
  assert public.review_check_view((select token from b3_tokens where name = 'v3')) ->> 'status' = 'unknown', 'the replaced link is dead';
  assert public.review_check_view((select token from b3_tokens where name = 'v3b')) ->> 'status' = 'ok', 'the new one works';
end $$;
reset role;
update public.review_checks set hits = 600, hits_window_started_at = now() where id = (select id from b3_ids where name = 'rc3');
set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
select public.review_check_view((select token from b3_tokens where name = 'v3b')) ->> 'status' = 'rate_limited' as ok \gset
\if :ok
\else
  \echo 'expected rate_limited'
  select 1/0;
\endif
reset role;
update public.review_checks set expires_at = now() - interval '1 minute', hits = 0 where id = (select id from b3_ids where name = 'rc3');
set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
do $$
begin
  assert public.review_check_view((select token from b3_tokens where name = 'v3b')) ->> 'status' = 'expired', 'expired links say so, nothing more';
  assert public.review_check_decide((select token from b3_tokens where name = 'v3b'), 'approved') ->> 'status' = 'expired', 'and take nothing';
end $$;
reset role;

-- Withdrawn: the link says so and shows nothing else.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b3b30026-0000-4000-8000-000000000001', false) is not null as ok \gset
select public.create_review_check((select id from b3_ids where name = 'rt'), array[(select id from b3_ids where name = 'a1')], 'client@example.org') ->> 'token' as withdrawn_token \gset
select public.cancel_review_check((select id from public.review_checks where task_id = (select id from b3_ids where name = 'rt') and status = 'pending')) = 'cancelled' as ok \gset
reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
select public.review_check_view(:'withdrawn_token') ->> 'status' = 'withdrawn' as ok \gset
\if :ok
\else
  \echo 'expected withdrawn'
  select 1/0;
\endif
select public.review_check_decide(:'withdrawn_token', 'approved') ->> 'status' = 'closed' as ok \gset
\if :ok
\else
  \echo 'a withdrawn round takes no decision'
  select 1/0;
\endif
reset role;

-- An approval: approved status, a comment, rules fire like an approval decision.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b3b30026-0000-4000-8000-000000000001', false) is not null as ok \gset
select public.create_review_check((select id from b3_ids where name = 'rt'), array[(select id from b3_ids where name = 'a2')], 'client@example.org') ->> 'token' as approve_token \gset
reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
select public.review_check_decide(:'approve_token', 'approved', 'Looks great') ->> 'review_status' = 'approved' as ok \gset
\if :ok
\else
  \echo 'expected approved'
  select 1/0;
\endif
reset role;
do $$
begin
  assert exists (select 1 from public.comments c join public.review_checks r on r.comment_id = c.id
    where r.status = 'approved' and c.body like 'Approved (review v5)%Looks great%'), 'the approval is on the task';
end $$;

do $$ begin raise notice 'oct 26 batch 3 smoke: all assertions passed'; end $$;
