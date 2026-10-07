-- Behavioural checks for Phase: Integration depth: Slack Block Kit payloads and the {task_link} token
-- (escaped, unforgeable, never a public URL), HMAC signing secrets (project and per action; never
-- readable by anyone, copied onto queued rows, the project key never sent to an action's own URL), the
-- delivery log and retry / cancel (Admin+ only; workspace admins get no bypass), capped exponential
-- backoff and the attempt cap, templates never carrying signing references, and anon getting nothing.
-- Fresh people for this suite (no memberships from earlier suites):
--   f5f5…01 id-owner@example.com     owner of ID P
--   f5f5…02 id-admin@example.com     Admin of P
--   f5f5…03 id-editor@example.com    Editor of P
--   f5f5…04 id-viewer@example.com    Viewer of P
--   f5f5…05 id-outsider@example.com  no memberships
-- plus the workspace admin an earlier suite left (not a member of P).

\set ON_ERROR_STOP 1

create temporary table id_ids (name text primary key, id uuid) on commit preserve rows;
grant all on id_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('id-owner@example.com', 'integration depth suite'),
  ('id-admin@example.com', 'integration depth suite'),
  ('id-editor@example.com', 'integration depth suite'),
  ('id-viewer@example.com', 'integration depth suite'),
  ('id-outsider@example.com', 'integration depth suite');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('f5f5f5f5-0000-4000-8000-000000000001', 'id-owner@example.com', now(), '{"full_name":"Iris Owner"}'),
  ('f5f5f5f5-0000-4000-8000-000000000002', 'id-admin@example.com', now(), '{"full_name":"Abe Admin"}'),
  ('f5f5f5f5-0000-4000-8000-000000000003', 'id-editor@example.com', now(), '{"full_name":"Eve <Editor>"}'),
  ('f5f5f5f5-0000-4000-8000-000000000004', 'id-viewer@example.com', now(), '{"full_name":"Val Viewer"}'),
  ('f5f5f5f5-0000-4000-8000-000000000005', 'id-outsider@example.com', now(), '{"full_name":"Otto Outsider"}');

insert into id_ids values
  ('owner', 'f5f5f5f5-0000-4000-8000-000000000001'),
  ('admin', 'f5f5f5f5-0000-4000-8000-000000000002'),
  ('editor', 'f5f5f5f5-0000-4000-8000-000000000003'),
  ('viewer', 'f5f5f5f5-0000-4000-8000-000000000004'),
  ('outsider', 'f5f5f5f5-0000-4000-8000-000000000005'),
  ('ws_admin', (select profile_id from public.workspace_admins where deleted_at is null order by created_at limit 1));

-- Helpers (internal; run as the migration owner) ----------------------------------------------------

do $$
begin
  assert (select id from id_ids where name = 'ws_admin') is not null, 'an earlier suite left a workspace admin';
  assert public.integration_retry_delay(1) = interval '5 minutes', 'first retry after 5 minutes';
  assert public.integration_retry_delay(2) = interval '10 minutes', 'then 10';
  assert public.integration_retry_delay(3) = interval '20 minutes', 'then 20';
  assert public.integration_retry_delay(4) = interval '30 minutes', 'capped at 30';
  assert public.integration_retry_delay(9) = interval '30 minutes', 'still capped';
  assert public.integration_retry_delay(1000) = interval '30 minutes', 'huge counts stay capped';
  assert public.integration_retry_delay(0) = interval '5 minutes' and public.integration_retry_delay(null) = interval '5 minutes',
    'odd input falls back to the first delay';
  assert not public.integration_header_ok('X-ALHC-Signature') and not public.integration_header_ok('x-alhc-timestamp'),
    'the signature headers are reserved';
  assert public.integration_header_ok('X-ALHC-Webhook-Secret'), 'the shared-secret header still works';
  assert not exists (
    select 1 from information_schema.columns where table_schema = 'public' and column_name ilike '%signature%'
  ), 'signatures are never stored';
end $$;

-- Fixtures ----------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'f5f5f5f5-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  p uuid;
  todo uuid;
  doing uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'ID P & <Co>') returning id into p;
  insert into public.sections (project_id, name, sort_order) values (p, 'To do', 1024) returning id into todo;
  insert into public.sections (project_id, name, sort_order) values (p, 'Doing', 2048) returning id into doing;
  perform public.add_project_member(p, 'id-admin@example.com', 'admin');
  perform public.add_project_member(p, 'id-editor@example.com', 'editor');
  perform public.add_project_member(p, 'id-viewer@example.com', 'viewer');
  insert into id_ids values ('p', p), ('todo', todo), ('doing', doing);
