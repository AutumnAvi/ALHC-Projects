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

-- ---------------------------------------------------------------------------
-- Inbox: one page, and the unread badge
-- ---------------------------------------------------------------------------
-- inbox_page matches listInbox: 100 task rows, 100 project messages, 100 team messages, and 100
-- status updates, then the same drops (a removed comment, a reply whose thread is gone), then the
-- newest 100 overall. inbox_unread_count matches the badge: unread, not archived, still readable,
-- including rows the page itself hides (a task in the Trash, a removed message).

create or replace function public.inbox_page(inbox_tab text)
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
  if me is null or not public.is_allowlisted()
     or inbox_tab not in ('activity', 'archive', 'bookmarks', 'mentioned') then
    return '[]'::jsonb;
  end if;

  with readable as materialized (
    select m.project_id
    from public.project_members m
    where m.profile_id = me
      and m.deleted_at is null
  ),
  task_raw as materialized (
    select i.id, i.kind, i.data, i.actor_id, i.read_at, i.archived_at, i.bookmarked_at, i.created_at,
           t.id as task_id, t.title as task_title, t.parent_task_id,
           c.body as comment_body, c.deleted_at as comment_removed_at,
           c.email_address, c.email_direction
    from public.inbox_items i
    join public.tasks t on t.id = i.task_id and t.deleted_at is null
    left join public.comments c
      on c.id = i.comment_id
     and exists (
       select 1
       from public.tasks ct
       join public.tasks root on root.id = coalesce(ct.root_task_id, ct.id)
       where ct.id = c.task_id
         and (
           (root.home_project_id is null and me in (root.created_by, root.assignee_id))
           or root.home_project_id in (select project_id from readable)
           or exists (
             select 1 from public.task_projects tp
             where tp.task_id = root.id and tp.deleted_at is null
               and tp.project_id in (select project_id from readable)
           )
         )
     )
    where i.recipient_id = me
      and case inbox_tab
        when 'archive' then i.archived_at is not null
        when 'bookmarks' then i.bookmarked_at is not null
        when 'mentioned' then i.kind = 'mention'
        else i.archived_at is null
      end
      and exists (
        select 1
        from public.tasks root
        where root.id = coalesce(t.root_task_id, t.id)
          and (
            (root.home_project_id is null and me in (root.created_by, root.assignee_id))
            or root.home_project_id in (select project_id from readable)
            or exists (
              select 1 from public.task_projects tp
              where tp.task_id = root.id and tp.deleted_at is null
                and tp.project_id in (select project_id from readable)
            )
          )
      )
    order by i.created_at desc, i.id desc
    limit 100
  ),
  task_kept as (
    select r.*,
           (
             select p.title
             from public.tasks p
             where p.id = r.parent_task_id
               and p.deleted_at is null
               and exists (
                 select 1
                 from public.tasks root
                 where root.id = coalesce(p.root_task_id, p.id)
                   and (
                     (root.home_project_id is null and me in (root.created_by, root.assignee_id))
                     or root.home_project_id in (select project_id from readable)
                     or exists (
                       select 1 from public.task_projects tp
                       where tp.task_id = root.id and tp.deleted_at is null
                         and tp.project_id in (select project_id from readable)
                     )
                   )
               )
           ) as parent_title,
           ap.id as approval_id, ap.status as approval_status, ap.approver_id
    from task_raw r
    left join lateral (
      select a.id, a.status, a.approver_id
      from public.approval_requests a
      where r.kind = 'approval_requested'
        and jsonb_typeof(r.data) = 'object'
        and r.data ? 'approval_id'
        and a.id::text = r.data->>'approval_id'
        and a.deleted_at is null
      limit 1
    ) ap on true
    where r.comment_removed_at is null
  ),
  message_raw as materialized (
    select i.id, i.kind, i.data, i.actor_id, i.read_at, i.archived_at, i.bookmarked_at, i.created_at,
           m.id as message_id, m.thread_id, m.project_id, m.title, m.body, p.name as project_name
    from public.inbox_items i
    join public.project_messages m on m.id = i.message_id and m.deleted_at is null
    join public.projects p on p.id = m.project_id and p.deleted_at is null
    where i.task_id is null
      and i.recipient_id = me
      and m.project_id in (select project_id from readable)
      and case inbox_tab
        when 'archive' then i.archived_at is not null
        when 'bookmarks' then i.bookmarked_at is not null
        when 'mentioned' then i.kind = 'mention'
        else i.archived_at is null
      end
    order by i.created_at desc, i.id desc
    limit 100
  ),
  message_kept as (
    select r.*, coalesce(th.title, r.title, 'Message') as display_title
    from message_raw r
    left join public.project_messages th on th.id = r.thread_id
    where r.thread_id is null or (th.id is not null and th.deleted_at is null)
  ),
  team_raw as materialized (
    select i.id, i.kind, i.data, i.actor_id, i.read_at, i.archived_at, i.bookmarked_at, i.created_at,
           m.id as message_id, m.thread_id, m.team_id, m.title, m.body, tm.name as team_name
    from public.inbox_items i
    join public.team_messages m on m.id = i.team_message_id and m.deleted_at is null
    join public.teams tm on tm.id = m.team_id and tm.deleted_at is null
    where i.task_id is null
      and i.recipient_id = me
      and case inbox_tab
        when 'archive' then i.archived_at is not null
        when 'bookmarks' then i.bookmarked_at is not null
        when 'mentioned' then i.kind = 'mention'
        else i.archived_at is null
      end
    order by i.created_at desc, i.id desc
    limit 100
  ),
  team_kept as (
    select r.*, coalesce(th.title, r.title, 'Message') as display_title
    from team_raw r
    left join public.team_messages th on th.id = r.thread_id
    where r.thread_id is null or (th.id is not null and th.deleted_at is null)
  ),
  status_raw as materialized (
    select i.id, i.kind, i.data, i.actor_id, i.read_at, i.archived_at, i.bookmarked_at, i.created_at,
           u.id as update_id, u.project_id, u.status, u.title, u.note, p.name as project_name
    from public.inbox_items i
    join public.project_status_updates u on u.id = i.status_update_id
    join public.projects p on p.id = u.project_id and p.deleted_at is null
    where i.task_id is null
      and i.recipient_id = me
      and u.project_id in (select project_id from readable)
      and case inbox_tab
        when 'archive' then i.archived_at is not null
        when 'bookmarks' then i.bookmarked_at is not null
        when 'mentioned' then i.kind = 'mention'
        else i.archived_at is null
      end
    order by i.created_at desc, i.id desc
    limit 100
  ),
  merged as (
    select k.created_at, k.id, jsonb_build_object(
      'id', k.id,
      'kind', k.kind,
      'data', k.data,
      'actor_id', k.actor_id,
      'read_at', k.read_at,
      'archived_at', k.archived_at,
      'bookmarked_at', k.bookmarked_at,
      'created_at', k.created_at,
      'task_id', k.task_id,
      'task_title', k.task_title,
      'parent_title', k.parent_title,
      'comment_body', k.comment_body,
      'email_from', case
        when k.actor_id is null and k.email_direction = 'received' then k.email_address
        else null
      end,
      'message', null,
      'team_message', null,
      'status_update', null,
      'approval', case when k.approval_id is null then null else jsonb_build_object(
        'id', k.approval_id, 'status', k.approval_status, 'approver_id', k.approver_id
      ) end
    ) as item
    from task_kept k
    union all
    select m.created_at, m.id, jsonb_build_object(
      'id', m.id, 'kind', m.kind, 'data', m.data, 'actor_id', m.actor_id,
      'read_at', m.read_at, 'archived_at', m.archived_at, 'bookmarked_at', m.bookmarked_at,
      'created_at', m.created_at, 'task_id', null, 'task_title', m.display_title,
      'parent_title', null, 'comment_body', m.body, 'email_from', null,
      'message', jsonb_build_object(
        'id', m.message_id, 'thread_id', coalesce(m.thread_id, m.message_id),
        'project_id', m.project_id, 'project_name', m.project_name
      ),
      'team_message', null, 'status_update', null, 'approval', null
    )
    from message_kept m
    union all
    select t.created_at, t.id, jsonb_build_object(
      'id', t.id, 'kind', t.kind, 'data', t.data, 'actor_id', t.actor_id,
      'read_at', t.read_at, 'archived_at', t.archived_at, 'bookmarked_at', t.bookmarked_at,
      'created_at', t.created_at, 'task_id', null, 'task_title', t.display_title,
      'parent_title', null, 'comment_body', t.body, 'email_from', null,
      'message', null,
      'team_message', jsonb_build_object(
        'id', t.message_id, 'thread_id', coalesce(t.thread_id, t.message_id),
        'team_id', t.team_id, 'team_name', t.team_name
      ),
      'status_update', null, 'approval', null
    )
    from team_kept t
    union all
    select s.created_at, s.id, jsonb_build_object(
      'id', s.id, 'kind', s.kind, 'data', s.data, 'actor_id', s.actor_id,
      'read_at', s.read_at, 'archived_at', s.archived_at, 'bookmarked_at', s.bookmarked_at,
      'created_at', s.created_at, 'task_id', null, 'task_title', s.project_name,
      'parent_title', null, 'comment_body', s.note, 'email_from', null,
      'message', null, 'team_message', null,
      'status_update', jsonb_build_object(
        'id', s.update_id, 'project_id', s.project_id, 'project_name', s.project_name,
        'status', s.status, 'title', s.title
      ),
      'approval', null
    )
    from status_raw s
  )
  select coalesce(jsonb_agg(page.item order by page.created_at desc, page.id desc), '[]'::jsonb)
  into result
  from (
    select merged.created_at, merged.id, merged.item
    from merged
    order by merged.created_at desc, merged.id desc
    limit 100
  ) page;

  return result;
