-- Behavioural checks for Phase: Task types and nested rollups: tasks.kind validation and stories,
-- milestones (date-only, zero length on the critical path, portfolio Timeline diamonds), approval tasks on
-- the existing approvals engine (the assignee is the approver; only they decide; one inbox item per
-- event; reassigning or switching kind cancels the request; deciding completes the task), kinds kept by
-- recurrence / templates / Duplicate project / imports (which open no request and notify nobody), and
-- workload + goal progress that count nested portfolios' projects only when readable. People from
-- earlier suites:
--   5555… viewer@example.com    "Vera Viewer"
--   6666… commenter@example.com "Cora Commenter"
--   7777… editor@example.com    "Eddie Editor"
--   8888… admin@example.com     "Ada Admin"
--   9999… nonmember@example.com "Nora Nonmember"

\set ON_ERROR_STOP 1

create temporary table tk_ids (name text primary key, id uuid) on commit preserve rows;
grant all on tk_ids to authenticated, anon, service_role;

set role authenticated;

-- Kinds --------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  p uuid;
  t uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Kinds') returning id into p;
  insert into tk_ids values ('p', p);
  perform public.add_project_member(p, 'commenter@example.com', 'commenter');
  perform public.add_project_member(p, 'viewer@example.com', 'viewer');
  perform public.add_project_member(p, 'admin@example.com', 'editor');

  t := public.create_task(p, null, 'Plain');
  insert into tk_ids values ('plain', t);
  assert (select kind from public.tasks where id = t) = 'task', 'tasks default to the task kind';
  begin
    update public.tasks set kind = 'epic' where id = t;
    raise exception 'unknown kinds should be rejected';
  exception when check_violation then null;
  end;

  -- A milestone keeps only its due date, and stays that way.
  update public.tasks set start_on = '2026-11-01', due_on = '2026-11-05' where id = t;
  update public.tasks set kind = 'milestone' where id = t;
  assert (select start_on is null and due_on = '2026-11-05' and kind = 'milestone' from public.tasks where id = t),
    'switching to milestone clears the start date';
  update public.tasks set start_on = '2026-11-02' where id = t;
  assert (select start_on is null from public.tasks where id = t), 'a milestone never gains a start date';
  assert (select count(*) from public.task_stories where task_id = t and kind = 'kind_changed'
          and data ->> 'from' = 'task' and data ->> 'to' = 'milestone') = 1, 'the change is in the activity';
end $$;

-- Viewers can't change the kind (RLS: zero rows).
select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset
do $$
begin
  update public.tasks set kind = 'task' where id = (select id from tk_ids where name = 'plain');
  assert (select kind from public.tasks where id = (select id from tk_ids where name = 'plain')) = 'milestone',
    'viewers can''t change the kind';
end $$;

-- Milestones on the critical path ------------------------------------------------------------------
-- A (Nov 1–3) → M (milestone, due Nov 3) → C (Nov 3–6): M is zero length, so the chain touches end to
-- end and all three are critical. M2 (milestone due Nov 4, no links) has 2 days of slack.

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  p uuid;
  a uuid; m uuid; c uuid; m2 uuid;
  r record;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Milestone plan') returning id into p;
  a := public.create_task(p, null, 'A');
  m := public.create_task(p, null, 'M');
  c := public.create_task(p, null, 'C');
  m2 := public.create_task(p, null, 'M2');
  update public.tasks set start_on = '2026-11-01', due_on = '2026-11-03' where id = a;
  update public.tasks set kind = 'milestone', start_on = '2026-11-01', due_on = '2026-11-03' where id = m;
  update public.tasks set start_on = '2026-11-03', due_on = '2026-11-06' where id = c;
  update public.tasks set kind = 'milestone', due_on = '2026-11-04' where id = m2;
  perform public.add_task_dependency(a, m);
  perform public.add_task_dependency(m, c);

  select * into r from public.project_critical_path(p) where task_id = m;
  assert r.start_on = r.due_on and r.slack_days = 0 and r.critical, 'a milestone is zero length and critical here';
  select * into r from public.project_critical_path(p) where task_id = a;
  assert r.slack_days = 0 and r.critical, 'the milestone adds no length before C';
  select * into r from public.project_critical_path(p) where task_id = m2;
  assert r.slack_days = 2 and not r.critical, 'a free milestone has slack up to the finish';
