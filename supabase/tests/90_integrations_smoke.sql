-- Behavioural checks for Phase: Integrations: HTTPS-only URL validation, Admin+ project integration
-- settings that never return secrets, send_slack / call_webhook actions whose URLs and secrets are
-- moved out of rules.actions, enqueue on rule fire (outbox row + redacted story + run id), the
-- documented outbound payload, the no-URL failure, outbox claim/complete for service_role only, and
-- no client or anon access to the outbox. Reuses people from earlier suites:
--   1111… member@example.com    "Member One"     (owner of everything below)
--   5555… viewer@example.com    "Vera Viewer"
--   7777… editor@example.com    "Eddie Editor"
--   8888… admin@example.com     "Ada Admin"
--   9999… nonmember@example.com "Nora Nonmember"  (never joins anything here)

\set ON_ERROR_STOP 1

create temporary table it_ids (name text primary key, id uuid) on commit preserve rows;
grant all on it_ids to authenticated, anon, service_role;

-- URL helpers (internal; run as the migration owner) --------------------------------------------

do $$
begin
  assert public.integration_url_ok('https://hooks.slack.com/services/T000/B000/abcdSECRET1234'), 'Slack URL ok';
  assert public.integration_url_ok('https://example.com:8443/hooks/alhc?x=1'), 'port + query ok';
  assert not public.integration_url_ok('http://example.com/hook'), 'plain http rejected';
  assert not public.integration_url_ok('/relative/hook'), 'relative URL rejected';
  assert not public.integration_url_ok('ftp://example.com/hook'), 'non-https scheme rejected';
  assert not public.integration_url_ok('javascript:alert(1)'), 'javascript: rejected';
  assert not public.integration_url_ok('https://user:pw@example.com/hook'), 'credentials in URL rejected';
  assert not public.integration_url_ok('https://localhost/hook'), 'localhost rejected';
  assert not public.integration_url_ok('https://api.internal/hook'), '.internal rejected';
  assert not public.integration_url_ok('https://10.1.2.3/hook'), 'private IPv4 rejected';
  assert not public.integration_url_ok('https://127.0.0.1/hook'), 'loopback rejected';
  assert not public.integration_url_ok('https://169.254.169.254/latest'), 'link-local rejected';
  assert not public.integration_url_ok('https://192.168.1.1/hook'), '192.168/16 rejected';
  assert not public.integration_url_ok('https://172.20.0.1/hook'), '172.16/12 rejected';
  assert not public.integration_url_ok('https://example.com/a b'), 'whitespace rejected';
  assert not public.integration_url_ok('https://2130706433/hook'), 'integer IPv4 rejected';
  assert not public.integration_url_ok('https://0x7f.0.0.1/hook'), 'hex IPv4 rejected';
  assert not public.integration_url_ok('https://0177.0.0.1/hook'), 'octal IPv4 rejected';
  assert public.integration_url_ok('https://203.0.113.10/hook'), 'public IPv4 ok';
  assert public.integration_url_ok('https://0xford.example.com/hook'), 'host names that start with 0x are fine';
  assert not public.integration_url_ok(null), 'null rejected';
  assert public.integration_url_hint('https://hooks.slack.com/services/T000/B000/abcdSECRET1234')
    = 'hooks.slack.com …1234', 'hint is host + last 4 characters';
  assert public.integration_header_ok('X-Signature'), 'custom header ok';
  assert public.integration_header_ok('Authorization'), 'Authorization header ok';
  assert not public.integration_header_ok('Content-Type'), 'transport headers are reserved';
  assert not public.integration_header_ok('Bad Header'), 'spaces rejected';
  assert public.slack_escape('<!channel> & <b>') = '&lt;!channel&gt; &amp; &lt;b&gt;', 'Slack escaping';
end $$;

