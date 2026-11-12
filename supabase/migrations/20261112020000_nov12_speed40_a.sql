-- Nov 12 batch 40 (the rest of AUDIT-1-SPEED-FEEL-NOV12): speed only, nothing a person sees changes.
-- Additive: two new SECURITY INVOKER functions (no table, policy, or existing function changes). The
-- release still on main never calls them, and the app falls back to its old reads while they're missing.
--
-- 1. project_file_page(target_project, max_results) — item 2, the Files tab: the newest files of the
--    project's tasks and their subtasks in one indexed read, instead of every task with its files nested
--    and then the subtasks' files in batches, sorted in the app. Invoker: tasks_select_viewer and
--    task_attachments' own read policy decide exactly as they did for the old reads.
-- 2. workspace_report_groups(filters, tz) — item 3, Reports: the four groupings Overview draws (overall,
--    by project, by person, by section) from one scan of report_task_rows, with workspace_report's own
--    counting rules, as one jsonb value (PostgREST's max_rows can't cut a grouping).

-- ---------------------------------------------------------------------------
-- 1. The Files tab
-- ---------------------------------------------------------------------------
-- A file shows when it isn't removed and its task is a live top-level task with an active membership in
-- the project, or a live subtask of one of the project's tasks (subtasks have no memberships). Newest
-- first (ties by id), at most 500.

create or replace function public.project_file_page(target_project uuid, max_results integer default 500)
returns table (
  id uuid,
  file_name text,
  content_type text,
  size_bytes bigint,
  uploaded_by uuid,
  source text,
  created_at timestamptz,
  task_id uuid,
  task_title text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with tops as (
    select t.id, t.title, t.deleted_at
    from public.task_projects tp
    join public.tasks t on t.id = tp.task_id
    where tp.project_id = target_project and tp.deleted_at is null
  ),
  holders as (
    select tops.id, tops.title from tops where tops.deleted_at is null
    union
    select s.id, s.title
    from public.tasks s
    where s.root_task_id in (select tops.id from tops) and s.deleted_at is null
  )
  select a.id, a.file_name, a.content_type, a.size_bytes, a.uploaded_by, a.source, a.created_at, h.id, h.title
  from holders h
  join public.task_attachments a on a.task_id = h.id
  where a.deleted_at is null
  order by a.created_at desc, a.id
  limit least(greatest(coalesce(max_results, 500), 1), 500);
$$;

comment on function public.project_file_page(uuid, integer) is
  'Nov 12 batch 40: the Files tab''s newest files (tasks of the project and their subtasks), read with the caller''s own access.';

revoke all on function public.project_file_page(uuid, integer) from public, anon;
grant execute on function public.project_file_page(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Reports → Overview's four groupings in one pass
-- ---------------------------------------------------------------------------
-- Each grouping is exactly workspace_report(filters, <grouping>, tz): the same rows (report_task_rows,
-- read once), the same de-duplication (a task once overall and per person; once per project in the
-- project and section groupings), the same counts, and "none" always one row.

create or replace function public.workspace_report_groups(filters jsonb default '{}'::jsonb, tz text default 'UTC')
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with params as (
    select zone, (now() at time zone zone)::date as today
    from (select public.safe_timezone(tz) as zone) z
  ),
  base as materialized (
    select r.project_id, r.section_id, r.task_id, r.assignee_id, r.due_on, r.completed_at
    from public.report_task_rows(filters, tz) r
  ),
  by_task as (
    select distinct b.task_id, b.assignee_id, b.due_on, b.completed_at from base b
  ),
  by_project as (
    select distinct b.project_id, b.task_id, b.assignee_id, b.due_on, b.completed_at from base b
  ),
  by_section as (
    select distinct b.project_id, b.section_id, b.task_id, b.assignee_id, b.due_on, b.completed_at from base b
  ),
  counted as (
    select 'none'::text as grouping, null::uuid as bucket, null::uuid as project_id, c.due_on, c.completed_at from by_task c
    union all
    select 'assignee', c.assignee_id, null, c.due_on, c.completed_at from by_task c
    union all
    select 'project', c.project_id, c.project_id, c.due_on, c.completed_at from by_project c
    union all
    select 'section', c.section_id, c.project_id, c.due_on, c.completed_at from by_section c
  ),
  grouped as (
    select
      c.grouping,
      c.bucket,
      c.project_id,
      count(*) as task_count,
      count(*) filter (where c.completed_at is not null) as completed_count,
      count(*) filter (where c.completed_at is null) as incomplete_count,
      count(*) filter (where c.completed_at is null and c.due_on < p.today) as overdue_count,
      count(*) filter (where c.completed_at is not null and (c.completed_at at time zone p.zone)::date > p.today - 7)
        as completed_recent_count
    from counted c
    cross join params p
    group by c.grouping, c.bucket, c.project_id
    union all
    select 'none', null, null, 0, 0, 0, 0, 0
    where not exists (select 1 from by_task)
  )
  select jsonb_build_object(
    'none', coalesce(jsonb_agg(to_jsonb(g) - 'grouping') filter (where g.grouping = 'none'), '[]'::jsonb),
    'project', coalesce(jsonb_agg(to_jsonb(g) - 'grouping') filter (where g.grouping = 'project'), '[]'::jsonb),
    'assignee', coalesce(jsonb_agg(to_jsonb(g) - 'grouping') filter (where g.grouping = 'assignee'), '[]'::jsonb),
    'section', coalesce(jsonb_agg(to_jsonb(g) - 'grouping') filter (where g.grouping = 'section'), '[]'::jsonb)
  )
  from grouped g;
$$;

comment on function public.workspace_report_groups(jsonb, text) is
  'Nov 12 batch 40: workspace_report''s none / project / assignee / section groupings from one scan, as one jsonb value.';

revoke all on function public.workspace_report_groups(jsonb, text) from public, anon;
grant execute on function public.workspace_report_groups(jsonb, text) to authenticated;
