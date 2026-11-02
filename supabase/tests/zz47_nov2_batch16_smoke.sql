-- Nov 2 notes, batch 16 (20261102050000_nov2_batch16_a.sql).
--   123 convert_subtask_to_task: Convert to main task, optionally making the new task block the task it
--       came from (one transaction, the usual checks).
--   124 subtask_parent_candidates: the blank list reads the projects' recently added open top-level
--       tasks the caller edits; a typed search still finds by name; nothing the caller can't edit.
--   125 preview_dependency_shifts / apply_dependency_shifts: every dependent a moved task leaves starting
--       too early is pushed, chained, on the workspace's workdays (Sunday–Thursday), keeping its length in
--       workdays; pulling earlier only when asked. The vectors are tests/unit/nov2-batch16.test.tsx's.
--   b1600160…11 b16-owner@example.com   Ona Owner (owns P)
--   b1600160…12 b16-viewer@example.com  Vi Viewer (Viewer of P)

\set ON_ERROR_STOP 1

create temporary table b16_ids (name text primary key, id uuid) on commit preserve rows;
grant all on b16_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('b16-owner@example.com', 'batch 16'),
  ('b16-viewer@example.com', 'batch 16');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b1600160-0000-4000-8000-000000000011', 'b16-owner@example.com', now(), '{"full_name":"Ona Owner"}'),
  ('b1600160-0000-4000-8000-000000000012', 'b16-viewer@example.com', now(), '{"full_name":"Vi Viewer"}');

-- ---------------------------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------------------------

do $$
begin
  assert not (select prosecdef from pg_proc where oid = 'public.convert_subtask_to_task(uuid, uuid, uuid, boolean)'::regprocedure),
    'convert_subtask_to_task is invoker';
  assert not (select prosecdef from pg_proc where oid = 'public.preview_dependency_shifts(jsonb, boolean)'::regprocedure),
    'the plan stays invoker';
  assert not (select prosecdef from pg_proc where oid = 'public.subtask_parent_candidates(uuid, text, integer)'::regprocedure),
    'the picker stays invoker';
  assert not (select prosecdef from pg_proc where oid = 'public.workday_steps(date, date, smallint[])'::regprocedure),
    'workday_steps is invoker';
  assert has_function_privilege('authenticated', 'public.convert_subtask_to_task(uuid, uuid, uuid, boolean)', 'execute');
  assert not has_function_privilege('anon', 'public.convert_subtask_to_task(uuid, uuid, uuid, boolean)', 'execute'), 'nothing for anon';
  assert not has_function_privilege('anon', 'public.workday_steps(date, date, smallint[])', 'execute'), 'nothing for anon';
  assert not has_function_privilege('anon', 'public.preview_dependency_shifts(jsonb, boolean)', 'execute'), 'nothing for anon';
  assert has_function_privilege('authenticated', 'public.preview_dependency_shifts(jsonb, boolean)', 'execute'), 'grants kept';
  assert has_function_privilege('authenticated', 'public.subtask_parent_candidates(uuid, text, integer)', 'execute'), 'grants kept';
  assert exists (select 1 from pg_indexes where indexname = 'task_projects_project_recent_idx'), 'the picker''s index';
  assert not has_function_privilege('authenticated', 'public.alhc_patch_function(regprocedure, text[])', 'execute'),
    'the patch helper stays internal';
  -- Workdays (Sunday–Thursday).
  assert public.workday_steps('2026-11-04', '2026-11-05', '{0,1,2,3,4}') = 1;
  assert public.workday_steps('2026-11-05', '2026-11-08', '{0,1,2,3,4}') = 1, 'Thursday to Sunday is one workday';
  assert public.workday_steps('2026-11-05', '2026-11-05', '{0,1,2,3,4}') = 0;
  assert public.workday_steps('2026-11-05', '2026-11-08', '{0,1,2,3,4,5,6}') = 3, 'all seven days: calendar days';
  assert public.workday_steps('2026-11-05', '2026-11-08', null) = 3, 'no workweek: calendar days';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Setup: the chain of the unit tests (workspace workweek Sunday–Thursday, the default)
