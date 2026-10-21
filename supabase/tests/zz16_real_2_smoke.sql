-- Behavioural checks for Phase: Real features 2 (team and people): team messages (team_messages,
-- mentions, reactions, followers, notify_team_message), status update notifications, per-kind
-- notification settings (notification_settings, set_notification_setting, the inbox_items preferences
-- trigger, notification emails with their send-time check and claim, the mention switch on comment
-- emails), and real last activity (list_member_last_activity).
-- Fresh people for this suite:
--   a2a2…01 r2-lead@example.com      lead of R2 Team (creates it); owner of R2 P
--   a2a2…02 r2-member@example.com    member of R2 Team; Editor of R2 P
--   a2a2…03 r2-outsider@example.com  not on R2 Team; Viewer of R2 P
--   a2a2…04 r2-admin@example.com     workspace admin; not on R2 Team, not in R2 P
--   a2a2…05 r2-quiet@example.com     member of R2 Team; Editor of R2 P; turns notifications off
--   a2a2…06 r2-hook@example.com      created R2 Hook P; its only task was "created by an inbound webhook"

\set ON_ERROR_STOP 1

create temporary table r2_ids (name text primary key, id uuid) on commit preserve rows;
grant all on r2_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('r2-lead@example.com', 'real 2 suite'),
  ('r2-member@example.com', 'real 2 suite'),
  ('r2-outsider@example.com', 'real 2 suite'),
  ('r2-admin@example.com', 'real 2 suite'),
  ('r2-quiet@example.com', 'real 2 suite'),
  ('r2-hook@example.com', 'real 2 suite');
insert into auth.users (id, email, email_confirmed_at, last_sign_in_at, raw_user_meta_data) values
  ('a2a2a2a2-0000-4000-8000-000000000001', 'r2-lead@example.com', now(), '2026-10-12 09:00+00', '{"full_name":"Lena Leadwell"}'),
  ('a2a2a2a2-0000-4000-8000-000000000002', 'r2-member@example.com', now(), '2026-10-12 10:00+00', '{"full_name":"Max Memberly"}'),
  ('a2a2a2a2-0000-4000-8000-000000000003', 'r2-outsider@example.com', now(), null, '{"full_name":"Otto Outlander"}'),
  ('a2a2a2a2-0000-4000-8000-000000000004', 'r2-admin@example.com', now(), '2026-10-12 11:00+00', '{"full_name":"Adele Adminova"}'),
  ('a2a2a2a2-0000-4000-8000-000000000005', 'r2-quiet@example.com', now(), '2026-10-01 08:00+00', '{"full_name":"Quinn Quietly"}'),
  ('a2a2a2a2-0000-4000-8000-000000000006', 'r2-hook@example.com', now(), '2026-10-02 08:00+00', '{"full_name":"Hal Hookson"}');
insert into public.workspace_admins (workspace_id, profile_id)
values ('00000000-0000-4000-8000-000000000001', 'a2a2a2a2-0000-4000-8000-000000000004');

-- EXECUTE surface and grants --------------------------------------------------------------------------

