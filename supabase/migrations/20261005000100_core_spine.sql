-- ALHC Projects — core spine schema.
-- Workspace → Project → Section → Task → Subtask, with task multi-homing via task_projects.
-- Every user-data table has RLS enabled. Deletes are soft (deleted_at); no DELETE policies exist,
-- so hard deletes from the API are rejected by RLS.

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Allowlist
-- ---------------------------------------------------------------------------

create table public.allowed_emails (
  email text primary key check (email = lower(trim(email)) and position('@' in email) > 1),
  note text,
  created_at timestamptz not null default now()
);

create or replace function public.normalize_allowed_email()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.email = lower(trim(new.email));
  return new;
end;
$$;

create trigger allowed_emails_normalize
  before insert or update of email on public.allowed_emails
  for each row execute function public.normalize_allowed_email();

comment on table public.allowed_emails is
  'Emails permitted to use the app after Google sign-in. Managed via SQL editor / service role only.';

-- True when the current JWT belongs to a confirmed auth user whose email is allowlisted.
-- SECURITY DEFINER so it can read auth.users and allowed_emails regardless of caller RLS.
create or replace function public.is_allowlisted()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from auth.users u
    join public.allowed_emails a on a.email = lower(u.email)
    where u.id = auth.uid()
      and u.email_confirmed_at is not null
  );
$$;

revoke all on function public.is_allowlisted() from public, anon;
grant execute on function public.is_allowlisted() to authenticated;

-- ---------------------------------------------------------------------------
-- Profiles (mirror of allowlisted auth users for display)
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create or replace function public.sync_profile_for_user(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  select
    u.id,
    lower(u.email),
    coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name'),
    coalesce(u.raw_user_meta_data ->> 'avatar_url', u.raw_user_meta_data ->> 'picture')
  from auth.users u
  join public.allowed_emails a on a.email = lower(u.email)
  where u.id = target_user_id
  on conflict (id) do update
    set email = excluded.email,
        full_name = coalesce(excluded.full_name, public.profiles.full_name),
        avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url);
end;
$$;

revoke all on function public.sync_profile_for_user(uuid) from public, anon, authenticated;

create or replace function public.handle_auth_user_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.sync_profile_for_user(new.id);
  return new;
end;
$$;

create trigger on_auth_user_change
  after insert or update of email, raw_user_meta_data on auth.users
  for each row execute function public.handle_auth_user_change();

-- Backfill a profile when an existing auth user is allowlisted after first sign-in.
create or replace function public.handle_allowed_email_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  matched_user_id uuid;
begin
  select u.id into matched_user_id
  from auth.users u
  where lower(u.email) = new.email;

  if matched_user_id is not null then
    perform public.sync_profile_for_user(matched_user_id);
  end if;
  return new;
end;
$$;

create trigger on_allowed_email_insert
  after insert on public.allowed_emails
  for each row execute function public.handle_allowed_email_insert();

-- ---------------------------------------------------------------------------
-- Workspaces
-- ---------------------------------------------------------------------------

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create trigger workspaces_set_updated_at
  before update on public.workspaces
  for each row execute function public.set_updated_at();

-- Single default workspace for this phase. The app resolves the oldest active workspace.
insert into public.workspaces (id, name)
values ('00000000-0000-4000-8000-000000000001', 'ALHC');

-- ---------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  name text not null check (length(trim(name)) > 0),
  description text,
  sort_order double precision not null default 0,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index projects_workspace_order_idx
  on public.projects (workspace_id, sort_order)
  where deleted_at is null;
create index projects_created_by_idx on public.projects (created_by);

create trigger projects_set_updated_at
  before update on public.projects
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Sections
-- ---------------------------------------------------------------------------

create table public.sections (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  name text not null check (length(trim(name)) > 0),
  sort_order double precision not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  -- Lets task_projects enforce that a membership's section belongs to the same project.
  unique (id, project_id)
);

create index sections_project_order_idx
  on public.sections (project_id, sort_order)
  where deleted_at is null;

create trigger sections_set_updated_at
  before update on public.sections
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------------

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  home_project_id uuid not null references public.projects (id),
  title text not null check (length(trim(title)) > 0),
  notes text,
  completed_at timestamptz,
  assignee_id uuid references public.profiles (id) on delete set null,
  due_on date,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index tasks_home_project_idx on public.tasks (home_project_id) where deleted_at is null;
create index tasks_assignee_idx on public.tasks (assignee_id) where deleted_at is null;
create index tasks_workspace_idx on public.tasks (workspace_id);
create index tasks_created_by_idx on public.tasks (created_by);

create trigger tasks_set_updated_at
  before update on public.tasks
  for each row execute function public.set_updated_at();

-- workspace_id always follows the home project.
create or replace function public.set_task_workspace()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  select p.workspace_id into new.workspace_id
  from public.projects p
  where p.id = new.home_project_id;
  return new;
end;
$$;

create trigger tasks_set_workspace
  before insert or update of home_project_id on public.tasks
  for each row execute function public.set_task_workspace();

-- ---------------------------------------------------------------------------
-- Multi-homing: task_projects
-- One row per (task, project). Section and ordering are per membership, so the same task can sit
-- in different sections/positions in each project it belongs to.
-- ---------------------------------------------------------------------------

