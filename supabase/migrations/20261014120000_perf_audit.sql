-- Performance: project List / Board / Calendar / Timeline and the task pane's comments.
--
-- A project page loaded every task, then six more queries, each paying has_project_role /
-- has_task_role once per row. On a local database with 10,000 tasks that was about 34 seconds
-- before a single card was drawn (see docs/PERF-AUDIT.md). These three functions check access
-- once, then read the rows directly, and return one jsonb value so PostgREST's max_rows cannot
-- cut the list. They are SECURITY DEFINER for that reason and are pinned in suite 60.
--
-- What they return is the same as the viewer's own queries:
--   cards only for active top-level tasks with a membership in this project
--   project counts and blocker counts only for projects and predecessors the caller can read
--   field values only for this project's fields
--   a non-member, including a workspace admin who is not a member, gets an empty result
--
-- No tail: nothing here removes an object.

-- ---------------------------------------------------------------------------
-- One card per task the view shows
-- ---------------------------------------------------------------------------

create or replace function public.project_task_cards(
  target_project uuid,
  only_ids uuid[] default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cards jsonb;
begin
  if target_project is null or not public.has_project_role(target_project, 'viewer') then
    return '[]'::jsonb;
  end if;
  if only_ids is not null and cardinality(only_ids) = 0 then
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
      and t.parent_task_id is null
      and (only_ids is null or t.id = any (only_ids))
  ),
  subs as (
    select s.parent_task_id as task_id,
           count(*)::integer as subtask_count,
           count(*) filter (where s.completed_at is not null)::integer as subtask_done_count
    from public.tasks s
    join member m on m.task_id = s.parent_task_id
    where s.deleted_at is null
    group by s.parent_task_id
  ),
  projects as (
    select tp.task_id, count(*)::integer as project_count
    from public.task_projects tp
    join member m on m.task_id = tp.task_id
    join public.projects p on p.id = tp.project_id and p.deleted_at is null
    where tp.deleted_at is null
      and (tp.project_id = target_project or tp.project_id in (select project_id from readable))
    group by tp.task_id
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
  comments as (
    select c.task_id, count(*)::integer as comment_count
    from public.comments c
    join member m on m.task_id = c.task_id
    where c.deleted_at is null
    group by c.task_id
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
  ),
  approvals as (
    select distinct on (a.task_id) a.task_id, a.status
    from public.approval_requests a
    join member m on m.task_id = a.task_id
    where m.kind = 'approval'
      and m.assignee_id is not null
      and a.deleted_at is null
      and a.subtask_id is null
      and a.status <> 'cancelled'
      and a.approver_id = m.assignee_id
    order by a.task_id, a.created_at desc, a.id desc
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
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
      'recurring', m.recurring,
      'kind', m.kind,
      'subtask_count', coalesce(s.subtask_count, 0),
      'subtask_done_count', coalesce(s.subtask_done_count, 0),
      'project_count', coalesce(pr.project_count, 1),
      'blocked_by', coalesce(b.blocked_by, 0),
      'comment_count', coalesce(c.comment_count, 0),
      'field_values', coalesce(fv.field_values, '{}'::jsonb),
      'tag_ids', coalesce(tg.tag_ids, '[]'::jsonb),
      'approval_status', ap.status
    )
    order by m.sort_order, m.task_id
  ), '[]'::jsonb)
  into cards
  from member m
  left join subs s on s.task_id = m.task_id
  left join projects pr on pr.task_id = m.task_id
  left join blockers b on b.task_id = m.task_id
  left join comments c on c.task_id = m.task_id
  left join fields fv on fv.task_id = m.task_id
  left join tags tg on tg.task_id = m.task_id
  left join approvals ap on ap.task_id = m.task_id;

  return cards;
end;
$$;

revoke all on function public.project_task_cards(uuid, uuid[]) from public, anon;
grant execute on function public.project_task_cards(uuid, uuid[]) to authenticated;