end $$;

-- Approval tasks -----------------------------------------------------------------------------------

do $$
declare
  p uuid := (select id from tk_ids where name = 'p');
  t uuid;
  a public.approval_requests;
begin
  t := public.create_task(p, null, 'Approve the flyer');
  insert into tk_ids values ('appr', t);
  update public.tasks set kind = 'approval', assignee_id = '66666666-6666-4666-8666-666666666666' where id = t;

  assert (select count(*) from public.approval_requests where task_id = t) = 1, 'assigning opens one request';
  select * into a from public.approval_requests where task_id = t;
  assert a.status = 'pending' and a.approver_id = '66666666-6666-4666-8666-666666666666'
    and a.requested_by = '77777777-7777-4777-8777-777777777777' and a.subtask_id is null,
    'the assignee approves; whoever assigned requested it; no approval subtask';
  assert not exists (select 1 from public.subtasks where task_id = t), 'no approval subtask is created';

  -- Only the assignee decides, and nobody ticks it complete while it's open.
  begin
    perform public.decide_approval(a.id, 'approved');
    raise exception 'only the approver may decide';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.tasks set completed_at = now() where id = t;
    raise exception 'an open approval task can''t be ticked complete';
  exception when check_violation then null;
  end;

  -- A Viewer can't approve, so they can't be the assignee of an approval task.
  begin
    update public.tasks set assignee_id = '55555555-5555-4555-8555-555555555555' where id = t;
    raise exception 'viewers can''t be approval assignees';
  exception when check_violation then null;
  end;
  assert (select assignee_id from public.tasks where id = t) = '66666666-6666-4666-8666-666666666666',
    'the failed reassignment changed nothing';
end $$;

-- The assignee hears about it once (approval_requested, not also "assigned").
select set_config('request.jwt.claim.sub', '66666666-6666-4666-8666-666666666666', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from tk_ids where name = 'appr');
begin
  assert (select count(*) from public.inbox_items where task_id = t) = 1, 'one inbox item for the assignee';
  assert (select kind from public.inbox_items where task_id = t) = 'approval_requested', 'it is the approval request';
end $$;

-- Reassigning cancels the request and opens a new one for the new assignee.
select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from tk_ids where name = 'appr');
begin
  update public.tasks set assignee_id = '88888888-8888-4888-8888-888888888888' where id = t;
  assert (select status from public.approval_requests
          where task_id = t and approver_id = '66666666-6666-4666-8666-666666666666') = 'cancelled',
    'the old assignee''s request is cancelled';
  assert (select count(*) from public.approval_requests
          where task_id = t and approver_id = '88888888-8888-4888-8888-888888888888' and status = 'pending') = 1,
    'the new assignee gets a pending request';
end $$;

select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from tk_ids where name = 'appr');
  a uuid := (select id from public.approval_requests
             where task_id = (select id from tk_ids where name = 'appr') and status = 'pending');
begin
  assert (select count(*) from public.inbox_items where task_id = t) = 1
    and (select kind from public.inbox_items where task_id = t) = 'approval_requested',
    'the new assignee gets one approval_requested item';
  perform public.decide_approval(a, 'changes_requested', 'Bigger logo');
  assert (select completed_at is null from public.tasks where id = t), 'changes requested keeps the task open';
end $$;

-- The requester gets one approval_decided item per decision; resubmitting goes back to the approver.
select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from tk_ids where name = 'appr');
begin
  assert (select count(*) from public.inbox_items where task_id = t) = 1
    and (select kind from public.inbox_items where task_id = t) = 'approval_decided',
    'one approval_decided item for the requester';
  perform public.resubmit_approval((select id from public.approval_requests where task_id = t and status = 'changes_requested'));
end $$;

select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from tk_ids where name = 'appr');
begin
  assert (select count(*) from public.inbox_items where task_id = t and kind = 'approval_requested') = 2,
    'resubmitting asks the approver again (one item for that event)';
  perform public.decide_approval((select id from public.approval_requests where task_id = t and status = 'pending'), 'approved');
  assert (select completed_at is not null from public.tasks where id = t), 'approving completes the approval task';
  assert (select count(*) from public.inbox_items where task_id = t and kind = 'approval_decided') = 0,
    'the approver isn''t notified of their own decision';
