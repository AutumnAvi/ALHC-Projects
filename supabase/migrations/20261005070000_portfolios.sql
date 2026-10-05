-- ALHC Projects — Phase: Portfolios and reporting.
-- A portfolio is a named collection of projects with a progress overview and simple cross-project
-- reporting. Still generic: nothing here knows about a team, department, or request type.
--
-- Access model (two independent gates, both behind the allowlist):
--   * portfolio_members decides who can see a portfolio and change it:
--       viewer < editor < admin < owner   (no commenter: portfolios have nothing to comment on)
--       viewer  read the portfolio, its members, and the projects in it that they can also read
--       editor  + rename / edit notes, add projects (needs Viewer+ on the project), remove, reorder
--       admin   + invite people, change roles (up to admin), remove non-owners
--       owner   + add/promote/remove owners, transfer ownership, soft-delete the portfolio
--   * project_members still decides which projects (and tasks) that person can read. Portfolio
--     membership never grants project access: portfolio_projects rows, counts, and reports only ever
--     include projects where the caller has has_project_role(project, 'viewer').
--
-- Progress formula (portfolio_report, group_by 'none'): over every active task with an active
-- membership in at least one active project of the portfolio that the caller can read,
--   percent = floor(100 * completed / (completed + incomplete)),
-- counting each task once even when it is multi-homed into several of those projects. Soft-deleted
-- tasks, projects, task memberships, and portfolio_projects rows are excluded. No tasks => null (the
-- app shows "No tasks"). Overdue = incomplete with due_on before the caller's local today.
--
-- Also adds a project status (on_track | at_risk | off_track | complete) with a note, set by Editors+
-- through set_project_status(); portfolio cards show it as a badge.
--
-- Same rules as earlier phases: soft delete only, no DELETE policies, SECURITY DEFINER helpers with
-- search_path = '' and EXECUTE revoked from client roles unless they are intentional RPCs.

-- ---------------------------------------------------------------------------
-- Project status
-- ---------------------------------------------------------------------------

alter table public.projects
  add column status text not null default 'on_track'
    constraint projects_status_check check (status in ('on_track', 'at_risk', 'off_track', 'complete')),
  add column status_note text
    constraint projects_status_note_length check (status_note is null or length(status_note) <= 2000),
  add column status_updated_at timestamptz,
  add column status_updated_by uuid references public.profiles (id) on delete set null;

create index projects_status_updated_by_idx on public.projects (status_updated_by);

-- Status changes go through set_project_status() (Editor+), which also stamps who and when.
-- Direct client updates (admins can update projects) may not touch the status columns.
create or replace function public.guard_project_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.is_client_role() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.status := 'on_track';
    new.status_note := null;
    new.status_updated_at := null;
    new.status_updated_by := null;
    return new;
  end if;
  if new.status is distinct from old.status
     or new.status_note is distinct from old.status_note
     or new.status_updated_at is distinct from old.status_updated_at
     or new.status_updated_by is distinct from old.status_updated_by then
    raise exception 'Project status changes go through set_project_status'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_project_status() from public, anon, authenticated;

create trigger projects_06_guard_status
  before insert or update on public.projects
  for each row execute function public.guard_project_status();

