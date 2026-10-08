-- Behavioural checks for Phase: Email live: form submitters follow their request only when they have
-- an allowlisted profile that can read it; comment emails go to every follower except the author who
-- can read the task and wants them (never to people without access, re-checked at send time, private
-- tasks included); the per-person toggle; imports / copies queue nothing; status moves from queued to
-- sending to sent / failed with backoff; reply-by-email posts only for the token's person from their own
-- address (service_role only); the Admin+ email delivery log and retry; the delivery kick is internal.
-- Fresh people for this suite:
--   e8e8…01 el-owner@example.com     owner of EL P
--   e8e8…02 el-member@example.com    Editor of EL P
--   e8e8…03 el-viewer@example.com    Viewer of EL P (follows, can't comment)
--   e8e8…04 el-outsider@example.com  allowlisted, no memberships
--   e8e8…05 el-quiet@example.com     Editor of EL P, comment emails off
--   e8e8…06 el-leaver@example.com    Editor of EL P, later removed

\set ON_ERROR_STOP 1

create temporary table el_ids (name text primary key, id uuid) on commit preserve rows;
grant all on el_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('el-owner@example.com', 'email live suite'),
  ('el-member@example.com', 'email live suite'),
  ('el-viewer@example.com', 'email live suite'),
  ('el-outsider@example.com', 'email live suite'),
  ('el-quiet@example.com', 'email live suite'),
  ('el-leaver@example.com', 'email live suite');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e8e8e8e8-0000-4000-8000-000000000001', 'el-owner@example.com', now(), '{"full_name":"Olive Owner"}'),
  ('e8e8e8e8-0000-4000-8000-000000000002', 'el-member@example.com', now(), '{"full_name":"Mia Member"}'),
  ('e8e8e8e8-0000-4000-8000-000000000003', 'el-viewer@example.com', now(), '{"full_name":"Vic Viewer"}'),
  ('e8e8e8e8-0000-4000-8000-000000000004', 'el-outsider@example.com', now(), '{"full_name":"Otto Outsider"}'),
  ('e8e8e8e8-0000-4000-8000-000000000005', 'el-quiet@example.com', now(), '{"full_name":"Quinn Quiet"}'),
  ('e8e8e8e8-0000-4000-8000-000000000006', 'el-leaver@example.com', now(), '{"full_name":"Lee Leaver"}');

insert into el_ids values
  ('owner', 'e8e8e8e8-0000-4000-8000-000000000001'),
  ('member', 'e8e8e8e8-0000-4000-8000-000000000002'),
  ('viewer', 'e8e8e8e8-0000-4000-8000-000000000003'),
  ('outsider', 'e8e8e8e8-0000-4000-8000-000000000004'),
  ('quiet', 'e8e8e8e8-0000-4000-8000-000000000005'),
  ('leaver', 'e8e8e8e8-0000-4000-8000-000000000006');

do $$
begin
  assert (select email_comments from public.profiles where id = 'e8e8e8e8-0000-4000-8000-000000000002'),
    'comment emails are on by default';
  assert exists (select 1 from cron.job where jobname = 'alhc-delivery-kick' and schedule = '* * * * *'),
    'the delivery kick runs every minute';
  assert not public.alhc_kick_delivery(), 'the kick does nothing without pg_net and Vault';
end $$;

-- Fixtures ----------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'e8e8e8e8-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  p uuid;
  intake uuid;
  f uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'EL P') returning id into p;
  insert into public.sections (project_id, name, sort_order) values (p, 'Intake', 1024) returning id into intake;
  perform public.add_project_member(p, 'el-member@example.com', 'editor');
  perform public.add_project_member(p, 'el-viewer@example.com', 'viewer');
  perform public.add_project_member(p, 'el-quiet@example.com', 'editor');
  perform public.add_project_member(p, 'el-leaver@example.com', 'editor');
  insert into public.forms (project_id, title, accepting_responses, send_confirmation, destination_section_id)
  values (p, 'EL Request', true, true, intake) returning id into f;
  insert into el_ids values ('p', p), ('intake', intake), ('form', f);
end $$;

