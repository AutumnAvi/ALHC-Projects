-- Nov 1 notes, batch 10 (20261101040000_nov1_batch10_a.sql): automations UX.
--   77 rule_runs.actor_id (the person whose request made a run) and the loop guard: a rule's own change
--      firing it again is ignored without a "loop" row (test 14.10); a real cycle of different rules is
--      still stopped and logged; chains of different rules run up to ten deep.
--   81 "Automation" in what the database writes for people.
--   a3100040…01 b10-owner@example.com   Bo Owner (owns P)
--   a3100040…02 b10-viewer@example.com  Vi Viewer (Viewer of P)
--   a3100040…03 b10-other@example.com   Oz Other (not in P)

\set ON_ERROR_STOP 1

create temporary table b10_ids (name text primary key, id uuid) on commit preserve rows;
grant all on b10_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('b10-owner@example.com', 'batch 10'),
  ('b10-viewer@example.com', 'batch 10'),
  ('b10-other@example.com', 'batch 10');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a3100040-0000-4000-8000-000000000001', 'b10-owner@example.com', now(), '{"full_name":"Bo Owner"}'),
  ('a3100040-0000-4000-8000-000000000002', 'b10-viewer@example.com', now(), '{"full_name":"Vi Viewer"}'),
  ('a3100040-0000-4000-8000-000000000003', 'b10-other@example.com', now(), '{"full_name":"Oz Other"}');

do $$
begin
  assert exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'rule_runs' and column_name = 'actor_id'),
    'rule_runs.actor_id exists';
  assert not has_table_privilege('anon', 'public.rule_runs', 'select'), 'anon reads no runs';
  -- No new client definer: run_rule stays internal.
  assert not has_function_privilege('authenticated', 'public.run_rule(public.rules, uuid, jsonb, jsonb, text)', 'execute'),
    'run_rule is not an RPC';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Setup: P with sections Start, Rule 1 trigger, Rule 2 Trigger, Loop A, Loop B, Done
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100040-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  p uuid;
  s uuid;
  n text;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B10 Automations')
    returning id into p;
  insert into b10_ids values ('p', p);
  perform public.add_project_member(p, 'b10-viewer@example.com', 'viewer');
  foreach n in array array['Start', 'Rule 1 trigger', 'Rule 2 Trigger', 'Loop A', 'Loop B', 'Done'] loop
    insert into public.sections (project_id, name) values (p, n) returning id into s;
    insert into b10_ids values (n, s);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 77 Test 14.10: "Task moves into a section" rules
-- ---------------------------------------------------------------------------------------------

-- Rule 1: any section → move to "Rule 2 Trigger". Its own move fires it again (any section): that is
-- the rule triggering itself, not a loop. Rule 2: "Rule 2 Trigger" → comment.
do $$
declare
  p uuid := (select id from b10_ids where name = 'p');
begin
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions) values
    (p, 'Rule 1', true, 'section_changed', '{}',
      jsonb_build_array(jsonb_build_object('type', 'move_section', 'section_id', (select id from b10_ids where name = 'Rule 2 Trigger')))),
    (p, 'Rule 2', true, 'section_changed', jsonb_build_object('section_id', (select id from b10_ids where name = 'Rule 2 Trigger')),
      '[{"type": "add_comment", "body": "rule 2 ran"}]');
  insert into b10_ids values ('t1', public.create_task(p, (select id from b10_ids where name = 'Start'), 'Chain task'));
end $$;

select public.place_task((select id from b10_ids where name = 't1'), (select id from b10_ids where name = 'p'),
  (select id from b10_ids where name = 'Rule 1 trigger'), null) is not null as ok \gset

reset role;
do $$
declare
  t uuid := (select id from b10_ids where name = 't1');
begin
  assert (select section_id from public.task_projects where task_id = t) = (select id from b10_ids where name = 'Rule 2 Trigger'),
    'Rule 1 moved the task on';
  assert (select count(*) from public.comments where task_id = t and body = 'rule 2 ran') = 1, 'Rule 2 ran once';
  assert not exists (select 1 from public.rule_runs where task_id = t and status = 'skipped'),
    'nothing was stopped: Rule 1''s own move firing it again is not a loop';
  assert (select count(*) from public.rule_runs where task_id = t and status = 'succeeded') = 2, 'two runs, both logged';
  assert (select bool_and(actor_id = 'a3100040-0000-4000-8000-000000000001') from public.rule_runs where task_id = t),
    'both runs name the person whose move started them, also the one a rule''s change started';
end $$;

-- A real cycle (Loop A → Loop B → Loop A) is still stopped and logged.
set role authenticated;
do $$
declare
  p uuid := (select id from b10_ids where name = 'p');
begin
  update public.rules set enabled = false where project_id = p;
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions) values
    (p, 'A to B', true, 'section_changed', jsonb_build_object('section_id', (select id from b10_ids where name = 'Loop A')),
      jsonb_build_array(jsonb_build_object('type', 'move_section', 'section_id', (select id from b10_ids where name = 'Loop B')))),
    (p, 'B to A', true, 'section_changed', jsonb_build_object('section_id', (select id from b10_ids where name = 'Loop B')),
      jsonb_build_array(jsonb_build_object('type', 'move_section', 'section_id', (select id from b10_ids where name = 'Loop A'))));
  insert into b10_ids values ('t2', public.create_task(p, (select id from b10_ids where name = 'Start'), 'Ping pong'));
