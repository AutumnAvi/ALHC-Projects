-- Behavioural checks for Phase: Workspace admin and comments: the workspace admin bootstrap (email
-- lookup, no-op when missing), managing admins (admins only, last-admin guard), template management
-- (workspace admin or Admin+ of the live source; non-admins can't touch the seeded example), import
-- runs visible to workspace admins only for projects they can read, and — above all — a workspace admin
-- gets no access to a private project. Then comments: edit / delete only your own, body-only edits with
-- edited_at, edits that notify only newly @mentioned people, reactions RLS, and inbox archive on own
-- items only. People from earlier suites:
--   1111… member@example.com    "Member One"
--   5555… viewer@example.com    "Vera Viewer"
--   6666… commenter@example.com "Cora Commenter"
--   7777… editor@example.com    "Eddie Editor"
--   8888… admin@example.com     "Ada Admin"
--   9999… nonmember@example.com "Nora Nonmember"

\set ON_ERROR_STOP 1

create temporary table wa_ids (name text primary key, id uuid) on commit preserve rows;
grant all on wa_ids to authenticated, anon, service_role;

-- Bootstrap ----------------------------------------------------------------------------------------

do $$
begin
  -- The migration looked the seeded address up in auth.users; it isn't in this database, so nothing
  -- happened, and running it again is still a no-op.
  assert (select count(*) from public.workspace_admins) = 0, 'the migration seed is a no-op without that account';
  assert not public.seed_workspace_admin('avweinreb@autumnlakemarketing.com'), 'missing account: no-op';
  assert not public.seed_workspace_admin('nobody@example.com'), 'unknown address: no-op';
  assert (select count(*) from public.workspace_admins) = 0, 'still nobody';
  -- The same lookup finds an existing account by email (case-insensitive) and is idempotent.
  assert public.seed_workspace_admin('MEMBER@example.com'), 'seeds by email';
  assert not public.seed_workspace_admin('member@example.com'), 'idempotent';
  assert (select count(*) from public.workspace_admins where deleted_at is null) = 1, 'one admin';
  assert (select profile_id from public.workspace_admins where deleted_at is null) = '11111111-1111-4111-8111-111111111111',
    'the member is the admin';
  assert not has_function_privilege('authenticated', 'public.seed_workspace_admin(text)', 'execute'),
    'the bootstrap is not an RPC';
end $$;

set role authenticated;

-- Non-admins can't manage admins or the seeded template -------------------------------------------

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
begin
  assert not public.is_workspace_admin(), 'an editor is not a workspace admin';
  assert (select count(*) from public.workspace_admins where deleted_at is null) = 1, 'but can see who the admins are';
  begin
    perform public.add_workspace_admin(null, 'editor@example.com');
    raise exception 'a non-admin must not add admins';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.remove_workspace_admin(null, '11111111-1111-4111-8111-111111111111');
    raise exception 'a non-admin must not remove admins';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.workspace_admins (workspace_id, profile_id)
    values ('00000000-0000-4000-8000-000000000001', '77777777-7777-4777-8777-777777777777');
    raise exception 'clients cannot write workspace_admins directly';
  exception when insufficient_privilege then null;
  end;
  assert not public.can_manage_project_template('00000000-0000-4000-8000-0000000000c1'),
    'a non-admin cannot manage the seeded example';
  begin
    perform public.delete_project_template('00000000-0000-4000-8000-0000000000c1');
    raise exception 'a non-admin must not delete the seeded template';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.update_project_template('00000000-0000-4000-8000-0000000000c1', 'Hijacked');
    raise exception 'a non-admin must not rename the seeded template';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Workspace admins: templates, adding / removing admins, last-admin guard ---------------------------

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset
do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
begin
  assert public.is_workspace_admin(), 'the member is a workspace admin';
  assert public.is_workspace_admin(ws), 'of the named workspace too';
  assert public.can_manage_project_template('00000000-0000-4000-8000-0000000000c1'), 'workspace admins manage the example';
  perform public.update_project_template('00000000-0000-4000-8000-0000000000c1', 'Creative Requests (renamed)');
  perform public.update_project_template('00000000-0000-4000-8000-0000000000c1', 'Creative Requests');

  begin
    perform public.remove_workspace_admin(ws, '11111111-1111-4111-8111-111111111111');
    raise exception 'the last admin must not remove themselves';
  exception when check_violation then null;
  end;
  begin
    perform public.add_workspace_admin(ws, 'outsider@example.com');
    raise exception 'only allowlisted people can be admins';
  exception when check_violation then null;
  end;
  begin
    perform public.add_workspace_admin(ws, 'pending@example.com');
    raise exception 'allowlisted people who never signed in can''t be added yet';
  exception when check_violation then null;
  end;
  assert public.add_workspace_admin(ws, 'Admin@Example.com') = '88888888-8888-4888-8888-888888888888', 'adds by email';
  perform public.add_workspace_admin(ws, 'admin@example.com');
  assert (select count(*) from public.workspace_admins where deleted_at is null) = 2, 're-adding is a no-op';
end $$;

select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', false) is not null as ok \gset
do $$
begin
  perform public.remove_workspace_admin(null, '11111111-1111-4111-8111-111111111111');
  assert not exists (
    select 1 from public.workspace_admins
    where profile_id = '11111111-1111-4111-8111-111111111111' and deleted_at is null
  ), 'an admin removes another admin (soft delete)';
  begin
    perform public.remove_workspace_admin(null, '88888888-8888-4888-8888-888888888888');
    raise exception 'the last admin must not remove themselves';
  exception when check_violation then null;
  end;
  perform public.add_workspace_admin(null, 'member@example.com');
  assert (select count(*) from public.workspace_admins where profile_id = '11111111-1111-4111-8111-111111111111') = 2,
    're-adding creates a new row and keeps the history';
  -- Leaving works while another admin remains.
  perform public.remove_workspace_admin(null, '88888888-8888-4888-8888-888888888888');
  assert not public.is_workspace_admin(), 'Ada left';
end $$;

-- A workspace admin never reads a private project -----------------------------------------------

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
declare
  p uuid;
  t uuid;
  run uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'Private plans')
  returning id into p;
  t := public.create_task(p, null, 'Secret task');
  insert into public.comments (task_id, body) values (t, 'Secret comment');
  run := public.start_import_run(p, 'asana', array['export.json']);
  perform public.finish_import_run(run, 'completed', '{}'::jsonb);
  insert into wa_ids values ('priv', p), ('priv_task', t), ('priv_run', run);