-- People change only their own toggle.
select set_config('request.jwt.claim.sub', 'e8e8e8e8-0000-4000-8000-000000000005', false) is not null as ok \gset
update public.profiles set email_comments = false where id = 'e8e8e8e8-0000-4000-8000-000000000005';
update public.profiles set email_comments = false where id = 'e8e8e8e8-0000-4000-8000-000000000002';
reset role;
do $$
begin
  assert not (select email_comments from public.profiles where id = 'e8e8e8e8-0000-4000-8000-000000000005'),
    'a person turns their own comment emails off';
  assert (select email_comments from public.profiles where id = 'e8e8e8e8-0000-4000-8000-000000000002'),
    'nobody turns off someone else''s';
end $$;

-- Form submitters follow their request -------------------------------------------------------------

set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset

create temporary table el_submissions (who text primary key, task_id uuid) on commit preserve rows;
grant all on el_submissions to anon, authenticated, service_role;

insert into el_submissions
select 'member', (public.submit_form((select id from el_ids where name = 'form'), 'EL-Member@Example.com', '{}') ->> 'task_id')::uuid;
insert into el_submissions
select 'outsider', (public.submit_form((select id from el_ids where name = 'form'), 'el-outsider@example.com', '{}') ->> 'task_id')::uuid;
insert into el_submissions
select 'stranger', (public.submit_form((select id from el_ids where name = 'form'), 'stranger@example.net', '{}') ->> 'task_id')::uuid;

reset role;

do $$
declare
  member_task uuid := (select task_id from el_submissions where who = 'member');
  outsider_task uuid := (select task_id from el_submissions where who = 'outsider');
  stranger_task uuid := (select task_id from el_submissions where who = 'stranger');
  e public.email_outbox;
begin
  assert exists (select 1 from public.task_followers where task_id = member_task
      and profile_id = (select id from el_ids where name = 'member') and deleted_at is null),
    'an allowlisted submitter who can read the task follows it (email matched case-insensitively)';
  assert not exists (select 1 from public.task_followers where task_id = outsider_task
      and profile_id = (select id from el_ids where name = 'outsider')),
    'an allowlisted submitter who can''t read the task does not follow it';
  assert (select count(*) from public.task_followers where task_id = stranger_task) = 0,
    'a submitter without a profile follows nothing';

  select * into e from public.email_outbox where task_id = stranger_task;
  assert e.template = 'form_confirmation' and e.status = 'pending' and e.to_email = 'stranger@example.net'
    and e.comment_id is null and e.max_attempts = 5,
    'the requester still gets the confirmation email, queued as pending';
  assert exists (select 1 from public.task_stories where task_id = stranger_task and kind = 'email_queued'
      and data ->> 'email_id' = e.id::text),
    'the activity says the email was queued';
end $$;

-- Comment emails ------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'e8e8e8e8-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from el_ids where name = 'p');
  t uuid;
  pt uuid;
  c uuid;
begin
  t := public.create_task(p, (select id from el_ids where name = 'intake'), 'Spring flyer');
  -- Owner follows as creator. Everyone else follows explicitly.
  insert into public.task_followers (task_id, profile_id) values
    (t, 'e8e8e8e8-0000-4000-8000-000000000002'),
    (t, 'e8e8e8e8-0000-4000-8000-000000000003'),
    (t, 'e8e8e8e8-0000-4000-8000-000000000005'),
    (t, 'e8e8e8e8-0000-4000-8000-000000000006');
  -- Lee loses access but keeps the follower row.
  perform public.remove_project_member(p, 'e8e8e8e8-0000-4000-8000-000000000006');
  insert into public.comments (task_id, body) values (t, 'Draft is in the folder') returning id into c;

  pt := public.create_private_task('Private follow-up');
  update public.tasks set assignee_id = 'e8e8e8e8-0000-4000-8000-000000000002' where id = pt;
  insert into el_ids values ('t', t), ('c', c), ('pt', pt);
end $$;

reset role;

do $$
declare
  t uuid := (select id from el_ids where name = 't');
  c uuid := (select id from el_ids where name = 'c');
  e public.email_outbox;