-- Fixtures ----------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  p uuid;
  other uuid;
  bare uuid;
  s_todo uuid;
  s_doing uuid;
  s_bare uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Integrations') returning id into p;
  insert into public.projects (workspace_id, name) values (ws, 'Other team') returning id into other;
  insert into public.projects (workspace_id, name) values (ws, 'No defaults') returning id into bare;
  insert into public.sections (project_id, name, sort_order) values (p, 'To do', 1024) returning id into s_todo;
  insert into public.sections (project_id, name, sort_order) values (p, 'Doing', 2048) returning id into s_doing;
  insert into public.sections (project_id, name, sort_order) values (bare, 'Doing', 1024) returning id into s_bare;
  perform public.add_project_member(p, 'admin@example.com', 'admin');
  perform public.add_project_member(p, 'editor@example.com', 'editor');
  perform public.add_project_member(p, 'viewer@example.com', 'viewer');
  perform public.add_project_member(bare, 'admin@example.com', 'admin');
  insert into it_ids values ('p', p), ('other', other), ('bare', bare),
    ('s_todo', s_todo), ('s_doing', s_doing), ('s_bare', s_bare);
end $$;

-- Project settings: Admin+ only, redacted, HTTPS only ---------------------------------------------

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from it_ids where name = 'p');
begin
  begin
    perform public.get_project_integrations(p);
    raise exception 'editors should not read integration settings';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.set_project_integration(p, 'slack_webhook_url', 'https://hooks.slack.com/services/T/B/x');
    raise exception 'editors should not change integration settings';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from it_ids where name = 'p');
  shown jsonb;
begin
  begin
    perform public.set_project_integration(p, 'slack_webhook_url', 'http://hooks.slack.com/services/T/B/x');
    raise exception 'http Slack URLs should fail';
  exception when check_violation then null;
  end;
  begin
    perform public.set_project_integration(p, 'webhook_url', 'https://localhost:3000/hook');
    raise exception 'local webhook URLs should fail';
  exception when check_violation then null;
  end;
  begin
    perform public.set_project_integration(p, 'webhook_secret_header', 'Host');
    raise exception 'reserved header names should fail';
  exception when check_violation then null;
  end;
  begin
    perform public.set_project_integration(p, 'bogus', 'x');
    raise exception 'unknown settings should fail';
  exception when check_violation then null;
  end;

  perform public.set_project_integration(p, 'slack_webhook_url', 'https://hooks.slack.com/services/T0/B0/projSlackTok9');
  perform public.set_project_integration(p, 'webhook_url', 'https://receiver.example.com/alhc/projHookTok8');
  perform public.set_project_integration(p, 'webhook_secret_header', 'X-Custom-Secret');
  shown := public.set_project_integration(p, 'webhook_secret', 'proj-shared-secret-7');
  assert shown ->> 'slack_webhook' = 'hooks.slack.com …Tok9', format('redacted Slack hint, got %s', shown);
  assert shown ->> 'webhook' = 'receiver.example.com …Tok8', 'redacted webhook hint';
  assert (shown ->> 'webhook_secret_set')::boolean, 'secret reported as set';
  assert shown ->> 'webhook_secret_header' = 'X-Custom-Secret', 'header name is not secret';
  assert shown::text not like '%projSlackTok9%' and shown::text not like '%projHookTok8%'
    and shown::text not like '%proj-shared-secret%', 'settings never return URLs or secrets';

  -- Clearing is allowed.
  shown := public.set_project_integration(p, 'webhook_secret', '');
  assert not (shown ->> 'webhook_secret_set')::boolean, 'secret cleared';
  perform public.set_project_integration(p, 'webhook_secret', 'proj-shared-secret-7');

  -- No direct table access for clients.
  begin
    perform 1 from public.project_integrations;
    raise exception 'clients should not read project_integrations';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.project_integrations (project_id, slack_webhook_url) values (p, 'https://evil.example.com/x');
    raise exception 'clients should not write project_integrations';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Rules: URLs and secrets are moved out of rules.actions ------------------------------------------

do $$
declare
  p uuid := (select id from it_ids where name = 'p');
  s_doing uuid := (select id from it_ids where name = 's_doing');
  slack_rule uuid;
  hook_rule uuid;
  project_hook_rule uuid;
  stored jsonb;
  first_ref text;
