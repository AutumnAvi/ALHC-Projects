-- Oct 27 notes, batch 6 (20261027020000_oct27_batch6_a.sql).
--   b6b60027…01 b6-owner@example.com    owner of B6 A and B6 B
--   b6b60027…02 b6-editor@example.com   Editor of B6 A and B6 B
--   b6b60027…03 b6-viewer@example.com   Viewer of B6 A
--   b6b60027…04 b6-approver@example.com Commenter of B6 A (approver)
--   b6b60027…05 b6-second@example.com   Editor of B6 A (second approver)

\set ON_ERROR_STOP 1

insert into public.allowed_emails (email, note) values
  ('b6-owner@example.com', 'oct 27 batch 6'),
  ('b6-editor@example.com', 'oct 27 batch 6'),
  ('b6-viewer@example.com', 'oct 27 batch 6'),
  ('b6-approver@example.com', 'oct 27 batch 6'),
  ('b6-second@example.com', 'oct 27 batch 6');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b6b60027-0000-4000-8000-000000000001', 'b6-owner@example.com', now(), '{"full_name":"Olive Owner"}'),
  ('b6b60027-0000-4000-8000-000000000002', 'b6-editor@example.com', now(), '{"full_name":"Edna Editor"}'),
  ('b6b60027-0000-4000-8000-000000000003', 'b6-viewer@example.com', now(), '{"full_name":"Vic Viewer"}'),
  ('b6b60027-0000-4000-8000-000000000004', 'b6-approver@example.com', now(), '{"full_name":"Abe Approver"}'),
  ('b6b60027-0000-4000-8000-000000000005', 'b6-second@example.com', now(), '{"full_name":"Sam Second"}');

-- The local harness turns the Commenter role on for older suites; keep it on here too.
update public.workspaces set allow_commenter_role = true where id = '00000000-0000-4000-8000-000000000001';

create temporary table b6_ids (name text primary key, id uuid);
grant all on b6_ids to authenticated, anon;

-- ---------------------------------------------------------------------------------------------
-- Setup: B6 A (numbered "A-{n}", reuses freed numbers) and B6 B (numbered "B-{n}")
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'b6b60027-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  a uuid;
  b uuid;
  sa uuid;
  sa2 uuid;
  sb uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B6 A') returning id into a;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B6 B') returning id into b;
  insert into public.sections (project_id, name, sort_order) values (a, 'Intake', 1024) returning id into sa;
  insert into public.sections (project_id, name, sort_order) values (a, 'Done', 2048) returning id into sa2;
  insert into public.sections (project_id, name, sort_order) values (b, 'Inbox', 1024) returning id into sb;
  insert into b6_ids values ('a', a), ('b', b), ('sa', sa), ('sa2', sa2), ('sb', sb);
  perform public.add_project_member(a, 'b6-editor@example.com', 'editor');
  perform public.add_project_member(b, 'b6-editor@example.com', 'editor');
  perform public.add_project_member(a, 'b6-viewer@example.com', 'viewer');
  perform public.add_project_member(a, 'b6-approver@example.com', 'commenter');
  perform public.add_project_member(a, 'b6-second@example.com', 'editor');
  perform public.apply_task_numbering(a,
    '{"enabled": true, "number_scope": "all_tasks", "template": "A-{n}", "reuse_deleted": true}'::jsonb, 'save');
  perform public.apply_task_numbering(b,
    '{"enabled": true, "number_scope": "all_tasks", "template": "B-{n}"}'::jsonb, 'save');
end $$;

-- ---------------------------------------------------------------------------------------------
-- 40. Adding a subtask in a project that reuses freed numbers (it used to fail with
--     'column reference "number" is ambiguous'), and the freed subtask index is reused.
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'b6b60027-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b6_ids where name = 'a');
  t uuid;
  c1 uuid;
  c2 uuid;
  c3 uuid;
