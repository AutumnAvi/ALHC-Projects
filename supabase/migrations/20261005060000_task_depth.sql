-- ALHC Projects — Phase: Task depth.
-- Recurring tasks (spawn the next occurrence on completion), optional due/start times, finish-to-start
-- task dependencies with cycle checks, and Trash (restore soft-deleted tasks). Additive only: new
-- columns, one new table, new functions and triggers, and a tighter tasks SELECT policy (trashed tasks
-- are readable by Editors and above only).
--
-- Same rules as earlier phases: soft delete only, no DELETE policies, membership-aware RLS, SECURITY
-- DEFINER functions with search_path = '' and EXECUTE revoked from client roles unless they are
-- intentional RPCs.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
--   due_at / start_at   optional times (timestamptz). due_on / start_on stay the source for Calendar,
--                        Timeline, filters, rules, and forms; a trigger keeps them equal to the local
--                        date of the time in tasks.time_zone.
--   time_zone           IANA zone the times were entered in (UTC when missing or invalid).
--   recurrence          jsonb rule, or null for a one-off task (shape documented above
--                        normalize_recurrence()).
--   recurrence_series_id the first task of the series (null until the first occurrence is spawned).
--   recurrence_seq      1-based occurrence number in the series (used by "ends after N").
--   recurrence_next_id  the occurrence spawned when this one was completed (at most one).

alter table public.tasks
  add column due_at timestamptz,
  add column start_at timestamptz,
  add column time_zone text,
  add column recurrence jsonb,
  add column recurrence_series_id uuid references public.tasks (id),
  add column recurrence_seq integer not null default 1 check (recurrence_seq > 0),
  add column recurrence_next_id uuid references public.tasks (id);

alter table public.tasks
  add constraint tasks_start_at_before_due_at check (start_at is null or due_at is null or start_at <= due_at),
  add constraint tasks_due_at_has_date check (due_at is null or due_on is not null),
  add constraint tasks_start_at_has_date check (start_at is null or start_on is not null);

create index tasks_recurrence_series_idx on public.tasks (recurrence_series_id) where recurrence_series_id is not null;
create index tasks_recurrence_next_idx on public.tasks (recurrence_next_id) where recurrence_next_id is not null;
create index tasks_trash_idx on public.tasks (deleted_at) where deleted_at is not null;

comment on column public.tasks.due_at is
  'Optional due time. due_on is kept equal to its local date in time_zone (trigger tasks_15_sync_times).';
comment on column public.tasks.start_at is
  'Optional start time. start_on is kept equal to its local date in time_zone. start_at <= due_at.';
comment on column public.tasks.recurrence is
  'Recurrence rule (see normalize_recurrence). Completing the task spawns the next occurrence.';

alter table public.task_stories drop constraint task_stories_kind_check;
alter table public.task_stories add constraint task_stories_kind_check check (kind in (
  'created', 'completed', 'reopened', 'renamed', 'assigned', 'unassigned', 'due_changed', 'start_changed',
  'section_changed', 'project_added', 'project_removed', 'attachment_added', 'field_changed',
  'deleted', 'approval_requested', 'approval_decided', 'approval_cancelled', 'approval_resubmitted',
  'form_submitted', 'request_number_assigned', 'email_queued',
  'recurrence_changed', 'recurrence_spawned', 'dependency_added', 'dependency_removed', 'restored'
));

-- ---------------------------------------------------------------------------
-- Times: keep the date parts in sync
-- ---------------------------------------------------------------------------
-- Setting a time sets its date (local date in time_zone). Changing only the date (Calendar or Timeline
-- drag) moves the time to that date at the same local time. Clearing the date clears the time.
-- Clearing only the time keeps the date. The existing date constraint (start_on <= due_on) and
-- tasks_start_at_before_due_at keep start <= due at both levels.

create or replace function public.sync_task_times()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  tz text := public.safe_timezone(new.time_zone);
  zone_changed boolean := tg_op = 'UPDATE' and new.time_zone is distinct from old.time_zone;
