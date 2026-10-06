-- Phase: Real subtasks
--
-- Until now public.subtasks was a checklist hanging off a task (title, completion, order). This phase
-- makes subtasks real tasks: a row in public.tasks with parent_task_id set. A subtask has an assignee,
-- start/due dates (and times), notes, a kind, custom field values of its root task's projects,
-- comments, followers, attachments, approvals, and its own subtasks (up to 4 levels below a task).
--
-- Model (see “Real subtasks model” in AGENTS.md):
--   * tasks.parent_task_id  the parent (a task or another subtask); null for an ordinary task.
--   * tasks.root_task_id    the top-level task of the tree; null for an ordinary task. Maintained by the
--                           invoker trigger tasks_05_subtask_parent from the parent, never by clients.
--   * tasks.subtask_order   order among siblings (fractional, step 1024); unused for ordinary tasks,
--                           whose order lives on task_projects.
--   * Access: a subtask resolves to its ROOT task's projects, never broader and never its own
--     memberships. Subtasks have no task_projects rows (task_projects_05_no_subtasks rejects them),
--     home_project_id / workspace_id always equal the root's, and profile_task_role() (signature and
--     grants unchanged; task_role / has_task_role / profile_can_read_task call it) reads the root's
--     memberships. So views, filters, dashboards, the critical path, rules, and portfolio progress keep
--     seeing ordinary tasks only, while My Tasks, the inbox, search, and workload see subtasks.
--   * Same workspace (inherited from the parent), no cycles, depth ≤ 4 (subtask_max_depth()). A task
--     can't become a subtask or a subtask a task yet (follow-up); a subtask may move to another parent.
--   * Soft-deleting a task trashes its active subtasks with the same timestamp; restoring it restores
--     exactly those. A subtask can't be restored while its parent is in the Trash.
--   * Rules and Req # skip subtasks in their calling triggers (fire_rules is unchanged).
--   * Data: every public.subtasks row became a child task with the same id, completion, and order, and
--     approval_requests.subtask_id now references public.tasks. public.subtasks is retired (kept, not
--     dropped, no client writes).
--
-- No new SECURITY DEFINER functions: everything new is SECURITY INVOKER. Redefined definer functions
-- keep their signatures and grants; notifications still go only through notify_with() / add_story(),
-- which are untouched (their import and copy checks included).

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table public.tasks
  add column parent_task_id uuid references public.tasks (id),
  add column root_task_id uuid references public.tasks (id),
  add column subtask_order double precision not null default 0;

alter table public.tasks
  add constraint tasks_parent_not_self check (parent_task_id is null or parent_task_id <> id),
  add constraint tasks_root_pair check ((parent_task_id is null) = (root_task_id is null));

create index tasks_parent_idx on public.tasks (parent_task_id, subtask_order) where parent_task_id is not null;
create index tasks_root_idx on public.tasks (root_task_id) where root_task_id is not null;

comment on column public.tasks.parent_task_id is
  'Real subtasks: the parent task (a task or a subtask); null for an ordinary task.';
comment on column public.tasks.root_task_id is
  'Real subtasks: the top-level task of the tree (access resolves through it); kept by tasks_05_subtask_parent.';
comment on column public.tasks.subtask_order is
  'Real subtasks: order among the parent''s subtasks (fractional, step 1024). Unused for ordinary tasks.';

-- ---------------------------------------------------------------------------
-- Depth helpers (invoker)
-- ---------------------------------------------------------------------------

-- Subtasks nest at most this many levels below an ordinary task (task → 1 → 2 → 3 → 4).
create or replace function public.subtask_max_depth()
returns integer
language sql
immutable
set search_path = ''
as $$
  select 4;
$$;

