-- ALHC Projects — Task types and nested rollups.
--
-- Prefer SECURITY INVOKER. The one new SECURITY DEFINER function is the trigger sync_task_approval(),
-- which opens and cancels approval requests through the existing approvals engine (create_approval is
-- internal and approval_requests has no client write path); like every definer trigger it is revoked
-- from client roles, so suite 60's list is unchanged. Existing functions are redefined with their
-- signatures and EXECUTE grants unchanged. fire_rules / notify_with / add_story are not touched.
--
--   * Task kinds: tasks.kind = task | milestone | approval (default task; CHECK tasks_kind_check).
--     Editors set it like any task column (RLS). A change writes a kind_changed story. Templates
--     (project snapshots and task templates), Duplicate project, recurrence, and the Asana importer
--     keep it.
--
--   * Milestones have only a due date: the invoker trigger tasks_13_task_kind clears start_on / start_at
--     whenever a task is (or becomes) a milestone. They are zero length in project_critical_path() (start
--     = due), and portfolio_milestones() lists each readable rollup project's open milestones for the
--     portfolio Timeline.
--
--   * Approval tasks reuse the approvals engine (approval_requests, approval_requested /
--     approval_decided inbox items and stories, the approval_decided rule trigger). The assignee is the
--     approver. The request of an approval task = an approval_requests row with subtask_id null whose
--     approver is the task's assignee. sync_task_approval() (AFTER INSERT / UPDATE OF kind, assignee_id):
--       - becoming an open approval task with an assignee, or a new assignee: opens a request through
--         create_approval(as_subtask = false) unless that person already has an open one (pending or
--         changes requested). The requester is whoever made the change (none for rules).
--       - a new assignee, unassigning, or switching away from approval: cancels the previous assignee's
--         open request.
--       - a person (not a rule, not a nested system write) assigning someone below Commenter is
--         rejected: they couldn't decide (decide_approval needs Commenter+). Rule-made assignments
--         follow the rule-created approvals rule and aren't checked.
--       - never while an import (alhc.import_run_id) or a copy (alhc.copy_id) runs: imported and copied
--         approval tasks open no request and notify nobody; an editor can request one from the pane.
--     Only the assignee decides (decide_approval, unchanged). approved / rejected complete the task
--     (complete_approval_task, invoker); changes requested leaves it open; people can't tick an approval
--     task complete while its request is open (tasks_13_task_kind). Notifications stay one per event:
--     an open approval task's assignee gets approval_requested instead of a separate assigned item, and a
--     completion caused by the decision doesn't add completed items on top of approval_decided.
--
--   * Nested rollups: portfolio_workload(), goal_task_counts() (and so goal_progress()), and
--     goal_hidden_project_count() now include the projects of nested portfolios through
--     portfolio_rollup_projects() / the same tree walk as portfolio_hidden_project_count(). Only links the
--     caller can see and projects the caller can read count; hidden counts stay numbers only.

-- ---------------------------------------------------------------------------
-- Task kinds
-- ---------------------------------------------------------------------------

alter table public.tasks
  add column kind text not null default 'task'
  constraint tasks_kind_check check (kind in ('task', 'milestone', 'approval'));

comment on column public.tasks.kind is
  'task | milestone | approval. Milestones have only a due date; an approval task''s assignee approves it.';

alter table public.task_templates
  add column kind text not null default 'task'
  constraint task_templates_kind_check check (kind in ('task', 'milestone', 'approval'));

alter table public.task_stories drop constraint task_stories_kind_check;
alter table public.task_stories add constraint task_stories_kind_check check (kind in (
  'created', 'completed', 'reopened', 'renamed', 'assigned', 'unassigned', 'due_changed', 'start_changed',
  'section_changed', 'project_added', 'project_removed', 'attachment_added', 'field_changed',
  'deleted', 'approval_requested', 'approval_decided', 'approval_cancelled', 'approval_resubmitted',
  'form_submitted', 'request_number_assigned', 'email_queued',
  'recurrence_changed', 'recurrence_spawned', 'dependency_added', 'dependency_removed', 'restored',
  'integration_queued', 'integration_failed', 'kind_changed'
));