begin
  assert (select count(*) from public.email_outbox where comment_id = c) = 2,
    'one email each for the member and the viewer: not the author, not the opted-out follower, not the follower who lost access';
  assert not exists (select 1 from public.email_outbox where comment_id = c
      and to_profile_id in (select id from el_ids where name in ('owner', 'quiet', 'leaver', 'outsider'))),
    'no email to the author, the opted-out follower, or anyone without access';
  select * into e from public.email_outbox where comment_id = c and to_profile_id = (select id from el_ids where name = 'member');
  assert e.to_email = 'el-member@example.com' and e.template = 'custom' and e.status = 'pending' and e.task_id = t,
    'a comment email is queued for the follower';
  assert e.payload ->> 'kind' = 'comment' and e.payload ->> 'comment_body' = 'Draft is in the folder'
    and e.payload ->> 'task_title' = 'Spring flyer' and e.payload ->> 'project_name' = 'EL P'
    and e.payload ->> 'author_name' = 'Olive Owner'
    and (e.payload ->> 'project_id')::uuid = (select id from el_ids where name = 'p'),
    'the email carries the task, project, author, and comment text';
  assert not exists (select 1 from public.task_stories where task_id = t and kind = 'email_queued'),
    'comment emails add no activity stories';
end $$;

-- A comment on a private task reaches only its creator / assignee, with no project.
set role authenticated;
select set_config('request.jwt.claim.sub', 'e8e8e8e8-0000-4000-8000-000000000001', false) is not null as ok \gset
insert into public.comments (task_id, body) select id, 'Private note' from el_ids where name = 'pt';
reset role;

do $$
declare
  pt uuid := (select id from el_ids where name = 'pt');
  e public.email_outbox;
begin
  assert (select count(*) from public.email_outbox where task_id = pt) = 1, 'one email: the assignee';
  select * into e from public.email_outbox where task_id = pt;
  assert e.to_profile_id = (select id from el_ids where name = 'member') and e.payload -> 'project_id' = 'null'::jsonb
    and e.payload -> 'project_name' = 'null'::jsonb,
    'a private task''s email names no project';
end $$;

-- Copies and imports queue nothing.
set role authenticated;
select set_config('request.jwt.claim.sub', 'e8e8e8e8-0000-4000-8000-000000000001', false) is not null as ok \gset
begin;
select set_config('alhc.copy_id', gen_random_uuid()::text, true) is not null as ok \gset
insert into public.comments (task_id, body) select id, 'Copied comment' from el_ids where name = 't';
commit;
reset role;

do $$
begin
  assert not exists (select 1 from public.email_outbox o join public.comments c on c.id = o.comment_id
      where c.body = 'Copied comment'),
    'a comment written during a copy queues no email';
end $$;

-- Send-time re-check: access lost, toggle off, private task reassigned ------------------------------

do $$
declare
  p uuid := (select id from el_ids where name = 'p');
  t uuid := (select id from el_ids where name = 't');
  pt uuid := (select id from el_ids where name = 'pt');
  viewer_email uuid;
  member_email uuid;
  private_email uuid;
  claimed uuid[];
  e public.email_outbox;
begin
  -- Hold every earlier row back so the claims below only see this suite's comment emails.
  update public.email_outbox set send_after = now() + interval '1 day'
  where status = 'pending' and coalesce(task_id, '00000000-0000-0000-0000-000000000000') not in (t, pt);

  select id into viewer_email from public.email_outbox where task_id = t and to_profile_id = (select id from el_ids where name = 'viewer');
  select id into member_email from public.email_outbox where task_id = t and to_profile_id = (select id from el_ids where name = 'member');
  select id into private_email from public.email_outbox where task_id = pt;

  -- The viewer leaves the project, the member turns comment emails off, the private task is reassigned.
  perform set_config('request.jwt.claim.sub', (select id::text from el_ids where name = 'owner'), true);
  perform public.remove_project_member(p, (select id from el_ids where name = 'viewer'));
  update public.profiles set email_comments = false where id = (select id from el_ids where name = 'member');
  update public.tasks set assignee_id = (select id from el_ids where name = 'owner') where id = pt;

  set local role service_role;
  select array_agg(x.id) into claimed from public.claim_email_deliveries(50, null) x;
  reset role;

  assert claimed is null or not (claimed && array[viewer_email, member_email, private_email]),
    'none of them is claimed for sending';
  select * into e from public.email_outbox where id = viewer_email;
  assert e.status = 'failed' and e.last_error = 'Not sent: the recipient can no longer open this task',
    'a follower who lost access gets nothing, and the row says why';
  select * into e from public.email_outbox where id = member_email;
  assert e.status = 'failed' and e.last_error = 'Not sent: the recipient turned off comment emails',
    'turning the toggle off stops queued emails too';
  select * into e from public.email_outbox where id = private_email;
  assert e.status = 'failed' and e.last_error = 'Not sent: the recipient can no longer open this task',
    'a private task''s former assignee gets nothing';
  update public.profiles set email_comments = true where id = (select id from el_ids where name = 'member');
