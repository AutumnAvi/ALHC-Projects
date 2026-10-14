-- Performance, stage 2: My Tasks and the Inbox.
--
-- My Tasks loaded every open task assigned to the viewer, and has_project_role ran once per row
-- (about 0.4 s for 1,700 tasks on the local seed; the section layout did it again). The Inbox
-- unread count did the same for every notification (about 1.3 s for 2,000). These functions check
-- allowlist once, read the viewer's projects once, then return the same rows the screens already
-- show. A person who cannot read a task gets nothing, workspace admins included.
--
-- my_tasks_layout and sync_my_task_placements were invoker. They are definers now for the same
-- reason: the placement sync and the layout read were the slow half of /my-tasks. What they
-- return is unchanged. Pinned in suite 60. Suite 95's "runs as the caller" list no longer names them.
--
-- No tail: nothing here removes an object.

-- ---------------------------------------------------------------------------
-- My Tasks cards (open tasks, and the 30 most recently completed)
-- ---------------------------------------------------------------------------

create or replace function public.my_task_cards()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  result jsonb;
begin
  if me is null or not public.is_allowlisted() then
    return '{"open":[],"completed":[]}'::jsonb;
  end if;

  with readable as materialized (
    select m.project_id
    from public.project_members m
    where m.profile_id = me
      and m.deleted_at is null
  ),
  -- Names the view can show: a removed project stays out of listReadableProjects.
  named as (
    select r.project_id, p.name
    from readable r
    join public.projects p on p.id = r.project_id and p.deleted_at is null
  ),
  assigned as (
    select t.id, t.title, t.completed_at, t.due_on, t.created_at, t.home_project_id,
           t.kind, t.parent_task_id, coalesce(t.root_task_id, t.id) as root_id
    from public.tasks t
    where t.assignee_id = me
      and t.deleted_at is null
      and exists (
        select 1
        from public.tasks root
        where root.id = coalesce(t.root_task_id, t.id)
          and (
            (root.home_project_id is null and me in (root.created_by, root.assignee_id))
            or root.home_project_id in (select project_id from readable)
            or exists (
              select 1
              from public.task_projects tp
              where tp.task_id = root.id
                and tp.deleted_at is null
                and tp.project_id in (select project_id from readable)
            )
          )
      )
  ),
  labelled as (
    select a.*,
      case
        when a.home_project_id is not null and exists (
          select 1 from named n where n.project_id = a.home_project_id
        ) then a.home_project_id
        else (
          select tp.project_id
          from public.task_projects tp
          join named n on n.project_id = tp.project_id
          where tp.task_id = a.root_id
            and tp.deleted_at is null
          order by tp.created_at, tp.project_id
          limit 1
        )
      end as project_id
    from assigned a
  ),
  kept as (
    select l.id, l.title, l.completed_at, l.due_on, l.created_at, l.kind,
           l.project_id,
           (select n.name from named n where n.project_id = l.project_id) as project_name,
           (l.home_project_id is null or l.project_id is not null) as show,
           (
             select p.title
             from public.tasks p
             where p.id = l.parent_task_id
               and p.deleted_at is null
               and exists (
                 select 1
                 from public.tasks root
                 where root.id = coalesce(p.root_task_id, p.id)
                   and (
                     (root.home_project_id is null and me in (root.created_by, root.assignee_id))
                     or root.home_project_id in (select project_id from readable)
                     or exists (
                       select 1
                       from public.task_projects tp
                       where tp.task_id = root.id
                         and tp.deleted_at is null
                         and tp.project_id in (select project_id from readable)
                     )
                   )
               )
           ) as parent_title
    from labelled l
  )
  select jsonb_build_object(
    'open', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', k.id,
        'title', k.title,
        'completed_at', k.completed_at,
        'due_on', k.due_on,
        'project_id', k.project_id,
        'project_name', k.project_name,
        'kind', k.kind,
        'parent_title', k.parent_title
      ) order by k.due_on nulls last, k.created_at, k.id)
      from kept k
      where k.show and k.completed_at is null
    ), '[]'::jsonb),
    'completed', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id,
        'title', c.title,
        'completed_at', c.completed_at,
        'due_on', c.due_on,
        'project_id', c.project_id,
        'project_name', c.project_name,
        'kind', c.kind,
        'parent_title', c.parent_title
      ) order by c.completed_at desc, c.id desc)
      from (
        select k.*
        from kept k
        where k.show and k.completed_at is not null
        order by k.completed_at desc, k.id desc
        limit 30
      ) c
    ), '[]'::jsonb)
  )
  into result;

  return result;
