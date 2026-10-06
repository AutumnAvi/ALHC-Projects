-- Phase: Bulk edit and shortcuts.
--
-- No new tables. Adds SECURITY INVOKER RPCs, so the caller's RLS applies to every write and every
-- existing trigger (stories, inbox items, rules, dependency guard, field validation) runs per task
-- exactly as for a single edit:
--
--   bulk_update_tasks(target_tasks uuid[], operation jsonb) -> jsonb
--     Applies one operation to up to 200 tasks, Asana style: every task that can be changed is
--     changed; a task that can't (not readable, below Editor, blocked by a dependency, constraint)
--     is skipped with a reason, and the others still go through. Each task runs in its own
--     subtransaction, so a failure rolls back only that task (including the rules it fired).
--
--     operation = { "action": ... } with
--       complete | reopen | delete
--       assign          { "assignee_id": uuid | null }            assignee must be able to read the task
--       set_due         { "due_on": "YYYY-MM-DD" | null }
--       move_section    { "project_id": uuid, "section_id": uuid | null }   tasks must be in the project
--       add_to_project  { "project_id": uuid, "section_id": uuid | null }   multi-homes (end of section)
--       set_field       { "field_id": uuid, "value": json }       JSON null clears; not section-bound
--
--     Problems with the operation itself (unknown action, a section of another project, a missing
--     field, no Editor role in the target project, more than 200 tasks) raise and change nothing.
--     Returns { "updated": [task ids changed], "unchanged": [already in that state],
--               "skipped": [{ "task_id", "title" (null when unreadable), "reason" }] }.
--     Completing retries tasks blocked only by other tasks in the same request, so completing a
--     predecessor and its successor together works in any order.
--
--   place_task(target_task, target_project, target_section, before_task) -> double precision
--     Moves a task's membership to a section and before `before_task` (null = end). Midpoint of
--     the neighbours (fractional sort_order, step 1024, same as Board); when the gap is too small
--     or the neighbour shares its sort_order, the section is reindexed first.
--   place_section(target_section, before_section) -> double precision        same for sections
--   reindex_task_order(target_project, target_section) -> integer   renumber one section 1024, 2048, …
--   reindex_section_order(target_project) -> integer                 renumber a project's sections
--     All need Editor on the project (explicit check; RLS also applies).

-- ---------------------------------------------------------------------------
-- Ordering helpers
-- ---------------------------------------------------------------------------

create or replace function public.reindex_task_order(target_project uuid, target_section uuid)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  changed integer;
begin
  if not public.has_project_role(target_project, 'editor') then
    raise exception 'Your role in this project doesn’t allow that' using errcode = 'insufficient_privilege';
  end if;
  update public.task_projects tp
  set sort_order = ranked.position * 1024
  from (
    select m.task_id, row_number() over (order by m.sort_order, m.created_at, m.task_id) as position
    from public.task_projects m
    where m.project_id = target_project
      and m.section_id is not distinct from target_section
      and m.deleted_at is null
  ) ranked
  where tp.project_id = target_project
    and tp.task_id = ranked.task_id
    and tp.sort_order is distinct from ranked.position * 1024;
  get diagnostics changed = row_count;
  return changed;
end;
$$;

create or replace function public.reindex_section_order(target_project uuid)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  changed integer;
begin
  if not public.has_project_role(target_project, 'editor') then
    raise exception 'Your role in this project doesn’t allow that' using errcode = 'insufficient_privilege';
  end if;
  update public.sections s
  set sort_order = ranked.position * 1024
  from (
    select x.id, row_number() over (order by x.sort_order, x.created_at, x.id) as position
    from public.sections x
    where x.project_id = target_project and x.deleted_at is null
  ) ranked
  where s.id = ranked.id and s.sort_order is distinct from ranked.position * 1024;
  get diagnostics changed = row_count;
  return changed;
end;
$$;

-- Gaps below this are reindexed before inserting (doubles keep ~15 significant digits, so a
-- section can take ~30 consecutive midpoint inserts at one spot before this triggers).
create or replace function public.min_order_gap()
returns double precision
language sql
immutable
set search_path = ''
as $$ select 0.000001::double precision $$;

