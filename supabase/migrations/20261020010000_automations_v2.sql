-- ALHC Projects — Automations V2 (docs/AUTOMATIONS-RESEARCH.md, batches 2–4).
--
-- Batch 2: engine breadth.
--   * Triggers: task completed, task reopened, due date changed, task overdue, comment added,
--     attachment added, tag added, all subtasks done, task added from another project, on a schedule,
--     and run manually (run_manual_rule). The wider CHECK lands as rules_trigger_type_check_v2; the
--     TAIL retires the old CHECK and renames the new one, so until the tail is applied the new
--     triggers are refused (the builder says so) while everything else works.
--   * Conditions: AND / OR groups (a condition's "group": 0–9; a branch passes when every condition of
--     any one group passes — no group key = one AND group, exactly as before), field comparisons
--     (greater / less, before / after, contains, is not), assignee / creator is, has / lacks a tag,
--     overdue / due within N days / has a due date, task type, open / finished subtasks, title
--     contains, form answer contains.
--   * Actions: complete, reopen, rename (title), set or clear the due date (relative, in calendar
--     days or business days), add / remove a tag, add to another project, create subtasks, apply a
--     task template.
--   * Business days follow the workspace's workweek (workspaces.work_week, Sunday–Thursday by
--     default; workspace admins change it). rule_add_days() is mirrored by src/lib/workdays.ts.
--   * Every run logs one entry per step (step, type, input, outcome, result, error) in
--     rule_runs.detail.actions; a failed run keeps the steps that ran in detail.steps.
-- Batch 3: {{placeholders}} in rule text (render_rule_text_as), mirrored by src/lib/rule-placeholders.ts.
-- Batch 4: dry-run tests (test_rule), loop limits, auto-pause, rule owners.
--
-- New client SECURITY DEFINER functions (pinned in suite 60): run_manual_rule (Editor+ of the rule's
-- project) and test_rule (Admin+ of the rule's project; always rolls back). Everything else new is
-- invoker or revoked from clients. fire_rules keeps its import and copy checks exactly as they were;
-- notify_with, notify_message, and add_story are untouched.

-- =============================================================================================
-- 1. The workspace's workweek and business-day math

alter table public.workspaces
  add column if not exists work_week smallint[] not null default '{0,1,2,3,4}';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'workspaces_work_week_check') then
    alter table public.workspaces add constraint workspaces_work_week_check
      check (cardinality(work_week) between 1 and 7 and work_week <@ '{0,1,2,3,4,5,6}'::smallint[]);
  end if;
end $$;

comment on column public.workspaces.work_week is
  'Days rules count as business days (0 = Sunday … 6 = Saturday). Default Sunday–Thursday.';

-- workspaces_update_admin (is_workspace_admin) already gates the row; this is the column.
grant update (work_week) on public.workspaces to authenticated;

-- start + days, counting only workdays when business is true (mirrors addWorkdays in
-- src/lib/workdays.ts). Zero business days from a day off moves to the next workday; a negative count
-- walks back. Without a workweek (or with all seven days) business days are calendar days.
create or replace function public.rule_add_days(start_on date, days integer, business boolean, work_week smallint[])
returns date
language plpgsql
immutable
set search_path = ''
as $$
declare
  d date := start_on;
  remaining integer := abs(coalesce(days, 0));
  direction integer := case when coalesce(days, 0) < 0 then -1 else 1 end;
begin
  if start_on is null then
    return null;
  end if;
  if not coalesce(business, false) or work_week is null or cardinality(work_week) = 0 or cardinality(work_week) >= 7 then
    return start_on + coalesce(days, 0);
  end if;
  if remaining = 0 then
    while not (extract(dow from d)::smallint = any (work_week)) loop
      d := d + 1;
    end loop;
    return d;
  end if;
  while remaining > 0 loop
    d := d + direction;
    if extract(dow from d)::smallint = any (work_week) then
      remaining := remaining - 1;
    end if;
  end loop;
  return d;
end;
$$;

revoke all on function public.rule_add_days(date, integer, boolean, smallint[]) from public, anon;
grant execute on function public.rule_add_days(date, integer, boolean, smallint[]) to authenticated;

create or replace function public.project_work_week(target_project uuid)
returns smallint[]
language sql
stable
set search_path = ''
as $$
  select w.work_week from public.projects p join public.workspaces w on w.id = p.workspace_id where p.id = target_project;
$$;

revoke all on function public.project_work_week(uuid) from public, anon;
grant execute on function public.project_work_week(uuid) to authenticated;

-- =============================================================================================
-- 2. Scheduled rules

alter table public.rules add column if not exists next_run_at timestamptz;

-- The person a rule acts for (cross-project actions check their access) and who hears about it when it
-- is paused (batch 4). Defaults to the creator.
alter table public.rules add column if not exists owner_id uuid references public.profiles (id);
update public.rules set owner_id = created_by where owner_id is null and created_by is not null;
create index if not exists rules_owner_idx on public.rules (owner_id);

-- Batch 4: who last changed it, the "rule-caused changes" switch, and the health the engine keeps.
alter table public.rules
  add column if not exists last_edited_by uuid references public.profiles (id),
  add column if not exists last_edited_at timestamptz,
  add column if not exists run_on_rule_changes boolean not null default true,
  add column if not exists paused_at timestamptz,
  add column if not exists pause_reason text,
  add column if not exists consecutive_failures integer not null default 0;
create index if not exists rules_last_edited_by_idx on public.rules (last_edited_by);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'rules_pause_reason_check') then
    alter table public.rules add constraint rules_pause_reason_check check (length(pause_reason) <= 500);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'rules_consecutive_failures_check') then
    alter table public.rules add constraint rules_consecutive_failures_check check (consecutive_failures >= 0);
  end if;
end $$;

update public.rules set last_edited_by = created_by, last_edited_at = updated_at where last_edited_at is null;

-- People set the name, trigger, conditions, actions, on / off, owner, and the rule-caused switch; the
-- database keeps the rest. A new rule's owner is its creator. Turning a paused rule back on resumes it
-- (clears the pause and the failure count). The owner must be a member of the project.
create or replace function public.rules_guard_v2()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if public.is_client_role() then
      new.owner_id := coalesce(new.owner_id, auth.uid());
      new.paused_at := null;
      new.pause_reason := null;
      new.consecutive_failures := 0;
      new.last_edited_by := auth.uid();
      new.last_edited_at := now();
    else
      new.owner_id := coalesce(new.owner_id, new.created_by);
    end if;
  elsif public.is_client_role() then
    new.paused_at := old.paused_at;
    new.pause_reason := old.pause_reason;
    new.consecutive_failures := old.consecutive_failures;
    new.last_edited_by := old.last_edited_by;
    new.last_edited_at := old.last_edited_at;
    new.created_by := old.created_by;
    if new.enabled and not old.enabled then
      new.paused_at := null;
      new.pause_reason := null;
      new.consecutive_failures := 0;
    end if;
    if new.name is distinct from old.name or new.trigger_type is distinct from old.trigger_type
       or new.trigger_config is distinct from old.trigger_config or new.conditions is distinct from old.conditions
       or new.actions is distinct from old.actions or new.owner_id is distinct from old.owner_id
       or new.run_on_rule_changes is distinct from old.run_on_rule_changes or new.enabled is distinct from old.enabled
       or new.deleted_at is distinct from old.deleted_at then
      new.last_edited_by := auth.uid();
      new.last_edited_at := now();
    end if;
  end if;
  if public.is_client_role() and new.owner_id is not null
     and (tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id)
     and not exists (
       select 1 from public.project_members pm
       where pm.project_id = new.project_id and pm.profile_id = new.owner_id and pm.deleted_at is null
     ) then
    raise exception 'The rule’s owner must be a member of this project' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.rules_guard_v2() from public, anon;
grant execute on function public.rules_guard_v2() to authenticated;

create or replace trigger rules_07_guard_v2
before insert or update on public.rules
for each row execute function public.rules_guard_v2();

create index if not exists rules_scheduled_due_idx on public.rules (next_run_at)
  where trigger_type = 'scheduled' and enabled and deleted_at is null;

-- The next time a scheduled rule runs after `after_time`: daily, every workday (the workspace's
-- workweek), weekly on a weekday, or monthly on a day (1–28), at an hour in the rule's time zone.
create or replace function public.rule_schedule_next_at(cfg jsonb, work_week smallint[], after_time timestamptz)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  frequency text := cfg ->> 'frequency';
  hour integer := case when jsonb_typeof(cfg -> 'hour') = 'number' then (cfg ->> 'hour')::numeric::integer else 9 end;
  weekday integer := case when jsonb_typeof(cfg -> 'weekday') = 'number' then (cfg ->> 'weekday')::numeric::integer else 0 end;
  month_day integer := case when jsonb_typeof(cfg -> 'month_day') = 'number' then (cfg ->> 'month_day')::numeric::integer else 1 end;
  zone text := public.safe_timezone(coalesce(nullif(cfg ->> 'timezone', ''), 'UTC'));
  next_at timestamptz;
begin
  if frequency = 'workdays' then
    next_at := public.email_schedule_next_at('daily', hour, null, null, zone, after_time);
    if work_week is not null and cardinality(work_week) between 1 and 6 then
      for i in 1 .. 7 loop
        exit when extract(dow from (next_at at time zone zone))::smallint = any (work_week);
        next_at := public.email_schedule_next_at('daily', hour, null, null, zone, next_at);
      end loop;
    end if;
    return next_at;
  end if;
  if frequency in ('daily', 'weekly', 'monthly') then
    return public.email_schedule_next_at(frequency, hour, weekday, month_day, zone, after_time);
  end if;
  return null;
end;
$$;

revoke all on function public.rule_schedule_next_at(jsonb, smallint[], timestamptz) from public, anon;
grant execute on function public.rule_schedule_next_at(jsonb, smallint[], timestamptz) to authenticated;

-- Keeps rules.next_run_at: set when a scheduled rule is created, its timing changes, or it is turned
-- on; null for every other rule. People never write it (the engine moves it on after each run).
create or replace function public.rules_set_next_run()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.trigger_type = 'scheduled' and new.enabled and new.deleted_at is null then
    if tg_op = 'INSERT'
       or new.trigger_config is distinct from old.trigger_config
       or new.trigger_type is distinct from old.trigger_type
       or new.enabled is distinct from old.enabled
       or new.deleted_at is distinct from old.deleted_at
       or (new.next_run_at is null and not public.is_client_role()) then
      new.next_run_at := public.rule_schedule_next_at(new.trigger_config, public.project_work_week(new.project_id), now());
    elsif public.is_client_role() then
      new.next_run_at := old.next_run_at;
    end if;
  else
    new.next_run_at := null;
  end if;
  return new;
end;
$$;

revoke all on function public.rules_set_next_run() from public, anon;
grant execute on function public.rules_set_next_run() to authenticated;

create or replace trigger rules_06_next_run
before insert or update on public.rules
for each row execute function public.rules_set_next_run();

-- A new workweek moves the next run of the workspace's "every workday" rules (so none runs once more
-- on a day that's now off). Runs only after the workspace update itself passed RLS (workspace admins);
-- definer because those rules belong to projects the admin may not be in. Revoked from clients.
create or replace function public.rules_on_work_week_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.work_week is distinct from old.work_week then
    update public.rules ru
    set next_run_at = public.rule_schedule_next_at(ru.trigger_config, new.work_week, now())
    from public.projects p
    where p.id = ru.project_id and p.workspace_id = new.id
      and ru.trigger_type = 'scheduled' and ru.enabled and ru.deleted_at is null
      and ru.trigger_config ->> 'frequency' = 'workdays';
  end if;
  return null;
end;
$$;

revoke all on function public.rules_on_work_week_change() from public, anon, authenticated;

create or replace trigger workspaces_zz_work_week_rules
after update of work_week on public.workspaces
for each row execute function public.rules_on_work_week_change();

