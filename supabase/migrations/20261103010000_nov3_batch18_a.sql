-- ALHC Projects — Nov 3 notes, batch 18 (notes 133–139). Additive: no table or column removed, nothing
-- dropped; the release still on main keeps working once this is applied (same rows, same function
-- signatures and grants). No TAIL.
--
-- 135 (performance). Profiled on scripts/perf/seed.sql plus 150 more projects, 25 automations, and
-- 200,000 automation runs (docs/PERF-AUDIT.md, "Nov 3 notes"): the slow page loads all came from row-by-row
-- access checks — every row of tasks, task_projects, and rule_runs called has_project_role / rule_has_role
-- (four nested SECURITY DEFINER functions, ~0.17 ms each), so a page reading 10,000–50,000 rows waited
-- seconds (an Automations page with 200,000 runs over a minute). Same access, decided once per statement:
--
--   viewer_project_ids()  the projects the caller can read (an active membership while allowlisted: exactly
--                         where has_project_role(project, 'viewer') is true) — an InitPlan in the policies.
--   viewer_rule_ids()     the automations of those projects (exactly where rule_has_role(rule, 'viewer') is
--                         true).
--   task_projects_select_viewer, rule_runs_select_viewer, and the active-task branch of tasks_select_viewer
--   compare with those sets instead of calling the role helpers per row. Every other branch is unchanged.
--   task_project_labels (every list outside a project: My tasks, Home, search, Inbox) reads the tasks'
--   memberships by task through the index and checks each project once.
--
-- 138 / 139 (automation feedback): rule_runs joins the Realtime publication, so the app hears the caller's
-- own runs (RLS: Viewers+ of the automation's project) and shows "Automation X moved 3 tasks" at once,
-- whatever made the change (a bulk edit, a date change).
--
-- Both new functions are SECURITY DEFINER (they read project_members / rules without RLS, about the caller
-- only), executable by authenticated, and pinned in suite 60; nothing for anon.

-- =================================================================================================
-- 1. The caller's readable projects and automations, once per statement
-- =================================================================================================

create or replace function public.viewer_project_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  -- has_project_role(p, 'viewer') = allowlisted and an active membership of any role (an archived
  -- project counts every member as Viewer, still a reader). Only the caller's own memberships.
  select coalesce(array_agg(m.project_id), '{}'::uuid[])
  from public.project_members m
  where m.profile_id = auth.uid()
    and m.deleted_at is null
    and public.project_role_rank(m.role) >= 1
    and public.is_allowlisted();
$$;

comment on function public.viewer_project_ids() is
  'Nov 3 notes (batch 18): the projects the caller can read (has_project_role viewer), for read policies evaluated once per statement.';

select public.alhc_revoke_anon_execute(array['viewer_project_ids()']);
revoke all on function public.viewer_project_ids() from public, anon;
grant execute on function public.viewer_project_ids() to authenticated;

create or replace function public.viewer_rule_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  -- rule_has_role(r, 'viewer') = the automation exists and the caller can read its project.
  select coalesce(array_agg(r.id), '{}'::uuid[])
  from public.rules r
  where r.project_id = any (public.viewer_project_ids());
$$;

comment on function public.viewer_rule_ids() is
  'Nov 3 notes (batch 18): the automations whose project the caller can read (rule_has_role viewer), for the rule_runs read policy.';

select public.alhc_revoke_anon_execute(array['viewer_rule_ids()']);
revoke all on function public.viewer_rule_ids() from public, anon;
grant execute on function public.viewer_rule_ids() to authenticated;

-- =================================================================================================
-- 2. The hottest read policies use them (same rows as before)
-- =================================================================================================

alter policy task_projects_select_viewer on public.task_projects
  using (project_id = any ((select public.viewer_project_ids())::uuid[]));

alter policy rule_runs_select_viewer on public.rule_runs
  using (rule_id = any ((select public.viewer_rule_ids())::uuid[]));

-- Only the third branch changes: has_project_role(home_project_id, 'viewer') becomes membership of the
-- caller's readable set (the same boolean); has_task_role still covers a task readable through another
-- of its projects. Subtasks, private tasks, and trashed tasks read exactly as before.
alter policy tasks_select_viewer on public.tasks
  using (
    case
      when root_task_id is not null then (select public.has_task_role(tasks.root_task_id,
        case when tasks.deleted_at is null then 'viewer' else 'editor' end))
      when home_project_id is null then
        ((((select auth.uid()) = created_by) or ((select auth.uid()) = assignee_id)) and (select public.is_allowlisted()))
      when deleted_at is null then
        (tasks.home_project_id = any ((select public.viewer_project_ids())::uuid[])
          or (select public.has_task_role(tasks.id, 'viewer')))
      else
        ((select public.has_project_role(tasks.home_project_id, 'editor')) or (select public.has_task_role(tasks.id, 'editor')))
    end
  );

-- =================================================================================================
-- 3. task_project_labels: memberships by task, each project checked once (same signature and output)
-- =================================================================================================

create or replace function public.task_project_labels(task_ids uuid[])
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  ids uuid[] := (select coalesce(array_agg(distinct x), '{}') from unnest(task_ids[1:2000]) x where x is not null);
  pairs jsonb;
  p record;
  by_project jsonb := '{}'::jsonb;
  result jsonb;
begin
  if cardinality(ids) = 0 then
    return '{}'::jsonb;
  end if;
  -- Nov 3 notes (batch 18, 135): the readable tasks and their top-level tasks first, then those tasks'
  -- memberships (by task, through the index), then each project's access once. The planner used to walk
  -- every membership of every project the caller can read, checking access row by row (~5 s a call on a
  -- 16,000-task workspace). Same rows: the caller's own RLS on tasks, task_projects, and projects, plus
  -- the explicit has_project_role check per project.
  with t as materialized (
    select t.id, coalesce(t.root_task_id, t.id) as root_id
    from public.tasks t
    where t.id = any (ids)
  ),
  m as materialized (
    select tp.task_id, tp.project_id, tp.created_at
    from public.task_projects tp
    where tp.task_id = any (array(select distinct t.root_id from t))
      and tp.deleted_at is null
  ),
  ok as materialized (
    select pj.id, pj.name
    from public.projects pj
    where pj.id = any (array(select distinct m.project_id from m))
      and pj.deleted_at is null
      and public.has_project_role(pj.id, 'viewer')
  )
  select coalesce(jsonb_agg(jsonb_build_object('t', t.id, 'p', m.project_id, 'n', ok.name, 'c', m.created_at)), '[]'::jsonb)
  into pairs
  from t
  join m on m.task_id = t.root_id
  join ok on ok.id = m.project_id;

  -- Each numbering project's own labels, subtasks included (their path in that project).
  for p in
    select x.p as project_id, array_agg(distinct x.t) as tids
    from jsonb_to_recordset(pairs) as x (t uuid, p uuid, n text, c timestamptz)
    join public.request_sequences s on s.project_id = x.p and s.enabled and s.deleted_at is null
    group by x.p
  loop
    by_project := by_project || jsonb_build_object(p.project_id::text, public.task_request_labels_in(p.project_id, p.tids));
  end loop;

  select coalesce(jsonb_object_agg(y.task_id, y.projects), '{}'::jsonb) into result
  from (
    select x.t as task_id,
      jsonb_agg(jsonb_build_object(
        'project_id', x.p,
        'project_name', x.n,
        'label', by_project -> x.p::text -> x.t::text ->> 'label',
        'wrap', by_project -> x.p::text -> x.t::text -> 'wrap'
      ) order by x.c, x.p) as projects
    from jsonb_to_recordset(pairs) as x (t uuid, p uuid, n text, c timestamptz)
    group by x.t
  ) y;
  return result;
end;
$$;

-- =================================================================================================
-- 4. Realtime: the caller's own automation runs (the "Automation X ran" notice; RLS as above)
-- =================================================================================================

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rule_runs'
     ) then
    execute 'alter publication supabase_realtime add table public.rule_runs';
  end if;
end $$;