end $$;

-- Project signing secret: Admin+, validated, never returned -----------------------------------------

do $$
declare
  p uuid := (select id from id_ids where name = 'p');
begin
  perform set_config('request.jwt.claim.sub', (select id::text from id_ids where name = 'editor'), true);
  begin
    perform public.set_project_integration(p, 'signing_secret', 'whsec_editor_should_not_set_this');
    raise exception 'editors should not set a signing secret';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'f5f5f5f5-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from id_ids where name = 'p');
  shown jsonb;
begin
  begin
    perform public.set_project_integration(p, 'signing_secret', 'too-short');
    raise exception 'short signing secrets should fail';
  exception when check_violation then null;
  end;
  perform public.set_project_integration(p, 'slack_webhook_url', 'https://hooks.slack.com/services/T5/B5/idSlackTok1');
  perform public.set_project_integration(p, 'webhook_url', 'https://proj.example.com/hook/idProjTok2');
  shown := public.set_project_integration(p, 'signing_secret', 'whsec_project_old_key_0000000000');
  shown := public.set_project_integration(p, 'signing_secret', 'whsec_project_key_1111111111111111');
  assert (shown ->> 'signing_secret_set')::boolean and shown ->> 'signing_secret_created_at' is not null,
    format('the project secret is reported as set, got %s', shown);
  assert shown::text not like '%whsec_%', 'settings never return a signing secret';
  assert (public.get_project_integrations(p) ->> 'signing_secret_set')::boolean, 'get reports it too';
end $$;

reset role;
do $$
declare
  p uuid := (select id from id_ids where name = 'p');
begin
  assert (select count(*) from public.integration_secrets
          where project_id = p and rule_id is null and kind = 'signing_secret' and deleted_at is null) = 1,
    'regenerating retires the old project secret';
  assert (select value from public.integration_secrets
          where project_id = p and rule_id is null and kind = 'signing_secret' and deleted_at is null)
    = 'whsec_project_key_1111111111111111', 'the newest project secret is active';
end $$;

-- Rules: Block Kit format, per-action signing secrets ------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'f5f5f5f5-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from id_ids where name = 'p');
  doing uuid := (select id from id_ids where name = 'doing');
  r uuid;
  stored jsonb;