-- =============================================================================================
-- 3. Trigger types (the old CHECK is retired in the TAIL)

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'rules_trigger_type_check_v2') then
    alter table public.rules add constraint rules_trigger_type_check_v2 check (trigger_type in (
      'task_created', 'section_changed', 'field_changed', 'assignee_changed', 'due_approaching',
      'approval_decided', 'form_submitted', 'inbound_received',
      'task_completed', 'task_reopened', 'due_date_changed', 'task_overdue', 'comment_added',
      'attachment_added', 'tag_added', 'subtasks_completed', 'task_added_from_project', 'scheduled', 'manual'
    ));
  end if;
end $$;

-- =============================================================================================
-- 4. Helpers for conditions and actions (internal)

-- A condition's OR group (0–9; missing = 0).
create or replace function public.rule_item_group(item jsonb)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case when jsonb_typeof(item -> 'group') = 'number' and (item ->> 'group') ~ '^[0-9]$'
    then (item ->> 'group')::integer else 0 end;
$$;

revoke all on function public.rule_item_group(jsonb) from public, anon;
grant execute on function public.rule_item_group(jsonb) to authenticated;

-- The people a list of person slots names right now (profile ids or the task's assignee / creator).
create or replace function public.rule_people(people jsonb, target_task uuid)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct x.person) filter (where x.person is not null), '{}')
  from (
    select public.resolve_rule_person(p.value, target_task) as person
    from jsonb_array_elements(case when jsonb_typeof(people) = 'array' then people else '[]'::jsonb end) p
  ) x;
$$;

revoke all on function public.rule_people(jsonb, uuid) from public, anon, authenticated;

create or replace function public.rule_profile_name(target_profile uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(nullif(trim(p.full_name), ''), p.email) from public.profiles p where p.id = target_profile;
$$;

revoke all on function public.rule_profile_name(uuid) from public, anon, authenticated;

-- "today" in the rule's time zone (trigger_config.timezone, saved by the builder; else UTC).
create or replace function public.rule_local_today(r public.rules)
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone public.safe_timezone(coalesce(nullif(r.trigger_config ->> 'timezone', ''), 'UTC')))::date;
$$;

revoke all on function public.rule_local_today(public.rules) from public, anon, authenticated;

-- A tag a rule may name: in the project's workspace and not removed (archived ones only when allowed).
create or replace function public.rule_tag_ok(target_project uuid, tag_id text, allow_archived boolean)
returns boolean
language sql
stable
set search_path = ''
as $$
  select tag_id ~* '^[0-9a-f-]{36}$' and exists (
    select 1 from public.tags tg join public.projects p on p.workspace_id = tg.workspace_id
    where p.id = target_project and tg.id::text = tag_id and tg.deleted_at is null
      and (allow_archived or tg.archived_at is null)
  );
$$;

revoke all on function public.rule_tag_ok(uuid, text, boolean) from public, anon;
grant execute on function public.rule_tag_ok(uuid, text, boolean) to authenticated;