--   A (Sun 11-01 – Tue 11-03) → B (Wed 11-04 – Thu 11-05) → C (Thu 11-05); A → D start-to-start +1;
--   A → E (completed); A → H finish-to-start +2. And F (11-01 – 11-09) → G (11-04), already too early.
-- ---------------------------------------------------------------------------------------------

do $$
begin
  assert (select work_week from public.workspaces where id = '00000000-0000-4000-8000-000000000001') = '{0,1,2,3,4}'::smallint[],
    'the default workweek is Sunday–Thursday';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b1600160-0000-4000-8000-000000000011', false) is not null as ok \gset
do $$
declare
  p uuid;
  s uuid;
  a uuid; b uuid; c uuid; d uuid; e uuid; h uuid; f uuid; g uuid;
  parent uuid; child uuid; other uuid; picker uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B16 P') returning id into p;
  perform public.add_project_member(p, 'b16-viewer@example.com', 'viewer');
  insert into public.sections (project_id, name) values (p, 'Doing') returning id into s;
  a := public.create_task(p, s, 'A');
  b := public.create_task(p, s, 'B');
  c := public.create_task(p, s, 'C');
  d := public.create_task(p, s, 'D');
  e := public.create_task(p, s, 'E');
  h := public.create_task(p, s, 'H');
  f := public.create_task(p, s, 'F');
  g := public.create_task(p, s, 'G');
  update public.tasks set start_on = '2026-11-01', due_on = '2026-11-03' where id = a;
  update public.tasks set start_on = '2026-11-04', due_on = '2026-11-05' where id = b;
  update public.tasks set start_on = '2026-11-05', due_on = '2026-11-05' where id = c;
  update public.tasks set start_on = '2026-11-04', due_on = '2026-11-04' where id in (d, e, h, g);
  update public.tasks set start_on = '2026-11-01', due_on = '2026-11-09' where id = f;
  update public.tasks set completed_at = now() where id = e;
  perform public.set_task_dependency(a, b, 'finish_to_start', 0);
  perform public.set_task_dependency(b, c, 'finish_to_start', 0);
  perform public.set_task_dependency(a, d, 'start_to_start', 1);
  perform public.set_task_dependency(a, e, 'finish_to_start', 0);
  perform public.set_task_dependency(a, h, 'finish_to_start', 2);
  perform public.set_task_dependency(f, g, 'finish_to_start', 0);
  -- 123 / 124
  parent := public.create_task(p, s, 'Spring flyer');
  child := public.create_subtask(parent, 'Write the copy', null);
  other := public.create_task(p, s, 'Brochure picker target');
  picker := public.create_task(p, s, 'Make me a subtask');
  insert into b16_ids values ('third', public.create_subtask(parent, 'Proofread', null));
  insert into b16_ids values ('p', p), ('s', s), ('a', a), ('b', b), ('c', c), ('d', d), ('e', e), ('h', h), ('f', f), ('g', g),
    ('parent', parent), ('child', child), ('other', other), ('picker', picker);
end $$;

-- ---------------------------------------------------------------------------------------------
-- 125 The plan
-- ---------------------------------------------------------------------------------------------

create function pg_temp.b16_plan(moves jsonb, pull boolean) returns text[] language sql as $$
  select coalesce(array_agg(x order by x), '{}') from (
    select n.name || ' ' || p.status || ' ' || coalesce(p.new_start::text, '-') || ' ' || coalesce(p.new_due::text, '-') || ' ' || p.shift_days as x
    from public.preview_dependency_shifts(moves, pull) p
    join b16_ids n on n.id = p.task_id
  ) q;
$$;

do $$
declare
  a uuid := (select id from b16_ids where name = 'a');
  f uuid := (select id from b16_ids where name = 'f');
  plan text[];
