-- Nov 1 notes, batch 9a (20261101020000_nov1_batch9a_a.sql). One section per part; every section starts
-- as the database owner with no signed-in person. 00_verified_domains_switch_smoke.sql turned the
-- verified-domain switch off for the older suites; this suite turns it back on.

\set ON_ERROR_STOP 1

reset role;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset

insert into public.allowed_emails (email, note) values
  ('b9-owner@example.com', 'nov 1 batch 9a'),
  ('b9-editor@example.com', 'nov 1 batch 9a'),
  ('b9-commenter@example.com', 'nov 1 batch 9a'),
  ('b9-approver@example.com', 'nov 1 batch 9a');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b9a90101-0000-4000-8000-000000000001', 'b9-owner@example.com', now(), '{"full_name":"Olga Owner"}'),
  ('b9a90101-0000-4000-8000-000000000002', 'b9-editor@example.com', now(), '{"full_name":"Eli Editor"}'),
  ('b9a90101-0000-4000-8000-000000000003', 'b9-commenter@example.com', now(), '{"full_name":"Cam Commenter"}'),
  ('b9a90101-0000-4000-8000-000000000004', 'b9-approver@example.com', now(), '{"full_name":"Ava Approver"}');
select public.seed_workspace_admin('b9-owner@example.com');
update public.workspaces set verified_domain_conversations = true, allow_commenter_role = true;

create temporary table b9_ids (name text primary key, id uuid);
grant all on b9_ids to authenticated, anon, service_role;

-- =================================================================================================
-- 69. Verified domains: seeded, managed by workspace admins only
-- =================================================================================================

do $$
begin
  assert (select count(*) from public.verified_email_domains
          where workspace_id = '00000000-0000-4000-8000-000000000001' and removed_at is null
            and domain in ('autumnhc.net', 'autumnlakemarketing.com')) = 2, 'the two domains are seeded';
  assert (select verified_domain_conversations from public.workspaces where id = '00000000-0000-4000-8000-000000000001'),
    'the switch is on (by default and in this suite)';
  assert public.email_on_verified_domain('Ana@AutumnHC.net', '00000000-0000-4000-8000-000000000001'), 'any case';
  assert not public.email_on_verified_domain('ana@sub.autumnhc.net', '00000000-0000-4000-8000-000000000001'), 'exact domain only';
  assert not public.email_on_verified_domain('ana@gmail.com', '00000000-0000-4000-8000-000000000001'), 'gmail isn''t';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b9a90101-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  begin
    insert into public.verified_email_domains (workspace_id, domain) values ('00000000-0000-4000-8000-000000000001', 'evil.example');
    raise exception 'a member must not add a verified domain';
  exception when insufficient_privilege then null;
  end;
  assert (select count(*) from public.verified_email_domains where removed_at is null) >= 2, 'members read the list';
end $$;