end $$;

-- The pre-Email live claim (still called by the release deployed while this applies) never takes comment
-- emails, and a comment email more than a day late fails instead of going out.
set role authenticated;
select set_config('request.jwt.claim.sub', 'e8e8e8e8-0000-4000-8000-000000000001', false) is not null as ok \gset
insert into public.comments (task_id, body) select id, 'Legacy check' from el_ids where name = 't';
reset role;

do $$
declare
  e_id uuid := (select o.id from public.email_outbox o join public.comments c on c.id = o.comment_id
    where c.body = 'Legacy check' and o.to_profile_id = (select id from el_ids where name = 'member'));
  claimed uuid[];
begin
  assert e_id is not null, 'the member is emailed about it';
  set local role service_role;
  select array_agg(x.id) into claimed from public.claim_email_outbox(1, e_id) x;
  reset role;
  assert claimed is null and (select status from public.email_outbox where id = e_id) = 'pending',
    'the legacy claim leaves comment emails alone';

  update public.email_outbox set created_at = now() - interval '25 hours' where id = e_id;
  set local role service_role;
  select array_agg(x.id) into claimed from public.claim_email_deliveries(1, e_id) x;
  reset role;
  assert claimed is null and (select last_error from public.email_outbox where id = e_id) = 'Not sent: more than a day late',
    'a comment email more than a day late is not sent';
end $$;

-- Status: queued → sending → sent | pending with backoff → failed ------------------------------------

do $$
declare
  stranger_task uuid := (select task_id from el_submissions where who = 'stranger');
  e_id uuid := (select id from public.email_outbox where task_id = stranger_task);
  e public.email_outbox;
  later public.email_outbox;
  member_task uuid := (select task_id from el_submissions where who = 'member');
begin
  update public.email_outbox set send_after = now() where id = e_id;
  set local role service_role;
  perform public.claim_email_deliveries(1, e_id);
  reset role;
  assert (select status from public.email_outbox where id = e_id) = 'sending' and
    (select attempts from public.email_outbox where id = e_id) = 1, 'claiming marks it sending';

  set local role service_role;
  perform public.complete_email_outbox(e_id, 'error', null, 'Resend responded 500');
  reset role;
  select * into e from public.email_outbox where id = e_id;
  assert e.status = 'pending' and e.last_error = 'Resend responded 500'
    and e.send_after between now() + interval '4 minutes' and now() + interval '6 minutes',
    'an error goes back to pending with the 5-minute backoff and the reason';

  update public.email_outbox set send_after = now(), attempts = 4 where id = e_id;
  set local role service_role;
  perform public.claim_email_deliveries(1, e_id);
  perform public.complete_email_outbox(e_id, 'error', null, 'Resend responded 422: invalid to');
  reset role;
  select * into e from public.email_outbox where id = e_id;
  assert e.status = 'failed' and e.attempts = 5 and e.last_error = 'Resend responded 422: invalid to',
    'the fifth failure is final, with the reason';

  select * into later from public.email_outbox where task_id = member_task and template = 'form_confirmation';
  update public.email_outbox set send_after = now() where id = later.id;
  set local role service_role;
  perform public.claim_email_deliveries(1, later.id);
  perform public.complete_email_outbox(later.id, 'sent', 'msg_123', null);
  reset role;
  select * into later from public.email_outbox where id = later.id;
  assert later.status = 'sent' and later.sent_at is not null and later.provider_message_id = 'msg_123',
    'a delivered email is sent';
  insert into el_ids values ('failed_email', e_id), ('sent_email', later.id);
