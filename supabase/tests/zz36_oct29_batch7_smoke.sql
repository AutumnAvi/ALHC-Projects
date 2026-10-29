-- Oct 29 notes, batch 7 (20261029010000_oct29_batch7_a.sql): items 52, 47, 54, 49, 48, 55, 51, 55b (53 is
-- app only; 50 is parked). Four sections, one per build track (T1, T2, T3, T4), each with its own people,
-- projects, and temporary id table (b7t1_ids, b7f_ids, sf_ids, b7t4_ids), then the cross-track checks
-- (b7x_ids). Every section starts as the database owner with no signed-in person.

\set ON_ERROR_STOP 1


-- =================================================================================================
-- Track T1: 52. Only approvers complete an approval task
-- =================================================================================================

reset role;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset

-- 52. Only approvers approve or complete an approval task. Regression test for the bug: before "Ready for
--     approval" any Editor could tick an approval task complete.
--   b7b70029…01 b7-owner@example.com      owner of B7 Approvals
--   b7b70029…02 b7-editor@example.com     Editor (the assignee; not an approver)
--   b7b70029…03 b7-approver@example.com   Editor and approver
--   b7b70029…04 b7-commenter@example.com  Commenter and approver

insert into public.allowed_emails (email, note) values
  ('b7-owner@example.com', 'oct 29 batch 7'),
  ('b7-editor@example.com', 'oct 29 batch 7'),
  ('b7-approver@example.com', 'oct 29 batch 7'),
  ('b7-commenter@example.com', 'oct 29 batch 7');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b7b70029-0000-4000-8000-000000000001', 'b7-owner@example.com', now(), '{"full_name":"Opal Owner"}'),
  ('b7b70029-0000-4000-8000-000000000002', 'b7-editor@example.com', now(), '{"full_name":"Eddie Editor"}'),
  ('b7b70029-0000-4000-8000-000000000003', 'b7-approver@example.com', now(), '{"full_name":"April Approver"}'),
  ('b7b70029-0000-4000-8000-000000000004', 'b7-commenter@example.com', now(), '{"full_name":"Cole Commenter"}');

-- The local harness turns the Commenter role on for older suites; keep it on here too.
update public.workspaces set allow_commenter_role = true where id = '00000000-0000-4000-8000-000000000001';

create temporary table b7t1_ids (name text primary key, id uuid);
grant all on b7t1_ids to authenticated, anon;

-- ---------------------------------------------------------------------------------------------
-- Setup
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  a uuid;
  sa uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B7 Approvals') returning id into a;
  insert into public.sections (project_id, name, sort_order) values (a, 'Intake', 1024) returning id into sa;
  insert into b7t1_ids values ('a', a), ('sa', sa);
  perform public.add_project_member(a, 'b7-editor@example.com', 'editor');
  perform public.add_project_member(a, 'b7-approver@example.com', 'editor');
  perform public.add_project_member(a, 'b7-commenter@example.com', 'commenter');
end $$;

-- The Editor (not an approver) makes an approval task assigned to themselves.
select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b7t1_ids where name = 'a');
  sa uuid := (select id from b7t1_ids where name = 'sa');
  t uuid;
  msg text;
begin
  t := public.create_task(a, sa, 'Brand guide approval');
  insert into b7t1_ids values ('t', t);
  insert into b7t1_ids values ('plain', public.create_task(a, sa, 'Plain task'));
  update public.tasks set kind = 'approval', assignee_id = 'b7b70029-0000-4000-8000-000000000002' where id = t;

  -- THE BUG: before "Ready for approval" an Editor who isn't an approver completed it.
  begin
    update public.tasks set completed_at = now() where id = t;
    raise exception 'an Editor who isn''t an approver must not complete an approval task';
  exception when check_violation then
    get stacked diagnostics msg = message_text;
    assert msg = 'Only its approvers can complete an approval task. Send it with Ready for approval.', 'the reason: ' || msg;
  end;
  assert (select completed_at from public.tasks where id = t) is null, 'still open';

  -- A new approval task can't be inserted already complete by a person either.
  begin
    insert into public.tasks (home_project_id, title, kind, completed_at) values (a, 'Done on arrival', 'approval', now());
    raise exception 'inserting a completed approval task is refused';
  exception when check_violation then null;
  end;

  -- Other kinds are unaffected.
  update public.tasks set completed_at = now() where id = (select id from b7t1_ids where name = 'plain');
  update public.tasks set completed_at = null where id = (select id from b7t1_ids where name = 'plain');
end $$;

-- With no approvers nobody completes it by hand, not even the project's owner.
select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b7t1_ids where name = 't');
begin
  begin
    update public.tasks set completed_at = now() where id = t;
    raise exception 'with no approvers nobody completes it, the owner included';
  exception when check_violation then null;
  end;
end $$;

-- Approvers: April (Editor) and Cole (Commenter). The Editor still can't complete it.
select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b7t1_ids where name = 't');
  plain uuid := (select id from b7t1_ids where name = 'plain');
  result jsonb;
  cards jsonb;
  msg text;
begin
  perform public.set_task_approvers(t,
    array['b7b70029-0000-4000-8000-000000000003'::uuid, 'b7b70029-0000-4000-8000-000000000004'::uuid], 'any', null);
  begin
    update public.tasks set completed_at = now() where id = t;
    raise exception 'still not an approver';
  exception when check_violation then null;
  end;

  -- Nor by switching it to another type and completing it in the same statement.
  begin
    update public.tasks set kind = 'task', completed_at = now() where id = t;
    raise exception 'switching the type in the same statement doesn''t get around it';
  exception when check_violation then
    get stacked diagnostics msg = message_text;
    assert msg = 'Only its approvers can complete an approval task. Send it with Ready for approval.', 'the reason: ' || msg;
  end;
  assert (select kind = 'approval' and completed_at is null from public.tasks where id = t), 'still an open approval task';

  -- The rows know who approves.
  assert not (public.task_approval_state(t) ->> 'is_approver')::boolean, 'the Editor isn''t an approver';
  cards := public.project_task_cards((select id from b7t1_ids where name = 'a'), array[t]);
  assert (cards -> 0 ->> 'approval_is_approver')::boolean = false, 'cards say so too';
  assert public.task_approval_states(array[t, plain]) ? t::text, 'approval tasks are in the map';
  assert not (public.task_approval_states(array[t, plain]) ? plain::text), 'other kinds aren''t';

  -- Bulk Complete skips it with the reason (and completes the rest).
  result := public.bulk_update_tasks(array[t, plain], '{"action": "complete"}'::jsonb);
  assert result -> 'updated' ? plain::text, 'the plain task completed';
  assert jsonb_array_length(result -> 'skipped') = 1
     and result -> 'skipped' -> 0 ->> 'task_id' = t::text
     and result -> 'skipped' -> 0 ->> 'reason' = 'Only its approvers can complete an approval task. Send it with Ready for approval.',
    'bulk skips the approval task with the reason: ' || (result -> 'skipped')::text;
  assert (select completed_at from public.tasks where id = t) is null, 'still open after bulk';
end $$;

-- An approver who edits the task completes it (no round pending); anyone who edits it reopens it.
select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b7t1_ids where name = 't');
  result jsonb;
  cards jsonb;
begin
  assert (public.task_approval_state(t) ->> 'is_approver')::boolean, 'April approves it';
  cards := public.project_task_cards((select id from b7t1_ids where name = 'a'), array[t]);
  assert (cards -> 0 ->> 'approval_is_approver')::boolean, 'her cards say so';

  update public.tasks set completed_at = now() where id = t;
  assert (select completed_at from public.tasks where id = t) is not null, 'an approver completes it';
  update public.tasks set completed_at = null where id = t;

  result := public.bulk_update_tasks(array[t], '{"action": "complete"}'::jsonb);
  assert result -> 'updated' ? t::text, 'bulk complete works for an approver';
end $$;

select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b7t1_ids where name = 't');
begin
  update public.tasks set completed_at = null where id = t;
  assert (select completed_at from public.tasks where id = t) is null, 'reopening is unchanged (any Editor)';

  -- Ready for approval: pending.
  perform public.send_for_approval(t, 'Brand guide, final', '{}', false, 'complete', null);
  assert public.task_approval_state(t) ->> 'status' = 'pending', 'pending';
end $$;

-- While it's pending nobody ticks it complete: an approver is told to Approve, others that it's waiting.
select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b7t1_ids where name = 't');
  msg text;
begin
  begin
    update public.tasks set completed_at = now() where id = t;
    raise exception 'an approver doesn''t tick a pending approval complete';
  exception when check_violation then
    get stacked diagnostics msg = message_text;
    assert msg = 'This task is waiting for your approval. Approve it instead of marking it complete.', 'approver message: ' || msg;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b7t1_ids where name = 't');
  msg text;
begin
  begin
    update public.tasks set completed_at = now() where id = t;
    raise exception 'a non-approver doesn''t complete a pending approval';
  exception when check_violation then
    get stacked diagnostics msg = message_text;
    assert msg = 'This task is waiting for approval. Only its approvers can complete it.', 'non-approver message: ' || msg;
  end;
end $$;

-- Cole (Commenter approver) requests changes: the Editor still can't complete it, before or after
-- marking the feedback received.
select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000004', false) is not null as ok \gset
select public.decide_approval((select id from public.approval_requests where task_id = (select id from b7t1_ids where name = 't')
  and approver_id = 'b7b70029-0000-4000-8000-000000000004' and status = 'pending'), 'changes_requested', 'Use the new logo');

select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b7t1_ids where name = 't');
begin
  assert public.task_approval_state(t) ->> 'status' = 'changes_requested', 'changes requested';
  begin
    update public.tasks set completed_at = now() where id = t;
    raise exception 'not after changes were requested either';
  exception when check_violation then null;
  end;
  perform public.acknowledge_approval(t);
  begin
    update public.tasks set completed_at = now() where id = t;
    raise exception 'nor once the feedback is marked received';
  exception when check_violation then null;
  end;
  perform public.send_for_approval(t, 'Brand guide, with the new logo', '{}', false, 'complete', null);
end $$;

-- The system path: April approves, and approving completes it.
select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000003', false) is not null as ok \gset
select public.decide_approval((select id from public.approval_requests where task_id = (select id from b7t1_ids where name = 't')
  and approver_id = 'b7b70029-0000-4000-8000-000000000003' and status = 'pending'), 'approved', 'Ship it');
do $$
begin
  assert public.task_approval_state((select id from b7t1_ids where name = 't')) ->> 'status' = 'approved', 'approved';
  assert (select completed_at from public.tasks where id = (select id from b7t1_ids where name = 't')) is not null,
    'Approve completes the task (the system path still works)';
end $$;

-- Subtasks of kind approval follow the same rule.
select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  parent uuid := (select id from b7t1_ids where name = 'plain');
  sub uuid;
begin
  sub := public.create_subtask(parent, 'Legal sign-off', null);
  insert into b7t1_ids values ('sub', sub);
  update public.tasks set kind = 'approval' where id = sub;
  begin
    update public.tasks set completed_at = now() where id = sub;
    raise exception 'an approval subtask follows the rule too';
  exception when check_violation then null;
  end;
  perform public.set_task_approvers(sub, array['b7b70029-0000-4000-8000-000000000003'::uuid], 'any', null);
end $$;
select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
begin
  update public.tasks set completed_at = now() where id = (select id from b7t1_ids where name = 'sub');
  assert (select completed_at from public.tasks where id = (select id from b7t1_ids where name = 'sub')) is not null,
    'its approver completes the approval subtask';
end $$;

-- Rules never complete approval tasks: the "Mark complete" step is skipped (logged), the run succeeds.
select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b7t1_ids where name = 'a');
  t2 uuid;
  rid uuid;
  result jsonb;
  run public.rule_runs;
begin
  t2 := public.create_task(a, (select id from b7t1_ids where name = 'sa'), 'Press release approval');
  update public.tasks set kind = 'approval' where id = t2;
  insert into b7t1_ids values ('t2', t2);
  insert into public.rules (project_id, name, enabled, trigger_type, actions) values (a, 'Wrap up', true, 'manual',
    jsonb_build_array(jsonb_build_object('type', 'complete_task'), jsonb_build_object('type', 'add_comment', 'body', 'Wrapped up')))
    returning id into rid;
  result := public.run_manual_rule(rid, t2);
  select * into run from public.rule_runs where rule_id = rid order by created_at desc limit 1;
  assert run.status = 'succeeded', 'the run succeeds: ' || coalesce(run.status, 'none') || ' ' || coalesce(run.detail::text, '');
  assert run.detail -> 'actions' -> 0 ->> 'outcome' = 'skipped'
     and run.detail -> 'actions' -> 0 ->> 'result' = 'Approval tasks are completed by their approvers',
    'the step is skipped with the reason: ' || (run.detail -> 'actions')::text;
  assert run.detail -> 'actions' -> 1 ->> 'outcome' = 'done', 'the next step still runs';
  assert (select completed_at from public.tasks where id = t2) is null, 'the rule didn''t complete it';

  -- A plain task still completes through the same rule.
  result := public.run_manual_rule(rid, (select id from b7t1_ids where name = 'plain'));
  assert (select completed_at from public.tasks where id = (select id from b7t1_ids where name = 'plain')) is not null,
    'rules complete other tasks as before';
end $$;
reset role;

-- The guard backs that up for anything else a rule runs.
do $$
declare
  t2 uuid := (select id from b7t1_ids where name = 't2');
begin
  perform set_config('alhc.rule_id', gen_random_uuid()::text, true);
  begin
    update public.tasks set completed_at = now() where id = t2;
    raise exception 'nothing in rule context completes an approval task';
  exception when check_violation then null;
  end;
  perform set_config('alhc.rule_id', '', true);
end $$;

-- My Tasks rules' "Mark complete" skips approval tasks too.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000002', false) is not null as ok \gset
insert into public.my_task_rules (name, trigger_type, actions)
values ('Done when assigned', 'assigned', '[{"type": "complete_task"}]');
select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000001', false) is not null as ok \gset
update public.tasks set assignee_id = 'b7b70029-0000-4000-8000-000000000002' where id = (select id from b7t1_ids where name = 't2');
reset role;
do $$
declare
  t2 uuid := (select id from b7t1_ids where name = 't2');
  run public.my_task_rule_runs;
begin
  select * into run from public.my_task_rule_runs where task_id = t2 order by created_at desc limit 1;
  assert found, 'the My Tasks rule ran';
  assert run.status = 'succeeded', 'and succeeded: ' || run.status;
  assert run.detail -> 'actions' -> 0 ->> 'outcome' = 'skipped', 'its Mark complete was skipped: ' || run.detail::text;
  assert (select completed_at from public.tasks where id = t2) is null, 'the approval task stays open';
  update public.my_task_rules set enabled = false where name = 'Done when assigned';
end $$;

-- Recurrence: an approver completing a recurring approval task spawns the next one, open, with the same
-- approver (the spawn isn't a person). Imports bring completed approval tasks in completed.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b7t1_ids where name = 'a');
  t3 uuid;
  run uuid;
begin
  t3 := public.create_task(a, (select id from b7t1_ids where name = 'sa'), 'Weekly numbers approval');
  update public.tasks set kind = 'approval', due_on = '2026-11-02', recurrence = '{"freq": "weekly", "interval": 1}' where id = t3;
  perform public.set_task_approvers(t3, array['b7b70029-0000-4000-8000-000000000003'::uuid], 'any', null);
  insert into b7t1_ids values ('t3', t3);

  run := public.start_import_run(a, 'asana', array['b7-approvals.json']);
  perform public.import_batch(run, jsonb_build_object(
    'project', jsonb_build_object('gid', 'b7-approvals-proj', 'name', 'B7 Approvals'),
    'tasks', jsonb_build_array(
      jsonb_build_object('gid', 'b7-k1', 'title', 'Signed off in Asana', 'kind', 'approval', 'completed_at', '2026-10-01T10:00:00Z')
    )
  ));
  perform public.finish_import_run(run, 'completed');
  assert (select kind = 'approval' and completed_at is not null from public.tasks
          where home_project_id = a and title = 'Signed off in Asana' and deleted_at is null),
    'imports keep a completed approval task completed';
end $$;

select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  t3 uuid := (select id from b7t1_ids where name = 't3');
  next_task uuid;
begin
  update public.tasks set completed_at = now() where id = t3;
  select recurrence_next_id into next_task from public.tasks where id = t3;
  assert next_task is not null, 'completing it spawned the next occurrence';
  assert (select kind = 'approval' and completed_at is null from public.tasks where id = next_task), 'open, still an approval task';
  assert exists (select 1 from public.task_approvers where task_id = next_task and deleted_at is null
                 and profile_id = 'b7b70029-0000-4000-8000-000000000003'), 'with the same approver';
end $$;
reset role;

-- Copies keep a completed approval task completed (the copy engine isn't a person).
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  copy jsonb;
begin
  copy := public.duplicate_project((select id from b7t1_ids where name = 'a'), 'B7 Approvals copy', '{}');
  assert exists (
    select 1 from public.tasks t join public.task_projects tp on tp.task_id = t.id and tp.deleted_at is null
    where tp.project_id = (copy ->> 'project_id')::uuid and t.kind = 'approval'
      and t.title = 'Brand guide approval' and t.completed_at is not null
  ), 'Duplicate project keeps the completed approval task completed';
end $$;
reset role;

-- Grants: the batch helper is the caller's (invoker), nothing for anon.
do $$
begin
  assert has_function_privilege('authenticated', 'public.task_approval_states(uuid[])', 'execute'), 'members read states';
  assert not has_function_privilege('anon', 'public.task_approval_states(uuid[])', 'execute'), 'anon doesn''t';
  assert not (select prosecdef from pg_proc where oid = 'public.task_approval_states(uuid[])'::regprocedure), 'invoker';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 52 (review fixes): a rule triggered by the approval itself completes the task once the approval is
-- given. approval_decided rules run before the round settles (the trigger order), so the round still
-- reads pending when they run; approval_round_approved() counts a round whose requests already meet
-- settle_approval_round's approve condition.
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b7t1_ids where name = 'a');
  done_section uuid;
  rid uuid;
begin
  insert into public.sections (project_id, name, sort_order) values (a, 'Signed off', 4096) returning id into done_section;
  insert into b7t1_ids values ('done_section', done_section);
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions)
  values (a, 'Done when approved', true, 'approval_decided', '{"statuses": ["approved"]}', '[{"type": "complete_task"}]')
  returning id into rid;
  insert into b7t1_ids values ('approved_rule', rid);
end $$;

-- The assignee sends three approval tasks with More steps (so the round itself doesn't complete them):
-- fa = "Any one can approve" (April), fb = "Everyone must approve" (April and Cole, then move to Signed
-- off), fc = "Everyone must approve" (April and Cole, just notify).
select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b7t1_ids where name = 'a');
  sa uuid := (select id from b7t1_ids where name = 'sa');
  both_approvers uuid[] := array['b7b70029-0000-4000-8000-000000000003'::uuid, 'b7b70029-0000-4000-8000-000000000004'::uuid];
  fa uuid;
  fb uuid;
  fc uuid;
begin
  fa := public.create_task(a, sa, 'Logo approval (any one)');
  fb := public.create_task(a, sa, 'Poster approval (everyone)');
  fc := public.create_task(a, sa, 'Banner approval (everyone)');
  insert into b7t1_ids values ('fa', fa), ('fb', fb), ('fc', fc);
  update public.tasks set kind = 'approval', assignee_id = 'b7b70029-0000-4000-8000-000000000002' where id in (fa, fb, fc);
  perform public.set_task_approvers(fa, array['b7b70029-0000-4000-8000-000000000003'::uuid], 'any', null);
  perform public.set_task_approvers(fb, both_approvers, 'all', null);
  perform public.set_task_approvers(fc, both_approvers, 'all', null);
  perform public.send_for_approval(fa, 'Logo, final', '{}', true, 'notify', null);
  perform public.send_for_approval(fb, 'Poster, final', '{}', true, 'move_section', (select id from b7t1_ids where name = 'done_section'));
  perform public.send_for_approval(fc, 'Banner, final', '{}', true, 'notify', null);
end $$;

-- Any one: April's approval runs the rule, and its Mark complete completes the task.
select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000003', false) is not null as ok \gset
select public.decide_approval((select id from public.approval_requests where task_id = (select id from b7t1_ids where name = 'fa')
  and approver_id = 'b7b70029-0000-4000-8000-000000000003' and status = 'pending'), 'approved', 'Good');
-- Everyone: April approves first (Cole is still pending).
select public.decide_approval((select id from public.approval_requests where task_id = (select id from b7t1_ids where name = 'fb')
  and approver_id = 'b7b70029-0000-4000-8000-000000000003' and status = 'pending'), 'approved', 'Good');
reset role;

do $$
declare
  fa uuid := (select id from b7t1_ids where name = 'fa');
  fb uuid := (select id from b7t1_ids where name = 'fb');
  rid uuid := (select id from b7t1_ids where name = 'approved_rule');
  run public.rule_runs;
begin
  assert public.task_approval_state(fa) ->> 'status' = 'approved', 'any one: the round is approved';
  select * into run from public.rule_runs where rule_id = rid and task_id = fa order by created_at desc limit 1;
  assert found and run.status = 'succeeded', 'the approval_decided rule ran for fa';
  assert run.detail -> 'actions' -> 0 ->> 'result' = 'Marked complete',
    'THE REVIEW BUG: the rule''s Mark complete was skipped as "completed by their approvers": ' || run.detail::text;
  assert (select completed_at from public.tasks where id = fa) is not null, 'the rule completed the approved task';

  -- Everyone: one of two approved, so the approval isn't given yet; the rule's step is skipped.
  assert public.task_approval_state(fb) ->> 'status' = 'pending', 'everyone: still pending after the first approval';
  assert not public.approval_round_approved(fb), 'not approved yet';
  select * into run from public.rule_runs where rule_id = rid and task_id = fb order by created_at desc limit 1;
  assert found and run.status = 'succeeded'
     and run.detail -> 'actions' -> 0 ->> 'outcome' = 'skipped'
     and run.detail -> 'actions' -> 0 ->> 'result' = 'Approval tasks are completed by their approvers',
    'the first approval''s run skips: ' || coalesce(run.detail::text, '');
  assert (select completed_at from public.tasks where id = fb) is null, 'still open';
end $$;

-- Cole's approval gives it: the rule completes it, and the round's More steps still move it.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000004', false) is not null as ok \gset
select public.decide_approval((select id from public.approval_requests where task_id = (select id from b7t1_ids where name = 'fb')
  and approver_id = 'b7b70029-0000-4000-8000-000000000004' and status = 'pending'), 'approved', 'Good');
reset role;

do $$
declare
  fb uuid := (select id from b7t1_ids where name = 'fb');
  run public.rule_runs;
begin
  assert public.task_approval_state(fb) ->> 'status' = 'approved', 'everyone: approved once both did';
  select * into run from public.rule_runs
  where rule_id = (select id from b7t1_ids where name = 'approved_rule') and task_id = fb order by created_at desc limit 1;
  assert run.detail -> 'actions' -> 0 ->> 'result' = 'Marked complete', 'the last approval''s run completes it: ' || run.detail::text;
  assert (select completed_at from public.tasks where id = fb) is not null, 'completed';
  assert (select section_id from public.task_projects where task_id = fb and deleted_at is null)
         = (select id from b7t1_ids where name = 'done_section'), 'More steps moved it to Signed off too';
end $$;

-- A rule for every decision: a request for changes after someone approved closes the round as changes
-- requested, never approved, so the rule doesn't complete it.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  rid uuid;
begin
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions)
  values ((select id from b7t1_ids where name = 'a'), 'Done on any decision', true, 'approval_decided', '{}', '[{"type": "complete_task"}]')
  returning id into rid;
  insert into b7t1_ids values ('any_rule', rid);
end $$;

select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000003', false) is not null as ok \gset
select public.decide_approval((select id from public.approval_requests where task_id = (select id from b7t1_ids where name = 'fc')
  and approver_id = 'b7b70029-0000-4000-8000-000000000003' and status = 'pending'), 'approved', 'Fine by me');
select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000004', false) is not null as ok \gset
select public.decide_approval((select id from public.approval_requests where task_id = (select id from b7t1_ids where name = 'fc')
  and approver_id = 'b7b70029-0000-4000-8000-000000000004' and status = 'pending'), 'changes_requested', 'Wrong size');
reset role;

do $$
declare
  fc uuid := (select id from b7t1_ids where name = 'fc');
  run public.rule_runs;
begin
  assert public.task_approval_state(fc) ->> 'status' = 'changes_requested', 'the round closed as changes requested';
  assert not public.approval_round_approved(fc), 'not approved';
  select * into run from public.rule_runs
  where rule_id = (select id from b7t1_ids where name = 'any_rule') and task_id = fc order by created_at desc limit 1;
  assert found and run.detail -> 'event' ->> 'status' = 'changes_requested', 'the rule ran for the request for changes: ' || coalesce(run.detail::text, '');
  assert run.detail -> 'actions' -> 0 ->> 'outcome' = 'skipped', 'and skipped its Mark complete: ' || run.detail::text;
  assert (select completed_at from public.tasks where id = fc) is null, 'the task stays open';
end $$;

-- Without More steps the round completes the task anyway; the rule running first changes nothing.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  fd uuid;
begin
  fd := public.create_task((select id from b7t1_ids where name = 'a'), (select id from b7t1_ids where name = 'sa'), 'Flyer approval');
  insert into b7t1_ids values ('fd', fd);
  update public.tasks set kind = 'approval', assignee_id = 'b7b70029-0000-4000-8000-000000000002' where id = fd;
  perform public.set_task_approvers(fd, array['b7b70029-0000-4000-8000-000000000003'::uuid], 'any', null);
  perform public.send_for_approval(fd, 'Flyer, final', '{}', false, 'complete', null);
end $$;
select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000003', false) is not null as ok \gset
select public.decide_approval((select id from public.approval_requests where task_id = (select id from b7t1_ids where name = 'fd')
  and approver_id = 'b7b70029-0000-4000-8000-000000000003' and status = 'pending'), 'approved', null);
reset role;
do $$
begin
  assert (select completed_at from public.tasks where id = (select id from b7t1_ids where name = 'fd')) is not null, 'completed';
  assert public.task_approval_state((select id from b7t1_ids where name = 'fd')) ->> 'status' = 'approved', 'approved';
  update public.rules set enabled = false where id in ((select id from b7t1_ids where name = 'approved_rule'), (select id from b7t1_ids where name = 'any_rule'));
end $$;

-- ---------------------------------------------------------------------------------------------
-- 52 (review fixes): an approver lowered to Viewer can't decide (decide_approval needs Commenter), so
-- nothing says the approval waits on them: rows (task_approval_state, project_task_cards) and the
-- "Waiting on me" view filter. Back to Commenter, it waits on them again.
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  fe uuid;
begin
  fe := public.create_task((select id from b7t1_ids where name = 'a'), (select id from b7t1_ids where name = 'sa'), 'Mailer approval');
  insert into b7t1_ids values ('fe', fe);
  update public.tasks set kind = 'approval', assignee_id = 'b7b70029-0000-4000-8000-000000000002' where id = fe;
  perform public.set_task_approvers(fe, array['b7b70029-0000-4000-8000-000000000004'::uuid], 'any', null);
  perform public.send_for_approval(fe, 'Mailer, final', '{}', false, 'complete', null);
end $$;

select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
declare
  fe uuid := (select id from b7t1_ids where name = 'fe');
begin
  assert (public.task_approval_state(fe) ->> 'waiting_on_me')::boolean, 'Cole (Commenter) is waited on';
  assert (public.project_task_cards((select id from b7t1_ids where name = 'a'), array[fe]) -> 0 ->> 'approval_waiting_on_me')::boolean,
    'his cards say so';
  assert public.approval_filter_matches(fe, 'approval', '["waiting_on_me"]'), 'the view filter finds it';
