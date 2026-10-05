-- Behavioural checks for Phase: Task depth: recurring tasks (spawn on complete, date shifting, weekdays,
-- month-end clamping, end conditions, copied memberships/fields/followers/subtasks, Req # titles),
-- due/start times (date sync, start <= due), finish-to-start dependencies (cycles, same project only,
-- blocking, roles, soft delete), and Trash (visibility by role, restore RPC, no leaks to search).
-- Reuses people from earlier suites:
--   1111… member@example.com   "Member One"   (owner of the projects below)
--   5555… viewer@example.com   "Vera Viewer"
--   7777… editor@example.com   "Eddie Editor"
--   9999… nonmember@example.com

\set ON_ERROR_STOP 1

create temporary table td_ids (name text primary key, id uuid) on commit preserve rows;
grant all on td_ids to authenticated, anon, service_role;

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset

-- Fixtures ---------------------------------------------------------------------------------------

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  p uuid;
  q uuid;
  s uuid;
  f uuid;
  t uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Depth') returning id into p;
  insert into public.projects (workspace_id, name) values (ws, 'Depth other') returning id into q;
  insert into public.sections (project_id, name, sort_order) values (p, 'Doing', 1024) returning id into s;
  insert into public.custom_fields (project_id, name, field_type) values (p, 'Effort', 'number') returning id into f;
  perform public.add_project_member(p, 'viewer@example.com', 'viewer');
  perform public.add_project_member(p, 'editor@example.com', 'editor');
  insert into td_ids values ('p', p), ('q', q), ('s', s), ('f', f);

  -- Weekly report: start Fri Oct 2, due Mon Oct 5 2026, in section Doing, with a field value,
  -- a follower, and a subtask.
  t := public.create_task(p, s, 'Weekly report');
  update public.tasks set start_on = '2026-10-02', due_on = '2026-10-05',
    assignee_id = '77777777-7777-4777-8777-777777777777',
    recurrence = '{"freq": "weekly", "timezone": "America/New_York"}'
  where id = t;
  insert into public.task_field_values (task_id, field_id, value) values (t, f, '3');
  insert into public.subtasks (task_id, title, sort_order) values (t, 'Collect numbers', 1024);
  insert into public.task_projects (task_id, project_id, sort_order) values (t, q, 1024);
  insert into td_ids values ('weekly', t);
end $$;

-- Recurrence: validation and guards --------------------------------------------------------------

do $$
declare
  p uuid := (select id from td_ids where name = 'p');
  weekly uuid := (select id from td_ids where name = 'weekly');
  t uuid;
  rule jsonb;
begin
  rule := (select recurrence from public.tasks where id = weekly);
  assert rule = '{"freq": "weekly", "interval": 1, "ends": {"type": "never"}, "timezone": "America/New_York"}'::jsonb,
    format('recurrence is normalized with defaults: %s', rule);
  assert exists (select 1 from public.task_stories where task_id = weekly and kind = 'recurrence_changed'),
    'setting a recurrence writes a story';

  t := public.create_task(p, null, 'Validation');
  insert into td_ids values ('validation', t);
  begin
    update public.tasks set recurrence = '{"freq": "hourly"}' where id = t;
    raise exception 'unknown frequency should fail';
  exception when check_violation then null;
  end;
  begin
    update public.tasks set recurrence = '{"freq": "daily", "interval": 0}' where id = t;
    raise exception 'interval 0 should fail';
  exception when check_violation then null;
  end;
  begin
    update public.tasks set recurrence = '{"freq": "monthly", "weekdays": [1]}' where id = t;
    raise exception 'weekdays on a monthly repeat should fail';
  exception when check_violation then null;
  end;
  begin
    update public.tasks set recurrence = '{"freq": "daily", "ends": {"type": "after", "count": 0}}' where id = t;
    raise exception 'ending after 0 occurrences should fail';
  exception when check_violation then null;
  end;
  begin
    update public.tasks set recurrence = '{"freq": "daily", "color": "red"}' where id = t;
    raise exception 'unknown keys should fail';
  exception when check_violation then null;
  end;
  update public.tasks set recurrence = '{"freq": "weekly", "weekdays": [3, 1, 3], "timezone": "Not/AZone"}' where id = t;
  assert (select recurrence from public.tasks where id = t)
    = '{"freq": "weekly", "interval": 1, "weekdays": [1, 3], "ends": {"type": "never"}, "timezone": "UTC"}'::jsonb,
    'weekdays are sorted/deduplicated and invalid zones fall back to UTC';
  update public.tasks set recurrence = 'null'::jsonb where id = t;
  assert (select recurrence from public.tasks where id = t) is null, 'JSON null clears the recurrence';

  begin
    update public.tasks set recurrence_seq = 5 where id = t;
    raise exception 'clients should not write series bookkeeping';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.tasks set recurrence_series_id = weekly where id = t;
    raise exception 'clients should not join a task to another series';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Next-date arithmetic ---------------------------------------------------------------------------

do $$
begin
  assert public.recurrence_next_date('{"freq": "daily", "interval": 3}', '2026-10-05') = '2026-10-08', 'every 3 days';
  assert public.recurrence_next_date('{"freq": "weekly"}', '2026-10-05') = '2026-10-12', 'weekly = +7';
  assert public.recurrence_next_date('{"freq": "weekly", "interval": 2}', '2026-10-05') = '2026-10-19', 'every 2 weeks';
  -- Mon Oct 5 with Mon/Wed → Wed Oct 7; Wed Oct 7 → Mon Oct 12; every 2 weeks: Wed Oct 7 → Mon Oct 19.
  assert public.recurrence_next_date('{"freq": "weekly", "weekdays": [1, 3]}', '2026-10-05') = '2026-10-07', 'Mon → Wed';
  assert public.recurrence_next_date('{"freq": "weekly", "weekdays": [1, 3]}', '2026-10-07') = '2026-10-12', 'Wed → next Mon';
  assert public.recurrence_next_date('{"freq": "weekly", "interval": 2, "weekdays": [1, 3]}', '2026-10-07') = '2026-10-19',
    'Wed → Mon two weeks on';
  assert public.recurrence_next_date('{"freq": "monthly"}', '2026-01-31') = '2026-02-28', 'Jan 31 clamps to Feb 28';
  assert public.recurrence_next_date('{"freq": "monthly", "month_day": 31}', '2026-02-28') = '2026-03-31',
    'the remembered day of month comes back after a short month';
  assert public.recurrence_next_date('{"freq": "monthly", "interval": 3}', '2026-10-15') = '2027-01-15', 'quarterly';
  assert public.recurrence_next_date('{"freq": "yearly"}', '2028-02-29') = '2029-02-28', 'Feb 29 clamps in a common year';
end $$;

-- Completing a weekly task spawns the next occurrence ----------------------------------------------

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset

do $$
declare
  weekly uuid := (select id from td_ids where name = 'weekly');
  next_task public.tasks;
begin
  update public.tasks set completed_at = now() where id = weekly;
  select * into next_task from public.tasks where recurrence_series_id = weekly and deleted_at is null;
  assert next_task.id is not null, 'completing a recurring task creates the next occurrence';
  insert into td_ids values ('weekly2', next_task.id);
  assert next_task.title = 'Weekly report', 'same title';
  assert next_task.completed_at is null, 'the next occurrence is incomplete';
  assert next_task.due_on = '2026-10-12', format('due shifts one week: %s', next_task.due_on);
  assert next_task.start_on = '2026-10-09', format('start shifts by the same amount: %s', next_task.start_on);
  assert next_task.assignee_id = '77777777-7777-4777-8777-777777777777', 'same assignee';
  assert next_task.recurrence_seq = 2, 'occurrence number increments';
  assert next_task.recurrence = (select recurrence from public.tasks where id = weekly), 'same rule';
  assert (select recurrence_next_id from public.tasks where id = weekly) = next_task.id, 'the completed task links to it';
  assert (select section_id from public.task_projects
          where task_id = next_task.id and project_id = (select id from td_ids where name = 'p')) =
         (select id from td_ids where name = 's'), 'same section in the home project';
  assert (select value from public.task_field_values where task_id = next_task.id
          and field_id = (select id from td_ids where name = 'f')) = '3'::jsonb, 'field values are copied';
  assert exists (select 1 from public.subtasks where task_id = next_task.id and title = 'Collect numbers' and completed_at is null),
    'subtasks are copied as open';
  assert exists (select 1 from public.task_followers where task_id = next_task.id
                 and profile_id = '11111111-1111-4111-8111-111111111111' and deleted_at is null),
    'followers are copied (the creator follows)';
  assert exists (select 1 from public.task_stories where task_id = weekly and kind = 'recurrence_spawned'
                 and data ->> 'next_task_id' = next_task.id::text), 'the spawn is logged on the completed task';
end $$;

do $$
declare
  weekly uuid := (select id from td_ids where name = 'weekly');
begin
  update public.tasks set completed_at = null where id = weekly;
  update public.tasks set completed_at = now() where id = weekly;
  assert (select count(*) from public.tasks where recurrence_series_id = weekly and deleted_at is null) = 1,
    'reopening and completing again does not spawn a second copy';
end $$;

-- Ends after N, until a date, and monthly month-end ------------------------------------------------

do $$
declare
  p uuid := (select id from td_ids where name = 'p');
  t uuid;
begin
  t := public.create_task(p, null, 'Twice');
  update public.tasks set due_on = '2026-10-05', recurrence = '{"freq": "daily", "ends": {"type": "after", "count": 2}}'
  where id = t;
  insert into td_ids values ('twice', t);

  t := public.create_task(p, null, 'Until');
  update public.tasks set due_on = '2026-10-05', recurrence = '{"freq": "weekly", "ends": {"type": "until", "until": "2026-10-10"}}'
  where id = t;
  insert into td_ids values ('until', t);

  t := public.create_task(p, null, 'Month end');
  update public.tasks set due_on = '2027-01-31', recurrence = '{"freq": "monthly"}' where id = t;
  insert into td_ids values ('month_end', t);

  t := public.create_task(p, null, 'Undated');
  update public.tasks set recurrence = '{"freq": "daily", "interval": 2}' where id = t;
  insert into td_ids values ('undated', t);
end $$;

do $$
declare
  twice uuid := (select id from td_ids where name = 'twice');
  second uuid;
  month_end uuid := (select id from td_ids where name = 'month_end');
  feb uuid;
  undated uuid := (select id from td_ids where name = 'undated');
begin
  update public.tasks set completed_at = now() where id = twice;
  select id into second from public.tasks where recurrence_series_id = twice;
  assert (select due_on from public.tasks where id = second) = '2026-10-06', 'daily: next day';
  update public.tasks set completed_at = now() where id = second;
  assert (select count(*) from public.tasks where recurrence_series_id = twice) = 1,
    'ends after 2: completing the 2nd occurrence spawns nothing';

  update public.tasks set completed_at = now() where id = (select id from td_ids where name = 'until');
  assert not exists (select 1 from public.tasks where recurrence_series_id = (select id from td_ids where name = 'until')),
    'until: no occurrence past the end date';

  update public.tasks set completed_at = now() where id = month_end;
  select id into feb from public.tasks where recurrence_series_id = month_end;
  assert (select due_on from public.tasks where id = feb) = '2027-02-28', 'Jan 31 → Feb 28';
  assert (select (recurrence ->> 'month_day')::int from public.tasks where id = feb) = 31, 'the day of month is remembered';
  update public.tasks set completed_at = now() where id = feb;
  assert (select due_on from public.tasks where recurrence_series_id = month_end and id <> feb) = '2027-03-31',
    'Feb 28 → Mar 31';

  update public.tasks set completed_at = now() where id = undated;
  assert (select due_on from public.tasks where recurrence_series_id = undated)
    = (now() at time zone 'UTC')::date + 2, 'an undated task repeats from the completion day';
end $$;

-- Req #: the next occurrence gets its own number in the title -------------------------------------

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset

do $$
declare
  q uuid := (select id from td_ids where name = 'q');
  t uuid;
  next_title text;
begin
  -- (The editor who completed the weekly task can't see q, the owner can.)
  assert exists (select 1 from public.task_projects
                 where task_id = (select id from td_ids where name = 'weekly2') and project_id = q and deleted_at is null),
    'the next occurrence joins the same other projects, even ones the completer cannot see';
  insert into public.request_sequences (project_id, prefix, pad_width, add_to_title, assign_to)
  values (q, 'Req #', 3, true, 'all_tasks');
  t := public.create_task(q, null, 'Numbered');
  assert (select title from public.tasks where id = t) = '[Req #001] Numbered', format('first number in the title: %s', (select title from public.tasks where id = t));
  update public.tasks set recurrence = '{"freq": "daily"}' where id = t;
  insert into td_ids values ('numbered', t);
end $$;

do $$
declare
  t uuid := (select id from td_ids where name = 'numbered');
begin
  update public.tasks set completed_at = now() where id = t;
  assert (select title from public.tasks where recurrence_series_id = t) = '[Req #002] Numbered',
    format('the next occurrence carries only its own number: %s',
      (select title from public.tasks where recurrence_series_id = t));
end $$;

-- Viewers can't set a recurrence -------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset

do $$
declare
  affected int;
begin
  update public.tasks set recurrence = '{"freq": "daily"}' where id = (select id from td_ids where name = 'validation');
  get diagnostics affected = row_count;
  assert affected = 0, 'viewers cannot set a recurrence';
end $$;

-- Due and start times ----------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from td_ids where name = 'p');
  t uuid;
  task public.tasks;
begin
  t := public.create_task(p, null, 'Timed');
  insert into td_ids values ('timed', t);

  -- 02:00 UTC on Oct 8 is still Oct 7 in New York.
  update public.tasks set due_at = '2026-10-08 02:00:00+00', time_zone = 'America/New_York' where id = t;
  select * into task from public.tasks where id = t;
  assert task.due_on = '2026-10-07', format('the due date is the local date of the due time: %s', task.due_on);

  update public.tasks set start_at = '2026-10-07 13:00:00+00' where id = t;
  assert (select start_on from public.tasks where id = t) = '2026-10-07', 'the start date follows the start time';

  begin
    update public.tasks set start_at = '2026-10-08 03:00:00+00' where id = t;
    raise exception 'a start time after the due time should fail';
  exception when check_violation then null;
  end;

  begin
    update public.tasks set start_at = '2026-10-09 13:00:00+00' where id = t;
    raise exception 'a start date after the due date should fail';
  exception when check_violation then null;
  end;

  -- Moving only the date (Calendar/Timeline drag) keeps the local time.
  update public.tasks set due_on = '2026-10-09' where id = t;
  assert (select due_at from public.tasks where id = t) = '2026-10-10 02:00:00+00',
    format('the due time moves with the date: %s', (select due_at from public.tasks where id = t));

  -- Clearing the time keeps the date; clearing the date clears the time.
  update public.tasks set start_at = null where id = t;
  assert (select start_on from public.tasks where id = t) = '2026-10-07', 'clearing the start time keeps the start date';
  update public.tasks set due_on = null where id = t;
  select * into task from public.tasks where id = t;
  assert task.due_at is null and task.due_on is null, 'clearing the due date clears the due time';

  update public.tasks set start_at = '2026-10-07 13:00:00+00' where id = t;
  update public.tasks set start_on = null where id = t;
  assert (select start_at from public.tasks where id = t) is null, 'clearing the start date clears the start time';

  -- Times shift with recurrence.
  update public.tasks set due_at = '2026-10-07 18:30:00+00', recurrence = '{"freq": "daily"}' where id = t;
  update public.tasks set completed_at = now() where id = t;
  select * into task from public.tasks where recurrence_series_id = t;
  assert task.due_at = '2026-10-08 18:30:00+00' and task.due_on = '2026-10-08' and task.time_zone = 'America/New_York',
    format('the next occurrence keeps the local due time: %s %s', task.due_at, task.due_on);
end $$;

-- Dependencies -----------------------------------------------------------------------------------

do $$
declare
  p uuid := (select id from td_ids where name = 'p');
  q uuid := (select id from td_ids where name = 'q');
  a uuid;
  b uuid;
  c uuid;
  other uuid;
  d1 uuid;
  d2 uuid;
begin
  a := public.create_task(p, null, 'Draft');
  b := public.create_task(p, null, 'Review');
  c := public.create_task(p, null, 'Publish');
  insert into td_ids values ('a', a), ('b', b), ('c', c);

  d1 := public.add_task_dependency(a, b);
  d2 := public.add_task_dependency(b, c);
  insert into td_ids values ('d_ab', d1), ('d_bc', d2);
  assert public.add_task_dependency(a, b) = d1, 'adding the same dependency again is idempotent';
  assert (select count(*) from public.task_dependencies where project_id = p and deleted_at is null) = 2,
    'one active row per pair';

  begin
    perform public.add_task_dependency(c, a);
    raise exception 'a cycle (a → b → c → a) should fail';
  exception when check_violation then null;
  end;
  begin
    perform public.add_task_dependency(b, a);
    raise exception 'a two-task cycle should fail';
  exception when check_violation then null;
  end;
  begin
    perform public.add_task_dependency(a, a);
    raise exception 'self-dependency should fail';
  exception when check_violation then null;
  end;

  -- The editor is not a member of q, so q tasks are invisible to them.
  other := (select id from td_ids where name = 'numbered');
  begin
    perform public.add_task_dependency(other, a);
    raise exception 'a task the caller cannot read should fail';
  exception when no_data_found then null;
  end;

  assert public.open_blocker_count(b) = 1, 'b waits on a';
  begin
    update public.tasks set completed_at = now() where id = b;
    raise exception 'completing a blocked task should fail';
  exception when check_violation then null;
  end;
  update public.tasks set completed_at = now() where id = a;
  assert public.open_blocker_count(b) = 0, 'b is unblocked once a is complete';
  update public.tasks set completed_at = now() where id = b;
  assert (select completed_at from public.tasks where id = b) is not null, 'b can be completed now';

  assert exists (select 1 from public.task_stories where task_id = b and kind = 'dependency_added'
                 and data ->> 'relation' = 'blocked_by'), 'the successor logs the dependency';
  assert exists (select 1 from public.task_stories where task_id = a and kind = 'dependency_added'
                 and data ->> 'relation' = 'blocking'), 'the predecessor logs the dependency';

  begin
    insert into public.task_dependencies (project_id, predecessor_id, successor_id) values (p, c, a);
    raise exception 'direct inserts should fail';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Owner: tasks in different projects can't be linked
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset

do $$
declare
  q uuid := (select id from td_ids where name = 'q');
  only_q uuid;
begin
  only_q := public.create_task(q, null, 'Only in other');
  begin
    perform public.add_task_dependency(only_q, (select id from td_ids where name = 'a'));
    raise exception 'cross-project dependencies should fail';
  exception when check_violation then null;
  end;
end $$;

-- Viewer: reads dependencies, can't change them
select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset

do $$
declare
  affected int;
begin
  assert (select count(*) from public.task_dependencies
          where project_id = (select id from td_ids where name = 'p') and deleted_at is null) = 2,
    'viewers see the project''s dependencies';
  begin
    perform public.add_task_dependency((select id from td_ids where name = 'a'), (select id from td_ids where name = 'c'));
    raise exception 'viewers cannot add dependencies';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.remove_task_dependency((select id from td_ids where name = 'd_ab'));
    raise exception 'viewers cannot remove dependencies';
  exception when insufficient_privilege then null;
  end;
  update public.task_dependencies set deleted_at = now();
  get diagnostics affected = row_count;
  assert affected = 0, 'no direct updates';
end $$;

-- Non-member: sees nothing
select set_config('request.jwt.claim.sub', '99999999-9999-4999-8999-999999999999', false) is not null as ok \gset

do $$
begin
  assert (select count(*) from public.task_dependencies) = 0, 'non-members see no dependencies';
  assert public.open_blocker_count((select id from td_ids where name = 'c')) = 0, 'and learn nothing from the helper';
  begin
    perform public.remove_task_dependency((select id from td_ids where name = 'd_bc'));
    raise exception 'non-members cannot remove dependencies';
  exception when no_data_found then null;
  end;
end $$;

-- Editor removes a dependency: soft delete hides it
select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset

do $$
declare
  c uuid := (select id from td_ids where name = 'c');
  d uuid := (select id from td_ids where name = 'd_bc');
begin
  update public.tasks set completed_at = null where id = (select id from td_ids where name = 'b');
  assert public.open_blocker_count(c) = 1, 'c waits on the reopened b';
  perform public.remove_task_dependency(d);
  assert (select deleted_at from public.task_dependencies where id = d) is not null, 'removal is a soft delete';
  assert not exists (select 1 from public.task_dependencies where successor_id = c and deleted_at is null),
    'the removed dependency is no longer active';
  assert public.open_blocker_count(c) = 0, 'removing the dependency unblocks the task';
  update public.tasks set completed_at = now() where id = c;
  assert exists (select 1 from public.task_stories where task_id = c and kind = 'dependency_removed'), 'removal is logged';
  -- Re-adding creates a new row (b → c is not a cycle again).
  assert public.add_task_dependency((select id from td_ids where name = 'b'), c) <> d, 're-adding creates a new row';
end $$;

-- Trash ------------------------------------------------------------------------------------------

do $$
declare
  p uuid := (select id from td_ids where name = 'p');
  t uuid;
  affected int;
begin
  t := public.create_task(p, null, 'Trash me zebra');
  insert into td_ids values ('trashed', t);
end $$;

do $$
declare
  t uuid := (select id from td_ids where name = 'trashed');
  affected int;
begin
  update public.tasks set deleted_at = now() where id = t;
  assert exists (select 1 from public.tasks where id = t and deleted_at is not null), 'editors see trashed tasks';
  assert not exists (select 1 from public.search_tasks('zebra')), 'search never returns trashed tasks';
  assert not exists (select 1 from public.filter_project_tasks((select id from td_ids where name = 'p'), '{"completion": "all"}')
                     where task_id = t), 'views never return trashed tasks';
  delete from public.tasks where id = t;
  get diagnostics affected = row_count;
  assert affected = 0, 'hard deletes affect nothing';
end $$;

select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset

do $$
declare
  t uuid := (select id from td_ids where name = 'trashed');
begin
  assert not exists (select 1 from public.tasks where id = t), 'viewers do not see trashed tasks';
  assert exists (select 1 from public.tasks where id = (select id from td_ids where name = 'a')),
    'viewers still see active tasks';
  begin
    perform public.restore_task(t);
    raise exception 'viewers cannot restore';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '99999999-9999-4999-8999-999999999999', false) is not null as ok \gset

