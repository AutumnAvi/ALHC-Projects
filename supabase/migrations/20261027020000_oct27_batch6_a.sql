-- ALHC Projects — Oct 27 notes, batch 6.
--
-- 40. Adding a subtask failed with 'column reference "number" is ambiguous' when the project reuses
--     freed numbers (assign_request_number_on_insert; asserted patch). Regression test in suite zz35.
--
-- 39. Each project numbers the tasks it holds: task_project_numbers (one row per task and project; read
--     with the task and the project; written only by numbering triggers; never removed). A task added to
--     a numbering project gets that project's next number (its template, scope, period, counter field);
--     re-adding keeps it. The home project's number stays on tasks.req_* (shown outside projects: My
--     tasks, search, the Inbox, emails, rules) and "Make home" moves the new home's number there.
--     task_request_labels_in (invoker) = the labels inside one project; task_numbers = a task's numbers;
--     search_tasks and a view's search find any of them. Existing multi-homed tasks get their other
--     projects' numbers once (backfill); nothing already issued changes. Converting a subtask to a task
--     numbers it like a new task (its subtasks' paths follow); a task made a subtask keeps its number.
--
-- 41. List / My tasks rows remember which ones a person expanded: profile_preferences.expanded_task_ids
--     (own row; set_task_row_expanded, invoker).
--
-- 42. subtask_parent_candidates (invoker): the "Make a subtask of…" picker.
--
-- 43. Blocked = any link that holds up completion: project_task_cards / project_schedule_cards count
--     every such kind (asserted patches); task_open_blockers / open_blocker_counts (invoker) list them.
--
-- 44. projects.dependency_shift = auto | ask (default) | off, Admin+ like the project's other settings;
--     dependency_shift_mode(tasks) picks the mode for a change.
--
-- 45 / 45b. Approval tasks: approvers separate from the assignee (task_approvers), Any one / Everyone
--     and an approval due date (task_approval_settings), rounds sent with "Ready for approval"
--     (approval_rounds; approval_requests.round_id), Request changes needs a note, Withdraw, Feedback /
--     Rejection received, Hand off, Owners / Admins reassign, More steps after approval (move to a
--     section or just notify), reminders the day before and once overdue (from workflow_tick), the
--     view filter `approval` incl. waiting_on_me. Only Approve without More steps completes the task.
--     Five new client SECURITY DEFINER functions (pinned in suite 60): set_task_approvers,
--     send_for_approval, withdraw_approval, acknowledge_approval, hand_off_approval. Nothing new for anon.
--
-- No row-removal or object-removal keywords anywhere in this file (the hosted connector refuses them).
-- Additive: no tail.

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

-- ---------------------------------------------------------------------------------------------------
-- 40. Adding a subtask failed with 'column reference "number" is ambiguous' in projects that reuse
--     freed numbers: the subtask branch of assign_request_number_on_insert() orders the open gaps by
--     `number`, which is both request_number_gaps.number and the function's own `number` variable.
--     Qualify the column (the top-level branch already goes through allocate_request_number, which does).
-- ---------------------------------------------------------------------------------------------------

select public.alhc_patch_function(
  'public.assign_request_number_on_insert()'::regprocedure,
  $old$        select id from public.request_number_gaps
        where project_id = seq.project_id
          and counter_key = 'sub:' || new.parent_task_id::text
          and consumed_at is null and deleted_at is null
        order by number
        limit 1$old$,
  $new$        select open_gap.id from public.request_number_gaps open_gap
        where open_gap.project_id = seq.project_id
          and open_gap.counter_key = 'sub:' || new.parent_task_id::text
          and open_gap.consumed_at is null and open_gap.deleted_at is null
        order by open_gap.number
        limit 1$new$
);

-- ---------------------------------------------------------------------------------------------------
-- 39. Each project numbers the tasks it holds.
--
--     task_project_numbers keeps every number a task has, one row per (task, project): the number its
--     home project issued (mirrored from tasks.req_* by tasks_25_mirror_number) and the number every
--     other numbering project gives it when it's added there (task_projects_16_project_number, using that
--     project's template, scope, reset period, and counter field). A number is never taken back: removing
--     the task from a project, re-adding it, trashing it, or converting it keeps the row.
--
--     Inside a project the app shows that project's number (task_request_labels_in); outside projects
--     (My tasks, Home, search, the Inbox, emails, rules, webhooks) the home project's number, which stays
--     on tasks.req_* — "Make home" moves the new home project's number there (tasks_19_number_shape) and
--     keeps the old one in its project's row. search_tasks and a view's search find any of the numbers.
--     Existing multi-homed tasks get their other projects' numbers once, below (nothing is renumbered).
-- ---------------------------------------------------------------------------------------------------

do $do$
begin
  execute $sql$
    create table public.task_project_numbers (
      id uuid primary key default gen_random_uuid(),
      task_id uuid not null references public.tasks (id),
      project_id uuid not null references public.projects (id),
      req_number bigint not null constraint task_project_numbers_number_check check (req_number > 0),
      req_period text not null default '',
      req_counter_key text not null default '',
      req_label text constraint task_project_numbers_label_check check (char_length(req_label) <= 300),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint task_project_numbers_key unique (task_id, project_id)
    )
  $sql$;
  execute 'alter table public.task_project_numbers enable row level security';
  execute 'revoke all on public.task_project_numbers from anon, authenticated';
end;
$do$;

create index task_project_numbers_project_idx on public.task_project_numbers (project_id, req_number);

-- A task's number in a project shows with the task and the project: the reader needs both.
create policy task_project_numbers_select_viewer on public.task_project_numbers
  for select to authenticated
  using (
    (select public.has_project_role(project_id, 'viewer'))
    and (select public.has_task_role(task_id, 'viewer'))
  );

grant select on public.task_project_numbers to authenticated;

select public.alhc_revoke_anon_grants(array['task_project_numbers']);
select public.alhc_revoke_client_truncate(array['task_project_numbers']);

comment on table public.task_project_numbers is
  'Task numbering: every number a task has, one row per project (the home project''s mirrors tasks.req_*). '
  'Written only by numbering triggers; never removed.';

-- Is the task in this sequence's scope? (request_number_in_scope, with the section and counter field of
-- the sequence's own project instead of the home project.)
create or replace function public.project_number_in_scope(target_task uuid, seq public.request_sequences)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  t public.tasks;
  scope text;
  sec uuid;
begin
  select * into t from public.tasks where id = target_task;
  if not found or t.parent_task_id is not null then
    return false;
  end if;
  scope := case when seq.number_scope = 'inherit' then seq.assign_to else seq.number_scope end;
  if scope = 'form_submissions' and t.source is distinct from 'form' then
    return false;
  end if;
  if scope = 'kinds' and not (t.kind = any (seq.task_kinds)) then
    return false;
  end if;
  if scope = 'sections' then
    select tp.section_id into sec
    from public.task_projects tp
    where tp.task_id = t.id and tp.project_id = seq.project_id and tp.deleted_at is null
    limit 1;
    if sec is null or not (sec = any (seq.section_ids)) then
      return false;
    end if;
  end if;
  if seq.counter_field_id is not null and not exists (
    select 1 from public.task_field_values v
    where v.task_id = t.id and v.field_id = seq.counter_field_id and v.value is not null
      and v.value <> 'null'::jsonb
  ) then
    return false;
  end if;
  return scope in ('all_tasks', 'form_submissions', 'sections', 'kinds');
end;
$$;

revoke all on function public.project_number_in_scope(uuid, public.request_sequences) from public, anon, authenticated;

-- The label of a task's number in one project (compose_request_label for a task_project_numbers row).
create or replace function public.compose_project_number_label(target_task uuid, target_project uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  n public.task_project_numbers;
  s public.request_sequences;
  tpl text;
  fname text;
  val text;
  field_type text;
  options jsonb;
  raw jsonb;
begin
  select * into n from public.task_project_numbers where task_id = target_task and project_id = target_project;
  if not found then
    return null;
  end if;
  select * into s from public.request_sequences where project_id = target_project and deleted_at is null;
  if not found then
    return null;
  end if;
  tpl := s.template;
  while tpl ~ '\{field:[^}]+\}' loop
    fname := btrim(substring(tpl from '\{field:([^}]+)\}'));
    val := '';
    field_type := null;
    raw := null;
    select cf.field_type, cf.options, v.value
      into field_type, options, raw
    from public.custom_fields cf
    left join public.task_field_values v on v.field_id = cf.id and v.task_id = target_task
    where cf.deleted_at is null
      and lower(btrim(cf.name)) = lower(fname)
      and cf.project_id = target_project
    limit 1;
    if field_type = 'single_select' then
      select o ->> 'name' into val
      from jsonb_array_elements(coalesce(options, '[]'::jsonb)) o
      where o ->> 'id' = raw #>> '{}'
      limit 1;
    elsif field_type = 'multi_select' then
      select o ->> 'name' into val
      from jsonb_array_elements(coalesce(options, '[]'::jsonb)) o
      where raw @> jsonb_build_array(o ->> 'id')
      limit 1;
    else
      val := raw #>> '{}';
    end if;
    tpl := regexp_replace(tpl, '\{field:[^}]+\}', coalesce(val, ''), '');
  end loop;
  return public.render_request_template(tpl, n.req_number::text, n.created_at, s.time_zone, s.project_code, null, null);
end;
$$;

revoke all on function public.compose_project_number_label(uuid, uuid) from public, anon, authenticated;

-- Gives a top-level task its number in one of its other projects (not its home project, which numbers it
-- on tasks.req_*), when that project numbers tasks and the task is in its scope. A task that already has
-- a number there keeps it. Returns the label (null when there is none).
create or replace function public.ensure_project_number(target_task uuid, target_project uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tasks;
  seq public.request_sequences;
  existing public.task_project_numbers;
  period text;
  ckey text := '';
  n bigint;
  label text;
begin
  select * into existing from public.task_project_numbers where task_id = target_task and project_id = target_project;
  if found then
    return existing.req_label;
  end if;
  select * into t from public.tasks where id = target_task and deleted_at is null;
  if not found or t.parent_task_id is not null
     or target_project is not distinct from t.home_project_id
     or target_project is not distinct from t.req_project_id then
    return null;
  end if;
  if not exists (
    select 1 from public.task_projects tp
    where tp.task_id = target_task and tp.project_id = target_project and tp.deleted_at is null
  ) then
    return null;
  end if;
  select * into seq from public.request_sequences
  where project_id = target_project and enabled and deleted_at is null
  for update;
  if not found or not public.project_number_in_scope(target_task, seq) then
    return null;
  end if;
  -- The row lock above serializes numbering in this project; re-check after waiting for it.
  if exists (select 1 from public.task_project_numbers where task_id = target_task and project_id = target_project) then
    return (select req_label from public.task_project_numbers where task_id = target_task and project_id = target_project);
  end if;
  period := public.request_number_period(now(), seq.reset_period, seq.time_zone);
  if seq.counter_field_id is not null then
    select coalesce(v.value #>> '{}', '') into ckey
    from public.task_field_values v
    where v.task_id = target_task and v.field_id = seq.counter_field_id;
    ckey := coalesce(ckey, '');
  end if;
  n := public.allocate_request_number(target_project, period, ckey);
  if n is null then
    return null;
  end if;
  insert into public.task_project_numbers (task_id, project_id, req_number, req_period, req_counter_key)
  values (target_task, target_project, n, period, ckey);
  label := public.compose_project_number_label(target_task, target_project);
  update public.task_project_numbers
  set req_label = label, updated_at = now()
  where task_id = target_task and project_id = target_project;
  return label;
end;
$$;

revoke all on function public.ensure_project_number(uuid, uuid) from public, anon, authenticated;

create or replace function public.ensure_project_numbers(target_task uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m record;
begin
  for m in
    select tp.project_id from public.task_projects tp
    where tp.task_id = target_task and tp.deleted_at is null
    order by tp.created_at, tp.project_id
  loop
    perform public.ensure_project_number(target_task, m.project_id);
  end loop;
end;
$$;

revoke all on function public.ensure_project_numbers(uuid) from public, anon, authenticated;

-- task_projects (added, re-added, moved to a numbered section), task_field_values (a counter field's
-- value), tasks (kind): each may bring a task into another project's scope.
create or replace function public.number_task_in_projects()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'task_projects' then
    if new.deleted_at is null then
      perform public.ensure_project_number(new.task_id, new.project_id);
    end if;
  elsif tg_table_name = 'task_field_values' then
    perform public.ensure_project_number(new.task_id, f.project_id)
    from public.custom_fields f
    where f.id = new.field_id;
  else
    perform public.ensure_project_numbers(new.id);
  end if;
  return null;
end;
$$;

revoke all on function public.number_task_in_projects() from public, anon, authenticated;

create trigger task_projects_16_project_number
  after insert or update of section_id, deleted_at on public.task_projects
  for each row execute function public.number_task_in_projects();

create trigger task_field_values_16_project_number
  after insert or update of value on public.task_field_values
  for each row execute function public.number_task_in_projects();

create trigger tasks_26_project_number_kind
  after update of kind on public.tasks
  for each row when (old.kind is distinct from new.kind and new.parent_task_id is null)
  execute function public.number_task_in_projects();

-- The number on tasks.req_* (the home project's, or the one the task kept when it moved) is also its
-- number in that project.
create or replace function public.mirror_task_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.parent_task_id is not null or new.req_number is null or new.req_project_id is null then
    return null;
  end if;
  insert into public.task_project_numbers
    (task_id, project_id, req_number, req_period, req_counter_key, req_label, created_at)
  values (new.id, new.req_project_id, new.req_number, new.req_period, new.req_counter_key, new.req_label, new.created_at)
  on conflict on constraint task_project_numbers_key do update
  set req_number = excluded.req_number,
      req_period = excluded.req_period,
      req_counter_key = excluded.req_counter_key,
      req_label = excluded.req_label,
      updated_at = now()
  where (public.task_project_numbers.req_number, public.task_project_numbers.req_period,
         public.task_project_numbers.req_counter_key, public.task_project_numbers.req_label)
        is distinct from (excluded.req_number, excluded.req_period, excluded.req_counter_key, excluded.req_label);
  return null;
end;
$$;

revoke all on function public.mirror_task_number() from public, anon, authenticated;

create trigger tasks_25_mirror_number
  after insert or update of req_project_id, req_number, req_period, req_counter_key, req_label on public.tasks
  for each row execute function public.mirror_task_number();

-- Before a task's row changes shape:
--   * "Make home": when the new home project already gave the task a number, that number becomes the one
--     on tasks.req_* (shown outside projects); the old one stays in its project's row.
--   * A subtask that becomes a task drops its subtask index and path (they described its old parent); its
--     new project numbers it like any new task. A task that becomes a subtask keeps its number.
create or replace function public.shape_task_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  n public.task_project_numbers;
begin
  if old.parent_task_id is not null and new.parent_task_id is null then
    new.req_subindex := null;
    new.req_path := case when new.req_number is not null then new.req_number::text end;
    if new.req_number is null then
      new.req_label := null;
    end if;
  end if;
  if new.parent_task_id is null
     and new.home_project_id is not null
     and new.home_project_id is distinct from old.home_project_id
     and new.req_project_id is distinct from new.home_project_id then
    select * into n from public.task_project_numbers
    where task_id = new.id and project_id = new.home_project_id;
    if found then
      new.req_project_id := n.project_id;
      new.req_number := n.req_number;
      new.req_period := n.req_period;
      new.req_counter_key := n.req_counter_key;
      new.req_path := n.req_number::text;
      new.req_label := n.req_label;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.shape_task_number() from public, anon, authenticated;

create trigger tasks_19_number_shape
  before update of parent_task_id, home_project_id on public.tasks
  for each row execute function public.shape_task_number();

-- A task's path or label changed (it was numbered, converted, or took its new home's number): its
-- subtasks' paths and labels follow, level by level (each child's own update cascades to its children).
create or replace function public.renumber_task_children()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.tasks c
  set req_path = case when new.req_path is null then null else new.req_path || coalesce(s.subtask_separator, '.') || c.req_subindex::text end
  from public.tasks x
  left join public.request_sequences s
    on s.project_id = coalesce(x.req_project_id, x.home_project_id) and s.deleted_at is null
  where x.id = c.id
    and c.parent_task_id = new.id
    and c.req_subindex is not null
    and c.deleted_at is null
    and c.req_path is distinct from (
      case when new.req_path is null then null else new.req_path || coalesce(s.subtask_separator, '.') || c.req_subindex::text end
    );
  update public.tasks c
  set req_label = public.compose_request_label(c.id)
  where c.parent_task_id = new.id
    and c.req_subindex is not null
    and c.deleted_at is null
    and c.req_label is distinct from public.compose_request_label(c.id);
  return null;
end;
$$;

revoke all on function public.renumber_task_children() from public, anon, authenticated;

create trigger tasks_zz_number_children
  after update of req_path, req_label on public.tasks
  for each row
  when (old.req_path is distinct from new.req_path or old.req_label is distinct from new.req_label)
  execute function public.renumber_task_children();

-- maybe_renumber_on_move: when "Make home" already moved the new home's number onto the task, there is
-- nothing to renumber.
select public.alhc_patch_function(
  'public.maybe_renumber_on_move()'::regprocedure,
  $old$  if old.req_project_id is not distinct from new.home_project_id then$old$,
  $new$  if old.req_project_id is not distinct from new.home_project_id
     or new.req_project_id is not distinct from new.home_project_id then$new$
);

-- Number every task of a project that has no number there yet (other projects' tasks too), or renumber
-- them all after the project's own tasks. Called by number_project_tasks (Number existing tasks / Renumber).
create or replace function public.number_project_memberships(target_project uuid, renumber boolean)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  seq public.request_sequences;
  r record;
  n bigint;
  numbered integer := 0;
begin
  select * into seq from public.request_sequences
  where project_id = target_project and enabled and deleted_at is null;
  if not found then
    return 0;
  end if;
  if renumber then
    for r in
      select x.task_id, x.req_period, x.req_counter_key
      from public.task_project_numbers x
      join public.tasks t on t.id = x.task_id
      join public.task_projects tp on tp.task_id = t.id and tp.project_id = target_project and tp.deleted_at is null
      where x.project_id = target_project
        and t.deleted_at is null
        and t.parent_task_id is null
        and t.req_project_id is distinct from target_project
      order by tp.created_at, x.task_id
    loop
      n := public.allocate_request_number(target_project, r.req_period, r.req_counter_key);
      if n is not null then
        update public.task_project_numbers
        set req_number = n, updated_at = now()
        where task_id = r.task_id and project_id = target_project;
        update public.task_project_numbers
        set req_label = public.compose_project_number_label(r.task_id, target_project)
        where task_id = r.task_id and project_id = target_project;
        numbered := numbered + 1;
      end if;
    end loop;
  end if;
  for r in
    select tp.task_id
    from public.task_projects tp
    join public.tasks t on t.id = tp.task_id
    where tp.project_id = target_project
      and tp.deleted_at is null
      and t.deleted_at is null
      and t.parent_task_id is null
      and t.home_project_id is distinct from target_project
      and t.req_project_id is distinct from target_project
      and not exists (
        select 1 from public.task_project_numbers x where x.task_id = t.id and x.project_id = target_project
      )
    order by tp.created_at, tp.task_id
  loop
    if public.ensure_project_number(r.task_id, target_project) is not null then
      numbered := numbered + 1;
    end if;
  end loop;
  return numbered;
end;
$$;

revoke all on function public.number_project_memberships(uuid, boolean) from public, anon, authenticated;

select public.alhc_patch_function(
  'public.number_project_tasks(uuid,boolean)'::regprocedure,
  $old$  return numbered;
end;$old$,
  $new$  numbered := numbered + public.number_project_memberships(target_project, renumber);
  return numbered;
end;$new$
);

-- Saving the numbering settings re-renders the labels of other projects' tasks too.
select public.alhc_patch_function(
  'public.apply_task_numbering(uuid,jsonb,text)'::regprocedure,
  $old$    numbered := 0;
  end if;$old$,
  $new$    update public.task_project_numbers x
    set req_label = public.compose_project_number_label(x.task_id, x.project_id), updated_at = now()
    from public.tasks t
    where x.project_id = target_project
      and t.id = x.task_id
      and t.deleted_at is null
      and t.req_project_id is distinct from target_project
      and x.req_label is distinct from public.compose_project_number_label(x.task_id, x.project_id);
    numbered := 0;
  end if;$new$
);

-- The labels the app shows inside one project: { "<task id>": { "label", "wrap" } }. When the project
-- numbers tasks: its own numbers (top-level tasks), and its numbers for their subtasks (the parent's
-- number in this project, then the subtask's indexes). When it doesn't: each task's home-project label,
-- as before (task_request_labels). Invoker: RLS decides what the caller reads.
create or replace function public.task_request_labels_in(target_project uuid, task_ids uuid[])
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  seq public.request_sequences;
  own jsonb;
  subs jsonb := '{}'::jsonb;
begin
  select * into seq from public.request_sequences
  where project_id = target_project and enabled and deleted_at is null;
  if not found then
    return public.task_request_labels(task_ids);
  end if;
  select coalesce(jsonb_object_agg(x.task_id, jsonb_build_object('label', x.req_label, 'wrap', seq.wrap_brackets)), '{}'::jsonb)
  into own
  from public.task_project_numbers x
  join public.tasks t on t.id = x.task_id
  where x.project_id = target_project
    and x.task_id = any (task_ids[1:5000])
    and t.parent_task_id is null
    and x.req_label is not null;
  if seq.number_subtasks then
    select coalesce(jsonb_object_agg(s.id, jsonb_build_object(
      'label',
      case
        when r.req_project_id = target_project then s.req_label
        else public.render_request_template(
          regexp_replace(seq.template, '\{field:[^}]+\}', '', 'g'),
          x.req_number::text || replace(substr(s.req_path, char_length(r.req_path) + 1), rs.subtask_separator, seq.subtask_separator),
          s.created_at, seq.time_zone, seq.project_code, null, null
        )
      end,
      'wrap', seq.wrap_brackets
    )), '{}'::jsonb)
    into subs
    from public.tasks s
    join public.tasks r on r.id = s.root_task_id
    join public.task_project_numbers x on x.task_id = r.id and x.project_id = target_project
    join public.request_sequences rs on rs.project_id = coalesce(r.req_project_id, r.home_project_id) and rs.deleted_at is null
    where s.id = any (task_ids[1:5000])
      and s.parent_task_id is not null
      and s.deleted_at is null
      and s.req_subindex is not null
      and s.req_path is not null
      and r.req_path is not null
      and left(s.req_path, char_length(r.req_path) + 1) = r.req_path || rs.subtask_separator;
  end if;
  return own || subs;
end;
$$;

revoke all on function public.task_request_labels_in(uuid, uuid[]) from public, anon;
grant execute on function public.task_request_labels_in(uuid, uuid[]) to authenticated;

-- Every number a task has in projects the caller can read (the pane's Projects row).
create or replace function public.task_numbers(target_task uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(x.project_id, jsonb_build_object('label', x.req_label, 'wrap', s.wrap_brackets)), '{}'::jsonb)
  from public.task_project_numbers x
  join public.request_sequences s on s.project_id = x.project_id and s.deleted_at is null and s.enabled
  where x.task_id = target_task and x.req_label is not null;
$$;

revoke all on function public.task_numbers(uuid) from public, anon;
grant execute on function public.task_numbers(uuid) to authenticated;

-- Search finds a task by any of its numbers (RLS on task_project_numbers: projects the caller reads).
select public.alhc_patch_function(
  'public.search_tasks(text,integer)'::regprocedure,
  $old$      or coalesce(t.req_label, '') ilike pattern.value
      or ($old$,
  $new$      or coalesce(t.req_label, '') ilike pattern.value
      or exists (
        select 1 from public.task_project_numbers x
        where x.task_id = t.id
          and (
            coalesce(x.req_label, '') ilike pattern.value
            or x.req_number::text = ltrim(coalesce(public.request_number_query(trim(query)), '-'), '0')
          )
      )
      or ($new$
);

-- A view's search box finds the project's own number too.
select public.alhc_patch_function(
  'public.filter_project_tasks(uuid,jsonb,text)'::regprocedure,
  $old$      or coalesce(t.req_label, '') ilike pattern.value
      or ($old$,
  $new$      or coalesce(t.req_label, '') ilike pattern.value
      or exists (
        select 1 from public.task_project_numbers x
        where x.task_id = t.id
          and x.project_id = target_project
          and (
            coalesce(x.req_label, '') ilike pattern.value
            or x.req_number::text = ltrim(coalesce(public.request_number_query(p.needle), '-'), '0')
          )
      )
      or ($new$
);

-- Backfill: every issued number in its project's row, then the other projects' numbers of tasks already
-- in several projects (in the order they were added; nothing already issued changes).
insert into public.task_project_numbers (task_id, project_id, req_number, req_period, req_counter_key, req_label, created_at)
select t.id, t.req_project_id, t.req_number, t.req_period, t.req_counter_key, t.req_label, t.created_at
from public.tasks t
where t.parent_task_id is null
  and t.req_number is not null
  and t.req_project_id is not null
on conflict on constraint task_project_numbers_key do nothing;

do $$
declare
  r record;
begin
  for r in
    select tp.task_id, tp.project_id
    from public.task_projects tp
    join public.tasks t on t.id = tp.task_id
    join public.projects p on p.id = tp.project_id and p.deleted_at is null
    join public.request_sequences s on s.project_id = tp.project_id and s.enabled and s.deleted_at is null
    where tp.deleted_at is null
      and t.deleted_at is null
      and t.parent_task_id is null
      and tp.project_id is distinct from t.home_project_id
      and tp.project_id is distinct from t.req_project_id
    order by tp.created_at, tp.task_id
  loop
    perform public.ensure_project_number(r.task_id, r.project_id);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------------------------------
-- 41. Expandable subtasks on List and My tasks rows: which rows a person opened is remembered for them
--     (profile_preferences.expanded_task_ids, own row; set_task_row_expanded, invoker; newest 500 kept).
-- ---------------------------------------------------------------------------------------------------

alter table public.profile_preferences
  add column expanded_task_ids uuid[] not null default '{}'
    constraint profile_preferences_expanded_task_ids_check check (cardinality(expanded_task_ids) <= 500);

grant insert (expanded_task_ids), update (expanded_task_ids) on public.profile_preferences to authenticated;

create or replace function public.set_task_row_expanded(target_task uuid, expanded boolean)
returns uuid[]
language plpgsql
set search_path = ''
as $$
declare
  ids uuid[];
begin
  if auth.uid() is null or not public.is_allowlisted() then
    raise exception 'Sign in to change your settings' using errcode = 'insufficient_privilege';
  end if;
  if target_task is null then
    raise exception 'Choose a task' using errcode = 'check_violation';
  end if;
  insert into public.profile_preferences as x (expanded_task_ids)
  values (case when expanded then array[target_task] else '{}'::uuid[] end)
  on conflict (profile_id) do update set
    expanded_task_ids = case
      when expanded then (array[target_task] || array_remove(x.expanded_task_ids, target_task))[1:500]
      else array_remove(x.expanded_task_ids, target_task)
    end
  returning expanded_task_ids into ids;
  return ids;
end;
$$;

revoke all on function public.set_task_row_expanded(uuid, boolean) from public, anon;
grant execute on function public.set_task_row_expanded(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- 42. "Make a subtask of…": tasks the caller can edit that this task can go under (the searchable
--     picker). Invoker; convert_to_subtask still checks everything. A blank search lists open tasks of the
--     task's own projects.
-- ---------------------------------------------------------------------------------------------------

create or replace function public.subtask_parent_candidates(target_task uuid, query text, max_results integer default 30)
returns table (id uuid, title text, parent_task_id uuid, home_project_id uuid, completed_at timestamptz)
language sql
stable
set search_path = ''
as $$
  with found as (
    select s.id
    from public.search_tasks(query, 100) s
    where length(btrim(coalesce(query, ''))) > 0
    union
    select t.id
    from public.task_projects mine
    join public.task_projects tp on tp.project_id = mine.project_id and tp.deleted_at is null
    join public.tasks t on t.id = tp.task_id and t.deleted_at is null and t.completed_at is null
    where length(btrim(coalesce(query, ''))) = 0
      and mine.task_id = target_task
      and mine.deleted_at is null
  )
  select t.id, t.title, t.parent_task_id, coalesce(r.home_project_id, t.home_project_id), t.completed_at
  from found f
  join public.tasks t on t.id = f.id and t.deleted_at is null
  left join public.tasks r on r.id = t.root_task_id
  where t.id <> target_task
    and t.root_task_id is distinct from target_task
    and public.has_task_role(t.id, 'editor')
  order by t.completed_at is not null, t.updated_at desc
  limit least(greatest(coalesce(max_results, 30), 1), 100);
$$;

revoke all on function public.subtask_parent_candidates(uuid, text, integer) from public, anon;
grant execute on function public.subtask_parent_candidates(uuid, text, integer) to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- 43. Blocked tasks: the List / Board card count is every link that holds up completing the task (what
--     the completion guard checks), not only finish-to-start; task_open_blockers lists the open blockers
--     the caller can read plus the total (the hover card on the locked checkbox). dependency_satisfied and
--     task_has_started are plain functions of the row they're given; the invoker list needs them.
-- ---------------------------------------------------------------------------------------------------

grant execute on function public.dependency_satisfied(text, public.tasks) to authenticated;
grant execute on function public.task_has_started(public.tasks) to authenticated;

select public.alhc_patch_function(
  'public.project_task_cards(uuid,uuid[])'::regprocedure,
  $old$      and d.kind = 'finish_to_start'
      and pred.deleted_at is null
      and pred.completed_at is null$old$,
  $new$      and d.kind <> 'start_to_start'
      and pred.deleted_at is null
      and not public.dependency_satisfied(d.kind, pred)$new$
);

select public.alhc_patch_function(
  'public.project_schedule_cards(uuid,jsonb,text,date,date,text)'::regprocedure,
  $old$      and d.kind = 'finish_to_start'
      and pred.deleted_at is null
      and pred.completed_at is null$old$,
  $new$      and d.kind <> 'start_to_start'
      and pred.deleted_at is null
      and not public.dependency_satisfied(d.kind, pred)$new$
);

create or replace function public.task_open_blockers(target_task uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'total', public.open_blocker_count(target_task),
    'blockers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'title', p.title, 'kind', d.kind, 'due_on', p.due_on, 'start_on', p.start_on,
        'parent_task_id', p.parent_task_id, 'home_project_id', coalesce(r.home_project_id, p.home_project_id)
      ) order by p.due_on nulls last, p.title)
      from public.task_dependencies d
      join public.tasks p on p.id = d.predecessor_id
      left join public.tasks r on r.id = p.root_task_id
      where d.successor_id = target_task
        and d.kind <> 'start_to_start'
        and d.deleted_at is null
        and p.deleted_at is null
        and not public.dependency_satisfied(d.kind, p)
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.task_open_blockers(uuid) from public, anon;
grant execute on function public.task_open_blockers(uuid) to authenticated;

-- Open-blocker counts for many tasks at once (My tasks rows): the completion guard's count, hidden
-- blockers included (a number only).
create or replace function public.open_blocker_counts(task_ids uuid[])
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(x.id, x.n) filter (where x.n > 0), '{}'::jsonb)
  from (
    select t.id, public.open_blocker_count(t.id) as n
    from public.tasks t
    where t.id = any (task_ids[1:2000]) and t.deleted_at is null and t.completed_at is null
  ) x;
$$;

revoke all on function public.open_blocker_counts(uuid[]) from public, anon;
grant execute on function public.open_blocker_counts(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- 44. Dependency date shifting, per project: projects.dependency_shift = auto (shift dependents both
--     ways, no prompt) | ask (default: show what would move, both ways) | off (never shift). Written like
--     the rest of the project's settings (projects_update_admin). dependency_shift_mode(tasks) is the mode
--     for a change: each task's home project (a subtask: its top-level task's); Ask me wins over the
--     others, Off only when every task's project is Off. Private tasks ask.
-- ---------------------------------------------------------------------------------------------------

alter table public.projects
  add column dependency_shift text not null default 'ask'
    constraint projects_dependency_shift_check check (dependency_shift in ('auto', 'ask', 'off'));

create or replace function public.dependency_shift_mode(task_ids uuid[])
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when count(*) = 0 then 'ask'
    when bool_or(x.mode = 'ask') then 'ask'
    when bool_and(x.mode = 'off') then 'off'
    else 'auto'
  end
  from (
    select coalesce(p.dependency_shift, 'ask') as mode
    from public.tasks t
    left join public.tasks r on r.id = t.root_task_id
    left join public.projects p on p.id = coalesce(r.home_project_id, t.home_project_id)
    where t.id = any (task_ids[1:200])
  ) x;
$$;

revoke all on function public.dependency_shift_mode(uuid[]) from public, anon;
grant execute on function public.dependency_shift_mode(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- 45 / 45b. Approval tasks.
--
--   * Assignee and Approver are separate. task_approvers (one active row per person; Commenter+ on the
--     task) and task_approval_settings (any | all, an approval due date). Only approvers decide.
--   * A round (approval_rounds) starts when the assignee (or an Editor) sends it with "Ready for approval":
--     the final text and/or files (at least one), and what happens on approval — complete the task
--     (default), or "More steps after approval": move it to a section, or just notify. One
--     approval_requests row per approver (round_id), so the Inbox, stories, and rules work as before.
--   * Statuses: Not sent, Pending, Changes requested, Rejected, Approved; after Request changes or Reject
--     the task is paused until the assignee marks the feedback received. Any approver's Request changes /
--     Reject ends the round; "Any one can approve" ends it on the first Approve, "Everyone must approve"
--     when every approver has approved. Only an Approve (without More steps) completes the task — a
--     Reject no longer does, and neither does an approval for its own sake.
--   * Withdraw (the assignee pulls back a pending round), Hand off (an approver passes their decision on,
--     with a note), Reassign (project Owners / Admins change approvers anytime).
--   * Reminders: the day before the approval due date and once overdue, each approver still deciding gets
--     an Inbox nudge (approval_reminders_tick, from workflow_tick).
--   * Story and Inbox kinds are pinned by CHECKs, so the new events reuse the approval kinds with a
--     discriminator in data (event / reason / reminder).
--   Existing approval tasks: their approver is the approver of their latest request, and that request
--   becomes round 1.
-- ---------------------------------------------------------------------------------------------------

do $do$
begin
  execute $sql$
    create table public.task_approvers (
      id uuid primary key default gen_random_uuid(),
      task_id uuid not null references public.tasks (id),
      profile_id uuid not null references public.profiles (id),
      added_by uuid references public.profiles (id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted_at timestamptz
    )
  $sql$;
  execute 'alter table public.task_approvers enable row level security';
  execute 'revoke all on public.task_approvers from anon, authenticated';
  execute $sql$
    create table public.task_approval_settings (
      task_id uuid primary key references public.tasks (id),
      mode text not null default 'any' constraint task_approval_settings_mode_check check (mode in ('any', 'all')),
      due_on date,
      updated_by uuid references public.profiles (id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  $sql$;
  execute 'alter table public.task_approval_settings enable row level security';
  execute 'revoke all on public.task_approval_settings from anon, authenticated';
  execute $sql$
    create table public.approval_rounds (
      id uuid primary key default gen_random_uuid(),
      task_id uuid not null references public.tasks (id),
      round_number integer not null constraint approval_rounds_number_check check (round_number > 0),
      status text not null default 'pending'
        constraint approval_rounds_status_check
        check (status in ('pending', 'approved', 'changes_requested', 'rejected', 'withdrawn')),
      mode text not null default 'any' constraint approval_rounds_mode_check check (mode in ('any', 'all')),
      final_text text constraint approval_rounds_final_text_check check (char_length(final_text) <= 10000),
      attachment_ids uuid[] not null default '{}'
        constraint approval_rounds_attachments_check check (cardinality(attachment_ids) <= 50),
      more_steps boolean not null default false,
      after_approval text not null default 'complete'
        constraint approval_rounds_after_check check (after_approval in ('complete', 'move_section', 'notify')),
      move_section_id uuid references public.sections (id),
      due_on date,
      sent_by uuid references public.profiles (id),
      sent_at timestamptz not null default now(),
      decided_by uuid references public.profiles (id),
      decided_at timestamptz,
      acknowledged_by uuid references public.profiles (id),
      acknowledged_at timestamptz,
      withdrawn_by uuid references public.profiles (id),
      withdrawn_at timestamptz,
      reminded_soon_at timestamptz,
      reminded_overdue_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint approval_rounds_task_number_key unique (task_id, round_number),
      constraint approval_rounds_after_section_check
        check (after_approval <> 'move_section' or move_section_id is not null)
    )
  $sql$;
  execute 'alter table public.approval_rounds enable row level security';
  execute 'revoke all on public.approval_rounds from anon, authenticated';
end;
$do$;

create unique index task_approvers_active_idx on public.task_approvers (task_id, profile_id) where deleted_at is null;
create index task_approvers_profile_idx on public.task_approvers (profile_id);
create index task_approvers_added_by_idx on public.task_approvers (added_by);
create index task_approval_settings_updated_by_idx on public.task_approval_settings (updated_by);
create index approval_rounds_section_idx on public.approval_rounds (move_section_id);
create index approval_rounds_sent_by_idx on public.approval_rounds (sent_by);
create index approval_rounds_decided_by_idx on public.approval_rounds (decided_by);
create index approval_rounds_acknowledged_by_idx on public.approval_rounds (acknowledged_by);
create index approval_rounds_withdrawn_by_idx on public.approval_rounds (withdrawn_by);
create index approval_rounds_pending_due_idx on public.approval_rounds (due_on) where status = 'pending';

create policy task_approvers_select_viewer on public.task_approvers
  for select to authenticated using ((select public.has_task_role(task_id, 'viewer')));
create policy task_approval_settings_select_viewer on public.task_approval_settings
  for select to authenticated using ((select public.has_task_role(task_id, 'viewer')));
create policy approval_rounds_select_viewer on public.approval_rounds
  for select to authenticated using ((select public.has_task_role(task_id, 'viewer')));

grant select on public.task_approvers, public.task_approval_settings, public.approval_rounds to authenticated;

select public.alhc_revoke_anon_grants(array['task_approvers', 'task_approval_settings', 'approval_rounds']);
select public.alhc_revoke_client_truncate(array['task_approvers', 'task_approval_settings', 'approval_rounds']);

alter table public.approval_requests
  add column round_id uuid references public.approval_rounds (id),
  add column cancel_reason text
    constraint approval_requests_cancel_reason_check
    check (cancel_reason is null or cancel_reason in ('withdrawn', 'handed_off', 'reassigned', 'round_closed', 'kind_changed')),
  add column handoff_to uuid references public.profiles (id),
  add column handoff_note text constraint approval_requests_handoff_note_check check (char_length(handoff_note) <= 2000);

create index approval_requests_round_idx on public.approval_requests (round_id);
create index approval_requests_handoff_to_idx on public.approval_requests (handoff_to);

-- Approval status of a task for the caller: { status: not_sent | pending | changes_requested | rejected |
-- approved, paused, waiting_on_me, round_id, round_number }.
create or replace function public.task_approval_state(target_task uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'status', case when r.id is null or r.status = 'withdrawn' then 'not_sent' else r.status end,
    'paused', coalesce(r.status in ('changes_requested', 'rejected') and r.acknowledged_at is null, false),
    'waiting_on_me', coalesce(r.status = 'pending' and exists (
      select 1 from public.approval_requests q
      where q.round_id = r.id and q.status = 'pending' and q.approver_id = (select auth.uid()) and q.deleted_at is null
    ), false),
    'round_id', r.id,
    'round_number', r.round_number
  )
  from (select 1) one
  left join lateral (
    select x.* from public.approval_rounds x where x.task_id = target_task order by x.round_number desc limit 1
  ) r on true;
$$;

revoke all on function public.task_approval_state(uuid) from public, anon;
grant execute on function public.task_approval_state(uuid) to authenticated;

-- Can the caller act for the task's side of the approval (send, withdraw, mark feedback received)?
-- The assignee (Commenter+), or anyone who edits the task.
create or replace function public.approval_can_act(target_task uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_task_role(target_task, 'editor')
    or (
      public.has_task_role(target_task, 'commenter')
      and exists (select 1 from public.tasks t where t.id = target_task and t.assignee_id = auth.uid())
    );
$$;

revoke all on function public.approval_can_act(uuid) from public, anon, authenticated;

-- Someone can approve this task: allowlisted with Commenter+ on it.
create or replace function public.approver_eligible(target_task uuid, person uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.profile_is_allowlisted(person)
    and public.project_role_rank(public.profile_task_role(person, target_task)) >= public.project_role_rank('commenter');
$$;

revoke all on function public.approver_eligible(uuid, uuid) from public, anon, authenticated;

create or replace function public.person_label(person uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(nullif(btrim(p.full_name), ''), p.email, 'Someone') from public.profiles p where p.id = person;
$$;

revoke all on function public.person_label(uuid) from public, anon, authenticated;

-- Opens one approval request in a round (on_approval_insert follows, logs, and notifies the approver).
create or replace function public.open_round_request(target_round uuid, approver uuid, request_note text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.approval_rounds;
  new_id uuid;
begin
  select * into r from public.approval_rounds where id = target_round;
  insert into public.approval_requests (task_id, approver_id, requested_by, note, round_id)
  values (r.task_id, approver, coalesce(r.sent_by, public.current_actor_id()), left(nullif(btrim(request_note), ''), 2000), r.id)
  returning id into new_id;
  return new_id;
end;
$$;

revoke all on function public.open_round_request(uuid, uuid, text) from public, anon, authenticated;

-- What happens when a round is approved.
create or replace function public.finish_approved_round(target_round uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.approval_rounds;
begin
  select * into r from public.approval_rounds where id = target_round;
  if r.after_approval = 'complete' then
    update public.tasks set completed_at = now()
    where id = r.task_id and completed_at is null and deleted_at is null;
  elsif r.after_approval = 'move_section' then
    update public.task_projects tp
    set section_id = r.move_section_id
    from public.sections s
    where s.id = r.move_section_id
      and s.deleted_at is null
      and tp.task_id = r.task_id
      and tp.project_id = s.project_id
      and tp.deleted_at is null
      and tp.section_id is distinct from r.move_section_id;
  end if;
end;
$$;

revoke all on function public.finish_approved_round(uuid) from public, anon, authenticated;

-- A request of a round changed status: settle the round.
create or replace function public.settle_approval_round()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.approval_rounds;
  done boolean := false;
begin
  select * into r from public.approval_rounds where id = new.round_id for update;
  if not found or r.status <> 'pending' then
    return null;
  end if;
  if new.status in ('changes_requested', 'rejected') then
    update public.approval_rounds
    set status = new.status, decided_by = new.decided_by, decided_at = now(),
        acknowledged_at = null, acknowledged_by = null, updated_at = now()
    where id = r.id;
    update public.approval_requests
    set status = 'cancelled', cancel_reason = 'round_closed'
    where round_id = r.id and status = 'pending' and id <> new.id and deleted_at is null;
    return null;
  end if;
  if new.status = 'approved' and r.mode = 'any' then
    done := true;
  elsif new.status in ('approved', 'cancelled') then
    done := not exists (
      select 1 from public.approval_requests q
      where q.round_id = r.id and q.status = 'pending' and q.deleted_at is null
    ) and exists (
      select 1 from public.approval_requests q
      where q.round_id = r.id and q.status = 'approved' and q.deleted_at is null
    );
  end if;
  if done then
    update public.approval_rounds
    set status = 'approved', decided_by = coalesce(new.decided_by, auth.uid()), decided_at = now(), updated_at = now()
    where id = r.id;
    update public.approval_requests
    set status = 'cancelled', cancel_reason = 'round_closed'
    where round_id = r.id and status = 'pending' and deleted_at is null;
    perform public.finish_approved_round(r.id);
  end if;
  return null;
end;
$$;

revoke all on function public.settle_approval_round() from public, anon, authenticated;

create trigger approval_requests_zz_round
  after update of status on public.approval_requests
  for each row
  when (new.round_id is not null and old.status is distinct from new.status)
  execute function public.settle_approval_round();

-- Stories for cancelled requests carry why (withdrawn, handed off with a note, reassigned); requests a
-- round closed (another approver decided) aren't logged on their own. Round requests never complete the
-- task through approval_completes_task: the round decides (finish_approved_round).
select public.alhc_patch_function(
  'public.on_approval_status_change()'::regprocedure,
  $old$    perform public.add_story(new.task_id, 'approval_cancelled', jsonb_build_object(
      'approval_id', new.id, 'approver_id', new.approver_id
    ));
    return new;$old$,
  $new$    if new.cancel_reason is distinct from 'round_closed' then
      perform public.add_story(new.task_id, 'approval_cancelled', jsonb_build_object(
        'approval_id', new.id, 'approver_id', new.approver_id, 'reason', new.cancel_reason,
        'handoff_to', new.handoff_to, 'note', new.handoff_note, 'round_id', new.round_id
      ));
    end if;
    return new;$new$,
  $old$  if new.status = 'approved' then
    select p.approval_completes_task$old$,
  $new$  if new.status = 'approved' and new.round_id is null then
    select p.approval_completes_task$new$
);

select public.alhc_patch_function(
  'public.complete_approval_task()'::regprocedure,
  $old$  if new.subtask_id is null and new.status in ('approved', 'rejected') and old.status is distinct from new.status then$old$,
  $new$  if new.subtask_id is null and new.round_id is null and new.status in ('approved', 'rejected')
     and old.status is distinct from new.status then$new$
);

-- Request changes needs a note (round requests); a closed round's request can't be decided.
select public.alhc_patch_function(
  'public.decide_approval(uuid,text,text)'::regprocedure,
  $old$  if a.status <> 'pending' then
    raise exception 'This approval is already %', replace(a.status, '_', ' ') using errcode = 'check_violation';
  end if;$old$,
  $new$  if a.status <> 'pending' then
    raise exception 'This approval is already %', replace(a.status, '_', ' ') using errcode = 'check_violation';
  end if;
  if a.round_id is not null then
    if not exists (select 1 from public.approval_rounds r where r.id = a.round_id and r.status = 'pending') then
      raise exception 'This approval request is no longer open' using errcode = 'check_violation';
    end if;
    if decision = 'changes_requested' and nullif(btrim(coalesce(decide_approval.decision_note, '')), '') is null then
      raise exception 'Add a note saying what needs to change' using errcode = 'check_violation';
    end if;
  end if;$new$
);

-- People can't complete an approval task while its approval is pending (the system can).
select public.alhc_patch_function(
  'public.guard_task_kind()'::regprocedure,
  $old$     and exists (
       select 1 from public.approval_requests a
       where a.task_id = new.id and a.subtask_id is null and a.approver_id = new.assignee_id
         and a.deleted_at is null and a.status in ('pending', 'changes_requested')
     ) then
    raise exception 'This is an approval task: its assignee approves, requests changes, or rejects it'
      using errcode = 'check_violation';$old$,
  $new$     and exists (
       select 1 from public.approval_rounds r where r.task_id = new.id and r.status = 'pending'
     ) then
    raise exception 'This task is waiting for approval. Withdraw the request first, or wait for the approver'
      using errcode = 'check_violation';$new$
);

-- Assignees no longer approve their own approval tasks: changing the assignee or the kind opens nothing.
-- Switching a task away from Approval withdraws a pending round.
create or replace function public.sync_task_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  open_round uuid;
begin
  if tg_op = 'UPDATE' then
    if new.kind is not distinct from old.kind and new.assignee_id is not distinct from old.assignee_id then
      return null;
    end if;
    if new.kind is distinct from old.kind then
      perform public.add_story(new.id, 'kind_changed', jsonb_build_object('from', old.kind, 'to', new.kind));
    end if;
  end if;
  if public.import_context_id() is not null or public.copy_context_id() is not null or new.deleted_at is not null then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.kind = 'approval' and new.kind <> 'approval' then
    select r.id into open_round from public.approval_rounds r where r.task_id = new.id and r.status = 'pending';
    if open_round is not null then
      update public.approval_rounds
      set status = 'withdrawn', withdrawn_at = now(), withdrawn_by = auth.uid(), updated_at = now()
      where id = open_round;
      update public.approval_requests
      set status = 'cancelled', cancel_reason = 'kind_changed'
      where round_id = open_round and status = 'pending' and deleted_at is null;
    end if;
  end if;
  return null;
end;
$$;

-- Approvers, how they decide, and the approval due date. Editors+ set them; while a round is pending only
-- project Owners / Admins change who approves (an approver hands off instead).
create or replace function public.set_task_approvers(
  target_task uuid,
  approvers uuid[],
  approval_mode text default 'any',
  approval_due date default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tasks;
  r public.approval_rounds;
  wanted uuid[];
  current_ids uuid[];
  person uuid;
  pending boolean;
begin
  select * into t from public.tasks where id = target_task and deleted_at is null for update;
  if not found or not public.has_task_role(target_task, 'viewer') then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;
  if t.kind <> 'approval' then
    raise exception 'Only approval tasks have approvers' using errcode = 'check_violation';
  end if;
  if not public.has_task_role(target_task, 'editor') then
    raise exception 'You need Editor access to change approvers' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(approval_mode, 'any') not in ('any', 'all') then
    raise exception 'Choose how approvers decide' using errcode = 'check_violation';
  end if;
  select coalesce(array_agg(distinct x) filter (where x is not null), '{}') into wanted from unnest(coalesce(approvers, '{}')) x;
  if cardinality(wanted) > 10 then
    raise exception 'A task can have up to 10 approvers' using errcode = 'check_violation';
  end if;
  foreach person in array wanted loop
    if not public.approver_eligible(target_task, person) then
      raise exception '% can''t approve this task: they need at least Commenter access to its project', public.person_label(person)
        using errcode = 'check_violation';
    end if;
  end loop;
  select * into r from public.approval_rounds where task_id = target_task order by round_number desc limit 1;
  pending := found and r.status = 'pending';
  select coalesce(array_agg(a.profile_id), '{}') into current_ids
  from public.task_approvers a where a.task_id = target_task and a.deleted_at is null;
  if pending and not (wanted @> current_ids and current_ids @> wanted) then
    if not public.has_task_role(target_task, 'admin') then
      raise exception 'While approval is pending, only a project Owner or Admin can change approvers (an approver can hand off)'
        using errcode = 'insufficient_privilege';
    end if;
    if cardinality(wanted) = 0 then
      raise exception 'A pending approval needs at least one approver; withdraw it instead' using errcode = 'check_violation';
    end if;
  end if;

  update public.task_approvers set deleted_at = now(), updated_at = now()
  where task_id = target_task and deleted_at is null and not (profile_id = any (wanted));
  insert into public.task_approvers (task_id, profile_id, added_by)
  select target_task, w, auth.uid() from unnest(wanted) w
  where not exists (
    select 1 from public.task_approvers a where a.task_id = target_task and a.profile_id = w and a.deleted_at is null
  );
  insert into public.task_approval_settings as s (task_id, mode, due_on, updated_by)
  values (target_task, coalesce(approval_mode, 'any'), approval_due, auth.uid())
  on conflict (task_id) do update set
    mode = excluded.mode, due_on = excluded.due_on, updated_by = excluded.updated_by, updated_at = now();

  if pending then
    update public.approval_rounds
    set mode = coalesce(approval_mode, 'any'),
        due_on = approval_due,
        reminded_soon_at = case when due_on is distinct from approval_due then null else reminded_soon_at end,
        reminded_overdue_at = case when due_on is distinct from approval_due then null else reminded_overdue_at end,
        updated_at = now()
    where id = r.id;
    -- New approvers first, so removing someone never settles the round early.
    foreach person in array wanted loop
      if not exists (
        select 1 from public.approval_requests q
        where q.round_id = r.id and q.approver_id = person and q.status in ('pending', 'approved') and q.deleted_at is null
      ) then
        perform public.open_round_request(r.id, person, r.final_text);
      end if;
    end loop;
    update public.approval_requests
    set status = 'cancelled', cancel_reason = 'reassigned'
    where round_id = r.id and status = 'pending' and deleted_at is null and not (approver_id = any (wanted));
    -- A mode change can settle the round (e.g. Any one can approve, and someone already approved).
    if exists (select 1 from public.approval_rounds x where x.id = r.id and x.status = 'pending')
       and exists (select 1 from public.approval_requests q where q.round_id = r.id and q.status = 'approved' and q.deleted_at is null)
       and (
         coalesce(approval_mode, 'any') = 'any'
         or not exists (select 1 from public.approval_requests q where q.round_id = r.id and q.status = 'pending' and q.deleted_at is null)
       ) then
      update public.approval_rounds
      set status = 'approved', decided_at = now(), decided_by = auth.uid(), updated_at = now()
      where id = r.id;
      update public.approval_requests
      set status = 'cancelled', cancel_reason = 'round_closed'
      where round_id = r.id and status = 'pending' and deleted_at is null;
      perform public.finish_approved_round(r.id);
    end if;
  end if;
  return public.task_approval_state(target_task);
end;
$$;

revoke all on function public.set_task_approvers(uuid, uuid[], text, date) from public, anon;
grant execute on function public.set_task_approvers(uuid, uuid[], text, date) to authenticated;

-- "Ready for approval": the assignee (or an Editor) sends the final text and/or files to the approvers.
create or replace function public.send_for_approval(
  target_task uuid,
  final_text text,
  attachment_ids uuid[],
  more_steps boolean default false,
  after_approval text default 'complete',
  move_section uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tasks;
  last_round public.approval_rounds;
  settings public.task_approval_settings;
  body text := nullif(btrim(coalesce(final_text, '')), '');
  files uuid[];
  after text;
  new_round uuid;
  person uuid;
  approvers uuid[];
begin
  select * into t from public.tasks where id = target_task and deleted_at is null for update;
  if not found or not public.has_task_role(target_task, 'viewer') then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;
  if t.kind <> 'approval' then
    raise exception 'Only approval tasks are sent for approval' using errcode = 'check_violation';
  end if;
  if not public.approval_can_act(target_task) then
    raise exception 'Only the assignee or an Editor can send this for approval' using errcode = 'insufficient_privilege';
  end if;
  if t.completed_at is not null then
    raise exception 'This task is already complete' using errcode = 'check_violation';
  end if;
  select * into last_round from public.approval_rounds where task_id = target_task order by round_number desc limit 1;
  if found and last_round.status = 'pending' then
    raise exception 'This task is already waiting for approval' using errcode = 'check_violation';
  end if;
  if found and last_round.status in ('changes_requested', 'rejected') and last_round.acknowledged_at is null then
    raise exception 'Mark the % as received first', case when last_round.status = 'rejected' then 'rejection' else 'feedback' end
      using errcode = 'check_violation';
  end if;
  select coalesce(array_agg(a.profile_id order by a.created_at), '{}') into approvers
  from public.task_approvers a where a.task_id = target_task and a.deleted_at is null;
  if cardinality(approvers) = 0 then
    raise exception 'Choose an approver first' using errcode = 'check_violation';
  end if;
  foreach person in array approvers loop
    if not public.approver_eligible(target_task, person) then
      raise exception '% can no longer approve this task; choose another approver', public.person_label(person)
        using errcode = 'check_violation';
    end if;
  end loop;
  if char_length(body) > 10000 then
    raise exception 'The final text is limited to 10,000 characters' using errcode = 'check_violation';
  end if;
  select coalesce(array_agg(distinct a.id), '{}') into files
  from public.task_attachments a
  where a.id = any (coalesce(attachment_ids, '{}')) and a.task_id = target_task and a.deleted_at is null;
  if cardinality(files) < cardinality(array(select distinct x from unnest(coalesce(attachment_ids, '{}')) x)) then
    raise exception 'A chosen file isn''t on this task' using errcode = 'check_violation';
  end if;
  if body is null and cardinality(files) = 0 then
    raise exception 'Add the final text or at least one file before sending for approval' using errcode = 'check_violation';
  end if;
  after := case when coalesce(more_steps, false) then coalesce(after_approval, 'notify') else 'complete' end;
  if coalesce(more_steps, false) and after not in ('move_section', 'notify') then
    raise exception 'Choose what happens after approval' using errcode = 'check_violation';
  end if;
  if after = 'move_section' then
    if move_section is null or not exists (
      select 1 from public.sections s
      join public.task_projects tp on tp.project_id = s.project_id and tp.task_id = target_task and tp.deleted_at is null
      where s.id = move_section and s.deleted_at is null
    ) then
      raise exception 'Choose a section of one of this task''s projects' using errcode = 'check_violation';
    end if;
    if not public.has_project_role((select s.project_id from public.sections s where s.id = move_section), 'editor') then
      raise exception 'You need Editor access to that project to move the task there' using errcode = 'insufficient_privilege';
    end if;
  end if;
  select * into settings from public.task_approval_settings where task_id = target_task;
  insert into public.approval_rounds (
    task_id, round_number, mode, final_text, attachment_ids, more_steps, after_approval, move_section_id,
    due_on, sent_by
  )
  values (
    target_task,
    coalesce((select max(x.round_number) from public.approval_rounds x where x.task_id = target_task), 0) + 1,
    coalesce(settings.mode, 'any'), body, files, coalesce(more_steps, false), after,
    case when after = 'move_section' then move_section end,
    settings.due_on, auth.uid()
  )
  returning id into new_round;
  foreach person in array approvers loop
    perform public.open_round_request(new_round, person, coalesce(body, 'Files attached for approval'));
  end loop;
  return new_round;
end;
$$;

revoke all on function public.send_for_approval(uuid, text, uuid[], boolean, text, uuid) from public, anon;
grant execute on function public.send_for_approval(uuid, text, uuid[], boolean, text, uuid) to authenticated;

-- The assignee pulls back a pending request.
create or replace function public.withdraw_approval(target_task uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.approval_rounds;
begin
  if not public.has_task_role(target_task, 'viewer') then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;
  select * into r from public.approval_rounds where task_id = target_task and status = 'pending' for update;
  if not found then
    raise exception 'Nothing is waiting for approval' using errcode = 'check_violation';
  end if;
  if not public.approval_can_act(target_task) and r.sent_by is distinct from auth.uid() then
    raise exception 'Only the assignee or an Editor can withdraw this' using errcode = 'insufficient_privilege';
  end if;
  update public.approval_rounds
  set status = 'withdrawn', withdrawn_at = now(), withdrawn_by = auth.uid(), updated_at = now()
  where id = r.id;
  update public.approval_requests
  set status = 'cancelled', cancel_reason = 'withdrawn'
  where round_id = r.id and status = 'pending' and deleted_at is null;
end;
$$;

revoke all on function public.withdraw_approval(uuid) from public, anon;
grant execute on function public.withdraw_approval(uuid) to authenticated;

-- "Feedback received" / "Rejection received": the paused task is the assignee's again.
create or replace function public.acknowledge_approval(target_task uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.approval_rounds;
begin
  if not public.has_task_role(target_task, 'viewer') then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;
  select * into r from public.approval_rounds where task_id = target_task order by round_number desc limit 1 for update;
  if not found or r.status not in ('changes_requested', 'rejected') or r.acknowledged_at is not null then
    raise exception 'There is no feedback waiting for you' using errcode = 'check_violation';
  end if;
  if not public.approval_can_act(target_task) then
    raise exception 'Only the assignee or an Editor can do that' using errcode = 'insufficient_privilege';
  end if;
  update public.approval_rounds
  set acknowledged_at = now(), acknowledged_by = auth.uid(), updated_at = now()
  where id = r.id;
  perform public.add_story(target_task, 'approval_resubmitted', jsonb_build_object(
    'event', 'acknowledged', 'status', r.status, 'round_id', r.id, 'round_number', r.round_number
  ));
end;
$$;

revoke all on function public.acknowledge_approval(uuid) from public, anon;
grant execute on function public.acknowledge_approval(uuid) to authenticated;

-- An approver passes their pending decision to someone else (with an optional note).
create or replace function public.hand_off_approval(target_task uuid, new_approver uuid, handoff_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.approval_rounds;
  mine public.approval_requests;
  handoff_text text := nullif(btrim(coalesce(handoff_note, '')), '');
begin
  if not public.has_task_role(target_task, 'viewer') then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;
  select * into r from public.approval_rounds where task_id = target_task and status = 'pending' for update;
  if not found then
    raise exception 'Only a pending approval can be handed off' using errcode = 'check_violation';
  end if;
  select * into mine from public.approval_requests
  where round_id = r.id and approver_id = auth.uid() and status = 'pending' and deleted_at is null;
  if not found then
    raise exception 'Only an approver who hasn''t decided yet can hand it off' using errcode = 'insufficient_privilege';
  end if;
  if new_approver is null or new_approver = auth.uid() then
    raise exception 'Choose someone else to hand this off to' using errcode = 'check_violation';
  end if;
  if char_length(handoff_text) > 2000 then
    raise exception 'The note is limited to 2,000 characters' using errcode = 'check_violation';
  end if;
  if not public.approver_eligible(target_task, new_approver) then
    raise exception '% can''t approve this task: they need at least Commenter access to its project', public.person_label(new_approver)
      using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.task_approvers a where a.task_id = target_task and a.profile_id = new_approver and a.deleted_at is null) then
    raise exception '% is already an approver of this task', public.person_label(new_approver) using errcode = 'check_violation';
  end if;
  update public.task_approvers set deleted_at = now(), updated_at = now()
  where task_id = target_task and profile_id = auth.uid() and deleted_at is null;
  insert into public.task_approvers (task_id, profile_id, added_by) values (target_task, new_approver, auth.uid());
  perform public.open_round_request(
    r.id, new_approver,
    concat_ws(E'\n\n',
      'Handed off by ' || public.person_label(auth.uid()) || coalesce(': ' || handoff_text, ''),
      coalesce(r.final_text, 'Files attached for approval'))
  );
  update public.approval_requests
  set status = 'cancelled', cancel_reason = 'handed_off', handoff_to = new_approver, handoff_note = handoff_text
  where id = mine.id;
end;
$$;

revoke all on function public.hand_off_approval(uuid, uuid, text) from public, anon;
grant execute on function public.hand_off_approval(uuid, uuid, text) to authenticated;

-- Nudges: the day before the approval due date, and once overdue, each approver who hasn't decided.
create or replace function public.approval_reminders_tick()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  q record;
  sent integer := 0;
  today date := (now() at time zone 'UTC')::date;
begin
  for r in
    select x.* from public.approval_rounds x
    join public.tasks t on t.id = x.task_id and t.deleted_at is null and t.completed_at is null
    where x.status = 'pending' and x.due_on is not null
      and (
        (x.due_on = today + 1 and x.reminded_soon_at is null)
        or (x.due_on < today and x.reminded_overdue_at is null)
      )
    for update of x skip locked
  loop
    for q in
      select a.id, a.approver_id from public.approval_requests a
      where a.round_id = r.id and a.status = 'pending' and a.deleted_at is null
    loop
      perform public.notify_with(q.approver_id, r.task_id, 'approval_requested', null, jsonb_build_object(
        'approval_id', q.id, 'reminder', case when r.due_on < today then 'overdue' else 'due_soon' end,
        'due_on', r.due_on, 'round_id', r.id));
      sent := sent + 1;
    end loop;
    if r.due_on < today then
      update public.approval_rounds set reminded_overdue_at = now(), reminded_soon_at = coalesce(reminded_soon_at, now())
      where id = r.id;
    else
      update public.approval_rounds set reminded_soon_at = now() where id = r.id;
    end if;
  end loop;
  return sent;
end;
$$;

revoke all on function public.approval_reminders_tick() from public, anon, authenticated;
grant execute on function public.approval_reminders_tick() to service_role;

select public.alhc_patch_function(
  'public.workflow_tick()'::regprocedure,
  $old$  my_tasks := public.my_task_rules_tick();$old$,
  $new$  my_tasks := public.my_task_rules_tick();
  perform public.approval_reminders_tick();$new$
);

-- List / Board cards: the approval status by round (and whether it's paused, or waiting on the caller).
select public.alhc_patch_function(
  'public.project_task_cards(uuid,uuid[])'::regprocedure,
  $old$  approvals as (
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
  )$old$,
  $new$  approvals as (
    select m.task_id,
           case when r.id is null or r.status = 'withdrawn' then 'not_sent' else r.status end as status,
           coalesce(r.status in ('changes_requested', 'rejected') and r.acknowledged_at is null, false) as paused,
           coalesce(r.status = 'pending' and exists (
             select 1 from public.approval_requests q
             where q.round_id = r.id and q.status = 'pending' and q.approver_id = (select auth.uid()) and q.deleted_at is null
           ), false) as waiting_on_me
    from member m
    left join lateral (
      select x.* from public.approval_rounds x where x.task_id = m.task_id order by x.round_number desc limit 1
    ) r on true
    where m.kind = 'approval'
  )$new$,
  $old$      'approval_status', ap.status
    )$old$,
  $new$      'approval_status', ap.status,
      'approval_paused', coalesce(ap.paused, false),
      'approval_waiting_on_me', coalesce(ap.waiting_on_me, false)
    )$new$
);

-- View filter: approval [not_sent | pending | changes_requested | rejected | approved | paused |
-- waiting_on_me] (any of). "Waiting on me" also matches tasks with any other approval request waiting on
-- the caller.
create or replace function public.approval_filter_matches(target_task uuid, task_kind text, wanted jsonb)
returns boolean
language sql
stable
set search_path = ''
as $$
  select
    (wanted @> '["waiting_on_me"]'::jsonb and exists (
      select 1 from public.approval_requests q
      left join public.approval_rounds r on r.id = q.round_id
      where q.task_id = target_task and q.status = 'pending' and q.deleted_at is null
        and q.approver_id = (select auth.uid())
        and (q.round_id is null or r.status = 'pending')
    ))
    or (task_kind = 'approval' and (
      wanted @> jsonb_build_array(public.task_approval_state(target_task) ->> 'status')
      or (wanted @> '["paused"]'::jsonb and (public.task_approval_state(target_task) ->> 'paused')::boolean)
    ));
$$;

revoke all on function public.approval_filter_matches(uuid, text, jsonb) from public, anon;
grant execute on function public.approval_filter_matches(uuid, text, jsonb) to authenticated;

select public.alhc_patch_function(
  'public.validate_view_filters(uuid,jsonb)'::regprocedure,
  $old$    where k not in ('completion', 'completed_within_days', 'sections', 'assignees', 'due', 'fields', 'text', 'tags')$old$,
  $new$    where k not in ('completion', 'completed_within_days', 'sections', 'assignees', 'due', 'fields', 'text', 'tags', 'approval')$new$,
  $old$  if filters ? 'text' and (jsonb_typeof(filters -> 'text') <> 'string' or length(filters ->> 'text') > 200) then$old$,
  $new$  if filters ? 'approval' and (
    jsonb_typeof(filters -> 'approval') <> 'array'
    or jsonb_array_length(filters -> 'approval') > 7
    or exists (
      select 1 from jsonb_array_elements(filters -> 'approval') a
      where jsonb_typeof(a) <> 'string'
        or a #>> '{}' not in ('not_sent', 'pending', 'changes_requested', 'rejected', 'approved', 'paused', 'waiting_on_me')
    )
  ) then
    raise exception 'Unknown approval filter' using errcode = 'check_violation';
  end if;

  if filters ? 'text' and (jsonb_typeof(filters -> 'text') <> 'string' or length(filters ->> 'text') > 200) then$new$
);

select public.alhc_patch_function(
  'public.filter_project_tasks(uuid,jsonb,text)'::regprocedure,
  $old$    and (
      jsonb_array_length(public.view_list(p.f -> 'tags')) = 0$old$,
  $new$    and (
      jsonb_array_length(public.view_list(p.f -> 'approval')) = 0
      or public.approval_filter_matches(t.id, t.kind, p.f -> 'approval')
    )
    and (
      jsonb_array_length(public.view_list(p.f -> 'tags')) = 0$new$
);

-- The assignee of an approval task no longer approves it, so being assigned one is an ordinary assignment.
select public.alhc_patch_function(
  'public.on_task_update_collab()'::regprocedure,
  $old$      if new.kind <> 'approval' or new.completed_at is not null then
        perform public.notify(new.assignee_id, new.id, 'assigned');
      end if;$old$,
  $new$      perform public.notify(new.assignee_id, new.id, 'assigned');$new$
);

select public.alhc_patch_function(
  'public.on_task_insert_collab()'::regprocedure,
  $old$    -- An open approval task's assignee hears about it once: the approval_requested item.
    if new.kind <> 'approval' or new.completed_at is not null then
      perform public.notify(new.assignee_id, new.id, 'assigned');
    end if;$old$,
  $new$    perform public.notify(new.assignee_id, new.id, 'assigned');$new$
);

-- A recurring approval task's next occurrence keeps its approvers and how they decide (not the due date).
create or replace function public.copy_approvers_to_next_occurrence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind <> 'approval' then
    return null;
  end if;
  insert into public.task_approvers (task_id, profile_id, added_by)
  select new.recurrence_next_id, a.profile_id, a.added_by
  from public.task_approvers a
  where a.task_id = new.id and a.deleted_at is null
    and not exists (
      select 1 from public.task_approvers x
      where x.task_id = new.recurrence_next_id and x.profile_id = a.profile_id and x.deleted_at is null
    );
  insert into public.task_approval_settings (task_id, mode, updated_by)
  select new.recurrence_next_id, s.mode, s.updated_by
  from public.task_approval_settings s
  where s.task_id = new.id
  on conflict (task_id) do nothing;
  return null;
end;
$$;

revoke all on function public.copy_approvers_to_next_occurrence() from public, anon, authenticated;

create trigger tasks_zz_next_occurrence_approvers
  after update of recurrence_next_id on public.tasks
  for each row
  when (old.recurrence_next_id is null and new.recurrence_next_id is not null)
  execute function public.copy_approvers_to_next_occurrence();

-- Existing approval tasks: their approver is the approver of their latest request (else nobody yet), and
-- that request is round 1 (changes requested before today doesn't pause anything).
do $$
declare
  a record;
  new_round uuid;
begin
  for a in
    select distinct on (q.task_id) q.*
    from public.approval_requests q
    join public.tasks t on t.id = q.task_id and t.kind = 'approval'
    where q.subtask_id is null and q.deleted_at is null and q.round_id is null and q.status <> 'cancelled'
    order by q.task_id, q.created_at desc, q.id desc
  loop
    insert into public.task_approvers (task_id, profile_id, added_by)
    select a.task_id, a.approver_id, a.requested_by
    where not exists (
      select 1 from public.task_approvers x where x.task_id = a.task_id and x.profile_id = a.approver_id and x.deleted_at is null
    );
    insert into public.approval_rounds (task_id, round_number, status, mode, final_text, sent_by, sent_at,
      decided_by, decided_at, acknowledged_at)
    values (a.task_id, 1, a.status, 'any', a.note, a.requested_by, a.created_at,
      a.decided_by, a.decided_at, case when a.status in ('changes_requested', 'rejected') then now() end)
    on conflict on constraint approval_rounds_task_number_key do nothing
    returning id into new_round;
    if new_round is not null then
      update public.approval_requests set round_id = new_round where id = a.id;
    end if;
  end loop;
end;
$$;