end $$;

select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000001', false) is not null as ok \gset
select public.update_project_member_role((select id from b7t1_ids where name = 'a'), 'b7b70029-0000-4000-8000-000000000004', 'viewer');

select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
declare
  fe uuid := (select id from b7t1_ids where name = 'fe');
  state jsonb := public.task_approval_state(fe);
  card jsonb := public.project_task_cards((select id from b7t1_ids where name = 'a'), array[fe]) -> 0;
begin
  assert state ->> 'status' = 'pending' and (state ->> 'is_approver')::boolean, 'still a pending round he approves';
  assert not (state ->> 'waiting_on_me')::boolean, 'a Viewer isn''t waited on: ' || state::text;
  assert not (card ->> 'approval_waiting_on_me')::boolean, 'nor on his cards: ' || card::text;
  assert (card ->> 'approval_is_approver')::boolean, 'he''s still listed as an approver';
  assert not public.approval_filter_matches(fe, 'approval', '["waiting_on_me"]'), 'nor in the view filter';
  begin
    perform public.decide_approval((select id from public.approval_requests where task_id = fe
      and approver_id = 'b7b70029-0000-4000-8000-000000000004' and status = 'pending'), 'approved', null);
    raise exception 'a Viewer can''t decide';
  exception when insufficient_privilege or check_violation then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000001', false) is not null as ok \gset
select public.update_project_member_role((select id from b7t1_ids where name = 'a'), 'b7b70029-0000-4000-8000-000000000004', 'commenter');

select set_config('request.jwt.claim.sub', 'b7b70029-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
declare
  fe uuid := (select id from b7t1_ids where name = 'fe');
begin
  assert (public.task_approval_state(fe) ->> 'waiting_on_me')::boolean, 'a Commenter again: waited on again';
  assert (public.project_task_cards((select id from b7t1_ids where name = 'a'), array[fe]) -> 0 ->> 'approval_waiting_on_me')::boolean;
  assert public.approval_filter_matches(fe, 'approval', '["waiting_on_me"]');
end $$;
reset role;


-- =================================================================================================
-- Track T2: 47 select options, 54 colors, 49 number symbol, 48 long text
-- =================================================================================================

reset role;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset

--   b7f20029…01 b7f-owner@example.com   owner of B7F A, owner of the B7F portfolio
--   b7f20029…02 b7f-editor@example.com  Editor of B7F A, Editor of the B7F portfolio
--   b7f20029…03 b7f-viewer@example.com  Viewer of B7F A

insert into public.allowed_emails (email, note) values
  ('b7f-owner@example.com', 'oct 29 batch 7 fields'),
  ('b7f-editor@example.com', 'oct 29 batch 7 fields'),
  ('b7f-viewer@example.com', 'oct 29 batch 7 fields');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b7f20029-0000-4000-8000-000000000001', 'b7f-owner@example.com', now(), '{"full_name":"Fern Owner"}'),
  ('b7f20029-0000-4000-8000-000000000002', 'b7f-editor@example.com', now(), '{"full_name":"Finn Editor"}'),
  ('b7f20029-0000-4000-8000-000000000003', 'b7f-viewer@example.com', now(), '{"full_name":"Faye Viewer"}');

create temporary table b7f_ids (name text primary key, id uuid);
grant all on b7f_ids to authenticated, anon;

-- ---------------------------------------------------------------------------------------------
-- Setup: project B7F A and portfolio B7F P
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  a uuid;
  p uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B7F A') returning id into a;
  perform public.add_project_member(a, 'b7f-editor@example.com', 'editor');
  perform public.add_project_member(a, 'b7f-viewer@example.com', 'viewer');
  insert into public.portfolios (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B7F P') returning id into p;
  perform public.add_portfolio_member(p, 'b7f-editor@example.com', 'editor');
  insert into b7f_ids values ('a', a), ('p', p);
end $$;

-- ---------------------------------------------------------------------------------------------
-- 47. Select fields need at least one option (people; system paths are untouched).
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b7f_ids where name = 'a');
  f uuid;
  early uuid;
  status_field uuid;
  t uuid;
  opts jsonb := '[{"id": "o1", "name": "High", "color": "red"}, {"id": "o2", "name": "Low", "color": "zinc"}]';
begin
  -- Creating one without options: this release's editors and createField refuse it, but the database
  -- lets people's inserts through while the release still on main (whose Add field and Choose from
  -- library can create one) is live; a later migration adds the insert check. Like that release, the
  -- options then come with an edit, and from then on the field can't be emptied.
  insert into public.custom_fields (project_id, name, field_type) values (a, 'Early pick', 'single_select')
  returning id into early;
  update public.custom_fields set options = '[{"id": "e1", "name": "One", "color": "blue"}]' where id = early;
  begin
    update public.custom_fields set options = '[]' where id = early;
    raise exception 'emptying it once it has an option must be refused';
  exception when check_violation then
    assert sqlerrm like 'Add at least one option to the “Early pick” field%', 'says what to do: ' || sqlerrm;
  end;
  insert into public.custom_fields (project_id, name, field_type, options) values (a, 'Early channels', 'multi_select', '[]');

  -- With an option it's fine; other types and the section-bound Status need none.
  insert into public.custom_fields (project_id, name, field_type, options) values (a, 'Priority', 'single_select', opts)
  returning id into f;
  insert into b7f_ids values ('f47', f);
  insert into public.custom_fields (project_id, name, field_type, options)
  values (a, 'Channels', 'multi_select', '[{"id": "c1", "name": "Email", "color": "blue"}]');
  insert into public.custom_fields (project_id, name, field_type) values (a, 'Notes', 'text');
  insert into public.custom_fields (project_id, name, field_type) values (a, 'Budget', 'number');
  insert into public.custom_fields (project_id, name, field_type, bound_to_sections)
  values (a, 'Status', 'single_select', true) returning id into status_field;
  assert (select options from public.custom_fields where id = status_field) = '[]'::jsonb, 'the section-bound Status keeps no options';
  update public.custom_fields set name = 'Stage' where id = status_field;
  assert (select name from public.custom_fields where id = status_field) = 'Stage', 'and is renamed as before';

  -- Emptying a select field is refused; renaming, reordering, recoloring, and replacing options work.
  begin
    update public.custom_fields set options = '[]' where id = f;
    raise exception 'emptying a select field must be refused';
  exception when check_violation then null;
  end;
  assert jsonb_array_length((select options from public.custom_fields where id = f)) = 2, 'its options are kept';
  update public.custom_fields
     set name = 'Urgency', options = '[{"id": "o2", "name": "Low", "color": "green"}]'
   where id = f;
  assert (select name from public.custom_fields where id = f) = 'Urgency', 'renamed';
  assert (select options -> 0 ->> 'color' from public.custom_fields where id = f) = 'green', 'one option left, recolored';
  update public.custom_fields set description = 'How soon' where id = f;

  -- A field can't become an empty select either (another type turned into a select).
  begin
    update public.custom_fields set field_type = 'single_select', options = '[]'
     where project_id = a and name = 'Notes';
    raise exception 'turning a text field into an empty select must be refused';
  exception when check_violation then null;
  end;

  -- Values still work on the field, and removing the field (soft delete) is allowed.
  t := public.create_task(a, null, 'Option task');
  insert into public.task_field_values (task_id, field_id, value) values (t, f, '"o2"');
  update public.custom_fields set deleted_at = now() where project_id = a and name = 'Channels';
  assert (select deleted_at is not null from public.custom_fields where project_id = a and name = 'Channels'),
    'a select field can still be removed';

  -- Removing a field doesn't skip the check: emptying it in the same update would let it come back
  -- (deleted_at cleared) with no options.
  begin
    update public.custom_fields set deleted_at = now(), options = '[]' where id = f;
    raise exception 'emptying a select field while removing it must be refused';
  exception when check_violation then null;
  end;
  assert (select deleted_at is null and jsonb_array_length(options) = 1 from public.custom_fields where id = f),
    'still live, with its option';
  begin
    update public.custom_fields set deleted_at = now(), options = '[]' where project_id = a and name = 'Channels';
    raise exception 'emptying a removed select field must be refused too';
  exception when check_violation then null;
  end;
  -- Removed with its options, it comes back with them.
  update public.custom_fields set deleted_at = now() where id = early;
  update public.custom_fields set deleted_at = null where id = early;
  assert (select deleted_at is null and jsonb_array_length(options) = 1 from public.custom_fields where id = early),
    'removed and back, with its option';
end $$;

-- Viewers still can't write fields at all (RLS, unchanged).
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b7f_ids where name = 'a');
begin
  begin
    insert into public.custom_fields (project_id, name, field_type, options)
    values (a, 'Sneaky', 'single_select', '[{"id": "s1", "name": "S", "color": "zinc"}]');
    raise exception 'viewers can''t add fields';
  exception when insufficient_privilege then null;
  end;
end $$;

-- System paths keep making empty select fields: a direct write as the database owner, and the seeded
-- Creative Requests template (its two select fields have no options) through create_project_from_template.
reset role;
do $$
declare
  a uuid := (select id from b7f_ids where name = 'a');
  legacy uuid;
begin
  insert into public.custom_fields (project_id, name, field_type) values (a, 'Legacy pick', 'single_select')
  returning id into legacy;
  insert into b7f_ids values ('legacy', legacy);
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  legacy uuid := (select id from b7f_ids where name = 'legacy');
  created jsonb;
  copy uuid;
begin
  -- An existing select field with no options can still be renamed and described (and saved empty again),
  -- but once it has options it can't be emptied.
  update public.custom_fields set name = 'Legacy choice', description = 'Older field' where id = legacy;
  assert (select name from public.custom_fields where id = legacy) = 'Legacy choice', 'an empty select is renameable';
  update public.custom_fields set options = '[]' where id = legacy;
  -- It can be removed and brought back as it is (it already was that empty select).
  update public.custom_fields set deleted_at = now() where id = legacy;
  update public.custom_fields set deleted_at = null where id = legacy;
  update public.custom_fields set options = '[{"id": "l1", "name": "Yes", "color": "green"}]' where id = legacy;
  begin
    update public.custom_fields set options = '[]' where id = legacy;
    raise exception 'once it has options it can''t be emptied';
  exception when check_violation then null;
  end;

  -- The seeded template (definer code) still copies its option-less select fields.
  created := public.create_project_from_template('00000000-0000-4000-8000-0000000000c1', 'B7F from template', current_date);
  copy := (created ->> 'project_id')::uuid;
  insert into b7f_ids values ('template_copy', copy);
  assert (select count(*) from public.custom_fields
           where project_id = copy and field_type = 'single_select' and not bound_to_sections
             and options = '[]'::jsonb and deleted_at is null) = 2,
    'a project from Creative Requests keeps its two option-less select fields';
  -- Its creator (the owner) can rename them, and give them options.
  update public.custom_fields set name = 'Kind of request'
   where project_id = copy and name = 'Request type';
  assert exists (select 1 from public.custom_fields where project_id = copy and name = 'Kind of request'),
    'a template''s empty select is renameable';
end $$;

-- Duplicate project (definer copy engine) copies a project with an empty select field too.
do $$
declare
  copy uuid := (select id from b7f_ids where name = 'template_copy');
  dup jsonb;
begin
  dup := public.duplicate_project(copy, 'B7F duplicate', '{}'::jsonb);
  assert (select count(*) from public.custom_fields
           where project_id = (dup ->> 'project_id')::uuid and options = '[]'::jsonb
             and field_type = 'single_select' and not bound_to_sections and deleted_at is null) = 2,
    'Duplicate project copies option-less select fields';
end $$;

-- Portfolio fields: a single-select keeps at least one option too.
do $$
declare
  p uuid := (select id from b7f_ids where name = 'p');
  pf uuid;
begin
  -- The release still on main adds a portfolio single-select with no options, then its options on the
  -- row: that keeps working until this release is merged (createPortfolioField refuses an option-less one).
  insert into public.portfolio_fields (portfolio_id, name, field_type) values (p, 'Phase', 'single_select')
  returning id into pf;
  update public.portfolio_fields set options = '[{"id": "ph1", "name": "Plan", "color": "blue"}]' where id = pf;
  insert into public.portfolio_fields (portfolio_id, name, field_type) values (p, 'Spend', 'number');
  begin
    update public.portfolio_fields set options = '[]' where id = pf;
    raise exception 'emptying a portfolio single-select must be refused';
  exception when check_violation then
    assert sqlerrm like 'Add at least one option to the “Phase” field%', 'says what to do: ' || sqlerrm;
  end;
  begin
    update public.portfolio_fields set deleted_at = now(), options = '[]' where id = pf;
    raise exception 'emptying it while removing it must be refused';
  exception when check_violation then null;
  end;
  update public.portfolio_fields set name = 'Stage of work' where id = pf;
  assert (select name from public.portfolio_fields where id = pf) = 'Stage of work', 'renamed';
  update public.portfolio_fields set deleted_at = now() where id = pf;
end $$;

reset role;
do $$
declare
  p uuid := (select id from b7f_ids where name = 'p');
  pf uuid;
begin
  -- Older option-less portfolio single-selects stay renameable by people.
  insert into public.portfolio_fields (portfolio_id, name, field_type) values (p, 'Old phase', 'single_select')
  returning id into pf;
  insert into b7f_ids values ('old_pf', pf);
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  pf uuid := (select id from b7f_ids where name = 'old_pf');
begin
  update public.portfolio_fields set name = 'Older phase' where id = pf;
  assert (select name from public.portfolio_fields where id = pf) = 'Older phase', 'an empty portfolio select is renameable';
end $$;

-- The guard is a trigger helper: no client executes it.
reset role;
do $$
begin
  assert not has_function_privilege('anon', 'public.guard_select_field_options()', 'execute'), 'anon can''t execute the guard';
  assert not has_function_privilege('authenticated', 'public.guard_select_field_options()', 'execute'),
    'authenticated can''t execute the guard';
  assert exists (select 1 from pg_trigger where tgname = 'custom_fields_07_select_options' and not tgisinternal), 'project trigger';
  assert exists (select 1 from pg_trigger where tgname = 'portfolio_fields_07_select_options' and not tgisinternal), 'portfolio trigger';
  -- Updates only (tgtype: 4 = insert, 16 = update), so the release still on main can add fields.
  assert (select bool_and(tgtype::int & 4 = 0 and tgtype::int & 16 <> 0) from pg_trigger
           where tgname in ('custom_fields_07_select_options', 'portfolio_fields_07_select_options') and not tgisinternal),
    'the select-option triggers run on updates only';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 54. More option colors: one palette (option_colors()), tags keep a palette color in palette_color.
-- ---------------------------------------------------------------------------------------------

-- The palette and the nearest-base mapping.
do $$
declare
  c text;
  def text := (select pg_get_constraintdef(oid) from pg_constraint where conname = 'tags_palette_color_check');
begin
  assert cardinality(public.option_colors()) = 20, 'twenty colors';
  assert (public.option_colors())[1:9] = array['zinc', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink'],
    'the first nine are the original colors, in their order';
  assert (select count(distinct x) from unnest(public.option_colors()) x) = 20, 'no repeats';
  foreach c in array public.option_colors() loop
    assert public.option_color_base(c) = any ((public.option_colors())[1:9]), c || ' maps to one of the first nine';
    if c = any ((public.option_colors())[1:9]) then
      assert public.option_color_base(c) = c, c || ' is its own base';
    end if;
    assert def like '%''' || c || '''%', 'the palette_color CHECK lists ' || c;
  end loop;
  assert (select count(*) from regexp_matches(def, '''[a-z]+''::text', 'g')) = 20, 'the CHECK lists only the palette';
  assert public.option_color_base('rose') = 'red' and public.option_color_base('cyan') = 'teal'
    and public.option_color_base('slate') = 'zinc' and public.option_color_base('yellow') = 'amber', 'nearest bases';
  assert public.option_color_base('neon') = 'neon', 'an unknown color is left alone';
end $$;

-- Tags: any palette color, kept in palette_color with the nearest base in color.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  c text;
  g uuid;
  n integer := 0;
begin
  -- The app's write: the picked color in palette_color, its base in color.
  insert into public.tags (name, color, palette_color) values ('B7F Rose', 'red', 'rose') returning id into g;
  assert (select (color, palette_color) = ('red', 'rose') from public.tags where id = g), 'rose kept, red as the base';
  insert into b7f_ids values ('tag_rose', g);
  -- A palette color sent in color (an older writer, ensure_tag) moves to palette_color.
  insert into public.tags (name, color) values ('B7F Cyan', 'cyan') returning id into g;
  assert (select (color, palette_color) = ('teal', 'cyan') from public.tags where id = g), 'cyan sent as color is kept';
  -- A base color sent alone stays as it was.
  insert into public.tags (name, color) values ('B7F Plain', 'blue') returning id into g;
  assert (select color = 'blue' and palette_color is null from public.tags where id = g), 'a base color as before';
  insert into b7f_ids values ('tag_plain', g);
  -- Inconsistent pair: the palette color wins and color follows it.
  insert into public.tags (name, color, palette_color) values ('B7F Odd', 'pink', 'lime') returning id into g;
  assert (select (color, palette_color) = ('green', 'lime') from public.tags where id = g), 'color follows palette_color';

  -- Every palette color can be picked.
  foreach c in array public.option_colors() loop
    n := n + 1;
    insert into public.tags (name, color, palette_color) values ('B7F Swatch ' || n, public.option_color_base(c), c) returning id into g;
    assert (select coalesce(palette_color, color) from public.tags where id = g) = c, c || ' reads back';
  end loop;

  -- Unknown colors are refused either way.
  begin
    insert into public.tags (name, color) values ('B7F Neon', 'neon');
    raise exception 'an unknown color must be refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.tags (name, color, palette_color) values ('B7F Neon', 'zinc', 'neon');
    raise exception 'an unknown palette color must be refused';
  exception when check_violation then null;
  end;
end $$;

do $$
declare
  rose uuid := (select id from b7f_ids where name = 'tag_rose');
  plain uuid := (select id from b7f_ids where name = 'tag_plain');
begin
  -- Renaming keeps the color.
  update public.tags set name = 'B7F Rose tag' where id = rose;
  assert (select (color, palette_color) = ('red', 'rose') from public.tags where id = rose), 'rename keeps rose';
  -- The app picks the base color the palette color was stored next to (red): it reads red.
  update public.tags set color = 'red', palette_color = 'red' where id = rose;
  assert (select coalesce(palette_color, color) from public.tags where id = rose) = 'red', 'red after rose';
  update public.tags set color = 'violet', palette_color = 'indigo' where id = rose;
  assert (select (color, palette_color) = ('violet', 'indigo') from public.tags where id = rose), 'indigo';
  -- The release before this one changes only color: the palette color goes.
  update public.tags set color = 'orange' where id = rose;
  assert (select color = 'orange' and palette_color is null from public.tags where id = rose), 'an older writer''s color wins';
  -- An older writer sending a palette name in color still works.
  update public.tags set color = 'fuchsia' where id = plain;
  assert (select (color, palette_color) = ('pink', 'fuchsia') from public.tags where id = plain), 'fuchsia sent as color';
end $$;

-- Someone who doesn't manage a tag can't recolor it (RLS, unchanged).
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  plain uuid := (select id from b7f_ids where name = 'tag_plain');
  hit integer;
begin
  update public.tags set color = 'teal', palette_color = 'emerald' where id = plain;
  get diagnostics hit = row_count;
  assert hit = 0, 'not the creator nor a workspace admin: nothing changes';
  assert (select palette_color from public.tags where id = plain) = 'fuchsia', 'still fuchsia';
end $$;

-- Tag stories carry the color people see; portfolio options take the whole palette.
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid;
begin
  t := public.create_task((select id from b7f_ids where name = 'a'), null, 'B7F colored task');
  insert into b7f_ids values ('t54', t);
end $$;
do $$
declare
  t uuid := (select id from b7f_ids where name = 't54');
  plain uuid := (select id from b7f_ids where name = 'tag_plain');
  p uuid := (select id from b7f_ids where name = 'p');
begin
  insert into public.task_tags (task_id, tag_id) values (t, plain);
  assert (select data ->> 'tag_color' from public.task_stories where task_id = t and kind = 'tag_added'
          order by created_at desc limit 1) = 'fuchsia', 'the tag_added story has the palette color';

  insert into public.portfolio_fields (portfolio_id, name, field_type, options)
  values (p, 'Mood', 'single_select', '[{"id": "m1", "name": "Calm", "color": "emerald"}, {"id": "m2", "name": "Bold", "color": "fuchsia"}]');
  begin
    insert into public.portfolio_fields (portfolio_id, name, field_type, options)
    values (p, 'Bad mood', 'single_select', '[{"id": "x", "name": "X", "color": "neon"}]');
    raise exception 'an unknown portfolio option color must be refused';
  exception when check_violation then null;
  end;
  -- Project field options take palette colors too (never checked in SQL; the app reads them).
  insert into public.custom_fields (project_id, name, field_type, options)
  values ((select id from b7f_ids where name = 'a'), 'Mood', 'single_select', '[{"id": "m1", "name": "Calm", "color": "sky"}]');
end $$;

reset role;
do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  g uuid;
begin
  -- ensure_tag (the importer, the old Tags field migration) keeps a palette color; unknown → Gray.
  g := public.ensure_tag(ws, 'B7F Imported', 'stone', 'b7f20029-0000-4000-8000-000000000001');
  assert (select (color, palette_color) = ('zinc', 'stone') from public.tags where id = g), 'imported stone';
  g := public.ensure_tag(ws, 'B7F Imported odd', 'neon', 'b7f20029-0000-4000-8000-000000000001');
  assert (select color = 'zinc' and palette_color is null from public.tags where id = g), 'unknown becomes Gray';

  -- Grants: the palette helpers are for signed-in people and the service role; the trigger for nobody.
  assert not has_function_privilege('anon', 'public.option_colors()', 'execute'), 'anon: option_colors';
  assert not has_function_privilege('anon', 'public.option_color_base(text)', 'execute'), 'anon: option_color_base';
  assert has_function_privilege('authenticated', 'public.option_colors()', 'execute'), 'authenticated: option_colors';
  assert has_function_privilege('authenticated', 'public.option_color_base(text)', 'execute'), 'authenticated: option_color_base';
  assert not has_function_privilege('anon', 'public.guard_tag_palette_color()', 'execute'), 'anon: the tag trigger';
  assert not has_function_privilege('authenticated', 'public.guard_tag_palette_color()', 'execute'), 'authenticated: the tag trigger';
  assert has_column_privilege('authenticated', 'public.tags', 'palette_color', 'UPDATE'), 'tag managers recolor (RLS decides)';
  assert not has_column_privilege('anon', 'public.tags', 'palette_color', 'SELECT'), 'anon reads nothing';
  assert exists (select 1 from pg_trigger where tgname = 'tags_06_palette_color' and not tgisinternal), 'tag trigger';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 49. Number field symbol: number_prefix on project and portfolio number fields, shown through
-- format_number_value() (task_field_text, rule_field_value_label); values stay plain numbers.
-- ---------------------------------------------------------------------------------------------

-- The one SQL rendering (the same vectors as tests/unit/oct29-batch7-number-prefix.test.ts).
do $$
begin
  assert public.format_number_value(1250, null) = '1,250', 'grouped';
  assert public.format_number_value(1250, '$') = '$1,250', 'the symbol first';
  assert public.format_number_value(-1250.5, '$') = '-$1,250.5', 'the sign before the symbol';
  assert public.format_number_value(0.12345, '€') = '€0.123', 'three decimals at most';
  assert public.format_number_value(1234567.891, null) = '1,234,567.891', 'millions';
  assert public.format_number_value(42.10, '#') = '#42.1', 'no trailing zeros';
  assert public.format_number_value(-0.0001, '$') = '$0', 'a value that rounds to zero has no sign';
  assert public.format_number_value(0, '₪') = '₪0', 'zero';
  assert public.format_number_value(1000, 'USD') = 'USD 1,000', 'a space after a symbol ending in a letter';
  assert public.format_number_value(-7, 'Rs') = '-Rs 7', 'and the sign still first';
  assert public.format_number_value(999, '') = '999', 'an empty symbol is none';
  assert public.format_number_value(null, '$') is null, 'no value, no text';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b7f_ids where name = 'a');
  f uuid;
  g uuid;
begin
  -- An Editor sets a symbol on a number field; surrounding spaces go, an empty one is none.
  insert into public.custom_fields (project_id, name, field_type, number_prefix, notify_on_change)
  values (a, 'Cost', 'number', '  $ ', true) returning id into f;
  assert (select number_prefix from public.custom_fields where id = f) = '$', 'trimmed';
  insert into b7f_ids values ('cost', f);
  update public.custom_fields set number_prefix = '' where id = f;
  assert (select number_prefix is null from public.custom_fields where id = f), 'empty = none';
  update public.custom_fields set number_prefix = E' € ' where id = f;
  assert (select number_prefix from public.custom_fields where id = f) = '€', 'no-break spaces trimmed too';
  update public.custom_fields set number_prefix = '₪₪₪₪' where id = f;
  assert (select char_length(number_prefix) from public.custom_fields where id = f) = 4, 'four characters (code points)';
  update public.custom_fields set number_prefix = 'US $' where id = f;
  update public.custom_fields set number_prefix = '$' where id = f;

  -- Refused: too long, control characters / line breaks, and any field that isn't a number field.
  begin
    update public.custom_fields set number_prefix = 'Euros' where id = f;
    raise exception 'five characters must be refused';
  exception when check_violation then null;
  end;
  begin
    update public.custom_fields set number_prefix = E'$\n€' where id = f;
    raise exception 'a line break must be refused';
  exception when check_violation then null;
  end;
  begin
    update public.custom_fields set number_prefix = E'$ ' || '€' where id = f;
    raise exception 'a Unicode line separator must be refused';
  exception when check_violation then null;
  end;
  begin
    update public.custom_fields set number_prefix = E'\u0007#' where id = f;
    raise exception 'a control character must be refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.custom_fields (project_id, name, field_type, number_prefix) values (a, 'Label', 'text', '$');
    raise exception 'a text field has no symbol';
  exception when check_violation then null;
  end;
  insert into public.custom_fields (project_id, name, field_type, number_prefix) values (a, 'Label', 'text', '  ')
  returning id into g;
  assert (select number_prefix is null from public.custom_fields where id = g), 'blank on a text field is just none';
  assert (select number_prefix from public.custom_fields where id = f) = '$', 'still $';
end $$;

-- A Viewer can't change a symbol (RLS, unchanged).
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  hit integer;
begin
  update public.custom_fields set number_prefix = '€' where id = (select id from b7f_ids where name = 'cost');
  get diagnostics hit = row_count;
  assert hit = 0, 'viewers change no field';
end $$;

-- A task with a value, followed by the owner (who hears about field changes).
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid;
begin
  t := public.create_task((select id from b7f_ids where name = 'a'), null, 'B7F costed task');
  insert into b7f_ids values ('t49', t);
end $$;
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000001', false) is not null as ok \gset
insert into public.task_followers (task_id, profile_id)
values ((select id from b7f_ids where name = 't49'), 'b7f20029-0000-4000-8000-000000000001');
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b7f_ids where name = 't49');
  f uuid := (select id from b7f_ids where name = 'cost');
  a uuid := (select id from b7f_ids where name = 'a');
