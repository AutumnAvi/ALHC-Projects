-- ALHC Projects — Workspace admin and comments.
--
--   * Workspace admins (workspace_admins + is_workspace_admin()): a small workspace-level role for
--     things that belong to no single project. Today that is managing workspace templates and seeing
--     past Asana import runs (of projects the admin can already read) on Settings → Workspace; later
--     workspace-level settings hang off the same page. **It never grants project access**: every
--     project-scoped policy is unchanged, so a workspace admin who isn't a member of a project can't
--     read its name, tasks, comments, or import runs.
--   * can_manage_project_template: Admin+ of the live source project, or a workspace admin. The old
--     "Admin+ of any project" fallback is gone.
--   * Comments: authors edit their own comments (body only; edited_at marks it), delete stays a soft
--     delete shown as a placeholder, and an edit notifies only people newly @mentioned by it.
--   * Comment reactions from a fixed set (comment_reactions; read Viewer+, react Commenter+, own rows).
--   * Inbox archive: inbox_items.archived_at, set and cleared by the recipient (column grant).

-- ---------------------------------------------------------------------------
-- Workspace admins
-- ---------------------------------------------------------------------------

create table public.workspace_admins (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- One active row per (workspace, person); removal is a soft delete kept as history.
create unique index workspace_admins_active_idx on public.workspace_admins (workspace_id, profile_id)
  where deleted_at is null;
create index workspace_admins_profile_idx on public.workspace_admins (profile_id);
create index workspace_admins_created_by_idx on public.workspace_admins (created_by);

create trigger workspace_admins_set_updated_at
  before update on public.workspace_admins
  for each row execute function public.set_updated_at();

-- The workspace the app uses (oldest active), for callers that don't name one.
create or replace function public.default_workspace_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select w.id from public.workspaces w where w.deleted_at is null order by w.created_at, w.id limit 1;
$$;

revoke all on function public.default_workspace_id() from public, anon, authenticated;

create or replace function public.profile_is_workspace_admin(target_profile uuid, target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.profile_is_allowlisted(target_profile) and exists (
    select 1 from public.workspace_admins a
    join public.workspaces w on w.id = a.workspace_id and w.deleted_at is null
    where a.profile_id = target_profile
      and a.workspace_id = coalesce(target_workspace, public.default_workspace_id())
      and a.deleted_at is null
  );
$$;

revoke all on function public.profile_is_workspace_admin(uuid, uuid) from public, anon, authenticated;

-- Is the caller a workspace admin (of the default workspace when none is named)? Never used by any
-- project-scoped policy: being a workspace admin grants no project access.
create or replace function public.is_workspace_admin(target_workspace uuid default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_allowlisted() and public.profile_is_workspace_admin(auth.uid(), target_workspace);
$$;

revoke all on function public.is_workspace_admin(uuid) from public, anon;
grant execute on function public.is_workspace_admin(uuid) to authenticated;

-- Rows can't move; a workspace always keeps one active admin once it has one (the workspace row is
-- locked so two concurrent removals serialise).
create or replace function public.guard_workspace_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.workspace_id <> old.workspace_id or new.profile_id <> old.profile_id then
      raise exception 'Workspace admin rows can''t be moved' using errcode = 'check_violation';
    end if;
    if old.deleted_at is not null and new.deleted_at is null then
      raise exception 'Add the person again instead of restoring a removed admin' using errcode = 'check_violation';
    end if;
    if old.deleted_at is null and new.deleted_at is not null then
      perform 1 from public.workspaces w where w.id = old.workspace_id for update;
      if not exists (
        select 1 from public.workspace_admins a
        where a.workspace_id = old.workspace_id and a.deleted_at is null and a.id <> old.id
      ) then
        raise exception 'A workspace needs at least one admin'
          using errcode = 'check_violation',
                hint = 'Add another workspace admin first.';
      end if;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_workspace_admin() from public, anon, authenticated;

create trigger workspace_admins_guard
  before update on public.workspace_admins
  for each row execute function public.guard_workspace_admin();

-- Bootstrap (not an RPC): makes the person with this sign-in email an admin of the default workspace.
-- Looks the address up in auth.users (with a profile, i.e. allowlisted and signed in); does nothing
-- when there is no such person or they already are an admin. Returns whether a row was added.
create or replace function public.seed_workspace_admin(admin_email text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  ws uuid := public.default_workspace_id();
  target uuid;
begin
  if ws is null then
    return false;
  end if;
  select u.id into target
  from auth.users u
  join public.profiles p on p.id = u.id
  where lower(u.email) = lower(trim(coalesce(admin_email, '')))
  order by u.email_confirmed_at nulls last
  limit 1;
  if target is null then
    return false;
  end if;
  insert into public.workspace_admins (workspace_id, profile_id)
  values (ws, target)
  on conflict (workspace_id, profile_id) where deleted_at is null do nothing;
  return found;
end;
$$;

revoke all on function public.seed_workspace_admin(text) from public, anon, authenticated;

select public.seed_workspace_admin('avweinreb@autumnlakemarketing.com');

-- Invite by allowlisted email (same rules as project invites). Re-adding an active admin is a no-op.
create or replace function public.add_workspace_admin(target_workspace uuid, member_email text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  ws uuid := coalesce(target_workspace, public.default_workspace_id());
  address text := lower(trim(coalesce(member_email, '')));
  target uuid;
begin
  if not public.is_workspace_admin(ws) then
    raise exception 'Only workspace admins can add workspace admins' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.allowed_emails a where a.email = address) then
    raise exception '% is not on the workspace allowlist', coalesce(nullif(address, ''), 'That address')
      using errcode = 'check_violation',
            hint = 'Workspace access is managed in SQL (allowed_emails). Ask whoever manages it to add them first.';
  end if;
  select x.id into target from public.profiles x
  where x.email = address and public.profile_is_allowlisted(x.id);
  if target is null then
    raise exception '% is allowlisted but has not signed in yet', address
      using errcode = 'check_violation',
            hint = 'They can be added after their first sign-in.';
  end if;
  insert into public.workspace_admins (workspace_id, profile_id, created_by)
  values (ws, target, auth.uid())
  on conflict (workspace_id, profile_id) where deleted_at is null do nothing;
  return target;
end;
$$;

revoke all on function public.add_workspace_admin(uuid, text) from public, anon;
grant execute on function public.add_workspace_admin(uuid, text) to authenticated;

-- Soft-removes an admin (themselves included); the guard keeps the last one.
create or replace function public.remove_workspace_admin(target_workspace uuid, target_profile uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  ws uuid := coalesce(target_workspace, public.default_workspace_id());
begin
  if not public.is_workspace_admin(ws) then
    raise exception 'Only workspace admins can remove workspace admins' using errcode = 'insufficient_privilege';
  end if;
  update public.workspace_admins
  set deleted_at = now()
  where workspace_id = ws and profile_id = target_profile and deleted_at is null;
  if not found then
    raise exception 'That person is not a workspace admin' using errcode = 'no_data_found';
  end if;
end;
$$;

revoke all on function public.remove_workspace_admin(uuid, uuid) from public, anon;
grant execute on function public.remove_workspace_admin(uuid, uuid) to authenticated;

alter table public.workspace_admins enable row level security;

-- Workspace-level: everyone allowlisted can see who the admins are (so they know whom to ask).
create policy workspace_admins_select_allowlisted on public.workspace_admins
  for select to authenticated using ((select public.is_allowlisted()));

revoke insert, update, delete, truncate, references, trigger on public.workspace_admins from anon, authenticated;
revoke all on public.workspace_admins from anon;

-- ---------------------------------------------------------------------------
-- Templates: Admin+ of the live source project, or a workspace admin
-- ---------------------------------------------------------------------------

create or replace function public.can_manage_project_template(target_template uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_allowlisted() and exists (
    select 1 from public.project_templates t
    left join public.projects src on src.id = t.source_project_id and src.deleted_at is null
    where t.id = target_template and t.deleted_at is null
      and (
        (src.id is not null and public.has_project_role(src.id, 'admin'))
        or public.is_workspace_admin(t.workspace_id)
      )
  );
$$;

revoke all on function public.can_manage_project_template(uuid) from public, anon;
grant execute on function public.can_manage_project_template(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Import runs: workspace admins see the runs of projects they can read (Viewer+), nothing more.
-- Importing itself stays per project (Admin+).
-- ---------------------------------------------------------------------------

create policy import_runs_select_workspace_admin on public.import_runs
  for select to authenticated
  using (
    (select public.has_project_role(project_id, 'viewer'))
    and exists (
      select 1 from public.projects p
      where p.id = project_id and p.deleted_at is null and (select public.is_workspace_admin(p.workspace_id))
    )
  );

-- ---------------------------------------------------------------------------
-- Comments: edit own (body only), edited_at, mentions added by an edit
-- ---------------------------------------------------------------------------

alter table public.comments add column edited_at timestamptz;

-- Clients (the author, through comments_update_own_commenter) may change the body of an active
-- comment or soft-delete it; nothing else. A body change stamps edited_at. Definer code (rules,
-- importer) is not limited. Runs as the caller so is_client_role() sees the client role.
create or replace function public.guard_comment_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.is_client_role() then
    if old.deleted_at is not null then
      raise exception 'This comment was deleted' using errcode = 'check_violation';
    end if;
    if new.id <> old.id
       or new.task_id <> old.task_id
       or new.author_id is distinct from old.author_id
       or new.rule_id is distinct from old.rule_id
       or new.created_at <> old.created_at
       or new.edited_at is distinct from old.edited_at then
      raise exception 'Only the text of a comment can be edited' using errcode = 'insufficient_privilege';
    end if;
  end if;
  if new.body is distinct from old.body then
    new.edited_at := now();
  end if;
  return new;
end;
$$;

revoke all on function public.guard_comment_update() from public, anon;
grant execute on function public.guard_comment_update() to authenticated;

create trigger comments_05_guard_update
  before update on public.comments
  for each row execute function public.guard_comment_update();

-- Who a comment body @mentions: `@Full Name` or `@emaillocalpart` (case-insensitive, word-bounded) of
-- a profile other than the author who can read the task. Same expression as before, now shared by
-- insert and edit.
create or replace function public.comment_mention_ids(target_task uuid, author uuid, body text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
  from public.profiles p
  where p.id is distinct from author
    and public.profile_task_role(p.id, target_task) is not null
    and (
      (nullif(trim(p.full_name), '') is not null
        and body ~* ('@' || public.regex_escape(trim(p.full_name)) || '([^[:alnum:]_]|$)'))
      or body ~* ('@' || public.regex_escape(split_part(p.email, '@', 1)) || '([^[:alnum:]_]|$)')
    );
$$;

revoke all on function public.comment_mention_ids(uuid, uuid, text) from public, anon, authenticated;

-- Same as the Teams & permissions version, with the mention match moved into comment_mention_ids().
create or replace function public.on_comment_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  perform public.follow_task(new.task_id, new.author_id);

  insert into public.comment_mentions (comment_id, profile_id)
  select new.id, m.id
  from public.comment_mention_ids(new.task_id, new.author_id, new.body) as m (id)
  on conflict do nothing;

  for r in select m.profile_id from public.comment_mentions m where m.comment_id = new.id loop
    perform public.follow_task(new.task_id, r.profile_id);
    perform public.notify(r.profile_id, new.task_id, 'mention', new.id);
  end loop;

  for r in
    select f.profile_id
    from public.task_followers f
    where f.task_id = new.task_id
      and f.deleted_at is null
      and f.profile_id is distinct from new.author_id
      and not exists (
        select 1 from public.comment_mentions m
        where m.comment_id = new.id and m.profile_id = f.profile_id
      )
  loop
    perform public.notify(r.profile_id, new.task_id, 'comment', new.id);
  end loop;

  return new;
end;
$$;

revoke all on function public.on_comment_insert() from public, anon, authenticated;

-- An edit notifies only people it newly @mentions (they follow the task and get a `mention` inbox
-- item). Followers hear nothing, and mentions the edit removed stay recorded (comment_mentions is
-- append-only; those people were already notified).
create or replace function public.on_comment_edit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  for r in
    insert into public.comment_mentions (comment_id, profile_id)
    select new.id, m.id
    from public.comment_mention_ids(new.task_id, new.author_id, new.body) as m (id)
    on conflict do nothing
    returning profile_id
  loop
    perform public.follow_task(new.task_id, r.profile_id);
    perform public.notify(r.profile_id, new.task_id, 'mention', new.id);
  end loop;
  return new;
end;
$$;

revoke all on function public.on_comment_edit() from public, anon, authenticated;

create trigger comments_after_edit
  after update of body on public.comments
  for each row
  when (old.body is distinct from new.body and new.deleted_at is null)
  execute function public.on_comment_edit();

-- ---------------------------------------------------------------------------
-- Comment reactions
-- ---------------------------------------------------------------------------

-- Fixed set, stored as keys (the app maps them to emoji): thumbs_up 👍, heart ❤️, tada 🎉, laugh 😄,
-- eyes 👀, check ✅.
create table public.comment_reactions (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null references public.comments (id),
  -- Copied from the comment on insert, so policies and Realtime filters work per task.
  task_id uuid not null references public.tasks (id),
  profile_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  emoji text not null check (emoji in ('thumbs_up', 'heart', 'tada', 'laugh', 'eyes', 'check')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- One active reaction per (comment, person, emoji); removing soft-deletes, reacting again adds a row.
create unique index comment_reactions_active_idx on public.comment_reactions (comment_id, profile_id, emoji)
  where deleted_at is null;
create index comment_reactions_task_idx on public.comment_reactions (task_id) where deleted_at is null;
create index comment_reactions_profile_idx on public.comment_reactions (profile_id);

create trigger comment_reactions_set_updated_at
  before update on public.comment_reactions
  for each row execute function public.set_updated_at();

-- Runs as the caller. Insert: task_id comes from the comment (which must be active and readable).
-- Update: clients may only remove (soft-delete) a reaction.
create or replace function public.guard_comment_reaction()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    select c.task_id into new.task_id
    from public.comments c
    where c.id = new.comment_id and c.deleted_at is null;
    if new.task_id is null then
      raise exception 'Comment not found' using errcode = 'no_data_found';
    end if;
    return new;
  end if;
  if public.is_client_role() then
    if new.comment_id <> old.comment_id
       or new.task_id <> old.task_id
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

revoke all on function public.guard_comment_reaction() from public, anon;
grant execute on function public.guard_comment_reaction() to authenticated;

create trigger comment_reactions_05_guard
  before insert or update on public.comment_reactions
  for each row execute function public.guard_comment_reaction();

alter table public.comment_reactions enable row level security;

create policy comment_reactions_select_viewer on public.comment_reactions
  for select to authenticated
  using ((select public.has_task_role(task_id, 'viewer')));
create policy comment_reactions_insert_own_commenter on public.comment_reactions
  for insert to authenticated
  with check (
    profile_id = (select auth.uid())
    and (select public.has_task_role(task_id, 'commenter'))
    and exists (
      select 1 from public.comments c
      where c.id = comment_id and c.task_id = comment_reactions.task_id and c.deleted_at is null
    )
  );
create policy comment_reactions_update_own_commenter on public.comment_reactions
  for update to authenticated
  using (profile_id = (select auth.uid()) and (select public.has_task_role(task_id, 'commenter')))
  with check (profile_id = (select auth.uid()) and (select public.has_task_role(task_id, 'commenter')));

revoke all on public.comment_reactions from anon;
revoke update, delete, truncate, references, trigger on public.comment_reactions from authenticated;
grant update (deleted_at) on public.comment_reactions to authenticated;

-- ---------------------------------------------------------------------------
-- Inbox archive
-- ---------------------------------------------------------------------------

alter table public.inbox_items add column archived_at timestamptz;

create index inbox_items_active_idx on public.inbox_items (recipient_id, created_at desc) where archived_at is null;

-- Recipients may set read_at (read / unread) and archived_at (archive / unarchive) on their own rows
-- (inbox_items_update_own_viewer); nothing else.
revoke update on public.inbox_items from anon, authenticated;
grant update (read_at, archived_at) on public.inbox_items to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.comment_reactions;
  end if;
end;
$$;
