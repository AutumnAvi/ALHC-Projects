-- Behavioural checks for Phase: My Tasks sections and workload: lazily seeded personal sections, new
-- assignments landing in Recently assigned (again after a reassignment), placing and reordering with
-- reindexing, custom sections whose deletion moves tasks back, own rows only (nobody reads or moves
-- someone else's sections or placements), bulk Move to section, and workload RPCs that never count a
-- task the caller can't read — per project and per portfolio — plus workload capacities.
-- Reuses people from earlier suites:
--   5555… viewer@example.com    "Vera Viewer"   (Viewer of the project below; assigned tasks)
--   7777… editor@example.com    "Eddie Editor"  (owner of the project and portfolio below)
--   8888… admin@example.com     "Ada Admin"     (owner of a private project; portfolio editor)
--   9999… nonmember@example.com "Nora Nonmember"

\set ON_ERROR_STOP 1

create temporary table mw_ids (name text primary key, id uuid) on commit preserve rows;
grant all on mw_ids to authenticated, anon, service_role;

set role authenticated;

-- Fixtures ---------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', false) is not null as ok \gset
do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  q uuid;
  t uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Workload private') returning id into q;
  t := public.create_task(q, null, 'Private q1');
  update public.tasks set assignee_id = '88888888-8888-4888-8888-888888888888', due_on = '2026-11-03' where id = t;
  insert into mw_ids values ('q', q), ('q1', t);
end $$;

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  p uuid;
  f uuid;
  t uuid;
  name text;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Workload') returning id into p;
  perform public.add_project_member(p, 'viewer@example.com', 'viewer');
  insert into public.custom_fields (project_id, name, field_type) values (p, 'Effort', 'number') returning id into f;
  insert into mw_ids values ('p', p), ('effort', f);
  foreach name in array array['a', 'b', 'c', 'd', 'e'] loop
    insert into mw_ids values (name, public.create_task(p, null, 'Mine ' || name));
  end loop;
end $$;

-- Later transactions: assign (so assigned_at is set after creation).
do $$
declare
  vera uuid := '55555555-5555-4555-8555-555555555555';
begin
  update public.tasks set assignee_id = vera, due_on = '2026-11-02'
  where id = (select id from mw_ids where name = 'a');
  update public.tasks set assignee_id = vera, start_on = '2026-11-02', due_on = '2026-11-06'
  where id = (select id from mw_ids where name = 'b');
  update public.tasks set assignee_id = vera where id = (select id from mw_ids where name = 'c');
  update public.tasks set assignee_id = '77777777-7777-4777-8777-777777777777', due_on = '2026-11-20'
  where id = (select id from mw_ids where name = 'd');
  insert into public.task_field_values (task_id, field_id, value) values
    ((select id from mw_ids where name = 'b'), (select id from mw_ids where name = 'effort'), '5'),
    ((select id from mw_ids where name = 'a'), (select id from mw_ids where name = 'effort'), '2');
  assert (select assigned_at from public.tasks where id = (select id from mw_ids where name = 'a')) is not null,
    'assigning stamps assigned_at';
  assert (select assigned_at from public.tasks where id = (select id from mw_ids where name = 'e')) is null,
    'unassigned tasks have no assigned_at';
  -- Clients can't set it.
  update public.tasks set assigned_at = '2000-01-01' where id = (select id from mw_ids where name = 'e');
  assert (select assigned_at from public.tasks where id = (select id from mw_ids where name = 'e')) is null,
    'assigned_at is not client-writable';
end $$;

-- Sections are seeded lazily, new assignments land in Recently assigned --------------------------

select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset
do $$
declare
  ra uuid;
  layout_count int;
begin
  assert not exists (select 1 from public.my_task_sections), 'nothing before the first visit';
  select count(*) into layout_count from public.my_tasks_layout();
  assert layout_count = 3, format('three open tasks assigned to Vera, got %s', layout_count);
  assert (select count(*) from public.my_task_sections) = 4, 'four system sections seeded';
  assert (select array_agg(kind order by sort_order) from public.my_task_sections)
    = array['recently_assigned', 'do_today', 'do_next_week', 'do_later'], 'in Asana order';
  ra := public.ensure_my_task_sections();
  assert (select kind from public.my_task_sections where id = ra) = 'recently_assigned', 'returns Recently assigned';
  assert not exists (select 1 from public.my_tasks_layout() l where l.section_id <> ra), 'new assignments land in Recently assigned';
  perform public.my_tasks_layout();
  assert (select count(*) from public.my_task_sections) = 4, 'seeding is idempotent';
  assert (select count(*) from public.my_task_placements) = 3, 'one placement per task';
  insert into mw_ids values
    ('ra', ra),
    ('today', (select id from public.my_task_sections where kind = 'do_today')),
    ('later', (select id from public.my_task_sections where kind = 'do_later'));
end $$;

-- Place, reorder, reindex ------------------------------------------------------------------------

do $$
declare
  a uuid := (select id from mw_ids where name = 'a');
  b uuid := (select id from mw_ids where name = 'b');
  c uuid := (select id from mw_ids where name = 'c');
  today uuid := (select id from mw_ids where name = 'today');
  later uuid := (select id from mw_ids where name = 'later');
  i int;
  orders double precision[];
begin
  perform public.place_my_task(a, today, null);
  assert (select section_id from public.my_tasks_layout() l where l.task_id = a) = today, 'moved to Do today';

  -- Three tasks in Do later; alternate b/c placements right under a until the gap must be reindexed.
  perform public.place_my_task(a, later, null);
  perform public.place_my_task(b, later, null);
  perform public.place_my_task(c, later, null);
  assert (select array_agg(l.task_id) from public.my_tasks_layout() l where l.section_id = later) = array[a, b, c],
    'appended in order';
  perform public.place_my_task(c, later, b);
  assert (select array_agg(l.task_id) from public.my_tasks_layout() l where l.section_id = later) = array[a, c, b],
    'placed before a neighbour';
  for i in 1..40 loop
    perform public.place_my_task(b, later, c);
    perform public.place_my_task(c, later, b);
  end loop;
  assert (select array_agg(l.task_id) from public.my_tasks_layout() l where l.section_id = later) = array[a, c, b],
    'order survives repeated midpoints';
  select array_agg(l.sort_order order by l.sort_order) into orders from public.my_tasks_layout() l where l.section_id = later;
  assert orders[2] - orders[1] >= public.min_order_gap() and orders[3] - orders[2] >= public.min_order_gap(),
    'tight gaps were reindexed';

  begin
    perform public.place_my_task(a, later, a);
    raise exception 'a task must not be placed before itself';
  exception when check_violation then null;
  end;
  begin
    perform public.place_my_task((select id from mw_ids where name = 'd'), later, null);
    raise exception 'only your own tasks can be placed';
  exception when check_violation then null;
  end;
end $$;

-- Sections: system ones are fixed; custom ones can be added, renamed, reordered, deleted -----------

do $$
declare
  b uuid := (select id from mw_ids where name = 'b');
  ra uuid := (select id from mw_ids where name = 'ra');
  today uuid := (select id from mw_ids where name = 'today');
  waiting uuid;
begin
  begin
    update public.my_task_sections set name = 'Renamed' where id = ra;
    raise exception 'system sections must not be renamed';
  exception when check_violation then null;
  end;
  begin
    update public.my_task_sections set deleted_at = now() where id = today;
    raise exception 'system sections must not be deleted';
  exception when check_violation then null;
  end;

  insert into public.my_task_sections (name, sort_order) values ('Waiting on others', 5120) returning id into waiting;
  update public.my_task_sections set name = '  Waiting  ' where id = waiting;
  assert (select name from public.my_task_sections where id = waiting) = 'Waiting', 'custom sections rename (trimmed)';
  perform public.place_my_task_section(waiting, today);
  assert (select array_agg(kind order by sort_order) from public.my_task_sections where deleted_at is null)
    = array['recently_assigned', 'custom', 'do_today', 'do_next_week', 'do_later'], 'sections reorder';

  perform public.place_my_task(b, waiting, null);
  assert (select section_id from public.my_tasks_layout() l where l.task_id = b) = waiting, 'placed in the custom section';
  update public.my_task_sections set deleted_at = now() where id = waiting;
  assert (select section_id from public.my_tasks_layout() l where l.task_id = b) = ra,
    'deleting a section moves its tasks back to Recently assigned';
  assert (select l.task_id from public.my_tasks_layout() l where l.section_id = ra order by l.sort_order desc limit 1) = b,
    'at the end of Recently assigned';
  begin
    update public.my_task_sections set deleted_at = null where id = waiting;
    raise exception 'deleted sections must not be restored';
  exception when check_violation then null;
  end;
  insert into mw_ids values ('waiting', waiting);
end $$;

-- Reassignment: a stale placement is ignored, and the task lands in Recently assigned again ---------

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
update public.tasks set assignee_id = '77777777-7777-4777-8777-777777777777'
where id = (select id from mw_ids where name = 'a');

select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.my_tasks_layout() l where l.task_id = (select id from mw_ids where name = 'a')),
    'a task assigned to someone else leaves My Tasks';
  assert exists (select 1 from public.my_task_placements where task_id = (select id from mw_ids where name = 'a')),
    'its placement row stays (ignored)';