begin
  insert into public.task_field_values (task_id, field_id, value) values (t, f, '1250.5');
  assert (select value from public.task_field_values where task_id = t and field_id = f) = '1250.5'::jsonb,
    'the stored value is a plain number';
  -- Filtering still compares numbers.
  assert t in (select x.task_id from public.filter_project_tasks(a, jsonb_build_object('completion', 'all',
    'fields', jsonb_build_array(jsonb_build_object('field_id', f, 'op', 'equals', 'value', 1250.5))), 'UTC') x),
    'a number filter still matches';
end $$;

-- The owner's Inbox: "Cost changed to $1,250.5".
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b7f_ids where name = 't49');
begin
  assert (select data ->> 'value_text' from public.inbox_items
           where recipient_id = 'b7f20029-0000-4000-8000-000000000001' and task_id = t and data ->> 'field_change' = 'true'
           order by created_at desc limit 1) = '$1,250.5', 'the Inbox shows the symbol';
  assert (select data ->> 'message' from public.inbox_items
           where recipient_id = 'b7f20029-0000-4000-8000-000000000001' and task_id = t and data ->> 'field_change' = 'true'
           order by created_at desc limit 1) = 'Cost changed to $1,250.5', 'in the message too';
end $$;

-- Rule text (placeholders, Send email's field line) and rule run logs.
reset role;
do $$
declare
  t uuid := (select id from b7f_ids where name = 't49');
  f uuid := (select id from b7f_ids where name = 'cost');
  a uuid := (select id from b7f_ids where name = 'a');
  task_row public.tasks;
  field_row public.custom_fields;
begin
  select * into task_row from public.tasks where id = t;
  select * into field_row from public.custom_fields where id = f;
  assert public.task_field_text(t, f) = '$1,250.5', 'task_field_text';
  assert public.rule_placeholder_value('field.Cost', task_row, a, '{}'::jsonb, 'text') = '$1,250.5', '{{field.Cost}}';
  assert public.render_rule_text_as('Budget: {{field.cost}}', t, a, '{}'::jsonb, 'text') = 'Budget: $1,250.5',
    'rendered in a rule message';
  assert public.rule_field_value_label(field_row, '-40'::jsonb) = '-$40', 'the run log''s value';
  assert public.rule_field_value_label(field_row, 'null'::jsonb) = 'empty', 'clearing still reads empty';
  -- A number field without a symbol is grouped, nothing else.
  select * into field_row from public.custom_fields where project_id = a and name = 'Budget';
  assert public.rule_field_value_label(field_row, '1250'::jsonb) = '1,250', 'no symbol';
end $$;

-- Templates and Duplicate project keep the symbol; a stored symbol that no longer fits is left out.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b7f_ids where name = 'a');
  dup jsonb;
  tmpl uuid;
  created jsonb;
begin
  dup := public.duplicate_project(a, 'B7F A copy', '{}'::jsonb);
  assert (select number_prefix from public.custom_fields
           where project_id = (dup ->> 'project_id')::uuid and name = 'Cost' and deleted_at is null) = '$',
    'Duplicate project keeps the symbol';
  assert (select number_prefix is null from public.custom_fields
           where project_id = (dup ->> 'project_id')::uuid and name = 'Budget' and deleted_at is null),
    'and no symbol stays none';
  tmpl := public.save_project_as_template(a, 'B7F costs', null, null, null);
  insert into b7f_ids values ('tmpl49', tmpl);
  created := public.create_project_from_template(tmpl, 'B7F from costs', current_date);
  assert (select number_prefix from public.custom_fields
           where project_id = (created ->> 'project_id')::uuid and name = 'Cost' and deleted_at is null) = '$',
    'a project template keeps the symbol';
end $$;

reset role;
update public.project_templates
   set content = jsonb_set(content, '{fields}', (
     select jsonb_agg(case when x ->> 'name' = 'Cost' then x || '{"number_prefix": "Dollars"}' else x end)
     from jsonb_array_elements(content -> 'fields') x))
 where id = (select id from b7f_ids where name = 'tmpl49');
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  created jsonb;
begin
  created := public.create_project_from_template((select id from b7f_ids where name = 'tmpl49'), 'B7F odd costs', current_date);
  assert (select number_prefix is null from public.custom_fields
           where project_id = (created ->> 'project_id')::uuid and name = 'Cost' and deleted_at is null),
    'a symbol that no longer fits is left out, and the copy goes on';
end $$;

-- Portfolio number fields take a symbol too.
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b7f_ids where name = 'p');
  pf uuid;
begin
  insert into public.portfolio_fields (portfolio_id, name, field_type, number_prefix) values (p, 'Spend B7F', 'number', ' € ')
  returning id into pf;
  assert (select number_prefix from public.portfolio_fields where id = pf) = '€', 'trimmed';
  update public.portfolio_fields set number_prefix = '#' where id = pf;
  update public.portfolio_fields set number_prefix = null where id = pf;
  begin
    update public.portfolio_fields set number_prefix = 'Euros' where id = pf;
    raise exception 'five characters must be refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.portfolio_fields (portfolio_id, name, field_type, number_prefix) values (p, 'Note B7F', 'text', '$');
    raise exception 'a portfolio text field has no symbol';
  exception when check_violation then null;
  end;
end $$;

reset role;
do $$
begin
  assert not has_function_privilege('anon', 'public.format_number_value(numeric, text)', 'execute'), 'anon: format_number_value';
  assert has_function_privilege('authenticated', 'public.format_number_value(numeric, text)', 'execute'),
    'authenticated: format_number_value';
  assert not has_function_privilege('anon', 'public.normalize_number_prefix()', 'execute'), 'anon: the trigger';
  assert not has_function_privilege('authenticated', 'public.normalize_number_prefix()', 'execute'), 'authenticated: the trigger';
  assert has_column_privilege('authenticated', 'public.custom_fields', 'number_prefix', 'UPDATE'), 'editors set it (RLS decides)';
  assert has_column_privilege('authenticated', 'public.portfolio_fields', 'number_prefix', 'UPDATE'), 'portfolio editors too';
  assert not has_column_privilege('anon', 'public.custom_fields', 'number_prefix', 'SELECT'), 'anon reads nothing';
  assert exists (select 1 from pg_trigger where tgname = 'custom_fields_08_number_prefix' and not tgisinternal), 'project trigger';
  assert exists (select 1 from pg_trigger where tgname = 'portfolio_fields_08_number_prefix' and not tgisinternal), 'portfolio trigger';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 48. Long text editor (app only): the limit the editor counts against — a text value holds 10,000
-- characters as Postgres counts them (code points, so an emoji is one), and keeps its line breaks.
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b7f_ids where name = 'a');
  f uuid;
  t uuid;
  multi text := E'Line one\nLine two\n\n  Indented line four';
begin
  insert into public.custom_fields (project_id, name, field_type) values (a, 'Brief B7F', 'text') returning id into f;
  t := public.create_task(a, null, 'B7F long brief');

  insert into public.task_field_values (task_id, field_id, value) values (t, f, to_jsonb(repeat('a', 10000)));
  assert length((select value #>> '{}' from public.task_field_values where task_id = t and field_id = f)) = 10000,
    'exactly 10,000 characters fit';
  begin
    update public.task_field_values set value = to_jsonb(repeat('a', 10001)) where task_id = t and field_id = f;
    raise exception 'a text value of 10,001 characters must be refused';
  exception when check_violation then null;
  end;
  assert length((select value #>> '{}' from public.task_field_values where task_id = t and field_id = f)) = 10000,
    'the refused write changed nothing';

  -- Line breaks (and inner spaces) are stored as written; the editor trims only the ends.
  update public.task_field_values set value = to_jsonb(multi) where task_id = t and field_id = f;
  assert (select value #>> '{}' from public.task_field_values where task_id = t and field_id = f) = multi,
    'line breaks are kept';

  -- Characters, not UTF-16 units or bytes: 10,000 emoji fit (where the database is UTF-8, as hosted).
  if current_setting('server_encoding') = 'UTF8' then
    update public.task_field_values set value = to_jsonb(repeat(chr(128512), 10000)) where task_id = t and field_id = f;
    assert length((select value #>> '{}' from public.task_field_values where task_id = t and field_id = f)) = 10000,
      '10,000 emoji are 10,000 characters';
    begin
      update public.task_field_values set value = to_jsonb(repeat(chr(128512), 10001)) where task_id = t and field_id = f;
      raise exception '10,001 emoji must be refused';
    exception when check_violation then null;
    end;
  end if;

  -- Clearing (the editor saves JSON null for an emptied box).
  update public.task_field_values set value = 'null'::jsonb where task_id = t and field_id = f;
  assert (select value from public.task_field_values where task_id = t and field_id = f) is null, 'cleared';
end $$;


-- ---------------------------------------------------------------------------------------------
-- 49 (review): a symbol can't change how the number reads (no bidi or other invisible formatting
-- characters, no digits, no plus / minus signs), the database trims exactly what the app trims
-- (JavaScript's trim(): NUMBER_PREFIX_SPACE), and a symbol ending in a period or a comma is spaced
-- like one ending in a letter. Same vectors as tests/unit/oct29-batch7-number-prefix.test.tsx.
-- ---------------------------------------------------------------------------------------------

do $$
begin
  assert public.format_number_value(1250, 'Rs.') = 'Rs. 1,250', 'a space after a period';
  assert public.format_number_value(-3, 'No.') = '-No. 3', 'and the sign still first';
  assert public.format_number_value(250, '$.') = '$. 250', 'never "$.250"';
  assert public.format_number_value(250, '$,') = '$, 250', 'nor "$,250"';
  assert public.format_number_value(250, '%') = '%250', 'other symbols as before';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  f uuid := (select id from b7f_ids where name = 'cost');
  p uuid := (select id from b7f_ids where name = 'p');
  pf uuid;
  bad text;
  good text;
begin
  -- Refused: right-to-left override, zero-width space, pop directional isolate, soft hyphen, a byte
  -- order mark inside, a language tag, digits (ASCII, full-width, Arabic-Indic), and signs (+, -, the
  -- minus sign, an en dash, plus-minus).
  foreach bad in array array[
    chr(8238) || '$', chr(8203) || '$', '$' || chr(8297), chr(173) || '$', '$' || chr(65279) || '$', chr(917505) || '$',
    '1', '$1', chr(65301), chr(1635),
    '+', '-', '$-', '-$', chr(8722), chr(8211), chr(177)
  ] loop
    begin
      update public.custom_fields set number_prefix = bad where id = f;
      raise exception 'the symbol % (U+%) must be refused', bad, to_hex(ascii(bad));
    exception when check_violation then null;
    end;
  end loop;
  assert (select number_prefix from public.custom_fields where id = f) = '$', 'still $';

  -- Accepted: currency signs, letters, a period or comma, superscripts, an emoji with its variation selector.
  foreach good in array array['€', '#', '₪', '£', 'USD', 'Rs.', 'No.', 'm' || chr(178), chr(10084) || chr(65039), '%'] loop
    update public.custom_fields set number_prefix = good where id = f;
    assert (select number_prefix from public.custom_fields where id = f) = good, good || ' is kept as typed';
  end loop;

  -- Trimmed like the app: a byte order mark, thin / em / ogham / medium math spaces, vertical tab, form
  -- feed, and the line separator at the ends go; a symbol of only those is no symbol.
  update public.custom_fields set number_prefix = chr(65279) || '$' || chr(8201) where id = f;
  assert (select number_prefix from public.custom_fields where id = f) = '$', 'byte order mark and thin space trimmed';
  update public.custom_fields set number_prefix = chr(8195) || chr(5760) || '€' || chr(8287) where id = f;
  assert (select number_prefix from public.custom_fields where id = f) = '€', 'em, ogham, and math spaces trimmed';
  update public.custom_fields set number_prefix = chr(11) || chr(12) || '#' || chr(8232) where id = f;
  assert (select number_prefix from public.custom_fields where id = f) = '#', 'vertical tab, form feed, line separator trimmed';
  update public.custom_fields set number_prefix = chr(65279) where id = f;
  assert (select number_prefix is null from public.custom_fields where id = f), 'a lone byte order mark is no symbol';
  update public.custom_fields set number_prefix = '$' where id = f;

  -- Portfolio number fields follow the same rules.
  insert into public.portfolio_fields (portfolio_id, name, field_type, number_prefix)
  values (p, 'Spend review', 'number', chr(8201) || '₪' || chr(65279)) returning id into pf;
  assert (select number_prefix from public.portfolio_fields where id = pf) = '₪', 'trimmed like the app';
  foreach bad in array array[chr(8238) || '$', '1', '-', chr(8722)] loop
    begin
      update public.portfolio_fields set number_prefix = bad where id = pf;
      raise exception 'the portfolio symbol % must be refused', bad;
    exception when check_violation then null;
    end;
  end loop;
end $$;

-- =================================================================================================
-- Track T3: 55 shared library fields, 51 field lock
-- =================================================================================================

reset role;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset

-- 55. Library fields shared across projects (linked placements).
--   b7c30029…01 sf-owner@example.com     owner of SF A, SF B, SF C (and the linking projects)
--   b7c30029…02 sf-editor@example.com    Editor of SF A and SF B
--   b7c30029…03 sf-bedit@example.com     Editor of SF B and SF C (not in SF A)
--   b7c30029…04 sf-viewer@example.com    Viewer of SF B
--   b7c30029…05 sf-outsider@example.com  in the workspace, in no project
--   b7c30029…06 sf-admin@example.com     workspace admin, in no project

insert into public.allowed_emails (email, note) values
  ('sf-owner@example.com', 'oct 29 batch 7 t3'),
  ('sf-editor@example.com', 'oct 29 batch 7 t3'),
  ('sf-bedit@example.com', 'oct 29 batch 7 t3'),
  ('sf-viewer@example.com', 'oct 29 batch 7 t3'),
  ('sf-outsider@example.com', 'oct 29 batch 7 t3'),
  ('sf-admin@example.com', 'oct 29 batch 7 t3');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b7c30029-0000-4000-8000-000000000001', 'sf-owner@example.com', now(), '{"full_name":"Olive Owner"}'),
  ('b7c30029-0000-4000-8000-000000000002', 'sf-editor@example.com', now(), '{"full_name":"Eddie Editor"}'),
  ('b7c30029-0000-4000-8000-000000000003', 'sf-bedit@example.com', now(), '{"full_name":"Bea Bedit"}'),
  ('b7c30029-0000-4000-8000-000000000004', 'sf-viewer@example.com', now(), '{"full_name":"Vera Viewer"}'),
  ('b7c30029-0000-4000-8000-000000000005', 'sf-outsider@example.com', now(), '{"full_name":"Otto Outsider"}'),
  ('b7c30029-0000-4000-8000-000000000006', 'sf-admin@example.com', now(), '{"full_name":"Ada Admin"}');
select public.seed_workspace_admin('sf-admin@example.com');

create temporary table sf_ids (name text primary key, id uuid);
grant all on sf_ids to authenticated, anon;

-- ---------------------------------------------------------------------------------------------
-- Schema and privileges
-- ---------------------------------------------------------------------------------------------

do $$
begin
  assert exists (
    select 1 from pg_attribute where attrelid = 'public.custom_fields'::regclass and attname = 'library_field_id' and not attisdropped
  ), 'custom_fields.library_field_id exists';
  assert (select relrowsecurity from pg_class where oid = 'public.library_field_links'::regclass), 'links: RLS on';
  assert (select relrowsecurity from pg_class where oid = 'public.library_field_link_conflicts'::regclass), 'conflicts: RLS on';
  assert not has_table_privilege('authenticated', 'public.library_field_links', 'SELECT')
    and not has_table_privilege('authenticated', 'public.library_field_link_conflicts', 'SELECT')
    and not has_table_privilege('anon', 'public.library_field_links', 'SELECT')
    and not has_table_privilege('anon', 'public.library_field_link_conflicts', 'SELECT'), 'no client access to the link tables';
  assert not has_table_privilege('authenticated', 'public.library_field_link_conflicts', 'INSERT')
    and not has_table_privilege('authenticated', 'public.library_field_link_conflicts', 'TRUNCATE'), 'no client writes';

  -- The two client definers (pinned in suite 60) and the internal helpers.
  assert (select prosecdef from pg_proc where oid = 'public.add_library_field(uuid, uuid)'::regprocedure), 'add_library_field is definer';
  assert (select prosecdef from pg_proc where oid = 'public.project_field_sharing(uuid)'::regprocedure), 'project_field_sharing is definer';
  assert has_function_privilege('authenticated', 'public.add_library_field(uuid, uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.project_field_sharing(uuid)', 'execute'), 'members call them';
  assert not has_function_privilege('anon', 'public.add_library_field(uuid, uuid)', 'execute')
    and not has_function_privilege('anon', 'public.project_field_sharing(uuid)', 'execute'), 'anon calls neither';
  assert not has_function_privilege('authenticated', 'public.link_library_field_copies()', 'execute')
    and not has_function_privilege('authenticated', 'public.link_library_placement(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.fill_library_values(uuid, uuid[])', 'execute')
    and not has_function_privilege('authenticated', 'public.library_value_siblings(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.library_field_governing_project(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.copy_library_definition(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.library_value_sync_write(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.library_field_source_for_copy(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.library_group_task_members(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.sync_library_field_value()', 'execute')
    and not has_function_privilege('authenticated', 'public.sync_library_field_definition()', 'execute')
    and not has_function_privilege('authenticated', 'public.lock_library_field_value()', 'execute')
    and not has_function_privilege('authenticated', 'public.fill_library_values_on_join()', 'execute'),
    'the engine is internal';
  assert public.library_field_definition_columns()
    = array['name', 'description', 'field_type', 'options', 'notify_on_change', 'number_prefix', 'locked', 'locked_by', 'locked_at'],
    'the definition columns';
  assert exists (select 1 from pg_trigger where tgname = 'task_field_values_03_library_lock' and tgrelid = 'public.task_field_values'::regclass)
    and exists (select 1 from pg_trigger where tgname = 'task_field_values_zzz_library_sync' and tgrelid = 'public.task_field_values'::regclass)
    and exists (select 1 from pg_trigger where tgname = 'task_projects_14_library_values' and tgrelid = 'public.task_projects'::regclass)
    and exists (select 1 from pg_trigger where tgname = 'custom_fields_05_library_guard' and tgrelid = 'public.custom_fields'::regclass)
    and exists (select 1 from pg_trigger where tgname = 'custom_fields_zz_library_sync' and tgrelid = 'public.custom_fields'::regclass),
    'the triggers are in place';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Setup (Olive): SF A publishes Priority (single-select) and Budget note (text); SF B has a field of
-- its own; SF C.
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  a uuid;
  b uuid;
  c uuid;
  f uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF A') returning id into a;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF B') returning id into b;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF C') returning id into c;
  insert into sf_ids values ('a', a), ('b', b), ('c', c);
  with x as (insert into public.sections (project_id, name, sort_order) values (a, 'Intake', 1024) returning id) insert into sf_ids select 'sa', id from x;
  with x as (insert into public.sections (project_id, name, sort_order) values (b, 'Inbox', 1024) returning id) insert into sf_ids select 'sb', id from x;
  with x as (insert into public.sections (project_id, name, sort_order) values (c, 'Queue', 1024) returning id) insert into sf_ids select 'sc', id from x;
  perform public.add_project_member(a, 'sf-editor@example.com', 'editor');
  perform public.add_project_member(b, 'sf-editor@example.com', 'editor');
  perform public.add_project_member(b, 'sf-bedit@example.com', 'editor');
  perform public.add_project_member(c, 'sf-bedit@example.com', 'editor');
  perform public.add_project_member(b, 'sf-viewer@example.com', 'viewer');

  insert into public.custom_fields (project_id, name, field_type, options, in_library, notify_on_change, description, sort_order,
                                    show_in_views)
  values (a, 'Priority', 'single_select',
    '[{"id": "p-low", "name": "Low", "color": "green"}, {"id": "p-high", "name": "High", "color": "red"}]',
    true, true, 'How urgent it is', 1024, true)
  returning id into f;
  insert into sf_ids values ('priority', f);
  insert into public.custom_fields (project_id, name, field_type, in_library, description, sort_order)
  values (a, 'Budget note', 'text', true, 'What it costs', 2048) returning id into f;
  insert into sf_ids values ('budget', f);
  insert into public.custom_fields (project_id, name, field_type, sort_order)
  values (a, 'Unshared', 'text', 3072) returning id into f;
  insert into sf_ids values ('unshared', f);
  insert into public.custom_fields (project_id, name, field_type, sort_order)
  values (b, 'Local', 'text', 1024) returning id into f;
  insert into sf_ids values ('local', f);
end $$;

-- ---------------------------------------------------------------------------------------------
-- add_library_field: who may add, idempotent, the placement's shape
-- ---------------------------------------------------------------------------------------------

-- Vera (Viewer of SF B), Otto (in no project), and Ada (a workspace admin, in no project) get nothing.
do $$
declare
  who text;
begin
  foreach who in array array['b7c30029-0000-4000-8000-000000000004', 'b7c30029-0000-4000-8000-000000000005',
                             'b7c30029-0000-4000-8000-000000000006'] loop
    perform set_config('request.jwt.claim.sub', who, true);
    begin
      perform public.add_library_field((select id from sf_ids where name = 'b'), (select id from sf_ids where name = 'priority'));
      raise exception 'add_library_field should be refused for %', who;
    exception when insufficient_privilege then
      null;
    end;
    if who = 'b7c30029-0000-4000-8000-000000000004' then
      assert exists (select 1 from public.project_field_sharing((select id from sf_ids where name = 'b')))
        and not exists (select 1 from public.project_field_sharing((select id from sf_ids where name = 'b')) s
                        where s.definition_editable or s.definition_manageable),
        'a Viewer sees SF B''s fields and changes none';
    else
      assert not exists (select 1 from public.project_field_sharing((select id from sf_ids where name = 'b'))),
        format('project_field_sharing says nothing to %s about SF B', who);
    end if;
  end loop;
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  b uuid := (select id from sf_ids where name = 'b');
  priority uuid := (select id from sf_ids where name = 'priority');
  placement uuid;
  again uuid;
  f public.custom_fields;
begin
  -- Bea can't read SF A (the source's project) but adds its library field to SF B.
  assert not exists (select 1 from public.custom_fields where id = priority), 'Bea can''t read the source row';
  placement := public.add_library_field(b, priority);
  assert placement is not null and placement <> priority, 'a placement in SF B';
  insert into sf_ids values ('pb', placement);
  again := public.add_library_field(b, priority);
  assert again = placement, 'adding it again returns the same placement';
  select * into f from public.custom_fields where id = placement;
  assert f.library_field_id = priority, 'the placement points at the source';
  assert f.project_id = b and f.name = 'Priority' and f.field_type = 'single_select' and f.description = 'How urgent it is'
    and f.notify_on_change and not f.in_library and f.show_in_views, 'definition copied, pinned, not itself in the library';
  assert f.options = '[{"id": "p-low", "name": "Low", "color": "green"}, {"id": "p-high", "name": "High", "color": "red"}]'::jsonb,
    'same option ids';
  assert f.sort_order > (select sort_order from public.custom_fields where id = (select id from sf_ids where name = 'local')),
    'it goes last';

  -- Not a library field.
  begin
    perform public.add_library_field(b, (select id from sf_ids where name = 'unshared'));
    raise exception 'a field that isn''t in the library can''t be added';
  exception when no_data_found then
    null;
  end;
  -- People never set the link themselves.
  begin
    insert into public.custom_fields (project_id, name, field_type, library_field_id) values (b, 'Sneaky', 'single_select', priority);
    raise exception 'a client insert can''t set library_field_id';
  exception when insufficient_privilege then
    null;
  end;
  begin
    update public.custom_fields set library_field_id = null where id = placement;
    raise exception 'a client can''t unlink a placement';
  exception when insufficient_privilege then
    null;
  end;
  begin
    update public.custom_fields set library_field_id = priority where id = (select id from sf_ids where name = 'local');
    raise exception 'a client can''t link a field';
  exception when insufficient_privilege then
    null;
  end;
  begin
    update public.custom_fields set in_library = true where id = placement;
    raise exception 'a placement can''t join the library';
  exception when check_violation then
    null;
  end;
end $$;

-- Eddie adds it to SF A, the source's own project: the source itself.
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  assert public.add_library_field((select id from sf_ids where name = 'a'), (select id from sf_ids where name = 'priority'))
    = (select id from sf_ids where name = 'priority'), 'the source''s own project gets the source back';
  assert (select count(*) from public.list_field_library() where field_id = (select id from sf_ids where name = 'priority')) = 1
    and not exists (select 1 from public.list_field_library() where field_id = (select id from sf_ids where name = 'pb')),
    'the library lists the source only';
end $$;

-- ---------------------------------------------------------------------------------------------
-- project_field_sharing: booleans and counts only
-- ---------------------------------------------------------------------------------------------

do $$
declare
  s record;
begin
  -- Eddie (Editor of SF A and SF B).
  select * into s from public.project_field_sharing((select id from sf_ids where name = 'b'))
  where field_id = (select id from sf_ids where name = 'pb');
  assert s.library_field_id = (select id from sf_ids where name = 'priority') and s.is_shared and not s.is_source
    and s.placement_count = 2 and s.definition_editable and not s.definition_manageable,
    format('Eddie: the placement is shared and he edits the definition (%s)', row_to_json(s));
  select * into s from public.project_field_sharing((select id from sf_ids where name = 'b'))
  where field_id = (select id from sf_ids where name = 'local');
  assert s.library_field_id is null and not s.is_shared and not s.is_source and s.placement_count = 1 and s.definition_editable,
    'a project-only field';
  select * into s from public.project_field_sharing((select id from sf_ids where name = 'a'))
  where field_id = (select id from sf_ids where name = 'budget');
  assert s.is_source and not s.is_shared and s.placement_count = 1, 'published, used nowhere else yet';
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  s record;
begin
  select * into s from public.project_field_sharing((select id from sf_ids where name = 'b'))
  where field_id = (select id from sf_ids where name = 'pb');
  assert s.is_shared and s.placement_count = 2 and not s.definition_editable and not s.definition_manageable,
    'Bea (not in SF A) can''t change the shared definition';
  assert not exists (select 1 from public.project_field_sharing((select id from sf_ids where name = 'a'))),
    'nothing about a project she can''t open';
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  s record;
begin
  select * into s from public.project_field_sharing((select id from sf_ids where name = 'a'))
  where field_id = (select id from sf_ids where name = 'priority');
  assert s.library_field_id is null and s.is_source and s.is_shared and s.placement_count = 2
    and s.definition_editable and s.definition_manageable, 'Olive owns the source';
end $$;

-- ---------------------------------------------------------------------------------------------
-- One value per task
-- ---------------------------------------------------------------------------------------------

-- Eddie makes Shared one in SF A, adds it to SF B, and assigns it to Olive (who follows it).
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from sf_ids where name = 'a');
  b uuid := (select id from sf_ids where name = 'b');
  priority uuid := (select id from sf_ids where name = 'priority');
  pb uuid := (select id from sf_ids where name = 'pb');
  t uuid;
  stories integer;
  notes integer;
  locks integer;
begin
  t := public.create_task(a, (select id from sf_ids where name = 'sa'), 'Shared one');
  insert into sf_ids values ('t1', t);
  insert into public.task_projects (task_id, project_id, section_id) values (t, b, (select id from sf_ids where name = 'sb'));
  update public.tasks set assignee_id = 'b7c30029-0000-4000-8000-000000000001' where id = t;
end $$;

-- (A later transaction: changes in the one that created the task notify nobody.) Olive's Inbox is
-- counted as the database owner (people read only their own items).
reset role;
create temporary table sf_counts (name text primary key, n integer);
insert into sf_counts
select 'notes', count(*) from public.inbox_items
where task_id = (select id from sf_ids where name = 't1') and recipient_id = 'b7c30029-0000-4000-8000-000000000001'
  and (data ->> 'field_change')::boolean;
set role authenticated;
do $$
declare
  priority uuid := (select id from sf_ids where name = 'priority');
  pb uuid := (select id from sf_ids where name = 'pb');
  t uuid := (select id from sf_ids where name = 't1');
  stories integer;
  locks integer;
begin
  select count(*) into stories from public.task_stories where task_id = t and kind = 'field_changed';
  insert into public.task_field_values (task_id, field_id, value) values (t, priority, '"p-high"')
  on conflict (task_id, field_id) do update set value = excluded.value;
  assert (select value from public.task_field_values where task_id = t and field_id = pb) = '"p-high"',
    'the value written in SF A shows in SF B';
  assert (select count(*) from public.task_stories where task_id = t and kind = 'field_changed') = stories + 1,
    'one story for the change, not one per project';
  select count(*) into locks from pg_locks where locktype = 'advisory' and pid = pg_backend_pid();
  assert locks > 0, 'the shared write took the per-task, per-field advisory lock';
end $$;
reset role;
do $$
begin
  assert (select count(*) from public.inbox_items
          where task_id = (select id from sf_ids where name = 't1') and recipient_id = 'b7c30029-0000-4000-8000-000000000001'
            and (data ->> 'field_change')::boolean) = (select n from sf_counts where name = 'notes') + 1,
    'one field-change notification, not one per project';
end $$;
set role authenticated;

-- Bea (Editor of SF B only) changes it through SF B; SF A has it too. Then it is cleared from SF A.
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from sf_ids where name = 't1');
  pb uuid := (select id from sf_ids where name = 'pb');
begin
  update public.task_field_values set value = '"p-low"' where task_id = t and field_id = pb;
  assert found, 'Bea writes SF B''s value';
end $$;
reset role;
do $$
begin
  assert (select value from public.task_field_values
          where task_id = (select id from sf_ids where name = 't1') and field_id = (select id from sf_ids where name = 'priority'))
    = '"p-low"', 'the value written in SF B shows in SF A';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from sf_ids where name = 't1');
  priority uuid := (select id from sf_ids where name = 'priority');
  pb uuid := (select id from sf_ids where name = 'pb');
  child uuid;
  rows_before integer;
begin
  update public.task_field_values set value = null where task_id = t and field_id = priority;
  assert (select value from public.task_field_values where task_id = t and field_id = pb) is null, 'clearing syncs';

  -- Subtasks: their values follow the top-level task's projects.
  child := public.create_subtask(t, 'Shared child', null);
  insert into sf_ids values ('t1child', child);
  insert into public.task_field_values (task_id, field_id, value) values (child, pb, '"p-high"');
  assert (select value from public.task_field_values where task_id = child and field_id = priority) = '"p-high"',
    'a subtask''s value syncs too';

  -- A project-only field stays local.
  select count(*) into rows_before from public.task_field_values where task_id = t;
  insert into public.task_field_values (task_id, field_id, value) values (t, (select id from sf_ids where name = 'unshared'), '"only here"');
  assert (select count(*) from public.task_field_values where task_id = t) = rows_before + 1, 'one row for a project-only field';
end $$;

-- A task joining SF B later gets the value; removed, it keeps its old row; added back, it catches up
-- (each step its own transaction, as in the app).
do $$
declare
  a uuid := (select id from sf_ids where name = 'a');
  b uuid := (select id from sf_ids where name = 'b');
  priority uuid := (select id from sf_ids where name = 'priority');
  pb uuid := (select id from sf_ids where name = 'pb');
  t uuid;
  child uuid;
  stories integer;
begin
  t := public.create_task(a, (select id from sf_ids where name = 'sa'), 'Joins later');
  insert into sf_ids values ('t2', t);
  insert into public.task_field_values (task_id, field_id, value) values (t, priority, '"p-high"');
  child := public.create_subtask(t, 'Joins later child', null);
  insert into public.task_field_values (task_id, field_id, value) values (child, priority, '"p-low"');
  assert not exists (select 1 from public.task_field_values where task_id = t and field_id = pb), 'not in SF B yet';
  select count(*) into stories from public.task_stories where task_id = t and kind = 'field_changed';
  insert into public.task_projects (task_id, project_id, section_id) values (t, b, (select id from sf_ids where name = 'sb'));
  assert (select value from public.task_field_values where task_id = t and field_id = pb) = '"p-high"',
    'joining SF B brings the value';
  assert (select value from public.task_field_values where task_id = child and field_id = pb) = '"p-low"',
    'and its subtasks'' values';
  assert (select count(*) from public.task_stories where task_id = t and kind = 'field_changed') = stories,
    'quietly (no story)';
end $$;

do $$
declare
  t uuid := (select id from sf_ids where name = 't2');
begin
  update public.task_projects set deleted_at = now() where task_id = t and project_id = (select id from sf_ids where name = 'b');
  update public.task_field_values set value = '"p-low"' where task_id = t and field_id = (select id from sf_ids where name = 'priority');
  assert (select value from public.task_field_values where task_id = t and field_id = (select id from sf_ids where name = 'pb')) = '"p-high"',
    'a project the task left keeps its old row';
end $$;

do $$
declare
  t uuid := (select id from sf_ids where name = 't2');
begin
  update public.task_projects set deleted_at = null where task_id = t and project_id = (select id from sf_ids where name = 'b');
  assert (select value from public.task_field_values where task_id = t and field_id = (select id from sf_ids where name = 'pb')) = '"p-low"',
    'added back, it gets the newest value';
end $$;

-- ---------------------------------------------------------------------------------------------
-- SF B's rules run when the value changes through SF A (and not when a task merely joins)
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  r uuid;
begin
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions)
  values ((select id from sf_ids where name = 'b'), 'B hears Priority', true, 'field_changed',
    jsonb_build_object('field_id', (select id from sf_ids where name = 'pb')),
    '[{"type": "add_comment", "body": "SF B saw the priority change"}]')
  returning id into r;
  insert into sf_ids values ('rule_b', r);
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from sf_ids where name = 't1');
  t3 uuid;
