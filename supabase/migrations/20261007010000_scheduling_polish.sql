-- ALHC Projects — Phase: Scheduling depth and polish.
-- Dependency depth (lag days, start-to-start, subtasks, cross-project links), confirmed auto-shift of
-- dependents with Undo, tag stories, converting a task into a subtask and back, and a saved
-- "Show subtasks" view setting. Generic: nothing knows about a team or request type.
--
-- Security shape (pinned by supabase/tests/zz03_scheduling_polish_smoke.sql):
--   * Reading a dependency needs read access to BOTH tasks (has_task_role viewer on each; a subtask
--     resolves through its root). Nobody sees a link to, or the title of, a task they can't read.
--   * Adding or changing a link (set_task_dependency) needs Editor on BOTH tasks, whatever projects they
--     are in; removing one (remove_task_dependency, same signature) needs the same. Cycles of any kind are
--     rejected over every active link, including ones the caller can't see (so the writer is SECURITY
--     DEFINER, like add_task_dependency; it is pinned in suite 60 and revoked from public and anon).
--     add_task_dependency(predecessor, successor) keeps its Task depth contract (same project,
--     finish-to-start, no lag): everything it allows, set_task_dependency allows too.
--   * Dependency stories only carry the other task's title when everyone who can read the story's task
--     can also read the other task (dependency_story_data); otherwise just its id.
--   * Auto-shift (preview_dependency_shift / apply_dependency_shift / undo_dependency_shift), the
--     conversions (convert_to_subtask / convert_to_task), and project_dependencies are SECURITY INVOKER:
--     every date change, parent change, and membership change goes through RLS and the normal task
--     triggers (stories, rules, inbox items), exactly like a single edit.
--   * The other definer functions here are triggers (on_task_tag_story, on_task_converted) and internal
--     helpers, all revoked from public, anon, and authenticated. Workspace admins get nothing extra.
--     fire_rules, notify_with, notify_message, and add_story are untouched (their import and copy checks
--     included).
--
-- Existing functions are changed with asserted text patches (alhc_patch_function below): each edit must
-- match the live definition exactly once, and every other line stays as it was. Grants are kept.

-- ---------------------------------------------------------------------------
-- Patch helper (dropped at the end of this migration)
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- Story kinds: dependency changes, tags, conversions
-- ---------------------------------------------------------------------------

alter table public.task_stories drop constraint task_stories_kind_check;
alter table public.task_stories add constraint task_stories_kind_check check (kind in (
  'created', 'completed', 'reopened', 'renamed', 'assigned', 'unassigned', 'due_changed', 'start_changed',
  'section_changed', 'project_added', 'project_removed', 'attachment_added', 'field_changed',
  'deleted', 'approval_requested', 'approval_decided', 'approval_cancelled', 'approval_resubmitted',
  'form_submitted', 'request_number_assigned', 'email_queued',
  'recurrence_changed', 'recurrence_spawned', 'dependency_added', 'dependency_removed', 'restored',
  'integration_queued', 'integration_failed', 'kind_changed',
  'dependency_changed', 'tag_added', 'tag_removed', 'converted_to_subtask', 'converted_to_task'
));