begin
  if new.time_zone is not null then
    new.time_zone := tz;
  end if;

  if tg_op = 'INSERT' or new.due_at is distinct from old.due_at or (zone_changed and new.due_at is not null) then
    if new.due_at is not null then
      new.due_on := (new.due_at at time zone tz)::date;
    end if;
  elsif new.due_on is distinct from old.due_on and new.due_at is not null then
    new.due_at := case
      when new.due_on is null then null
      else (new.due_on + (new.due_at at time zone tz)::time) at time zone tz
    end;
  end if;

  if tg_op = 'INSERT' or new.start_at is distinct from old.start_at or (zone_changed and new.start_at is not null) then
    if new.start_at is not null then
      new.start_on := (new.start_at at time zone tz)::date;
    end if;
  elsif new.start_on is distinct from old.start_on and new.start_at is not null then
    new.start_at := case
      when new.start_on is null then null
      else (new.start_on + (new.start_at at time zone tz)::time) at time zone tz
    end;
  end if;
  return new;
end;
$$;

revoke all on function public.sync_task_times() from public, anon, authenticated;

create trigger tasks_15_sync_times
  before insert or update of due_at, start_at, due_on, start_on, time_zone on public.tasks
  for each row execute function public.sync_task_times();

-- ---------------------------------------------------------------------------
-- Recurrence rule
-- ---------------------------------------------------------------------------
--   {
--     "freq":      "daily" | "weekly" | "monthly" | "yearly",
--     "interval":  1–365 (default 1: every day / week / month / year),
--     "weekdays":  [0–6]  weekly only, 0 = Sunday; empty/absent = the anchor's own weekday
--     "ends":      {"type": "never"} | {"type": "after", "count": 1–1000} | {"type": "until", "until": "YYYY-MM-DD"},
--     "timezone":  IANA zone used for "today" when the task has no dates (default UTC),
--     "month_day": 1–31  system-written for monthly/yearly so "the 31st" stays the 31st (clamped to
--                  the month's last day) instead of drifting after a short month
--   }
-- The anchor of an occurrence is its due date, else its start date, else the completion day.

create or replace function public.normalize_recurrence(rule jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  freq text;
  step integer;
  days jsonb := '[]'::jsonb;
  ends jsonb;
  end_type text;
  until_on date;
  count_value integer;
  month_day integer;
begin
  if rule is null or jsonb_typeof(rule) = 'null' then
    return null;
  end if;
  if jsonb_typeof(rule) <> 'object' then
    raise exception 'A recurrence must be an object' using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from jsonb_object_keys(rule) k
    where k not in ('freq', 'interval', 'weekdays', 'ends', 'timezone', 'month_day')
  ) then
    raise exception 'Unknown recurrence setting' using errcode = 'check_violation';
  end if;

  freq := rule ->> 'freq';
  if freq is null or freq not in ('daily', 'weekly', 'monthly', 'yearly') then
    raise exception 'Repeat daily, weekly, monthly, or yearly' using errcode = 'check_violation';
  end if;

  if rule ? 'interval' then
    if jsonb_typeof(rule -> 'interval') <> 'number' or (rule ->> 'interval') !~ '^[0-9]+$' then
      raise exception 'The repeat interval must be a whole number' using errcode = 'check_violation';
    end if;
    step := (rule ->> 'interval')::integer;
  else
    step := 1;
  end if;
  if step < 1 or step > 365 then
    raise exception 'The repeat interval must be between 1 and 365' using errcode = 'check_violation';
  end if;

  if rule ? 'weekdays' and jsonb_typeof(rule -> 'weekdays') <> 'null' then
    if jsonb_typeof(rule -> 'weekdays') <> 'array' or exists (
      select 1 from jsonb_array_elements(rule -> 'weekdays') d
      where jsonb_typeof(d) <> 'number' or d::text !~ '^[0-6]$'
    ) then
      raise exception 'Weekdays are numbers from 0 (Sunday) to 6 (Saturday)' using errcode = 'check_violation';
    end if;
    if freq <> 'weekly' and jsonb_array_length(rule -> 'weekdays') > 0 then
      raise exception 'Weekdays only apply to weekly repeats' using errcode = 'check_violation';
    end if;
    select coalesce(jsonb_agg(distinct d::integer order by d::integer), '[]'::jsonb) into days
    from jsonb_array_elements_text(rule -> 'weekdays') d;
  end if;

  ends := coalesce(rule -> 'ends', '{"type": "never"}'::jsonb);
  if jsonb_typeof(ends) <> 'object' then
    raise exception 'Invalid recurrence end' using errcode = 'check_violation';
  end if;
  end_type := coalesce(ends ->> 'type', 'never');
  if end_type = 'never' then
    ends := '{"type": "never"}'::jsonb;
  elsif end_type = 'after' then
    if jsonb_typeof(ends -> 'count') <> 'number' or (ends ->> 'count') !~ '^[0-9]+$' then
      raise exception 'Say after how many occurrences the task stops repeating' using errcode = 'check_violation';
    end if;
    count_value := (ends ->> 'count')::integer;
    if count_value < 1 or count_value > 1000 then
      raise exception 'A repeat can end after 1 to 1000 occurrences' using errcode = 'check_violation';
    end if;
    ends := jsonb_build_object('type', 'after', 'count', count_value);
  elsif end_type = 'until' then
    begin
      until_on := (ends ->> 'until')::date;
    exception when others then
      until_on := null;
    end;
    if until_on is null or (ends ->> 'until') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'The repeat end date must be YYYY-MM-DD' using errcode = 'check_violation';
    end if;
    ends := jsonb_build_object('type', 'until', 'until', until_on);
  else
    raise exception 'A repeat ends never, after N occurrences, or on a date' using errcode = 'check_violation';
  end if;

  if rule ? 'month_day' and jsonb_typeof(rule -> 'month_day') <> 'null' then
    if jsonb_typeof(rule -> 'month_day') <> 'number' or (rule ->> 'month_day') !~ '^[0-9]+$'
       or (rule ->> 'month_day')::integer not between 1 and 31 then
      raise exception 'Invalid day of month' using errcode = 'check_violation';
    end if;
    month_day := (rule ->> 'month_day')::integer;
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'freq', freq,
    'interval', step,
    'weekdays', case when freq = 'weekly' and jsonb_array_length(days) > 0 then days end,
    'ends', ends,
    'timezone', public.safe_timezone(rule ->> 'timezone'),
    'month_day', case when freq in ('monthly', 'yearly') then month_day end
  ));