-- How many active tasks sit in each section, including ones the current view hides.
-- The List uses this to know a section is empty before offering to remove it.
create or replace function public.project_section_task_counts(target_project uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if target_project is null or not public.has_project_role(target_project, 'viewer') then
    return '{}'::jsonb;
  end if;
  return (
    select coalesce(jsonb_object_agg(section_id::text, n), '{}'::jsonb)
    from (
      select tp.section_id, count(*)::integer as n
      from public.task_projects tp
      join public.tasks t on t.id = tp.task_id
      where tp.project_id = target_project
        and tp.deleted_at is null
        and t.deleted_at is null
        and t.parent_task_id is null
        and tp.section_id is not null
      group by tp.section_id
    ) s
  );
end;
$$;

revoke all on function public.project_section_task_counts(uuid) from public, anon;
grant execute on function public.project_section_task_counts(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The latest comments on a task, one access check
-- ---------------------------------------------------------------------------

-- Newest page first (the pane draws them oldest-first). before_at / before_id walk backward.
-- total is the count of comments that are still there, for the Comments tab. has_more means an
-- older page exists. A caller who cannot read the task gets an empty page.
create or replace function public.task_comment_page(
  target_task uuid,
  before_at timestamp with time zone default null,
  before_id uuid default null,
  max_results integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  lim integer := greatest(1, least(coalesce(max_results, 100), 200));
  total integer := 0;
  has_more boolean := false;
  comments jsonb := '[]'::jsonb;
begin
  if target_task is null or not public.has_task_role(target_task, 'viewer') then
    return jsonb_build_object('comments', '[]'::jsonb, 'has_more', false, 'total', 0);
  end if;

  select count(*)::integer into total
  from public.comments c
  where c.task_id = target_task
    and c.deleted_at is null;

  with picked as (
    select c.id
    from public.comments c
    where c.task_id = target_task
      and (
        before_at is null
        or c.created_at < before_at
        or (c.created_at = before_at and (before_id is null or c.id < before_id))
      )
    order by c.created_at desc, c.id desc
    limit lim + 1
  ),
  page as (
    select c.id, c.author_id, c.rule_id,
           case
             when c.rule_id is null then null
             when public.has_project_role(r.project_id, 'viewer') then r.name
             else null
           end as rule_name,
           c.body, c.created_at, c.edited_at, c.deleted_at,
           coalesce((
             select jsonb_agg(m.profile_id)
             from public.comment_mentions m
             where m.comment_id = c.id
           ), '[]'::jsonb) as mention_ids,
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'emoji', rx.emoji,
               'profile_id', rx.profile_id,
               'created_at', rx.created_at
             ) order by rx.created_at)
             from public.comment_reactions rx
             where rx.comment_id = c.id
               and rx.deleted_at is null
           ), '[]'::jsonb) as reactions,
           c.email_direction, c.email_address, c.email_subject
    from picked p
    join public.comments c on c.id = p.id
    left join public.rules r on r.id = c.rule_id
    order by c.created_at desc, c.id desc
    limit lim
  )
  select (select count(*) > lim from picked),
         coalesce((select jsonb_agg(to_jsonb(page) order by page.created_at, page.id) from page), '[]'::jsonb)
  into has_more, comments;

  return jsonb_build_object('comments', comments, 'has_more', has_more, 'total', total);
end;
$$;

revoke all on function public.task_comment_page(uuid, timestamp with time zone, uuid, integer) from public, anon;
grant execute on function public.task_comment_page(uuid, timestamp with time zone, uuid, integer) to authenticated;

-- The pane reads every comment on a task, including ones that were removed (they stay as a
-- placeholder). The partial comments index leaves those out, so this one can walk a task's
-- timeline and stop after a page.
create index comments_task_timeline_idx
  on public.comments (task_id, created_at desc, id desc);

select public.alhc_revoke_anon_execute(array[
  'project_task_cards(uuid,uuid[])',
  'project_section_task_counts(uuid)',
  'task_comment_page(uuid,timestamp with time zone,uuid,integer)'
]);