-- A field value in words, for run logs ("High", "Video, Print", "Yes").
create or replace function public.rule_field_value_label(field public.custom_fields, value jsonb)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when value is null or value = 'null'::jsonb or value in ('""'::jsonb, '[]'::jsonb) then 'empty'
    when field.bound_to_sections then coalesce((select s.name from public.sections s where s.id::text = value #>> '{}'), 'a section')
    when field.field_type = 'single_select' then coalesce((
      select o ->> 'name' from jsonb_array_elements(field.options) o where o ->> 'id' = value #>> '{}'
    ), 'an option')
    when field.field_type = 'multi_select' and jsonb_typeof(value) = 'array' then (
      select string_agg(coalesce(o ->> 'name', '?'), ', ' order by v.i)
      from jsonb_array_elements_text(value) with ordinality v(id, i)
      left join lateral (select o from jsonb_array_elements(field.options) o where o ->> 'id' = v.id) x on true
    )
    when field.field_type = 'boolean' then case when value = 'true'::jsonb then 'checked' else 'unchecked' end
    else left(value #>> '{}', 200)
  end;
$$;

revoke all on function public.rule_field_value_label(public.custom_fields, jsonb) from public, anon, authenticated;

-- =============================================================================================
-- 5. Conditions

-- Branch keys and limits (Asana parity, batch 4) plus OR group keys (Automations V2).
create or replace function public.validate_rule_branches(rule_conditions jsonb, rule_actions jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  item jsonb;
  branches integer;
  b integer;
  n_conditions integer;
  n_actions integer;
begin
  if coalesce(jsonb_typeof(rule_conditions), 'missing') <> 'array' or coalesce(jsonb_typeof(rule_actions), 'missing') <> 'array' then
    raise exception 'Conditions and actions must be lists' using errcode = 'check_violation';
  end if;
  for item in
    select value from jsonb_array_elements(rule_conditions)
    union all
    select value from jsonb_array_elements(rule_actions)
  loop
    if jsonb_typeof(item) = 'object' and item ? 'branch'
       and (jsonb_typeof(item -> 'branch') <> 'number' or (item ->> 'branch') !~ '^[0-4]$') then
      raise exception 'A rule branch is a whole number from 0 to 4' using errcode = 'check_violation';
    end if;
  end loop;
  for item in select value from jsonb_array_elements(rule_conditions) loop
    if jsonb_typeof(item) = 'object' and item ? 'group'
       and (jsonb_typeof(item -> 'group') <> 'number' or (item ->> 'group') !~ '^[0-9]$') then
      raise exception 'A condition group is a whole number from 0 to 9' using errcode = 'check_violation';
    end if;
  end loop;
  for item in select value from jsonb_array_elements(rule_actions) loop
    if jsonb_typeof(item) = 'object' and item ? 'group' then
      raise exception 'Only conditions belong to OR groups' using errcode = 'check_violation';
    end if;
  end loop;

  branches := public.rule_branch_count(rule_conditions, rule_actions);
  if branches = 1 then
    if jsonb_array_length(rule_conditions) > 20 then
      raise exception 'Rules are limited to 20 conditions' using errcode = 'check_violation';
    end if;
    if jsonb_array_length(rule_actions) not between 1 and 10 then
      raise exception 'Rules need between 1 and 10 actions' using errcode = 'check_violation';
    end if;
    return;
  end if;

  for b in 0 .. branches - 1 loop
    n_conditions := jsonb_array_length(public.rule_branch_items(rule_conditions, b));
    n_actions := jsonb_array_length(public.rule_branch_items(rule_actions, b));
    if n_conditions > 20 then
      raise exception 'Each branch is limited to 20 conditions' using errcode = 'check_violation';
    end if;
    if n_actions not between 1 and 10 then
      raise exception 'Each branch needs between 1 and 10 actions' using errcode = 'check_violation';
    end if;
    if n_conditions = 0 and b < branches - 1 then
      raise exception 'Only the last branch (Otherwise) can run without conditions' using errcode = 'check_violation';
    end if;
  end loop;
end;
$$;

-- One condition against one task (the engine and the dry run share it). `section` is the task's
-- section in the rule's project.
create or replace function public.rule_condition_ok(r public.rules, c jsonb, t public.tasks, section uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  field public.custom_fields;
  current_value jsonb;
  wanted jsonb := c -> 'value';
  today date := public.rule_local_today(r);
  op text := c ->> 'op';
  current_text text;
  wanted_text text;
begin
  case c ->> 'type'
    when 'section_is' then return section::text is not distinct from c ->> 'section_id';
    when 'section_is_not' then return section::text is distinct from c ->> 'section_id';
    when 'assignee_is_set' then return t.assignee_id is not null;
    when 'assignee_is_empty' then return t.assignee_id is null;
    when 'is_complete' then return t.completed_at is not null;
    when 'is_incomplete' then return t.completed_at is null;
    when 'source_is' then return t.source = c ->> 'source';
    when 'assignee_is' then return t.assignee_id is not null and t.assignee_id = any (public.rule_people(c -> 'people', t.id));
    when 'assignee_is_not' then return t.assignee_id is null or not (t.assignee_id = any (public.rule_people(c -> 'people', t.id)));
    when 'creator_is' then return t.created_by is not null and t.created_by = any (public.rule_people(c -> 'people', t.id));
    when 'has_tag', 'lacks_tag' then
      return (c ->> 'type' = 'has_tag') = exists (
        select 1 from public.task_tags tt
        where tt.task_id = t.id and tt.tag_id::text = c ->> 'tag_id' and tt.deleted_at is null
      );
    when 'is_overdue' then return t.completed_at is null and t.due_on < today;
    when 'due_within' then
      return t.due_on is not null and t.due_on between today and today + coalesce((c ->> 'days')::numeric::integer, 0);
    when 'has_due_date' then return t.due_on is not null;
    when 'no_due_date' then return t.due_on is null;
    when 'task_type_is' then return t.kind = c ->> 'kind';
    when 'has_open_subtasks' then
      return exists (select 1 from public.tasks s where s.parent_task_id = t.id and s.deleted_at is null and s.completed_at is null);
    when 'all_subtasks_done' then
      return exists (select 1 from public.tasks s where s.parent_task_id = t.id and s.deleted_at is null)
        and not exists (select 1 from public.tasks s where s.parent_task_id = t.id and s.deleted_at is null and s.completed_at is null);
    when 'title_contains' then
      return strpos(lower(t.title), lower(coalesce(c ->> 'text', ''))) > 0 and coalesce(c ->> 'text', '') <> '';
    when 'form_answer_contains' then
      return coalesce(c ->> 'text', '') <> '' and exists (
        select 1 from public.form_submissions s, jsonb_each(s.answers) ans
        where s.task_id = t.id and s.deleted_at is null
          and (coalesce(c ->> 'question_id', '') = '' or ans.key = c ->> 'question_id')
          and strpos(lower(case when jsonb_typeof(ans.value) = 'string' then ans.value #>> '{}' else ans.value::text end),
                     lower(c ->> 'text')) > 0
      );
    else
      null;
  end case;

  -- Field conditions.
  field := public.rule_field(r.project_id, c ->> 'field_id');
  if field.id is null then
    return false;
  end if;
  if field.bound_to_sections then
    current_value := to_jsonb(section::text);
  else
    select v.value into current_value from public.task_field_values v where v.task_id = t.id and v.field_id = field.id;
  end if;
  if current_value = 'null'::jsonb or current_value in ('""'::jsonb, '[]'::jsonb) then
    current_value := null;
  end if;

  case c ->> 'type'
    when 'field_is_set' then return current_value is not null;
    when 'field_is_empty' then return current_value is null;
    when 'field_equals' then
      return case
        when jsonb_typeof(current_value) = 'array' and coalesce(jsonb_typeof(wanted), 'missing') <> 'array'
          then current_value @> jsonb_build_array(wanted)
        else coalesce(current_value = wanted, false)
      end;
    when 'field_compare' then
      current_text := case when jsonb_typeof(current_value) = 'string' then current_value #>> '{}' else current_value::text end;
      wanted_text := case when jsonb_typeof(wanted) = 'string' then wanted #>> '{}' else wanted::text end;
      case op
        when 'not_equals' then
          return current_value is null
            or case when jsonb_typeof(current_value) = 'array' then not current_value @> jsonb_build_array(wanted)
              else current_value is distinct from wanted end;
        when 'contains' then
          return current_value is not null and case
            when jsonb_typeof(current_value) = 'array' then current_value @> jsonb_build_array(wanted)
            else strpos(lower(current_text), lower(coalesce(wanted_text, ''))) > 0 end;
        when 'not_contains' then
          return current_value is null or not case
            when jsonb_typeof(current_value) = 'array' then current_value @> jsonb_build_array(wanted)
            else strpos(lower(current_text), lower(coalesce(wanted_text, ''))) > 0 end;
        when 'gt', 'gte', 'lt', 'lte' then
          if jsonb_typeof(current_value) <> 'number' or jsonb_typeof(wanted) <> 'number' then
            return false;
          end if;
          return case op
            when 'gt' then (current_value #>> '{}')::numeric > (wanted #>> '{}')::numeric
            when 'gte' then (current_value #>> '{}')::numeric >= (wanted #>> '{}')::numeric
            when 'lt' then (current_value #>> '{}')::numeric < (wanted #>> '{}')::numeric
            else (current_value #>> '{}')::numeric <= (wanted #>> '{}')::numeric
          end;
        when 'before', 'after' then
          if current_text !~ '^\d{4}-\d{2}-\d{2}$' or wanted_text !~ '^\d{4}-\d{2}-\d{2}$' then
            return false;
          end if;
          return case op when 'before' then current_text::date < wanted_text::date else current_text::date > wanted_text::date end;
        else
          return false;
      end case;
    else
      return false;
  end case;
end;
$$;

revoke all on function public.rule_condition_ok(public.rules, jsonb, public.tasks, uuid) from public, anon, authenticated;

-- A branch's conditions: OR across groups, AND within a group (no conditions = pass). Same signature,
-- grants, and callers as before.
create or replace function public.rule_conditions_pass(r public.rules, target_task uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  t public.tasks;
  section uuid;
  g integer;
  c jsonb;
  group_ok boolean;
begin
  select * into t from public.tasks where id = target_task and deleted_at is null;
  if not found then
    return false;
  end if;
  select tp.section_id into section from public.task_projects tp
  where tp.task_id = target_task and tp.project_id = r.project_id and tp.deleted_at is null;
  if not found then
    return false;
  end if;
  if jsonb_array_length(r.conditions) = 0 then
    return true;
  end if;
  for g in select distinct public.rule_item_group(value) from jsonb_array_elements(r.conditions) order by 1 loop
    group_ok := true;
    for c in select value from jsonb_array_elements(r.conditions) where public.rule_item_group(value) = g loop
      if not coalesce(public.rule_condition_ok(r, c, t, section), false) then
        group_ok := false;
        exit;
      end if;
    end loop;
    if group_ok then
      return true;
    end if;
  end loop;
  return false;
end;
$$;

-- =============================================================================================
-- 6. Validation (the whole vocabulary; same trigger, same callers)

create or replace function public.validate_rule()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  cfg jsonb := new.trigger_config;
  item jsonb;
  kind text;
  op text;
  field public.custom_fields;
  ws uuid := (select p.workspace_id from public.projects p where p.id = new.project_id);
begin
  if cfg ? 'timezone' and (jsonb_typeof(cfg -> 'timezone') <> 'string' or length(cfg ->> 'timezone') > 64) then
    raise exception 'The rule''s time zone is not valid' using errcode = 'check_violation';
  end if;
  case new.trigger_type
    when 'section_changed' then
      if not public.rule_section_ok(new.project_id, cfg ->> 'section_id') then
        raise exception 'Choose a section in this project for the trigger' using errcode = 'check_violation';
      end if;
    when 'field_changed' then
      field := public.rule_field(new.project_id, cfg ->> 'field_id');
      if field.id is null then
        raise exception 'Choose a field in this project for the trigger' using errcode = 'check_violation';
      end if;
      if field.bound_to_sections then
        raise exception 'The section-bound Status field changes with sections: use the “Section changed” trigger'
          using errcode = 'check_violation';
      end if;
    when 'due_approaching', 'task_overdue' then
      if cfg ? 'days' and (coalesce(jsonb_typeof(cfg -> 'days'), 'missing') <> 'number' or (cfg ->> 'days')::numeric not between 0 and 30) then
        raise exception 'Days must be between 0 and 30' using errcode = 'check_violation';
      end if;
    when 'approval_decided' then
      if cfg ? 'statuses' and (
        coalesce(jsonb_typeof(cfg -> 'statuses'), 'missing') <> 'array'
        or not '["approved", "changes_requested", "rejected"]'::jsonb @> (cfg -> 'statuses')
      ) then
        raise exception 'Unknown approval status in trigger' using errcode = 'check_violation';
      end if;
    when 'inbound_received' then
      if cfg ? 'endpoint_id' and not exists (
        select 1 from public.inbound_endpoints en
        where en.id::text = cfg ->> 'endpoint_id' and en.project_id = new.project_id and en.deleted_at is null
      ) then
        raise exception 'Choose an inbound webhook of this project for the trigger' using errcode = 'check_violation';
      end if;
    when 'form_submitted' then
      if cfg ? 'form_id' and not exists (
        select 1 from public.forms fo where fo.id::text = cfg ->> 'form_id' and fo.project_id = new.project_id
      ) then
        raise exception 'Choose a form in this project for the trigger' using errcode = 'check_violation';
      end if;
    when 'tag_added' then
      if cfg ? 'tag_id' and not public.rule_tag_ok(new.project_id, cfg ->> 'tag_id', true) then
        raise exception 'Choose a tag of this workspace for the trigger' using errcode = 'check_violation';
      end if;
    when 'scheduled' then
      if coalesce(cfg ->> 'frequency', '') not in ('daily', 'workdays', 'weekly', 'monthly') then
        raise exception 'Choose how often the rule runs' using errcode = 'check_violation';
      end if;
      if cfg ? 'hour' and (jsonb_typeof(cfg -> 'hour') <> 'number' or (cfg ->> 'hour') !~ '^([0-9]|1[0-9]|2[0-3])$') then
        raise exception 'The hour is a whole number from 0 to 23' using errcode = 'check_violation';
      end if;
      if cfg ? 'weekday' and (jsonb_typeof(cfg -> 'weekday') <> 'number' or (cfg ->> 'weekday') !~ '^[0-6]$') then
        raise exception 'Choose a day of the week' using errcode = 'check_violation';
      end if;
      if cfg ? 'month_day' and (jsonb_typeof(cfg -> 'month_day') <> 'number' or (cfg ->> 'month_day') !~ '^([1-9]|1[0-9]|2[0-8])$') then
        raise exception 'The day of the month is from 1 to 28' using errcode = 'check_violation';
      end if;
    else
      null;
  end case;

  -- Branch and group keys and limits.
  perform public.validate_rule_branches(new.conditions, new.actions);
  for item in select value from jsonb_array_elements(new.conditions) loop
    kind := item ->> 'type';
    if kind in ('section_is', 'section_is_not') then
      if not public.rule_section_ok(new.project_id, item ->> 'section_id') then
        raise exception 'A condition refers to a section outside this project' using errcode = 'check_violation';
      end if;
    elsif kind in ('field_equals', 'field_is_set', 'field_is_empty') then
      if public.rule_field(new.project_id, item ->> 'field_id') is null then
        raise exception 'A condition refers to a field outside this project' using errcode = 'check_violation';
      end if;
    elsif kind = 'field_compare' then
      field := public.rule_field(new.project_id, item ->> 'field_id');
      op := item ->> 'op';
      if field.id is null then
        raise exception 'A condition refers to a field outside this project' using errcode = 'check_violation';
      end if;
      if not (item ? 'value') or item -> 'value' = 'null'::jsonb then
        raise exception 'Field comparison: choose a value to compare with' using errcode = 'check_violation';
      end if;
      if op is null or not (
        (field.bound_to_sections and op = 'not_equals')
        or (not field.bound_to_sections and (
          (field.field_type = 'number' and op in ('gt', 'gte', 'lt', 'lte', 'not_equals') and jsonb_typeof(item -> 'value') = 'number')
          or (field.field_type = 'date' and op in ('before', 'after', 'not_equals') and (item ->> 'value') ~ '^\d{4}-\d{2}-\d{2}$')
          or (field.field_type = 'text' and op in ('contains', 'not_contains', 'not_equals') and jsonb_typeof(item -> 'value') = 'string')
          or (field.field_type = 'single_select' and op = 'not_equals')
          or (field.field_type = 'multi_select' and op in ('contains', 'not_contains'))
          or (field.field_type = 'boolean' and op = 'not_equals')
        ))
      ) then
        raise exception 'Field comparison: that comparison doesn''t fit the field''s type' using errcode = 'check_violation';
      end if;
    elsif kind = 'source_is' then
      if item ->> 'source' not in ('manual', 'form', 'import', 'inbound') then
        raise exception 'Unknown task source in condition' using errcode = 'check_violation';
      end if;
    elsif kind in ('assignee_is', 'assignee_is_not', 'creator_is') then
      if coalesce(jsonb_typeof(item -> 'people'), 'missing') <> 'array' or jsonb_array_length(item -> 'people') = 0
         or exists (select 1 from jsonb_array_elements(item -> 'people') p where not public.rule_person_ok(p)) then
        raise exception 'Choose at least one person for the condition' using errcode = 'check_violation';
      end if;
    elsif kind in ('has_tag', 'lacks_tag') then
      if not public.rule_tag_ok(new.project_id, item ->> 'tag_id', true) then
        raise exception 'Choose a tag of this workspace for the condition' using errcode = 'check_violation';
      end if;
    elsif kind = 'due_within' then
      if coalesce(jsonb_typeof(item -> 'days'), 'missing') <> 'number' or (item ->> 'days') !~ '^[0-9]{1,3}$' or (item ->> 'days')::integer > 365 then
        raise exception 'Due within: choose 0 to 365 days' using errcode = 'check_violation';
      end if;
    elsif kind = 'task_type_is' then
      if coalesce(item ->> 'kind', '') not in ('task', 'milestone', 'approval') then
        raise exception 'Choose a task type' using errcode = 'check_violation';
      end if;
    elsif kind in ('title_contains', 'form_answer_contains') then
      if length(trim(coalesce(item ->> 'text', ''))) not between 1 and 200 then
        raise exception 'Write the text to look for' using errcode = 'check_violation';
      end if;
      if item ? 'question_id' and jsonb_typeof(item -> 'question_id') <> 'string' then
        raise exception 'Choose a form question' using errcode = 'check_violation';
      end if;
    elsif kind is null or kind not in (
      'assignee_is_set', 'assignee_is_empty', 'is_complete', 'is_incomplete', 'is_overdue',
      'has_due_date', 'no_due_date', 'has_open_subtasks', 'all_subtasks_done'
    ) then
      raise exception 'Unknown condition %', coalesce(kind, '(none)') using errcode = 'check_violation';
    end if;
  end loop;

  for item in select value from jsonb_array_elements(new.actions) loop
    kind := item ->> 'type';
    case kind
      when 'move_section' then
        if not public.rule_section_ok(new.project_id, item ->> 'section_id') then
          raise exception 'Move to section: choose a section in this project' using errcode = 'check_violation';
        end if;
      when 'set_field' then
        field := public.rule_field(new.project_id, item ->> 'field_id');
        if field.id is null then
          raise exception 'Set field: choose a field in this project' using errcode = 'check_violation';
        end if;
        if field.bound_to_sections and not public.rule_section_ok(new.project_id, item -> 'value' #>> '{}') then
          raise exception 'Set Status: choose one of this project''s sections' using errcode = 'check_violation';
        end if;
      when 'set_assignee' then
        if item -> 'assignee' <> 'null'::jsonb and not public.rule_person_ok(item -> 'assignee') then
          raise exception 'Set assignee: choose a person' using errcode = 'check_violation';
        end if;
      when 'add_comment' then
        if length(trim(coalesce(item ->> 'body', ''))) not between 1 and 5000 then
          raise exception 'Add comment: write the comment text' using errcode = 'check_violation';
        end if;
      when 'set_title' then
        if length(trim(coalesce(item ->> 'title', ''))) not between 1 and 500 then
          raise exception 'Rename task: write the new name' using errcode = 'check_violation';
        end if;
      when 'add_followers', 'notify' then
        if coalesce(jsonb_typeof(item -> 'people'), 'missing') <> 'array' or jsonb_array_length(item -> 'people') = 0
           or exists (select 1 from jsonb_array_elements(item -> 'people') p where not public.rule_person_ok(p)) then
          raise exception 'Choose at least one person for %', replace(kind, '_', ' ') using errcode = 'check_violation';
        end if;
        if kind = 'notify' and length(trim(coalesce(item ->> 'message', ''))) not between 1 and 1000 then
          raise exception 'Notify: write a message' using errcode = 'check_violation';
        end if;
      when 'request_approval' then
        if not public.rule_person_ok(item -> 'approver') then
          raise exception 'Request approval: choose an approver' using errcode = 'check_violation';
        end if;
      when 'send_email' then
        if item ->> 'to' is null or item ->> 'to' not in ('submitter', 'assignee', 'field', 'address') then
          raise exception 'Send email: choose a recipient' using errcode = 'check_violation';
        end if;
        if item ->> 'to' = 'field' and public.rule_field(new.project_id, item ->> 'field_id') is null then
          raise exception 'Send email: choose the field that holds the email address' using errcode = 'check_violation';
        end if;
        if item ->> 'to' = 'address' and not public.is_email(lower(trim(item ->> 'address'))) then
          raise exception 'Send email: enter a valid address' using errcode = 'check_violation';
        end if;
        if coalesce(item ->> 'template', 'requester_update') not in ('requester_update', 'due_tomorrow', 'custom') then
          raise exception 'Send email: unknown template' using errcode = 'check_violation';
        end if;
        if item ? 'include_field_id' and public.rule_field(new.project_id, item ->> 'include_field_id') is null then
          raise exception 'Send email: the included field is not in this project' using errcode = 'check_violation';
        end if;
      when 'send_slack' then
        if length(trim(coalesce(item ->> 'message', ''))) not between 1 and 4000 then
          raise exception 'Send Slack message: write the message' using errcode = 'check_violation';
        end if;
        if item ? 'use_project_webhook' and jsonb_typeof(item -> 'use_project_webhook') <> 'boolean' then
          raise exception 'Send Slack message: “use the project webhook” must be true or false' using errcode = 'check_violation';
        end if;
        if item ? 'format' and coalesce(item ->> 'format', '') not in ('text', 'blocks') then
          raise exception 'Send Slack message: the format is plain text or Block Kit' using errcode = 'check_violation';
        end if;
        if item ? 'webhook_url' then
          raise exception 'Send Slack message: webhook URLs are stored separately' using errcode = 'check_violation';
        end if;
      when 'call_webhook' then
        if item ? 'use_project_webhook' and jsonb_typeof(item -> 'use_project_webhook') <> 'boolean' then
          raise exception 'Call webhook: “use the project webhook” must be true or false' using errcode = 'check_violation';
        end if;
        if item ? 'secret_header' and item -> 'secret_header' <> 'null'::jsonb
           and not public.integration_header_ok(item ->> 'secret_header') then
          raise exception 'Call webhook: header names use letters, digits, and dashes (and can''t be a standard transport header)'
            using errcode = 'check_violation';
        end if;
        if item ? 'url' or item ? 'secret' or item ? 'signing_secret' then
          raise exception 'Call webhook: URLs and secrets are stored separately' using errcode = 'check_violation';
        end if;
      when 'delay' then
        if coalesce(jsonb_typeof(item -> 'hours'), 'missing') <> 'number' or (item ->> 'hours')::numeric not between 0.1 and 720 then
          raise exception 'Delay must be between 0.1 and 720 hours' using errcode = 'check_violation';
        end if;
      when 'complete_task', 'reopen_task' then
        null;
      when 'set_due_date' then
        if coalesce(item ->> 'mode', 'relative') = 'clear' then
          null;
        elsif item ->> 'mode' is distinct from 'relative' and item ? 'mode' then
          raise exception 'Set due date: choose a date or clear it' using errcode = 'check_violation';
        elsif coalesce(jsonb_typeof(item -> 'days'), 'missing') <> 'number' or (item ->> 'days') !~ '^-?[0-9]{1,3}$'
              or abs((item ->> 'days')::integer) > 365 then
          raise exception 'Set due date: choose −365 to 365 days' using errcode = 'check_violation';
        elsif coalesce(item ->> 'from', 'today') not in ('today', 'due_date', 'start_date') then
          raise exception 'Set due date: count from today, the due date, or the start date' using errcode = 'check_violation';
        elsif item ? 'business_days' and jsonb_typeof(item -> 'business_days') <> 'boolean' then
          raise exception 'Set due date: business days is on or off' using errcode = 'check_violation';
        end if;
      when 'add_tag', 'remove_tag' then
        if not public.rule_tag_ok(new.project_id, item ->> 'tag_id', kind = 'remove_tag') then
          raise exception '%: choose a tag of this workspace', case kind when 'add_tag' then 'Add tag' else 'Remove tag' end
            using errcode = 'check_violation';
        end if;
      when 'add_to_project' then
        if coalesce(item ->> 'project_id', '') !~* '^[0-9a-f-]{36}$' or item ->> 'project_id' = new.project_id::text or not exists (
          select 1 from public.projects p
          where p.id::text = item ->> 'project_id' and p.workspace_id = ws and p.deleted_at is null and p.archived_at is null
        ) then
          raise exception 'Add to project: choose another active project in this workspace' using errcode = 'check_violation';
        end if;
        -- Whoever writes this action must be able to add tasks there themselves.
        if not public.has_project_role((item ->> 'project_id')::uuid, 'editor') then
          raise exception 'Add to project: you need to be an Editor in that project' using errcode = 'insufficient_privilege';
        end if;
        if coalesce(item ->> 'section_id', '') <> '' and not public.rule_section_ok((item ->> 'project_id')::uuid, item ->> 'section_id') then
          raise exception 'Add to project: that section isn''t in the project' using errcode = 'check_violation';
        end if;
      when 'create_subtasks' then
        if coalesce(jsonb_typeof(item -> 'titles'), 'missing') <> 'array' or jsonb_array_length(item -> 'titles') not between 1 and 20
           or exists (
             select 1 from jsonb_array_elements(item -> 'titles') x
             where jsonb_typeof(x) <> 'string' or length(trim(x #>> '{}')) not between 1 and 500
           ) then
          raise exception 'Create subtasks: write 1 to 20 subtask names' using errcode = 'check_violation';
        end if;
        if item ? 'assignee' and item -> 'assignee' <> 'null'::jsonb and not public.rule_person_ok(item -> 'assignee') then
          raise exception 'Create subtasks: choose a person to assign' using errcode = 'check_violation';
        end if;
      when 'apply_task_template' then
        if not exists (
          select 1 from public.task_templates tt
          where tt.id::text = item ->> 'template_id' and tt.project_id = new.project_id and tt.deleted_at is null
        ) then
          raise exception 'Apply task template: choose a task template of this project' using errcode = 'check_violation';
        end if;
      else
        raise exception 'Unknown action %', coalesce(kind, '(none)') using errcode = 'check_violation';
    end case;
  end loop;
  return new;
end;
$$;

-- =============================================================================================
-- 7. Running actions: one log entry per step, the new actions, and the dry run (batch 4)

create or replace function public.execute_rule_actions(r public.rules, target_task uuid, rule_actions jsonb, event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a jsonb;
  idx bigint;
  log jsonb := '[]'::jsonb;
  outcome text;
  result text;
  input jsonb;
  t public.tasks;
  field public.custom_fields;
  person uuid;
  body text;
  recipient text;
  p jsonb;
  names text;
  dry boolean := coalesce(current_setting('alhc.rule_dry_run', true), '') = 'on';
  waited boolean := false;
  target_project uuid;
  target_section uuid;
  new_due date;
  base date;
  tag_row public.tags;
  tpl public.task_templates;
  elem jsonb;
  n integer;
  counts integer[];
begin
  for a, idx in select value, ordinality from jsonb_array_elements(rule_actions) with ordinality loop
    select * into t from public.tasks where id = target_task;
    outcome := 'done';
    result := null;
    input := '{}'::jsonb;
    begin
      case a ->> 'type'
        when 'delay' then
          input := jsonb_build_object('hours', a -> 'hours');
          if dry then
            -- A test run shows what happens after the wait too (the real run re-checks the conditions).
            outcome := 'would_wait';
            waited := true;
            result := 'Wait ' || (a ->> 'hours') || ' h, then continue';
          else
            insert into public.scheduled_rule_actions (rule_id, task_id, actions, event, run_at)
            values (
              r.id, target_task,
              coalesce((select jsonb_agg(ra.value order by ra.ordinality) from jsonb_array_elements(rule_actions)
                with ordinality ra where ra.ordinality > idx), '[]'::jsonb),
              coalesce(event, '{}'::jsonb),
              now() + make_interval(secs => ((a ->> 'hours')::numeric * 3600)::double precision)
            );
            log := log || jsonb_build_array(jsonb_build_object(
              'step', idx, 'type', 'delay', 'outcome', 'scheduled', 'hours', a -> 'hours', 'input', input,
              'result', 'Waiting ' || (a ->> 'hours') || ' h before the next step'
            ));
            return log;
          end if;

        when 'move_section' then
          input := jsonb_build_object('section', (select s.name from public.sections s where s.id::text = a ->> 'section_id'));
          if not public.move_task_to_section(target_task, r.project_id, (a ->> 'section_id')::uuid) then
            outcome := 'unchanged';
            result := 'Already in “' || coalesce(input ->> 'section', '?') || '”';
          else
            result := 'Moved to “' || coalesce(input ->> 'section', '?') || '”';
          end if;

        when 'set_field' then
          field := public.rule_field(r.project_id, a ->> 'field_id');
          input := jsonb_build_object('field', field.name, 'value', public.rule_field_value_label(field, a -> 'value'));
          if field.id is null then
            outcome := 'missing_field';
            result := 'The field was removed';
          elsif field.bound_to_sections then
            -- The section-bound Status field IS the section: setting it moves the task, nothing is stored.
            if not public.move_task_to_section(target_task, r.project_id, (a -> 'value' #>> '{}')::uuid) then
              outcome := 'unchanged';
            end if;
          else
            insert into public.task_field_values (task_id, field_id, value)
            values (target_task, field.id, a -> 'value')
            on conflict (task_id, field_id) do update set value = excluded.value
            where public.task_field_values.value is distinct from excluded.value;
            if not found then outcome := 'unchanged'; end if;
          end if;
          if field.id is not null then
            result := case when outcome = 'unchanged' then '“' || field.name || '” was already ' else '“' || field.name || '” set to ' end
              || (input ->> 'value');
          end if;

        when 'set_assignee' then
          person := case when a -> 'assignee' = 'null'::jsonb or a -> 'assignee' is null then null
            else public.resolve_rule_person(a -> 'assignee', target_task) end;
          input := jsonb_build_object('person', coalesce(public.rule_profile_name(person), 'nobody'));
          update public.tasks set assignee_id = person
          where id = target_task and assignee_id is distinct from person;
          if not found then
            outcome := 'unchanged';
            result := case when person is null then 'Already unassigned' else 'Already assigned to ' || (input ->> 'person') end;
          else
            result := case when person is null then 'Unassigned' else 'Assigned to ' || (input ->> 'person') end;
          end if;

        when 'add_comment' then
          body := left(public.render_rule_text(a ->> 'body', target_task, r.project_id, event), 10000);
          input := jsonb_build_object('text', left(body, 300));
          if body = '' then
            outcome := 'empty';
            result := 'Nothing to say (the comment came out empty)';
          else
            insert into public.comments (task_id, author_id, rule_id, body) values (target_task, null, r.id, body);
            result := 'Commented: “' || left(body, 200) || case when length(body) > 200 then '…' else '' end || '”';
          end if;

        when 'set_title' then
          body := left(public.render_rule_text(a ->> 'title', target_task, r.project_id, event), 500);
          input := jsonb_build_object('title', body);
          if body = '' then
            outcome := 'empty';
            result := 'The new name came out empty, so the name was kept';
          else
            update public.tasks set title = body where id = target_task and title is distinct from body;
            if not found then
              outcome := 'unchanged';
              result := 'Already named “' || left(body, 200) || '”';
            else
              result := 'Renamed to “' || left(body, 200) || '”';
            end if;
          end if;

        when 'add_followers' then
          select string_agg(coalesce(public.rule_profile_name(u.person), '?'), ', ') into names
          from unnest(public.rule_people(a -> 'people', target_task)) as u(person);
          input := jsonb_build_object('people', coalesce(names, ''));
          for p in select value from jsonb_array_elements(a -> 'people') loop
            perform public.follow_task(target_task, public.resolve_rule_person(p, target_task));
          end loop;
          result := case when names is null then 'Nobody to add' else 'Followers: ' || names end;

        when 'notify' then
          body := left(public.render_rule_text(a ->> 'message', target_task, r.project_id, event), 1000);
          select string_agg(coalesce(public.rule_profile_name(u.person), '?'), ', ') into names
          from unnest(public.rule_people(a -> 'people', target_task)) as u(person);
          input := jsonb_build_object('people', coalesce(names, ''), 'message', left(body, 300));
          for person in
            select distinct public.resolve_rule_person(pp.value, target_task)
            from jsonb_array_elements(a -> 'people') pp
          loop
            perform public.notify_with(person, target_task, 'rule', null, jsonb_build_object('message', body));
          end loop;
          result := case when names is null then 'Nobody to notify' else 'Notified ' || names || ': “' || left(body, 200) || '”' end;

        when 'request_approval' then
          person := public.resolve_rule_person(a -> 'approver', target_task);
          input := jsonb_build_object('approver', public.rule_profile_name(person));
          if person is null then
            outcome := 'no_approver';
            result := 'No approver (the task has nobody in that role)';
          elsif exists (
            select 1 from public.approval_requests ar
            where ar.task_id = target_task and ar.approver_id = person and ar.deleted_at is null
              and ar.status in ('pending', 'changes_requested')
          ) then
            outcome := 'already_open';
            result := public.rule_profile_name(person) || ' already has an open approval';
          else
            perform public.create_approval(
              target_task, person,
              public.render_rule_text(a ->> 'note', target_task, r.project_id, event),
              true,
              coalesce(nullif(public.render_rule_text(a ->> 'title', target_task, r.project_id, event), ''), 'Approve this work')
            );
            result := 'Asked ' || public.rule_profile_name(person) || ' to approve';
          end if;

        when 'send_email' then
          recipient := case a ->> 'to'
            when 'submitter' then (
              select s.submitter_email from public.form_submissions s
              where s.task_id = target_task and s.deleted_at is null order by s.created_at desc limit 1
            )
            when 'assignee' then (select pr.email from public.profiles pr where pr.id = t.assignee_id)
            when 'field' then public.task_field_text(target_task, (a ->> 'field_id')::uuid)
            when 'address' then a ->> 'address'
          end;
          -- The log names who, never the address (run logs are readable by every project member).
          input := jsonb_build_object('to', case a ->> 'to'
            when 'submitter' then 'the form submitter' when 'assignee' then 'the assignee'
            when 'field' then 'the address in a field' else 'a fixed address' end,
            'template', coalesce(a ->> 'template', 'requester_update'));
          if not public.is_email(lower(trim(coalesce(recipient, '')))) then
            outcome := 'no_recipient';
            result := 'No email address for ' || (input ->> 'to');
          elsif dry then
            outcome := 'would_send';
            result := 'Email to ' || (input ->> 'to');
          else
            perform public.enqueue_email(
              recipient,
              coalesce(a ->> 'template', 'requester_update'),
              nullif(public.render_rule_text_as(a ->> 'subject', target_task, r.project_id, event, 'email'), ''),
              jsonb_build_object(
                'task_title', t.title,
                'request_label', public.task_request_label(target_task),
                'project_name', (select pj.name from public.projects pj where pj.id = r.project_id),
                'section_name', public.render_rule_text('{section}', target_task, r.project_id, event),
                'due_on', t.due_on,
                'message', nullif(public.render_rule_text_as(a ->> 'message', target_task, r.project_id, event, 'email'), ''),
                'field', case when a ? 'include_field_id' then jsonb_build_object(
                  'name', (select f.name from public.custom_fields f where f.id::text = a ->> 'include_field_id'),
                  'value', public.task_field_text(target_task, (a ->> 'include_field_id')::uuid)
                ) end
              ),
              target_task
            );
            outcome := 'queued';
            result := 'Email queued to ' || (input ->> 'to');
          end if;

        when 'send_slack', 'call_webhook' then
          -- Never the URL, not even its redacted hint (suite 90 pins that run logs carry none).
          input := jsonb_build_object('target', case
            when a ->> 'use_project_webhook' is distinct from 'true' and (a ? 'webhook_ref' or a ? 'url_ref') then 'this action''s own webhook'
            else 'the project webhook' end);
          if dry then
            outcome := 'would_send';
            result := case a ->> 'type' when 'send_slack' then 'Slack message to ' else 'Webhook call to ' end || (input ->> 'target');
          elsif public.enqueue_integration(r, target_task, a, event) is null then
            outcome := 'empty';
            result := 'The message came out empty, so nothing was sent';
          else
            outcome := 'queued';
            result := case a ->> 'type' when 'send_slack' then 'Slack message queued to ' else 'Webhook call queued to ' end || (input ->> 'target');
          end if;

        when 'complete_task' then
          update public.tasks set completed_at = now() where id = target_task and completed_at is null;
          if not found then
            outcome := 'unchanged';
            result := 'Already complete';
          else
            result := 'Marked complete';
          end if;

        when 'reopen_task' then
          update public.tasks set completed_at = null where id = target_task and completed_at is not null;
          if not found then
            outcome := 'unchanged';
            result := 'Already open';
          else
            result := 'Reopened';
          end if;

        when 'set_due_date' then
          if coalesce(a ->> 'mode', 'relative') = 'clear' then
            input := jsonb_build_object('mode', 'clear');
            update public.tasks set due_on = null where id = target_task and due_on is not null;
            if not found then
              outcome := 'unchanged';
              result := 'Already has no due date';
            else
              result := 'Due date cleared';
            end if;
          else
            base := case coalesce(a ->> 'from', 'today')
              when 'due_date' then coalesce(t.due_on, public.rule_local_today(r))
              when 'start_date' then coalesce(t.start_on, public.rule_local_today(r))
              else public.rule_local_today(r)
            end;
            new_due := public.rule_add_days(base, (a ->> 'days')::integer, coalesce((a ->> 'business_days')::boolean, false),
              public.project_work_week(r.project_id));
            input := jsonb_build_object('days', a -> 'days', 'business_days', coalesce((a ->> 'business_days')::boolean, false),
              'from', coalesce(a ->> 'from', 'today'));
            -- A start date after the new due date would break the date order, so it is cleared.
            update public.tasks
            set due_on = new_due,
                start_on = case when start_on > new_due then null else start_on end,
                start_at = case when start_on > new_due then null else start_at end
            where id = target_task and due_on is distinct from new_due;
            if not found then
              outcome := 'unchanged';
              result := 'Already due ' || to_char(new_due, 'Mon FMDD, YYYY');
            else
              result := 'Due date set to ' || to_char(new_due, 'Dy, Mon FMDD, YYYY');
            end if;
          end if;

        when 'add_tag', 'remove_tag' then
          select * into tag_row from public.tags tg where tg.id::text = a ->> 'tag_id' and tg.deleted_at is null;
          input := jsonb_build_object('tag', tag_row.name);
          if tag_row.id is null then
            outcome := 'missing_tag';
            result := 'The tag was removed';
          elsif a ->> 'type' = 'add_tag' then
            if tag_row.archived_at is not null then
              outcome := 'archived';
              result := 'Tag “' || tag_row.name || '” is archived, so it wasn''t added';
            elsif exists (select 1 from public.task_tags tt where tt.task_id = target_task and tt.tag_id = tag_row.id and tt.deleted_at is null) then
              outcome := 'unchanged';
              result := 'Already tagged “' || tag_row.name || '”';
            else
              insert into public.task_tags (task_id, tag_id, created_by) values (target_task, tag_row.id, null);
              result := 'Tagged “' || tag_row.name || '”';
            end if;
          else
            update public.task_tags set deleted_at = now()
            where task_id = target_task and tag_id = tag_row.id and deleted_at is null;
            if not found then
              outcome := 'unchanged';
              result := 'Wasn''t tagged “' || tag_row.name || '”';
            else
              result := 'Removed tag “' || tag_row.name || '”';
            end if;
          end if;

        when 'add_to_project' then
          target_project := (a ->> 'project_id')::uuid;
          target_section := nullif(a ->> 'section_id', '')::uuid;
          input := jsonb_build_object(
            'project', (select pj.name from public.projects pj where pj.id = target_project),
            'section', (select s.name from public.sections s where s.id = target_section)
          );
          if not exists (
            select 1 from public.projects pj where pj.id = target_project and pj.deleted_at is null and pj.archived_at is null
          ) then
            raise exception 'Add to project: that project was removed or archived' using errcode = 'check_violation';
          end if;
          -- The rule acts for its owner (else its creator), who must still be an Editor there.
          if coalesce(public.profile_project_role(coalesce(r.owner_id, r.created_by), target_project), '') not in ('editor', 'admin', 'owner') then
            raise exception 'Add to project: the rule''s owner can''t add tasks to “%”', coalesce(input ->> 'project', 'that project')
              using errcode = 'insufficient_privilege';
          end if;
          if exists (select 1 from public.task_projects tp where tp.task_id = target_task and tp.project_id = target_project and tp.deleted_at is null) then
            outcome := 'unchanged';
            result := 'Already in “' || (input ->> 'project') || '”';
          else
            insert into public.task_projects (task_id, project_id, section_id, sort_order, deleted_at)
            values (target_task, target_project, target_section, coalesce((
              select max(m.sort_order) from public.task_projects m
              where m.project_id = target_project and m.section_id is not distinct from target_section and m.deleted_at is null
            ), 0) + 1024, null)
            on conflict (task_id, project_id) do update
              set deleted_at = null, section_id = excluded.section_id, sort_order = excluded.sort_order;
            result := 'Added to “' || (input ->> 'project') || '”' || coalesce(' in “' || (input ->> 'section') || '”', '');
          end if;

        when 'create_subtasks' then
          person := case when a ? 'assignee' and a -> 'assignee' <> 'null'::jsonb
            then public.resolve_rule_person(a -> 'assignee', target_task) end;
          n := 0;
          names := null;
          for elem in select value from jsonb_array_elements(a -> 'titles') loop
            body := left(public.render_rule_text(elem #>> '{}', target_task, r.project_id, event), 500);
            continue when body = '';
            insert into public.tasks (parent_task_id, title, assignee_id, subtask_order, workspace_id)
            values (target_task, body, person, coalesce((
              select max(s.subtask_order) from public.tasks s where s.parent_task_id = target_task and s.deleted_at is null
            ), 0) + 1024, t.workspace_id);
            n := n + 1;
            names := coalesce(names || ', ', '') || '“' || left(body, 80) || '”';
          end loop;
          input := jsonb_build_object('count', jsonb_array_length(a -> 'titles'), 'assignee', public.rule_profile_name(person));
          result := 'Created ' || n || ' subtask' || case when n = 1 then '' else 's' end || coalesce(': ' || names, '');
          if n = 0 then outcome := 'empty'; end if;

        when 'apply_task_template' then
          select * into tpl from public.task_templates tt
          where tt.id::text = a ->> 'template_id' and tt.project_id = r.project_id and tt.deleted_at is null;
          input := jsonb_build_object('template', tpl.name);
          if tpl.id is null then
            outcome := 'missing_template';
            result := 'The task template was removed';
          else
            counts := array[0, 0, 0];
            for elem in select value from jsonb_array_elements(tpl.subtasks) loop
              body := left(trim(case when jsonb_typeof(elem) = 'string' then elem #>> '{}' else elem ->> 'title' end), 500);
              continue when coalesce(body, '') = '';
              insert into public.tasks (parent_task_id, title, subtask_order, workspace_id)
              values (target_task, body, coalesce((
                select max(s.subtask_order) from public.tasks s where s.parent_task_id = target_task and s.deleted_at is null
              ), 0) + 1024, t.workspace_id);
              counts[1] := counts[1] + 1;
            end loop;
            for elem in select value from jsonb_array_elements(tpl.tags) loop
              if exists (select 1 from public.tags tg where tg.id::text = elem #>> '{}' and tg.deleted_at is null and tg.archived_at is null)
                 and not exists (select 1 from public.task_tags tt where tt.task_id = target_task and tt.tag_id::text = elem #>> '{}' and tt.deleted_at is null) then
                insert into public.task_tags (task_id, tag_id, created_by) values (target_task, (elem #>> '{}')::uuid, null);
                counts[2] := counts[2] + 1;
              end if;
            end loop;
            for elem in select value from jsonb_array_elements(tpl.field_values) loop
              -- A value that no longer fits its field is left out (like the copy engine).
              begin
                insert into public.task_field_values (task_id, field_id, value)
                values (target_task, (elem ->> 'field_id')::uuid, elem -> 'value')
                on conflict (task_id, field_id) do update set value = excluded.value
                where public.task_field_values.value is distinct from excluded.value;
                if found then counts[3] := counts[3] + 1; end if;
              exception when others then
                null;
              end;
            end loop;
            result := 'Applied “' || tpl.name || '”: ' || counts[1] || ' subtasks, ' || counts[2] || ' tags, ' || counts[3] || ' field values';
          end if;
      end case;
    exception when others then
      -- Keep the steps that ran (and this one's error) with the failure: run_rule logs them.
      log := log || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'step', idx, 'type', a ->> 'type', 'outcome', 'error', 'error', sqlerrm,
        'input', nullif(input, '{}'::jsonb), 'after_wait', case when waited then true end
      )));
      raise exception using message = sqlerrm, errcode = sqlstate, detail = log::text;
    end;
    log := log || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'step', idx, 'type', a ->> 'type', 'outcome', outcome, 'result', result,
      'input', nullif(input, '{}'::jsonb), 'after_wait', case when waited and outcome <> 'would_wait' then true end
    )));
  end loop;
  return log;
end;
$$;

revoke all on function public.execute_rule_actions(public.rules, uuid, jsonb, jsonb) from public, anon, authenticated;

-- =============================================================================================
-- 8. Running a rule (same signature; a failed run keeps its steps)

-- The pause notice: an Inbox item (kind rule) to the rule's owner (else its creator) on the task the
-- last failure happened on, written in the rule's name (no actor), through notify_with — so only an
-- owner who can still read the task hears about it, and their notification settings apply.
create or replace function public.notify_rule_paused(r public.rules, target_task uuid, error_message text, failures integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous_rule text := coalesce(current_setting('alhc.rule_id', true), '');
begin
  perform set_config('alhc.rule_id', r.id::text, true);
  perform public.notify_with(coalesce(r.owner_id, r.created_by), target_task, 'rule', null, jsonb_build_object(
    'message', 'Rule “' || r.name || '” was paused after ' || failures || ' failed runs in a row: '
      || left(coalesce(error_message, 'it failed'), 300) || '. Fix it, then turn it back on.',
    'rule_paused', true,
    'project_id', r.project_id
  ));
  perform set_config('alhc.rule_id', previous_rule, true);
end;
$$;

revoke all on function public.notify_rule_paused(public.rules, uuid, text, integer) from public, anon, authenticated;

create or replace function public.run_rule(r public.rules, target_task uuid, event jsonb, rule_actions jsonb default null, dedupe text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  chain text := coalesce(current_setting('alhc.rule_chain', true), '');
  previous_rule text := coalesce(current_setting('alhc.rule_id', true), '');
  previous_run text := coalesce(current_setting('alhc.rule_run_id', true), '');
  depth integer := case when chain = '' then 0 else array_length(string_to_array(chain, ','), 1) end;
  log jsonb;
  steps jsonb;
  run_status text;
  run_id uuid := gen_random_uuid();
  chosen_branch integer;
  error_detail text;
  error_message text;
  failures integer;
  still_on boolean;
begin
  if dedupe is not null and exists (
    select 1 from public.rule_runs rr where rr.rule_id = r.id and rr.task_id = target_task and rr.dedupe_key = dedupe
  ) then
    return 'duplicate';
  end if;

  -- Loop guard (Automations V2): a rule never re-enters its own chain, and chains stop at three rules.
  if position(r.id::text in chain) > 0 or depth >= 3 then
    insert into public.rule_runs (rule_id, task_id, trigger_type, status, detail)
    values (r.id, target_task, r.trigger_type, 'skipped', jsonb_build_object(
      'reason', case when position(r.id::text in chain) > 0 then 'loop' else 'depth_limit' end, 'chain', chain
    ));
    return 'skipped';
  end if;

  -- Rate limit per rule: at most 1,000 runs an hour across all tasks (a runaway rule can't flood the log
  -- or the outboxes); one "rate_limited" row a minute says so.
  if (
    select count(*) from (
      select 1 from public.rule_runs rr
      where rr.rule_id = r.id and rr.created_at > now() - interval '1 hour' and rr.status <> 'skipped'
      limit 1000
    ) recent
  ) >= 1000 then
    if not exists (
      select 1 from public.rule_runs rr
      where rr.rule_id = r.id and rr.status = 'skipped' and rr.detail ->> 'reason' = 'rate_limited'
        and rr.created_at > now() - interval '1 minute'
    ) then
      insert into public.rule_runs (rule_id, task_id, trigger_type, status, detail)
      values (r.id, target_task, r.trigger_type, 'skipped', jsonb_build_object('reason', 'rate_limited'));
    end if;
    return 'skipped';
  end if;

  if (
    select count(*) from public.rule_runs rr
    where rr.rule_id = r.id and rr.task_id = target_task
      and rr.status in ('succeeded', 'scheduled') and rr.created_at > now() - interval '1 hour'
  ) >= 20 then
    insert into public.rule_runs (rule_id, task_id, trigger_type, status, detail)
    values (r.id, target_task, r.trigger_type, 'skipped', jsonb_build_object('reason', 'throttled'));
    return 'skipped';
  end if;

  chosen_branch := public.rule_pick_branch(r, target_task, rule_actions);
  if chosen_branch is null then
    return 'conditions';
  end if;

  perform set_config('alhc.rule_chain', case when chain = '' then r.id::text else chain || ',' || r.id::text end, true);
  perform set_config('alhc.rule_id', r.id::text, true);
  perform set_config('alhc.rule_run_id', run_id::text, true);
  begin
    log := public.execute_rule_actions(r, target_task, coalesce(rule_actions, public.rule_branch_items(r.actions, chosen_branch)), event);
    run_status := case when log @> '[{"outcome": "scheduled"}]'::jsonb then 'scheduled' else 'succeeded' end;
  exception when others then
    get stacked diagnostics error_message = message_text, error_detail = pg_exception_detail;
    log := jsonb_build_object('error', error_message);
    begin
      steps := case when left(coalesce(error_detail, ''), 1) = '[' then error_detail::jsonb end;
    exception when others then
      steps := null;
    end;
    run_status := 'failed';
  end;
  perform set_config('alhc.rule_chain', chain, true);
  perform set_config('alhc.rule_id', previous_rule, true);
  perform set_config('alhc.rule_run_id', previous_run, true);

  insert into public.rule_runs (id, rule_id, task_id, trigger_type, status, detail, dedupe_key)
  values (run_id, r.id, target_task, r.trigger_type, run_status,
    jsonb_build_object('actions', log, 'event', coalesce(event, '{}'::jsonb))
      || case when steps is not null then jsonb_build_object('steps', steps) else '{}'::jsonb end
      || case when public.rule_branch_count(r.conditions, r.actions) > 1
        then jsonb_build_object('branch', chosen_branch) else '{}'::jsonb end, dedupe);

  -- Auto-pause (Automations V2): five failed runs in a row turn the rule off and tell its owner; a
  -- run that works resets the count. Turning the rule back on (Resume) clears the pause.
  if run_status = 'failed' then
    update public.rules set consecutive_failures = consecutive_failures + 1
    where id = r.id
    returning consecutive_failures, enabled into failures, still_on;
    if failures >= 5 and still_on then
      update public.rules
      set enabled = false, paused_at = now(), pause_reason = left(coalesce(error_message, 'Failed'), 500)
      where id = r.id;
      perform public.notify_rule_paused(r, target_task, error_message, failures);
    end if;
  elsif run_status in ('succeeded', 'scheduled') then
    update public.rules set consecutive_failures = 0 where id = r.id and consecutive_failures > 0;
  end if;
  return run_status;
end;
$$;

-- =============================================================================================
-- 9. Firing rules (the import and copy checks stay first, exactly as they were)

create or replace function public.fire_rules(trigger_kind text, target_task uuid, target_project uuid, event jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rules;
  cfg jsonb;
begin
  if public.import_context_id() is not null then
    return;
  end if;
  if public.copy_context_id() is not null then
    return;
  end if;
  -- A dry run (test_rule) shows only the tested rule's own steps.
  if coalesce(current_setting('alhc.rule_dry_run', true), '') = 'on' then
    return;
  end if;
  for r in
    select ru.* from public.rules ru
    join public.projects p on p.id = ru.project_id and p.deleted_at is null and p.archived_at is null
    join public.task_projects tp on tp.project_id = ru.project_id and tp.task_id = target_task and tp.deleted_at is null
    where ru.enabled and ru.deleted_at is null and ru.trigger_type = trigger_kind
      and (target_project is null or ru.project_id = target_project)
    order by ru.sort_order, ru.created_at
  loop
    cfg := r.trigger_config;
    continue when trigger_kind = 'section_changed' and cfg ->> 'section_id' is distinct from event ->> 'section_id';
    continue when trigger_kind = 'field_changed' and (
      cfg ->> 'field_id' is distinct from event ->> 'field_id'
      or (cfg ? 'option_id' and not coalesce(
        event -> 'value' = cfg -> 'option_id' or event -> 'value' @> jsonb_build_array(cfg -> 'option_id'), false
      ))
    );
    continue when trigger_kind = 'approval_decided' and cfg ? 'statuses'
      and not (cfg -> 'statuses') ? (event ->> 'status');
    continue when trigger_kind = 'form_submitted' and cfg ? 'form_id' and cfg ->> 'form_id' is distinct from event ->> 'form_id';
    continue when trigger_kind = 'inbound_received' and cfg ? 'endpoint_id'
      and cfg ->> 'endpoint_id' is distinct from event ->> 'endpoint_id';
    continue when trigger_kind = 'tag_added' and cfg ? 'tag_id' and cfg ->> 'tag_id' is distinct from event ->> 'tag_id';
    -- "Also run when another rule makes the change" off: only people's changes fire it.
    continue when public.rule_context_id() is not null and not r.run_on_rule_changes;
    perform public.run_rule(r, target_task, event);
  end loop;
end;
$$;

-- =============================================================================================
-- 10. Where the new triggers fire (all skip subtasks: rules act on top-level tasks)

create or replace function public.rules_on_task_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  parent public.tasks;
begin
  if new.deleted_at is null and new.parent_task_id is null then
    if new.assignee_id is distinct from old.assignee_id then
      perform public.fire_rules('assignee_changed', new.id, null, jsonb_build_object('assignee_id', new.assignee_id));
    end if;
    if old.completed_at is null and new.completed_at is not null then
      perform public.fire_rules('task_completed', new.id, null, jsonb_build_object('completed_at', new.completed_at));
    elsif old.completed_at is not null and new.completed_at is null then
      perform public.fire_rules('task_reopened', new.id, null, '{}'::jsonb);
    end if;
    -- Like section and field changes: not for dates set in the transaction that made the task.
    if new.due_on is distinct from old.due_on
       and (public.rule_context_id() is not null or new.created_at <> now()) then
      perform public.fire_rules('due_date_changed', new.id, null, jsonb_build_object(
        'due_on', new.due_on, 'from_due_on', old.due_on
      ));
    end if;
  end if;

  -- A subtask was finished: when it was the parent's last open one, "all subtasks done" fires on the
  -- (top-level) parent. Subtasks finished together fire once (the last of them by id).
  if new.parent_task_id is not null and new.deleted_at is null
     and old.completed_at is null and new.completed_at is not null then
    select * into parent from public.tasks
    where id = new.parent_task_id and deleted_at is null and parent_task_id is null;
    if found
       and not exists (
         select 1 from public.tasks s where s.parent_task_id = parent.id and s.deleted_at is null and s.completed_at is null
       )
       and new.id = (
         select s.id from public.tasks s
         where s.parent_task_id = parent.id and s.deleted_at is null and s.completed_at = new.completed_at
         order by s.id desc limit 1
       ) then
      perform public.fire_rules('subtasks_completed', parent.id, null, jsonb_build_object('subtask_id', new.id));
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.rules_on_task_update() from public, anon, authenticated;

create or replace trigger tasks_rules
after update of assignee_id, completed_at, due_on on public.tasks
for each row execute function public.rules_on_task_update();

create or replace function public.rules_on_comment_added()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is null and exists (
    select 1 from public.tasks t where t.id = new.task_id and t.deleted_at is null and t.parent_task_id is null
  ) then
    perform public.fire_rules('comment_added', new.task_id, null, jsonb_build_object(
      'comment_id', new.id, 'author_id', new.author_id, 'by_rule', new.rule_id is not null,
      'email', new.email_direction
    ));
  end if;
  return null;
end;
$$;

revoke all on function public.rules_on_comment_added() from public, anon, authenticated;

create or replace trigger comments_zz_rules
after insert on public.comments
for each row execute function public.rules_on_comment_added();

create or replace function public.rules_on_attachment_added()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is null and exists (
    select 1 from public.tasks t where t.id = new.task_id and t.deleted_at is null and t.parent_task_id is null
  ) then
    perform public.fire_rules('attachment_added', new.task_id, null, jsonb_build_object(
      'attachment_id', new.id, 'file_name', left(new.file_name, 200), 'source', new.source
    ));
  end if;
  return null;
end;
$$;

revoke all on function public.rules_on_attachment_added() from public, anon, authenticated;

create or replace trigger task_attachments_zz_rules
after insert on public.task_attachments
for each row execute function public.rules_on_attachment_added();

create or replace function public.rules_on_tag_added()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is null and exists (
    select 1 from public.tasks t
    where t.id = new.task_id and t.deleted_at is null and t.parent_task_id is null
      and (public.rule_context_id() is not null or t.created_at <> now())
  ) then
    perform public.fire_rules('tag_added', new.task_id, null, jsonb_build_object('tag_id', new.tag_id));
  end if;
  return null;
end;
$$;

revoke all on function public.rules_on_tag_added() from public, anon, authenticated;

create or replace trigger task_tags_zz_rules
after insert on public.task_tags
for each row execute function public.rules_on_tag_added();

-- A task already living elsewhere is added to this project (multi-homing): fires in this project only.
create or replace function public.rules_on_task_added_to_project()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is null
     and (tg_op = 'INSERT' or old.deleted_at is not null)
     and exists (
       select 1 from public.tasks t
       where t.id = new.task_id and t.deleted_at is null and t.parent_task_id is null
         and t.home_project_id is distinct from new.project_id
         and (public.rule_context_id() is not null or t.created_at <> now())
     ) then
    perform public.fire_rules('task_added_from_project', new.task_id, new.project_id, jsonb_build_object(
      'project_id', new.project_id,
      'home_project_id', (select t.home_project_id from public.tasks t where t.id = new.task_id)
    ));
  end if;
  return null;
end;
$$;

revoke all on function public.rules_on_task_added_to_project() from public, anon, authenticated;

create or replace trigger task_projects_zz_rules_added
after insert or update of deleted_at on public.task_projects
for each row execute function public.rules_on_task_added_to_project();

-- =============================================================================================
-- 11. The scheduler: delayed actions, due soon, overdue, and scheduled rules

create or replace function public.workflow_tick()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  job public.scheduled_rule_actions;
  r public.rules;
  t record;
  days integer;
  local_today date;
  delayed integer := 0;
  due integer := 0;
  overdue integer := 0;
  scheduled integer := 0;
  outcome text;
  slot timestamptz;
begin
  for job in
    select * from public.scheduled_rule_actions
    where status = 'pending' and run_at <= now() and deleted_at is null
    order by run_at
    limit 500
    for update skip locked
  loop
    select * into r from public.rules where id = job.rule_id;
    if not r.enabled or r.deleted_at is not null
       or exists (select 1 from public.projects ap where ap.id = r.project_id and ap.archived_at is not null)
       or not exists (select 1 from public.tasks tk where tk.id = job.task_id and tk.deleted_at is null) then
      update public.scheduled_rule_actions set status = 'cancelled', completed_at = now() where id = job.id;
      continue;
    end if;
    outcome := public.run_rule(r, job.task_id, job.event, job.actions);
    update public.scheduled_rule_actions
    set status = case when outcome = 'failed' then 'failed' when outcome = 'conditions' then 'cancelled' else 'done' end,
        completed_at = now()
    where id = job.id;
    delayed := delayed + 1;
  end loop;

  for r in
    select ru.* from public.rules ru
    join public.projects p on p.id = ru.project_id and p.deleted_at is null and p.archived_at is null
    where ru.enabled and ru.deleted_at is null and ru.trigger_type = 'due_approaching'
  loop
    days := coalesce((r.trigger_config ->> 'days')::integer, 1);
    local_today := (now() at time zone coalesce(nullif(r.trigger_config ->> 'timezone', ''), 'UTC'))::date;
    for t in
      select tk.id, tk.due_on from public.tasks tk
      join public.task_projects tp on tp.task_id = tk.id and tp.project_id = r.project_id and tp.deleted_at is null
      where tk.deleted_at is null and tk.completed_at is null and tk.due_on = local_today + days
    loop
      outcome := public.run_rule(r, t.id, jsonb_build_object('due_on', t.due_on), null, 'due:' || t.due_on::text);
      if outcome in ('succeeded', 'scheduled') then
        due := due + 1;
      end if;
    end loop;
  end loop;

  -- Overdue: once per task and due date, when it is `days` days overdue (1 = the day after the due
  -- date; 0 counts as 1), with a two-day catch-up window so a missed tick still fires without waking up
  -- long-overdue tasks.
  for r in
    select ru.* from public.rules ru
    join public.projects p on p.id = ru.project_id and p.deleted_at is null and p.archived_at is null
    where ru.enabled and ru.deleted_at is null and ru.trigger_type = 'task_overdue'
  loop
    days := greatest(coalesce((r.trigger_config ->> 'days')::integer, 1), 1);
    local_today := public.rule_local_today(r);
    for t in
      select tk.id, tk.due_on from public.tasks tk
      join public.task_projects tp on tp.task_id = tk.id and tp.project_id = r.project_id and tp.deleted_at is null
      where tk.deleted_at is null and tk.completed_at is null and tk.parent_task_id is null
        and tk.due_on between local_today - days - 2 and local_today - days
    loop
      outcome := public.run_rule(r, t.id, jsonb_build_object('due_on', t.due_on), null, 'overdue:' || t.due_on::text);
      if outcome in ('succeeded', 'scheduled') then
        overdue := overdue + 1;
      end if;
    end loop;
  end loop;

  -- Scheduled rules: at each run, every open top-level task of the project that passes the rule's
  -- conditions (at most 500 per run; once per task and run).
  for r in
    select ru.* from public.rules ru
    join public.projects p on p.id = ru.project_id and p.deleted_at is null and p.archived_at is null
    where ru.enabled and ru.deleted_at is null and ru.trigger_type = 'scheduled' and ru.next_run_at <= now()
    order by ru.next_run_at
    limit 50
    for update of ru skip locked
  loop
    slot := r.next_run_at;
    for t in
      select tk.id from public.tasks tk
      join public.task_projects tp on tp.task_id = tk.id and tp.project_id = r.project_id and tp.deleted_at is null
      where tk.deleted_at is null and tk.completed_at is null and tk.parent_task_id is null
      order by tp.sort_order, tk.created_at
      limit 500
    loop
      outcome := public.run_rule(r, t.id, jsonb_build_object('scheduled_for', slot), null,
        'schedule:' || to_char(slot at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI'));
      if outcome in ('succeeded', 'scheduled') then
        scheduled := scheduled + 1;
      end if;
    end loop;
    update public.rules
    set next_run_at = public.rule_schedule_next_at(r.trigger_config, public.project_work_week(r.project_id), greatest(now(), slot))
    where id = r.id;
  end loop;

  return jsonb_build_object('delayed_actions', delayed, 'due_rules', due, 'overdue_rules', overdue, 'scheduled_rules', scheduled);
end;
$$;

-- =============================================================================================
-- 12. Run a rule by hand ("Run manually" rules, from a task's … menu)

create or replace function public.run_manual_rule(target_rule uuid, target_task uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rules;
  status text;
  last_run public.rule_runs;
begin
  select * into r from public.rules where id = target_rule and deleted_at is null;
  if not found or not public.has_project_role(r.project_id, 'viewer') then
    raise exception 'Rule not found' using errcode = 'no_data_found';
  end if;
  if r.trigger_type <> 'manual' then
    raise exception 'Only “Run manually” rules can be run from a task' using errcode = 'check_violation';
  end if;
  if not r.enabled then
    raise exception 'This rule is off' using errcode = 'check_violation';
  end if;
  -- Editors of the rule's project (the rule acts there); archived projects cap everyone at Viewer.
  if not public.has_project_role(r.project_id, 'editor') then
    raise exception 'Your role in this project doesn’t allow running rules' using errcode = 'insufficient_privilege';
  end if;
  if not exists (
    select 1 from public.tasks t
    join public.task_projects tp on tp.task_id = t.id and tp.project_id = r.project_id and tp.deleted_at is null
    where t.id = target_task and t.deleted_at is null and t.parent_task_id is null
  ) then
    raise exception 'The task isn’t in this rule’s project' using errcode = 'check_violation';
  end if;
  status := public.run_rule(r, target_task, jsonb_build_object('run_by', auth.uid()));
  -- The run this call logged (rule_runs.created_at is the transaction's start), never an older one.
  select * into last_run from public.rule_runs rr
  where rr.rule_id = r.id and rr.task_id = target_task and rr.created_at = now()
  order by rr.created_at desc limit 1;
  return jsonb_build_object(
    'status', status,
    'run_id', last_run.id,
    'detail', last_run.detail
  );
end;
$$;

revoke all on function public.run_manual_rule(uuid, uuid) from public, anon;
grant execute on function public.run_manual_rule(uuid, uuid) to authenticated;

-- =============================================================================================
-- 13. {{placeholders}} in rule text (batch 3; mirrored by src/lib/rule-placeholders.ts)

-- One placeholder's value for a task. Keys are case-insensitive, with dots or a colon:
--   task.name  task.url  task.assignee  task.creator  task.due_date  task.start_date  task.section
--   task.request_number  task.status  task.type  task.tags  project.name  form.name
--   form.field.<question label>  field.<field name> (or field:<field name>)  submitter.email
--   approval.note  rule.name  today
-- plus short aliases (assignee, due_date, section, project, request_number, submitter, …). Unknown keys
-- render empty. Values are plain text: Slack escapes them here (so a title can't ping @channel), and the
-- email renderer escapes them for HTML. task.url is the signed-in task link: an alhc-link: marker the
-- Slack and email drains turn into an absolute link, a path in comments and notifications.
create or replace function public.rule_placeholder_value(raw_key text, t public.tasks, target_project uuid, event jsonb, text_format text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  k text := lower(regexp_replace(trim(coalesce(raw_key, '')), '\s+', ' ', 'g'));
  v text;
  rest text;
  zone text;
  sub public.form_submissions;
  q jsonb;
  f public.custom_fields;
begin
  if t.id is null then
    return '';
  end if;
  if k in ('task.url', 'task.link', 'url', 'link') then
    if target_project is null then
      return '';
    end if;
    return case text_format
      when 'slack' then '<alhc-link:/projects/' || target_project || '?task=' || t.id || '|' || public.slack_escape(left(t.title, 200)) || '>'
      when 'email' then 'alhc-link:/projects/' || target_project || '?task=' || t.id
      else '/projects/' || target_project || '?task=' || t.id
    end;
  end if;

  if k in ('task.name', 'task.title', 'task', 'name', 'title') then
    v := t.title;
  elsif k in ('task.assignee', 'task.assignee.name', 'assignee') then
    v := public.rule_profile_name(t.assignee_id);
  elsif k in ('task.creator', 'task.creator.name', 'creator') then
    v := public.rule_profile_name(t.created_by);
  elsif k in ('task.due_date', 'task.due', 'due_date', 'due') then
    v := to_char(t.due_on, 'Mon FMDD, YYYY');
  elsif k in ('task.start_date', 'start_date') then
    v := to_char(t.start_on, 'Mon FMDD, YYYY');
  elsif k in ('task.section', 'section') then
    v := coalesce((select s.name from public.task_projects tp join public.sections s on s.id = tp.section_id
          where tp.task_id = t.id and tp.project_id = target_project and tp.deleted_at is null), 'No section');
  elsif k in ('task.request_number', 'task.req', 'request_number', 'req') then
    v := public.task_request_label(t.id);
  elsif k in ('task.status', 'status') then
    v := case when t.completed_at is null then 'Open' else 'Complete' end;
  elsif k in ('task.type', 'type') then
    v := initcap(t.kind);
  elsif k in ('task.tags', 'tags') then
    v := (select string_agg(tg.name, ', ' order by tg.name) from public.task_tags tt join public.tags tg on tg.id = tt.tag_id
          where tt.task_id = t.id and tt.deleted_at is null and tg.deleted_at is null);
  elsif k in ('project.name', 'project') then
    v := (select p.name from public.projects p where p.id = target_project);
  elsif k in ('submitter.email', 'submitter', 'requester.email', 'requester') then
    v := (select s.submitter_email from public.form_submissions s
          where s.task_id = t.id and s.deleted_at is null order by s.created_at desc limit 1);
  elsif k in ('form.name', 'form') then
    v := (select fo.title from public.form_submissions s join public.forms fo on fo.id = s.form_id
          where s.task_id = t.id and s.deleted_at is null order by s.created_at desc limit 1);
  elsif k like 'form.field.%' or k like 'form.answer.%' then
    rest := trim(regexp_replace(k, '^form\.(field|answer)\.', ''));
    select * into sub from public.form_submissions s
    where s.task_id = t.id and s.deleted_at is null order by s.created_at desc limit 1;
    if sub.id is not null then
      select qq.value into q from public.forms fo, jsonb_array_elements(fo.questions) qq
      where fo.id = sub.form_id and lower(trim(qq.value ->> 'label')) = rest
      limit 1;
      if q is not null and sub.answers ? (q ->> 'id') then
        v := public.form_answer_text(q, sub.answers -> (q ->> 'id'));
      end if;
    end if;
  elsif k like 'field.%' or k like 'field:%' then
    rest := trim(substr(k, 7));
    select * into f from public.custom_fields cf
    where cf.project_id = target_project and cf.deleted_at is null and lower(trim(cf.name)) = rest
    order by cf.created_at limit 1;
    if f.id is not null then
      v := case when f.bound_to_sections then (
        select s.name from public.task_projects tp join public.sections s on s.id = tp.section_id
        where tp.task_id = t.id and tp.project_id = target_project and tp.deleted_at is null
      ) else public.task_field_text(t.id, f.id) end;
    end if;
  elsif k in ('approval.note', 'approval_note') then
    v := event ->> 'note';
  elsif k in ('rule.name', 'rule') then
    v := (select r.name from public.rules r where r.id = public.rule_context_id());
  elsif k = 'today' then
    zone := public.safe_timezone(coalesce((select r.trigger_config ->> 'timezone' from public.rules r where r.id = public.rule_context_id()), 'UTC'));
    v := to_char((now() at time zone zone)::date, 'Mon FMDD, YYYY');
  end if;
  v := coalesce(v, '');
  return case when text_format = 'slack' then public.slack_escape(v) else v end;
end;
$$;

revoke all on function public.rule_placeholder_value(text, public.tasks, uuid, jsonb, text) from public, anon, authenticated;

-- Rule text in one pass: {{placeholders}} and the original {tokens} ({task}, {assignee}, {section}, …;
-- {task_link} in Slack only). Substituted values are never scanned again, so a task title can't inject
-- a token or a link. Same signature, grants, and callers as before.
create or replace function public.render_rule_text_as(template text, target_task uuid, target_project uuid, event jsonb, text_format text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  t public.tasks;
  rest text := coalesce(template, '');
  result text := '';
  m text[];
  pos integer;
  val text;
begin
  select * into t from public.tasks where id = target_task;
  loop
    m := regexp_match(rest, '(\{\{([^{}]{1,120})\}\}|\{(task_link|assignee|creator|task|req|due|approval_note|project|section)\})');
    exit when m is null;
    pos := strpos(rest, m[1]);
    if m[2] is not null then
      val := public.rule_placeholder_value(m[2], t, target_project, event, text_format);
    elsif m[3] = 'task_link' then
      -- {task_link} is a Slack token; elsewhere it stays as typed.
      val := case when text_format = 'slack' then public.slack_task_link(target_task, target_project) else m[1] end;
    else
      val := case m[3]
        when 'assignee' then coalesce(public.profile_handle(t.assignee_id), '')
        when 'creator' then coalesce(public.profile_handle(t.created_by), '')
        when 'task' then coalesce(t.title, '')
        when 'req' then coalesce(public.task_request_label(target_task), '')
        when 'due' then coalesce(to_char(t.due_on, 'Mon FMDD'), 'no due date')
        when 'approval_note' then coalesce(event ->> 'note', '')
        when 'project' then coalesce((select p.name from public.projects p where p.id = target_project), '')
        when 'section' then coalesce((
          select s.name from public.task_projects tp join public.sections s on s.id = tp.section_id
          where tp.task_id = target_task and tp.project_id = target_project
        ), 'No section')
      end;
      if text_format = 'slack' then
        val := public.slack_escape(val);
      end if;
    end if;
    result := result || left(rest, pos - 1) || coalesce(val, '');
    rest := substr(rest, pos + length(m[1]));
  end loop;
  return trim(result || rest);
end;
$$;

-- =============================================================================================
-- 14. Test a rule on a task without changing anything (batch 4)

-- Runs the rule's real engine on a task inside a subtransaction that is always rolled back, so nothing
-- it does — moves, comments, emails, notifications, subtasks, run log rows — is ever kept: the result
-- is only the explanation (each branch's conditions with pass / fail, the branch chosen, and each step
-- with what it would do). Emails, Slack, and webhooks aren't even queued (dry-run mode), waits are
-- shown and stepped over, and no other rule fires. `draft` (the builder's unsaved rule: trigger_type,
-- trigger_config, conditions, actions, name) is tested instead of the saved one; with target_rule null
-- it is a new rule of draft.project_id. Admin+ of the rule's project (the people who manage rules), and
-- the task must be a top-level task of that project the caller can read.
create or replace function public.test_rule(target_rule uuid, target_task uuid, draft jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rules;
  t public.tasks;
  rule_project uuid;
  section uuid;
  branches jsonb := '[]'::jsonb;
  conditions jsonb;
  c jsonb;
  b integer;
  chosen integer;
  steps jsonb := '[]'::jsonb;
  failure text;
  failure_detail text;
  problem text;
begin
  if target_rule is not null then
    select * into r from public.rules where id = target_rule and deleted_at is null;
    if not found or not public.has_project_role(r.project_id, 'viewer') then
      raise exception 'Rule not found' using errcode = 'no_data_found';
    end if;
    rule_project := r.project_id;
  else
    rule_project := nullif(draft ->> 'project_id', '')::uuid;
  end if;
  if rule_project is null or not public.has_project_role(rule_project, 'admin') then
    raise exception 'Only project admins and owners test rules' using errcode = 'insufficient_privilege';
  end if;
  select * into t from public.tasks where id = target_task and deleted_at is null;
  if not found or not public.has_task_role(target_task, 'viewer') then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;
  if t.parent_task_id is not null then
    raise exception 'Rules run on top-level tasks; pick the parent task' using errcode = 'check_violation';
  end if;
  select tp.section_id into section from public.task_projects tp
  where tp.task_id = target_task and tp.project_id = rule_project and tp.deleted_at is null;
  if not found then
    raise exception 'Pick a task in this rule’s project' using errcode = 'check_violation';
  end if;

  begin
    perform set_config('alhc.rule_dry_run', 'on', true);
    if draft is not null then
      -- The draft goes through the real triggers (validation, secret stash) and is rolled back with
      -- everything else.
      if target_rule is null then
        insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, conditions, actions)
        values (rule_project, coalesce(nullif(trim(draft ->> 'name'), ''), 'Rule test'), false,
          coalesce(draft ->> 'trigger_type', 'manual'), coalesce(draft -> 'trigger_config', '{}'::jsonb),
          coalesce(draft -> 'conditions', '[]'::jsonb), coalesce(draft -> 'actions', '[]'::jsonb))
        returning * into r;
      else
        update public.rules
        set trigger_type = coalesce(draft ->> 'trigger_type', trigger_type),
            trigger_config = coalesce(draft -> 'trigger_config', trigger_config),
            conditions = coalesce(draft -> 'conditions', conditions),
            actions = coalesce(draft -> 'actions', actions)
        where id = target_rule
        returning * into r;
      end if;
    end if;

    for b in 0 .. public.rule_branch_count(r.conditions, r.actions) - 1 loop
      conditions := '[]'::jsonb;
      for c in select value from jsonb_array_elements(public.rule_branch_items(r.conditions, b)) loop
        conditions := conditions || jsonb_build_array(jsonb_build_object(
          'condition', c, 'ok', coalesce(public.rule_condition_ok(r, c, t, section), false)
        ));
      end loop;
      branches := branches || jsonb_build_array(jsonb_build_object('branch', b, 'conditions', conditions));
    end loop;

    chosen := public.rule_pick_branch(r, target_task, null);
    if chosen is not null then
      perform set_config('alhc.rule_chain', r.id::text, true);
      perform set_config('alhc.rule_id', r.id::text, true);
      perform set_config('alhc.rule_run_id', gen_random_uuid()::text, true);
      begin
        steps := public.execute_rule_actions(r, target_task, public.rule_branch_items(r.actions, chosen),
          jsonb_build_object('dry_run', true));
      exception when others then
        get stacked diagnostics failure = message_text, failure_detail = pg_exception_detail;
        begin
          steps := case when left(coalesce(failure_detail, ''), 1) = '[' then failure_detail::jsonb else '[]'::jsonb end;
        exception when others then
          steps := '[]'::jsonb;
        end;
      end;
    end if;
    raise exception 'alhc_dry_run_rollback' using errcode = 'P0001';
  exception when others then
    -- Everything above is undone here. Anything but our own rollback is a problem with the draft.
    if sqlerrm <> 'alhc_dry_run_rollback' then
      problem := sqlerrm;
    end if;
  end;

  return jsonb_build_object(
    'task_id', t.id,
    'task_title', t.title,
    'trigger_type', coalesce(r.trigger_type, draft ->> 'trigger_type'),
    'branches', branches,
    'chosen_branch', chosen,
    'steps', steps,
    'error', coalesce(problem, failure),
    'invalid', problem is not null,
    'written', false
  );
end;
$$;

revoke all on function public.test_rule(uuid, uuid, jsonb) from public, anon;
grant execute on function public.test_rule(uuid, uuid, jsonb) to authenticated;

-- The rules list's health line: each rule's last run and its failures in the last 7 days (invoker:
-- rule_runs' own policy decides what the caller sees).
create or replace function public.rule_run_stats(rule_ids uuid[])
returns table (rule_id uuid, last_run_at timestamptz, last_status text, runs_7d integer, failures_7d integer)
language sql
stable
set search_path = ''
as $$
  select ids.id,
    last_run.created_at,
    last_run.status,
    (select count(*)::integer from public.rule_runs rr where rr.rule_id = ids.id and rr.created_at > now() - interval '7 days' and rr.status <> 'skipped'),
    (select count(*)::integer from public.rule_runs rr where rr.rule_id = ids.id and rr.created_at > now() - interval '7 days' and rr.status = 'failed')
  from unnest(coalesce(rule_ids, '{}'::uuid[])) ids (id)
  left join lateral (
    select rr.created_at, rr.status from public.rule_runs rr
    where rr.rule_id = ids.id and rr.deleted_at is null
    order by rr.created_at desc limit 1
  ) last_run on true
  where cardinality(rule_ids) <= 200;
$$;

revoke all on function public.rule_run_stats(uuid[]) from public, anon;
grant execute on function public.rule_run_stats(uuid[]) to authenticated;

-- =============================================================================================
-- Statements that must run last (applied by hand) go after the marker below.
-- =============================================================================================
-- TAIL
alter table public.rules drop constraint rules_trigger_type_check;
alter table public.rules rename constraint rules_trigger_type_check_v2 to rules_trigger_type_check;