end $$;

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from tk_ids where name = 'p');
  t uuid := (select id from tk_ids where name = 'appr');
  t2 uuid;
  t3 uuid;
  next_task uuid;
begin
  assert (select count(*) from public.inbox_items where task_id = t and kind = 'approval_decided') = 2,
    'one approval_decided item per decision';
  assert not exists (select 1 from public.inbox_items where task_id = t and kind = 'completed'),
    'a completion caused by the decision adds no completed item';
  assert exists (select 1 from public.task_stories where task_id = t and kind = 'completed'),
    'the completion is still in the activity';

  -- Switching away from approval cancels the open request; switching back opens a new one.
  t2 := public.create_task(p, null, 'Approve the copy');
  update public.tasks set assignee_id = '66666666-6666-4666-8666-666666666666' where id = t2;
  assert not exists (select 1 from public.approval_requests where task_id = t2), 'plain tasks open no request';
  update public.tasks set kind = 'approval' where id = t2;
  assert (select count(*) from public.approval_requests where task_id = t2 and status = 'pending') = 1,
    'switching to approval opens a request for the assignee';
  update public.tasks set kind = 'task' where id = t2;
  assert (select status from public.approval_requests where task_id = t2) = 'cancelled',
    'switching away cancels it';
  update public.tasks set assignee_id = null, kind = 'approval' where id = t2;
  assert (select count(*) from public.approval_requests where task_id = t2) = 1, 'no assignee, no request';

  -- Recurrence keeps the kind and the next occurrence asks its assignee again.
  t3 := public.create_task(p, null, 'Weekly sign-off');
  update public.tasks
  set kind = 'approval', assignee_id = '66666666-6666-4666-8666-666666666666', due_on = '2026-11-02',
      recurrence = '{"freq": "weekly", "interval": 1}'
  where id = t3;
  insert into tk_ids values ('weekly', t3);
end $$;

select set_config('request.jwt.claim.sub', '66666666-6666-4666-8666-666666666666', false) is not null as ok \gset
do $$
declare
  t3 uuid := (select id from tk_ids where name = 'weekly');
  next_task uuid;
begin
  perform public.decide_approval((select id from public.approval_requests where task_id = t3 and status = 'pending'), 'rejected');
  select recurrence_next_id into next_task from public.tasks where id = t3;
  assert (select completed_at is not null from public.tasks where id = t3), 'rejecting completes the approval task too';
  assert next_task is not null and (select kind from public.tasks where id = next_task) = 'approval',
    'the next occurrence is an approval task';
  assert (select count(*) from public.approval_requests where task_id = next_task and status = 'pending'
          and approver_id = '66666666-6666-4666-8666-666666666666') = 1, 'and has its own pending request';
end $$;

-- Templates and Duplicate project keep kinds (copies open no request) ------------------------------

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from tk_ids where name = 'p');
  copy jsonb;
  tpl uuid;
  made uuid;
begin
  copy := public.duplicate_project(p, 'Kinds copy', '{"members": true}');
  assert (select count(*) from public.tasks t join public.task_projects tp on tp.task_id = t.id
          where tp.project_id = (copy ->> 'project_id')::uuid and t.kind = 'milestone') = 1, 'milestones are copied';
  assert (select count(*) from public.tasks t join public.task_projects tp on tp.task_id = t.id
          where tp.project_id = (copy ->> 'project_id')::uuid and t.kind = 'approval') = 4, 'approval tasks are copied';
  assert not exists (
    select 1 from public.approval_requests a join public.task_projects tp on tp.task_id = a.task_id
    where tp.project_id = (copy ->> 'project_id')::uuid
  ), 'copies open no approval requests';

  tpl := public.save_task_as_template((select id from tk_ids where name = 'plain'), p, 'Milestone template');
  assert (select kind from public.task_templates where id = tpl) = 'milestone', 'task templates keep the kind';
  made := public.create_task_from_template(tpl);
  assert (select kind from public.tasks where id = made) = 'milestone', 'tasks from the template get it';
end $$;