end $$;

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from wa_ids where name = 'priv');
begin
  assert public.is_workspace_admin(), 'fixture: still a workspace admin';
  assert not exists (select 1 from public.projects where id = p), 'no project row';
  assert not exists (select 1 from public.tasks where id = (select id from wa_ids where name = 'priv_task')), 'no tasks';
  assert not exists (select 1 from public.comments where task_id = (select id from wa_ids where name = 'priv_task')), 'no comments';
  assert not exists (select 1 from public.sections where project_id = p), 'no sections';
  assert not exists (select 1 from public.project_members where project_id = p), 'no members';
  assert not exists (select 1 from public.import_runs where project_id = p), 'no import runs of unreadable projects';
  assert (select count(*) from public.filter_project_tasks(p, '{}'::jsonb, 'UTC')) = 0, 'no view rows';
  assert public.project_role(p) is null, 'no role';
  begin
    perform public.save_project_as_template(p, 'Leak', null, null, null);
    raise exception 'a workspace admin must not template a private project';
  exception when no_data_found then null;
  end;
  begin
    perform public.duplicate_project(p, 'Leak', '{}'::jsonb);
    raise exception 'a workspace admin must not duplicate a private project';
  exception when no_data_found or insufficient_privilege then null;
  end;
end $$;

-- Once they can read the project (any role), its import runs show on Settings → Workspace.
select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
begin
  perform public.add_project_member((select id from wa_ids where name = 'priv'), 'member@example.com', 'viewer');
  perform public.add_project_member((select id from wa_ids where name = 'priv'), 'viewer@example.com', 'viewer');