end;
$$;

revoke all on function public.inbox_page(text) from public, anon;
grant execute on function public.inbox_page(text) to authenticated;

create or replace function public.inbox_unread_count()
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  n integer;
begin
  if me is null or not public.is_allowlisted() then
    return 0;
  end if;

  with readable as materialized (
    select m.project_id
    from public.project_members m
    where m.profile_id = me
      and m.deleted_at is null
  )
  select count(*)::integer into n
  from public.inbox_items i
  where i.recipient_id = me
    and i.read_at is null
    and i.archived_at is null
    and (
      (
        i.task_id is not null
        and exists (
          select 1
          from public.tasks t
          join public.tasks root on root.id = coalesce(t.root_task_id, t.id)
          where t.id = i.task_id
            and (
              (root.home_project_id is null and me in (root.created_by, root.assignee_id))
              or root.home_project_id in (select project_id from readable)
              or exists (
                select 1 from public.task_projects tp
                where tp.task_id = root.id and tp.deleted_at is null
                  and tp.project_id in (select project_id from readable)
              )
            )
        )
      )
      or (
        i.task_id is null
        and exists (
          select 1 from public.project_messages m
          where m.id = i.message_id
            and m.project_id in (select project_id from readable)
        )
      )
      or (
        i.task_id is null
        and exists (
          select 1
          from public.team_messages m
          join public.teams tm on tm.id = m.team_id and tm.deleted_at is null
          where m.id = i.team_message_id
        )
      )
      or (
        i.task_id is null
        and exists (
          select 1 from public.project_status_updates u
          where u.id = i.status_update_id
            and u.project_id in (select project_id from readable)
        )
      )
    );

  return coalesce(n, 0);
end;
$$;

revoke all on function public.inbox_unread_count() from public, anon;
grant execute on function public.inbox_unread_count() to authenticated;

select public.alhc_revoke_anon_execute(array[
  'inbox_page(text)',
  'inbox_unread_count()'
]);

-- TAIL
-- Nothing to remove.
