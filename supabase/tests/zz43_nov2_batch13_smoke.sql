-- Nov 2 notes, batch 13 (20261102010000_nov2_batch13_a.sql): portfolios, workload, goals, reports.
--   88 workspaces.goals_enabled: off by default, only workspace admins turn it on.
--   90 Personal dashboards: a multi-row widget insert that leaves series_interval / filters out of some
--      rows (null for them) takes the defaults instead of failing (the bug: creating a dashboard failed).
--   86 workload_people_summary: per assignee, open / overdue today and completed in the period by local
--      day, for a project or a portfolio's rollup (nested portfolios the caller is in), never a project
--      the caller can't read; bad periods are refused.
--   a3100130…01 b13-admin@example.com   Ada Admin (workspace admin; owns P and Q, the portfolios)
--   a3100130…02 b13-worker@example.com  Wes Worker (Editor of P; not in Q)
--   a3100130…03 b13-other@example.com   Oz Other (in nothing)

\set ON_ERROR_STOP 1

create temporary table b13_ids (name text primary key, id uuid) on commit preserve rows;
grant all on b13_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('b13-admin@example.com', 'batch 13'),
  ('b13-worker@example.com', 'batch 13'),
  ('b13-other@example.com', 'batch 13');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a3100130-0000-4000-8000-000000000001', 'b13-admin@example.com', now(), '{"full_name":"Ada Admin"}'),
  ('a3100130-0000-4000-8000-000000000002', 'b13-worker@example.com', now(), '{"full_name":"Wes Worker"}'),
  ('a3100130-0000-4000-8000-000000000003', 'b13-other@example.com', now(), '{"full_name":"Oz Other"}');
select public.seed_workspace_admin('b13-admin@example.com');

-- ---------------------------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------------------------

do $$
begin
  assert (select column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'workspaces' and column_name = 'goals_enabled') = 'false',
    'goals are off by default';
  assert (select is_nullable from information_schema.columns
    where table_schema = 'public' and table_name = 'workspaces' and column_name = 'goals_enabled') = 'NO', 'never null';
  assert not (select goals_enabled from public.workspaces where id = '00000000-0000-4000-8000-000000000001'),
    'the existing workspace starts with goals off';
  assert has_column_privilege('authenticated', 'public.workspaces', 'goals_enabled', 'UPDATE'), 'grantable to admins (RLS decides)';
  assert not has_column_privilege('anon', 'public.workspaces', 'goals_enabled', 'UPDATE'), 'not anon';

  assert has_function_privilege('authenticated', 'public.workload_people_summary(uuid, uuid, date, date, text)', 'execute'),
    'members call the workload summary';
  assert not has_function_privilege('anon', 'public.workload_people_summary(uuid, uuid, date, date, text)', 'execute'),
    'anon can''t';
  assert not (select prosecdef from pg_proc where oid = 'public.workload_people_summary(uuid, uuid, date, date, text)'::regprocedure),
    'it runs as the caller (invoker)';
  assert not has_function_privilege('authenticated', 'public.alhc_patch_function(regprocedure, text[])', 'execute'),
    'the patch helper stays internal';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 88 Goals switch
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100130-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  n integer;
begin
  update public.workspaces set goals_enabled = true where id = '00000000-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  assert n = 0, 'a member can''t turn goals on';
end $$;