begin
  plan := pg_temp.b16_plan(jsonb_build_array(jsonb_build_object('task_id', a, 'due_on', '2026-11-05')), false);
  assert plan = array[
    'b move 2026-11-05 2026-11-08 1',
    'c move 2026-11-08 2026-11-08 3',
    'e skipped 2026-11-04 2026-11-04 1',
    'h move 2026-11-09 2026-11-09 5'
  ], format('later, chained, on workdays: %s', plan);

  plan := pg_temp.b16_plan(jsonb_build_array(jsonb_build_object('task_id', a, 'due_on', '2026-11-06')), false);
  assert plan = array[
    'b move 2026-11-08 2026-11-09 4',
    'c move 2026-11-09 2026-11-09 4',
    'e skipped 2026-11-04 2026-11-04 4',
    'h move 2026-11-09 2026-11-09 5'
  ], format('a Friday due date starts its dependents on Sunday: %s', plan);

  plan := pg_temp.b16_plan(jsonb_build_array(jsonb_build_object('task_id', a, 'due_on', '2026-11-02')), false);
  assert plan = '{}', format('moving earlier pulls nothing unless asked: %s', plan);
  plan := pg_temp.b16_plan(jsonb_build_array(jsonb_build_object('task_id', a, 'due_on', '2026-11-02')), true);
  assert plan = array[
    'b move 2026-11-03 2026-11-04 -1',
    'c move 2026-11-04 2026-11-04 -1',
    'e skipped 2026-11-04 2026-11-04 -1'
  ], format('pulled earlier, keeping the gap: %s', plan);

  plan := pg_temp.b16_plan(jsonb_build_array(jsonb_build_object('task_id', f, 'due_on', '2026-11-05')), false);
  assert plan = array['g move 2026-11-05 2026-11-05 1'],
    format('a dependent still too early is pushed even when its predecessor moved earlier: %s', plan);
end $$;

-- Apply (Auto-shift): every planned dependent moves, chained; Undo puts them back.
do $$
declare
  a uuid := (select id from b16_ids where name = 'a');
  b uuid := (select id from b16_ids where name = 'b');
  c uuid := (select id from b16_ids where name = 'c');
  h uuid := (select id from b16_ids where name = 'h');
  e uuid := (select id from b16_ids where name = 'e');
  moves jsonb := jsonb_build_array(jsonb_build_object('task_id', a, 'start_on', '2026-11-01', 'due_on', '2026-11-05'));
  result jsonb;
  undone jsonb;
begin
  result := public.apply_dependency_shifts(
    moves,
    (select array_agg(task_id) from public.preview_dependency_shifts(moves, true) where status = 'move'),
    true
  );
  assert (select due_on from public.tasks where id = a) = '2026-11-05';
  assert (select (start_on, due_on) from public.tasks where id = b) = ('2026-11-05'::date, '2026-11-08'::date), 'B moved';
  assert (select (start_on, due_on) from public.tasks where id = c) = ('2026-11-08'::date, '2026-11-08'::date), 'C moved with it';
  assert (select (start_on, due_on) from public.tasks where id = h) = ('2026-11-09'::date, '2026-11-09'::date), 'H moved by its lag';
  assert (select start_on from public.tasks where id = e) = '2026-11-04', 'completed tasks stay';
  assert jsonb_array_length(result -> 'changes') = 4, format('the task and three dependents: %s', result);
  undone := public.undo_dependency_shift(result -> 'changes');
  assert jsonb_array_length(undone -> 'restored') = 4, format('Undo restores them: %s', undone);
  assert (select (start_on, due_on) from public.tasks where id = b) = ('2026-11-04'::date, '2026-11-05'::date), 'B is back';
end $$;

-- A Viewer's plan lists the dependents as ones they can't edit; their apply moves nothing.
select set_config('request.jwt.claim.sub', 'b1600160-0000-4000-8000-000000000012', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b16_ids where name = 'a');
  plan text[];
  result jsonb;
begin
  plan := pg_temp.b16_plan(jsonb_build_array(jsonb_build_object('task_id', a, 'due_on', '2026-11-05')), false);
  assert 'b skipped 2026-11-04 2026-11-05 1' = any (plan), format('read-only dependents are listed: %s', plan);
  result := public.apply_dependency_shifts(jsonb_build_array(jsonb_build_object('task_id', a, 'due_on', '2026-11-05')), '{}', false);
  assert jsonb_array_length(result -> 'changes') = 0, 'a Viewer moves nothing';
  assert (select due_on from public.tasks where id = a) = '2026-11-03';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 124 The parent picker
