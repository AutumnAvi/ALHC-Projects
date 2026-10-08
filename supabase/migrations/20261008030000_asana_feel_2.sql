-- ALHC Projects — Phase: Asana feel, batch 2: teams, people, workspace settings.
--
--   1. Teams are required. The workspace has a default team (workspaces.default_team_id; the migration
--      reuses an active team called "Autumn Lake" or creates it). Every project belongs to a team
--      (projects.team_id, not null): a project inserted without one lands in the default team, and a
--      person picking a team must be in it (or pick the default team). Deleting a team moves its
--      projects to the default team; the default team itself can't be deleted. New workspace members
--      join the default team once, on their first sign-in (never again after leaving it).
--   2. Pending invites. A workspace admin adds an email on Settings → Workspace → Members
--      (invite_to_workspace): the allowlist row records who invited them and an invite email is queued
--      through the existing outbox (template custom, payload kind "invite"; the drain renders it). An
--      allowlisted person who hasn't signed in yet can now be added to projects, portfolios, and teams:
--      pending_memberships rows that apply_pending_memberships() turns into ordinary memberships on
--      their first confirmed sign-in. Removing an email (remove_workspace_member) sets
--      allowed_emails.removed_at: every allowlist check ignores removed rows, so sign-in stops, while the
--      person's profile, tasks, comments, and memberships stay (re-adding restores access).
--   3. Browse projects. projects.visibility = private (members only, the default and every existing
--      project) | team (members of the project's team can find it and join as Editor).
--      browse_projects(team) lists the caller's own projects plus team-visible projects of teams they
--      are in; join_project(project) adds them. Private projects stay invisible to non-members,
--      workspace admins included: neither function consults is_workspace_admin().
--   4. Workspace settings: name, logo (public bucket workspace-assets, admin uploads), default team, and
--      the email sender name, written by workspace admins through RLS (column grants).
--
-- Five new client SECURITY DEFINER functions, pinned in suite 60: invite_to_workspace,
-- resend_workspace_invite, remove_workspace_member (workspace admins), browse_projects, join_project.
-- Everything else is invoker or internal (revoked). fire_rules, notify_with, notify_message, and
-- add_story are untouched. Additive: the release still on main keeps working once this is applied
-- (new columns have defaults; projects inserted without a team land in the default team).
-- No statement here needs a row- or object-removal keyword, so there is no tail section.

-- ---------------------------------------------------------------------------
-- Patch helper (kept on the hosted project; see AGENTS.md → Conventions)
-- ---------------------------------------------------------------------------

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
-- Allowlist: who invited whom, and removal that keeps the person's work
-- ---------------------------------------------------------------------------

alter table public.allowed_emails
  add column invited_by uuid references public.profiles (id),
  add column invited_at timestamptz,
  add column removed_at timestamptz,
  add column removed_by uuid references public.profiles (id);

create index allowed_emails_invited_by_idx on public.allowed_emails (invited_by);
create index allowed_emails_removed_by_idx on public.allowed_emails (removed_by);

comment on column public.allowed_emails.removed_at is
  'Set when a workspace admin removes the email: sign-in stops (every allowlist check ignores the row), '
  'but the person''s profile, work, and memberships stay. Re-adding clears it.';

-- Every allowlist check ignores removed rows.
select public.alhc_patch_function('public.is_allowlisted()'::regprocedure,
$p$a.email = lower(u.email)$p$, $p$a.email = lower(u.email) and a.removed_at is null$p$);
select public.alhc_patch_function('public.sync_profile_for_user(uuid)'::regprocedure,
$p$a.email = lower(u.email)$p$, $p$a.email = lower(u.email) and a.removed_at is null$p$);
select public.alhc_patch_function('public.profile_is_allowlisted(uuid)'::regprocedure,
$p$a.email = lower(u.email)$p$, $p$a.email = lower(u.email) and a.removed_at is null$p$);
select public.alhc_patch_function('public.profile_in_workspace(uuid)'::regprocedure,
$p$a.email = lower(p.email)$p$, $p$a.email = lower(p.email) and a.removed_at is null$p$);

-- When the person first signed in with a confirmed, allowlisted account (set by
-- apply_pending_memberships; backfilled for everyone already in). Members shows "Invited" until then.
alter table public.profiles add column joined_at timestamptz;

update public.profiles p set joined_at = p.created_at where public.profile_is_allowlisted(p.id) and p.joined_at is null;

-- ---------------------------------------------------------------------------
-- Workspace settings and project teams (columns)
-- ---------------------------------------------------------------------------

alter table public.workspaces
  add column default_team_id uuid references public.teams (id),
  add column logo_path text check (logo_path is null or char_length(logo_path) between 1 and 300),
  add column email_sender_name text
    check (email_sender_name is null or (char_length(email_sender_name) between 1 and 60 and email_sender_name !~ '[<>"\\\r\n,;]'));

create index workspaces_default_team_idx on public.workspaces (default_team_id);

comment on column public.workspaces.logo_path is
  'Object path of the logo in the public workspace-assets bucket (<workspace id>/<file>), or null.';
comment on column public.workspaces.email_sender_name is
  'Display name on outgoing email (From: "<name>" <EMAIL_FROM address>); null = EMAIL_FROM as configured.';

alter table public.projects
  add column team_id uuid references public.teams (id),
  add column visibility text not null default 'private'
    constraint projects_visibility_check check (visibility in ('private', 'team'));

create index projects_team_idx on public.projects (team_id) where deleted_at is null;

comment on column public.projects.visibility is
  'private: only members can find or open it. team: members of the project''s team can find it on Browse '
  'projects and join it (as Editors). Never consulted by any read policy: access still comes only from '
  'project_members.';

-- ---------------------------------------------------------------------------
-- Pending memberships (people on the allowlist who haven't signed in yet)
-- ---------------------------------------------------------------------------

create table public.pending_memberships (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  email text not null check (email = lower(btrim(email)) and position('@' in email) > 1),
  project_id uuid references public.projects (id),
  portfolio_id uuid references public.portfolios (id),
  team_id uuid references public.teams (id),
  role text not null,
  created_by uuid default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  applied_at timestamptz,
  applied_profile_id uuid references public.profiles (id),
  deleted_at timestamptz,
  constraint pending_memberships_one_target check (num_nonnulls(project_id, portfolio_id, team_id) = 1),
  constraint pending_memberships_role_check check (
    (project_id is null or role in ('admin', 'editor', 'commenter', 'viewer'))
    and (portfolio_id is null or role in ('admin', 'editor', 'viewer'))
    and (team_id is null or role in ('lead', 'member'))
  )
);

create unique index pending_memberships_project_idx on public.pending_memberships (project_id, email)
  where project_id is not null and applied_at is null and deleted_at is null;
create unique index pending_memberships_portfolio_idx on public.pending_memberships (portfolio_id, email)
  where portfolio_id is not null and applied_at is null and deleted_at is null;
create unique index pending_memberships_team_idx on public.pending_memberships (team_id, email)
  where team_id is not null and applied_at is null and deleted_at is null;
create index pending_memberships_email_idx on public.pending_memberships (email)
  where applied_at is null and deleted_at is null;
create index pending_memberships_workspace_idx on public.pending_memberships (workspace_id);
create index pending_memberships_created_by_idx on public.pending_memberships (created_by);
create index pending_memberships_applied_profile_idx on public.pending_memberships (applied_profile_id);

create trigger pending_memberships_set_updated_at
  before update on public.pending_memberships
  for each row execute function public.set_updated_at();

comment on table public.pending_memberships is
  'Project / portfolio / team memberships for allowlisted people who haven''t signed in yet. Turned into '
  'ordinary memberships by apply_pending_memberships() on their first confirmed sign-in. Cancelled by '
  'setting deleted_at. Readable with the target (project / portfolio Viewer+, teams: everyone allowlisted).';

-- Runs as the caller. Clients only insert team rows (add_team_member, through RLS) and only change the
-- role or cancel; applied and cancelled rows are final.
create or replace function public.guard_pending_membership()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.email := lower(btrim(new.email));
    if public.is_client_role() then
      new.created_by := auth.uid();
      new.created_at := now();
      new.applied_at := null;
      new.applied_profile_id := null;
      new.deleted_at := null;
      if new.team_id is not null then
        select t.workspace_id into new.workspace_id from public.teams t where t.id = new.team_id;
      end if;
      if not exists (select 1 from public.allowed_emails a where a.email = new.email and a.removed_at is null) then
        raise exception '% isn''t in this workspace yet', new.email using errcode = 'check_violation';
      end if;
    end if;
    return new;
  end if;
  if new.email <> old.email
     or new.workspace_id <> old.workspace_id
     or new.project_id is distinct from old.project_id
     or new.portfolio_id is distinct from old.portfolio_id
     or new.team_id is distinct from old.team_id
     or new.created_by is distinct from old.created_by
     or new.created_at <> old.created_at then
    raise exception 'Pending invites can''t be moved' using errcode = 'insufficient_privilege';
  end if;
  if public.is_client_role() then
    if old.applied_at is not null or old.deleted_at is not null then
      raise exception 'This invite was already used or cancelled' using errcode = 'check_violation';
    end if;
    if new.applied_at is distinct from old.applied_at or new.applied_profile_id is distinct from old.applied_profile_id then
      raise exception 'Invites apply on first sign-in' using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_pending_membership() from public, anon;
grant execute on function public.guard_pending_membership() to authenticated;

create trigger pending_memberships_05_guard
  before insert or update on public.pending_memberships
  for each row execute function public.guard_pending_membership();

alter table public.pending_memberships enable row level security;

create policy pending_memberships_select_viewer on public.pending_memberships
  for select to authenticated
  using (
    (project_id is not null and (select public.has_project_role(project_id, 'viewer')))
    or (portfolio_id is not null and (select public.has_portfolio_role(portfolio_id, 'viewer')))
    or (team_id is not null and (select public.is_allowlisted()))
  );
-- Clients add only team invites (add_team_member is invoker); project and portfolio invites are written
-- by add_project_member / add_portfolio_member, which check Admin+ themselves.
create policy pending_memberships_insert_team_manager on public.pending_memberships
  for insert to authenticated
  with check (team_id is not null and (select public.can_manage_team(team_id)));
create policy pending_memberships_update_admin on public.pending_memberships
  for update to authenticated
  using (
    (project_id is not null and (select public.has_project_role(project_id, 'admin')))
    or (portfolio_id is not null and (select public.has_portfolio_role(portfolio_id, 'admin')))
    or (team_id is not null and (select public.can_manage_team(team_id)))
  )
  with check (
    (project_id is not null and (select public.has_project_role(project_id, 'admin')))
    or (portfolio_id is not null and (select public.has_portfolio_role(portfolio_id, 'admin')))
    or (team_id is not null and (select public.can_manage_team(team_id)))
  );

revoke all on public.pending_memberships from anon, authenticated;
grant select on public.pending_memberships to authenticated;
grant insert (workspace_id, email, team_id, role) on public.pending_memberships to authenticated;
grant update (role, deleted_at) on public.pending_memberships to authenticated;

-- Internal: adds (or re-roles) a pending project / portfolio invite. Called by the definer invite RPCs
-- after their own Admin+ checks.
create or replace function public.queue_pending_membership(address text, target_kind text, target uuid, member_role text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  ws uuid;
  row_id uuid;
begin
  if target_kind = 'project' then
    select p.workspace_id into ws from public.projects p where p.id = target and p.deleted_at is null;
    update public.pending_memberships m set role = member_role
    where m.project_id = target and m.email = address and m.applied_at is null and m.deleted_at is null
    returning m.id into row_id;
  elsif target_kind = 'portfolio' then
    select p.workspace_id into ws from public.portfolios p where p.id = target and p.deleted_at is null;
    update public.pending_memberships m set role = member_role
    where m.portfolio_id = target and m.email = address and m.applied_at is null and m.deleted_at is null
    returning m.id into row_id;
  else
    raise exception 'Unknown invite target' using errcode = 'check_violation';
  end if;
  if ws is null then
    raise exception 'Not found' using errcode = 'no_data_found';
  end if;
  if row_id is null then
    insert into public.pending_memberships (workspace_id, email, project_id, portfolio_id, role, created_by)
    values (
      ws, address,
      case when target_kind = 'project' then target end,
      case when target_kind = 'portfolio' then target end,
      member_role, auth.uid()
    )
    returning id into row_id;
  end if;
  return row_id;
end;
$$;

revoke all on function public.queue_pending_membership(text, text, uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The default team
-- ---------------------------------------------------------------------------

-- Internal: the workspace's default team, creating "Autumn Lake" when there is none (an active team of
-- that name is reused). Workspace admins become its leads; every allowlisted person joins it.
create or replace function public.ensure_default_team(target_workspace uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  team uuid;
  first_admin uuid;
begin
  select w.default_team_id into team
  from public.workspaces w
  join public.teams t on t.id = w.default_team_id and t.deleted_at is null
  where w.id = target_workspace;
  if team is not null then
    return team;
  end if;

  select t.id into team from public.teams t
  where t.workspace_id = target_workspace and t.deleted_at is null and lower(btrim(t.name)) = 'autumn lake'
  order by t.created_at, t.id
  limit 1;
  if team is null then
    select a.profile_id into first_admin
    from public.workspace_admins a
    where a.workspace_id = target_workspace and a.deleted_at is null and public.profile_is_allowlisted(a.profile_id)
    order by a.created_at, a.id
    limit 1;
    insert into public.teams (workspace_id, name, description, created_by)
    values (target_workspace, 'Autumn Lake', 'Everyone in the workspace. New members join this team automatically.', first_admin)
    returning id into team;
  end if;

  update public.workspaces set default_team_id = team where id = target_workspace;

  insert into public.team_members (team_id, profile_id, role)
  select team, a.profile_id, 'lead'
  from public.workspace_admins a
  where a.workspace_id = target_workspace and a.deleted_at is null and public.profile_is_allowlisted(a.profile_id)
    and not exists (
      select 1 from public.team_members m where m.team_id = team and m.profile_id = a.profile_id and m.deleted_at is null
    );
  insert into public.team_members (team_id, profile_id, role)
  select team, p.id, 'member'
  from public.profiles p
  where public.profile_is_allowlisted(p.id)
    and not exists (
      select 1 from public.team_members m where m.team_id = team and m.profile_id = p.id and m.deleted_at is null
    );
  return team;
end;
$$;

revoke all on function public.ensure_default_team(uuid) from public, anon, authenticated;

select public.ensure_default_team(w.id) from public.workspaces w;

-- A workspace created later gets its default team right away (definer trigger, revoked).
create or replace function public.on_workspace_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.ensure_default_team(new.id);
  return new;
end;
$$;

revoke all on function public.on_workspace_created() from public, anon, authenticated;

create trigger workspaces_after_insert_default_team
  after insert on public.workspaces
  for each row execute function public.on_workspace_created();

-- Every project belongs to a team; existing ones join their workspace's default team.
update public.projects p
set team_id = w.default_team_id
from public.workspaces w
where w.id = p.workspace_id and p.team_id is null and w.default_team_id is not null;

-- Runs as the caller. A project without a team lands in its workspace's default team. A person who
-- picks or changes the team must be in it (the default team is open to everyone); the team must be
-- active and in the project's workspace.
create or replace function public.guard_project_team()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.team_id is null then
    select w.default_team_id into new.team_id from public.workspaces w where w.id = new.workspace_id;
    return new;
  end if;
  if tg_op = 'UPDATE' and new.team_id = old.team_id then
    return new;
  end if;
  if not exists (
    select 1 from public.teams t
    where t.id = new.team_id and t.workspace_id = new.workspace_id and t.deleted_at is null
  ) then
    raise exception 'Choose an active team of this workspace' using errcode = 'check_violation';
  end if;
  if public.is_client_role()
     and not exists (select 1 from public.workspaces w where w.id = new.workspace_id and w.default_team_id = new.team_id)
     and not exists (
       select 1 from public.team_members m
       where m.team_id = new.team_id and m.profile_id = auth.uid() and m.deleted_at is null
     ) then
    raise exception 'You can only put a project in a team you''re in' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_project_team() from public, anon;
grant execute on function public.guard_project_team() to authenticated;

create trigger projects_08_team
  before insert or update of team_id on public.projects
  for each row execute function public.guard_project_team();

alter table public.projects alter column team_id set not null;

-- Runs as the caller: the default team can't be removed.
create or replace function public.guard_default_team()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.deleted_at is null and new.deleted_at is not null
     and exists (select 1 from public.workspaces w where w.default_team_id = old.id) then
    raise exception 'The default team can''t be removed'
      using errcode = 'check_violation',
            hint = 'Make another team the default in Settings → Workspace first.';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_default_team() from public, anon;
grant execute on function public.guard_default_team() to authenticated;

create trigger teams_06_default_team
  before update of deleted_at on public.teams
  for each row execute function public.guard_default_team();

-- A removed team's projects move to the default team (definer: its managers may not read them all) and
-- become private, so a project that was public to a small team never opens up to the whole workspace.
create or replace function public.on_team_removed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    update public.projects p
    set team_id = w.default_team_id, visibility = 'private'
    from public.workspaces w
    where p.team_id = new.id and w.id = p.workspace_id and w.default_team_id is not null
      and w.default_team_id <> new.id;
  end if;
  return new;
end;
$$;

revoke all on function public.on_team_removed() from public, anon, authenticated;

create trigger teams_after_removed
  after update of deleted_at on public.teams
  for each row execute function public.on_team_removed();

-- ---------------------------------------------------------------------------
-- First sign-in: default team + pending memberships
-- ---------------------------------------------------------------------------

-- Internal. For an allowlisted, confirmed person: joins the default team once (never again after they
-- left it), then turns their pending invites into ordinary memberships (people already in keep their
-- role). Runs inside sign-up / confirmation, so one bad row never blocks a sign-in.
create or replace function public.apply_pending_memberships(target_profile uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  address text;
  default_team uuid;
  r public.pending_memberships;
  applied integer := 0;
begin
  if target_profile is null or not public.profile_is_allowlisted(target_profile) then
    return 0;
  end if;
  select lower(p.email) into address from public.profiles p where p.id = target_profile;
  if address is null then
    return 0;
  end if;
  update public.profiles set joined_at = now() where id = target_profile and joined_at is null;

  begin
    select w.default_team_id into default_team
    from public.workspaces w
    join public.teams t on t.id = w.default_team_id and t.deleted_at is null
    where w.id = public.default_workspace_id();
    if default_team is not null
       and not exists (select 1 from public.team_members m where m.team_id = default_team and m.profile_id = target_profile) then
      insert into public.team_members (team_id, profile_id, role) values (default_team, target_profile, 'member');
    end if;
  exception when others then
    raise warning 'apply_pending_memberships: default team skipped (%)', sqlstate;
  end;

  for r in
    select * from public.pending_memberships pm
    where pm.email = address and pm.applied_at is null and pm.deleted_at is null
    order by pm.created_at, pm.id
  loop
    begin
      if r.project_id is not null then
        if exists (select 1 from public.projects p where p.id = r.project_id and p.deleted_at is null)
           and not exists (
             select 1 from public.project_members m
             where m.project_id = r.project_id and m.profile_id = target_profile and m.deleted_at is null
           ) then
          insert into public.project_members (project_id, profile_id, role, created_by)
          values (r.project_id, target_profile, r.role, r.created_by);
        end if;
      elsif r.portfolio_id is not null then
        if exists (select 1 from public.portfolios p where p.id = r.portfolio_id and p.deleted_at is null)
           and not exists (
             select 1 from public.portfolio_members m
             where m.portfolio_id = r.portfolio_id and m.profile_id = target_profile and m.deleted_at is null
           ) then
          insert into public.portfolio_members (portfolio_id, profile_id, role, created_by)
          values (r.portfolio_id, target_profile, r.role, r.created_by);
        end if;
      elsif r.team_id is not null then
        if exists (select 1 from public.teams t where t.id = r.team_id and t.deleted_at is null) then
          if exists (
            select 1 from public.team_members m
            where m.team_id = r.team_id and m.profile_id = target_profile and m.deleted_at is null
          ) then
            update public.team_members set role = 'lead'
            where team_id = r.team_id and profile_id = target_profile and deleted_at is null and r.role = 'lead';
          else
            insert into public.team_members (team_id, profile_id, role, created_by)
            values (r.team_id, target_profile, r.role, r.created_by);
          end if;
        end if;
      end if;
      update public.pending_memberships
      set applied_at = now(), applied_profile_id = target_profile
      where id = r.id;
      applied := applied + 1;
    exception when others then
      raise warning 'apply_pending_memberships: invite % skipped (%)', r.id, sqlstate;
    end;
  end loop;
  return applied;
end;
$$;

revoke all on function public.apply_pending_memberships(uuid) from public, anon, authenticated;

-- Sign-up, metadata changes, and (below) email confirmation all run the same path.
select public.alhc_patch_function('public.handle_auth_user_change()'::regprocedure,
$p$  perform public.sync_profile_for_user(new.id);
$p$,
$p$  perform public.sync_profile_for_user(new.id);
  perform public.apply_pending_memberships(new.id);
$p$);

create trigger on_auth_user_confirmed
  after update of email_confirmed_at on auth.users
  for each row
  when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function public.handle_auth_user_change();

-- An email added (or added back) for someone who already has an account.
select public.alhc_patch_function('public.handle_allowed_email_insert()'::regprocedure,
$p$    perform public.sync_profile_for_user(matched_user_id);
$p$,
$p$    perform public.sync_profile_for_user(matched_user_id);
    perform public.apply_pending_memberships(matched_user_id);
$p$);

create trigger on_allowed_email_restored
  after update of removed_at on public.allowed_emails
  for each row
  when (old.removed_at is not null and new.removed_at is null)
  execute function public.handle_allowed_email_insert();

-- Everyone already in the workspace has had their first sign-in: nothing pending yet, but the default
-- team join above already covered them.

-- ---------------------------------------------------------------------------
-- Invites to projects, portfolios, teams, and the admin role
-- ---------------------------------------------------------------------------

do $do$
declare
  old_check text := $p$  if not exists (select 1 from public.allowed_emails a where a.email = address) then
    raise exception '% is not on the workspace allowlist', coalesce(nullif(address, ''), 'That address')
      using errcode = 'check_violation',
            hint = 'Workspace access is managed in SQL (allowed_emails). Ask whoever manages it to add them first.';
  end if;$p$;
  new_check text := $p$  if not exists (select 1 from public.allowed_emails a where a.email = address and a.removed_at is null) then
    raise exception '% isn''t in this workspace yet', coalesce(nullif(address, ''), 'That address')
      using errcode = 'check_violation',
            hint = 'Ask a workspace admin to invite them on Settings → Workspace → Members.';
  end if;$p$;
  old_pending text := $p$  if target is null then
    raise exception '% is allowlisted but has not signed in yet', address
      using errcode = 'check_violation',
            hint = 'They can be added after their first sign-in.';
  end if;$p$;
begin
  perform public.alhc_patch_function('public.add_project_member(uuid,text,text)'::regprocedure,
    old_check, new_check,
    old_pending, $p$  if target is null then
    if member_role = 'owner' then
      raise exception '% can be made an owner after their first sign-in', address using errcode = 'check_violation';
    end if;
    -- Not signed in yet: a pending invite that becomes a membership on their first sign-in.
    perform public.queue_pending_membership(address, 'project', target_project, member_role);
    return null;
  end if;$p$);
  perform public.alhc_patch_function('public.add_portfolio_member(uuid,text,text)'::regprocedure,
    old_check, new_check,
    old_pending, $p$  if target is null then
    if member_role = 'owner' then
      raise exception '% can be made an owner after their first sign-in', address using errcode = 'check_violation';
    end if;
    perform public.queue_pending_membership(address, 'portfolio', target_portfolio, member_role);
    return null;
  end if;$p$);
  perform public.alhc_patch_function('public.add_workspace_admin(uuid,text)'::regprocedure,
    old_check, new_check,
    old_pending, $p$  if target is null then
    raise exception '% hasn''t signed in yet', address
      using errcode = 'check_violation',
            hint = 'Make them an admin after their first sign-in.';
  end if;$p$);
end;
$do$;

-- Teams (invoker, RLS decides): someone who hasn't signed in yet gets a pending team invite.
create or replace function public.add_team_member(target_team uuid, member_email text, member_role text default 'member')
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  address text := lower(trim(coalesce(member_email, '')));
  target uuid;
  ws uuid;
begin
  if not public.can_manage_team(target_team) then
    raise exception 'Only team leads and workspace admins can add people' using errcode = 'insufficient_privilege';
  end if;
  select t.workspace_id into ws from public.teams t where t.id = target_team and t.deleted_at is null;
  if ws is null then
    raise exception 'Team not found' using errcode = 'no_data_found';
  end if;
  if member_role is null or member_role not in ('lead', 'member') then
    raise exception 'Choose lead or member' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.allowed_emails a where a.email = address and a.removed_at is null) then
    raise exception '% isn''t in this workspace yet', coalesce(nullif(address, ''), 'That address')
      using errcode = 'check_violation',
            hint = 'Ask a workspace admin to invite them on Settings → Workspace → Members.';
  end if;
  -- joined_at: a confirmed first sign-in (like the definer invites' profile_is_allowlisted check).
  select p.id into target from public.profiles p
  where lower(p.email) = address and p.joined_at is not null and public.profile_in_workspace(p.id);
  if target is null then
    update public.pending_memberships m
    set role = member_role
    where m.team_id = target_team and m.email = address and m.applied_at is null and m.deleted_at is null;
    if not found then
      insert into public.pending_memberships (workspace_id, email, team_id, role)
      values (ws, address, target_team, member_role);
    end if;
    return null;
  end if;
  update public.team_members m
  set role = member_role
  where m.team_id = target_team and m.profile_id = target and m.deleted_at is null and m.role <> member_role;
  if not exists (
    select 1 from public.team_members m
    where m.team_id = target_team and m.profile_id = target and m.deleted_at is null
  ) then
    insert into public.team_members (team_id, profile_id, role) values (target_team, target, member_role);
  end if;
  return target;
end;
$$;

revoke all on function public.add_team_member(uuid, text, text) from public, anon;
grant execute on function public.add_team_member(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Workspace settings (workspace admins, through RLS)
-- ---------------------------------------------------------------------------

-- Runs as the caller: trims the name and sender, keeps the logo inside the workspace's folder, and the
-- default team active and in this workspace.
create or replace function public.guard_workspace_settings()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.name := btrim(new.name);
  new.email_sender_name := nullif(btrim(coalesce(new.email_sender_name, '')), '');
  if new.logo_path is not null and split_part(new.logo_path, '/', 1) <> new.id::text then
    raise exception 'The logo must be uploaded to this workspace' using errcode = 'check_violation';
  end if;
  if new.default_team_id is distinct from old.default_team_id and (
    new.default_team_id is null or not exists (
      select 1 from public.teams t
      where t.id = new.default_team_id and t.workspace_id = new.id and t.deleted_at is null
    )
  ) then
    raise exception 'Choose an active team of this workspace as the default' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_workspace_settings() from public, anon;
grant execute on function public.guard_workspace_settings() to authenticated;

create trigger workspaces_05_guard_settings
  before update on public.workspaces
  for each row execute function public.guard_workspace_settings();

create policy workspaces_update_admin on public.workspaces
  for update to authenticated
  using ((select public.is_workspace_admin(id)))
  with check ((select public.is_workspace_admin(id)));

revoke insert, update, truncate, references, trigger on public.workspaces from authenticated;
grant update (name, logo_path, email_sender_name, default_team_id) on public.workspaces to authenticated;

-- Logos: a public bucket (the sidebar shows the logo to everyone signed in); only workspace admins
-- upload, into their workspace's folder. Images only, 2 MB.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('workspace-assets', 'workspace-assets', true, 2097152, array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

-- The workspace a workspace-assets object belongs to (its first path segment), or null.
create or replace function public.workspace_asset_workspace(object_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when split_part(object_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then split_part(object_name, '/', 1)::uuid
  end;
$$;

revoke all on function public.workspace_asset_workspace(text) from public, anon;
grant execute on function public.workspace_asset_workspace(text) to authenticated;

create policy workspace_assets_objects_insert_admin on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'workspace-assets'
    and (select public.is_workspace_admin(public.workspace_asset_workspace(name)))
  );
create policy workspace_assets_objects_select_allowlisted on storage.objects
  for select to authenticated
  using (bucket_id = 'workspace-assets' and (select public.is_allowlisted()));

-- ---------------------------------------------------------------------------
-- Workspace members: invite, resend, remove (workspace admins)
-- ---------------------------------------------------------------------------

-- Internal: queues the invite email ("You've been invited to ALHC Projects"). The payload names the
-- inviter (never their address) and the workspace; the drain adds the sign-up link.
create or replace function public.queue_workspace_invite_email(address text, ws uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  inviter text;
  ws_name text;
begin
  select nullif(btrim(p.full_name), '') into inviter from public.profiles p where p.id = auth.uid();
  select w.name into ws_name from public.workspaces w where w.id = ws;
  return public.enqueue_email(
    address,
    'custom',
    'You''ve been invited to ALHC Projects',
    jsonb_build_object(
      'kind', 'invite',
      'inviter_name', coalesce(inviter, 'A workspace admin'),
      'workspace_name', coalesce(ws_name, 'ALHC Projects'),
      'message', coalesce(inviter, 'A workspace admin') || ' invited you to ALHC Projects. Sign up with this address to get started.'
    ),
    null
  );
end;
$$;

revoke all on function public.queue_workspace_invite_email(text, uuid) from public, anon, authenticated;

-- Adds an email to the workspace (or adds a removed one back) and emails an invite. Someone already in
-- the workspace is left as is. Returns { email, status: invited | restored | already_member |
-- already_invited, email_id }.
create or replace function public.invite_to_workspace(member_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  ws uuid := public.default_workspace_id();
  address text := lower(btrim(coalesce(member_email, '')));
  existing public.allowed_emails;
  signed_in boolean;
  outcome text;
  email_id uuid;
begin
  if not public.is_workspace_admin(ws) then
    raise exception 'Only workspace admins can invite people to the workspace' using errcode = 'insufficient_privilege';
  end if;
  if not public.is_email(address) then
    raise exception 'Enter a valid email address' using errcode = 'check_violation';
  end if;

  select * into existing from public.allowed_emails a where a.email = address for update;
  -- Has an account that signed in before (joined_at), whether or not the address is removed right now.
  signed_in := exists (select 1 from public.profiles p where lower(p.email) = address and p.joined_at is not null);
  if existing.email is not null and existing.removed_at is null then
    return jsonb_build_object('email', address, 'status', case when signed_in then 'already_member' else 'already_invited' end);
  end if;

  if existing.email is not null then
    update public.allowed_emails
    set removed_at = null, removed_by = null, invited_by = auth.uid(), invited_at = now()
    where email = address;
    outcome := 'restored';
  else
    insert into public.allowed_emails (email, note, invited_by, invited_at)
    values (address, 'Invited on Settings → Workspace → Members', auth.uid(), now());
    outcome := 'invited';
  end if;

  -- Someone added back who already has an account just signs in again: no sign-up email.
  if not signed_in then
    email_id := public.queue_workspace_invite_email(address, ws);
  end if;
  return jsonb_build_object('email', address, 'status', outcome, 'email_id', email_id);
end;
$$;

revoke all on function public.invite_to_workspace(text) from public, anon;
grant execute on function public.invite_to_workspace(text) to authenticated;

-- Sends the invite email again to someone who hasn't signed in yet (at most once every 10 minutes).
create or replace function public.resend_workspace_invite(member_email text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  ws uuid := public.default_workspace_id();
  address text := lower(btrim(coalesce(member_email, '')));
begin
  if not public.is_workspace_admin(ws) then
    raise exception 'Only workspace admins can send invites' using errcode = 'insufficient_privilege';
  end if;
  perform 1 from public.allowed_emails a where a.email = address and a.removed_at is null for update;
  if not found then
    raise exception '% isn''t in this workspace', coalesce(nullif(address, ''), 'That address') using errcode = 'no_data_found';
  end if;
  if exists (select 1 from public.profiles p where lower(p.email) = address and public.profile_is_allowlisted(p.id)) then
    raise exception '% has already signed in', address using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from public.email_outbox o
    where o.to_email = address and o.task_id is null and o.payload ->> 'kind' = 'invite'
      and o.created_at > now() - interval '10 minutes'
  ) then
    raise exception 'An invite was just sent to %', address
      using errcode = 'check_violation', hint = 'Wait a few minutes before sending another.';
  end if;
  return public.queue_workspace_invite_email(address, ws);
end;
$$;

revoke all on function public.resend_workspace_invite(text) from public, anon;
grant execute on function public.resend_workspace_invite(text) to authenticated;

-- Removes an email from the workspace: future sign-ins stop at once (every allowlist check ignores the
-- row), open pending invites are cancelled, and nothing the person made is touched. You can't remove
-- yourself or a workspace admin (remove the admin role first).
create or replace function public.remove_workspace_member(member_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  ws uuid := public.default_workspace_id();
  address text := lower(btrim(coalesce(member_email, '')));
  person uuid;
begin
  if not public.is_workspace_admin(ws) then
    raise exception 'Only workspace admins can remove people from the workspace' using errcode = 'insufficient_privilege';
  end if;
  perform 1 from public.allowed_emails a where a.email = address and a.removed_at is null for update;
  if not found then
    raise exception '% isn''t in this workspace', coalesce(nullif(address, ''), 'That address') using errcode = 'no_data_found';
  end if;
  select p.id into person from public.profiles p where lower(p.email) = address;
  if person is not null and person = auth.uid() then
    raise exception 'You can''t remove yourself from the workspace' using errcode = 'check_violation';
  end if;
  if person is not null and exists (
    select 1 from public.workspace_admins a where a.workspace_id = ws and a.profile_id = person and a.deleted_at is null
  ) then
    raise exception 'Remove their workspace admin role first' using errcode = 'check_violation';
  end if;
  update public.allowed_emails set removed_at = now(), removed_by = auth.uid() where email = address;
  update public.pending_memberships set deleted_at = now()
  where email = address and applied_at is null and deleted_at is null;
end;
$$;

revoke all on function public.remove_workspace_member(text) from public, anon;
grant execute on function public.remove_workspace_member(text) to authenticated;

-- Workspace admins also see the invite emails (no task, so no other path). One permissive policy per
-- command (Review hardening), so the existing policy gains the branch.
alter policy email_outbox_select_viewer on public.email_outbox
  using (
    (task_id is not null and (select public.has_task_role(task_id, 'viewer')))
    or (task_id is null and payload ->> 'kind' = 'invite' and (select public.is_workspace_admin()))
  );

-- Invite emails are checked again when claimed: a withdrawn invite or one more than a week late fails
-- with the reason instead of going out.
create or replace function public.invite_email_block_reason(target_email uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not exists (select 1 from public.allowed_emails a where a.email = o.to_email and a.removed_at is null)
      then 'Not sent: the invite was withdrawn'
    when o.created_at < now() - interval '7 days' then 'Not sent: more than a week late'
  end
  from public.email_outbox o
  where o.id = target_email and o.task_id is null and o.payload ->> 'kind' = 'invite';
$$;

revoke all on function public.invite_email_block_reason(uuid) from public, anon, authenticated;

select public.alhc_patch_function('public.claim_email_deliveries(integer,uuid)'::regprocedure,
$p$    and public.comment_email_block_reason(o.id) is not null;
$p$,
$p$    and public.comment_email_block_reason(o.id) is not null;

  update public.email_outbox o
  set status = 'failed', last_error = public.invite_email_block_reason(o.id)
  where o.task_id is null
    and o.payload ->> 'kind' = 'invite'
    and o.deleted_at is null
    and (only_id is null or o.id = only_id)
    and o.send_after <= now()
    and (o.status = 'pending' or (o.status = 'sending' and o.updated_at < now() - interval '10 minutes'))
    and public.invite_email_block_reason(o.id) is not null;
$p$);

-- ---------------------------------------------------------------------------
-- Browse and join projects
-- ---------------------------------------------------------------------------

-- The caller's own projects plus team-visible projects of teams they are in (optionally one team).
-- Private projects of others never appear, workspace admins included.
create or replace function public.browse_projects(target_team uuid default null)
returns table (
  project_id uuid,
  name text,
  description text,
  team_id uuid,
  team_name text,
  visibility text,
  status text,
  archived boolean,
  member_count integer,
  my_role text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    p.id,
    p.name,
    p.description,
    p.team_id,
    t.name,
    p.visibility,
    p.status,
    p.archived_at is not null,
    (select count(*)::integer from public.project_members m where m.project_id = p.id and m.deleted_at is null),
    public.profile_project_role(auth.uid(), p.id)
  from public.projects p
  join public.teams t on t.id = p.team_id
  where public.is_allowlisted()
    and p.deleted_at is null
    and (target_team is null or p.team_id = target_team)
    and (
      public.profile_project_role(auth.uid(), p.id) is not null
      or (
        p.visibility = 'team'
        and t.deleted_at is null
        and exists (
          select 1 from public.team_members tm
          where tm.team_id = p.team_id and tm.profile_id = auth.uid() and tm.deleted_at is null
        )
      )
    )
  order by lower(t.name), lower(p.name), p.id;
$$;

revoke all on function public.browse_projects(uuid) from public, anon;
grant execute on function public.browse_projects(uuid) to authenticated;

-- Joins a team-visible project of a team the caller is in, as an Editor. Already a member: their role
-- stays. Private, archived, and other teams' projects can't be joined.
create or replace function public.join_project(target_project uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.projects;
  current_role_name text;
begin
  if not public.is_allowlisted() then
    raise exception 'Not signed in' using errcode = 'insufficient_privilege';
  end if;
  select * into p from public.projects x where x.id = target_project and x.deleted_at is null;
  current_role_name := public.profile_project_role(auth.uid(), target_project);
  if current_role_name is not null then
    return current_role_name;
  end if;
  if p.id is null or p.visibility <> 'team' or not exists (
    select 1 from public.team_members tm
    join public.teams t on t.id = tm.team_id and t.deleted_at is null
    where tm.team_id = p.team_id and tm.profile_id = auth.uid() and tm.deleted_at is null
  ) then
    raise exception 'Project not found' using errcode = 'no_data_found';
  end if;
  if p.archived_at is not null then
    raise exception 'Archived projects can''t be joined' using errcode = 'check_violation';
  end if;
  insert into public.project_members (project_id, profile_id, role, created_by)
  values (target_project, auth.uid(), 'editor', auth.uid());
  return 'editor';
end;
$$;

revoke all on function public.join_project(uuid) from public, anon;
grant execute on function public.join_project(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- anon never reaches anything new (Review hardening convention)
-- ---------------------------------------------------------------------------

select public.alhc_revoke_anon_grants(array['pending_memberships']);

select public.alhc_revoke_anon_execute(array[
  'guard_pending_membership()', 'queue_pending_membership(text,text,uuid,text)', 'ensure_default_team(uuid)',
  'on_workspace_created()', 'guard_project_team()', 'guard_default_team()', 'on_team_removed()', 'apply_pending_memberships(uuid)',
  'add_team_member(uuid,text,text)', 'guard_workspace_settings()', 'workspace_asset_workspace(text)',
  'queue_workspace_invite_email(text,uuid)', 'invite_to_workspace(text)', 'resend_workspace_invite(text)',
  'remove_workspace_member(text)', 'invite_email_block_reason(uuid)', 'browse_projects(uuid)',
  'join_project(uuid)'
]);
