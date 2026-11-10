-- Nov 10 batch 36 (20261110010000_nov10_batch36_a.sql): the audit fixes and the approval rework.
--   a3100360…01 b36-owner@example.com     Bo Owner     (owns P)
--   a3100360…02 b36-editor@example.com    Ed Editor    (Editor of P, the approval task's assignee)
--   a3100360…03 b36-approver@example.com  Al Approver  (Editor of P, the approval task's approver)
--   a3100360…04 b36-solo@example.com      So Solo      (owns a project nobody else is in)
--   a3100360…05 b36-viewer@example.com    Vi Viewer    (Viewer of P)

\set ON_ERROR_STOP 1

create temporary table b36_ids (name text primary key, id uuid) on commit preserve rows;
create temporary table b36_tokens (name text primary key, token text) on commit preserve rows;
grant all on b36_ids, b36_tokens to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('b36-owner@example.com', 'batch 36'), ('b36-editor@example.com', 'batch 36'), ('b36-approver@example.com', 'batch 36'),
  ('b36-solo@example.com', 'batch 36'), ('b36-viewer@example.com', 'batch 36');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a3100360-0000-4000-8000-000000000001', 'b36-owner@example.com', now(), '{"full_name":"Bo Owner"}'),
  ('a3100360-0000-4000-8000-000000000002', 'b36-editor@example.com', now(), '{"full_name":"Ed Editor"}'),
  ('a3100360-0000-4000-8000-000000000003', 'b36-approver@example.com', now(), '{"full_name":"Al Approver"}'),
  ('a3100360-0000-4000-8000-000000000004', 'b36-solo@example.com', now(), '{"full_name":"So Solo"}'),
  ('a3100360-0000-4000-8000-000000000005', 'b36-viewer@example.com', now(), '{"full_name":"Vi Viewer"}');

-- 0. Grants: the new table has nothing for anon; the reminder claims are the service role's only; the send
--    check helpers are internal.
do $$
begin
  assert not has_table_privilege('anon', 'public.task_review_settings', 'select'), 'anon: nothing on task_review_settings';
  assert not has_table_privilege('authenticated', 'public.task_review_settings', 'truncate'), 'no client truncate';
  assert not has_column_privilege('authenticated', 'public.review_checks', 'nudge_token_hash', 'select'), 'the reminder link''s hash stays unreadable';
  assert has_column_privilege('authenticated', 'public.review_checks', 'nudged_at', 'select'), 'whether a reminder went out is readable';
  assert has_function_privilege('service_role', 'public.claim_review_nudges(integer)', 'execute'), 'service role claims reminders';
  assert not has_function_privilege('authenticated', 'public.claim_review_nudges(integer)', 'execute'), 'clients don''t';
  assert not has_function_privilege('anon', 'public.claim_review_nudges(integer)', 'execute'), 'anon doesn''t';
  assert not has_function_privilege('authenticated', 'public.finish_review_nudge(uuid,boolean)', 'execute'), 'finish is the service role''s';
  assert not has_function_privilege('authenticated', 'public.review_check_send_problem(uuid)', 'execute'), 'internal';
  assert not has_function_privilege('authenticated', 'public.review_check_after_approval(uuid)', 'execute'), 'internal';
  assert not has_function_privilege('anon', 'public.set_task_external_reviewer(uuid,text,text)', 'execute'), 'anon: no reviewer setting';
  assert exists (select 1 from pg_policies where tablename = 'rules' and policyname = 'rules_insert_editor'), 'renamed policy';
  assert exists (select 1 from pg_policies where tablename = 'forms' and policyname = 'forms_update_editor'), 'renamed policy';
end $$;

-- P: the owner's project with an Editor, the approver (also an Editor), and a Viewer.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100360-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid;
  s uuid;
  t uuid;
  plain uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B36 Requests') returning id into p;
  insert into public.sections (project_id, name) values (p, 'Doing') returning id into s;
  perform public.add_project_member(p, 'b36-editor@example.com', 'editor');
  perform public.add_project_member(p, 'b36-approver@example.com', 'editor');
  perform public.add_project_member(p, 'b36-viewer@example.com', 'viewer');
  t := public.create_task(p, s, 'B36 brochure');
  plain := public.create_task(p, s, 'B36 plain task');
  update public.tasks set kind = 'approval', assignee_id = 'a3100360-0000-4000-8000-000000000002' where id = t;
  update public.tasks set assignee_id = 'a3100360-0000-4000-8000-000000000002' where id = plain;
  perform public.set_task_approvers(t, array['a3100360-0000-4000-8000-000000000003']::uuid[], 'any', null);
  insert into b36_ids values ('p', p), ('s', s), ('t', t), ('plain', plain);
  insert into public.task_attachments (task_id, storage_path, file_name, content_type, size_bytes)
  values (t, t::text || '/b36-brochure.pdf', 'brochure.pdf', 'application/pdf', 1000) returning id into s;
  insert into b36_ids values ('a1', s);
  insert into public.task_attachments (task_id, storage_path, file_name, content_type, size_bytes)
  values (plain, plain::text || '/b36-poster.png', 'poster.png', 'image/png', 1000) returning id into s;
  insert into b36_ids values ('a2', s);
  -- An "approval decided" automation: an external review's answer must not run it.
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values (p, 'B36 approval decided', true, 'approval_decided', '[{"type":"add_comment","body":"approval automation ran"}]');
end $$;

-- 1. Owners and Editors build automations and forms (and dry-run them); Viewers don't.
select set_config('request.jwt.claim.sub', 'a3100360-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b36_ids where name = 'p');
  r uuid;
  n int;
begin
  insert into public.rules (project_id, name, trigger_type, actions)
  values (p, 'B36 editor automation', 'task_created', '[{"type":"add_followers","people":["assignee"]}]') returning id into r;
  update public.rules set name = 'B36 editor automation (renamed)' where id = r;
  get diagnostics n = row_count;
  assert n = 1, 'an Editor changes an automation';
  assert public.test_rule(r, (select id from b36_ids where name = 'plain')) is not null, 'an Editor dry-runs it';
  insert into public.forms (project_id, title) values (p, 'B36 editor form');
  update public.forms set title = 'B36 editor form (renamed)' where project_id = p and title = 'B36 editor form';
  get diagnostics n = row_count;
  assert n = 1, 'an Editor changes a form';
  assert (select coalesce(f ->> 'send_confirmation', 'missing') from public.get_public_form(
    (select id from public.forms where project_id = p and deleted_at is null limit 1)) f) in ('true', 'false'),
    'the public form says whether it sends a confirmation (C34)';
end $$;
select set_config('request.jwt.claim.sub', 'a3100360-0000-4000-8000-000000000005', false) is not null as ok \gset
do $$
begin
  begin
    insert into public.rules (project_id, name, trigger_type, actions)
    values ((select id from b36_ids where name = 'p'), 'B36 viewer automation', 'task_created', '[{"type":"add_followers","people":["assignee"]}]');
    raise exception 'a Viewer must not build automations';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.set_task_external_reviewer((select id from b36_ids where name = 'plain'), 'client@example.org', null);
    raise exception 'a Viewer must not choose the external reviewer';
  exception when insufficient_privilege then null;
  end;
end $$;

-- 2. The intended external reviewer: Editors set it (cleaned), readers read it.
select set_config('request.jwt.claim.sub', 'a3100360-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b36_ids where name = 't');
begin
  perform public.set_task_external_reviewer(t, '  Client@Example.ORG ', ' Jordan ');
  assert (select reviewer_email from public.task_review_settings where task_id = t) = 'client@example.org', 'lowercased';
  assert (select reviewer_name from public.task_review_settings where task_id = t) = 'Jordan', 'trimmed';
  assert (select updated_by from public.task_review_settings where task_id = t) = 'a3100360-0000-4000-8000-000000000002', 'who set it';
  assert (public.task_pane_rows(t) -> 'external_review' -> 'reviewer' ->> 'email') = 'client@example.org', 'the pane reads it';
end $$;

-- 3. Internal first, then external: the assignee can't send the review check; the approver can't either
--    until they approved.
do $$
declare
  t uuid := (select id from b36_ids where name = 't');
begin
  begin
    perform public.create_review_check(t, array[(select id from b36_ids where name = 'a1')], 'client@example.org');
    raise exception 'a non-approver must not send the external review of an approval task';
  exception when insufficient_privilege then
    assert sqlerrm like 'This task has an internal approver%', sqlerrm;
  end;
  perform public.send_for_approval(t, 'Final brochure copy', array[(select id from b36_ids where name = 'a1')], false, 'complete', null);
end $$;
select set_config('request.jwt.claim.sub', 'a3100360-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b36_ids where name = 't');
  req uuid;
  result jsonb;
begin
  begin
    perform public.create_review_check(t, array[(select id from b36_ids where name = 'a1')], 'client@example.org');
    raise exception 'the approver sends it only after approving';
  exception when insufficient_privilege then
    assert sqlerrm like 'Approve the task first%', sqlerrm;
  end;
  select q.id into req from public.approval_requests q
  where q.task_id = t and q.approver_id = auth.uid() and q.status = 'pending';
  perform public.decide_approval(req, 'approved', null);
  result := public.create_review_check(t, array[(select id from b36_ids where name = 'a1')], 'client@example.org', 'Jordan');
  insert into b36_tokens values ('first', result ->> 'token');
  insert into b36_ids values ('rc', (result ->> 'id')::uuid);
end $$;
select set_config('request.jwt.claim.sub', 'a3100360-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  begin
    perform public.rotate_review_check_token((select id from b36_ids where name = 'rc'));
    raise exception 'only the approver sends it again';
  exception when insufficient_privilege then null;
  end;
end $$;

-- 4. One reminder 24 hours later, with its own link; the first link keeps working; never twice.
reset role;
update public.review_checks set created_at = now() - interval '25 hours' where id = (select id from b36_ids where name = 'rc');
set role service_role;
do $$
declare
  n record;
  count_claimed int := 0;
begin
  for n in select * from public.claim_review_nudges(50) loop
    if n.review_id = (select id from b36_ids where name = 'rc') then
      count_claimed := count_claimed + 1;
      assert n.token ~ '^alhc_rev_[0-9a-f]{64}$', 'a fresh reminder link';
      assert n.token <> (select token from b36_tokens where name = 'first'), 'not the first link';
      assert n.recipient_email = 'client@example.org' and n.task_title = 'B36 brochure', 'what the email shows';
      assert jsonb_array_length(n.files) = 1 and n.files -> 0 ->> 'name' = 'brochure.pdf', 'the round''s files';
      insert into b36_tokens values ('nudge', n.token);
    end if;
  end loop;
  assert count_claimed = 1, 'the round is due its reminder';
  assert not exists (select 1 from public.claim_review_nudges(50) c where c.review_id = (select id from b36_ids where name = 'rc')),
    'claimed once (ten minutes before a retry)';
  perform public.finish_review_nudge((select id from b36_ids where name = 'rc'), true);
end $$;
reset role;
do $$
begin
  assert (select nudged_at from public.review_checks where id = (select id from b36_ids where name = 'rc')) is not null, 'marked sent';
  update public.review_checks set nudge_claimed_at = now() - interval '1 hour' where id = (select id from b36_ids where name = 'rc');
end $$;
set role service_role;
do $$
begin
  assert not exists (select 1 from public.claim_review_nudges(50) c where c.review_id = (select id from b36_ids where name = 'rc')),
    'one reminder, never two';
end $$;
reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
do $$
begin
  assert public.review_check_view((select token from b36_tokens where name = 'nudge')) ->> 'status' = 'ok',
    'the reminder''s link opens the round: ' || public.review_check_view((select token from b36_tokens where name = 'nudge'))::text;
  assert public.review_check_view((select token from b36_tokens where name = 'first')) ->> 'status' = 'ok', 'and so does the first one';
end $$;

-- 5. The external reviewer approves: the assignee and the approver who sent it hear about it as an external
--    review, the "approval decided" automation doesn't run, the internal approval is untouched, and task
--    lists learn it (the green dot).
do $$
begin
  assert public.review_check_decide((select token from b36_tokens where name = 'nudge'), 'approved', 'Looks great') ->> 'review_status' = 'approved',
    'approved through the reminder link';
end $$;
reset role;
do $$
declare
  t uuid := (select id from b36_ids where name = 't');
  item public.inbox_items;
begin
  select * into item from public.inbox_items
  where task_id = t and recipient_id = 'a3100360-0000-4000-8000-000000000002' and kind = 'approval_decided' and data ? 'review_check_id';
  assert item.id is not null, 'the assignee is told';
  assert (item.data ->> 'external')::boolean and item.data ->> 'reviewer_name' = 'Jordan', 'as the external reviewer''s decision';
  assert exists (select 1 from public.inbox_items where task_id = t and recipient_id = 'a3100360-0000-4000-8000-000000000003'
    and kind = 'approval_decided' and data ? 'review_check_id'), 'the approver who sent it is told';
  assert public.inbox_item_email_parts(item, item.recipient_id) ->> 'actor_name' = 'Jordan (external reviewer)', 'named in emails';
  assert (select count(*) from public.comments where task_id = t and body = 'approval automation ran') = 1,
    'the "An approval is decided" automation ran for the internal approval only, not the external review';
  assert (select status from public.approval_rounds where task_id = t order by round_number desc limit 1) = 'approved',
    'the internal round is unchanged';
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100360-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b36_ids where name = 't');
  cards jsonb := public.project_task_cards((select id from b36_ids where name = 'p'), null);
begin
  assert (select (c ->> 'external_approved')::boolean from jsonb_array_elements(cards) c where c ->> 'id' = t::text), 'the list''s green dot';
  assert not (select (c ->> 'external_approved')::boolean from jsonb_array_elements(cards) c
    where c ->> 'id' = (select id from b36_ids where name = 'plain')::text), 'only where it was approved';
  -- Approving completed the approval task, so it's in My tasks' completed list.
  assert (select (c ->> 'external_approved')::boolean from jsonb_array_elements(
    (public.my_task_cards() -> 'open') || (public.my_task_cards() -> 'completed')) c where c ->> 'id' = t::text),
    'My tasks'' green dot';
  assert public.task_pane_rows(t) -> 'external_review' -> 'latest' ->> 'status' = 'approved', 'the pane''s badge';
end $$;

-- 6. Anywhere else, Editors send review checks as before (and an open round is replaced only by a new send).
do $$
declare
  plain uuid := (select id from b36_ids where name = 'plain');
  result jsonb;
begin
  result := public.create_review_check(plain, array[(select id from b36_ids where name = 'a2')], 'facility@example.org');
  assert (result ->> 'round')::int = 1, 'an Editor sends one';
end $$;

-- 7. Transfer ownership leaves the old owner an Editor (never the retired Admin role).
select set_config('request.jwt.claim.sub', 'a3100360-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b36_ids where name = 'p');
begin
  perform public.transfer_project_ownership(p, 'a3100360-0000-4000-8000-000000000003');
  assert public.project_role(p) = 'editor', 'the old owner is an Editor';
end $$;

-- 8. Home's lead cards: a project only you are in isn't a team to lead.
select set_config('request.jwt.claim.sub', 'a3100360-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B36 solo');
  assert public.home_dashboard('UTC') -> 'lead' = 'null'::jsonb, 'no lead cards for a solo project';
end $$;
select set_config('request.jwt.claim.sub', 'a3100360-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
begin
  assert public.home_dashboard('UTC') -> 'lead' <> 'null'::jsonb, 'the new owner of a shared project gets them';
end $$;
reset role;

-- 9. Wording the database writes: "the automation's owner".
do $$
begin
  assert pg_get_functiondef('public.execute_rule_actions(public.rules,uuid,jsonb,jsonb)'::regprocedure) not like '%rule''''s owner%',
    'no "rule''s owner" left';
  assert pg_get_functiondef('public.rules_guard_v2()'::regprocedure) like '%automation’s owner must be a member%', 'the guard says automation';
end $$;

do $$ begin raise notice 'nov 10 batch 36 smoke: all assertions passed'; end $$;