create or replace function public.set_project_status(
  target_project uuid,
  new_status text,
  note text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  cleaned text := nullif(trim(coalesce(note, '')), '');
begin
  if not public.has_project_role(target_project, 'editor') then
    raise exception 'Only project editors and above can set the project status'
      using errcode = 'insufficient_privilege';
  end if;
  if new_status is null or new_status not in ('on_track', 'at_risk', 'off_track', 'complete') then
    raise exception 'Status must be on_track, at_risk, off_track, or complete' using errcode = 'check_violation';
  end if;
  if length(cleaned) > 2000 then
    raise exception 'The status note is too long' using errcode = 'check_violation';
  end if;
  update public.projects
  set status = new_status,
      status_note = cleaned,
      status_updated_at = now(),
      status_updated_by = auth.uid()
  where id = target_project and deleted_at is null;
  if not found then
    raise exception 'Project not found' using errcode = 'no_data_found';
  end if;
end;
$$;

revoke all on function public.set_project_status(uuid, text, text) from public, anon;
grant execute on function public.set_project_status(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.portfolios (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  name text not null constraint portfolios_name_length check (length(trim(name)) between 1 and 100),
  notes text constraint portfolios_notes_length check (notes is null or length(notes) <= 20000),
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index portfolios_workspace_idx on public.portfolios (workspace_id, name) where deleted_at is null;
create index portfolios_created_by_idx on public.portfolios (created_by);

create trigger portfolios_set_updated_at
  before update on public.portfolios
  for each row execute function public.set_updated_at();

comment on table public.portfolios is
  'Named collection of projects. Access via portfolio_members; projects inside still need project membership.';

create table public.portfolio_members (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios (id),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'editor', 'viewer')),
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- One active membership per person per portfolio. Removed memberships stay as history.
create unique index portfolio_members_active_idx
  on public.portfolio_members (portfolio_id, profile_id)
  where deleted_at is null;
create index portfolio_members_profile_idx
  on public.portfolio_members (profile_id, portfolio_id)
  where deleted_at is null;
create index portfolio_members_created_by_idx on public.portfolio_members (created_by);

create trigger portfolio_members_set_updated_at
  before update on public.portfolio_members
  for each row execute function public.set_updated_at();

comment on table public.portfolio_members is
  'Per-portfolio membership and role. Written only by SECURITY DEFINER RPCs/triggers; soft-deleted on removal.';

create table public.portfolio_projects (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios (id),
  project_id uuid not null references public.projects (id),
  sort_order double precision not null default 0,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- One active row per (portfolio, project). Removing soft-deletes; re-adding creates a new row.
create unique index portfolio_projects_active_idx
  on public.portfolio_projects (portfolio_id, project_id)
  where deleted_at is null;
create index portfolio_projects_order_idx
  on public.portfolio_projects (portfolio_id, sort_order)
  where deleted_at is null;
create index portfolio_projects_project_idx
  on public.portfolio_projects (project_id)
  where deleted_at is null;
create index portfolio_projects_created_by_idx on public.portfolio_projects (created_by);

create trigger portfolio_projects_set_updated_at
  before update on public.portfolio_projects
  for each row execute function public.set_updated_at();

comment on table public.portfolio_projects is
  'Projects in a portfolio, ordered by sort_order. Written only by SECURITY DEFINER RPCs.';

-- ---------------------------------------------------------------------------
-- Role helpers
-- ---------------------------------------------------------------------------

-- Total order for portfolio roles. Unknown roles (including 'commenter') rank 0 (no access).
create or replace function public.portfolio_role_rank(role text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case role
    when 'viewer' then 1
    when 'editor' then 2
    when 'admin' then 3
    when 'owner' then 4
    else 0
  end;
$$;

revoke all on function public.portfolio_role_rank(text) from public, anon, authenticated;

-- Internal: a given profile's active role in a portfolio (no allowlist check).
create or replace function public.profile_portfolio_role(target_profile uuid, target_portfolio uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
  from public.portfolio_members m
  where m.portfolio_id = target_portfolio
    and m.profile_id = target_profile
    and m.deleted_at is null;
$$;

revoke all on function public.profile_portfolio_role(uuid, uuid) from public, anon, authenticated;

-- The caller's role in a portfolio, or null. Null for callers who are not allowlisted.
create or replace function public.portfolio_role(target_portfolio uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.is_allowlisted() then public.profile_portfolio_role(auth.uid(), target_portfolio) end;
$$;

revoke all on function public.portfolio_role(uuid) from public, anon;
grant execute on function public.portfolio_role(uuid) to authenticated;

create or replace function public.has_portfolio_role(target_portfolio uuid, min_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.portfolio_role_rank(min_role) > 0
    and coalesce(
      public.portfolio_role_rank(public.portfolio_role(target_portfolio)) >= public.portfolio_role_rank(min_role),
      false
    );
$$;

revoke all on function public.has_portfolio_role(uuid, text) from public, anon;
grant execute on function public.has_portfolio_role(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Invariants
-- ---------------------------------------------------------------------------

-- Memberships never move between portfolios/people, and a portfolio always keeps an active owner.
create or replace function public.guard_portfolio_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.portfolio_id is distinct from old.portfolio_id or new.profile_id is distinct from old.profile_id then
    raise exception 'A membership cannot move to another portfolio or person' using errcode = 'check_violation';
  end if;
  if old.deleted_at is null and old.role = 'owner'
     and (new.deleted_at is not null or new.role <> 'owner') then
    -- Serialise owner changes per portfolio so two concurrent demotions can't both pass.
    perform 1 from public.portfolios p where p.id = old.portfolio_id for update;
    if not exists (
      select 1 from public.portfolio_members m
      where m.portfolio_id = old.portfolio_id
        and m.id <> old.id
        and m.role = 'owner'
        and m.deleted_at is null
    ) then
      raise exception 'A portfolio needs at least one owner. Make someone else an owner first.'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger portfolio_members_guard
  before update on public.portfolio_members
  for each row execute function public.guard_portfolio_member();

-- A portfolio's projects never move between portfolios/projects (remove and re-add instead).
create or replace function public.guard_portfolio_project()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.portfolio_id is distinct from old.portfolio_id or new.project_id is distinct from old.project_id then
    raise exception 'A portfolio project cannot move to another portfolio or project'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_portfolio_project() from public, anon, authenticated;

create trigger portfolio_projects_guard
  before update on public.portfolio_projects
  for each row execute function public.guard_portfolio_project();

-- Clients can't spoof who created a portfolio or when, can't move it to another workspace, and only
-- an owner can soft-delete or restore it.
create or replace function public.guard_portfolio_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.is_client_role() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
    new.deleted_at := null;
    return new;
  end if;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.workspace_id := old.workspace_id;
  if new.deleted_at is distinct from old.deleted_at and not public.has_portfolio_role(old.id, 'owner') then
    raise exception 'Only a portfolio owner can delete this portfolio' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_portfolio_columns() from public, anon, authenticated;

create trigger portfolios_05_guard_columns
  before insert or update on public.portfolios
  for each row execute function public.guard_portfolio_columns();

-- The creator of a portfolio becomes its owner (mirrors projects_add_owner).
create or replace function public.add_portfolio_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := coalesce(public.current_profile_id(), new.created_by);
begin
  if owner_id is not null then
    insert into public.portfolio_members (portfolio_id, profile_id, role, created_by)
    values (new.id, owner_id, 'owner', owner_id);
  end if;
  return new;
end;
$$;

create trigger portfolios_add_owner
  after insert on public.portfolios
  for each row execute function public.add_portfolio_owner();

-- ---------------------------------------------------------------------------
-- Membership RPCs (the only write path for portfolio_members)
-- ---------------------------------------------------------------------------

create or replace function public.update_portfolio_member_role(
  target_portfolio uuid,
  target_profile uuid,
  new_role text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_role text := public.portfolio_role(target_portfolio);
  m public.portfolio_members;
begin
  if public.portfolio_role_rank(caller_role) < public.portfolio_role_rank('admin') then
    raise exception 'Only portfolio owners and admins can change roles' using errcode = 'insufficient_privilege';
  end if;
  if public.portfolio_role_rank(new_role) = 0 then
    raise exception 'Unknown role' using errcode = 'check_violation';
  end if;
  select * into m from public.portfolio_members
  where portfolio_id = target_portfolio and profile_id = target_profile and deleted_at is null
  for update;
  if not found then
    raise exception 'That person is not a member of this portfolio' using errcode = 'no_data_found';
  end if;
  if (m.role = 'owner' or new_role = 'owner') and caller_role <> 'owner' then
    raise exception 'Only an owner can add or change owners' using errcode = 'insufficient_privilege';
  end if;
  if m.role <> new_role then
    update public.portfolio_members set role = new_role where id = m.id;
  end if;
end;
$$;

revoke all on function public.update_portfolio_member_role(uuid, uuid, text) from public, anon;
grant execute on function public.update_portfolio_member_role(uuid, uuid, text) to authenticated;

-- Invite by email, same rules as add_project_member: the address must be on the workspace allowlist
-- and its owner must have signed in with a confirmed email (so a profile exists). Re-inviting an
-- active member changes their role instead. Portfolio membership grants no project access.
create or replace function public.add_portfolio_member(
  target_portfolio uuid,
  member_email text,
  member_role text default 'viewer'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_role text := public.portfolio_role(target_portfolio);
  address text := lower(trim(coalesce(member_email, '')));
  target uuid;
begin
  if public.portfolio_role_rank(caller_role) < public.portfolio_role_rank('admin') then
    raise exception 'Only portfolio owners and admins can invite people' using errcode = 'insufficient_privilege';
  end if;
  if public.portfolio_role_rank(member_role) = 0 then
    raise exception 'Unknown role' using errcode = 'check_violation';
  end if;
  if member_role = 'owner' and caller_role <> 'owner' then
    raise exception 'Only an owner can add another owner' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.portfolios p where p.id = target_portfolio and p.deleted_at is not null) then
    raise exception 'This portfolio was deleted' using errcode = 'check_violation';
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

  if exists (
    select 1 from public.portfolio_members m
    where m.portfolio_id = target_portfolio and m.profile_id = target and m.deleted_at is null
  ) then
    perform public.update_portfolio_member_role(target_portfolio, target, member_role);
  else
    insert into public.portfolio_members (portfolio_id, profile_id, role, created_by)
    values (target_portfolio, target, member_role, auth.uid());
  end if;
  return target;
end;
$$;

revoke all on function public.add_portfolio_member(uuid, text, text) from public, anon;
grant execute on function public.add_portfolio_member(uuid, text, text) to authenticated;

-- Soft-removes a membership. Anyone may leave; removing others needs admin (owners need an owner).
create or replace function public.remove_portfolio_member(target_portfolio uuid, target_profile uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_role text := public.portfolio_role(target_portfolio);
  m public.portfolio_members;
begin
  if caller_role is null then
    raise exception 'You are not a member of this portfolio' using errcode = 'insufficient_privilege';
  end if;
  select * into m from public.portfolio_members
  where portfolio_id = target_portfolio and profile_id = target_profile and deleted_at is null
  for update;
  if not found then
    raise exception 'That person is not a member of this portfolio' using errcode = 'no_data_found';
  end if;
  if target_profile is distinct from auth.uid() then
    if public.portfolio_role_rank(caller_role) < public.portfolio_role_rank('admin') then
      raise exception 'Only portfolio owners and admins can remove people' using errcode = 'insufficient_privilege';
    end if;
    if m.role = 'owner' and caller_role <> 'owner' then
      raise exception 'Only an owner can remove another owner' using errcode = 'insufficient_privilege';
    end if;
  end if;
  update public.portfolio_members set deleted_at = now() where id = m.id;
end;
$$;

revoke all on function public.remove_portfolio_member(uuid, uuid) from public, anon;
grant execute on function public.remove_portfolio_member(uuid, uuid) to authenticated;

-- Makes another member an owner and steps the caller down to admin.
create or replace function public.transfer_portfolio_ownership(target_portfolio uuid, target_profile uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.portfolio_role(target_portfolio) is distinct from 'owner' then
    raise exception 'Only an owner can transfer ownership' using errcode = 'insufficient_privilege';
  end if;
  if target_profile is not distinct from auth.uid() then
    raise exception 'Choose another member' using errcode = 'check_violation';
  end if;
  update public.portfolio_members set role = 'owner'
  where portfolio_id = target_portfolio and profile_id = target_profile and deleted_at is null;
  if not found then
    raise exception 'That person is not a member of this portfolio' using errcode = 'no_data_found';
  end if;
  update public.portfolio_members set role = 'admin'
  where portfolio_id = target_portfolio and profile_id = auth.uid() and deleted_at is null;
end;
$$;

revoke all on function public.transfer_portfolio_ownership(uuid, uuid) from public, anon;
grant execute on function public.transfer_portfolio_ownership(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Portfolio project RPCs (the only write path for portfolio_projects)
-- ---------------------------------------------------------------------------

-- Adding needs Editor+ on the portfolio AND Viewer+ on the project — for admins and owners too — so a
-- portfolio can never be used to surface a project its members can't already see. Idempotent.
create or replace function public.add_portfolio_project(target_portfolio uuid, target_project uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing uuid;
  inserted uuid;
begin
  if not public.has_portfolio_role(target_portfolio, 'editor') then
    raise exception 'Only portfolio editors and above can add projects' using errcode = 'insufficient_privilege';
  end if;
  if not public.has_project_role(target_project, 'viewer') then
    raise exception 'You can only add projects you are a member of' using errcode = 'insufficient_privilege';
  end if;
  -- Lock the portfolio so concurrent adds compute distinct positions.
  perform 1 from public.portfolios p where p.id = target_portfolio for update;
  if exists (select 1 from public.portfolios p where p.id = target_portfolio and p.deleted_at is not null) then
    raise exception 'This portfolio was deleted' using errcode = 'check_violation';
  end if;
  if not exists (
    select 1
    from public.projects pr
    join public.portfolios po on po.id = target_portfolio
    where pr.id = target_project and pr.deleted_at is null and pr.workspace_id = po.workspace_id
  ) then
    raise exception 'That project is not available' using errcode = 'check_violation';
  end if;

  select pp.id into existing from public.portfolio_projects pp
  where pp.portfolio_id = target_portfolio and pp.project_id = target_project and pp.deleted_at is null;
  if existing is not null then
    return existing;
  end if;

  insert into public.portfolio_projects (portfolio_id, project_id, sort_order, created_by)
  values (
    target_portfolio,
    target_project,
    coalesce((
      select max(pp.sort_order) from public.portfolio_projects pp
      where pp.portfolio_id = target_portfolio and pp.deleted_at is null
    ), 0) + 1024,
    auth.uid()
  )
  returning id into inserted;
  return inserted;
end;
$$;

revoke all on function public.add_portfolio_project(uuid, uuid) from public, anon;
grant execute on function public.add_portfolio_project(uuid, uuid) to authenticated;

-- Removing (soft delete) and reordering need Editor+ on the portfolio only.
create or replace function public.remove_portfolio_project(target_portfolio uuid, target_project uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.has_portfolio_role(target_portfolio, 'editor') then
    raise exception 'Only portfolio editors and above can remove projects' using errcode = 'insufficient_privilege';
  end if;
  update public.portfolio_projects set deleted_at = now()
  where portfolio_id = target_portfolio and project_id = target_project and deleted_at is null;
  if not found then
    raise exception 'That project is not in this portfolio' using errcode = 'no_data_found';
  end if;
end;
$$;

revoke all on function public.remove_portfolio_project(uuid, uuid) from public, anon;
grant execute on function public.remove_portfolio_project(uuid, uuid) to authenticated;

create or replace function public.move_portfolio_project(
  target_portfolio uuid,
  target_project uuid,
  new_sort_order double precision
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.has_portfolio_role(target_portfolio, 'editor') then
    raise exception 'Only portfolio editors and above can reorder projects' using errcode = 'insufficient_privilege';
  end if;
  if new_sort_order is null or new_sort_order = 'NaN'::double precision
     or new_sort_order in ('Infinity'::double precision, '-Infinity'::double precision) then
    raise exception 'Invalid position' using errcode = 'check_violation';
  end if;
  update public.portfolio_projects set sort_order = new_sort_order
  where portfolio_id = target_portfolio and project_id = target_project and deleted_at is null;
  if not found then
    raise exception 'That project is not in this portfolio' using errcode = 'no_data_found';
  end if;
end;
$$;

revoke all on function public.move_portfolio_project(uuid, uuid, double precision) from public, anon;
grant execute on function public.move_portfolio_project(uuid, uuid, double precision) to authenticated;

-- How many active projects of a portfolio the caller can't read (so the overview can say that its
-- numbers leave them out). Reveals only a count, and only to portfolio members.
create or replace function public.portfolio_hidden_project_count(target_portfolio uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.has_portfolio_role(target_portfolio, 'viewer') then (
    select count(*)::integer
    from public.portfolio_projects pp
    join public.projects pr on pr.id = pp.project_id
    where pp.portfolio_id = target_portfolio
      and pp.deleted_at is null
      and pr.deleted_at is null
      and not public.has_project_role(pp.project_id, 'viewer')
  ) else 0 end;
$$;

revoke all on function public.portfolio_hidden_project_count(uuid) from public, anon;
grant execute on function public.portfolio_hidden_project_count(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Reporting (SECURITY INVOKER: RLS on portfolios, portfolio_projects, projects, task_projects, and
-- tasks applies, and every project is re-checked with has_project_role(project, 'viewer'))
-- ---------------------------------------------------------------------------

-- Cross-project counts for one portfolio.
--   group_by 'none'     one row (bucket null): the portfolio's progress, each task counted once
--   group_by 'project'  one row per visible project with tasks (a multi-homed task counts in each)
--   group_by 'assignee' one row per assignee (null = unassigned), each task counted once
-- completed_recent_count = completed on one of the caller's last 7 local days (today included),
-- matching the views filter completed_within_days = 7.
create or replace function public.portfolio_report(
  target_portfolio uuid,
  group_by text default 'none',
  tz text default 'UTC'
)
returns table (
  bucket uuid,
  task_count bigint,
  completed_count bigint,
  incomplete_count bigint,
  overdue_count bigint,
  completed_recent_count bigint
)
language sql
stable
set search_path = ''
as $$
  with params as (
    select zone, (now() at time zone zone)::date as today
    from (select public.safe_timezone(tz) as zone) z
  ),
  visible_projects as (
    select pp.project_id
    from public.portfolio_projects pp
    join public.portfolios po on po.id = pp.portfolio_id
    join public.projects pr on pr.id = pp.project_id
    where pp.portfolio_id = target_portfolio
      and pp.deleted_at is null
      and po.deleted_at is null
      and pr.deleted_at is null
      and public.has_portfolio_role(target_portfolio, 'viewer')
      and public.has_project_role(pp.project_id, 'viewer')
  ),
  memberships as (
    select tp.project_id, t.id as task_id, t.assignee_id, t.due_on, t.completed_at
    from visible_projects vp
    join public.task_projects tp on tp.project_id = vp.project_id and tp.deleted_at is null
    join public.tasks t on t.id = tp.task_id and t.deleted_at is null
  ),
  counted as (
    -- 'project' keeps one row per (project, task); the other groupings dedupe by task id.
    select case when group_by = 'project' then m.project_id end as project_id,
           m.task_id, m.assignee_id, m.due_on, m.completed_at
    from memberships m
    group by 1, m.task_id, m.assignee_id, m.due_on, m.completed_at
  )
  select
    case group_by when 'project' then r.project_id when 'assignee' then r.assignee_id end as bucket,
    count(*) as task_count,
    count(*) filter (where r.completed_at is not null) as completed_count,
    count(*) filter (where r.completed_at is null) as incomplete_count,
    count(*) filter (where r.completed_at is null and r.due_on < p.today) as overdue_count,
    count(*) filter (
      where r.completed_at is not null and (r.completed_at at time zone p.zone)::date > p.today - 7
    ) as completed_recent_count
  from counted r
  cross join params p
  where group_by in ('none', 'project', 'assignee')
  group by 1
  union all
  -- 'none' always returns one row, even for an empty (or unreadable) portfolio.
  select null, 0, 0, 0, 0, 0
  where group_by = 'none' and not exists (select 1 from counted);
$$;

revoke all on function public.portfolio_report(uuid, text, text) from public, anon;
grant execute on function public.portfolio_report(uuid, text, text) to authenticated;

comment on function public.portfolio_report(uuid, text, text) is
  'Portfolio counts over visible projects only. Progress = completed / (completed + incomplete), tasks '
  'deduped by id across the portfolio''s projects; see the header of 20261005070000_portfolios.sql.';

-- Progress of every portfolio the caller can read, for the sidebar (one call instead of one per
-- portfolio). Same visibility and dedupe rules as portfolio_report(..., 'none').
create or replace function public.list_portfolio_progress()
returns table (portfolio_id uuid, task_count bigint, completed_count bigint)
language sql
stable
set search_path = ''
as $$
  with visible as (
    select distinct po.id as portfolio_id, t.id as task_id, t.completed_at
    from public.portfolios po
    join public.portfolio_projects pp on pp.portfolio_id = po.id and pp.deleted_at is null
    join public.projects pr on pr.id = pp.project_id and pr.deleted_at is null
    join public.task_projects tp on tp.project_id = pp.project_id and tp.deleted_at is null
    join public.tasks t on t.id = tp.task_id and t.deleted_at is null
    where po.deleted_at is null
      and public.has_portfolio_role(po.id, 'viewer')
      and public.has_project_role(pp.project_id, 'viewer')
  )
  select v.portfolio_id, count(*), count(*) filter (where v.completed_at is not null)
  from visible v
  group by v.portfolio_id;
$$;

revoke all on function public.list_portfolio_progress() from public, anon;
grant execute on function public.list_portfolio_progress() to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security (membership-aware; no DELETE policies; nothing for anon)
-- ---------------------------------------------------------------------------

alter table public.portfolios enable row level security;
alter table public.portfolio_members enable row level security;
alter table public.portfolio_projects enable row level security;

-- The second branch lets a creator read the row back in the transaction that inserts it (the owner
-- membership is written by an AFTER trigger, after INSERT ... RETURNING is checked). created_by and
-- created_at are forced by portfolios_05_guard_columns, so it can't be replayed later.
create policy portfolios_select_viewer on public.portfolios
  for select to authenticated
  using (
    (select public.has_portfolio_role(id, 'viewer'))
    or (created_by = (select auth.uid()) and created_at = now() and (select public.is_allowlisted()))
  );
-- Like projects: any allowlisted person can start a portfolio and owns it.
create policy portfolios_insert_allowlisted on public.portfolios
  for insert to authenticated
  with check ((select public.is_allowlisted()));
-- Name and notes: Editor+. Soft delete/restore: Owner (portfolios_05_guard_columns).
create policy portfolios_update_editor on public.portfolios
  for update to authenticated
  using ((select public.has_portfolio_role(id, 'editor')))
  with check ((select public.has_portfolio_role(id, 'editor')));

create policy portfolio_members_select_viewer on public.portfolio_members
  for select to authenticated
  using ((select public.has_portfolio_role(portfolio_id, 'viewer')));
-- No insert/update policies: memberships change only through the RPCs above.

-- A portfolio's project list only shows projects the caller can also read.
create policy portfolio_projects_select_viewer on public.portfolio_projects
  for select to authenticated
  using (
    (select public.has_portfolio_role(portfolio_id, 'viewer'))
    and (select public.has_project_role(project_id, 'viewer'))
  );
-- No insert/update policies: add/remove/reorder only through the RPCs above.

-- ---------------------------------------------------------------------------
-- Hardening: EXECUTE on SECURITY DEFINER trigger functions (same sweep as earlier phases)
-- ---------------------------------------------------------------------------

do $$
declare
  fn regprocedure;
begin
  for fn in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and p.prorettype = 'trigger'::regtype
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
  end loop;
end;
$$;
