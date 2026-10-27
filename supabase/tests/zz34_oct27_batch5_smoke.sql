-- Oct 27 notes, batch 5 (20261027010000_oct27_batch5_a.sql).
--   b5b50027…01 b5-owner@example.com    owner of B5 P
--   b5b50027…02 b5-editor@example.com   Editor of B5 P
--   b5b50027…03 b5-viewer@example.com   Viewer of B5 P
--   b5b50027…04 b5-admin@example.com    workspace admin; not in B5 P

\set ON_ERROR_STOP 1

insert into public.allowed_emails (email, note) values
  ('b5-owner@example.com', 'oct 27 batch 5'),
  ('b5-editor@example.com', 'oct 27 batch 5'),
  ('b5-viewer@example.com', 'oct 27 batch 5'),
  ('b5-admin@example.com', 'oct 27 batch 5');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b5b50027-0000-4000-8000-000000000001', 'b5-owner@example.com', now(), '{"full_name":"Olga Owner"}'),
  ('b5b50027-0000-4000-8000-000000000002', 'b5-editor@example.com', now(), '{"full_name":"Eddie Editor"}'),
  ('b5b50027-0000-4000-8000-000000000003', 'b5-viewer@example.com', now(), '{"full_name":"Vera Viewer"}'),
  ('b5b50027-0000-4000-8000-000000000004', 'b5-admin@example.com', now(), '{"full_name":"Adam Admin"}');
select public.seed_workspace_admin('b5-admin@example.com');

create temporary table b5_ids (name text primary key, id uuid);
grant all on b5_ids to authenticated, anon;
create temporary table b5_tokens (name text primary key, token text);
grant all on b5_tokens to authenticated, anon;

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------

do $$
begin
  assert (select relrowsecurity from pg_class where oid = 'public.project_person_settings'::regclass), 'RLS on';
  assert not has_table_privilege('anon', 'public.project_person_settings', 'SELECT'), 'nothing for anon';
  assert not has_table_privilege('authenticated', 'public.project_person_settings', 'TRUNCATE'), 'no truncate';
  assert not has_column_privilege('authenticated', 'public.project_person_settings', 'profile_id', 'INSERT'), 'own rows only';
  assert not (select prosecdef from pg_proc where oid = 'public.set_project_show_completed(uuid, boolean)'::regprocedure), 'invoker';
  assert not (select prosecdef from pg_proc where oid = 'public.set_subtask_preferences(boolean, boolean, text)'::regprocedure), 'invoker';
  assert not (select prosecdef from pg_proc where oid = 'public.guard_section_lock()'::regprocedure), 'invoker guard';
  assert not (select prosecdef from pg_proc where oid = 'public.guard_project_sections_lock()'::regprocedure), 'invoker guard';
  assert not has_function_privilege('anon', 'public.set_project_show_completed(uuid, boolean)', 'execute')
    and not has_function_privilege('anon', 'public.set_subtask_preferences(boolean, boolean, text)', 'execute'), 'nothing for anon';
  assert has_function_privilege('anon', 'public.review_check_save(text, jsonb, boolean)', 'execute'), 'the review page saves as anon';
  assert not has_function_privilege('authenticated', 'public.review_check_save(text, jsonb, boolean)', 'execute'), 'only through the page';
  assert not has_function_privilege('anon', 'public.review_check_previous(public.review_checks)', 'execute')
    and not has_function_privilege('authenticated', 'public.review_check_previous_json(public.review_checks)', 'execute'),
    'helpers revoked';
  assert not has_column_privilege('authenticated', 'public.review_checks', 'draft', 'SELECT'), 'the team never reads the draft';
  assert has_column_privilege('authenticated', 'public.review_checks', 'draft_saved_at', 'SELECT'), 'only when it was saved';
  assert position('attachment_count' in pg_get_functiondef('public.project_task_cards(uuid, uuid[])'::regprocedure)) > 0,
    'cards carry attachment counts';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Setup: B5 P with an Editor and a Viewer
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'b5b50027-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid;
  s1 uuid;
  s2 uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B5 P') returning id into p;
  insert into b5_ids values ('p', p);
  insert into public.sections (project_id, name, sort_order) values (p, 'Intake', 1024) returning id into s1;
  insert into public.sections (project_id, name, sort_order) values (p, 'Doing', 2048) returning id into s2;
  insert into b5_ids values ('s1', s1), ('s2', s2);
  perform public.add_project_member(p, 'b5-editor@example.com', 'editor');
  perform public.add_project_member(p, 'b5-viewer@example.com', 'viewer');
  assert not (select sections_locked from public.projects where id = p), 'unlocked by default';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 1. Lock section order
