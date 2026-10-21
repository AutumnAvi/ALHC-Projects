-- ALHC Projects — Automations V3 (docs/AUTOMATIONS-GAP-CHECK.md §8–10, batches A–E).
--
-- Additive only: nothing above or below needs a statement the hosted connector refuses. The three
-- wider CHECKs (rule trigger types, dependency kinds, Inbox targets) land next to the old ones as
-- …_v3 / …_v2; 20261021020000_automations_v3_tail.sql (applied by hand) retires the old ones and
-- renames the new ones. Until then the new triggers, the new dependency kinds, and Inbox items about a
-- project are refused (the builder and the app say so) while everything else works.
--
-- Batch A — people and routing: round robin and load-balanced "Set assignee", People fields as person
--   slots everywhere (assignee, subtasks, approvers, followers, notifications, conditions), "Remove
--   followers", the "Collaborator is added" trigger, "Compare people" (e.g. the assignee is the
--   creator), and "Task came from a form" picking which form.
-- Batch B — dates: start date triggers (changed, approaching, arrived) and conditions (set / empty,
--   within, arrived), "Set start date", absolute dates (set a date; before / after / on / between
--   conditions on the due date, the start date, and date or number fields), hour and week offsets for
--   approaching / overdue / start triggers and the date actions, and schedules with a time of day,
--   every N days or weeks, and several weekdays. Business days follow the workspace's workweek
--   (Sunday–Thursday by default).
--
-- fire_rules keeps its import and copy checks first, exactly as they were; notify_with,
-- notify_message, and add_story are untouched. Every new table has RLS on, no anon privilege, and no
-- client TRUNCATE.

-- =============================================================================================
-- 0. The app's probe and the wider trigger CHECK

-- True once this migration is applied (the app reads it with an RPC; PGRST202 = not yet).
create or replace function public.automations_v3_ready()
returns boolean
language sql
stable
set search_path = ''
as $$
  select true;
$$;

revoke all on function public.automations_v3_ready() from public, anon;
grant execute on function public.automations_v3_ready() to authenticated;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'rules_trigger_type_check_v3') then
    alter table public.rules add constraint rules_trigger_type_check_v3 check (trigger_type in (
      'task_created', 'section_changed', 'field_changed', 'assignee_changed', 'due_approaching',
      'approval_decided', 'form_submitted', 'inbound_received',
      'task_completed', 'task_reopened', 'due_date_changed', 'task_overdue', 'comment_added',
      'attachment_added', 'tag_added', 'subtasks_completed', 'task_added_from_project', 'scheduled', 'manual',
      -- Automations V3
      'follower_added',
      'start_date_changed', 'start_approaching', 'start_reached'
    ));
  end if;
end $$;

-- =============================================================================================
-- 1. People slots (batch A)
--
-- A person slot in a rule is a profile id, "assignee", "creator", or (Automations V3) "field:<id>" —
-- a People field of the rule's project: the first person in it where one person is needed (assignee,
-- approver), everyone in it where several are (followers, notifications, conditions).