begin
  begin
    insert into public.rules (project_id, name, trigger_type, trigger_config, actions)
    values (p, 'Bad Slack', 'section_changed', jsonb_build_object('section_id', s_doing),
      '[{"type": "send_slack", "message": "hi", "webhook_url": "http://hooks.slack.com/services/x"}]');
    raise exception 'http Slack URLs in actions should fail';
  exception when check_violation then null;
  end;
  begin
    insert into public.rules (project_id, name, trigger_type, trigger_config, actions)
    values (p, 'Bad hook', 'section_changed', jsonb_build_object('section_id', s_doing),
      '[{"type": "call_webhook", "url": "ftp://example.com/x"}]');
    raise exception 'non-https webhook URLs should fail';
  exception when check_violation then null;
  end;
  begin
    insert into public.rules (project_id, name, trigger_type, trigger_config, actions)
    values (p, 'Relative hook', 'section_changed', jsonb_build_object('section_id', s_doing),
      '[{"type": "call_webhook", "url": "/api/hook"}]');
    raise exception 'relative webhook URLs should fail';
  exception when check_violation then null;
  end;
  begin
    insert into public.rules (project_id, name, trigger_type, trigger_config, actions)
    values (p, 'Bad header', 'section_changed', jsonb_build_object('section_id', s_doing),
      '[{"type": "call_webhook", "url": "https://example.com/x", "secret": "s", "secret_header": "Content-Type"}]');
    raise exception 'reserved secret headers should fail';
  exception when check_violation then null;
  end;
  begin
    insert into public.rules (project_id, name, trigger_type, trigger_config, actions)
    values (p, 'Empty Slack', 'section_changed', jsonb_build_object('section_id', s_doing),
      '[{"type": "send_slack", "message": "  "}]');
    raise exception 'Slack messages need text';
  exception when check_violation then null;
  end;

  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions)
  values (p, 'Ping Slack', true, 'section_changed', jsonb_build_object('section_id', s_doing),
    '[{"type": "send_slack", "message": "{task} moved to {section} in {project} ({req})",
       "webhook_url": "https://hooks.slack.com/services/T1/B1/ruleSlackTok5"}]')
  returning id, actions into slack_rule, stored;
  assert stored -> 0 ->> 'webhook_hint' = 'hooks.slack.com …Tok5', format('stored hint, got %s', stored);
  assert stored -> 0 ? 'webhook_ref' and not stored -> 0 ? 'webhook_url', 'the URL is replaced by a reference';
  assert stored::text not like '%ruleSlackTok5%', 'rules.actions never holds the URL';

  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions)
  values (p, 'Own webhook', true, 'section_changed', jsonb_build_object('section_id', s_doing),
    '[{"type": "call_webhook", "url": "https://own.example.com/hook/ownHookTok3"}]')
  returning id, actions into hook_rule, stored;
  assert stored -> 0 ->> 'url_hint' = 'own.example.com …Tok3', 'webhook hint';
  assert not stored -> 0 ? 'secret_ref' and not stored -> 0 ? 'secret_set', 'no secret saved';

  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions)
  values (p, 'Project webhook', true, 'section_changed', jsonb_build_object('section_id', s_doing),
    '[{"type": "call_webhook", "use_project_webhook": true, "url": "https://ignored.example.com/x",
       "secret": "rule-secret-should-not-be-sent", "secret_header": "X-Rule"}]')
  returning id, actions into project_hook_rule, stored;
  assert (stored -> 0 ->> 'secret_set')::boolean and stored::text not like '%rule-secret%', 'secret replaced by a flag';

  -- Saving again with the reference keeps it; client-supplied hints are recomputed.
  first_ref := stored -> 0 ->> 'url_ref';
  update public.rules set actions = jsonb_set(actions, '{0,url_hint}', '"forged …hint"') where id = project_hook_rule
  returning actions into stored;
  assert stored -> 0 ->> 'url_ref' = first_ref, 'the reference survives an edit';
  assert stored -> 0 ->> 'url_hint' = 'ignored.example.com …om/x', format('hints are recomputed, got %s', stored);

  insert into it_ids values ('slack_rule', slack_rule), ('hook_rule', hook_rule), ('project_hook_rule', project_hook_rule);