begin
  begin
    insert into public.rules (project_id, name, trigger_type, trigger_config, actions)
    values (p, 'Bad format', 'section_changed', jsonb_build_object('section_id', doing),
      '[{"type": "send_slack", "message": "hi", "format": "rich"}]');
    raise exception 'unknown Slack formats should fail';
  exception when check_violation then null;
  end;
  begin
    insert into public.rules (project_id, name, trigger_type, trigger_config, actions)
    values (p, 'Short signing', 'section_changed', jsonb_build_object('section_id', doing),
      '[{"type": "call_webhook", "url": "https://own.example.com/hook/x", "signing_secret": "short"}]');
    raise exception 'short per-action signing secrets should fail';
  exception when check_violation then null;
  end;

  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions)
  values (p, 'Card', true, 'section_changed', jsonb_build_object('section_id', doing),
    '[{"type": "send_slack", "format": "blocks", "message": "New in {project}: {task_link} for {assignee}"}]')
  returning id into r;
  insert into id_ids values ('card_rule', r);

  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions)
  values (p, 'Plain link', true, 'section_changed', jsonb_build_object('section_id', doing),
    '[{"type": "send_slack", "message": "{task_link} is {section}", "use_project_webhook": true}]')
  returning id into r;
  insert into id_ids values ('plain_rule', r);

  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions)
  values (p, 'Own signed', true, 'section_changed', jsonb_build_object('section_id', doing),
    '[{"type": "call_webhook", "url": "https://own.example.com/hook/idOwnTok3",
       "signing_secret": "whsec_action_key_2222222222222222"}]')
  returning id, actions into r, stored;
  assert stored -> 0 ? 'signing_ref' and (stored -> 0 ->> 'signing_set')::boolean, format('ref + flag stored, got %s', stored);
  assert not stored -> 0 ? 'signing_secret' and stored::text not like '%whsec_%', 'rules.actions never holds the signing secret';
  insert into id_ids values ('own_signed_rule', r);

  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions)
  values (p, 'Own unsigned', true, 'section_changed', jsonb_build_object('section_id', doing),
    '[{"type": "call_webhook", "url": "https://other.example.com/hook/idOtherTok4"}]')
  returning id into r;
  insert into id_ids values ('own_unsigned_rule', r);

  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions)
  values (p, 'Project hook', true, 'section_changed', jsonb_build_object('section_id', doing),
    '[{"type": "call_webhook", "use_project_webhook": true}]')
  returning id into r;
  insert into id_ids values ('project_rule', r);

  -- Saving again with the reference keeps it; "" removes it.
  update public.rules set name = 'Own signed' where id = (select id from id_ids where name = 'own_signed_rule')
  returning actions into stored;
  assert (stored -> 0 ->> 'signing_set')::boolean, 'the signing reference survives an edit';
end $$;

-- Viewers still read rules, never a secret; nobody reads the secret tables.
do $$
declare
  p uuid := (select id from id_ids where name = 'p');
  who text;
begin
  foreach who in array array['owner', 'admin', 'editor', 'viewer', 'ws_admin', 'outsider'] loop
    perform set_config('request.jwt.claim.sub', (select id::text from id_ids where name = who), true);
    assert not exists (select 1 from public.rules where project_id = p and actions::text like '%whsec_%'),
      format('%s reads no secret in rules', who);
    begin
      perform 1 from public.integration_secrets;
      raise exception '% should not read integration_secrets', who;
    exception when insufficient_privilege then null;
    end;
    begin
      perform 1 from public.integration_outbox;
      raise exception '% should not read integration_outbox', who;
    exception when insufficient_privilege then null;
    end;
  end loop;
end $$;

-- Rule fire --------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'f5f5f5f5-0000-4000-8000-000000000003', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from id_ids where name = 'p');
  t uuid;
begin
  t := public.create_task(p, (select id from id_ids where name = 'todo'), '<!channel> Q4 & launch {task_link}');
  insert into id_ids values ('t', t);
end $$;

-- A separate transaction: changes made while a task is created don't fire section rules.
do $$
declare
  p uuid := (select id from id_ids where name = 'p');
  t uuid := (select id from id_ids where name = 't');
begin
  update public.tasks set due_on = '2026-11-02', assignee_id = (select id from id_ids where name = 'editor') where id = t;
  update public.task_projects set section_id = (select id from id_ids where name = 'doing') where task_id = t and project_id = p;
  assert (select count(*) from public.rule_runs where task_id = t and status = 'succeeded') = 5,
    format('all five rules ran, got %s', (select jsonb_agg(detail) from public.rule_runs where task_id = t));
  assert not exists (select 1 from public.task_stories where task_id = t and data::text like '%whsec_%'),
    'stories never carry a secret';
end $$;

reset role;

do $$
declare
  p uuid := (select id from id_ids where name = 'p');
  t uuid := (select id from id_ids where name = 't');
  link text;
  card public.integration_outbox;
  plain public.integration_outbox;
  own_signed public.integration_outbox;
  own_unsigned public.integration_outbox;
  proj public.integration_outbox;