-- ---------------------------------------------------------------------------------------------

-- An Editor can't lock it (and neither could an Admin who isn't an Owner).
select set_config('request.jwt.claim.sub', 'b5b50027-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  begin
    update public.projects set sections_locked = true where id = (select id from b5_ids where name = 'p');
    -- RLS makes an Editor's project update touch nothing; nothing changed either way.
  exception when insufficient_privilege then null;
  end;
  assert not (select sections_locked from public.projects where id = (select id from b5_ids where name = 'p')), 'still unlocked';
end $$;
reset role;
update public.project_members set role = 'admin'
  where project_id = (select id from b5_ids where name = 'p') and profile_id = 'b5b50027-0000-4000-8000-000000000002';
set role authenticated;
select set_config('request.jwt.claim.sub', 'b5b50027-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  begin
    update public.projects set sections_locked = true where id = (select id from b5_ids where name = 'p');
    raise exception 'an Admin who isn''t an Owner can''t lock sections';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
update public.project_members set role = 'editor'
  where project_id = (select id from b5_ids where name = 'p') and profile_id = 'b5b50027-0000-4000-8000-000000000002';

-- The Owner locks them.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b5b50027-0000-4000-8000-000000000001', false) is not null as ok \gset
update public.projects set sections_locked = true where id = (select id from b5_ids where name = 'p');
do $$
begin
  assert (select sections_locked from public.projects where id = (select id from b5_ids where name = 'p')), 'locked';
end $$;

-- The Editor can't add, rename, reorder, or remove a section, but still moves tasks between them.
select set_config('request.jwt.claim.sub', 'b5b50027-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b5_ids where name = 'p');
  s1 uuid := (select id from b5_ids where name = 's1');
  s2 uuid := (select id from b5_ids where name = 's2');
  t uuid;
begin
  begin
    insert into public.sections (project_id, name, sort_order) values (p, 'Extra', 4096);
    raise exception 'adding a section is refused';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.sections set name = 'Renamed' where id = s1;
    raise exception 'renaming is refused';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.place_section(s2, s1);
    raise exception 'reordering is refused';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.sections set deleted_at = now() where id = s2;
    raise exception 'removing is refused';
  exception when insufficient_privilege then null;
  end;
  t := public.create_task(p, s1, 'Locked sections task');
  insert into b5_ids values ('t', t);
  perform public.place_task(t, p, s2, null);
  assert (select section_id from public.task_projects where task_id = t and project_id = p and deleted_at is null) = s2,
    'tasks still move between sections';
  assert (select name from public.sections where id = s1) = 'Intake', 'unchanged';
end $$;

-- The Owner still changes them, and unlocks.
select set_config('request.jwt.claim.sub', 'b5b50027-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b5_ids where name = 'p');
begin
  update public.sections set name = 'Inbox' where id = (select id from b5_ids where name = 's1');
  perform public.place_section((select id from b5_ids where name = 's2'), (select id from b5_ids where name = 's1'));
  insert into public.sections (project_id, name, sort_order) values (p, 'Owner adds', 8192);
  update public.projects set sections_locked = false where id = p;
end $$;
select set_config('request.jwt.claim.sub', 'b5b50027-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  update public.sections set name = 'Intake' where id = (select id from b5_ids where name = 's1');
  assert (select name from public.sections where id = (select id from b5_ids where name = 's1')) = 'Intake', 'unlocked again';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 2. Show / Hide completed, per person per project
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'b5b50027-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b5_ids where name = 'p');
begin
  assert public.set_project_show_completed(p, true), 'a Viewer remembers it too';
  assert public.set_project_show_completed(p, false) = false, 'and changes it';
  assert public.set_project_show_completed(p, null) is null, 'null = what the view says';
  perform public.set_project_show_completed(p, true);
  assert (select count(*) from public.project_person_settings) = 1, 'own row only';
end $$;
select set_config('request.jwt.claim.sub', 'b5b50027-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.project_person_settings), 'nobody reads anyone else''s';
end $$;
select set_config('request.jwt.claim.sub', 'b5b50027-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
begin
  begin
    perform public.set_project_show_completed((select id from b5_ids where name = 'p'), true);
    raise exception 'outside the project: refused';
  exception when no_data_found then null;
  end;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 3. Attachment counts on the cards
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'b5b50027-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b5_ids where name = 'p');
  t uuid := (select id from b5_ids where name = 't');
  card jsonb;
begin
  insert into public.task_attachments (task_id, storage_path, file_name, content_type, size_bytes)
    values (t, t::text || '/one-a.png', 'a.png', 'image/png', 10),
           (t, t::text || '/two-b.pdf', 'b.pdf', 'application/pdf', 10),
           (t, t::text || '/three-c.txt', 'c.txt', 'text/plain', 10);
  update public.task_attachments set deleted_at = now() where task_id = t and file_name = 'c.txt';
  select value into card from jsonb_array_elements(public.project_task_cards(p)) where value ->> 'id' = t::text;
  assert (card ->> 'attachment_count')::int = 2, format('two files, the removed one not counted: %s', card);
  assert (card ->> 'comment_count')::int = 0, 'comments unchanged';
end $$;
select set_config('request.jwt.claim.sub', 'b5b50027-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
begin
  assert public.project_task_cards((select id from b5_ids where name = 'p')) = '[]'::jsonb, 'outsiders still get nothing';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 4. Subtasks organize menu
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'b5b50027-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  saved jsonb;
begin
  saved := public.set_subtask_preferences(true, true, 'due_desc');
  assert saved = '{"hide_completed": true, "assigned_to_me": true, "sort": "due_desc"}'::jsonb, format('saved %s', saved);
  assert (select subtask_sort from public.profile_preferences) = 'due_desc', 'own row';
  begin
    perform public.set_subtask_preferences(false, false, 'random');
    raise exception 'unknown orders are refused';
  exception when check_violation then null;
  end;
  saved := public.set_subtask_preferences(false, false, 'manual');
  assert saved ->> 'sort' = 'manual', 'back to manual';
end $$;
select set_config('request.jwt.claim.sub', 'b5b50027-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.profile_preferences where profile_id = 'b5b50027-0000-4000-8000-000000000003'),
    'nobody reads anyone else''s';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 8. Review checks: saved progress, the walkthrough, the previous round
-- ---------------------------------------------------------------------------------------------

do $$
declare
  t uuid := (select id from b5_ids where name = 't');
  a1 uuid;
  a2 uuid;
  result jsonb;
begin
  select id into a1 from public.task_attachments where task_id = t and file_name = 'a.png';
  select id into a2 from public.task_attachments where task_id = t and file_name = 'b.pdf';
  insert into b5_ids values ('a1', a1), ('a2', a2);
  result := public.create_review_check(t, array[a1], 'Reviewer@Example.org', 'Rae');
  insert into b5_ids values ('r1', (result ->> 'id')::uuid);
  insert into b5_tokens values ('r1', result ->> 'token');
end $$;

reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
do $$
declare
  token text := (select token from b5_tokens where name = 'r1');
  asset uuid;
  view jsonb;
  saved jsonb;
begin
  view := public.review_check_view(token);
  assert view ->> 'status' = 'ok', 'opens';
  assert (view ->> 'walkthrough_seen')::boolean = false, 'the walkthrough shows the first time';
  assert view -> 'draft' = 'null'::jsonb, 'nothing saved yet';
  assert view -> 'previous' = 'null'::jsonb, 'round 1 has no previous round';
  asset := (view -> 'assets' -> 0 ->> 'id')::uuid;

  assert public.review_check_save('nope') ->> 'status' = 'unknown', 'malformed';
  assert public.review_check_save(token, null, true) ->> 'status' = 'ok', 'closing the walkthrough';
  assert (public.review_check_view(token) ->> 'walkthrough_seen')::boolean, 'remembered on the server';

  saved := public.review_check_save(token, jsonb_build_object(
    'pins', jsonb_build_array(
      jsonb_build_object('asset_id', asset, 'x', 0.25, 'y', 0.5, 'body', 'Bigger logo'),
      jsonb_build_object('asset_id', asset, 'x', 0.75, 'y', 0.1, 'body', ''),
      jsonb_build_object('asset_id', gen_random_uuid(), 'x', 0.1, 'y', 0.1, 'body', 'another file'),
      jsonb_build_object('asset_id', asset, 'x', 7, 'y', 0.1, 'body', 'off the file')
    ),
    'note', 'Nearly there', 'decision', 'changes_requested', 'active_asset', asset
  ));
  assert saved ->> 'status' = 'ok', format('saved %s', saved);
  view := public.review_check_view(token);
  assert jsonb_array_length(view -> 'draft' -> 'pins') = 3, 'only pins on this round''s files';
  assert view -> 'draft' -> 'pins' -> 0 ->> 'body' = 'Bigger logo', 'in order';
  assert view -> 'draft' -> 'pins' -> 1 ->> 'body' = '', 'a pin may have no text yet';
  assert view -> 'draft' -> 'pins' -> 2 -> 'x' = 'null'::jsonb, 'a place off the file is dropped';
  assert view -> 'draft' ->> 'note' = 'Nearly there' and view -> 'draft' ->> 'decision' = 'changes_requested', 'note and answer';
  assert public.review_check_save(token, '"text"'::jsonb) ->> 'status' = 'invalid', 'objects only';
  assert public.review_check_save(token, jsonb_build_object('note', repeat('x', 300000))) ->> 'status' = 'invalid', 'size cap';

  -- Deciding sends what counts and clears the draft.
  saved := public.review_check_decide(token, 'changes_requested', 'Nearly there', jsonb_build_array(
    jsonb_build_object('asset_id', asset, 'x', 0.25, 'y', 0.5, 'body', 'Bigger logo')
  ));
  assert saved ->> 'status' = 'ok', format('decided %s', saved);
  view := public.review_check_view(token);
  assert view -> 'draft' = 'null'::jsonb, 'cleared';
  assert public.review_check_save(token, jsonb_build_object('note', 'late')) ->> 'status' = 'closed', 'no changes after the answer';
  assert public.review_check_save(token, null, true) ->> 'status' = 'ok', 'the walkthrough flag still works';
end $$;

reset role;
do $$
begin
  assert (select draft is null and draft_saved_at is not null from public.review_checks where id = (select id from b5_ids where name = 'r1')),
    'the draft is gone, its time stays';
  assert exists (
    select 1 from public.comments c
    where c.review_check_id = (select id from b5_ids where name = 'r1')
      and c.body like 'Requested changes (round 1)%' and c.email_subject = 'Review round 1: Changes requested'
  ), 'plain words: round 1';
end $$;

-- Round 2 to the same address shows round 1 (with its pins); another address doesn't.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b5b50027-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b5_ids where name = 't');
  result jsonb;
begin
  result := public.create_review_check(t, array[(select id from b5_ids where name = 'a2')], 'reviewer@example.org');
  insert into b5_tokens values ('r2', result ->> 'token');
  assert (result ->> 'round')::int = 2, 'round 2';
end $$;
reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
do $$
declare
  token text := (select token from b5_tokens where name = 'r2');
  view jsonb := public.review_check_view(token);
  previous_asset uuid;
begin
  assert view -> 'previous' ->> 'round' = '1', format('the previous round: %s', view -> 'previous');
  assert view -> 'previous' ->> 'status' = 'changes_requested', 'with its answer';
  assert view -> 'previous' ->> 'decision_note' = 'Nearly there', 'its note';
  assert jsonb_array_length(view -> 'previous' -> 'pins') = 1, 'and its pins';
  previous_asset := (view -> 'previous' -> 'assets' -> 0 ->> 'id')::uuid;
  assert public.review_check_file(token, previous_asset) ->> 'status' = 'ok', 'its files open from this link';
  assert public.review_check_file(token, gen_random_uuid()) ->> 'status' = 'unknown', 'nothing else';
  insert into b5_ids values ('r1_asset', previous_asset);
end $$;

reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', 'b5b50027-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  result jsonb;
begin
  result := public.create_review_check((select id from b5_ids where name = 't'), array[(select id from b5_ids where name = 'a1')], 'someone.else@example.org');
  insert into b5_tokens values ('r3', result ->> 'token');
end $$;
reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
do $$
begin
  assert public.review_check_view((select token from b5_tokens where name = 'r3')) -> 'previous' = 'null'::jsonb,
    'a different reviewer sees nothing of the earlier rounds';
  assert public.review_check_file((select token from b5_tokens where name = 'r3'), (select id from b5_ids where name = 'r1_asset')) ->> 'status' = 'unknown',
    'nor opens their files';
  assert public.review_check_save((select token from b5_tokens where name = 'r2'), jsonb_build_object('note', 'x')) ->> 'status' = 'superseded',
    'a replaced round takes nothing';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 12. Followers drive notifications
-- ---------------------------------------------------------------------------------------------

reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', 'b5b50027-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  t uuid;
begin
  t := public.create_task((select id from b5_ids where name = 'p'), null, 'Follow me');
  insert into b5_ids values ('ft', t);
  -- The Owner adds the Viewer as a follower (Viewers can be followers: they read the task).
  insert into public.task_followers (task_id, profile_id) values (t, 'b5b50027-0000-4000-8000-000000000003');
end $$;
select set_config('request.jwt.claim.sub', 'b5b50027-0000-4000-8000-000000000002', false) is not null as ok \gset
insert into public.comments (task_id, author_id, body)
  values ((select id from b5_ids where name = 'ft'), 'b5b50027-0000-4000-8000-000000000002', 'First update');
reset role;
do $$
begin
  assert exists (
    select 1 from public.inbox_items
    where recipient_id = 'b5b50027-0000-4000-8000-000000000003' and task_id = (select id from b5_ids where name = 'ft') and kind = 'comment'
  ), 'a follower hears about comments';
  assert exists (
    select 1 from public.inbox_items
    where recipient_id = 'b5b50027-0000-4000-8000-000000000001' and task_id = (select id from b5_ids where name = 'ft') and kind = 'comment'
  ), 'the creator follows (and hears) too';
  update public.task_followers set deleted_at = now()
  where task_id = (select id from b5_ids where name = 'ft') and profile_id = 'b5b50027-0000-4000-8000-000000000003';
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub', 'b5b50027-0000-4000-8000-000000000002', false) is not null as ok \gset
insert into public.comments (task_id, author_id, body)
  values ((select id from b5_ids where name = 'ft'), 'b5b50027-0000-4000-8000-000000000002', 'Second update');
reset role;
do $$
begin
  assert (
    select count(*) from public.inbox_items
    where recipient_id = 'b5b50027-0000-4000-8000-000000000003' and task_id = (select id from b5_ids where name = 'ft') and kind = 'comment'
  ) = 1, 'after unfollowing, no more';
end $$;

do $$
begin
  assert position('A follower is added' in pg_get_functiondef('public.validate_rule()'::regprocedure)) > 0, 'followers, not collaborators';
end $$;

do $$ begin raise notice 'oct 27 batch 5 smoke: all assertions passed'; end $$;