end $$;

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset
do $$
begin
  assert exists (select 1 from public.import_runs where id = (select id from wa_ids where name = 'priv_run')),
    'a workspace admin who can read the project sees its import runs';
end $$;

select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.import_runs where id = (select id from wa_ids where name = 'priv_run')),
    'a project viewer who is not a workspace admin does not';
end $$;

-- Comments: fixtures ---------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
declare
  p uuid;
  t uuid;
  c_editor uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'Comment depth')
  returning id into p;
  perform public.add_project_member(p, 'commenter@example.com', 'commenter');
  perform public.add_project_member(p, 'viewer@example.com', 'viewer');
  t := public.create_task(p, null, 'Discuss');
  insert into public.comments (task_id, body) values (t, 'Editor note') returning id into c_editor;
  insert into wa_ids values ('cp', p), ('ct', t), ('c_editor', c_editor);
end $$;

select set_config('request.jwt.claim.sub', '66666666-6666-4666-8666-666666666666', false) is not null as ok \gset
do $$
declare
  c uuid;
begin
  insert into public.comments (task_id, body) values ((select id from wa_ids where name = 'ct'), 'Hi @Eddie Editor')
  returning id into c;
  insert into wa_ids values ('c_cora', c);
  assert (select edited_at from public.comments where id = c) is null, 'new comments are not edited';
end $$;

-- Edit only your own, body only ----------------------------------------------------------------------

reset role;
do $$
begin
  assert (select count(*) from public.inbox_items where comment_id = (select id from wa_ids where name = 'c_cora')
          and recipient_id = '77777777-7777-4777-8777-777777777777' and kind = 'mention') = 1,
    'fixture: the mention notified Eddie once';
end $$;
set role authenticated;

select set_config('request.jwt.claim.sub', '66666666-6666-4666-8666-666666666666', false) is not null as ok \gset
do $$
declare
  c uuid := (select id from wa_ids where name = 'c_cora');
  affected int;
begin
  update public.comments set body = 'Hi @Eddie Editor and @Vera Viewer' where id = c;
  get diagnostics affected = row_count;
  assert affected = 1, 'the author edits their comment';
  assert (select edited_at is not null and body = 'Hi @Eddie Editor and @Vera Viewer' from public.comments where id = c),
    'edited_at is stamped';

  update public.comments set body = 'Changed' where id = (select id from wa_ids where name = 'c_editor');
  get diagnostics affected = row_count;
  assert affected = 0, 'nobody edits someone else''s comment';
  update public.comments set deleted_at = now() where id = (select id from wa_ids where name = 'c_editor');
  get diagnostics affected = row_count;
  assert affected = 0, 'nobody deletes someone else''s comment';

  begin
    update public.comments set task_id = (select id from wa_ids where name = 'priv_task') where id = c;
    raise exception 'the author must not move a comment';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.comments set edited_at = null where id = c;
    raise exception 'the author must not clear edited_at';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.comments set created_at = now() - interval '1 day' where id = c;
    raise exception 'the author must not backdate a comment';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
do $$
declare
  c uuid := (select id from wa_ids where name = 'c_cora');
begin
  -- The edit added Vera: she follows and gets a mention. Eddie (already mentioned) and followers get nothing new.
  assert (select count(*) from public.inbox_items where comment_id = c
          and recipient_id = '55555555-5555-4555-8555-555555555555' and kind = 'mention') = 1, 'newly mentioned person notified';
  assert exists (select 1 from public.task_followers where task_id = (select id from wa_ids where name = 'ct')
                 and profile_id = '55555555-5555-4555-8555-555555555555' and deleted_at is null), 'and follows the task';
  assert (select count(*) from public.inbox_items where comment_id = c
          and recipient_id = '77777777-7777-4777-8777-777777777777') = 1, 'already-mentioned people are not notified again';
  assert (select count(*) from public.inbox_items where comment_id = c) = 2, 'an edit notifies no followers';
  assert (select count(*) from public.comment_mentions where comment_id = c) = 2, 'both mentions are recorded';