-- ---------------------------------------------------------------------------------------------

do $$
declare
  picker uuid := (select id from b16_ids where name = 'picker');
  other uuid := (select id from b16_ids where name = 'other');
begin
  assert not exists (select 1 from public.subtask_parent_candidates(picker, '', 30)), 'a Viewer gets nothing to pick';
  assert not exists (select 1 from public.subtask_parent_candidates(picker, 'Brochure', 30)), 'nor by search';
end $$;

select set_config('request.jwt.claim.sub', 'b1600160-0000-4000-8000-000000000011', false) is not null as ok \gset
do $$
declare
  picker uuid := (select id from b16_ids where name = 'picker');
  other uuid := (select id from b16_ids where name = 'other');
  child uuid := (select id from b16_ids where name = 'child');
  e uuid := (select id from b16_ids where name = 'e');
begin
  assert exists (select 1 from public.subtask_parent_candidates(picker, '', 30) c where c.id = other), 'blank: the project''s open tasks';
  assert not exists (select 1 from public.subtask_parent_candidates(picker, '', 100) c where c.id = picker), 'never itself';
  assert not exists (select 1 from public.subtask_parent_candidates(picker, '', 100) c where c.id = e), 'blank: open tasks only';
  assert not exists (select 1 from public.subtask_parent_candidates(picker, '', 100) c where c.id = child), 'blank: top-level tasks';
  assert (select count(*) from public.subtask_parent_candidates(picker, '', 3)) = 3, 'the limit holds';
  assert exists (select 1 from public.subtask_parent_candidates(picker, 'Brochure', 30) c where c.id = other), 'typed: found by name';
  assert (select c.home_project_id from public.subtask_parent_candidates(picker, 'Brochure', 30) c where c.id = other)
    = (select id from b16_ids where name = 'p'), 'with its project';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 123 Convert to main task, blocking the task it came from
-- ---------------------------------------------------------------------------------------------

do $$
declare
  p uuid := (select id from b16_ids where name = 'p');
  s uuid := (select id from b16_ids where name = 's');
  parent uuid := (select id from b16_ids where name = 'parent');
  child uuid := (select id from b16_ids where name = 'child');
  second uuid;
  result jsonb;
begin
  result := public.convert_subtask_to_task(child, p, s, true);
  assert (select parent_task_id from public.tasks where id = child) is null, 'it is a main task now';
  assert exists (select 1 from public.task_projects where task_id = child and project_id = p and deleted_at is null), 'in the project';
  assert exists (select 1 from public.task_dependencies
    where predecessor_id = child and successor_id = parent and kind = 'finish_to_start' and lag_days = 0 and deleted_at is null),
    'and it blocks the task it came from';
  assert (result ->> 'blocks')::uuid = parent, format('the answer names it: %s', result);
  assert public.open_blocker_count(parent) = 1, 'the parent can''t be completed until it is';

  -- Without the box: no link.
  second := public.create_subtask(parent, 'Pick the photo', null);
  result := public.convert_subtask_to_task(second, p, s, false);
  assert not exists (select 1 from public.task_dependencies where predecessor_id = second and deleted_at is null), 'no link unless asked';
  assert result ->> 'blocks' is null;
end $$;

-- A Viewer can't convert (and nothing is linked).
select set_config('request.jwt.claim.sub', 'b1600160-0000-4000-8000-000000000012', false) is not null as ok \gset
do $$
declare
  third uuid := (select id from b16_ids where name = 'third');
begin
  begin
    perform public.convert_subtask_to_task(third, null, null, true);
    assert false, 'a Viewer can''t convert';
  exception when insufficient_privilege or no_data_found or check_violation then
    null;
  end;
  assert (select parent_task_id from public.tasks where id = third) is not null, 'still a subtask';
end $$;

reset role;
select 'nov2 batch16 smoke: all assertions passed' as result;