create or replace function public.rule_person_ok(person jsonb)
returns boolean
language sql
stable
set search_path = ''
as $$
  select person is not null and jsonb_typeof(person) = 'string' and (
    person #>> '{}' in ('assignee', 'creator')
    or exists (select 1 from public.profiles p where p.id::text = person #>> '{}')
    or ((person #>> '{}') ~* '^field:[0-9a-f-]{36}$' and exists (
      select 1 from public.custom_fields f
      where f.id::text = substr(person #>> '{}', 7) and f.field_type = 'people' and f.deleted_at is null
    ))
  );
$$;

-- A slot a rule of `target_project` may name: a field slot must be one of that project's People fields.
create or replace function public.rule_person_in_project(target_project uuid, person jsonb)
returns boolean
language sql
stable
set search_path = ''
as $$
  select public.rule_person_ok(person) and (
    (person #>> '{}') !~* '^field:'
    or exists (
      select 1 from public.custom_fields f
      where f.id::text = substr(person #>> '{}', 7) and f.project_id = target_project
        and f.field_type = 'people' and f.deleted_at is null
    )
  );
$$;

revoke all on function public.rule_person_in_project(uuid, jsonb) from public, anon;
grant execute on function public.rule_person_in_project(uuid, jsonb) to authenticated;

-- Everyone a People field names on a task, in the field's order (people who still have a profile).
create or replace function public.rule_field_people(target_task uuid, field_ref text)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(pr.id order by v.i), '{}')
  from public.task_field_values fv
  cross join lateral jsonb_array_elements_text(case when jsonb_typeof(fv.value) = 'array' then fv.value else '[]'::jsonb end)
    with ordinality v(person, i)
  join public.profiles pr on pr.id::text = v.person
  where fv.task_id = target_task and fv.field_id::text = substr(field_ref, 7);
$$;

revoke all on function public.rule_field_people(uuid, text) from public, anon, authenticated;

-- One person for a slot (same signature, grants, and callers as before): a People field gives its
-- first person.
create or replace function public.resolve_rule_person(person jsonb, target_task uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when person #>> '{}' = 'assignee' then (select t.assignee_id from public.tasks t where t.id = target_task)
    when person #>> '{}' = 'creator' then (select t.created_by from public.tasks t where t.id = target_task)
    when (person #>> '{}') ~* '^field:[0-9a-f-]{36}$' then (public.rule_field_people(target_task, person #>> '{}'))[1]
    else (select p.id from public.profiles p where p.id::text = person #>> '{}')
  end;
$$;

-- Every person a list of slots names, in the list's order without repeats (People fields expand).
create or replace function public.rule_people_ordered(people jsonb, target_task uuid)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(x.person order by x.first_seen), '{}')
  from (
    select y.person, min(y.pos) as first_seen
    from (
      select u.person, p.ordinality * 1000 + u.i as pos
      from jsonb_array_elements(case when jsonb_typeof(people) = 'array' then people else '[]'::jsonb end) with ordinality p
      cross join lateral unnest(
        case when (p.value #>> '{}') ~* '^field:[0-9a-f-]{36}$' then public.rule_field_people(target_task, p.value #>> '{}')
          else array[public.resolve_rule_person(p.value, target_task)] end
      ) with ordinality u(person, i)
      where u.person is not null
    ) y
    group by y.person
  ) x;
$$;

revoke all on function public.rule_people_ordered(jsonb, uuid) from public, anon, authenticated;

-- Same signature, grants, and callers as before; People fields now expand to everyone in them.
create or replace function public.rule_people(people jsonb, target_task uuid)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select public.rule_people_ordered(people, target_task);
$$;

-- The people a "Compare people" side names: the assignee, the creator, the collaborators (active
-- followers), or a People field.
create or replace function public.rule_side_people(side text, target_task uuid)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when side = 'assignee' then (select array_remove(array[t.assignee_id], null) from public.tasks t where t.id = target_task)
    when side = 'creator' then (select array_remove(array[t.created_by], null) from public.tasks t where t.id = target_task)
    when side = 'followers' then (
      select coalesce(array_agg(f.profile_id order by f.created_at), '{}') from public.task_followers f
      where f.task_id = target_task and f.deleted_at is null
    )
    when side ~* '^field:[0-9a-f-]{36}$' then public.rule_field_people(target_task, side)
    else '{}'::uuid[]
  end;
$$;

revoke all on function public.rule_side_people(text, uuid) from public, anon, authenticated;

-- =============================================================================================
-- 2. Round robin and load-balanced assignment (batch A)

-- Where each rule's rotation stopped, per pool of people (the pool's slots, hashed). Written only by
-- the engine; no client access at all.
create table if not exists public.rule_assignment_cursors (
  rule_id uuid not null references public.rules (id),
  pool_key text not null,
  last_profile_id uuid references public.profiles (id),
  updated_at timestamptz not null default now(),
  primary key (rule_id, pool_key)
);

alter table public.rule_assignment_cursors enable row level security;
revoke all on public.rule_assignment_cursors from anon, authenticated;
create index if not exists rule_assignment_cursors_last_profile_idx on public.rule_assignment_cursors (last_profile_id);
select public.alhc_revoke_anon_grants(array['rule_assignment_cursors']);
select public.alhc_revoke_client_truncate(array['rule_assignment_cursors']);

comment on table public.rule_assignment_cursors is
  'Automations V3: the last person a round-robin or load-balanced Set assignee picked, per rule and pool. Engine-written only.';

-- The next assignee for a round-robin ("round_robin") or load-balanced ("balanced") Set assignee: the
-- pool's people (in order, People fields expanded) who can still read the task, then — round robin —
-- the one after whoever was picked last, or — balanced — whoever has the fewest open top-level tasks
-- in the rule's project (ties go round robin). Null when nobody in the pool can take it. The pick is
-- remembered (a dry run's is rolled back with everything else).
create or replace function public.rule_pick_assignee(r public.rules, target_task uuid, a jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  pool uuid[];
  key text := md5(coalesce(a -> 'people', '[]'::jsonb)::text);
  last_pick uuid;
  last_index integer;
  n integer;
  picked uuid;
begin
  select coalesce(array_agg(x.person order by x.i), '{}') into pool
  from unnest(public.rule_people_ordered(a -> 'people', target_task)) with ordinality x(person, i)
  where public.profile_is_allowlisted(x.person) and public.profile_task_role(x.person, target_task) is not null;
  n := cardinality(pool);
  if n = 0 then
    return null;
  end if;

  insert into public.rule_assignment_cursors (rule_id, pool_key) values (r.id, key) on conflict do nothing;
  select c.last_profile_id into last_pick from public.rule_assignment_cursors c
  where c.rule_id = r.id and c.pool_key = key for update;
  last_index := coalesce(array_position(pool, last_pick), 0);

  -- Candidates in rotation order: the one after the last pick first.
  select o.person into picked
  from (
    select x.person, ((x.i - 1 - last_index + n) % n) as turn
    from unnest(pool) with ordinality x(person, i)
  ) o
  order by
    case when a ->> 'mode' = 'balanced' then (
      select count(*) from public.tasks t
      join public.task_projects tp on tp.task_id = t.id and tp.project_id = r.project_id and tp.deleted_at is null
      where t.assignee_id = o.person and t.completed_at is null and t.deleted_at is null and t.parent_task_id is null
        and t.id <> target_task
    ) else 0 end,
    o.turn
  limit 1;

  update public.rule_assignment_cursors set last_profile_id = picked, updated_at = now()
  where rule_id = r.id and pool_key = key;
  return picked;
end;
$$;

revoke all on function public.rule_pick_assignee(public.rules, uuid, jsonb) from public, anon, authenticated;

-- =============================================================================================
-- 2b. Dates (batch B)

-- A day compared with one or two days: before, after, on, on or before, on or after, between (both
-- ends included, in either order), not between. An empty day never matches (use "has no due date").
create or replace function public.rule_date_matches(d date, op text, first_day text, second_day text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  a date;
  b date;
begin
  if d is null or coalesce(first_day, '') !~ '^\d{4}-\d{2}-\d{2}$' then
    return false;
  end if;
  a := first_day::date;
  if op in ('between', 'not_between') then
    if coalesce(second_day, '') !~ '^\d{4}-\d{2}-\d{2}$' then
      return false;
    end if;
    b := second_day::date;
    return (d between least(a, b) and greatest(a, b)) = (op = 'between');
  end if;
  return case op
    when 'before' then d < a
    when 'after' then d > a
    when 'on' then d = a
    when 'on_or_before' then d <= a
    when 'on_or_after' then d >= a
    else false
  end;
end;
$$;

revoke all on function public.rule_date_matches(date, text, text, text) from public, anon, authenticated;

-- A real calendar day written YYYY-MM-DD (2026-02-30 isn't one).
create or replace function public.rule_is_day(value jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if value is null or jsonb_typeof(value) <> 'string' or (value #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$' then
    return false;
  end if;
  perform (value #>> '{}')::date;
  return true;
exception when others then
  return false;
end;
$$;

revoke all on function public.rule_is_day(jsonb) from public, anon;
grant execute on function public.rule_is_day(jsonb) to authenticated;

-- A date trigger's offset: { amount, unit: hours | days | weeks } (Automations V3), or the older
-- { days } (= days). Missing = the trigger's default (1 day; 0 for "start date arrives").
create or replace function public.rule_trigger_offset(cfg jsonb, default_days integer)
returns table (amount integer, unit text)
language sql
immutable
set search_path = ''
as $$
  select
    case
      when cfg ? 'unit' and jsonb_typeof(cfg -> 'amount') = 'number' then (cfg ->> 'amount')::numeric::integer
      when cfg ? 'unit' then default_days
      when jsonb_typeof(cfg -> 'days') = 'number' then (cfg ->> 'days')::numeric::integer
      else default_days
    end,
    case when cfg ->> 'unit' in ('hours', 'weeks') then cfg ->> 'unit' else 'days' end;
$$;

revoke all on function public.rule_trigger_offset(jsonb, integer) from public, anon, authenticated;

-- Why a date trigger's offset is refused (null = fine), for validate_rule.
create or replace function public.rule_offset_problem(cfg jsonb, legacy_max integer)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if cfg ? 'unit' then
    if coalesce(cfg ->> 'unit', '') not in ('hours', 'days', 'weeks') then
      return 'Count the time in hours, days, or weeks';
    end if;
    if coalesce(jsonb_typeof(cfg -> 'amount'), 'missing') <> 'number' or (cfg ->> 'amount') !~ '^[0-9]{1,3}$' then
      return 'Choose how many ' || (cfg ->> 'unit');
    end if;
    if (cfg ->> 'unit' = 'hours' and (cfg ->> 'amount')::integer not between 1 and 720)
       or (cfg ->> 'unit' = 'days' and (cfg ->> 'amount')::integer not between 0 and 90)
       or (cfg ->> 'unit' = 'weeks' and (cfg ->> 'amount')::integer not between 1 and 12) then
      return 'Hours go from 1 to 720, days from 0 to 90, and weeks from 1 to 12';
    end if;
  elsif cfg ? 'days' and (coalesce(jsonb_typeof(cfg -> 'days'), 'missing') <> 'number' or (cfg ->> 'days')::numeric not between 0 and legacy_max) then
    return 'Days must be between 0 and ' || legacy_max;
  end if;
  return null;
end;
$$;

-- validate_rule runs as the person saving the rule.
revoke all on function public.rule_offset_problem(jsonb, integer) from public, anon;
grant execute on function public.rule_offset_problem(jsonb, integer) to authenticated;

-- Why a Set due date / Set start date action is refused (null = fine). Shapes:
--   { mode: "clear" }
--   { mode: "date", date: "YYYY-MM-DD" }                                       (Automations V3)
--   { mode: "relative" (default), days: −365…365, unit?: days | weeks | hours, business_days?, from? }
-- Weeks are calendar weeks; hours count from now (from "today" only) and set a time.
create or replace function public.rule_date_action_problem(a jsonb, label text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  unit text := coalesce(a ->> 'unit', 'days');
begin
  case coalesce(a ->> 'mode', 'relative')
    when 'clear' then
      return null;
    when 'date' then
      if not public.rule_is_day(a -> 'date') then
        return label || ': choose a date';
      end if;
      return null;
    when 'relative' then
      null;
    else
      return label || ': choose a date or clear it';
  end case;
  if unit not in ('days', 'weeks', 'hours') then
    return label || ': count days, weeks, or hours';
  end if;
  if coalesce(jsonb_typeof(a -> 'days'), 'missing') <> 'number' or (a ->> 'days') !~ '^-?[0-9]{1,4}$' then
    return label || ': choose −365 to 365 days';
  end if;
  if (unit = 'days' and abs((a ->> 'days')::integer) > 365)
     or (unit = 'weeks' and abs((a ->> 'days')::integer) > 52)
     or (unit = 'hours' and (a ->> 'days')::integer not between 1 and 2160) then
    return label || ': up to 365 days, 52 weeks, or 2,160 hours';
  end if;
  if coalesce(a ->> 'from', 'today') not in ('today', 'due_date', 'start_date') then
    return label || ': count from today, the due date, or the start date';
  end if;
  if unit = 'hours' and coalesce(a ->> 'from', 'today') <> 'today' then
    return label || ': hours count from now';
  end if;
  if a ? 'business_days' and jsonb_typeof(a -> 'business_days') <> 'boolean' then
    return label || ': business days is on or off';
  end if;
  if unit <> 'days' and coalesce((a ->> 'business_days')::boolean, false) then
    return label || ': business days count in days';
  end if;
  return null;
end;
$$;

-- validate_rule runs as the person saving the rule.
revoke all on function public.rule_date_action_problem(jsonb, text) from public, anon;
grant execute on function public.rule_date_action_problem(jsonb, text) to authenticated;

-- Runs a Set due date (which = 'due') or Set start date (which = 'start') action on a task and says
-- what happened: { outcome, result, input }. The start date never ends up after the due date: setting
-- the due date before the start clears the start; setting the start after the due date moves the due
-- date to the start. Hours set a time (now + N hours) in the task's time zone (the rule's when the task
-- has no times yet). Milestones have no start date.
create or replace function public.rule_set_task_date(r public.rules, target_task uuid, a jsonb, which text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tasks;
  mode text := coalesce(a ->> 'mode', 'relative');
  unit text := coalesce(a ->> 'unit', 'days');
  n integer := coalesce((a ->> 'days')::numeric::integer, 0);
  business boolean := coalesce((a ->> 'business_days')::boolean, false);
  label text := case which when 'start' then 'start date' else 'due date' end;
  base date;
  new_day date;
  new_at timestamptz;
  zone text;
  input jsonb;
  changed boolean;
begin
  select * into t from public.tasks where id = target_task;
  zone := case when t.due_at is null and t.start_at is null
    then public.safe_timezone(coalesce(nullif(r.trigger_config ->> 'timezone', ''), 'UTC'))
    else public.safe_timezone(t.time_zone) end;

  if mode = 'clear' then
    input := jsonb_build_object('mode', 'clear');
    if which = 'start' then
      update public.tasks set start_on = null where id = target_task and start_on is not null;
    else
      update public.tasks set due_on = null where id = target_task and due_on is not null;
    end if;
    return jsonb_build_object('input', input) || case when found
      then jsonb_build_object('outcome', 'done', 'result', initcap(left(label, 1)) || substr(label, 2) || ' cleared')
      else jsonb_build_object('outcome', 'unchanged', 'result', 'Already has no ' || label) end;
  end if;

  if which = 'start' and t.kind = 'milestone' then
    return jsonb_build_object('outcome', 'unchanged', 'result', 'Milestones have no start date', 'input', jsonb_build_object('mode', mode));
  end if;

  if mode = 'date' then
    new_day := (a ->> 'date')::date;
    input := jsonb_build_object('date', a ->> 'date');
  else
    base := case coalesce(a ->> 'from', 'today')
      when 'due_date' then coalesce(t.due_on, public.rule_local_today(r))
      when 'start_date' then coalesce(t.start_on, public.rule_local_today(r))
      else public.rule_local_today(r)
    end;
    if unit = 'hours' then
      new_at := date_trunc('minute', now()) + make_interval(hours => n);
      new_day := (new_at at time zone zone)::date;
    elsif unit = 'weeks' then
      new_day := base + n * 7;
    else
      new_day := public.rule_add_days(base, n, business, public.project_work_week(r.project_id));
    end if;
    input := jsonb_build_object('days', n, 'unit', unit, 'business_days', business, 'from', coalesce(a ->> 'from', 'today'));
  end if;

  if which = 'due' then
    if new_at is not null then
      update public.tasks
      set due_at = new_at,
          time_zone = zone,
          start_on = case when start_on > new_day then null else start_on end,
          start_at = case when start_on > new_day or start_at > new_at then null else start_at end
      where id = target_task and due_at is distinct from new_at;
    else
      update public.tasks
      set due_on = new_day,
          start_on = case when start_on > new_day then null else start_on end,
          start_at = case when start_on > new_day then null else start_at end
      where id = target_task and due_on is distinct from new_day;
    end if;
  else
    if new_at is not null then
      update public.tasks
      set start_at = new_at,
          time_zone = zone,
          due_at = case when due_at < new_at then null else due_at end,
          due_on = case when due_on < new_day then new_day else due_on end
      where id = target_task and start_at is distinct from new_at;
    else
      update public.tasks
      set start_on = new_day,
          start_at = null,
          due_at = case when due_on < new_day then null else due_at end,
          due_on = case when due_on < new_day then new_day else due_on end
      where id = target_task and start_on is distinct from new_day;
    end if;
  end if;
  changed := found;
  if not changed then
    return jsonb_build_object('outcome', 'unchanged', 'input', input, 'result',
      'Already ' || case which when 'start' then 'starts ' else 'due ' end
      || case when new_at is not null then to_char(new_at at time zone zone, 'Mon FMDD, YYYY HH12:MI AM') else to_char(new_day, 'Mon FMDD, YYYY') end);
  end if;
  return jsonb_build_object('outcome', 'done', 'input', input, 'result',
    initcap(left(label, 1)) || substr(label, 2) || ' set to '
    || case when new_at is not null then to_char(new_at at time zone zone, 'Dy, Mon FMDD, YYYY HH12:MI AM') else to_char(new_day, 'Dy, Mon FMDD, YYYY') end
    || case when which = 'start' and t.due_on < new_day then ' (the due date moved with it)'
            when which = 'due' and t.start_on > new_day then ' (the start date was cleared)' else '' end);
end;
$$;

revoke all on function public.rule_set_task_date(public.rules, uuid, jsonb, text) from public, anon, authenticated;

-- =============================================================================================
-- 3. Conditions

-- One condition against one task (the engine and the dry run share it). `section` is the task's
-- section in the rule's project. Same signature and grants as Automations V2; V3 adds the conditions
-- marked below.
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
    when 'source_is' then
      -- A form source may name the form (Automations V3).
      return t.source = c ->> 'source' and (
        coalesce(c ->> 'form_id', '') = '' or exists (
          select 1 from public.form_submissions s
          where s.task_id = t.id and s.deleted_at is null and s.form_id::text = c ->> 'form_id'
        )
      );
    when 'person_compare' then
      -- "Compare people": a side (assignee, creator, collaborators, or a People field) is — or isn't —
      -- one of the people named (overlap; an empty side is never "is").
      return case when c ->> 'op' = 'is_not'
        then not (public.rule_side_people(c ->> 'left', t.id) && public.rule_people(c -> 'people', t.id))
        else public.rule_side_people(c ->> 'left', t.id) && public.rule_people(c -> 'people', t.id) end;
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
    -- Batch B: start dates and absolute dates.
    when 'has_start_date' then return t.start_on is not null;
    when 'no_start_date' then return t.start_on is null;
    when 'has_started' then return t.start_on is not null and t.start_on <= today;
    when 'start_within' then
      return t.start_on is not null and t.start_on between today and today + coalesce((c ->> 'days')::numeric::integer, 0);
    when 'date_compare' then
      return public.rule_date_matches(case c ->> 'date' when 'start' then t.start_on else t.due_on end,
        c ->> 'op', c ->> 'value', c ->> 'to');
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
        when 'between', 'not_between' then
          -- Batch B: a number or date field between two values (both included, in either order).
          if jsonb_typeof(current_value) = 'number' and jsonb_typeof(wanted) = 'number' and jsonb_typeof(c -> 'to') = 'number' then
            return ((current_value #>> '{}')::numeric between least((wanted #>> '{}')::numeric, (c ->> 'to')::numeric)
              and greatest((wanted #>> '{}')::numeric, (c ->> 'to')::numeric)) = (op = 'between');
          end if;
          if current_text ~ '^\d{4}-\d{2}-\d{2}$' then
            return public.rule_date_matches(current_text::date, op, wanted_text, c ->> 'to');
          end if;
          return false;
        else
          return false;
      end case;
    else
      return false;
  end case;
end;
$$;

revoke all on function public.rule_condition_ok(public.rules, jsonb, public.tasks, uuid) from public, anon, authenticated;

-- =============================================================================================
-- 4. Validation (the whole vocabulary; same trigger, same callers)

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
    when 'due_approaching', 'task_overdue', 'start_approaching', 'start_reached' then
      -- Batch B: an offset in hours, days, or weeks (or the older { days }).
      if public.rule_offset_problem(cfg, 30) is not null then
        raise exception '%', public.rule_offset_problem(cfg, 30) using errcode = 'check_violation';
      end if;
    when 'due_date_changed', 'start_date_changed' then
      if cfg ? 'change' and coalesce(cfg ->> 'change', '') not in ('any', 'set', 'cleared') then
        raise exception 'Choose any change, a new date, or cleared' using errcode = 'check_violation';
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
      -- Batch B: minutes, every N days / weeks (counted from an anchor day), several weekdays.
      if cfg ? 'minute' and (jsonb_typeof(cfg -> 'minute') <> 'number' or (cfg ->> 'minute') !~ '^[0-5]?[0-9]$') then
        raise exception 'The minute is a whole number from 0 to 59' using errcode = 'check_violation';
      end if;
      if cfg ? 'interval' and (
        jsonb_typeof(cfg -> 'interval') <> 'number' or (cfg ->> 'interval') !~ '^[0-9]{1,3}$'
        or (cfg ->> 'interval')::integer not between 1 and case cfg ->> 'frequency' when 'weekly' then 52 else 365 end
        or (cfg ->> 'frequency' not in ('daily', 'weekly') and (cfg ->> 'interval')::integer <> 1)
      ) then
        raise exception 'Every N: up to 365 days or 52 weeks' using errcode = 'check_violation';
      end if;
      if cfg ? 'weekdays' and (
        coalesce(jsonb_typeof(cfg -> 'weekdays'), 'missing') <> 'array' or jsonb_array_length(cfg -> 'weekdays') not between 1 and 7
        or exists (select 1 from jsonb_array_elements(cfg -> 'weekdays') w where jsonb_typeof(w) <> 'number' or (w #>> '{}') !~ '^[0-6]$')
        or (select count(distinct w #>> '{}') from jsonb_array_elements(cfg -> 'weekdays') w) <> jsonb_array_length(cfg -> 'weekdays')
      ) then
        raise exception 'Choose one or more days of the week' using errcode = 'check_violation';
      end if;
      if cfg ? 'anchor' and not public.rule_is_day(cfg -> 'anchor') then
        raise exception 'The schedule''s first day is not a date' using errcode = 'check_violation';
      end if;
      if cfg ? 'month_day' and (jsonb_typeof(cfg -> 'month_day') <> 'number' or (cfg ->> 'month_day') !~ '^([1-9]|1[0-9]|2[0-8])$') then
        raise exception 'The day of the month is from 1 to 28' using errcode = 'check_violation';
      end if;
    when 'follower_added' then
      if cfg ? 'people' and (
        coalesce(jsonb_typeof(cfg -> 'people'), 'missing') <> 'array' or jsonb_array_length(cfg -> 'people') = 0
        or exists (select 1 from jsonb_array_elements(cfg -> 'people') p where not public.rule_person_in_project(new.project_id, p))
      ) then
        raise exception 'Collaborator is added: choose who, or anyone' using errcode = 'check_violation';
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
          -- Batch B: between two numbers or two dates.
          or (field.field_type = 'number' and op in ('between', 'not_between') and jsonb_typeof(item -> 'value') = 'number'
              and jsonb_typeof(item -> 'to') = 'number')
          or (field.field_type = 'date' and op in ('between', 'not_between') and public.rule_is_day(item -> 'value')
              and public.rule_is_day(item -> 'to'))
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
      if coalesce(item ->> 'form_id', '') <> '' and (item ->> 'source' <> 'form' or not exists (
        select 1 from public.forms fo where fo.id::text = item ->> 'form_id' and fo.project_id = new.project_id
      )) then
        raise exception 'Task came from a form: choose a form of this project' using errcode = 'check_violation';
      end if;
    elsif kind in ('assignee_is', 'assignee_is_not', 'creator_is') then
      if coalesce(jsonb_typeof(item -> 'people'), 'missing') <> 'array' or jsonb_array_length(item -> 'people') = 0
         or exists (select 1 from jsonb_array_elements(item -> 'people') p where not public.rule_person_in_project(new.project_id, p)) then
        raise exception 'Choose at least one person for the condition' using errcode = 'check_violation';
      end if;
    elsif kind = 'person_compare' then
      if coalesce(item ->> 'op', '') not in ('is', 'is_not') then
        raise exception 'Compare people: choose is or isn''t' using errcode = 'check_violation';
      end if;
      if not (coalesce(item ->> 'left', '') in ('assignee', 'creator', 'followers')
              or public.rule_person_in_project(new.project_id, item -> 'left') and (item ->> 'left') ~* '^field:') then
        raise exception 'Compare people: choose the assignee, the creator, the collaborators, or a People field' using errcode = 'check_violation';
      end if;
      if coalesce(jsonb_typeof(item -> 'people'), 'missing') <> 'array' or jsonb_array_length(item -> 'people') = 0
         or exists (select 1 from jsonb_array_elements(item -> 'people') p where not public.rule_person_in_project(new.project_id, p)) then
        raise exception 'Compare people: choose who to compare with' using errcode = 'check_violation';
      end if;
    elsif kind in ('has_tag', 'lacks_tag') then
      if not public.rule_tag_ok(new.project_id, item ->> 'tag_id', true) then
        raise exception 'Choose a tag of this workspace for the condition' using errcode = 'check_violation';
      end if;
    elsif kind in ('due_within', 'start_within') then
      if coalesce(jsonb_typeof(item -> 'days'), 'missing') <> 'number' or (item ->> 'days') !~ '^[0-9]{1,3}$' or (item ->> 'days')::integer > 365 then
        raise exception '%: choose 0 to 365 days', case kind when 'due_within' then 'Due within' else 'Starts within' end
          using errcode = 'check_violation';
      end if;
    elsif kind = 'date_compare' then
      if coalesce(item ->> 'date', '') not in ('due', 'start') then
        raise exception 'Date is: choose the due date or the start date' using errcode = 'check_violation';
      end if;
      if coalesce(item ->> 'op', '') not in ('before', 'after', 'on', 'on_or_before', 'on_or_after', 'between', 'not_between') then
        raise exception 'Date is: choose before, after, on, or between' using errcode = 'check_violation';
      end if;
      if not public.rule_is_day(item -> 'value') or (item ->> 'op' in ('between', 'not_between') and not public.rule_is_day(item -> 'to')) then
        raise exception 'Date is: choose the date%', case when item ->> 'op' in ('between', 'not_between') then 's' else '' end
          using errcode = 'check_violation';
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
      'has_due_date', 'no_due_date', 'has_open_subtasks', 'all_subtasks_done',
      -- Batch B
      'has_start_date', 'no_start_date', 'has_started'
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
        if coalesce(item ->> 'mode', 'person') in ('round_robin', 'balanced') then
          if coalesce(jsonb_typeof(item -> 'people'), 'missing') <> 'array' or jsonb_array_length(item -> 'people') not between 1 and 50
             or exists (select 1 from jsonb_array_elements(item -> 'people') p where not public.rule_person_in_project(new.project_id, p)) then
            raise exception 'Set assignee: choose the people to take turns' using errcode = 'check_violation';
          end if;
        elsif coalesce(item ->> 'mode', 'person') <> 'person' then
          raise exception 'Set assignee: assign a person, round robin, or the least busy' using errcode = 'check_violation';
        elsif item -> 'assignee' <> 'null'::jsonb and not public.rule_person_in_project(new.project_id, item -> 'assignee') then
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
      when 'add_followers', 'notify', 'remove_followers' then
        if coalesce(jsonb_typeof(item -> 'people'), 'missing') <> 'array' or jsonb_array_length(item -> 'people') = 0
           or exists (select 1 from jsonb_array_elements(item -> 'people') p where not public.rule_person_in_project(new.project_id, p)) then
          raise exception 'Choose at least one person for %', replace(kind, '_', ' ') using errcode = 'check_violation';
        end if;
        if kind = 'notify' and length(trim(coalesce(item ->> 'message', ''))) not between 1 and 1000 then
          raise exception 'Notify: write a message' using errcode = 'check_violation';
        end if;
      when 'request_approval' then
        if not public.rule_person_in_project(new.project_id, item -> 'approver') then
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
      when 'set_due_date', 'set_start_date' then
        -- Batch B: an absolute date, weeks, and hours too (rule_date_action_problem).
        if public.rule_date_action_problem(item, case kind when 'set_due_date' then 'Set due date' else 'Set start date' end) is not null then
          raise exception '%', public.rule_date_action_problem(item, case kind when 'set_due_date' then 'Set due date' else 'Set start date' end)
            using errcode = 'check_violation';
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
        if item ? 'assignee' and item -> 'assignee' <> 'null'::jsonb and not public.rule_person_in_project(new.project_id, item -> 'assignee') then
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
-- 5. Running actions (one log entry per step; same signature, grants, and callers)

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
          if coalesce(a ->> 'mode', 'person') in ('round_robin', 'balanced') then
            -- Automations V3: take turns (round robin) or the least busy of a pool.
            person := public.rule_pick_assignee(r, target_task, a);
            input := jsonb_build_object('mode', a ->> 'mode', 'person', coalesce(public.rule_profile_name(person), 'nobody'));
            if person is null then
              outcome := 'no_candidate';
              result := 'Nobody in the group can take it (they can''t open the task)';
            end if;
          else
            person := case when a -> 'assignee' = 'null'::jsonb or a -> 'assignee' is null then null
              else public.resolve_rule_person(a -> 'assignee', target_task) end;
            input := jsonb_build_object('person', coalesce(public.rule_profile_name(person), 'nobody'));
          end if;
          if outcome = 'no_candidate' then
            null;
          elsif a -> 'assignee' is not null and a -> 'assignee' <> 'null'::jsonb and person is null
                and coalesce(a ->> 'mode', 'person') = 'person' then
            -- A role or People field that names nobody right now leaves the task as it is.
            outcome := 'no_person';
            result := 'Nobody to assign (the slot is empty on this task)';
          else
            update public.tasks set assignee_id = person
            where id = target_task and assignee_id is distinct from person;
            if not found then
              outcome := 'unchanged';
              result := case when person is null then 'Already unassigned' else 'Already assigned to ' || (input ->> 'person') end;
            else
              result := case when person is null then 'Unassigned' else 'Assigned to ' || (input ->> 'person') end
                || case a ->> 'mode' when 'round_robin' then ' (round robin)' when 'balanced' then ' (fewest open tasks)' else '' end;
            end if;
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
          foreach person in array public.rule_people(a -> 'people', target_task) loop
            perform public.follow_task(target_task, person);
          end loop;
          result := case when names is null then 'Nobody to add' else 'Followers: ' || names end;

        when 'remove_followers' then
          -- Automations V3: the people stop following (a removed follow is kept as history).
          select string_agg(coalesce(public.rule_profile_name(u.person), '?'), ', ') into names
          from unnest(public.rule_people(a -> 'people', target_task)) as u(person);
          input := jsonb_build_object('people', coalesce(names, ''));
          update public.task_followers set deleted_at = now()
          where task_id = target_task and deleted_at is null
            and profile_id = any (public.rule_people(a -> 'people', target_task));
          get diagnostics n = row_count;
          if n = 0 then
            outcome := 'unchanged';
            result := case when names is null then 'Nobody to remove' else 'Not following: ' || names end;
          else
            result := 'Stopped following: ' || (
              select string_agg(coalesce(public.rule_profile_name(f.profile_id), '?'), ', ')
              from public.task_followers f
              where f.task_id = target_task and f.deleted_at = now() and f.profile_id = any (public.rule_people(a -> 'people', target_task))
            );
          end if;

        when 'notify' then
          body := left(public.render_rule_text(a ->> 'message', target_task, r.project_id, event), 1000);
          select string_agg(coalesce(public.rule_profile_name(u.person), '?'), ', ') into names
          from unnest(public.rule_people(a -> 'people', target_task)) as u(person);
          input := jsonb_build_object('people', coalesce(names, ''), 'message', left(body, 300));
          foreach person in array public.rule_people(a -> 'people', target_task) loop
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

        when 'set_due_date', 'set_start_date' then
          -- Batch B: one helper for both dates (absolute dates, weeks, and hours too).
          elem := public.rule_set_task_date(r, target_task, a, case a ->> 'type' when 'set_start_date' then 'start' else 'due' end);
          outcome := elem ->> 'outcome';
          result := elem ->> 'result';
          input := coalesce(elem -> 'input', '{}'::jsonb);

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
-- 6. Firing rules (the import and copy checks stay first, exactly as they were)

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
    -- Automations V3 trigger filters.
    continue when trigger_kind = 'follower_added' and cfg ? 'people'
      and not coalesce((event ->> 'profile_id')::uuid = any (public.rule_people(cfg -> 'people', target_task)), false);
    continue when trigger_kind in ('due_date_changed', 'start_date_changed') and (
      (cfg ->> 'change' = 'set' and (event ->> (case trigger_kind when 'due_date_changed' then 'due_on' else 'start_on' end)) is null)
      or (cfg ->> 'change' = 'cleared' and (event ->> (case trigger_kind when 'due_date_changed' then 'due_on' else 'start_on' end)) is not null)
    );
    -- "Also run when another rule makes the change" off: only people's changes fire it.
    continue when public.rule_context_id() is not null and not r.run_on_rule_changes;
    perform public.run_rule(r, target_task, event);
  end loop;
end;
$$;


-- =============================================================================================
-- 7. Where the new triggers fire (all skip subtasks: rules act on top-level tasks)

-- "Collaborator is added" (batch A): someone starts following a task — by hand, by being assigned,
-- mentioned, or commenting, or by a rule. Not in the transaction that made the task (its creator and
-- first assignee follow it then), unless a rule did it.
create or replace function public.rules_on_follower_added()
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
         and (public.rule_context_id() is not null or t.created_at <> now())
     ) then
    perform public.fire_rules('follower_added', new.task_id, null, jsonb_build_object('profile_id', new.profile_id));
  end if;
  return null;
end;
$$;

revoke all on function public.rules_on_follower_added() from public, anon, authenticated;

create or replace trigger task_followers_zz_rules
after insert or update of deleted_at on public.task_followers
for each row execute function public.rules_on_follower_added();

-- =============================================================================================
-- 8. Dates (batch B): where the start date triggers fire, schedules, and the scheduler

-- Same as Automations V2's, plus "Start date changes" (not for dates set in the transaction that made
-- the task, like due dates).
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
    if new.start_on is distinct from old.start_on
       and (public.rule_context_id() is not null or new.created_at <> now()) then
      perform public.fire_rules('start_date_changed', new.id, null, jsonb_build_object(
        'start_on', new.start_on, 'from_start_on', old.start_on
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
after update of assignee_id, completed_at, due_on, start_on on public.tasks
for each row execute function public.rules_on_task_update();

-- The next time a scheduled rule runs after `after_time` (same signature, grants, and callers as
-- Automations V2's). At `hour`:`minute` (9:00 by default) in the rule's time zone:
--   daily     every day, or every `interval` days counted from `anchor`
--   workdays  the workspace's workweek
--   weekly    on `weekdays` (or the older single `weekday`; Sunday by default), every `interval` weeks
--             counted from `anchor`'s week (weeks start on Sunday)
--   monthly   on `month_day` (1–28)
-- A rule saved without the new keys runs exactly as before.
create or replace function public.rule_schedule_next_at(cfg jsonb, work_week smallint[], after_time timestamptz)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  frequency text := cfg ->> 'frequency';
  hour integer := case when jsonb_typeof(cfg -> 'hour') = 'number' then (cfg ->> 'hour')::numeric::integer else 9 end;
  minute integer := case when jsonb_typeof(cfg -> 'minute') = 'number' then (cfg ->> 'minute')::numeric::integer else 0 end;
  every integer := greatest(case when jsonb_typeof(cfg -> 'interval') = 'number' then (cfg ->> 'interval')::numeric::integer else 1 end, 1);
  month_day integer := case when jsonb_typeof(cfg -> 'month_day') = 'number' then (cfg ->> 'month_day')::numeric::integer else 1 end;
  zone text := public.safe_timezone(coalesce(nullif(cfg ->> 'timezone', ''), 'UTC'));
  anchor date := case when (cfg ->> 'anchor') ~ '^\d{4}-\d{2}-\d{2}$' then (cfg ->> 'anchor')::date else date '2026-01-04' end;
  days smallint[];
  first_day date;
  on_day date;
  candidate timestamptz;
  ok boolean;
begin
  if coalesce(frequency, '') not in ('daily', 'workdays', 'weekly', 'monthly') or hour not between 0 and 23 or minute not between 0 and 59 then
    return null;
  end if;
  if frequency = 'weekly' then
    if jsonb_typeof(cfg -> 'weekdays') = 'array' and jsonb_array_length(cfg -> 'weekdays') > 0 then
      select array_agg((w #>> '{}')::smallint) into days from jsonb_array_elements(cfg -> 'weekdays') w;
    else
      days := array[case when jsonb_typeof(cfg -> 'weekday') = 'number' then (cfg ->> 'weekday')::numeric::smallint else 0 end];
    end if;
  elsif frequency = 'workdays' then
    days := case when work_week is not null and cardinality(work_week) between 1 and 6 then work_week else array[0, 1, 2, 3, 4, 5, 6]::smallint[] end;
  end if;

  first_day := (after_time at time zone zone)::date;
  for i in 0 .. 800 loop
    on_day := first_day + i;
    ok := case frequency
      when 'daily' then ((on_day - anchor) % every + every) % every = 0
      when 'workdays' then extract(dow from on_day)::smallint = any (days)
      when 'weekly' then extract(dow from on_day)::smallint = any (days)
        and ((((on_day - extract(dow from on_day)::integer) - (anchor - extract(dow from anchor)::integer)) / 7) % every + every) % every = 0
      else extract(day from on_day)::integer = month_day
    end;
    if ok then
      candidate := (on_day + make_time(hour, minute, 0)) at time zone zone;
      if candidate > after_time then
        return candidate;
      end if;
    end if;
  end loop;
  return null;
end;
$$;

revoke all on function public.rule_schedule_next_at(jsonb, smallint[], timestamptz) from public, anon;
grant execute on function public.rule_schedule_next_at(jsonb, smallint[], timestamptz) to authenticated;

-- The date triggers of one rule for the scheduler: "Due date is approaching", "Task becomes overdue",
-- "Start date is approaching", and "Start date arrives" (batch B), each with an offset in days, weeks
-- (whole dates in the rule's time zone, as before), or hours (from the task's due / start time: a due
-- date without a time counts as the end of that day, a start date without one as its start). Each runs
-- once per task and date (or time); overdue and arrived catch up for two days so a missed tick still
-- fires. Returns how many runs happened.
create or replace function public.rule_date_tick(r public.rules)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  kind text := r.trigger_type;
  amount integer;
  unit text;
  n integer;
  today date := public.rule_local_today(r);
  zone text := public.safe_timezone(coalesce(nullif(r.trigger_config ->> 'timezone', ''), 'UTC'));
  span interval;
  t record;
  outcome text;
  ran integer := 0;
  is_due boolean := kind in ('due_approaching', 'task_overdue');
  ahead boolean := kind in ('due_approaching', 'start_approaching');
begin
  select o.amount, o.unit into amount, unit
  from public.rule_trigger_offset(r.trigger_config, case when kind = 'start_reached' then 0 else 1 end) o;

  if unit in ('days', 'weeks') then
    n := amount * case when unit = 'weeks' then 7 else 1 end;
    if kind = 'task_overdue' then
      n := greatest(n, 1);
    end if;
    for t in
      select tk.id, case when is_due then tk.due_on else tk.start_on end as on_day
      from public.tasks tk
      join public.task_projects tp on tp.task_id = tk.id and tp.project_id = r.project_id and tp.deleted_at is null
      where tk.deleted_at is null and tk.completed_at is null and tk.parent_task_id is null
        and case
          when ahead then (case when is_due then tk.due_on else tk.start_on end) = today + n
          else (case when is_due then tk.due_on else tk.start_on end) between today - n - 2 and today - n
        end
    loop
      outcome := public.run_rule(r, t.id,
        case when is_due then jsonb_build_object('due_on', t.on_day) else jsonb_build_object('start_on', t.on_day) end, null,
        case kind when 'due_approaching' then 'due:' when 'task_overdue' then 'overdue:' when 'start_approaching' then 'start:' else 'started:' end
          || t.on_day::text);
      if outcome in ('succeeded', 'scheduled') then
        ran := ran + 1;
      end if;
    end loop;
    return ran;
  end if;

  -- Hours.
  span := make_interval(hours => greatest(amount, 1));
  for t in
    select x.id, x.moment from (
      select tk.id,
        case when is_due then coalesce(tk.due_at, ((tk.due_on + 1)::timestamp at time zone zone))
          else coalesce(tk.start_at, (tk.start_on::timestamp at time zone zone)) end as moment
      from public.tasks tk
      join public.task_projects tp on tp.task_id = tk.id and tp.project_id = r.project_id and tp.deleted_at is null
      where tk.deleted_at is null and tk.completed_at is null and tk.parent_task_id is null
        and (case when is_due then tk.due_on else tk.start_on end)
          between today - 3 - case when ahead then 0 else amount / 24 end and today + 2 + case when ahead then amount / 24 else 0 end
    ) x
    where case
      when ahead then now() >= x.moment - span and now() < x.moment
      else now() >= x.moment + span and now() < x.moment + span + interval '2 days'
    end
  loop
    outcome := public.run_rule(r, t.id, jsonb_build_object('at', t.moment), null,
      case kind when 'due_approaching' then 'due_h:' when 'task_overdue' then 'overdue_h:' when 'start_approaching' then 'start_h:' else 'started_h:' end
        || to_char(t.moment at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI'));
    if outcome in ('succeeded', 'scheduled') then
      ran := ran + 1;
    end if;
  end loop;
  return ran;
end;
$$;

revoke all on function public.rule_date_tick(public.rules) from public, anon, authenticated;

-- The scheduler (same signature, grants, and callers): delayed actions, the date triggers (through
-- rule_date_tick), and scheduled rules.
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
  delayed integer := 0;
  due integer := 0;
  overdue integer := 0;
  starts integer := 0;
  scheduled integer := 0;
  ran integer;
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
    where ru.enabled and ru.deleted_at is null
      and ru.trigger_type in ('due_approaching', 'task_overdue', 'start_approaching', 'start_reached')
  loop
    ran := public.rule_date_tick(r);
    case r.trigger_type
      when 'due_approaching' then due := due + ran;
      when 'task_overdue' then overdue := overdue + ran;
      else starts := starts + ran;
    end case;
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

  return jsonb_build_object('delayed_actions', delayed, 'due_rules', due, 'overdue_rules', overdue,
    'start_rules', starts, 'scheduled_rules', scheduled);
end;
$$;
