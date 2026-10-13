-- ALHC Projects — Phase: Real features 2 (team and people).
-- ROADMAP.md section 0 listed what still pretended about teams and people; this makes it real in the
-- database (person profile pages are app-only reads through RLS):
--
--   Team messages. A team's Messages tab was a placeholder that pointed at project Messages. Now teams
--     have their own threads: team_messages (thread_id null = a thread with a title, else a reply — one
--     level, like project messages), team_message_mentions, team_message_reactions, and
--     team_message_followers. Read = whoever can see the team (teams are a workspace directory: everyone
--     allowlisted, while the team is live; can_read_team); post / reply / react = the team's active
--     members plus the people who manage it (can_post_team_message: members, leads, workspace admins);
--     authors edit and remove their own (the project-message guard's rules). Following: the author,
--     everyone who replies, and everyone @mentioned follow the thread; anyone who can read it can Follow
--     or Unfollow it. Notifications (definer triggers, notify_team_message — the import and copy mutes,
--     never the actor, only people allowlisted while the team is live): a new thread tells every active
--     team member ("message", data.new_thread), a reply tells the thread's followers ("message"), an
--     @mention tells that person ("mention"; anyone in the workspace can be mentioned, since everyone can
--     read team messages), an edit only newly mentioned people, and deleting a message marks its items
--     read. inbox_items.team_message_id points at the message.
--   Notification settings per kind. notification_settings (own rows only): one row per person and kind
--     with an Inbox and an Email switch (null = the default). Kinds: assigned, mention, comment,
--     completed, approval, message, status_update, field_change, rule. Defaults keep what happens today:
--     every Inbox kind on; email off except comments (profiles.email_comments stays that switch, so the
--     release still on main keeps reading it) and @mentions (until changed, they follow the comment
--     switch, as a mention in a comment was a comment email before). set_notification_setting() (invoker)
--     writes them. The Inbox respects them through a BEFORE INSERT trigger on inbox_items
--     (inbox_items_05_preferences): an item whose kind the recipient turned off isn't stored. The email
--     outbox respects them: (1) comment emails (on_comment_email, comment_email_block_reason — asserted
--     patches) go to a follower who wants comment emails, or who is @mentioned in that comment and wants
--     mention emails; (2) every other kind can now be emailed: the same trigger queues one outbox row
--     (template custom, payload kind "notification", task_id null so task readers never see it) for a
--     recipient whose Email switch for that kind is on, whether or not the Inbox copy is kept. At send
--     time notification_email_block_reason() fails it instead when it's more than a day late, the
--     recipient lost access (to the workspace or to the task / message / project), turned the email off,
--     changed address, or already read the notification in the Inbox. claim_email_deliveries (the
--     current drain) and claim_email_outbox (legacy) no longer claim these rows (asserted patches), so
--     the release still on main never sends one; this release's drain claims them through
--     claim_notification_emails() (service_role only).
--   Status update notifications. A new project status update (project_status_updates, written only by
--     set_project_status) tells the project's members ("status_update", inbox_items.status_update_id),
--     except its author; the setting's default is on (Asana's default for project members).
--   Real last activity. list_member_last_activity(target_profile) (SECURITY DEFINER): for workspace admins
--     every allowlisted address with a profile, for anyone else only their own row — the last sign-in
--     plus the last time the person did something that shows up in an activity feed: a task story they
--     caused (task_stories.actor_id; a task created through an inbound webhook in its creator's name
--     doesn't count, since the creator didn't do it), a comment, a project or team message, a project or
--     goal status update, a project story (copies, archive), or creating a project. Derived from those
--     tables (two new covering indexes); no counter, nothing invented. Only a timestamp: never what or
--     where.
--
-- New client surface: one SECURITY DEFINER function, list_member_last_activity (pinned in suite 60).
-- claim_notification_emails is service_role only; every trigger function and internal helper is revoked
-- from client roles; set_notification_setting, can_read_team, can_post_team_message, and the guards are
-- invoker. fire_rules, notify_with, notify_message, and add_story are untouched (their import and copy
-- checks included); the new notify_team_message / notify_status_update carry the same mutes. Nothing for
-- anon. Additive: the release still on main keeps working once this is applied (it never reads the new
-- tables or columns; its listInbox only reads task and project-message items; its drain never claims
-- notification emails; every default keeps today's Inbox and email behavior).
--
-- TAIL: inbox_items' kind and target CHECKs predate team messages and status updates. Wider CHECKs
-- (…_v2) are added here; the tail retires the old ones and gives the new ones the old names. Until the
-- tail is applied, team message and status update notifications are skipped (notify_team_message and
-- notify_status_update catch the old CHECK's refusal), while posting, settings, emails for every other
-- kind, and last activity already work. The grant on notification_settings is the last statement before
-- the tail: the app treats this release's database features as present once that table is readable.

create or replace function public.alhc_patch_function(target regprocedure, variadic edits text[])
returns void
language plpgsql
set search_path = ''
as $$
declare
  def text := pg_get_functiondef(target);
  hits integer;
begin
  if coalesce(array_length(edits, 1), 0) = 0 or array_length(edits, 1) % 2 <> 0 then
    raise exception 'alhc_patch_function(%): pass (old, new) text pairs', target;
  end if;
  for i in 1 .. array_length(edits, 1) / 2 loop
    if coalesce(edits[2 * i - 1], '') = '' then
      raise exception 'alhc_patch_function(%): edit % has no text to replace', target, i;
    end if;
    hits := (length(def) - length(replace(def, edits[2 * i - 1], ''))) / length(edits[2 * i - 1]);
    if hits <> 1 then
      raise exception 'alhc_patch_function(%): edit % matched % times (expected exactly once)', target, i, hits;
    end if;
    def := replace(def, edits[2 * i - 1], edits[2 * i]);
  end loop;
  execute def;
end;
$$;

revoke all on function public.alhc_patch_function(regprocedure, text[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Team messages: who can read, who can post
-- ---------------------------------------------------------------------------

-- Who can read a team's messages: whoever can see the team (the directory is workspace-level), while it
-- is live. Invoker: teams are readable by everyone allowlisted.
create or replace function public.can_read_team(target_team uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select public.is_allowlisted()
    and exists (select 1 from public.teams t where t.id = target_team and t.deleted_at is null);
$$;

revoke all on function public.can_read_team(uuid) from public, anon;
grant execute on function public.can_read_team(uuid) to authenticated;

-- Who can post, reply, and react: the team's active members and the people who manage it (its leads and
-- workspace admins, can_manage_team). Invoker.
create or replace function public.can_post_team_message(target_team uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select public.can_read_team(target_team)
    and (
      exists (
        select 1 from public.team_members m
        where m.team_id = target_team and m.profile_id = auth.uid() and m.deleted_at is null
      )
      or public.can_manage_team(target_team)
    );
$$;

revoke all on function public.can_post_team_message(uuid) from public, anon;
grant execute on function public.can_post_team_message(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Team messages: tables
-- ---------------------------------------------------------------------------

-- Created and locked (RLS on, no client privileges) in one statement, so no chunk boundary can leave
-- them open between the two. Grants come with the policies below.
do $do$
begin
  execute $sql$
    create table public.team_messages (
      id uuid primary key default gen_random_uuid(),
      team_id uuid not null references public.teams (id),
      thread_id uuid references public.team_messages (id),
      title text,
      body text not null check (char_length(btrim(body)) between 1 and 20000),
      author_id uuid not null default auth.uid() references public.profiles (id),
      edited_at timestamptz,
      last_activity_at timestamptz not null default now(),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted_at timestamptz,
      constraint team_messages_title_check check (
        (thread_id is null and title is not null and char_length(btrim(title)) between 1 and 200)
        or (thread_id is not null and title is null)
      ),
      constraint team_messages_not_own_thread check (thread_id is distinct from id)
    )
  $sql$;
  execute 'alter table public.team_messages enable row level security';
  execute 'revoke all on public.team_messages from anon, authenticated';

  execute $sql$
    create table public.team_message_mentions (
      message_id uuid not null references public.team_messages (id),
      profile_id uuid not null references public.profiles (id),
      created_at timestamptz not null default now(),
      primary key (message_id, profile_id)
    )
  $sql$;
  execute 'alter table public.team_message_mentions enable row level security';
  execute 'revoke all on public.team_message_mentions from anon, authenticated';

  execute $sql$
    create table public.team_message_reactions (
      id uuid primary key default gen_random_uuid(),
      message_id uuid not null references public.team_messages (id),
      team_id uuid not null references public.teams (id),
      profile_id uuid not null default auth.uid() references public.profiles (id),
      emoji text not null check (emoji in ('thumbs_up', 'heart', 'tada', 'laugh', 'eyes', 'check')),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted_at timestamptz
    )
  $sql$;
  execute 'alter table public.team_message_reactions enable row level security';
  execute 'revoke all on public.team_message_reactions from anon, authenticated';

  execute $sql$
    create table public.team_message_followers (
      id uuid primary key default gen_random_uuid(),
      thread_id uuid not null references public.team_messages (id),
      team_id uuid not null references public.teams (id),
      profile_id uuid not null default auth.uid() references public.profiles (id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted_at timestamptz,
      constraint team_message_followers_thread_profile_key unique (thread_id, profile_id)
    )
  $sql$;
  execute 'alter table public.team_message_followers enable row level security';
  execute 'revoke all on public.team_message_followers from anon, authenticated';
end;
$do$;

comment on table public.team_messages is
  'Real features 2: team Messages. thread_id null = a thread (with a title), else a reply. Read = whoever can '
  'see the team (can_read_team); post / reply = its members and managers (can_post_team_message); authors '
  'edit and remove their own (deleted_at).';
comment on table public.team_message_mentions is
  'Real features 2: people @mentioned in a team message. Written by triggers only.';
comment on table public.team_message_reactions is
  'Real features 2: reactions on team messages (the comment reaction set). Read = team readers, react = '
  'team members and managers (own rows; removal sets deleted_at).';
comment on table public.team_message_followers is
  'Real features 2: who follows a team thread (gets its replies in the Inbox). The author, repliers, and '
  'mentioned people are added by triggers; anyone who can read the thread follows / unfollows themselves '
  '(deleted_at = unfollowed).';

create index team_messages_threads_idx on public.team_messages (team_id, last_activity_at desc)
  where thread_id is null and deleted_at is null;
create index team_messages_replies_idx on public.team_messages (thread_id, created_at)
  where thread_id is not null;
create index team_messages_author_idx on public.team_messages (author_id, created_at desc);
create index team_message_mentions_profile_idx on public.team_message_mentions (profile_id);
create unique index team_message_reactions_active_idx
  on public.team_message_reactions (message_id, profile_id, emoji) where deleted_at is null;
create index team_message_reactions_team_idx on public.team_message_reactions (team_id);
create index team_message_reactions_profile_idx on public.team_message_reactions (profile_id);
create index team_message_followers_profile_idx on public.team_message_followers (profile_id);
create index team_message_followers_team_idx on public.team_message_followers (team_id);

create trigger team_messages_set_updated_at
  before update on public.team_messages
  for each row execute function public.set_updated_at();
create trigger team_message_reactions_set_updated_at
  before update on public.team_message_reactions
  for each row execute function public.set_updated_at();
create trigger team_message_followers_set_updated_at
  before update on public.team_message_followers
  for each row execute function public.set_updated_at();

-- Runs as the caller (the project-message guard's rules). Inserts: author = caller, a reply joins an
-- active thread of the same team (its team is copied from the thread). Updates by people: only the body
-- (and a thread's title) or setting deleted_at; a deleted message can't be edited or restored. Any body /
-- title change stamps edited_at.
create or replace function public.guard_team_message()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  thread public.team_messages;
begin
  if tg_op = 'INSERT' then
    if public.is_client_role() then
      new.author_id := auth.uid();
      new.created_at := now();
      new.last_activity_at := now();
      new.edited_at := null;
      new.deleted_at := null;
    end if;
    if new.thread_id is not null then
      select * into thread from public.team_messages m where m.id = new.thread_id;
      if not found or thread.deleted_at is not null then
        raise exception 'Message not found' using errcode = 'no_data_found';
      end if;
      if thread.thread_id is not null then
        raise exception 'Reply to the thread, not to a reply' using errcode = 'check_violation';
      end if;
      new.team_id := thread.team_id;
      new.title := null;
    else
      new.title := btrim(new.title);
    end if;
    new.body := btrim(new.body);
    return new;
  end if;

  if public.is_client_role() then
    if old.deleted_at is not null then
      raise exception 'This message was deleted' using errcode = 'check_violation';
    end if;
    if new.id <> old.id
       or new.team_id <> old.team_id
       or new.thread_id is distinct from old.thread_id
       or new.author_id <> old.author_id
       or new.created_at <> old.created_at
       or new.last_activity_at <> old.last_activity_at
       or new.edited_at is distinct from old.edited_at then
      raise exception 'Only the text of a message can be edited' using errcode = 'insufficient_privilege';
    end if;
  end if;
  if new.thread_id is null then
    new.title := btrim(new.title);
  end if;
  new.body := btrim(new.body);
  if new.body is distinct from old.body or new.title is distinct from old.title then
    new.edited_at := now();
  end if;
  return new;
end;
$$;

revoke all on function public.guard_team_message() from public, anon;
grant execute on function public.guard_team_message() to authenticated;

create trigger team_messages_05_guard
  before insert or update on public.team_messages
  for each row execute function public.guard_team_message();

create policy team_messages_select_reader on public.team_messages
  for select to authenticated
  using ((select public.can_read_team(team_messages.team_id)));
create policy team_messages_insert_own_member on public.team_messages
  for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and (select public.can_post_team_message(team_messages.team_id))
  );
create policy team_messages_update_own_member on public.team_messages
  for update to authenticated
  using (
    author_id = (select auth.uid())
    and (select public.can_post_team_message(team_messages.team_id))
  )
  with check (
    author_id = (select auth.uid())
    and (select public.can_post_team_message(team_messages.team_id))
  );

grant select on public.team_messages to authenticated;
grant insert (team_id, thread_id, title, body) on public.team_messages to authenticated;
grant update (title, body, deleted_at) on public.team_messages to authenticated;

create policy team_message_mentions_select_reader on public.team_message_mentions
  for select to authenticated
  using (exists (
    select 1 from public.team_messages m
    where m.id = team_message_mentions.message_id
      and (select public.can_read_team(m.team_id))
  ));

grant select on public.team_message_mentions to authenticated;

-- Runs as the caller: the team comes from the (active) message; people can only remove a reaction.
create or replace function public.guard_team_message_reaction()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    select m.team_id into new.team_id
    from public.team_messages m
    where m.id = new.message_id and m.deleted_at is null;
    if new.team_id is null then
      raise exception 'Message not found' using errcode = 'no_data_found';
    end if;
    if public.is_client_role() then
      new.profile_id := auth.uid();
      new.created_at := now();
      new.deleted_at := null;
    end if;
    return new;
  end if;
  if public.is_client_role() then
    if new.message_id <> old.message_id
       or new.team_id <> old.team_id
       or new.profile_id <> old.profile_id
       or new.emoji <> old.emoji
       or new.created_at <> old.created_at
       or old.deleted_at is not null
       or new.deleted_at is null then
      raise exception 'Reactions can only be removed' using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_team_message_reaction() from public, anon;
grant execute on function public.guard_team_message_reaction() to authenticated;

create trigger team_message_reactions_05_guard
  before insert or update on public.team_message_reactions
  for each row execute function public.guard_team_message_reaction();

create policy team_message_reactions_select_reader on public.team_message_reactions
  for select to authenticated
  using ((select public.can_read_team(team_message_reactions.team_id)));
create policy team_message_reactions_insert_own_member on public.team_message_reactions
  for insert to authenticated
  with check (
    profile_id = (select auth.uid())
    and (select public.can_post_team_message(team_message_reactions.team_id))
  );
create policy team_message_reactions_update_own_member on public.team_message_reactions
  for update to authenticated
  using (
    profile_id = (select auth.uid())
    and (select public.can_post_team_message(team_message_reactions.team_id))
  )
  with check (
    profile_id = (select auth.uid())
    and (select public.can_post_team_message(team_message_reactions.team_id))
  );

grant select on public.team_message_reactions to authenticated;
grant insert (message_id, emoji) on public.team_message_reactions to authenticated;
grant update (deleted_at) on public.team_message_reactions to authenticated;

-- Runs as the caller: a follow belongs to an active thread (never a reply) and takes its team; people
-- follow only themselves, and afterwards change nothing but deleted_at (unfollow = set, follow again =
-- clear).
create or replace function public.guard_team_message_follower()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  thread public.team_messages;
begin
  if tg_op = 'INSERT' then
    select * into thread from public.team_messages m where m.id = new.thread_id;
    if not found or thread.deleted_at is not null or thread.thread_id is not null then
      raise exception 'Message not found' using errcode = 'no_data_found';
    end if;
    new.team_id := thread.team_id;
    if public.is_client_role() then
      new.profile_id := auth.uid();
      new.created_at := now();
      new.deleted_at := null;
    end if;
    return new;
  end if;
  if public.is_client_role() then
    if new.thread_id <> old.thread_id
       or new.team_id <> old.team_id
       or new.profile_id <> old.profile_id
       or new.created_at <> old.created_at then
      raise exception 'Only following can be changed' using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_team_message_follower() from public, anon;
grant execute on function public.guard_team_message_follower() to authenticated;

create trigger team_message_followers_05_guard
  before insert or update on public.team_message_followers
  for each row execute function public.guard_team_message_follower();

create policy team_message_followers_select_reader on public.team_message_followers
  for select to authenticated
  using ((select public.can_read_team(team_message_followers.team_id)));
create policy team_message_followers_insert_own_reader on public.team_message_followers
  for insert to authenticated
  with check (
    profile_id = (select auth.uid())
    and (select public.can_read_team(team_message_followers.team_id))
  );
create policy team_message_followers_update_own_reader on public.team_message_followers
  for update to authenticated
  using (
    profile_id = (select auth.uid())
    and (select public.can_read_team(team_message_followers.team_id))
  )
  with check (
    profile_id = (select auth.uid())
    and (select public.can_read_team(team_message_followers.team_id))
  );

grant select on public.team_message_followers to authenticated;
grant insert (thread_id, profile_id) on public.team_message_followers to authenticated;
grant update (deleted_at) on public.team_message_followers to authenticated;

-- ---------------------------------------------------------------------------
-- Inbox items about team messages and status updates
-- ---------------------------------------------------------------------------

alter table public.inbox_items add column team_message_id uuid references public.team_messages (id);
alter table public.inbox_items add column status_update_id uuid references public.project_status_updates (id);
create index inbox_items_team_message_idx on public.inbox_items (team_message_id) where team_message_id is not null;
create index inbox_items_status_update_idx on public.inbox_items (status_update_id) where status_update_id is not null;

comment on column public.inbox_items.team_message_id is
  'Real features 2: the team message an item is about (task_id and message_id are null then). Readable by the '
  'recipient while they can read the team''s messages.';
comment on column public.inbox_items.status_update_id is
  'Real features 2: the project status update an item is about (kind status_update). Readable by the recipient '
  'while they can read the project.';

-- The wider CHECKs; the tail retires the old ones (which don't know these targets and the new kind).
alter table public.inbox_items add constraint inbox_items_target_check_v2 check (
  task_id is not null or message_id is not null or team_message_id is not null or status_update_id is not null
);
alter table public.inbox_items add constraint inbox_items_kind_check_v2 check (kind in (
  'assigned', 'comment', 'mention', 'completed', 'approval_requested', 'approval_decided', 'rule', 'message',
  'status_update'
));

-- Task items and project-message items as before; team-message items while the recipient can read the
-- team's messages; status-update items while they can read the project.
alter policy inbox_items_select_own_viewer on public.inbox_items
  using (
    recipient_id = (select auth.uid())
    and (
      (task_id is not null and (select public.has_task_role(inbox_items.task_id, 'viewer')))
      or (task_id is null and exists (
        select 1 from public.project_messages m
        where m.id = inbox_items.message_id and (select public.has_project_role(m.project_id, 'viewer'))
      ))
      or (task_id is null and exists (
        select 1 from public.team_messages m
        where m.id = inbox_items.team_message_id and (select public.can_read_team(m.team_id))
      ))
      or (task_id is null and exists (
        select 1 from public.project_status_updates u
        where u.id = inbox_items.status_update_id and (select public.has_project_role(u.project_id, 'viewer'))
      ))
    )
  );
alter policy inbox_items_update_own_viewer on public.inbox_items
  using (
    recipient_id = (select auth.uid())
    and (
      (task_id is not null and (select public.has_task_role(inbox_items.task_id, 'viewer')))
      or (task_id is null and exists (
        select 1 from public.project_messages m
        where m.id = inbox_items.message_id and (select public.has_project_role(m.project_id, 'viewer'))
      ))
      or (task_id is null and exists (
        select 1 from public.team_messages m
        where m.id = inbox_items.team_message_id and (select public.can_read_team(m.team_id))
      ))
      or (task_id is null and exists (
        select 1 from public.project_status_updates u
        where u.id = inbox_items.status_update_id and (select public.has_project_role(u.project_id, 'viewer'))
      ))
    )
  )
  with check (
    recipient_id = (select auth.uid())
    and (
      (task_id is not null and (select public.has_task_role(inbox_items.task_id, 'viewer')))
      or (task_id is null and exists (
        select 1 from public.project_messages m
        where m.id = inbox_items.message_id and (select public.has_project_role(m.project_id, 'viewer'))
      ))
      or (task_id is null and exists (
        select 1 from public.team_messages m
        where m.id = inbox_items.team_message_id and (select public.can_read_team(m.team_id))
      ))
      or (task_id is null and exists (
        select 1 from public.project_status_updates u
        where u.id = inbox_items.status_update_id and (select public.has_project_role(u.project_id, 'viewer'))
      ))
    )
  );

-- ---------------------------------------------------------------------------
-- Team messages: mentions, following, notifications (definer triggers and helpers, revoked)
-- ---------------------------------------------------------------------------

-- @mentions in a team message: the comment matcher (`@Full Name` or `@emaillocalpart`, word-bounded,
-- case-insensitive) over allowlisted people (everyone in the workspace can read team messages); never
-- the author.
create or replace function public.team_message_mention_ids(author uuid, body text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
  from public.profiles p
  where p.id is distinct from author
    and public.profile_is_allowlisted(p.id)
    and (
      (nullif(trim(p.full_name), '') is not null
        and body ~* ('@' || public.regex_escape(trim(p.full_name)) || '([^[:alnum:]_]|$)'))
      or body ~* ('@' || public.regex_escape(split_part(p.email, '@', 1)) || '([^[:alnum:]_]|$)')
    );
$$;

revoke all on function public.team_message_mention_ids(uuid, text) from public, anon, authenticated;

-- Someone follows a thread (again): allowlisted people only.
create or replace function public.follow_team_thread(target_thread uuid, person uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if person is null or not public.profile_is_allowlisted(person) then
    return;
  end if;
  insert into public.team_message_followers (thread_id, profile_id)
  values (target_thread, person)
  on conflict (thread_id, profile_id) do update
    set deleted_at = null
    where public.team_message_followers.deleted_at is not null;
end;
$$;

revoke all on function public.follow_team_thread(uuid, uuid) from public, anon, authenticated;

-- The team-message twin of notify_message(): the same import and copy mutes, never the actor, and only
-- allowlisted people while the team and the message are live. Until the tail retires inbox_items' old
-- target CHECK, the insert is refused; that refusal (and only it) is caught, so posting still works.
create or replace function public.notify_team_message(recipient uuid, target_message uuid, item_kind text, item_data jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := public.current_actor_id();
  msg public.team_messages;
  team public.teams;
begin
  if public.import_context_id() is not null then
    return;
  end if;
  if public.copy_context_id() is not null then
    return;
  end if;
  if recipient is null or recipient is not distinct from actor then
    return;
  end if;
  select * into msg from public.team_messages m where m.id = target_message;
  if not found or msg.deleted_at is not null then
    return;
  end if;
  select * into team from public.teams t where t.id = msg.team_id;
  if not found or team.deleted_at is not null then
    return;
  end if;
  if not exists (select 1 from public.profiles p where p.id = recipient)
     or not public.profile_is_allowlisted(recipient) then
    return;
  end if;
  begin
    insert into public.inbox_items (recipient_id, actor_id, task_id, team_message_id, kind, data)
    values (
      recipient, actor, null, target_message, item_kind,
      coalesce(item_data, '{}'::jsonb) || jsonb_build_object(
        'team_id', team.id,
        'team_name', team.name,
        'thread_id', coalesce(msg.thread_id, msg.id)
      )
    );
  exception when check_violation then
    -- inbox_items' old target CHECK (until the tail is applied): no Inbox item.
    null;
  end;
end;
$$;

revoke all on function public.notify_team_message(uuid, uuid, text, jsonb) from public, anon, authenticated;

-- After a team message is posted: record mentions; the author and mentioned people follow the thread;
-- mentioned people hear "mention"; a new thread tells every other active team member ("message",
-- new_thread); a reply bumps the thread and tells its other followers ("message").
create or replace function public.on_team_message_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  thread uuid := coalesce(new.thread_id, new.id);
begin
  insert into public.team_message_mentions (message_id, profile_id)
  select new.id, m.id
  from public.team_message_mention_ids(new.author_id, new.body) as m (id)
  on conflict do nothing;

  perform public.follow_team_thread(thread, new.author_id);
  for r in select mm.profile_id from public.team_message_mentions mm where mm.message_id = new.id loop
    perform public.follow_team_thread(thread, r.profile_id);
    perform public.notify_team_message(r.profile_id, new.id, 'mention', '{}'::jsonb);
  end loop;

  if new.thread_id is null then
    for r in
      select m.profile_id
      from public.team_members m
      where m.team_id = new.team_id
        and m.deleted_at is null
        and m.profile_id is distinct from new.author_id
        and not exists (
          select 1 from public.team_message_mentions mm
          where mm.message_id = new.id and mm.profile_id = m.profile_id
        )
    loop
      perform public.notify_team_message(r.profile_id, new.id, 'message', jsonb_build_object('new_thread', true));
    end loop;
  else
    update public.team_messages set last_activity_at = now() where id = new.thread_id;
    for r in
      select f.profile_id
      from public.team_message_followers f
      where f.thread_id = new.thread_id
        and f.deleted_at is null
        and f.profile_id is distinct from new.author_id
        and not exists (
          select 1 from public.team_message_mentions mm
          where mm.message_id = new.id and mm.profile_id = f.profile_id
        )
    loop
      perform public.notify_team_message(r.profile_id, new.id, 'message', '{}'::jsonb);
    end loop;
  end if;
  return new;
end;
$$;

revoke all on function public.on_team_message_insert() from public, anon, authenticated;

create trigger team_messages_after_insert
  after insert on public.team_messages
  for each row execute function public.on_team_message_insert();

-- After an edit: only newly mentioned people are notified (and follow). After removal (deleted_at): the
-- message's inbox items (a thread's: its replies' too) are marked read.
create or replace function public.on_team_message_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  if new.deleted_at is not null and old.deleted_at is null then
    update public.inbox_items i
    set read_at = coalesce(i.read_at, now())
    where i.team_message_id in (
      select m.id from public.team_messages m where m.id = new.id or m.thread_id = new.id
    );
    return new;
  end if;
  if new.deleted_at is null and new.body is distinct from old.body then
    for r in
      insert into public.team_message_mentions (message_id, profile_id)
      select new.id, m.id
      from public.team_message_mention_ids(new.author_id, new.body) as m (id)
      on conflict do nothing
      returning profile_id
    loop
      perform public.follow_team_thread(coalesce(new.thread_id, new.id), r.profile_id);
      perform public.notify_team_message(r.profile_id, new.id, 'mention', '{}'::jsonb);
    end loop;
  end if;
  return new;
end;
$$;

revoke all on function public.on_team_message_update() from public, anon, authenticated;

create trigger team_messages_after_update
  after update of body, deleted_at on public.team_messages
  for each row execute function public.on_team_message_update();

-- ---------------------------------------------------------------------------
-- Status update notifications
-- ---------------------------------------------------------------------------

-- One status_update item for a project member: the same mutes as notify_with(), never the actor, only
-- allowlisted people who can read the project. Catches only the old target / kind CHECK (until the tail).
create or replace function public.notify_status_update(recipient uuid, target_update uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := public.current_actor_id();
  u public.project_status_updates;
  p public.projects;
begin
  if public.import_context_id() is not null then
    return;
  end if;
  if public.copy_context_id() is not null then
    return;
  end if;
  if recipient is null or recipient is not distinct from actor then
    return;
  end if;
  select * into u from public.project_status_updates x where x.id = target_update;
  if not found then
    return;
  end if;
  select * into p from public.projects x where x.id = u.project_id;
  if not found or p.deleted_at is not null then
    return;
  end if;
  if not exists (select 1 from public.profiles x where x.id = recipient)
     or not public.profile_is_allowlisted(recipient)
     or public.profile_project_role(recipient, p.id) is null then
    return;
  end if;
  begin
    insert into public.inbox_items (recipient_id, actor_id, task_id, status_update_id, kind, data)
    values (
      recipient, actor, null, u.id, 'status_update',
      jsonb_strip_nulls(jsonb_build_object(
        'project_id', p.id,
        'project_name', p.name,
        'status', u.status,
        'title', u.title,
        'note', left(u.note, 500)
      ))
    );
  exception when check_violation then
    -- inbox_items' old kind / target CHECKs (until the tail is applied): no Inbox item.
    null;
  end;
end;
$$;

revoke all on function public.notify_status_update(uuid, uuid) from public, anon, authenticated;

-- After set_project_status() records an update: every active member of the project but its author.
create or replace function public.on_project_status_update_notify()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  for r in
    select distinct pm.profile_id
    from public.project_members pm
    where pm.project_id = new.project_id
      and pm.deleted_at is null
      and pm.profile_id is distinct from new.author_id
  loop
    perform public.notify_status_update(r.profile_id, new.id);
  end loop;
  return null;
end;
$$;

revoke all on function public.on_project_status_update_notify() from public, anon, authenticated;

create trigger project_status_updates_after_insert_notify
  after insert on public.project_status_updates
  for each row execute function public.on_project_status_update_notify();

-- ---------------------------------------------------------------------------
-- Notification settings (per person, per kind)
-- ---------------------------------------------------------------------------

do $do$
begin
  execute $sql$
    create table public.notification_settings (
      profile_id uuid not null default auth.uid() references public.profiles (id),
      kind text not null constraint notification_settings_kind_check check (kind in (
        'assigned', 'mention', 'comment', 'completed', 'approval', 'message', 'status_update', 'field_change', 'rule'
      )),
      inbox boolean,
      email boolean,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (profile_id, kind),
      constraint notification_settings_comment_email_check check (kind <> 'comment' or email is null)
    )
  $sql$;
  execute 'alter table public.notification_settings enable row level security';
  execute 'revoke all on public.notification_settings from anon, authenticated';
end;
$do$;

comment on table public.notification_settings is
  'Real features 2: a person''s Inbox / Email switch per notification kind (own rows only; null = the default: '
  'Inbox on; email off except mentions, which follow profiles.email_comments until set). The comment email '
  'switch is profiles.email_comments.';

create trigger notification_settings_set_updated_at
  before update on public.notification_settings
  for each row execute function public.set_updated_at();

-- Runs as the caller: a row belongs to the person who writes it and never moves.
create or replace function public.guard_notification_setting()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.is_client_role() then
    if tg_op = 'INSERT' then
      new.profile_id := auth.uid();
      new.created_at := now();
    elsif new.profile_id <> old.profile_id or new.kind <> old.kind or new.created_at <> old.created_at then
      raise exception 'Only the switches can change' using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_notification_setting() from public, anon;
grant execute on function public.guard_notification_setting() to authenticated;

create trigger notification_settings_05_guard
  before insert or update on public.notification_settings
  for each row execute function public.guard_notification_setting();

create policy notification_settings_select_own on public.notification_settings
  for select to authenticated
  using (profile_id = (select auth.uid()) and (select public.is_allowlisted()));
create policy notification_settings_insert_own on public.notification_settings
  for insert to authenticated
  with check (profile_id = (select auth.uid()) and (select public.is_allowlisted()));
create policy notification_settings_update_own on public.notification_settings
  for update to authenticated
  using (profile_id = (select auth.uid()) and (select public.is_allowlisted()))
  with check (profile_id = (select auth.uid()) and (select public.is_allowlisted()));

-- The kind an inbox item counts as for the settings (and the Inbox's Filter): approval requests and
-- decisions are "approval"; a rule item with data.field_change is "field_change".
create or replace function public.notification_category(item_kind text, item_data jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select case item_kind
    when 'assigned' then 'assigned'
    when 'mention' then 'mention'
    when 'comment' then 'comment'
    when 'completed' then 'completed'
    when 'approval_requested' then 'approval'
    when 'approval_decided' then 'approval'
    when 'message' then 'message'
    when 'status_update' then 'status_update'
    else case when coalesce(item_data ->> 'field_change', '') = 'true' then 'field_change' else 'rule' end
  end;
$$;

revoke all on function public.notification_category(text, jsonb) from public, anon, authenticated;

-- Does this person want this kind of notification on this channel ('inbox' | 'email')? The defaults
-- keep today's behavior: every Inbox kind on; comment emails = profiles.email_comments; mention emails
-- follow that switch until set; every other email off. Internal.
create or replace function public.notification_wanted(target_profile uuid, category text, channel text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when channel = 'email' and category = 'comment' then
      coalesce((select p.email_comments from public.profiles p where p.id = target_profile), true)
    when channel = 'email' then
      coalesce(
        (select s.email from public.notification_settings s where s.profile_id = target_profile and s.kind = category),
        case
          when category = 'mention' then
            coalesce((select p.email_comments from public.profiles p where p.id = target_profile), true)
          else false
        end
      )
    else
      coalesce(
        (select s.inbox from public.notification_settings s where s.profile_id = target_profile and s.kind = category),
        true
      )
  end;
$$;

revoke all on function public.notification_wanted(uuid, text, text) from public, anon, authenticated;

-- Settings → Notifications: one switch for one kind. The comment email switch is
-- profiles.email_comments (the person's own row, profiles_update_own). Invoker: RLS keeps it to the
-- caller's own rows.
create or replace function public.set_notification_setting(category text, channel text, enabled boolean)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_allowlisted() then
    raise exception 'Sign in again to change your notifications' using errcode = 'insufficient_privilege';
  end if;
  if category is null or category not in (
    'assigned', 'mention', 'comment', 'completed', 'approval', 'message', 'status_update', 'field_change', 'rule'
  ) then
    raise exception 'Unknown notification kind' using errcode = 'check_violation';
  end if;
  if enabled is null then
    raise exception 'Choose on or off' using errcode = 'check_violation';
  end if;
  if channel = 'email' and category = 'comment' then
    update public.profiles set email_comments = enabled where id = auth.uid();
  elsif channel = 'email' then
    insert into public.notification_settings (profile_id, kind, email)
    values (auth.uid(), category, enabled)
    on conflict (profile_id, kind) do update set email = excluded.email;
  elsif channel = 'inbox' then
    insert into public.notification_settings (profile_id, kind, inbox)
    values (auth.uid(), category, enabled)
    on conflict (profile_id, kind) do update set inbox = excluded.inbox;
  else
    raise exception 'Unknown channel' using errcode = 'check_violation';
  end if;
end;
$$;

revoke all on function public.set_notification_setting(text, text, boolean) from public, anon;
grant execute on function public.set_notification_setting(text, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Notification emails (every kind but task comments, which have their own email)
-- ---------------------------------------------------------------------------

-- One outbox row for an inbox notification the recipient wants by email: the wording's parts (who,
-- what, where), the link path, and the target ids the send-time check re-reads. task_id stays null, so
-- task readers never see it in the outbox; the release still on main never claims it. Internal.
create or replace function public.queue_notification_email(item public.inbox_items)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  category text := public.notification_category(item.kind, item.data);
  person public.profiles;
  actor_name text;
  item_title text;
  context text;
  detail text;
  link text;
  target_project uuid;
  t public.tasks;
  pm public.project_messages;
  tm public.team_messages;
  su public.project_status_updates;
begin
  -- Task comments (and the @mentions in them) are emailed by on_comment_email, with reply by email.
  if item.kind = 'comment' or (item.kind = 'mention' and item.comment_id is not null) then
    return;
  end if;
  if not public.notification_wanted(item.recipient_id, category, 'email') then
    return;
  end if;
  select * into person from public.profiles p where p.id = item.recipient_id;
  if not found or not public.is_email(lower(person.email)) or not public.profile_is_allowlisted(person.id) then
    return;
  end if;

  actor_name := coalesce(
    (select coalesce(nullif(trim(p.full_name), ''), p.email) from public.profiles p where p.id = item.actor_id),
    case when nullif(item.data ->> 'rule_name', '') is not null then 'Rule “' || (item.data ->> 'rule_name') || '”' end,
    'Someone'
  );

  if item.task_id is not null then
    select * into t from public.tasks x where x.id = item.task_id;
    if not found or t.deleted_at is not null then
      return;
    end if;
    item_title := t.title;
    target_project := public.comment_email_project(person.id, t.id);
    context := (select pr.name from public.projects pr where pr.id = target_project);
    link := case
      when target_project is null then '/my-tasks?task=' || t.id
      else '/projects/' || target_project || '?task=' || t.id
    end;
    detail := coalesce(item.data ->> 'message', item.data ->> 'note', item.data ->> 'value_text');
  elsif item.message_id is not null then
    select * into pm from public.project_messages x where x.id = item.message_id;
    if not found or pm.deleted_at is not null then
      return;
    end if;
    item_title := (select coalesce(m.title, 'Message') from public.project_messages m where m.id = coalesce(pm.thread_id, pm.id));
    target_project := pm.project_id;
    context := (select pr.name from public.projects pr where pr.id = pm.project_id);
    link := '/projects/' || pm.project_id || '/messages/' || coalesce(pm.thread_id, pm.id) || '#message-' || pm.id;
    detail := pm.body;
  elsif item.team_message_id is not null then
    select * into tm from public.team_messages x where x.id = item.team_message_id;
    if not found or tm.deleted_at is not null then
      return;
    end if;
    item_title := (select coalesce(m.title, 'Message') from public.team_messages m where m.id = coalesce(tm.thread_id, tm.id));
    context := (select te.name from public.teams te where te.id = tm.team_id);
    link := '/teams/' || tm.team_id || '/messages/' || coalesce(tm.thread_id, tm.id) || '#message-' || tm.id;
    detail := tm.body;
  elsif item.status_update_id is not null then
    select * into su from public.project_status_updates x where x.id = item.status_update_id;
    if not found then
      return;
    end if;
    target_project := su.project_id;
    item_title := (select pr.name from public.projects pr where pr.id = su.project_id);
    context := su.title;
    link := '/projects/' || su.project_id || '/overview';
    detail := su.note;
  else
    return;
  end if;

  insert into public.email_outbox (task_id, to_email, template, subject, payload, to_profile_id)
  values (
    null,
    lower(person.email),
    'custom',
    null,
    jsonb_strip_nulls(jsonb_build_object(
      'kind', 'notification',
      'category', category,
      'item_kind', item.kind,
      'inbox_item_id', item.id,
      'actor_name', actor_name,
      'title', left(item_title, 500),
      'context', left(context, 500),
      'detail', left(detail, 2000),
      'path', link,
      'task_id', item.task_id,
      'project_id', target_project,
      'message_id', item.message_id,
      'team_message_id', item.team_message_id,
      'status_update_id', item.status_update_id,
      'data', item.data
    )),
    person.id
  );
end;
$$;

revoke all on function public.queue_notification_email(public.inbox_items) from public, anon, authenticated;

-- BEFORE INSERT on inbox_items: the email first (it doesn't depend on keeping the Inbox copy), then the
-- Inbox copy is kept only if the recipient wants that kind in the Inbox.
create or replace function public.apply_notification_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.queue_notification_email(new);
  if not public.notification_wanted(new.recipient_id, public.notification_category(new.kind, new.data), 'inbox') then
    return null;
  end if;
  return new;
end;
$$;

revoke all on function public.apply_notification_settings() from public, anon, authenticated;

create trigger inbox_items_05_preferences
  before insert on public.inbox_items
  for each row execute function public.apply_notification_settings();

-- Why a queued notification email must not go out now (null = send it). Internal.
create or replace function public.notification_email_block_reason(target_email uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when o.to_profile_id is null or p.id is null then 'Not sent: no recipient'
    when o.created_at < now() - interval '24 hours' then 'Not sent: more than a day late'
    when not public.profile_is_allowlisted(p.id) then 'Not sent: the recipient no longer has access to ALHC Projects'
    when lower(p.email) is distinct from o.to_email then 'Not sent: the recipient''s email address changed'
    when not public.notification_wanted(p.id, o.payload ->> 'category', 'email')
      then 'Not sent: the recipient turned off these emails'
    when exists (
      select 1 from public.inbox_items i
      where i.id::text = o.payload ->> 'inbox_item_id' and i.read_at is not null
    ) then 'Not sent: already read in the Inbox'
    when o.payload ? 'task_id' and not exists (
      select 1 from public.tasks t
      where t.id::text = o.payload ->> 'task_id' and t.deleted_at is null
        and public.profile_task_role(p.id, t.id) is not null
    ) then 'Not sent: the recipient can no longer open this task'
    when o.payload ? 'message_id' and not exists (
      select 1 from public.project_messages m
      join public.project_messages th on th.id = coalesce(m.thread_id, m.id) and th.deleted_at is null
      where m.id::text = o.payload ->> 'message_id' and m.deleted_at is null
        and public.profile_project_role(p.id, m.project_id) is not null
    ) then 'Not sent: the message was removed or can no longer be opened'
    when o.payload ? 'team_message_id' and not exists (
      select 1 from public.team_messages m
      join public.team_messages th on th.id = coalesce(m.thread_id, m.id) and th.deleted_at is null
      join public.teams te on te.id = m.team_id and te.deleted_at is null
      where m.id::text = o.payload ->> 'team_message_id' and m.deleted_at is null
    ) then 'Not sent: the message was removed'
    when o.payload ? 'status_update_id' and not exists (
      select 1 from public.project_status_updates u
      join public.projects pr on pr.id = u.project_id and pr.deleted_at is null
      where u.id::text = o.payload ->> 'status_update_id'
        and public.profile_project_role(p.id, u.project_id) is not null
    ) then 'Not sent: the recipient can no longer open this project'
  end
  from public.email_outbox o
  left join public.profiles p on p.id = o.to_profile_id
  where o.id = target_email and o.payload ->> 'kind' = 'notification';
$$;

revoke all on function public.notification_email_block_reason(uuid) from public, anon, authenticated;

-- The drains that predate notification emails never claim them (the release still on main can't
-- render them).
select public.alhc_patch_function('public.claim_email_deliveries(integer,uuid)'::regprocedure,
$p$      and c.attempts < c.max_attempts
$p$,
$p$      and c.attempts < c.max_attempts
      and coalesce(c.payload ->> 'kind', '') <> 'notification'
$p$);

select public.alhc_patch_function('public.claim_email_outbox(integer,uuid)'::regprocedure,
$p$      and c.comment_id is null
$p$,
$p$      and c.comment_id is null
      and coalesce(c.payload ->> 'kind', '') <> 'notification'
$p$);

-- This release's drain claims notification emails here (service_role only): due rows, oldest first;
-- a row whose notification_email_block_reason() is set fails with the reason instead.
create or replace function public.claim_notification_emails(max_items integer default 20, only_id uuid default null)
returns setof public.email_outbox
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.email_outbox o
  set status = 'failed', last_error = public.notification_email_block_reason(o.id)
  where o.payload ->> 'kind' = 'notification'
    and o.deleted_at is null
    and (only_id is null or o.id = only_id)
    and o.send_after <= now()
    and (o.status = 'pending' or (o.status = 'sending' and o.updated_at < now() - interval '10 minutes'))
    and public.notification_email_block_reason(o.id) is not null;

  return query
  update public.email_outbox o
  set status = 'sending', attempts = o.attempts + 1
  where o.id in (
    select c.id from public.email_outbox c
    where c.deleted_at is null
      and c.payload ->> 'kind' = 'notification'
      and (only_id is null or c.id = only_id)
      and c.attempts < c.max_attempts
      and c.send_after <= now()
      and (c.status = 'pending' or (c.status = 'sending' and c.updated_at < now() - interval '10 minutes'))
    order by c.created_at
    limit least(greatest(coalesce(max_items, 20), 1), 100)
    for update skip locked
  )
  returning o.*;
end;
$$;

revoke all on function public.claim_notification_emails(integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_notification_emails(integer, uuid) to service_role;

-- Comment emails respect the mention switch too: a follower gets one when they want comment emails, or
-- when the comment @mentions them and they want mention emails (then the subject says so).
select public.alhc_patch_function('public.on_comment_email()'::regprocedure,
$p$    select p.id, lower(p.email) as email
$p$,
$p$    select p.id, lower(p.email) as email,
      exists (
        select 1 from public.comment_mentions cm where cm.comment_id = new.id and cm.profile_id = p.id
      ) as mentioned
$p$,
$p$      and p.email_comments
$p$,
$p$      and (
        p.email_comments
        or (
          exists (select 1 from public.comment_mentions cm where cm.comment_id = new.id and cm.profile_id = p.id)
          and public.notification_wanted(p.id, 'mention', 'email')
        )
      )
$p$,
$p$      left(author_name || ' commented on “' || t.title || '”', 300),
$p$,
$p$      left(author_name || case when r.mentioned then ' mentioned you on “' else ' commented on “' end || t.title || '”', 300),
$p$,
$p$        'request_label', public.task_request_label(new.task_id)
$p$,
$p$        'request_label', public.task_request_label(new.task_id),
        'mentioned', r.mentioned
$p$);

select public.alhc_patch_function('public.comment_email_block_reason(uuid)'::regprocedure,
$p$    when not p.email_comments then 'Not sent: the recipient turned off comment emails'
$p$,
$p$    when not (
      p.email_comments
      or (
        exists (select 1 from public.comment_mentions cm where cm.comment_id = o.comment_id and cm.profile_id = p.id)
        and public.notification_wanted(p.id, 'mention', 'email')
      )
    ) then 'Not sent: the recipient turned off comment emails'
$p$);

-- ---------------------------------------------------------------------------
-- Real last activity
-- ---------------------------------------------------------------------------

create index if not exists task_stories_actor_created_idx on public.task_stories (actor_id, created_at desc);
create index if not exists comments_author_created_idx on public.comments (author_id, created_at desc);

-- The last time a person did something that shows up in an activity feed (null = never). A task story
-- they caused, except those written in the transaction that created a task through an inbound webhook
-- (that runs in the endpoint creator's name; they didn't do it); a comment; a project or team message; a
-- project or goal status update; a project story; creating a project (the Overview's activity shows it).
-- Internal (it reads across every project).
create or replace function public.profile_last_active_at(target_profile uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(
    (
      select s.created_at
      from public.task_stories s
      join public.tasks t on t.id = s.task_id
      where s.actor_id = target_profile
        and not (t.source = 'inbound' and s.created_at = t.created_at)
      order by s.created_at desc
      limit 1
    ),
    (select max(c.created_at) from public.comments c where c.author_id = target_profile),
    (select max(m.created_at) from public.project_messages m where m.author_id = target_profile),
    (select max(m.created_at) from public.team_messages m where m.author_id = target_profile),
    (select max(u.created_at) from public.project_status_updates u where u.author_id = target_profile),
    (select max(g.created_at) from public.goal_status_updates g where g.author_id = target_profile),
    (select max(ps.created_at) from public.project_stories ps where ps.actor_id = target_profile),
    (select max(pr.created_at) from public.projects pr where pr.created_by = target_profile)
  );
$$;

revoke all on function public.profile_last_active_at(uuid) from public, anon, authenticated;

-- Admin console → Users and the profile page: each allowlisted address with a profile, its last sign-in
-- and its last activity (timestamps only — never what or where). Workspace admins get everyone (or the
-- one asked for); anyone else only their own row.
create or replace function public.list_member_last_activity(target_profile uuid default null)
returns table (profile_id uuid, email text, last_sign_in_at timestamptz, last_active_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, a.email, u.last_sign_in_at, public.profile_last_active_at(p.id)
  from public.allowed_emails a
  join public.profiles p on lower(p.email) = a.email
  left join auth.users u on u.id = p.id
  where public.is_allowlisted()
    and (target_profile is null or p.id = target_profile)
    and (public.is_workspace_admin() or p.id = auth.uid())
  order by a.email;
$$;

revoke all on function public.list_member_last_activity(uuid) from public, anon;
grant execute on function public.list_member_last_activity(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime, anon, and the probe
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.team_messages, public.team_message_reactions, public.team_message_followers;
  end if;
end $$;

select public.alhc_revoke_anon_grants(array[
  'team_messages', 'team_message_mentions', 'team_message_reactions', 'team_message_followers', 'notification_settings'
]);
select public.alhc_revoke_anon_execute(array[
  'can_read_team(uuid)', 'can_post_team_message(uuid)', 'guard_team_message()', 'guard_team_message_reaction()',
  'guard_team_message_follower()', 'team_message_mention_ids(uuid,text)', 'follow_team_thread(uuid,uuid)',
  'notify_team_message(uuid,uuid,text,jsonb)', 'on_team_message_insert()', 'on_team_message_update()',
  'notify_status_update(uuid,uuid)', 'on_project_status_update_notify()', 'guard_notification_setting()',
  'notification_category(text,jsonb)', 'notification_wanted(uuid,text,text)',
  'set_notification_setting(text,text,boolean)', 'queue_notification_email(public.inbox_items)',
  'apply_notification_settings()', 'notification_email_block_reason(uuid)',
  'claim_notification_emails(integer,uuid)', 'profile_last_active_at(uuid)', 'list_member_last_activity(uuid)'
]);

-- Last before the tail: the app's probe for this release's database features (Settings → Notifications,
-- team Messages, last activity) reads this table.
grant select on public.notification_settings to authenticated;
grant insert (profile_id, kind, inbox, email) on public.notification_settings to authenticated;
grant update (inbox, email) on public.notification_settings to authenticated;

-- TAIL
-- Applied by hand (the connector refuses these keywords). Retires inbox_items' old kind and target
-- CHECKs, so team message and status update notifications reach the Inbox, then gives the wider ones the
-- old names. Nothing above depends on this section.
alter table public.inbox_items drop constraint inbox_items_target_check;
alter table public.inbox_items rename constraint inbox_items_target_check_v2 to inbox_items_target_check;
alter table public.inbox_items drop constraint inbox_items_kind_check;
alter table public.inbox_items rename constraint inbox_items_kind_check_v2 to inbox_items_kind_check;