end;
$$;

revoke all on function public.normalize_recurrence(jsonb) from public, anon;
grant execute on function public.normalize_recurrence(jsonb) to authenticated;

create or replace function public.validate_task_recurrence()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.recurrence := public.normalize_recurrence(new.recurrence);
  return new;
end;
$$;

revoke all on function public.validate_task_recurrence() from public, anon, authenticated;

create trigger tasks_16_validate_recurrence
  before insert or update of recurrence on public.tasks
  for each row execute function public.validate_task_recurrence();

-- The next anchor date after `anchor` for a normalized rule.
create or replace function public.recurrence_next_date(rule jsonb, anchor date)
returns date
language plpgsql
immutable
set search_path = ''
as $$
declare
  freq text := rule ->> 'freq';
  step integer := coalesce((rule ->> 'interval')::integer, 1);
  days integer[];
  first_week date := anchor - extract(dow from anchor)::integer;
  candidate date;
  target date;
  last_day integer;
  day_of_month integer;
begin
  if freq = 'daily' then
    return anchor + step;
  end if;

  if freq = 'weekly' then
    select array_agg(d::integer) into days from jsonb_array_elements_text(coalesce(rule -> 'weekdays', '[]'::jsonb)) d;
    if days is null then
      return anchor + 7 * step;
    end if;
    -- The first listed weekday after the anchor that falls in a week "every N weeks" from the anchor's.
    for i in 1 .. 7 * step + 7 loop
      candidate := anchor + i;
      if extract(dow from candidate)::integer = any (days)
         and ((candidate - extract(dow from candidate)::integer) - first_week) / 7 % step = 0 then
        return candidate;
      end if;
    end loop;
    return anchor + 7 * step;
  end if;

  target := (date_trunc('month', anchor) + case
    when freq = 'monthly' then make_interval(months => step)
    else make_interval(years => step)
  end)::date;
  if freq = 'yearly' then
    target := make_date(extract(year from target)::integer, extract(month from anchor)::integer, 1);
  end if;
  last_day := extract(day from (target + interval '1 month' - interval '1 day'))::integer;
  day_of_month := coalesce((rule ->> 'month_day')::integer, extract(day from anchor)::integer);
  return target + (least(day_of_month, last_day) - 1);