begin
  insert into public.task_field_values (task_id, field_id, value) values (t, (select id from sf_ids where name = 'priority'), '"p-high"')
  on conflict (task_id, field_id) do update set value = excluded.value;
  assert exists (select 1 from public.comments where task_id = t and body = 'SF B saw the priority change' and deleted_at is null),
    'SF B''s field_changed rule ran for an edit made in SF A';
  assert exists (select 1 from public.rule_runs where rule_id = (select id from sf_ids where name = 'rule_b') and task_id = t
                 and status = 'succeeded'), 'and logged its run';

  t3 := public.create_task((select id from sf_ids where name = 'a'), (select id from sf_ids where name = 'sa'), 'Joins quietly');
  insert into public.task_field_values (task_id, field_id, value) values (t3, (select id from sf_ids where name = 'priority'), '"p-low"');
  insert into public.task_projects (task_id, project_id, section_id) values (t3, (select id from sf_ids where name = 'b'), (select id from sf_ids where name = 'sb'));
  assert (select value from public.task_field_values where task_id = t3 and field_id = (select id from sf_ids where name = 'pb')) = '"p-low"',
    'joined with its value';
  assert not exists (select 1 from public.comments where task_id = t3 and body = 'SF B saw the priority change'),
    'joining runs no rule';
end $$;

-- ---------------------------------------------------------------------------------------------
-- One definition
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  pb uuid := (select id from sf_ids where name = 'pb');
begin
  begin
    update public.custom_fields set name = 'Pri' where id = pb;
    raise exception 'Bea can''t rename a shared field';
  exception when insufficient_privilege then
    assert sqlerrm like 'Shared from the field library.%', sqlerrm;
  end;
  begin
    update public.custom_fields set options = '[]' where id = pb;
    raise exception 'Bea can''t change its options';
  exception when insufficient_privilege then
    null;
  end;
  -- Her project's own settings for it are hers.
  update public.custom_fields set show_in_views = false where id = pb;
  assert found, 'show_in_views is per project';
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  priority uuid := (select id from sf_ids where name = 'priority');
begin
  assert (select show_in_views from public.custom_fields where id = priority), 'the source''s pin didn''t move';
  update public.custom_fields
  set name = 'Priority level',
      options = '[{"id": "p-low", "name": "Low", "color": "green"}, {"id": "p-mid", "name": "Medium", "color": "yellow"},
                  {"id": "p-high", "name": "High", "color": "red"}]'
  where id = priority;
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  priority uuid := (select id from sf_ids where name = 'priority');
  pb uuid := (select id from sf_ids where name = 'pb');
begin
  assert (select name = 'Priority level' and jsonb_array_length(options) = 3 and not show_in_views from public.custom_fields where id = pb),
    'renaming and a new option reach the placement; its pin stays its own';
  -- Eddie edits SF A too, so he changes the definition through SF B's placement.
  update public.custom_fields set description = 'How urgent, really' where id = pb;
  assert (select description from public.custom_fields where id = priority) = 'How urgent, really',
    'a definition change through a placement reaches the source';
end $$;

-- SF C: a task already in SF A and SF C gets the value when SF C adds the field.
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  c uuid := (select id from sf_ids where name = 'c');
  t uuid;
  pc uuid;
begin
  t := public.create_task((select id from sf_ids where name = 'a'), (select id from sf_ids where name = 'sa'), 'Already in C');
  insert into sf_ids values ('t4', t);
  insert into public.task_field_values (task_id, field_id, value) values (t, (select id from sf_ids where name = 'priority'), '"p-mid"');
  insert into public.task_projects (task_id, project_id, section_id) values (t, c, (select id from sf_ids where name = 'sc'));
  pc := public.add_library_field(c, (select id from sf_ids where name = 'priority'));
  insert into sf_ids values ('pc', pc);
  assert (select value from public.task_field_values where task_id = t and field_id = pc) = '"p-mid"',
    'adding the field fills the project''s tasks';
  assert (select name from public.custom_fields where id = pc) = 'Priority level', 'with the current definition';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Bulk edit and filters still work per placement
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  result jsonb;
begin
  result := public.bulk_update_tasks(array[(select id from sf_ids where name = 't1')],
    jsonb_build_object('action', 'set_field', 'field_id', (select id from sf_ids where name = 'pb'), 'value', 'p-mid'));
  assert jsonb_array_length(result -> 'updated') = 1, format('bulk set_field through SF B: %s', result);
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  assert (select value from public.task_field_values
          where task_id = (select id from sf_ids where name = 't1') and field_id = (select id from sf_ids where name = 'priority'))
    = '"p-mid"', 'the bulk edit reached SF A';
  assert exists (
    select 1 from public.filter_project_tasks((select id from sf_ids where name = 'a'),
      jsonb_build_object('fields', jsonb_build_array(jsonb_build_object(
        'field_id', (select id from sf_ids where name = 'priority'), 'op', 'in', 'values', '["p-mid"]'::jsonb))), 'UTC') f
    where f.task_id = (select id from sf_ids where name = 't1')
  ), 'SF A''s filter finds the task by the value set in SF B';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Copies: Duplicate project links the copy to the library field; an unpublished one is a plain copy
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  priority uuid := (select id from sf_ids where name = 'priority');
  copy_a uuid;
  copy_b uuid;
  copy_after uuid;
  f public.custom_fields;
begin
  copy_a := (public.duplicate_project((select id from sf_ids where name = 'a'), 'SF A copy', '{}'::jsonb) ->> 'project_id')::uuid;
  insert into sf_ids values ('copy_a', copy_a);
  select * into f from public.custom_fields where project_id = copy_a and name = 'Priority level' and deleted_at is null;
  assert f.library_field_id = priority, 'the source''s copy is a placement of it';
  assert not f.in_library, 'and isn''t listed in the library itself';
  assert (select library_field_id from public.custom_fields where project_id = copy_a and name = 'Unshared') is null,
    'a project-only field is a plain copy';
  assert exists (
    select 1 from public.task_field_values v join public.tasks t on t.id = v.task_id
    where v.field_id = f.id and t.title = 'Already in C' and v.value = '"p-mid"'
  ), 'copied values sit on the copy''s placement';

  copy_b := (public.duplicate_project((select id from sf_ids where name = 'b'), 'SF B copy', '{}'::jsonb) ->> 'project_id')::uuid;
  insert into sf_ids values ('copy_b', copy_b);
  assert (select library_field_id from public.custom_fields where project_id = copy_b and name = 'Priority level' and deleted_at is null)
    = priority, 'a placement''s copy is a placement of the same library field';

  -- Unpublished: no new projects; existing placements stay linked and in step.
  update public.custom_fields set in_library = false where id = priority;
  begin
    perform public.add_library_field((select id from sf_ids where name = 'c'), (select id from sf_ids where name = 'budget'));
  exception when others then
    raise exception 'budget is still published: %', sqlerrm;
  end;
  begin
    perform public.add_library_field(copy_a, priority);
    raise exception 'an unpublished field can''t be added';
  exception when no_data_found then
    null;
  end;
  copy_after := (public.duplicate_project((select id from sf_ids where name = 'a'), 'SF A late copy', '{}'::jsonb) ->> 'project_id')::uuid;
  assert (select library_field_id from public.custom_fields where project_id = copy_after and name = 'Priority level') is null,
    'after unpublishing, a copy is a plain copy';
  update public.task_field_values set value = '"p-low"'
  where task_id = (select id from sf_ids where name = 't4') and field_id = priority;
  assert (select value from public.task_field_values
          where task_id = (select id from sf_ids where name = 't4') and field_id = (select id from sf_ids where name = 'pc')) = '"p-low"',
    'existing placements keep syncing after unpublishing';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Removing a placement, and the source going away
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
begin
  update public.custom_fields set deleted_at = now() where id = (select id from sf_ids where name = 'pb');
  assert found, 'an Editor of SF B removes the field from SF B';
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from sf_ids where name = 't1');
begin
  assert (select deleted_at is null from public.custom_fields where id = (select id from sf_ids where name = 'priority')),
    'the source is untouched';
  update public.task_field_values set value = '"p-high"' where task_id = t and field_id = (select id from sf_ids where name = 'priority');
end $$;
reset role;
do $$
begin
  assert (select value from public.task_field_values
          where task_id = (select id from sf_ids where name = 't1') and field_id = (select id from sf_ids where name = 'pb')) = '"p-mid"',
    'a removed placement gets no more values';
end $$;

-- Olive removes the source: SF C's Editors now look after the definition, and it still reaches every
-- live placement.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  update public.custom_fields set deleted_at = now() where id = (select id from sf_ids where name = 'priority');
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  pc uuid := (select id from sf_ids where name = 'pc');
  s record;
begin
  select * into s from public.project_field_sharing((select id from sf_ids where name = 'c')) where field_id = pc;
  assert s.definition_editable and s.is_shared, 'with the source gone, SF C''s Editors edit its definition';
  update public.custom_fields set name = 'Urgency' where id = pc;
  assert found, 'Bea renames it';
end $$;
reset role;
do $$
begin
  assert (select name from public.custom_fields
          where project_id = (select id from sf_ids where name = 'copy_a') and library_field_id = (select id from sf_ids where name = 'priority')
            and deleted_at is null) = 'Urgency', 'the rename reached the other live placements';
  assert (select name from public.custom_fields where id = (select id from sf_ids where name = 'priority')) = 'Priority level',
    'a removed field is left as it was';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Linking existing copies (link_library_field_copies, run once by the migration)
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  m1 uuid;
  m2 uuid;
  m3 uuid;
  m4 uuid;
  m5 uuid;
  s1 uuid;
  s2 uuid;
  f uuid;
  t uuid;
  opts jsonb := '[{"id": "st-a", "name": "Ay", "color": "blue"}, {"id": "st-b", "name": "Bee", "color": "pink"}]';
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF M1') returning id into m1;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF M2') returning id into m2;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF M3') returning id into m3;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF M4') returning id into m4;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF M5') returning id into m5;
  insert into sf_ids values ('m1', m1), ('m2', m2), ('m3', m3), ('m4', m4), ('m5', m5);
  with x as (insert into public.sections (project_id, name, sort_order) values (m1, 'One', 1024) returning id) insert into sf_ids select 'sm1', id from x;
  with x as (insert into public.sections (project_id, name, sort_order) values (m2, 'Two', 1024) returning id) insert into sf_ids select 'sm2', id from x;

  -- Sources in SF M1.
  insert into public.custom_fields (project_id, name, field_type, options, in_library) values (m1, 'Stage', 'single_select', opts, true)
  returning id into s1;
  insert into sf_ids values ('s_stage', s1);
  insert into public.custom_fields (project_id, name, field_type, description, in_library) values (m1, 'Brief', 'text', 'The brief', true)
  returning id into s2;
  insert into sf_ids values ('s_brief', s2);
  with x as (insert into public.custom_fields (project_id, name, field_type, description, in_library)
    values (m1, 'Owner', 'text', 'Who owns it', true) returning id) insert into sf_ids select 's_owner1', id from x;
  with x as (insert into public.custom_fields (project_id, name, field_type, description, in_library)
    values (m4, 'Owner', 'text', 'Who owns it', true) returning id) insert into sf_ids select 's_owner2', id from x;

  -- Same option ids (other names, other order) → linked.
  with x as (insert into public.custom_fields (project_id, name, field_type, options)
    values (m2, ' stage ', 'single_select',
      '[{"id": "st-b", "name": "B", "color": "red"}, {"id": "st-a", "name": "A", "color": "red"}]') returning id) insert into sf_ids select 'c_stage', id from x;
  -- Same name, other options → not linked.
  with x as (insert into public.custom_fields (project_id, name, field_type, options)
    values (m3, 'Stage', 'single_select', '[{"id": "st-a", "name": "Ay", "color": "blue"}]') returning id) insert into sf_ids select 'c_stage_other', id from x;
  -- Same options but made before the source → not linked.
  with x as (insert into public.custom_fields (project_id, name, field_type, options)
    values (m4, 'Stage', 'single_select', opts) returning id) insert into sf_ids select 'c_stage_early', id from x;
  -- Text with the same description (trimmed) → linked; without one → not linked.
  with x as (insert into public.custom_fields (project_id, name, field_type, description)
    values (m2, 'BRIEF', 'text', ' The brief ') returning id) insert into sf_ids select 'c_brief', id from x;
  with x as (insert into public.custom_fields (project_id, name, field_type)
    values (m3, 'Brief', 'text') returning id) insert into sf_ids select 'c_brief_bare', id from x;
  -- Matches two library fields → left alone.
  with x as (insert into public.custom_fields (project_id, name, field_type, description)
    values (m2, 'Owner', 'text', 'Who owns it') returning id) insert into sf_ids select 'c_owner', id from x;
  -- Two candidates in one project → both left alone.
  with x as (insert into public.custom_fields (project_id, name, field_type, description)
    values (m5, 'Brief', 'text', 'The brief') returning id) insert into sf_ids select 'c_brief_twin1', id from x;
  with x as (insert into public.custom_fields (project_id, name, field_type, description)
    values (m5, 'brief', 'text', 'The brief') returning id) insert into sf_ids select 'c_brief_twin2', id from x;

  -- Values. V1: only M1 has one. V2: both equal. V3: both differ. V4: only in M2.
  t := public.create_task(m1, (select id from sf_ids where name = 'sm1'), 'Link V1');
  insert into sf_ids values ('v1', t);
  insert into public.task_projects (task_id, project_id, section_id) values (t, m2, (select id from sf_ids where name = 'sm2'));
  insert into public.task_field_values (task_id, field_id, value) values (t, s1, '"st-a"'), (t, s2, '"Write it up"');
  t := public.create_task(m1, (select id from sf_ids where name = 'sm1'), 'Link V2');
  insert into sf_ids values ('v2', t);
  insert into public.task_projects (task_id, project_id, section_id) values (t, m2, (select id from sf_ids where name = 'sm2'));
  insert into public.task_field_values (task_id, field_id, value) values
    (t, s1, '"st-b"'), (t, (select id from sf_ids where name = 'c_stage'), '"st-b"');
  t := public.create_task(m1, (select id from sf_ids where name = 'sm1'), 'Link V3');
  insert into sf_ids values ('v3', t);
  insert into public.task_projects (task_id, project_id, section_id) values (t, m2, (select id from sf_ids where name = 'sm2'));
  insert into public.task_field_values (task_id, field_id, value) values
    (t, s1, '"st-a"'), (t, (select id from sf_ids where name = 'c_stage'), '"st-b"');
  t := public.create_task(m2, (select id from sf_ids where name = 'sm2'), 'Link V4');
  insert into sf_ids values ('v4', t);
  insert into public.task_field_values (task_id, field_id, value) values (t, (select id from sf_ids where name = 'c_stage'), '"st-b"');
end $$;
reset role;

do $$
declare
  result jsonb;
  again jsonb;
  stories integer;
  v1 uuid := (select id from sf_ids where name = 'v1');
  v3 uuid := (select id from sf_ids where name = 'v3');
  s1 uuid := (select id from sf_ids where name = 's_stage');
  c_stage uuid := (select id from sf_ids where name = 'c_stage');
begin
  -- Creation order: the projects, then the sources, the early copy before them, the rest after (a copy
  -- is linked only when it was added after its own project was made: see the template case below).
  update public.projects set created_at = now() - interval '30 days'
  where id in (select id from sf_ids where name in ('m1', 'm2', 'm3', 'm4', 'm5'));
  update public.custom_fields set created_at = now() - interval '10 days'
  where id in (select id from sf_ids where name in ('s_stage', 's_brief', 's_owner1', 's_owner2'));
  update public.custom_fields set created_at = now() - interval '20 days' where id = (select id from sf_ids where name = 'c_stage_early');
  update public.custom_fields set created_at = now() - interval '5 days'
  where id in (select id from sf_ids where name like 'c\_%' and name <> 'c_stage_early');

  select count(*) into stories from public.task_stories where task_id = v1 and kind = 'field_changed';
  result := public.link_library_field_copies();
  assert (result ->> 'linked')::integer >= 2 and (result ->> 'filled')::integer >= 2
    and (result ->> 'conflicts')::integer >= 1 and (result ->> 'ambiguous')::integer >= 3, format('counts: %s', result);

  assert (select library_field_id from public.custom_fields where id = c_stage) = s1, 'same option ids: linked';
  assert (select matched_by from public.library_field_links where field_id = c_stage) = 'options', 'recorded as an options match';
  assert (select previous_definition ->> 'name' = ' stage '
            and previous_definition -> 'options' -> 0 ->> 'name' = 'B'
          from public.library_field_links where field_id = c_stage), 'with the definition it had before';
  assert (select name = 'Stage' and options = (select options from public.custom_fields where id = s1)
          from public.custom_fields where id = c_stage), 'the copy takes the library definition';
  assert (select library_field_id from public.custom_fields where id = (select id from sf_ids where name = 'c_brief'))
    = (select id from sf_ids where name = 's_brief'), 'same description: linked';
  assert (select matched_by from public.library_field_links where field_id = (select id from sf_ids where name = 'c_brief')) = 'description',
    'recorded as a description match';
  assert (select count(*) from public.custom_fields
          where id in (select id from sf_ids where name in ('c_stage_other', 'c_stage_early', 'c_brief_bare', 'c_owner',
                                                             'c_brief_twin1', 'c_brief_twin2'))
            and library_field_id is not null) = 0,
    'other options, made earlier, no description, two library fields, two in one project: left alone';

  -- Values.
  assert (select value from public.task_field_values where task_id = v1 and field_id = c_stage) = '"st-a"', 'V1 filled';
  assert (select value from public.task_field_values where task_id = v1 and field_id = (select id from sf_ids where name = 'c_brief'))
    = '"Write it up"', 'V1''s text filled';
  assert (select count(*) from public.task_stories where task_id = v1 and kind = 'field_changed') = stories, 'quietly';
  assert (select value from public.task_field_values where task_id = (select id from sf_ids where name = 'v2') and field_id = c_stage) = '"st-b"',
    'V2 equal: unchanged';
  assert (select value from public.task_field_values where task_id = v3 and field_id = s1) = '"st-a"'
    and (select value from public.task_field_values where task_id = v3 and field_id = c_stage) = '"st-b"', 'V3: both kept';
  assert (select count(*) from public.library_field_link_conflicts
          where task_id = v3 and field_id = c_stage and value = '"st-b"' and other_field_id = s1 and other_value = '"st-a"') = 1,
    'V3: the conflict is recorded';
  assert (select value from public.task_field_values where task_id = (select id from sf_ids where name = 'v4') and field_id = c_stage)
    = '"st-b"', 'V4 (one project): untouched';

  -- Running it again changes nothing for these.
  again := public.link_library_field_copies();
  assert (select count(*) from public.library_field_links where field_id = c_stage) = 1, 'linked once';
  assert (select count(*) from public.library_field_link_conflicts where task_id = v3) = 1, 'the conflict is recorded once';
end $$;

-- Linked fields share from now on.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  v1 uuid := (select id from sf_ids where name = 'v1');
begin
  update public.task_field_values set value = '"st-b"'
  where task_id = v1 and field_id = (select id from sf_ids where name = 'c_stage');
  assert (select value from public.task_field_values where task_id = v1 and field_id = (select id from sf_ids where name = 's_stage'))
    = '"st-b"', 'after linking, a change through the copy reaches the library field';
end $$;
reset role;

-- A copy that doesn't fit the other placement is skipped; the person's own write stands. (Forced here
-- by narrowing the placement's options behind the definition sync's back.)
do $$
begin
  perform set_config('alhc.library_definition_sync', 'on', true);
  update public.custom_fields set options = '[{"id": "st-b", "name": "Bee", "color": "pink"}]'
  where id = (select id from sf_ids where name = 'c_stage');
  perform set_config('alhc.library_definition_sync', '', true);
end $$;
set role authenticated;
do $$
declare
  v1 uuid := (select id from sf_ids where name = 'v1');
begin
  update public.task_field_values set value = '"st-a"'
  where task_id = v1 and field_id = (select id from sf_ids where name = 's_stage');
  assert found, 'the write through SF M1 succeeds';
  assert (select value from public.task_field_values where task_id = v1 and field_id = (select id from sf_ids where name = 's_stage'))
    = '"st-a"', 'and keeps its value';
  assert (select value from public.task_field_values where task_id = v1 and field_id = (select id from sf_ids where name = 'c_stage'))
    = '"st-b"', 'the copy that doesn''t fit was skipped';
end $$;
reset role;

-- ---------------------------------------------------------------------------------------------
-- Review fixes. SF R1 (Olive) publishes Review state; Otto is a Viewer of SF R1 and an Admin of
-- SF R2. A Viewer of the publishing project, restoring a placement, the Asana importer, a task moved
-- under a task of another project, and empty values when existing copies are linked.
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  r1 uuid;
  r2 uuid;
  f uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF R1') returning id into r1;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF R2') returning id into r2;
  insert into sf_ids values ('r1', r1), ('r2', r2);
  with x as (insert into public.sections (project_id, name, sort_order) values (r1, 'R1 work', 1024) returning id) insert into sf_ids select 'sr1', id from x;
  with x as (insert into public.sections (project_id, name, sort_order) values (r2, 'R2 work', 1024) returning id) insert into sf_ids select 'sr2', id from x;
  perform public.add_project_member(r1, 'sf-outsider@example.com', 'viewer');
  perform public.add_project_member(r2, 'sf-outsider@example.com', 'admin');
  insert into public.custom_fields (project_id, name, field_type, options, in_library, sort_order)
  values (r1, 'Review state', 'single_select',
    '[{"id": "rv-draft", "name": "Draft", "color": "blue"}, {"id": "rv-done", "name": "Done", "color": "green"}]', true, 1024)
  returning id into f;
  insert into sf_ids values ('review', f);
end $$;

-- Otto shares it into SF R2. Reading the publishing project isn't enough to change its definition.
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000005', false) is not null as ok \gset
do $$
declare
  r2 uuid := (select id from sf_ids where name = 'r2');
  pr uuid;
  s record;