-- Imports set kinds without opening requests or notifying anyone -----------------------------------

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  q uuid;
  run uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Imported kinds') returning id into q;
  insert into tk_ids values ('q', q);
  perform public.add_project_member(q, 'commenter@example.com', 'commenter');
  run := public.start_import_run(q, 'asana', array['kinds.json']);
  perform public.import_batch(run, jsonb_build_object(
    'project', jsonb_build_object('gid', 'kinds-proj', 'name', 'Kinds'),
    'tasks', jsonb_build_array(
      jsonb_build_object('gid', 'k1', 'title', 'Launch', 'kind', 'milestone', 'start_on', '2026-11-01', 'due_on', '2026-11-09'),
      jsonb_build_object('gid', 'k2', 'title', 'Sign off', 'kind', 'approval', 'assignee_email', 'commenter@example.com'),
      jsonb_build_object('gid', 'k3', 'title', 'Write', 'kind', 'section')
    )
  ));
  perform public.finish_import_run(run, 'completed');
end $$;

do $$
declare
  q uuid := (select id from tk_ids where name = 'q');
begin
  assert (select kind = 'milestone' and start_on is null and due_on = '2026-11-09' from public.tasks
          where home_project_id = q and title = 'Launch'), 'milestones import as milestones';
  assert (select kind = 'approval' and assignee_id = '66666666-6666-4666-8666-666666666666' from public.tasks
          where home_project_id = q and title = 'Sign off'), 'approval tasks import with their assignee';
  assert (select kind from public.tasks where home_project_id = q and title = 'Write') = 'task',
    'anything else imports as a plain task';
  assert not exists (
    select 1 from public.approval_requests a join public.tasks t on t.id = a.task_id where t.home_project_id = q
  ), 'imports open no approval requests';
end $$;

select set_config('request.jwt.claim.sub', '66666666-6666-4666-8666-666666666666', false) is not null as ok \gset
do $$
begin
  assert not exists (
    select 1 from public.inbox_items i join public.tasks t on t.id = i.task_id
    where t.home_project_id = (select id from tk_ids where name = 'q')
  ), 'imports notify nobody';
end $$;

-- Nested rollups: workload, goal progress, portfolio milestones -----------------------------------
-- Parent (Eddie) ⊃ Child (Eddie; Ada is an editor there). Parent has project PA; Child has PB (Eddie,
-- Vera is a viewer) and PS (Ada's; Eddie isn't in it). Vera is a viewer of Parent but not of Child;
-- Ada is a viewer of Parent.

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  parent uuid; child uuid; pa uuid; pb uuid;
  t uuid;
begin
  insert into public.portfolios (workspace_id, name) values (ws, 'Parent') returning id into parent;
  insert into public.portfolios (workspace_id, name) values (ws, 'Child') returning id into child;
  perform public.add_portfolio_child(parent, child);
  insert into public.projects (workspace_id, name) values (ws, 'PA') returning id into pa;
  insert into public.projects (workspace_id, name) values (ws, 'PB') returning id into pb;
  perform public.add_portfolio_project(parent, pa);
  perform public.add_portfolio_project(child, pb);
  perform public.add_portfolio_member(child, 'admin@example.com', 'editor');
  perform public.add_portfolio_member(parent, 'viewer@example.com', 'viewer');
  perform public.add_portfolio_member(parent, 'admin@example.com', 'viewer');
  perform public.add_project_member(pb, 'viewer@example.com', 'viewer');

  t := public.create_task(pa, null, 'PA work');
  update public.tasks set assignee_id = auth.uid(), due_on = '2026-11-03' where id = t;
  insert into tk_ids values ('pa_task', t);
  t := public.create_task(pb, null, 'PB work');
  update public.tasks set assignee_id = auth.uid(), due_on = '2026-11-04' where id = t;
  insert into tk_ids values ('pb_task', t);
  t := public.create_task(pb, null, 'PB done');
  update public.tasks set completed_at = now() where id = t;
  t := public.create_task(pb, null, 'PB launch');
  update public.tasks set kind = 'milestone', due_on = '2026-11-20' where id = t;
  insert into tk_ids values ('pb_milestone', t);
  insert into tk_ids values ('parent', parent), ('child', child), ('pa', pa), ('pb', pb);

  insert into public.goals (title, progress_mode) values ('Ship the rollup', 'projects') returning id into t;
  insert into public.goal_links (goal_id, portfolio_id) values (t, parent);
  insert into tk_ids values ('goal', t);
end $$;

select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', false) is not null as ok \gset
do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  ps uuid;
  t uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'PS') returning id into ps;
  perform public.add_portfolio_project((select id from tk_ids where name = 'child'), ps);
  t := public.create_task(ps, null, 'PS work');
  update public.tasks set assignee_id = auth.uid(), due_on = '2026-11-05' where id = t;
  insert into tk_ids values ('ps', ps), ('ps_task', t);