end $$;

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
update public.tasks set assignee_id = '55555555-5555-4555-8555-555555555555'
where id = (select id from mw_ids where name = 'a');

select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from mw_ids where name = 'a');
  ra uuid := (select id from mw_ids where name = 'ra');
begin
  assert (select section_id from public.my_tasks_layout() l where l.task_id = a) = ra,
    'reassigned back: Recently assigned again, not its old section';
  assert (select l.task_id from public.my_tasks_layout() l where l.section_id = ra order by l.sort_order limit 1) = a,
    'at the top of Recently assigned';
end $$;

-- Own rows only ----------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
declare
  vera uuid := '55555555-5555-4555-8555-555555555555';
  d uuid := (select id from mw_ids where name = 'd');
  vera_today uuid := (select id from mw_ids where name = 'today');
  affected int;
  result jsonb;
begin
  perform public.my_tasks_layout();
  assert not exists (select 1 from public.my_task_sections where profile_id = vera), 'nobody reads someone else''s sections';
  assert not exists (select 1 from public.my_task_placements where profile_id = vera), 'or their placements';
  assert (select count(*) from public.my_task_sections) = 4, 'Eddie has his own sections';

  update public.my_task_sections set sort_order = 1 where id = vera_today;
  get diagnostics affected = row_count;
  assert affected = 0, 'nobody changes someone else''s section';
  update public.my_task_placements set sort_order = 1 where profile_id = vera;
  get diagnostics affected = row_count;
  assert affected = 0, 'nobody moves someone else''s placements';

  begin
    perform public.place_my_task(d, vera_today, null);
    raise exception 'placing into someone else''s section must fail';
  exception when check_violation then null;
  end;
  begin
    perform public.place_my_task_section(vera_today, null);
    raise exception 'reordering someone else''s section must fail';
  exception when no_data_found then null;
  end;
  begin
    perform public.move_my_tasks(array[d], vera_today);
    raise exception 'bulk moving into someone else''s section must fail';
  exception when invalid_parameter_value then null;
  end;
  begin
    insert into public.my_task_placements (profile_id, task_id, section_id)
    values (vera, (select id from mw_ids where name = 'a'), vera_today);
    raise exception 'nobody inserts placements for someone else';
  exception when insufficient_privilege or check_violation then null;
  end;
  begin
    insert into public.my_task_sections (profile_id, name) values (vera, 'Sneaky');
    raise exception 'nobody adds sections for someone else';
  exception when insufficient_privilege then null;
  end;
  -- Someone else's task (readable, assigned to Vera) can't go in Eddie's My Tasks.
  begin
    insert into public.my_task_placements (task_id, section_id)
    values ((select id from mw_ids where name = 'b'), public.ensure_my_task_sections());
    raise exception 'only tasks assigned to you can be placed';
  exception when check_violation then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '99999999-9999-4999-8999-999999999999', false) is not null as ok \gset