begin
  pr := public.add_library_field(r2, (select id from sf_ids where name = 'review'));
  insert into sf_ids values ('pr', pr);
  select * into s from public.project_field_sharing(r2) where field_id = pr;
  assert s.is_shared and not s.definition_editable and not s.definition_manageable,
    format('a Viewer of the publishing project doesn''t change the shared definition (%s)', row_to_json(s));
  begin
    update public.custom_fields set name = 'Otto''s state' where id = pr;
    raise exception 'a Viewer of the publishing project renamed the shared field';
  exception when insufficient_privilege then
    assert sqlerrm like 'Shared from the field library.%', sqlerrm;
  end;
  update public.custom_fields set deleted_at = now() where id = pr;
  assert found, 'Otto removes the field from SF R2';
end $$;

-- While it's out of SF R2, Olive changes the definition.
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  update public.custom_fields
  set name = 'Review stage', options = options || '[{"id": "rv-hold", "name": "On hold", "color": "amber"}]'::jsonb
  where id = (select id from sf_ids where name = 'review');
  assert found, 'Olive changes the library field';
end $$;

-- Putting it back can't bring a definition of its own (that was a way around the guard), and it comes
-- back with the group's current definition.
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000005', false) is not null as ok \gset
do $$
declare
  pr uuid := (select id from sf_ids where name = 'pr');
begin
  begin
    update public.custom_fields set deleted_at = null, name = 'Hijacked' where id = pr;
    raise exception 'a restore brought its own definition';
  exception when check_violation then
    assert sqlerrm = 'Restore the shared field first, then change it', sqlerrm;
  end;
  update public.custom_fields set deleted_at = null where id = pr;
  assert found, 'Otto puts the field back in SF R2';
  assert (select name = 'Review stage' and jsonb_array_length(options) = 3 from public.custom_fields where id = pr),
    'it comes back with the group''s current definition';
end $$;
reset role;
do $$
begin
  assert (select name = 'Review stage' and jsonb_array_length(options) = 3
          from public.custom_fields where id = (select id from sf_ids where name = 'review')),
    'the library field kept its definition';
end $$;

-- The Asana importer matches the placement by name. Otto (Admin of SF R2, Viewer of SF R1) can't
-- change the shared definition, so the option the field lacks isn't added (anywhere) and the value
-- naming it is skipped; the other value lands.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000005', false) is not null as ok \gset
do $$
declare
  run uuid;
  result jsonb;
begin
  run := public.start_import_run((select id from sf_ids where name = 'r2'), 'asana', array['review.json']);
  result := public.import_batch(run, $json$
  {
    "project": {"gid": "asana-review", "name": "Review"},
    "sections": [{"key": "s-r", "name": "R2 work"}],
    "fields": [{"key": "f-review", "name": "review stage", "type": "single_select", "options": ["Draft", "Blocked"]}],
    "tasks": [
      {"gid": "rv-1", "title": "Imported blocked", "section_key": "s-r", "fields": [{"key": "f-review", "value": "Blocked"}]},
      {"gid": "rv-2", "title": "Imported draft", "section_key": "s-r", "fields": [{"key": "f-review", "value": "draft"}]}
    ]
  }
  $json$);
  assert (result ->> 'values_skipped')::integer = 1, format('the value naming a missing option is skipped: %s', result);
  perform public.finish_import_run(run, 'completed', result);
end $$;
reset role;
do $$
declare
  pr uuid := (select id from sf_ids where name = 'pr');
begin
  assert (select jsonb_array_length(options) from public.custom_fields where id = (select id from sf_ids where name = 'review')) = 3
    and (select jsonb_array_length(options) from public.custom_fields where id = pr) = 3,
    'an importer who can''t change the shared definition adds no option to it';
  assert (select v.value from public.task_field_values v join public.tasks t on t.id = v.task_id
          where t.title = 'Imported draft' and v.field_id = pr) = '"rv-draft"', 'the value that fits is imported';
end $$;

-- Olive may change it (Owner of SF R1): her import into SF R2 adds the option, and every project gets it.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  run uuid;
  result jsonb;
begin
  run := public.start_import_run((select id from sf_ids where name = 'r2'), 'asana', array['review-2.json']);
  result := public.import_batch(run,
    '{"fields": [{"key": "f-review", "name": "Review stage", "type": "single_select", "options": ["Blocked"]}]}'::jsonb);
  perform public.finish_import_run(run, 'completed', result);
end $$;
reset role;
do $$
begin
  assert (select options @> '[{"name": "Blocked"}]' from public.custom_fields where id = (select id from sf_ids where name = 'review'))
    and (select options from public.custom_fields where id = (select id from sf_ids where name = 'review'))
      = (select options from public.custom_fields where id = (select id from sf_ids where name = 'pr')),
    'an importer who may change it adds the option to the shared definition';
end $$;

-- A task (with a subtask) in SF R1 becomes a subtask of a task in SF R2: SF R2's placement gets their
-- values, quietly.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  review uuid := (select id from sf_ids where name = 'review');
  pr uuid := (select id from sf_ids where name = 'pr');
  t uuid;
  child uuid;
  parent uuid;
  stories integer;
begin
  t := public.create_task((select id from sf_ids where name = 'r1'), (select id from sf_ids where name = 'sr1'), 'Moving review');
  child := public.create_subtask(t, 'Moving review child', null);
  parent := public.create_task((select id from sf_ids where name = 'r2'), (select id from sf_ids where name = 'sr2'), 'New parent');
  insert into sf_ids values ('mv', t), ('mv_child', child);
  insert into public.task_field_values (task_id, field_id, value) values (t, review, '"rv-done"'), (child, review, '"rv-hold"');
  select count(*) into stories from public.task_stories where task_id = t and kind = 'field_changed';
  perform public.convert_to_subtask(t, parent);
  assert (select root_task_id from public.tasks where id = child) = parent, 'the subtree moved';
  assert (select value from public.task_field_values where task_id = t and field_id = pr) = '"rv-done"',
    'the moved task has its value in SF R2';
  assert (select value from public.task_field_values where task_id = child and field_id = pr) = '"rv-hold"',
    'and so does its subtask';
  assert (select count(*) from public.task_stories where task_id = t and kind = 'field_changed') = stories, 'quietly';
end $$;

-- When the publishing project is archived (read-only for everyone), the shared definition is frozen until
-- it's unarchived: the placements' own Editors (and Admins) don't take over. (Review fix: anyone could
-- otherwise add the field to a project of their own and rewrite it everywhere.)
do $$
begin
  perform public.set_project_archived((select id from sf_ids where name = 'r1'), true);
end $$;
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000005', false) is not null as ok \gset
do $$
declare
  s record;
begin
  select * into s from public.project_field_sharing((select id from sf_ids where name = 'r2'))
  where field_id = (select id from sf_ids where name = 'pr');
  assert not s.definition_editable and not s.definition_manageable,
    'with the publishing project archived, SF R2''s Admin doesn''t change the shared definition';
  begin
    update public.custom_fields set name = 'Hijacked' where id = (select id from sf_ids where name = 'pr');
    raise exception 'a placement''s Admin renamed a field whose publishing project is archived';
  exception when insufficient_privilege then
    assert sqlerrm like 'Shared from the field library.%', sqlerrm;
  end;
end $$;
reset role;

-- Linking existing copies: an empty value (none, "", []) is no value, so the other side's value fills it
-- instead of being recorded as a conflict.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  e1 uuid;
  e2 uuid;
  t uuid;
  opts jsonb := '[{"id": "ch-web", "name": "Web", "color": "blue"}, {"id": "ch-print", "name": "Print", "color": "red"}]';
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF E1') returning id into e1;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF E2') returning id into e2;
  insert into sf_ids values ('e1', e1), ('e2', e2);
  with x as (insert into public.sections (project_id, name, sort_order) values (e1, 'E1', 1024) returning id) insert into sf_ids select 'se1', id from x;
  with x as (insert into public.sections (project_id, name, sort_order) values (e2, 'E2', 1024) returning id) insert into sf_ids select 'se2', id from x;
  with x as (insert into public.custom_fields (project_id, name, field_type, options, in_library)
    values (e1, 'Channels', 'multi_select', opts, true) returning id) insert into sf_ids select 's_channels', id from x;
  with x as (insert into public.custom_fields (project_id, name, field_type, description, in_library)
    values (e1, 'Summary', 'text', 'Short summary', true) returning id) insert into sf_ids select 's_summary', id from x;
  with x as (insert into public.custom_fields (project_id, name, field_type, options)
    values (e2, 'Channels', 'multi_select', opts) returning id) insert into sf_ids select 'c_channels', id from x;
  with x as (insert into public.custom_fields (project_id, name, field_type, description)
    values (e2, 'Summary', 'text', 'Short summary') returning id) insert into sf_ids select 'c_summary', id from x;
  t := public.create_task(e1, (select id from sf_ids where name = 'se1'), 'Empty sides');
  insert into sf_ids values ('ve', t);
  insert into public.task_projects (task_id, project_id, section_id) values (t, e2, (select id from sf_ids where name = 'se2'));
  insert into public.task_field_values (task_id, field_id, value) values
    (t, (select id from sf_ids where name = 's_channels'), '["ch-web"]'),
    (t, (select id from sf_ids where name = 'c_channels'), '[]'),
    (t, (select id from sf_ids where name = 's_summary'), '""'),
    (t, (select id from sf_ids where name = 'c_summary'), '"Two lines"');
end $$;
reset role;
do $$
declare
  ve uuid := (select id from sf_ids where name = 've');
begin
  update public.projects set created_at = now() - interval '30 days' where id in (select id from sf_ids where name in ('e1', 'e2'));
  update public.custom_fields set created_at = now() - interval '10 days'
  where id in (select id from sf_ids where name in ('s_channels', 's_summary'));
  perform public.link_library_field_copies();
  assert (select library_field_id from public.custom_fields where id = (select id from sf_ids where name = 'c_channels'))
      = (select id from sf_ids where name = 's_channels')
    and (select library_field_id from public.custom_fields where id = (select id from sf_ids where name = 'c_summary'))
      = (select id from sf_ids where name = 's_summary'), 'both copies linked';
  assert (select value from public.task_field_values where task_id = ve and field_id = (select id from sf_ids where name = 'c_channels'))
    = '["ch-web"]', 'an empty multi-select is filled';
  assert (select value from public.task_field_values where task_id = ve and field_id = (select id from sf_ids where name = 's_summary'))
    = '"Two lines"', 'an empty text is filled';
  assert not exists (select 1 from public.library_field_link_conflicts where task_id = ve), 'no conflict for an empty side';
end $$;

-- Recurrence and Duplicate task copy values field by field into a task already in both projects: the
-- shared value reaches the other placement first, and the copy must not fail on it (it did: completing
-- the recurring task raised a duplicate key).
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  d1 uuid;
  d2 uuid;
  sd1 uuid;
  sd2 uuid;
  f uuid;
  pd uuid;
  t uuid;
  child uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF D1') returning id into d1;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF D2') returning id into d2;
  insert into public.sections (project_id, name, sort_order) values (d1, 'D1', 1024) returning id into sd1;
  insert into public.sections (project_id, name, sort_order) values (d2, 'D2', 1024) returning id into sd2;
  insert into public.custom_fields (project_id, name, field_type, options, in_library, sort_order)
  values (d1, 'Size', 'single_select', '[{"id": "sz-s", "name": "Small", "color": "blue"}, {"id": "sz-l", "name": "Large", "color": "red"}]',
    true, 1024)
  returning id into f;
  pd := public.add_library_field(d2, f);
  t := public.create_task(d1, sd1, 'Weekly report');
  insert into public.task_projects (task_id, project_id, section_id) values (t, d2, sd2);
  child := public.create_subtask(t, 'Weekly report part', null);
  insert into public.task_field_values (task_id, field_id, value) values (t, f, '"sz-l"'), (child, pd, '"sz-s"');
  update public.tasks set recurrence = '{"freq": "weekly", "interval": 1, "ends": {"type": "never"}}', due_on = current_date
  where id = t;
  insert into sf_ids values ('size', f), ('pd', pd), ('weekly', t);
end $$;

do $$
declare
  t uuid := (select id from sf_ids where name = 'weekly');
  f uuid := (select id from sf_ids where name = 'size');
  pd uuid := (select id from sf_ids where name = 'pd');
  next_t uuid;
  next_child uuid;
begin
  update public.tasks set completed_at = now() where id = t;
  assert found, 'the recurring task completes';
  next_t := (select recurrence_next_id from public.tasks where id = t);
  assert next_t is not null, 'its next occurrence was made';
  assert (select value from public.task_field_values where task_id = next_t and field_id = f) = '"sz-l"'
    and (select value from public.task_field_values where task_id = next_t and field_id = pd) = '"sz-l"',
    'the next occurrence has the value in both projects';
  next_child := (select id from public.tasks where parent_task_id = next_t and deleted_at is null);
  assert (select value from public.task_field_values where task_id = next_child and field_id = f) = '"sz-s"'
    and (select value from public.task_field_values where task_id = next_child and field_id = pd) = '"sz-s"',
    'and so does its subtask';
end $$;

do $$
declare
  t uuid := (select id from sf_ids where name = 'weekly');
  f uuid := (select id from sf_ids where name = 'size');
  pd uuid := (select id from sf_ids where name = 'pd');
  result jsonb;
  copy_t uuid;
  copy_child uuid;
begin
  result := public.duplicate_task(t, '{}'::jsonb);
  copy_t := (result ->> 'task_id')::uuid;
  assert (result -> 'skipped' ->> 'fields')::integer = 0, format('nothing skipped: %s', result);
  assert (select value from public.task_field_values where task_id = copy_t and field_id = f) = '"sz-l"'
    and (select value from public.task_field_values where task_id = copy_t and field_id = pd) = '"sz-l"',
    'the duplicate has the value in both projects';
  copy_child := (select id from public.tasks where parent_task_id = copy_t and deleted_at is null);
  assert (select value from public.task_field_values where task_id = copy_child and field_id = pd) = '"sz-s"',
    'and so does its subtask';
end $$;

-- A removed source that comes back takes the definition its placements moved on to (it can't push an
-- old one, or a new one in the same step, onto them).
do $$
declare
  f uuid := (select id from sf_ids where name = 'size');
  pd uuid := (select id from sf_ids where name = 'pd');
begin
  update public.custom_fields set deleted_at = now() where id = f;
  update public.custom_fields set name = 'Bigness' where id = pd;
  assert found, 'with the source removed, SF D2''s Editors rename it';
  begin
    update public.custom_fields set deleted_at = null, name = 'Size again' where id = f;
    raise exception 'a restored source pushed a definition of its own';
  exception when check_violation then
    assert sqlerrm = 'Restore the shared field first, then change it', sqlerrm;
  end;
  update public.custom_fields set deleted_at = null where id = f;
  assert (select name from public.custom_fields where id = f) = 'Bigness', 'the source comes back with the group''s definition';
  assert (select name from public.custom_fields where id = pd) = 'Bigness', 'the placement is unchanged';
end $$;
reset role;

-- =============================================================================================
-- 51. Field lock
--   Olive owns SF L1 and SF L2; Eddie is an Editor of both; Bea is an Admin of SF L2 only; Vera is a
--   Viewer of SF L1. SF L1 has Stage (single-select, project-only) and publishes Rate (number), which
--   SF L2 uses.
-- =============================================================================================

do $$
begin
  assert exists (
    select 1 from pg_attribute where attrelid = 'public.custom_fields'::regclass and attname = 'locked' and not attisdropped
  ) and exists (
    select 1 from pg_attribute where attrelid = 'public.custom_fields'::regclass and attname = 'locked_by' and not attisdropped
  ) and exists (
    select 1 from pg_attribute where attrelid = 'public.custom_fields'::regclass and attname = 'locked_at' and not attisdropped
  ), 'custom_fields.locked, locked_by, locked_at exist';
  assert exists (select 1 from pg_constraint where conname = 'custom_fields_lock_check'), 'Status can''t be locked (CHECK)';
  assert exists (select 1 from pg_trigger where tgname = 'custom_fields_06_lock_guard' and tgrelid = 'public.custom_fields'::regclass)
    and exists (select 1 from pg_trigger where tgname = 'task_field_values_02_field_lock' and tgrelid = 'public.task_field_values'::regclass),
    'the lock triggers are in place';
  assert not (select prosecdef from pg_proc where oid = 'public.guard_locked_field_value()'::regprocedure)
    and not (select prosecdef from pg_proc where oid = 'public.guard_custom_field_lock()'::regprocedure),
    'the guards run as the caller';
  assert (select prosecdef from pg_proc where oid = 'public.rule_owner_manages_project(uuid, uuid)'::regprocedure)
    and not has_function_privilege('authenticated', 'public.rule_owner_manages_project(uuid, uuid)', 'execute')
    and not has_function_privilege('anon', 'public.rule_owner_manages_project(uuid, uuid)', 'execute'),
    'the rule owner check is internal';
  assert not has_function_privilege('anon', 'public.guard_locked_field_value()', 'execute')
    and not has_function_privilege('anon', 'public.guard_custom_field_lock()', 'execute'), 'anon runs neither guard';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  l1 uuid;
  l2 uuid;
  s1 uuid;
  s2 uuid;
  stage uuid;
  rate uuid;
  rate2 uuid;
  t1 uuid;
  t2 uuid;
  ts uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF L1') returning id into l1;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF L2') returning id into l2;
  insert into public.sections (project_id, name, sort_order) values (l1, 'L1', 1024) returning id into s1;
  insert into public.sections (project_id, name, sort_order) values (l2, 'L2', 1024) returning id into s2;
  perform public.add_project_member(l1, 'sf-editor@example.com', 'editor');
  perform public.add_project_member(l2, 'sf-editor@example.com', 'editor');
  perform public.add_project_member(l2, 'sf-bedit@example.com', 'admin');
  perform public.add_project_member(l1, 'sf-viewer@example.com', 'viewer');
  insert into public.custom_fields (project_id, name, field_type, options, sort_order, show_in_views)
  values (l1, 'Stage', 'single_select',
    '[{"id": "st-draft", "name": "Draft", "color": "zinc"}, {"id": "st-final", "name": "Final", "color": "green"}]', 1024, true)
  returning id into stage;
  insert into public.custom_fields (project_id, name, field_type, in_library, sort_order)
  values (l1, 'Rate', 'number', true, 2048) returning id into rate;
  rate2 := public.add_library_field(l2, rate);
  t1 := public.create_task(l1, s1, 'Locked one');
  t2 := public.create_task(l1, s1, 'Locked two');
  ts := public.create_task(l1, s1, 'Shared locked');
  insert into public.task_projects (task_id, project_id, section_id) values (ts, l2, s2);
  insert into sf_ids values ('l1', l1), ('l2', l2), ('ls1', s1), ('ls2', s2), ('stage', stage), ('rate', rate), ('rate2', rate2),
    ('lt1', t1), ('lt2', t2), ('lts', ts);
end $$;

-- Eddie (Editor) can't lock; Olive (Owner) can, and the guard records who and when.
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  stage uuid := (select id from sf_ids where name = 'stage');
begin
  begin
    update public.custom_fields set locked = true where id = stage;
    raise exception 'an Editor locked a field';
  exception when insufficient_privilege then
    assert sqlerrm = 'Only project Owners and Admins can lock or unlock a field', sqlerrm;
  end;
  begin
    insert into public.custom_fields (project_id, name, field_type, locked)
    values ((select id from sf_ids where name = 'l1'), 'Born locked', 'text', true);
    raise exception 'an Editor made a locked field';
  exception when insufficient_privilege then
    null;
  end;
  -- Before the lock, Eddie sets values freely.
  insert into public.task_field_values (task_id, field_id, value) values ((select id from sf_ids where name = 'lt1'), stage, '"st-draft"');
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  stage uuid := (select id from sf_ids where name = 'stage');
begin
  update public.custom_fields set locked = true, locked_by = 'b7c30029-0000-4000-8000-000000000002' where id = stage;
  assert (select locked from public.custom_fields where id = stage), 'Olive locked Stage';
  assert (select locked_by from public.custom_fields where id = stage) = 'b7c30029-0000-4000-8000-000000000001'
    and (select locked_at from public.custom_fields where id = stage) is not null, 'the guard records who locked it (not what was sent)';
  begin
    insert into public.custom_fields (project_id, name, field_type, bound_to_sections, locked)
    values ((select id from sf_ids where name = 'l1'), 'Status', 'single_select', true, true);
    raise exception 'a section-bound field was locked';
  exception when check_violation then
    null;
  end;
end $$;

-- While locked, Eddie can't change values (insert, upsert, update, clear), the definition, or remove it;
-- show it in List / Board is still his to change. A value that doesn't change isn't refused.
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  stage uuid := (select id from sf_ids where name = 'stage');
  t1 uuid := (select id from sf_ids where name = 'lt1');
  t2 uuid := (select id from sf_ids where name = 'lt2');
begin
  begin
    insert into public.task_field_values (task_id, field_id, value) values (t2, stage, '"st-final"');
    raise exception 'an Editor set a locked value';
  exception when insufficient_privilege then
    assert sqlerrm = 'Locked — only project Owners and Admins can change this field', sqlerrm;
  end;
  begin
    insert into public.task_field_values (task_id, field_id, value) values (t1, stage, '"st-final"')
    on conflict (task_id, field_id) do update set value = excluded.value;
    raise exception 'an Editor changed a locked value (upsert)';
  exception when insufficient_privilege then
    null;
  end;
  begin
    update public.task_field_values set value = 'null' where task_id = t1 and field_id = stage;
    raise exception 'an Editor cleared a locked value';
  exception when insufficient_privilege then
    null;
  end;
  update public.task_field_values set value = '"st-draft"' where task_id = t1 and field_id = stage;
  insert into public.task_field_values (task_id, field_id, value) values (t2, stage, 'null');
  assert (select value from public.task_field_values where task_id = t1 and field_id = stage) = '"st-draft"', 'the value is unchanged';
  begin
    update public.custom_fields set name = 'Phase' where id = stage;
    raise exception 'an Editor renamed a locked field';
  exception when insufficient_privilege then
    assert sqlerrm = 'Locked — only project Owners and Admins can change this field', sqlerrm;
  end;
  begin
    update public.custom_fields set options = options || '[{"id": "st-x", "name": "Extra", "color": "red"}]' where id = stage;
    raise exception 'an Editor added an option to a locked field';
  exception when insufficient_privilege then
    null;
  end;
  begin
    update public.custom_fields set deleted_at = now() where id = stage;
    raise exception 'an Editor removed a locked field';
  exception when insufficient_privilege then
    null;
  end;
  begin
    update public.custom_fields set locked = false where id = stage;
    raise exception 'an Editor unlocked a field';
  exception when insufficient_privilege then
    assert sqlerrm = 'Only project Owners and Admins can lock or unlock a field', sqlerrm;
  end;
  update public.custom_fields set show_in_views = false where id = stage;
  assert found and not (select show_in_views from public.custom_fields where id = stage), 'an Editor still hides it from views';
  update public.custom_fields set show_in_views = true where id = stage;
end $$;

-- Bulk Field: Eddie's run skips both tasks with the reason; Olive's sets them.
do $$
declare
  stage uuid := (select id from sf_ids where name = 'stage');
  result jsonb;
begin
  result := public.bulk_update_tasks(array[(select id from sf_ids where name = 'lt1'), (select id from sf_ids where name = 'lt2')],
    jsonb_build_object('action', 'set_field', 'field_id', stage, 'value', 'st-final'));
  assert jsonb_array_length(result -> 'updated') = 0 and jsonb_array_length(result -> 'skipped') = 2, format('both skipped: %s', result);
  assert (select bool_and(s ->> 'reason' = 'Locked — only project Owners and Admins can change this field')
          from jsonb_array_elements(result -> 'skipped') s), format('with the reason: %s', result);
end $$;

-- Olive (Owner) changes values, the definition, and runs bulk.
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  stage uuid := (select id from sf_ids where name = 'stage');
  result jsonb;
begin
  insert into public.task_field_values (task_id, field_id, value) values ((select id from sf_ids where name = 'lt2'), stage, '"st-draft"')
  on conflict (task_id, field_id) do update set value = excluded.value;
  result := public.bulk_update_tasks(array[(select id from sf_ids where name = 'lt1'), (select id from sf_ids where name = 'lt2')],
    jsonb_build_object('action', 'set_field', 'field_id', stage, 'value', 'st-final'));
  assert jsonb_array_length(result -> 'updated') = 2, format('Olive''s bulk edit sets both: %s', result);
  update public.custom_fields set description = 'Where it is' where id = stage;
  assert (select description from public.custom_fields where id = stage) = 'Where it is', 'the Owner edits a locked definition';
end $$;

-- Duplicate task and task templates leave a locked value out for Eddie (Duplicate counts it); Olive's
-- copies keep it. Recurrence (a system path) keeps it whoever completes the task.
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  stage uuid := (select id from sf_ids where name = 'stage');
  t1 uuid := (select id from sf_ids where name = 'lt1');
  result jsonb;
  tpl uuid;
  made uuid;
  next_t uuid;
begin
  result := public.duplicate_task(t1, '{}'::jsonb);
  assert (result -> 'skipped' ->> 'fields')::integer = 1, format('the locked value is left out and counted: %s', result);
  assert not exists (select 1 from public.task_field_values where task_id = (result ->> 'task_id')::uuid and field_id = stage),
    'the copy has no Stage';

  insert into public.task_templates (project_id, name, title, field_values)
  values ((select id from sf_ids where name = 'l1'), 'Locked template', 'From template',
    jsonb_build_array(jsonb_build_object('field_id', stage, 'value', 'st-final')))
  returning id into tpl;
  insert into sf_ids values ('ltpl', tpl);
  made := public.create_task_from_template(tpl, (select id from sf_ids where name = 'ls1'), 'Templated by Eddie');
  assert made is not null, 'the task is made';
  assert not exists (select 1 from public.task_field_values where task_id = made and field_id = stage),
    'the template''s locked value is left out';

  update public.tasks set recurrence = '{"freq": "daily", "interval": 1, "ends": {"type": "never"}}', due_on = current_date
  where id = t1;
  update public.tasks set completed_at = now() where id = t1;
  next_t := (select recurrence_next_id from public.tasks where id = t1);
  assert (select value from public.task_field_values where task_id = next_t and field_id = stage) = '"st-final"',
    'the next occurrence keeps the locked value';
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  stage uuid := (select id from sf_ids where name = 'stage');
  result jsonb;
  made uuid;
begin
  result := public.duplicate_task((select id from sf_ids where name = 'lt2'), '{}'::jsonb);
  assert (result -> 'skipped' ->> 'fields')::integer = 0, format('nothing left out for the Owner: %s', result);
  assert (select value from public.task_field_values where task_id = (result ->> 'task_id')::uuid and field_id = stage) = '"st-final"',
    'the Owner''s copy keeps Stage';
  made := public.create_task_from_template((select id from sf_ids where name = 'ltpl'), (select id from sf_ids where name = 'ls1'), 'Templated by Olive');
  assert (select value from public.task_field_values where task_id = made and field_id = stage) = '"st-final"',
    'the Owner''s template task has Stage';
end $$;

-- Rules: Set field on a locked field runs only while the rule's owner is an Owner / Admin of it; else the
-- step is skipped with a logged reason and the run goes on.
do $$
declare
  stage uuid := (select id from sf_ids where name = 'stage');
  l1 uuid := (select id from sf_ids where name = 'l1');
  r_editor uuid;
  r_owner uuid;
