-- Nov 24 batch 45 (20261124010000_nov24_batch45_a.sql): team and outside review at the same time, "When it's
-- approved" after the last stage, the outside reviewer's due date and reminder, the email's send state, and
-- the separate copyable review link.
--   a3100450…01 b45-owner@example.com     Bo Owner     (owns P)
--   a3100450…02 b45-editor@example.com    Ed Editor    (Editor of P, the approval tasks' assignee)
--   a3100450…03 b45-approver@example.com  Al Approver  (Editor of P, the approval tasks' approver)
--   a3100450…04 b45-viewer@example.com    Vi Viewer    (Viewer of P)
--   a3100450…05 b45-commenter@example.com Cy Commenter (Commenter of P, assignee of par5)

\set ON_ERROR_STOP 1

create temporary table b45_ids (name text primary key, id uuid) on commit preserve rows;
create temporary table b45_tokens (name text primary key, token text) on commit preserve rows;
grant all on b45_ids, b45_tokens to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('b45-owner@example.com', 'batch 45'), ('b45-editor@example.com', 'batch 45'),
  ('b45-approver@example.com', 'batch 45'), ('b45-viewer@example.com', 'batch 45'),
  ('b45-commenter@example.com', 'batch 45');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a3100450-0000-4000-8000-000000000001', 'b45-owner@example.com', now(), '{"full_name":"Bo Owner"}'),
  ('a3100450-0000-4000-8000-000000000002', 'b45-editor@example.com', now(), '{"full_name":"Ed Editor"}'),
  ('a3100450-0000-4000-8000-000000000003', 'b45-approver@example.com', now(), '{"full_name":"Al Approver"}'),
  ('a3100450-0000-4000-8000-000000000004', 'b45-viewer@example.com', now(), '{"full_name":"Vi Viewer"}'),
  ('a3100450-0000-4000-8000-000000000005', 'b45-commenter@example.com', now(), '{"full_name":"Cy Commenter"}');

-- 0. Grants and shape: nothing for anon; the two new client calls for signed-in people; helpers internal;
--    the copied link's hash and Resend's id unreadable; existing rows keep the old order.
do $$
begin
  assert has_function_privilege('authenticated', 'public.record_review_email(uuid,text,text,text)', 'execute'), 'client call';
  assert has_function_privilege('authenticated', 'public.review_check_copy_link(uuid)', 'execute'), 'client call';
  assert has_function_privilege('authenticated', 'public.set_task_review_plan(uuid,text,date)', 'execute'), 'client call';
  assert (select prosecdef from pg_proc where oid = 'public.set_task_review_plan(uuid,text,date)'::regprocedure) = false,
    'the plan call is invoker (RLS decides)';
  assert not has_function_privilege('anon', 'public.set_task_review_plan(uuid,text,date)', 'execute'), 'not anon';
  assert not has_function_privilege('anon', 'public.record_review_email(uuid,text,text,text)', 'execute'), 'not anon';
  assert not has_function_privilege('anon', 'public.review_check_copy_link(uuid)', 'execute'), 'not anon';
  assert not has_function_privilege('authenticated', 'public.review_check_parallel(uuid)', 'execute'), 'internal';
  assert not has_function_privilege('authenticated', 'public.approval_external_done(uuid)', 'execute'), 'internal';
  assert not has_function_privilege('authenticated', 'public.record_review_email_event(text,text,timestamptz,text,text)', 'execute'), 'service only';
  assert has_function_privilege('service_role', 'public.record_review_email_event(text,text,timestamptz,text,text)', 'execute'), 'service';
  assert not has_function_privilege('authenticated', 'public.sync_review_due_on()', 'execute'), 'trigger';
  assert not has_function_privilege('authenticated', 'public.review_checks_fill_due_on()', 'execute'), 'trigger';
  assert has_column_privilege('authenticated', 'public.review_checks', 'email_status', 'select'), 'the team reads the email state';
  assert has_column_privilege('authenticated', 'public.review_checks', 'due_on', 'select'), 'and the due date';
  assert not has_column_privilege('authenticated', 'public.review_checks', 'copy_token_hash', 'select'), 'never the copied link''s hash';
  assert not has_column_privilege('authenticated', 'public.review_checks', 'provider_message_id', 'select'), 'nor Resend''s id';
  assert not has_column_privilege('anon', 'public.review_checks', 'email_status', 'select'), 'nothing for anon';
  assert not has_column_privilege('anon', 'public.task_review_settings', 'review_order', 'select'), 'nothing for anon';
  assert not exists (select 1 from public.task_review_settings where review_order <> 'sequential'), 'existing rows stay sequential';
  assert (select prosecdef from pg_proc where oid = 'public.guard_task_review_order()'::regprocedure) = false, 'the order guard is invoker';
end $$;

-- Cy is a Commenter (round 1 fix: the assignee sends the outside review with the team round): the Commenter
-- role is on for this suite and put back at the end.
create temporary table b45_flags on commit preserve rows as
  select allow_commenter_role from public.workspaces where id = '00000000-0000-4000-8000-000000000001';
update public.workspaces set allow_commenter_role = true where id = '00000000-0000-4000-8000-000000000001';

-- P with sections Doing and Ready; approval tasks assigned to Ed and approved by Al, each with a file:
--   par   — parallel order, moves to Ready when approved (team approves first, then the outside reviewer)
--   par2  — parallel order, completes when approved (the outside reviewer approves first)
--   par3  — parallel order: changes from either side end the round for both; withdraw takes the review back
--   seq   — sequential order (team first), completes when approved
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100450-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid;
  s uuid;
  ready uuid;
  t uuid;
  a uuid;
  label text;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B45 Requests') returning id into p;
  insert into public.sections (project_id, name) values (p, 'Doing') returning id into s;
  insert into public.sections (project_id, name) values (p, 'Ready') returning id into ready;
  perform public.add_project_member(p, 'b45-editor@example.com', 'editor');
  perform public.add_project_member(p, 'b45-approver@example.com', 'editor');
  perform public.add_project_member(p, 'b45-viewer@example.com', 'viewer');
  perform public.add_project_member(p, 'b45-commenter@example.com', 'commenter');
  insert into b45_ids values ('p', p), ('s', s), ('ready', ready);
  foreach label in array array['par', 'par2', 'par3', 'seq', 'par4', 'par5', 'seq2'] loop
    t := public.create_task(p, s, 'B45 ' || label);
    update public.tasks set kind = 'approval', assignee_id = 'a3100450-0000-4000-8000-000000000002' where id = t;
    perform public.set_task_approvers(t, array['a3100450-0000-4000-8000-000000000003']::uuid[], 'any', null);
    insert into public.task_attachments (task_id, storage_path, file_name, content_type, size_bytes)
    values (t, t::text || '/b45-' || label || '.pdf', label || '.pdf', 'application/pdf', 1000) returning id into a;
    insert into b45_ids values (label, t), (label || '_file', a);
    perform public.set_task_external_reviewer(t, 'client@example.org', 'Sarah K.');
  end loop;
  update public.tasks set assignee_id = 'a3100450-0000-4000-8000-000000000005' where id = (select id from b45_ids where name = 'par5');
end $$;

-- 1. Ed (an Editor) chooses the order and the outside due date through set_task_review_plan (the app's
--    path; an upsert through the API would need UPDATE on task_id), on rows that exist and rows that don't.
select set_config('request.jwt.claim.sub', 'a3100450-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  label text;
  t uuid;
begin
  foreach label in array array['par', 'par2', 'par3', 'par4', 'par5'] loop
    perform public.set_task_review_plan((select id from b45_ids where name = label), 'parallel', current_date + 5);
  end loop;
  assert (select count(*) from public.task_review_settings
    where task_id in (select id from b45_ids where name in ('par', 'par2', 'par3', 'par4', 'par5'))
      and review_order = 'parallel' and reviewer_due_on = current_date + 5) = 5, 'an Editor sets the order and the due date';
  perform public.set_task_review_plan((select id from b45_ids where name = 'seq'), 'sequential', current_date + 6);
  perform public.set_task_review_plan((select id from b45_ids where name = 'seq2'), 'sequential', null);
  begin
    perform public.set_task_review_plan((select id from b45_ids where name = 'seq'), 'both', null);
    raise exception 'an unknown order must be refused';
  exception when check_violation then null;
  end;
  -- A task without review settings yet gets its row — but not the parallel order under an open round.
  t := public.create_task((select id from b45_ids where name = 'p'), (select id from b45_ids where name = 's'), 'B45 no settings');
  update public.tasks set kind = 'approval' where id = t;
  perform public.set_task_approvers(t, array['a3100450-0000-4000-8000-000000000003']::uuid[], 'any', null);
  perform public.send_for_approval(t, 'Final copy', null, false, 'complete', null);
  assert not exists (select 1 from public.task_review_settings where task_id = t), 'no settings row yet';
  begin
    perform public.set_task_review_plan(t, 'parallel', null);
    raise exception 'the parallel order must not start under an open round';
  exception when check_violation then null;
  end;
  perform public.set_task_review_plan(t, 'sequential', current_date + 3);
  assert (select reviewer_due_on from public.task_review_settings where task_id = t) = current_date + 3, 'inserted';
  -- A plain write of the table still follows the column grants (no task_id updates).
  begin
    update public.task_review_settings set task_id = t where task_id = (select id from b45_ids where name = 'seq');
    raise exception 'task_id is not writable';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', 'a3100450-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
begin
  perform public.set_task_review_plan((select id from b45_ids where name = 'par'), 'sequential', null);
  raise exception 'a Viewer can''t change the order';
exception when insufficient_privilege then null;
end $$;

-- 2. The gate: in the parallel order the outside review goes out with the team round (no approval first);
--    in the sequential order it still waits for the team. The round takes the outside due date.
select set_config('request.jwt.claim.sub', 'a3100450-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  result jsonb;
  label text;
begin
  perform public.send_for_approval((select id from b45_ids where name = 'par'), 'Final copy', null, true, 'move_section',
    (select id from b45_ids where name = 'ready'));
  perform public.send_for_approval((select id from b45_ids where name = 'par2'), 'Final copy', null, false, 'complete', null);
  perform public.send_for_approval((select id from b45_ids where name = 'par3'), 'Final copy', null, false, 'complete', null);
  perform public.send_for_approval((select id from b45_ids where name = 'seq'), 'Final copy', null, false, 'complete', null);
  foreach label in array array['par', 'par2', 'par3'] loop
    result := public.create_review_check((select id from b45_ids where name = label),
      array[(select id from b45_ids where name = label || '_file')], 'client@example.org', 'Sarah K.', 'Same time as the team');
    insert into b45_tokens values (label, result ->> 'token');
    insert into b45_ids values (label || '_check', (result ->> 'id')::uuid);
    assert (select due_on from public.review_checks where id = (result ->> 'id')::uuid) = current_date + 5,
      'the round takes the task''s outside due date';
  end loop;
  begin
    perform public.create_review_check((select id from b45_ids where name = 'seq'),
      array[(select id from b45_ids where name = 'seq_file')], 'client@example.org', 'Sarah K.', null);
    raise exception 'the sequential order still waits for the team''s approval';
  exception when insufficient_privilege then null;
  end;
  -- The order can't change under an open round.
  begin
    update public.task_review_settings set review_order = 'sequential' where task_id = (select id from b45_ids where name = 'par');
    raise exception 'the order must not change while a round is open';
  exception when check_violation then
    assert sqlerrm like 'Change the review order once%', sqlerrm;
  end;
  -- A changed due date follows into the open round.
  update public.task_review_settings set reviewer_due_on = current_date + 7 where task_id = (select id from b45_ids where name = 'par');
end $$;
reset role;
do $$
begin
  assert (select due_on from public.review_checks where id = (select id from b45_ids where name = 'par_check')) = current_date + 7,
    'the open round follows the new due date';
  assert public.review_check_parallel((select id from b45_ids where name = 'par')), 'parallel';
  assert not public.review_check_parallel((select id from b45_ids where name = 'seq')), 'sequential';
end $$;

-- 3. par: the team approves first — nothing moves yet; then the outside reviewer approves — it moves to Ready.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100450-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
begin
  perform public.decide_approval(
    (select q.id from public.approval_requests q where q.task_id = (select id from b45_ids where name = 'par') and q.status = 'pending'),
    'approved', null);
end $$;
reset role;
do $$
begin
  assert (select section_id from public.task_projects where task_id = (select id from b45_ids where name = 'par') and deleted_at is null)
    = (select id from b45_ids where name = 's'), 'the team''s approval alone doesn''t move it (the outside reviewer is still reviewing)';
end $$;
set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
do $$
begin
  assert public.review_check_decide((select token from b45_tokens where name = 'par'), 'approved', 'Love it') ->> 'review_status' = 'approved',
    'the outside reviewer approves';
end $$;
reset role;
do $$
begin
  assert (select section_id from public.task_projects where task_id = (select id from b45_ids where name = 'par') and deleted_at is null)
    = (select id from b45_ids where name = 'ready'), 'both approved the same round: "When it''s approved" moved it to Ready';
  assert (select completed_at from public.tasks where id = (select id from b45_ids where name = 'par')) is null, 'moved, not completed';
end $$;

-- 4. par2: the outside reviewer approves first — still open; then the team approves — completed.
set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
do $$
begin
  perform public.review_check_decide((select token from b45_tokens where name = 'par2'), 'approved', null);
end $$;
reset role;
do $$
begin
  assert (select completed_at from public.tasks where id = (select id from b45_ids where name = 'par2')) is null,
    'the outside approval alone doesn''t complete it (the team hasn''t approved)';
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100450-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
begin
  perform public.decide_approval(
    (select q.id from public.approval_requests q where q.task_id = (select id from b45_ids where name = 'par2') and q.status = 'pending'),
    'approved', null);
end $$;
reset role;
do $$
begin
  assert (select completed_at from public.tasks where id = (select id from b45_ids where name = 'par2')) is not null,
    'the team''s approval was the last one: "When it''s approved" completed it';
end $$;

-- 5. par3: the outside reviewer asks for changes — the team's open round ends too (round 2 goes to both).
set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
do $$
begin
  assert public.review_check_decide((select token from b45_tokens where name = 'par3'), 'changes_requested', 'Bigger logo')
    ->> 'review_status' = 'changes_requested', 'the outside reviewer asks for changes';
end $$;
reset role;
do $$
declare
  r public.approval_rounds;
begin
  select * into r from public.approval_rounds where task_id = (select id from b45_ids where name = 'par3') order by round_number desc limit 1;
  assert r.status = 'withdrawn' and r.closed_reason = 'outside_changes', 'the team round ended with the outside changes';
  assert not exists (
    select 1 from public.approval_requests q where q.round_id = r.id and q.status = 'pending'
  ), 'nothing is left for the approver to decide';
  assert exists (
    select 1 from public.approval_requests q where q.round_id = r.id and q.status = 'cancelled' and q.cancel_reason = 'round_closed'
  ), 'the approver''s request closed with the round';
  assert (select completed_at from public.tasks where id = (select id from b45_ids where name = 'par3')) is null, 'not completed';
end $$;

-- Round 2 goes to both straight away; then the team asks for changes — the outside round 2 closes too.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100450-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  result jsonb;
begin
  perform public.send_for_approval((select id from b45_ids where name = 'par3'), 'Bigger logo now', null, false, 'complete', null);
  result := public.create_review_check((select id from b45_ids where name = 'par3'),
    array[(select id from b45_ids where name = 'par3_file')], 'client@example.org', 'Sarah K.', null);
  assert (result ->> 'round')::int = 2, 'outside round 2';
  insert into b45_ids values ('par3_check2', (result ->> 'id')::uuid);
end $$;
select set_config('request.jwt.claim.sub', 'a3100450-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
begin
  perform public.decide_approval(
    (select q.id from public.approval_requests q where q.task_id = (select id from b45_ids where name = 'par3') and q.status = 'pending'),
    'changes_requested', 'Wrong date');
end $$;
reset role;
do $$
begin
  assert (select status from public.review_checks where id = (select id from b45_ids where name = 'par3_check2')) = 'superseded',
    'the team''s changes close the outside reviewer''s open round';
  assert (select closed_reason from public.review_checks where id = (select id from b45_ids where name = 'par3_check2')) = 'team_changes',
    'and say why';
end $$;

-- Round 3: withdrawing the team round takes back the outside review sent with it.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100450-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  result jsonb;
begin
  perform public.acknowledge_approval((select id from b45_ids where name = 'par3'));
  perform public.send_for_approval((select id from b45_ids where name = 'par3'), 'Date fixed', null, false, 'complete', null);
  result := public.create_review_check((select id from b45_ids where name = 'par3'),
    array[(select id from b45_ids where name = 'par3_file')], 'client@example.org', 'Sarah K.', null);
  insert into b45_ids values ('par3_check3', (result ->> 'id')::uuid);
  perform public.withdraw_approval((select id from b45_ids where name = 'par3'));
end $$;
reset role;
do $$
begin
  assert (select status from public.review_checks where id = (select id from b45_ids where name = 'par3_check3')) = 'cancelled',
    'withdrawn with the team round';
  assert (select closed_reason from public.review_checks where id = (select id from b45_ids where name = 'par3_check3')) = 'withdrawn_with_round',
    'and say why';
end $$;

-- 6. seq (team first, then outside): the team's approval doesn't complete it; the outside approval — the
--    last stage — runs "When it's approved" (complete).
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100450-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  result jsonb;
begin
  perform public.decide_approval(
    (select q.id from public.approval_requests q where q.task_id = (select id from b45_ids where name = 'seq') and q.status = 'pending'),
    'approved', null);
  assert (select completed_at from public.tasks where id = (select id from b45_ids where name = 'seq')) is null, 'not yet';
  result := public.create_review_check((select id from b45_ids where name = 'seq'),
    array[(select id from b45_ids where name = 'seq_file')], 'client@example.org', 'Sarah K.', null);
  insert into b45_tokens values ('seq', result ->> 'token');
  insert into b45_ids values ('seq_check', (result ->> 'id')::uuid);
  assert (select due_on from public.review_checks where id = (result ->> 'id')::uuid) = current_date + 6, 'its due date';
end $$;
reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
do $$
begin
  perform public.review_check_decide((select token from b45_tokens where name = 'seq'), 'approved', null);
end $$;
reset role;
do $$
begin
  assert (select completed_at from public.tasks where id = (select id from b45_ids where name = 'seq')) is not null,
    'sequential: the outside approval (last stage) completed it';
end $$;

-- 7. The one reminder: the day before the due date (not in the first 12 hours); without one, a day after.
reset role;
do $$
declare
  r public.review_checks;
  base public.review_checks;
begin
  select * into base from public.review_checks where id = (select id from b45_ids where name = 'par3_check3');
  r := base;
  r.status := 'pending'; r.nudged_at := null; r.nudge_attempts := 0; r.nudge_claimed_at := null;
  r.expires_at := now() + interval '20 days';
  r.due_on := current_date + 1; r.created_at := now() - interval '13 hours';
  assert public.review_nudge_due(r), 'due tomorrow, sent 13 hours ago: remind now';
  r.created_at := now() - interval '2 hours';
  assert not public.review_nudge_due(r), 'never in the first 12 hours';
  r.due_on := current_date + 10; r.created_at := now() - interval '30 hours';
  assert not public.review_nudge_due(r), 'due in 10 days: not yet (even though it was sent a day ago)';
  r.due_on := null; r.created_at := now() - interval '25 hours';
  assert public.review_nudge_due(r), 'no due date: a day after sending, as before';
  r.created_at := now() - interval '80 hours';
  assert not public.review_nudge_due(r), 'no due date, too old: none, as before';
end $$;

-- 8. The email's send state: the sender (or anyone who may send it) records it; a Viewer can't; sent clears a
--    failure; Resend's later events land on the round and a permanent bounce suppresses the address.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100450-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  result jsonb;
begin
  -- A fresh round on par3 to a separate address (its earlier rounds are closed).
  result := public.create_review_check((select id from b45_ids where name = 'par3'),
    array[(select id from b45_ids where name = 'par3_file')], 'bounce@example.org', null, null);
  insert into b45_ids values ('mail_check', (result ->> 'id')::uuid);
  perform public.record_review_email((result ->> 'id')::uuid, 'sending', null, null);
  assert (select email_status from public.review_checks where id = (result ->> 'id')::uuid) = 'sending', 'sending recorded first';
  perform public.record_review_email((result ->> 'id')::uuid, 'failed', 'Resend responded 429: rate limited', null);
  assert (select email_status from public.review_checks where id = (result ->> 'id')::uuid) = 'failed', 'failed recorded';
  assert (select email_error from public.review_checks where id = (result ->> 'id')::uuid) like 'Resend responded 429%', 'with the reason';
  begin
    perform public.record_review_email((result ->> 'id')::uuid, 'lost', null, null);
    raise exception 'an unknown outcome must be refused';
  exception when check_violation then null;
  end;
  perform public.record_review_email((result ->> 'id')::uuid, 'sent', null, 're_b45abc123');
  assert (select email_status from public.review_checks where id = (result ->> 'id')::uuid) = 'sent', 'sent recorded';
  assert (select email_error from public.review_checks where id = (result ->> 'id')::uuid) is null, 'the failure is cleared';
end $$;
select set_config('request.jwt.claim.sub', 'a3100450-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
begin
  perform public.record_review_email((select id from b45_ids where name = 'mail_check'), 'failed', 'x', null);
  raise exception 'a Viewer must not record the email';
exception when insufficient_privilege then null;
end $$;
reset role;
do $$
begin
  assert (select provider_message_id from public.review_checks where id = (select id from b45_ids where name = 'mail_check')) = 're_b45abc123',
    'Resend''s id is kept (not client-readable)';
end $$;
set role service_role;
do $$
declare
  result jsonb;
begin
  result := public.record_email_event('re_b45abc123', 'email.delivered', now(), null, null);
  assert result ->> 'status' = 'delivered' and (result ->> 'review')::boolean, 'a review email''s event is recognised';
  result := public.record_email_event('re_b45abc123', 'email.bounced', now(), 'Permanent', 'General');
  assert result ->> 'status' = 'bounced', 'bounced';
  result := public.record_email_event('re_b45abc123', 'email.delivered', now(), null, null);
  assert result ->> 'status' = 'delivered', 'a weaker event is answered but doesn''t replace the stronger one';
  assert public.record_email_event('re_b45unknown', 'email.delivered', now(), null, null) ->> 'status' = 'unknown',
    'unknown ids are still unknown';
end $$;
reset role;
do $$
begin
  assert (select delivery_status from public.review_checks where id = (select id from b45_ids where name = 'mail_check')) = 'bounced',
    'the strongest event wins';
  assert exists (
    select 1 from public.email_suppressions s
    where s.email = 'bounce@example.org' and s.cleared_at is null and s.reason = 'bounced' and s.email_kind = 'review_check'
  ), 'a permanent bounce suppresses the address';
end $$;

-- 9. "Copy review link": its own link opens the round; the emailed link keeps working; Send again replaces it.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100450-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  copied text;
begin
  copied := public.review_check_copy_link((select id from b45_ids where name = 'mail_check'));
  assert copied like 'alhc_rev_%', 'a review link token';
  insert into b45_tokens values ('copied', copied);
end $$;
select set_config('request.jwt.claim.sub', 'a3100450-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
begin
  perform public.review_check_copy_link((select id from b45_ids where name = 'mail_check'));
  raise exception 'a Viewer must not copy the link';
exception when insufficient_privilege then null;
end $$;
reset role;
do $$
begin
  assert (public.review_check_by_token((select token from b45_tokens where name = 'copied'))).id
    = (select id from b45_ids where name = 'mail_check'), 'the copied link opens the same round';
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100450-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  perform public.rotate_review_check_token((select id from b45_ids where name = 'mail_check'));
  begin
    perform public.review_check_copy_link((select id from b45_ids where name = 'par_check'));
    raise exception 'a decided round''s link can''t be copied';
  exception when check_violation then null;
  end;
end $$;
reset role;
do $$
begin
  assert (public.review_check_by_token((select token from b45_tokens where name = 'copied'))).id is null,
    'Send again replaced the copied link too';
end $$;

-- 10. Review round 1 fixes.
-- par4 (parallel): the team approves, then the outside reviewer asks for changes — the team's approval no longer
-- counts (that round ends too), so a later outside approval alone doesn't run "When it's approved".
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100450-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  result jsonb;
begin
  perform public.send_for_approval((select id from b45_ids where name = 'par4'), 'Final copy', null, false, 'complete', null);
  result := public.create_review_check((select id from b45_ids where name = 'par4'),
    array[(select id from b45_ids where name = 'par4_file')], 'client@example.org', 'Sarah K.', null);
  insert into b45_tokens values ('par4', result ->> 'token');
end $$;
select set_config('request.jwt.claim.sub', 'a3100450-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
begin
  perform public.decide_approval(
    (select q.id from public.approval_requests q where q.task_id = (select id from b45_ids where name = 'par4') and q.status = 'pending'),
    'approved', null);
end $$;
set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
do $$
begin
  perform public.review_check_decide((select token from b45_tokens where name = 'par4'), 'changes_requested', 'Wrong photo');
end $$;
reset role;
do $$
declare
  r public.approval_rounds;
begin
  select * into r from public.approval_rounds where task_id = (select id from b45_ids where name = 'par4') order by round_number desc limit 1;
  assert r.status = 'withdrawn' and r.closed_reason = 'outside_changes',
    'the team''s approved round ends with the outside changes (it was still waiting on the outside reviewer)';
  assert exists (select 1 from public.approval_requests q where q.round_id = r.id and q.status = 'approved'),
    'the approver''s decision stays in the history';
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100450-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  result jsonb;
begin
  result := public.create_review_check((select id from b45_ids where name = 'par4'),
    array[(select id from b45_ids where name = 'par4_file')], 'client@example.org', 'Sarah K.', null);
  insert into b45_tokens values ('par4b', result ->> 'token');
end $$;
set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
do $$
begin
  perform public.review_check_decide((select token from b45_tokens where name = 'par4b'), 'approved', null);
end $$;
reset role;
do $$
begin
  assert (select completed_at from public.tasks where id = (select id from b45_ids where name = 'par4')) is null,
    'an outside approval without the team''s approval of a new round doesn''t complete it';
end $$;

-- par5 (parallel): Cy, a Commenter who is the assignee, sends the team round and the outside review with it;
-- the team's rejection closes the outside round as a rejection.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100450-0000-4000-8000-000000000005', false) is not null as ok \gset
do $$
declare
  result jsonb;
begin
  perform public.send_for_approval((select id from b45_ids where name = 'par5'), 'Final copy', null, false, 'complete', null);
  result := public.create_review_check((select id from b45_ids where name = 'par5'),
    array[(select id from b45_ids where name = 'par5_file')], 'client@example.org', 'Sarah K.', null);
  insert into b45_ids values ('par5_check', (result ->> 'id')::uuid);
end $$;
select set_config('request.jwt.claim.sub', 'a3100450-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
begin
  perform public.decide_approval(
    (select q.id from public.approval_requests q where q.task_id = (select id from b45_ids where name = 'par5') and q.status = 'pending'),
    'rejected', 'Not this campaign');
end $$;
reset role;
do $$
begin
  assert (select status from public.review_checks where id = (select id from b45_ids where name = 'par5_check')) = 'superseded', 'closed';
  assert (select closed_reason from public.review_checks where id = (select id from b45_ids where name = 'par5_check')) = 'team_rejected',
    'as a rejection';
end $$;

-- seq2 (sequential): after the team approves, only the approver sends — and copies — the outside link; an
-- Editor who isn't the approver can't copy it. Resend's id is kept only when no other email has it.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100450-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  perform public.send_for_approval((select id from b45_ids where name = 'seq2'), 'Final copy', null, false, 'complete', null);
end $$;
select set_config('request.jwt.claim.sub', 'a3100450-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  result jsonb;
begin
  perform public.decide_approval(
    (select q.id from public.approval_requests q where q.task_id = (select id from b45_ids where name = 'seq2') and q.status = 'pending'),
    'approved', null);
  result := public.create_review_check((select id from b45_ids where name = 'seq2'),
    array[(select id from b45_ids where name = 'seq2_file')], 'client@example.org', 'Sarah K.', null);
  insert into b45_ids values ('seq2_check', (result ->> 'id')::uuid);
  perform public.record_review_email((result ->> 'id')::uuid, 'sent', null, 're_b45abc123');
  assert public.review_check_copy_link((result ->> 'id')::uuid) like 'alhc_rev_%', 'the approver copies the link';
end $$;
select set_config('request.jwt.claim.sub', 'a3100450-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  perform public.review_check_copy_link((select id from b45_ids where name = 'seq2_check'));
  raise exception 'an Editor who isn''t the approver must not copy the outside link';
exception when insufficient_privilege then null;
end $$;
reset role;
do $$
begin
  assert (select provider_message_id from public.review_checks where id = (select id from b45_ids where name = 'seq2_check')) is null,
    'an id another email already has isn''t kept';
  assert (select email_status from public.review_checks where id = (select id from b45_ids where name = 'seq2_check')) = 'sent', 'sent';
end $$;

-- Reminders: a round that isn't due yet never holds up one that is (the claim picks only due rounds).
reset role;
do $$
begin
  update public.review_checks
  set status = 'pending', nudged_at = null, nudge_attempts = 0, nudge_claimed_at = null, nudge_token_hash = null,
      created_at = now() - interval '30 hours', due_on = current_date + 10, expires_at = now() + interval '20 days'
  where id = (select id from b45_ids where name = 'par_check');
  update public.review_checks
  set created_at = now() - interval '13 hours', due_on = current_date + 1, expires_at = now() + interval '20 days'
  where id = (select id from b45_ids where name = 'seq2_check');
end $$;
set role service_role;
do $$
declare
  claimed uuid[];
begin
  select array_agg(c.review_id) into claimed from public.claim_review_nudges(1) c;
  assert claimed = array[(select id from b45_ids where name = 'seq2_check')],
    format('the due round is claimed first, not the older one that isn''t due (%s)', claimed);
end $$;
reset role;

update public.workspaces set allow_commenter_role = (select allow_commenter_role from b45_flags)
where id = '00000000-0000-4000-8000-000000000001';

do $$ begin raise notice 'nov 24 batch 45 smoke: all assertions passed'; end $$;
