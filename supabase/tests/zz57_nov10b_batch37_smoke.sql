-- Nov 10 batch 37 (20261110020000_nov10b_batch37_a.sql, note 183): a two-stage approval (internal
-- approver + external reviewer) never completes its task by itself; its assignee finishes it.
--   a3100370…01 b37-owner@example.com     Bo Owner     (owns P)
--   a3100370…02 b37-editor@example.com    Ed Editor    (Editor of P, the approval tasks' assignee)
--   a3100370…03 b37-approver@example.com  Al Approver  (Editor of P, the approval tasks' approver)

\set ON_ERROR_STOP 1

create temporary table b37_ids (name text primary key, id uuid) on commit preserve rows;
create temporary table b37_tokens (name text primary key, token text) on commit preserve rows;
grant all on b37_ids, b37_tokens to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('b37-owner@example.com', 'batch 37'), ('b37-editor@example.com', 'batch 37'), ('b37-approver@example.com', 'batch 37');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a3100370-0000-4000-8000-000000000001', 'b37-owner@example.com', now(), '{"full_name":"Bo Owner"}'),
  ('a3100370-0000-4000-8000-000000000002', 'b37-editor@example.com', now(), '{"full_name":"Ed Editor"}'),
  ('a3100370-0000-4000-8000-000000000003', 'b37-approver@example.com', now(), '{"full_name":"Al Approver"}');

-- 0. Grants: the helpers are for signed-in people (the guard runs as them) and the service role; never anon.
do $$
begin
  assert has_function_privilege('authenticated', 'public.approval_two_stage(uuid)', 'execute'), 'the guard needs it';
  assert not has_function_privilege('anon', 'public.approval_two_stage(uuid)', 'execute'), 'anon doesn''t';
  assert not has_function_privilege('anon', 'public.approval_assignee_may_complete(uuid)', 'execute'), 'anon doesn''t';
  assert not (select prosecdef from pg_proc where oid = 'public.approval_two_stage(uuid)'::regprocedure), 'invoker';
  assert not (select prosecdef from pg_proc where oid = 'public.approval_assignee_may_complete(uuid)'::regprocedure), 'invoker';
end $$;

-- P with two sections; three approval tasks assigned to Ed and approved by Al:
--   two  — an external reviewer is set, "complete the task" when approved
--   move — an external reviewer is set, "move it to Done" when approved
--   one  — no external reviewer (single-stage), "complete the task" when approved
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100370-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid;
  s uuid;
  done uuid;
  t uuid;
  a uuid;
  label text;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B37 Requests') returning id into p;
  insert into public.sections (project_id, name) values (p, 'Doing') returning id into s;
  insert into public.sections (project_id, name) values (p, 'Done') returning id into done;
  perform public.add_project_member(p, 'b37-editor@example.com', 'editor');
  perform public.add_project_member(p, 'b37-approver@example.com', 'editor');
  insert into b37_ids values ('p', p), ('s', s), ('done', done);
  foreach label in array array['two', 'move', 'one'] loop
    t := public.create_task(p, s, 'B37 ' || label);
    update public.tasks set kind = 'approval', assignee_id = 'a3100370-0000-4000-8000-000000000002' where id = t;
    perform public.set_task_approvers(t, array['a3100370-0000-4000-8000-000000000003']::uuid[], 'any', null);
    insert into public.task_attachments (task_id, storage_path, file_name, content_type, size_bytes)
    values (t, t::text || '/b37-' || label || '.pdf', label || '.pdf', 'application/pdf', 1000) returning id into a;
    insert into b37_ids values (label, t), (label || '_file', a);
  end loop;
  perform public.set_task_external_reviewer((select id from b37_ids where name = 'two'), 'client@example.org', 'Jordan');
  perform public.set_task_external_reviewer((select id from b37_ids where name = 'move'), 'client@example.org', 'Jordan');
  assert public.approval_two_stage((select id from b37_ids where name = 'two')), 'an approver + a reviewer = two-stage';
  assert not public.approval_two_stage((select id from b37_ids where name = 'one')), 'no reviewer = single-stage';
end $$;

-- 1. Ed sends each for approval; Al approves each.
select set_config('request.jwt.claim.sub', 'a3100370-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  perform public.send_for_approval((select id from b37_ids where name = 'two'), 'Final copy', null, false, 'complete', null);
  perform public.send_for_approval((select id from b37_ids where name = 'move'), 'Final copy', null, true, 'move_section',
    (select id from b37_ids where name = 'done'));
  perform public.send_for_approval((select id from b37_ids where name = 'one'), 'Final copy', null, false, 'complete', null);
end $$;
select set_config('request.jwt.claim.sub', 'a3100370-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  req uuid;
begin
  for req in
    select q.id from public.approval_requests q
    where q.task_id in (select id from b37_ids where name in ('two', 'move', 'one'))
      and q.approver_id = auth.uid() and q.status = 'pending'
  loop
    perform public.decide_approval(req, 'approved', null);
  end loop;
end $$;
reset role;
do $$
begin
  assert (select completed_at from public.tasks where id = (select id from b37_ids where name = 'two')) is null,
    'two-stage: the internal approval doesn''t complete it, though "When it''s approved" said complete';
  assert (select completed_at from public.tasks where id = (select id from b37_ids where name = 'move')) is null, 'two-stage: not completed';
  assert (select section_id from public.task_projects where task_id = (select id from b37_ids where name = 'move') and deleted_at is null)
    = (select id from b37_ids where name = 's'), 'two-stage: the internal approval doesn''t move it either';
  assert (select completed_at from public.tasks where id = (select id from b37_ids where name = 'one')) is not null,
    'single-stage: approving completes it, as before';
  assert (select status from public.approval_rounds where task_id = (select id from b37_ids where name = 'two')
    order by round_number desc limit 1) = 'approved', 'the internal round is approved';
end $$;

-- 2. Before the external approval, the assignee can't complete it (only its approvers could).
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100370-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  assert not public.approval_assignee_may_complete((select id from b37_ids where name = 'two')), 'not yet';
  begin
    update public.tasks set completed_at = now() where id = (select id from b37_ids where name = 'two');
    raise exception 'the assignee must not complete it before the external review is approved';
  exception when check_violation then
    assert sqlerrm like 'This task was approved. Only its approvers%', sqlerrm;
  end;
end $$;

-- 3. Al sends it to the external reviewer, who approves: still open (no automatic completion).
select set_config('request.jwt.claim.sub', 'a3100370-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  result jsonb;
begin
  result := public.create_review_check((select id from b37_ids where name = 'two'),
    array[(select id from b37_ids where name = 'two_file')], 'client@example.org', 'Jordan', 'Please take a look before Friday.');
  insert into b37_tokens values ('two', result ->> 'token');
  assert (select message from public.review_checks where id = (result ->> 'id')::uuid) = 'Please take a look before Friday.',
    'the approver''s message is kept with the round (note 182: the email shows it)';
end $$;
reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
do $$
begin
  assert public.review_check_decide((select token from b37_tokens where name = 'two'), 'approved', 'All good') ->> 'review_status' = 'approved',
    'the external reviewer approves';
end $$;
reset role;
do $$
begin
  assert (select completed_at from public.tasks where id = (select id from b37_ids where name = 'two')) is null,
    'the external approval doesn''t complete it either';
end $$;

-- 4. Now the assignee completes it by hand (the green "Externally approved" badge is on).
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100370-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  n int;
begin
  assert public.approval_assignee_may_complete((select id from b37_ids where name = 'two')), 'both approvals are in';
  update public.tasks set completed_at = now() where id = (select id from b37_ids where name = 'two');
  get diagnostics n = row_count;
  assert n = 1, 'the assignee completes it';
end $$;

-- 5. The approver can still complete the other two-stage task (unchanged), and a non-assignee Editor
--    still can't.
select set_config('request.jwt.claim.sub', 'a3100370-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  assert not public.approval_assignee_may_complete((select id from b37_ids where name = 'move')), 'the owner isn''t its assignee';
  begin
    update public.tasks set completed_at = now() where id = (select id from b37_ids where name = 'move');
    raise exception 'only approvers (or, after the external approval, the assignee) complete it';
  exception when check_violation then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', 'a3100370-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  n int;
begin
  update public.tasks set completed_at = now() where id = (select id from b37_ids where name = 'move');
  get diagnostics n = row_count;
  assert n = 1, 'an approver completes it as before';
end $$;
reset role;

do $$ begin raise notice 'nov 10 batch 37 smoke: all assertions passed'; end $$;