end $$;

-- Delivery log and retry (Admin+ of a project of the task) -------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'e8e8e8e8-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
begin
  begin
    perform public.list_email_deliveries((select id from el_ids where name = 'p'));
    raise exception 'an Editor should not read the email log';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.retry_email_delivery((select id from el_ids where name = 'failed_email'));
    raise exception 'an Editor should not retry an email';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'e8e8e8e8-0000-4000-8000-000000000004', false) is not null as ok \gset

do $$
begin
  begin
    perform public.retry_email_delivery((select id from el_ids where name = 'failed_email'));
    raise exception 'a non-member should not see the email';
  exception when no_data_found then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'e8e8e8e8-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from el_ids where name = 'p');
  failed uuid := (select id from el_ids where name = 'failed_email');
  row_kind text;
begin
  assert (select status from public.list_email_deliveries(p) where id = failed) = 'failed'
    and (select last_error from public.list_email_deliveries(p) where id = failed) = 'Resend responded 422: invalid to'
    and (select recipient from public.list_email_deliveries(p) where id = failed) = 'stranger@example.net',
    'the owner sees the failed email with its reason';
  assert (select status from public.list_email_deliveries(p) where id = (select id from el_ids where name = 'sent_email')) = 'sent',
    'and the sent one';
  select kind into row_kind from public.list_email_deliveries(p)
  where task_id = (select id from el_ids where name = 't') limit 1;
  assert row_kind = 'comment', 'comment emails are listed as comment';
  assert not exists (select 1 from public.list_email_deliveries(p) where task_id = (select id from el_ids where name = 'pt')),
    'private-task emails belong to no project log';

  assert public.retry_email_delivery(failed) = 'pending', 'retrying a failed email queues it';
  assert (select max_attempts from public.email_outbox where id = failed) = 6, 'with one more attempt';
  begin
    perform public.retry_email_delivery((select id from el_ids where name = 'sent_email'));
    raise exception 'a sent email should not be retried';
  exception when check_violation then null;
  end;
end $$;

-- Clients reach none of the plumbing.
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'claim_email_outbox(integer,uuid)', 'claim_email_deliveries(integer,uuid)', 'complete_email_outbox(uuid,text,text,text)', 'email_reply_token(uuid)',
    'post_email_reply(text,text,text,text)', 'alhc_kick_delivery()', 'comment_email_block_reason(uuid)',
    'on_comment_email()', 'on_form_submission_follow()', 'comment_email_project(uuid,uuid)',
    'log_email_reply(text,uuid,uuid,uuid,uuid,text,text)', 'email_delivery_admin(uuid)'
  ] loop
    assert not has_function_privilege('authenticated', ('public.' || fn)::regprocedure, 'execute'), fn || ' is not for clients';
    assert not has_function_privilege('anon', ('public.' || fn)::regprocedure, 'execute'), fn || ' is not for anon';
  end loop;
  assert not has_function_privilege('service_role', 'public.alhc_kick_delivery()'::regprocedure, 'execute'),
    'only pg_cron (the owner) runs the kick';
  assert has_function_privilege('service_role', 'public.post_email_reply(text,text,text,text)'::regprocedure, 'execute')
    and has_function_privilege('service_role', 'public.email_reply_token(uuid)'::regprocedure, 'execute'),
    'service_role runs the reply plumbing';
  begin
    perform 1 from public.email_reply_tokens;
    raise exception 'clients should not read reply tokens';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.email_replies;
    raise exception 'clients should not read the reply log';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

-- Reply by email ------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'e8e8e8e8-0000-4000-8000-000000000001', false) is not null as ok \gset
insert into public.comments (task_id, body) select id, 'Second round' from el_ids where name = 't';
reset role;

do $$
declare
  t uuid := (select id from el_ids where name = 't');
  member_email uuid;
  tok text;
  result jsonb;
  c public.comments;
  before_count integer;
