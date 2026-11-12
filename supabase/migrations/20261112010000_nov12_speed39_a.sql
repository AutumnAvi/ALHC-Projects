-- Nov 12 batch 39 (speed and feel, item 2a): "blocked by" counts for a whole list in one pass.
--
-- open_blocker_counts(task_ids) (My tasks rows, through my_task_bundle; bulk automation runs) used to
-- call open_blocker_count once per task: one definer call, one task_role() check, and one count each.
-- With 2,000 open tasks that was about 1.5 seconds locally. It now asks open_blocker_count_set once for
-- the whole list: one access check per statement and one grouped count.
--
-- Same answers: open_blocker_counts keeps its signature, return shape ({ "<task id>": n }, only tasks
-- with n > 0), language, invoker security, search_path, and grants. Its outer read of the tasks is still
-- the caller's own (RLS), and open_blocker_count_set counts only tasks the caller could ask
-- open_blocker_count about (task_role() not null: profile_task_role's rule, written as a set), with the
-- completion guard's count (hidden blockers included, as a number only; start-to-start never blocks;
-- dependency_satisfied decides the rest). Suite zz59 compares the two on every task for several people.
--
-- open_blocker_count_set is the one new client SECURITY DEFINER function (pinned in suite 60): it must
-- see links to tasks the caller can't read, exactly like open_blocker_count, which is already callable
-- one task at a time, so it answers nothing a person couldn't learn before. Nothing for anon.
--
-- Additive: create or replace with unchanged signatures, so the release on main keeps working before and
-- after this is applied. No tail.

create or replace function public.open_blocker_count_set(task_ids uuid[])
returns table (task_id uuid, blockers integer)
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select auth.uid() as uid where public.is_allowlisted()
  ),
  asked as (
    select t.id, coalesce(t.root_task_id, t.id) as root_id, t.home_project_id
    from public.tasks t
    where t.id = any (task_ids[1:2000])
  ),
  -- profile_task_role(auth.uid(), task) is not null: a membership (any role, archived or not) in one of
  -- the top-level task's projects or the task's home project, or a private top-level task the caller
  -- created or is assigned.
  readable as (
    select a.id
    from asked a
    cross join me
    where exists (
        select 1 from public.project_members m
        where m.profile_id = me.uid
          and m.deleted_at is null
          and (
            m.project_id = a.home_project_id
            or m.project_id in (
              select tp.project_id from public.task_projects tp
              where tp.task_id = a.root_id and tp.deleted_at is null
            )
          )
      )
      or exists (
        select 1 from public.tasks rt
        where rt.id = a.root_id
          and rt.home_project_id is null
          and me.uid in (rt.created_by, rt.assignee_id)
      )
  )
  select d.successor_id, count(*)::integer
  from readable r
  join public.task_dependencies d on d.successor_id = r.id
  join public.tasks p on p.id = d.predecessor_id
  where d.kind <> 'start_to_start'
    and d.deleted_at is null
    and p.deleted_at is null
    and not public.dependency_satisfied(d.kind, p)
  group by d.successor_id;
$$;

revoke all on function public.open_blocker_count_set(uuid[]) from public, anon;
grant execute on function public.open_blocker_count_set(uuid[]) to authenticated;

comment on function public.open_blocker_count_set(uuid[]) is
  'Batch 39: open_blocker_count for many tasks in one pass (tasks the caller may ask about, with at least one open blocker). Definer like open_blocker_count; a number per task only.';

-- Open-blocker counts for many tasks at once (My tasks rows): the completion guard's count, hidden
-- blockers included (a number only).
create or replace function public.open_blocker_counts(task_ids uuid[])
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(s.task_id, s.blockers) filter (where s.blockers > 0), '{}'::jsonb)
  from public.open_blocker_count_set(array(
    select t.id
    from public.tasks t
    where t.id = any (task_ids[1:2000]) and t.deleted_at is null and t.completed_at is null
  )) s;
$$;

revoke all on function public.open_blocker_counts(uuid[]) from public, anon;
grant execute on function public.open_blocker_counts(uuid[]) to authenticated;