end $$;

-- A reference from another project can't be borrowed.
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset

do $$
declare
  other uuid := (select id from it_ids where name = 'other');
  r uuid;
begin
  insert into public.rules (project_id, name, trigger_type, actions)
  values (other, 'Other team Slack', 'task_created',
    '[{"type": "send_slack", "message": "x", "webhook_url": "https://hooks.slack.com/services/T9/B9/otherTok"}]')
  returning id into r;
  insert into it_ids values ('other_rule', r);
end $$;

reset role;
insert into it_ids
select 'other_ref', (actions -> 0 ->> 'webhook_ref')::uuid from public.rules where id = (select id from it_ids where name = 'other_rule');
set role authenticated;
select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from it_ids where name = 'p');
begin
  begin
    insert into public.rules (project_id, name, trigger_type, actions)
    values (p, 'Borrowed', 'task_created', jsonb_build_array(jsonb_build_object(
      'type', 'send_slack', 'message', 'x', 'webhook_ref', (select id from it_ids where name = 'other_ref'))));
    raise exception 'a reference from another project should fail';
  exception when check_violation then null;
  end;
end $$;

-- Viewers can read rules (as before) but never the URLs or secrets.
select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from it_ids where name = 'p');
begin
  assert (select count(*) from public.rules where project_id = p and deleted_at is null) = 3, 'viewers still read rules';
  assert not exists (
    select 1 from public.rules where project_id = p
      and (actions::text like '%ruleSlackTok5%' or actions::text like '%hook/ownHookTok3%' or actions::text like '%rule-secret%')
  ), 'rules expose no URLs or secrets';
  begin
    perform 1 from public.integration_secrets;
    raise exception 'clients should not read integration_secrets';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.integration_outbox;
    raise exception 'clients should not read integration_outbox';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Rule fire: enqueue, redacted story, run id, payloads -------------------------------------------

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from it_ids where name = 'p');
  t uuid;
begin
  t := public.create_task(p, (select id from it_ids where name = 's_todo'), '<!channel> Launch & review');
  insert into it_ids values ('t', t);
end $$;

do $$
declare
  p uuid := (select id from it_ids where name = 'p');
  t uuid := (select id from it_ids where name = 't');
begin
  update public.tasks set due_on = '2026-11-02', assignee_id = '77777777-7777-4777-8777-777777777777' where id = t;
  update public.task_projects set section_id = (select id from it_ids where name = 's_doing')
  where task_id = t and project_id = p;

  assert (select count(*) from public.task_stories where task_id = t and kind = 'integration_queued') = 3,
    'one integration_queued story per queued delivery';
  assert not exists (
    select 1 from public.task_stories where task_id = t
      and (data::text like '%ruleSlackTok5%' or data::text like '%hook/ownHookTok3%' or data::text like '%alhc/projHookTok8%'
           or data::text like '%secret%')
  ), 'stories never contain a full URL or secret';
  assert exists (
    select 1 from public.task_stories where task_id = t and kind = 'integration_queued'
      and data ->> 'channel' = 'slack' and data ->> 'target' = 'hooks.slack.com …Tok5' and data ->> 'rule_name' = 'Ping Slack'
  ), 'the Slack story names the channel, redacted target, and rule';
  assert not exists (
    select 1 from public.rule_runs where task_id = t and (detail::text like '%Tok5%' or detail::text like '%Tok3%' or detail::text like '%Tok8%')
  ), 'run logs never contain URLs';
  assert (select count(*) from public.rule_runs where task_id = t and status = 'succeeded') = 3, 'all three rules succeeded';
end $$;

reset role;

do $$
declare
  t uuid := (select id from it_ids where name = 't');
  p uuid := (select id from it_ids where name = 'p');
  slack public.integration_outbox;
  own public.integration_outbox;
  proj public.integration_outbox;