begin
  insert into public.rules (project_id, name, enabled, trigger_type, owner_id, actions)
  values (l1, 'Editor-owned stage rule', true, 'manual', 'b7c30029-0000-4000-8000-000000000002',
    jsonb_build_array(jsonb_build_object('type', 'set_field', 'field_id', stage, 'value', 'st-draft'),
                      jsonb_build_object('type', 'add_comment', 'body', 'Rule went on')))
  returning id into r_editor;
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values (l1, 'Owner-owned stage rule', true, 'manual',
    jsonb_build_array(jsonb_build_object('type', 'set_field', 'field_id', stage, 'value', 'st-draft')))
  returning id into r_owner;
  insert into sf_ids values ('r_editor', r_editor), ('r_owner', r_owner);
end $$;

do $$
declare
  stage uuid := (select id from sf_ids where name = 'stage');
  t2 uuid := (select id from sf_ids where name = 'lt2');
  result jsonb;
begin
  result := public.run_manual_rule((select id from sf_ids where name = 'r_editor'), t2);
  assert result ->> 'status' = 'succeeded', format('the run goes on: %s', result);
  assert result -> 'detail' -> 'actions' -> 0 ->> 'outcome' = 'locked', format('the step is skipped as locked: %s', result);
  assert (result -> 'detail' -> 'actions' -> 0 ->> 'result') like 'Skipped: “Stage” is locked%', format('with the reason: %s', result);
  assert result -> 'detail' -> 'actions' -> 1 ->> 'outcome' = 'done', 'the next step still runs';
  assert (select value from public.task_field_values where task_id = t2 and field_id = stage) = '"st-final"', 'Stage is unchanged';
  assert exists (select 1 from public.comments c where c.task_id = t2 and c.body = 'Rule went on'), 'the comment was posted';
end $$;

-- (run_manual_rule reports the transaction's first run of a rule on a task, so each run is its own statement.)
do $$
declare
  result jsonb;
begin
  result := public.run_manual_rule((select id from sf_ids where name = 'r_owner'), (select id from sf_ids where name = 'lt2'));
  assert result -> 'detail' -> 'actions' -> 0 ->> 'outcome' = 'done', format('the Owner''s rule writes: %s', result);
  assert (select value from public.task_field_values
          where task_id = (select id from sf_ids where name = 'lt2') and field_id = (select id from sf_ids where name = 'stage')) = '"st-draft"',
    'Stage changed';
end $$;

-- The Editor-owned rule's owner becomes an Admin: its step now writes.
do $$
begin
  perform public.update_project_member_role((select id from sf_ids where name = 'l1'), 'b7c30029-0000-4000-8000-000000000002', 'admin');
  update public.task_field_values set value = '"st-final"'
  where task_id = (select id from sf_ids where name = 'lt2') and field_id = (select id from sf_ids where name = 'stage');
end $$;

do $$
declare
  result jsonb;
begin
  result := public.run_manual_rule((select id from sf_ids where name = 'r_editor'), (select id from sf_ids where name = 'lt2'));
  assert result -> 'detail' -> 'actions' -> 0 ->> 'outcome' = 'done', format('an Admin owner''s rule writes: %s', result);
  assert (select value from public.task_field_values
          where task_id = (select id from sf_ids where name = 'lt2') and field_id = (select id from sf_ids where name = 'stage')) = '"st-draft"',
    'Stage changed again';
  perform public.update_project_member_role((select id from sf_ids where name = 'l1'), 'b7c30029-0000-4000-8000-000000000002', 'editor');
end $$;

-- A rule's other writes are held to the same lock: an Editor-owned rule applying a task template leaves
-- the locked value out (the step still runs). A public form fills a locked field (forms are set up by
-- Admins): a system path.
do $$
declare
  rule_id uuid;
  result jsonb;
  form_id uuid;
begin
  insert into public.rules (project_id, name, enabled, trigger_type, owner_id, actions)
  values ((select id from sf_ids where name = 'l1'), 'Editor-owned template rule', true, 'manual', 'b7c30029-0000-4000-8000-000000000002',
    jsonb_build_array(jsonb_build_object('type', 'apply_task_template', 'template_id', (select id from sf_ids where name = 'ltpl'))))
  returning id into rule_id;
  result := public.run_manual_rule(rule_id, (select id from sf_ids where name = 'lt2'));
  assert result -> 'detail' -> 'actions' -> 0 ->> 'outcome' = 'done'
    and (result -> 'detail' -> 'actions' -> 0 ->> 'result')
      like '%0 field values (1 locked field value left out: only project Owners and Admins change locked fields, and this rule''s owner isn''t one)',
    format('the template step leaves Stage alone and says why: %s', result);
  assert (select value from public.task_field_values
          where task_id = (select id from sf_ids where name = 'lt2') and field_id = (select id from sf_ids where name = 'stage')) = '"st-draft"',
    'Stage is unchanged';

  insert into public.forms (project_id, title, accepting_responses, send_confirmation, destination_section_id, questions)
  values ((select id from sf_ids where name = 'l1'), 'Stage form', true, false, (select id from sf_ids where name = 'ls1'),
    jsonb_build_array(jsonb_build_object('id', 'q-stage', 'type', 'single_select', 'label', 'Stage',
      'options', jsonb_build_array(jsonb_build_object('id', 'st-final', 'label', 'Final')),
      'maps_to', jsonb_build_object('target', 'field', 'field_id', (select id from sf_ids where name = 'stage')))))
  returning id into form_id;
  insert into sf_ids values ('lform', form_id);
end $$;
reset role;

set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
insert into sf_ids select 'lformtask',
  (public.submit_form((select id from sf_ids where name = 'lform'), 'stage-requester@example.org', '{"q-stage": "st-final"}') ->> 'task_id')::uuid;
reset role;

do $$
begin
  assert (select value from public.task_field_values
          where task_id = (select id from sf_ids where name = 'lformtask') and field_id = (select id from sf_ids where name = 'stage')) = '"st-final"',
    'the form filled the locked field';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset

-- Duplicate project keeps the lock (the copy's Owner can unlock it).
do $$
declare
  result jsonb;
  copied uuid;
begin
  result := public.duplicate_project((select id from sf_ids where name = 'l1'), 'SF L1 copy', '{}'::jsonb);
  copied := (select f.id from public.custom_fields f where f.project_id = (result ->> 'project_id')::uuid and f.name = 'Stage');
  assert (select locked from public.custom_fields where id = copied), 'the copy''s Stage is locked';
  update public.custom_fields set locked = false where id = copied;
  assert not (select locked from public.custom_fields where id = copied), 'and its Owner unlocks it';
end $$;

-- Unlocking: Eddie edits values and the definition again; who / when are cleared.
do $$
begin
  update public.custom_fields set locked = false where id = (select id from sf_ids where name = 'stage');
  assert (select locked_by is null and locked_at is null from public.custom_fields where id = (select id from sf_ids where name = 'stage')),
    'unlocking clears who and when';
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  stage uuid := (select id from sf_ids where name = 'stage');
begin
  update public.task_field_values set value = '"st-final"' where task_id = (select id from sf_ids where name = 'lt2') and field_id = stage;
  assert found, 'unlocked: an Editor sets values again';
  update public.custom_fields set name = 'Stage name' where id = stage;
  assert found, 'and changes the definition';
end $$;

-- A shared library field: locking it at the source locks every placement. Bea (Admin of SF L2 only)
-- can't unlock it from there. Its value is one value in every project that holds the task, so a locked
-- one is changed only by someone who is an Owner or Admin of all of them: Bea writes it on a task only in
-- SF L2, not on one also in SF L1 (review fix: before, any Admin of one project changed it everywhere —
-- and anyone can make a project of their own); Olive (Owner of both) does, and it reaches SF L1 (sync
-- writes still happen); Eddie (Editor) writes through neither project.
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  rate uuid := (select id from sf_ids where name = 'rate');
  rate2 uuid := (select id from sf_ids where name = 'rate2');
begin
  update public.custom_fields set locked = true where id = rate;
  assert (select locked and locked_by = 'b7c30029-0000-4000-8000-000000000001' from public.custom_fields where id = rate2),
    'the placement is locked too (and says who locked it)';
  insert into sf_ids values ('lt_l2', public.create_task((select id from sf_ids where name = 'l2'), (select id from sf_ids where name = 'ls2'), 'Only in L2'));
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  rate uuid := (select id from sf_ids where name = 'rate');
  rate2 uuid := (select id from sf_ids where name = 'rate2');
  ts uuid := (select id from sf_ids where name = 'lts');
  share record;
begin
  select * into share from public.project_field_sharing((select id from sf_ids where name = 'l2')) s where s.field_id = rate2;
  assert not share.definition_manageable and not share.definition_editable, 'Bea doesn''t manage the shared definition';
  begin
    update public.custom_fields set locked = false where id = rate2;
    raise exception 'Bea unlocked a shared field from a placement';
  exception when insufficient_privilege then
    null;
  end;
  assert not public.locked_field_value_writable(ts, rate2), 'Bea can''t change it on a task that is also in SF L1';
  begin
    insert into public.task_field_values (task_id, field_id, value) values (ts, rate2, '42');
    raise exception 'an Admin of SF L2 only changed a locked value SF L1 shares';
  exception when insufficient_privilege then
    assert sqlerrm = 'Locked — only Owners and Admins of every project this task is in can change this shared field', sqlerrm;
  end;
  assert public.locked_field_value_writable((select id from sf_ids where name = 'lt_l2'), rate2), 'on a task only in SF L2 she can';
  insert into public.task_field_values (task_id, field_id, value) values ((select id from sf_ids where name = 'lt_l2'), rate2, '42');
  assert found, 'an Admin of SF L2 writes the locked value on a task only SF L2 holds';
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  insert into public.task_field_values (task_id, field_id, value)
  values ((select id from sf_ids where name = 'lts'), (select id from sf_ids where name = 'rate2'), '42');
  assert found, 'Olive (Owner of SF L1 and SF L2) writes it through SF L2';
end $$;
reset role;
do $$
begin
  assert (select value from public.task_field_values
          where task_id = (select id from sf_ids where name = 'lts') and field_id = (select id from sf_ids where name = 'rate')) = '42',
    'the value reached SF L1 (sync writes still happen)';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  ts uuid := (select id from sf_ids where name = 'lts');
begin
  begin
    update public.task_field_values set value = '7' where task_id = ts and field_id = (select id from sf_ids where name = 'rate2');
    raise exception 'an Editor changed a locked shared value through SF L2';
  exception when insufficient_privilege then
    null;
  end;
  begin
    update public.task_field_values set value = '7' where task_id = ts and field_id = (select id from sf_ids where name = 'rate');
    raise exception 'an Editor changed a locked shared value through SF L1';
  exception when insufficient_privilege then
    null;
  end;
  begin
    update public.custom_fields set name = 'Fee' where id = (select id from sf_ids where name = 'rate');
    raise exception 'an Editor of the publishing project renamed a locked shared field';
  exception when insufficient_privilege then
    assert sqlerrm = 'Locked — only project Owners and Admins can change this field', sqlerrm;
  end;
end $$;

-- A rule in SF L2 owned by Bea (its Admin) is held to the same rule: on the task SF L1 shares its step is
-- skipped (logged, the run goes on); on the task only in SF L2 it writes. Olive's rule writes on both.
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  rule_id uuid;
begin
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values ((select id from sf_ids where name = 'l2'), 'Rate to 99', true, 'manual',
    jsonb_build_array(jsonb_build_object('type', 'set_field', 'field_id', (select id from sf_ids where name = 'rate2'), 'value', 99),
                      jsonb_build_object('type', 'add_comment', 'body', 'Rate rule went on')))
  returning id into rule_id;
  insert into sf_ids values ('bea_rate_rule', rule_id);
end $$;

do $$
declare
  result jsonb;
begin
  result := public.run_manual_rule((select id from sf_ids where name = 'bea_rate_rule'), (select id from sf_ids where name = 'lts'));
  assert result ->> 'status' = 'succeeded' and result -> 'detail' -> 'actions' -> 0 ->> 'outcome' = 'locked'
    and (result -> 'detail' -> 'actions' -> 0 ->> 'result') like 'Skipped: “Rate” is locked and shared with other projects this task is in%'
    and result -> 'detail' -> 'actions' -> 1 ->> 'outcome' = 'done',
    format('Bea''s rule skips the shared locked value and goes on: %s', result);
end $$;

do $$
declare
  result jsonb;
begin
  result := public.run_manual_rule((select id from sf_ids where name = 'bea_rate_rule'), (select id from sf_ids where name = 'lt_l2'));
  assert result -> 'detail' -> 'actions' -> 0 ->> 'outcome' = 'done', format('Bea''s rule writes on a task only in SF L2: %s', result);
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  rule_id uuid;
  result jsonb;
begin
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values ((select id from sf_ids where name = 'l2'), 'Rate to 99 (Olive)', true, 'manual',
    jsonb_build_array(jsonb_build_object('type', 'set_field', 'field_id', (select id from sf_ids where name = 'rate2'), 'value', 99)))
  returning id into rule_id;
  result := public.run_manual_rule(rule_id, (select id from sf_ids where name = 'lts'));
  assert result -> 'detail' -> 'actions' -> 0 ->> 'outcome' = 'done', format('Olive''s rule writes: %s', result);
end $$;
reset role;
do $$
begin
  assert (select value from public.task_field_values
          where task_id = (select id from sf_ids where name = 'lts') and field_id = (select id from sf_ids where name = 'rate')) = '99',
    'the rule''s value reached SF L1';
  assert (select value from public.task_field_values
          where task_id = (select id from sf_ids where name = 'lt_l2') and field_id = (select id from sf_ids where name = 'rate2')) = '99',
    'Bea''s rule set the value only SF L2 holds';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 51 review fixes. SF L1 gets Gate (single-select, locked) on a recurring task with a subtask.
-- ---------------------------------------------------------------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  l1 uuid := (select id from sf_ids where name = 'l1');
  gate uuid;
  t uuid;
  child uuid;
  r uuid;
begin
  insert into public.custom_fields (project_id, name, field_type, options, sort_order)
  values (l1, 'Gate', 'single_select',
    '[{"id": "g-open", "name": "Open", "color": "green"}, {"id": "g-shut", "name": "Shut", "color": "red"}]', 4096)
  returning id into gate;
  t := public.create_task(l1, (select id from sf_ids where name = 'ls1'), 'Recurring gate');
  child := public.create_subtask(t, 'Gate child', null);
  insert into public.task_field_values (task_id, field_id, value) values (t, gate, '"g-open"'), (child, gate, '"g-shut"');
  update public.tasks set recurrence = '{"freq": "daily", "interval": 1, "ends": {"type": "never"}}', due_on = current_date
  where id = t;
  update public.custom_fields set locked = true where id = gate;
  insert into public.rules (project_id, name, enabled, trigger_type, owner_id, actions)
  values (l1, 'Editor-owned complete', true, 'manual', 'b7c30029-0000-4000-8000-000000000002',
    jsonb_build_array(jsonb_build_object('type', 'complete_task')))
  returning id into r;
  insert into sf_ids values ('gate', gate), ('gate_t', t), ('gate_child', child), ('gate_rule', r);
end $$;

-- A rule whose owner is an Editor completes the recurring task: recurrence is a system path, so the
-- locked values still reach the next occurrence and its subtask (the completion used to fail with the
-- lock's refusal, failing the whole run).
do $$
declare
  gate uuid := (select id from sf_ids where name = 'gate');
  t uuid := (select id from sf_ids where name = 'gate_t');
  result jsonb;
  next_t uuid;
begin
  result := public.run_manual_rule((select id from sf_ids where name = 'gate_rule'), t);
  assert result ->> 'status' = 'succeeded' and result -> 'detail' -> 'actions' -> 0 ->> 'outcome' = 'done',
    format('the Editor-owned rule completes the recurring task: %s', result);
  next_t := (select recurrence_next_id from public.tasks where id = t);
  assert next_t is not null, 'the next occurrence was made';
  assert (select value from public.task_field_values where task_id = next_t and field_id = gate) = '"g-open"',
    'the next occurrence keeps the locked value';
  assert (select v.value from public.tasks c join public.task_field_values v on v.task_id = c.id and v.field_id = gate
          where c.parent_task_id = next_t and c.deleted_at is null) = '"g-shut"',
    'and so does its subtask';
end $$;

-- A rule that runs inside that copy is still held to the lock: the mark names the task, the field, and
-- the rule that completed the task, nothing else. (A forged mark for another rule changes nothing.)
reset role;
do $$
declare
  gate uuid := (select id from sf_ids where name = 'gate');
  t uuid := (select id from sf_ids where name = 'gate_t');
begin
  perform set_config('alhc.rule_id', (select id from sf_ids where name = 'r_editor')::text, true);
  perform set_config('alhc.field_value_copy', t::text || ':' || gate::text || ':' || (select id from sf_ids where name = 'gate_rule')::text, true);
  begin
    update public.task_field_values set value = '"g-shut"' where task_id = t and field_id = gate;
    raise exception 'another rule''s write went through on the copy''s mark';
  exception when insufficient_privilege then
    null;
  end;
  perform set_config('alhc.field_value_copy', '', true);
  perform set_config('alhc.rule_id', '', true);
end $$;

-- Eddie (Editor) can't put the locked field in the field library (he could then share it into a project
-- of his own and change its values there); an unchanged upsert isn't a change, a changed one is refused.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  gate uuid := (select id from sf_ids where name = 'gate');
  t uuid := (select id from sf_ids where name = 'gate_t');
begin
  begin
    update public.custom_fields set in_library = true where id = gate;
    raise exception 'an Editor published a locked field';
  exception when insufficient_privilege then
    assert sqlerrm = 'Locked — only project Owners and Admins can change this field', sqlerrm;
  end;
  assert not (select in_library from public.custom_fields where id = gate), 'Gate isn''t in the library';
  insert into public.task_field_values (task_id, field_id, value) values (t, gate, '"g-open"')
  on conflict (task_id, field_id) do update set value = excluded.value;
  begin
    insert into public.task_field_values (task_id, field_id, value) values (t, gate, '"g-shut"')
    on conflict (task_id, field_id) do update set value = excluded.value;
    raise exception 'an Editor changed a locked value with an upsert';
  exception when insufficient_privilege then
    null;
  end;
  assert (select value from public.task_field_values where task_id = t and field_id = gate) = '"g-open"', 'Gate is unchanged';
end $$;

-- Olive (Owner) publishes it and takes it out again; she also makes Eddie an Admin of SF L2 for the next
-- check.
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  gate uuid := (select id from sf_ids where name = 'gate');
begin
  update public.custom_fields set in_library = true where id = gate;
  assert (select in_library from public.custom_fields where id = gate), 'the Owner publishes a locked field';
  update public.custom_fields set in_library = false where id = gate;
  perform public.update_project_member_role((select id from sf_ids where name = 'l2'), 'b7c30029-0000-4000-8000-000000000002', 'admin');
end $$;

-- Duplicate task: Eddie (Editor of SF L1, Admin of SF L2) gets a copy in both projects, but the locked
-- shared Rate would reach SF L1, where he isn't an Admin, so it's left out — counted once (one field),
-- not once per project. Duplicating the task only SF L2 holds, he keeps it.
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  result jsonb;
  copy_id uuid;
begin
  result := public.duplicate_task((select id from sf_ids where name = 'lts'), '{}'::jsonb);
  copy_id := (result ->> 'task_id')::uuid;
  assert (select count(*) from public.task_projects where task_id = copy_id and deleted_at is null) = 2, 'the copy is in both projects';
  assert not exists (select 1 from public.task_field_values where task_id = copy_id
                     and field_id in ((select id from sf_ids where name = 'rate'), (select id from sf_ids where name = 'rate2'))
                     and value is not null and value <> 'null'::jsonb),
    'the copy has no locked shared value';
  assert (result -> 'skipped' ->> 'fields')::integer = 1, format('left out and counted once: %s', result);
  result := public.duplicate_task((select id from sf_ids where name = 'lt_l2'), '{}'::jsonb);
  assert (select value from public.task_field_values
          where task_id = (result ->> 'task_id')::uuid and field_id = (select id from sf_ids where name = 'rate2')) = '99'
    and (result -> 'skipped' ->> 'fields')::integer = 0, format('a task only SF L2 holds keeps it: %s', result);
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  perform public.update_project_member_role((select id from sf_ids where name = 'l2'), 'b7c30029-0000-4000-8000-000000000002', 'editor');
end $$;
reset role;


-- ---------------------------------------------------------------------------------------------
-- 55 × 51 review fixes (G3).
--   SF K1 (Olive) publishes Spend (number, locked); Eddie is an Editor of SF K1. SF V1 (Olive) publishes
--   Tier, SF V2 (Olive; Bea an Editor) uses it.
-- ---------------------------------------------------------------------------------------------
create temporary table g3_ids (name text primary key, id uuid);
grant all on g3_ids to authenticated, anon;

do $$
begin
  assert (select prosecdef from pg_proc where oid = 'public.locked_field_value_writable(uuid, uuid)'::regprocedure)
    and has_function_privilege('authenticated', 'public.locked_field_value_writable(uuid, uuid)', 'execute')
    and not has_function_privilege('anon', 'public.locked_field_value_writable(uuid, uuid)', 'execute'),
    'locked_field_value_writable: a client definer (pinned in suite 60), not for anon';
  assert not has_function_privilege('authenticated', 'public.rule_owner_writes_locked_value(uuid, uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.library_fill_overwrite_allowed(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.library_link_value_empty(jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.fill_library_values_on_project_restore()', 'execute'),
    'the other review-fix helpers are internal';
  assert exists (select 1 from pg_trigger where tgname = 'projects_zz_library_restore' and tgrelid = 'public.projects'::regclass),
    'a restored project refills its shared values';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  k1 uuid;
  sk1 uuid;
  spend uuid;
  shadow uuid;
  kt uuid;
  kt_other uuid;
  v1 uuid;
  v2 uuid;
  tier uuid;
  tier2 uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF K1') returning id into k1;
  insert into public.sections (project_id, name, sort_order) values (k1, 'K1', 1024) returning id into sk1;
  perform public.add_project_member(k1, 'sf-editor@example.com', 'editor');
  insert into public.custom_fields (project_id, name, field_type, in_library, sort_order)
  values (k1, 'Spend', 'number', true, 1024) returning id into spend;
  insert into public.custom_fields (project_id, name, field_type, sort_order)
  values (k1, 'Shadow', 'number', 2048) returning id into shadow;
  update public.custom_fields set locked = true where id = spend;
  kt := public.create_task(k1, sk1, 'Spend task');
  kt_other := public.create_task(k1, sk1, 'Other spend task');
  insert into public.task_field_values (task_id, field_id, value) values (kt, spend, '100'), (kt_other, spend, '1');

  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF V1') returning id into v1;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF V2') returning id into v2;
  perform public.add_project_member(v1, 'sf-editor@example.com', 'editor');
  perform public.add_project_member(v2, 'sf-bedit@example.com', 'editor');
  insert into public.custom_fields (project_id, name, field_type, options, in_library, sort_order)
  values (v1, 'Tier', 'single_select', '[{"id": "ti-1", "name": "One", "color": "blue"}, {"id": "ti-2", "name": "Two", "color": "red"}]',
    true, 1024)
  returning id into tier;
  tier2 := public.add_library_field(v2, tier);
  insert into g3_ids values ('k1', k1), ('sk1', sk1), ('spend', spend), ('shadow', shadow), ('kt', kt), ('kt_other', kt_other),
    ('v1', v1), ('v2', v2), ('tier', tier), ('tier2', tier2);
end $$;

-- F1: an archived publishing project keeps governing its shared field: frozen until it's unarchived.
-- The library leaves it out, nobody adds it to another project, and the placements' own Editors can't
-- take over (anyone could make a project of their own and rewrite it everywhere).
do $$
begin
  perform public.set_project_archived((select id from g3_ids where name = 'v1'), true);
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000005', false) is not null as ok \gset
do $$
declare
  z uuid;
begin
  assert not exists (select 1 from public.list_field_library() where field_id = (select id from g3_ids where name = 'tier')),
    'the library leaves out a field of an archived project';
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF Z (Otto)') returning id into z;
  insert into g3_ids values ('z', z);
  begin
    perform public.add_library_field(z, (select id from g3_ids where name = 'tier'));
    raise exception 'an archived project''s library field was added to another project';
  exception when no_data_found then
    null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  tier2 uuid := (select id from g3_ids where name = 'tier2');
  s record;
begin
  select * into s from public.project_field_sharing((select id from g3_ids where name = 'v2')) where field_id = tier2;
  assert s.is_shared and not s.definition_editable and not s.definition_manageable, format('frozen for Bea: %s', row_to_json(s));
  begin
    update public.custom_fields set name = 'Hijacked', options = '[{"id": "ti-9", "name": "Nine", "color": "red"}]' where id = tier2;
    raise exception 'a placement''s Editor rewrote a field whose publishing project is archived';
  exception when insufficient_privilege then
    null;
  end;
end $$;

-- A copy made meanwhile (Duplicate project) is a plain copy: nothing new links to a frozen field.
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  result jsonb;
begin
  result := public.duplicate_project((select id from g3_ids where name = 'v2'), 'SF V2 copy', '{}'::jsonb);
  assert (select library_field_id is null from public.custom_fields
          where project_id = (result ->> 'project_id')::uuid and name = 'Tier' and deleted_at is null),
    'the duplicate''s Tier isn''t linked to the archived library field';
  perform public.set_project_archived((select id from g3_ids where name = 'v1'), false);
end $$;
reset role;
do $$
begin
  assert (select bool_and(name = 'Tier' and options -> 0 ->> 'id' = 'ti-1') from public.custom_fields
          where id in ((select id from g3_ids where name = 'tier'), (select id from g3_ids where name = 'tier2'))),
    'the definition didn''t change anywhere';
end $$;

-- Unarchived, the publishing project's Editors change it again (and every placement follows).
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  update public.custom_fields set name = 'Tier level' where id = (select id from g3_ids where name = 'tier');
  assert found, 'Eddie (Editor of SF V1) renames it once SF V1 is unarchived';
end $$;
reset role;
do $$
begin
  assert (select name from public.custom_fields where id = (select id from g3_ids where name = 'tier2')) = 'Tier level',
    'the placement follows';
end $$;

-- F51-1: a value row never moves to another task or field (an Editor could otherwise carry a value past
-- the lock, or out from under it). F51-2 / F7: a field never changes project or type through people's
-- writes. Eddie is an Editor of SF K1; Spend is locked.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  spend uuid := (select id from g3_ids where name = 'spend');
  shadow uuid := (select id from g3_ids where name = 'shadow');
  kt uuid := (select id from g3_ids where name = 'kt');
  kt_other uuid := (select id from g3_ids where name = 'kt_other');
  own uuid;
begin
  begin
    update public.task_field_values set task_id = kt_other where task_id = kt and field_id = spend;
    raise exception 'an Editor moved a locked value to another task';
  exception when insufficient_privilege then
    assert sqlerrm = 'A field value can''t move to another task or field', sqlerrm;
  end;
  insert into public.task_field_values (task_id, field_id, value) values (kt, shadow, '424242');
  begin
    update public.task_field_values set field_id = spend where task_id = kt and field_id = shadow;
    raise exception 'an Editor repointed a value at a locked field';
  exception when insufficient_privilege then
    null;
  end;
  begin
    update public.task_field_values set field_id = shadow where task_id = kt and field_id = spend;
    raise exception 'an Editor moved a locked value out from under the lock';
  exception when insufficient_privilege then
    null;
  end;
  -- The app's upsert (PostgREST sets the key columns to themselves) still works on an unlocked field.
  insert into public.task_field_values (task_id, field_id, value) values (kt, shadow, '5')
  on conflict (task_id, field_id) do update set task_id = excluded.task_id, field_id = excluded.field_id, value = excluded.value;
  assert (select value from public.task_field_values where task_id = kt and field_id = shadow) = '5', 'the upsert works';
  assert (select value from public.task_field_values where task_id = kt and field_id = spend) = '100', 'Spend is unchanged';

  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF K own (Eddie)') returning id into own;
  insert into g3_ids values ('kown', own);
  with x as (insert into public.sections (project_id, name, sort_order) values (own, 'Mine', 1024) returning id) insert into g3_ids select 'skown', id from x;
  begin
    update public.custom_fields set project_id = own where id = spend;
    raise exception 'an Editor moved a locked field to a project of his own';
  exception when check_violation then
    assert sqlerrm = 'A field stays in its project', sqlerrm;
  end;
  begin
    update public.custom_fields set project_id = own where id = shadow;
    raise exception 'a field moved to another project';
  exception when check_violation then
    null;
  end;
  begin
    update public.custom_fields set field_type = 'text' where id = shadow;
    raise exception 'a field changed type';
  exception when check_violation then
    assert sqlerrm = 'A field''s type can''t be changed once it''s created', sqlerrm;
  end;
  assert (select project_id = (select id from g3_ids where name = 'k1') and locked from public.custom_fields where id = spend),
    'Spend stays in SF K1, locked';
end $$;

-- F2 / F51-3: the own-project path. Eddie adds Spend to his own project and the task to it; he's its
-- Owner, but the value would reach SF K1 too, where he's only an Editor: refused, directly and by his rule.
do $$
declare
  spend uuid := (select id from g3_ids where name = 'spend');
  own uuid := (select id from g3_ids where name = 'kown');
  kt uuid := (select id from g3_ids where name = 'kt');
  placement uuid;
begin
  placement := public.add_library_field(own, spend);
  insert into g3_ids values ('spend_own', placement);
  assert (select locked from public.custom_fields where id = placement), 'the placement arrives locked';
  insert into public.task_projects (task_id, project_id, section_id) values (kt, own, (select id from g3_ids where name = 'skown'));
  assert (select value from public.task_field_values where task_id = kt and field_id = placement) = '100',
    'the task brings its value along';
  assert not public.locked_field_value_writable(kt, placement), 'Eddie can''t change it';
  begin
    insert into public.task_field_values (task_id, field_id, value) values (kt, placement, '999')
    on conflict (task_id, field_id) do update set value = excluded.value;
    raise exception 'the own-project path changed a locked value';
  exception when insufficient_privilege then
    assert sqlerrm = 'Locked — only Owners and Admins of every project this task is in can change this shared field', sqlerrm;
  end;
end $$;

do $$
declare
  rule_id uuid;
  result jsonb;
begin
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values ((select id from g3_ids where name = 'kown'), 'Spend to 999', true, 'manual',
    jsonb_build_array(jsonb_build_object('type', 'set_field', 'field_id', (select id from g3_ids where name = 'spend_own'), 'value', 999)))
  returning id into rule_id;
  result := public.run_manual_rule(rule_id, (select id from g3_ids where name = 'kt'));
  assert result ->> 'status' = 'succeeded' and result -> 'detail' -> 'actions' -> 0 ->> 'outcome' = 'locked',
    format('his rule''s step is skipped: %s', result);
end $$;

-- The bulk bar skips it with the reason.
do $$
declare
  result jsonb;
begin
  result := public.bulk_update_tasks(array[(select id from g3_ids where name = 'kt')],
    jsonb_build_object('action', 'set_field', 'field_id', (select id from g3_ids where name = 'spend_own'), 'value', 7));
  assert jsonb_array_length(result -> 'skipped') = 1
    and result -> 'skipped' -> 0 ->> 'reason' = 'Locked — only Owners and Admins of every project this task is in can change this shared field',
    format('bulk skips it: %s', result);
end $$;

-- The join path: Eddie takes the task out of SF K1 (it stays in his project), changes Spend where only
-- his project holds it, and adds the task back to SF K1: refused, since SF K1's own value would change.
do $$
declare
  k1 uuid := (select id from g3_ids where name = 'k1');
  kt uuid := (select id from g3_ids where name = 'kt');
  placement uuid := (select id from g3_ids where name = 'spend_own');
begin
  update public.task_projects set deleted_at = now() where task_id = kt and project_id = k1;
  update public.task_field_values set value = '4242' where task_id = kt and field_id = placement;
  assert found, 'with only his project holding the task, its Owner changes the value';
  begin
    update public.task_projects set deleted_at = null where task_id = kt and project_id = k1;
    raise exception 'adding the task back carried a locked value past the lock';
  exception when insufficient_privilege then
    assert sqlerrm like 'Locked — a locked shared field already has a different value for this task%', sqlerrm;
  end;
  -- With the value as SF K1 has it, the task goes back.
  update public.task_field_values set value = '100' where task_id = kt and field_id = placement;
  update public.task_projects set deleted_at = null where task_id = kt and project_id = k1;
  assert found, 'back in SF K1 once nothing changes there';
  -- Olive joins his project as an Admin: an Owner / Admin of every project that holds the task writes it.
  perform public.add_project_member((select id from g3_ids where name = 'kown'), 'sf-owner@example.com', 'admin');
end $$;
reset role;
do $$
begin
  assert (select value from public.task_field_values
          where task_id = (select id from g3_ids where name = 'kt') and field_id = (select id from g3_ids where name = 'spend')) = '100',
    'SF K1''s locked value never changed';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  assert public.locked_field_value_writable((select id from g3_ids where name = 'kt'), (select id from g3_ids where name = 'spend'));
  insert into public.task_field_values (task_id, field_id, value)
  values ((select id from g3_ids where name = 'kt'), (select id from g3_ids where name = 'spend'), '150')
  on conflict (task_id, field_id) do update set value = excluded.value;
  assert (select value from public.task_field_values
          where task_id = (select id from g3_ids where name = 'kt') and field_id = (select id from g3_ids where name = 'spend_own')) = '150',
    'Olive (Owner of SF K1, Admin of his project) changes it, and it reaches his project';
end $$;

-- F51-4 / F6: bringing back a removed field of a locked group is for its project's Owners and Admins,
-- and it comes back with the group's newest values (also when its whole project comes back). SF K2
-- (Olive; Eddie an Editor) uses Spend; KT2 is in SF K1 and SF K2.
do $$
declare
  k2 uuid;
  sk2 uuid;
  kt2 uuid;
  placement uuid;
begin
  update public.custom_fields set locked = false where id = (select id from g3_ids where name = 'spend');
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF K2') returning id into k2;
  insert into public.sections (project_id, name, sort_order) values (k2, 'K2', 1024) returning id into sk2;
  perform public.add_project_member(k2, 'sf-editor@example.com', 'editor');
  placement := public.add_library_field(k2, (select id from g3_ids where name = 'spend'));
  kt2 := public.create_task((select id from g3_ids where name = 'k1'), (select id from g3_ids where name = 'sk1'), 'Spend two');
  insert into public.task_projects (task_id, project_id, section_id) values (kt2, k2, sk2);
  insert into public.task_field_values (task_id, field_id, value) values (kt2, placement, '5');
  insert into g3_ids values ('k2', k2), ('spend_k2', placement), ('kt2', kt2);
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  update public.custom_fields set deleted_at = now() where id = (select id from g3_ids where name = 'spend_k2');
  assert found, 'Eddie removes the unlocked field from SF K2';
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  update public.custom_fields set locked = true where id = (select id from g3_ids where name = 'spend');
  update public.task_field_values set value = '6'
  where task_id = (select id from g3_ids where name = 'kt2') and field_id = (select id from g3_ids where name = 'spend');
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  begin
    update public.custom_fields set deleted_at = null where id = (select id from g3_ids where name = 'spend_k2');
    raise exception 'an Editor brought back a field of a locked group';
  exception when insufficient_privilege then
    assert sqlerrm = 'Locked — only project Owners and Admins can change this field', sqlerrm;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  placement uuid := (select id from g3_ids where name = 'spend_k2');
  kt2 uuid := (select id from g3_ids where name = 'kt2');
begin
  update public.custom_fields set deleted_at = null where id = placement;
  assert (select locked and deleted_at is null from public.custom_fields where id = placement), 'Olive brings it back, locked';
  assert (select value from public.task_field_values where task_id = kt2 and field_id = placement) = '6',
    'with the value written while it was removed';
end $$;

-- The whole project: removed, a value written meanwhile, restored.
do $$
declare
  kt2 uuid := (select id from g3_ids where name = 'kt2');
begin
  update public.projects set deleted_at = now() where id = (select id from g3_ids where name = 'k2');
  update public.task_field_values set value = '7' where task_id = kt2 and field_id = (select id from g3_ids where name = 'spend');
end $$;
reset role;
do $$
begin
  assert (select value from public.task_field_values
          where task_id = (select id from g3_ids where name = 'kt2') and field_id = (select id from g3_ids where name = 'spend_k2')) = '6',
    'a removed project gets no copies';
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  update public.projects set deleted_at = null where id = (select id from g3_ids where name = 'k2');
  assert (select value from public.task_field_values
          where task_id = (select id from g3_ids where name = 'kt2') and field_id = (select id from g3_ids where name = 'spend_k2')) = '7',
    'a restored project gets the group''s newest value';
end $$;

-- F4 / F5: linking existing copies. A select field the copy engine made with a project from a template
-- isn't linked to its template sibling that was published later (its option ids match, but it was
-- never chosen from the library). An unticked checkbox (false) is a value: true on one side and false
-- on the other is a conflict, both kept.
do $$
declare
  src uuid;
  tmpl uuid;
  t1 uuid;
  t2 uuid;
  b1 uuid;
  b2 uuid;
  t uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF TPL') returning id into src;
  insert into public.custom_fields (project_id, name, field_type, options, sort_order)
  values (src, 'Phase', 'single_select', '[{"id": "ph-1", "name": "One", "color": "blue"}, {"id": "ph-2", "name": "Two", "color": "red"}]', 1024);
  tmpl := public.save_project_as_template(src, 'SF phases', null, null, null);
  t1 := (public.create_project_from_template(tmpl, 'SF from tpl 1', current_date) ->> 'project_id')::uuid;
  update public.custom_fields set in_library = true where project_id = t1 and name = 'Phase';
  t2 := (public.create_project_from_template(tmpl, 'SF from tpl 2', current_date) ->> 'project_id')::uuid;
  insert into g3_ids values ('tpl1', t1), ('tpl2', t2);

  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF B1') returning id into b1;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF B2') returning id into b2;
  with x as (insert into public.custom_fields (project_id, name, field_type, description, in_library)
    values (b1, 'Approved', 'boolean', 'Client signed off', true) returning id) insert into g3_ids select 's_approved', id from x;
  with x as (insert into public.custom_fields (project_id, name, field_type, description)
    values (b2, 'Approved', 'boolean', 'Client signed off') returning id) insert into g3_ids select 'c_approved', id from x;
  t := public.create_task(b1, null, 'Signed off?');
  insert into public.task_projects (task_id, project_id) values (t, b2);
  insert into public.task_field_values (task_id, field_id, value) values
    (t, (select id from g3_ids where name = 's_approved'), 'true'), (t, (select id from g3_ids where name = 'c_approved'), 'false');
  insert into g3_ids values ('b1', b1), ('b2', b2), ('vb', t);
