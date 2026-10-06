-- ALHC Projects — My Tasks sections and workload.
--
-- No SECURITY DEFINER functions: every new function runs as the caller, so RLS and the existing
-- triggers apply exactly as for any other edit.
--
--   * tasks.assigned_at: when the current assignee was set (null when unassigned, and for tasks
--     assigned before this migration). Stamped by the invoker trigger tasks_17_stamp_assigned_at on
--     every insert/update; clients can't set it.
--
--   * My Tasks sections (Asana style), one set per person:
--       my_task_sections (profile_id, kind, name, sort_order, soft delete)
--         kind = recently_assigned | do_today | do_next_week | do_later (system, seeded lazily by
--         ensure_my_task_sections(); can't be renamed or deleted) | custom (add / rename / delete).
--       my_task_placements (profile_id, task_id, section_id, sort_order, assigned_at)
--         One row per (person, task). A placement counts only while the task is still assigned to
--         that person *by the same assignment*: it stores the task's assigned_at when it was written,
--         and a later reassignment (even back to the same person) changes tasks.assigned_at, so the
--         old placement is ignored and the task lands in Recently assigned again.
--     Own rows only (RLS). A placement must point at a task the person can read and is assigned to.
--     Deleting a custom section moves its placements to the end of Recently assigned.
--
--     RPCs (all invoker):
--       ensure_my_task_sections() -> uuid            seeds the four system sections once; returns the
--                                                    caller's Recently assigned section
--       my_tasks_layout() -> (task_id, section_id, sort_order)
--         Places every open task assigned to the caller without a valid placement at the top of
--         Recently assigned (newest assignment first), then returns the open tasks' placements.
--       place_my_task(target_task, target_section, before_task) -> double precision
--         Midpoint between neighbours (step 1024), reindexing the section when the gap is too small
--         (same approach as place_task).
--       move_my_tasks(target_tasks uuid[], target_section) -> jsonb      bulk "Move to section"
--         ≤ 200 tasks, appended in order; { updated, unchanged, skipped: [{ task_id, title, reason }] }
--       place_my_task_section(target_section, before_section) -> double precision
--       reindex_my_task_section(target_section) / reindex_my_task_sections() -> integer
--
--   * Workload (per project and per portfolio):
--       project_workload(target_project, range_start, range_end, value_field)
--       portfolio_workload(target_portfolio, range_start, range_end, value_field_name)
--         -> (task_id, title, assignee_id, start_on, due_on, value, project_id, can_edit)
--         Open, assigned tasks with a due date whose span (start_on .. due_on, else the due day)
--         overlaps the range (null = unbounded). `value` is the task's value of a number field (by
--         id in a project; by name, case-insensitive, across a portfolio's projects). Invoker, plus an
--         explicit has_project_role(project, 'viewer') per project: a portfolio workload only ever
--         counts tasks of projects the caller can read (portfolio membership never grants access).
--       workload_capacities (project_id | portfolio_id, profile_id, weekly_capacity, soft delete)
--         Read Viewer+, write Editor+ of the project / portfolio, through
--         set_workload_capacity(target_project, target_portfolio, target_profile, new_capacity)
--         (null clears).

-- ---------------------------------------------------------------------------
-- tasks.assigned_at
-- ---------------------------------------------------------------------------

alter table public.tasks add column assigned_at timestamptz;

-- Runs as the caller; always overrides whatever the client sent.
create or replace function public.stamp_task_assigned_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id then
    new.assigned_at := case when new.assignee_id is not null then now() end;
  else
    new.assigned_at := old.assigned_at;
  end if;
  return new;
end;
$$;

revoke all on function public.stamp_task_assigned_at() from public, anon;
grant execute on function public.stamp_task_assigned_at() to authenticated;

create trigger tasks_17_stamp_assigned_at
  before insert or update on public.tasks
  for each row execute function public.stamp_task_assigned_at();

-- ---------------------------------------------------------------------------
-- My Tasks sections
-- ---------------------------------------------------------------------------

create table public.my_task_sections (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  kind text not null default 'custom'
    check (kind in ('recently_assigned', 'do_today', 'do_next_week', 'do_later', 'custom')),
  name text not null check (char_length(btrim(name)) between 1 and 100),
  sort_order double precision not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- One active system section of each kind per person.
create unique index my_task_sections_kind_idx on public.my_task_sections (profile_id, kind)
  where kind <> 'custom' and deleted_at is null;
create index my_task_sections_profile_idx on public.my_task_sections (profile_id, sort_order)
  where deleted_at is null;

create trigger my_task_sections_set_updated_at
  before update on public.my_task_sections
  for each row execute function public.set_updated_at();

-- Runs as the caller. Sections can't move between people or change kind; system sections keep their
-- name and can't be deleted; a deleted section stays deleted.
create or replace function public.guard_my_task_section()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.profile_id <> old.profile_id or new.kind <> old.kind or new.created_at <> old.created_at then
    raise exception 'My Tasks sections can''t be moved or change kind' using errcode = 'insufficient_privilege';
  end if;
  if old.deleted_at is not null then
    raise exception 'This section was deleted' using errcode = 'check_violation';
  end if;
  if old.kind <> 'custom' and (new.name <> old.name or new.deleted_at is not null) then
    raise exception '“%” can’t be renamed or deleted', old.name using errcode = 'check_violation';
  end if;
  new.name := btrim(new.name);
  return new;
end;
$$;

revoke all on function public.guard_my_task_section() from public, anon;
grant execute on function public.guard_my_task_section() to authenticated;

create trigger my_task_sections_05_guard
  before update on public.my_task_sections
  for each row execute function public.guard_my_task_section();

alter table public.my_task_sections enable row level security;

create policy my_task_sections_select_own on public.my_task_sections
  for select to authenticated
  using (profile_id = (select auth.uid()) and (select public.is_allowlisted()));
create policy my_task_sections_insert_own on public.my_task_sections
  for insert to authenticated
  with check (profile_id = (select auth.uid()) and (select public.is_allowlisted()));
create policy my_task_sections_update_own on public.my_task_sections
  for update to authenticated
  using (profile_id = (select auth.uid()) and (select public.is_allowlisted()))
  with check (profile_id = (select auth.uid()) and (select public.is_allowlisted()));

revoke all on public.my_task_sections from anon;
revoke delete, truncate, references, trigger on public.my_task_sections from authenticated;

-- ---------------------------------------------------------------------------
-- My Tasks placements
-- ---------------------------------------------------------------------------

create table public.my_task_placements (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  task_id uuid not null references public.tasks (id),
  section_id uuid not null references public.my_task_sections (id),
  sort_order double precision not null default 0,
  -- The task's assigned_at when this placement was written; it counts only while they still match.
  assigned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, task_id)
);

create index my_task_placements_section_idx on public.my_task_placements (section_id, sort_order);
create index my_task_placements_task_idx on public.my_task_placements (task_id);

create trigger my_task_placements_set_updated_at
  before update on public.my_task_placements
  for each row execute function public.set_updated_at();

-- Runs as the caller (the owner, by RLS). Insert: the task must be readable, active, and assigned to
-- the owner. Update: task and owner are fixed; assigned_at is refreshed while the task is assigned
-- to the owner and kept otherwise (so a stale placement stays stale). Either way the section must be
-- one of the owner's active sections.
create or replace function public.guard_my_task_placement()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  task_assignee uuid;
  task_assigned_at timestamptz;
  task_deleted timestamptz;
begin
  select t.assignee_id, t.assigned_at, t.deleted_at into task_assignee, task_assigned_at, task_deleted
  from public.tasks t where t.id = new.task_id;
  if tg_op = 'INSERT' then
    if not found or task_deleted is not null then
      raise exception 'Task not found' using errcode = 'no_data_found';
    end if;
    if task_assignee is distinct from new.profile_id then
      raise exception 'Only tasks assigned to you can be placed in My Tasks' using errcode = 'check_violation';
    end if;
    new.assigned_at := task_assigned_at;
  else
    if new.profile_id <> old.profile_id or new.task_id <> old.task_id or new.created_at <> old.created_at then
      raise exception 'My Tasks placements can''t be moved to another task or person'
        using errcode = 'insufficient_privilege';
    end if;
    if found and task_deleted is null and task_assignee = new.profile_id then
      new.assigned_at := task_assigned_at;
    else
      new.assigned_at := old.assigned_at;
    end if;
  end if;
  if not exists (
    select 1 from public.my_task_sections s
    where s.id = new.section_id and s.profile_id = new.profile_id and s.deleted_at is null
  ) then
    raise exception 'Section not found' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_my_task_placement() from public, anon;
grant execute on function public.guard_my_task_placement() to authenticated;

create trigger my_task_placements_05_guard
  before insert or update on public.my_task_placements
  for each row execute function public.guard_my_task_placement();

alter table public.my_task_placements enable row level security;

create policy my_task_placements_select_own on public.my_task_placements
  for select to authenticated
  using (profile_id = (select auth.uid()) and (select public.is_allowlisted()));
create policy my_task_placements_insert_own_viewer on public.my_task_placements
  for insert to authenticated
  with check (
    profile_id = (select auth.uid())
    and (select public.has_task_role(task_id, 'viewer'))
    and exists (
      select 1 from public.my_task_sections s
      where s.id = section_id and s.profile_id = (select auth.uid()) and s.deleted_at is null
    )
  );
-- No task check here: deleting a section must be able to move placements of tasks the owner can no
-- longer read (they are ignored anyway). The guard keeps task_id fixed.
create policy my_task_placements_update_own on public.my_task_placements
  for update to authenticated
  using (profile_id = (select auth.uid()) and (select public.is_allowlisted()))
  with check (
    profile_id = (select auth.uid())
    and exists (
      select 1 from public.my_task_sections s
      where s.id = section_id and s.profile_id = (select auth.uid()) and s.deleted_at is null
    )
  );

revoke all on public.my_task_placements from anon;
revoke delete, truncate, references, trigger on public.my_task_placements from authenticated;

-- A placement counts when it is the owner's, matches the task's current assignment to the owner, and
-- sits in an active section of the owner.
create or replace function public.my_task_placement_valid(
  placement_profile uuid,
  placement_assigned_at timestamptz,
  task_assignee uuid,
  task_assigned_at timestamptz
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select placement_profile = task_assignee and placement_assigned_at is not distinct from task_assigned_at
$$;

revoke all on function public.my_task_placement_valid(uuid, timestamptz, uuid, timestamptz) from public, anon;
grant execute on function public.my_task_placement_valid(uuid, timestamptz, uuid, timestamptz) to authenticated;

-- Deleting a custom section moves its placements to the end of the owner's Recently assigned.
create or replace function public.on_my_task_section_deleted()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  recent uuid;
  base double precision;
begin
  select s.id into recent
  from public.my_task_sections s
  where s.profile_id = new.profile_id and s.kind = 'recently_assigned' and s.deleted_at is null;
  if recent is null then
    raise exception 'Recently assigned is missing' using errcode = 'check_violation';
  end if;
  select coalesce(max(p.sort_order), 0) into base
  from public.my_task_placements p where p.section_id = recent;
  update public.my_task_placements p
  set section_id = recent, sort_order = base + 1024 * moved.position
  from (
    select x.id, row_number() over (order by x.sort_order, x.created_at, x.id) as position
    from public.my_task_placements x
    where x.section_id = new.id
  ) moved
  where p.id = moved.id;
  return new;
end;
$$;

revoke all on function public.on_my_task_section_deleted() from public, anon;
grant execute on function public.on_my_task_section_deleted() to authenticated;

create trigger my_task_sections_after_delete
  after update of deleted_at on public.my_task_sections
  for each row
  when (old.deleted_at is null and new.deleted_at is not null)
  execute function public.on_my_task_section_deleted();

-- ---------------------------------------------------------------------------
-- My Tasks RPCs
-- ---------------------------------------------------------------------------

-- Seeds the caller's four system sections the first time (and Recently assigned if it is ever
-- missing). Returns the caller's Recently assigned section.
create or replace function public.ensure_my_task_sections()
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  recent uuid;
begin
  if me is null or not public.is_allowlisted() then
    raise exception 'Sign in to use My Tasks' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.my_task_sections s where s.profile_id = me) then
    insert into public.my_task_sections (profile_id, kind, name, sort_order)
    values
      (me, 'recently_assigned', 'Recently assigned', 1024),
      (me, 'do_today', 'Do today', 2048),
      (me, 'do_next_week', 'Do next week', 3072),
      (me, 'do_later', 'Do later', 4096)
    on conflict (profile_id, kind) where kind <> 'custom' and deleted_at is null do nothing;
  end if;
  select s.id into recent
  from public.my_task_sections s
  where s.profile_id = me and s.kind = 'recently_assigned' and s.deleted_at is null;
  if recent is null then
    insert into public.my_task_sections (profile_id, kind, name, sort_order)
    values (me, 'recently_assigned', 'Recently assigned', coalesce((
      select min(s.sort_order) from public.my_task_sections s where s.profile_id = me and s.deleted_at is null
    ), 2048) - 1024)
    on conflict (profile_id, kind) where kind <> 'custom' and deleted_at is null do nothing;
    select s.id into recent
    from public.my_task_sections s
    where s.profile_id = me and s.kind = 'recently_assigned' and s.deleted_at is null;
  end if;
  return recent;
