-- Behavioural checks for Phase: Critical path and portfolio depth: critical path and slack on a small
-- dependency chain (undated tasks skipped, readable tasks only), project status history written by
-- set_project_status, nested portfolios that never reveal a child or project the viewer can't read
-- (rollups, hidden counts), nesting cycles rejected (also through links the caller can't see), portfolio
-- custom fields whose values only portfolio Editors+ who can read the project set, and the portfolio
-- timeline. People from earlier suites:
--   5555… viewer@example.com    "Vera Viewer"
--   6666… commenter@example.com "Cora Commenter"
--   7777… editor@example.com    "Eddie Editor"
--   8888… admin@example.com     "Ada Admin"
--   9999… nonmember@example.com "Nora Nonmember"

\set ON_ERROR_STOP 1

create temporary table cp_ids (name text primary key, id uuid) on commit preserve rows;
grant all on cp_ids to authenticated, anon, service_role;

set role authenticated;

-- Critical path ---------------------------------------------------------------------------------
-- A (Nov 1–3) → B (Nov 3–5) → C (Nov 5–10) is the critical path: each link touches and C is due last.
-- A → D (due Nov 4) leaves D 6 days of slack; F (Nov 1–2) → C leaves F 3 days; G (due Nov 8) → C is
-- already late (C starts Nov 5), so G has −3 days and counts as critical. E has no due date (skipped).

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  p uuid;
  a uuid; b uuid; c uuid; d uuid; e uuid; f uuid; g uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Launch plan') returning id into p;
  insert into cp_ids values ('cp', p);
  a := public.create_task(p, null, 'A');
  b := public.create_task(p, null, 'B');
  c := public.create_task(p, null, 'C');
  d := public.create_task(p, null, 'D');
  e := public.create_task(p, null, 'E');
  f := public.create_task(p, null, 'F');
  g := public.create_task(p, null, 'G');
  insert into cp_ids values ('a', a), ('b', b), ('c', c), ('d', d), ('e', e), ('f', f), ('g', g);
  update public.tasks set start_on = '2026-11-01', due_on = '2026-11-03' where id = a;
  update public.tasks set start_on = '2026-11-03', due_on = '2026-11-05' where id = b;
  update public.tasks set start_on = '2026-11-05', due_on = '2026-11-10' where id = c;
  update public.tasks set due_on = '2026-11-04' where id = d;
  update public.tasks set start_on = '2026-11-01', due_on = '2026-11-02' where id = f;
  update public.tasks set due_on = '2026-11-08' where id = g;
  perform public.add_task_dependency(a, b);
  perform public.add_task_dependency(b, c);
  perform public.add_task_dependency(a, d);
  perform public.add_task_dependency(f, c);
  perform public.add_task_dependency(g, c);
  perform public.add_task_dependency(e, d);
  perform public.add_project_member(p, 'viewer@example.com', 'viewer');
end $$;

do $$
declare
  r record;
  expected jsonb := jsonb_build_object(
    'a', jsonb_build_array(0, true), 'b', jsonb_build_array(0, true), 'c', jsonb_build_array(0, true),
    'd', jsonb_build_array(6, false), 'f', jsonb_build_array(3, false), 'g', jsonb_build_array(-3, true)
  );
  k text;
begin
  assert (select count(*) from public.project_critical_path((select id from cp_ids where name = 'cp'))) = 7,
    'one row per task';
  for k in select jsonb_object_keys(expected) loop
    select * into r from public.project_critical_path((select id from cp_ids where name = 'cp'))
    where task_id = (select id from cp_ids where name = k);
    assert r.slack_days = (expected -> k ->> 0)::int,
      format('slack of %s: expected %s, got %s', k, expected -> k ->> 0, r.slack_days);
    assert r.critical = (expected -> k ->> 1)::boolean, format('critical flag of %s', k);
    assert not r.skipped, format('%s is dated', k);
  end loop;
  select * into r from public.project_critical_path((select id from cp_ids where name = 'cp'))
  where task_id = (select id from cp_ids where name = 'e');
  assert r.skipped and r.slack_days is null and not r.critical, 'undated tasks are skipped';

  -- Read-only: nothing moved.
  assert (select due_on from public.tasks where id = (select id from cp_ids where name = 'g')) = '2026-11-08',
    'computing the critical path shifts no dates';
end $$;

-- Completing a task doesn't change the schedule; removing a link frees its predecessor.
do $$
declare
  r record;
begin
  perform public.remove_task_dependency((
    select id from public.task_dependencies
    where predecessor_id = (select id from cp_ids where name = 'g') and deleted_at is null
  ));
  select * into r from public.project_critical_path((select id from cp_ids where name = 'cp'))
  where task_id = (select id from cp_ids where name = 'g');
  assert r.slack_days = 2 and not r.critical, 'without its successor G only has to finish by Nov 10';
end $$;

-- Viewers see the same numbers; non-members see nothing.
select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset
do $$
begin
  assert (select slack_days from public.project_critical_path((select id from cp_ids where name = 'cp'))
          where task_id = (select id from cp_ids where name = 'd')) = 6, 'viewers get slack too';
end $$;

select set_config('request.jwt.claim.sub', '99999999-9999-4999-8999-999999999999', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.project_critical_path((select id from cp_ids where name = 'cp'))),
    'non-members get no rows';
end $$;

-- Project status history ------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from cp_ids where name = 'cp');
begin
  assert not exists (select 1 from public.project_status_updates where project_id = p), 'no history yet';
  perform public.set_project_status(p, 'at_risk', '  Vendor is late  ');
  perform public.set_project_status(p, 'off_track', null);
  assert (select count(*) from public.project_status_updates where project_id = p) = 2, 'one row per change';
  assert (
    select status from public.project_status_updates where project_id = p order by created_at desc limit 1
  ) = 'off_track', 'latest first';
  assert (
    select note from public.project_status_updates where project_id = p and status = 'at_risk'
  ) = 'Vendor is late', 'notes are trimmed like the project''s';
  assert (
    select author_id from public.project_status_updates where project_id = p and status = 'at_risk'
  ) = '77777777-7777-4777-8777-777777777777', 'who is stamped';
  assert (select status from public.projects where id = p) = 'off_track', 'the project keeps the current status';
  perform public.add_project_member(p, 'commenter@example.com', 'commenter');
