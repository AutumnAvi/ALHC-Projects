-- Nov 1 notes, batch 9b (items 64 and 65: My Tasks as a simple checklist, and a new Home). Additive: new
-- columns, functions, and asserted patches; nothing is renamed or taken away, and there is no TAIL.
-- Ordered for a chunked apply: new columns first, every function before its callers.
--
-- What the database gains (the app does the rest):
--   * 64 Checked items: profile_preferences.my_tasks_checked ('stay' | 'sink' | 'hide', default 'sink'),
--     what a ticked task does on the person's checklist until the day ends; set_my_tasks_checked (invoker,
--     own row).
--   * 64 "Set a date" prompts: my_task_cards returns date_prompt for an open task with no due date that
--     someone else assigned to the viewer in the last 14 days, until they set a date or say "Not now"
--     (profile_preferences.date_prompt_dismissed, newest 500; dismiss_task_date_prompt, invoker). It also
--     returns start_on, recurring, and assigned_at for the checklist's rows.
--   * 64 Repeat after completion: a recurrence may carry "from_completion": true (normalize_recurrence
--     patched); spawn_next_occurrence (patched) then counts the next date from the day the task was
--     completed instead of from its due date.
--   * 65 Home: home_dashboard(tz) (client definer, pinned in suite 60) returns the viewer's own projects
--     with progress (projects they're a member of: starred first, then where they have the most open
--     work; six at most), and — only for people who lead projects (Owner / Admin of an active project by
--     their own role, or a workspace admin, then over every project they're a member of) — four fixed
--     cards over exactly those projects: team load, late and at-risk work, project health, and what was
--     done this week. Nothing about a project the caller isn't a member of.
-- fire_rules, notify_with, notify_message, and add_story are untouched.

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
-- 1. New columns
-- =================================================================================================

alter table public.profile_preferences add column if not exists my_tasks_checked text not null default 'sink'
  constraint profile_preferences_my_tasks_checked_check check (my_tasks_checked in ('stay', 'sink', 'hide'));
alter table public.profile_preferences add column if not exists date_prompt_dismissed uuid[] not null default '{}'
  constraint profile_preferences_date_prompt_dismissed_check check (cardinality(date_prompt_dismissed) <= 500);
grant insert (my_tasks_checked, date_prompt_dismissed) on public.profile_preferences to authenticated;
grant update (my_tasks_checked, date_prompt_dismissed) on public.profile_preferences to authenticated;

comment on column public.profile_preferences.my_tasks_checked is
  'Nov 1 notes (batch 9b): what a task ticked today does on the person''s My tasks checklist: stay (in '
  'place, struck through), sink (into the collapsed "Done today" group; the default), or hide. Every mode '
  'clears overnight.';
comment on column public.profile_preferences.date_prompt_dismissed is
  'Nov 1 notes (batch 9b): tasks whose "Set a date" prompt the person put away with "Not now" (newest '
  'first, at most 500).';

-- =================================================================================================
-- 2. Preferences (invoker: own row only, RLS)
-- =================================================================================================

create or replace function public.set_my_tasks_checked(mode text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  stored text;
begin
  if auth.uid() is null or not public.is_allowlisted() then
    raise exception 'Sign in to change your settings' using errcode = 'insufficient_privilege';
  end if;
  if mode is null or mode not in ('stay', 'sink', 'hide') then
    raise exception 'Checked items stay, move to Done today, or hide' using errcode = 'check_violation';
  end if;
  insert into public.profile_preferences as p (my_tasks_checked)
  values (mode)
  on conflict (profile_id) do update set my_tasks_checked = excluded.my_tasks_checked
  returning p.my_tasks_checked into stored;
  return stored;
end;
$$;

select public.alhc_revoke_anon_execute(array['set_my_tasks_checked(text)']);
grant execute on function public.set_my_tasks_checked(text) to authenticated;

-- "Not now" on a task's "Set a date" prompt. Only tasks the caller can read (RLS) are remembered.
create or replace function public.dismiss_task_date_prompt(target_task uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_allowlisted() then
    raise exception 'Sign in to change your settings' using errcode = 'insufficient_privilege';
  end if;
  if target_task is null or not exists (select 1 from public.tasks t where t.id = target_task) then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;
  insert into public.profile_preferences as p (date_prompt_dismissed)
  values (array[target_task])
  on conflict (profile_id) do update
    set date_prompt_dismissed = (array[target_task] || array_remove(p.date_prompt_dismissed, target_task))[1:500];
end;
$$;

select public.alhc_revoke_anon_execute(array['dismiss_task_date_prompt(uuid)']);
grant execute on function public.dismiss_task_date_prompt(uuid) to authenticated;

-- =================================================================================================
-- 3. Repeat after completion
-- =================================================================================================

select public.alhc_patch_function(
  'public.normalize_recurrence(jsonb)'::regprocedure,
  $old$where k not in ('freq', 'interval', 'weekdays', 'ends', 'timezone', 'month_day')$old$,
  $new$where k not in ('freq', 'interval', 'weekdays', 'ends', 'timezone', 'month_day', 'from_completion')$new$,
  $old$  return jsonb_strip_nulls(jsonb_build_object($old$,
  $new$  -- Nov 1 notes (batch 9b): repeat counting from the day the task is completed.
  if rule ? 'from_completion' and jsonb_typeof(rule -> 'from_completion') not in ('boolean', 'null') then
    raise exception 'Repeat after completion is on or off' using errcode = 'check_violation';
  end if;

  return jsonb_strip_nulls(jsonb_build_object($new$,
  $old$    'month_day', case when freq in ('monthly', 'yearly') then month_day end
  ));$old$,
  $new$    'month_day', case when freq in ('monthly', 'yearly') then month_day end,
    'from_completion', case when rule -> 'from_completion' = 'true'::jsonb then true end
  ));$new$
);

select public.alhc_patch_function(
  'public.spawn_next_occurrence()'::regprocedure,
  $old$  next_anchor := public.recurrence_next_date(rule, anchor);$old$,
  $new$  -- Nov 1 notes (batch 9b): "repeat after completion" counts from the day the task was completed; the
  -- task's dates then move so its due date lands there (the start keeps its distance).
  next_anchor := public.recurrence_next_date(rule, case
    when rule -> 'from_completion' = 'true'::jsonb then (coalesce(new.completed_at, now()) at time zone rule_tz)::date
    else anchor
  end);$new$,
  $old$  if rule ->> 'freq' in ('monthly', 'yearly') and not rule ? 'month_day' then$old$,
  $new$  if rule ->> 'freq' in ('monthly', 'yearly') and not rule ? 'month_day'
     and rule -> 'from_completion' is distinct from 'true'::jsonb then$new$
);

-- =================================================================================================
-- 4. My tasks cards: start date, repeat, when it was assigned, and the "Set a date" prompt
-- =================================================================================================

select public.alhc_patch_function(
  'public.my_task_cards()'::regprocedure,
  $old$  result jsonb;
begin$old$,
  $new$  result jsonb;
  -- Nov 1 notes (batch 9b): "Set a date" prompts the viewer put away.
  dismissed uuid[] := coalesce((
    select pp.date_prompt_dismissed from public.profile_preferences pp where pp.profile_id = auth.uid()
  ), '{}');
begin$new$,
  $old$    select t.id, t.title, t.completed_at, t.due_on, t.created_at, t.home_project_id,$old$,
  $new$    select t.id, t.title, t.completed_at, t.due_on, t.created_at, t.home_project_id,
           t.start_on, (t.recurrence is not null) as recurring, t.assigned_at, t.created_by,$new$,
  $old$    select l.id, l.title, l.completed_at, l.due_on, l.created_at, l.kind,$old$,
  $new$    select l.id, l.title, l.completed_at, l.due_on, l.created_at, l.kind,
           l.start_on, l.recurring, l.assigned_at,
           -- Someone else gave it to the viewer lately and it has no date yet (a task the viewer made
           -- for themself isn't news).
           (
             l.due_on is null
             and l.completed_at is null
             and l.assigned_at > now() - interval '14 days'
             and not (l.created_by = me and l.assigned_at < l.created_at + interval '1 minute')
             and not (l.id = any (dismissed))
           ) as date_prompt,$new$,
  $old$        'parent_title', k.parent_title$old$,
  $new$        'parent_title', k.parent_title,
        'start_on', k.start_on,
        'recurring', k.recurring,
        'assigned_at', k.assigned_at,
        'date_prompt', k.date_prompt$new$,
  $old$        'parent_title', c.parent_title$old$,
  $new$        'parent_title', c.parent_title,
        'start_on', c.start_on,
        'recurring', c.recurring,
        'assigned_at', c.assigned_at,
        'date_prompt', false$new$
);

-- =================================================================================================
-- 5. Home (65)
-- =================================================================================================

-- The viewer's own Home in one read. SECURITY DEFINER so its counts don't pay a row-level check per task;
-- every project it reads is one the caller has an active membership in (checked here, by their own
-- role), and the lead cards only cover projects they lead (Owner / Admin, not archived), or — for a
-- workspace admin — the projects they're a member of. A workspace admin gets nothing of a project they
-- aren't in.
create or replace function public.home_dashboard(tz text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  zone text := public.safe_timezone(tz);
  today date;
  week_start date;
  week_start_at timestamptz;
  admin boolean;
  lead_ids uuid[];
  projects jsonb;
  lead jsonb;
begin
  if me is null or not public.is_allowlisted() then
    return jsonb_build_object('projects', '[]'::jsonb, 'lead', null);
  end if;
  today := (now() at time zone zone)::date;
  week_start := today - extract(dow from today)::integer;
  week_start_at := week_start::timestamp at time zone zone;
  admin := public.is_workspace_admin(null);

  -- My projects: starred first, then where the viewer has the most open work.
  with mine as (
    select p.id, p.name, p.status, (p.status_updated_at is not null) as status_set,
      exists (
        select 1 from public.project_stars s
        where s.profile_id = me and s.project_id = p.id and s.deleted_at is null
      ) as starred
    from public.project_members m
    join public.projects p on p.id = m.project_id and p.deleted_at is null and p.archived_at is null
    where m.profile_id = me
      and m.deleted_at is null
  ),
  my_open as (
    select tp.project_id, count(distinct t.id) as n
    from public.tasks t
    join public.task_projects tp on tp.task_id = coalesce(t.root_task_id, t.id) and tp.deleted_at is null
    where t.assignee_id = me
      and t.deleted_at is null
      and t.completed_at is null
    group by tp.project_id
  ),
  chosen as (
    select mi.*, coalesce(o.n, 0) as my_open
    from mine mi
    left join my_open o on o.project_id = mi.id
    order by mi.starred desc, coalesce(o.n, 0) desc, mi.name, mi.id
    limit 6
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id,
      'name', c.name,
      'status', c.status,
      'status_set', c.status_set,
      'starred', c.starred,
      'my_open', c.my_open,
      'total', x.total,
      'completed', x.completed,
      'overdue', x.overdue
    ) order by c.starred desc, c.my_open desc, c.name, c.id), '[]'::jsonb)
  into projects
  from chosen c
  cross join lateral (
    select count(*) as total,
      count(*) filter (where t.completed_at is not null) as completed,
      count(*) filter (where t.completed_at is null and t.due_on < today) as overdue
    from public.task_projects tp
    join public.tasks t on t.id = tp.task_id and t.deleted_at is null
    where tp.project_id = c.id
      and tp.deleted_at is null
  ) x;

  -- The projects the lead cards cover.
  select coalesce(array_agg(p.id), '{}') into lead_ids
  from public.project_members m
  join public.projects p on p.id = m.project_id and p.deleted_at is null and p.archived_at is null
  where m.profile_id = me
    and m.deleted_at is null
    and (m.role in ('owner', 'admin') or admin);

  if cardinality(lead_ids) = 0 then
    return jsonb_build_object('projects', projects, 'lead', null);
  end if;

  with roots as materialized (
    select distinct tp.task_id
    from public.task_projects tp
    where tp.project_id = any (lead_ids)
      and tp.deleted_at is null
  ),
  -- Open work and work done this week in those projects: their tasks and the subtasks under them.
  work as materialized (
    select t.id, t.title, t.assignee_id, t.due_on, t.completed_at, t.updated_at, t.id as root_id
    from public.tasks t
    join roots r on r.task_id = t.id
    where t.deleted_at is null
      and (t.completed_at is null or t.completed_at >= week_start_at)
    union all
    select t.id, t.title, t.assignee_id, t.due_on, t.completed_at, t.updated_at, t.root_task_id
    from public.tasks t
    join roots r on r.task_id = t.root_task_id
    where t.deleted_at is null
      and (t.completed_at is null or t.completed_at >= week_start_at)
  ),
  people as (
    select pr.id, coalesce(nullif(btrim(pr.full_name), ''), pr.email) as name
    from public.profiles pr
    where pr.id in (select w.assignee_id from work w where w.assignee_id is not null)
  ),
  load as (
    select w.assignee_id,
      count(*) as open,
      count(*) filter (where w.due_on between today and today + 6) as due_week,
      count(*) filter (where w.due_on < today) as overdue
    from work w
    where w.completed_at is null
      and w.assignee_id is not null
    group by w.assignee_id
  ),
  late as (
    select w.*, (w.due_on < today) as is_overdue
    from work w
    where w.completed_at is null
      and w.due_on is not null
      and (w.due_on < today or (w.due_on <= today + 2 and w.updated_at < now() - interval '3 days'))
  ),
  done as (
    select w.assignee_id, count(*) as n
    from work w
    where w.completed_at is not null
    group by w.assignee_id
  ),
  health as (
    select p.id, p.name, p.status, (p.status_updated_at is not null) as status_set, x.*
    from public.projects p
    cross join lateral (
      select count(*) as total,
        count(*) filter (where t.completed_at is not null) as completed,
        count(*) filter (where t.completed_at is null and t.due_on < today) as overdue,
        count(*) filter (where t.completed_at is not null and t.completed_at >= week_start_at) as done_week
      from public.task_projects tp
      join public.tasks t on t.id = tp.task_id and t.deleted_at is null
      where tp.project_id = p.id
        and tp.deleted_at is null
    ) x
    where p.id = any (lead_ids)
  )
  select jsonb_build_object(
    'project_count', cardinality(lead_ids),
    'workspace_admin', admin,
    'week_start', week_start,
    'load', jsonb_build_object(
      'people', coalesce((
        select jsonb_agg(jsonb_build_object(
          'profile_id', l.assignee_id,
          'name', (select pe.name from people pe where pe.id = l.assignee_id),
          'open', l.open,
          'due_week', l.due_week,
          'overdue', l.overdue
        ) order by l.overdue desc, l.due_week desc, l.open desc, l.assignee_id)
        from (select * from load order by overdue desc, due_week desc, open desc, assignee_id limit 12) l
      ), '[]'::jsonb),
      'people_count', (select count(*) from load),
      'unassigned', (select count(*) from work w where w.completed_at is null and w.assignee_id is null)
    ),
    'late', jsonb_build_object(
      'overdue', (select count(*) from late where is_overdue),
      'at_risk', (select count(*) from late where not is_overdue),
      'tasks', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', x.id,
          'title', x.title,
          'due_on', x.due_on,
          'overdue', x.is_overdue,
          'assignee_id', x.assignee_id,
          'assignee_name', (select pe.name from people pe where pe.id = x.assignee_id),
          'project_id', x.project_id,
          'project_name', (select p.name from public.projects p where p.id = x.project_id)
        ) order by x.is_overdue desc, x.due_on, x.title, x.id)
        from (
          select lt.*, (
            select tp.project_id
            from public.task_projects tp
            where tp.task_id = lt.root_id
              and tp.deleted_at is null
              and tp.project_id = any (lead_ids)
            order by tp.created_at, tp.project_id
            limit 1
          ) as project_id
          from late lt
          order by lt.is_overdue desc, lt.due_on, lt.title, lt.id
          limit 10
        ) x
      ), '[]'::jsonb)
    ),
    'health', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', h.id,
        'name', h.name,
        'status', h.status,
        'status_set', h.status_set,
        'total', h.total,
        'completed', h.completed,
        'overdue', h.overdue,
        'done_week', h.done_week
      ) order by h.overdue desc, h.name, h.id)
      from (select * from health order by overdue desc, name, id limit 12) h
    ), '[]'::jsonb),
    'done', jsonb_build_object(
      'total', (select count(*) from work w where w.completed_at is not null),
      'people', coalesce((
        select jsonb_agg(jsonb_build_object(
          'profile_id', d.assignee_id,
          'name', case when d.assignee_id is null then null else (select pe.name from people pe where pe.id = d.assignee_id) end,
          'count', d.n
        ) order by d.n desc, d.assignee_id nulls last)
        from (select * from done order by n desc, assignee_id nulls last limit 8) d
      ), '[]'::jsonb)
    )
  )
  into lead;

  return jsonb_build_object('projects', projects, 'lead', lead);
end;
$$;

select public.alhc_revoke_anon_execute(array['home_dashboard(text)']);
grant execute on function public.home_dashboard(text) to authenticated;

comment on function public.home_dashboard(text) is
  'Nov 1 notes (batch 9b): Home in one read — the caller''s own projects with progress, and for people '
  'who lead projects four fixed cards (team load, late and at-risk, project health, done this week) over '
  'the projects they lead. Definer; only projects the caller is a member of.';