end;
$$;

revoke all on function public.ensure_my_task_sections() from public, anon;
grant execute on function public.ensure_my_task_sections() to authenticated;

-- Gives every open task assigned to the caller without a valid placement one at the top of Recently
-- assigned, newest assignment first. Returns Recently assigned.
create or replace function public.sync_my_task_placements()
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  recent uuid := public.ensure_my_task_sections();
  low double precision;
begin
  select coalesce(min(p.sort_order), 1024) into low
  from public.my_task_placements p
  join public.tasks t on t.id = p.task_id
  where p.section_id = recent
    and p.profile_id = me
    and t.deleted_at is null
    and t.completed_at is null
    and public.my_task_placement_valid(p.profile_id, p.assigned_at, t.assignee_id, t.assigned_at);

  insert into public.my_task_placements (profile_id, task_id, section_id, sort_order)
  select me, fresh.id, recent, low - 1024 * (fresh.total - fresh.position + 1)
  from (
    select t.id,
           row_number() over (order by t.assigned_at desc nulls last, t.created_at desc, t.id) as position,
           count(*) over () as total
    from public.tasks t
    where t.assignee_id = me
      and t.deleted_at is null
      and t.completed_at is null
      and not exists (
        select 1
        from public.my_task_placements p
        join public.my_task_sections s on s.id = p.section_id and s.deleted_at is null
        where p.profile_id = me
          and p.task_id = t.id
          and public.my_task_placement_valid(p.profile_id, p.assigned_at, t.assignee_id, t.assigned_at)
      )
  ) fresh
  on conflict (profile_id, task_id) do update
    set section_id = excluded.section_id, sort_order = excluded.sort_order;
  return recent;