end $$;
set role authenticated;

select set_config('request.jwt.claim.sub', '66666666-6666-4666-8666-666666666666', false) is not null as ok \gset
do $$
declare
  c uuid := (select id from wa_ids where name = 'c_cora');
begin
  -- Editing again without new mentions notifies nobody.
  update public.comments set body = 'Hi @Eddie Editor, @Vera Viewer!' where id = c;
end $$;

reset role;
do $$
begin
  assert (select count(*) from public.inbox_items where comment_id = (select id from wa_ids where name = 'c_cora')) = 2,
    'no new mentions, no new notifications';
end $$;
set role authenticated;

select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset
do $$
declare
  affected int;
begin
  begin
    insert into public.comments (task_id, body) values ((select id from wa_ids where name = 'ct'), 'Viewer says hi');
    raise exception 'a viewer must not comment';
  exception when insufficient_privilege then null;
  end;
  update public.comments set body = 'x' where id = (select id from wa_ids where name = 'c_cora');
  get diagnostics affected = row_count;
  assert affected = 0, 'a viewer edits nothing';
end $$;

-- Reactions --------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '66666666-6666-4666-8666-666666666666', false) is not null as ok \gset
do $$
declare
  c uuid := (select id from wa_ids where name = 'c_editor');
  r uuid;
begin
  insert into public.comment_reactions (comment_id, emoji) values (c, 'thumbs_up') returning id into r;
  insert into wa_ids values ('r_cora', r);
  assert (select task_id from public.comment_reactions where id = r) = (select id from wa_ids where name = 'ct'),
    'task_id comes from the comment';
  begin
    insert into public.comment_reactions (comment_id, emoji) values (c, 'thumbs_up');
    raise exception 'one active reaction per emoji per person';
  exception when unique_violation then null;
  end;
  begin
    insert into public.comment_reactions (comment_id, emoji) values (c, 'skull');
    raise exception 'only the fixed set';
  exception when check_violation then null;
  end;
  begin
    insert into public.comment_reactions (comment_id, profile_id, emoji)
    values (c, '77777777-7777-4777-8777-777777777777', 'heart');
    raise exception 'nobody reacts as someone else';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.comment_reactions (comment_id, task_id, emoji)
    values (c, (select id from wa_ids where name = 'priv_task'), 'heart');
    assert (select task_id from public.comment_reactions where comment_id = c and emoji = 'heart' and deleted_at is null)
      = (select id from wa_ids where name = 'ct'), 'a forged task_id is replaced by the comment''s task';
    update public.comment_reactions set deleted_at = now() where comment_id = c and emoji = 'heart';
  end;
  begin
    update public.comment_reactions set emoji = 'heart' where id = r;
    raise exception 'reactions can''t be changed, only removed';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset
do $$
declare
  affected int;
begin
  assert exists (select 1 from public.comment_reactions where id = (select id from wa_ids where name = 'r_cora')),
    'viewers read reactions';
  begin
    insert into public.comment_reactions (comment_id, emoji) values ((select id from wa_ids where name = 'c_editor'), 'heart');
    raise exception 'a viewer must not react';
  exception when insufficient_privilege then null;
  end;
  update public.comment_reactions set deleted_at = now() where id = (select id from wa_ids where name = 'r_cora');
  get diagnostics affected = row_count;
  assert affected = 0, 'nobody removes someone else''s reaction';
end $$;

select set_config('request.jwt.claim.sub', '99999999-9999-4999-8999-999999999999', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.comment_reactions where id = (select id from wa_ids where name = 'r_cora')),
    'non-members see no reactions';