end $$;
reset role;
do $$
declare
  vb uuid := (select id from g3_ids where name = 'vb');
  t1_phase uuid := (select id from public.custom_fields where project_id = (select id from g3_ids where name = 'tpl1') and name = 'Phase');
  t2_phase uuid := (select id from public.custom_fields where project_id = (select id from g3_ids where name = 'tpl2') and name = 'Phase');
begin
  -- Each templated project and its fields were made together; the second one later than the first.
  update public.projects set created_at = now() - interval '10 days' where id = (select id from g3_ids where name = 'tpl1');
  update public.custom_fields set created_at = now() - interval '10 days' where id = t1_phase;
  update public.projects set created_at = now() - interval '5 days' where id = (select id from g3_ids where name = 'tpl2');
  update public.custom_fields set created_at = now() - interval '5 days' where id = t2_phase;
  update public.projects set created_at = now() - interval '30 days' where id in (select id from g3_ids where name in ('b1', 'b2'));
  update public.custom_fields set created_at = now() - interval '10 days' where id = (select id from g3_ids where name = 's_approved');
  update public.custom_fields set created_at = now() - interval '5 days' where id = (select id from g3_ids where name = 'c_approved');
  perform public.link_library_field_copies();
  assert (select library_field_id is null from public.custom_fields where id = t2_phase),
    'a templated project''s field isn''t linked to its published template sibling';
  assert (select library_field_id from public.custom_fields where id = (select id from g3_ids where name = 'c_approved'))
    = (select id from g3_ids where name = 's_approved'), 'the checkbox copy is linked';
  assert (select value from public.task_field_values where task_id = vb and field_id = (select id from g3_ids where name = 'c_approved')) = 'false'
    and (select value from public.task_field_values where task_id = vb and field_id = (select id from g3_ids where name = 's_approved')) = 'true',
    'an unticked checkbox isn''t overwritten';
  assert (select count(*) from public.library_field_link_conflicts where task_id = vb and value = 'false' and other_value = 'true') = 1,
    'true against false is recorded as a conflict';
end $$;
reset role;

-- =================================================================================================
-- Track T4: 55b no home project
-- =================================================================================================

reset role;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset

-- 55b. No home project.
--   b7d40029…01 b7t4-owner@example.com   owner of T4 A, T4 B, T4 C, T4 D
--   b7d40029…02 b7t4-editor@example.com  Editor of T4 A, T4 B, T4 D (not T4 C)
--   b7d40029…03 b7t4-viewer@example.com  Viewer of T4 B only

insert into public.allowed_emails (email, note) values
  ('b7t4-owner@example.com', 'oct 29 batch 7 t4'),
  ('b7t4-editor@example.com', 'oct 29 batch 7 t4'),
  ('b7t4-viewer@example.com', 'oct 29 batch 7 t4');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b7d40029-0000-4000-8000-000000000001', 'b7t4-owner@example.com', now(), '{"full_name":"Oona Owner"}'),
  ('b7d40029-0000-4000-8000-000000000002', 'b7t4-editor@example.com', now(), '{"full_name":"Eddie Editor"}'),
  ('b7d40029-0000-4000-8000-000000000003', 'b7t4-viewer@example.com', now(), '{"full_name":"Vera Viewer"}');

create temporary table b7t4_ids (name text primary key, id uuid);
grant all on b7t4_ids to authenticated, anon;

-- ---------------------------------------------------------------------------------------------
-- Setup: A ("A-{n}"), B ("B-{n}"), C ("C-{n}", the editor can't open it), D (numbers only one
-- section's tasks and renumbers on move).
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7d40029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  a uuid;
  b uuid;
  c uuid;
  d uuid;
  sa uuid;
  sd uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'T4 A') returning id into a;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'T4 B') returning id into b;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'T4 C') returning id into c;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'T4 D') returning id into d;
  insert into public.sections (project_id, name, sort_order) values (a, 'Intake', 1024) returning id into sa;
  insert into public.sections (project_id, name, sort_order) values (d, 'Numbered', 1024) returning id into sd;
  insert into b7t4_ids values ('a', a), ('b', b), ('c', c), ('d', d), ('sa', sa), ('sd', sd);
  perform public.add_project_member(a, 'b7t4-editor@example.com', 'editor');
  perform public.add_project_member(b, 'b7t4-editor@example.com', 'editor');
  perform public.add_project_member(d, 'b7t4-editor@example.com', 'editor');
  perform public.add_project_member(b, 'b7t4-viewer@example.com', 'viewer');
  perform public.apply_task_numbering(a, '{"enabled": true, "number_scope": "all_tasks", "template": "A-{n}"}'::jsonb, 'save');
  perform public.apply_task_numbering(b, '{"enabled": true, "number_scope": "all_tasks", "template": "B-{n}"}'::jsonb, 'save');
  perform public.apply_task_numbering(c, '{"enabled": true, "number_scope": "all_tasks", "template": "C-{n}"}'::jsonb, 'save');
  perform public.apply_task_numbering(d, jsonb_build_object(
    'enabled', true, 'number_scope', 'sections', 'section_ids', jsonb_build_array(sd),
    'template', 'D-{n}', 'renumber_on_move', true), 'save');
end $$;