end;
$$;

revoke all on function public.sync_my_task_placements() from public, anon;
grant execute on function public.sync_my_task_placements() to authenticated;

create or replace function public.my_tasks_layout()
returns table (task_id uuid, section_id uuid, sort_order double precision)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform public.sync_my_task_placements();
  return query
    select p.task_id, p.section_id, p.sort_order
    from public.my_task_placements p
    join public.tasks t on t.id = p.task_id
    join public.my_task_sections s on s.id = p.section_id and s.deleted_at is null
    where p.profile_id = auth.uid()
      and t.deleted_at is null
      and t.completed_at is null
      and public.my_task_placement_valid(p.profile_id, p.assigned_at, t.assignee_id, t.assigned_at)
    order by s.sort_order, s.created_at, p.sort_order, p.created_at, p.task_id;
end;
$$;

revoke all on function public.my_tasks_layout() from public, anon;
grant execute on function public.my_tasks_layout() to authenticated;

-- Renumbers the valid placements of one of the caller's sections 1024, 2048, … in current order.
create or replace function public.reindex_my_task_section(target_section uuid)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  changed integer;
begin
  update public.my_task_placements p
  set sort_order = ranked.position * 1024
  from (
    select x.id, row_number() over (order by x.sort_order, x.created_at, x.task_id) as position
    from public.my_task_placements x
    join public.tasks t on t.id = x.task_id
    where x.section_id = target_section
      and x.profile_id = auth.uid()
      and public.my_task_placement_valid(x.profile_id, x.assigned_at, t.assignee_id, t.assigned_at)
  ) ranked
  where p.id = ranked.id and p.sort_order is distinct from ranked.position * 1024;
  get diagnostics changed = row_count;
  return changed;
