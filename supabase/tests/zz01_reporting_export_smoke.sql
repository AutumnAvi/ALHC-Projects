-- Behavioural checks for Phase: Reporting and export: workspace reports count only readable tasks, a
-- non-member gets no rows or names (only a hidden count), a workspace admin gets nothing extra, the
-- Include subtasks toggle (subtasks count through their root's project and section), date buckets in
-- the viewer's time zone, a widget pointing at an unreadable project stays empty, personal dashboards
-- are invisible to everyone else, anon gets nothing, and the subtask workspace hardening.
-- Fresh people for this suite (no memberships from earlier suites):
--   c1c1…01 reports-owner@example.com  owner of Report Alpha and Report Beta
--   c1c1…02 reports-peer@example.com   Viewer of Report Alpha only
--   c1c1…03 reports-out@example.com    allowlisted, in no project

\set ON_ERROR_STOP 1

create temporary table rp_ids (name text primary key, id uuid) on commit preserve rows;
grant all on rp_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('reports-owner@example.com', 'reporting suite'),
  ('reports-peer@example.com', 'reporting suite'),
  ('reports-out@example.com', 'reporting suite');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('c1c1c1c1-0000-4000-8000-000000000001', 'reports-owner@example.com', now(), '{"full_name":"Rae Owner"}'),
  ('c1c1c1c1-0000-4000-8000-000000000002', 'reports-peer@example.com', now(), '{"full_name":"Pat Peer"}'),
  ('c1c1c1c1-0000-4000-8000-000000000003', 'reports-out@example.com', now(), '{"full_name":"Oli Out"}');

insert into rp_ids values
  ('owner', 'c1c1c1c1-0000-4000-8000-000000000001'),
  ('peer', 'c1c1c1c1-0000-4000-8000-000000000002'),
  ('out', 'c1c1c1c1-0000-4000-8000-000000000003'),
  ('admin', (select profile_id from public.workspace_admins where deleted_at is null order by created_at limit 1));

do $$
begin
  assert (select id from rp_ids where name = 'admin') is not null, 'an earlier suite left a workspace admin';
end $$;

-- Fixtures (as the owner) ----------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'c1c1c1c1-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  utc_today date := (now() at time zone 'UTC')::date;
  alpha uuid;
  beta uuid;
  doing uuid;
  overdue_task uuid;
  done_task uuid;
  undated uuid;
  sub uuid;
  beta_task uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Report Alpha') returning id into alpha;
  insert into public.projects (workspace_id, name) values (ws, 'Report Beta') returning id into beta;
  insert into public.sections (project_id, name, sort_order) values (alpha, 'Doing', 1024) returning id into doing;
  perform public.add_project_member(alpha, 'reports-peer@example.com', 'viewer');

  overdue_task := public.create_task(alpha, doing, 'Overdue brochure');
  done_task := public.create_task(alpha, doing, 'Finished poster');
  undated := public.create_task(alpha, doing, 'Undated idea');
  sub := public.create_subtask(undated, 'Late step');
  beta_task := public.create_task(beta, null, 'Beta secret plan');

  update public.tasks set due_on = utc_today - 3 where id = overdue_task;
  -- 02:00 UTC is the previous day in Los Angeles.
  update public.tasks set completed_at = ((utc_today - 3)::timestamp + time '02:00') at time zone 'UTC', due_on = utc_today - 3
  where id = done_task;
  update public.tasks set due_on = utc_today - 5, assignee_id = 'c1c1c1c1-0000-4000-8000-000000000002' where id = sub;

  insert into rp_ids values ('alpha', alpha), ('beta', beta), ('doing', doing), ('overdue', overdue_task),
    ('done', done_task), ('undated', undated), ('sub', sub), ('beta_task', beta_task);
end $$;

-- Counts include only readable tasks; subtasks only on request -------------------------------------

do $$
declare
  alpha uuid := (select id from rp_ids where name = 'alpha');
  beta uuid := (select id from rp_ids where name = 'beta');
  peer uuid := (select id from rp_ids where name = 'peer');
  r record;
begin
  select * into r from public.workspace_report('{}', 'none', 'UTC');
  assert r.task_count = 4 and r.completed_count = 1 and r.incomplete_count = 3 and r.overdue_count = 1,
    format('owner totals: %s', r);
  select * into r from public.workspace_report('{"include_subtasks": true}', 'none', 'UTC');
  assert r.task_count = 5 and r.overdue_count = 2, format('subtasks count when asked: %s', r);

  assert (select count(*) from public.workspace_report('{}', 'project', 'UTC')) = 2, 'two readable projects';
  assert (select task_count from public.workspace_report('{}', 'project', 'UTC') where bucket = alpha) = 3, 'alpha has three tasks';

  -- Subtasks count through their root's project and section, with their own assignee.
  assert not exists (select 1 from public.workspace_report('{}', 'assignee', 'UTC') where bucket = peer),
    'subtask assignees are left out by default';
  assert (select task_count from public.workspace_report('{"include_subtasks": true}', 'assignee', 'UTC') where bucket = peer) = 1,
    'the subtask counts for its own assignee';
  assert (select task_count from public.workspace_report('{"include_subtasks": true}', 'section', 'UTC')
          where bucket = (select id from rp_ids where name = 'doing') and project_id = alpha) = 4,
    'the subtask counts in its root task''s section';
  assert (select bool_and(not is_subtask) from public.report_task_rows('{}', 'UTC')), 'no subtask rows by default';

  -- Filters.
  assert (select task_count from public.workspace_report(jsonb_build_object('projects', jsonb_build_array(beta)), 'none', 'UTC')) = 1,
    'project filter';
  assert (select task_count from public.workspace_report('{"status": "overdue"}', 'none', 'UTC')) = 1, 'status filter';
  assert (select task_count from public.workspace_report(
            jsonb_build_object('from', ((now() at time zone 'UTC')::date - 10)::text, 'to', ((now() at time zone 'UTC')::date)::text),
            'none', 'UTC')) = 2,
    'a date range keeps tasks due or completed in it (not undated ones)';
  assert (select task_count from public.workspace_report('{"assignees": [null]}', 'none', 'UTC')) = 4, 'unassigned';

  -- Overdue list: each task once, subtasks with their parent.
  assert (select count(*) from public.report_overdue_tasks('{}', 'UTC', 200)) = 1, 'one overdue task';
  assert (select title = 'Overdue brochure' and project_id = alpha and days_overdue >= 3
          from public.report_overdue_tasks('{}', 'UTC', 200)), 'overdue row';
  assert (select parent_task_id from public.report_overdue_tasks('{"include_subtasks": true}', 'UTC', 200)
          where task_id = (select id from rp_ids where name = 'sub')) = (select id from rp_ids where name = 'undated'),
    'an overdue subtask is listed with its parent';

  -- All-projects report.
  assert (select count(*) from public.all_projects_report('UTC')) = 2, 'all projects: both readable projects';
  assert (select incomplete_count = 2 and completed_count = 1 and overdue_count = 1
          from public.all_projects_report('UTC') where project_id = alpha), 'all projects: alpha counts';
  assert (select task_count = 1 and name = 'Report Beta' from public.all_projects_report('UTC') where project_id = beta),
    'all projects: beta counts';

  -- Validation.
  begin
    perform public.workspace_report('{"bogus": 1}', 'none', 'UTC');
    raise exception 'unknown filter keys are rejected';
  exception when check_violation then null;
  end;
  begin
    perform public.workspace_report('{"from": "2026-10-05", "to": "2026-10-01"}', 'none', 'UTC');
    raise exception 'a backwards range is rejected';
  exception when check_violation then null;
  end;
  begin
    perform public.report_completed_series('{}', 'month', 'UTC');
    raise exception 'only day or week buckets';
  exception when check_violation then null;
  end;
end $$;

-- Date buckets follow the viewer's time zone ---------------------------------------------------------

do $$
declare
  d date := (now() at time zone 'UTC')::date - 3;
  win jsonb := jsonb_build_object('from', (d - 3)::text, 'to', (d + 2)::text);
begin
  assert (select count(*) from public.report_completed_series(win, 'day', 'UTC')) = 6, 'every day comes back';
  assert (select completed_count from public.report_completed_series(win, 'day', 'UTC') where bucket_start = d) = 1,
    'UTC: completed on d';
  assert (select completed_count from public.report_completed_series(win, 'day', 'America/Los_Angeles') where bucket_start = d - 1) = 1,
    'Los Angeles: completed the day before';
  assert (select completed_count from public.report_completed_series(win, 'day', 'America/Los_Angeles') where bucket_start = d) = 0,
    'Los Angeles: nothing on d';
  assert (select sum(completed_count) from public.report_completed_series('{}', 'week', 'UTC')) = 1, 'weekly total';
  assert (select bool_and(extract(dow from bucket_start) = 0) from public.report_completed_series('{}', 'week', 'UTC')),
    'weeks start on Sunday';
  assert (select count(*) from public.report_completed_series('{}', 'day', 'UTC')) = 30, 'default day window is 30 days';
  assert (select count(*) from public.report_completed_series('{"from": "2020-01-01", "to": "2026-01-01"}', 'day', 'UTC')) = 731,
    'long day windows are capped';
end $$;

-- A viewer of Alpha only: no Beta rows, names, or ids; a hidden count instead -----------------------

select set_config('request.jwt.claim.sub', 'c1c1c1c1-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  alpha uuid := (select id from rp_ids where name = 'alpha');
  beta uuid := (select id from rp_ids where name = 'beta');
  owner_hidden integer;
begin
  assert (select task_count from public.workspace_report('{}', 'none', 'UTC')) = 3, 'peer sees alpha''s three tasks';
  assert not exists (select 1 from public.report_task_rows('{"include_subtasks": true}', 'UTC') where project_id = beta),
    'no beta rows';
  assert not exists (select 1 from public.workspace_report('{}', 'project', 'UTC') where bucket = beta), 'no beta bucket';
  assert not exists (select 1 from public.all_projects_report('UTC') where project_id = beta or name = 'Report Beta'),
    'beta never shows by name';
  assert (select count(*) from public.all_projects_report('UTC')) = 1, 'only alpha';
  assert not exists (select 1 from public.report_overdue_tasks('{"include_subtasks": true}', 'UTC', 200) r
                     join public.tasks t on t.id = r.task_id where t.title = 'Beta secret plan'), 'no beta titles';
  -- A widget pointing at an unreadable project renders empty (it never widens to everything).
  assert (select task_count from public.workspace_report(jsonb_build_object('projects', jsonb_build_array(beta)), 'none', 'UTC')) = 0,
    'a filter on an unreadable project is empty';
  assert (select sum(completed_count) from public.report_completed_series(jsonb_build_object('projects', jsonb_build_array(beta)), 'week', 'UTC')) = 0,
    'and so is its series';
  assert public.workspace_hidden_project_count() >= 1, 'beta (at least) is hidden from the peer';
  perform set_config('request.jwt.claim.sub', 'c1c1c1c1-0000-4000-8000-000000000001', true);
  owner_hidden := public.workspace_hidden_project_count();
  perform set_config('request.jwt.claim.sub', 'c1c1c1c1-0000-4000-8000-000000000002', true);
  assert public.workspace_hidden_project_count() = owner_hidden + 1, 'exactly one more hidden project than the owner';
end $$;

-- A non-member gets nothing ------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'c1c1c1c1-0000-4000-8000-000000000003', false) is not null as ok \gset

do $$
declare
  r record;
begin
  assert not exists (select 1 from public.report_task_rows('{"include_subtasks": true}', 'UTC')), 'no rows';
  select * into r from public.workspace_report('{}', 'none', 'UTC');
  assert r.task_count = 0 and r.bucket is null, 'one zero row';
  assert not exists (select 1 from public.workspace_report('{}', 'project', 'UTC')), 'no project buckets';
  assert not exists (select 1 from public.all_projects_report('UTC')), 'no projects, no names';
  assert not exists (select 1 from public.report_overdue_tasks('{}', 'UTC', 200)), 'no overdue tasks';
  assert (select sum(completed_count) from public.report_completed_series('{}', 'day', 'UTC')) = 0, 'an empty series';
end $$;

-- A workspace admin gets nothing extra -------------------------------------------------------------

select set_config('request.jwt.claim.sub', (select id::text from rp_ids where name = 'admin'), false) is not null as ok \gset

do $$
declare
  alpha uuid := (select id from rp_ids where name = 'alpha');
  beta uuid := (select id from rp_ids where name = 'beta');
begin
  assert public.is_workspace_admin(), 'acting as a workspace admin';
  assert not public.has_project_role(alpha, 'viewer') and not public.has_project_role(beta, 'viewer'),
    'who isn''t in either project';
  assert not exists (select 1 from public.report_task_rows('{"include_subtasks": true}', 'UTC') where project_id in (alpha, beta)),
    'no rows from them';
  assert not exists (select 1 from public.all_projects_report('UTC') where project_id in (alpha, beta)), 'no names';
  assert (select task_count from public.workspace_report(jsonb_build_object('projects', jsonb_build_array(alpha, beta)), 'none', 'UTC')) = 0,
    'naming them changes nothing';
  assert (select count(*) from public.all_projects_report('UTC'))
         = (select count(*) from public.projects p where p.deleted_at is null and public.has_project_role(p.id, 'viewer')),
    'exactly the projects their memberships allow';
end $$;

-- Personal dashboards: owner-only ------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'c1c1c1c1-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  d uuid;
  w uuid;
begin
  insert into public.personal_dashboards (name) values ('  My reports ') returning id into d;
  assert (select profile_id = 'c1c1c1c1-0000-4000-8000-000000000001' and name = 'My reports'
          from public.personal_dashboards where id = d), 'owned by the creator, name trimmed';
  insert into public.personal_dashboard_widgets (dashboard_id, kind, title, filters)
  values (d, 'completed_series', 'Done per week', '{"include_subtasks": true}') returning id into w;
  assert (select profile_id from public.personal_dashboard_widgets where id = w) = 'c1c1c1c1-0000-4000-8000-000000000001',
    'widgets take the dashboard''s owner';
  begin
    insert into public.personal_dashboard_widgets (dashboard_id, kind, title, filters) values (d, 'count', 'Bad', '{"nope": 1}');
    raise exception 'widget filters are validated';
  exception when check_violation then null;
  end;
  begin
    insert into public.personal_dashboard_widgets (dashboard_id, kind, title) values (d, 'pie', 'Bad');
    raise exception 'widget kinds are fixed';
  exception when check_violation then null;
  end;
  begin
    delete from public.personal_dashboards where id = d;
    raise exception 'no hard deletes';
  exception when insufficient_privilege then null;
  end;
  insert into rp_ids values ('dash', d), ('widget', w);
end $$;

select set_config('request.jwt.claim.sub', 'c1c1c1c1-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  d uuid := (select id from rp_ids where name = 'dash');
  w uuid := (select id from rp_ids where name = 'widget');
  mine uuid;
  n integer;
begin
  assert not exists (select 1 from public.personal_dashboards where id = d), 'someone else''s dashboard is invisible';
  assert not exists (select 1 from public.personal_dashboard_widgets where id = w), 'and so are its widgets';
  update public.personal_dashboards set name = 'Taken' where id = d;
  get diagnostics n = row_count;
  assert n = 0, 'can''t rename it';
  update public.personal_dashboard_widgets set title = 'Taken' where id = w;
  get diagnostics n = row_count;
  assert n = 0, 'can''t edit its widgets';
  begin
    insert into public.personal_dashboard_widgets (dashboard_id, kind, title) values (d, 'count', 'Sneaky');
    raise exception 'can''t add widgets to it';
  exception when no_data_found then null;
  end;
  insert into public.personal_dashboards (profile_id, name)
  values ('c1c1c1c1-0000-4000-8000-000000000001', 'Forged') returning id into mine;
  assert (select profile_id from public.personal_dashboards where id = mine) = 'c1c1c1c1-0000-4000-8000-000000000002',
    'a forged owner becomes the caller';
end $$;

select set_config('request.jwt.claim.sub', (select id::text from rp_ids where name = 'admin'), false) is not null as ok \gset

do $$
begin
  assert not exists (select 1 from public.personal_dashboards where id = (select id from rp_ids where name = 'dash')),
    'workspace admins don''t see other people''s dashboards';
end $$;

select set_config('request.jwt.claim.sub', 'c1c1c1c1-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  d uuid := (select id from rp_ids where name = 'dash');
begin
  update public.personal_dashboards set deleted_at = now() where id = d;
  begin
    update public.personal_dashboards set deleted_at = null where id = d;
    raise exception 'a deleted dashboard stays deleted';
  exception when check_violation then null;
  end;
end $$;

reset role;

-- Hardening: a subtask's parent must be in its workspace ---------------------------------------------

insert into public.workspaces (id, name) values ('c1c1c1c1-0000-4000-8000-0000000000ee', 'Other workspace');
insert into public.projects (id, workspace_id, name) values
  ('c1c1c1c1-0000-4000-8000-0000000000e1', 'c1c1c1c1-0000-4000-8000-0000000000ee', 'Elsewhere');

do $$
declare
  other_task uuid;
  other_sub uuid;
begin
  insert into public.tasks (home_project_id, title) values ('c1c1c1c1-0000-4000-8000-0000000000e1', 'Other root')
  returning id into other_task;
  insert into public.tasks (parent_task_id, title) values (other_task, 'Other child') returning id into other_sub;
  assert (select workspace_id from public.tasks where id = other_sub) = 'c1c1c1c1-0000-4000-8000-0000000000ee',
    'a subtask lands in its parent''s workspace';
  begin
    update public.tasks set parent_task_id = (select id from rp_ids where name = 'undated') where id = other_sub;
    raise exception 'moving a subtask under a parent in another workspace is rejected';
  exception when check_violation then null;
  end;
  insert into rp_ids values ('other_task', other_task);
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'c1c1c1c1-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
begin
  begin
    insert into public.tasks (parent_task_id, title, workspace_id)
    values ((select id from rp_ids where name = 'undated'), 'Cross-workspace', 'c1c1c1c1-0000-4000-8000-0000000000ee');
    raise exception 'a subtask sent with another workspace is rejected';
  exception when check_violation then null;
  end;
  begin
    insert into public.tasks (parent_task_id, title, home_project_id)
    values ((select id from rp_ids where name = 'undated'), 'Cross-workspace', 'c1c1c1c1-0000-4000-8000-0000000000e1');
    raise exception 'a subtask sent with a home project in another workspace is rejected';
  exception when check_violation then null;
  end;
  assert public.create_subtask((select id from rp_ids where name = 'undated'), 'Same workspace') is not null,
    'ordinary subtasks still work';
end $$;

-- anon gets nothing ----------------------------------------------------------------------------------

set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset

do $$
begin
  begin
    perform 1 from public.personal_dashboards;
    raise exception 'anon reads no dashboards';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.personal_dashboard_widgets;
    raise exception 'anon reads no widgets';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.workspace_report('{}', 'none', 'UTC');
    raise exception 'anon can''t run reports';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.workspace_hidden_project_count();
    raise exception 'anon can''t count hidden projects';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

-- EXECUTE surface: one new SECURITY DEFINER function (the count); nothing new for anon ---------------

do $$
begin
  assert not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and p.proname in ('validate_report_filters', 'report_task_rows', 'workspace_report', 'report_completed_series',
        'report_overdue_tasks', 'all_projects_report', 'guard_personal_dashboard', 'guard_personal_dashboard_widget',
        'guard_task_parent')
  ), 'everything but the hidden count is SECURITY INVOKER';
  assert (select prosecdef from pg_proc where oid = 'public.workspace_hidden_project_count()'::regprocedure),
    'the hidden count is the one definer function';
  assert not has_function_privilege('anon', 'public.workspace_hidden_project_count()', 'execute')
    and not has_function_privilege('anon', 'public.report_task_rows(jsonb, text)', 'execute')
    and not has_function_privilege('anon', 'public.workspace_report(jsonb, text, text)', 'execute')
    and not has_function_privilege('anon', 'public.report_completed_series(jsonb, text, text)', 'execute')
    and not has_function_privilege('anon', 'public.report_overdue_tasks(jsonb, text, integer)', 'execute')
    and not has_function_privilege('anon', 'public.all_projects_report(text)', 'execute'),
    'anon executes none of the reporting functions';
  assert not has_table_privilege('anon', 'public.personal_dashboards', 'select')
    and not has_table_privilege('anon', 'public.personal_dashboard_widgets', 'select'), 'no anon table grants';
  assert not has_table_privilege('authenticated', 'public.personal_dashboards', 'delete')
    and not has_table_privilege('authenticated', 'public.personal_dashboard_widgets', 'delete'), 'no hard deletes';
end $$;

select 'reporting and export smoke: all assertions passed' as result;
