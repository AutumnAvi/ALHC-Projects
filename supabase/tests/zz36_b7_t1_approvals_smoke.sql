-- Oct 29 notes, batch 7, track T1 (20261029010100_b7_t1_approvals.sql; the lead concatenates it into
-- zz36_oct29_batch7_smoke.sql).
--
-- 52. Only approvers approve or complete an approval task. Regression test for the bug: before "Ready for
--     approval" any Editor could tick an approval task complete.
--   b7b70029…01 b7-owner@example.com      owner of B7 Approvals
--   b7b70029…02 b7-editor@example.com     Editor (the assignee; not an approver)
--   b7b70029…03 b7-approver@example.com   Editor and approver
--   b7b70029…04 b7-commenter@example.com  Commenter and approver

\set ON_ERROR_STOP 1

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
begin
  perform public.set_task_approvers(t,
    array['b7b70029-0000-4000-8000-000000000003'::uuid, 'b7b70029-0000-4000-8000-000000000004'::uuid], 'any', null);
  begin
    update public.tasks set completed_at = now() where id = t;
    raise exception 'still not an approver';
  exception when check_violation then null;
  end;

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

do $$ begin raise notice 'zz36 (T1) Oct 29 batch 7 approvals smoke: all assertions passed'; end $$;