end;
$$;

revoke all on function public.recurrence_next_date(jsonb, date) from public, anon;
grant execute on function public.recurrence_next_date(jsonb, date) to authenticated;

-- Clients can't write the series bookkeeping (runs as the caller, like guard_task_system_columns).
create or replace function public.guard_task_recurrence_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.is_client_role() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.recurrence_series_id is not null or new.recurrence_next_id is not null or new.recurrence_seq <> 1 then
      raise exception 'Recurring series are managed by the system' using errcode = 'insufficient_privilege';
    end if;
  elsif new.recurrence_series_id is distinct from old.recurrence_series_id
     or new.recurrence_next_id is distinct from old.recurrence_next_id
     or new.recurrence_seq is distinct from old.recurrence_seq then
    raise exception 'Recurring series are managed by the system' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_task_recurrence_columns() from public, anon, authenticated;

create trigger tasks_11_guard_recurrence_columns
  before insert or update on public.tasks
  for each row execute function public.guard_task_recurrence_columns();

create or replace function public.on_task_recurrence_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is null and new.recurrence is distinct from old.recurrence then
    perform public.add_story(new.id, 'recurrence_changed', jsonb_build_object('recurrence', new.recurrence));
  end if;
  return new;
end;
$$;

create trigger tasks_after_update_recurrence
  after update of recurrence on public.tasks
  for each row execute function public.on_task_recurrence_change();

-- Completing a recurring task creates its next occurrence (Asana style): same title, notes, assignee,
-- projects + sections, custom field values, followers, and open (non-approval) subtasks; dates shifted
-- to the next anchor; the same rule with recurrence_seq + 1. Comments, attachments, approvals, and
-- dependencies are not copied. One spawn per occurrence: reopening and completing again does not
-- create a second copy while the first is active. Runs for any completion (person, rule, approval).
create or replace function public.spawn_next_occurrence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  rule jsonb := new.recurrence;
  ends jsonb := coalesce(new.recurrence -> 'ends', '{"type": "never"}'::jsonb);
  rule_tz text := public.safe_timezone(new.recurrence ->> 'timezone');
  time_tz text := public.safe_timezone(new.time_zone);
  anchor date := coalesce(new.due_on, new.start_on, (now() at time zone rule_tz)::date);
  next_anchor date;
  shift integer;
  next_id uuid;
  next_rule jsonb;
  next_title text := new.title;
  label text;
  r record;