do $$
begin
  assert has_function_privilege('authenticated', 'public.list_member_last_activity(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.list_member_last_activity(uuid)', 'execute')
    and (select prosecdef from pg_proc where oid = 'public.list_member_last_activity(uuid)'::regprocedure),
    'list_member_last_activity: the one new client definer function';
  assert has_function_privilege('service_role', 'public.claim_notification_emails(integer, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.claim_notification_emails(integer, uuid)', 'execute')
    and not has_function_privilege('anon', 'public.claim_notification_emails(integer, uuid)', 'execute'),
    'claim_notification_emails is service_role only';
  assert has_function_privilege('authenticated', 'public.set_notification_setting(text, text, boolean)', 'execute')
    and has_function_privilege('authenticated', 'public.can_read_team(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.can_post_team_message(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.set_notification_setting(text, text, boolean)', 'execute')
    and not has_function_privilege('anon', 'public.can_read_team(uuid)', 'execute'),
    'the invoker helpers are for signed-in people';
  assert not (select prosecdef from pg_proc where oid = 'public.set_notification_setting(text, text, boolean)'::regprocedure)
    and not (select prosecdef from pg_proc where oid = 'public.can_read_team(uuid)'::regprocedure)
    and not (select prosecdef from pg_proc where oid = 'public.can_post_team_message(uuid)'::regprocedure)
    and not (select prosecdef from pg_proc where oid = 'public.guard_team_message()'::regprocedure)
    and not (select prosecdef from pg_proc where oid = 'public.guard_team_message_reaction()'::regprocedure)
    and not (select prosecdef from pg_proc where oid = 'public.guard_team_message_follower()'::regprocedure)
    and not (select prosecdef from pg_proc where oid = 'public.guard_notification_setting()'::regprocedure),
    'everything signed-in people call is invoker';
  assert not has_function_privilege('authenticated', 'public.notify_team_message(uuid, uuid, text, jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.notify_status_update(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.team_message_mention_ids(uuid, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.follow_team_thread(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.on_team_message_insert()', 'execute')
    and not has_function_privilege('authenticated', 'public.on_team_message_update()', 'execute')
    and not has_function_privilege('authenticated', 'public.on_project_status_update_notify()', 'execute')
    and not has_function_privilege('authenticated', 'public.notification_wanted(uuid, text, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.notification_category(text, jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.queue_notification_email(public.inbox_items)', 'execute')
    and not has_function_privilege('authenticated', 'public.apply_notification_settings()', 'execute')
    and not has_function_privilege('authenticated', 'public.notification_email_block_reason(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.profile_last_active_at(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.profile_last_active_at(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.notify_team_message(uuid, uuid, text, jsonb)', 'execute'),
    'triggers and internal helpers are revoked';
  assert not has_table_privilege('anon', 'public.team_messages', 'select')
    and not has_table_privilege('anon', 'public.team_message_followers', 'select')
    and not has_table_privilege('anon', 'public.notification_settings', 'select'), 'anon has nothing';
  assert not has_table_privilege('authenticated', 'public.team_messages', 'delete')
    and not has_column_privilege('authenticated', 'public.team_messages', 'team_id', 'update')
    and not has_column_privilege('authenticated', 'public.team_messages', 'author_id', 'insert')
    and not has_column_privilege('authenticated', 'public.team_messages', 'last_activity_at', 'update')
    and has_column_privilege('authenticated', 'public.team_messages', 'body', 'update')
    and not has_table_privilege('authenticated', 'public.team_message_mentions', 'insert')
    and has_column_privilege('authenticated', 'public.team_message_followers', 'deleted_at', 'update')
    and not has_column_privilege('authenticated', 'public.team_message_followers', 'profile_id', 'update')
    and not has_column_privilege('authenticated', 'public.notification_settings', 'profile_id', 'update')
    and not has_table_privilege('authenticated', 'public.notification_settings', 'delete'),
    'team messages and settings: narrow column grants';
  assert (select relrowsecurity from pg_class where oid = 'public.team_messages'::regclass)
    and (select relrowsecurity from pg_class where oid = 'public.team_message_mentions'::regclass)
    and (select relrowsecurity from pg_class where oid = 'public.team_message_reactions'::regclass)
    and (select relrowsecurity from pg_class where oid = 'public.team_message_followers'::regclass)
    and (select relrowsecurity from pg_class where oid = 'public.notification_settings'::regclass), 'RLS is on';
  -- (Automations V3's tail replaces the target CHECK with its wider inbox_items_target_check_v3.)
  assert exists (select 1 from pg_constraint where conname in ('inbox_items_target_check', 'inbox_items_target_check_v3')
                   and pg_get_constraintdef(oid) like '%team_message_id%')
    and exists (select 1 from pg_constraint where conname = 'inbox_items_kind_check'
                   and pg_get_constraintdef(oid) like '%status_update%')
    and not exists (select 1 from pg_constraint where conname like 'inbox_items_%_check_v2'),
    'after the tail, the wider inbox CHECKs carry the old names';
end $$;

-- Setup ------------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'a2a2a2a2-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  team uuid;
  p uuid;
  t uuid;
begin
  insert into public.teams (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'R2 Team') returning id into team;
  perform public.add_team_member(team, 'r2-member@example.com', 'member');
  perform public.add_team_member(team, 'r2-quiet@example.com', 'member');
  insert into r2_ids values ('team', team);
  insert into public.teams (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'R2 Other team') returning id into team;
  insert into r2_ids values ('other_team', team);
  team := (select id from r2_ids where name = 'team');

  insert into public.projects (workspace_id, name, team_id)
  values ('00000000-0000-4000-8000-000000000001', 'R2 P', team) returning id into p;
  perform public.add_project_member(p, 'r2-member@example.com', 'editor');
  perform public.add_project_member(p, 'r2-outsider@example.com', 'viewer');
  perform public.add_project_member(p, 'r2-quiet@example.com', 'editor');
  insert into r2_ids values ('p', p);
  select public.create_task(p, null, 'R2 task one') into t;
  insert into r2_ids values ('t1', t);
  select public.create_task(p, null, 'R2 task two') into t;
  insert into r2_ids values ('t2', t);
  select public.create_task(p, null, 'R2 task three') into t;
  insert into r2_ids values ('t3', t);
  select public.create_task(p, null, 'R2 task four') into t;
  insert into r2_ids values ('t4', t);
end $$;

-- Team messages: a member starts a thread ------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'a2a2a2a2-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  team uuid := (select id from r2_ids where name = 'team');
  m uuid;
begin
  assert public.can_read_team(team) and public.can_post_team_message(team), 'a member reads and posts';
  begin
    insert into public.team_messages (team_id, title, body, author_id)
    values (team, 'Forged', 'In someone else''s name', 'a2a2a2a2-0000-4000-8000-000000000001');
    raise exception 'clients can''t name the author';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.team_messages (team_id, title, body, last_activity_at) values (team, 'Old', 'Backdated', '2000-01-01');
    raise exception 'clients can''t backdate';
  exception when insufficient_privilege then null;
  end;
  insert into public.team_messages (team_id, title, body)
  values (team, '  Launch plan  ', 'Kickoff Monday. @Otto Outlander, can you join?')
  returning id into m;
  insert into r2_ids values ('thread', m);
  assert (select author_id from public.team_messages where id = m) = 'a2a2a2a2-0000-4000-8000-000000000002',
    'the author is the caller';
  assert (select title from public.team_messages where id = m) = 'Launch plan', 'the title is trimmed';
  assert exists (select 1 from public.team_message_mentions where message_id = m and profile_id = 'a2a2a2a2-0000-4000-8000-000000000003'),
    'anyone in the workspace can be mentioned (everyone can read team messages)';
  assert (select count(*) from public.team_message_followers where thread_id = m and deleted_at is null) = 2
    and exists (select 1 from public.team_message_followers where thread_id = m and profile_id = 'a2a2a2a2-0000-4000-8000-000000000002')
    and exists (select 1 from public.team_message_followers where thread_id = m and profile_id = 'a2a2a2a2-0000-4000-8000-000000000003'),
    'the author and the mentioned person follow the thread';

  begin
    insert into public.team_messages (team_id, title, body) values (team, null, 'No title');
    raise exception 'a thread needs a title';
  exception when check_violation then null;
  end;
end $$;

reset role;
do $$
declare
  m uuid := (select id from r2_ids where name = 'thread');
begin
  assert exists (select 1 from public.inbox_items where recipient_id = 'a2a2a2a2-0000-4000-8000-000000000001'
                   and team_message_id = m and kind = 'message' and (data ->> 'new_thread')::boolean
                   and data ->> 'team_name' = 'R2 Team' and task_id is null),
    'a new thread tells the team''s lead';
  assert exists (select 1 from public.inbox_items where recipient_id = 'a2a2a2a2-0000-4000-8000-000000000005'
                   and team_message_id = m and kind = 'message'), 'and every other member';
  assert exists (select 1 from public.inbox_items where recipient_id = 'a2a2a2a2-0000-4000-8000-000000000003'
                   and team_message_id = m and kind = 'mention')
    and not exists (select 1 from public.inbox_items where recipient_id = 'a2a2a2a2-0000-4000-8000-000000000003'
                   and team_message_id = m and kind = 'message'), 'the mentioned outsider hears "mention" once';
  assert not exists (select 1 from public.inbox_items where recipient_id = 'a2a2a2a2-0000-4000-8000-000000000002' and team_message_id = m),
    'never the author';
  assert not exists (select 1 from public.inbox_items where recipient_id = 'a2a2a2a2-0000-4000-8000-000000000004' and team_message_id = m),
    'a workspace admin who isn''t on the team isn''t told';
end $$;
set role authenticated;

-- An outsider reads (the team is visible to everyone) but can't post, reply, or react; they can follow --

select set_config('request.jwt.claim.sub', 'a2a2a2a2-0000-4000-8000-000000000003', false) is not null as ok \gset

do $$
declare
  team uuid := (select id from r2_ids where name = 'team');
  m uuid := (select id from r2_ids where name = 'thread');
begin
  assert public.can_read_team(team) and not public.can_post_team_message(team), 'reads, doesn''t post';
  assert exists (select 1 from public.team_messages where id = m), 'the thread is readable';
  assert exists (select 1 from public.inbox_items where team_message_id = m and kind = 'mention'), 'their own item is readable';
  begin
    insert into public.team_messages (team_id, title, body) values (team, 'Mine', 'Hello');
    raise exception 'non-members can''t start threads';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.team_messages (team_id, thread_id, body) values (team, m, 'A reply');
    raise exception 'non-members can''t reply';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.team_message_reactions (message_id, emoji) values (m, 'heart');
    raise exception 'non-members can''t react';
  exception when insufficient_privilege then null;
  end;
  -- Following: unfollow, follow again, never for someone else.
  update public.team_message_followers set deleted_at = now() where thread_id = m and profile_id = auth.uid();
  assert exists (select 1 from public.team_message_followers where thread_id = m and profile_id = auth.uid() and deleted_at is not null),
    'unfollowed';
  update public.team_message_followers set deleted_at = null where thread_id = m and profile_id = auth.uid();
  assert exists (select 1 from public.team_message_followers where thread_id = m and profile_id = auth.uid() and deleted_at is null),
    'following again';
  begin
    update public.team_message_followers set deleted_at = now()
    where thread_id = m and profile_id = 'a2a2a2a2-0000-4000-8000-000000000002';
    assert not found, 'someone else''s follow isn''t theirs to change';
  end;
  assert exists (select 1 from public.team_message_followers where thread_id = m
                   and profile_id = 'a2a2a2a2-0000-4000-8000-000000000002' and deleted_at is null), 'still following';
end $$;

-- The admin (manages every team) and the lead reply; followers hear about it --------------------------

select set_config('request.jwt.claim.sub', 'a2a2a2a2-0000-4000-8000-000000000004', false) is not null as ok \gset

do $$
declare
  team uuid := (select id from r2_ids where name = 'team');
  m uuid := (select id from r2_ids where name = 'thread');
  r uuid;
begin
  assert public.can_post_team_message(team), 'workspace admins manage teams, so they post';
  insert into public.team_messages (team_id, thread_id, title, body)
  values ((select id from r2_ids where name = 'other_team'), m, 'ignored', 'Count me in')
  returning id into r;
  insert into r2_ids values ('admin_reply', r);
  assert (select team_id from public.team_messages where id = r) = team and (select title from public.team_messages where id = r) is null,
    'a reply takes its thread''s team and no title';
  begin
    insert into public.team_messages (team_id, thread_id, body) values (team, r, 'Nested');
    raise exception 'replies are one level deep';
  exception when check_violation then null;
  end;
end $$;

reset role;
do $$
declare
  r uuid := (select id from r2_ids where name = 'admin_reply');
begin
  assert exists (select 1 from public.inbox_items where recipient_id = 'a2a2a2a2-0000-4000-8000-000000000002' and team_message_id = r and kind = 'message')
    and exists (select 1 from public.inbox_items where recipient_id = 'a2a2a2a2-0000-4000-8000-000000000003' and team_message_id = r and kind = 'message'),
    'the thread''s followers hear about a reply';
  assert not exists (select 1 from public.inbox_items where recipient_id = 'a2a2a2a2-0000-4000-8000-000000000001' and team_message_id = r)
    and not exists (select 1 from public.inbox_items where recipient_id = 'a2a2a2a2-0000-4000-8000-000000000005' and team_message_id = r),
    'team members who don''t follow the thread don''t';
  assert exists (select 1 from public.team_message_followers where thread_id = (select id from r2_ids where name = 'thread')
                   and profile_id = 'a2a2a2a2-0000-4000-8000-000000000004' and deleted_at is null), 'repliers follow';
  assert (select last_activity_at from public.team_messages where id = (select id from r2_ids where name = 'thread'))
       >= (select created_at from public.team_messages where id = r), 'a reply bumps the thread';
end $$;
set role authenticated;

-- Edits, reactions, and removal ----------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'a2a2a2a2-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  m uuid := (select id from r2_ids where name = 'thread');
begin
  update public.team_messages set body = 'Edited by the lead' where id = m;
  assert not found, 'only the author edits';
  insert into public.team_message_reactions (message_id, emoji) values (m, 'thumbs_up');
  assert exists (select 1 from public.team_message_reactions where message_id = m and profile_id = auth.uid() and emoji = 'thumbs_up'),
    'members react';
  begin
    insert into public.team_message_reactions (message_id, emoji) values (m, 'thumbs_up');
    raise exception 'one reaction of a kind per person';
  exception when unique_violation then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'a2a2a2a2-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  m uuid := (select id from r2_ids where name = 'thread');
begin
  update public.team_messages set body = 'Kickoff Monday. @Otto Outlander and @Quinn Quietly, can you join?' where id = m;
  assert found and (select edited_at from public.team_messages where id = m) is not null, 'the author edits (stamped)';
  begin
    update public.team_messages set team_id = (select id from r2_ids where name = 'other_team') where id = m;
    raise exception 'messages never move';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
do $$
declare
  m uuid := (select id from r2_ids where name = 'thread');
begin
  assert exists (select 1 from public.inbox_items where recipient_id = 'a2a2a2a2-0000-4000-8000-000000000005' and team_message_id = m and kind = 'mention'),
    'an edit tells the newly mentioned person';
  assert (select count(*) from public.inbox_items where recipient_id = 'a2a2a2a2-0000-4000-8000-000000000003' and team_message_id = m and kind = 'mention') = 1,
    'people mentioned before aren''t told again';
  assert exists (select 1 from public.team_message_followers where thread_id = m and profile_id = 'a2a2a2a2-0000-4000-8000-000000000005'),
    'and they follow it';
end $$;
set role authenticated;

-- Status updates tell the project's members ----------------------------------------------------------

select set_config('request.jwt.claim.sub', 'a2a2a2a2-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  perform public.set_project_status((select id from r2_ids where name = 'p'), 'at_risk', 'Behind on copy');
end $$;

reset role;
do $$
declare
  p uuid := (select id from r2_ids where name = 'p');
  u uuid := (select id from public.project_status_updates where project_id = p order by created_at desc limit 1);
begin
  insert into r2_ids values ('status_update', u);
  assert exists (select 1 from public.inbox_items where recipient_id = 'a2a2a2a2-0000-4000-8000-000000000002'
                   and status_update_id = u and kind = 'status_update' and data ->> 'status' = 'at_risk'
                   and data ->> 'project_name' = 'R2 P' and data ->> 'note' = 'Behind on copy'),
    'an Editor hears about a status update';
  assert exists (select 1 from public.inbox_items where recipient_id = 'a2a2a2a2-0000-4000-8000-000000000003' and status_update_id = u),
    'so does a Viewer';
  assert not exists (select 1 from public.inbox_items where recipient_id = 'a2a2a2a2-0000-4000-8000-000000000001' and status_update_id = u),
    'never the author';
  assert not exists (select 1 from public.inbox_items where recipient_id = 'a2a2a2a2-0000-4000-8000-000000000004' and status_update_id = u),
    'workspace admins who aren''t members get nothing';
end $$;
set role authenticated;

select set_config('request.jwt.claim.sub', 'a2a2a2a2-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
begin
  assert exists (select 1 from public.inbox_items where status_update_id = (select id from r2_ids where name = 'status_update')),
    'the member reads their status update item';
end $$;

-- Notification settings ------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'a2a2a2a2-0000-4000-8000-000000000005', false) is not null as ok \gset

do $$
begin
  perform public.set_notification_setting('assigned', 'inbox', false);
  perform public.set_notification_setting('assigned', 'email', true);
  perform public.set_notification_setting('comment', 'email', false);
  assert (select inbox from public.notification_settings where kind = 'assigned') = false
    and (select email from public.notification_settings where kind = 'assigned'), 'one row per kind, both switches';
  assert not (select email_comments from public.profiles where id = auth.uid()), 'the comment email switch is profiles.email_comments';
  begin
    perform public.set_notification_setting('everything', 'inbox', false);
    raise exception 'unknown kinds are refused';
  exception when check_violation then null;
  end;
  begin
    perform public.set_notification_setting('assigned', 'sms', false);
    raise exception 'unknown channels are refused';
  exception when check_violation then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'a2a2a2a2-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
begin
  assert not exists (select 1 from public.notification_settings), 'nobody reads anyone else''s settings';
  insert into public.notification_settings (profile_id, kind, inbox) values ('a2a2a2a2-0000-4000-8000-000000000005', 'rule', false);
  assert (select profile_id from public.notification_settings where kind = 'rule') = auth.uid(),
    'a row always belongs to the person who writes it';
  perform public.set_notification_setting('rule', 'inbox', true);
  perform public.set_notification_setting('assigned', 'email', true);
end $$;

-- The lead assigns tasks: Quinn's Inbox copy is dropped but the email goes out; Max gets both.
select set_config('request.jwt.claim.sub', 'a2a2a2a2-0000-4000-8000-000000000001', false) is not null as ok \gset
update public.tasks set assignee_id = 'a2a2a2a2-0000-4000-8000-000000000005' where id = (select id from r2_ids where name = 't1');
update public.tasks set assignee_id = 'a2a2a2a2-0000-4000-8000-000000000002' where id = (select id from r2_ids where name = 't2');

reset role;
do $$
declare
  t1 uuid := (select id from r2_ids where name = 't1');
  t2 uuid := (select id from r2_ids where name = 't2');
  p uuid := (select id from r2_ids where name = 'p');
  e public.email_outbox;
begin
  assert not exists (select 1 from public.inbox_items where recipient_id = 'a2a2a2a2-0000-4000-8000-000000000005' and task_id = t1 and kind = 'assigned'),
    'an Inbox kind turned off isn''t stored';
  select * into e from public.email_outbox
  where to_profile_id = 'a2a2a2a2-0000-4000-8000-000000000005' and payload ->> 'kind' = 'notification' and payload ->> 'task_id' = t1::text;
  assert found and e.task_id is null and e.template = 'custom' and e.to_email = 'r2-quiet@example.com'
    and e.payload ->> 'category' = 'assigned' and e.payload ->> 'actor_name' = 'Lena Leadwell'
    and e.payload ->> 'title' = 'R2 task one' and e.payload ->> 'context' = 'R2 P'
    and e.payload ->> 'path' = '/projects/' || p || '?task=' || t1,
    'but the email is queued (no task_id, so task readers never see it)';
  insert into r2_ids values ('quiet_email', e.id);
  assert exists (select 1 from public.inbox_items where recipient_id = 'a2a2a2a2-0000-4000-8000-000000000002' and task_id = t2 and kind = 'assigned'),
    'Max keeps the Inbox copy';
  select * into e from public.email_outbox
  where to_profile_id = 'a2a2a2a2-0000-4000-8000-000000000002' and payload ->> 'kind' = 'notification' and payload ->> 'task_id' = t2::text;
  assert found and e.payload ->> 'inbox_item_id' = (
    select id::text from public.inbox_items where recipient_id = 'a2a2a2a2-0000-4000-8000-000000000002' and task_id = t2 and kind = 'assigned'
  ), 'and the email names the Inbox item';
  insert into r2_ids values ('max_email', e.id);
  assert not exists (select 1 from public.email_outbox where payload ->> 'kind' = 'notification'
                       and to_profile_id = 'a2a2a2a2-0000-4000-8000-000000000003' and payload ->> 'category' <> 'mention'),
    'other emails stay off by default (Otto never asked for any: no status update or reply emails)';
  assert exists (select 1 from public.email_outbox where payload ->> 'kind' = 'notification'
                   and to_profile_id = 'a2a2a2a2-0000-4000-8000-000000000003' and payload ->> 'category' = 'mention'
                   and payload ? 'team_message_id' and payload ->> 'context' = 'R2 Team'
                   and payload ->> 'path' like '/teams/%/messages/%'),
    'but mention emails follow the comment email switch (on), so the team message mention was emailed';
end $$;
set role authenticated;

-- The mention switch on comment emails: Quinn turned comment emails off, so a mention isn't emailed
-- (mentions follow the comment switch until set); once Quinn turns mention emails on, it is.
select set_config('request.jwt.claim.sub', 'a2a2a2a2-0000-4000-8000-000000000002', false) is not null as ok \gset
insert into public.comments (task_id, body) values ((select id from r2_ids where name = 't3'), 'Thoughts, @Quinn Quietly?');

reset role;
do $$
begin
  assert not exists (select 1 from public.email_outbox o where o.to_profile_id = 'a2a2a2a2-0000-4000-8000-000000000005'
                       and o.comment_id is not null), 'no comment email while both switches are off';
end $$;
set role authenticated;

select set_config('request.jwt.claim.sub', 'a2a2a2a2-0000-4000-8000-000000000005', false) is not null as ok \gset
do $$ begin perform public.set_notification_setting('mention', 'email', true); end $$;
select set_config('request.jwt.claim.sub', 'a2a2a2a2-0000-4000-8000-000000000002', false) is not null as ok \gset
insert into public.comments (task_id, body) values ((select id from r2_ids where name = 't3'), 'Still need you, @Quinn Quietly.');
insert into public.comments (task_id, body) values ((select id from r2_ids where name = 't3'), 'A plain comment.');

reset role;
do $$
declare
  e public.email_outbox;
begin
  assert (select count(*) from public.email_outbox o where o.to_profile_id = 'a2a2a2a2-0000-4000-8000-000000000005'
            and o.comment_id is not null) = 1, 'the mention is emailed; the plain comment isn''t';
  select * into e from public.email_outbox o where o.to_profile_id = 'a2a2a2a2-0000-4000-8000-000000000005' and o.comment_id is not null;
  assert e.subject = 'Max Memberly mentioned you on “R2 task three”' and (e.payload ->> 'mentioned')::boolean,
    'the subject says it''s a mention';
  assert public.comment_email_block_reason(e.id) is null, 'and the send-time check agrees';
  assert (select count(*) from public.email_outbox o where o.to_profile_id = 'a2a2a2a2-0000-4000-8000-000000000001'
            and o.comment_id is not null and o.task_id = (select id from r2_ids where name = 't3')) = 3,
    'the lead (the task''s creator, a follower, comment emails on) gets every comment email as before';
end $$;
set role authenticated;

-- A project message mention is emailed to someone with comment emails on (mentions follow that switch).
select set_config('request.jwt.claim.sub', 'a2a2a2a2-0000-4000-8000-000000000001', false) is not null as ok \gset
insert into public.project_messages (project_id, title, body)
values ((select id from r2_ids where name = 'p'), 'Copy review', 'Please look, @Max Memberly.');

reset role;
do $$
declare
  e public.email_outbox;
begin
  select * into e from public.email_outbox
  where to_profile_id = 'a2a2a2a2-0000-4000-8000-000000000002' and payload ->> 'kind' = 'notification' and payload ->> 'item_kind' = 'mention';
  assert found and e.payload ->> 'title' = 'Copy review' and e.payload ? 'message_id'
    and e.payload ->> 'path' like '/projects/%/messages/%#message-%', 'a message mention email links to the thread';
  insert into r2_ids values ('message_email', e.id);
end $$;

-- Claiming: the existing drains never take notification emails; claim_notification_emails does, after
-- the send-time check.
set role service_role;
do $$
begin
  assert not exists (select 1 from public.claim_email_deliveries(100, (select id from r2_ids where name = 'message_email'))),
    'claim_email_deliveries leaves notification emails alone';
  assert not exists (select 1 from public.claim_email_outbox(100, (select id from r2_ids where name = 'message_email'))),
    'so does the legacy claim';
  assert (select count(*) from public.claim_notification_emails(100, (select id from r2_ids where name = 'message_email'))) = 1,
    'claim_notification_emails claims it';
end $$;
reset role;

-- Max reads the assignment in the Inbox before the email goes out; Quinn turns assignment emails off.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a2a2a2a2-0000-4000-8000-000000000002', false) is not null as ok \gset
update public.inbox_items set read_at = now() where task_id = (select id from r2_ids where name = 't2') and kind = 'assigned';
select set_config('request.jwt.claim.sub', 'a2a2a2a2-0000-4000-8000-000000000005', false) is not null as ok \gset
do $$ begin perform public.set_notification_setting('assigned', 'email', false); end $$;
reset role;

set role service_role;
do $$
begin
  assert not exists (select 1 from public.claim_notification_emails(100, (select id from r2_ids where name = 'max_email'))),
    'an email read in the Inbox isn''t sent';
  assert not exists (select 1 from public.claim_notification_emails(100, (select id from r2_ids where name = 'quiet_email'))),
    'an email turned off since isn''t sent';
end $$;
reset role;

do $$
begin
  assert (select status = 'failed' and last_error = 'Not sent: already read in the Inbox'
          from public.email_outbox where id = (select id from r2_ids where name = 'max_email')), 'failed with the reason';
  assert (select status = 'failed' and last_error = 'Not sent: the recipient turned off these emails'
          from public.email_outbox where id = (select id from r2_ids where name = 'quiet_email')), 'failed with the reason';
  assert (select status from public.email_outbox where id = (select id from r2_ids where name = 'message_email')) = 'sending',
    'the claimed one is on its way';
end $$;

-- Defaults keep today's behavior --------------------------------------------------------------------

do $$
begin
  assert public.notification_wanted('a2a2a2a2-0000-4000-8000-000000000003', 'assigned', 'inbox')
    and public.notification_wanted('a2a2a2a2-0000-4000-8000-000000000003', 'status_update', 'inbox')
    and public.notification_wanted('a2a2a2a2-0000-4000-8000-000000000003', 'comment', 'email')
    and public.notification_wanted('a2a2a2a2-0000-4000-8000-000000000003', 'mention', 'email')
    and not public.notification_wanted('a2a2a2a2-0000-4000-8000-000000000003', 'assigned', 'email')
    and not public.notification_wanted('a2a2a2a2-0000-4000-8000-000000000003', 'approval', 'email'),
    'Inbox on; email only for comments and mentions';
  assert public.notification_category('rule', '{"field_change": true}') = 'field_change'
    and public.notification_category('rule', '{}') = 'rule'
    and public.notification_category('approval_decided', '{}') = 'approval', 'categories';
end $$;

-- Last activity --------------------------------------------------------------------------------------

-- Hal created a project (activity, dated back below), and its only task was created in an inbound
-- webhook's transaction in Hal's name: that task isn't Hal's activity.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a2a2a2a2-0000-4000-8000-000000000006', false) is not null as ok \gset
do $$
declare
  p uuid;
  t uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'R2 Hook P') returning id into p;
  select public.create_task(p, null, 'From the webhook') into t;
  insert into r2_ids values ('hook_task', t);
end $$;
reset role;
update public.tasks set source = 'inbound' where id = (select id from r2_ids where name = 'hook_task');
-- Creating the project is Hal's own activity; date it back so the webhook's task can't hide behind it.
update public.projects set created_at = '2026-01-05 09:00+00' where name = 'R2 Hook P';

set role authenticated;
select set_config('request.jwt.claim.sub', 'a2a2a2a2-0000-4000-8000-000000000005', false) is not null as ok \gset
do $$
begin
  assert (select count(*) from public.list_member_last_activity()) = 1
    and (select profile_id from public.list_member_last_activity()) = auth.uid(), 'a member sees only their own row';
  assert not exists (select 1 from public.list_member_last_activity('a2a2a2a2-0000-4000-8000-000000000002')),
    'and nobody else''s';
  assert (select last_sign_in_at from public.list_member_last_activity()) = '2026-10-01 08:00+00', 'their sign-in';
end $$;

select set_config('request.jwt.claim.sub', 'a2a2a2a2-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
begin
  assert (select count(*) from public.list_member_last_activity() where email like 'r2-%') = 6, 'admins see everyone';
  assert (select last_active_at from public.list_member_last_activity('a2a2a2a2-0000-4000-8000-000000000002'))
         > now() - interval '1 hour',
    'activity counts comments, messages, and task changes (also in projects the admin can''t open: a time only)';
  assert (select last_active_at from public.list_member_last_activity('a2a2a2a2-0000-4000-8000-000000000006')) = '2026-01-05 09:00+00',
    'creating a project counts; an inbound webhook''s task in the creator''s name doesn''t';
  assert (select last_active_at from public.list_member_last_activity('a2a2a2a2-0000-4000-8000-000000000003')) is null,
    'someone who never did anything has none (nothing invented)';
  assert (select last_sign_in_at from public.list_member_last_activity('a2a2a2a2-0000-4000-8000-000000000002')) = '2026-10-12 10:00+00',
    'the sign-in time comes along';
end $$;

select set_config('request.jwt.claim.sub', 'a2a2a2a2-0000-4000-8000-000000000006', false) is not null as ok \gset
insert into public.comments (task_id, body) values ((select id from r2_ids where name = 'hook_task'), 'Looked at it.');
select set_config('request.jwt.claim.sub', 'a2a2a2a2-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
begin
  assert (select last_active_at from public.list_member_last_activity('a2a2a2a2-0000-4000-8000-000000000006'))
         > now() - interval '1 hour',
    'a comment of their own is';
end $$;

-- Removing a thread marks its items read; removing the team hides its messages ----------------------

select set_config('request.jwt.claim.sub', 'a2a2a2a2-0000-4000-8000-000000000002', false) is not null as ok \gset
update public.team_messages set deleted_at = now() where id = (select id from r2_ids where name = 'thread');

reset role;
do $$
declare
  m uuid := (select id from r2_ids where name = 'thread');
begin
  assert not exists (
    select 1 from public.inbox_items i
    where i.team_message_id in (select id from public.team_messages where id = m or thread_id = m) and i.read_at is null
  ), 'a removed thread''s items (and its replies'') are marked read';
end $$;
set role authenticated;

select set_config('request.jwt.claim.sub', 'a2a2a2a2-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  team uuid := (select id from r2_ids where name = 'team');
  m uuid;
begin
  insert into public.team_messages (team_id, title, body) values (team, 'Second thread', 'Still here') returning id into m;
  insert into r2_ids values ('thread2', m);
  update public.teams set deleted_at = now() where id = team;
end $$;

select set_config('request.jwt.claim.sub', 'a2a2a2a2-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  assert not public.can_read_team((select id from r2_ids where name = 'team')), 'a removed team''s messages are closed';
  assert not exists (select 1 from public.team_messages where id = (select id from r2_ids where name = 'thread2')), 'unreadable';
  assert not exists (select 1 from public.inbox_items where team_message_id = (select id from r2_ids where name = 'thread2')),
    'and so are the items about them';
end $$;

reset role;
select 'zz16 real 2 smoke: ok' as result;