end;
$$;

revoke all on function public.my_task_cards() from public, anon;
grant execute on function public.my_task_cards() to authenticated;

-- ---------------------------------------------------------------------------
-- My Tasks sections: same placement rules, without a role check per task
-- ---------------------------------------------------------------------------

create or replace function public.sync_my_task_placements()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  recent uuid := public.ensure_my_task_sections();
  low double precision;
begin
  if me is null or not public.is_allowlisted() then
    raise exception 'Sign in to use My Tasks' using errcode = 'insufficient_privilege';
  end if;

  with readable as materialized (
    select m.project_id
    from public.project_members m
    where m.profile_id = me
      and m.deleted_at is null
  )
  select coalesce(min(p.sort_order), 1024) into low
  from public.my_task_placements p
  join public.tasks t on t.id = p.task_id
  where p.section_id = recent
    and p.profile_id = me
    and t.deleted_at is null
    and t.completed_at is null
    and public.my_task_placement_valid(p.profile_id, p.assigned_at, t.assignee_id, t.assigned_at)
    and exists (
      select 1
      from public.tasks root
      where root.id = coalesce(t.root_task_id, t.id)
        and (
          (root.home_project_id is null and me in (root.created_by, root.assignee_id))
          or root.home_project_id in (select project_id from readable)
          or exists (
            select 1
            from public.task_projects tp
            where tp.task_id = root.id
              and tp.deleted_at is null
              and tp.project_id in (select project_id from readable)
          )
        )
    );

  with readable as materialized (
    select m.project_id
    from public.project_members m
    where m.profile_id = me
      and m.deleted_at is null
  )
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
      and exists (
        select 1
        from public.tasks root
        where root.id = coalesce(t.root_task_id, t.id)
          and (
            (root.home_project_id is null and me in (root.created_by, root.assignee_id))
            or root.home_project_id in (select project_id from readable)
            or exists (
              select 1
              from public.task_projects tp
              where tp.task_id = root.id
                and tp.deleted_at is null
                and tp.project_id in (select project_id from readable)
            )
          )
      )
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
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
begin
  if me is null or not public.is_allowlisted() then
    return;
  end if;
  perform public.sync_my_task_placements();
  return query
    with readable as materialized (
      select m.project_id
      from public.project_members m
      where m.profile_id = me
        and m.deleted_at is null
    )
    select p.task_id, p.section_id, p.sort_order
    from public.my_task_placements p
    join public.tasks t on t.id = p.task_id
    join public.my_task_sections s on s.id = p.section_id and s.deleted_at is null
    where p.profile_id = me
      and t.deleted_at is null
      and t.completed_at is null
      and public.my_task_placement_valid(p.profile_id, p.assigned_at, t.assignee_id, t.assigned_at)
      and exists (
        select 1
        from public.tasks root
        where root.id = coalesce(t.root_task_id, t.id)
          and (
            (root.home_project_id is null and me in (root.created_by, root.assignee_id))
            or root.home_project_id in (select project_id from readable)
            or exists (
              select 1
              from public.task_projects tp
              where tp.task_id = root.id
                and tp.deleted_at is null
                and tp.project_id in (select project_id from readable)
            )
          )
      )
    order by s.sort_order, s.created_at, p.sort_order, p.created_at, p.task_id;
end;
$$;

revoke all on function public.my_tasks_layout() from public, anon;
grant execute on function public.my_tasks_layout() to authenticated;

select public.alhc_revoke_anon_execute(array[
  'my_task_cards()',
  'my_tasks_layout()',
  'sync_my_task_placements()'
]);

-- TAIL
-- Nothing to remove.