begin
  select o.id into member_email from public.email_outbox o join public.comments cm on cm.id = o.comment_id
  where cm.body = 'Second round' and o.to_profile_id = (select id from el_ids where name = 'member');
  assert member_email is not null, 'the member is emailed about the second comment';
  assert not exists (select 1 from public.email_outbox o join public.comments cm on cm.id = o.comment_id
      where cm.body = 'Second round' and o.to_profile_id = (select id from el_ids where name = 'viewer')),
    'the viewer who left the project is no longer emailed';

  set local role service_role;
  tok := public.email_reply_token(member_email);
  assert tok ~ '^[0-9a-f]{40}$', 'a reply token is 40 hex characters';
  assert public.email_reply_token(member_email) = tok, 'one token per task and follower';
  assert public.email_reply_token((select id from el_ids where name = 'sent_email')) is null,
    'only comment emails get a token';

  before_count := (select count(*) from public.comments where task_id = t);

  result := public.post_email_reply(repeat('0', 40), 'el-member@example.com', 'Looks good', 'em_1');
  assert result ->> 'status' = 'rejected' and result ->> 'reason' = 'unknown_token', 'an unknown token is refused';
  result := public.post_email_reply('not-a-token', 'el-member@example.com', 'Looks good', 'em_2');
  assert result ->> 'reason' = 'unknown_token', 'a malformed token is refused';
  result := public.post_email_reply(tok, 'el-owner@example.com', 'Looks good', 'em_3');
  assert result ->> 'status' = 'rejected' and result ->> 'reason' = 'sender_mismatch',
    'another person''s address is refused, even for a real token';
  result := public.post_email_reply(tok, 'el-member@example.com', '   ', 'em_4');
  assert result ->> 'reason' = 'empty', 'an empty reply is refused';
  assert (select count(*) from public.comments where task_id = t) = before_count, 'nothing was posted';

  result := public.post_email_reply(tok, ' EL-Member@example.com ', 'Looks good — ship it', 'em_5');
  assert result ->> 'status' = 'posted', 'the right person replying from their own address posts';
  select * into c from public.comments where id = (result ->> 'comment_id')::uuid;
  assert c.author_id = (select id from el_ids where name = 'member') and c.task_id = t and c.body = 'Looks good — ship it',
    'the reply is a comment by that person';
  assert current_setting('request.jwt.claim.sub', true) is distinct from (select id::text from el_ids where name = 'member'),
    'the impersonation is undone';
  assert exists (select 1 from public.email_outbox where comment_id = c.id and to_profile_id = (select id from el_ids where name = 'owner')),
    'the other followers are emailed about the reply';
  assert not exists (select 1 from public.email_outbox where comment_id = c.id and to_profile_id = (select id from el_ids where name = 'member')),
    'but not its author';

  result := public.post_email_reply(tok, 'el-member@example.com', 'Looks good — ship it', 'em_5');
  assert result ->> 'status' = 'duplicate' and (result ->> 'comment_id')::uuid = c.id, 'a redelivered webhook posts once';
  assert (select count(*) from public.comments where task_id = t) = before_count + 1, 'still one new comment';
  assert (select count(*) from public.email_replies where status = 'rejected' and provider_id in ('em_1', 'em_2', 'em_3', 'em_4')) = 4,
    'rejections are logged';
  reset role;

  -- The member loses access: their token stops working.
  update public.project_members set role = 'viewer'
  where project_id = (select id from el_ids where name = 'p') and profile_id = (select id from el_ids where name = 'member') and deleted_at is null;
  set local role service_role;
  result := public.post_email_reply(tok, 'el-member@example.com', 'One more thing', 'em_6');
  assert result ->> 'status' = 'rejected' and result ->> 'reason' = 'no_access', 'a Viewer can''t reply by email';
  reset role;
  update public.project_members set role = 'editor'
  where project_id = (select id from el_ids where name = 'p') and profile_id = (select id from el_ids where name = 'member') and deleted_at is null;

  -- De-allowlisted people can't either.
  delete from public.allowed_emails where email = 'el-member@example.com';
  set local role service_role;
  result := public.post_email_reply(tok, 'el-member@example.com', 'Still here?', 'em_7');
  assert result ->> 'reason' = 'no_access', 'someone no longer allowlisted can''t reply by email';
  reset role;
  insert into public.allowed_emails (email, note) values ('el-member@example.com', 'email live suite');
end $$;

select 'zz08 email live smoke: ok' as result;