begin
  assert (select reuse_deleted from public.request_sequences where project_id = a), 'reuse is on';
  t := public.create_task(a, (select id from b6_ids where name = 'sa'), 'Parent 40');
  insert into b6_ids values ('t40', t);
  assert (select req_label from public.tasks where id = t) = 'A-1', 'parent numbered';
  c1 := public.create_subtask(t, 'First child', null);
  c2 := public.create_subtask(t, 'Second child', null);
  assert (select req_label from public.tasks where id = c1) = 'A-1.1', 'first child numbered';
  assert (select req_label from public.tasks where id = c2) = 'A-1.2', 'second child numbered';
  -- Trash the first; its index is freed and the next subtask takes it.
  update public.tasks set deleted_at = now() where id = c1;
  c3 := public.create_subtask(t, 'Third child', null);
  assert (select req_subindex from public.tasks where id = c3) = 1, 'the freed index is reused';
  assert (select req_label from public.tasks where id = c3) = 'A-1.1', 'labelled with it';
  -- A sub-subtask too.
  c1 := public.create_subtask(c3, 'Grandchild', null);
  assert (select req_label from public.tasks where id = c1) = 'A-1.1.1', 'nested subtasks number as well';
end $$;
reset role;

-- ---------------------------------------------------------------------------------------------
-- 39. Each project numbers the tasks it holds; outside projects the home project's number shows.
-- ---------------------------------------------------------------------------------------------

do $$
begin
  assert (select relrowsecurity from pg_class where oid = 'public.task_project_numbers'::regclass), 'RLS on';
  assert not has_table_privilege('anon', 'public.task_project_numbers', 'SELECT'), 'nothing for anon';
  assert not has_table_privilege('authenticated', 'public.task_project_numbers', 'INSERT')
    and not has_table_privilege('authenticated', 'public.task_project_numbers', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.task_project_numbers', 'TRUNCATE'), 'no client writes';
  assert not (select prosecdef from pg_proc where oid = 'public.task_request_labels_in(uuid, uuid[])'::regprocedure), 'invoker';
  assert not has_function_privilege('authenticated', 'public.ensure_project_number(uuid, uuid)', 'execute'), 'internal';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b6b60027-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b6_ids where name = 'a');
  b uuid := (select id from b6_ids where name = 'b');
  t uuid;
  t40 uuid := (select id from b6_ids where name = 't40');
  child uuid;
  labels jsonb;
  hits integer;
begin
  t := public.create_task(a, (select id from b6_ids where name = 'sa'), 'Shared brief');
  insert into b6_ids values ('shared', t);
  assert (select req_label from public.tasks where id = t) = 'A-2', 'numbered by its home project';

  -- Added to B: B gives it B's next number, with B's template.
  insert into public.task_projects (task_id, project_id, section_id, sort_order)
  values (t, b, (select id from b6_ids where name = 'sb'), 1024);
  assert (select req_label from public.task_project_numbers where task_id = t and project_id = b) = 'B-1', 'B numbers it';
  assert (select req_label from public.task_project_numbers where task_id = t and project_id = a) = 'A-2',
    'the home number is mirrored';
  assert (select req_label from public.tasks where id = t) = 'A-2', 'the task itself keeps its home number';

  -- Inside B: B's number; inside A: A's; outside: the home project's.
  assert public.task_request_labels_in(b, array[t]) -> t::text ->> 'label' = 'B-1', 'B shows B-1';
  assert public.task_request_labels_in(a, array[t]) -> t::text ->> 'label' = 'A-2', 'A shows A-2';
  assert public.task_request_labels(array[t]) -> t::text ->> 'label' = 'A-2', 'outside: the home number';

  -- Search finds it by either number.
  select count(*) into hits from public.search_tasks('B-1', 20) s where s.id = t;
  assert hits = 1, 'found by its B number';
  select count(*) into hits from public.search_tasks('A-2', 20) s where s.id = t;
  assert hits = 1, 'found by its A number';
  select count(*) into hits from public.filter_project_tasks(b, '{"text": "B-1"}'::jsonb, 'UTC') f where f.task_id = t;
  assert hits = 1, 'a view''s search finds B''s number';

  -- Removing it from B and adding it back keeps B-1 (never renumbered); B's counter didn't move.
  update public.task_projects set deleted_at = now() where task_id = t and project_id = b;
  update public.task_projects set deleted_at = null where task_id = t and project_id = b;
  assert (select req_label from public.task_project_numbers where task_id = t and project_id = b) = 'B-1', 'kept B-1';
  assert (select last_number from public.request_sequences where project_id = b) = 1, 'no second number';

  -- Subtasks inside B: the parent's B number, then the subtask's own index.
  insert into public.task_projects (task_id, project_id, section_id, sort_order)
  values (t40, b, (select id from b6_ids where name = 'sb'), 2048);
  assert (select req_label from public.task_project_numbers where task_id = t40 and project_id = b) = 'B-2', 'parent in B';
  select id into child from public.tasks where parent_task_id = t40 and title = 'Second child';
  labels := public.task_request_labels_in(b, array[child]);
  assert labels -> child::text ->> 'label' = 'B-2.2', 'subtask shows B''s path: ' || coalesce(labels::text, 'null');
  assert public.task_request_labels_in(a, array[child]) -> child::text ->> 'label' = 'A-1.2', 'A keeps its path';

  -- Make home B: the task's outside number becomes B-1; A-2 stays A's.
  update public.tasks set home_project_id = b where id = t;
  assert (select req_label from public.tasks where id = t) = 'B-1', 'home number moved onto the task';
  assert (select req_project_id from public.tasks where id = t) = b, 'issued by B';
  assert public.task_request_labels_in(a, array[t]) -> t::text ->> 'label' = 'A-2', 'A still shows A-2';
  assert (select last_number from public.request_sequences where project_id = b) = 2, 'still nothing renumbered';