create or replace function public.place_task(
  target_task uuid,
  target_project uuid,
  target_section uuid,
  before_task uuid
)
returns double precision
language plpgsql
security invoker
set search_path = ''
as $$
declare
  next_order double precision;
  prev_order double precision;
  new_order double precision;
  attempt integer;
begin
  if not public.has_project_role(target_project, 'editor') then
    raise exception 'Your role in this project doesn’t allow that' using errcode = 'insufficient_privilege';
  end if;
  if target_section is not null and not exists (
    select 1 from public.sections s
    where s.id = target_section and s.project_id = target_project and s.deleted_at is null
  ) then
    raise exception 'That section isn’t in this project' using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.task_projects tp
    where tp.task_id = target_task and tp.project_id = target_project and tp.deleted_at is null
  ) then
    raise exception 'That task isn’t in this project' using errcode = 'check_violation';
  end if;
  if before_task = target_task then
    raise exception 'A task can’t be placed before itself' using errcode = 'check_violation';
  end if;

  for attempt in 1..2 loop
    if before_task is null then
      select max(tp.sort_order) into prev_order
      from public.task_projects tp
      where tp.project_id = target_project
        and tp.section_id is not distinct from target_section
        and tp.deleted_at is null
        and tp.task_id <> target_task;
      new_order := coalesce(prev_order, 0) + 1024;
      exit;
    end if;

    select tp.sort_order into next_order
    from public.task_projects tp
    where tp.task_id = before_task
      and tp.project_id = target_project
      and tp.section_id is not distinct from target_section
      and tp.deleted_at is null;
    if not found then
      raise exception 'The task to place it before isn’t in that section' using errcode = 'check_violation';
    end if;

    select max(tp.sort_order) into prev_order
    from public.task_projects tp
    where tp.project_id = target_project
      and tp.section_id is not distinct from target_section
      and tp.deleted_at is null
      and tp.task_id not in (target_task, before_task)
      and tp.sort_order <= next_order;

    if prev_order is null then
      new_order := next_order - 1024;
      exit;
    end if;
    if next_order - prev_order >= public.min_order_gap() then
      new_order := (prev_order + next_order) / 2;
      exit;
    end if;
    -- Neighbours too close (or tied): renumber the section and look again.
    perform public.reindex_task_order(target_project, target_section);
  end loop;

  if new_order is null then
    raise exception 'Couldn’t find a position for the task' using errcode = 'check_violation';
  end if;

  update public.task_projects
  set section_id = target_section, sort_order = new_order
  where task_id = target_task and project_id = target_project and deleted_at is null;
  if not found then
    raise exception 'Your role in this project doesn’t allow that' using errcode = 'insufficient_privilege';
  end if;
  return new_order;
end;
$$;

create or replace function public.place_section(target_section uuid, before_section uuid)
returns double precision
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target_project uuid;
  next_order double precision;
  prev_order double precision;
  new_order double precision;
  attempt integer;
begin
  select s.project_id into target_project
  from public.sections s where s.id = target_section and s.deleted_at is null;
  if target_project is null then
    raise exception 'Section not found' using errcode = 'no_data_found';
  end if;
  if not public.has_project_role(target_project, 'editor') then
    raise exception 'Your role in this project doesn’t allow that' using errcode = 'insufficient_privilege';
  end if;
  if before_section = target_section then
    raise exception 'A section can’t be placed before itself' using errcode = 'check_violation';
  end if;

  for attempt in 1..2 loop
    if before_section is null then
      select max(s.sort_order) into prev_order
      from public.sections s
      where s.project_id = target_project and s.deleted_at is null and s.id <> target_section;
      new_order := coalesce(prev_order, 0) + 1024;
      exit;
    end if;

    select s.sort_order into next_order
    from public.sections s
    where s.id = before_section and s.project_id = target_project and s.deleted_at is null;
    if not found then
      raise exception 'The section to place it before isn’t in this project' using errcode = 'check_violation';
    end if;

    select max(s.sort_order) into prev_order
    from public.sections s
    where s.project_id = target_project
      and s.deleted_at is null
      and s.id not in (target_section, before_section)
      and s.sort_order <= next_order;

    if prev_order is null then
      new_order := next_order - 1024;
      exit;
    end if;
    if next_order - prev_order >= public.min_order_gap() then
      new_order := (prev_order + next_order) / 2;
      exit;
    end if;
    perform public.reindex_section_order(target_project);
  end loop;

  if new_order is null then
    raise exception 'Couldn’t find a position for the section' using errcode = 'check_violation';
  end if;

  update public.sections set sort_order = new_order where id = target_section;
  if not found then
    raise exception 'Your role in this project doesn’t allow that' using errcode = 'insufficient_privilege';
  end if;
  return new_order;