begin
  if new.recurrence_next_id is not null and exists (
    select 1 from public.tasks t where t.id = new.recurrence_next_id and t.deleted_at is null
  ) then
    return null;
  end if;
  if ends ->> 'type' = 'after' and new.recurrence_seq >= (ends ->> 'count')::integer then
    return null;
  end if;
  next_anchor := public.recurrence_next_date(rule, anchor);
  if ends ->> 'type' = 'until' and next_anchor > (ends ->> 'until')::date then
    return null;
  end if;
  shift := next_anchor - anchor;

  -- A title prefixed with this task's Req # gets the next occurrence's own number instead.
  if new.req_number is not null then
    label := '[' || public.format_request_label(new.req_project_id, new.req_number) || '] ';
    if left(next_title, length(label)) = label then
      next_title := substr(next_title, length(label) + 1);
    end if;
  end if;

  next_rule := rule;
  if rule ->> 'freq' in ('monthly', 'yearly') and not rule ? 'month_day' then
    next_rule := rule || jsonb_build_object('month_day', extract(day from anchor)::integer);
  end if;

  insert into public.tasks (
    home_project_id, title, notes, assignee_id, start_on, due_on, start_at, due_at, time_zone, created_by,
    recurrence, recurrence_series_id, recurrence_seq
  )
  values (
    new.home_project_id,
    next_title,
    new.notes,
    new.assignee_id,
    new.start_on + shift,
    case when new.due_on is null and new.start_on is null then next_anchor else new.due_on + shift end,
    ((new.start_at at time zone time_tz) + make_interval(days => shift)) at time zone time_tz,
    ((new.due_at at time zone time_tz) + make_interval(days => shift)) at time zone time_tz,
    new.time_zone,
    new.created_by,
    next_rule,
    coalesce(new.recurrence_series_id, new.id),
    new.recurrence_seq + 1
  )
  returning id into next_id;

  -- Same projects and sections (the home membership exists already via ensure_home_membership).
  update public.task_projects tp
  set section_id = src.section_id
  from public.task_projects src
  join public.sections s on s.id = src.section_id and s.deleted_at is null
  where tp.task_id = next_id
    and src.task_id = new.id
    and src.project_id = tp.project_id
    and src.deleted_at is null;

  insert into public.task_projects (task_id, project_id, section_id, sort_order)
  select
    next_id,
    src.project_id,
    (select s.id from public.sections s where s.id = src.section_id and s.deleted_at is null),
    coalesce((select max(x.sort_order) from public.task_projects x
              where x.project_id = src.project_id and x.deleted_at is null), 0) + 1024
  from public.task_projects src
  join public.projects p on p.id = src.project_id and p.deleted_at is null
  where src.task_id = new.id
    and src.deleted_at is null
    and src.project_id <> new.home_project_id
  on conflict (task_id, project_id) do nothing;

  -- Stored custom field values whose field still exists in one of the new task's projects. A value
  -- that no longer validates (e.g. a removed option) is skipped rather than blocking the completion.
  for r in
    select v.field_id, v.value
    from public.task_field_values v
    join public.custom_fields f on f.id = v.field_id and f.deleted_at is null and not f.bound_to_sections
    where v.task_id = new.id
      and v.value is not null
      and jsonb_typeof(v.value) <> 'null'
      and exists (
        select 1 from public.task_projects tp
        where tp.task_id = next_id and tp.project_id = f.project_id and tp.deleted_at is null
      )
  loop
    begin
      insert into public.task_field_values (task_id, field_id, value) values (next_id, r.field_id, r.value);
    exception when check_violation or foreign_key_violation then
      null;
    end;
  end loop;

  insert into public.subtasks (task_id, title, sort_order)
  select next_id, s.title, s.sort_order
  from public.subtasks s
  where s.task_id = new.id
    and s.deleted_at is null
    and not exists (select 1 from public.approval_requests a where a.subtask_id = s.id);

  for r in
    select f.profile_id from public.task_followers f where f.task_id = new.id and f.deleted_at is null
  loop
    perform public.follow_task(next_id, r.profile_id);
  end loop;

  update public.tasks set recurrence_next_id = next_id where id = new.id;
  perform public.add_story(new.id, 'recurrence_spawned', jsonb_build_object(
    'next_task_id', next_id,
    'due_on', (select t.due_on from public.tasks t where t.id = next_id)
  ));
  return null;
end;
$$;

create trigger tasks_after_complete_recur
  after update of completed_at on public.tasks
  for each row
  when (old.completed_at is null and new.completed_at is not null
        and new.recurrence is not null and new.deleted_at is null)
  execute function public.spawn_next_occurrence();

-- ---------------------------------------------------------------------------
-- Dependencies (finish-to-start)
-- ---------------------------------------------------------------------------
-- predecessor → successor: the successor can't be completed while the predecessor is incomplete.
-- Both tasks must share the dependency's project (same-project dependencies only, for now). Written
-- only by add_task_dependency / remove_task_dependency (Editor in that project); readable by the
-- project's viewers. Soft delete keeps the history; re-adding creates a new row.

create table public.task_dependencies (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  predecessor_id uuid not null references public.tasks (id),
  successor_id uuid not null references public.tasks (id),
  kind text not null default 'finish_to_start' check (kind in ('finish_to_start')),
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (predecessor_id <> successor_id)
);

create unique index task_dependencies_active_pair_idx
  on public.task_dependencies (predecessor_id, successor_id)
  where deleted_at is null;
create index task_dependencies_successor_idx on public.task_dependencies (successor_id) where deleted_at is null;
create index task_dependencies_project_idx on public.task_dependencies (project_id) where deleted_at is null;
create index task_dependencies_created_by_idx on public.task_dependencies (created_by);