end $$;

select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from cp_ids where name = 'cp');
begin
  assert (select count(*) from public.project_status_updates where project_id = p) = 2, 'viewers read the history';
  begin
    perform public.set_project_status(p, 'on_track', null);
    raise exception 'viewers can''t set the status';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.project_status_updates (project_id, status) values (p, 'complete');
    raise exception 'nobody inserts history directly';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '66666666-6666-4666-8666-666666666666', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from cp_ids where name = 'cp');
  n int;
begin
  begin
    perform public.set_project_status(p, 'complete', 'done?');
    raise exception 'commenters can''t set the status';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.project_status_updates set note = 'rewritten' where project_id = p;
    get diagnostics n = row_count;
    assert n = 0, 'history can''t be rewritten';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '99999999-9999-4999-8999-999999999999', false) is not null as ok \gset
do $$
begin
  assert not exists (
    select 1 from public.project_status_updates where project_id = (select id from cp_ids where name = 'cp')
  ), 'non-members read no history';
end $$;

-- Nested portfolios -----------------------------------------------------------------------------
-- Eddie owns portfolios P (Vera: viewer), C1 (Vera: not a member), C2 (Vera: viewer) and projects
-- Y (in P; Vera: viewer), X (in C1; Vera: viewer), Z (in C2; Vera: not a member). P ⊃ C1, P ⊃ C2.
-- Vera must see only C2 and only Y: X is readable but reached only through C1, Z isn't readable.

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  p uuid; c1 uuid; c2 uuid; x uuid; y uuid; z uuid; t uuid;
begin
  insert into public.portfolios (workspace_id, name) values (ws, 'Parent') returning id into p;
  insert into public.portfolios (workspace_id, name) values (ws, 'Child one') returning id into c1;
  insert into public.portfolios (workspace_id, name) values (ws, 'Child two') returning id into c2;
  insert into public.projects (workspace_id, name) values (ws, 'Project X') returning id into x;
  insert into public.projects (workspace_id, name) values (ws, 'Project Y') returning id into y;
  insert into public.projects (workspace_id, name) values (ws, 'Project Z') returning id into z;
  insert into cp_ids values ('p', p), ('c1', c1), ('c2', c2), ('x', x), ('y', y), ('z', z);

  t := public.create_task(x, null, 'X1');
  update public.tasks set start_on = '2026-10-01', due_on = '2026-10-20' where id = t;
  t := public.create_task(y, null, 'Y1');
  update public.tasks set due_on = '2026-12-01' where id = t;
  t := public.create_task(y, null, 'Y2');
  update public.tasks set start_on = '2026-11-15' where id = t;
  t := public.create_task(y, null, 'Y3 done');
  update public.tasks set due_on = '2027-03-01', completed_at = now() where id = t;
  t := public.create_task(z, null, 'Z1');

  perform public.add_portfolio_project(p, y);
  perform public.add_portfolio_project(c1, x);
  perform public.add_portfolio_project(c2, z);
  perform public.add_project_member(x, 'viewer@example.com', 'viewer');
  perform public.add_project_member(y, 'viewer@example.com', 'viewer');
  perform public.add_portfolio_member(p, 'viewer@example.com', 'viewer');
  perform public.add_portfolio_member(c2, 'viewer@example.com', 'viewer');

  perform public.add_portfolio_child(p, c1);
  perform public.add_portfolio_child(p, c2);
  assert public.add_portfolio_child(p, c1) = (
    select id from public.portfolio_children where parent_id = p and child_id = c1 and deleted_at is null
  ), 'nesting again is a no-op';

  assert (select count(*) from public.portfolio_rollup_projects(p)) = 3, 'the owner sees every project';
  assert (select group_id from public.portfolio_rollup_projects(p) where project_id = x) = c1, 'X comes through C1';
  assert (select group_id from public.portfolio_rollup_projects(p) where project_id = y) is null, 'Y is P''s own';
  assert public.portfolio_hidden_project_count(p) = 0, 'nothing is hidden from the owner';
  assert (select task_count from public.portfolio_report(p, 'none', 'UTC')) = 5, 'rollup counts every task once';
  assert (select task_count from public.list_portfolio_progress() where portfolio_id = p) = 5, 'sidebar rolls up';