-- How many levels a subtree goes below a task (0 = no subtasks). Counts trashed rows too, so a
-- restore can never push a tree past the limit.
create or replace function public.subtask_height(target_task uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  with recursive down (id, height) as (
    select target_task, 0
    union all
    select c.id, d.height + 1
    from public.tasks c
    join down d on c.parent_task_id = d.id
    where d.height < 10
  )
  select max(height) from down;
$$;

revoke all on function public.subtask_max_depth() from public, anon;
grant execute on function public.subtask_max_depth() to authenticated;
revoke all on function public.subtask_height(uuid) from public, anon;
grant execute on function public.subtask_height(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- tasks_05_subtask_parent: parent checks, root / home / workspace from the parent (invoker)
-- ---------------------------------------------------------------------------
-- Runs first among the BEFORE triggers (05 < 10). For a subtask it always recomputes root_task_id,
-- home_project_id, and workspace_id from the parent row, so clients can't forge them. On insert or a
-- parent change it checks: the parent exists (and is readable — RLS applies), is active, isn't the task
-- itself or one of its subtasks (cycle), and the subtree stays within subtask_max_depth().

create or replace function public.guard_task_parent()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  parent public.tasks;
  cur uuid;
  depth integer := 0;
begin
  if tg_op = 'UPDATE' and (old.parent_task_id is null) <> (new.parent_task_id is null) then
    raise exception 'A task can’t become a subtask, or a subtask a task, yet'
      using errcode = 'check_violation', hint = 'Move the subtask under another task instead';
  end if;
  if new.parent_task_id is null then
    new.root_task_id := null;
    return new;
  end if;
  if new.parent_task_id = new.id then
    raise exception 'A task can’t be its own subtask' using errcode = 'check_violation';
  end if;

  select * into parent from public.tasks t where t.id = new.parent_task_id;
  if not found then
    raise exception 'Parent task not found' using errcode = 'no_data_found';
  end if;

  if tg_op = 'INSERT' or new.parent_task_id is distinct from old.parent_task_id then
    if parent.deleted_at is not null then
      raise exception 'The parent task is in the Trash' using errcode = 'check_violation';
    end if;
    -- Walk up from the parent: a cycle if we meet this task, and count the parent's depth.
    cur := parent.id;
    loop
      if cur = new.id then
        raise exception 'A task can’t be a subtask of its own subtask' using errcode = 'check_violation';
      end if;
      select t.parent_task_id into cur from public.tasks t where t.id = cur;
      exit when cur is null;
      depth := depth + 1;
      exit when depth > 10;
    end loop;
    if depth + 1 + (case when tg_op = 'UPDATE' then coalesce(public.subtask_height(new.id), 0) else 0 end)
       > public.subtask_max_depth() then
      raise exception 'Subtasks can be nested up to % levels deep', public.subtask_max_depth()
        using errcode = 'check_violation';
    end if;
  end if;

  if tg_op = 'UPDATE' and old.deleted_at is not null and new.deleted_at is null and parent.deleted_at is not null then
    raise exception 'Restore the parent task first' using errcode = 'check_violation';
  end if;

  new.root_task_id := coalesce(parent.root_task_id, parent.id);
  new.home_project_id := parent.home_project_id;
  new.workspace_id := parent.workspace_id;
  return new;
end;
$$;

revoke all on function public.guard_task_parent() from public, anon;
grant execute on function public.guard_task_parent() to authenticated;

create trigger tasks_05_subtask_parent
  before insert or update on public.tasks
  for each row execute function public.guard_task_parent();

-- ---------------------------------------------------------------------------
-- Cascades to direct subtasks (invoker; each child's own trigger carries it one level further)
-- ---------------------------------------------------------------------------
-- * a new root or home project (reparenting, or the root's home moving) is copied down;
-- * trashing a task trashes its active subtasks with the same deleted_at, and restoring it restores
--   exactly those (subtasks trashed on their own earlier stay in the Trash).

create or replace function public.cascade_task_to_subtasks()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.root_task_id is distinct from old.root_task_id or new.home_project_id is distinct from old.home_project_id then
    update public.tasks c
    set root_task_id = coalesce(new.root_task_id, new.id),
        home_project_id = new.home_project_id
    where c.parent_task_id = new.id
      and (c.root_task_id is distinct from coalesce(new.root_task_id, new.id)
           or c.home_project_id is distinct from new.home_project_id);
  end if;
  if new.deleted_at is not null and old.deleted_at is null then
    update public.tasks c set deleted_at = new.deleted_at
    where c.parent_task_id = new.id and c.deleted_at is null;
  elsif new.deleted_at is null and old.deleted_at is not null then
    update public.tasks c set deleted_at = null
    where c.parent_task_id = new.id and c.deleted_at = old.deleted_at;
  end if;
  return null;
end;
$$;

revoke all on function public.cascade_task_to_subtasks() from public, anon;
grant execute on function public.cascade_task_to_subtasks() to authenticated;

create trigger tasks_cascade_subtasks
  after update of parent_task_id, root_task_id, home_project_id, deleted_at on public.tasks
  for each row execute function public.cascade_task_to_subtasks();

-- ---------------------------------------------------------------------------
-- Subtasks never get project memberships
-- ---------------------------------------------------------------------------

create or replace function public.ensure_home_membership()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Subtasks live in their root task's projects, never their own.
  if new.parent_task_id is not null then
    return new;
  end if;
  insert into public.task_projects (task_id, project_id, sort_order)
  values (
    new.id,
    new.home_project_id,
    coalesce(
      (select max(tp.sort_order) + 1024
       from public.task_projects tp
       where tp.project_id = new.home_project_id and tp.deleted_at is null),
      1024
    )
  )
  on conflict (task_id, project_id) do update
    set deleted_at = null;
  return new;
end;
$$;

create or replace function public.guard_task_project_subtask()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from public.tasks t where t.id = new.task_id and t.parent_task_id is not null) then
    raise exception 'Subtasks belong to their parent task’s projects; they can’t be added to a project'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_task_project_subtask() from public, anon;
grant execute on function public.guard_task_project_subtask() to authenticated;

create trigger task_projects_05_no_subtasks
  before insert on public.task_projects
  for each row execute function public.guard_task_project_subtask();

-- ---------------------------------------------------------------------------
-- Access: a subtask resolves to its root task's projects
-- ---------------------------------------------------------------------------
-- Same signature, grants, and answer for ordinary tasks. For a subtask the memberships are the root's
-- (its home project equals the root's). task_role, has_task_role, and profile_can_read_task are
-- unchanged and inherit this.

create or replace function public.profile_task_role(target_profile uuid, target_task uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
  from public.project_members m
  where m.profile_id = target_profile
    and m.deleted_at is null
    and m.project_id in (
      select tp.project_id from public.task_projects tp
      where tp.task_id = coalesce(
          (select t.root_task_id from public.tasks t where t.id = target_task),
          target_task
        )
        and tp.deleted_at is null
      union all
      select t.home_project_id from public.tasks t where t.id = target_task
    )
  order by public.project_role_rank(m.role) desc
  limit 1;
$$;

-- Policies read the row's own root_task_id (not a lookup by id), so INSERT … RETURNING and a reparent's
-- WITH CHECK see the new values. Ordinary tasks keep exactly the previous rules.
drop policy tasks_select_viewer on public.tasks;
create policy tasks_select_viewer on public.tasks
  for select to authenticated
  using (
    case
      when root_task_id is not null then
        (select public.has_task_role(root_task_id, case when deleted_at is null then 'viewer' else 'editor' end))
      when deleted_at is null then
        (select public.has_project_role(home_project_id, 'viewer')) or (select public.has_task_role(id, 'viewer'))
      else
        (select public.has_project_role(home_project_id, 'editor')) or (select public.has_task_role(id, 'editor'))
    end
  );

drop policy tasks_insert_editor on public.tasks;
create policy tasks_insert_editor on public.tasks
  for insert to authenticated
  with check (
    case when parent_task_id is null
      then (select public.has_project_role(home_project_id, 'editor'))
      else (select public.has_task_role(root_task_id, 'editor'))
    end
  );

drop policy tasks_update_editor on public.tasks;
create policy tasks_update_editor on public.tasks
  for update to authenticated
  using ((select public.has_task_role(coalesce(root_task_id, id), 'editor')))
  with check ((select public.has_task_role(coalesce(root_task_id, id), 'editor')));

-- Field values: a subtask can hold values of its root task's projects' fields.
create or replace function public.validate_task_field_value()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  field public.custom_fields;
  option_ids jsonb;
begin
  select * into field from public.custom_fields f where f.id = new.field_id and f.deleted_at is null;
  if not found then
    raise exception 'Unknown custom field' using errcode = 'foreign_key_violation';
  end if;
  if field.bound_to_sections then
    raise exception 'Section-bound fields change by moving the task between sections'
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.task_projects tp
    where tp.task_id = coalesce((select t.root_task_id from public.tasks t where t.id = new.task_id), new.task_id)
      and tp.project_id = field.project_id and tp.deleted_at is null
  ) then
    raise exception 'Task is not in the project that owns this field' using errcode = 'check_violation';
  end if;

  if new.value is null or new.value = 'null'::jsonb then
    new.value := null;
    return new;
  end if;

  select coalesce(jsonb_agg(o -> 'id'), '[]'::jsonb) into option_ids
  from jsonb_array_elements(field.options) o;

  if not (case field.field_type
    when 'text' then jsonb_typeof(new.value) = 'string' and length(new.value #>> '{}') <= 10000
    when 'number' then jsonb_typeof(new.value) = 'number'
    when 'boolean' then jsonb_typeof(new.value) = 'boolean'
    when 'date' then jsonb_typeof(new.value) = 'string' and (new.value #>> '{}') ~ '^\d{4}-\d{2}-\d{2}$'
    when 'single_select' then jsonb_typeof(new.value) = 'string' and option_ids @> jsonb_build_array(new.value)
    when 'multi_select' then jsonb_typeof(new.value) = 'array' and option_ids @> new.value
    when 'people' then jsonb_typeof(new.value) = 'array' and not exists (
      select 1 from jsonb_array_elements(new.value) v
      where jsonb_typeof(v) <> 'string'
        or (v #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    )
    else false
  end) then
    raise exception 'Invalid value for % field "%"', field.field_type, field.name
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Data: every public.subtasks row becomes a child task with the same id
-- ---------------------------------------------------------------------------
-- User triggers are off for the copy so nothing is notified, numbered, followed, or logged twice; the
-- columns the triggers would fill (workspace, home, root) are set here. Completion, order, title,
-- timestamps, and soft deletion are kept. Old subtasks were never nested, so root = parent.

alter table public.tasks disable trigger user;

insert into public.tasks (
  id, workspace_id, home_project_id, parent_task_id, root_task_id, title, completed_at, subtask_order,
  created_by, created_at, updated_at, deleted_at
)
select s.id, t.workspace_id, t.home_project_id, s.task_id, s.task_id, s.title, s.completed_at, s.sort_order,
       null, s.created_at, s.updated_at, s.deleted_at
from public.subtasks s
join public.tasks t on t.id = s.task_id
on conflict (id) do nothing;

alter table public.tasks enable trigger user;

-- Approval links now point at the child task (same id).
alter table public.approval_requests drop constraint approval_requests_subtask_id_fkey;
alter table public.approval_requests
  add constraint approval_requests_subtask_id_fkey foreign key (subtask_id) references public.tasks (id);

-- Retired: kept for history (no DROP), read by nothing, written by nothing.
comment on table public.subtasks is
  'Retired by Real subtasks (20261006080000_real_subtasks.sql): every row was copied into public.tasks as a '
  'child task with the same id (parent_task_id = task_id, same completion and order), and '
  'approval_requests.subtask_id now references public.tasks. Kept for history; nothing reads or writes it.';
revoke insert, update, delete on public.subtasks from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Creating and ordering subtasks (invoker RPCs: RLS and every task trigger apply)
-- ---------------------------------------------------------------------------

-- Re-spaces a parent's active subtasks 1024, 2048, … in their current order.
create or replace function public.reindex_subtask_order(target_parent uuid)
returns void
language sql
set search_path = ''
as $$
  update public.tasks t
  set subtask_order = o.rn * 1024
  from (
    select c.id, row_number() over (order by c.subtask_order, c.created_at, c.id) as rn
    from public.tasks c
    where c.parent_task_id = target_parent and c.deleted_at is null
  ) o
  where t.id = o.id and t.subtask_order is distinct from o.rn * 1024;
$$;

-- The sort order that puts a subtask before before_task (null = at the end) among target_parent's
-- subtasks, reindexing when the gap gets too small.
create or replace function public.subtask_order_before(target_parent uuid, before_task uuid, moving uuid default null)
returns double precision
language plpgsql
set search_path = ''
as $$
declare
  next_order double precision;
  prev_order double precision;
begin
  for attempt in 1..2 loop
    if before_task is null then
      select max(c.subtask_order) into prev_order from public.tasks c
      where c.parent_task_id = target_parent and c.deleted_at is null and c.id is distinct from moving;
      return coalesce(prev_order, 0) + 1024;
    end if;
    select c.subtask_order into next_order from public.tasks c
    where c.id = before_task and c.parent_task_id = target_parent and c.deleted_at is null;
    if not found then
      raise exception 'That subtask isn’t under this task' using errcode = 'check_violation';
    end if;
    select max(c.subtask_order) into prev_order from public.tasks c
    where c.parent_task_id = target_parent and c.deleted_at is null and c.id is distinct from moving
      and c.id <> before_task and c.subtask_order <= next_order;
    if prev_order is null then
      return next_order - 1024;
    end if;
    if next_order - prev_order >= public.min_order_gap() then
      return (prev_order + next_order) / 2;
    end if;
    perform public.reindex_subtask_order(target_parent);
  end loop;
  raise exception 'Could not place the subtask' using errcode = 'check_violation';
end;
$$;

-- New subtask under parent_task (Editor on its root): title, at the end or before before_task.
create or replace function public.create_subtask(parent_task uuid, task_title text, before_task uuid default null)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  created uuid;
begin
  if not exists (select 1 from public.tasks t where t.id = parent_task and t.deleted_at is null) then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;
  if not public.has_task_role(parent_task, 'editor') then
    raise exception 'Only editors and above can add subtasks' using errcode = 'insufficient_privilege';
  end if;
  if nullif(trim(coalesce(task_title, '')), '') is null then
    raise exception 'Give the subtask a name' using errcode = 'check_violation';
  end if;
  insert into public.tasks (parent_task_id, title, subtask_order)
  values (parent_task, left(trim(task_title), 1000), public.subtask_order_before(parent_task, before_task))
  returning id into created;
  return created;
end;
$$;

-- Moves a subtask before before_task (null = to the end), optionally under another parent
-- (new_parent; Editor on both trees; depth and cycle checks in tasks_05_subtask_parent).
create or replace function public.place_subtask(target_task uuid, before_task uuid default null, new_parent uuid default null)
returns void
language plpgsql
set search_path = ''
as $$
declare
  t public.tasks;
  parent uuid;
begin
  select * into t from public.tasks where id = target_task and deleted_at is null;
  if not found or t.parent_task_id is null then
    raise exception 'Subtask not found' using errcode = 'no_data_found';
  end if;
  if not public.has_task_role(target_task, 'editor') then
    raise exception 'Only editors and above can move subtasks' using errcode = 'insufficient_privilege';
  end if;
  parent := coalesce(new_parent, t.parent_task_id);
  if parent <> t.parent_task_id and not public.has_task_role(parent, 'editor') then
    raise exception 'Only editors and above can move subtasks there' using errcode = 'insufficient_privilege';
  end if;
  if before_task = target_task then
    return;
  end if;
  update public.tasks
  set parent_task_id = parent,
      subtask_order = public.subtask_order_before(parent, before_task, target_task)
  where id = target_task;
end;
$$;

revoke all on function public.reindex_subtask_order(uuid) from public, anon;
grant execute on function public.reindex_subtask_order(uuid) to authenticated;
revoke all on function public.subtask_order_before(uuid, uuid, uuid) from public, anon;
grant execute on function public.subtask_order_before(uuid, uuid, uuid) to authenticated;
revoke all on function public.create_subtask(uuid, text, uuid) from public, anon;
grant execute on function public.create_subtask(uuid, text, uuid) to authenticated;
revoke all on function public.place_subtask(uuid, uuid, uuid) from public, anon;
grant execute on function public.place_subtask(uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Approvals: approval subtasks are child tasks
-- ---------------------------------------------------------------------------

-- Same as before; the approval subtask is now a child task (no assignee, so its only inbox item is
-- the approver's approval_requested on the task).
create or replace function public.create_approval(
  target_task uuid,
  approver uuid,
  approval_note text,
  as_subtask boolean,
  subtask_title text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  linked_subtask uuid;
  new_id uuid;
begin
  if not exists (select 1 from public.profiles p where p.id = approver) then
    raise exception 'Choose an approver' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.tasks t where t.id = target_task and t.deleted_at is null) then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;
  if as_subtask then
    insert into public.tasks (parent_task_id, title, subtask_order)
    values (
      target_task,
      left(coalesce(nullif(trim(subtask_title), ''), 'Approval'), 500),
      coalesce((select max(s.subtask_order) + 1024 from public.tasks s
                where s.parent_task_id = target_task and s.deleted_at is null), 1024)
    )
    returning id into linked_subtask;
  end if;
  insert into public.approval_requests (task_id, subtask_id, approver_id, requested_by, rule_id, note)
  values (
    target_task, linked_subtask, approver, public.current_actor_id(), public.rule_context_id(),
    nullif(trim(approval_note), '')
  )
  returning id into new_id;
  return new_id;
end;
$$;

-- Same as before; a decision completes the approval subtask (a child task now), and rules skip
-- subtasks.
create or replace function public.on_approval_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  completes_task boolean;
begin
  if new.status = old.status then
    return new;
  end if;

  if new.status = 'cancelled' then
    perform public.add_story(new.task_id, 'approval_cancelled', jsonb_build_object(
      'approval_id', new.id, 'approver_id', new.approver_id
    ));
    return new;
  end if;

  if new.status = 'pending' then
    perform public.add_story(new.task_id, 'approval_resubmitted', jsonb_build_object(
      'approval_id', new.id, 'approver_id', new.approver_id, 'note', new.note
    ));
    perform public.notify_with(new.approver_id, new.task_id, 'approval_requested', null,
      jsonb_build_object('approval_id', new.id, 'note', new.note, 'resubmitted', true));
    return new;
  end if;

  perform public.add_story(new.task_id, 'approval_decided', jsonb_build_object(
    'approval_id', new.id, 'status', new.status, 'approver_id', new.approver_id, 'note', new.decision_note
  ));

  for r in
    select distinct recipient from (
      select new.requested_by as recipient
      union all
      select t.assignee_id from public.tasks t where t.id = new.task_id
      union all
      select f.profile_id from public.task_followers f where f.task_id = new.task_id and f.deleted_at is null
    ) recipients
    where recipient is not null
  loop
    perform public.notify_with(r.recipient, new.task_id, 'approval_decided', null,
      jsonb_build_object('approval_id', new.id, 'status', new.status, 'note', new.decision_note));
  end loop;

  if new.subtask_id is not null and new.status in ('approved', 'rejected') then
    update public.tasks set completed_at = now()
    where id = new.subtask_id and completed_at is null;
  end if;

  if new.status = 'approved' then
    select p.approval_completes_task into completes_task
    from public.tasks t join public.projects p on p.id = t.home_project_id
    where t.id = new.task_id;
    if completes_task then
      update public.tasks set completed_at = now() where id = new.task_id and completed_at is null;
    end if;
  end if;

  -- Rules skip subtasks (an approval on a subtask, e.g. a subtask approval task).
  if not exists (select 1 from public.tasks t where t.id = new.task_id and t.parent_task_id is not null) then
    perform public.fire_rules('approval_decided', new.task_id, null, jsonb_build_object(
      'approval_id', new.id, 'status', new.status, 'note', new.decision_note
    ));
  end if;
  return new;
end;
$$;

-- Runs as the caller. Milestones keep only a due date; people can't tick an approval task complete
-- while its assignee's request is open, nor tick an approval subtask while its approval is open
-- (system completions — the decision itself, rules — pass).
create or replace function public.guard_task_kind()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind = 'milestone' then
    new.start_on := null;
    new.start_at := null;
  end if;
  if tg_op = 'UPDATE'
     and public.is_client_role()
     and new.kind = 'approval'
     and old.completed_at is null and new.completed_at is not null
     and exists (
       select 1 from public.approval_requests a
       where a.task_id = new.id and a.subtask_id is null and a.approver_id = new.assignee_id
         and a.deleted_at is null and a.status in ('pending', 'changes_requested')
     ) then
    raise exception 'This is an approval task: its assignee approves, requests changes, or rejects it'
      using errcode = 'check_violation';
  end if;
  -- Approval subtasks (approval_requests.subtask_id) complete by deciding, not by ticking.
  if tg_op = 'UPDATE'
     and public.is_client_role()
     and new.completed_at is distinct from old.completed_at
     and exists (
       select 1 from public.approval_requests a
       where a.subtask_id = new.id and a.deleted_at is null
         and a.status in ('pending', 'changes_requested')
     ) then
    raise exception 'This subtask is an approval; approve, request changes, or reject it instead'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- Same as before; an approval subtask completed by its decision doesn't add `completed` items on
-- top of approval_decided either (one inbox item per event).
create or replace function public.on_task_update_collab()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  if new.deleted_at is not null and old.deleted_at is null then
    perform public.add_story(new.id, 'deleted', '{}'::jsonb);
    return new;
  end if;

  if new.completed_at is not null and old.completed_at is null then
    perform public.add_story(new.id, 'completed', '{}'::jsonb);
    -- An approval task, or an approval subtask, closed by its decision: people already got
    -- approval_decided.
    if not exists (
      select 1 from public.approval_requests a
      where a.deleted_at is null and a.status in ('approved', 'rejected') and a.decided_at = now()
        and ((new.kind = 'approval' and a.task_id = new.id and a.subtask_id is null) or a.subtask_id = new.id)
    ) then
      for r in
        select f.profile_id from public.task_followers f
        where f.task_id = new.id and f.deleted_at is null
      loop
        perform public.notify(r.profile_id, new.id, 'completed');
      end loop;
    end if;
  elsif new.completed_at is null and old.completed_at is not null then
    perform public.add_story(new.id, 'reopened', '{}'::jsonb);
  end if;

  if new.title is distinct from old.title then
    perform public.add_story(new.id, 'renamed', jsonb_build_object('from', old.title, 'to', new.title));
  end if;

  if new.assignee_id is distinct from old.assignee_id then
    if new.assignee_id is null then
      perform public.add_story(new.id, 'unassigned', jsonb_build_object('previous_id', old.assignee_id));
    else
      perform public.follow_task(new.id, new.assignee_id);
      perform public.add_story(new.id, 'assigned', jsonb_build_object('assignee_id', new.assignee_id));
      if new.kind <> 'approval' or new.completed_at is not null then
        perform public.notify(new.assignee_id, new.id, 'assigned');
      end if;
    end if;
  end if;

  if new.due_on is distinct from old.due_on then
    perform public.add_story(new.id, 'due_changed', jsonb_build_object('from', old.due_on, 'to', new.due_on));
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Rules and Req # skip subtasks (in the calling triggers; fire_rules is unchanged)
-- ---------------------------------------------------------------------------

-- Subtasks never get a Req #.
create or replace function public.assign_request_number_on_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  seq public.request_sequences;
  number bigint;
  label text;
begin
  if new.req_number is not null or new.parent_task_id is not null then
    return new;
  end if;
  select * into seq from public.request_sequences s
  where s.project_id = new.home_project_id and s.enabled and s.deleted_at is null;
  if not found or (seq.assign_to = 'form_submissions' and new.source <> 'form') then
    return new;
  end if;
  number := public.next_request_number(new.home_project_id);
  label := public.format_request_label(new.home_project_id, number);
  new.req_project_id := new.home_project_id;
  new.req_number := number;
  if seq.add_to_title then
    new.title := '[' || label || '] ' || new.title;
  end if;
  return new;
end;
$$;

-- Same checks and grant; subtasks are refused.
create or replace function public.assign_request_number(target_task uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tasks;
  seq public.request_sequences;
  number bigint;
  label text;
begin
  if not public.has_task_role(target_task, 'editor') then
    raise exception 'You need Editor access to number this task' using errcode = 'insufficient_privilege';
  end if;
  select * into t from public.tasks where id = target_task and deleted_at is null for update;
  if not found then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;
  if t.parent_task_id is not null then
    raise exception 'Subtasks don’t get request numbers' using errcode = 'check_violation';
  end if;
  if t.req_number is not null then
    return public.format_request_label(t.req_project_id, t.req_number);
  end if;
  select * into seq from public.request_sequences s
  where s.project_id = t.home_project_id and s.enabled and s.deleted_at is null;
  if not found then
    raise exception 'Request numbers are not enabled for this task''s home project'
      using errcode = 'check_violation';
  end if;
  number := public.next_request_number(t.home_project_id);
  label := public.format_request_label(t.home_project_id, number);
  update public.tasks
  set req_project_id = t.home_project_id,
      req_number = number,
      title = case when seq.add_to_title then '[' || label || '] ' || t.title else t.title end
  where id = target_task;
  perform public.add_story(target_task, 'request_number_assigned', jsonb_build_object('label', label));
  return label;
end;
$$;

create or replace function public.rules_on_task_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.assignee_id is distinct from old.assignee_id and new.deleted_at is null and new.parent_task_id is null then
    perform public.fire_rules('assignee_changed', new.id, null, jsonb_build_object('assignee_id', new.assignee_id));
  end if;
  return new;
end;
$$;

create or replace function public.rules_on_task_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.tasks t where t.id = new.id and t.deleted_at is null and t.parent_task_id is null) then
    perform public.fire_rules('task_created', new.id, null, '{}'::jsonb);
  end if;
  return null;
end;
$$;

create or replace function public.rules_on_field_value_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.value is not distinct from old.value then
    return new;
  end if;
  if exists (select 1 from public.tasks t where t.id = new.task_id and t.parent_task_id is not null) then
    return new;
  end if;
  if public.rule_context_id() is null
     and exists (select 1 from public.tasks t where t.id = new.task_id and t.created_at = now()) then
    return new;
  end if;
  perform public.fire_rules('field_changed', new.task_id,
    (select f.project_id from public.custom_fields f where f.id = new.field_id),
    jsonb_build_object('field_id', new.field_id, 'value', new.value));
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Search: subtasks are found and labelled with their root task's project
-- ---------------------------------------------------------------------------

-- Same as before (SECURITY INVOKER); a subtask is labelled with a project of its root task.
create or replace function public.search_tasks(query text, max_results integer default 50)
returns table (
  id uuid,
  title text,
  notes text,
  completed_at timestamptz,
  due_on date,
  assignee_id uuid,
  home_project_id uuid,
  home_project_name text
)
language sql
stable
set search_path = ''
as $$
  with pattern as (
    select '%' || replace(replace(replace(trim(query), '\', '\\'), '%', '\%'), '_', '\_') || '%' as value
  )
  select t.id, t.title, t.notes, t.completed_at, t.due_on, t.assignee_id, shown.id, shown.name
  from public.tasks t
  cross join pattern
  cross join lateral (
    select p.id, p.name
    from public.task_projects tp
    join public.projects p on p.id = tp.project_id
    where tp.task_id = coalesce(t.root_task_id, t.id) and tp.deleted_at is null and p.deleted_at is null
    order by (tp.project_id = t.home_project_id) desc, tp.created_at
    limit 1
  ) shown
  where length(trim(query)) > 0
    and t.deleted_at is null
    and (t.title ilike pattern.value or t.notes ilike pattern.value)
  order by t.completed_at is not null, t.title ilike pattern.value desc, t.updated_at desc
  limit least(greatest(coalesce(max_results, 50), 1), 100);
$$;

-- ---------------------------------------------------------------------------
-- Copy engine: project snapshots carry full subtask trees
-- ---------------------------------------------------------------------------
-- Snapshot task key "subtasks" is now a tree: [{ title, notes, kind, completed, completed_at,
-- assignee_id, due_offset, start_offset, fields, subtasks: [...] }] (same keys and rules as a task,
-- offsets from the same anchor). Approval subtasks are still left out. Older snapshots ([{ title,
-- completed }]) still instantiate. Internal helpers, revoked from clients; they run inside the
-- SECURITY DEFINER copy functions.

-- Stored values of the source project's fields on one task, as snapshot "fields" (date values become
-- day offsets; people values only with assignees; dates only with dates).
create or replace function public.snapshot_task_fields(
  source_task uuid, source_project uuid, anchor date, want_assignees boolean, want_dates boolean
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(case
      when f.field_type = 'date' then jsonb_build_object('field_id', f.id, 'offset', (v.value #>> '{}')::date - anchor)
      else jsonb_build_object('field_id', f.id, 'value', v.value) end), '[]'::jsonb)
  from public.task_field_values v
  join public.custom_fields f on f.id = v.field_id and f.project_id = source_project and f.deleted_at is null
    and not f.bound_to_sections
  where v.task_id = source_task and v.value is not null and v.value <> 'null'::jsonb
    and (f.field_type <> 'people' or want_assignees)
    and (f.field_type <> 'date' or (want_dates and jsonb_typeof(v.value) = 'string'
      and v.value #>> '{}' ~ '^\d{4}-\d{2}-\d{2}$'));
$$;

create or replace function public.snapshot_subtasks(
  parent uuid, source_project uuid, anchor date, want_assignees boolean, want_dates boolean, keep_completion boolean
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'title', c.title,
      'notes', c.notes,
      'kind', c.kind,
      'completed', keep_completion and c.completed_at is not null,
      'completed_at', case when keep_completion then c.completed_at end,
      'assignee_id', case when want_assignees then c.assignee_id end,
      'due_offset', case when want_dates and c.due_on is not null then c.due_on - anchor end,
      'start_offset', case when want_dates and c.start_on is not null then c.start_on - anchor end,
      'fields', public.snapshot_task_fields(c.id, source_project, anchor, want_assignees, want_dates),
      'subtasks', public.snapshot_subtasks(c.id, source_project, anchor, want_assignees, want_dates, keep_completion)
    ) order by c.subtask_order, c.created_at, c.id)
    from public.tasks c
    where c.parent_task_id = parent and c.deleted_at is null
      and not exists (select 1 from public.approval_requests a where a.subtask_id = c.id)
  ), '[]'::jsonb);
end;
$$;

-- Field values from a snapshot "fields" list onto a new task; returns how many were skipped.
create or replace function public.instantiate_task_fields(new_task uuid, fields jsonb, id_map jsonb, base_date date)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  child jsonb;
  found_id uuid;
  v_field_type text;
  v_value jsonb;
  skipped integer := 0;
begin
  for child in select * from jsonb_array_elements(case when jsonb_typeof(fields) = 'array' then fields else '[]' end) loop
    found_id := (id_map ->> (child ->> 'field_id'))::uuid;
    select f.field_type into v_field_type from public.custom_fields f where f.id = found_id;
    v_value := case
      when found_id is null then null
      when v_field_type = 'date' and jsonb_typeof(child -> 'offset') = 'number'
        then to_jsonb((base_date + (child ->> 'offset')::integer)::text)
      when v_field_type = 'date' then null
      else child -> 'value'
    end;
    if v_value is null then
      skipped := skipped + 1;
      continue;
    end if;
    begin
      insert into public.task_field_values (task_id, field_id, value) values (new_task, found_id, v_value);
    exception when check_violation or foreign_key_violation or invalid_text_representation then
      skipped := skipped + 1;
    end;
  end loop;
  return skipped;
end;
$$;

-- A snapshot subtask tree under parent; returns { created, values_skipped }. Assignees are kept only
-- when they can read the new project. Levels past subtask_max_depth() are flattened into the deepest
-- allowed one (never happens for trees copied from this app).
create or replace function public.instantiate_subtasks(
  parent uuid, items jsonb, base_date date, id_map jsonb, new_project uuid, me uuid, depth integer default 1
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  child jsonb;
  new_id uuid;
  assignee uuid;
  v_due date;
  v_start date;
  i integer := 0;
  created integer := 0;
  skipped integer := 0;
  sub jsonb;
begin
  for child in select * from jsonb_array_elements(case when jsonb_typeof(items) = 'array' then items else '[]' end) loop
    continue when jsonb_typeof(child) <> 'object' or nullif(trim(child ->> 'title'), '') is null;
    i := i + 1;
    assignee := case when child ->> 'assignee_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then (child ->> 'assignee_id')::uuid end;
    if assignee is not null and public.profile_project_role(assignee, new_project) is null then
      assignee := null;
    end if;
    v_due := case when jsonb_typeof(child -> 'due_offset') = 'number' then base_date + (child ->> 'due_offset')::integer end;
    v_start := case when jsonb_typeof(child -> 'start_offset') = 'number' then base_date + (child ->> 'start_offset')::integer end;
    if v_start > v_due then
      v_start := null;
    end if;
    insert into public.tasks (parent_task_id, title, notes, completed_at, assignee_id, due_on, start_on, created_by, kind, subtask_order)
    values (
      parent,
      left(trim(child ->> 'title'), 1000),
      child ->> 'notes',
      case when coalesce((child ->> 'completed')::boolean, false)
        then coalesce((child ->> 'completed_at')::timestamptz, now()) end,
      assignee,
      v_due,
      v_start,
      me,
      case when child ->> 'kind' in ('milestone', 'approval') then child ->> 'kind' else 'task' end,
      i * 1024
    )
    returning id into new_id;
    created := created + 1;
    skipped := skipped + public.instantiate_task_fields(new_id, child -> 'fields', id_map, base_date);
    if depth < public.subtask_max_depth() then
      sub := public.instantiate_subtasks(new_id, child -> 'subtasks', base_date, id_map, new_project, me, depth + 1);
    else
      sub := public.instantiate_subtasks(parent, child -> 'subtasks', base_date, id_map, new_project, me, depth);
    end if;
    created := created + (sub ->> 'created')::integer;
    skipped := skipped + (sub ->> 'values_skipped')::integer;
  end loop;
  return jsonb_build_object('created', created, 'values_skipped', skipped);
end;
$$;

-- ---------------------------------------------------------------------------
-- Recurrence: the next occurrence gets a copy of the subtask tree
-- ---------------------------------------------------------------------------
-- Every active subtask except approval subtasks, as an open task: title, notes, kind, assignee, dates
-- and times shifted by day_shift (times keep their local time in the subtask's zone), stored field
-- values (ones that no longer validate are skipped), followers, and order. Not its own recurrence,
-- comments, attachments, approvals, or dependencies (same as the task itself). Runs inside the
-- SECURITY DEFINER spawn_next_occurrence().
create or replace function public.copy_subtask_tree(source_parent uuid, target_parent uuid, day_shift integer)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  c public.tasks;
  tz text;
  new_id uuid;
  r record;
  copied integer := 0;
begin
  for c in
    select * from public.tasks s
    where s.parent_task_id = source_parent and s.deleted_at is null
      and not exists (select 1 from public.approval_requests a where a.subtask_id = s.id)
    order by s.subtask_order, s.created_at, s.id
  loop
    tz := public.safe_timezone(c.time_zone);
    insert into public.tasks (
      parent_task_id, title, notes, assignee_id, start_on, due_on, start_at, due_at, time_zone, created_by,
      kind, subtask_order
    )
    values (
      target_parent, c.title, c.notes, c.assignee_id,
      c.start_on + day_shift, c.due_on + day_shift,
      ((c.start_at at time zone tz) + make_interval(days => day_shift)) at time zone tz,
      ((c.due_at at time zone tz) + make_interval(days => day_shift)) at time zone tz,
      c.time_zone, c.created_by, c.kind, c.subtask_order
    )
    returning id into new_id;
    copied := copied + 1;

    for r in
      select v.field_id, v.value from public.task_field_values v
      join public.custom_fields f on f.id = v.field_id and f.deleted_at is null and not f.bound_to_sections
      where v.task_id = c.id and v.value is not null and jsonb_typeof(v.value) <> 'null'
    loop
      begin
        insert into public.task_field_values (task_id, field_id, value) values (new_id, r.field_id, r.value);
      exception when check_violation or foreign_key_violation then
        null;
      end;
    end loop;

    for r in
      select f.profile_id from public.task_followers f where f.task_id = c.id and f.deleted_at is null
    loop
      perform public.follow_task(new_id, r.profile_id);
    end loop;

    copied := copied + public.copy_subtask_tree(c.id, new_id, day_shift);
  end loop;
  return copied;
end;
$$;

revoke all on function public.snapshot_task_fields(uuid, uuid, date, boolean, boolean) from public, anon, authenticated;
revoke all on function public.snapshot_subtasks(uuid, uuid, date, boolean, boolean, boolean) from public, anon, authenticated;
revoke all on function public.instantiate_task_fields(uuid, jsonb, jsonb, date) from public, anon, authenticated;
revoke all on function public.instantiate_subtasks(uuid, jsonb, date, jsonb, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.copy_subtask_tree(uuid, uuid, integer) from public, anon, authenticated;

-- Same as before; "subtasks" is the full subtask tree (snapshot_subtasks()).
create or replace function public.project_snapshot(source_project uuid, opts jsonb default '{}')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.projects;
  want_tasks boolean := coalesce((opts ->> 'tasks')::boolean, true);
  want_assignees boolean := coalesce((opts ->> 'assignees')::boolean, false);
  want_dates boolean := coalesce((opts ->> 'dates')::boolean, true);
  keep_completion boolean := coalesce((opts ->> 'keep_completion')::boolean, false);
  want_rules boolean := coalesce((opts ->> 'rules')::boolean, true);
  want_forms boolean := coalesce((opts ->> 'forms')::boolean, true);
  want_views boolean := coalesce((opts ->> 'views')::boolean, true);
  want_members boolean := coalesce((opts ->> 'members')::boolean, false);
  anchor date := nullif(opts ->> 'anchor_on', '')::date;
  task_count integer;
begin
  select * into p from public.projects where id = source_project and deleted_at is null;
  if not found then
    raise exception 'Project not found' using errcode = 'no_data_found';
  end if;

  if to_regclass('pg_temp.snapshot_tasks') is null then
    create temporary table snapshot_tasks (
      id uuid primary key, title text, notes text, section_id uuid, section_order double precision,
      sort_order double precision, completed_at timestamptz, assignee_id uuid, due_on date, start_on date,
      kind text
    ) on commit drop;
  else
    truncate pg_temp.snapshot_tasks;
  end if;

  if want_tasks then
    insert into pg_temp.snapshot_tasks
    select t.id,
      case
        when t.req_number is not null and left(t.title, length('[' || public.format_request_label(t.req_project_id, t.req_number) || '] '))
             = '[' || public.format_request_label(t.req_project_id, t.req_number) || '] '
             and length(t.title) > length('[' || public.format_request_label(t.req_project_id, t.req_number) || '] ')
          then substr(t.title, length('[' || public.format_request_label(t.req_project_id, t.req_number) || '] ') + 1)
        else t.title
      end,
      t.notes, s.id, s.sort_order, tp.sort_order, t.completed_at, t.assignee_id, t.due_on, t.start_on, t.kind
    from public.tasks t
    join public.task_projects tp on tp.task_id = t.id and tp.project_id = p.id and tp.deleted_at is null
    left join public.sections s on s.id = tp.section_id and s.deleted_at is null
    where t.deleted_at is null;
  end if;

  select count(*) into task_count from pg_temp.snapshot_tasks;
  if task_count > 2000 then
    raise exception 'Projects with more than 2,000 tasks can’t be copied yet (this one has %)', task_count
      using errcode = 'check_violation';
  end if;

  if anchor is null and want_dates then
    select min(least(st.start_on, st.due_on)) into anchor from pg_temp.snapshot_tasks st;
  end if;
  anchor := coalesce(anchor, current_date);

  return jsonb_build_object(
    'version', 1,
    'project', jsonb_build_object('description', p.description, 'approval_completes_task', p.approval_completes_task),
    'anchor_on', anchor,
    'request_sequence', (
      select jsonb_build_object('enabled', rs.enabled, 'prefix', rs.prefix, 'pad_width', rs.pad_width,
        'add_to_title', rs.add_to_title, 'assign_to', rs.assign_to)
      from public.request_sequences rs where rs.project_id = p.id and rs.deleted_at is null
    ),
    'sections', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) order by s.sort_order, s.created_at)
      from public.sections s where s.project_id = p.id and s.deleted_at is null
    ), '[]'::jsonb),
    'fields', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', f.id, 'name', f.name, 'field_type', f.field_type, 'options', f.options,
        'bound_to_sections', f.bound_to_sections, 'show_in_views', f.show_in_views
      ) order by f.sort_order, f.created_at)
      from public.custom_fields f where f.project_id = p.id and f.deleted_at is null
    ), '[]'::jsonb),
    'forms', case when want_forms then coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', fm.id, 'title', fm.title, 'description', fm.description, 'questions', fm.questions,
        'destination_section_id', fm.destination_section_id, 'send_confirmation', fm.send_confirmation,
        'confirmation_message', fm.confirmation_message
      ) order by fm.created_at)
      from public.forms fm where fm.project_id = p.id and fm.deleted_at is null
    ), '[]'::jsonb) else '[]'::jsonb end,
    'rules', case when want_rules then coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', r.name, 'trigger_type', r.trigger_type, 'trigger_config', r.trigger_config,
        'conditions', r.conditions,
        -- Saved integration URLs / secrets stay with the source project.
        'actions', coalesce((
          select jsonb_agg(case when jsonb_typeof(a.value) = 'object'
            then a.value - 'webhook_ref' - 'webhook_hint' - 'url_ref' - 'url_hint' - 'secret_ref' - 'secret_set'
            else a.value end order by a.ordinality)
          from jsonb_array_elements(r.actions) with ordinality a
        ), '[]'::jsonb),
        'preset_key', r.preset_key
      ) order by r.sort_order, r.created_at)
      from public.rules r where r.project_id = p.id and r.deleted_at is null
    ), '[]'::jsonb) else '[]'::jsonb end,
    'views', case when want_views then coalesce((
      select jsonb_agg(jsonb_build_object('name', v.name, 'layout', v.layout, 'config', v.config)
        order by v.sort_order, v.created_at)
      from public.project_views v where v.project_id = p.id and v.deleted_at is null
    ), '[]'::jsonb) else '[]'::jsonb end,
    'tasks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', st.id,
        'title', st.title,
        'notes', st.notes,
        'kind', st.kind,
        'section_id', st.section_id,
        'sort_order', st.sort_order,
        'completed', keep_completion and st.completed_at is not null,
        'completed_at', case when keep_completion then st.completed_at end,
        'assignee_id', case when want_assignees then st.assignee_id end,
        'due_offset', case when want_dates and st.due_on is not null then st.due_on - anchor end,
        'start_offset', case when want_dates and st.start_on is not null then st.start_on - anchor end,
        'fields', coalesce((
          select jsonb_agg(case
            when f.field_type = 'date' then jsonb_build_object('field_id', f.id, 'offset', (v.value #>> '{}')::date - anchor)
            else jsonb_build_object('field_id', f.id, 'value', v.value) end)
          from public.task_field_values v
          join public.custom_fields f on f.id = v.field_id and f.project_id = p.id and f.deleted_at is null
            and not f.bound_to_sections
          where v.task_id = st.id and v.value is not null and v.value <> 'null'::jsonb
            and (f.field_type <> 'people' or want_assignees)
            and (f.field_type <> 'date' or (want_dates and jsonb_typeof(v.value) = 'string'
              and v.value #>> '{}' ~ '^\d{4}-\d{2}-\d{2}$'))
        ), '[]'::jsonb),
        'subtasks', public.snapshot_subtasks(st.id, p.id, anchor, want_assignees, want_dates, keep_completion)
      ) order by st.section_order nulls first, st.sort_order, st.id)
      from pg_temp.snapshot_tasks st
    ), '[]'::jsonb),
    'dependencies', coalesce((
      select jsonb_agg(jsonb_build_object('predecessor', d.predecessor_id, 'successor', d.successor_id))
      from public.task_dependencies d
      where d.deleted_at is null
        and d.predecessor_id in (select st.id from pg_temp.snapshot_tasks st)
        and d.successor_id in (select st.id from pg_temp.snapshot_tasks st)
    ), '[]'::jsonb),
    'members', case when want_members then coalesce((
      select jsonb_agg(jsonb_build_object('profile_id', m.profile_id, 'role', m.role) order by m.created_at)
      from public.project_members m where m.project_id = p.id and m.deleted_at is null
    ), '[]'::jsonb) else '[]'::jsonb end
  );