begin
  select * into slack from public.integration_outbox where task_id = t and rule_id = (select id from it_ids where name = 'slack_rule');
  select * into own from public.integration_outbox where task_id = t and rule_id = (select id from it_ids where name = 'hook_rule');
  select * into proj from public.integration_outbox where task_id = t and rule_id = (select id from it_ids where name = 'project_hook_rule');

  assert slack.channel = 'slack' and slack.status = 'pending' and slack.attempts = 0, 'Slack row queued';
  assert slack.target_url = 'https://hooks.slack.com/services/T1/B1/ruleSlackTok5', 'the action URL wins';
  assert slack.headers = '{}'::jsonb, 'Slack rows have no extra headers';
  assert slack.payload = jsonb_build_object('text', '&lt;!channel&gt; Launch &amp; review moved to Doing in Integrations ()'),
    format('Slack text renders tokens and escapes values, got %s', slack.payload);
  assert slack.rule_run_id = (
    select rr.id from public.rule_runs rr where rr.rule_id = slack.rule_id and rr.task_id = t
  ), 'the row points at its rule run';
  assert slack.project_id = p and slack.target_hint = 'hooks.slack.com …Tok5', 'project + hint recorded';

  assert own.channel = 'webhook' and own.target_url = 'https://own.example.com/hook/ownHookTok3', 'own webhook URL';
  assert own.headers = '{}'::jsonb, 'the project secret is never sent to an action''s own URL';
  assert (select array_agg(k order by k) from jsonb_object_keys(own.payload) k)
    = array['event', 'occurred_at', 'project', 'rule_id', 'rule_name', 'task'], format('payload keys, got %s', own.payload);
  assert own.payload ->> 'event' = 'section_changed', 'event is the trigger type';
  assert own.payload ->> 'rule_name' = 'Own webhook' and own.payload ->> 'rule_id' = own.rule_id::text, 'rule fields';
  assert own.payload -> 'project' = jsonb_build_object('id', p, 'name', 'Integrations'), 'project object';
  assert (select array_agg(k order by k) from jsonb_object_keys(own.payload -> 'task') k)
    = array['assignee_id', 'completed', 'due_on', 'id', 'req', 'section_id', 'section_name', 'title'], 'task keys';
  assert own.payload -> 'task' ->> 'title' = '<!channel> Launch & review', 'webhook JSON is not Slack-escaped';
  assert own.payload -> 'task' ->> 'section_name' = 'Doing' and own.payload -> 'task' ->> 'due_on' = '2026-11-02', 'task values';
  assert own.payload -> 'task' -> 'req' = 'null'::jsonb and own.payload -> 'task' -> 'completed' = 'false'::jsonb, 'req null, open task';
  assert own.payload -> 'task' ->> 'assignee_id' = '77777777-7777-4777-8777-777777777777', 'assignee id';
  assert own.payload ->> 'occurred_at' ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$', 'ISO-8601 occurred_at';

  assert proj.target_url = 'https://receiver.example.com/alhc/projHookTok8', 'use_project_webhook ignores the action URL';
  assert proj.headers = jsonb_build_object('X-Custom-Secret', 'proj-shared-secret-7'), 'project secret in the project header';
  assert not proj.payload::text like '%secret%', 'secrets never go in the body';
end $$;

-- No URL anywhere: the run fails with a clear error and nothing is queued -------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', false) is not null as ok \gset

do $$
declare
  bare uuid := (select id from it_ids where name = 'bare');
  s uuid := (select id from it_ids where name = 's_bare');
  r uuid;
  t uuid;
begin
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions)
  values (bare, 'Nowhere to post', true, 'section_changed', jsonb_build_object('section_id', s),
    '[{"type": "add_comment", "body": "rolled back with the run"}, {"type": "send_slack", "message": "hello", "use_project_webhook": true}]')
  returning id into r;
  t := public.create_task(bare, null, 'No defaults task');
  insert into it_ids values ('bare_task', t);
