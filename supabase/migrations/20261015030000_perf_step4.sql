-- Performance, stage 4: Calendar and Timeline stop building every card.
--
-- project_task_cards still returns one jsonb value for every task in the project, including
-- comment counts. List and Board already page. Calendar only draws the visible month or week
-- (plus the No due date tray). Timeline only draws the visible scale (plus the Unscheduled
-- tray). This function returns those tasks, with the same access rule: one
-- has_project_role(viewer) check, then the view filter. A non-member, including a workspace
-- admin who is not a member, gets [].
--
-- Cards skip the comment, subtask, and approval joins the grid does not show. Field values,
-- tags, and visible finish-to-start blockers stay, so grouping and the blocked-by count match
-- the full card. A database without this function keeps project_task_cards.
--
-- No object is removed. The tail is empty.

-- Whether a task belongs on a calendar or timeline for this window. range_start null means the
-- whole layout (every dated task, plus the undated tray). Internal. Not a client RPC.
create or replace function public.alhc_task_in_schedule(
  schedule text,
  task_start date,
  task_due date,
  task_kind text,
  task_completed timestamp with time zone,
  range_start date,
  range_end date
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when schedule = 'calendar' then
      (
        task_due is not null
        and (
          range_start is null
          or (
            (
              case
                when task_kind = 'milestone' or task_start is null or task_start >= task_due then task_due
                else task_start
              end
            ) <= range_end
            and task_due >= range_start
          )
        )
      )
      or (task_due is null and task_completed is null)
    else
      (
        (task_start is not null or task_due is not null)
        and (
          range_start is null
          or (
            coalesce(task_start, task_due) <= range_end
            and coalesce(task_due, task_start) >= range_start
          )
        )
      )
      or (task_start is null and task_due is null and task_completed is null)
  end;
$$;

revoke all on function public.alhc_task_in_schedule(text, date, date, text, timestamp with time zone, date, date) from public, anon, authenticated;

-- schedule is 'calendar' or 'timeline'. range_start and range_end are inclusive local days
-- (both set, or both null). The default incomplete filter is a direct scan; any other filter
-- goes through filter_project_tasks, so the rows are the ones that viewer would see.
create or replace function public.project_schedule_cards(
  target_project uuid,
  filters jsonb default '{}'::jsonb,
  tz text default 'UTC',
  range_start date default null,
  range_end date default null,
  schedule text default 'timeline'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_fast boolean;
  v_window boolean;
  ids uuid[];
  cards jsonb;
begin
  if target_project is null or not public.has_project_role(target_project, 'viewer') then
    return '[]'::jsonb;
  end if;
  if schedule is distinct from 'calendar' and schedule is distinct from 'timeline' then
    return '[]'::jsonb;
  end if;
  if (range_start is null) <> (range_end is null) or range_start > range_end then
    return '[]'::jsonb;
  end if;

  v_window := range_start is not null;
  v_fast :=
    filters is null
    or filters = '{}'::jsonb
    or (
      jsonb_typeof(filters) = 'object'
      and (select count(*) from jsonb_object_keys(filters)) = 1
      and filters ->> 'completion' = 'incomplete'
    );

  if v_fast then
    select coalesce(array_agg(t.id), '{}'::uuid[])
    into ids
    from public.task_projects tp
    join public.tasks t on t.id = tp.task_id
    where tp.project_id = target_project
      and tp.deleted_at is null
      and t.deleted_at is null
      and t.parent_task_id is null
      and t.completed_at is null
      and public.alhc_task_in_schedule(schedule, t.start_on, t.due_on, t.kind, t.completed_at, range_start, range_end);
  else
    select coalesce(array_agg(t.id), '{}'::uuid[])
    into ids
    from public.filter_project_tasks(target_project, coalesce(filters, '{}'::jsonb), coalesce(nullif(btrim(tz), ''), 'UTC')) f
    join public.tasks t on t.id = f.task_id and t.deleted_at is null
    where public.alhc_task_in_schedule(schedule, t.start_on, t.due_on, t.kind, t.completed_at, range_start, range_end);
  end if;

  if cardinality(ids) = 0 then
    return '[]'::jsonb;
  end if;

  with readable as (
    select m.project_id
    from public.project_members m
    join public.projects p on p.id = m.project_id and p.deleted_at is null
    where m.profile_id = (select auth.uid())
      and m.deleted_at is null
  ),
  member as (
    select tp.task_id, tp.section_id, tp.sort_order,
           t.title, t.completed_at, t.start_on, t.due_on, t.assignee_id,
           coalesce(t.home_project_id, target_project) as home_project_id,
           t.created_at, (t.recurrence is not null) as recurring, t.kind
    from public.task_projects tp
    join public.tasks t on t.id = tp.task_id
    where tp.project_id = target_project
      and tp.deleted_at is null
      and t.deleted_at is null
      and t.id = any (ids)
  ),
  blockers as (
    select d.successor_id as task_id, count(*)::integer as blocked_by
    from public.task_dependencies d
    join member m on m.task_id = d.successor_id
    join public.tasks pred on pred.id = d.predecessor_id
    join public.tasks root on root.id = coalesce(pred.root_task_id, pred.id)
    where d.deleted_at is null
      and d.kind = 'finish_to_start'
      and pred.deleted_at is null
      and pred.completed_at is null
      and root.deleted_at is null
      and (
        (root.home_project_id is null and (select auth.uid()) in (root.created_by, root.assignee_id))
        or exists (
          select 1
          from public.task_projects rtp
          where rtp.task_id = root.id
            and rtp.deleted_at is null
            and rtp.project_id in (select project_id from readable)
        )
      )
    group by d.successor_id
  ),
  fields as (
    select v.task_id, jsonb_object_agg(v.field_id, v.value) as field_values
    from public.task_field_values v
    join public.custom_fields f on f.id = v.field_id
    join member m on m.task_id = v.task_id
    where f.project_id = target_project
      and f.deleted_at is null
      and v.value is not null
    group by v.task_id
  ),
  tags as (
    select tt.task_id, jsonb_agg(tt.tag_id order by tt.tag_id) as tag_ids
    from public.task_tags tt
    join member m on m.task_id = tt.task_id
    join public.tags g on g.id = tt.tag_id and g.deleted_at is null
    where tt.deleted_at is null
    group by tt.task_id
  )
  -- Empty counts, an ordinary task kind, and absent field / tag values are left out.
  -- The app fills those in the same way as a card that never had them.
  select coalesce(jsonb_agg(
    jsonb_strip_nulls(jsonb_build_object(
      'id', m.task_id,
      'title', m.title,
      'completed_at', m.completed_at,
      'start_on', m.start_on,
      'due_on', m.due_on,
      'assignee_id', m.assignee_id,
      'home_project_id', m.home_project_id,
      'created_at', m.created_at,
      'section_id', m.section_id,
      'sort_order', m.sort_order,
      'recurring', case when m.recurring then true end,
      'kind', case when m.kind is distinct from 'task' then m.kind end,
      'blocked_by', nullif(b.blocked_by, 0),
      'field_values', fv.field_values,
      'tag_ids', tg.tag_ids
    ))
    order by m.sort_order, m.task_id
  ), '[]'::jsonb)
  into cards
  from member m
  left join blockers b on b.task_id = m.task_id
  left join fields fv on fv.task_id = m.task_id
  left join tags tg on tg.task_id = m.task_id;

  return cards;
end;
$$;

revoke all on function public.project_schedule_cards(uuid, jsonb, text, date, date, text) from public, anon;
grant execute on function public.project_schedule_cards(uuid, jsonb, text, date, date, text) to authenticated;

select public.alhc_revoke_anon_execute(array[
  'alhc_task_in_schedule(text,date,date,text,timestamp with time zone,date,date)',
  'project_schedule_cards(uuid,jsonb,text,date,date,text)'
]);

-- TAIL
-- Nothing in this phase removes an object.