end $$;

select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from cp_ids where name = 'p');
  c1 uuid := (select id from cp_ids where name = 'c1');
  c2 uuid := (select id from cp_ids where name = 'c2');
  x uuid := (select id from cp_ids where name = 'x');
  y uuid := (select id from cp_ids where name = 'y');
begin
  assert exists (select 1 from public.projects where id = x), 'fixture: Vera can read X itself';
  assert not exists (select 1 from public.portfolios where id = c1), 'Vera can''t see C1';
  assert not exists (select 1 from public.portfolio_children where child_id = c1), 'nor the link to it';
  assert (select count(*) from public.portfolio_children where parent_id = p and deleted_at is null) = 1,
    'only the C2 link shows';
  assert (select array_agg(portfolio_id) from public.portfolio_tree(p)) @> array[p, c2]
    and not exists (select 1 from public.portfolio_tree(p) where portfolio_id = c1), 'the tree skips C1';
  assert (select array_agg(project_id) from public.portfolio_rollup_projects(p)) = array[y],
    'rollups only count Y (X is behind C1, Z isn''t readable)';
  assert not exists (select 1 from public.portfolio_report(p, 'project', 'UTC') where bucket <> y),
    'the report shows no other project';
  assert (select task_count from public.portfolio_report(p, 'none', 'UTC')) = 3, 'nor counts its tasks';
  assert (select task_count from public.list_portfolio_progress() where portfolio_id = p) = 3, 'sidebar too';
  assert public.portfolio_hidden_project_count(p) = 2, 'X and Z are counted as hidden (a number only)';
  assert not exists (select 1 from public.portfolio_rollup_projects(c2)), 'C2 shows no unreadable project';
  assert (select array_agg(project_id) from public.portfolio_timeline(p)) = array[y], 'the timeline only has Y';
  assert (select start_on from public.portfolio_timeline(p)) = '2026-11-15', 'earliest start of open tasks';
  assert (select due_on from public.portfolio_timeline(p)) = '2026-12-01', 'latest due of open tasks (done ones ignored)';
  assert (select open_task_count from public.portfolio_timeline(p)) = 2, 'two open tasks';
  begin
    perform public.add_portfolio_child(p, c2);
    raise exception 'viewers can''t nest portfolios';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.remove_portfolio_child(p, c2);
    raise exception 'nor remove them';
  exception when insufficient_privilege then null;
  end;
end $$;

-- A non-member of the parent sees no link at all, even when they can read the child.
select set_config('request.jwt.claim.sub', '99999999-9999-4999-8999-999999999999', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.portfolio_children), 'non-members see no nesting';
  assert not exists (select 1 from public.portfolio_tree((select id from cp_ids where name = 'p'))), 'nor the tree';
  assert public.portfolio_hidden_project_count((select id from cp_ids where name = 'p')) = 0, 'nor a count';
end $$;