end;
$$;

revoke all on function public.reindex_my_task_section(uuid) from public, anon;
grant execute on function public.reindex_my_task_section(uuid) to authenticated;

create or replace function public.reindex_my_task_sections()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  changed integer;
begin
  update public.my_task_sections s
  set sort_order = ranked.position * 1024
  from (
    select x.id, row_number() over (order by x.sort_order, x.created_at, x.id) as position
    from public.my_task_sections x
    where x.profile_id = auth.uid() and x.deleted_at is null
  ) ranked
  where s.id = ranked.id and s.sort_order is distinct from ranked.position * 1024;
  get diagnostics changed = row_count;
  return changed;
end;
$$;

revoke all on function public.reindex_my_task_sections() from public, anon;
grant execute on function public.reindex_my_task_sections() to authenticated;

-- Places one of the caller's tasks in one of their sections, before `before_task` (null = end).
-- Neighbours are the open tasks shown in that section.
create or replace function public.place_my_task(target_task uuid, target_section uuid, before_task uuid)
returns double precision
language plpgsql
security invoker
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  next_order double precision;
  prev_order double precision;
  new_order double precision;
  attempt integer;
begin
  perform public.sync_my_task_placements();
  if not exists (
    select 1 from public.my_task_sections s
    where s.id = target_section and s.profile_id = me and s.deleted_at is null
  ) then
    raise exception 'Section not found' using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.tasks t where t.id = target_task and t.assignee_id = me and t.deleted_at is null
  ) then
    raise exception 'Only tasks assigned to you can be placed in My Tasks' using errcode = 'check_violation';
  end if;
  if before_task = target_task then
    raise exception 'A task can’t be placed before itself' using errcode = 'check_violation';
  end if;

  for attempt in 1..2 loop
    if before_task is null then
      select max(p.sort_order) into prev_order
      from public.my_task_placements p
      join public.tasks t on t.id = p.task_id
      where p.section_id = target_section and p.profile_id = me and p.task_id <> target_task
        and t.deleted_at is null and t.completed_at is null
        and public.my_task_placement_valid(p.profile_id, p.assigned_at, t.assignee_id, t.assigned_at);
      new_order := coalesce(prev_order, 0) + 1024;
      exit;
    end if;

    select p.sort_order into next_order
    from public.my_task_placements p
    join public.tasks t on t.id = p.task_id
    where p.task_id = before_task and p.profile_id = me and p.section_id = target_section
      and t.deleted_at is null
      and public.my_task_placement_valid(p.profile_id, p.assigned_at, t.assignee_id, t.assigned_at);
    if not found then
      raise exception 'The task to place it before isn’t in that section' using errcode = 'check_violation';
    end if;

    select max(p.sort_order) into prev_order
    from public.my_task_placements p
    join public.tasks t on t.id = p.task_id
    where p.section_id = target_section and p.profile_id = me
      and p.task_id not in (target_task, before_task)
      and p.sort_order <= next_order
      and t.deleted_at is null and t.completed_at is null
      and public.my_task_placement_valid(p.profile_id, p.assigned_at, t.assignee_id, t.assigned_at);

    if prev_order is null then
      new_order := next_order - 1024;
      exit;
    end if;
    if next_order - prev_order >= public.min_order_gap() then
      new_order := (prev_order + next_order) / 2;
      exit;
    end if;
    perform public.reindex_my_task_section(target_section);
  end loop;

  if new_order is null then
    raise exception 'Couldn’t find a position for the task' using errcode = 'check_violation';
  end if;

  insert into public.my_task_placements (profile_id, task_id, section_id, sort_order)
  values (me, target_task, target_section, new_order)
  on conflict (profile_id, task_id) do update
    set section_id = excluded.section_id, sort_order = excluded.sort_order;
  return new_order;
