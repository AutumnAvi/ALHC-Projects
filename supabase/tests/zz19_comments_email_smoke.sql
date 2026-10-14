-- Behavioural checks for Phase: Comments and reply by email (20261014030000_comments_email.sql).
-- Only a form task's submitter gets a replyable email, and only when someone sends them a response:
-- send_submitter_response (invoker, Commenter+) posts an email comment whose address and subject come
-- from the database, queues one email, and mints one reply thread per (task, submitter); clients can't
-- mark comments as emails any other way or edit an emailed one; post_submitter_reply (service_role)
-- posts the submitter's reply as an authorless 'received' comment and refuses everything else; follower
-- emails stay no-reply; the send-time check fails a response whose comment was removed.
-- Fresh people for this suite (unique names; @mention matching reaches everyone with a name):
--   e1919191…01 ce-owner@example.com    Celandine Coalfield, owner of CE P
--   e1919191…02 ce-editor@example.com   Dashiell Dunmore, Editor of CE P
--   e1919191…03 ce-viewer@example.com   Verbena Vantwest, Viewer of CE P
--   e1919191…04 ce-outsider@example.com Osric Oddfellow, allowlisted, no memberships

\set ON_ERROR_STOP 1

create temporary table ce_ids (name text primary key, id uuid) on commit preserve rows;
grant all on ce_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('ce-owner@example.com', 'comments email suite'),
  ('ce-editor@example.com', 'comments email suite'),
  ('ce-viewer@example.com', 'comments email suite'),
  ('ce-outsider@example.com', 'comments email suite');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e1919191-0000-4000-8000-000000000001', 'ce-owner@example.com', now(), '{"full_name":"Celandine Coalfield"}'),
  ('e1919191-0000-4000-8000-000000000002', 'ce-editor@example.com', now(), '{"full_name":"Dashiell Dunmore"}'),
  ('e1919191-0000-4000-8000-000000000003', 'ce-viewer@example.com', now(), '{"full_name":"Verbena Vantwest"}'),
  ('e1919191-0000-4000-8000-000000000004', 'ce-outsider@example.com', now(), '{"full_name":"Osric Oddfellow"}');
insert into ce_ids values
  ('owner', 'e1919191-0000-4000-8000-000000000001'),
  ('editor', 'e1919191-0000-4000-8000-000000000002'),
  ('viewer', 'e1919191-0000-4000-8000-000000000003'),
  ('outsider', 'e1919191-0000-4000-8000-000000000004');

-- Fixtures: a project with a form, a form task (submitted anonymously), and an ordinary task.
set role authenticated;
select set_config('request.jwt.claim.sub', 'e1919191-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid;
  intake uuid;
  f uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'CE P') returning id into p;
  insert into public.sections (project_id, name, sort_order) values (p, 'Intake', 1024) returning id into intake;
  perform public.add_project_member(p, 'ce-editor@example.com', 'editor');
  perform public.add_project_member(p, 'ce-viewer@example.com', 'viewer');
  insert into public.forms (project_id, title, accepting_responses, send_confirmation, destination_section_id)
  values (p, 'CREATIVE REQUEST FORM', true, false, intake) returning id into f;
  insert into ce_ids values ('p', p), ('intake', intake), ('form', f);
  insert into ce_ids values ('plain', public.create_task(p, intake, 'CE plain task'));
end $$;
reset role;

set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
insert into ce_ids
select 'formtask', (public.submit_form((select id from ce_ids where name = 'form'), 'Terry.Jones@Example.net', '{}') ->> 'task_id')::uuid;
insert into ce_ids
select 'formtask2', (public.submit_form((select id from ce_ids where name = 'form'), 'gwen.perrin@example.net', '{}') ->> 'task_id')::uuid;
reset role;

-- Grants -------------------------------------------------------------------------------------------

do $$
begin
  assert has_function_privilege('authenticated', 'public.send_submitter_response(uuid,text)', 'execute'),
    'people send responses through the invoker RPC';
  assert not (select prosecdef from pg_proc where oid = 'public.send_submitter_response(uuid,text)'::regprocedure),
    'send_submitter_response runs as the caller';
  assert not has_function_privilege('anon', 'public.send_submitter_response(uuid,text)', 'execute'), 'anon can''t send';
  assert not has_function_privilege('authenticated', 'public.post_submitter_reply(text,text,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.post_submitter_reply(text,text,text,text)', 'execute')
    and has_function_privilege('service_role', 'public.post_submitter_reply(text,text,text,text)', 'execute'),
    'only the service role posts a submitter''s reply';
  assert not has_function_privilege('authenticated', 'public.submitter_reply_token(uuid)', 'execute')
    and has_function_privilege('service_role', 'public.submitter_reply_token(uuid)', 'execute'),
    'only the service role reads a reply token';
  assert not has_function_privilege('authenticated', 'public.task_submitter(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.on_comment_submitter_response()', 'execute')
    and not has_function_privilege('authenticated', 'public.submitter_response_block_reason(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.fill_comment_email()', 'execute'),
    'the definer helpers are internal';
  assert not has_table_privilege('authenticated', 'public.submitter_reply_threads', 'select')
    and not has_table_privilege('anon', 'public.submitter_reply_threads', 'select'),
    'clients never read reply threads';