-- Runs as the caller. Milestones keep only a due date; people can't tick an approval task complete
-- while its assignee's request is open (system completions — the decision itself, rules — pass).
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
  return new;
end;
$$;

revoke all on function public.guard_task_kind() from public, anon;
grant execute on function public.guard_task_kind() to authenticated;

create trigger tasks_13_task_kind
  before insert or update on public.tasks
  for each row execute function public.guard_task_kind();

-- ---------------------------------------------------------------------------
-- Approval tasks
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER on purpose: it opens requests through the internal create_approval() and cancels
-- them, and approval_requests has no client write path. Revoked from client roles below.
create or replace function public.sync_task_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  was_approval boolean := tg_op = 'UPDATE' and old.kind = 'approval';
  previous uuid := case when tg_op = 'UPDATE' then old.assignee_id end;
begin
  if tg_op = 'UPDATE' then
    if new.kind is not distinct from old.kind and new.assignee_id is not distinct from old.assignee_id then
      return null;
    end if;
    if new.kind is distinct from old.kind then
      perform public.add_story(new.id, 'kind_changed', jsonb_build_object('from', old.kind, 'to', new.kind));
    end if;
  end if;

  -- Imports and copies never open (or cancel) approval requests.
  if public.import_context_id() is not null or public.copy_context_id() is not null or new.deleted_at is not null then
    return null;
  end if;

  if was_approval and previous is not null
     and (new.kind <> 'approval' or new.assignee_id is distinct from previous) then
    update public.approval_requests a
    set status = 'cancelled'
    where a.task_id = new.id and a.subtask_id is null and a.approver_id = previous
      and a.deleted_at is null and a.status in ('pending', 'changes_requested');
  end if;

  if new.kind = 'approval' and new.assignee_id is not null and new.completed_at is null
     and (not was_approval or new.assignee_id is distinct from previous)
     and not exists (
       select 1 from public.approval_requests a
       where a.task_id = new.id and a.subtask_id is null and a.approver_id = new.assignee_id
         and a.deleted_at is null and a.status in ('pending', 'changes_requested')
     ) then
    -- A person's direct edit (not a rule, not a write nested in another trigger such as a recurrence
    -- spawn) must name someone who can decide.
    if public.rule_context_id() is null and pg_trigger_depth() <= 1
       and public.project_role_rank(public.profile_task_role(new.assignee_id, new.id))
           < public.project_role_rank('commenter') then
      raise exception 'The assignee of an approval task approves it, so they need at least Commenter access'
        using errcode = 'check_violation';
    end if;
    perform public.create_approval(new.id, new.assignee_id, null, false, null);
  end if;
  return null;
end;
$$;

revoke all on function public.sync_task_approval() from public, anon, authenticated;

create trigger tasks_sync_approval
  after insert or update of kind, assignee_id on public.tasks
  for each row execute function public.sync_task_approval();

-- Runs as the caller (always decide_approval, the only path that sets these statuses). Approving or
-- rejecting an approval task's request completes the task, as in Asana.
create or replace function public.complete_approval_task()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.subtask_id is null and new.status in ('approved', 'rejected') and old.status is distinct from new.status then
    update public.tasks t
    set completed_at = now()
    where t.id = new.task_id and t.kind = 'approval' and t.assignee_id = new.approver_id
      and t.completed_at is null and t.deleted_at is null;
  end if;
  return null;
end;
$$;

revoke all on function public.complete_approval_task() from public, anon;
grant execute on function public.complete_approval_task() to authenticated;

create trigger approval_requests_after_task_kind
  after update of status on public.approval_requests
  for each row execute function public.complete_approval_task();

-- One inbox item per event for approval tasks (see the header); otherwise as before.

create or replace function public.on_task_insert_collab()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.add_story(new.id, 'created', '{}'::jsonb);
  perform public.follow_task(new.id, new.created_by);
  if new.assignee_id is not null then
    perform public.follow_task(new.id, new.assignee_id);
    perform public.add_story(new.id, 'assigned', jsonb_build_object('assignee_id', new.assignee_id));
    -- An open approval task's assignee hears about it once: the approval_requested item.
    if new.kind <> 'approval' or new.completed_at is not null then
      perform public.notify(new.assignee_id, new.id, 'assigned');
    end if;
  end if;
  return new;