do $$
declare
  mine uuid := public.ensure_my_task_sections();
begin
  begin
    insert into public.my_task_placements (task_id, section_id) values ((select id from mw_ids where name = 'b'), mine);
    raise exception 'a placement must point at a readable task';
  exception when no_data_found or insufficient_privilege then null;
  end;
  assert not exists (select 1 from public.my_task_placements), 'nothing placed';
end $$;

-- Bulk Move to section ---------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from mw_ids where name = 'a');
  c uuid := (select id from mw_ids where name = 'c');
  d uuid := (select id from mw_ids where name = 'd');
  q1 uuid := (select id from mw_ids where name = 'q1');
  today uuid := (select id from mw_ids where name = 'today');
  result jsonb;
begin
  result := public.move_my_tasks(array[a, c, d, q1, a], today);
  assert result -> 'updated' = jsonb_build_array(a, c), format('a and c moved: %s', result);
  assert jsonb_array_length(result -> 'skipped') = 2, format('two skipped: %s', result);
  assert result -> 'skipped' -> 0 ->> 'reason' = 'It isn’t assigned to you', 'someone else''s task is skipped';
  assert result -> 'skipped' -> 1 ->> 'title' is null
     and result -> 'skipped' -> 1 ->> 'reason' = 'Not found, or you don’t have access to it',
    'an unreadable task is skipped without leaking its title';
  assert (select array_agg(l.task_id) from public.my_tasks_layout() l where l.section_id = today) = array[a, c],
    'appended in the given order';
  result := public.move_my_tasks(array[a], today);
  assert result -> 'unchanged' = jsonb_build_array(a), 'already there: unchanged';
  begin
    perform public.move_my_tasks(array[]::uuid[], today);
    raise exception 'empty selection must fail';
  exception when invalid_parameter_value then null;
  end;