-- Nesting needs Viewer+ on the child; cycles are rejected, also through a link the caller can't see.
-- Ada owns H (Eddie: viewer) and is a viewer of P. Eddie nests H in C1, so P ⊃ C1 ⊃ H, where Ada can't
-- see C1 or either link. Ada then tries H ⊃ P.
select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', false) is not null as ok \gset
do $$
declare
  h uuid;
begin
  insert into public.portfolios (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'Hidden')
  returning id into h;
  insert into cp_ids values ('h', h);
  perform public.add_portfolio_member(h, 'editor@example.com', 'viewer');
  begin
    perform public.add_portfolio_child(h, (select id from cp_ids where name = 'p'));
    raise exception 'Ada isn''t a member of P yet';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from cp_ids where name = 'p');
  c1 uuid := (select id from cp_ids where name = 'c1');
  h uuid := (select id from cp_ids where name = 'h');
begin
  perform public.add_portfolio_child(c1, h);
  perform public.add_portfolio_member(p, 'admin@example.com', 'viewer');
  begin
    perform public.add_portfolio_child(c1, p);
    raise exception 'a portfolio can''t contain its parent';
  exception when check_violation then null;
  end;
  begin
    perform public.add_portfolio_child(h, p);
    raise exception 'Eddie is only a viewer of H';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.add_portfolio_child(p, p);
    raise exception 'a portfolio can''t contain itself';
  exception when check_violation then null;
  end;
  begin
    update public.portfolio_children set child_id = h where parent_id = p and child_id = c1;
    raise exception 'links can''t move';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from cp_ids where name = 'p');
  h uuid := (select id from cp_ids where name = 'h');
begin
  assert not exists (select 1 from public.portfolio_children where child_id = h), 'Ada can''t see C1 ⊃ H';
  assert not exists (select 1 from public.portfolio_tree(p) where portfolio_id = h), 'nor reach H from P';
  begin
    perform public.add_portfolio_child(h, p);
    raise exception 'cycles through hidden links are rejected too';
  exception when check_violation then null;
  end;
  begin
    insert into public.portfolio_children (parent_id, child_id) values (h, p);
    raise exception 'also on a direct insert';
  exception when check_violation then null;
  end;
end $$;

-- Portfolio custom fields -----------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from cp_ids where name = 'p');
  budget uuid;
  phase uuid;
  launch uuid;
begin
  insert into public.portfolio_fields (portfolio_id, name, field_type) values (p, '  Budget ', 'number')
  returning id into budget;
  insert into public.portfolio_fields (portfolio_id, name, field_type, options)
  values (p, 'Phase', 'single_select', '[{"id":"plan","name":"Plan","color":"blue"},{"id":"build","name":"Build","color":"green"}]')
  returning id into phase;
  insert into public.portfolio_fields (portfolio_id, name, field_type) values (p, 'Launch', 'date')
  returning id into launch;
  insert into cp_ids values ('budget', budget), ('phase', phase), ('launch', launch);
  assert (select name from public.portfolio_fields where id = budget) = 'Budget', 'names are trimmed';

  begin
    insert into public.portfolio_fields (portfolio_id, name, field_type, options)
    values (p, 'Bad', 'single_select', '[{"id":"x","name":"X","color":"neon"}]');
    raise exception 'unknown option colours are rejected';
  exception when check_violation then null;
  end;
  begin
    insert into public.portfolio_fields (portfolio_id, name, field_type, options)
    values (p, 'Bad', 'text', '[{"id":"x","name":"X","color":"zinc"}]');
    raise exception 'only single-select fields have options';
  exception when check_violation then null;
  end;
  begin
    insert into public.portfolio_fields (portfolio_id, name, field_type) values (p, 'Owner', 'people');
    raise exception 'portfolio fields are text, number, single-select, or date';
  exception when check_violation then null;
  end;
  begin
    update public.portfolio_fields set field_type = 'text' where id = budget;
    raise exception 'a field''s type is fixed';
  exception when insufficient_privilege then null;
  end;

  perform public.set_portfolio_field_value(budget, (select id from cp_ids where name = 'y'), '1500');
  perform public.set_portfolio_field_value(budget, (select id from cp_ids where name = 'y'), '2500');
  perform public.set_portfolio_field_value(phase, (select id from cp_ids where name = 'y'), '"build"');
  perform public.set_portfolio_field_value(launch, (select id from cp_ids where name = 'y'), '"2026-12-15"');
  assert (select count(*) from public.portfolio_field_values where portfolio_id = p) = 3, 'one value per field and project';
  assert (select value from public.portfolio_field_values where field_id = budget) = '2500'::jsonb, 'setting again replaces';
  assert (select updated_by from public.portfolio_field_values where field_id = budget)
    = '77777777-7777-4777-8777-777777777777', 'who is stamped';

  begin
    perform public.set_portfolio_field_value(phase, (select id from cp_ids where name = 'y'), '"ship"');
    raise exception 'unknown options are rejected';
  exception when check_violation then null;
  end;
  begin
    perform public.set_portfolio_field_value(launch, (select id from cp_ids where name = 'y'), '"2026-02-30"');
    raise exception 'impossible dates are rejected';
  exception when check_violation then null;
  end;
  begin
    perform public.set_portfolio_field_value(budget, (select id from cp_ids where name = 'y'), '"lots"');
    raise exception 'numbers must be numbers';
  exception when check_violation then null;
  end;
  begin
    perform public.set_portfolio_field_value(budget, (select id from cp_ids where name = 'x'), '10');
    raise exception 'values only for the portfolio''s own projects';
  exception when check_violation then null;
  end;
  perform public.set_portfolio_field_value(launch, (select id from cp_ids where name = 'y'), 'null');
  assert (select value from public.portfolio_field_values where field_id = launch) is null, 'JSON null clears';

  -- Ada becomes a portfolio editor but can't read project Y.
  perform public.add_portfolio_member(p, 'admin@example.com', 'editor');