end;
$$;

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
    -- An approval task closed by its decision: followers already got approval_decided.
    if new.kind <> 'approval' or not exists (
      select 1 from public.approval_requests a
      where a.task_id = new.id and a.subtask_id is null and a.deleted_at is null
        and a.status in ('approved', 'rejected') and a.decided_at = now()
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
-- Kinds survive recurrence, templates, Duplicate project, and imports
-- ---------------------------------------------------------------------------

-- Same as before plus the kind.
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
    recurrence, recurrence_series_id, recurrence_seq, kind
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
    new.kind
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

  insert into public.subtasks (task_id, title, sort_order)
  select next_id, s.title, s.sort_order
  from public.subtasks s
  where s.task_id = new.id
    and s.deleted_at is null
    and not exists (select 1 from public.approval_requests a where a.subtask_id = s.id);

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

-- Same as before plus the kind (snapshot key "kind"; older snapshots without it make plain tasks).
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
        'subtasks', coalesce((
          select jsonb_agg(jsonb_build_object('title', sb.title, 'completed', keep_completion and sb.completed_at is not null)
            order by sb.sort_order, sb.created_at)
          from public.subtasks sb
          where sb.task_id = st.id and sb.deleted_at is null
            and not exists (select 1 from public.approval_requests a where a.subtask_id = sb.id)
        ), '[]'::jsonb)
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

revoke all on function public.project_snapshot(uuid, jsonb) from public, anon, authenticated;

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

    i := 0;
    for child in select * from jsonb_array_elements(case when jsonb_typeof(item -> 'subtasks') = 'array' then item -> 'subtasks' else '[]' end) loop
      continue when nullif(trim(child ->> 'title'), '') is null;
      i := i + 1;
      insert into public.subtasks (task_id, title, completed_at, sort_order)
      values (
        new_task,
        left(trim(child ->> 'title'), 1000),
        case when coalesce((child ->> 'completed')::boolean, false) then now() end,
        i * 1024
      );
    end loop;
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

revoke all on function public.instantiate_project_snapshot(jsonb, text, date, uuid, text, jsonb)
  from public, anon, authenticated;

-- Same as before plus the kind (batch task key "kind": milestone | approval, else a plain task). The
-- import context still mutes everything, so imported approval tasks open no request.
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

    -- Subtasks (title + completion; nested subtasks arrive flattened) ------------------------------
    for child in select * from jsonb_array_elements(case when jsonb_typeof(item -> 'subtasks') = 'array' then item -> 'subtasks' else '[]' end) loop
      continue when nullif(child ->> 'gid', '') is null or public.import_local_id(p, src, 'subtask', child ->> 'gid') is not null;
      insert into public.subtasks (task_id, title, completed_at, sort_order)
      values (
        t,
        left(coalesce(nullif(trim(child ->> 'title'), ''), 'Untitled subtask'), 1000),
        case when nullif(child ->> 'completed_at', '') is not null
          then coalesce(public.import_timestamp(child ->> 'completed_at'), now()) end,
        coalesce((select max(s.sort_order) + 1024 from public.subtasks s where s.task_id = t and s.deleted_at is null), 1024)
      )
      returning id into found_id;
      perform public.import_remember(p, src, 'subtask', child ->> 'gid', found_id, run.id);
      n_subtasks := n_subtasks + 1;
    end loop;

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

revoke all on function public.import_batch(uuid, jsonb) from public, anon;
grant execute on function public.import_batch(uuid, jsonb) to authenticated;

-- Task templates keep the kind too (same signatures, still SECURITY INVOKER).
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
    where tp.task_id = t.id and tp.project_id = target_project and tp.deleted_at is null
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
      select jsonb_agg(to_jsonb(s.title) order by s.sort_order, s.created_at)
      from (select * from public.subtasks s where s.task_id = t.id and s.deleted_at is null
            order by s.sort_order, s.created_at limit 100) s
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

revoke all on function public.save_task_as_template(uuid, uuid, text, boolean) from public, anon;
grant execute on function public.save_task_as_template(uuid, uuid, text, boolean) to authenticated;

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
    insert into public.subtasks (task_id, title, sort_order) values (new_task, left(trim(item #>> '{}'), 1000), i * 1024);
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

revoke all on function public.create_task_from_template(uuid, uuid, text) from public, anon;
grant execute on function public.create_task_from_template(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Milestones: critical path and portfolio Timeline
-- ---------------------------------------------------------------------------

-- Same signature and output as before; milestones are zero length.
create or replace function public.project_critical_path(target_project uuid)
returns table (
  task_id uuid,
  start_on date,
  due_on date,
  slack_days integer,
  critical boolean,
  skipped boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with recursive nodes as (
    -- A milestone is zero length: it starts on its due day.
    select distinct t.id,
           case when t.kind = 'milestone' then t.due_on else coalesce(t.start_on, t.due_on) end as s,
           t.due_on as d
    from public.task_projects tp
    join public.tasks t on t.id = tp.task_id and t.deleted_at is null
    where tp.project_id = target_project
      and tp.deleted_at is null
      and public.has_project_role(target_project, 'viewer')
  ),
  dated as (
    select n.id, n.s, n.d from nodes n where n.d is not null
  ),
  bounds as (
    select max(dated.d) as finish from dated
  ),
  edges as (
    select distinct dep.predecessor_id as pred, dep.successor_id as succ
    from public.task_dependencies dep
    join dated a on a.id = dep.predecessor_id
    join dated b on b.id = dep.successor_id
    where dep.project_id = target_project and dep.deleted_at is null
  ),
  -- Walks back from every task: a predecessor's remaining work is its successor's remaining work plus
  -- the successor's duration. UNION drops repeats, so this ends on any DAG (dependencies reject cycles);
  -- the day cap is a backstop.
  remaining (id, days) as (
    select dated.id, 0 from dated
    union
    select e.pred, r.days + (b.d - b.s)
    from remaining r
    join edges e on e.succ = r.id
    join dated b on b.id = r.id
    where r.days < 36600
  ),
  longest as (
    select r.id, max(r.days) as days from remaining r group by r.id
  )
  select dated.id,
         dated.s,
         dated.d,
         ((bounds.finish - l.days) - dated.d)::integer,
         ((bounds.finish - l.days) - dated.d) <= 0,
         false
  from dated
  join longest l on l.id = dated.id
  cross join bounds
  union all
  select n.id, n.s, n.d, null::integer, false, true
  from nodes n
  where n.d is null;
$$;

revoke all on function public.project_critical_path(uuid) from public, anon;
grant execute on function public.project_critical_path(uuid) to authenticated;

-- Open milestones with a due date in every readable project of the rollup (direct or nested), for the
-- portfolio Timeline. A milestone multi-homed into two of those projects shows on both rows.
create or replace function public.portfolio_milestones(target_portfolio uuid)
returns table (project_id uuid, task_id uuid, title text, due_on date)
language sql
stable
security invoker
set search_path = ''
as $$
  select r.project_id, t.id, t.title, t.due_on
  from public.portfolio_rollup_projects(target_portfolio) r
  join public.task_projects tp on tp.project_id = r.project_id and tp.deleted_at is null
  join public.tasks t on t.id = tp.task_id
  where t.deleted_at is null
    and t.completed_at is null
    and t.kind = 'milestone'
    and t.due_on is not null
    and public.has_project_role(r.project_id, 'viewer')
  order by r.project_id, t.due_on, t.id;
$$;

revoke all on function public.portfolio_milestones(uuid) from public, anon;
grant execute on function public.portfolio_milestones(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Nested rollups: workload and goals
-- ---------------------------------------------------------------------------

-- Same signature and output as before. The projects are now the rollup (the portfolio's own projects
-- plus those of nested portfolios the caller can see), still only projects the caller can read, each
-- task once. project_id = the task's home project when it is one of them, else the first of them in
-- rollup order (own projects, then by nested portfolio).
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
    join public.tasks t on t.id = tp.task_id
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
          join public.task_projects tp on tp.task_id = t.id and tp.project_id = f.project_id and tp.deleted_at is null
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

revoke all on function public.portfolio_workload(uuid, date, date, text) from public, anon;
grant execute on function public.portfolio_workload(uuid, date, date, text) to authenticated;

-- Same signature and grants (a count only, never a name or id). A linked portfolio now also brings the
-- projects of its nested portfolios: a project is hidden when the caller can't read it or can only
-- reach it through a portfolio they aren't a member of — exactly what goal_task_counts() leaves out.
create or replace function public.goal_hidden_project_count(target_goal uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  with recursive goal as (
    select g.id from public.goals g
    where g.id = target_goal and g.deleted_at is null and public.is_allowlisted()
  ),
  tree (portfolio_id, visible, path) as (
    select po.id, public.has_portfolio_role(po.id, 'viewer'), array[po.id]
    from goal
    join public.goal_links l on l.goal_id = goal.id and l.deleted_at is null and l.portfolio_id is not null
    join public.portfolios po on po.id = l.portfolio_id and po.deleted_at is null
    union all
    select c.child_id, t.visible and public.has_portfolio_role(c.child_id, 'viewer'), t.path || c.child_id
    from tree t
    join public.portfolio_children c on c.parent_id = t.portfolio_id and c.deleted_at is null
    join public.portfolios po on po.id = c.child_id and po.deleted_at is null
    where not c.child_id = any (t.path) and cardinality(t.path) <= 20
  ),
  linked as (
    select l.project_id, (public.has_project_role(l.project_id, 'viewer')) as visible
    from goal
    join public.goal_links l on l.goal_id = goal.id and l.deleted_at is null and l.project_id is not null
    join public.projects p on p.id = l.project_id and p.deleted_at is null
    union all
    select pp.project_id, (t.visible and public.has_project_role(pp.project_id, 'viewer'))
    from tree t
    join public.portfolio_projects pp on pp.portfolio_id = t.portfolio_id and pp.deleted_at is null
    join public.projects p on p.id = pp.project_id and p.deleted_at is null
  )
  select count(*)::integer
  from (select project_id from linked group by project_id having not bool_or(visible)) hidden;
$$;

revoke all on function public.goal_hidden_project_count(uuid) from public, anon;
grant execute on function public.goal_hidden_project_count(uuid) to authenticated;

-- Same signature and grants. Linked portfolios count through portfolio_rollup_projects(): their own
-- projects plus those of nested portfolios the caller can see, only projects the caller can read, each
-- task once. goal_progress() calls this, so its projects mode rolls up too (its definition is unchanged).
create or replace function public.goal_task_counts(target_goal uuid)
returns table (task_count bigint, completed_count bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with visible_projects as (
    select l.project_id
    from public.goal_links l
    join public.projects p on p.id = l.project_id and p.deleted_at is null
    where l.goal_id = target_goal and l.deleted_at is null and l.project_id is not null
      and public.has_project_role(l.project_id, 'viewer')
    union
    select r.project_id
    from public.goal_links l
    join public.portfolios po on po.id = l.portfolio_id and po.deleted_at is null
    cross join lateral public.portfolio_rollup_projects(l.portfolio_id) r
    where l.goal_id = target_goal and l.deleted_at is null and l.portfolio_id is not null
      and public.has_portfolio_role(l.portfolio_id, 'viewer')
      and public.has_project_role(r.project_id, 'viewer')
  ),
  counted as (
    select distinct t.id, t.completed_at
    from visible_projects vp
    join public.task_projects tp on tp.project_id = vp.project_id and tp.deleted_at is null
    join public.tasks t on t.id = tp.task_id and t.deleted_at is null
  )
  select count(*), count(*) filter (where completed_at is not null) from counted;
$$;

revoke all on function public.goal_task_counts(uuid) from public, anon;
grant execute on function public.goal_task_counts(uuid) to authenticated;

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
