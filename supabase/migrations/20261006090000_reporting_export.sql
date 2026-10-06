-- ALHC Projects — Phase: Reporting and export.
-- Workspace-wide reports over every project the caller can read, personal dashboards, and a small
-- subtask hardening. Everything is SECURITY INVOKER (RLS applies, plus an explicit
-- has_project_role(project, 'viewer') per project) except workspace_hidden_project_count(), which
-- returns only a number (like portfolio_hidden_project_count) and is pinned in suite 60. A workspace
-- admin gets nothing extra anywhere: no function here consults is_workspace_admin(). Generic: nothing
-- knows about a team or request type. CSV export and print styles live in the app; they read through
-- these functions and the existing ones with the signed-in user's client.
--
-- Report filter (mirrored by src/lib/reports.ts; validate_report_filters() rejects anything else):
-- {
--   "projects":  [project uuid],            any-of; absent or [] = every project you can read. A listed
--                                           project you can't read contributes nothing (it never widens
--                                           the set), so a widget pointing at one renders empty.
--   "assignees": [profile uuid | "me" | null],  any-of; null = unassigned
--   "from": "YYYY-MM-DD", "to": "YYYY-MM-DD",   inclusive local days (viewer's time zone): a task is in
--                                           the range when its due date or its completion day is
--   "status": "all" | "open" | "completed" | "overdue",  default all; overdue = open and due before today
--   "include_subtasks": boolean             default false; subtasks count through their ROOT task's
--                                           project memberships (and section), never their own
-- }
-- Counting: a task counts once in totals and per assignee; per project / per section it counts in each
-- project it belongs to (the portfolio report's rule). "Completed recently" = completed on one of the
-- last 7 local days, today included.
--
-- New:
--   report_task_rows(filters, tz)                        the filtered (project, task) rows (invoker)
--   workspace_report(filters, group_by, tz)              none | project | assignee | section (invoker)
--   report_completed_series(filters, bucket_interval, tz) completions per local day / week (invoker)
--   report_overdue_tasks(filters, tz, max_results)       overdue list, each task once (invoker)
--   all_projects_report(tz)                              one row per readable project (invoker)
--   workspace_hidden_project_count()                     DEFINER: active projects you can't read (count)
--   personal_dashboards, personal_dashboard_widgets      owner-only RLS, soft delete
--   tasks_05_subtask_parent                              rejects a parent from another workspace

-- ---------------------------------------------------------------------------
-- Report filter validation (invoker; also used by the personal widget guard)
-- ---------------------------------------------------------------------------

create or replace function public.validate_report_filters(filters jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  item jsonb;
begin
  if filters is null or filters = 'null'::jsonb then
    return;
  end if;
  if jsonb_typeof(filters) <> 'object' then
    raise exception 'Report filters must be an object' using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from jsonb_object_keys(filters) k
    where k not in ('projects', 'assignees', 'from', 'to', 'status', 'include_subtasks')
  ) then
    raise exception 'Unknown report filter' using errcode = 'check_violation';
  end if;

  if filters ? 'projects' then
    if jsonb_typeof(filters -> 'projects') <> 'array' or jsonb_array_length(filters -> 'projects') > 100 then
      raise exception 'Project filter must be a list of up to 100 projects' using errcode = 'check_violation';
    end if;
    for item in select value from jsonb_array_elements(filters -> 'projects') loop
      if jsonb_typeof(item) <> 'string'
        or (item #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'Project filter must list project ids' using errcode = 'check_violation';
      end if;
    end loop;
  end if;

  if filters ? 'assignees' then
    if jsonb_typeof(filters -> 'assignees') <> 'array' or jsonb_array_length(filters -> 'assignees') > 100 then
      raise exception 'Assignee filter must be a list of up to 100 people' using errcode = 'check_violation';
    end if;
    for item in select value from jsonb_array_elements(filters -> 'assignees') loop
      if item <> 'null'::jsonb and item <> '"me"'::jsonb and (
        jsonb_typeof(item) <> 'string'
        or (item #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      ) then
        raise exception 'Assignee filter must list people, "me", or null' using errcode = 'check_violation';
      end if;
    end loop;
  end if;

  if filters ? 'from' and not public.is_iso_date(filters ->> 'from') then
    raise exception 'The start of the date range must be a date (YYYY-MM-DD)' using errcode = 'check_violation';
  end if;
  if filters ? 'to' and not public.is_iso_date(filters ->> 'to') then
    raise exception 'The end of the date range must be a date (YYYY-MM-DD)' using errcode = 'check_violation';
  end if;
  if filters ? 'from' and filters ? 'to' and (filters ->> 'from')::date > (filters ->> 'to')::date then
    raise exception 'The date range must start on or before its end' using errcode = 'check_violation';
  end if;

  if filters ? 'status' and coalesce(filters ->> 'status', '') not in ('all', 'open', 'completed', 'overdue') then
    raise exception 'Status filter must be all, open, completed, or overdue' using errcode = 'check_violation';
  end if;
  if filters ? 'include_subtasks' and jsonb_typeof(filters -> 'include_subtasks') <> 'boolean' then
    raise exception 'Include subtasks must be true or false' using errcode = 'check_violation';
  end if;
end;
$$;

revoke all on function public.validate_report_filters(jsonb) from public, anon;
grant execute on function public.validate_report_filters(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Report rows (invoker): one row per (readable project, task) matching the filter
-- ---------------------------------------------------------------------------
-- Top-level tasks come from active task_projects rows of active projects the caller can read (RLS on
-- every table plus an explicit has_project_role check). With include_subtasks, every active subtask of
-- such a task joins with the root's project and section. Invalid filters raise (check_violation).

create or replace function public.report_task_rows(filters jsonb default '{}'::jsonb, tz text default 'UTC')
returns table (
  project_id uuid,
  task_id uuid,
  section_id uuid,
  assignee_id uuid,
  due_on date,
  completed_at timestamptz,
  is_subtask boolean
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  f jsonb := case when jsonb_typeof(filters) = 'object' then filters else '{}'::jsonb end;
  zone text := public.safe_timezone(tz);
  today date := (now() at time zone public.safe_timezone(tz))::date;
  wanted_projects jsonb := public.view_list(f -> 'projects');
  wanted_assignees jsonb := public.view_list(f -> 'assignees');
  range_from date;
  range_to date;
  wanted_status text := coalesce(f ->> 'status', 'all');
  with_subtasks boolean := coalesce(f -> 'include_subtasks' = 'true'::jsonb, false);
  me uuid := auth.uid();
begin
  perform public.validate_report_filters(f);
  range_from := case when f ? 'from' then (f ->> 'from')::date end;
  range_to := case when f ? 'to' then (f ->> 'to')::date end;

  return query
  with readable as (
    select pr.id
    from public.projects pr
    where pr.deleted_at is null
      and (jsonb_array_length(wanted_projects) = 0 or wanted_projects @> jsonb_build_array(pr.id))
      and public.has_project_role(pr.id, 'viewer')
  ),
  top_level as (
    select tp.project_id, t.id as task_id, tp.section_id, t.assignee_id, t.due_on, t.completed_at, false as is_subtask
    from readable r
    join public.task_projects tp on tp.project_id = r.id and tp.deleted_at is null
    join public.tasks t on t.id = tp.task_id and t.deleted_at is null and t.parent_task_id is null
  ),
  everything as (
    select * from top_level
    union all
    select tl.project_id, s.id, tl.section_id, s.assignee_id, s.due_on, s.completed_at, true
    from top_level tl
    join public.tasks s on s.root_task_id = tl.task_id and s.deleted_at is null
    where with_subtasks
  )
  select e.project_id, e.task_id, e.section_id, e.assignee_id, e.due_on, e.completed_at, e.is_subtask
  from everything e
  where (
      jsonb_array_length(wanted_assignees) = 0
      or wanted_assignees @> jsonb_build_array(e.assignee_id)
      or (wanted_assignees @> '["me"]'::jsonb and e.assignee_id = me)
    )
    and (
      (range_from is null and range_to is null)
      or (e.due_on is not null
          and e.due_on >= coalesce(range_from, '-infinity'::date)
          and e.due_on <= coalesce(range_to, 'infinity'::date))
      or (e.completed_at is not null
          and (e.completed_at at time zone zone)::date >= coalesce(range_from, '-infinity'::date)
          and (e.completed_at at time zone zone)::date <= coalesce(range_to, 'infinity'::date))
    )
    and case wanted_status
      when 'open' then e.completed_at is null
      when 'completed' then e.completed_at is not null
      when 'overdue' then e.completed_at is null and e.due_on < today
      else true
    end;
end;
$$;

revoke all on function public.report_task_rows(jsonb, text) from public, anon;
grant execute on function public.report_task_rows(jsonb, text) to authenticated;

comment on function public.report_task_rows(jsonb, text) is
  'Reporting and export: (project, task) rows over every project the caller can read, filtered by the '
  'report filter documented at the top of 20261006090000_reporting_export.sql.';

-- ---------------------------------------------------------------------------
-- workspace_report (invoker): the portfolio report's counts across every readable project
-- ---------------------------------------------------------------------------
--   none      exactly one row (each task once), even when nothing matches
--   project   bucket = project id; a multi-homed task counts in each of its projects
--   assignee  bucket = assignee id (null = unassigned); each task once
--   section   bucket = section id (null = "No section"), project_id = its project; per project

create or replace function public.workspace_report(
  filters jsonb default '{}'::jsonb,
  group_by text default 'none',
  tz text default 'UTC'
)
returns table (
  bucket uuid,
  project_id uuid,
  task_count bigint,
  completed_count bigint,
  incomplete_count bigint,
  overdue_count bigint,
  completed_recent_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with params as (
    select zone, (now() at time zone zone)::date as today
    from (select public.safe_timezone(tz) as zone) z
  ),
  counted as (
    select case when group_by in ('project', 'section') then r.project_id end as project_id,
           case when group_by = 'section' then r.section_id end as section_id,
           r.task_id, r.assignee_id, r.due_on, r.completed_at
    from public.report_task_rows(filters, tz) r
    where group_by in ('none', 'project', 'assignee', 'section')
    group by 1, 2, r.task_id, r.assignee_id, r.due_on, r.completed_at
  )
  select
    case group_by when 'project' then c.project_id when 'assignee' then c.assignee_id when 'section' then c.section_id end,
    case when group_by in ('project', 'section') then c.project_id end,
    count(*),
    count(*) filter (where c.completed_at is not null),
    count(*) filter (where c.completed_at is null),
    count(*) filter (where c.completed_at is null and c.due_on < p.today),
    count(*) filter (where c.completed_at is not null and (c.completed_at at time zone p.zone)::date > p.today - 7)
  from counted c
  cross join params p
  group by 1, 2
  union all
  select null, null, 0, 0, 0, 0, 0
  where group_by = 'none' and not exists (select 1 from counted);
$$;

revoke all on function public.workspace_report(jsonb, text, text) from public, anon;
grant execute on function public.workspace_report(jsonb, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Completed per local day or week (invoker; weeks start on Sunday like the rest of the app)
-- ---------------------------------------------------------------------------
-- The window is the filter's from..to; a missing end is today and a missing start is 30 days (day) or
-- 12 weeks (week) before the end. At most 731 day buckets / 261 week buckets (the start moves up).
-- Every bucket comes back, zeros included. Each task counts once.

create or replace function public.report_completed_series(
  filters jsonb default '{}'::jsonb,
  bucket_interval text default 'day',
  tz text default 'UTC'
)
returns table (bucket_start date, completed_count bigint)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  f jsonb := case when jsonb_typeof(filters) = 'object' then filters else '{}'::jsonb end;
  zone text := public.safe_timezone(tz);
  today date := (now() at time zone public.safe_timezone(tz))::date;
  weekly boolean;
  window_end date;
  window_start date;
begin
  if bucket_interval not in ('day', 'week') then
    raise exception 'Buckets must be day or week' using errcode = 'check_violation';
  end if;
  perform public.validate_report_filters(f);
  weekly := bucket_interval = 'week';
  window_end := coalesce((f ->> 'to')::date, today);
  window_start := coalesce(
    (f ->> 'from')::date,
    case when weekly then window_end - 83 else window_end - 29 end
  );
  if weekly then
    window_start := window_start - extract(dow from window_start)::integer;
    window_start := greatest(window_start, (window_end - extract(dow from window_end)::integer) - 260 * 7);
  else
    window_start := greatest(window_start, window_end - 730);
  end if;

  return query
  with done as (
    select distinct r.task_id, (r.completed_at at time zone zone)::date as day
    from public.report_task_rows(f, tz) r
    where r.completed_at is not null
  ),
  buckets as (
    select g::date as bucket_start
    from generate_series(window_start, window_end, case when weekly then interval '7 days' else interval '1 day' end) g
  )
  select b.bucket_start, count(d.task_id)
  from buckets b
  left join done d
    on d.day >= b.bucket_start
   and d.day < b.bucket_start + case when weekly then 7 else 1 end
   and d.day >= window_start and d.day <= window_end
  group by b.bucket_start
  order by b.bucket_start;
end;
$$;

revoke all on function public.report_completed_series(jsonb, text, text) from public, anon;
grant execute on function public.report_completed_series(jsonb, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Overdue list (invoker): open tasks due before the caller's local today, each task once, labelled
-- with its home project when that is one of the matching readable projects, else the first one.
-- ---------------------------------------------------------------------------

create or replace function public.report_overdue_tasks(
  filters jsonb default '{}'::jsonb,
  tz text default 'UTC',
  max_results integer default 200
)
returns table (
  task_id uuid,
  title text,
  project_id uuid,
  assignee_id uuid,
  due_on date,
  days_overdue integer,
  parent_task_id uuid
)
language sql
stable
security invoker
set search_path = ''
as $$
  with params as (
    select (now() at time zone public.safe_timezone(tz))::date as today
  ),
  overdue as (
    select distinct on (r.task_id) r.task_id, r.project_id, r.assignee_id, r.due_on
    from public.report_task_rows(filters, tz) r
    join public.tasks t on t.id = r.task_id
    cross join params p
    where r.completed_at is null and r.due_on < p.today
    order by r.task_id, (r.project_id = coalesce(t.home_project_id, r.project_id)) desc, r.project_id
  )
  select o.task_id, t.title, o.project_id, o.assignee_id, o.due_on, (p.today - o.due_on)::integer, t.parent_task_id
  from overdue o
  join public.tasks t on t.id = o.task_id
  cross join params p
  order by o.due_on, t.title, o.task_id
  limit greatest(1, least(coalesce(max_results, 200), 10000));
$$;

revoke all on function public.report_overdue_tasks(jsonb, text, integer) from public, anon;
grant execute on function public.report_overdue_tasks(jsonb, text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- All-projects report (invoker): one row per readable project with the portfolio Report columns
-- ---------------------------------------------------------------------------

create or replace function public.all_projects_report(tz text default 'UTC')
returns table (
  project_id uuid,
  name text,
  status text,
  status_note text,
  status_updated_at timestamptz,
  task_count bigint,
  completed_count bigint,
  incomplete_count bigint,
  overdue_count bigint,
  completed_recent_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select pr.id, pr.name, pr.status, pr.status_note, pr.status_updated_at,
         coalesce(w.task_count, 0), coalesce(w.completed_count, 0), coalesce(w.incomplete_count, 0),
         coalesce(w.overdue_count, 0), coalesce(w.completed_recent_count, 0)
  from public.projects pr
  left join public.workspace_report('{}'::jsonb, 'project', tz) w on w.bucket = pr.id
  where pr.deleted_at is null and public.has_project_role(pr.id, 'viewer')
  order by pr.sort_order, pr.created_at, pr.id;
$$;

revoke all on function public.all_projects_report(text) from public, anon;
grant execute on function public.all_projects_report(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Hidden count (the one SECURITY DEFINER function): how many active projects the caller can't read.
-- A number only — never a name or id. Allowlisted callers only (else 0).
-- ---------------------------------------------------------------------------

create or replace function public.workspace_hidden_project_count()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.projects pr
  where public.is_allowlisted()
    and pr.deleted_at is null
    and not public.has_project_role(pr.id, 'viewer');
$$;

revoke all on function public.workspace_hidden_project_count() from public, anon;
grant execute on function public.workspace_hidden_project_count() to authenticated;

-- ---------------------------------------------------------------------------
-- Personal dashboards (owner-only, soft delete)
-- ---------------------------------------------------------------------------

create table public.personal_dashboards (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 100),
  sort_order double precision not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index personal_dashboards_profile_idx on public.personal_dashboards (profile_id, sort_order)
  where deleted_at is null;

comment on table public.personal_dashboards is
  'Reporting and export: a person''s own dashboards. Only the owner reads or writes them (RLS).';

create trigger personal_dashboards_set_updated_at
  before update on public.personal_dashboards
  for each row execute function public.set_updated_at();

create table public.personal_dashboard_widgets (
  id uuid primary key default gen_random_uuid(),
  dashboard_id uuid not null references public.personal_dashboards (id) on delete cascade,
  profile_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  kind text not null
    check (kind in ('count', 'by_section', 'by_assignee', 'by_project', 'completed_series', 'overdue_list')),
  title text not null check (char_length(btrim(title)) between 1 and 100),
  filters jsonb not null default '{}'::jsonb,
  series_interval text not null default 'week' check (series_interval in ('day', 'week')),
  sort_order double precision not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index personal_dashboard_widgets_dashboard_idx on public.personal_dashboard_widgets (dashboard_id, sort_order)
  where deleted_at is null;

comment on table public.personal_dashboard_widgets is
  'Reporting and export: widgets of a personal dashboard (report filter in filters). Owner-only (RLS).';

create trigger personal_dashboard_widgets_set_updated_at
  before update on public.personal_dashboard_widgets
  for each row execute function public.set_updated_at();

-- Runs as the caller. Owner and creation time are fixed; a deleted dashboard stays deleted.
create or replace function public.guard_personal_dashboard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if public.is_client_role() then
      new.profile_id := auth.uid();
      new.created_at := now();
      new.deleted_at := null;
    end if;
  else
    if new.profile_id <> old.profile_id or new.created_at <> old.created_at then
      raise exception 'Dashboards can''t change owner' using errcode = 'insufficient_privilege';
    end if;
    if old.deleted_at is not null then
      raise exception 'This dashboard was deleted' using errcode = 'check_violation';
    end if;
  end if;
  new.name := btrim(new.name);
  return new;
end;
$$;

revoke all on function public.guard_personal_dashboard() from public, anon;
grant execute on function public.guard_personal_dashboard() to authenticated;

create trigger personal_dashboards_05_guard
  before insert or update on public.personal_dashboards
  for each row execute function public.guard_personal_dashboard();

-- Runs as the caller. A widget belongs to an active dashboard the caller can see (their own: RLS), takes
-- the dashboard's owner, never moves, validates its filter, and stays deleted once deleted.
create or replace function public.guard_personal_dashboard_widget()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  owner uuid;
begin
  if tg_op = 'INSERT' then
    select d.profile_id into owner
    from public.personal_dashboards d
    where d.id = new.dashboard_id and d.deleted_at is null;
    if owner is null then
      raise exception 'Dashboard not found' using errcode = 'no_data_found';
    end if;
    new.profile_id := owner;
    if public.is_client_role() then
      new.created_at := now();
      new.deleted_at := null;
    end if;
  else
    if new.dashboard_id <> old.dashboard_id or new.profile_id <> old.profile_id or new.created_at <> old.created_at then
      raise exception 'Widgets can''t move between dashboards' using errcode = 'insufficient_privilege';
    end if;
    if old.deleted_at is not null then
      raise exception 'This widget was removed' using errcode = 'check_violation';
    end if;
  end if;
  perform public.validate_report_filters(new.filters);
  new.filters := coalesce(new.filters, '{}'::jsonb);
  new.title := btrim(new.title);
  return new;
end;
$$;

revoke all on function public.guard_personal_dashboard_widget() from public, anon;
grant execute on function public.guard_personal_dashboard_widget() to authenticated;

create trigger personal_dashboard_widgets_05_guard
  before insert or update on public.personal_dashboard_widgets
  for each row execute function public.guard_personal_dashboard_widget();

alter table public.personal_dashboards enable row level security;
alter table public.personal_dashboard_widgets enable row level security;

create policy personal_dashboards_select_own on public.personal_dashboards
  for select to authenticated
  using (profile_id = (select auth.uid()) and (select public.is_allowlisted()));
create policy personal_dashboards_insert_own on public.personal_dashboards
  for insert to authenticated
  with check (profile_id = (select auth.uid()) and (select public.is_allowlisted()));
create policy personal_dashboards_update_own on public.personal_dashboards
  for update to authenticated
  using (profile_id = (select auth.uid()) and (select public.is_allowlisted()))
  with check (profile_id = (select auth.uid()) and (select public.is_allowlisted()));

create policy personal_dashboard_widgets_select_own on public.personal_dashboard_widgets
  for select to authenticated
  using (profile_id = (select auth.uid()) and (select public.is_allowlisted()));
create policy personal_dashboard_widgets_insert_own on public.personal_dashboard_widgets
  for insert to authenticated
  with check (profile_id = (select auth.uid()) and (select public.is_allowlisted()));
create policy personal_dashboard_widgets_update_own on public.personal_dashboard_widgets
  for update to authenticated
  using (profile_id = (select auth.uid()) and (select public.is_allowlisted()))
  with check (profile_id = (select auth.uid()) and (select public.is_allowlisted()));

revoke all on public.personal_dashboards from anon;
revoke all on public.personal_dashboard_widgets from anon;
revoke delete, truncate, references, trigger on public.personal_dashboards from authenticated;
revoke delete, truncate, references, trigger on public.personal_dashboard_widgets from authenticated;

-- ---------------------------------------------------------------------------
-- Hardening (from Real subtasks): a subtask's parent must be in the subtask's workspace
-- ---------------------------------------------------------------------------
-- Same function as before plus one explicit check: on insert, a workspace or home project the client
-- sent that lies in another workspace than the parent's is rejected (it used to be silently replaced);
-- on a parent change, the new parent must be in the subtask's current workspace.

create or replace function public.guard_task_parent()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  parent public.tasks;
  cur uuid;
  depth integer := 0;
  sent_workspace uuid;
begin
  if tg_op = 'UPDATE' and (old.parent_task_id is null) <> (new.parent_task_id is null) then
    raise exception 'A task can’t become a subtask, or a subtask a task, yet'
      using errcode = 'check_violation', hint = 'Move the subtask under another task instead';
  end if;
  if new.parent_task_id is null then
    new.root_task_id := null;
    return new;
  end if;
  if new.parent_task_id = new.id then
    raise exception 'A task can’t be its own subtask' using errcode = 'check_violation';
  end if;

  select * into parent from public.tasks t where t.id = new.parent_task_id;
  if not found then
    raise exception 'Parent task not found' using errcode = 'no_data_found';
  end if;

  if tg_op = 'INSERT' then
    if new.home_project_id is not null then
      select p.workspace_id into sent_workspace from public.projects p where p.id = new.home_project_id;
    end if;
    if (new.workspace_id is not null and new.workspace_id <> parent.workspace_id)
       or (sent_workspace is not null and sent_workspace <> parent.workspace_id) then
      raise exception 'A subtask must be in its parent task’s workspace' using errcode = 'check_violation';
    end if;
  elsif new.parent_task_id is distinct from old.parent_task_id and old.workspace_id <> parent.workspace_id then
    raise exception 'A subtask must be in its parent task’s workspace' using errcode = 'check_violation';
  end if;

  if tg_op = 'INSERT' or new.parent_task_id is distinct from old.parent_task_id then
    if parent.deleted_at is not null then
      raise exception 'The parent task is in the Trash' using errcode = 'check_violation';
    end if;
    -- Walk up from the parent: a cycle if we meet this task, and count the parent's depth.
    cur := parent.id;
    loop
      if cur = new.id then
        raise exception 'A task can’t be a subtask of its own subtask' using errcode = 'check_violation';
      end if;
      select t.parent_task_id into cur from public.tasks t where t.id = cur;
      exit when cur is null;
      depth := depth + 1;
      exit when depth > 10;
    end loop;
    if depth + 1 + (case when tg_op = 'UPDATE' then coalesce(public.subtask_height(new.id), 0) else 0 end)
       > public.subtask_max_depth() then
      raise exception 'Subtasks can be nested up to % levels deep', public.subtask_max_depth()
        using errcode = 'check_violation';
    end if;
  end if;

  if tg_op = 'UPDATE' and old.deleted_at is not null and new.deleted_at is null and parent.deleted_at is not null then
    raise exception 'Restore the parent task first' using errcode = 'check_violation';
  end if;

  new.root_task_id := coalesce(parent.root_task_id, parent.id);
  new.home_project_id := parent.home_project_id;
  new.workspace_id := parent.workspace_id;
  return new;
end;
$$;

revoke all on function public.guard_task_parent() from public, anon;
grant execute on function public.guard_task_parent() to authenticated;
