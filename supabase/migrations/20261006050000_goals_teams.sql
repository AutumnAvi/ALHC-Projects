-- ALHC Projects — Goals and Teams directory.
--
-- Prefer SECURITY INVOKER: every new function runs as the caller (RLS and the existing triggers apply)
-- except goal_hidden_project_count(), the one SECURITY DEFINER function, which only returns a number
-- (like portfolio_hidden_project_count) and is pinned in suite 60.
--
--   * Teams directory (workspace-level; everyone allowlisted reads it):
--       teams (workspace_id, name, description, created_by, soft delete)
--       team_members (team_id, profile_id, role lead | member, soft delete)
--       team_projects (team_id, project_id, role) — a record of "this team was added to this project",
--         readable only by people who can read the project.
--     Leads and workspace admins manage a team (rename, describe, add/remove people, change roles,
--     delete). The creator becomes its first lead, and a team keeps at least one lead.
--     **A team by itself never grants project access**: no project-scoped policy or helper looks at
--     team_members. The group invite add_team_to_project(target_project, target_team, member_role)
--     (Project Admin+) calls the existing add_project_member() for each team member who isn't already in
--     the project, so access still comes only from ordinary project_members rows. Members already in
--     the project keep their role; later team changes don't touch the project.
--
--   * Goals (Asana style; workspace-level, everyone allowlisted reads them):
--       goals (workspace_id, team_id?, parent_id? (sub-goals), owner_id, title, notes, period_start/end,
--              status on_track | at_risk | off_track | achieved | missed | dropped,
--              progress_mode manual | sub_goals | projects, manual_progress 0–100, soft delete)
--       goal_links (goal_id, project_id | portfolio_id) — readable only when the caller can read the
--         project / portfolio, so a goal never shows the name (or id) of something you can't open.
--       goal_status_updates (goal_id, status, body, author_id) — posting one sets the goal's status.
--     Who edits a goal: its owner, a lead of its team, or a workspace admin (goal_editable()). Being a
--     workspace admin never opens a private project: the progress RPC checks has_project_role() for
--     every project like everyone else. Linking a project needs Viewer+ on it (a portfolio: Viewer+ on
--     the portfolio). Setting a parent needs edit rights on the parent too, and cycles are rejected.
--
--   * Progress: goal_progress(target_workspace) (invoker) per active goal:
--       manual     manual_progress
--       sub_goals  floor(average of the active, non-dropped sub-goals' progress); sub-goals without a
--                  number (no tasks yet) are left out; none ⇒ null
--       projects   floor(100 × completed / total) over the active tasks of the linked projects and of
--                  the linked portfolios' projects that the caller can read, each task counted once
--                  (the portfolio formula); no tasks ⇒ null
--     plus the task counts and goal_hidden_project_count(goal): how many linked projects (directly or
--     through a linked portfolio) the caller can't read and that were therefore left out. Only a count.

-- ---------------------------------------------------------------------------
-- Teams
-- ---------------------------------------------------------------------------

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  name text not null check (char_length(btrim(name)) between 1 and 100),
  description text check (description is null or char_length(description) <= 2000),
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index teams_workspace_idx on public.teams (workspace_id) where deleted_at is null;
create index teams_created_by_idx on public.teams (created_by);

create trigger teams_set_updated_at
  before update on public.teams
  for each row execute function public.set_updated_at();

create table public.team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  role text not null default 'member' check (role in ('lead', 'member')),
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- One active row per (team, person); removal is a soft delete kept as history.
create unique index team_members_active_idx on public.team_members (team_id, profile_id) where deleted_at is null;
create index team_members_profile_idx on public.team_members (profile_id) where deleted_at is null;
create index team_members_created_by_idx on public.team_members (created_by);

create trigger team_members_set_updated_at
  before update on public.team_members
  for each row execute function public.set_updated_at();

-- Is the caller an active lead of an active team? Invoker: team_members and teams are readable by
-- everyone allowlisted, so this never needs elevated rights (and never touches project data).
create or replace function public.is_team_lead(target_team uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.team_members m
    join public.teams t on t.id = m.team_id and t.deleted_at is null
    where m.team_id = target_team
      and m.profile_id = auth.uid()
      and m.role = 'lead'
      and m.deleted_at is null
  );
$$;

revoke all on function public.is_team_lead(uuid) from public, anon;
grant execute on function public.is_team_lead(uuid) to authenticated;

-- Leads and workspace admins manage a team.
create or replace function public.can_manage_team(target_team uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select public.is_allowlisted() and (
    public.is_team_lead(target_team)
    or exists (
      select 1 from public.teams t
      where t.id = target_team and public.is_workspace_admin(t.workspace_id)
    )
  );
$$;

revoke all on function public.can_manage_team(uuid) from public, anon;
grant execute on function public.can_manage_team(uuid) to authenticated;

-- The workspace the app uses (oldest active), readable by the caller. Invoker twin of
-- default_workspace_id() for invoker code.
create or replace function public.oldest_workspace_id()
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select w.id from public.workspaces w where w.deleted_at is null order by w.created_at, w.id limit 1;
$$;

revoke all on function public.oldest_workspace_id() from public, anon;
grant execute on function public.oldest_workspace_id() to authenticated;

-- Is this person someone in the workspace (a profile whose email is on the allowlist)? Invoker:
-- profiles and allowed_emails are readable by everyone allowlisted.
create or replace function public.profile_in_workspace(target_profile uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    join public.allowed_emails a on a.email = lower(p.email)
    where p.id = target_profile
  );
$$;

revoke all on function public.profile_in_workspace(uuid) from public, anon;
grant execute on function public.profile_in_workspace(uuid) to authenticated;

-- Runs as the caller. created_by / created_at are stamped on client inserts and fixed afterwards; the
-- workspace defaults to the app's and never changes.
create or replace function public.guard_team()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if public.is_client_role() then
      new.created_by := auth.uid();
      new.created_at := now();
      new.deleted_at := null;
    end if;
    if new.workspace_id is null then
      new.workspace_id := public.oldest_workspace_id();
    end if;
  elsif new.workspace_id <> old.workspace_id
     or new.created_by is distinct from old.created_by
     or new.created_at <> old.created_at then
    raise exception 'A team''s workspace and creator can''t change' using errcode = 'insufficient_privilege';
  end if;
  new.name := btrim(new.name);
  new.description := nullif(btrim(coalesce(new.description, '')), '');
  return new;
end;
$$;

revoke all on function public.guard_team() from public, anon;
grant execute on function public.guard_team() to authenticated;

create trigger teams_05_guard
  before insert or update on public.teams
  for each row execute function public.guard_team();

-- The creator becomes the first lead (through team_members_insert_lead's creating-transaction branch).
create or replace function public.add_team_creator_lead()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.created_by is not null then
    insert into public.team_members (team_id, profile_id, role, created_by)
    values (new.id, new.created_by, 'lead', new.created_by);
  end if;
  return new;
end;
$$;

revoke all on function public.add_team_creator_lead() from public, anon;
grant execute on function public.add_team_creator_lead() to authenticated;

create trigger teams_add_creator_lead
  after insert on public.teams
  for each row execute function public.add_team_creator_lead();

-- Runs as the caller. Rows can't move between teams or people and a removed row stays removed; a
-- person who doesn't manage the team may only remove themselves (leave); a live team always keeps a
-- lead (an advisory lock per team serialises concurrent demotions and removals).
create or replace function public.guard_team_member()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if public.is_client_role() then
      new.created_by := auth.uid();
      new.created_at := now();
      new.deleted_at := null;
    end if;
    if not public.profile_in_workspace(new.profile_id) then
      raise exception 'Only people on the workspace allowlist can join a team' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.team_id <> old.team_id
     or new.profile_id <> old.profile_id
     or new.created_by is distinct from old.created_by
     or new.created_at <> old.created_at then
    raise exception 'Team memberships can''t be moved' using errcode = 'insufficient_privilege';
  end if;
  if old.deleted_at is not null then
    raise exception 'Add the person again instead of restoring a removed membership' using errcode = 'check_violation';
  end if;
  if public.is_client_role() and not public.can_manage_team(old.team_id)
     and (new.role <> old.role or new.deleted_at is null) then
    raise exception 'Only team leads and workspace admins can change a team' using errcode = 'insufficient_privilege';
  end if;
  if old.role = 'lead' and (new.role <> 'lead' or new.deleted_at is not null) then
    perform pg_advisory_xact_lock(hashtextextended('alhc.team:' || old.team_id::text, 0));
    if exists (select 1 from public.teams t where t.id = old.team_id and t.deleted_at is null)
       and not exists (
         select 1 from public.team_members m
         where m.team_id = old.team_id and m.role = 'lead' and m.deleted_at is null and m.id <> old.id
       ) then
      raise exception 'A team needs at least one lead'
        using errcode = 'check_violation',
              hint = 'Make someone else a lead first.';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_team_member() from public, anon;
grant execute on function public.guard_team_member() to authenticated;

create trigger team_members_05_guard
  before insert or update on public.team_members
  for each row execute function public.guard_team_member();

alter table public.teams enable row level security;
alter table public.team_members enable row level security;

-- The directory is workspace-level: everyone allowlisted sees every team and who is in it.
create policy teams_select_allowlisted on public.teams
  for select to authenticated using ((select public.is_allowlisted()));
create policy teams_insert_allowlisted on public.teams
  for insert to authenticated with check ((select public.is_allowlisted()));
create policy teams_update_lead on public.teams
  for update to authenticated
  using ((select public.can_manage_team(id)))
  with check ((select public.can_manage_team(id)));

create policy team_members_select_allowlisted on public.team_members
  for select to authenticated using ((select public.is_allowlisted()));
-- Leads and workspace admins add people. The second branch lets a team's creator add themselves as
-- its first lead in the creating transaction (created_by / created_at are forced by teams_05_guard,
-- so it can't be replayed later).
create policy team_members_insert_lead on public.team_members
  for insert to authenticated
  with check (
    (select public.can_manage_team(team_id))
    or (
      profile_id = (select auth.uid())
      and role = 'lead'
      and (select public.is_allowlisted())
      and exists (
        select 1 from public.teams t
        where t.id = team_id and t.created_by = (select auth.uid()) and t.created_at = now()
      )
    )
  );
create policy team_members_update_lead on public.team_members
  for update to authenticated
  using ((select public.can_manage_team(team_id)))
  with check ((select public.can_manage_team(team_id)));
-- Anyone may leave a team (the guard limits this to setting deleted_at).
create policy team_members_update_own on public.team_members
  for update to authenticated
  using (profile_id = (select auth.uid()) and (select public.is_allowlisted()))
  with check (profile_id = (select auth.uid()));

revoke all on public.teams from anon;
revoke all on public.team_members from anon;
revoke delete, truncate, references, trigger on public.teams from authenticated;
revoke delete, truncate, references, trigger on public.team_members from authenticated;

-- ---------------------------------------------------------------------------
-- Team member RPCs (invoker: RLS and the guard decide)
-- ---------------------------------------------------------------------------

-- Adds someone by allowlisted email (they must have signed in once, like project invites). Adding an
-- active member again changes their role.
create or replace function public.add_team_member(target_team uuid, member_email text, member_role text default 'member')
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  address text := lower(trim(coalesce(member_email, '')));
  target uuid;
begin
  if not public.can_manage_team(target_team) then
    raise exception 'Only team leads and workspace admins can add people' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.teams t where t.id = target_team and t.deleted_at is null) then
    raise exception 'Team not found' using errcode = 'no_data_found';
  end if;
  if member_role is null or member_role not in ('lead', 'member') then
    raise exception 'Choose lead or member' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.allowed_emails a where a.email = address) then
    raise exception '% is not on the workspace allowlist', coalesce(nullif(address, ''), 'That address')
      using errcode = 'check_violation',
            hint = 'Workspace access is managed in SQL (allowed_emails). Ask whoever manages it to add them first.';
  end if;
  select p.id into target from public.profiles p where lower(p.email) = address;
  if target is null then
    raise exception '% is allowlisted but has not signed in yet', address
      using errcode = 'check_violation',
            hint = 'They can be added after their first sign-in.';
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

create or replace function public.update_team_member_role(target_team uuid, target_profile uuid, new_role text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not public.can_manage_team(target_team) then
    raise exception 'Only team leads and workspace admins can change roles' using errcode = 'insufficient_privilege';
  end if;
  if new_role is null or new_role not in ('lead', 'member') then
    raise exception 'Choose lead or member' using errcode = 'check_violation';
  end if;
  update public.team_members m
  set role = new_role
  where m.team_id = target_team and m.profile_id = target_profile and m.deleted_at is null;
  if not found then
    raise exception 'That person is not in this team' using errcode = 'no_data_found';
  end if;
end;
$$;

revoke all on function public.update_team_member_role(uuid, uuid, text) from public, anon;
grant execute on function public.update_team_member_role(uuid, uuid, text) to authenticated;

-- Leads and workspace admins remove anyone; everyone may remove themselves (leave). The last lead stays.
create or replace function public.remove_team_member(target_team uuid, target_profile uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if target_profile is distinct from auth.uid() and not public.can_manage_team(target_team) then
    raise exception 'Only team leads and workspace admins can remove people' using errcode = 'insufficient_privilege';
  end if;
  update public.team_members m
  set deleted_at = now()
  where m.team_id = target_team and m.profile_id = target_profile and m.deleted_at is null;
  if not found then
    raise exception 'That person is not in this team' using errcode = 'no_data_found';
  end if;
end;
$$;

revoke all on function public.remove_team_member(uuid, uuid) from public, anon;
grant execute on function public.remove_team_member(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Group invite: team → project
-- ---------------------------------------------------------------------------

create table public.team_projects (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id),
  project_id uuid not null references public.projects (id),
  -- The role the team was last added with (members already in the project kept theirs).
  role text not null check (role in ('admin', 'editor', 'commenter', 'viewer')),
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index team_projects_active_idx on public.team_projects (team_id, project_id) where deleted_at is null;
create index team_projects_project_idx on public.team_projects (project_id) where deleted_at is null;
create index team_projects_created_by_idx on public.team_projects (created_by);

create trigger team_projects_set_updated_at
  before update on public.team_projects
  for each row execute function public.set_updated_at();

create or replace function public.guard_team_project()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if public.is_client_role() then
      new.created_by := auth.uid();
      new.created_at := now();
      new.deleted_at := null;
    end if;
    return new;
  end if;
  if new.team_id <> old.team_id
     or new.project_id <> old.project_id
     or new.created_by is distinct from old.created_by
     or new.created_at <> old.created_at then
    raise exception 'Team projects can''t be moved' using errcode = 'insufficient_privilege';
  end if;
  if old.deleted_at is not null then
    raise exception 'Add the team again instead of restoring' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_team_project() from public, anon;
grant execute on function public.guard_team_project() to authenticated;

create trigger team_projects_05_guard
  before insert or update on public.team_projects
  for each row execute function public.guard_team_project();

alter table public.team_projects enable row level security;

-- A team page lists only the projects the viewer can already read.
create policy team_projects_select_viewer on public.team_projects
  for select to authenticated
  using ((select public.has_project_role(project_id, 'viewer')));
create policy team_projects_insert_admin on public.team_projects
  for insert to authenticated
  with check ((select public.has_project_role(project_id, 'admin')));
create policy team_projects_update_admin on public.team_projects
  for update to authenticated
  using ((select public.has_project_role(project_id, 'admin')))
  with check ((select public.has_project_role(project_id, 'admin')));

revoke all on public.team_projects from anon;
revoke delete, truncate, references, trigger on public.team_projects from authenticated;

-- Adds every active team member who isn't in the project yet with one role, through the ordinary
-- add_project_member() (which re-checks Admin+ and the allowlist), so access comes only from normal
-- project_members rows. People already in the project keep their role. Each person is added in its
-- own subtransaction: someone who can't be added (e.g. no longer allowlisted) is skipped with a reason.
-- Returns { added: [{profile_id, name}], unchanged: [...], skipped: [{profile_id, name, reason}] }.
create or replace function public.add_team_to_project(target_project uuid, target_team uuid, member_role text default 'editor')
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r record;
  added jsonb := '[]'::jsonb;
  unchanged jsonb := '[]'::jsonb;
  skipped jsonb := '[]'::jsonb;
begin
  if not public.has_project_role(target_project, 'admin') then
    raise exception 'Only project owners and admins can add a team' using errcode = 'insufficient_privilege';
  end if;
  if member_role is null or member_role not in ('admin', 'editor', 'commenter', 'viewer') then
    raise exception 'Choose admin, editor, commenter, or viewer' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.teams t where t.id = target_team and t.deleted_at is null) then
    raise exception 'Team not found' using errcode = 'no_data_found';
  end if;

  for r in
    select m.profile_id, p.email, coalesce(nullif(btrim(p.full_name), ''), p.email) as name
    from public.team_members m
    join public.profiles p on p.id = m.profile_id
    where m.team_id = target_team and m.deleted_at is null
    order by m.created_at, m.profile_id
  loop
    if exists (
      select 1 from public.project_members pm
      where pm.project_id = target_project and pm.profile_id = r.profile_id and pm.deleted_at is null
    ) then
      unchanged := unchanged || jsonb_build_object('profile_id', r.profile_id, 'name', r.name);
      continue;
    end if;
    begin
      perform public.add_project_member(target_project, r.email, member_role);
      added := added || jsonb_build_object('profile_id', r.profile_id, 'name', r.name);
    exception when others then
      skipped := skipped || jsonb_build_object('profile_id', r.profile_id, 'name', r.name, 'reason', sqlerrm);
    end;
  end loop;

  update public.team_projects tp
  set role = member_role
  where tp.team_id = target_team and tp.project_id = target_project and tp.deleted_at is null;
  if not found then
    insert into public.team_projects (team_id, project_id, role) values (target_team, target_project, member_role);
  end if;

  return jsonb_build_object('added', added, 'unchanged', unchanged, 'skipped', skipped);
end;
$$;

revoke all on function public.add_team_to_project(uuid, uuid, text) from public, anon;
grant execute on function public.add_team_to_project(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Goals
-- ---------------------------------------------------------------------------

create table public.goals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  team_id uuid references public.teams (id),
  parent_id uuid references public.goals (id),
  owner_id uuid default auth.uid() references public.profiles (id) on delete set null,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  notes text check (notes is null or char_length(notes) <= 10000),
  period_start date,
  period_end date,
  status text not null default 'on_track'
    check (status in ('on_track', 'at_risk', 'off_track', 'achieved', 'missed', 'dropped')),
  progress_mode text not null default 'manual' check (progress_mode in ('manual', 'sub_goals', 'projects')),
  manual_progress integer not null default 0 check (manual_progress between 0 and 100),
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint goals_period_order check (period_start is null or period_end is null or period_start <= period_end),
  constraint goals_not_own_parent check (parent_id is null or parent_id <> id)
);

create index goals_workspace_idx on public.goals (workspace_id) where deleted_at is null;
create index goals_parent_idx on public.goals (parent_id) where deleted_at is null;
create index goals_team_idx on public.goals (team_id) where deleted_at is null;
create index goals_owner_idx on public.goals (owner_id);
create index goals_created_by_idx on public.goals (created_by);

create trigger goals_set_updated_at
  before update on public.goals
  for each row execute function public.set_updated_at();

-- Can the caller edit a goal with this owner / team / workspace? Its owner, a lead of its team, or a
-- workspace admin. Never consults project membership, and grants nothing on projects.
create or replace function public.goal_editable(goal_owner uuid, goal_team uuid, goal_workspace uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select auth.uid() is not null and public.is_allowlisted() and (
    goal_owner = auth.uid()
    or (goal_team is not null and public.is_team_lead(goal_team))
    or public.is_workspace_admin(goal_workspace)
  );
$$;

revoke all on function public.goal_editable(uuid, uuid, uuid) from public, anon;
grant execute on function public.goal_editable(uuid, uuid, uuid) to authenticated;

create or replace function public.can_edit_goal(target_goal uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1 from public.goals g
    where g.id = target_goal and g.deleted_at is null
      and public.goal_editable(g.owner_id, g.team_id, g.workspace_id)
  );
$$;

revoke all on function public.can_edit_goal(uuid) from public, anon;
grant execute on function public.can_edit_goal(uuid) to authenticated;

-- Runs as the caller. Stamps creator/created_at, defaults the workspace, keeps workspace and creator
-- fixed, checks the team, owner, and parent (same workspace, active, editable parent, no cycles).
create or replace function public.guard_goal()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  parent_workspace uuid;
begin
  if tg_op = 'INSERT' then
    if public.is_client_role() then
      new.created_by := auth.uid();
      new.created_at := now();
      new.deleted_at := null;
    end if;
    if new.workspace_id is null then
      new.workspace_id := coalesce(
        (select t.workspace_id from public.teams t where t.id = new.team_id),
        (select g.workspace_id from public.goals g where g.id = new.parent_id),
        public.oldest_workspace_id()
      );
    end if;
  elsif new.workspace_id <> old.workspace_id
     or new.created_by is distinct from old.created_by
     or new.created_at <> old.created_at then
    raise exception 'A goal''s workspace and creator can''t change' using errcode = 'insufficient_privilege';
  end if;

  new.title := btrim(new.title);
  new.notes := nullif(btrim(coalesce(new.notes, '')), '');

  if new.team_id is not null and (tg_op = 'INSERT' or new.team_id is distinct from old.team_id) then
    if not exists (
      select 1 from public.teams t
      where t.id = new.team_id and t.deleted_at is null and t.workspace_id = new.workspace_id
    ) then
      raise exception 'Team not found' using errcode = 'check_violation';
    end if;
  end if;

  if new.owner_id is not null and (tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id) then
    if not public.profile_in_workspace(new.owner_id) then
      raise exception 'The owner must be someone on the workspace allowlist' using errcode = 'check_violation';
    end if;
  end if;

  if new.parent_id is not null and (tg_op = 'INSERT' or new.parent_id is distinct from old.parent_id) then
    if new.parent_id = new.id then
      raise exception 'A goal can’t be its own sub-goal' using errcode = 'check_violation';
    end if;
    select g.workspace_id into parent_workspace
    from public.goals g where g.id = new.parent_id and g.deleted_at is null;
    if parent_workspace is null or parent_workspace <> new.workspace_id then
      raise exception 'Parent goal not found' using errcode = 'check_violation';
    end if;
    if public.is_client_role() and not public.can_edit_goal(new.parent_id) then
      raise exception 'You can only add sub-goals to a goal you can edit'
        using errcode = 'insufficient_privilege',
              hint = 'Its owner, a lead of its team, or a workspace admin can.';
    end if;
    -- Serialise tree changes in this workspace so two concurrent moves can't make a cycle.
    perform pg_advisory_xact_lock(hashtextextended('alhc.goal_tree:' || new.workspace_id::text, 0));
    if exists (
      with recursive ancestors (id) as (
        select new.parent_id
        union
        select g.parent_id
        from public.goals g
        join ancestors a on g.id = a.id
        where g.parent_id is not null
      )
      select 1 from ancestors where id = new.id
    ) then
      raise exception 'A goal can’t be a sub-goal of its own sub-goal' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_goal() from public, anon;
grant execute on function public.guard_goal() to authenticated;

create trigger goals_05_guard
  before insert or update on public.goals
  for each row execute function public.guard_goal();

alter table public.goals enable row level security;

-- Goals are workspace-level: everyone allowlisted reads them.
create policy goals_select_allowlisted on public.goals
  for select to authenticated using ((select public.is_allowlisted()));
-- You can create a goal you'd be able to edit (you own it, lead its team, or are a workspace admin).
create policy goals_insert_editor on public.goals
  for insert to authenticated
  with check ((select public.goal_editable(owner_id, team_id, workspace_id)));
-- Editors change anything, including handing the goal to a new owner or team.
create policy goals_update_editor on public.goals
  for update to authenticated
  using ((select public.goal_editable(owner_id, team_id, workspace_id)))
  with check ((select public.is_allowlisted()));

revoke all on public.goals from anon;
revoke delete, truncate, references, trigger on public.goals from authenticated;

-- ---------------------------------------------------------------------------
-- Goal links (projects and portfolios)
-- ---------------------------------------------------------------------------

create table public.goal_links (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references public.goals (id),
  project_id uuid references public.projects (id),
  portfolio_id uuid references public.portfolios (id),
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint goal_links_one_target check (num_nonnulls(project_id, portfolio_id) = 1)
);

create unique index goal_links_project_idx on public.goal_links (goal_id, project_id)
  where project_id is not null and deleted_at is null;
create unique index goal_links_portfolio_idx on public.goal_links (goal_id, portfolio_id)
  where portfolio_id is not null and deleted_at is null;
create index goal_links_project_ref_idx on public.goal_links (project_id) where deleted_at is null;
create index goal_links_portfolio_ref_idx on public.goal_links (portfolio_id) where deleted_at is null;
create index goal_links_created_by_idx on public.goal_links (created_by);

create trigger goal_links_set_updated_at
  before update on public.goal_links
  for each row execute function public.set_updated_at();

create or replace function public.guard_goal_link()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if public.is_client_role() then
      new.created_by := auth.uid();
      new.created_at := now();
      new.deleted_at := null;
    end if;
    if not exists (select 1 from public.goals g where g.id = new.goal_id and g.deleted_at is null) then
      raise exception 'Goal not found' using errcode = 'no_data_found';
    end if;
    if new.project_id is not null
       and not exists (select 1 from public.projects p where p.id = new.project_id and p.deleted_at is null) then
      raise exception 'Project not found' using errcode = 'no_data_found';
    end if;
    if new.portfolio_id is not null
       and not exists (select 1 from public.portfolios p where p.id = new.portfolio_id and p.deleted_at is null) then
      raise exception 'Portfolio not found' using errcode = 'no_data_found';
    end if;
    return new;
  end if;
  if new.goal_id <> old.goal_id
     or new.project_id is distinct from old.project_id
     or new.portfolio_id is distinct from old.portfolio_id
     or new.created_by is distinct from old.created_by
     or new.created_at <> old.created_at then
    raise exception 'Goal links can''t be moved' using errcode = 'insufficient_privilege';
  end if;
  if old.deleted_at is not null then
    raise exception 'Link it again instead of restoring' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_goal_link() from public, anon;
grant execute on function public.guard_goal_link() to authenticated;

create trigger goal_links_05_guard
  before insert or update on public.goal_links
  for each row execute function public.guard_goal_link();

alter table public.goal_links enable row level security;

-- A link is only visible to people who can read what it points at (no names, no ids otherwise).
create policy goal_links_select_viewer on public.goal_links
  for select to authenticated
  using (
    (select public.is_allowlisted())
    and (project_id is null or (select public.has_project_role(project_id, 'viewer')))
    and (portfolio_id is null or (select public.has_portfolio_role(portfolio_id, 'viewer')))
  );
-- Linking needs edit rights on the goal and Viewer+ on the project / portfolio.
create policy goal_links_insert_editor on public.goal_links
  for insert to authenticated
  with check (
    (select public.can_edit_goal(goal_id))
    and (project_id is null or (select public.has_project_role(project_id, 'viewer')))
    and (portfolio_id is null or (select public.has_portfolio_role(portfolio_id, 'viewer')))
  );
-- Unlinking (soft delete) needs edit rights on the goal.
create policy goal_links_update_editor on public.goal_links
  for update to authenticated
  using ((select public.can_edit_goal(goal_id)))
  with check ((select public.can_edit_goal(goal_id)));

revoke all on public.goal_links from anon;
revoke update, delete, truncate, references, trigger on public.goal_links from authenticated;
grant update (deleted_at) on public.goal_links to authenticated;

-- ---------------------------------------------------------------------------
-- Goal status updates
-- ---------------------------------------------------------------------------

create table public.goal_status_updates (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references public.goals (id),
  status text not null check (status in ('on_track', 'at_risk', 'off_track', 'achieved', 'missed', 'dropped')),
  body text check (body is null or char_length(body) <= 5000),
  author_id uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index goal_status_updates_goal_idx on public.goal_status_updates (goal_id, created_at desc)
  where deleted_at is null;
create index goal_status_updates_author_idx on public.goal_status_updates (author_id);

create trigger goal_status_updates_set_updated_at
  before update on public.goal_status_updates
  for each row execute function public.set_updated_at();

create or replace function public.guard_goal_status_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if public.is_client_role() then
      new.author_id := auth.uid();
      new.created_at := now();
      new.deleted_at := null;
    end if;
    new.body := nullif(btrim(coalesce(new.body, '')), '');
    if not exists (select 1 from public.goals g where g.id = new.goal_id and g.deleted_at is null) then
      raise exception 'Goal not found' using errcode = 'no_data_found';
    end if;
    return new;
  end if;
  if old.deleted_at is not null or new.deleted_at is null then
    raise exception 'Status updates can only be deleted' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_goal_status_update() from public, anon;
grant execute on function public.guard_goal_status_update() to authenticated;

create trigger goal_status_updates_05_guard
  before insert or update on public.goal_status_updates
  for each row execute function public.guard_goal_status_update();

-- Posting an update sets the goal's status. Runs as the author, who can edit the goal (policy).
create or replace function public.apply_goal_status_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.goals g set status = new.status
  where g.id = new.goal_id and g.status is distinct from new.status;
  return new;
end;
$$;

revoke all on function public.apply_goal_status_update() from public, anon;
grant execute on function public.apply_goal_status_update() to authenticated;

create trigger goal_status_updates_after_insert
  after insert on public.goal_status_updates
  for each row execute function public.apply_goal_status_update();

alter table public.goal_status_updates enable row level security;

create policy goal_status_updates_select_allowlisted on public.goal_status_updates
  for select to authenticated using ((select public.is_allowlisted()));
create policy goal_status_updates_insert_editor on public.goal_status_updates
  for insert to authenticated
  with check (author_id = (select auth.uid()) and (select public.can_edit_goal(goal_id)));
-- Authors delete (soft) their own updates; the goal's status stays as it is.
create policy goal_status_updates_update_own on public.goal_status_updates
  for update to authenticated
  using (author_id = (select auth.uid()) and (select public.is_allowlisted()))
  with check (author_id = (select auth.uid()));

revoke all on public.goal_status_updates from anon;
revoke update, delete, truncate, references, trigger on public.goal_status_updates from authenticated;
grant update (deleted_at) on public.goal_status_updates to authenticated;

-- ---------------------------------------------------------------------------
-- Progress
-- ---------------------------------------------------------------------------

-- How many linked projects (directly, or through a linked portfolio) the caller can't read and that
-- goal_progress() therefore leaves out. A project reached only through a portfolio the caller isn't a
-- member of counts as hidden too (portfolio membership is needed to see a portfolio's projects).
-- SECURITY DEFINER because RLS hides exactly the rows it counts; it returns only a number, never a
-- name or id, and only for active goals (which every allowlisted person can read anyway).
create or replace function public.goal_hidden_project_count(target_goal uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  with goal as (
    select g.id from public.goals g
    where g.id = target_goal and g.deleted_at is null and public.is_allowlisted()
  ),
  linked as (
    select l.project_id, (public.has_project_role(l.project_id, 'viewer')) as visible
    from goal
    join public.goal_links l on l.goal_id = goal.id and l.deleted_at is null and l.project_id is not null
    join public.projects p on p.id = l.project_id and p.deleted_at is null
    union all
    select pp.project_id,
           (public.has_portfolio_role(l.portfolio_id, 'viewer') and public.has_project_role(pp.project_id, 'viewer'))
    from goal
    join public.goal_links l on l.goal_id = goal.id and l.deleted_at is null and l.portfolio_id is not null
    join public.portfolios po on po.id = l.portfolio_id and po.deleted_at is null
    join public.portfolio_projects pp on pp.portfolio_id = po.id and pp.deleted_at is null
    join public.projects p on p.id = pp.project_id and p.deleted_at is null
  )
  select count(*)::integer
  from (select project_id from linked group by project_id having not bool_or(visible)) hidden;
$$;

revoke all on function public.goal_hidden_project_count(uuid) from public, anon;
grant execute on function public.goal_hidden_project_count(uuid) to authenticated;

-- Task counts for one goal over the linked projects the caller can read (directly, or through a linked
-- portfolio they're a member of), each task once. Invoker plus explicit role checks, like
-- portfolio_report: a workspace admin counts exactly what their own project memberships allow.
create or replace function public.goal_task_counts(target_goal uuid)
returns table (task_count bigint, completed_count bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with visible_projects as (
    select l.project_id
    from public.goal_links l
    join public.projects p on p.id = l.project_id and p.deleted_at is null
    where l.goal_id = target_goal and l.deleted_at is null and l.project_id is not null
      and public.has_project_role(l.project_id, 'viewer')
    union
    select pp.project_id
    from public.goal_links l
    join public.portfolios po on po.id = l.portfolio_id and po.deleted_at is null
    join public.portfolio_projects pp on pp.portfolio_id = po.id and pp.deleted_at is null
    join public.projects p on p.id = pp.project_id and p.deleted_at is null
    where l.goal_id = target_goal and l.deleted_at is null and l.portfolio_id is not null
      and public.has_portfolio_role(l.portfolio_id, 'viewer')
      and public.has_project_role(pp.project_id, 'viewer')
  ),
  counted as (
    select distinct t.id, t.completed_at
    from visible_projects vp
    join public.task_projects tp on tp.project_id = vp.project_id and tp.deleted_at is null
    join public.tasks t on t.id = tp.task_id and t.deleted_at is null
  )
  select count(*), count(*) filter (where completed_at is not null) from counted;
$$;

revoke all on function public.goal_task_counts(uuid) from public, anon;
grant execute on function public.goal_task_counts(uuid) to authenticated;

-- Progress of every active goal in the workspace (default: the app's), as seen by the caller.
-- Sub-goals are computed before their parents (ordered by height in the tree).
--   progress            0–100, or null when there is nothing to measure yet
--   task_count          tasks counted (projects mode; else null)
--   completed_count     completed tasks counted (projects mode; else null)
--   hidden_project_count  linked projects the caller can't read (any mode; only a count)
--   sub_goal_count      active sub-goals
create or replace function public.goal_progress(target_workspace uuid default null)
returns table (
  goal_id uuid,
  progress integer,
  task_count bigint,
  completed_count bigint,
  hidden_project_count integer,
  sub_goal_count integer
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  ws uuid := coalesce(target_workspace, public.oldest_workspace_id());
  r record;
  known jsonb := '{}'::jsonb;
  total bigint;
  done bigint;
  value integer;
begin
  if not public.is_allowlisted() then
    return;
  end if;
  for r in
    with recursive active as (
      select g.id, g.parent_id, g.progress_mode, g.manual_progress
      from public.goals g
      where g.workspace_id = ws and g.deleted_at is null
    ),
    heights (id, height) as (
      select a.id, 0 from active a
      union all
      select a.parent_id, h.height + 1
      from heights h
      join active a on a.id = h.id
      join active p on p.id = a.parent_id
      where h.height < 100
    )
    select a.id, a.progress_mode, a.manual_progress, max(h.height) as height,
           (select count(*)::integer from active c where c.parent_id = a.id) as children
    from active a
    join heights h on h.id = a.id
    group by a.id, a.progress_mode, a.manual_progress
    order by max(h.height), a.id
  loop
    total := null;
    done := null;
    if r.progress_mode = 'manual' then
      value := r.manual_progress;
    elsif r.progress_mode = 'projects' then
      select c.task_count, c.completed_count into total, done from public.goal_task_counts(r.id) c;
      value := case when total > 0 then floor(100.0 * done / total)::integer end;
    else
      select floor(avg((known ->> c.id::text)::numeric))::integer into value
      from public.goals c
      where c.parent_id = r.id and c.deleted_at is null and c.status <> 'dropped'
        and known ->> c.id::text is not null;
    end if;
    known := known || jsonb_build_object(r.id::text, value);
    goal_id := r.id;
    progress := value;
    task_count := total;
    completed_count := done;
    hidden_project_count := public.goal_hidden_project_count(r.id);
    sub_goal_count := r.children;
    return next;
  end loop;
end;
$$;

revoke all on function public.goal_progress(uuid) from public, anon;
grant execute on function public.goal_progress(uuid) to authenticated;