end;
$$;

revoke all on function public.place_my_task(uuid, uuid, uuid) from public, anon;
grant execute on function public.place_my_task(uuid, uuid, uuid) to authenticated;

create or replace function public.place_my_task_section(target_section uuid, before_section uuid)
returns double precision
language plpgsql
security invoker
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  next_order double precision;
  prev_order double precision;
  new_order double precision;
  attempt integer;
begin
  if not exists (
    select 1 from public.my_task_sections s
    where s.id = target_section and s.profile_id = me and s.deleted_at is null
  ) then
    raise exception 'Section not found' using errcode = 'no_data_found';
  end if;
  if before_section = target_section then
    raise exception 'A section can’t be placed before itself' using errcode = 'check_violation';
  end if;

  for attempt in 1..2 loop
    if before_section is null then
      select max(s.sort_order) into prev_order
      from public.my_task_sections s
      where s.profile_id = me and s.deleted_at is null and s.id <> target_section;
      new_order := coalesce(prev_order, 0) + 1024;
      exit;
    end if;

    select s.sort_order into next_order
    from public.my_task_sections s
    where s.id = before_section and s.profile_id = me and s.deleted_at is null;
    if not found then
      raise exception 'The section to place it before isn’t one of yours' using errcode = 'check_violation';
    end if;

    select max(s.sort_order) into prev_order
    from public.my_task_sections s
    where s.profile_id = me and s.deleted_at is null
      and s.id not in (target_section, before_section)
      and s.sort_order <= next_order;

    if prev_order is null then
      new_order := next_order - 1024;
      exit;
    end if;
    if next_order - prev_order >= public.min_order_gap() then
      new_order := (prev_order + next_order) / 2;
      exit;
    end if;
    perform public.reindex_my_task_sections();
  end loop;

  if new_order is null then
    raise exception 'Couldn’t find a position for the section' using errcode = 'check_violation';
  end if;

  update public.my_task_sections set sort_order = new_order where id = target_section;
  return new_order;