end $$;

select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from cp_ids where name = 'p');
  budget uuid := (select id from cp_ids where name = 'budget');
  n int;
begin
  assert (select count(*) from public.portfolio_fields where portfolio_id = p and deleted_at is null) = 3,
    'viewers read the field definitions';
  assert (select value from public.portfolio_field_values where field_id = budget) = '2500'::jsonb,
    'and values of projects they can read';
  begin
    perform public.set_portfolio_field_value(budget, (select id from cp_ids where name = 'y'), '1');
    raise exception 'portfolio viewers can''t set values';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.portfolio_field_values (portfolio_id, field_id, project_id, value)
    values (p, (select id from cp_ids where name = 'phase'), (select id from cp_ids where name = 'y'), '"plan"');
    raise exception 'nor insert them directly';
  exception when insufficient_privilege or unique_violation then null;
  end;
  update public.portfolio_field_values set value = '1' where field_id = budget;
  get diagnostics n = row_count;
  assert n = 0, 'nor update them';
  update public.portfolio_fields set name = 'Hijacked' where id = budget;
  get diagnostics n = row_count;
  assert n = 0, 'nor rename fields';
  begin
    insert into public.portfolio_fields (portfolio_id, name, field_type) values (p, 'Mine', 'text');
    raise exception 'nor add fields';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from cp_ids where name = 'p');
  budget uuid := (select id from cp_ids where name = 'budget');
begin
  assert exists (select 1 from public.portfolio_fields where id = budget), 'Ada sees the fields';
  assert not exists (select 1 from public.portfolio_field_values where portfolio_id = p),
    'but no value of a project she can''t read';
  begin
    perform public.set_portfolio_field_value(budget, (select id from cp_ids where name = 'y'), '1');
    raise exception 'portfolio editors can''t set values on projects they can''t read';
  exception when insufficient_privilege then null;
  end;
end $$;

-- EXECUTE surface ------------------------------------------------------------------------------

reset role;
do $$
begin
  assert not has_function_privilege('anon', 'public.project_critical_path(uuid)', 'execute'), 'not for anon';
  assert not has_function_privilege('anon', 'public.portfolio_timeline(uuid)', 'execute'), 'not for anon';
  assert not has_function_privilege('anon', 'public.add_portfolio_child(uuid, uuid)', 'execute'), 'not for anon';
  assert not has_function_privilege('anon', 'public.set_portfolio_field_value(uuid, uuid, jsonb)', 'execute'),
    'not for anon';
  assert not has_function_privilege('authenticated', 'public.guard_portfolio_child()', 'execute'),
    'the definer trigger isn''t callable';
  assert has_function_privilege('authenticated', 'public.set_project_status(uuid, text, text)', 'execute'),
    'set_project_status keeps its grant';
  assert not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and p.proname in ('project_critical_path', 'add_portfolio_child', 'remove_portfolio_child', 'portfolio_tree',
        'portfolio_rollup_projects', 'portfolio_timeline', 'portfolio_report', 'list_portfolio_progress',
        'guard_portfolio_field', 'guard_portfolio_field_value', 'set_portfolio_field_value')
  ), 'everything else in this phase is SECURITY INVOKER';
end $$;

select 'critical path and portfolios smoke: all assertions passed' as result;