select set_config('request.jwt.claim.sub', 'b9a90101-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  d uuid;
begin
  insert into public.verified_email_domains (workspace_id, domain) values ('00000000-0000-4000-8000-000000000001', ' @Example.COM ')
  returning id into d;
  assert (select domain from public.verified_email_domains where id = d) = 'example.com', 'cleaned: lowercase, no @';
  assert (select created_by from public.verified_email_domains where id = d) = 'b9a90101-0000-4000-8000-000000000001', 'creator stamped';
  begin
    insert into public.verified_email_domains (workspace_id, domain) values ('00000000-0000-4000-8000-000000000001', 'example.com');
    raise exception 'a duplicate must be refused';
  exception when unique_violation then null;
  end;
  begin
    insert into public.verified_email_domains (workspace_id, domain) values ('00000000-0000-4000-8000-000000000001', 'not a domain');
    raise exception 'a bad domain must be refused';
  exception when check_violation then null;
  end;
  update public.verified_email_domains set removed_at = now() where id = d;
  assert (select removed_by from public.verified_email_domains where id = d) = 'b9a90101-0000-4000-8000-000000000001', 'remover stamped';
  begin
    update public.verified_email_domains set removed_at = null where id = d;
    raise exception 'a removed domain stays removed';
  exception when check_violation then null;
  end;
end $$;
reset role;

-- =================================================================================================
-- 69. Verified-only forms, and the request email conversation
-- =================================================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', 'b9a90101-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid;
  s uuid;
  f1 uuid;
  f2 uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B9 Requests') returning id into p;
  insert into public.sections (project_id, name, sort_order) values (p, 'Intake', 1024) returning id into s;
  perform public.add_project_member(p, 'b9-editor@example.com', 'editor');
  insert into public.forms (project_id, title, accepting_responses, send_confirmation, destination_section_id, verified_domains_only)
  values (p, 'Staff only', true, false, s, true) returning id into f1;
  insert into public.forms (project_id, title, accepting_responses, send_confirmation, destination_section_id)
  values (p, 'Anyone', true, false, s) returning id into f2;
  insert into b9_ids values ('rp', p), ('f1', f1), ('f2', f2);
end $$;
reset role;

set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
do $$
declare
  f1 uuid := (select id from b9_ids where name = 'f1');
  form jsonb := public.get_public_form((select id from b9_ids where name = 'f1'));
begin
  assert (form ->> 'verified_domains_only')::boolean, 'the public form knows it''s verified-only';
  assert form -> 'verified_domains' = '["autumnhc.net", "autumnlakemarketing.com"]'::jsonb, 'and the domains: ' || (form -> 'verified_domains')::text;
  assert public.get_public_form((select id from b9_ids where name = 'f2')) -> 'verified_domains' = '[]'::jsonb, 'anyone''s form lists none';
  begin
    perform public.submit_form(f1, 'pat@gmail.com', '{"requester_name": "Pat"}');
    raise exception 'a verified-only form must refuse gmail';
  exception when check_violation then
    assert sqlerrm = 'This form only accepts email addresses at autumnhc.net or autumnlakemarketing.com', sqlerrm;
  end;
end $$;
insert into b9_ids select 'tv1', (public.submit_form((select id from b9_ids where name = 'f1'), 'Ana@AutumnHC.net', '{"requester_name": "Ana"}') ->> 'task_id')::uuid;
insert into b9_ids select 'tg', (public.submit_form((select id from b9_ids where name = 'f2'), 'pat@gmail.com', '{"requester_name": "Pat"}') ->> 'task_id')::uuid;
insert into b9_ids select 'tv', (public.submit_form((select id from b9_ids where name = 'f2'), 'lee@autumnlakemarketing.com', '{"requester_name": "Lee"}') ->> 'task_id')::uuid;
reset role;

do $$
begin
  assert (select id from b9_ids where name = 'tv1') is not null, 'a verified address submits the verified-only form';
  assert (select id from b9_ids where name = 'tg') is not null, 'anyone submits the other form';
end $$;

-- The editor: a verified submitter gets the conversation, an unverified one doesn't (and is told why).
set role authenticated;
select set_config('request.jwt.claim.sub', 'b9a90101-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  tg uuid := (select id from b9_ids where name = 'tg');
  tv uuid := (select id from b9_ids where name = 'tv');
  status jsonb;
begin
  perform public.send_submitter_response(tv, 'Thanks Lee');
  begin
    perform public.send_submitter_response(tg, 'Thanks Pat');
    raise exception 'an unverified submitter must get no email conversation';
  exception when check_violation then
    assert sqlerrm like 'Email conversation is off for this request: pat@gmail.com isn''t on a verified domain.%', sqlerrm;
  end;
  status := public.submitter_conversation_status(tg);
  assert not (status ->> 'allowed')::boolean and status ->> 'reason' = 'unverified' and status ->> 'email' = 'pat@gmail.com',
    'the status says why: ' || status::text;
  assert not (status ->> 'can_override')::boolean, 'the editor isn''t a workspace admin';
  assert (public.submitter_conversation_status(tv) ->> 'reason') = 'verified', 'verified';
  begin
    perform public.set_email_conversation_override(tg, 'request', true);
    raise exception 'only workspace admins override';
  exception when insufficient_privilege then null;
  end;
end $$;

-- The workspace admin turns it on for this request; the editor can respond.
select set_config('request.jwt.claim.sub', 'b9a90101-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  status jsonb;
begin
  status := public.set_email_conversation_override((select id from b9_ids where name = 'tg'), 'request', true);
  assert (status ->> 'allowed')::boolean and status ->> 'reason' = 'override_request' and (status ->> 'can_override')::boolean,
    'allowed for this request: ' || status::text;
end $$;
select set_config('request.jwt.claim.sub', 'b9a90101-0000-4000-8000-000000000002', false) is not null as ok \gset
select public.send_submitter_response((select id from b9_ids where name = 'tg'), 'Thanks Pat') is not null as ok \gset

-- Then stops it: the submitter's reply is refused (not_verified) and no Reply-To is handed out.
select set_config('request.jwt.claim.sub', 'b9a90101-0000-4000-8000-000000000001', false) is not null as ok \gset
select public.set_email_conversation_override((select id from b9_ids where name = 'tg'), 'request', false) is not null as ok \gset
reset role;
do $$
declare
  tg uuid := (select id from b9_ids where name = 'tg');
  token text := (select token from public.submitter_reply_threads where task_id = tg and revoked_at is null);
  result jsonb;
  outbox uuid := (select id from public.email_outbox where task_id = tg and payload ->> 'kind' = 'submitter_response' order by created_at desc limit 1);
begin
  assert token is not null, 'the earlier response made a thread';
  result := public.post_submitter_reply(token, 'pat@gmail.com', 'Here you go', 'b9-provider-1');
  assert result ->> 'reason' = 'not_verified', 'a reply while it''s off is refused: ' || result::text;
  assert public.submitter_reply_token(outbox) is null, 'no Reply-To while it''s off';
  assert (select status from public.email_replies where provider_id = 'b9-provider-1') = 'rejected', 'logged';
end $$;

-- Per submitter, then the workspace switch.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b9a90101-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  tg uuid := (select id from b9_ids where name = 'tg');
  status jsonb;
begin
  perform public.set_email_conversation_override(tg, 'request', null);
  status := public.set_email_conversation_override(tg, 'submitter', true);
  assert (status ->> 'allowed')::boolean and status ->> 'reason' = 'override_submitter', 'every request from pat: ' || status::text;
  perform public.set_email_conversation_override(tg, 'submitter', null);
  assert (public.submitter_conversation_status(tg) ->> 'reason') = 'unverified', 'back to the rule';
  update public.workspaces set verified_domain_conversations = false where id = '00000000-0000-4000-8000-000000000001';
  status := public.submitter_conversation_status(tg);
  assert (status ->> 'allowed')::boolean and status ->> 'reason' = 'setting_off', 'switch off: everyone: ' || status::text;
  update public.workspaces set verified_domain_conversations = true where id = '00000000-0000-4000-8000-000000000001';
end $$;
select set_config('request.jwt.claim.sub', 'b9a90101-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  begin
    update public.workspaces set verified_domain_conversations = false where id = '00000000-0000-4000-8000-000000000001';
    if found then raise exception 'a member must not change the switch'; end if;
  exception when insufficient_privilege then null;
  end;
  assert (select verified_domain_conversations from public.workspaces where id = '00000000-0000-4000-8000-000000000001'), 'still on';
end $$;
reset role;

-- =================================================================================================
-- 10.4. Comment pinning
-- =================================================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', 'b9a90101-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid;
  s uuid;
  t uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B9 Pins') returning id into p;
  insert into public.sections (project_id, name, sort_order) values (p, 'Work', 1024) returning id into s;
  perform public.add_project_member(p, 'b9-editor@example.com', 'editor');
  perform public.add_project_member(p, 'b9-commenter@example.com', 'commenter');
  t := public.create_task(p, s, 'Pin me');
  insert into b9_ids values ('pp', p), ('pt', t);
end $$;

select set_config('request.jwt.claim.sub', 'b9a90101-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  c uuid;
begin
  insert into public.comments (task_id, author_id, body)
  values ((select id from b9_ids where name = 'pt'), 'b9a90101-0000-4000-8000-000000000003', 'Decision: we go with the blue logo')
  returning id into c;
  insert into b9_ids values ('pc', c);
  begin
    perform public.set_comment_pinned(c, true);
    raise exception 'a Commenter must not pin';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.comments set pinned_at = now() where id = c;
    raise exception 'nobody pins through a plain write';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'b9a90101-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  c uuid := (select id from b9_ids where name = 'pc');
  t uuid := (select id from b9_ids where name = 'pt');
  page jsonb;
  pinned_list jsonb;
begin
  perform public.set_comment_pinned(c, true);
  assert (select pinned_by from public.comments where id = c) = 'b9a90101-0000-4000-8000-000000000002', 'pinned by the editor';
  perform public.set_comment_pinned(c, true);
  assert (select count(*) from public.comment_pin_events where comment_id = c) = 1, 'pinning twice logs once';
  page := public.task_comment_page(t);
  assert page -> 'comments' -> 0 ->> 'pinned_at' is not null, 'the page carries the pin: ' || page::text;
  pinned_list := public.task_pinned_comments(t);
  assert jsonb_array_length(pinned_list) = 1 and pinned_list -> 0 ->> 'body' = 'Decision: we go with the blue logo',
    'pinned list: ' || pinned_list::text;
  perform public.set_comment_pinned(c, false);
  assert (select pinned_at from public.comments where id = c) is null, 'unpinned';
  assert (select array_agg(e.pinned order by e.created_at) from public.comment_pin_events e where e.comment_id = c) = array[true, false],
    'both logged';
  assert jsonb_array_length(public.task_pinned_comments(t)) = 0, 'nothing pinned now';
end $$;

-- The commenter reads the activity; a removed comment can't be pinned.
select set_config('request.jwt.claim.sub', 'b9a90101-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
begin
  assert (select count(*) from public.comment_pin_events where task_id = (select id from b9_ids where name = 'pt')) = 2, 'task readers see the activity';
  update public.comments set deleted_at = now() where id = (select id from b9_ids where name = 'pc');
end $$;
select set_config('request.jwt.claim.sub', 'b9a90101-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  begin
    perform public.set_comment_pinned((select id from b9_ids where name = 'pc'), true);
    raise exception 'a removed comment can''t be pinned';
  exception when no_data_found then null;
  end;
end $$;
reset role;

-- =================================================================================================
-- Approvals (a): approvers only, also after approval; (b) the follow-up step and reminders
-- =================================================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', 'b9a90101-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid;
  other uuid;
  s uuid;
  done uuid;
  foreign_section uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B9 Approvals') returning id into p;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B9 Elsewhere') returning id into other;
  insert into public.sections (project_id, name, sort_order) values (p, 'Work', 1024) returning id into s;
  insert into public.sections (project_id, name, sort_order) values (p, 'Ready to publish', 2048) returning id into done;
  insert into public.sections (project_id, name, sort_order) values (other, 'Theirs', 1024) returning id into foreign_section;
  perform public.add_project_member(p, 'b9-editor@example.com', 'editor');
  perform public.add_project_member(p, 'b9-commenter@example.com', 'commenter');
  perform public.add_project_member(p, 'b9-approver@example.com', 'commenter');
  insert into b9_ids values ('ap', p), ('as', s), ('adone', done), ('aforeign', foreign_section);
end $$;

select set_config('request.jwt.claim.sub', 'b9a90101-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  a uuid;
  b uuid;
begin
  a := public.create_task((select id from b9_ids where name = 'ap'), (select id from b9_ids where name = 'as'), 'Brochure approval');
  b := public.create_task((select id from b9_ids where name = 'ap'), (select id from b9_ids where name = 'as'), 'Banner approval');
  update public.tasks set kind = 'approval', assignee_id = 'b9a90101-0000-4000-8000-000000000002' where id in (a, b);
  insert into b9_ids values ('aa', a), ('ab', b);
  perform public.set_task_approvers(a, array['b9a90101-0000-4000-8000-000000000004'::uuid], 'any', null);

  -- The follow-up step.
  begin
    perform public.set_approval_followup(a, 'move_section', null, true);
    raise exception 'move to a section needs the section';
  exception when check_violation then null;
  end;
  begin
    perform public.set_approval_followup(a, 'move_section', (select id from b9_ids where name = 'aforeign'), true);
    raise exception 'a section of another project is refused';
  exception when check_violation then null;
  end;
  begin
    perform public.set_approval_followup(a, 'skip it', null, true);
    raise exception 'an unknown follow-up is refused';
  exception when check_violation then null;
  end;
  perform public.set_approval_followup(a, 'move_section', (select id from b9_ids where name = 'adone'), true);
  assert (select after_approval from public.task_approval_settings where task_id = a) = 'move_section', 'saved';
  assert (select after_section_id from public.task_approval_settings where task_id = a) = (select id from b9_ids where name = 'adone'), 'with its section';
end $$;

select set_config('request.jwt.claim.sub', 'b9a90101-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
begin
  begin
    perform public.set_approval_followup((select id from b9_ids where name = 'aa'), 'complete', null, true);
    raise exception 'a Commenter can''t set up the approval';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Sent with More steps (move to Ready to publish), approved: the assignee (an Editor, not an approver)
-- still can't complete it; the approver can.
select set_config('request.jwt.claim.sub', 'b9a90101-0000-4000-8000-000000000002', false) is not null as ok \gset
select public.send_for_approval((select id from b9_ids where name = 'aa'), 'Final brochure', '{}', true, 'move_section',
  (select id from b9_ids where name = 'adone')) is not null as ok \gset
select set_config('request.jwt.claim.sub', 'b9a90101-0000-4000-8000-000000000004', false) is not null as ok \gset
select public.decide_approval((select id from public.approval_requests where task_id = (select id from b9_ids where name = 'aa')
  and status = 'pending'), 'approved', 'Lovely') is not null as ok \gset
select set_config('request.jwt.claim.sub', 'b9a90101-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b9_ids where name = 'aa');
  result jsonb;
begin
  assert public.task_approval_state(a) ->> 'status' = 'approved', 'approved';
  assert (select section_id from public.task_projects where task_id = a and deleted_at is null) = (select id from b9_ids where name = 'adone'),
    'More steps moved it';
  begin
    update public.tasks set completed_at = now() where id = a;
    raise exception 'batch 9a: a non-approver must not complete an approved approval task';
  exception when check_violation then
    assert sqlerrm = 'This task was approved. Only its approvers can complete it.', sqlerrm;
  end;
  result := public.bulk_update_tasks(array[a], '{"action": "complete"}'::jsonb);
  assert result -> 'skipped' -> 0 ->> 'reason' = 'This task was approved. Only its approvers can complete it.', 'bulk too: ' || result::text;
end $$;
-- The approver (a Commenter: no Editor access) completes it through complete_approval_as_approver; a
-- plain update would touch nothing for them.
select set_config('request.jwt.claim.sub', 'b9a90101-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
begin
  begin
    perform public.complete_approval_as_approver((select id from b9_ids where name = 'aa'));
    raise exception 'a Commenter who isn''t an approver must not';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', 'b9a90101-0000-4000-8000-000000000004', false) is not null as ok \gset
select public.complete_approval_as_approver((select id from b9_ids where name = 'aa')) is not null as ok \gset
reset role;
do $$
begin
  assert (select completed_at from public.tasks where id = (select id from b9_ids where name = 'aa')) is not null, 'the approver completed it';
end $$;

-- Reminders off: no due-date reminder; back on: the reminder goes out.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b9a90101-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  b uuid := (select id from b9_ids where name = 'ab');
begin
  perform public.set_task_approvers(b, array['b9a90101-0000-4000-8000-000000000004'::uuid], 'any', current_date - 1);
  perform public.set_approval_followup(b, 'complete', null, false);
  perform public.send_for_approval(b, 'Final banner', '{}', false, 'complete', null);
end $$;
reset role;
do $$
declare
  b uuid := (select id from b9_ids where name = 'ab');
  before_count integer;
begin
  before_count := (select count(*) from public.inbox_items where task_id = b and data ? 'reminder');
  perform public.approval_reminders_tick();
  assert (select count(*) from public.inbox_items where task_id = b and data ? 'reminder') = before_count, 'reminders off: nothing';
  update public.task_approval_settings set reminders = true where task_id = b;
  perform public.approval_reminders_tick();
  assert (select count(*) from public.inbox_items where task_id = b and data ? 'reminder') = before_count + 1, 'reminders on: one';
end $$;

-- Rules never complete an approval task (also once approved): batch 7's rule paths now always skip.
do $$
begin
  assert position('approval_round_approved' in pg_get_functiondef('public.run_my_task_rule(public.my_task_rules,uuid,jsonb,text)'::regprocedure)) = 0,
    'My Tasks rules skip approval tasks unconditionally';
  assert position('approval_round_approved' in pg_get_functiondef('public.execute_rule_actions(public.rules,uuid,jsonb,jsonb)'::regprocedure)) = 0,
    'project rules too';
end $$;

-- =================================================================================================
-- 66. The Trash purge
-- =================================================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', 'b9a90101-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  pa uuid;
  pb uuid;
  sa uuid;
  sb uuid;
  t1 uuid;
  s1 uuid;
  t2 uuid;
  t3 uuid;
  t4 uuid;
  s4 uuid;
  t5 uuid;
  c1 uuid;
  c2 uuid;
  tpl uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B9 Old project') returning id into pa;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B9 Live project') returning id into pb;
  insert into public.sections (project_id, name, sort_order) values (pa, 'Old', 1024) returning id into sa;
  insert into public.sections (project_id, name, sort_order) values (pb, 'Live', 1024) returning id into sb;
  t1 := public.create_task(pa, sa, 'Only in the old project');
  s1 := public.create_subtask(t1, 'Its subtask', null);
  t2 := public.create_task(pa, sa, 'Also in the live project');
  insert into public.task_projects (task_id, project_id, section_id) values (t2, pb, sb);
  t3 := public.create_task(pb, sb, 'Live task waiting on t1');
  t4 := public.create_task(pb, sb, 'Trashed long ago');
  s4 := public.create_subtask(t4, 'Trashed with it', null);
  t5 := public.create_task(pb, sb, 'Trashed recently');
  perform public.set_task_dependency(t1, t3, 'finish_to_start', 0);
  insert into public.comments (task_id, author_id, body) values (t1, 'b9a90101-0000-4000-8000-000000000001', 'On the old task') returning id into c1;
  insert into public.comments (task_id, author_id, body) values (t3, 'b9a90101-0000-4000-8000-000000000001', 'Removed long ago') returning id into c2;
  tpl := public.save_project_as_template(pa, 'B9 Template from the old project');
  insert into b9_ids values ('pa', pa), ('pb', pb), ('t1', t1), ('s1', s1), ('t2', t2), ('t3', t3), ('t4', t4), ('s4', s4), ('t5', t5),
    ('c1', c1), ('c2', c2), ('tpl', tpl);
end $$;
reset role;

-- Files (metadata only: the test shim's Storage is rows), and the old deletions (as the owner, which
-- the guards don't check).
do $$
declare
  t1 uuid := (select id from b9_ids where name = 't1');
  t3 uuid := (select id from b9_ids where name = 't3');
  a1 uuid;
  a3 uuid;
  a3b uuid;
begin
  insert into public.task_attachments (task_id, storage_path, file_name, size_bytes, uploaded_by)
  values (t1, t1 || '/old.png', 'old.png', 10, 'b9a90101-0000-4000-8000-000000000001') returning id into a1;
  insert into public.task_attachments (task_id, storage_path, file_name, size_bytes, uploaded_by)
  values (t3, t3 || '/gone.pdf', 'gone.pdf', 10, 'b9a90101-0000-4000-8000-000000000001') returning id into a3;
  insert into public.task_attachments (task_id, storage_path, file_name, size_bytes, uploaded_by)
  values (t3, t3 || '/kept.pdf', 'kept.pdf', 10, 'b9a90101-0000-4000-8000-000000000001') returning id into a3b;
  insert into b9_ids values ('a1', a1), ('a3', a3), ('a3b', a3b);

  update public.projects set deleted_at = now() - interval '91 days' where id = (select id from b9_ids where name = 'pa');
  update public.tasks set deleted_at = now() - interval '100 days' where id in ((select id from b9_ids where name = 't4'), (select id from b9_ids where name = 's4'));
  update public.tasks set deleted_at = now() - interval '10 days' where id = (select id from b9_ids where name = 't5');
  update public.comments set deleted_at = now() - interval '95 days' where id = (select id from b9_ids where name = 'c2');
  update public.task_attachments set deleted_at = now() - interval '95 days' where id = a3;
  update public.task_attachments set deleted_at = now() - interval '5 days' where id = a3b;
end $$;

do $$
declare
  result jsonb;
  again jsonb;
  t2 uuid := (select id from b9_ids where name = 't2');
  t3 uuid := (select id from b9_ids where name = 't3');
begin
  result := public.alhc_purge_trash();
  raise notice 'Trash purge (local test data): %', result;
  assert (result ->> 'projects')::integer >= 1, 'a project purged: ' || result::text;
  assert not exists (select 1 from public.projects where id = (select id from b9_ids where name = 'pa')), 'the old project is gone';
  assert not exists (select 1 from public.tasks where id in (select id from b9_ids where name in ('t1', 's1', 't4', 's4'))),
    'its only-there task and subtask, and the long-trashed task and subtask, are gone';
  assert not exists (select 1 from public.comments where id in (select id from b9_ids where name in ('c1', 'c2'))), 'their comments, and the old removed comment';
  assert not exists (select 1 from public.task_attachments where id in (select id from b9_ids where name in ('a1', 'a3'))), 'the old files'' rows';

  -- What stays.
  assert (select home_project_id from public.tasks where id = t2) = (select id from b9_ids where name = 'pb'), 'the multi-homed task moved to the live project';
  assert (select deleted_at from public.tasks where id = t2) is null, 'and stays live';
  assert exists (select 1 from public.tasks where id = t3 and deleted_at is null), 'the live task stays';
  assert exists (select 1 from public.tasks where id = (select id from b9_ids where name = 't5')), 'a recently trashed task stays (Deletes in 80 days)';
  assert exists (select 1 from public.task_attachments where id = (select id from b9_ids where name = 'a3b')), 'a recently removed file stays';
  assert exists (select 1 from public.project_templates where id = (select id from b9_ids where name = 'tpl') and source_project_id is null),
    'the template made from the old project stays, unlinked';
  assert exists (
    select 1 from public.task_stories st
    where st.task_id = t3 and st.kind = 'dependency_added' and (st.data ->> 'purged')::boolean
  ), 'the live task''s dependency story names "a deleted task"';

  -- Records and files.
  assert exists (select 1 from public.trash_purged_items where kind = 'project' and item_id = (select id from b9_ids where name = 'pa')), 'recorded';
  assert exists (select 1 from public.trash_storage_purges where path = (select id from b9_ids where name = 't1') || '/' and is_prefix and done_at is null),
    'the purged task''s folder is queued';
  assert exists (select 1 from public.trash_storage_purges where path = t3 || '/gone.pdf' and not is_prefix and done_at is null),
    'the purged file of a live task is queued';
  assert not exists (select 1 from public.trash_storage_purges where path = t3 || '/kept.pdf'), 'never a live file';
  assert exists (select 1 from public.trash_purge_runs where finished_at is not null), 'the run is logged';

  -- Safe to run twice.
  again := public.alhc_purge_trash();
  assert (again ->> 'projects')::integer = 0 and (again ->> 'tasks')::integer = 0 and (again ->> 'comments')::integer = 0,
    'nothing left the second time: ' || again::text;

  -- A queued folder of a task that still exists is closed without removal.
  insert into public.trash_storage_purges (bucket, path, is_prefix) values ('task-attachments', t3 || '/', true);
end $$;

set role service_role;
do $$
declare
  t3 uuid := (select id from b9_ids where name = 't3');
  claimed integer;
begin
  select count(*) into claimed from public.claim_trash_storage_purges(500) c where c.path = t3 || '/';
  assert claimed = 0, 'a live task''s folder is never handed out';
  assert (select last_error from public.trash_storage_purges where path = t3 || '/') = 'Kept: still in use', 'closed as kept';
end $$;
reset role;

do $$
begin
  assert not has_function_privilege('authenticated', 'public.alhc_purge_trash(integer)', 'execute'), 'no client runs the purge';
  assert not has_function_privilege('service_role', 'public.alhc_purge_trash(integer)', 'execute'), 'not even the service role';
  assert has_function_privilege('service_role', 'public.claim_trash_storage_purges(integer)', 'execute'), 'the cron route claims files';
  assert not has_function_privilege('authenticated', 'public.claim_trash_storage_purges(integer)', 'execute'), 'clients don''t';
  assert exists (select 1 from cron.job where jobname = 'alhc-trash-purge'), 'scheduled daily';
  assert not has_table_privilege('authenticated', 'public.trash_storage_purges', 'select'), 'no client reads the file queue';
  assert not has_table_privilege('anon', 'public.verified_email_domains', 'select'), 'nothing for anon';
  assert not has_table_privilege('authenticated', 'public.email_conversation_overrides', 'select'), 'overrides: definer functions only';
  assert public.trash_retention_days() = 90, '90 days';
  raise notice 'nov 1 batch 9a: ok';
end $$;