end;
$$;

-- Same as before; each task's subtask tree is created with instantiate_subtasks() (quiet like the
-- rest of the copy: alhc.copy_id is set), and the result also counts "subtasks".
create or replace function public.instantiate_project_snapshot(
  snapshot jsonb,
  project_name text,
  start_on date,
  target_workspace uuid,
  story_kind text,
  story_data jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := public.current_profile_id();
  new_project uuid;
  id_map jsonb := '{}'::jsonb;    -- sections, fields, forms
  task_map jsonb := '{}'::jsonb;
  item jsonb;
  child jsonb;
  found_id uuid;
  new_task uuid;
  v_section uuid;
  v_field_type text;
  v_value jsonb;
  assignee uuid;
  base_date date := coalesce(start_on, current_date);
  i integer;
  kept_views uuid[] := '{}';
  n_sections integer := 0;
  n_fields integer := 0;
  n_tasks integer := 0;
  n_rules integer := 0;
  n_rules_skipped integer := 0;
  n_forms integer := 0;
  n_forms_skipped integer := 0;
  n_views integer := 0;
  n_views_skipped integer := 0;
  n_values_skipped integer := 0;
  n_members integer := 0;
  n_subtasks integer := 0;
  sub_result jsonb;
begin
  if me is null or not public.is_allowlisted() then
    raise exception 'Sign in to create projects' using errcode = 'insufficient_privilege';
  end if;
  if jsonb_typeof(snapshot) <> 'object' or (snapshot ->> 'version') is distinct from '1' then
    raise exception 'This template can’t be used (unknown format)' using errcode = 'check_violation';
  end if;
  if nullif(trim(coalesce(project_name, '')), '') is null then
    raise exception 'Project name can’t be empty' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.workspaces w where w.id = target_workspace and w.deleted_at is null) then
    raise exception 'Workspace not found' using errcode = 'no_data_found';
  end if;

  -- Left set until the transaction ends so the deferred task_created rule trigger sees it too.
  perform set_config('alhc.copy_id', gen_random_uuid()::text, true);

  insert into public.projects (workspace_id, name, description, approval_completes_task, created_by, sort_order)
  values (
    target_workspace,
    left(trim(project_name), 200),
    nullif(snapshot #>> '{project,description}', ''),
    coalesce((snapshot #>> '{project,approval_completes_task}')::boolean, false),
    me,
    coalesce((select max(pj.sort_order) from public.projects pj
              where pj.workspace_id = target_workspace and pj.deleted_at is null), 0) + 1024
  )
  returning id into new_project;
  -- projects_add_owner made the caller the owner.

  -- Members (Duplicate project only): owners of the source join as admins; the caller stays owner.
  for item in select * from jsonb_array_elements(case when jsonb_typeof(snapshot -> 'members') = 'array' then snapshot -> 'members' else '[]' end) loop
    found_id := (item ->> 'profile_id')::uuid;
    continue when found_id is null or found_id = me or not public.profile_is_allowlisted(found_id)
      or public.project_role_rank(item ->> 'role') = 0;
    insert into public.project_members (project_id, profile_id, role, created_by)
    values (new_project, found_id, case when item ->> 'role' = 'owner' then 'admin' else item ->> 'role' end, me);
    n_members := n_members + 1;
  end loop;

  -- Req # settings (numbering restarts at 1).
  if jsonb_typeof(snapshot -> 'request_sequence') = 'object' then
    insert into public.request_sequences (project_id, enabled, prefix, pad_width, add_to_title, assign_to)
    values (
      new_project,
      coalesce((snapshot #>> '{request_sequence,enabled}')::boolean, true),
      left(coalesce(snapshot #>> '{request_sequence,prefix}', 'Req #'), 20),
      least(greatest(coalesce((snapshot #>> '{request_sequence,pad_width}')::smallint, 0), 0), 8),
      coalesce((snapshot #>> '{request_sequence,add_to_title}')::boolean, true),
      case when snapshot #>> '{request_sequence,assign_to}' = 'all_tasks' then 'all_tasks' else 'form_submissions' end
    );
  end if;

  -- Sections -------------------------------------------------------------------------------------
  i := 0;
  for item in select * from jsonb_array_elements(case when jsonb_typeof(snapshot -> 'sections') = 'array' then snapshot -> 'sections' else '[]' end) loop
    continue when nullif(trim(item ->> 'name'), '') is null;
    i := i + 1;
    insert into public.sections (project_id, name, sort_order)
    values (new_project, left(trim(item ->> 'name'), 200), i * 1024)
    returning id into found_id;
    if nullif(item ->> 'id', '') is not null then
      id_map := id_map || jsonb_build_object(item ->> 'id', found_id);
    end if;
    n_sections := n_sections + 1;
  end loop;

  -- Custom field definitions (option ids are kept, so rule/form/value references stay valid) -------
  i := 0;
  for item in select * from jsonb_array_elements(case when jsonb_typeof(snapshot -> 'fields') = 'array' then snapshot -> 'fields' else '[]' end) loop
    i := i + 1;
    insert into public.custom_fields (project_id, name, field_type, options, bound_to_sections, show_in_views, sort_order)
    values (
      new_project,
      left(trim(item ->> 'name'), 100),
      item ->> 'field_type',
      case when jsonb_typeof(item -> 'options') = 'array' then item -> 'options' else '[]'::jsonb end,
      coalesce((item ->> 'bound_to_sections')::boolean, false),
      coalesce((item ->> 'show_in_views')::boolean, false),
      i * 1024
    )
    returning id into found_id;
    if nullif(item ->> 'id', '') is not null then
      id_map := id_map || jsonb_build_object(item ->> 'id', found_id);
    end if;
    n_fields := n_fields + 1;
  end loop;

  -- Forms (closed until someone opens them; ones that no longer validate are skipped) --------------
  for item in select * from jsonb_array_elements(case when jsonb_typeof(snapshot -> 'forms') = 'array' then snapshot -> 'forms' else '[]' end) loop
    begin
      insert into public.forms (project_id, title, description, questions, destination_section_id, accepting_responses,
        send_confirmation, confirmation_message, created_by)
      values (
        new_project,
        left(coalesce(nullif(trim(item ->> 'title'), ''), 'Form'), 200),
        item ->> 'description',
        coalesce(public.template_remap(item -> 'questions', id_map), '[]'::jsonb),
        (id_map ->> (item ->> 'destination_section_id'))::uuid,
        false,
        coalesce((item ->> 'send_confirmation')::boolean, true),
        item ->> 'confirmation_message',
        me
      )
      returning id into found_id;
      if nullif(item ->> 'id', '') is not null then
        id_map := id_map || jsonb_build_object(item ->> 'id', found_id);
      end if;
      n_forms := n_forms + 1;
    exception when check_violation or not_null_violation or invalid_text_representation
      or foreign_key_violation or invalid_parameter_value or raise_exception then
      n_forms_skipped := n_forms_skipped + 1;
    end;
  end loop;

  -- Rules: ALWAYS disabled (rules_04_copy_disabled forces it too). Invalid ones are skipped. --------
  i := 0;
  for item in select * from jsonb_array_elements(case when jsonb_typeof(snapshot -> 'rules') = 'array' then snapshot -> 'rules' else '[]' end) loop
    i := i + 1;
    begin
      insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, conditions, actions,
        preset_key, created_by, sort_order)
      values (
        new_project,
        left(coalesce(nullif(trim(item ->> 'name'), ''), 'Copied rule'), 200),
        false,
        item ->> 'trigger_type',
        coalesce(public.template_remap(item -> 'trigger_config', id_map), '{}'::jsonb),
        coalesce(public.template_remap(item -> 'conditions', id_map), '[]'::jsonb),
        coalesce(public.template_remap(item -> 'actions', id_map), '[]'::jsonb),
        item ->> 'preset_key',
        me,
        i * 1024
      );
      n_rules := n_rules + 1;
    exception when check_violation or not_null_violation or invalid_text_representation
      or foreign_key_violation or invalid_parameter_value or raise_exception then
      n_rules_skipped := n_rules_skipped + 1;
    end;
  end loop;

  -- Saved views replace the default tabs when at least one copies cleanly --------------------------
  i := 0;
  for item in select * from jsonb_array_elements(case when jsonb_typeof(snapshot -> 'views') = 'array' then snapshot -> 'views' else '[]' end) loop
    i := i + 1;
    begin
      insert into public.project_views (project_id, name, layout, config, sort_order, created_by)
      values (
        new_project,
        left(trim(item ->> 'name'), 100),
        item ->> 'layout',
        coalesce(public.template_remap(item -> 'config', id_map), '{}'::jsonb),
        i * 1024,
        me
      )
      returning id into found_id;
      kept_views := kept_views || found_id;
      n_views := n_views + 1;
    exception when check_violation or not_null_violation or invalid_text_representation
      or foreign_key_violation or invalid_parameter_value or raise_exception then
      n_views_skipped := n_views_skipped + 1;
    end;
  end loop;
  if cardinality(kept_views) > 0 then
    update public.project_views set deleted_at = now()
    where project_id = new_project and deleted_at is null and not (id = any (kept_views));
  end if;

  -- Tasks ------------------------------------------------------------------------------------------
  for item in select * from jsonb_array_elements(case when jsonb_typeof(snapshot -> 'tasks') = 'array' then snapshot -> 'tasks' else '[]' end) loop
    -- Assignees are kept only when they can read the new project (members copied with it, or the caller).
    assignee := (item ->> 'assignee_id')::uuid;
    if assignee is not null and public.profile_project_role(assignee, new_project) is null then
      assignee := null;
    end if;
    insert into public.tasks (home_project_id, title, notes, completed_at, assignee_id, due_on, start_on, created_by, kind)
    values (
      new_project,
      left(coalesce(nullif(trim(item ->> 'title'), ''), 'Untitled task'), 1000),
      item ->> 'notes',
      case when coalesce((item ->> 'completed')::boolean, false)
        then coalesce((item ->> 'completed_at')::timestamptz, now()) end,
      assignee,
      case when jsonb_typeof(item -> 'due_offset') = 'number' then base_date + (item ->> 'due_offset')::integer end,
      case when jsonb_typeof(item -> 'start_offset') = 'number' then base_date + (item ->> 'start_offset')::integer end,
      me,
      case when item ->> 'kind' in ('milestone', 'approval') then item ->> 'kind' else 'task' end
    )
    returning id into new_task;
    n_tasks := n_tasks + 1;
    if nullif(item ->> 'id', '') is not null then
      task_map := task_map || jsonb_build_object(item ->> 'id', new_task);
    end if;

    v_section := (id_map ->> (item ->> 'section_id'))::uuid;
    update public.task_projects
    set section_id = v_section,
        sort_order = coalesce((item ->> 'sort_order')::double precision, sort_order)
    where task_id = new_task and project_id = new_project;

    for child in select * from jsonb_array_elements(case when jsonb_typeof(item -> 'fields') = 'array' then item -> 'fields' else '[]' end) loop
      found_id := (id_map ->> (child ->> 'field_id'))::uuid;
      select f.field_type into v_field_type from public.custom_fields f where f.id = found_id;
      v_value := case
        when found_id is null then null
        when v_field_type = 'date' and jsonb_typeof(child -> 'offset') = 'number'
          then to_jsonb((base_date + (child ->> 'offset')::integer)::text)
        when v_field_type = 'date' then null
        else child -> 'value'
      end;
      if v_value is null then
        n_values_skipped := n_values_skipped + 1;
        continue;
      end if;
      begin
        insert into public.task_field_values (task_id, field_id, value) values (new_task, found_id, v_value);
      exception when check_violation or foreign_key_violation or invalid_text_representation then
        n_values_skipped := n_values_skipped + 1;
      end;
    end loop;

    sub_result := public.instantiate_subtasks(new_task, item -> 'subtasks', base_date, id_map, new_project, me);
    n_subtasks := n_subtasks + (sub_result ->> 'created')::integer;
    n_values_skipped := n_values_skipped + (sub_result ->> 'values_skipped')::integer;
  end loop;

  -- Dependencies between copied tasks (the source had no cycles, so neither does the copy) ---------
  insert into public.task_dependencies (project_id, predecessor_id, successor_id, created_by)
  select distinct new_project, (task_map ->> (d ->> 'predecessor'))::uuid, (task_map ->> (d ->> 'successor'))::uuid, me
  from jsonb_array_elements(case when jsonb_typeof(snapshot -> 'dependencies') = 'array' then snapshot -> 'dependencies' else '[]' end) d
  where task_map ? (d ->> 'predecessor') and task_map ? (d ->> 'successor')
    and d ->> 'predecessor' <> d ->> 'successor';

  -- The caller auto-followed every copied task as its creator; keep only the ones assigned to them.
  update public.task_followers tf set deleted_at = now()
  from public.tasks t
  where t.id = tf.task_id and t.home_project_id = new_project and tf.profile_id = me and tf.deleted_at is null
    and t.assignee_id is distinct from me;

  insert into public.project_stories (project_id, actor_id, kind, data)
  values (new_project, me, story_kind, coalesce(story_data, '{}'::jsonb) || jsonb_build_object(
    'start_on', base_date, 'tasks', n_tasks, 'rules', n_rules));

  return jsonb_build_object(
    'project_id', new_project,
    'sections', n_sections,
    'fields', n_fields,
    'tasks', n_tasks,
    'subtasks', n_subtasks,
    'rules', n_rules,
    'rules_skipped', n_rules_skipped,
    'forms', n_forms,
    'forms_skipped', n_forms_skipped,
    'views', n_views,
    'views_skipped', n_views_skipped,
    'values_skipped', n_values_skipped,
    'members', n_members
  );
end;
$$;

-- Same as before, plus: the next occurrence gets a full copy of the subtask tree
-- (copy_subtask_tree()), and a recurring subtask spawns under the same parent.
create or replace function public.spawn_next_occurrence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  rule jsonb := new.recurrence;
  ends jsonb := coalesce(new.recurrence -> 'ends', '{"type": "never"}'::jsonb);
  rule_tz text := public.safe_timezone(new.recurrence ->> 'timezone');
  time_tz text := public.safe_timezone(new.time_zone);
  anchor date := coalesce(new.due_on, new.start_on, (now() at time zone rule_tz)::date);
  next_anchor date;
  shift integer;
  next_id uuid;
  next_rule jsonb;
  next_title text := new.title;
  label text;
  r record;
begin
  if new.recurrence_next_id is not null and exists (
    select 1 from public.tasks t where t.id = new.recurrence_next_id and t.deleted_at is null
  ) then
    return null;
  end if;
  if ends ->> 'type' = 'after' and new.recurrence_seq >= (ends ->> 'count')::integer then
    return null;
  end if;
  -- A recurring subtask's next occurrence goes under the same parent, unless that is gone.
  if new.parent_task_id is not null and not exists (
    select 1 from public.tasks t where t.id = new.parent_task_id and t.deleted_at is null
  ) then
    return null;
  end if;
  next_anchor := public.recurrence_next_date(rule, anchor);
  if ends ->> 'type' = 'until' and next_anchor > (ends ->> 'until')::date then
    return null;
  end if;
  shift := next_anchor - anchor;

  -- A title prefixed with this task's Req # gets the next occurrence's own number instead.
  if new.req_number is not null then
    label := '[' || public.format_request_label(new.req_project_id, new.req_number) || '] ';
    if left(next_title, length(label)) = label then
      next_title := substr(next_title, length(label) + 1);
    end if;
  end if;

  next_rule := rule;
  if rule ->> 'freq' in ('monthly', 'yearly') and not rule ? 'month_day' then
    next_rule := rule || jsonb_build_object('month_day', extract(day from anchor)::integer);
  end if;

  insert into public.tasks (
    home_project_id, title, notes, assignee_id, start_on, due_on, start_at, due_at, time_zone, created_by,
    recurrence, recurrence_series_id, recurrence_seq, kind, parent_task_id, subtask_order
  )
  values (
    new.home_project_id,
    next_title,
    new.notes,
    new.assignee_id,
    new.start_on + shift,
    case when new.due_on is null and new.start_on is null then next_anchor else new.due_on + shift end,
    ((new.start_at at time zone time_tz) + make_interval(days => shift)) at time zone time_tz,
    ((new.due_at at time zone time_tz) + make_interval(days => shift)) at time zone time_tz,
    new.time_zone,
    new.created_by,
    next_rule,
    coalesce(new.recurrence_series_id, new.id),
    new.recurrence_seq + 1,
    new.kind,
    new.parent_task_id,
    case when new.parent_task_id is not null then coalesce((
      select max(s.subtask_order) from public.tasks s where s.parent_task_id = new.parent_task_id and s.deleted_at is null
    ), 0) + 1024 else 0 end
  )
  returning id into next_id;

  -- Same projects and sections (the home membership exists already via ensure_home_membership).
  update public.task_projects tp
  set section_id = src.section_id
  from public.task_projects src
  join public.sections s on s.id = src.section_id and s.deleted_at is null
  where tp.task_id = next_id
    and src.task_id = new.id
    and src.project_id = tp.project_id
    and src.deleted_at is null;

  insert into public.task_projects (task_id, project_id, section_id, sort_order)
  select
    next_id,
    src.project_id,
    (select s.id from public.sections s where s.id = src.section_id and s.deleted_at is null),
    coalesce((select max(x.sort_order) from public.task_projects x
              where x.project_id = src.project_id and x.deleted_at is null), 0) + 1024
  from public.task_projects src
  join public.projects p on p.id = src.project_id and p.deleted_at is null
  where src.task_id = new.id
    and src.deleted_at is null
    and src.project_id <> new.home_project_id
  on conflict (task_id, project_id) do nothing;

  -- Stored custom field values whose field still exists in one of the new task's projects. A value
  -- that no longer validates (e.g. a removed option) is skipped rather than blocking the completion.
  for r in
    select v.field_id, v.value
    from public.task_field_values v
    join public.custom_fields f on f.id = v.field_id and f.deleted_at is null and not f.bound_to_sections
    where v.task_id = new.id
      and v.value is not null
      and jsonb_typeof(v.value) <> 'null'
      and exists (
        select 1 from public.task_projects tp
        where tp.task_id = next_id and tp.project_id = f.project_id and tp.deleted_at is null
      )
  loop
    begin
      insert into public.task_field_values (task_id, field_id, value) values (next_id, r.field_id, r.value);
    exception when check_violation or foreign_key_violation then
      null;
    end;
  end loop;

  -- The subtask tree (except approval subtasks), open, with dates shifted like the task's.
  perform public.copy_subtask_tree(new.id, next_id, shift);

  for r in
    select f.profile_id from public.task_followers f where f.task_id = new.id and f.deleted_at is null
  loop
    perform public.follow_task(next_id, r.profile_id);
  end loop;

  update public.tasks set recurrence_next_id = next_id where id = new.id;
  perform public.add_story(new.id, 'recurrence_spawned', jsonb_build_object(
    'next_task_id', next_id,
    'due_on', (select t.due_on from public.tasks t where t.id = next_id)
  ));
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Task templates keep subtask titles (direct subtasks)
-- ---------------------------------------------------------------------------

-- Same as before; subtask titles come from the task's direct subtasks, and a subtask can be saved
-- as a template of its root task's project.
create or replace function public.save_task_as_template(
  target_task uuid,
  target_project uuid,
  template_name text,
  include_assignee boolean default false
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  t public.tasks;
  clean_title text;
  label text;
  created uuid;
begin
  select * into t from public.tasks where id = target_task and deleted_at is null;
  if not found then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;
  if not exists (
    select 1 from public.task_projects tp
    where tp.task_id = coalesce(t.root_task_id, t.id) and tp.project_id = target_project and tp.deleted_at is null
  ) then
    raise exception 'This task isn’t in that project' using errcode = 'check_violation';
  end if;
  if not public.has_project_role(target_project, 'editor') then
    raise exception 'Only editors and above can save task templates' using errcode = 'insufficient_privilege';
  end if;
  clean_title := t.title;
  if t.req_number is not null then
    label := '[' || public.format_request_label(t.req_project_id, t.req_number) || '] ';
    if left(clean_title, length(label)) = label and length(clean_title) > length(label) then
      clean_title := substr(clean_title, length(label) + 1);
    end if;
  end if;
  insert into public.task_templates (project_id, name, title, notes, subtasks, field_values, assignee_id, sort_order, kind)
  values (
    target_project,
    left(coalesce(nullif(trim(template_name), ''), clean_title), 100),
    left(clean_title, 1000),
    t.notes,
    coalesce((
      select jsonb_agg(to_jsonb(s.title) order by s.subtask_order, s.created_at)
      from (select * from public.tasks s where s.parent_task_id = t.id and s.deleted_at is null
            order by s.subtask_order, s.created_at limit 100) s
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(jsonb_build_object('field_id', v.field_id, 'value', v.value))
      from public.task_field_values v
      join public.custom_fields f on f.id = v.field_id and f.project_id = target_project and f.deleted_at is null
        and not f.bound_to_sections
      where v.task_id = t.id and v.value is not null and v.value <> 'null'::jsonb
    ), '[]'::jsonb),
    case when include_assignee then t.assignee_id end,
    coalesce((select max(x.sort_order) from public.task_templates x
              where x.project_id = target_project and x.deleted_at is null), 0) + 1024,
    t.kind
  )
  returning id into created;
  return created;
end;
$$;

-- Same as before; each title becomes a subtask (a normal subtask creation, as the caller).
create or replace function public.create_task_from_template(
  target_template uuid,
  target_section uuid default null,
  task_title text default null
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  tpl public.task_templates;
  new_task uuid;
  item jsonb;
  i integer := 0;
begin
  select * into tpl from public.task_templates where id = target_template and deleted_at is null;
  if not found then
    raise exception 'Task template not found' using errcode = 'no_data_found';
  end if;
  if not public.has_project_role(tpl.project_id, 'editor') then
    raise exception 'Only editors and above can add tasks here' using errcode = 'insufficient_privilege';
  end if;
  if target_section is not null and not exists (
    select 1 from public.sections s where s.id = target_section and s.project_id = tpl.project_id and s.deleted_at is null
  ) then
    raise exception 'That section isn’t in this project' using errcode = 'check_violation';
  end if;

  new_task := public.create_task(tpl.project_id, target_section,
    left(coalesce(nullif(trim(coalesce(task_title, '')), ''), tpl.title), 1000));

  if tpl.notes is not null or tpl.kind <> 'task'
     or (tpl.assignee_id is not null and public.profile_can_read_task(tpl.assignee_id, new_task)) then
    update public.tasks
    set notes = coalesce(tpl.notes, notes),
        kind = tpl.kind,
        assignee_id = case when tpl.assignee_id is not null and public.profile_can_read_task(tpl.assignee_id, new_task)
          then tpl.assignee_id else assignee_id end
    where id = new_task;
  end if;

  for item in select * from jsonb_array_elements(tpl.subtasks) loop
    continue when jsonb_typeof(item) <> 'string' or nullif(trim(item #>> '{}'), '') is null;
    i := i + 1;
    insert into public.tasks (parent_task_id, title, subtask_order) values (new_task, left(trim(item #>> '{}'), 1000), i * 1024);
  end loop;

  for item in select * from jsonb_array_elements(tpl.field_values) loop
    continue when jsonb_typeof(item) <> 'object' or item -> 'value' is null or item -> 'value' = 'null'::jsonb;
    begin
      insert into public.task_field_values (task_id, field_id, value)
      values (new_task, (item ->> 'field_id')::uuid, item -> 'value');
    exception when check_violation or foreign_key_violation or invalid_text_representation
      or insufficient_privilege or raise_exception then
      null;
    end;
  end loop;

  return new_task;
end;
$$;

-- ---------------------------------------------------------------------------
-- Asana importer: nested subtasks as real subtasks
-- ---------------------------------------------------------------------------
-- Batch task key "subtasks" items may now carry { gid, title, completed_at, notes, assignee_email,
-- assignee_name, due_on, start_on, kind, subtasks: [...] } (all but gid optional; older batches with
-- just title + completion still work). Levels past subtask_max_depth() are flattened into the deepest
-- allowed one. Same matching rules as tasks: the assignee only when an active project member's email
-- matches (else noted in the notes), a start date after the due date dropped. Idempotent per gid:
-- an already-imported subtask is skipped and never changed, but new children under it are added.
-- Runs inside import_batch(), so the import context mutes rules, inbox items, and stories.
create or replace function public.import_subtasks(
  target_project uuid, import_source text, target_run uuid, parent uuid, items jsonb, depth integer default 1
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  child jsonb;
  existing uuid;
  new_id uuid;
  assignee uuid;
  v_due date;
  v_start date;
  v_notes text;
  footer text[];
  created integer := 0;
  next_parent uuid;
  next_depth integer;
begin
  for child in select * from jsonb_array_elements(case when jsonb_typeof(items) = 'array' then items else '[]' end) loop
    continue when jsonb_typeof(child) <> 'object' or nullif(child ->> 'gid', '') is null;
    existing := public.import_local_id(target_project, import_source, 'subtask', child ->> 'gid');
    if existing is not null then
      -- Imported before: leave it as it is; only its new children are added (unless it's gone).
      continue when not exists (select 1 from public.tasks t where t.id = existing and t.deleted_at is null);
      new_id := existing;
    else
      footer := '{}';
      assignee := public.import_member(target_project, child ->> 'assignee_email');
      if assignee is null and coalesce(nullif(trim(child ->> 'assignee_name'), ''), nullif(trim(child ->> 'assignee_email'), '')) is not null then
        footer := footer || format('Assignee in Asana: %s (not a member of this project, so left unassigned)',
          concat_ws(' ', nullif(trim(child ->> 'assignee_name'), ''),
            '<' || nullif(lower(trim(child ->> 'assignee_email')), '') || '>'));
      end if;
      v_due := public.import_date(child ->> 'due_on');
      v_start := public.import_date(child ->> 'start_on');
      if v_start is not null and v_due is not null and v_start > v_due then
        footer := footer || format('Start date in Asana: %s (after the due date, so not set)', v_start);
        v_start := null;
      end if;
      v_notes := left(nullif(trim(coalesce(child ->> 'notes', '')), ''), 50000);
      if cardinality(footer) > 0 then
        v_notes := concat_ws(E'\n\n', v_notes, '— Imported from Asana —' || E'\n' || array_to_string(footer, E'\n'));
      end if;
      insert into public.tasks (parent_task_id, title, notes, completed_at, assignee_id, due_on, start_on, source,
        created_by, kind, subtask_order)
      values (
        parent,
        left(coalesce(nullif(trim(child ->> 'title'), ''), 'Untitled subtask'), 1000),
        v_notes,
        case when nullif(child ->> 'completed_at', '') is not null
          then coalesce(public.import_timestamp(child ->> 'completed_at'), now()) end,
        assignee,
        v_due,
        v_start,
        'import',
        public.current_profile_id(),
        case when child ->> 'kind' in ('milestone', 'approval') then child ->> 'kind' else 'task' end,
        coalesce((select max(s.subtask_order) + 1024 from public.tasks s
                  where s.parent_task_id = parent and s.deleted_at is null), 1024)
      )
      returning id into new_id;
      perform public.import_remember(target_project, import_source, 'subtask', child ->> 'gid', new_id, target_run);
      created := created + 1;
    end if;
    -- Children go one level down, or stay at this level once the depth limit is reached.
    if depth < public.subtask_max_depth() then
      next_parent := new_id;
      next_depth := depth + 1;
    else
      next_parent := parent;
      next_depth := depth;
    end if;
    created := created + public.import_subtasks(target_project, import_source, target_run, next_parent, child -> 'subtasks', next_depth);
  end loop;
  return created;
end;
$$;

revoke all on function public.import_subtasks(uuid, text, uuid, uuid, jsonb, integer) from public, anon, authenticated;

-- Same as before; subtasks are real subtasks (assignee, dates, notes, kind, nested children) via
-- import_subtasks().
create or replace function public.import_batch(target_run uuid, batch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  run public.import_runs;
  p uuid;
  src text;
  me uuid := public.current_profile_id();
  item jsonb;
  child jsonb;
  found_id uuid;
  key text;
  t uuid;
  task_is_new boolean;
  was_following boolean;
  assignee uuid;
  fld public.custom_fields;
  ftype text;
  merged_options jsonb;
  new_value jsonb;
  v_due date;
  v_start date;
  v_notes text;
  footer text[];
  author uuid;
  body text;
  url text;
  other uuid;
  pred uuid;
  succ uuid;
  n_sections integer := 0;
  n_fields integer := 0;
  n_rules integer := 0;
  n_tasks integer := 0;
  n_tasks_skipped integer := 0;
  n_subtasks integer := 0;
  n_comments integer := 0;
  n_attachments integer := 0;
  n_dependencies integer := 0;
  n_dependencies_skipped integer := 0;
  n_memberships integer := 0;
  n_unassigned integer := 0;
  n_values_skipped integer := 0;
  n_rules_skipped integer := 0;
  n_dates_dropped integer := 0;
begin
  select * into run from public.import_runs where id = target_run and deleted_at is null;
  if not found or not public.has_project_role(run.project_id, 'viewer') then
    raise exception 'Import not found' using errcode = 'no_data_found';
  end if;
  if not public.has_project_role(run.project_id, 'admin') then
    raise exception 'You need Admin access to import into this project' using errcode = 'insufficient_privilege';
  end if;
  if run.status <> 'running' then
    raise exception 'This import has already finished' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.projects pj where pj.id = run.project_id and pj.deleted_at is null) then
    raise exception 'Project not found' using errcode = 'no_data_found';
  end if;
  if jsonb_typeof(coalesce(batch, '{}'::jsonb)) <> 'object' then
    raise exception 'Invalid import batch' using errcode = 'check_violation';
  end if;

  p := run.project_id;
  src := run.source;
  -- One batch at a time per project, so two admins importing at once can't both create a row.
  perform pg_advisory_xact_lock(hashtextextended('alhc.import:' || p::text, 0));
  -- Left set until the transaction ends so the deferred task_created rule trigger sees it too.
  perform set_config('alhc.import_run_id', run.id::text, true);

  -- Project --------------------------------------------------------------------------------------
  if jsonb_typeof(batch -> 'project') = 'object' and nullif(batch #>> '{project,gid}', '') is not null then
    perform public.import_remember(p, src, 'project', batch #>> '{project,gid}', p, run.id);
  end if;

  -- Sections: by external key, else an active section with the same name, else a new one ----------
  for item in select * from jsonb_array_elements(case when jsonb_typeof(batch -> 'sections') = 'array' then batch -> 'sections' else '[]' end) loop
    key := nullif(item ->> 'key', '');
    continue when key is null or nullif(trim(item ->> 'name'), '') is null;
    found_id := public.import_local_id(p, src, 'section', key);
    if found_id is not null and not exists (
      select 1 from public.sections s where s.id = found_id and s.project_id = p and s.deleted_at is null
    ) then
      found_id := null;
    end if;
    if found_id is null then
      select s.id into found_id from public.sections s
      where s.project_id = p and s.deleted_at is null and lower(s.name) = lower(trim(item ->> 'name'))
      order by s.sort_order limit 1;
    end if;
    if found_id is null then
      insert into public.sections (project_id, name, sort_order)
      values (p, left(trim(item ->> 'name'), 200), coalesce(
        (select max(s.sort_order) + 1024 from public.sections s where s.project_id = p and s.deleted_at is null), 1024))
      returning id into found_id;
      n_sections := n_sections + 1;
    end if;
    perform public.import_remember(p, src, 'section', key, found_id, run.id);
  end loop;

  -- Custom fields: by key, else an active field with the same name and type, else a new one. Select
  -- options are matched by name; missing options are appended. -----------------------------------
  for item in select * from jsonb_array_elements(case when jsonb_typeof(batch -> 'fields') = 'array' then batch -> 'fields' else '[]' end) loop
    key := nullif(item ->> 'key', '');
    ftype := item ->> 'type';
    continue when key is null or nullif(trim(item ->> 'name'), '') is null
      or ftype is null or ftype not in ('text', 'number', 'date', 'single_select', 'multi_select', 'people');
    found_id := public.import_local_id(p, src, 'field', key);
    fld := null;
    if found_id is not null then
      select * into fld from public.custom_fields f where f.id = found_id and f.project_id = p and f.deleted_at is null;
    end if;
    if fld.id is null then
      select * into fld from public.custom_fields f
      where f.project_id = p and f.deleted_at is null and not f.bound_to_sections
        and f.field_type = ftype and lower(f.name) = lower(left(trim(item ->> 'name'), 100))
      order by f.sort_order limit 1;
    end if;
    if fld.id is null then
      insert into public.custom_fields (project_id, name, field_type, options, sort_order)
      values (
        p,
        -- A same-named field of another type (or the section-bound Status) keeps its name.
        case when exists (
          select 1 from public.custom_fields f
          where f.project_id = p and f.deleted_at is null and lower(f.name) = lower(left(trim(item ->> 'name'), 100))
        ) then left(left(trim(item ->> 'name'), 90) || ' (Asana)', 100) else left(trim(item ->> 'name'), 100) end,
        ftype,
        '[]'::jsonb,
        coalesce((select max(f.sort_order) + 1024 from public.custom_fields f where f.project_id = p and f.deleted_at is null), 1024)
      )
      returning * into fld;
      n_fields := n_fields + 1;
    end if;
    if ftype in ('single_select', 'multi_select') and jsonb_typeof(item -> 'options') = 'array' then
      merged_options := fld.options;
      for child in select * from jsonb_array_elements(item -> 'options') loop
        continue when jsonb_typeof(child) <> 'string' or nullif(trim(child #>> '{}'), '') is null;
        if not exists (
          select 1 from jsonb_array_elements(merged_options) o where lower(o ->> 'name') = lower(left(trim(child #>> '{}'), 100))
        ) then
          merged_options := merged_options || jsonb_build_array(jsonb_build_object(
            'id', gen_random_uuid()::text,
            'name', left(trim(child #>> '{}'), 100),
            'color', (array['zinc','blue','green','amber','red','violet','teal','orange','pink'])[jsonb_array_length(merged_options) % 9 + 1]
          ));
        end if;
      end loop;
      if merged_options is distinct from fld.options then
        update public.custom_fields set options = merged_options where id = fld.id;
      end if;
    end if;
    perform public.import_remember(p, src, 'field', key, fld.id, run.id);
  end loop;

  -- Rules: always disabled (rules_03_import_disabled also forces it). Invalid ones are skipped. ----
  for item in select * from jsonb_array_elements(case when jsonb_typeof(batch -> 'rules') = 'array' then batch -> 'rules' else '[]' end) loop
    key := nullif(item ->> 'key', '');
    continue when key is null or public.import_local_id(p, src, 'rule', key) is not null;
    begin
      insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, conditions, actions, created_by, sort_order)
      values (
        p,
        left(coalesce(nullif(trim(item ->> 'name'), ''), 'Imported rule'), 200),
        false,
        item ->> 'trigger_type',
        coalesce(item -> 'trigger_config', '{}'::jsonb),
        coalesce(item -> 'conditions', '[]'::jsonb),
        coalesce(item -> 'actions', '[]'::jsonb),
        me,
        coalesce((select max(r.sort_order) + 1024 from public.rules r where r.project_id = p and r.deleted_at is null), 1024)
      )
      returning id into found_id;
      perform public.import_remember(p, src, 'rule', key, found_id, run.id);
      n_rules := n_rules + 1;
    exception when check_violation or not_null_violation or invalid_text_representation
      or foreign_key_violation or invalid_parameter_value or raise_exception then
      n_rules_skipped := n_rules_skipped + 1;
    end;
  end loop;

  -- Tasks ------------------------------------------------------------------------------------------
  for item in select * from jsonb_array_elements(case when jsonb_typeof(batch -> 'tasks') = 'array' then batch -> 'tasks' else '[]' end) loop
    key := nullif(item ->> 'gid', '');
    continue when key is null;
    t := public.import_local_id(p, src, 'task', key);
    task_is_new := t is null;

    if not task_is_new then
      n_tasks_skipped := n_tasks_skipped + 1;
      -- Deleted here since the last import: leave it (and its children) alone.
      continue when not exists (select 1 from public.tasks x where x.id = t and x.deleted_at is null);
      select exists (
        select 1 from public.task_followers f where f.task_id = t and f.profile_id = me and f.deleted_at is null
      ) into was_following;
      assignee := (select x.assignee_id from public.tasks x where x.id = t);
    else
      was_following := false;
      footer := '{}';
      assignee := public.import_member(p, item ->> 'assignee_email');
      if assignee is null and coalesce(nullif(trim(item ->> 'assignee_name'), ''), nullif(trim(item ->> 'assignee_email'), '')) is not null then
        n_unassigned := n_unassigned + 1;
        footer := footer || format('Assignee in Asana: %s (not a member of this project, so left unassigned)',
          concat_ws(' ', nullif(trim(item ->> 'assignee_name'), ''),
            '<' || nullif(lower(trim(item ->> 'assignee_email')), '') || '>'));
      end if;
      v_due := public.import_date(item ->> 'due_on');
      v_start := public.import_date(item ->> 'start_on');
      if v_start is not null and v_due is not null and v_start > v_due then
        footer := footer || format('Start date in Asana: %s (after the due date, so not set)', v_start);
        v_start := null;
        n_dates_dropped := n_dates_dropped + 1;
      end if;
      v_notes := left(nullif(trim(coalesce(item ->> 'notes', '')), ''), 50000);
      if cardinality(footer) > 0 then
        v_notes := concat_ws(E'\n\n', v_notes, '— Imported from Asana —' || E'\n' || array_to_string(footer, E'\n'));
      end if;

      insert into public.tasks (home_project_id, title, notes, completed_at, assignee_id, due_on, start_on, source, created_by, kind)
      values (
        p,
        left(coalesce(nullif(trim(item ->> 'title'), ''), 'Untitled task'), 1000),
        v_notes,
        case when nullif(item ->> 'completed_at', '') is not null
          then coalesce(public.import_timestamp(item ->> 'completed_at'), now()) end,
        assignee,
        v_due,
        v_start,
        'import',
        me,
        case when item ->> 'kind' in ('milestone', 'approval') then item ->> 'kind' else 'task' end
      )
      returning id into t;
      n_tasks := n_tasks + 1;
      perform public.import_remember(p, src, 'task', key, t, run.id);

      found_id := case when nullif(item ->> 'section_key', '') is not null
        then public.import_local_id(p, src, 'section', item ->> 'section_key') end;
      if found_id is not null and exists (select 1 from public.sections s where s.id = found_id and s.deleted_at is null) then
        update public.task_projects set section_id = found_id where task_id = t and project_id = p;
      end if;

      -- Also home the task in other projects this source project's siblings were imported into.
      for child in select * from jsonb_array_elements(case when jsonb_typeof(item -> 'projects') = 'array' then item -> 'projects' else '[]' end) loop
        select x.local_id into other from public.import_external_ids x
        join public.projects pj on pj.id = x.local_id and pj.deleted_at is null
        where x.source = src and x.kind = 'project' and x.external_id = child ->> 'gid' and x.local_id <> p
          and public.has_project_role(x.local_id, 'editor')
        order by x.created_at limit 1;
        continue when other is null;
        insert into public.task_projects (task_id, project_id, section_id, sort_order)
        values (
          t, other,
          (select s.id from public.sections s
           where s.project_id = other and s.deleted_at is null and lower(s.name) = lower(trim(child ->> 'section_name'))
           order by s.sort_order limit 1),
          coalesce((select max(tp.sort_order) + 1024 from public.task_projects tp
                    where tp.project_id = other and tp.deleted_at is null), 1024)
        )
        on conflict (task_id, project_id) do nothing;
        if found then
          n_memberships := n_memberships + 1;
        end if;
      end loop;

      -- Field values (validated by task_field_values_validate; values that don't fit are skipped).
      for child in select * from jsonb_array_elements(case when jsonb_typeof(item -> 'fields') = 'array' then item -> 'fields' else '[]' end) loop
        found_id := public.import_local_id(p, src, 'field', child ->> 'key');
        fld := null;
        if found_id is not null then
          select * into fld from public.custom_fields f where f.id = found_id and f.deleted_at is null;
        end if;
        continue when fld.id is null or child -> 'value' is null or child -> 'value' = 'null'::jsonb;
        new_value := case fld.field_type
          when 'text' then case when jsonb_typeof(child -> 'value') in ('string', 'number')
            then to_jsonb(left(child ->> 'value', 10000)) end
          when 'number' then case when jsonb_typeof(child -> 'value') = 'number' then child -> 'value' end
          when 'date' then case when public.import_date(child ->> 'value') is not null
            then to_jsonb(public.import_date(child ->> 'value')::text) end
          when 'single_select' then (
            select o -> 'id' from jsonb_array_elements(fld.options) o
            where lower(o ->> 'name') = lower(trim(child ->> 'value')) limit 1)
          when 'multi_select' then (
            select jsonb_agg(distinct o -> 'id') from jsonb_array_elements(fld.options) o
            where jsonb_typeof(child -> 'value') = 'array'
              and exists (select 1 from jsonb_array_elements_text(child -> 'value') v where lower(trim(v)) = lower(o ->> 'name')))
          when 'people' then (
            select jsonb_agg(distinct to_jsonb(public.import_member(p, v)))
            from jsonb_array_elements_text(case when jsonb_typeof(child -> 'value') = 'array' then child -> 'value' else '[]' end) v
            where public.import_member(p, v) is not null)
        end;
        if new_value is null then
          n_values_skipped := n_values_skipped + 1;
          continue;
        end if;
        begin
          insert into public.task_field_values (task_id, field_id, value)
          values (t, fld.id, new_value)
          on conflict (task_id, field_id) do nothing;
        exception when check_violation or foreign_key_violation then
          n_values_skipped := n_values_skipped + 1;
        end;
      end loop;

      for child in select * from jsonb_array_elements(case when jsonb_typeof(item -> 'followers') = 'array' then item -> 'followers' else '[]' end) loop
        perform public.follow_task(t, public.import_member(p, child #>> '{}'));
      end loop;
    end if;

    -- Subtasks: real subtasks, nested up to the depth limit (import_subtasks) ----------------------
    n_subtasks := n_subtasks + public.import_subtasks(p, src, run.id, t, item -> 'subtasks');

    -- Comments: by the matched member, else by the importer with the original author named --------
    for child in select * from jsonb_array_elements(case when jsonb_typeof(item -> 'comments') = 'array' then item -> 'comments' else '[]' end) loop
      continue when nullif(child ->> 'gid', '') is null or nullif(trim(child ->> 'body'), '') is null
        or public.import_local_id(p, src, 'comment', child ->> 'gid') is not null;
      author := public.import_member(p, child ->> 'author_email');
      body := trim(child ->> 'body');
      if author is null then
        author := me;
        body := format('%s wrote in Asana:', coalesce(nullif(trim(child ->> 'author_name'), ''), 'Someone')) || E'\n' || body;
      end if;
      insert into public.comments (task_id, author_id, body, created_at)
      values (t, author, left(body, 10000), coalesce(public.import_timestamp(child ->> 'created_at'), now()))
      returning id into found_id;
      perform public.import_remember(p, src, 'comment', child ->> 'gid', found_id, run.id);
      n_comments := n_comments + 1;
    end loop;

    -- Attachment links (no file copy) --------------------------------------------------------------
    for child in select * from jsonb_array_elements(case when jsonb_typeof(item -> 'attachments') = 'array' then item -> 'attachments' else '[]' end) loop
      continue when nullif(child ->> 'gid', '') is null or nullif(trim(child ->> 'name'), '') is null
        or public.import_local_id(p, src, 'attachment', child ->> 'gid') is not null;
      url := trim(child ->> 'url');
      if url is null or url !~ '^https://[^\s]+$' or length(url) > 2000 then
        url := null;
      end if;
      insert into public.task_attachment_links (task_id, source, name, url)
      values (t, src, left(trim(child ->> 'name'), 255), url)
      returning id into found_id;
      perform public.import_remember(p, src, 'attachment', child ->> 'gid', found_id, run.id);
      n_attachments := n_attachments + 1;
    end loop;

    -- The importer auto-followed as the creator (or comment author); don't keep them on every task.
    if not was_following and assignee is distinct from me
       and not (coalesce(item -> 'followers', '[]'::jsonb) @> to_jsonb(array[(select pr.email from public.profiles pr where pr.id = me)])) then
      update public.task_followers set deleted_at = now()
      where task_id = t and profile_id = me and deleted_at is null;
    end if;
  end loop;

  -- Dependencies: both tasks imported into this project and still active; cycles are skipped -------
  if jsonb_typeof(batch -> 'dependencies') = 'array' and jsonb_array_length(batch -> 'dependencies') > 0 then
    perform pg_advisory_xact_lock(hashtextextended('alhc.task_dependencies', 0));
  end if;
  for item in select * from jsonb_array_elements(case when jsonb_typeof(batch -> 'dependencies') = 'array' then batch -> 'dependencies' else '[]' end) loop
    key := (item ->> 'predecessor') || '>' || (item ->> 'successor');
    continue when key is null or public.import_local_id(p, src, 'dependency', key) is not null;
    pred := public.import_local_id(p, src, 'task', item ->> 'predecessor');
    succ := public.import_local_id(p, src, 'task', item ->> 'successor');
    if pred is null or succ is null or pred = succ
       or not exists (select 1 from public.tasks x join public.task_projects tp on tp.task_id = x.id and tp.project_id = p and tp.deleted_at is null
                      where x.id = pred and x.deleted_at is null)
       or not exists (select 1 from public.tasks x join public.task_projects tp on tp.task_id = x.id and tp.project_id = p and tp.deleted_at is null
                      where x.id = succ and x.deleted_at is null) then
      n_dependencies_skipped := n_dependencies_skipped + 1;
      continue;
    end if;
    select d.id into found_id from public.task_dependencies d
    where d.predecessor_id = pred and d.successor_id = succ and d.deleted_at is null;
    if found_id is null then
      if exists (
        with recursive downstream (task_id) as (
          select d.successor_id from public.task_dependencies d
          where d.predecessor_id = succ and d.deleted_at is null
          union
          select d.successor_id from public.task_dependencies d
          join downstream x on d.predecessor_id = x.task_id
          where d.deleted_at is null
        )
        select 1 from downstream where task_id = pred
      ) then
        n_dependencies_skipped := n_dependencies_skipped + 1;
        continue;
      end if;
      insert into public.task_dependencies (project_id, predecessor_id, successor_id, created_by)
      values (p, pred, succ, me)
      returning id into found_id;
      n_dependencies := n_dependencies + 1;
    end if;
    perform public.import_remember(p, src, 'dependency', key, found_id, run.id);
  end loop;

  return jsonb_build_object(
    'sections', n_sections,
    'fields', n_fields,
    'rules', n_rules,
    'rules_skipped', n_rules_skipped,
    'tasks', n_tasks,
    'tasks_skipped', n_tasks_skipped,
    'subtasks', n_subtasks,
    'comments', n_comments,
    'attachments', n_attachments,
    'dependencies', n_dependencies,
    'dependencies_skipped', n_dependencies_skipped,
    'memberships', n_memberships,
    'unassigned', n_unassigned,
    'values_skipped', n_values_skipped,
    'dates_dropped', n_dates_dropped
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Workload counts subtasks (their root task's project / portfolio membership)
-- ---------------------------------------------------------------------------

-- Same as before (invoker, same signature); subtasks of the project's tasks count too.
create or replace function public.project_workload(
  target_project uuid,
  range_start date default null,
  range_end date default null,
  value_field uuid default null
)
returns table (
  task_id uuid,
  title text,
  assignee_id uuid,
  start_on date,
  due_on date,
  value numeric,
  project_id uuid,
  can_edit boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select t.id, t.title, t.assignee_id, t.start_on, t.due_on,
         (select (v.value #>> '{}')::numeric
          from public.task_field_values v
          join public.custom_fields f on f.id = v.field_id
          where v.task_id = t.id and v.field_id = value_field
            and f.project_id = target_project and f.field_type = 'number' and f.deleted_at is null
            and jsonb_typeof(v.value) = 'number'),
         target_project,
         public.has_task_role(t.id, 'editor')
  from public.task_projects tp
  join public.projects pr on pr.id = tp.project_id and pr.deleted_at is null
  join public.tasks t on t.id = tp.task_id or t.root_task_id = tp.task_id
  where tp.project_id = target_project
    and tp.deleted_at is null
    and public.has_project_role(target_project, 'viewer')
    and t.deleted_at is null
    and t.completed_at is null
    and t.assignee_id is not null
    and t.due_on is not null
    and (range_end is null or coalesce(t.start_on, t.due_on) <= range_end)
    and (range_start is null or t.due_on >= range_start)
  order by t.due_on, t.created_at, t.id;
$$;

-- Same as before (invoker, same signature); subtasks count through their root task's projects.
create or replace function public.portfolio_workload(
  target_portfolio uuid,
  range_start date default null,
  range_end date default null,
  value_field_name text default null
)
returns table (
  task_id uuid,
  title text,
  assignee_id uuid,
  start_on date,
  due_on date,
  value numeric,
  project_id uuid,
  can_edit boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with visible_projects as (
    select r.project_id,
           row_number() over (order by r.depth, gc.sort_order nulls first, r.sort_order, r.project_id) as sort_order
    from public.portfolio_rollup_projects(target_portfolio) r
    left join public.portfolio_children gc
      on gc.parent_id = target_portfolio and gc.child_id = r.group_id and gc.deleted_at is null
    where public.has_portfolio_role(target_portfolio, 'viewer')
      and public.has_project_role(r.project_id, 'viewer')
  ),
  picked as (
    select distinct on (t.id) t.id, vp.project_id
    from visible_projects vp
    join public.task_projects tp on tp.project_id = vp.project_id and tp.deleted_at is null
    join public.tasks t on t.id = tp.task_id or t.root_task_id = tp.task_id
    where t.deleted_at is null
      and t.completed_at is null
      and t.assignee_id is not null
      and t.due_on is not null
      and (range_end is null or coalesce(t.start_on, t.due_on) <= range_end)
      and (range_start is null or t.due_on >= range_start)
    order by t.id, (vp.project_id = t.home_project_id) desc, vp.sort_order, vp.project_id
  )
  select t.id, t.title, t.assignee_id, t.start_on, t.due_on,
         (select max((v.value #>> '{}')::numeric)
          from public.task_field_values v
          join public.custom_fields f on f.id = v.field_id
          join visible_projects vp on vp.project_id = f.project_id
          join public.task_projects tp on tp.task_id = coalesce(t.root_task_id, t.id) and tp.project_id = f.project_id and tp.deleted_at is null
          where v.task_id = t.id
            and nullif(btrim(value_field_name), '') is not null
            and lower(btrim(f.name)) = lower(btrim(value_field_name))
            and f.field_type = 'number' and f.deleted_at is null
            and jsonb_typeof(v.value) = 'number'),
         picked.project_id,
         public.has_task_role(t.id, 'editor')
  from picked
  join public.tasks t on t.id = picked.id
  order by t.due_on, t.created_at, t.id;
$$;

-- ---------------------------------------------------------------------------
-- Hardening: EXECUTE on SECURITY DEFINER trigger functions (same sweep as earlier phases)
-- ---------------------------------------------------------------------------

do $$
declare
  fn regprocedure;
begin
  for fn in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and p.prorettype = 'trigger'::regtype
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
  end loop;
end;
$$;