do $$
declare
  t uuid := (select id from td_ids where name = 'trashed');
begin
  assert not exists (select 1 from public.tasks where id = t), 'non-members cannot see another project''s trash';
  assert not exists (select 1 from public.tasks
                     where deleted_at is not null and home_project_id = (select id from td_ids where name = 'p')),
    'non-members see none of the project''s trashed tasks';
  begin
    perform public.restore_task(t);
    raise exception 'non-members cannot restore';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset

do $$
declare
  t uuid := (select id from td_ids where name = 'trashed');
begin
  perform public.restore_task(t);
  assert (select deleted_at from public.tasks where id = t) is null, 'restore clears deleted_at';
  assert exists (select 1 from public.task_stories where task_id = t and kind = 'restored'), 'restore is logged';
  assert exists (select 1 from public.search_tasks('zebra') where id = t), 'a restored task is searchable again';
  perform public.restore_task(t);
end $$;

select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset

do $$
begin
  assert exists (select 1 from public.tasks where id = (select id from td_ids where name = 'trashed')),
    'viewers see the restored task again';
end $$;

reset role;

-- EXECUTE surface: the new client RPCs are intentional; trigger functions are not exposed ----------

do $$
begin
  assert has_function_privilege('authenticated', 'public.add_task_dependency(uuid, uuid)', 'execute'), 'add RPC';
  assert has_function_privilege('authenticated', 'public.remove_task_dependency(uuid)', 'execute'), 'remove RPC';
  assert has_function_privilege('authenticated', 'public.restore_task(uuid)', 'execute'), 'restore RPC';
  assert not has_function_privilege('anon', 'public.restore_task(uuid)', 'execute'), 'anon cannot restore';
  assert not has_function_privilege('anon', 'public.add_task_dependency(uuid, uuid)', 'execute'), 'anon cannot link';
  assert not has_function_privilege('authenticated', 'public.spawn_next_occurrence()', 'execute'), 'spawn is a trigger only';
  assert not has_function_privilege('authenticated', 'public.on_task_restore()', 'execute'), 'restore story is a trigger only';
end $$;

select 'task depth smoke: all assertions passed' as result;
