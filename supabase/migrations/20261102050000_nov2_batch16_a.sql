-- Nov 2 notes, batch 16 (items 120–126): things that only showed after a delay or a reload.
-- Additive: two new invoker functions and two functions replaced with the same signatures, results, and
-- grants; nothing is renamed or taken away, and there is no tail. The release still on main keeps working:
-- it calls the replaced functions the same way and never calls the new ones.
--
-- What the database gains (the app does the rest):
--   * 123 convert_subtask_to_task(task, project, section, block_parent) (invoker): Convert to main task,
--     and — when asked — make the new task block the task it came from, in one transaction (the same
--     convert_to_task and set_task_dependency checks: Editor on both, no cycles).
--   * 124 subtask_parent_candidates (same signature): "Make a subtask of…"'s list. A blank search now
--     reads the open top-level tasks most recently added to the projects of the task where the caller is
--     an Editor (one role check per project, at most 200 tasks per project through the new index
--     task_projects_project_recent_idx, so a big project answers at once), most recently changed first;
--     a typed search is search_tasks (titles, notes, numbers) narrowed to tasks the caller edits.
--   * 125 preview_dependency_shifts (same signature; apply_dependency_shifts uses it): every dependent a
--     moved task leaves starting too early is pushed — whichever way the predecessor moved — and dates
--     follow the workspace's workweek (Sunday–Thursday by default): a pushed or pulled task starts on a
--     workday, link lags count workdays, and a moved task keeps its length in workdays. Mirrored by
--     src/lib/dependency-plan.ts (the browser's instant Auto-shift); suite zz47 and the unit tests share
--     the vectors. workday_steps(from, to, workweek) counts the workdays in between.
-- No new client SECURITY DEFINER function (suite 60 unchanged); nothing for anon. fire_rules, notify_with,
-- notify_message, and add_story are untouched.

-- ---------------------------------------------------------------------------------------------
-- 125 Workdays between two dates
-- ---------------------------------------------------------------------------------------------

-- Workdays in (from_date, to_date]: 0 when to_date isn't later. Without a workweek (or with all seven
-- days), calendar days. Mirrors workdaySteps() in src/lib/dependency-plan.ts.
create or replace function public.workday_steps(from_date date, to_date date, work_week smallint[])
returns integer
language sql
immutable
set search_path = ''
as $$
  select case
    when from_date is null or to_date is null or to_date <= from_date then 0
    when work_week is null or cardinality(work_week) = 0 or cardinality(work_week) >= 7 then to_date - from_date
    else (
      select count(*)::integer
      from generate_series(from_date + 1, to_date, interval '1 day') g(d)
      where extract(dow from g.d)::smallint = any (work_week)
    )
  end;
$$;