begin
  link := '<alhc-link:/projects/' || p || '?task=' || t || '|&lt;!channel&gt; Q4 &amp; launch {task_link}>';
  select * into card from public.integration_outbox where rule_id = (select id from id_ids where name = 'card_rule');
  select * into plain from public.integration_outbox where rule_id = (select id from id_ids where name = 'plain_rule');
  select * into own_signed from public.integration_outbox where rule_id = (select id from id_ids where name = 'own_signed_rule');
  select * into own_unsigned from public.integration_outbox where rule_id = (select id from id_ids where name = 'own_unsigned_rule');
  select * into proj from public.integration_outbox where rule_id = (select id from id_ids where name = 'project_rule');

  -- Block Kit: fallback text, linked title, fields, Open task button; everything escaped.
  assert card.payload ->> 'text' = 'New in ID P &amp; &lt;Co&gt;: ' || link || ' for @Eve &lt;Editor&gt;',
    format('Block Kit fallback text, got %s', card.payload ->> 'text');
  assert jsonb_array_length(card.payload -> 'blocks') = 3, 'message, task card, and button blocks';
  assert card.payload #>> '{blocks,0,text,text}' = card.payload ->> 'text', 'the message is the first block';
  assert card.payload #>> '{blocks,1,text,text}' = '*' || link || '*', 'the title is linked';
  assert card.payload #>> '{blocks,1,fields,0,text}' = '*Project*' || chr(10) || 'ID P &amp; &lt;Co&gt;', 'project field';
  assert card.payload #>> '{blocks,1,fields,1,text}' = '*Assignee*' || chr(10) || 'Eve &lt;Editor&gt;', 'assignee field';
  assert card.payload #>> '{blocks,1,fields,2,text}' = '*Due*' || chr(10) || 'Nov 2, 2026', 'due field';
  assert card.payload #>> '{blocks,1,fields,3,text}' = '*Status*' || chr(10) || 'Open · Doing', 'status field';
  assert card.payload #>> '{blocks,2,elements,0,url}' = 'alhc-link:/projects/' || p || '?task=' || t, 'the button points at the task';
  assert card.payload #>> '{blocks,2,elements,0,text,text}' = 'Open task', 'Open task button';
  assert card.payload::text not like '%<!channel>%' and card.payload::text not like '%https://%',
    'no unescaped mention and no URL in the stored card';
  assert (length(card.payload ->> 'text') - length(replace(card.payload ->> 'text', '<alhc-link:', ''))) / length('<alhc-link:') = 1,
    'a title containing {task_link} can''t add a second link';
  assert card.signing_secret is null, 'Slack is never signed';

  -- Plain text keeps the old shape; {task_link} works there too.
  assert plain.payload = jsonb_build_object('text', link || ' is Doing'), format('plain text payload, got %s', plain.payload);
  assert plain.target_hint = 'hooks.slack.com …Tok1', 'project Slack URL';

  -- Signing: the action's own key to its own URL, the project key only to the project URL.
  assert own_signed.signing_secret = 'whsec_action_key_2222222222222222', 'own URL signed with its own key';
  assert own_unsigned.signing_secret is null, 'the project key never goes to an action''s own URL';
  assert proj.signing_secret = 'whsec_project_key_1111111111111111', 'project URL signed with the project key';
  assert own_signed.payload::text not like '%whsec_%' and own_signed.headers::text not like '%whsec_%',
    'the key is neither in the body nor in a header';
  assert own_signed.max_attempts = 5 and own_signed.status = 'pending', 'new rows: 5 attempts, pending';

  -- Other rule text leaves {task_link} as typed.
  assert public.render_rule_text('see {task_link}', t, p, '{}') = 'see {task_link}', 'plain rule text has no link token';

  insert into id_ids values ('d_card', card.id), ('d_plain', plain.id), ('d_own', own_signed.id),
    ('d_unsigned', own_unsigned.id), ('d_proj', proj.id);
end $$;