end $$;

select public.place_task((select id from b10_ids where name = 't2'), (select id from b10_ids where name = 'p'),
  (select id from b10_ids where name = 'Loop A'), null) is not null as ok \gset

reset role;
do $$
declare
  t uuid := (select id from b10_ids where name = 't2');
begin
  assert exists (select 1 from public.rule_runs rr join public.rules r on r.id = rr.rule_id
    where rr.task_id = t and r.name = 'A to B' and rr.status = 'skipped' and rr.detail ->> 'reason' = 'loop'
      and rr.actor_id = 'a3100040-0000-4000-8000-000000000001'),
    'A → B → A: A is stopped as a loop (and the person who started it can be told)';
  assert (select count(*) from public.rule_runs where task_id = t and status = 'succeeded') = 2, 'each rule ran once';
end $$;

-- Chains of different rules: ten run, the eleventh is past the limit.
set role authenticated;
do $$
declare
  p uuid := (select id from b10_ids where name = 'p');
  tags uuid[] := '{}';
  tg uuid;
begin
  update public.rules set enabled = false where project_id = p;
  for i in 1 .. 12 loop
    insert into public.tags (workspace_id, name, color) values ('00000000-0000-4000-8000-000000000001', 'b10-chain-' || i, 'zinc')
      returning id into tg;
    tags := tags || tg;
  end loop;
  insert into b10_ids values ('chain1', tags[1]);
  for i in 1 .. 11 loop
    insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions) values (p, 'B10 chain ' || i, true, 'tag_added',
      jsonb_build_object('tag_id', tags[i]), jsonb_build_array(jsonb_build_object('type', 'add_tag', 'tag_id', tags[i + 1])));
  end loop;
  insert into b10_ids values ('t3', public.create_task(p, (select id from b10_ids where name = 'Start'), 'Long chain'));
end $$;

do $$
begin
  insert into public.task_tags (task_id, tag_id) values ((select id from b10_ids where name = 't3'), (select id from b10_ids where name = 'chain1'));
end $$;

reset role;
do $$
declare
  t uuid := (select id from b10_ids where name = 't3');
begin
  assert (select count(*) from public.rule_runs rr join public.rules r on r.id = rr.rule_id
    where rr.task_id = t and r.name like 'B10 chain %' and rr.status = 'succeeded') = 10, 'ten different rules ran in a chain';
  assert exists (select 1 from public.rule_runs rr join public.rules r on r.id = rr.rule_id
    where rr.task_id = t and r.name = 'B10 chain 11' and rr.status = 'skipped' and rr.detail ->> 'reason' = 'depth_limit'),
    'the eleventh is past the limit';
  assert (select count(*) from public.task_tags tt join public.tags tg on tg.id = tt.tag_id
    where tt.task_id = t and tg.name like 'b10-chain-%') = 11, 'so tag 12 was never added';
end $$;

-- Runs without a person (the scheduler) have no actor.
do $$
declare
  r public.rules := (select ru from public.rules ru where ru.name = 'Rule 2');
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform public.run_rule(r, (select id from b10_ids where name = 't1'), '{}'::jsonb);
  assert public.run_rule(r, (select id from b10_ids where name = 't1'), '{}'::jsonb) = 'succeeded', 'it ran again';
  assert (select count(*) from public.rule_runs where rule_id = r.id and created_at = now() and actor_id is null) = 2,
    'no person, no actor';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Who reads the runs (the app's feedback reads the caller's own runs through RLS)
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100040-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  assert (select count(*) from public.rule_runs where task_id = (select id from b10_ids where name = 't1')) >= 2,
    'a Viewer of the project reads its runs';
  assert not exists (select 1 from public.rule_runs where actor_id = 'a3100040-0000-4000-8000-000000000002'),
    'and has no runs of their own';
end $$;
select set_config('request.jwt.claim.sub', 'a3100040-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.rule_runs where task_id = (select id from b10_ids where name = 't1')),
    'someone outside the project reads none';
end $$;
reset role;

-- ---------------------------------------------------------------------------------------------
-- 81 "Automation" in what the database writes for people
-- ---------------------------------------------------------------------------------------------

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.inbox_item_email_parts(public.inbox_items, uuid)', 'public.queue_notification_email(public.inbox_items)',
    'public.on_comment_email()', 'public.notify_rule_paused(public.rules, uuid, text, integer)',
    'public.run_manual_rule(uuid, uuid)', 'public.run_portfolio_rule(uuid, uuid)',
    'public.run_portfolio_rule_engine(public.portfolio_rules, uuid, jsonb, text)'
  ] loop
    assert pg_get_functiondef(fn::regprocedure) like '%utomation%', fn || ' says Automation';
    assert pg_get_functiondef(fn::regprocedure) not like '%''Rule “%', fn || ' no longer says Rule “…”';
  end loop;
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100040-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  perform public.run_manual_rule(gen_random_uuid(), (select id from b10_ids where name = 't1'));
  raise exception 'an unknown automation must be refused';
exception when no_data_found then
  assert sqlerrm = 'Automation not found', 'the message says Automation';
end $$;
reset role;

select 'nov1 batch10 smoke: all assertions passed' as result;