create trigger task_dependencies_set_updated_at
  before update on public.task_dependencies
  for each row execute function public.set_updated_at();

comment on table public.task_dependencies is
  'Finish-to-start dependencies between tasks of one project. Written only by SECURITY DEFINER RPCs; soft-deleted on removal.';

alter table public.task_dependencies enable row level security;

create policy task_dependencies_select_viewer on public.task_dependencies
  for select to authenticated
  using ((select public.has_project_role(project_id, 'viewer')));
-- No insert/update policies: dependencies change only through the RPCs below.

create or replace function public.add_task_dependency(predecessor uuid, successor uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  shared uuid;
  existing uuid;
  created uuid;
  pred public.tasks;
  succ public.tasks;
begin
  if not public.is_allowlisted() then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  if predecessor is null or successor is null or predecessor = successor then
    raise exception 'A task can''t depend on itself' using errcode = 'check_violation';
  end if;
  select * into pred from public.tasks where id = predecessor and deleted_at is null;
  select * into succ from public.tasks where id = successor and deleted_at is null;
  if pred.id is null or succ.id is null
     or public.task_role(predecessor) is null or public.task_role(successor) is null then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;

  -- A project both tasks are in where the caller is an Editor (the successor's home project first).
  select a.project_id into shared
  from public.task_projects a
  join public.task_projects b on b.project_id = a.project_id and b.task_id = successor and b.deleted_at is null
  join public.projects p on p.id = a.project_id and p.deleted_at is null
  where a.task_id = predecessor
    and a.deleted_at is null
    and public.has_project_role(a.project_id, 'editor')
  order by (a.project_id = succ.home_project_id) desc, (a.project_id = pred.home_project_id) desc, a.project_id
  limit 1;
  if shared is null then
    if exists (
      select 1 from public.task_projects a
      join public.task_projects b on b.project_id = a.project_id and b.task_id = successor and b.deleted_at is null
      where a.task_id = predecessor and a.deleted_at is null
    ) then
      raise exception 'You need Editor access to link these tasks' using errcode = 'insufficient_privilege';
    end if;
    raise exception 'Dependencies can only link tasks in the same project' using errcode = 'check_violation';
  end if;

  -- Serialise dependency writes so two concurrent inserts can't close a cycle between them.
  perform pg_advisory_xact_lock(hashtextextended('alhc.task_dependencies', 0));

  select d.id into existing from public.task_dependencies d
  where d.predecessor_id = predecessor and d.successor_id = successor and d.deleted_at is null;
  if existing is not null then
    return existing;
  end if;

  if exists (
    with recursive downstream (task_id) as (
      select d.successor_id from public.task_dependencies d
      where d.predecessor_id = successor and d.deleted_at is null
      union
      select d.successor_id from public.task_dependencies d
      join downstream x on d.predecessor_id = x.task_id
      where d.deleted_at is null
    )
    select 1 from downstream where task_id = predecessor
  ) then
    raise exception 'That would create a circular dependency' using errcode = 'check_violation';
  end if;

  insert into public.task_dependencies (project_id, predecessor_id, successor_id, created_by)
  values (shared, predecessor, successor, public.current_profile_id())
  returning id into created;

  perform public.add_story(successor, 'dependency_added',
    jsonb_build_object('relation', 'blocked_by', 'task_id', predecessor, 'task_title', pred.title));
  perform public.add_story(predecessor, 'dependency_added',
    jsonb_build_object('relation', 'blocking', 'task_id', successor, 'task_title', succ.title));
  return created;
end;
$$;

revoke all on function public.add_task_dependency(uuid, uuid) from public, anon;
grant execute on function public.add_task_dependency(uuid, uuid) to authenticated;

create or replace function public.remove_task_dependency(target_dependency uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.task_dependencies;
begin
  select * into d from public.task_dependencies where id = target_dependency and deleted_at is null for update;
  if not found or not public.has_project_role(d.project_id, 'viewer') then
    raise exception 'Dependency not found' using errcode = 'no_data_found';
  end if;
  if not public.has_project_role(d.project_id, 'editor') then
    raise exception 'You need Editor access to change dependencies' using errcode = 'insufficient_privilege';
  end if;
  update public.task_dependencies set deleted_at = now() where id = d.id;
  perform public.add_story(d.successor_id, 'dependency_removed', jsonb_build_object(
    'relation', 'blocked_by', 'task_id', d.predecessor_id,
    'task_title', (select t.title from public.tasks t where t.id = d.predecessor_id)));
  perform public.add_story(d.predecessor_id, 'dependency_removed', jsonb_build_object(
    'relation', 'blocking', 'task_id', d.successor_id,
    'task_title', (select t.title from public.tasks t where t.id = d.successor_id)));
end;
$$;

revoke all on function public.remove_task_dependency(uuid) from public, anon;
grant execute on function public.remove_task_dependency(uuid) to authenticated;

-- Number of incomplete, non-deleted predecessors of a task (0 for tasks the caller can't read).
create or replace function public.open_blocker_count(target_task uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.task_role(target_task) is null then 0 else (
    select count(*)::integer
    from public.task_dependencies d
    join public.tasks p on p.id = d.predecessor_id
    where d.successor_id = target_task
      and d.deleted_at is null
      and p.deleted_at is null
      and p.completed_at is null
  ) end;
$$;

revoke all on function public.open_blocker_count(uuid) from public, anon;
grant execute on function public.open_blocker_count(uuid) to authenticated;

-- Blocking rule: people can't complete a task while a predecessor is incomplete. Runs as the caller
-- (like the other task guards), so system completions (rules, approval_completes_task) are not
-- blocked: a dependency is a guard for people, not a reason for an approval decision to fail.
create or replace function public.guard_task_dependencies()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  blockers integer;
begin
  if not public.is_client_role() then
    return new;
  end if;
  blockers := public.open_blocker_count(new.id);
  if blockers > 0 then
    raise exception 'This task is blocked by % incomplete task%', blockers, case when blockers = 1 then '' else 's' end
      using errcode = 'check_violation',
            hint = 'Complete the tasks it waits on first, or remove the dependency';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_task_dependencies() from public, anon, authenticated;

create trigger tasks_12_guard_dependencies
  before update of completed_at on public.tasks
  for each row
  when (old.completed_at is null and new.completed_at is not null)
  execute function public.guard_task_dependencies();

-- ---------------------------------------------------------------------------
-- Trash: trashed tasks are visible to Editors+ only, and restore is an RPC
-- ---------------------------------------------------------------------------
-- Same visibility as before for active tasks. A soft-deleted task is readable only by people who
-- could restore it (Editor or above on its home project or one of its projects), so Viewers and
-- Commenters never see trashed titles through the API either.

drop policy tasks_select_viewer on public.tasks;
create policy tasks_select_viewer on public.tasks
  for select to authenticated
  using (
    case when deleted_at is null then
      (select public.has_project_role(home_project_id, 'viewer')) or (select public.has_task_role(id, 'viewer'))
    else
      (select public.has_project_role(home_project_id, 'editor')) or (select public.has_task_role(id, 'editor'))
    end
  );

create or replace function public.restore_task(target_task uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tasks;
begin
  if not public.has_task_role(target_task, 'editor') then
    raise exception 'You need Editor access to restore this task' using errcode = 'insufficient_privilege';
  end if;
  select * into t from public.tasks where id = target_task for update;
  if not found then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;
  if t.deleted_at is null then
    return;
  end if;
  if exists (select 1 from public.projects p where p.id = t.home_project_id and p.deleted_at is not null) then
    raise exception 'This task''s home project is deleted' using errcode = 'check_violation',
      hint = 'Restore the project or make another project the task''s home first';
  end if;
  update public.tasks set deleted_at = null where id = target_task;
end;
$$;

revoke all on function public.restore_task(uuid) from public, anon;
grant execute on function public.restore_task(uuid) to authenticated;

create or replace function public.on_task_restore()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.add_story(new.id, 'restored', '{}'::jsonb);
  return new;
end;
$$;

create trigger tasks_after_restore
  after update of deleted_at on public.tasks
  for each row
  when (old.deleted_at is not null and new.deleted_at is null)
  execute function public.on_task_restore();

-- ---------------------------------------------------------------------------
-- Hardening: trigger functions are never client RPCs (same sweep as earlier phases)
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