-- Rotating the project key doesn't touch queued rows; clearing it stops signing new ones.
set role authenticated;
select set_config('request.jwt.claim.sub', 'f5f5f5f5-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from id_ids where name = 'p');
begin
  perform public.set_project_integration(p, 'signing_secret', 'whsec_project_key_3333333333333333');
  assert not (public.set_project_integration(p, 'signing_secret', '') ->> 'signing_secret_set')::boolean, 'cleared';
end $$;
reset role;
do $$
begin
  assert (select signing_secret from public.integration_outbox where id = (select id from id_ids where name = 'd_proj'))
    = 'whsec_project_key_1111111111111111', 'queued rows keep the key they were queued with';
  assert not exists (
    select 1 from public.integration_secrets
    where project_id = (select id from id_ids where name = 'p') and rule_id is null and deleted_at is null
  ), 'no active project key after clearing';
end $$;

-- Delivery log: Admin+ only, hints only ------------------------------------------------------------

set role authenticated;
do $$
declare
  p uuid := (select id from id_ids where name = 'p');
  d uuid := (select id from id_ids where name = 'd_proj');
  who text;
  rec jsonb;
  n integer := 0;
begin
  foreach who in array array['editor', 'viewer', 'outsider', 'ws_admin'] loop
    perform set_config('request.jwt.claim.sub', (select id::text from id_ids where name = who), true);
    begin
      perform public.list_integration_deliveries(p);
      raise exception '% should not read the delivery log', who;
    exception when insufficient_privilege then null;
    end;
    begin
      perform public.retry_integration_delivery(d);
      raise exception '% should not retry a delivery', who;
    exception when insufficient_privilege or no_data_found then
      assert (who in ('editor', 'viewer')) = (sqlstate = '42501'),
        format('%s: members are refused, non-members learn nothing (got %s)', who, sqlstate);
    end;
    begin
      perform public.cancel_integration_delivery(d);
      raise exception '% should not cancel a delivery', who;
    exception when insufficient_privilege or no_data_found then null;
    end;
  end loop;

  foreach who in array array['owner', 'admin'] loop
    perform set_config('request.jwt.claim.sub', (select id::text from id_ids where name = who), true);
    n := 0;
    for rec in select to_jsonb(l) from public.list_integration_deliveries(p) l loop
      n := n + 1;
      assert rec::text not like '%whsec_%' and rec::text not like '%https://%' and rec::text not like '%idOwnTok3%'
        and rec::text not like '%/hook/%', format('the log shows hints only, got %s', rec);
      assert not (rec ?| array['target_url', 'headers', 'payload', 'signing_secret', 'provider_response', 'signature']),
        'no URL, header, payload, response body, secret, or signature columns';
    end loop;
    assert n = 5, format('%s sees the five deliveries, got %s', who, n);
  end loop;
  assert (select signed from public.list_integration_deliveries(p) where id = d), 'signed deliveries are marked';
  assert not (select signed from public.list_integration_deliveries(p) where id = (select id from id_ids where name = 'd_unsigned')),
    'unsigned ones are not';
  assert (select task_title from public.list_integration_deliveries(p) where id = d) = '<!channel> Q4 & launch {task_link}',
    'the admin sees the task title';
end $$;

-- Backoff and the attempt cap ------------------------------------------------------------------------

reset role;
set role service_role;
do $$
declare
  d uuid := (select id from id_ids where name = 'd_own');
  claimed public.integration_outbox;
  row_after public.integration_outbox;
  waits interval[] := array[interval '5 minutes', interval '10 minutes', interval '20 minutes', interval '30 minutes'];
  i integer;
begin
  for i in 1..5 loop
    update public.integration_outbox set send_after = now() - interval '1 second' where id = d;
    select * into claimed from public.claim_integration_outbox(10, d);
    assert claimed.id = d and claimed.attempts = i, format('attempt %s claimed', i);
    assert claimed.signing_secret = 'whsec_action_key_2222222222222222', 'the drain gets the key with the row';
    perform public.complete_integration_outbox(d, 'error', '{"status": 503, "body": "down https://own.example.com/hook/idOwnTok3"}'::jsonb,
      'own.example.com …Tok3 responded 503');
    select * into row_after from public.integration_outbox where id = d;
    if i < 5 then
      assert row_after.status = 'pending', format('attempt %s goes back to pending', i);
      assert row_after.send_after between now() + waits[i] - interval '5 seconds' and now() + waits[i] + interval '5 seconds',
        format('attempt %s waits %s, got %s', i, waits[i], row_after.send_after - now());
    else
      assert row_after.status = 'failed', 'the fifth failure gives up';
    end if;
  end loop;
  update public.integration_outbox set send_after = now() - interval '1 second' where id = d;
  assert not exists (select 1 from public.claim_integration_outbox(10, d)), 'failed rows are not claimed';
end $$;

reset role;
do $$
begin
  assert exists (
    select 1 from public.task_stories where task_id = (select id from id_ids where name = 't') and kind = 'integration_failed'
      and data ->> 'target' = 'own.example.com …Tok3' and (data ->> 'attempts')::int = 5
  ), 'the final failure still writes the redacted story';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'f5f5f5f5-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from id_ids where name = 'p');
  d uuid := (select id from id_ids where name = 'd_own');
  logged record;
  result jsonb;
begin
  select * into logged from public.list_integration_deliveries(p) where id = d;
  assert logged.status = 'failed' and logged.attempts = 5 and logged.max_attempts = 5 and logged.response_status = 503,
    format('the log shows the failure, got %s', to_jsonb(logged));
  assert logged.last_error = 'own.example.com …Tok3 responded 503' and logged.next_attempt_at is null, 'error, no next attempt';

  result := public.retry_integration_delivery(d);
  assert result ->> 'status' = 'pending' and (result ->> 'max_attempts')::int = 6, format('one more attempt, got %s', result);
end $$;

reset role;
set role service_role;
do $$
declare
  d uuid := (select id from id_ids where name = 'd_own');
  claimed public.integration_outbox;
begin
  -- Manual retries: one attempt each, up to 10 in total.
  for i in 6..10 loop
    select * into claimed from public.claim_integration_outbox(10, d);
    assert claimed.id = d and claimed.attempts = i, format('retry attempt %s is claimed right away', i);
    assert claimed.payload = (select payload from public.integration_outbox where id = d), 'the same payload is reused';
    perform public.complete_integration_outbox(d, 'error', '{"status": 500}'::jsonb, 'own.example.com …Tok3 responded 500');
    assert (select status from public.integration_outbox where id = d) = 'failed', format('retry %s failed again', i);
    if i < 10 then
      perform set_config('role', 'authenticated', true);
      perform set_config('request.jwt.claim.sub', 'f5f5f5f5-0000-4000-8000-000000000002', true);
      perform public.retry_integration_delivery(d);
      perform set_config('role', 'service_role', true);
    end if;
  end loop;
end $$;

reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', 'f5f5f5f5-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  d uuid := (select id from id_ids where name = 'd_own');
begin
  assert (select attempts from public.list_integration_deliveries((select id from id_ids where name = 'p')) where id = d) = 10,
    'ten attempts in all';
  begin
    perform public.retry_integration_delivery(d);
    raise exception 'retries stop at 10 attempts';
  exception when check_violation then null;
  end;
end $$;

-- Send now: a waiting delivery is due immediately, with the same limit.
reset role;
update public.integration_outbox set send_after = now() + interval '1 hour'
where id = (select id from id_ids where name = 'd_card');
set role authenticated;
select set_config('request.jwt.claim.sub', 'f5f5f5f5-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from id_ids where name = 'p');
  card uuid := (select id from id_ids where name = 'd_card');
  proj uuid := (select id from id_ids where name = 'd_proj');
  result jsonb;
begin
  assert (select next_attempt_at > now() + interval '50 minutes' from public.list_integration_deliveries(p) where id = card),
    'the log shows when a waiting delivery is due';
  result := public.retry_integration_delivery(card);
  assert result ->> 'status' = 'pending' and (result ->> 'max_attempts')::int = 5 and (result ->> 'attempts')::int = 0,
    format('send now keeps the limit, got %s', result);
  assert (select next_attempt_at <= now() from public.list_integration_deliveries(p) where id = card), 'and is due now';

  -- Cancel: waiting deliveries only.
  result := public.cancel_integration_delivery(proj);
  assert result ->> 'status' = 'cancelled', 'cancelled';
  begin
    perform public.cancel_integration_delivery(proj);
    raise exception 'a cancelled delivery can''t be cancelled again';
  exception when check_violation then null;
  end;
  begin
    perform public.retry_integration_delivery(proj);
    raise exception 'a cancelled delivery can''t be retried';
  exception when check_violation then null;
  end;
  begin
    perform public.cancel_integration_delivery((select id from id_ids where name = 'd_own'));
    raise exception 'a failed delivery can''t be cancelled';
  exception when check_violation then null;
  end;
end $$;

reset role;
set role service_role;
do $$
declare
  proj uuid := (select id from id_ids where name = 'd_proj');
  card uuid := (select id from id_ids where name = 'd_card');
begin
  update public.integration_outbox set send_after = now() - interval '1 second' where id = proj;
  assert not exists (select 1 from public.claim_integration_outbox(10, proj)), 'cancelled rows are never claimed';
  perform public.claim_integration_outbox(10, card);
  perform public.complete_integration_outbox(card, 'sent', '{"status": 200, "body": "ok"}'::jsonb, null);
end $$;

reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', 'f5f5f5f5-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  begin
    perform public.retry_integration_delivery((select id from id_ids where name = 'd_card'));
    raise exception 'a sent delivery can''t be retried';
  exception when check_violation then null;
  end;
end $$;

-- An archived project caps its admin at Viewer: no log.
select set_config('request.jwt.claim.sub', 'f5f5f5f5-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from id_ids where name = 'p');
begin
  perform public.set_project_archived(p, true);
  perform set_config('request.jwt.claim.sub', (select id::text from id_ids where name = 'admin'), true);
  begin
    perform public.list_integration_deliveries(p);
    raise exception 'archived projects are read-only: no delivery log';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claim.sub', (select id::text from id_ids where name = 'owner'), true);
  perform public.set_project_archived(p, false);
end $$;

-- Templates and Duplicate project never carry signing references ----------------------------------

reset role;
do $$
declare
  snap jsonb := public.project_snapshot((select id from id_ids where name = 'p'), '{"rules": true}'::jsonb);
begin
  assert jsonb_array_length(snap -> 'rules') >= 5, 'the snapshot has the rules';
  assert snap::text not like '%signing_ref%' and snap::text not like '%signing_set%' and snap::text not like '%whsec_%',
    'snapshots strip signing references';
  assert snap::text like '%"format": "blocks"%', 'the Slack format is kept';
end $$;

-- Anon gets nothing ------------------------------------------------------------------------------

do $$
begin
  assert not has_function_privilege('anon', 'public.list_integration_deliveries(uuid, integer)', 'execute'), 'anon: no log';
  assert not has_function_privilege('anon', 'public.retry_integration_delivery(uuid)', 'execute'), 'anon: no retry';
  assert not has_function_privilege('anon', 'public.cancel_integration_delivery(uuid)', 'execute'), 'anon: no cancel';
  assert not has_function_privilege('authenticated', 'public.integration_retry_delay(integer)', 'execute'), 'delay is internal';
  assert not has_function_privilege('authenticated', 'public.slack_block_payload(text, uuid, uuid)', 'execute'), 'blocks are internal';
  assert not has_function_privilege('authenticated', 'public.slack_task_link(uuid, uuid)', 'execute'), 'links are internal';
  assert not has_function_privilege('authenticated', 'public.integration_delivery_for_admin(uuid)', 'execute'), 'lookup is internal';
  assert not has_table_privilege('anon', 'public.integration_outbox', 'select'), 'anon has no outbox grant';
  assert not has_table_privilege('anon', 'public.integration_secrets', 'select'), 'anon has no secrets grant';
  assert not has_table_privilege('authenticated', 'public.integration_outbox', 'select'), 'members have no outbox grant';
  assert not exists (select 1 from pg_proc where proname = 'alhc_patch_function'), 'the patch helper is gone';
end $$;

set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
do $$
begin
  begin
    perform public.list_integration_deliveries((select id from id_ids where name = 'p'));
    raise exception 'anon should not read the log';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.retry_integration_delivery((select id from id_ids where name = 'd_own'));
    raise exception 'anon should not retry';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_project_integrations((select id from id_ids where name = 'p'));
    raise exception 'anon should not read settings';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

select 'integration depth smoke: all assertions passed' as result;