select set_config('request.jwt.claim.sub', 'a3100130-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  n integer;
begin
  update public.workspaces set goals_enabled = true where id = '00000000-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  assert n = 1, 'a workspace admin turns goals on';
  assert (select goals_enabled from public.workspaces where id = '00000000-0000-4000-8000-000000000001'), 'it stuck';
  update public.workspaces set goals_enabled = false where id = '00000000-0000-4000-8000-000000000001';
  assert not (select goals_enabled from public.workspaces where id = '00000000-0000-4000-8000-000000000001'), 'and off again';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 90 Personal dashboard starter widgets
-- ---------------------------------------------------------------------------------------------

do $$
declare
  d uuid;
  w public.personal_dashboard_widgets;
begin
  insert into public.personal_dashboards (name, sort_order) values ('testing', 1024) returning id into d;
  -- What a multi-row insert that names series_interval / filters for only some rows sends: null for the rest.
  insert into public.personal_dashboard_widgets (dashboard_id, kind, title, filters, series_interval, sort_order) values
    (d, 'count', 'Open tasks', '{"status":"open"}', null, 1024),
    (d, 'count', 'Overdue', '{"status":"overdue"}', null, 2048),
    (d, 'completed_series', 'Completed per week', null, 'week', 3072),
    (d, 'by_project', 'Open tasks by project', '{"status":"open"}', null, 4096);
  assert (select count(*) from public.personal_dashboard_widgets where dashboard_id = d) = 4, 'every starter widget was saved';
  assert not exists (select 1 from public.personal_dashboard_widgets where dashboard_id = d and series_interval is distinct from 'week'),
    'a missing interval is the default (week)';
  select * into w from public.personal_dashboard_widgets where dashboard_id = d and kind = 'completed_series';
  assert w.filters = '{}'::jsonb, 'missing filters are {}';
  assert w.profile_id = 'a3100130-0000-4000-8000-000000000001', 'the owner is the caller';
  -- A day series still keeps its own interval, and bad intervals / filters are still refused.
  insert into public.personal_dashboard_widgets (dashboard_id, kind, title, series_interval, sort_order)
    values (d, 'completed_series', 'Per day', 'day', 5120) returning * into w;
  assert w.series_interval = 'day', 'an explicit interval is kept';
  begin
    insert into public.personal_dashboard_widgets (dashboard_id, kind, title, series_interval) values (d, 'count', 'Bad', 'month');
    assert false, 'an unknown interval is refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.personal_dashboard_widgets (dashboard_id, kind, title, filters) values (d, 'count', 'Bad', '{"nope":1}');
    assert false, 'an unknown filter key is refused';
  exception when check_violation then null;
  end;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 86 Workload people summary
-- ---------------------------------------------------------------------------------------------

do $$
declare
  p uuid;
  q uuid;
  parent uuid;
  child uuid;
  t uuid;
  s uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B13 P')
    returning id into p;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B13 Q')
    returning id into q;
  insert into b13_ids values ('p', p), ('q', q);
  perform public.add_project_member(p, 'b13-worker@example.com', 'editor');

  -- P: the worker has two open (one overdue), completed one today and one ten days ago; the admin has one
  -- open; a subtask of the worker's counts through its parent's project; a trashed task never counts.
  t := public.create_task(p, null, 'Open, due later');
  update public.tasks set assignee_id = 'a3100130-0000-4000-8000-000000000002', due_on = current_date + 5 where id = t;
  t := public.create_task(p, null, 'Open, overdue');
  update public.tasks set assignee_id = 'a3100130-0000-4000-8000-000000000002', due_on = current_date - 3 where id = t;
  insert into b13_ids values ('overdue', t);
  t := public.create_task(p, null, 'Done today');
  update public.tasks set assignee_id = 'a3100130-0000-4000-8000-000000000002', completed_at = now() where id = t;
  t := public.create_task(p, null, 'Done ten days ago');
  update public.tasks set assignee_id = 'a3100130-0000-4000-8000-000000000002', completed_at = now() - interval '10 days' where id = t;
  t := public.create_task(p, null, 'Admin open');
  update public.tasks set assignee_id = 'a3100130-0000-4000-8000-000000000001' where id = t;
  s := public.create_subtask(t, 'Worker subtask done', null);
  update public.tasks set assignee_id = 'a3100130-0000-4000-8000-000000000002', completed_at = now() where id = s;
  t := public.create_task(p, null, 'Trashed');
  update public.tasks set assignee_id = 'a3100130-0000-4000-8000-000000000002' where id = t;
  update public.tasks set deleted_at = now() where id = t;
  t := public.create_task(p, null, 'Nobody''s');
  -- Q (the worker isn't in it): one the admin completed today.
  t := public.create_task(q, null, 'Q done by the admin');
  update public.tasks set assignee_id = 'a3100130-0000-4000-8000-000000000001' where id = t;
  update public.tasks set completed_at = now() where id = t;

  -- Portfolios: parent holds P directly; child (nested) holds Q.
  insert into public.portfolios (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B13 parent')
    returning id into parent;
  insert into public.portfolios (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B13 child')
    returning id into child;
  insert into b13_ids values ('parent', parent), ('child', child);
  perform public.add_portfolio_project(parent, p);
  perform public.add_portfolio_project(child, q);
  perform public.add_portfolio_child(parent, child);
  perform public.add_portfolio_member(parent, 'b13-worker@example.com', 'viewer');
end $$;

do $$
declare
  p uuid := (select id from b13_ids where name = 'p');
  worker record;
  admin record;
  today text := to_char(current_date, 'YYYY-MM-DD');
begin
  select * into worker from public.workload_people_summary(p, null, current_date - 6, current_date, 'UTC')
  where assignee_id = 'a3100130-0000-4000-8000-000000000002';
  assert worker.open_count = 2, format('the worker has two open tasks (got %s)', worker.open_count);
  assert worker.overdue_count = 1, 'one of them is overdue';
  assert worker.completed_count = 2, format('two completed this week, the subtask included (got %s)', worker.completed_count);
  assert (worker.completed_days ->> today)::integer = 2, 'both on today';
  assert worker.completed_days = jsonb_build_object(today, 2), 'and only today in the period';

  select * into worker from public.workload_people_summary(p, null, current_date - 29, current_date, 'UTC')
  where assignee_id = 'a3100130-0000-4000-8000-000000000002';
  assert worker.completed_count = 3, 'the last 30 days add the older one';

  select * into admin from public.workload_people_summary(p, null, current_date - 6, current_date, 'UTC')
  where assignee_id = 'a3100130-0000-4000-8000-000000000001';
  assert admin.open_count = 1 and admin.completed_count = 0 and admin.completed_days = '{}'::jsonb, 'the admin has one open task';
  assert (select count(*) from public.workload_people_summary(p, null, current_date - 6, current_date, 'UTC')) = 2,
    'only people with open or completed work (nobody for unassigned tasks)';

  -- The portfolio counts the nested portfolio's project for the admin (a member of both).
  select * into admin from public.workload_people_summary(null, (select id from b13_ids where name = 'parent'),
    current_date - 6, current_date, 'UTC')
  where assignee_id = 'a3100130-0000-4000-8000-000000000001';
  assert admin.completed_count = 1 and admin.open_count = 1, 'the nested portfolio''s project counts for its members';

  begin
    perform public.workload_people_summary(p, null, current_date, current_date - 1, 'UTC');
    assert false, 'a backwards period is refused';
  exception when check_violation then null;
  end;
  begin
    perform public.workload_people_summary(p, null, current_date - 400, current_date, 'UTC');
    assert false, 'more than a year is refused';
  exception when check_violation then null;
  end;
  begin
    perform public.workload_people_summary(p, (select id from b13_ids where name = 'parent'), current_date - 1, current_date, 'UTC');
    assert false, 'a project or a portfolio, not both';
  exception when invalid_parameter_value then null;
  end;
end $$;

-- The worker reads P but isn't a member of the nested portfolio (or of Q): Q's work never counts.
select set_config('request.jwt.claim.sub', 'a3100130-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  admin record;
begin
  assert (select count(*) from public.workload_people_summary((select id from b13_ids where name = 'q'), null,
    current_date - 6, current_date, 'UTC')) = 0, 'nothing from a project the caller can''t read';
  select * into admin from public.workload_people_summary(null, (select id from b13_ids where name = 'parent'),
    current_date - 6, current_date, 'UTC')
  where assignee_id = 'a3100130-0000-4000-8000-000000000001';
  assert admin.completed_count = 0 and admin.open_count = 1,
    'the parent portfolio leaves out the nested portfolio the caller isn''t in';
end $$;

select set_config('request.jwt.claim.sub', 'a3100130-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
begin
  assert (select count(*) from public.workload_people_summary((select id from b13_ids where name = 'p'), null,
    current_date - 6, current_date, 'UTC')) = 0, 'an outsider gets nothing for the project';
  assert (select count(*) from public.workload_people_summary(null, (select id from b13_ids where name = 'parent'),
    current_date - 6, current_date, 'UTC')) = 0, 'or for the portfolio';
end $$;

reset role;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
select 'nov2 batch13 smoke: all assertions passed' as result;