end $$;

select set_config('request.jwt.claim.sub', '66666666-6666-4666-8666-666666666666', false) is not null as ok \gset
do $$
declare
  affected int;
  c uuid := (select id from wa_ids where name = 'c_editor');
begin
  update public.comment_reactions set deleted_at = now() where id = (select id from wa_ids where name = 'r_cora');
  get diagnostics affected = row_count;
  assert affected = 1, 'people remove their own reaction';
  begin
    update public.comment_reactions set deleted_at = null where id = (select id from wa_ids where name = 'r_cora');
    raise exception 'removed reactions are not restored';
  exception when insufficient_privilege then null;
  end;
  insert into public.comment_reactions (comment_id, emoji) values (c, 'thumbs_up');
  assert (select count(*) from public.comment_reactions where comment_id = c and emoji = 'thumbs_up') = 2,
    'reacting again adds a row';
end $$;

-- Delete own comment (soft), then it's frozen ------------------------------------------------------

select set_config('request.jwt.claim.sub', '66666666-6666-4666-8666-666666666666', false) is not null as ok \gset
do $$
declare
  c uuid := (select id from wa_ids where name = 'c_cora');
  affected int;
begin
  update public.comments set deleted_at = now() where id = c;
  get diagnostics affected = row_count;
  assert affected = 1, 'the author deletes their comment';
  assert exists (select 1 from public.comments where id = c and deleted_at is not null), 'kept as a soft-deleted row';
  begin
    update public.comments set body = 'Back again' where id = c;
    raise exception 'a deleted comment can''t be edited';
  exception when check_violation then null;
  end;
  begin
    update public.comments set deleted_at = null where id = c;
    raise exception 'a deleted comment can''t be restored by its author';
  exception when check_violation then null;
  end;
  begin
    insert into public.comment_reactions (comment_id, emoji) values (c, 'eyes');
    raise exception 'no reactions on deleted comments';
  exception when no_data_found then null;
  end;
end $$;

-- Inbox archive: own items only --------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
declare
  item uuid;
  affected int;
begin
  select id into item from public.inbox_items
  where recipient_id = '77777777-7777-4777-8777-777777777777' and comment_id = (select id from wa_ids where name = 'c_cora');
  assert item is not null, 'fixture: Eddie has the mention';
  insert into wa_ids values ('eddie_item', item);
  update public.inbox_items set archived_at = now() where id = item;
  get diagnostics affected = row_count;
  assert affected = 1, 'recipients archive their items';
  update public.inbox_items set archived_at = null, read_at = null where id = item;
  assert (select archived_at is null and read_at is null from public.inbox_items where id = item), 'unarchive + mark unread';
  begin
    update public.inbox_items set kind = 'comment' where id = item;
    raise exception 'only read_at and archived_at are writable';
  exception when insufficient_privilege then null;
  end;
  -- Archive all (what the app sends): only the caller's rows change.
  update public.inbox_items set archived_at = now() where archived_at is null;
  assert not exists (select 1 from public.inbox_items where archived_at is null), 'all of Eddie''s items archived';
end $$;

select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset
do $$
declare
  affected int;
begin
  update public.inbox_items set archived_at = now() where id = (select id from wa_ids where name = 'eddie_item');
  get diagnostics affected = row_count;
  assert affected = 0, 'nobody archives someone else''s item';
  assert exists (select 1 from public.inbox_items where archived_at is null), 'fixture: Vera has unarchived items';
end $$;

reset role;
do $$
begin
  assert exists (
    select 1 from public.inbox_items
    where recipient_id = '55555555-5555-4555-8555-555555555555' and archived_at is null
  ), 'Eddie''s archive-all left Vera''s items alone';
  assert not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('guard_comment_update', 'guard_comment_reaction') and p.prosecdef
  ), 'the comment and reaction guards run as the caller';
end $$;

select 'workspace admin and comments smoke: all assertions passed' as result;
