-- Stage 4: project_schedule_cards returns the tasks a member would see in one Calendar
-- or Timeline window, including the undated tray. A non-member, including a workspace
-- admin who is not a member, gets nothing.
--
--   b4b4…01 perf4-owner@example.com   owner of the project
--   b4b4…02 perf4-other@example.com   allowlisted, not a member
--   b4b4…03 perf4-admin@example.com   workspace admin, not a member

\set ON_ERROR_STOP 1

reset role;

insert into public.allowed_emails (email, note) values
  ('perf4-owner@example.com', 'perf step 4'),
  ('perf4-other@example.com', 'perf step 4'),
  ('perf4-admin@example.com', 'perf step 4');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b4b4b4b4-0000-4000-8000-000000000001', 'perf4-owner@example.com', now(), '{"full_name":"Sched Owner"}'),
  ('b4b4b4b4-0000-4000-8000-000000000002', 'perf4-other@example.com', now(), '{"full_name":"Sched Other"}'),
  ('b4b4b4b4-0000-4000-8000-000000000003', 'perf4-admin@example.com', now(), '{"full_name":"Sched Admin"}');
insert into public.workspace_admins (workspace_id, profile_id)
values ('00000000-0000-4000-8000-000000000001', 'b4b4b4b4-0000-4000-8000-000000000003');

do $$
begin
  assert has_function_privilege(
    'authenticated',
    'public.project_schedule_cards(uuid, jsonb, text, date, date, text)',
    'execute'
  ), 'signed-in members can read a schedule window';
  assert not has_function_privilege(
    'anon',
    'public.project_schedule_cards(uuid, jsonb, text, date, date, text)',
    'execute'
  ), 'anon cannot read a schedule window';
  assert not has_function_privilege(
    'authenticated',
    'public.alhc_task_in_schedule(text, date, date, text, timestamp with time zone, date, date)',
    'execute'
  ), 'the window predicate is not a client RPC';
  assert (
    select prosecdef from pg_proc
    where oid = 'public.project_schedule_cards(uuid, jsonb, text, date, date, text)'::regprocedure
  ), 'the schedule function is security definer';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b4b4b4b4-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  p uuid;
  section uuid;
  task uuid;
  parent uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Schedule P') returning id into p;
  insert into public.sections (project_id, name, sort_order) values (p, 'Doing', 1024) returning id into section;

  parent := public.create_task(p, section, 'Due in October');
  update public.tasks set due_on = date '2026-10-15' where id = parent;

  task := public.create_task(p, section, 'Due in December');
  update public.tasks set due_on = date '2026-12-01' where id = task;

  task := public.create_task(p, section, 'Due in August');
  update public.tasks set due_on = date '2026-08-15' where id = task;

  perform public.create_task(p, section, 'No due date');

  task := public.create_task(p, section, 'Completed without a date');
  update public.tasks set completed_at = timestamptz '2026-10-10' where id = task;

  task := public.create_task(p, section, 'Starts in October');
  update public.tasks set start_on = date '2026-10-01', due_on = date '2026-10-20' where id = task;

  task := public.create_task(p, section, 'Ends before October');
  update public.tasks set start_on = date '2026-08-01', due_on = date '2026-09-01' where id = task;

  task := public.create_task(p, section, 'Reaches into October');
  update public.tasks set start_on = date '2026-09-20', due_on = date '2026-10-02' where id = task;

  task := public.create_task(p, section, 'October milestone');
  update public.tasks set kind = 'milestone', due_on = date '2026-10-16' where id = task;

  task := public.create_task(p, section, 'Completed in October');
  update public.tasks set due_on = date '2026-10-18', completed_at = timestamptz '2026-10-18' where id = task;

  -- The child is not a calendar or timeline row.
  perform public.create_subtask(parent, 'Child of October');

  perform set_config('alhc.sched_project', p::text, false);
end $$;

-- October 2026 month (Sunday Sep 27 through Saturday Oct 31) and the timeline's week
-- scale around Oct 15 (Oct 4 through Nov 14).
do $$
declare
  p uuid := current_setting('alhc.sched_project')::uuid;
  titles jsonb;
  expected jsonb;
begin
  select coalesce(jsonb_agg(c->>'title' order by c->>'title'), '[]'::jsonb)
  into titles
  from jsonb_array_elements(public.project_schedule_cards(
    p, '{}'::jsonb, 'UTC', date '2026-09-27', date '2026-10-31', 'calendar'
  )) c;
  expected := '["Due in October","No due date","October milestone","Reaches into October","Starts in October"]'::jsonb;
  assert titles = expected, format('calendar window titles, got %s', titles);

  select coalesce(jsonb_agg(c->>'title' order by c->>'title'), '[]'::jsonb)
  into titles
  from jsonb_array_elements(public.project_schedule_cards(
    p, '{}'::jsonb, 'UTC', date '2026-10-04', date '2026-11-14', 'timeline'
  )) c;
  expected := '["Due in October","No due date","October milestone","Starts in October"]'::jsonb;
  assert titles = expected, format('timeline window titles, got %s', titles);

  select coalesce(jsonb_agg(c->>'title' order by c->>'title'), '[]'::jsonb)
  into titles
  from jsonb_array_elements(public.project_schedule_cards(
    p, '{"completion":"all"}'::jsonb, 'UTC', date '2026-09-27', date '2026-10-31', 'calendar'
  )) c;
  assert titles ? 'Completed in October', 'showing completed tasks keeps one inside the window';
  assert not titles ? 'Completed without a date', 'a completed task with no due date stays off the calendar';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b4b4b4b4-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  p uuid := current_setting('alhc.sched_project')::uuid;
begin
  assert public.project_schedule_cards(p, '{}'::jsonb, 'UTC', date '2026-09-27', date '2026-10-31', 'calendar') = '[]'::jsonb,
    'no membership, no calendar window';
  assert public.project_schedule_cards(p, '{}'::jsonb, 'UTC', date '2026-10-04', date '2026-11-14', 'timeline') = '[]'::jsonb,
    'no membership, no timeline window';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b4b4b4b4-0000-4000-8000-000000000003', false) is not null as ok \gset

do $$
declare
  p uuid := current_setting('alhc.sched_project')::uuid;
begin
  assert public.project_schedule_cards(p, '{}'::jsonb, 'UTC', date '2026-09-27', date '2026-10-31', 'calendar') = '[]'::jsonb,
    'a workspace admin who is not a member sees no calendar window';
  assert public.project_schedule_cards(p, '{}'::jsonb, 'UTC', date '2026-10-04', date '2026-11-14', 'timeline') = '[]'::jsonb,
    'a workspace admin who is not a member sees no timeline window';
end $$;

select 'perf step 4 smoke: all assertions passed' as result;