end $$;

-- A Viewer of A only reads A's numbers (B's row needs B).
select set_config('request.jwt.claim.sub', 'b6b60027-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b6_ids where name = 'shared');
begin
  assert (select count(*) from public.task_project_numbers where task_id = t) = 1, 'only A''s row';
  assert (select req_label from public.task_project_numbers where task_id = t) = 'A-2', 'A-2';
end $$;

-- Renumber all in B renumbers B's own tasks first, then other projects' tasks in B.
select set_config('request.jwt.claim.sub', 'b6b60027-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  b uuid := (select id from b6_ids where name = 'b');
  t uuid := (select id from b6_ids where name = 'shared');
  t40 uuid := (select id from b6_ids where name = 't40');
begin
  perform public.apply_task_numbering(b, '{"confirmation": "RENUMBER"}'::jsonb, 'renumber');
  assert (select req_label from public.tasks where id = t) = 'B-1', 'B''s own task first';
  assert (select req_label from public.task_project_numbers where task_id = t40 and project_id = b) = 'B-2', 'then A''s task';
  assert (select count(distinct req_number) from public.task_project_numbers where project_id = b)
       = (select count(*) from public.task_project_numbers where project_id = b), 'no duplicates';
end $$;

-- Converting: a subtask that becomes a task is numbered by its project (its old path is dropped, its own
-- subtasks follow); a task that becomes a subtask keeps its number.
select set_config('request.jwt.claim.sub', 'b6b60027-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b6_ids where name = 'a');
  t40 uuid := (select id from b6_ids where name = 't40');
  third uuid;
  grand uuid;
  label text;
begin
  select id into third from public.tasks where parent_task_id = t40 and title = 'Third child';
  select id into grand from public.tasks where parent_task_id = third;
  perform public.convert_to_task(third, a, null);
  select req_label into label from public.tasks where id = third;
  assert label ~ '^A-[0-9]+$', 'numbered as a task: ' || coalesce(label, 'null');
  assert (select req_subindex from public.tasks where id = third) is null, 'no subtask index';
  assert (select req_label from public.tasks where id = grand) = label || '.1', 'its subtask follows';

  perform public.convert_to_subtask(third, t40);
  assert (select req_label from public.tasks where id = third) = label, 'a task keeps its number as a subtask';
end $$;
reset role;

-- ---------------------------------------------------------------------------------------------
-- 45 / 45b. Approval tasks: separate approvers, Ready for approval, decisions, pause, withdraw,
-- hand off, reassign, reminders, filters.
-- ---------------------------------------------------------------------------------------------

do $$
begin
  assert (select relrowsecurity from pg_class where oid = 'public.approval_rounds'::regclass)
     and (select relrowsecurity from pg_class where oid = 'public.task_approvers'::regclass)
     and (select relrowsecurity from pg_class where oid = 'public.task_approval_settings'::regclass), 'RLS on';
  assert not has_table_privilege('authenticated', 'public.approval_rounds', 'INSERT')
     and not has_table_privilege('authenticated', 'public.task_approvers', 'UPDATE')
     and not has_table_privilege('authenticated', 'public.task_approval_settings', 'INSERT'), 'no client writes';
  assert not has_table_privilege('anon', 'public.approval_rounds', 'SELECT'), 'nothing for anon';
  assert not has_function_privilege('authenticated', 'public.approval_reminders_tick()', 'execute'), 'internal';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b6b60027-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b6_ids where name = 'a');
  t uuid;
begin
  t := public.create_task(a, (select id from b6_ids where name = 'sa'), 'Logo approval');
  insert into b6_ids values ('ap', t);
  update public.tasks set kind = 'approval', assignee_id = 'b6b60027-0000-4000-8000-000000000002' where id = t;
  -- Assigning an approval task no longer asks the assignee to approve it.
  assert not exists (select 1 from public.approval_requests where task_id = t), 'no request from assigning';
  assert public.task_approval_state(t) ->> 'status' = 'not_sent', 'not sent yet';

  -- Approvers need Commenter+; a Viewer can't approve.
  begin
    perform public.set_task_approvers(t, array['b6b60027-0000-4000-8000-000000000003'::uuid], 'any', null);
    raise exception 'a Viewer can''t approve';
  exception when check_violation then null;
  end;
  perform public.set_task_approvers(t,
    array['b6b60027-0000-4000-8000-000000000004'::uuid, 'b6b60027-0000-4000-8000-000000000005'::uuid], 'all', null);
  assert (select count(*) from public.task_approvers where task_id = t and deleted_at is null) = 2, 'two approvers';

  -- Ready for approval needs final text or a file.
  begin
    perform public.send_for_approval(t, '   ', '{}', false, 'complete', null);
    raise exception 'final assets are required';
  exception when check_violation then null;
  end;
  perform public.send_for_approval(t, 'Final logo copy, v3', '{}', false, 'complete', null);
  assert public.task_approval_state(t) ->> 'status' = 'pending', 'pending';
  assert (select count(*) from public.approval_requests r join public.approval_rounds x on x.id = r.round_id
          where x.task_id = t and r.status = 'pending') = 2, 'one request per approver';
  assert not (public.task_approval_state(t) ->> 'waiting_on_me')::boolean, 'not waiting on the assignee';

  -- Nobody completes it while it's pending.
  begin
    update public.tasks set completed_at = now() where id = t;
    raise exception 'completing a pending approval task is refused';
  exception when check_violation then null;
  end;
  -- Sending twice is refused.
  begin
    perform public.send_for_approval(t, 'again', '{}', false, 'complete', null);
    raise exception 'already pending';
  exception when check_violation then null;
  end;
end $$;

-- The first approver sees it waiting on them (and in a view filter), and Request changes needs a note.
select set_config('request.jwt.claim.sub', 'b6b60027-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b6_ids where name = 'ap');
  req uuid;
begin
  assert (public.task_approval_state(t) ->> 'waiting_on_me')::boolean, 'waiting on the approver';
  assert exists (
    select 1 from public.filter_project_tasks((select id from b6_ids where name = 'a'), '{"approval": ["waiting_on_me"]}'::jsonb, 'UTC') f
    where f.task_id = t
  ), 'the Waiting on me filter finds it';
  select id into req from public.approval_requests
  where task_id = t and approver_id = 'b6b60027-0000-4000-8000-000000000004' and status = 'pending';
  begin
    perform public.decide_approval(req, 'changes_requested', '  ');
    raise exception 'a note is required';
  exception when check_violation then null;
  end;
  perform public.decide_approval(req, 'changes_requested', 'Use the darker green');
  assert public.task_approval_state(t) ->> 'status' = 'changes_requested', 'changes requested';
  assert (public.task_approval_state(t) ->> 'paused')::boolean, 'paused until the assignee acknowledges';
  assert (select status from public.approval_requests
          where task_id = t and approver_id = 'b6b60027-0000-4000-8000-000000000005' and round_id is not null) = 'cancelled',
    'the other approver''s request closed with the round';
  assert (select completed_at from public.tasks where id = t) is null, 'Request changes never completes';
end $$;

-- The assignee marks the feedback received, then sends round 2; everyone must approve.
select set_config('request.jwt.claim.sub', 'b6b60027-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b6_ids where name = 'ap');
begin
  begin
    perform public.send_for_approval(t, 'v4', '{}', false, 'complete', null);
    raise exception 'acknowledge first';
  exception when check_violation then null;
  end;
  perform public.acknowledge_approval(t);
  assert not (public.task_approval_state(t) ->> 'paused')::boolean, 'not paused';
  assert exists (select 1 from public.task_stories where task_id = t and kind = 'approval_resubmitted'
                 and data ->> 'event' = 'acknowledged'), 'logged';
  perform public.send_for_approval(t, 'Final logo copy, v4', '{}', false, 'complete', null);
  assert (public.task_approval_state(t) ->> 'round_number')::int = 2, 'round 2';
end $$;

select set_config('request.jwt.claim.sub', 'b6b60027-0000-4000-8000-000000000004', false) is not null as ok \gset
select public.decide_approval((select id from public.approval_requests where task_id = (select id from b6_ids where name = 'ap')
  and approver_id = 'b6b60027-0000-4000-8000-000000000004' and status = 'pending'), 'approved', null);
do $$
begin
  assert public.task_approval_state((select id from b6_ids where name = 'ap')) ->> 'status' = 'pending', 'still waiting on everyone';
end $$;
select set_config('request.jwt.claim.sub', 'b6b60027-0000-4000-8000-000000000005', false) is not null as ok \gset
select public.decide_approval((select id from public.approval_requests where task_id = (select id from b6_ids where name = 'ap')
  and approver_id = 'b6b60027-0000-4000-8000-000000000005' and status = 'pending'), 'approved', 'Looks great');
do $$
declare
  t uuid := (select id from b6_ids where name = 'ap');
begin
  assert public.task_approval_state(t) ->> 'status' = 'approved', 'approved';
  assert (select completed_at from public.tasks where id = t) is not null, 'Approve (no More steps) completes it';
end $$;

-- More steps: approval moves the task to a section and leaves it open; Reject never completes; Withdraw;
-- Hand off; Reassign (Owners / Admins only while pending).
select set_config('request.jwt.claim.sub', 'b6b60027-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b6_ids where name = 'a');
  done_section uuid := (select id from b6_ids where name = 'sa2');
  t uuid;
  r2 uuid;
begin
  t := public.create_task(a, (select id from b6_ids where name = 'sa'), 'Banner approval');
  insert into b6_ids values ('ap2', t);
  update public.tasks set kind = 'approval' where id = t;
  perform public.set_task_approvers(t, array['b6b60027-0000-4000-8000-000000000004'::uuid], 'any', null);
  -- The section has to be one of the task's projects'.
  begin
    perform public.send_for_approval(t, 'Banner', '{}', true, 'move_section', (select id from b6_ids where name = 'sb'));
    raise exception 'B''s section isn''t this task''s';
  exception when check_violation then null;
  end;
  perform public.send_for_approval(t, 'Banner', '{}', true, 'move_section', done_section);

  -- An Editor who isn't an Owner / Admin can't swap approvers or change how they decide while it's
  -- pending; the approval due date is still theirs to change.
  begin
    perform public.set_task_approvers(t, array['b6b60027-0000-4000-8000-000000000005'::uuid], 'any', null);
    raise exception 'reassigning needs an Owner or Admin';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.set_task_approvers(t, array['b6b60027-0000-4000-8000-000000000004'::uuid], 'all', null);
    raise exception 'changing the mode mid-round needs an Owner or Admin';
  exception when insufficient_privilege then null;
  end;
  perform public.set_task_approvers(t, array['b6b60027-0000-4000-8000-000000000004'::uuid], 'any', current_date + 3);
  assert (select due_on from public.approval_rounds where task_id = t and status = 'pending') = current_date + 3,
    'the due date follows to the pending round';

  -- Withdraw, then send again.
  perform public.withdraw_approval(t);
  assert public.task_approval_state(t) ->> 'status' = 'not_sent', 'withdrawn = not sent';
  assert exists (select 1 from public.task_stories where task_id = t and kind = 'approval_cancelled'
                 and data ->> 'reason' = 'withdrawn'), 'withdrawal logged';
  perform public.send_for_approval(t, 'Banner v2', '{}', true, 'move_section', done_section);
end $$;

-- The approver hands off to the second approver with a note.
select set_config('request.jwt.claim.sub', 'b6b60027-0000-4000-8000-000000000004', false) is not null as ok \gset
select public.hand_off_approval((select id from b6_ids where name = 'ap2'), 'b6b60027-0000-4000-8000-000000000005', 'I''m out Friday');
do $$
declare
  t uuid := (select id from b6_ids where name = 'ap2');
begin
  assert not exists (select 1 from public.task_approvers where task_id = t and deleted_at is null
                     and profile_id = 'b6b60027-0000-4000-8000-000000000004'), 'no longer an approver';
  assert exists (select 1 from public.approval_requests where task_id = t and status = 'pending'
                 and approver_id = 'b6b60027-0000-4000-8000-000000000005'), 'the new approver decides';
  assert exists (select 1 from public.task_stories where task_id = t and kind = 'approval_cancelled'
                 and data ->> 'reason' = 'handed_off' and data ->> 'note' = 'I''m out Friday'), 'handoff logged with its note';
end $$;

-- The Owner reassigns it back (anytime), then the approver approves: moved to Done, still open.
select set_config('request.jwt.claim.sub', 'b6b60027-0000-4000-8000-000000000001', false) is not null as ok \gset
select public.set_task_approvers((select id from b6_ids where name = 'ap2'), array['b6b60027-0000-4000-8000-000000000004'::uuid], 'any', null);
select set_config('request.jwt.claim.sub', 'b6b60027-0000-4000-8000-000000000004', false) is not null as ok \gset
select public.decide_approval((select id from public.approval_requests where task_id = (select id from b6_ids where name = 'ap2')
  and approver_id = 'b6b60027-0000-4000-8000-000000000004' and status = 'pending'), 'approved', null);
do $$
declare
  t uuid := (select id from b6_ids where name = 'ap2');
begin
  assert public.task_approval_state(t) ->> 'status' = 'approved', 'approved';
  assert (select completed_at from public.tasks where id = t) is null, 'More steps: not completed';
  assert (select section_id from public.task_projects where task_id = t and project_id = (select id from b6_ids where name = 'a'))
       = (select id from b6_ids where name = 'sa2'), 'moved to Done';
end $$;

-- Reject: back to the assignee, paused, open.
select set_config('request.jwt.claim.sub', 'b6b60027-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid;
begin
  t := public.create_task((select id from b6_ids where name = 'a'), (select id from b6_ids where name = 'sa'), 'Flyer approval');
  insert into b6_ids values ('ap3', t);
  update public.tasks set kind = 'approval' where id = t;
  perform public.set_task_approvers(t, array['b6b60027-0000-4000-8000-000000000004'::uuid], 'any', current_date + 1);
  perform public.send_for_approval(t, 'Flyer', '{}', false, 'complete', null);
end $$;
reset role;
-- Reminders: the day before the approval due date (once).
do $$
declare
  t uuid := (select id from b6_ids where name = 'ap3');
begin
  assert public.approval_reminders_tick() >= 1, 'a nudge went out';
  assert exists (select 1 from public.inbox_items where task_id = t and kind = 'approval_requested'
                 and recipient_id = 'b6b60027-0000-4000-8000-000000000004' and data ->> 'reminder' = 'due_soon'), 'due-soon nudge';
  assert public.approval_reminders_tick() = 0, 'only once';
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub', 'b6b60027-0000-4000-8000-000000000004', false) is not null as ok \gset
select public.decide_approval((select id from public.approval_requests where task_id = (select id from b6_ids where name = 'ap3')
  and status = 'pending'), 'rejected', null);
do $$
declare
  t uuid := (select id from b6_ids where name = 'ap3');
  cards jsonb;
begin
  assert public.task_approval_state(t) ->> 'status' = 'rejected', 'rejected';
  assert (public.task_approval_state(t) ->> 'paused')::boolean, 'paused';
  assert (select completed_at from public.tasks where id = t) is null, 'Reject never completes';
  cards := public.project_task_cards((select id from b6_ids where name = 'a'), array[t]);
  assert cards -> 0 ->> 'approval_status' = 'rejected' and (cards -> 0 ->> 'approval_paused')::boolean, 'cards carry it';
  begin
    perform public.validate_view_filters((select id from b6_ids where name = 'a'), '{"approval": ["maybe"]}'::jsonb);
    raise exception 'unknown approval filters are refused';
  exception when check_violation then null;
  end;
end $$;
reset role;

-- ---------------------------------------------------------------------------------------------
-- 41-44. Expanded rows, the parent picker, blockers, the dependency-shift setting.
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'b6b60027-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b6_ids where name = 'a');
  t40 uuid := (select id from b6_ids where name = 't40');
  shared uuid := (select id from b6_ids where name = 'shared');
  first uuid;
  second uuid;
  info jsonb;
begin
  -- 41. Remembered per person, newest first, no duplicates.
  assert public.set_task_row_expanded(t40, true) = array[t40], 'expanded';
  assert public.set_task_row_expanded(shared, true) = array[shared, t40], 'newest first';
  assert public.set_task_row_expanded(t40, true) = array[t40, shared], 'no duplicates';
  assert public.set_task_row_expanded(t40, false) = array[shared], 'collapsed';

  -- 42. Candidates: tasks the caller edits, never the task itself or its own subtasks.
  first := public.create_task(a, (select id from b6_ids where name = 'sa'), 'Picker parent');
  assert exists (select 1 from public.subtask_parent_candidates(t40, 'Picker', 10) c where c.id = first), 'found by name';
  assert not exists (select 1 from public.subtask_parent_candidates(t40, 'child', 10) c
                     where c.parent_task_id = t40 or c.id = t40), 'not its own subtasks';
  assert exists (select 1 from public.subtask_parent_candidates(t40, '', 30) c where c.id = first), 'blank: its projects'' tasks';

  -- 43. Blockers: the count and the list (finish-to-finish holds completion too).
  second := public.create_task(a, (select id from b6_ids where name = 'sa'), 'Blocked one');
  perform public.set_task_dependency(first, second, 'finish_to_finish', 0);
  info := public.task_open_blockers(second);
  assert (info ->> 'total')::int = 1, 'one open blocker';
  assert info -> 'blockers' -> 0 ->> 'id' = first::text, 'listed with its id';
  assert (public.project_task_cards(a, array[second]) -> 0 ->> 'blocked_by')::int = 1, 'cards count finish-to-finish';
  assert (public.open_blocker_counts(array[second, first]) ->> second::text)::int = 1, 'bulk counts';
  assert public.open_blocker_counts(array[first]) = '{}'::jsonb, 'unblocked tasks are left out';
  begin
    update public.tasks set completed_at = now() where id = second;
    raise exception 'blocked tasks can''t be completed';
  exception when check_violation then null;
  end;

  -- 44. Ask me by default; Admins+ change it like other project settings.
  assert public.dependency_shift_mode(array[second]) = 'ask', 'Ask me by default';
end $$;
select set_config('request.jwt.claim.sub', 'b6b60027-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b6_ids where name = 'a');
  b uuid := (select id from b6_ids where name = 'b');
  only_b uuid;
begin
  update public.projects set dependency_shift = 'auto' where id = a;
  assert public.dependency_shift_mode(array[(select id from b6_ids where name = 't40')]) = 'auto', 'auto';
  update public.projects set dependency_shift = 'off' where id = b;
  -- Oct 29 notes (55b): no home project — a task's first project decides ("shared" was made in A, then
  -- its home was moved to B).
  assert public.dependency_shift_mode(array[(select id from b6_ids where name = 'shared')]) = 'auto', 'A decides, not the old home B';
  update public.projects set dependency_shift = 'off' where id = a;
  update public.projects set dependency_shift = 'auto' where id = b;
  assert public.dependency_shift_mode(array[(select id from b6_ids where name = 'shared')]) = 'off', 'off (its first project is A)';
  only_b := public.create_task(b, (select id from b6_ids where name = 'sb'), 'Only in B');
  assert public.dependency_shift_mode(array[(select id from b6_ids where name = 'shared'), only_b]) = 'auto',
    'Off only when every task''s project is off';
  update public.projects set dependency_shift = 'auto' where id = a;
  begin
    update public.projects set dependency_shift = 'sometimes' where id = a;
    raise exception 'unknown modes are refused';
  exception when check_violation then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', 'b6b60027-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  -- An Editor can't change it (RLS: projects_update_admin touches nothing).
  update public.projects set dependency_shift = 'ask' where id = (select id from b6_ids where name = 'a');
  assert (select dependency_shift from public.projects where id = (select id from b6_ids where name = 'a')) = 'auto', 'unchanged';
end $$;
reset role;

do $$
begin
  raise notice 'oct 27 batch 6 smoke: all assertions passed';
end $$;