-- The editor makes T in A (A-1) and, a moment later, adds it to B (B-1); the owner then adds it to C
-- (C-1), which the editor can't open. U (A-2) is in A and C only. A subtask under T. Each step is its own
-- transaction, so the memberships' times (the stable order) differ.
select set_config('request.jwt.claim.sub', 'b7d40029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b7t4_ids where name = 'a');
  t uuid;
  u uuid;
begin
  t := public.create_task(a, (select id from b7t4_ids where name = 'sa'), 'Brochure');
  u := public.create_task(a, (select id from b7t4_ids where name = 'sa'), 'Banner');
  insert into b7t4_ids values ('t', t), ('u', u);
end $$;

do $$
declare
  t uuid := (select id from b7t4_ids where name = 't');
  b uuid := (select id from b7t4_ids where name = 'b');
  stamped timestamptz;
begin
  -- A client can't choose a membership's time (the stable order reads it): the database stamps it.
  insert into public.task_projects (task_id, project_id, sort_order, created_at) values (t, b, 1024, '2001-01-01');
  select created_at into stamped from public.task_projects where task_id = t and project_id = b;
  assert stamped >= now(), 'stamped by the database';
  update public.task_projects set created_at = '2001-01-01' where task_id = t and project_id = b;
  assert (select created_at from public.task_projects where task_id = t and project_id = b) = stamped, 'and kept';
  insert into b7t4_ids values ('s', public.create_subtask(t, 'Proof', null));
end $$;

select set_config('request.jwt.claim.sub', 'b7d40029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  c uuid := (select id from b7t4_ids where name = 'c');
begin
  insert into public.task_projects (task_id, project_id, sort_order)
  values ((select id from b7t4_ids where name = 't'), c, 1024);
  insert into public.task_projects (task_id, project_id, sort_order)
  values ((select id from b7t4_ids where name = 'u'), c, 2048);
  assert (select req_label from public.task_project_numbers
          where task_id = (select id from b7t4_ids where name = 't') and project_id = c) = 'C-1', 'C numbers T';
end $$;

-- ---------------------------------------------------------------------------------------------
-- The numbers helper: every project the caller can read, in the order the task was added to them,
-- with that project's number — never a project (or number) the caller can't read.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  t uuid := (select id from b7t4_ids where name = 't');
  list jsonb := public.task_project_labels(array[t]) -> t::text;
begin
  assert jsonb_array_length(list) = 3, format('the owner reads all three: %s', list);
  assert (select jsonb_agg(e ->> 'label' order by n) from jsonb_array_elements(list) with ordinality x(e, n))
         = '["A-1", "B-1", "C-1"]'::jsonb, format('stable order: %s', list);
  assert list -> 0 ->> 'project_name' = 'T4 A' and (list -> 0 ->> 'wrap')::boolean, 'name and bracket setting';
end $$;

select set_config('request.jwt.claim.sub', 'b7d40029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b7t4_ids where name = 't');
  s uuid := (select id from b7t4_ids where name = 's');
  c uuid := (select id from b7t4_ids where name = 'c');
  all_lists jsonb := public.task_project_labels(array[t, s, null]);
  list jsonb := all_lists -> t::text;
  sub jsonb := all_lists -> s::text;
  mine uuid := public.create_private_task('Mine only');
begin
  assert (select jsonb_agg(e ->> 'label' order by n) from jsonb_array_elements(list) with ordinality x(e, n))
         = '["A-1", "B-1"]'::jsonb, format('the editor never sees C or C-1: %s', list);
  assert not (list::text like '%' || c::text || '%'), 'not even its id';
  assert (select jsonb_agg(e ->> 'label' order by n) from jsonb_array_elements(sub) with ordinality x(e, n))
         = '["A-1.1", "B-1.1"]'::jsonb, format('a subtask carries its path in each project: %s', sub);
  assert not (public.task_project_labels(array[mine]) ? mine::text), 'a private task has no projects';
end $$;

select set_config('request.jwt.claim.sub', 'b7d40029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b7t4_ids where name = 't');
  u uuid := (select id from b7t4_ids where name = 'u');
  list jsonb := public.task_project_labels(array[t, u]);
begin
  assert (select jsonb_agg(e ->> 'label' order by n) from jsonb_array_elements(list -> t::text) with ordinality x(e, n))
         = '["B-1"]'::jsonb, format('a Viewer of B reads only B-1: %s', list);
  assert not (list ? u::text), 'a task in no project you can open has no entry';
  -- Search labels with the first project the caller can read.
  assert (select s.home_project_id from public.search_tasks('Brochure', 10) s where s.id = t)
         = (select id from b7t4_ids where name = 'b'), 'search: the only readable project';
  -- Number privacy in search: T's own number columns are A's (its internal pointer), and this Viewer
  -- can't open A, so searching A's numbers finds neither T nor its subtask; B's number does.
  assert not exists (select 1 from public.search_tasks('A-1', 10) x where x.id in (t, (select id from b7t4_ids where name = 's'))),
    'search never matches a number of a project you can''t open';
  assert not exists (select 1 from public.search_tasks('A-1.1', 10) x where x.id = (select id from b7t4_ids where name = 's')),
    'nor a subtask''s path there';
  assert exists (select 1 from public.search_tasks('B-1', 10) x where x.id = t), 'B''s number finds it';
  assert not exists (
    select 1 from public.filter_project_tasks((select id from b7t4_ids where name = 'b'), '{"text": "A-1"}'::jsonb, 'UTC') f
    where f.task_id = t
  ), 'a view''s text filter in B neither';
  assert exists (
    select 1 from public.filter_project_tasks((select id from b7t4_ids where name = 'b'), '{"text": "B-1"}'::jsonb, 'UTC') f
    where f.task_id = t
  ), 'B''s number does';
end $$;

select set_config('request.jwt.claim.sub', 'b7d40029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b7t4_ids where name = 't');
begin
  -- The owner opens A: its numbers still find the task.
  assert exists (select 1 from public.search_tasks('A-1', 10) x where x.id = t), 'the owner finds A-1';
  assert exists (select 1 from public.search_tasks('A-1.1', 10) x where x.id = (select id from b7t4_ids where name = 's')),
    'and the subtask''s path';
  assert exists (
    select 1 from public.filter_project_tasks((select id from b7t4_ids where name = 'b'), '{"text": "A-1"}'::jsonb, 'UTC') f
    where f.task_id = t
  ), 'also from B''s view';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Email recipients: the first project (stable rule) they're in, and the numbers they can read.
-- ---------------------------------------------------------------------------------------------

reset role;
do $$
declare
  t uuid := (select id from b7t4_ids where name = 't');
  a uuid := (select id from b7t4_ids where name = 'a');
  b uuid := (select id from b7t4_ids where name = 'b');
  e_editor uuid;
  e_viewer uuid;
  e_address uuid;
  ctx jsonb;
begin
  assert public.comment_email_project('b7d40029-0000-4000-8000-000000000002', t) = a, 'editor: A, the first';
  assert public.comment_email_project('b7d40029-0000-4000-8000-000000000003', t) = b, 'viewer: B, the one they read';
  assert public.task_first_project(t) = a, 'no recipient: the first project';
  insert into public.email_outbox (task_id, to_email, to_profile_id, template, payload)
  values (t, 'b7t4-editor@example.com', 'b7d40029-0000-4000-8000-000000000002', 'custom', '{"kind": "rule"}')
  returning id into e_editor;
  insert into public.email_outbox (task_id, to_email, to_profile_id, template, payload)
  values (t, 'b7t4-viewer@example.com', 'b7d40029-0000-4000-8000-000000000003', 'custom', '{"kind": "rule"}')
  returning id into e_viewer;
  insert into public.email_outbox (task_id, to_email, template, payload)
  values (t, 'someone@elsewhere.example', 'custom', '{"kind": "rule"}')
  returning id into e_address;
  perform set_config('request.jwt.claim.sub', 'ffffffff-0000-4000-8000-0000000000aa', true);
  ctx := public.email_design_context(e_editor);
  assert current_setting('request.jwt.claim.sub', true) = 'ffffffff-0000-4000-8000-0000000000aa', 'the caller is put back';
  assert (select jsonb_agg(e ->> 'label' order by n) from jsonb_array_elements(ctx -> 'values' -> 'task_numbers') with ordinality x(e, n))
         = '["A-1", "B-1"]'::jsonb, format('editor: the numbers they can read: %s', ctx -> 'values');
  assert ctx -> 'values' ->> 'request_number' = 'A-1', 'their first number';
  assert ctx ->> 'project_id' = a::text, 'linked to their first project';
  ctx := public.email_design_context(e_viewer);
  assert (select jsonb_agg(e ->> 'label' order by n) from jsonb_array_elements(ctx -> 'values' -> 'task_numbers') with ordinality x(e, n))
         = '["B-1"]'::jsonb, format('viewer: B-1 only: %s', ctx -> 'values');
  assert ctx -> 'values' ->> 'request_number' = 'B-1' and ctx ->> 'project_id' = b::text, 'viewer: B';
  ctx := public.email_design_context(e_address);
  assert ctx -> 'values' -> 'task_numbers' = 'null'::jsonb, 'an address: the label it was queued with';
  assert ctx ->> 'project_id' = a::text, 'an address: the first project';
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Removing a task from a project removes it there only. The pointer's project can go: the pointer
-- moves to the next project (stable rule) and every number stays. The last project can't go.
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7d40029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b7t4_ids where name = 't');
  a uuid := (select id from b7t4_ids where name = 'a');
  b uuid := (select id from b7t4_ids where name = 'b');
  list jsonb;
begin
  -- Removing B (not the first) keeps A; nothing moves.
  update public.task_projects set deleted_at = now() where task_id = t and project_id = b;
  assert (select home_project_id from public.tasks where id = t) = a, 'pointer stays on A';
  assert exists (select 1 from public.task_projects where task_id = t and project_id = a and deleted_at is null), 'still in A';
  assert exists (select 1 from public.tasks where id = t and deleted_at is null), 'the task stays';
  -- Back in B: the same number (kept, never reissued), and B is now the last project it was added to.
  update public.task_projects set deleted_at = null where task_id = t and project_id = b;
  assert (select req_label from public.task_project_numbers where task_id = t and project_id = b) = 'B-1', 'B-1 kept';
  list := public.task_project_labels(array[t]) -> t::text;
  assert (select jsonb_agg(e ->> 'label' order by n) from jsonb_array_elements(list) with ordinality x(e, n))
         = '["A-1", "B-1"]'::jsonb, format('order: %s', list);
end $$;

do $$
declare
  t uuid := (select id from b7t4_ids where name = 't');
  u uuid := (select id from b7t4_ids where name = 'u');
  s uuid := (select id from b7t4_ids where name = 's');
  a uuid := (select id from b7t4_ids where name = 'a');
  b uuid := (select id from b7t4_ids where name = 'b');
  c uuid := (select id from b7t4_ids where name = 'c');
  list jsonb;
begin
  -- Removing A (the pointer's project) is allowed. The pointer moves to the next project the task was
  -- added to — C (B was added back later), which this editor can't even open — and every number stays.
  update public.task_projects set deleted_at = now() where task_id = t and project_id = a;
  assert (select home_project_id from public.tasks where id = t) = c, 'pointer moved to C';
  assert (select req_label from public.tasks where id = t) = 'C-1', 'C''s number became the task''s own';
  assert (select home_project_id from public.tasks where id = s) = c, 'its subtask follows';
  assert (select req_label from public.tasks where id = s) = 'C-1.1', 'and reads C''s path';
  list := public.task_project_labels(array[t]) -> t::text;
  assert (select jsonb_agg(e ->> 'label' order by n) from jsonb_array_elements(list) with ordinality x(e, n))
         = '["B-1"]'::jsonb, format('the editor still sees only B: %s', list);

  -- U is in A and in C (which the editor can't open): A isn't its last project.
  update public.task_projects set deleted_at = now() where task_id = u and project_id = a;
  assert (select count(*) from public.task_projects where task_id = u and deleted_at is null) = 0,
    'the editor no longer sees any of U''s projects';
end $$;

reset role;
do $$
declare
  t uuid := (select id from b7t4_ids where name = 't');
  a uuid := (select id from b7t4_ids where name = 'a');
  b uuid := (select id from b7t4_ids where name = 'b');
  c uuid := (select id from b7t4_ids where name = 'c');
begin
  assert (select req_label from public.task_project_numbers where task_id = t and project_id = a) = 'A-1', 'A-1 kept';
  assert (select req_label from public.task_project_numbers where task_id = t and project_id = b) = 'B-1', 'B-1 kept';
  assert (select req_label from public.task_project_numbers where task_id = t and project_id = c) = 'C-1', 'C-1 kept';
  assert (select last_number from public.request_sequences where project_id = a) = 2, 'A issued two numbers';
  assert (select last_number from public.request_sequences where project_id = b) = 1, 'B issued one';
  assert (select last_number from public.request_sequences where project_id = c) = 2, 'C issued two, nothing renumbered';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7d40029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  u uuid := (select id from b7t4_ids where name = 'u');
  c uuid := (select id from b7t4_ids where name = 'c');
  state text;
  msg text;
  detail text;
begin
  assert (select home_project_id from public.tasks where id = u) = c, 'U''s pointer moved to C';
  assert (select req_label from public.tasks where id = u) = 'C-2', 'and C''s number came along';
  -- C is U's last project.
  begin
    update public.task_projects set deleted_at = now() where task_id = u and project_id = c;
    raise exception 'removing the last project should have failed';
  exception when check_violation then
    get stacked diagnostics state = returned_sqlstate, msg = message_text, detail = pg_exception_detail;
  end;
  assert msg = 'This is the task’s only project. Add it to another project first, or move the task to the Trash.', msg;
  assert detail = 'last_project', detail;
  assert exists (select 1 from public.task_projects where task_id = u and project_id = c and deleted_at is null), 'still in C';
  -- Deleting the task instead works, and it comes back.
  update public.tasks set deleted_at = now() where id = u;
  perform public.restore_task(u);
  assert exists (select 1 from public.tasks where id = u and deleted_at is null), 'restored';
  assert exists (select 1 from public.task_projects where task_id = u and project_id = c and deleted_at is null), 'in C';
end $$;

-- The rule action Remove from this project on the pointer's project: the database moves the pointer.
select set_config('request.jwt.claim.sub', 'b7d40029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  insert into b7t4_ids values ('w', public.create_task((select id from b7t4_ids where name = 'a'),
    (select id from b7t4_ids where name = 'sa'), 'Flyer'));
end $$;
do $$
declare
  a uuid := (select id from b7t4_ids where name = 'a');
  b uuid := (select id from b7t4_ids where name = 'b');
  w uuid := (select id from b7t4_ids where name = 'w');
  r uuid;
begin
  insert into public.task_projects (task_id, project_id, sort_order) values (w, b, 1024);
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values (a, 'Leave A', true, 'manual', '[{"type": "remove_from_project"}]') returning id into r;
  perform public.run_manual_rule(r, w);
  assert not exists (select 1 from public.task_projects where task_id = w and project_id = a and deleted_at is null), 'out of A';
  assert (select home_project_id from public.tasks where id = w) = b, 'pointer on B';
  update public.rules set enabled = false where id = r;
end $$;

-- Projects a task joins in one transaction keep that order (the membership times are the clock's), so
-- the project it was created in stays first — also for a duplicate made of it.
do $$
declare
  a uuid := (select id from b7t4_ids where name = 'a');
  b uuid := (select id from b7t4_ids where name = 'b');
  v uuid;
  copy uuid;
  list jsonb;
begin
  v := public.create_task(a, (select id from b7t4_ids where name = 'sa'), 'Tie');
  insert into public.task_projects (task_id, project_id, sort_order) values (v, b, 1024);
  list := public.task_project_labels(array[v]) -> v::text;
  assert list -> 0 ->> 'project_id' = a::text and list -> 1 ->> 'project_id' = b::text, format('A, then B: %s', list);
  copy := (public.duplicate_task(v, '{}'::jsonb) ->> 'task_id')::uuid;
  list := public.task_project_labels(array[copy]) -> copy::text;
  assert list -> 0 ->> 'project_id' = a::text and list -> 1 ->> 'project_id' = b::text, format('the copy too: %s', list);
  assert (select home_project_id from public.tasks where id = copy) = a, 'its pointer is its first project';
end $$;

-- ---------------------------------------------------------------------------------------------
-- The pointer moving never renumbers, even into a project that renumbers on move.
-- ---------------------------------------------------------------------------------------------

do $$
begin
  insert into b7t4_ids values ('x', public.create_task((select id from b7t4_ids where name = 'a'),
    (select id from b7t4_ids where name = 'sa'), 'Poster'));
end $$;
do $$
declare
  a uuid := (select id from b7t4_ids where name = 'a');
  d uuid := (select id from b7t4_ids where name = 'd');
  x uuid := (select id from b7t4_ids where name = 'x');
  label text := (select req_label from public.tasks where id = x);
  d_last bigint;
begin
  insert into public.task_projects (task_id, project_id, sort_order) values (x, d, 1024);
  assert not exists (select 1 from public.task_project_numbers where task_id = x and project_id = d), 'D doesn''t number it';
  select last_number into d_last from public.request_sequences where project_id = d;
  update public.task_projects set deleted_at = now() where task_id = x and project_id = a;
  assert (select home_project_id from public.tasks where id = x) = d, 'pointer on D';
  assert (select last_number from public.request_sequences where project_id = d) = d_last, 'D issued no number';
  assert (select req_label from public.tasks where id = x) = label, 'it keeps its number';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Defaults and links follow the stable rule: dependency shifting follows the first project, restoring needs
-- one active project, subtask parent candidates and blockers name the first readable project.
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'b7d40029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b7t4_ids where name = 'a');
  b uuid := (select id from b7t4_ids where name = 'b');
  c uuid := (select id from b7t4_ids where name = 'c');
  t uuid := (select id from b7t4_ids where name = 't');
begin
  -- T is in C, then B (it was added back to B later): C, its first project, decides.
  update public.projects set dependency_shift = 'off' where id in (a, b, c);
  assert public.dependency_shift_mode(array[t]) = 'off', 'C is off';
  update public.projects set dependency_shift = 'ask' where id = b;
  assert public.dependency_shift_mode(array[t]) = 'off', 'B doesn''t decide';
  update public.projects set dependency_shift = 'auto' where id = c;
  assert public.dependency_shift_mode(array[t]) = 'auto', 'C does';
  update public.projects set dependency_shift = 'ask' where id in (a, b, c);
  insert into b7t4_ids values ('y', public.create_task(c, null, 'Sticker'));
end $$;
do $$
declare
  y uuid := (select id from b7t4_ids where name = 'y');
begin
  insert into public.task_projects (task_id, project_id, sort_order) values (y, (select id from b7t4_ids where name = 'b'), 1024);
  update public.tasks set deleted_at = now() where id = y;
end $$;

-- Restoring: the pointer's project deleted, another one active → fine; every project deleted → refused.
reset role;
update public.projects set deleted_at = now() where id = (select id from b7t4_ids where name = 'c');
set role authenticated;
do $$
declare
  y uuid := (select id from b7t4_ids where name = 'y');
begin
  perform public.restore_task(y);
  assert exists (select 1 from public.tasks where id = y and deleted_at is null), 'restored through B';
  update public.tasks set deleted_at = now() where id = y;
end $$;
reset role;
update public.projects set deleted_at = now() where id = (select id from b7t4_ids where name = 'b');
set role authenticated;
do $$
declare
  y uuid := (select id from b7t4_ids where name = 'y');
  msg text;
begin
  begin
    perform public.restore_task(y);
    raise exception 'restoring with no active project should have failed';
  exception when check_violation then
    get stacked diagnostics msg = message_text;
  end;
  assert msg = 'This task''s projects are deleted', msg;
end $$;
reset role;
update public.projects set deleted_at = null where id in (select id from b7t4_ids where name in ('b', 'c'));
set role authenticated;

select set_config('request.jwt.claim.sub', 'b7d40029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b7t4_ids where name = 'a');
  b uuid := (select id from b7t4_ids where name = 'b');
  t uuid := (select id from b7t4_ids where name = 't');
  z uuid;
  blockers jsonb;
begin
  -- T is in C (its first project now, which the editor can't open) and B: the editor's link project is B.
  z := public.create_task(a, (select id from b7t4_ids where name = 'sa'), 'Card');
  perform public.set_task_dependency(t, z, 'finish_to_start', 0);
  blockers := public.task_open_blockers(z);
  assert blockers -> 'blockers' -> 0 ->> 'home_project_id' = b::text, format('blocker linked to B: %s', blockers);
  assert (select c.home_project_id from public.subtask_parent_candidates(z, 'Brochure', 10) c where c.id = t) = b,
    'parent candidate labelled with B';
end $$;

reset role;

-- ---------------------------------------------------------------------------------------------
-- Two removals at the same time (a second session through dblink, where the test database has it):
-- a task's last two projects removed at once. The guard locks the task, so the second removal waits for
-- the first, then sees it and is refused — the task never ends up in no project, and the first removal
-- stays removed (the pointer's move doesn't write the other membership back). Both orders: the first
-- removal on the pointer's project, and on the other one.
-- ---------------------------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'dblink') then
    create extension if not exists dblink schema extensions;
  end if;
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7d40029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  insert into b7t4_ids values
    ('race1', public.create_task((select id from b7t4_ids where name = 'a'), (select id from b7t4_ids where name = 'sa'), 'Race one')),
    ('race2', public.create_task((select id from b7t4_ids where name = 'a'), (select id from b7t4_ids where name = 'sa'), 'Race two'));
end $$;
do $$
begin
  insert into public.task_projects (task_id, project_id, sort_order)
  select id, (select id from b7t4_ids where name = 'b'), 8192 from b7t4_ids where name in ('race1', 'race2');
end $$;
reset role;

create temporary table b7t4_race (task text, here text, there text);
insert into b7t4_race values ('race1', 'a', 'b'), ('race2', 'b', 'a');

do $$
declare
  r record;
begin
  if not exists (select 1 from pg_extension where extname = 'dblink') then
    raise notice 'zz36 (55b): dblink isn''t available here, the concurrent removal check is skipped';
    return;
  end if;
  for r in select * from b7t4_race loop
    perform extensions.dblink_connect('b7t4_' || r.task, format('host=%s port=%s dbname=%s user=postgres',
      split_part(current_setting('unix_socket_directories'), ',', 1), current_setting('port'), current_database()));
    -- This transaction removes one project (and keeps the task's lock until it ends) …
    update public.task_projects set deleted_at = now()
    where task_id = (select id from b7t4_ids where name = r.task) and project_id = (select id from b7t4_ids where name = r.here);
    -- … while a second session removes the other one.
    perform extensions.dblink_send_query('b7t4_' || r.task, format(
      'update public.task_projects set deleted_at = now() where task_id = %L and project_id = %L',
      (select id from b7t4_ids where name = r.task), (select id from b7t4_ids where name = r.there)));
  end loop;
  perform pg_sleep(0.3);
  for r in select * from b7t4_race loop
    assert extensions.dblink_is_busy('b7t4_' || r.task) = 1, format('%s: the second removal waits for the first', r.task);
  end loop;
end $$;

do $$
declare
  r record;
  err text;
begin
  if not exists (select 1 from pg_extension where extname = 'dblink') then
    return;
  end if;
  for r in select * from b7t4_race loop
    perform * from extensions.dblink_get_result('b7t4_' || r.task, false) as x(status text);
    err := extensions.dblink_error_message('b7t4_' || r.task);
    perform extensions.dblink_disconnect('b7t4_' || r.task);
    assert err like '%This is the task’s only project%', format('%s: the second removal is refused: %s', r.task, err);
    assert (select count(*) from public.task_projects
            where task_id = (select id from b7t4_ids where name = r.task) and deleted_at is null) = 1,
      format('%s: still in exactly one project', r.task);
    assert exists (select 1 from public.task_projects
                   where task_id = (select id from b7t4_ids where name = r.task) and deleted_at is null
                     and project_id = (select id from b7t4_ids where name = r.there)),
      format('%s: the one the first removal left (it didn''t come back)', r.task);
    assert (select home_project_id from public.tasks where id = (select id from b7t4_ids where name = r.task))
           = (select id from b7t4_ids where name = r.there), format('%s: the pointer is there', r.task);
  end loop;
end $$;

-- =================================================================================================
-- Cross-track checks (things no single track could test)
-- =================================================================================================

reset role;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset

--   b7a80029…01 b7x-owner@example.com     owner of X A and X B
--   b7a80029…02 b7x-editor@example.com    Editor of X A (an approval task's assignee; not an approver)
--   b7a80029…03 b7x-bedit@example.com     Editor of X B only
--   b7a80029…04 b7x-approver@example.com  Editor of X A, the approver

insert into public.allowed_emails (email, note) values
  ('b7x-owner@example.com', 'oct 29 batch 7 cross'),
  ('b7x-editor@example.com', 'oct 29 batch 7 cross'),
  ('b7x-bedit@example.com', 'oct 29 batch 7 cross'),
  ('b7x-approver@example.com', 'oct 29 batch 7 cross');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b7a80029-0000-4000-8000-000000000001', 'b7x-owner@example.com', now(), '{"full_name":"Xena Owner"}'),
  ('b7a80029-0000-4000-8000-000000000002', 'b7x-editor@example.com', now(), '{"full_name":"Xavi Editor"}'),
  ('b7a80029-0000-4000-8000-000000000003', 'b7x-bedit@example.com', now(), '{"full_name":"Bex Editor"}'),
  ('b7a80029-0000-4000-8000-000000000004', 'b7x-approver@example.com', now(), '{"full_name":"Axel Approver"}');

create temporary table b7x_ids (name text primary key, id uuid);
grant all on b7x_ids to authenticated, anon;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7a80029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  a uuid;
  b uuid;
  sa uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'X A') returning id into a;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'X B') returning id into b;
  insert into public.sections (project_id, name, sort_order) values (a, 'Work', 1024) returning id into sa;
  insert into b7x_ids values ('a', a), ('b', b), ('sa', sa);
  perform public.add_project_member(a, 'b7x-editor@example.com', 'editor');
  perform public.add_project_member(a, 'b7x-approver@example.com', 'editor');
  perform public.add_project_member(b, 'b7x-bedit@example.com', 'editor');
end $$;

-- ---------------------------------------------------------------------------------------------
-- 52 (refined): once the latest round is approved, the task completes normally again.
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'b7a80029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid;
begin
  t := public.create_task((select id from b7x_ids where name = 'a'), (select id from b7x_ids where name = 'sa'), 'Campaign approval');
  insert into b7x_ids values ('t', t);
  update public.tasks set kind = 'approval', assignee_id = 'b7a80029-0000-4000-8000-000000000002' where id = t;
  perform public.set_task_approvers(t, array['b7a80029-0000-4000-8000-000000000004'::uuid], 'any', null);
  assert not public.approval_round_approved(t), 'no round yet';
  begin
    update public.tasks set completed_at = now() where id = t;
    raise exception 'no round: only approvers';
  exception when check_violation then null;
  end;
  -- Ready for approval with More steps (just notify): approving won't complete it.
  perform public.send_for_approval(t, 'Campaign, final', '{}', true, 'notify', null);
end $$;

select set_config('request.jwt.claim.sub', 'b7a80029-0000-4000-8000-000000000004', false) is not null as ok \gset
select public.decide_approval((select id from public.approval_requests where task_id = (select id from b7x_ids where name = 't')
  and approver_id = 'b7a80029-0000-4000-8000-000000000004' and status = 'pending'), 'approved', 'Looks good');

-- The approval has been given: the Editor who isn't an approver completes it, by hand and in bulk.
select set_config('request.jwt.claim.sub', 'b7a80029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b7x_ids where name = 't');
  result jsonb;
begin
  assert public.task_approval_state(t) ->> 'status' = 'approved', 'the latest round is approved';
  assert public.approval_round_approved(t), 'the helper says so';
  assert (select completed_at from public.tasks where id = t) is null, 'More steps: approving didn''t complete it';
  assert not (public.task_approval_state(t) ->> 'is_approver')::boolean, 'the Editor still isn''t an approver';

  update public.tasks set completed_at = now() where id = t;
  assert (select completed_at from public.tasks where id = t) is not null, 'a non-approver Editor completes it now';
  update public.tasks set completed_at = null where id = t;

  result := public.bulk_update_tasks(array[t], '{"action": "complete"}'::jsonb);
  assert result -> 'updated' ? t::text, 'bulk Complete too: ' || result::text;
  update public.tasks set completed_at = null where id = t;
end $$;

-- A rule's Mark complete completes it too (no skip once approved).
select set_config('request.jwt.claim.sub', 'b7a80029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b7x_ids where name = 't');
  rid uuid;
  run public.rule_runs;
begin
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values ((select id from b7x_ids where name = 'a'), 'Finish it', true, 'manual', '[{"type": "complete_task"}]')
  returning id into rid;
  insert into b7x_ids values ('finish_rule', rid);
  perform public.run_manual_rule(rid, t);
  select * into run from public.rule_runs where rule_id = rid order by created_at desc limit 1;
  assert run.status = 'succeeded' and run.detail -> 'actions' -> 0 ->> 'result' = 'Marked complete',
    'the rule''s Mark complete ran: ' || coalesce(run.detail::text, '');
  assert (select completed_at from public.tasks where id = t) is not null, 'the rule completed it';
  update public.tasks set completed_at = null where id = t;
end $$;

-- My Tasks rules' Mark complete too.
select set_config('request.jwt.claim.sub', 'b7a80029-0000-4000-8000-000000000002', false) is not null as ok \gset
insert into public.my_task_rules (name, trigger_type, actions) values ('B7X done when assigned', 'assigned', '[{"type": "complete_task"}]');
select set_config('request.jwt.claim.sub', 'b7a80029-0000-4000-8000-000000000001', false) is not null as ok \gset
update public.tasks set assignee_id = 'b7a80029-0000-4000-8000-000000000001' where id = (select id from b7x_ids where name = 't');
update public.tasks set assignee_id = 'b7a80029-0000-4000-8000-000000000002' where id = (select id from b7x_ids where name = 't');
reset role;
do $$
declare
  t uuid := (select id from b7x_ids where name = 't');
  run public.my_task_rule_runs;
begin
  select * into run from public.my_task_rule_runs where task_id = t order by created_at desc limit 1;
  assert found and run.status = 'succeeded', 'the My Tasks rule ran';
  assert run.detail -> 'actions' -> 0 ->> 'outcome' is distinct from 'skipped', 'not skipped: ' || run.detail::text;
  assert (select completed_at from public.tasks where id = t) is not null, 'the My Tasks rule completed it';
  update public.my_task_rules set enabled = false where name = 'B7X done when assigned';
end $$;

-- A newer round puts the rule back: pending, then changes requested, then withdrawn.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7a80029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b7x_ids where name = 't');
begin
  update public.tasks set completed_at = null where id = t;
  perform public.send_for_approval(t, 'Campaign, v2', '{}', false, 'complete', null);
  assert not public.approval_round_approved(t), 'the latest round is pending';
  begin
    update public.tasks set completed_at = now() where id = t;
    raise exception 'pending again: only the approvers decide';
  exception when check_violation then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'b7a80029-0000-4000-8000-000000000004', false) is not null as ok \gset
select public.decide_approval((select id from public.approval_requests where task_id = (select id from b7x_ids where name = 't')
  and approver_id = 'b7a80029-0000-4000-8000-000000000004' and status = 'pending'), 'changes_requested', 'One more pass');

select set_config('request.jwt.claim.sub', 'b7a80029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b7x_ids where name = 't');
  result jsonb;
begin
  begin
    update public.tasks set completed_at = now() where id = t;
    raise exception 'changes requested in the latest round: the earlier approval doesn''t count';
  exception when check_violation then null;
  end;
  result := public.bulk_update_tasks(array[t], '{"action": "complete"}'::jsonb);
  assert result -> 'skipped' -> 0 ->> 'reason' = 'Only its approvers can complete an approval task. Send it with Ready for approval.',
    'bulk skips it again: ' || result::text;
  perform public.acknowledge_approval(t);
  perform public.send_for_approval(t, 'Campaign, v3', '{}', false, 'complete', null);
  perform public.withdraw_approval(t);
  assert public.task_approval_state(t) ->> 'status' = 'not_sent', 'withdrawn reads as not sent';
  begin
    update public.tasks set completed_at = now() where id = t;
    raise exception 'withdrawn: only approvers';
  exception when check_violation then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'b7a80029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b7x_ids where name = 't');
  run public.rule_runs;
begin
  perform public.run_manual_rule((select id from b7x_ids where name = 'finish_rule'), t);
  select * into run from public.rule_runs where rule_id = (select id from b7x_ids where name = 'finish_rule')
  order by created_at desc limit 1;
  assert run.detail -> 'actions' -> 0 ->> 'outcome' = 'skipped', 'the rule skips it again: ' || run.detail::text;
  assert (select completed_at from public.tasks where id = t) is null, 'still open';
end $$;
reset role;

do $$
begin
  assert not (select prosecdef from pg_proc where oid = 'public.approval_round_approved(uuid)'::regprocedure), 'invoker';
  assert has_function_privilege('authenticated', 'public.approval_round_approved(uuid)', 'execute'), 'the guard runs it as the person';
  assert not has_function_privilege('anon', 'public.approval_round_approved(uuid)', 'execute'), 'nothing for anon';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 49 × 55: a shared library field has one symbol; 47 × 55: an option-less library select can be
-- added; 54 × 55: shared options keep the new colors; 51: a locked field's symbol needs Owner / Admin.
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7a80029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b7x_ids where name = 'a');
  f uuid;
begin
  insert into public.custom_fields (project_id, name, field_type, number_prefix, in_library)
  values (a, 'X Budget', 'number', '$', true) returning id into f;
  insert into b7x_ids values ('budget', f);
  insert into public.custom_fields (project_id, name, field_type, options, in_library)
  values (a, 'X Tone', 'single_select',
          '[{"id": "warm", "name": "Warm", "color": "fuchsia"}, {"id": "cool", "name": "Cool", "color": "sky"}]', true)
  returning id into f;
  insert into b7x_ids values ('tone', f);
end $$;
reset role;

-- An option-less select published by a system path (like the seeded template's selects).
do $$
declare
  f uuid;
begin
  insert into public.custom_fields (project_id, name, field_type, options, in_library)
  values ((select id from b7x_ids where name = 'a'), 'X Stage', 'single_select', '[]', true) returning id into f;
  insert into b7x_ids values ('stage', f);
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7a80029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  b uuid := (select id from b7x_ids where name = 'b');
  pb uuid;
  pt uuid;
  ps uuid;
begin
  pb := public.add_library_field(b, (select id from b7x_ids where name = 'budget'));
  pt := public.add_library_field(b, (select id from b7x_ids where name = 'tone'));
  -- 47: the option guard is for people's writes; add_library_field (definer) adds an empty select.
  ps := public.add_library_field(b, (select id from b7x_ids where name = 'stage'));
  insert into b7x_ids values ('budget_b', pb), ('tone_b', pt), ('stage_b', ps);
  assert (select number_prefix from public.custom_fields where id = pb) = '$', '49: the placement has the symbol';
  assert (select options from public.custom_fields where id = pt)
         = '[{"id": "warm", "name": "Warm", "color": "fuchsia"}, {"id": "cool", "name": "Cool", "color": "sky"}]'::jsonb,
    '54: the placement keeps the new colors';
  assert (select field_type = 'single_select' and options = '[]'::jsonb from public.custom_fields where id = ps),
    '47: an option-less library select is added';

  -- The symbol is part of the shared definition: only Editors of the publishing project change it.
  begin
    update public.custom_fields set number_prefix = '€' where id = pb;
    raise exception 'a placement''s symbol is read-only here';
  exception when insufficient_privilege then null;
  end;
  assert (select number_prefix from public.custom_fields where id = pb) = '$', 'unchanged';
end $$;

select set_config('request.jwt.claim.sub', 'b7a80029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  -- An Editor of the publishing project changes it everywhere, and option colors sync as they are.
  update public.custom_fields set number_prefix = '€' where id = (select id from b7x_ids where name = 'budget');
  update public.custom_fields
  set options = '[{"id": "warm", "name": "Warm", "color": "rose"}, {"id": "cool", "name": "Cool", "color": "indigo"}]'
  where id = (select id from b7x_ids where name = 'tone');
end $$;
reset role;

do $$
begin
  assert (select number_prefix from public.custom_fields where id = (select id from b7x_ids where name = 'budget_b')) = '€',
    '49 × 55: the symbol synced to the placement';
  assert (select options -> 0 ->> 'color' from public.custom_fields where id = (select id from b7x_ids where name = 'tone_b')) = 'rose'
     and (select options -> 1 ->> 'color' from public.custom_fields where id = (select id from b7x_ids where name = 'tone_b')) = 'indigo',
    '54 × 55: the new colors synced';
  assert (select format_number_value(1250, number_prefix) from public.custom_fields where id = (select id from b7x_ids where name = 'budget_b'))
         = '€1,250', 'the placement formats with the shared symbol';
end $$;

-- Copies: Duplicate project links the copy and it carries the shared symbol.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7a80029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  copy jsonb;
begin
  copy := public.duplicate_project((select id from b7x_ids where name = 'b'), 'X B copy', '{}');
  assert exists (
    select 1 from public.custom_fields f
    where f.project_id = (copy ->> 'project_id')::uuid and f.deleted_at is null
      and f.library_field_id = (select id from b7x_ids where name = 'budget') and f.number_prefix = '€'
  ), 'the copy is a placement of the library field, with its symbol';

  -- 51: lock the shared field; then its symbol needs an Owner / Admin of the publishing project.
  update public.custom_fields set locked = true where id = (select id from b7x_ids where name = 'budget');
end $$;

select set_config('request.jwt.claim.sub', 'b7a80029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  msg text;
begin
  begin
    update public.custom_fields set number_prefix = '£' where id = (select id from b7x_ids where name = 'budget');
    raise exception 'a locked field''s symbol is for Owners and Admins';
  exception when insufficient_privilege then
    get stacked diagnostics msg = message_text;
    assert msg like 'Locked%', 'the lock''s reason: ' || msg;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'b7a80029-0000-4000-8000-000000000001', false) is not null as ok \gset
update public.custom_fields set number_prefix = '£' where id = (select id from b7x_ids where name = 'budget');
reset role;

do $$
begin
  assert (select bool_and(number_prefix = '£' and locked) from public.custom_fields
          where (id = (select id from b7x_ids where name = 'budget') or library_field_id = (select id from b7x_ids where name = 'budget'))
            and deleted_at is null),
    'the owner changed the locked symbol, and every placement follows (locked too)';
end $$;

-- 54: tags keep a new palette color (the base color for older readers) after the field library's changes.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7a80029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  g uuid;
begin
  insert into public.tags (name, color, palette_color) values ('B7X Lime', 'green', 'lime') returning id into g;
  assert (select (color, palette_color) = ('green', 'lime') from public.tags where id = g), 'lime kept, green as the base';
end $$;
reset role;

reset role;
do $$ begin raise notice 'oct 29 batch 7 smoke: all assertions passed'; end $$;