end $$;

-- Eddie: PA + PB (nested), not PS.
select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
declare
  parent uuid := (select id from tk_ids where name = 'parent');
  goal uuid := (select id from tk_ids where name = 'goal');
  r record;
begin
  assert (select array_agg(task_id order by due_on) from public.portfolio_workload(parent))
    = array[(select id from tk_ids where name = 'pa_task'), (select id from tk_ids where name = 'pb_task')],
    'workload includes the nested portfolio''s readable projects';
  assert (select project_id from public.portfolio_workload(parent) where task_id = (select id from tk_ids where name = 'pb_task'))
    = (select id from tk_ids where name = 'pb'), 'nested tasks are labelled with their project';

  select * into r from public.goal_task_counts(goal);
  assert r.task_count = 4 and r.completed_count = 1, format('goal counts nested projects: %s', row_to_json(r));
  assert public.goal_hidden_project_count(goal) = 1, 'PS is hidden from Eddie and counted as a number';
  select * into r from public.goal_progress() where goal_id = goal;
  assert r.progress = 25 and r.hidden_project_count = 1, format('goal progress rolls up: %s', row_to_json(r));

  assert (select array_agg(task_id) from public.portfolio_milestones(parent))
    = array[(select id from tk_ids where name = 'pb_milestone')], 'open milestones of nested projects';
end $$;

-- Vera reads PB but isn't in Child: nothing nested counts for her.
select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset
do $$
declare
  parent uuid := (select id from tk_ids where name = 'parent');
  goal uuid := (select id from tk_ids where name = 'goal');
begin
  assert not exists (select 1 from public.portfolio_workload(parent)), 'no workload through a hidden nested portfolio';
  assert (select task_count from public.goal_task_counts(goal)) = 0, 'no goal tasks through a hidden nested portfolio';
  assert public.goal_hidden_project_count(goal) = 3, 'PA, PB, and PS are all hidden from Vera';
  assert not exists (select 1 from public.portfolio_milestones(parent)), 'no milestones through a hidden nested portfolio';
end $$;

-- Ada: PS through Child (she's in both portfolios); PA and PB she can't read.
select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', false) is not null as ok \gset
do $$
declare
  parent uuid := (select id from tk_ids where name = 'parent');
  goal uuid := (select id from tk_ids where name = 'goal');
begin
  assert (select array_agg(task_id) from public.portfolio_workload(parent)) = array[(select id from tk_ids where name = 'ps_task')],
    'Ada sees only the nested project she can read';
  assert (select task_count from public.goal_task_counts(goal)) = 1, 'Ada''s goal count is PS only';
  assert public.goal_hidden_project_count(goal) = 2, 'PA and PB are hidden from Ada';
end $$;

-- Non-members of the portfolio get nothing.
select set_config('request.jwt.claim.sub', '99999999-9999-4999-8999-999999999999', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.portfolio_workload((select id from tk_ids where name = 'parent'))),
    'non-members get no workload';
  assert (select task_count from public.goal_task_counts((select id from tk_ids where name = 'goal'))) = 0,
    'non-members get no goal tasks';
end $$;

reset role;

-- EXECUTE surface ----------------------------------------------------------------------------------

do $$
begin
  assert not has_function_privilege('authenticated', 'public.sync_task_approval()', 'execute'),
    'the definer trigger isn''t callable';
  assert not has_function_privilege('anon', 'public.portfolio_milestones(uuid)', 'execute'), 'not for anon';
  assert has_function_privilege('authenticated', 'public.portfolio_workload(uuid, date, date, text)', 'execute'),
    'portfolio_workload keeps its grant';
  assert has_function_privilege('authenticated', 'public.goal_hidden_project_count(uuid)', 'execute'),
    'goal_hidden_project_count keeps its grant';
  assert not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and p.proname in ('guard_task_kind', 'complete_approval_task', 'portfolio_milestones', 'portfolio_workload',
        'goal_task_counts', 'goal_progress', 'project_critical_path', 'save_task_as_template', 'create_task_from_template')
  ), 'everything else in this phase is SECURITY INVOKER';
end $$;

select 'task types and rollups smoke: all assertions passed' as result;