end $$;

-- Clients can't mark a comment as an email on their own -------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'e1919191-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from ce_ids where name = 'formtask');
begin
  begin
    insert into public.comments (task_id, body, email_direction, email_address, email_subject)
    values (t, 'Sneaky', 'sent', 'evil@example.com', 'Hi');
    raise exception 'a plain insert marked as an email should fail';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.comments (task_id, body, email_direction, email_address, email_subject)
    values (t, 'Pretend reply', 'received', 'terry.jones@example.net', 'Hi');
    raise exception 'a client-made received email should fail';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.send_submitter_response((select id from ce_ids where name = 'plain'), 'Hello');
    raise exception 'an ordinary task has no submitter to email';
  exception when check_violation then null;
  end;
  begin
    perform public.send_submitter_response(t, '   ');
    raise exception 'an empty response should fail';
  exception when check_violation then null;
  end;
end $$;

-- Viewers can't send (comments RLS: Commenter+).
select set_config('request.jwt.claim.sub', 'e1919191-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
begin
  perform public.send_submitter_response((select id from ce_ids where name = 'formtask'), 'From a viewer');
  raise exception 'a Viewer should not send a response';
exception when insufficient_privilege then null;
end $$;

-- An Editor sends a response ------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'e1919191-0000-4000-8000-000000000002', false) is not null as ok \gset
insert into ce_ids select 'response', public.send_submitter_response((select id from ce_ids where name = 'formtask'), E'Hi Terry,\n\nAre you following the holiday theme?');
-- The transaction-local switch with a forged address: the database fills the real one in.
do $$
declare
  t uuid := (select id from ce_ids where name = 'formtask');
  c uuid;
begin
  perform set_config('alhc.submitter_response', t::text, true);
  insert into public.comments (task_id, body, email_direction, email_address, email_subject)
  values (t, 'Second note', 'sent', 'evil@example.com', 'Fake subject') returning id into c;
  perform set_config('alhc.submitter_response', '', true);
  insert into ce_ids values ('response2', c);
end $$;
reset role;

do $$
declare
  c public.comments;
  o public.email_outbox;
  t uuid := (select id from ce_ids where name = 'formtask');
begin
  select * into c from public.comments where id = (select id from ce_ids where name = 'response');
  assert c.author_id = (select id from ce_ids where name = 'editor') and c.email_direction = 'sent'
    and c.email_address = 'terry.jones@example.net'
    and c.email_subject = 'Re: "CREATIVE REQUEST FORM" submission received',
    'the response is the sender''s comment, addressed to the submitter with Asana''s subject';
  select * into c from public.comments where id = (select id from ce_ids where name = 'response2');
  assert c.email_address = 'terry.jones@example.net' and c.email_subject like 'Re: "CREATIVE REQUEST FORM"%',
    'a forged address or subject is replaced by the database';

  select * into o from public.email_outbox
  where payload ->> 'kind' = 'submitter_response' and payload ->> 'comment_id' = (select id::text from ce_ids where name = 'response');
  assert o.id is not null and o.task_id = t and o.to_email = 'terry.jones@example.net' and o.comment_id is null
    and o.to_profile_id is null and o.template = 'custom'
    and o.subject = 'Re: "CREATIVE REQUEST FORM" submission received'
    and o.payload ->> 'author_name' = 'Dashiell Dunmore'
    and o.payload ->> 'message' like 'Hi Terry,%'
    and o.payload ? 'thread_id' and not (o.payload ? 'token'),
    'one email to the submitter is queued (no token in the payload)';
  assert (select count(*) from public.email_outbox where payload ->> 'kind' = 'submitter_response' and task_id = t) = 2,
    'one email per response';
  assert (select count(*) from public.submitter_reply_threads where task_id = t and revoked_at is null) = 1,
    'both responses share one reply thread';
  assert public.email_outbox_kind(o) = 'submitter_response', 'Admin console → Email names the kind';
  assert not exists (select 1 from public.task_stories where task_id = t and kind = 'email_queued'),
    'no email story: the comment is the activity';
  assert exists (select 1 from public.task_followers where task_id = t and profile_id = (select id from ce_ids where name = 'editor') and deleted_at is null),
    'the sender follows the task like any commenter';