-- ---------------------------------------------------------------------------
-- Dependencies: kind and lag
-- ---------------------------------------------------------------------------
-- kind: finish_to_start (the successor starts on or after the predecessor's due date + lag, and can't be
-- completed while the predecessor is open) or start_to_start (the successor starts on or after the
-- predecessor's start + lag; never blocks completion). lag_days: whole days, -365..365 (negative = lead).
-- project_id is now only where the link was made (a shared project the creator edits, else the
-- successor's home project); access never reads it.

alter table public.task_dependencies drop constraint task_dependencies_kind_check;
alter table public.task_dependencies add constraint task_dependencies_kind_check
  check (kind in ('finish_to_start', 'start_to_start'));
alter table public.task_dependencies
  add column lag_days integer not null default 0
  constraint task_dependencies_lag_days_check check (lag_days between -365 and 365);
create index task_dependencies_predecessor_idx on public.task_dependencies (predecessor_id) where deleted_at is null;

comment on table public.task_dependencies is
  'Dependencies between two tasks or subtasks (finish-to-start or start-to-start, with lag days), possibly '
  'across projects. Readable only with read access to both tasks; written only by set_task_dependency / '
  'add_task_dependency / remove_task_dependency (Editor on both tasks). Soft-deleted on removal.';
comment on column public.task_dependencies.kind is
  'finish_to_start: the successor starts on/after the predecessor''s due date + lag and is blocked until it is '
  'complete. start_to_start: the successor starts on/after the predecessor''s start + lag; never blocks.';
comment on column public.task_dependencies.lag_days is
  'Whole days between the predecessor''s anchor date and the successor''s start (-365..365; negative = lead).';

-- anon never had a policy here; drop its leftover default table grants too (writes stay RPC-only).
revoke all on public.task_dependencies from anon;
revoke insert, delete, truncate, references, trigger on public.task_dependencies from authenticated;

drop policy task_dependencies_select_viewer on public.task_dependencies;
create policy task_dependencies_select_viewer on public.task_dependencies
  for select to authenticated
  using (
    (select public.has_task_role(task_dependencies.predecessor_id, 'viewer'))
    and (select public.has_task_role(task_dependencies.successor_id, 'viewer'))
  );

-- ---------------------------------------------------------------------------
-- Dependency stories never leak a title (internal helpers, run inside definer functions)
-- ---------------------------------------------------------------------------

-- True when every project through which target_task can be read is also one through which other_task can
-- be read (a subtask reads through its root task), so whoever reads target_task can read other_task.
create or replace function public.task_reach_within(target_task uuid, other_task uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  with reach_a as (
    select tp.project_id from public.task_projects tp
    where tp.deleted_at is null
      and tp.task_id = coalesce((select t.root_task_id from public.tasks t where t.id = target_task), target_task)
    union
    select t.home_project_id from public.tasks t where t.id = target_task
  ),
  reach_b as (
    select tp.project_id from public.task_projects tp
    where tp.deleted_at is null
      and tp.task_id = coalesce((select t.root_task_id from public.tasks t where t.id = other_task), other_task)
    union
    select t.home_project_id from public.tasks t where t.id = other_task
  )
  select not exists (select project_id from reach_a except select project_id from reach_b);
$$;

-- Story data for a dependency story on story_task about other_task: the other task's title only when
-- every reader of story_task can read it too (else the app shows "a task you can't open").
create or replace function public.dependency_story_data(story_task uuid, other_task uuid, relation text, extra jsonb)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object('relation', relation, 'task_id', other_task)
    || case when public.task_reach_within(story_task, other_task)
         then jsonb_build_object('task_title', (select t.title from public.tasks t where t.id = other_task))
         else '{}'::jsonb end
    || coalesce(extra, '{}'::jsonb);
$$;

revoke all on function public.task_reach_within(uuid, uuid) from public, anon, authenticated;
revoke all on function public.dependency_story_data(uuid, uuid, text, jsonb) from public, anon, authenticated;

-- add_task_dependency: same contract; its stories now use dependency_story_data.
select public.alhc_patch_function('public.add_task_dependency(uuid, uuid)',
$p$  perform public.add_story(successor, 'dependency_added',
    jsonb_build_object('relation', 'blocked_by', 'task_id', predecessor, 'task_title', pred.title));
  perform public.add_story(predecessor, 'dependency_added',
    jsonb_build_object('relation', 'blocking', 'task_id', successor, 'task_title', succ.title));$p$,
$p$  perform public.add_story(successor, 'dependency_added',
    public.dependency_story_data(successor, predecessor, 'blocked_by', null));
  perform public.add_story(predecessor, 'dependency_added',
    public.dependency_story_data(predecessor, successor, 'blocking', null));$p$);

-- remove_task_dependency: read access to both tasks to find it, Editor on both to remove it.
select public.alhc_patch_function('public.remove_task_dependency(uuid)',
$p$  if not found or not public.has_project_role(d.project_id, 'viewer') then
    raise exception 'Dependency not found' using errcode = 'no_data_found';
  end if;
  if not public.has_project_role(d.project_id, 'editor') then
    raise exception 'You need Editor access to change dependencies' using errcode = 'insufficient_privilege';
  end if;$p$,
$p$  if not found or not public.has_task_role(d.predecessor_id, 'viewer') or not public.has_task_role(d.successor_id, 'viewer') then
    raise exception 'Dependency not found' using errcode = 'no_data_found';
  end if;
  if not public.has_task_role(d.predecessor_id, 'editor') or not public.has_task_role(d.successor_id, 'editor') then
    raise exception 'You need Editor access to both tasks to change this dependency' using errcode = 'insufficient_privilege';
  end if;$p$,
$p$  perform public.add_story(d.successor_id, 'dependency_removed', jsonb_build_object(
    'relation', 'blocked_by', 'task_id', d.predecessor_id,
    'task_title', (select t.title from public.tasks t where t.id = d.predecessor_id)));
  perform public.add_story(d.predecessor_id, 'dependency_removed', jsonb_build_object(
    'relation', 'blocking', 'task_id', d.successor_id,
    'task_title', (select t.title from public.tasks t where t.id = d.successor_id)));$p$,
$p$  perform public.add_story(d.successor_id, 'dependency_removed',
    public.dependency_story_data(d.successor_id, d.predecessor_id, 'blocked_by', null));
  perform public.add_story(d.predecessor_id, 'dependency_removed',
    public.dependency_story_data(d.predecessor_id, d.successor_id, 'blocking', null));$p$);

-- open_blocker_count: only finish-to-start links block completion.
select public.alhc_patch_function('public.open_blocker_count(uuid)',
$p$    where d.successor_id = target_task
      and d.deleted_at is null$p$,
$p$    where d.successor_id = target_task
      and d.kind = 'finish_to_start'
      and d.deleted_at is null$p$);

-- ---------------------------------------------------------------------------
-- set_task_dependency: add a link, or change its kind / lag (SECURITY DEFINER, pinned in suite 60)
-- ---------------------------------------------------------------------------
-- Definer because the cycle check must walk every active link, including links between tasks the caller
-- can't read (it only ever answers "that would create a circular dependency"). Checks, in order: both tasks
-- exist, are active and readable (else "Task not found"), same workspace, Editor on BOTH tasks (subtasks
-- through their root), then no cycle. Re-setting an existing pair updates its kind / lag (a
-- dependency_changed story on both tasks) and returns the same id.

create or replace function public.set_task_dependency(
  predecessor uuid,
  successor uuid,
  dependency_kind text default 'finish_to_start',
  dependency_lag integer default 0
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  pred public.tasks;
  succ public.tasks;
  existing public.task_dependencies;
  shared uuid;
  created uuid;
begin
  if not public.is_allowlisted() then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  if dependency_kind is null or dependency_kind not in ('finish_to_start', 'start_to_start') then
    raise exception 'A dependency is finish-to-start or start-to-start' using errcode = 'check_violation';
  end if;
  if dependency_lag is null or dependency_lag not between -365 and 365 then
    raise exception 'Lag is a whole number of days between -365 and 365' using errcode = 'check_violation';
  end if;
  if predecessor is null or successor is null or predecessor = successor then
    raise exception 'A task can''t depend on itself' using errcode = 'check_violation';
  end if;
  select * into pred from public.tasks where id = predecessor and deleted_at is null;
  select * into succ from public.tasks where id = successor and deleted_at is null;
  if pred.id is null or succ.id is null
     or public.task_role(predecessor) is null or public.task_role(successor) is null then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;
  if pred.workspace_id <> succ.workspace_id then
    raise exception 'Dependencies can only link tasks in the same workspace' using errcode = 'check_violation';
  end if;
  if not public.has_task_role(predecessor, 'editor') or not public.has_task_role(successor, 'editor') then
    raise exception 'You need Editor access to both tasks to link them' using errcode = 'insufficient_privilege';
  end if;

  -- Serialise dependency writes so two concurrent inserts can't close a cycle between them.
  perform pg_advisory_xact_lock(hashtextextended('alhc.task_dependencies', 0));

  select * into existing from public.task_dependencies d
  where d.predecessor_id = predecessor and d.successor_id = successor and d.deleted_at is null
  for update;
  if existing.id is not null then
    if existing.kind <> dependency_kind or existing.lag_days <> dependency_lag then
      update public.task_dependencies set kind = dependency_kind, lag_days = dependency_lag where id = existing.id;
      perform public.add_story(successor, 'dependency_changed', public.dependency_story_data(successor, predecessor,
        'blocked_by', jsonb_build_object('kind', dependency_kind, 'lag_days', dependency_lag,
          'from_kind', existing.kind, 'from_lag_days', existing.lag_days)));
      perform public.add_story(predecessor, 'dependency_changed', public.dependency_story_data(predecessor, successor,
        'blocking', jsonb_build_object('kind', dependency_kind, 'lag_days', dependency_lag,
          'from_kind', existing.kind, 'from_lag_days', existing.lag_days)));
    end if;
    return existing.id;
  end if;

  if exists (
    with recursive downstream (task_id) as (
      select d.successor_id from public.task_dependencies d
      where d.predecessor_id = successor and d.deleted_at is null
      union
      select d.successor_id from public.task_dependencies d
      join downstream x on d.predecessor_id = x.task_id
      where d.deleted_at is null
    )
    select 1 from downstream where task_id = predecessor
  ) then
    raise exception 'That would create a circular dependency' using errcode = 'check_violation';
  end if;

  -- Where the link was made: a project both (root) tasks are in that the caller edits, else the
  -- successor's home project. Informational only.
  select a.project_id into shared
  from public.task_projects a
  join public.task_projects b on b.project_id = a.project_id and b.deleted_at is null
    and b.task_id = coalesce(succ.root_task_id, succ.id)
  join public.projects p on p.id = a.project_id and p.deleted_at is null
  where a.task_id = coalesce(pred.root_task_id, pred.id)
    and a.deleted_at is null
    and public.has_project_role(a.project_id, 'editor')
  order by (a.project_id = succ.home_project_id) desc, (a.project_id = pred.home_project_id) desc, a.project_id
  limit 1;

  insert into public.task_dependencies (project_id, predecessor_id, successor_id, kind, lag_days, created_by)
  values (coalesce(shared, succ.home_project_id), predecessor, successor, dependency_kind, dependency_lag,
          public.current_profile_id())
  returning id into created;

  perform public.add_story(successor, 'dependency_added', public.dependency_story_data(successor, predecessor,
    'blocked_by', jsonb_build_object('kind', dependency_kind, 'lag_days', dependency_lag)));
  perform public.add_story(predecessor, 'dependency_added', public.dependency_story_data(predecessor, successor,
    'blocking', jsonb_build_object('kind', dependency_kind, 'lag_days', dependency_lag)));
  return created;
end;
$$;

revoke all on function public.set_task_dependency(uuid, uuid, text, integer) from public, anon;
grant execute on function public.set_task_dependency(uuid, uuid, text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- project_dependencies: links between two active tasks of one project (Timeline arrows; invoker)
-- ---------------------------------------------------------------------------

create or replace function public.project_dependencies(target_project uuid)
returns table (id uuid, predecessor_id uuid, successor_id uuid, kind text, lag_days integer)
language sql
stable
security invoker
set search_path = ''
as $$
  select d.id, d.predecessor_id, d.successor_id, d.kind, d.lag_days
  from public.task_dependencies d
  where d.deleted_at is null
    and public.has_project_role(target_project, 'viewer')
    and exists (
      select 1 from public.task_projects a
      join public.tasks ta on ta.id = a.task_id and ta.deleted_at is null
      where a.task_id = d.predecessor_id and a.project_id = target_project and a.deleted_at is null
    )
    and exists (
      select 1 from public.task_projects b
      join public.tasks tb on tb.id = b.task_id and tb.deleted_at is null
      where b.task_id = d.successor_id and b.project_id = target_project and b.deleted_at is null
    )
  order by d.created_at, d.id;
$$;

revoke all on function public.project_dependencies(uuid) from public, anon;
grant execute on function public.project_dependencies(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Critical path: lag and kind (same signature and output; still invoker)
-- ---------------------------------------------------------------------------
-- Edges are every active link between two dated tasks of the project (not only links made in it). With a
-- successor u of t: finish-to-start needs t.due <= u.latest_start - lag; start-to-start needs
-- t.start <= u.latest_start - lag, i.e. t.due <= u.latest_start - lag + duration(t). In "remaining days
-- before the finish" terms a step adds duration(u) + lag (minus duration(t) for start-to-start).

select public.alhc_patch_function('public.project_critical_path(uuid)',
$p$    select distinct dep.predecessor_id as pred, dep.successor_id as succ
    from public.task_dependencies dep
    join dated a on a.id = dep.predecessor_id
    join dated b on b.id = dep.successor_id
    where dep.project_id = target_project and dep.deleted_at is null$p$,
$p$    select distinct dep.predecessor_id as pred, dep.successor_id as succ, dep.kind, dep.lag_days, a.d - a.s as pred_days
    from public.task_dependencies dep
    join dated a on a.id = dep.predecessor_id
    join dated b on b.id = dep.successor_id
    where dep.deleted_at is null$p$,
$p$    select e.pred, r.days + (b.d - b.s)$p$,
$p$    select e.pred, r.days + (b.d - b.s) + e.lag_days - case when e.kind = 'start_to_start' then e.pred_days else 0 end$p$);

-- ---------------------------------------------------------------------------
-- Copies keep a dependency's kind and lag (project templates and Duplicate project)
-- ---------------------------------------------------------------------------

select public.alhc_patch_function('public.project_snapshot(uuid, jsonb)',
$p$jsonb_build_object('predecessor', d.predecessor_id, 'successor', d.successor_id)$p$,
$p$jsonb_build_object('predecessor', d.predecessor_id, 'successor', d.successor_id, 'kind', d.kind, 'lag_days', d.lag_days)$p$);

select public.alhc_patch_function('public.instantiate_project_snapshot(jsonb, text, date, uuid, text, jsonb)',
$p$  insert into public.task_dependencies (project_id, predecessor_id, successor_id, created_by)
  select distinct new_project, (task_map ->> (d ->> 'predecessor'))::uuid, (task_map ->> (d ->> 'successor'))::uuid, me
  from jsonb_array_elements$p$,
$p$  insert into public.task_dependencies (project_id, predecessor_id, successor_id, kind, lag_days, created_by)
  select distinct new_project, (task_map ->> (d ->> 'predecessor'))::uuid, (task_map ->> (d ->> 'successor'))::uuid,
    case when d ->> 'kind' = 'start_to_start' then 'start_to_start' else 'finish_to_start' end,
    case when coalesce(d ->> 'lag_days', '') ~ '^-?[0-9]{1,3}$' and abs((d ->> 'lag_days')::integer) <= 365
      then (d ->> 'lag_days')::integer else 0 end,
    me
  from jsonb_array_elements$p$);

-- ---------------------------------------------------------------------------
-- Auto-shift: preview, apply (one call), undo (all invoker)
-- ---------------------------------------------------------------------------
-- When a task's dates move LATER, each dependent whose constraint the move breaks is pushed later just
-- enough (finish-to-start: start >= predecessor's due + lag; start-to-start: start >= predecessor's start
-- + lag), keeping its length, and so on transitively in topological order. A task's "start" is its start
-- date, else its due date (a milestone starts on its due day); undated dependents have nothing to move.
-- Moving earlier never pulls dependents in. Only links the caller can read are followed (both tasks
-- readable), so the plan never names a task the caller can't see. Completed dependents and dependents the
-- caller can't edit are listed as skipped and don't move (nor push anything after them). Nothing changes
-- until apply_dependency_shift, which only moves the dependents the person confirmed.

create or replace function public.preview_dependency_shift(target_task uuid, new_start_on date, new_due_on date)
returns table (
  task_id uuid,
  title text,
  start_on date,
  due_on date,
  new_start date,
  new_due date,
  shift_days integer,
  status text,
  reason text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  src public.tasks;
  t public.tasks;
  node record;
  edge record;
  -- Tasks that moved (the source and every shifted dependent): id -> old / new start and due.
  moved jsonb;
  m jsonb;
  cur_start date;
  need date;
  candidate date;
  old_anchor date;
  new_anchor date;
  shift integer;
begin
  select * into src from public.tasks x where x.id = target_task and x.deleted_at is null;
  if not found then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;
  if new_start_on is not null and new_due_on is not null and new_start_on > new_due_on then
    raise exception 'The start date must be on or before the due date' using errcode = 'check_violation';
  end if;
  moved := jsonb_build_object(src.id::text, jsonb_build_object(
    'os', case when src.kind = 'milestone' then src.due_on else coalesce(src.start_on, src.due_on) end,
    'od', coalesce(src.due_on, src.start_on),
    'ns', case when src.kind = 'milestone' then new_due_on else coalesce(new_start_on, new_due_on) end,
    'nd', coalesce(new_due_on, new_start_on)
  ));

  for node in
    with recursive walk (id, depth) as (
      select d.successor_id, 1 from public.task_dependencies d
      where d.predecessor_id = target_task and d.deleted_at is null
      union
      select d.successor_id, w.depth + 1 from public.task_dependencies d
      join walk w on d.predecessor_id = w.id
      where d.deleted_at is null and w.depth < 200
    )
    select w.id, max(w.depth) as depth from walk w where w.id <> target_task
    group by w.id order by max(w.depth), w.id
  loop
    select * into t from public.tasks x where x.id = node.id and x.deleted_at is null;
    continue when not found;
    cur_start := case when t.kind = 'milestone' then t.due_on else coalesce(t.start_on, t.due_on) end;
    continue when cur_start is null;

    need := null;
    for edge in
      select d.predecessor_id, d.kind, d.lag_days from public.task_dependencies d
      where d.successor_id = node.id and d.deleted_at is null and moved ? d.predecessor_id::text
    loop
      m := moved -> edge.predecessor_id::text;
      if edge.kind = 'start_to_start' then
        old_anchor := (m ->> 'os')::date;
        new_anchor := (m ->> 'ns')::date;
      else
        old_anchor := (m ->> 'od')::date;
        new_anchor := (m ->> 'nd')::date;
      end if;
      -- Only a predecessor whose anchor moved later pushes.
      continue when new_anchor is null or (old_anchor is not null and new_anchor <= old_anchor);
      candidate := new_anchor + edge.lag_days;
      need := greatest(need, candidate);
    end loop;
    continue when need is null or need <= cur_start;

    shift := need - cur_start;
    task_id := t.id;
    title := t.title;
    start_on := t.start_on;
    due_on := t.due_on;
    shift_days := shift;
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
      new_start := t.start_on + shift;
      new_due := t.due_on + shift;
      status := 'move';
      reason := null;
      moved := moved || jsonb_build_object(t.id::text, jsonb_build_object(
        'os', cur_start, 'od', coalesce(t.due_on, t.start_on),
        'ns', cur_start + shift, 'nd', coalesce(t.due_on, t.start_on) + shift
      ));
    end if;
    return next;
  end loop;
end;
$$;

-- Moves target_task to the new dates and shifts the confirmed dependents of the plan, in one call.
-- Returns { changes: [{ task_id, title, old_start_on, old_due_on, new_start_on, new_due_on }] (the
-- task itself first; hand it to undo_dependency_shift), skipped: [{ task_id, title, reason }] }.
create or replace function public.apply_dependency_shift(
  target_task uuid,
  new_start_on date,
  new_due_on date,
  confirmed_tasks uuid[] default '{}'
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  src public.tasks;
  plan record;
  after_row public.tasks;
  changes jsonb := '[]'::jsonb;
  skipped jsonb := '[]'::jsonb;
  plan_rows jsonb;
begin
  select * into src from public.tasks x where x.id = target_task and x.deleted_at is null;
  if not found then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;
  if not public.has_task_role(target_task, 'editor') then
    raise exception 'Only editors and above can change dates' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(cardinality(confirmed_tasks), 0) > 500 then
    raise exception 'Too many tasks to shift at once' using errcode = 'check_violation';
  end if;

  -- The plan is computed against the dates before the move.
  select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) into plan_rows
  from public.preview_dependency_shift(target_task, new_start_on, new_due_on) p;

  update public.tasks x set start_on = new_start_on, due_on = new_due_on
  where x.id = target_task
  returning * into after_row;
  if after_row.id is null then
    raise exception 'Your role in this project doesn’t allow that' using errcode = 'insufficient_privilege';
  end if;
  changes := changes || jsonb_build_array(jsonb_build_object(
    'task_id', src.id, 'title', src.title,
    'old_start_on', src.start_on, 'old_due_on', src.due_on,
    'new_start_on', after_row.start_on, 'new_due_on', after_row.due_on));

  for plan in
    select * from jsonb_to_recordset(plan_rows) as r(
      task_id uuid, title text, start_on date, due_on date, new_start date, new_due date,
      shift_days integer, status text, reason text)
  loop
    if plan.status <> 'move' then
      skipped := skipped || jsonb_build_array(jsonb_build_object('task_id', plan.task_id, 'title', plan.title, 'reason', plan.reason));
      continue;
    end if;
    if not (plan.task_id = any (coalesce(confirmed_tasks, '{}'))) then
      skipped := skipped || jsonb_build_array(jsonb_build_object('task_id', plan.task_id, 'title', plan.title,
        'reason', 'Not part of the confirmed change'));
      continue;
    end if;
    after_row := null;
    update public.tasks x
    set start_on = plan.new_start, due_on = plan.new_due
    where x.id = plan.task_id
      and x.deleted_at is null
      and x.start_on is not distinct from plan.start_on
      and x.due_on is not distinct from plan.due_on
    returning * into after_row;
    if after_row.id is null then
      skipped := skipped || jsonb_build_array(jsonb_build_object('task_id', plan.task_id, 'title', plan.title,
        'reason', 'It changed since the preview'));
    else
      changes := changes || jsonb_build_array(jsonb_build_object(
        'task_id', plan.task_id, 'title', plan.title,
        'old_start_on', plan.start_on, 'old_due_on', plan.due_on,
        'new_start_on', after_row.start_on, 'new_due_on', after_row.due_on));
    end if;
  end loop;

  return jsonb_build_object('changes', changes, 'skipped', skipped);
end;
$$;

-- Puts back the dates apply_dependency_shift changed: each task whose dates are still the ones the shift
-- set gets its old dates back (through RLS, so only tasks the caller edits); anything changed since is
-- left alone and reported. Returns { restored: [task ids], skipped: [{ task_id, title, reason }] }.
create or replace function public.undo_dependency_shift(changes jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  item jsonb;
  target uuid;
  restored jsonb := '[]'::jsonb;
  skipped jsonb := '[]'::jsonb;
  found_title text;
  n integer;
begin
  if jsonb_typeof(changes) <> 'array' or jsonb_array_length(changes) > 501 then
    raise exception 'Nothing to undo' using errcode = 'check_violation';
  end if;
  for item in select value from jsonb_array_elements(changes) loop
    if jsonb_typeof(item) <> 'object' or coalesce(item ->> 'task_id', '') !~* '^[0-9a-f-]{36}$' then
      raise exception 'Nothing to undo' using errcode = 'check_violation';
    end if;
    target := (item ->> 'task_id')::uuid;
    update public.tasks x
    set start_on = (item ->> 'old_start_on')::date, due_on = (item ->> 'old_due_on')::date
    where x.id = target
      and x.deleted_at is null
      and x.start_on is not distinct from (item ->> 'new_start_on')::date
      and x.due_on is not distinct from (item ->> 'new_due_on')::date;
    get diagnostics n = row_count;
    if n = 1 then
      restored := restored || jsonb_build_array(target);
    else
      select x.title into found_title from public.tasks x where x.id = target;
      skipped := skipped || jsonb_build_array(jsonb_build_object(
        'task_id', target,
        'title', found_title,
        'reason', case
          when found_title is null then 'Not found, or you don’t have access to it'
          when not public.has_task_role(target, 'editor') then 'You can’t edit this task'
          else 'Its dates changed since' end));
    end if;
  end loop;
  return jsonb_build_object('restored', restored, 'skipped', skipped);
end;
$$;

revoke all on function public.preview_dependency_shift(uuid, date, date) from public, anon;
grant execute on function public.preview_dependency_shift(uuid, date, date) to authenticated;
revoke all on function public.apply_dependency_shift(uuid, date, date, uuid[]) from public, anon;
grant execute on function public.apply_dependency_shift(uuid, date, date, uuid[]) to authenticated;
revoke all on function public.undo_dependency_shift(jsonb) from public, anon;
grant execute on function public.undo_dependency_shift(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Tag stories (definer trigger, revoked from clients)
-- ---------------------------------------------------------------------------
-- tag_added / tag_removed on the task, attributed to the person (or rule). Like project memberships,
-- tags set in the transaction that created the task (quick-add, task templates, recurrence) aren't
-- logged; imports and copies write nothing (add_story's own import / copy checks).

create or replace function public.on_task_tag_story()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  tag public.tags;
begin
  if exists (select 1 from public.tasks t where t.id = new.task_id and t.created_at = now()) then
    return null;
  end if;
  select * into tag from public.tags t where t.id = new.tag_id;
  if tg_op = 'INSERT' and new.deleted_at is null then
    perform public.add_story(new.task_id, 'tag_added',
      jsonb_build_object('tag_id', new.tag_id, 'tag_name', tag.name, 'tag_color', tag.color));
  elsif tg_op = 'UPDATE' and old.deleted_at is null and new.deleted_at is not null then
    perform public.add_story(new.task_id, 'tag_removed',
      jsonb_build_object('tag_id', new.tag_id, 'tag_name', tag.name, 'tag_color', tag.color));
  end if;
  return null;
end;
$$;

revoke all on function public.on_task_tag_story() from public, anon, authenticated;

create trigger task_tags_after_change_story
  after insert or update of deleted_at on public.task_tags
  for each row execute function public.on_task_tag_story();

-- ---------------------------------------------------------------------------
-- Convert a task into a subtask, and a subtask into a task
-- ---------------------------------------------------------------------------
-- convert_to_subtask(task, parent) / convert_to_task(subtask, project, section) (invoker). The parent change
-- itself goes through RLS (Editor on the task's tree before AND after, i.e. on both tasks) and
-- tasks_05_subtask_parent (cycles, depth limit, same workspace). That guard still refuses a plain update
-- of parent_task_id between null and a task (suite 99); the RPCs mark the one task they convert with the
-- transaction-local GUC alhc.convert_task. The GUC is API discipline, not a security boundary: every
-- check above, and the membership rules below, apply whichever way the update arrives.
--   * To a subtask: it leaves every project it was in (subtasks have no memberships). That needs Editor in
--     each of those projects; otherwise nothing changes ("also in projects you can't edit").
--   * To a task: it becomes a top-level task of an active project of its workspace where the caller is an
--     Editor (default: its root task's home project), in the section given (else No section).
-- Tags, custom field values (values of fields outside the new projects are kept, just not shown),
-- comments, followers, attachments, approvals, dependencies, and its own subtasks stay with it.

select public.alhc_patch_function('public.guard_task_parent()',
$p$  if tg_op = 'UPDATE' and (old.parent_task_id is null) <> (new.parent_task_id is null) then
    raise exception 'A task can’t become a subtask, or a subtask a task, yet'
      using errcode = 'check_violation', hint = 'Move the subtask under another task instead';
  end if;
  if new.parent_task_id is null then
    new.root_task_id := null;
    return new;
  end if;$p$,
$p$  if tg_op = 'UPDATE' and (old.parent_task_id is null) <> (new.parent_task_id is null)
     and current_setting('alhc.convert_task', true) is distinct from new.id::text then
    raise exception 'A task can’t become a subtask, or a subtask a task, this way'
      using errcode = 'check_violation', hint = 'Use Convert to subtask / Convert to task (convert_to_subtask, convert_to_task)';
  end if;
  if new.parent_task_id is null then
    new.root_task_id := null;
    if tg_op = 'UPDATE' and old.parent_task_id is not null then
      -- A subtask becoming a task: its home project must be an active project of its workspace.
      if not exists (
        select 1 from public.projects p
        where p.id = new.home_project_id and p.deleted_at is null and p.workspace_id = old.workspace_id
      ) then
        raise exception 'Choose an active project in this workspace' using errcode = 'check_violation';
      end if;
      new.subtask_order := 0;
    end if;
    return new;
  end if;$p$);

-- Subtasks never have memberships, so the home-membership guard only applies to tasks.
select public.alhc_patch_function('public.guard_home_membership()',
$p$    where t.id = new.task_id and t.home_project_id = new.project_id
  ) then$p$,
$p$    where t.id = new.task_id and t.home_project_id = new.project_id and t.parent_task_id is null
  ) then$p$);

-- Memberships and the story of a conversion. Definer so it can see (and refuse) memberships in projects
-- the caller can't read; it only removes memberships in projects where the caller is an Editor.
create or replace function public.on_task_converted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  tp record;
begin
  if old.parent_task_id is null and new.parent_task_id is not null then
    for tp in
      select m.project_id from public.task_projects m
      where m.task_id = new.id and m.deleted_at is null
      for update
    loop
      if not public.has_project_role(tp.project_id, 'editor') then
        raise exception 'This task is also in projects you can’t edit; remove it from them first'
          using errcode = 'insufficient_privilege';
      end if;
      update public.task_projects m set deleted_at = now()
      where m.task_id = new.id and m.project_id = tp.project_id;
    end loop;
    perform public.add_story(new.id, 'converted_to_subtask', jsonb_build_object(
      'parent_id', new.parent_task_id,
      'parent_title', (select t.title from public.tasks t where t.id = new.parent_task_id)));
  elsif old.parent_task_id is not null and new.parent_task_id is null then
    if not public.has_project_role(new.home_project_id, 'editor') then
      raise exception 'Only editors of that project can add tasks to it' using errcode = 'insufficient_privilege';
    end if;
    if not exists (
      select 1 from public.task_projects m
      where m.task_id = new.id and m.project_id = new.home_project_id and m.deleted_at is null
    ) then
      insert into public.task_projects (task_id, project_id, sort_order)
      values (
        new.id,
        new.home_project_id,
        coalesce((select max(m.sort_order) + 1024 from public.task_projects m
                  where m.project_id = new.home_project_id and m.deleted_at is null), 1024)
      )
      on conflict (task_id, project_id) do update set deleted_at = null;
    end if;
    perform public.add_story(new.id, 'converted_to_task', jsonb_build_object(
      'project_id', new.home_project_id,
      'project_name', (select p.name from public.projects p where p.id = new.home_project_id),
      'parent_id', old.parent_task_id,
      'parent_title', (select t.title from public.tasks t where t.id = old.parent_task_id)));
  end if;
  return null;
end;
$$;

revoke all on function public.on_task_converted() from public, anon, authenticated;

-- "zz" so it runs after tasks_ensure_home_membership (AFTER triggers fire in name order).
create trigger tasks_zz_after_convert
  after update of parent_task_id on public.tasks
  for each row
  when ((old.parent_task_id is null) <> (new.parent_task_id is null))
  execute function public.on_task_converted();

create or replace function public.convert_to_subtask(target_task uuid, new_parent uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  t public.tasks;
  parent public.tasks;
begin
  select * into t from public.tasks x where x.id = target_task and x.deleted_at is null;
  if not found then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;
  if t.parent_task_id is not null then
    raise exception 'This is already a subtask; move it under another task instead' using errcode = 'check_violation';
  end if;
  select * into parent from public.tasks x where x.id = new_parent and x.deleted_at is null;
  if not found then
    raise exception 'Parent task not found' using errcode = 'no_data_found';
  end if;
  if not public.has_task_role(target_task, 'editor') or not public.has_task_role(new_parent, 'editor') then
    raise exception 'You need Editor access to both tasks to do that' using errcode = 'insufficient_privilege';
  end if;
  perform set_config('alhc.convert_task', target_task::text, true);
  update public.tasks x
  set parent_task_id = new_parent,
      subtask_order = public.subtask_order_before(new_parent, null, target_task)
  where x.id = target_task;
  perform set_config('alhc.convert_task', '', true);
end;
$$;

create or replace function public.convert_to_task(
  target_task uuid,
  target_project uuid default null,
  target_section uuid default null
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  t public.tasks;
  project uuid;
begin
  select * into t from public.tasks x where x.id = target_task and x.deleted_at is null;
  if not found then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;
  if t.parent_task_id is null then
    raise exception 'This is already a task' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.approval_requests a where a.subtask_id = target_task) then
    raise exception 'Approval subtasks stay with their approval' using errcode = 'check_violation';
  end if;
  project := coalesce(target_project, t.home_project_id);
  if not public.has_task_role(target_task, 'editor') or not public.has_project_role(project, 'editor') then
    raise exception 'You need Editor access to the subtask and to that project' using errcode = 'insufficient_privilege';
  end if;
  if target_section is not null and not exists (
    select 1 from public.sections s where s.id = target_section and s.project_id = project and s.deleted_at is null
  ) then
    raise exception 'That section isn’t in this project' using errcode = 'check_violation';
  end if;
  perform set_config('alhc.convert_task', target_task::text, true);
  update public.tasks x set parent_task_id = null, home_project_id = project where x.id = target_task;
  perform set_config('alhc.convert_task', '', true);
  perform public.place_task(target_task, project, target_section, null);
end;
$$;

revoke all on function public.convert_to_subtask(uuid, uuid) from public, anon;
grant execute on function public.convert_to_subtask(uuid, uuid) to authenticated;
revoke all on function public.convert_to_task(uuid, uuid, uuid) from public, anon;
grant execute on function public.convert_to_task(uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Views: "Show subtasks" is a saved view setting (List)
-- ---------------------------------------------------------------------------
-- config.show_subtasks = true | false (absent = false). Mirrored by src/lib/views.ts.

select public.alhc_patch_function('public.validate_view_config(uuid, jsonb)',
$p$k not in ('filters', 'sort', 'group_by', 'columns')$p$,
$p$k not in ('filters', 'sort', 'group_by', 'columns', 'show_subtasks')$p$,
$p$  perform public.validate_view_filters(target_project, config -> 'filters');
$p$,
$p$  perform public.validate_view_filters(target_project, config -> 'filters');

  if config ? 'show_subtasks' and jsonb_typeof(config -> 'show_subtasks') <> 'boolean' then
    raise exception 'Show subtasks is on or off' using errcode = 'check_violation';
  end if;
$p$);

-- ---------------------------------------------------------------------------
-- Done with the patch helper
-- ---------------------------------------------------------------------------

drop function public.alhc_patch_function(regprocedure, text[]);