end;
$$;

-- ---------------------------------------------------------------------------
-- Bulk edit
-- ---------------------------------------------------------------------------

-- Turns an error raised while changing one task into a short reason for the summary.
create or replace function public.bulk_skip_reason(state text, message text, constraint_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when state = '42501' then 'Your role doesn’t allow editing this task'
    when constraint_name = 'tasks_start_on_before_due_on' or constraint_name = 'tasks_start_at_before_due_at'
      then 'Its start date is after that due date'
    else coalesce(nullif(message, ''), 'Couldn’t be changed')
  end
$$;

create or replace function public.bulk_update_tasks(target_tasks uuid[], operation jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  action text := operation ->> 'action';
  task_ids uuid[];
  remaining uuid[];
  retry uuid[];
  t uuid;
  task_title text;
  task_deleted timestamptz;
  outcome text;
  reason text;
  progress boolean;
  changed integer;
  updated jsonb := '[]'::jsonb;
  unchanged jsonb := '[]'::jsonb;
  skipped jsonb := '[]'::jsonb;
  blocked jsonb := '{}'::jsonb;
  -- operation arguments
  arg_assignee uuid;
  arg_due date;
  arg_project uuid;
  arg_section uuid;
  arg_field uuid;
  arg_value jsonb;
  field_row record;
  current_section uuid;
  err_state text;
  err_message text;
  err_constraint text;
begin
  if auth.uid() is null or not public.is_allowlisted() then
    raise exception 'Sign in to edit tasks' using errcode = 'insufficient_privilege';
  end if;
  if operation is null or jsonb_typeof(operation) <> 'object' then
    raise exception 'Invalid bulk operation' using errcode = 'invalid_parameter_value';
  end if;

  -- Deduplicate, keeping the caller's order.
  select coalesce(array_agg(id order by first_position), '{}') into task_ids
  from (
    select id, min(position) as first_position
    from unnest(coalesce(target_tasks, '{}')) with ordinality as u(id, position)
    where id is not null
    group by id
  ) d;
  if cardinality(task_ids) = 0 then
    raise exception 'Select at least one task' using errcode = 'invalid_parameter_value';
  end if;
  if cardinality(task_ids) > 200 then
    raise exception 'Bulk edits are limited to 200 tasks at a time' using errcode = 'invalid_parameter_value';
  end if;

  -- Validate the operation once, before touching any task.
  case action
    when 'complete', 'reopen', 'delete' then
      null;
    when 'assign' then
      if not (operation ? 'assignee_id') then
        raise exception 'Choose someone to assign, or unassign' using errcode = 'invalid_parameter_value';
      end if;
      arg_assignee := nullif(operation ->> 'assignee_id', '')::uuid;
      if arg_assignee is not null and not exists (select 1 from public.profiles p where p.id = arg_assignee) then
        raise exception 'That person doesn’t exist' using errcode = 'invalid_parameter_value';
      end if;
    when 'set_due' then
      if not (operation ? 'due_on') then
        raise exception 'Choose a due date, or clear it' using errcode = 'invalid_parameter_value';
      end if;
      arg_due := nullif(operation ->> 'due_on', '')::date;
    when 'move_section', 'add_to_project' then
      arg_project := (operation ->> 'project_id')::uuid;
      arg_section := nullif(operation ->> 'section_id', '')::uuid;
      if arg_project is null or not exists (
        select 1 from public.projects p where p.id = arg_project and p.deleted_at is null
      ) then
        raise exception 'Project not found' using errcode = 'invalid_parameter_value';
      end if;
      if not public.has_project_role(arg_project, 'editor') then
        raise exception 'Your role in that project doesn’t allow that' using errcode = 'insufficient_privilege';
      end if;
      if arg_section is not null and not exists (
        select 1 from public.sections s
        where s.id = arg_section and s.project_id = arg_project and s.deleted_at is null
      ) then
        raise exception 'That section isn’t in the project' using errcode = 'invalid_parameter_value';
      end if;
    when 'set_field' then
      arg_field := (operation ->> 'field_id')::uuid;
      if not (operation ? 'value') then
        raise exception 'Choose a value, or clear it' using errcode = 'invalid_parameter_value';
      end if;
      arg_value := operation -> 'value';
      select f.id, f.project_id, f.name, f.bound_to_sections into field_row
      from public.custom_fields f where f.id = arg_field and f.deleted_at is null;
      if not found then
        raise exception 'Field not found' using errcode = 'invalid_parameter_value';
      end if;
      if field_row.bound_to_sections then
        raise exception '“%” follows the sections; use Move to section instead', field_row.name
          using errcode = 'invalid_parameter_value';
      end if;
      if not public.has_project_role(field_row.project_id, 'editor') then
        raise exception 'Your role in that project doesn’t allow that' using errcode = 'insufficient_privilege';
      end if;
      arg_project := field_row.project_id;
    else
      raise exception 'Unknown bulk action: %', coalesce(action, '(none)') using errcode = 'invalid_parameter_value';
  end case;

  remaining := task_ids;
  loop
    progress := false;
    retry := '{}';

    foreach t in array remaining loop
      outcome := null;
      reason := null;

      -- RLS: an unreadable task looks like a missing one.
      select x.title, x.deleted_at into task_title, task_deleted from public.tasks x where x.id = t;
      if not found then
        skipped := skipped || jsonb_build_object('task_id', t, 'title', null,
          'reason', 'Not found, or you don’t have access to it');
        continue;
      end if;
      if task_deleted is not null then
        skipped := skipped || jsonb_build_object('task_id', t, 'title', task_title, 'reason', 'It’s in the Trash');
        continue;
      end if;
      if not public.has_task_role(t, 'editor') then
        skipped := skipped || jsonb_build_object('task_id', t, 'title', task_title,
          'reason', 'Your role doesn’t allow editing this task');
        continue;
      end if;

      begin
        case action
          when 'complete' then
            update public.tasks set completed_at = now() where id = t and completed_at is null;
            get diagnostics changed = row_count;
          when 'reopen' then
            update public.tasks set completed_at = null where id = t and completed_at is not null;
            get diagnostics changed = row_count;
          when 'delete' then
            update public.tasks set deleted_at = now() where id = t and deleted_at is null;
            get diagnostics changed = row_count;
          when 'assign' then
            if arg_assignee is not null and not public.profile_can_read_task(arg_assignee, t) then
              outcome := 'skipped';
              reason := coalesce(
                (select coalesce(nullif(p.full_name, ''), p.email) from public.profiles p where p.id = arg_assignee),
                'That person'
              ) || ' isn’t a member of this task’s projects';
            else
              update public.tasks set assignee_id = arg_assignee
              where id = t and assignee_id is distinct from arg_assignee;
              get diagnostics changed = row_count;
            end if;
          when 'set_due' then
            update public.tasks set due_on = arg_due where id = t and due_on is distinct from arg_due;
            get diagnostics changed = row_count;
          when 'move_section' then
            select tp.section_id into current_section
            from public.task_projects tp
            where tp.task_id = t and tp.project_id = arg_project and tp.deleted_at is null;
            if not found then
              outcome := 'skipped';
              reason := 'It isn’t in this project';
            elsif current_section is not distinct from arg_section then
              changed := 0;
            else
              update public.task_projects
              set section_id = arg_section,
                  sort_order = coalesce((
                    select max(m.sort_order) from public.task_projects m
                    where m.project_id = arg_project
                      and m.section_id is not distinct from arg_section
                      and m.deleted_at is null
                  ), 0) + 1024
              where task_id = t and project_id = arg_project;
              get diagnostics changed = row_count;
            end if;
          when 'add_to_project' then
            if exists (
              select 1 from public.task_projects tp
              where tp.task_id = t and tp.project_id = arg_project and tp.deleted_at is null
            ) then
              changed := 0;
            else
              insert into public.task_projects (task_id, project_id, section_id, sort_order, deleted_at)
              values (t, arg_project, arg_section, coalesce((
                select max(m.sort_order) from public.task_projects m
                where m.project_id = arg_project
                  and m.section_id is not distinct from arg_section
                  and m.deleted_at is null
              ), 0) + 1024, null)
              on conflict (task_id, project_id) do update
                set deleted_at = null, section_id = excluded.section_id, sort_order = excluded.sort_order;
              get diagnostics changed = row_count;
            end if;
          when 'set_field' then
            if not exists (
              select 1 from public.task_projects tp
              where tp.task_id = t and tp.project_id = arg_project and tp.deleted_at is null
            ) then
              outcome := 'skipped';
              reason := 'It isn’t in the field’s project';
            elsif (arg_value is null or arg_value = 'null'::jsonb) and not exists (
              select 1 from public.task_field_values v
              where v.task_id = t and v.field_id = arg_field and v.value <> 'null'::jsonb
            ) then
              changed := 0;
            else
              insert into public.task_field_values (task_id, field_id, value)
              values (t, arg_field, coalesce(arg_value, 'null'::jsonb))
              on conflict (task_id, field_id) do update
                set value = excluded.value
                where public.task_field_values.value is distinct from excluded.value;
              get diagnostics changed = row_count;
            end if;
        end case;
      exception when others then
        get stacked diagnostics err_state = returned_sqlstate, err_message = message_text,
          err_constraint = constraint_name;
        outcome := 'skipped';
        reason := public.bulk_skip_reason(err_state, err_message, err_constraint);
        -- Blocked by a dependency: another task in this request may be its blocker, so try again
        -- after the rest of the pass.
        if action = 'complete' and err_state = '23514' and err_message like 'This task is blocked by%' then
          outcome := 'retry';
        end if;
      end;

      if outcome = 'retry' then
        retry := retry || t;
        blocked := blocked || jsonb_build_object(t::text, jsonb_build_object('title', task_title, 'reason', reason));
      elsif outcome = 'skipped' then
        skipped := skipped || jsonb_build_object('task_id', t, 'title', task_title, 'reason', reason);
      elsif changed > 0 then
        updated := updated || to_jsonb(t);
        progress := true;
      else
        unchanged := unchanged || to_jsonb(t);
      end if;
    end loop;

    exit when cardinality(retry) = 0;
    if not progress then
      foreach t in array retry loop
        skipped := skipped || jsonb_build_object('task_id', t,
          'title', blocked -> t::text ->> 'title', 'reason', blocked -> t::text ->> 'reason');
      end loop;
      exit;
    end if;
    remaining := retry;
  end loop;

  return jsonb_build_object('updated', updated, 'unchanged', unchanged, 'skipped', skipped);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: invoker RPCs for signed-in members only; helpers stay internal.
-- ---------------------------------------------------------------------------

revoke all on function public.bulk_update_tasks(uuid[], jsonb) from public, anon;
grant execute on function public.bulk_update_tasks(uuid[], jsonb) to authenticated;
revoke all on function public.place_task(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.place_task(uuid, uuid, uuid, uuid) to authenticated;
revoke all on function public.place_section(uuid, uuid) from public, anon;
grant execute on function public.place_section(uuid, uuid) to authenticated;
revoke all on function public.reindex_task_order(uuid, uuid) from public, anon;
grant execute on function public.reindex_task_order(uuid, uuid) to authenticated;
revoke all on function public.reindex_section_order(uuid) from public, anon;
grant execute on function public.reindex_section_order(uuid) to authenticated;
revoke all on function public.bulk_skip_reason(text, text, text) from public, anon;
grant execute on function public.bulk_skip_reason(text, text, text) to authenticated;
revoke all on function public.min_order_gap() from public, anon;
grant execute on function public.min_order_gap() to authenticated;