end $$;

-- The Viewer reads the email columns with the comment.
set role authenticated;
select set_config('request.jwt.claim.sub', 'e1919191-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
begin
  assert (select email_address from public.comments where id = (select id from ce_ids where name = 'response')) = 'terry.jones@example.net',
    'task readers see who a response went to';
end $$;

-- An emailed comment can't be edited or re-addressed; it can be removed.
select set_config('request.jwt.claim.sub', 'e1919191-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  c uuid := (select id from ce_ids where name = 'response');
begin
  begin
    update public.comments set body = 'Changed' where id = c;
    raise exception 'an emailed comment''s text should be fixed';
  exception when check_violation then null;
  end;
  begin
    update public.comments set email_address = 'evil@example.com' where id = c;
    raise exception 'the address should be fixed';
  exception when insufficient_privilege then null;
  end;
  update public.comments set deleted_at = now() where id = (select id from ce_ids where name = 'response2');
end $$;
reset role;

-- Delivery: the Reply-To token and the send-time check ---------------------------------------------

set role service_role;
do $$
declare
  first_email uuid := (select id from public.email_outbox where payload ->> 'comment_id' = (select id::text from ce_ids where name = 'response'));
  second_email uuid := (select id from public.email_outbox where payload ->> 'comment_id' = (select id::text from ce_ids where name = 'response2'));
  tok text;
  claimed integer;
begin
  tok := public.submitter_reply_token(first_email);
  assert tok ~ '^[0-9a-f]{40}$', 'a response email has a reply token';
  assert public.submitter_reply_token(second_email) = tok, 'the same thread, the same token';
  insert into ce_ids values ('first_email', first_email);
  perform set_config('ce.token', tok, false);

  select count(*) into claimed from public.claim_email_deliveries(20, second_email);
  assert claimed = 0, 'a response whose comment was removed is not sent';
  assert (select status = 'failed' and last_error = 'Not sent: the comment was removed' from public.email_outbox where id = second_email),
    'it fails with the reason';
  select count(*) into claimed from public.claim_email_deliveries(20, first_email);
  assert claimed = 1, 'the live response is claimed for sending';
end $$;
reset role;

-- Ordinary follower emails stay no-reply.
do $$
declare
  follower_email uuid;
begin
  -- The owner comments; the editor (a follower) gets an ordinary comment email.
  perform set_config('request.jwt.claim.sub', 'e1919191-0000-4000-8000-000000000001', true);
  set local role authenticated;
  insert into public.comments (task_id, body) values ((select id from ce_ids where name = 'formtask'), 'Owner note');
  reset role;
  select id into follower_email from public.email_outbox o
  where o.comment_id = (select id from public.comments where body = 'Owner note')
    and o.to_profile_id = (select id from ce_ids where name = 'editor');
  assert follower_email is not null, 'the follower is emailed about the comment';
  set local role service_role;
  assert public.email_reply_token(follower_email) is null and public.submitter_reply_token(follower_email) is null,
    'a follower''s comment email has no reply address';
  reset role;
end $$;

-- The submitter replies -----------------------------------------------------------------------------

set role service_role;
do $$
declare
  tok text := current_setting('ce.token');
  t uuid := (select id from ce_ids where name = 'formtask');
  result jsonb;
  c public.comments;
  before_count integer := (select count(*) from public.comments where task_id = t);
  follower_token text := repeat('ab', 20);
begin
  result := public.post_submitter_reply(repeat('0', 40), 'terry.jones@example.net', 'Hello', 'ce_1');
  assert result ->> 'status' = 'rejected' and result ->> 'reason' = 'unknown_token', 'an unknown token is refused';
  result := public.post_submitter_reply('not-a-token', 'terry.jones@example.net', 'Hello', 'ce_2');
  assert result ->> 'reason' = 'unknown_token', 'a malformed token is refused';
  result := public.post_submitter_reply(tok, 'someone.else@example.net', 'Hello', 'ce_3');
  assert result ->> 'reason' = 'sender_mismatch', 'only the submitter''s address may reply';
  result := public.post_submitter_reply(tok, 'terry.jones@example.net', '  ', 'ce_4');
  assert result ->> 'reason' = 'empty', 'an empty reply is refused';

  -- A follower token (the old design) is not a submitter thread.
  insert into public.email_reply_tokens (task_id, profile_id, token)
  values (t, (select id from ce_ids where name = 'editor'), follower_token);
  result := public.post_submitter_reply(follower_token, 'ce-editor@example.com', 'Hello', 'ce_5');
  assert result ->> 'reason' = 'unknown_token', 'a follower token posts nothing';
  result := public.post_email_reply(follower_token, 'ce-editor@example.com', 'Hello', 'ce_6');
  assert result ->> 'reason' = 'follower_replies_off', 'and the old follower path refuses it too';
  assert (select count(*) from public.comments where task_id = t) = before_count, 'nothing was posted';
  assert (select count(*) from public.email_replies where status = 'rejected' and provider_id in ('ce_1', 'ce_2', 'ce_3', 'ce_4', 'ce_5', 'ce_6')) = 6,
    'every refusal is logged';

  result := public.post_submitter_reply(tok, ' Terry.Jones@Example.NET ', 'Perfect! It''s printed. Thanks @Dashiell Dunmore', 'ce_7');
  assert result ->> 'status' = 'posted', 'the submitter''s reply posts';
  select * into c from public.comments where id = (result ->> 'comment_id')::uuid;
  assert c.task_id = t and c.author_id is null and c.rule_id is null and c.email_direction = 'received'
    and c.email_address = 'terry.jones@example.net' and c.email_subject = 'Re: "CREATIVE REQUEST FORM" submission received'
    and c.body like 'Perfect!%',
    'the reply is an authorless received-email comment with the thread''s subject';
  insert into ce_ids values ('reply', c.id);
  assert not exists (select 1 from public.comment_mentions where comment_id = c.id), 'an emailed reply mentions nobody';
  assert exists (select 1 from public.inbox_items where comment_id = c.id and kind = 'comment' and actor_id is null
      and recipient_id = (select id from ce_ids where name = 'editor')),
    'followers hear about the reply in their Inbox';
  assert exists (select 1 from public.email_outbox where comment_id = c.id and to_profile_id = (select id from ce_ids where name = 'editor')
      and payload ->> 'author_name' = 'terry.jones@example.net'),
    'and by comment email, naming the address';
  assert not exists (select 1 from public.email_outbox where payload ->> 'kind' = 'submitter_response' and payload ->> 'comment_id' = c.id::text),
    'a reply is never emailed back to the submitter';
  assert current_setting('request.jwt.claim.sub', true) is distinct from 'x', 'the claim is restored';

  result := public.post_submitter_reply(tok, 'terry.jones@example.net', 'Perfect! It''s printed.', 'ce_7');
  assert result ->> 'status' = 'duplicate' and (result ->> 'comment_id')::uuid = c.id, 'a redelivered webhook posts once';
  assert (select last_used_at is not null from public.submitter_reply_threads where token = tok), 'the thread records its use';
end $$;

-- At most 20 replies an hour on one thread.
do $$
declare
  tok text := current_setting('ce.token');
  result jsonb;
begin
  for i in 1 .. 19 loop
    result := public.post_submitter_reply(tok, 'terry.jones@example.net', 'Reply ' || i, 'ce_rate_' || i);
    assert result ->> 'status' = 'posted', 'replies under the limit post';
  end loop;
  result := public.post_submitter_reply(tok, 'terry.jones@example.net', 'One too many', 'ce_rate_20');
  assert result ->> 'reason' = 'rate_limited', 'the 21st reply in an hour is refused';
end $$;
reset role;

-- A trashed task takes no replies.
set role authenticated;
select set_config('request.jwt.claim.sub', 'e1919191-0000-4000-8000-000000000001', false) is not null as ok \gset
update public.tasks set deleted_at = now() where id = (select id from ce_ids where name = 'formtask');
reset role;
set role service_role;
do $$
declare
  result jsonb;
begin
  result := public.post_submitter_reply(current_setting('ce.token'), 'terry.jones@example.net', 'Still there?', 'ce_trash');
  assert result ->> 'reason' = 'task_unavailable', 'a trashed task takes no replies';
end $$;
reset role;

-- Nobody can edit or remove a received reply through the API (it has no author).
set role authenticated;
select set_config('request.jwt.claim.sub', 'e1919191-0000-4000-8000-000000000001', false) is not null as ok \gset
update public.tasks set deleted_at = null where id = (select id from ce_ids where name = 'formtask');
update public.comments set body = 'Rewritten' where id = (select id from ce_ids where name = 'reply');
reset role;
do $$
begin
  assert (select body like 'Perfect!%' from public.comments where id = (select id from ce_ids where name = 'reply')),
    'a submitter''s reply can''t be rewritten';
end $$;

select 'zz19 comments email smoke: ok' as result;