end $$;

-- Completed tasks leave the layout and come back to their section when reopened.
select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
update public.tasks set completed_at = now() where id = (select id from mw_ids where name = 'c');
select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.my_tasks_layout() l where l.task_id = (select id from mw_ids where name = 'c')),
    'completed tasks are not in sections';
end $$;
select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
update public.tasks set completed_at = null where id = (select id from mw_ids where name = 'c');
select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset
do $$
begin
  assert (select section_id from public.my_tasks_layout() l where l.task_id = (select id from mw_ids where name = 'c'))
    = (select id from mw_ids where name = 'today'), 'reopened tasks return to their section';
end $$;

-- Project workload -------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from mw_ids where name = 'p');
  q uuid := (select id from mw_ids where name = 'q');
  effort uuid := (select id from mw_ids where name = 'effort');
  a uuid := (select id from mw_ids where name = 'a');
  b uuid := (select id from mw_ids where name = 'b');
  d uuid := (select id from mw_ids where name = 'd');
begin
  -- c has no due date, e is unassigned: neither is workload.
  assert (select array_agg(w.task_id order by w.due_on) from public.project_workload(p) w) = array[a, b, d],
    'open, assigned, dated tasks';
  assert (select array_agg(w.task_id order by w.due_on) from public.project_workload(p, '2026-11-05', '2026-11-10') w) = array[b],
    'span overlap (b runs Nov 2–6)';
  assert (select w.value from public.project_workload(p, null, null, effort) w where w.task_id = b) = 5, 'number field value';
  assert (select w.value from public.project_workload(p) w where w.task_id = b) is null, 'no field, no value';
  assert (select bool_and(w.can_edit) from public.project_workload(p) w), 'the owner can edit';
  assert not exists (select 1 from public.project_workload(q)), 'workload never counts unreadable tasks';
end $$;

select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset
do $$
begin
  assert (select count(*) from public.project_workload((select id from mw_ids where name = 'p'))) = 3, 'viewers see the workload';
  assert not (select bool_or(w.can_edit) from public.project_workload((select id from mw_ids where name = 'p')) w),
    'but can''t edit';
end $$;

select set_config('request.jwt.claim.sub', '99999999-9999-4999-8999-999999999999', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.project_workload((select id from mw_ids where name = 'p'))),
    'a non-member gets nothing from a project workload';
end $$;

-- Portfolio workload: only projects the caller can read --------------------------------------------

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  w uuid;
  p2 uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Workload second') returning id into p2;
  insert into public.portfolios (workspace_id, name) values (ws, 'Workload portfolio') returning id into w;
  perform public.add_portfolio_project(w, p2);
  perform public.add_portfolio_project(w, (select id from mw_ids where name = 'p'));
  insert into mw_ids values ('p2', p2);
  perform public.add_portfolio_member(w, 'admin@example.com', 'editor');
  perform public.add_portfolio_member(w, 'viewer@example.com', 'viewer');
  insert into mw_ids values ('w', w);
end $$;

select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', false) is not null as ok \gset
do $$
declare
  w uuid := (select id from mw_ids where name = 'w');