revoke all on function public.workday_steps(date, date, smallint[]) from public, anon;
grant execute on function public.workday_steps(date, date, smallint[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 125 The dependency shift plan
-- ---------------------------------------------------------------------------------------------

create or replace function public.preview_dependency_shifts(moves jsonb, pull_earlier boolean default false)
returns table (task_id uuid, title text, start_on date, due_on date, new_start date, new_due date, shift_days integer, status text, reason text)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  item jsonb;
  src public.tasks;
  t public.tasks;
  pt public.tasks;
  roots uuid[] := '{}';
  ns date;
  nd date;
  node record;
  edge record;
  -- Tasks that move (the given ones and every shifted dependent): id -> old / new start and due.
  moved jsonb := '{}'::jsonb;
  m jsonb;
  ww smallint[];
  cur_start date;
  cur_end date;
  span integer;
  need date;
  floor_start date;
  pull integer;
  old_anchor date;
  new_anchor date;
  asked date;
  required date;
  next_start date;
  next_due date;
begin
  if jsonb_typeof(moves) is distinct from 'array' or jsonb_array_length(moves) not between 1 and 200 then
    raise exception 'Choose 1 to 200 tasks to move' using errcode = 'check_violation';
  end if;
  for item in select value from jsonb_array_elements(moves) loop
    if jsonb_typeof(item) <> 'object' or coalesce(item ->> 'task_id', '') !~* '^[0-9a-f-]{36}$' then
      raise exception 'Each move needs a task_id' using errcode = 'check_violation';
    end if;
    select * into src from public.tasks x where x.id = (item ->> 'task_id')::uuid and x.deleted_at is null;
    continue when not found or src.id = any (roots);
    ns := case when item ? 'start_on' then (item ->> 'start_on')::date else src.start_on end;
    nd := case when item ? 'due_on' then (item ->> 'due_on')::date else src.due_on end;
    if src.kind = 'milestone' then
      ns := null;
    end if;
    -- A move the task itself would refuse moves nothing.
    continue when ns is not null and nd is not null and ns > nd;
    if ww is null then
      select w.work_week into ww from public.workspaces w where w.id = src.workspace_id;
    end if;
    roots := roots || src.id;
    moved := moved || jsonb_build_object(src.id::text, jsonb_build_object(
      'os', case when src.kind = 'milestone' then src.due_on else coalesce(src.start_on, src.due_on) end,
      'od', coalesce(src.due_on, src.start_on),
      'ns', case when src.kind = 'milestone' then nd else coalesce(ns, nd) end,
      'nd', coalesce(nd, ns)
    ));
  end loop;
  if cardinality(roots) = 0 then
    return;
  end if;

  for node in
    with recursive walk (id, depth) as (
      select d.successor_id, 1 from public.task_dependencies d
      where d.predecessor_id = any (roots) and d.deleted_at is null
      union
      select d.successor_id, w.depth + 1 from public.task_dependencies d
      join walk w on d.predecessor_id = w.id
      where d.deleted_at is null and w.depth < 200
    )
    select w.id, max(w.depth) as depth from walk w where not (w.id = any (roots))
    group by w.id order by max(w.depth), w.id
  loop
    select * into t from public.tasks x where x.id = node.id and x.deleted_at is null;
    continue when not found;
    cur_start := case when t.kind = 'milestone' then t.due_on else coalesce(t.start_on, t.due_on) end;
    continue when cur_start is null;
    cur_end := coalesce(t.due_on, cur_start);
    span := public.workday_steps(cur_start, cur_end, ww);

    need := null;
    pull := null;
    floor_start := null;
    for edge in
      select d.predecessor_id, d.kind, d.lag_days from public.task_dependencies d
      where d.successor_id = node.id and d.deleted_at is null
    loop
      m := null;
      if moved ? edge.predecessor_id::text then
        m := moved -> edge.predecessor_id::text;
        if edge.kind in ('start_to_start', 'start_to_finish') then
          old_anchor := (m ->> 'os')::date;
          new_anchor := (m ->> 'ns')::date;
        else
          old_anchor := (m ->> 'od')::date;
          new_anchor := (m ->> 'nd')::date;
        end if;
      else
        select * into pt from public.tasks x where x.id = edge.predecessor_id and x.deleted_at is null;
        continue when not found;
        new_anchor := case when edge.kind in ('start_to_start', 'start_to_finish')
          then case when pt.kind = 'milestone' then pt.due_on else coalesce(pt.start_on, pt.due_on) end
          else coalesce(pt.due_on, pt.start_on) end;
        old_anchor := new_anchor;
      end if;
      continue when new_anchor is null;
      -- The start the link asks for, on a workday (lags count workdays); finish links ask it of the due
      -- date, so the start is the task's length before it.
      asked := public.rule_add_days(public.rule_add_days(new_anchor, edge.lag_days, true, ww), 0, true, ww);
      required := case when edge.kind in ('finish_to_finish', 'start_to_finish')
        then public.rule_add_days(public.rule_add_days(asked, -span, true, ww), 0, true, ww)
        else asked end;
      floor_start := greatest(floor_start, required);
      continue when m is null;
      if required > cur_start then
        -- A moved predecessor leaves this task starting too early: push it, whichever way it moved.
        need := greatest(need, required);
      elsif old_anchor is not null and new_anchor < old_anchor then
        pull := greatest(pull, new_anchor - old_anchor);
      end if;
    end loop;

    if need is not null then
      next_start := need;
    elsif pull_earlier and pull is not null then
      next_start := greatest(public.rule_add_days(cur_start + pull, 0, true, ww), coalesce(floor_start, cur_start + pull));
      continue when next_start >= cur_start;
    else
      continue;
    end if;
    next_due := case
      when t.due_on is null then null
      when t.kind = 'milestone' then next_start
      else public.rule_add_days(next_start, span, true, ww)
    end;

    task_id := t.id;
    title := t.title;
    start_on := t.start_on;
    due_on := t.due_on;
    shift_days := next_start - cur_start;
    if t.completed_at is not null then
      new_start := t.start_on;
      new_due := t.due_on;
      status := 'skipped';
      reason := 'Completed';
    elsif not public.has_task_role(t.id, 'editor') then
      new_start := t.start_on;
      new_due := t.due_on;
      status := 'skipped';
      reason := 'You can’t edit this task';
    else
      new_start := case when t.start_on is null or t.kind = 'milestone' then null else next_start end;
      new_due := next_due;
      status := 'move';
      reason := null;
      moved := moved || jsonb_build_object(t.id::text, jsonb_build_object(
        'os', cur_start, 'od', cur_end,
        'ns', next_start, 'nd', coalesce(next_due, next_start)
      ));
    end if;
    return next;
  end loop;
end;
$$;

revoke all on function public.preview_dependency_shifts(jsonb, boolean) from public, anon;
grant execute on function public.preview_dependency_shifts(jsonb, boolean) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 124 "Make a subtask of…": fast candidates
-- ---------------------------------------------------------------------------------------------

-- Recently added tasks of a project, newest first (the blank list below walks it).
create index if not exists task_projects_project_recent_idx
  on public.task_projects (project_id, created_at desc) where deleted_at is null;

create or replace function public.subtask_parent_candidates(target_task uuid, query text, max_results integer default 30)
returns table (id uuid, title text, parent_task_id uuid, home_project_id uuid, completed_at timestamptz)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  wanted integer := least(greatest(coalesce(max_results, 30), 1), 100);
  needle text := btrim(coalesce(query, ''));
  editable uuid[];
begin
  -- The projects of the task's tree where the caller is an Editor (one role check per project).
  select coalesce(array_agg(distinct tp.project_id), '{}') into editable
  from public.tasks me
  join public.task_projects tp on tp.task_id = coalesce(me.root_task_id, me.id) and tp.deleted_at is null
  join public.projects pj on pj.id = tp.project_id and pj.deleted_at is null
  where me.id = target_task and public.has_project_role(tp.project_id, 'editor');

  if needle = '' then
    -- Before anything is typed: open top-level tasks of those projects, the most recently changed first.
    return query
    select t.id, t.title, t.parent_task_id, (
      select tp2.project_id
      from public.task_projects tp2
      join public.projects pj on pj.id = tp2.project_id and pj.deleted_at is null
      where tp2.task_id = t.id and tp2.deleted_at is null
        and public.has_project_role(tp2.project_id, 'viewer')
      order by tp2.created_at, tp2.project_id
      limit 1
    ), t.completed_at
    from public.tasks t
    where t.id in (
      -- The 200 tasks most recently added to each of those projects (an index walk that stops there), so
      -- the answer takes the same time in a project of 50 tasks or 50,000.
      select r.task_id
      from unnest(editable) e(project_id)
      cross join lateral (
        select tp.task_id
        from public.task_projects tp
        where tp.project_id = e.project_id and tp.deleted_at is null
        order by tp.created_at desc
        limit 200
      ) r
    )
      and t.deleted_at is null
      and t.completed_at is null
      and t.parent_task_id is null
      and t.id <> target_task
    order by t.updated_at desc, t.id
    limit wanted;
    return;
  end if;

  -- A typed search: titles, notes, and numbers (search_tasks), narrowed to tasks the caller edits.
  return query
  select t.id, t.title, t.parent_task_id, (
    select tp2.project_id
    from public.task_projects tp2
    join public.projects pj on pj.id = tp2.project_id and pj.deleted_at is null
    where tp2.task_id = coalesce(t.root_task_id, t.id) and tp2.deleted_at is null
      and public.has_project_role(tp2.project_id, 'viewer')
    order by tp2.created_at, tp2.project_id
    limit 1
  ), t.completed_at
  from public.search_tasks(needle, 100) s
  join public.tasks t on t.id = s.id and t.deleted_at is null
  where t.id <> target_task
    and t.root_task_id is distinct from target_task
    and public.has_task_role(t.id, 'editor')
  order by t.completed_at is not null, t.updated_at desc, t.id
  limit wanted;
end;
$$;

revoke all on function public.subtask_parent_candidates(uuid, text, integer) from public, anon;
grant execute on function public.subtask_parent_candidates(uuid, text, integer) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 123 Convert to main task, optionally blocking the task it came from
-- ---------------------------------------------------------------------------------------------

create or replace function public.convert_subtask_to_task(
  target_task uuid,
  target_project uuid default null,
  target_section uuid default null,
  block_parent boolean default false
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  parent uuid;
  link uuid;
begin
  select x.parent_task_id into parent from public.tasks x where x.id = target_task and x.deleted_at is null;
  if not found then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;
  perform public.convert_to_task(target_task, target_project, target_section);
  if coalesce(block_parent, false) and parent is not null then
    -- The new task blocks the task it came from (finish-to-start, no lag): Editor on both, no cycles.
    link := public.set_task_dependency(target_task, parent, 'finish_to_start', 0);
  end if;
  return jsonb_build_object('task_id', target_task, 'blocks', case when link is not null then parent end, 'dependency_id', link);
end;
$$;

revoke all on function public.convert_subtask_to_task(uuid, uuid, uuid, boolean) from public, anon;
grant execute on function public.convert_subtask_to_task(uuid, uuid, uuid, boolean) to authenticated;