end $$;

do $$
declare
  bare uuid := (select id from it_ids where name = 'bare');
  t uuid := (select id from it_ids where name = 'bare_task');
  last_run public.rule_runs;
begin
  update public.task_projects set section_id = (select id from it_ids where name = 's_bare') where task_id = t and project_id = bare;
  select * into last_run from public.rule_runs where task_id = t;
  assert last_run.status = 'failed', format('the run fails, got %s', last_run.status);
  assert last_run.detail -> 'actions' ->> 'error' like 'Send Slack message: no Slack webhook URL%Settings → Integrations%',
    format('clear error, got %s', last_run.detail);
  assert not exists (select 1 from public.task_stories where task_id = t and kind = 'integration_queued'), 'no story';
  assert not exists (select 1 from public.comments where task_id = t), 'earlier actions of the failed run roll back';
end $$;

reset role;
do $$
begin
  assert not exists (select 1 from public.integration_outbox where task_id = (select id from it_ids where name = 'bare_task')),
    'no outbox row without a URL';
end $$;

-- Delayed actions keep their saved URL until the job runs -----------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from it_ids where name = 'p');
  r uuid;
  t uuid := (select id from it_ids where name = 't');
  old_ref text;
  new_ref text;
begin
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions)
  values (p, 'Later Slack', true, 'section_changed', jsonb_build_object('section_id', (select id from it_ids where name = 's_todo')),
    '[{"type": "delay", "hours": 1}, {"type": "send_slack", "message": "later", "webhook_url": "https://hooks.slack.com/services/T2/B2/laterTok1"}]')
  returning id, actions -> 1 ->> 'webhook_ref' into r, old_ref;
  update public.task_projects set section_id = (select id from it_ids where name = 's_todo') where task_id = t and project_id = p;
  assert (select status from public.rule_runs where rule_id = r) = 'scheduled', 'delay schedules the Slack action';

  update public.rules set actions = jsonb_set(actions, '{1}', ((actions -> 1) - 'webhook_ref' - 'webhook_hint')
      || '{"webhook_url": "https://hooks.slack.com/services/T2/B2/replacedTok2"}'::jsonb)
  where id = r
  returning actions -> 1 ->> 'webhook_ref' into new_ref;
  assert new_ref <> old_ref, 'replacing the URL saves a new reference';
  insert into it_ids values ('later_rule', r), ('old_ref', old_ref::uuid), ('new_ref', new_ref::uuid);
end $$;

reset role;
do $$
begin
  assert (select deleted_at is null from public.integration_secrets where id = (select id from it_ids where name = 'old_ref')),
    'a URL still needed by a pending delayed job is kept';
  update public.rules set actions = actions where id = (select id from it_ids where name = 'later_rule');
  update public.scheduled_rule_actions set run_at = now() - interval '1 minute'
  where rule_id = (select id from it_ids where name = 'later_rule');
  perform public.workflow_tick();
  assert exists (
    select 1 from public.integration_outbox
    where rule_id = (select id from it_ids where name = 'later_rule')
      and target_url = 'https://hooks.slack.com/services/T2/B2/laterTok1'
  ), 'the delayed job posts to the URL it was scheduled with';
  update public.rules set actions = actions where id = (select id from it_ids where name = 'later_rule');
  assert (select deleted_at is not null from public.integration_secrets where id = (select id from it_ids where name = 'old_ref')),
    'once no job needs it, the replaced URL is retired';
end $$;

-- Delivery: service_role claims and completes; nobody else can ----------------------------------