end;
$$;

revoke all on function public.place_my_task_section(uuid, uuid) from public, anon;
grant execute on function public.place_my_task_section(uuid, uuid) to authenticated;

-- Bulk "Move to section" in My Tasks: appends each task (in the given order) to one of the caller's
-- sections. Partial apply like bulk_update_tasks: a task that isn't readable, is in the Trash, or
-- isn't assigned to the caller is skipped with a reason.
create or replace function public.move_my_tasks(target_tasks uuid[], target_section uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  task_ids uuid[];
  t uuid;
  task_row record;
  current_section uuid;
  base double precision;
  updated jsonb := '[]'::jsonb;
  unchanged jsonb := '[]'::jsonb;
  skipped jsonb := '[]'::jsonb;
begin
  if me is null or not public.is_allowlisted() then
    raise exception 'Sign in to use My Tasks' using errcode = 'insufficient_privilege';
  end if;
  select coalesce(array_agg(id order by first_position), '{}') into task_ids
  from (
    select id, min(position) as first_position
    from unnest(coalesce(target_tasks, '{}')) with ordinality as u(id, position)
    where id is not null
    group by id
  ) d;
  if cardinality(task_ids) = 0 then
    raise exception 'Select at least one task' using errcode = 'invalid_parameter_value';
  end if;
  if cardinality(task_ids) > 200 then
    raise exception 'Bulk edits are limited to 200 tasks at a time' using errcode = 'invalid_parameter_value';
  end if;
  perform public.sync_my_task_placements();
  if not exists (
    select 1 from public.my_task_sections s
    where s.id = target_section and s.profile_id = me and s.deleted_at is null
  ) then
    raise exception 'Section not found' using errcode = 'invalid_parameter_value';
  end if;

  foreach t in array task_ids loop
    select x.title, x.assignee_id, x.assigned_at, x.deleted_at into task_row from public.tasks x where x.id = t;
    if not found then
      skipped := skipped || jsonb_build_object('task_id', t, 'title', null,
        'reason', 'Not found, or you don’t have access to it');
      continue;
    end if;
    if task_row.deleted_at is not null then
      skipped := skipped || jsonb_build_object('task_id', t, 'title', task_row.title, 'reason', 'It’s in the Trash');
      continue;
    end if;
    if task_row.assignee_id is distinct from me then
      skipped := skipped || jsonb_build_object('task_id', t, 'title', task_row.title,
        'reason', 'It isn’t assigned to you');
      continue;
    end if;

    select p.section_id into current_section
    from public.my_task_placements p
    where p.profile_id = me and p.task_id = t
      and public.my_task_placement_valid(p.profile_id, p.assigned_at, task_row.assignee_id, task_row.assigned_at);
    if current_section = target_section then
      unchanged := unchanged || to_jsonb(t);
      continue;
    end if;

    select coalesce(max(p.sort_order), 0) into base
    from public.my_task_placements p
    where p.section_id = target_section and p.profile_id = me;
    insert into public.my_task_placements (profile_id, task_id, section_id, sort_order)
    values (me, t, target_section, base + 1024)
    on conflict (profile_id, task_id) do update
      set section_id = excluded.section_id, sort_order = excluded.sort_order;
    updated := updated || to_jsonb(t);
  end loop;

  return jsonb_build_object('updated', updated, 'unchanged', unchanged, 'skipped', skipped);
end;
$$;

revoke all on function public.move_my_tasks(uuid[], uuid) from public, anon;
grant execute on function public.move_my_tasks(uuid[], uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Workload
-- ---------------------------------------------------------------------------

create or replace function public.project_workload(
  target_project uuid,
  range_start date default null,
  range_end date default null,
  value_field uuid default null
)
returns table (
  task_id uuid,
  title text,
  assignee_id uuid,
  start_on date,
  due_on date,
  value numeric,
  project_id uuid,
  can_edit boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select t.id, t.title, t.assignee_id, t.start_on, t.due_on,
         (select (v.value #>> '{}')::numeric
          from public.task_field_values v
          join public.custom_fields f on f.id = v.field_id
          where v.task_id = t.id and v.field_id = value_field
            and f.project_id = target_project and f.field_type = 'number' and f.deleted_at is null
            and jsonb_typeof(v.value) = 'number'),
         target_project,
         public.has_task_role(t.id, 'editor')
  from public.task_projects tp
  join public.projects pr on pr.id = tp.project_id and pr.deleted_at is null
  join public.tasks t on t.id = tp.task_id
  where tp.project_id = target_project
    and tp.deleted_at is null
    and public.has_project_role(target_project, 'viewer')
    and t.deleted_at is null
    and t.completed_at is null
    and t.assignee_id is not null
    and t.due_on is not null
    and (range_end is null or coalesce(t.start_on, t.due_on) <= range_end)
    and (range_start is null or t.due_on >= range_start)
  order by t.due_on, t.created_at, t.id;
$$;

revoke all on function public.project_workload(uuid, date, date, uuid) from public, anon;
grant execute on function public.project_workload(uuid, date, date, uuid) to authenticated;

-- Tasks of the portfolio's projects the caller can read, each once. project_id = the task's home
-- project when it is one of them, else the first of them in portfolio order.
create or replace function public.portfolio_workload(
  target_portfolio uuid,
  range_start date default null,
  range_end date default null,
  value_field_name text default null
)
returns table (
  task_id uuid,
  title text,
  assignee_id uuid,
  start_on date,
  due_on date,
  value numeric,
  project_id uuid,
  can_edit boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with visible_projects as (
    select pp.project_id, pp.sort_order
    from public.portfolio_projects pp
    join public.portfolios po on po.id = pp.portfolio_id and po.deleted_at is null
    join public.projects pr on pr.id = pp.project_id and pr.deleted_at is null
    where pp.portfolio_id = target_portfolio
      and pp.deleted_at is null
      and public.has_portfolio_role(target_portfolio, 'viewer')
      and public.has_project_role(pp.project_id, 'viewer')
  ),
  picked as (
    select distinct on (t.id) t.id, vp.project_id
    from visible_projects vp
    join public.task_projects tp on tp.project_id = vp.project_id and tp.deleted_at is null
    join public.tasks t on t.id = tp.task_id
    where t.deleted_at is null
      and t.completed_at is null
      and t.assignee_id is not null
      and t.due_on is not null
      and (range_end is null or coalesce(t.start_on, t.due_on) <= range_end)
      and (range_start is null or t.due_on >= range_start)
    order by t.id, (vp.project_id = t.home_project_id) desc, vp.sort_order, vp.project_id
  )
  select t.id, t.title, t.assignee_id, t.start_on, t.due_on,
         (select max((v.value #>> '{}')::numeric)
          from public.task_field_values v
          join public.custom_fields f on f.id = v.field_id
          join visible_projects vp on vp.project_id = f.project_id
          join public.task_projects tp on tp.task_id = t.id and tp.project_id = f.project_id and tp.deleted_at is null
          where v.task_id = t.id
            and nullif(btrim(value_field_name), '') is not null
            and lower(btrim(f.name)) = lower(btrim(value_field_name))
            and f.field_type = 'number' and f.deleted_at is null
            and jsonb_typeof(v.value) = 'number'),
         picked.project_id,
         public.has_task_role(t.id, 'editor')
  from picked
  join public.tasks t on t.id = picked.id
  order by t.due_on, t.created_at, t.id;
$$;

revoke all on function public.portfolio_workload(uuid, date, date, text) from public, anon;
grant execute on function public.portfolio_workload(uuid, date, date, text) to authenticated;

create table public.workload_capacities (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects (id),
  portfolio_id uuid references public.portfolios (id),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  weekly_capacity numeric not null check (weekly_capacity > 0 and weekly_capacity <= 100000),
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint workload_capacities_one_scope check (num_nonnulls(project_id, portfolio_id) = 1)
);

create unique index workload_capacities_project_idx on public.workload_capacities (project_id, profile_id)
  where project_id is not null and deleted_at is null;
create unique index workload_capacities_portfolio_idx on public.workload_capacities (portfolio_id, profile_id)
  where portfolio_id is not null and deleted_at is null;
create index workload_capacities_profile_idx on public.workload_capacities (profile_id);
create index workload_capacities_created_by_idx on public.workload_capacities (created_by);

create trigger workload_capacities_set_updated_at
  before update on public.workload_capacities
  for each row execute function public.set_updated_at();

-- Runs as the caller: rows can't move between scopes or people, created_by is the inserter, and a
-- cleared capacity stays cleared (setting it again adds a row).
create or replace function public.guard_workload_capacity()
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
  if new.project_id is distinct from old.project_id
     or new.portfolio_id is distinct from old.portfolio_id
     or new.profile_id <> old.profile_id
     or new.created_by is distinct from old.created_by
     or new.created_at <> old.created_at then
    raise exception 'Capacity rows can''t be moved' using errcode = 'insufficient_privilege';
  end if;
  if old.deleted_at is not null then
    raise exception 'This capacity was cleared' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_workload_capacity() from public, anon;
grant execute on function public.guard_workload_capacity() to authenticated;

create trigger workload_capacities_05_guard
  before insert or update on public.workload_capacities
  for each row execute function public.guard_workload_capacity();

alter table public.workload_capacities enable row level security;

create policy workload_capacities_select_viewer on public.workload_capacities
  for select to authenticated
  using (
    (project_id is not null and (select public.has_project_role(project_id, 'viewer')))
    or (portfolio_id is not null and (select public.has_portfolio_role(portfolio_id, 'viewer')))
  );
create policy workload_capacities_insert_editor on public.workload_capacities
  for insert to authenticated
  with check (
    (project_id is not null and (select public.has_project_role(project_id, 'editor')))
    or (portfolio_id is not null and (select public.has_portfolio_role(portfolio_id, 'editor')))
  );
create policy workload_capacities_update_editor on public.workload_capacities
  for update to authenticated
  using (
    (project_id is not null and (select public.has_project_role(project_id, 'editor')))
    or (portfolio_id is not null and (select public.has_portfolio_role(portfolio_id, 'editor')))
  )
  with check (
    (project_id is not null and (select public.has_project_role(project_id, 'editor')))
    or (portfolio_id is not null and (select public.has_portfolio_role(portfolio_id, 'editor')))
  );

revoke all on public.workload_capacities from anon;
revoke delete, truncate, references, trigger on public.workload_capacities from authenticated;

-- Sets (or, with null, clears) one person's weekly capacity in a project or a portfolio workload.
-- Units follow whatever the workload measures (tasks, or a number field's value).
create or replace function public.set_workload_capacity(
  target_project uuid,
  target_portfolio uuid,
  target_profile uuid,
  new_capacity numeric
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if num_nonnulls(target_project, target_portfolio) <> 1 then
    raise exception 'Choose a project or a portfolio' using errcode = 'invalid_parameter_value';
  end if;
  if target_project is not null and not public.has_project_role(target_project, 'editor') then
    raise exception 'Your role in this project doesn’t allow that' using errcode = 'insufficient_privilege';
  end if;
  if target_portfolio is not null and not public.has_portfolio_role(target_portfolio, 'editor') then
    raise exception 'Your role in this portfolio doesn’t allow that' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.profiles p where p.id = target_profile) then
    raise exception 'That person doesn’t exist' using errcode = 'invalid_parameter_value';
  end if;
  if new_capacity is not null and (new_capacity <= 0 or new_capacity > 100000) then
    raise exception 'Capacity must be more than 0' using errcode = 'invalid_parameter_value';
  end if;

  if new_capacity is null then
    update public.workload_capacities c
    set deleted_at = now()
    where c.profile_id = target_profile and c.deleted_at is null
      and c.project_id is not distinct from target_project
      and c.portfolio_id is not distinct from target_portfolio;
    return;
  end if;

  update public.workload_capacities c
  set weekly_capacity = new_capacity
  where c.profile_id = target_profile and c.deleted_at is null
    and c.project_id is not distinct from target_project
    and c.portfolio_id is not distinct from target_portfolio;
  if not found then
    insert into public.workload_capacities (project_id, portfolio_id, profile_id, weekly_capacity)
    values (target_project, target_portfolio, target_profile, new_capacity);
  end if;
end;
$$;

revoke all on function public.set_workload_capacity(uuid, uuid, uuid, numeric) from public, anon;
grant execute on function public.set_workload_capacity(uuid, uuid, uuid, numeric) to authenticated;