create table public.task_projects (
  task_id uuid not null references public.tasks (id),
  project_id uuid not null references public.projects (id),
  section_id uuid,
  sort_order double precision not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (task_id, project_id),
  foreign key (section_id, project_id) references public.sections (id, project_id)
);

create index task_projects_board_idx
  on public.task_projects (project_id, section_id, sort_order)
  where deleted_at is null;
create index task_projects_task_idx
  on public.task_projects (task_id)
  where deleted_at is null;
create index task_projects_section_idx on public.task_projects (section_id);

create trigger task_projects_set_updated_at
  before update on public.task_projects
  for each row execute function public.set_updated_at();

-- Every task always has an active membership in its home project.
create or replace function public.ensure_home_membership()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into public.task_projects (task_id, project_id, sort_order)
  values (
    new.id,
    new.home_project_id,
    coalesce(
      (select max(tp.sort_order) + 1024
       from public.task_projects tp
       where tp.project_id = new.home_project_id and tp.deleted_at is null),
      1024
    )
  )
  on conflict (task_id, project_id) do update
    set deleted_at = null;
  return new;
end;
$$;

create trigger tasks_ensure_home_membership
  after insert or update of home_project_id on public.tasks
  for each row execute function public.ensure_home_membership();

create or replace function public.guard_home_membership()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.deleted_at is not null and old.deleted_at is null and exists (
    select 1 from public.tasks t
    where t.id = new.task_id and t.home_project_id = new.project_id
  ) then
    raise exception 'Cannot remove a task from its home project; change the home project first'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger task_projects_guard_home
  before update of deleted_at on public.task_projects
  for each row execute function public.guard_home_membership();

-- Soft-deleting a section moves its tasks to "no section" in that project.
create or replace function public.release_section_memberships()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    update public.task_projects
    set section_id = null
    where section_id = new.id;
  end if;
  return new;
end;
$$;

create trigger sections_release_memberships
  after update of deleted_at on public.sections
  for each row execute function public.release_section_memberships();

-- ---------------------------------------------------------------------------
-- Subtasks
-- ---------------------------------------------------------------------------

create table public.subtasks (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id),
  title text not null check (length(trim(title)) > 0),
  completed_at timestamptz,
  sort_order double precision not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index subtasks_task_order_idx
  on public.subtasks (task_id, sort_order)
  where deleted_at is null;

create trigger subtasks_set_updated_at
  before update on public.subtasks
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- Phase policy: any allowlisted user can read/create/update all workspace data.
-- No DELETE policies: removal is always an UPDATE of deleted_at.
-- ---------------------------------------------------------------------------

alter table public.allowed_emails enable row level security;
alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.projects enable row level security;
alter table public.sections enable row level security;
alter table public.tasks enable row level security;
alter table public.task_projects enable row level security;
alter table public.subtasks enable row level security;

create policy allowed_emails_select_allowlisted on public.allowed_emails
  for select to authenticated
  using ((select public.is_allowlisted()));

create policy profiles_select_allowlisted on public.profiles
  for select to authenticated
  using ((select public.is_allowlisted()));

create policy profiles_update_own on public.profiles
  for update to authenticated
  using ((select public.is_allowlisted()) and id = (select auth.uid()))
  with check ((select public.is_allowlisted()) and id = (select auth.uid()));

create policy workspaces_select_allowlisted on public.workspaces
  for select to authenticated
  using ((select public.is_allowlisted()));

create policy projects_select_allowlisted on public.projects
  for select to authenticated
  using ((select public.is_allowlisted()));
create policy projects_insert_allowlisted on public.projects
  for insert to authenticated
  with check ((select public.is_allowlisted()));
create policy projects_update_allowlisted on public.projects
  for update to authenticated
  using ((select public.is_allowlisted()))
  with check ((select public.is_allowlisted()));

create policy sections_select_allowlisted on public.sections
  for select to authenticated
  using ((select public.is_allowlisted()));
create policy sections_insert_allowlisted on public.sections
  for insert to authenticated
  with check ((select public.is_allowlisted()));
create policy sections_update_allowlisted on public.sections
  for update to authenticated
  using ((select public.is_allowlisted()))
  with check ((select public.is_allowlisted()));

create policy tasks_select_allowlisted on public.tasks
  for select to authenticated
  using ((select public.is_allowlisted()));
create policy tasks_insert_allowlisted on public.tasks
  for insert to authenticated
  with check ((select public.is_allowlisted()));
create policy tasks_update_allowlisted on public.tasks
  for update to authenticated
  using ((select public.is_allowlisted()))
  with check ((select public.is_allowlisted()));

create policy task_projects_select_allowlisted on public.task_projects
  for select to authenticated
  using ((select public.is_allowlisted()));
create policy task_projects_insert_allowlisted on public.task_projects
  for insert to authenticated
  with check ((select public.is_allowlisted()));
create policy task_projects_update_allowlisted on public.task_projects
  for update to authenticated
  using ((select public.is_allowlisted()))
  with check ((select public.is_allowlisted()));

create policy subtasks_select_allowlisted on public.subtasks
  for select to authenticated
  using ((select public.is_allowlisted()));
create policy subtasks_insert_allowlisted on public.subtasks
  for insert to authenticated
  with check ((select public.is_allowlisted()));
create policy subtasks_update_allowlisted on public.subtasks
  for update to authenticated
  using ((select public.is_allowlisted()))
  with check ((select public.is_allowlisted()));