begin
  perform public.add_portfolio_project(w, (select id from mw_ids where name = 'q'));
  assert (select array_agg(x.task_id) from public.portfolio_workload(w) x) = array[(select id from mw_ids where name = 'q1')],
    'Ada sees only her own project''s tasks (she isn''t in the other project)';
end $$;

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
declare
  w uuid := (select id from mw_ids where name = 'w');
  p uuid := (select id from mw_ids where name = 'p');
  b uuid := (select id from mw_ids where name = 'b');
begin
  assert (select count(*) from public.portfolio_workload(w)) = 3, 'Eddie sees his project''s three tasks';
  assert not exists (select 1 from public.portfolio_workload(w) x where x.task_id = (select id from mw_ids where name = 'q1')),
    'portfolio membership never grants project access';
  assert (select bool_and(x.project_id = p) from public.portfolio_workload(w) x), 'labelled with a readable project';
  assert (select x.value from public.portfolio_workload(w, null, null, ' effort ') x where x.task_id = b) = 5,
    'number field matched by name';
  -- A task multi-homed into two of the portfolio's projects counts once, under its home project.
  insert into public.task_projects (task_id, project_id) values (b, (select id from mw_ids where name = 'p2'));
  assert (select count(*) from public.portfolio_workload(w) x where x.task_id = b) = 1, 'multi-homed tasks count once';
  assert (select x.project_id from public.portfolio_workload(w) x where x.task_id = b) = p, 'under the home project';
end $$;

select set_config('request.jwt.claim.sub', '99999999-9999-4999-8999-999999999999', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.portfolio_workload((select id from mw_ids where name = 'w'))),
    'a non-member gets nothing from portfolio workload';
end $$;

-- Capacities -------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from mw_ids where name = 'p');
  w uuid := (select id from mw_ids where name = 'w');
  vera uuid := '55555555-5555-4555-8555-555555555555';
begin
  perform public.set_workload_capacity(p, null, vera, 5);
  perform public.set_workload_capacity(p, null, vera, 8);
  assert (select weekly_capacity from public.workload_capacities where project_id = p and deleted_at is null) = 8,
    'one active capacity per person, updated in place';
  perform public.set_workload_capacity(null, w, vera, 12);
  perform public.set_workload_capacity(null, w, '88888888-8888-4888-8888-888888888888', 3);
  perform public.set_workload_capacity(null, w, '88888888-8888-4888-8888-888888888888', null);
  assert (select count(*) from public.workload_capacities where portfolio_id = w and deleted_at is null) = 1,
    'null clears (soft delete)';
  begin
    perform public.set_workload_capacity(p, w, vera, 1);
    raise exception 'exactly one scope';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.set_workload_capacity(p, null, vera, 0);
    raise exception 'capacity must be positive';
  exception when invalid_parameter_value then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset
do $$
declare
  affected int;
begin
  assert (select count(*) from public.workload_capacities where deleted_at is null) = 2, 'viewers read capacities';
  begin
    perform public.set_workload_capacity((select id from mw_ids where name = 'p'), null,
      '55555555-5555-4555-8555-555555555555', 40);
    raise exception 'viewers must not set capacity';
  exception when insufficient_privilege then null;
  end;
  update public.workload_capacities set weekly_capacity = 99;
  get diagnostics affected = row_count;
  assert affected = 0, 'viewers can''t update capacities directly';
end $$;

select set_config('request.jwt.claim.sub', '99999999-9999-4999-8999-999999999999', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.workload_capacities), 'non-members read no capacities';
end $$;

reset role;
do $$
begin
  assert not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and p.proname in (
      'stamp_task_assigned_at', 'guard_my_task_section', 'guard_my_task_placement', 'my_task_placement_valid',
      'on_my_task_section_deleted', 'ensure_my_task_sections', 'sync_my_task_placements', 'my_tasks_layout',
      'reindex_my_task_section', 'reindex_my_task_sections', 'place_my_task', 'place_my_task_section',
      'move_my_tasks', 'project_workload', 'portfolio_workload', 'guard_workload_capacity', 'set_workload_capacity'
    )
  ), 'every new function runs as the caller';
  assert not has_function_privilege('anon', 'public.my_tasks_layout()', 'execute'), 'anon gets nothing';
  assert not has_function_privilege('anon', 'public.portfolio_workload(uuid, date, date, text)', 'execute'), 'anon gets nothing';
end $$;

select 'my tasks and workload smoke: all assertions passed' as result;