do $$
begin
  assert not has_function_privilege('authenticated', 'public.claim_integration_outbox(integer, uuid)', 'execute'),
    'claim is service-role only';
  assert not has_function_privilege('authenticated', 'public.complete_integration_outbox(uuid, text, jsonb, text)', 'execute'),
    'complete is service-role only';
  assert not has_function_privilege('anon', 'public.claim_integration_outbox(integer, uuid)', 'execute'), 'anon cannot claim';
  assert not has_function_privilege('authenticated', 'public.enqueue_integration(public.rules, uuid, jsonb, jsonb)', 'execute'),
    'enqueue is internal';
  assert not has_function_privilege('anon', 'public.enqueue_integration(public.rules, uuid, jsonb, jsonb)', 'execute'),
    'enqueue is internal (anon)';
  assert not has_function_privilege('authenticated', 'public.stash_rule_integration_secrets()', 'execute'), 'trigger fn revoked';
  assert not has_function_privilege('anon', 'public.get_project_integrations(uuid)', 'execute'), 'anon cannot read settings';
  assert not has_function_privilege('anon', 'public.set_project_integration(uuid, text, text)', 'execute'), 'anon cannot write settings';
  assert has_function_privilege('service_role', 'public.claim_integration_outbox(integer, uuid)', 'execute'), 'service role claims';
  assert not has_table_privilege('anon', 'public.integration_outbox', 'select'), 'anon has no outbox grant';
  assert not has_table_privilege('authenticated', 'public.integration_outbox', 'select'), 'members have no outbox grant';
  assert not has_table_privilege('authenticated', 'public.integration_secrets', 'select'), 'members have no secrets grant';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', false) is not null as ok \gset
do $$
begin
  begin
    perform public.claim_integration_outbox(10, null);
    raise exception 'admins should not claim outbox rows';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
do $$
begin
  begin
    perform 1 from public.integration_outbox;
    raise exception 'anon should not read the outbox';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_project_integrations((select id from it_ids where name = 'p'));
    raise exception 'anon should not read settings';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
set role service_role;
do $$
declare
  t uuid := (select id from it_ids where name = 't');
  target uuid := (select id from public.integration_outbox where task_id = t and channel = 'slack'
    and rule_id = (select id from it_ids where name = 'slack_rule'));
  failing uuid := (select id from public.integration_outbox where task_id = t
    and rule_id = (select id from it_ids where name = 'hook_rule'));
  claimed public.integration_outbox;
  i integer;
begin
  select * into claimed from public.claim_integration_outbox(10, target);
  assert claimed.id = target and claimed.status = 'sending' and claimed.attempts = 1, 'claim marks sending';
  assert not exists (select 1 from public.claim_integration_outbox(10, target)), 'a claimed row is not claimed twice';
  perform public.complete_integration_outbox(target, 'sent', '{"status": 200, "body": "ok"}'::jsonb, null);
  assert (select status = 'sent' and sent_at is not null and provider_response ->> 'body' = 'ok'
          from public.integration_outbox where id = target), 'complete marks sent';

  for i in 1..5 loop
    update public.integration_outbox set send_after = now() - interval '1 second' where id = failing;
    select * into claimed from public.claim_integration_outbox(10, failing);
    assert claimed.id = failing, format('attempt %s claimed', i);
    perform public.complete_integration_outbox(failing, 'error', '{"status": 500}'::jsonb, 'Receiver responded 500');
    assert (select status from public.integration_outbox where id = failing) = case when i < 5 then 'pending' else 'failed' end,
      format('attempt %s status', i);
  end loop;
  update public.integration_outbox set send_after = now() - interval '1 second' where id = failing;
  assert not exists (select 1 from public.claim_integration_outbox(10, failing)), 'failed rows are not retried';
  assert (select last_error from public.integration_outbox where id = failing) = 'Receiver responded 500', 'error kept';
end $$;

reset role;
do $$
declare
  t uuid := (select id from it_ids where name = 't');
begin
  assert exists (
    select 1 from public.task_stories where task_id = t and kind = 'integration_failed'
      and data ->> 'channel' = 'webhook' and data ->> 'target' = 'own.example.com …Tok3'
      and data ->> 'rule_name' = 'Own webhook' and (data ->> 'attempts')::int = 5
  ), 'a final failure writes a redacted story';
  assert not exists (select 1 from public.task_stories where task_id = t and data::text like '%https://%'),
    'no story ever carries a URL';
end $$;

select 'integrations smoke: all assertions passed' as result;
