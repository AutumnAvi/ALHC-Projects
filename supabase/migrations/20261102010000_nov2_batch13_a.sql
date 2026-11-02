-- Nov 2 notes, batch 13 (items 85–91): portfolios, workload, the Goals switch, and reports. Additive: one
-- new column, one new invoker function, and one asserted patch; nothing is renamed or taken away, and
-- there is no tail.
--
-- What the database gains (the app does the rest):
--   * 88 Goals switch: workspaces.goals_enabled (off by default; workspace admins through the existing
--     workspaces_update_admin policy and a column grant, like tags_enabled). Off only hides goals in the
--     app; every goal, link, and status update is kept. Nothing in the database reads it.
--   * 90 Personal dashboards: creating one failed with 'null value in column "series_interval"' — the
--     app inserted its starter widgets in one request, and a request that names a column for some rows
--     sends null for the others (it doesn't fall back to the column's default). The widget guard now
--     treats a missing interval as 'week' and missing filters as {} (the columns' own defaults) before
--     the NOT NULL checks run; the app sends both on every row too.
--   * 86 Workload people summary: workload_people_summary(project | portfolio, from, to, zone) returns,
--     per assignee, their open and overdue tasks today and the tasks they completed in the period, by
--     local day. SECURITY INVOKER with an explicit has_project_role viewer check per project (a
--     portfolio's projects are its rollup: portfolio_rollup_projects, which only reaches nested
--     portfolios the caller is a member of and projects they can read), so nobody counts a task they
--     couldn't open. Subtasks count through their top-level task's projects, like project_workload.
-- No new client SECURITY DEFINER function (suite 60 unchanged); nothing for anon. fire_rules,
-- notify_with, notify_message, and add_story are untouched.

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

-- =================================================================================================
-- 1. The Goals switch (88)
-- =================================================================================================

alter table public.workspaces add column if not exists goals_enabled boolean not null default false;
-- workspaces_update_admin (workspace admins only) decides who; this column is theirs to change too.
grant update (goals_enabled) on public.workspaces to authenticated;

comment on column public.workspaces.goals_enabled is
  'Nov 2 notes (batch 13): whether the app shows Goals (off by default; Admin console → Organization). Off '
  'hides them everywhere in the app; goals, their links, and status updates are kept.';

-- =================================================================================================
-- 2. Personal dashboard widgets take the column defaults for a missing interval / filter (90)
-- =================================================================================================

select public.alhc_patch_function('public.guard_personal_dashboard_widget()'::regprocedure,
$p$  perform public.validate_report_filters(new.filters);
  new.filters := coalesce(new.filters, '{}'::jsonb);$p$,
$p$  -- Nov 2 notes (batch 13): a request that inserts several widgets sends null for a column some rows
  -- leave out; take the columns' own defaults instead of failing their NOT NULL checks.
  new.series_interval := coalesce(new.series_interval, 'week');
  new.filters := coalesce(new.filters, '{}'::jsonb);
  perform public.validate_report_filters(new.filters);$p$);

-- =================================================================================================
-- 3. Workload: who got what done in a period (86)
-- =================================================================================================

create or replace function public.workload_people_summary(
  target_project uuid,
  target_portfolio uuid,
  range_start date,
  range_end date,
  tz text default 'UTC'
)
returns table (
  assignee_id uuid,
  open_count integer,
  overdue_count integer,
  completed_count integer,
  -- { "YYYY-MM-DD": n } for the local days in the period they completed tasks on.
  completed_days jsonb
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  zone text := public.safe_timezone(tz);
  today date := (now() at time zone public.safe_timezone(tz))::date;
begin
  if num_nonnulls(target_project, target_portfolio) <> 1 then
    raise exception 'Pass a project or a portfolio' using errcode = 'invalid_parameter_value';
  end if;
  if range_start is null or range_end is null or range_start > range_end then
    raise exception 'Choose a period whose start is on or before its end' using errcode = 'check_violation';
  end if;
  if range_end - range_start > 366 then
    raise exception 'Choose a period of at most a year' using errcode = 'check_violation';
  end if;

  return query
  with scope_projects as (
    select pr.id as project_id
    from public.projects pr
    where target_project is not null
      and pr.id = target_project
      and pr.deleted_at is null
      and public.has_project_role(pr.id, 'viewer')
    union
    select r.project_id
    from public.portfolio_rollup_projects(target_portfolio) r
    where target_portfolio is not null
      and public.has_project_role(r.project_id, 'viewer')
  ),
  scoped as (
    select distinct t.id, t.assignee_id, t.completed_at, t.due_on
    from scope_projects sp
    join public.task_projects tp on tp.project_id = sp.project_id and tp.deleted_at is null
    join public.tasks t on t.id = tp.task_id or t.root_task_id = tp.task_id
    where t.deleted_at is null
      and t.assignee_id is not null
  ),
  located as (
    select s.assignee_id, s.completed_at, s.due_on, (s.completed_at at time zone zone)::date as done_on
    from scoped s
  ),
  per_day as (
    select l.assignee_id, l.done_on, count(*)::integer as n
    from located l
    where l.done_on between range_start and range_end
    group by l.assignee_id, l.done_on
  )
  select l.assignee_id,
         (count(*) filter (where l.completed_at is null))::integer,
         (count(*) filter (where l.completed_at is null and l.due_on < today))::integer,
         (count(*) filter (where l.done_on between range_start and range_end))::integer,
         coalesce(
           (select jsonb_object_agg(d.done_on::text, d.n) from per_day d where d.assignee_id = l.assignee_id),
           '{}'::jsonb
         )
  from located l
  group by l.assignee_id
  having count(*) filter (where l.completed_at is null) > 0
      or count(*) filter (where l.done_on between range_start and range_end) > 0
  order by l.assignee_id;
end;
$$;

comment on function public.workload_people_summary(uuid, uuid, date, date, text) is
  'Nov 2 notes (batch 13): per assignee, open and overdue tasks today and tasks completed in a period '
  '(by local day) over a project or a portfolio''s rollup. Invoker; only projects the caller can read.';

revoke all on function public.workload_people_summary(uuid, uuid, date, date, text) from public, anon;
grant execute on function public.workload_people_summary(uuid, uuid, date, date, text) to authenticated;
