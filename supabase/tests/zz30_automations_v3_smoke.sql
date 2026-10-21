-- Automations V3 (automations_v3_a.sql + automations_v3_tail.sql).
-- Batch A: People-field person slots, round robin / load-balanced Set assignee, Remove followers, the
-- "Collaborator is added" trigger, Compare people, and "Task came from" a picked form.
--   a3030030…01 av3-owner@example.com   Ava Owner (owns P)
--   a3030030…02 av3-eli@example.com     Eli Editor (Editor of P)
--   a3030030…03 av3-dana@example.com    Dana Designer (Editor of P)
--   a3030030…04 av3-sam@example.com     Sam Smith (Editor of P)
--   a3030030…05 av3-vera@example.com    Vera Viewer (Viewer of P)
--   a3030030…06 av3-out@example.com     Oscar Outside (in the workspace, not in P)

\set ON_ERROR_STOP 1

create temporary table av3_ids (name text primary key, id uuid) on commit preserve rows;
grant all on av3_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('av3-owner@example.com', 'automations v3'),
  ('av3-eli@example.com', 'automations v3'),
  ('av3-dana@example.com', 'automations v3'),
  ('av3-sam@example.com', 'automations v3'),
  ('av3-vera@example.com', 'automations v3'),
  ('av3-out@example.com', 'automations v3');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a3030030-0000-4000-8000-000000000001', 'av3-owner@example.com', now(), '{"full_name":"Ava Owner"}'),
  ('a3030030-0000-4000-8000-000000000002', 'av3-eli@example.com', now(), '{"full_name":"Eli Editor"}'),
  ('a3030030-0000-4000-8000-000000000003', 'av3-dana@example.com', now(), '{"full_name":"Dana Designer"}'),
  ('a3030030-0000-4000-8000-000000000004', 'av3-sam@example.com', now(), '{"full_name":"Sam Smith"}'),
  ('a3030030-0000-4000-8000-000000000005', 'av3-vera@example.com', now(), '{"full_name":"Vera Viewer"}'),
  ('a3030030-0000-4000-8000-000000000006', 'av3-out@example.com', now(), '{"full_name":"Oscar Outside"}');

insert into av3_ids values
  ('ava', 'a3030030-0000-4000-8000-000000000001'),
  ('eli', 'a3030030-0000-4000-8000-000000000002'),
  ('dana', 'a3030030-0000-4000-8000-000000000003'),
  ('sam', 'a3030030-0000-4000-8000-000000000004'),
  ('vera', 'a3030030-0000-4000-8000-000000000005'),
  ('out', 'a3030030-0000-4000-8000-000000000006');

-- Small helpers for the suite (dropped by the throwaway database).
create function pg_temp.av3(key text) returns uuid language sql stable as $$ select id from av3_ids where name = key $$;

do $$
begin
  assert has_function_privilege('authenticated', 'public.automations_v3_ready()', 'execute'), 'the app probes V3';
  assert not has_function_privilege('anon', 'public.automations_v3_ready()', 'execute'), 'anon: no probe';
  assert not has_function_privilege('authenticated', 'public.rule_pick_assignee(public.rules, uuid, jsonb)', 'execute'),
    'round robin is internal';
  assert not has_function_privilege('authenticated', 'public.rule_side_people(text, uuid)', 'execute'), 'people sides are internal';
  assert not has_function_privilege('authenticated', 'public.rule_field_people(uuid, text)', 'execute'), 'field people are internal';
  assert not has_table_privilege('authenticated', 'public.rule_assignment_cursors', 'select'), 'cursors: no client reads';
  assert not has_table_privilege('anon', 'public.rule_assignment_cursors', 'select'), 'cursors: nothing for anon';
  assert (select relrowsecurity from pg_class where oid = 'public.rule_assignment_cursors'::regclass), 'cursors: RLS on';
  assert (select count(*) from pg_constraint where conname = 'rules_trigger_type_check_v3') = 1
    and not exists (select 1 from pg_constraint where conname in ('rules_trigger_type_check', 'rules_trigger_type_check_v2')),
    'the V3 tail dropped the narrower trigger CHECKs';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Setup: P (Ava owns; Eli, Dana, Sam Editors; Vera Viewer) with a People field and a form
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'a3030030-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  p uuid;
  x uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'AV3 Requests')
    returning id into p;
  insert into av3_ids values ('p', p);
  perform public.add_project_member(p, 'av3-eli@example.com', 'editor');
  perform public.add_project_member(p, 'av3-dana@example.com', 'editor');
  perform public.add_project_member(p, 'av3-sam@example.com', 'editor');
  perform public.add_project_member(p, 'av3-vera@example.com', 'viewer');
  insert into public.sections (project_id, name, sort_order) values (p, 'Intake', 1) returning id into x;
  insert into av3_ids values ('intake', x);
  insert into public.sections (project_id, name, sort_order) values (p, 'Design', 2) returning id into x;
  insert into av3_ids values ('design', x);
  insert into public.sections (project_id, name, sort_order) values (p, 'Review', 3) returning id into x;
  insert into av3_ids values ('review', x);
  insert into public.custom_fields (project_id, name, field_type) values (p, 'Designer', 'people') returning id into x;
  insert into av3_ids values ('designer', x);
  insert into public.custom_fields (project_id, name, field_type) values (p, 'Notes', 'text') returning id into x;
  insert into av3_ids values ('notes_field', x);
  insert into public.tags (workspace_id, name, color) values ('00000000-0000-4000-8000-000000000001', 'av3-flag', 'red') returning id into x;
  insert into av3_ids values ('tag_flag', x);
  insert into public.forms (project_id, title, questions) values (p, 'AV3 Brief form', '[]') returning id into x;
  insert into av3_ids values ('form_a', x);
  insert into public.forms (project_id, title, questions) values (p, 'AV3 Other form', '[]') returning id into x;
  insert into av3_ids values ('form_b', x);
  -- Another project of Ava's, with its own People field (a rule of P can't name it).
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'AV3 Elsewhere')
    returning id into x;
  insert into av3_ids values ('q', x);
  insert into public.custom_fields (project_id, name, field_type) values (x, 'Reviewer', 'people') returning id into x;
  insert into av3_ids values ('q_reviewer', x);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Batch A: People fields as person slots
-- ---------------------------------------------------------------------------------------------

do $$
declare
  p uuid := pg_temp.av3('p');
  slot text := 'field:' || pg_temp.av3('designer');
  t uuid;
  r uuid;
begin
  t := public.create_task(p, pg_temp.av3('intake'), 'Poster');
  insert into av3_ids values ('t_poster', t);
  insert into public.task_field_values (task_id, field_id, value)
  values (t, pg_temp.av3('designer'), jsonb_build_array(pg_temp.av3('dana'), pg_temp.av3('sam')));

  -- A rule may name its own project's People field, never another project's, and never a non-People field.
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values (p, 'Assign the designer', true, 'manual', jsonb_build_array(
    jsonb_build_object('type', 'set_assignee', 'assignee', slot),
    jsonb_build_object('type', 'request_approval', 'approver', slot),
    jsonb_build_object('type', 'add_followers', 'people', jsonb_build_array(slot))
  )) returning id into r;
  insert into av3_ids values ('r_designer', r);
  begin
    insert into public.rules (project_id, name, trigger_type, actions)
    values (p, 'Wrong field', 'manual', jsonb_build_array(jsonb_build_object('type', 'set_assignee', 'assignee', 'field:' || pg_temp.av3('q_reviewer'))));
    raise exception 'another project''s People field must be refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.rules (project_id, name, trigger_type, actions)
    values (p, 'Not people', 'manual', jsonb_build_array(jsonb_build_object('type', 'set_assignee', 'assignee', 'field:' || pg_temp.av3('notes_field'))));
    raise exception 'a text field is not a person slot';
  exception when check_violation then null;
  end;
end $$;

-- Ava runs it: the first person in Designer is assigned and asked to approve; everyone in it follows.
do $$
declare
  t uuid := pg_temp.av3('t_poster');
  outcome jsonb;
begin
  outcome := public.run_manual_rule(pg_temp.av3('r_designer'), t);
  assert outcome ->> 'status' = 'succeeded', format('the rule ran: %s', outcome);
  assert (select assignee_id from public.tasks where id = t) = pg_temp.av3('dana'), 'the first person of the People field is assigned';
  assert exists (
    select 1 from public.approval_requests ar where ar.task_id = t and ar.approver_id = pg_temp.av3('dana') and ar.status = 'pending'
  ), 'the People field names the approver';
  assert (select count(*) from public.task_followers f where f.task_id = t and f.deleted_at is null
          and f.profile_id in (pg_temp.av3('dana'), pg_temp.av3('sam'))) = 2, 'everyone in the People field follows';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Batch A: round robin and load-balanced assignment
-- ---------------------------------------------------------------------------------------------

do $$
declare
  p uuid := pg_temp.av3('p');
  r uuid;
  t uuid;
  i integer;
  got uuid[] := '{}';
begin
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values (p, 'Round robin', true, 'manual', jsonb_build_array(jsonb_build_object(
    'type', 'set_assignee', 'mode', 'round_robin',
    -- Oscar can't open P's tasks: he is skipped.
    'people', jsonb_build_array(pg_temp.av3('eli'), pg_temp.av3('out'), pg_temp.av3('dana'), pg_temp.av3('sam'))
  ))) returning id into r;
  for i in 1 .. 4 loop
    t := public.create_task(p, pg_temp.av3('intake'), 'Round ' || i);
    perform public.run_manual_rule(r, t);
    got := got || (select assignee_id from public.tasks where id = t);
  end loop;
  assert got = array[pg_temp.av3('eli'), pg_temp.av3('dana'), pg_temp.av3('sam'), pg_temp.av3('eli')],
    format('round robin takes turns and skips people who can''t open the task: %s', got);

  begin
    insert into public.rules (project_id, name, trigger_type, actions)
    values (p, 'Empty pool', 'manual', '[{"type": "set_assignee", "mode": "round_robin", "people": []}]');
    raise exception 'a round robin needs people';
  exception when check_violation then null;
  end;
  begin
    insert into public.rules (project_id, name, trigger_type, actions)
    values (p, 'Bad mode', 'manual', '[{"type": "set_assignee", "mode": "lottery"}]');
    raise exception 'unknown assignment mode';
  exception when check_violation then null;
  end;
end $$;

-- Balanced: Eli has 2 open tasks in P from the round robin, Dana 1 + the Poster (2), Sam 1 → Sam.
do $$
declare
  p uuid := pg_temp.av3('p');
  r uuid;
  t uuid;
begin
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values (p, 'Least busy', true, 'manual', jsonb_build_array(jsonb_build_object(
    'type', 'set_assignee', 'mode', 'balanced',
    'people', jsonb_build_array(pg_temp.av3('eli'), pg_temp.av3('dana'), pg_temp.av3('sam'))
  ))) returning id into r;
  t := public.create_task(p, pg_temp.av3('intake'), 'Balanced one');
  perform public.run_manual_rule(r, t);
  assert (select assignee_id from public.tasks where id = t) = pg_temp.av3('sam'), 'balanced picks whoever has the fewest open tasks';
  t := public.create_task(p, pg_temp.av3('intake'), 'Balanced two');
  perform public.run_manual_rule(r, t);
  -- Now everyone has 2: a tie goes round robin after Sam → Eli.
  assert (select assignee_id from public.tasks where id = t) = pg_temp.av3('eli'), 'ties go round robin';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Batch A: Remove followers, Collaborator is added, Compare people, form picked in "Task came from"
-- ---------------------------------------------------------------------------------------------

do $$
declare
  p uuid := pg_temp.av3('p');
  r uuid;
begin
  -- When Dana starts following a task, tag it (anyone else: nothing).
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions)
  values (p, 'Dana follows', true, 'follower_added', jsonb_build_object('people', jsonb_build_array(pg_temp.av3('dana'))),
    jsonb_build_array(jsonb_build_object('type', 'add_tag', 'tag_id', pg_temp.av3('tag_flag'))));
  insert into av3_ids values ('t_follow', public.create_task(p, pg_temp.av3('intake'), 'Follow me'));
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values (p, 'Unfollow Eli', true, 'manual', jsonb_build_array(jsonb_build_object('type', 'remove_followers',
    'people', jsonb_build_array(pg_temp.av3('eli'))))) returning id into r;
  insert into av3_ids values ('r_unfollow', r);
  begin
    insert into public.rules (project_id, name, trigger_type, trigger_config, actions)
    values (p, 'Bad follower filter', 'follower_added', '{"people": []}', '[{"type": "complete_task"}]');
    raise exception 'an empty follower filter is refused';
  exception when check_violation then null;
  end;
end $$;

-- Separate transactions (rules don't fire for follows made while the task is created).
reset role;
select public.follow_task(pg_temp.av3('t_follow'), pg_temp.av3('eli')) is null as ok \gset
do $$
begin
  assert not exists (select 1 from public.task_tags where task_id = pg_temp.av3('t_follow') and deleted_at is null),
    'Eli following doesn''t match the filter';
end $$;
select public.follow_task(pg_temp.av3('t_follow'), pg_temp.av3('dana')) is null as ok \gset
set role authenticated;
do $$
declare
  t uuid := pg_temp.av3('t_follow');
begin
  assert exists (select 1 from public.task_tags where task_id = t and tag_id = pg_temp.av3('tag_flag') and deleted_at is null),
    'Dana following fires the rule';
  perform public.run_manual_rule(pg_temp.av3('r_unfollow'), t);
  assert exists (select 1 from public.task_followers where task_id = t and profile_id = pg_temp.av3('eli') and deleted_at is not null)
    and exists (select 1 from public.task_followers where task_id = t and profile_id = pg_temp.av3('dana') and deleted_at is null),
    'Remove followers stops Eli only';
end $$;

do $$
declare
  p uuid := pg_temp.av3('p');
begin
  begin
    insert into public.rules (project_id, name, trigger_type, conditions, actions)
    values (p, 'Bad compare', 'manual', '[{"type": "person_compare", "left": "assignee", "op": "equals", "people": ["creator"]}]',
      '[{"type": "complete_task"}]');
    raise exception 'Compare people needs is / is not';
  exception when check_violation then null;
  end;
  begin
    insert into public.rules (project_id, name, trigger_type, conditions, actions)
    values (p, 'Bad form', 'manual', jsonb_build_array(jsonb_build_object('type', 'source_is', 'source', 'manual', 'form_id', pg_temp.av3('form_a'))),
      '[{"type": "complete_task"}]');
    raise exception 'a form only goes with the form source';
  exception when check_violation then null;
  end;
end $$;

reset role;

do $$
declare
  t uuid := pg_temp.av3('t_poster');
  r public.rules := (select ru from public.rules ru where ru.id = pg_temp.av3('r_designer'));
begin
  -- The Poster: created by Ava, assigned to Dana, Designer = Dana, Sam.
  r.conditions := '[{"type": "person_compare", "left": "assignee", "op": "is", "people": ["creator"]}]';
  assert not public.rule_conditions_pass(r, t), 'the assignee isn''t the creator';
  update public.tasks set assignee_id = pg_temp.av3('ava') where id = t;
  assert public.rule_conditions_pass(r, t), 'the assignee is the creator';
  r.conditions := '[{"type": "person_compare", "left": "assignee", "op": "is_not", "people": ["creator"]}]';
  assert not public.rule_conditions_pass(r, t), 'is not';
  r.conditions := jsonb_build_array(jsonb_build_object('type', 'person_compare', 'left', 'field:' || pg_temp.av3('designer'),
    'op', 'is', 'people', jsonb_build_array(pg_temp.av3('sam'))));
  assert public.rule_conditions_pass(r, t), 'a People field includes Sam';
  r.conditions := jsonb_build_array(jsonb_build_object('type', 'person_compare', 'left', 'followers',
    'op', 'is', 'people', jsonb_build_array(pg_temp.av3('vera'))));
  assert not public.rule_conditions_pass(r, t), 'Vera isn''t a collaborator';
  r.conditions := jsonb_build_array(jsonb_build_object('type', 'assignee_is', 'people', jsonb_build_array('field:' || pg_temp.av3('designer'))));
  assert not public.rule_conditions_pass(r, t), 'the assignee (Ava) isn''t in the People field';

  -- Task came from a form, and which one.
  update public.tasks set source = 'form' where id = t;
  insert into public.form_submissions (form_id, task_id, submitter_email) values (pg_temp.av3('form_a'), t, 'someone@example.com');
  r.conditions := jsonb_build_array(jsonb_build_object('type', 'source_is', 'source', 'form', 'form_id', pg_temp.av3('form_a')));
  assert public.rule_conditions_pass(r, t), 'came from the Brief form';
  r.conditions := jsonb_build_array(jsonb_build_object('type', 'source_is', 'source', 'form', 'form_id', pg_temp.av3('form_b')));
  assert not public.rule_conditions_pass(r, t), 'not from the Other form';
  r.conditions := '[{"type": "source_is", "source": "form"}]';
  assert public.rule_conditions_pass(r, t), 'any form';
  update public.tasks set source = 'manual' where id = t;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Batch B: dates
-- ---------------------------------------------------------------------------------------------

-- Schedules: minutes, every N days / weeks, several weekdays (Oct 19, 2026 is a Monday; UTC).
do $$
declare
  sun_thu smallint[] := '{0,1,2,3,4}';
begin
  assert public.rule_schedule_next_at('{"frequency":"daily","hour":9,"minute":30,"timezone":"UTC"}', sun_thu, '2026-10-19 09:15+00')
    = '2026-10-19 09:30+00', 'a time of day with minutes';
  assert public.rule_schedule_next_at('{"frequency":"daily","interval":3,"anchor":"2026-10-19","hour":9,"timezone":"UTC"}', sun_thu,
    '2026-10-19 10:00+00') = '2026-10-22 09:00+00', 'every 3 days from the anchor';
  assert public.rule_schedule_next_at('{"frequency":"weekly","weekdays":[1,3],"hour":9,"timezone":"UTC"}', sun_thu,
    '2026-10-19 10:00+00') = '2026-10-21 09:00+00', 'Monday and Wednesday: Wednesday next';
  assert public.rule_schedule_next_at('{"frequency":"weekly","weekdays":[1],"interval":2,"anchor":"2026-10-19","hour":9,"timezone":"UTC"}',
    sun_thu, '2026-10-19 10:00+00') = '2026-11-02 09:00+00', 'every other Monday';
  assert public.rule_schedule_next_at('{"frequency":"weekly","weekday":0,"hour":9,"timezone":"UTC"}', sun_thu, '2026-10-19 10:00+00')
    = '2026-10-25 09:00+00', 'the older single weekday still works';
  assert public.rule_schedule_next_at('{"frequency":"daily","hour":9,"minute":0,"timezone":"Asia/Jerusalem"}', sun_thu,
    '2026-10-19 10:00+00') = '2026-10-20 06:00+00', 'in the rule''s time zone';

  assert public.rule_date_matches('2026-10-20', 'between', '2026-10-25', '2026-10-19'), 'between, either order';
  assert not public.rule_date_matches('2026-10-26', 'between', '2026-10-19', '2026-10-25'), 'outside';
  assert public.rule_date_matches('2026-10-26', 'not_between', '2026-10-19', '2026-10-25'), 'not between';
  assert public.rule_date_matches('2026-10-19', 'on_or_before', '2026-10-19', null), 'on or before';
  assert not public.rule_date_matches(null, 'not_between', '2026-10-19', '2026-10-25'), 'no date never matches';
end $$;

-- Validation of the new shapes.
do $$
declare
  p uuid := pg_temp.av3('p');
  spec jsonb;
begin
  for spec in select (value #>> '{}')::jsonb from jsonb_array_elements(jsonb_build_array(
    '{"trigger_type": "start_approaching", "trigger_config": {"amount": 4, "unit": "hours"}}',
    '{"trigger_type": "start_reached", "trigger_config": {"amount": 0, "unit": "days"}}',
    '{"trigger_type": "due_approaching", "trigger_config": {"amount": 2, "unit": "weeks"}}',
    '{"trigger_type": "task_overdue", "trigger_config": {"amount": 6, "unit": "hours"}}',
    '{"trigger_type": "start_date_changed", "trigger_config": {"change": "cleared"}}',
    '{"trigger_type": "scheduled", "trigger_config": {"frequency": "weekly", "weekdays": [0, 2, 4], "interval": 2, "anchor": "2026-10-18", "hour": 8, "minute": 45}}',
    '{"conditions": [{"type": "date_compare", "date": "start", "op": "between", "value": "2026-11-01", "to": "2026-11-30"}]}',
    '{"conditions": [{"type": "start_within", "days": 3}, {"type": "has_started"}, {"type": "no_start_date"}]}',
    '{"actions": [{"type": "set_start_date", "mode": "date", "date": "2026-11-02"}]}',
    '{"actions": [{"type": "set_start_date", "days": 2, "unit": "weeks", "from": "due_date"}]}',
    '{"actions": [{"type": "set_due_date", "days": 4, "unit": "hours"}]}',
    '{"actions": [{"type": "set_due_date", "days": 1, "business_days": true}]}'
  )) loop
    insert into public.rules (project_id, name, trigger_type, trigger_config, conditions, actions)
    values (p, 'Good', coalesce(spec ->> 'trigger_type', 'manual'), coalesce(spec -> 'trigger_config', '{}'),
      coalesce(spec -> 'conditions', '[]'), coalesce(spec -> 'actions', '[{"type": "complete_task"}]'));
  end loop;

  for spec in select (value #>> '{}')::jsonb from jsonb_array_elements(jsonb_build_array(
    '{"trigger_type": "start_approaching", "trigger_config": {"amount": 4, "unit": "minutes"}}',
    '{"trigger_type": "due_approaching", "trigger_config": {"amount": 13, "unit": "weeks"}}',
    '{"trigger_type": "due_date_changed", "trigger_config": {"change": "moved"}}',
    '{"trigger_type": "scheduled", "trigger_config": {"frequency": "weekly", "weekdays": [1, 1]}}',
    '{"trigger_type": "scheduled", "trigger_config": {"frequency": "monthly", "interval": 2}}',
    '{"trigger_type": "scheduled", "trigger_config": {"frequency": "daily", "minute": 75}}',
    '{"conditions": [{"type": "date_compare", "date": "due", "op": "between", "value": "2026-11-01"}]}',
    '{"conditions": [{"type": "date_compare", "date": "due", "op": "on", "value": "2026-02-30"}]}',
    '{"conditions": [{"type": "date_compare", "date": "created", "op": "on", "value": "2026-02-03"}]}',
    '{"actions": [{"type": "set_start_date", "mode": "date"}]}',
    '{"actions": [{"type": "set_due_date", "days": 4, "unit": "hours", "from": "due_date"}]}',
    '{"actions": [{"type": "set_due_date", "days": 2, "unit": "weeks", "business_days": true}]}'
  )) loop
    begin
      insert into public.rules (project_id, name, trigger_type, trigger_config, conditions, actions)
      values (p, 'Bad', coalesce(spec ->> 'trigger_type', 'manual'), coalesce(spec -> 'trigger_config', '{}'),
        coalesce(spec -> 'conditions', '[]'), coalesce(spec -> 'actions', '[{"type": "complete_task"}]'));
      raise exception 'should have been refused: %', spec;
    exception when check_violation then null;
    end;
  end loop;
end $$;

-- Set start date / Set due date: absolute dates, weeks, the order of the two dates, hours.
do $$
declare
  p uuid := pg_temp.av3('p');
  t uuid;
  r uuid;
  out jsonb;
begin
  t := public.create_task(p, pg_temp.av3('intake'), 'Campaign');
  update public.tasks set due_on = '2026-11-10' where id = t;
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions)
  values (p, 'Start Nov 2', true, 'manual', '{"timezone": "UTC"}', '[{"type": "set_start_date", "mode": "date", "date": "2026-11-02"}]')
  returning id into r;
  out := public.run_manual_rule(r, t);
  assert out ->> 'status' = 'succeeded', format('ran: %s', out);
  assert (select start_on from public.tasks where id = t) = '2026-11-02', 'an absolute start date';

  -- A start after the due date moves the due date with it.
  update public.rules set actions = '[{"type": "set_start_date", "mode": "date", "date": "2026-11-20"}]' where id = r;
  perform public.run_manual_rule(r, t);
  assert (select (start_on, due_on) = (date '2026-11-20', date '2026-11-20') from public.tasks where id = t),
    'the due date moved to the new start';

  -- Two weeks after the start date.
  update public.rules set actions = '[{"type": "set_due_date", "days": 2, "unit": "weeks", "from": "start_date"}]' where id = r;
  perform public.run_manual_rule(r, t);
  assert (select due_on from public.tasks where id = t) = '2026-12-04', 'weeks are calendar weeks';

  -- A due date before the start clears the start.
  update public.rules set actions = '[{"type": "set_due_date", "mode": "date", "date": "2026-11-01"}]' where id = r;
  perform public.run_manual_rule(r, t);
  assert (select (start_on is null and due_on = '2026-11-01') from public.tasks where id = t), 'the start was cleared';

  -- Hours set a time.
  update public.rules set actions = '[{"type": "set_due_date", "days": 4, "unit": "hours"}]' where id = r;
  perform public.run_manual_rule(r, t);
  assert (select due_at between now() + interval '3 hours 58 minutes' and now() + interval '4 hours 1 minute' from public.tasks where id = t),
    'due in four hours';

  -- Milestones have no start date.
  update public.tasks set kind = 'milestone', due_at = null where id = t;
  update public.rules set actions = '[{"type": "set_start_date", "mode": "date", "date": "2026-10-30"}]' where id = r;
  perform public.run_manual_rule(r, t);
  assert (select start_on is null from public.tasks where id = t), 'a milestone gets no start date';
  assert exists (select 1 from public.rule_runs rr where rr.rule_id = r and rr.detail -> 'actions' -> 0 ->> 'result' = 'Milestones have no start date'),
    'the step says why';
  update public.tasks set kind = 'task' where id = t;
  insert into av3_ids values ('t_campaign', t), ('r_dates', r);
end $$;

-- Start date conditions and Date is.
do $$
declare
  t uuid := pg_temp.av3('t_campaign');
  r public.rules := (select ru from public.rules ru where ru.id = pg_temp.av3('r_dates'));
begin
  update public.tasks set start_on = current_date - 1, due_on = current_date + 5 where id = t;
  r.conditions := '[{"type": "has_started"}]';
  assert public.rule_conditions_pass(r, t), 'the start date has arrived';
  r.conditions := '[{"type": "start_within", "days": 3}]';
  assert not public.rule_conditions_pass(r, t), 'a start in the past isn''t "within"';
  r.conditions := jsonb_build_array(jsonb_build_object('type', 'date_compare', 'date', 'due', 'op', 'between',
    'value', (current_date + 1)::text, 'to', (current_date + 7)::text));
  assert public.rule_conditions_pass(r, t), 'the due date is between';
  r.conditions := jsonb_build_array(jsonb_build_object('type', 'date_compare', 'date', 'start', 'op', 'after', 'value', current_date::text));
  assert not public.rule_conditions_pass(r, t), 'the start isn''t after today';
  r.conditions := '[{"type": "no_start_date"}]';
  assert not public.rule_conditions_pass(r, t), 'it has a start date';
end $$;

-- Start date changes (only to a new date), and the scheduler's start / hour triggers.
do $$
declare
  p uuid := pg_temp.av3('p');
begin
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions)
  values (p, 'Start set', true, 'start_date_changed', '{"change": "set"}',
    jsonb_build_array(jsonb_build_object('type', 'add_comment', 'body', 'Start moved')));
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions)
  values (p, 'Starts today', true, 'start_reached', '{"amount": 0, "unit": "days", "timezone": "UTC"}',
    jsonb_build_array(jsonb_build_object('type', 'move_section', 'section_id', pg_temp.av3('design'))));
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions)
  values (p, 'Due in 3 hours', true, 'due_approaching', '{"amount": 3, "unit": "hours", "timezone": "UTC"}',
    jsonb_build_array(jsonb_build_object('type', 'add_tag', 'tag_id', pg_temp.av3('tag_flag'))));
  insert into av3_ids values ('t_kickoff', public.create_task(p, pg_temp.av3('intake'), 'Kickoff'));
  insert into av3_ids values ('t_soon', public.create_task(p, pg_temp.av3('intake'), 'Soon'));
end $$;

update public.tasks set start_on = (now() at time zone 'UTC')::date where id = pg_temp.av3('t_kickoff');
update public.tasks set start_on = null where id = pg_temp.av3('t_kickoff');
update public.tasks set start_on = (now() at time zone 'UTC')::date where id = pg_temp.av3('t_kickoff');
update public.tasks set due_at = now() + interval '2 hours', time_zone = 'UTC' where id = pg_temp.av3('t_soon');

do $$
declare
  k uuid := pg_temp.av3('t_kickoff');
  out jsonb;
begin
  assert (select count(*) from public.comments where task_id = k and body = 'Start moved') = 2,
    'a new start fires twice, clearing it doesn''t';
  out := public.workflow_tick();
  assert (out ->> 'start_rules')::integer >= 1, format('the scheduler ran the start rule: %s', out);
  assert (select tp.section_id from public.task_projects tp where tp.task_id = k and tp.project_id = pg_temp.av3('p')) = pg_temp.av3('design'),
    'the task starting today moved to Design';
  assert exists (select 1 from public.task_tags where task_id = pg_temp.av3('t_soon') and tag_id = pg_temp.av3('tag_flag') and deleted_at is null),
    'due in 2 hours is within 3 hours';
  out := public.workflow_tick();
  assert (out ->> 'start_rules')::integer = 0 and (out ->> 'due_rules')::integer = 0, format('once per task and date: %s', out);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Batch C: flow
-- ---------------------------------------------------------------------------------------------

-- All four dependency kinds; what blocks completion.
do $$
declare
  p uuid := pg_temp.av3('p');
  a uuid;
  b uuid;
  c uuid;
  d uuid;
begin
  assert (select pg_get_constraintdef(oid) like '%start_to_finish%' from pg_constraint where conname = 'task_dependencies_kind_check_v3')
    and not exists (select 1 from pg_constraint where conname = 'task_dependencies_kind_check'),
    'the tail dropped the two-kind dependency CHECK';
  a := public.create_task(p, pg_temp.av3('intake'), 'Copy');
  b := public.create_task(p, pg_temp.av3('intake'), 'Design FF');
  c := public.create_task(p, pg_temp.av3('intake'), 'Design SF');
  d := public.create_task(p, pg_temp.av3('intake'), 'Design SS');
  insert into av3_ids values ('dep_a', a), ('dep_ff', b), ('dep_sf', c), ('dep_ss', d);
  perform public.set_task_dependency(a, b, 'finish_to_finish', 0);
  perform public.set_task_dependency(a, c, 'start_to_finish', 0);
  perform public.set_task_dependency(a, d, 'start_to_start', 0);
  assert public.open_blocker_count(b) = 1, 'finish-to-finish blocks completion while the predecessor is open';
  assert public.open_blocker_count(c) = 1, 'start-to-finish blocks completion until the predecessor starts';
  assert public.open_blocker_count(d) = 0, 'start-to-start never blocks completion';
  assert public.task_is_blocked(d), 'but the start-to-start successor is waiting';
  begin
    perform public.set_task_dependency(a, b, 'finish_to_middle', 0);
    raise exception 'unknown kinds are refused';
  exception when check_violation then null;
  end;
end $$;

-- Rules for the flow: no longer blocked, type changes, moved out of a section.
do $$
declare
  p uuid := pg_temp.av3('p');
begin
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values (p, 'Unblocked', true, 'task_unblocked', '[{"type": "add_comment", "body": "Ready to go"}]');
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions)
  values (p, 'Now a milestone', true, 'task_type_changed', '{"kind": "milestone"}', '[{"type": "add_comment", "body": "Milestone!"}]');
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions)
  values (p, 'Left Design', true, 'section_left', jsonb_build_object('section_id', pg_temp.av3('design')),
    '[{"type": "add_comment", "body": "Out of design"}]');
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values (p, 'Any section', true, 'section_changed', '[{"type": "add_comment", "body": "Moved somewhere"}]');
end $$;

-- The predecessor starts (its start date is today): the start kinds release their successors.
update public.tasks set start_on = (now() at time zone 'UTC')::date where id = pg_temp.av3('dep_a');
do $$
begin
  assert exists (select 1 from public.comments where task_id = pg_temp.av3('dep_ss') and body = 'Ready to go'), 'start-to-start released';
  assert exists (select 1 from public.comments where task_id = pg_temp.av3('dep_sf') and body = 'Ready to go'), 'start-to-finish released';
  assert not exists (select 1 from public.comments where task_id = pg_temp.av3('dep_ff') and body = 'Ready to go'), 'finish-to-finish still waits';
  assert (public.workflow_tick() ->> 'unblocked_rules')::integer = 0, 'the scheduler doesn''t fire them again';
end $$;
update public.tasks set completed_at = now() where id = pg_temp.av3('dep_a');
do $$
begin
  assert exists (select 1 from public.comments where task_id = pg_temp.av3('dep_ff') and body = 'Ready to go'), 'finish-to-finish released';
  assert (select count(*) from public.comments where task_id = pg_temp.av3('dep_ss') and body = 'Ready to go') = 1, 'once per release';
  assert not public.task_is_blocked(pg_temp.av3('dep_ff')), 'nothing holds it up';
end $$;

update public.tasks set kind = 'milestone' where id = pg_temp.av3('dep_ss');
update public.task_projects set section_id = pg_temp.av3('design') where task_id = pg_temp.av3('dep_sf') and project_id = pg_temp.av3('p');
update public.task_projects set section_id = pg_temp.av3('review') where task_id = pg_temp.av3('dep_sf') and project_id = pg_temp.av3('p');
do $$
begin
  assert exists (select 1 from public.comments where task_id = pg_temp.av3('dep_ss') and body = 'Milestone!'), 'Task type changes';
  assert (select count(*) from public.comments where task_id = pg_temp.av3('dep_sf') and body = 'Out of design') = 1, 'moved out of Design';
  assert (select count(*) from public.comments where task_id = pg_temp.av3('dep_sf') and body = 'Moved somewhere') = 2, 'any section change';
end $$;
update public.rules set enabled = false where project_id = pg_temp.av3('p') and name in ('Unblocked', 'Now a milestone', 'Left Design', 'Any section');

-- Create a task (in another project, linked), Move to project, Remove from project, Set task type,
-- Set description.
do $$
declare
  p uuid := pg_temp.av3('p');
  q uuid := pg_temp.av3('q');
  t uuid;
  r uuid;
  made uuid;
begin
  t := public.create_task(p, pg_temp.av3('intake'), 'Event brief');
  update public.tasks set assignee_id = pg_temp.av3('dana') where id = t;
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions)
  values (p, 'Spawn', true, 'manual', '{"timezone": "UTC"}', jsonb_build_array(jsonb_build_object(
    'type', 'create_task', 'kind', 'milestone', 'title', 'Launch: {{task.name}}', 'project_id', q,
    'assignee', 'creator', 'due_days', 3, 'link', 'blocked_by', 'notes', 'From {{task.name}}'
  ))) returning id into r;
  perform public.run_manual_rule(r, t);
  select tk.id into made from public.tasks tk where tk.title = 'Launch: Event brief';
  assert made is not null, format('the task was made: %s', (select rr.detail from public.rule_runs rr where rr.rule_id = r order by rr.created_at desc limit 1));
  assert (select (kind, home_project_id, assignee_id, due_on, notes) = ('milestone', q, pg_temp.av3('ava'), current_date + 3, 'From Event brief')
          from public.tasks where id = made), 'kind, project, assignee, due date, and description';
  assert exists (select 1 from public.task_dependencies d where d.predecessor_id = t and d.successor_id = made and d.deleted_at is null),
    'it waits on the triggering task';

  -- Validation.
  begin
    insert into public.rules (project_id, name, trigger_type, actions)
    values (p, 'Bad create', 'manual', '[{"type": "create_task", "title": ""}]');
    raise exception 'a task needs a name';
  exception when check_violation then null;
  end;
  begin
    insert into public.rules (project_id, name, trigger_type, actions)
    values (p, 'Bad link', 'manual', '[{"type": "create_task", "title": "x", "link": "sideways"}]');
    raise exception 'unknown link';
  exception when check_violation then null;
  end;

  -- Set task type and Set description.
  update public.rules set actions = '[{"type": "set_task_type", "kind": "approval"}, {"type": "set_description", "mode": "append", "text": "Approved by {{task.assignee}}"}]'
  where id = r;
  update public.tasks set notes = 'Brief' where id = t;
  perform public.run_manual_rule(r, t);
  assert (select kind from public.tasks where id = t) = 'approval', 'Set task type';
  assert (select notes from public.tasks where id = t) like E'Brief\n\nApproved by %', 'appended to the description';

  -- Remove from project: it's only in P, so it stays.
  update public.rules set actions = '[{"type": "remove_from_project"}]' where id = r;
  perform public.run_manual_rule(r, t);
  assert exists (select 1 from public.task_projects where task_id = t and project_id = p and deleted_at is null), 'a task always keeps a project';

  -- Move to Q: home moves, P's membership goes.
  update public.rules set actions = jsonb_build_array(jsonb_build_object('type', 'move_to_project', 'project_id', q)) where id = r;
  perform public.run_manual_rule(r, t);
  assert (select home_project_id from public.tasks where id = t) = q, 'the home moved';
  assert not exists (select 1 from public.task_projects where task_id = t and project_id = p and deleted_at is null), 'out of P';
end $$;

-- A rule that makes a task when a task is added stops at its own chain (no runaway).
do $$
begin
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values (pg_temp.av3('p'), 'Echo', true, 'task_created', '[{"type": "create_task", "title": "Echo of {{task.name}}"}]');
end $$;
select public.create_task(pg_temp.av3('p'), pg_temp.av3('intake'), 'Seed') is not null as ok \gset
do $$
begin
  assert (select count(*) from public.tasks where title like 'Echo of %') = 1, 'one echo: the made task doesn''t re-trigger the rule';
  assert exists (select 1 from public.rule_runs rr join public.rules ru on ru.id = rr.rule_id
                 where ru.name = 'Echo' and rr.status = 'skipped' and rr.detail ->> 'reason' = 'loop'), 'the loop was refused';
  update public.rules set enabled = false where name = 'Echo';
end $$;

-- Conditions: blocked, approval status, attachments, comments, type is not, section one of, field one of.
do $$
declare
  p uuid := pg_temp.av3('p');
  r public.rules := (select ru from public.rules ru where ru.id = pg_temp.av3('r_dates'));
  t uuid;
  f uuid;
begin
  t := public.create_task(p, pg_temp.av3('intake'), 'Checks');
  r.conditions := '[{"type": "is_not_blocked"}, {"type": "no_attachment"}, {"type": "no_comment"}, {"type": "task_type_is_not", "kind": "approval"}]';
  assert public.rule_conditions_pass(r, t), 'a fresh task';
  r.conditions := '[{"type": "approval_status_is", "statuses": ["none"]}]';
  assert public.rule_conditions_pass(r, t), 'no approval yet';
  perform public.request_approval(t, pg_temp.av3('eli'), null, false, null);
  r.conditions := '[{"type": "approval_status_is", "statuses": ["pending", "changes_requested"]}]';
  assert public.rule_conditions_pass(r, t), 'pending';
  insert into public.comments (task_id, author_id, body) values (t, pg_temp.av3('ava'), 'Hi');
  r.conditions := '[{"type": "has_comment"}]';
  assert public.rule_conditions_pass(r, t), 'has a comment';
  r.conditions := jsonb_build_array(jsonb_build_object('type', 'section_is_one_of', 'section_ids', jsonb_build_array(pg_temp.av3('design'), pg_temp.av3('intake'))));
  assert public.rule_conditions_pass(r, t), 'section is one of';
  r.conditions := jsonb_build_array(jsonb_build_object('type', 'section_is_none_of', 'section_ids', jsonb_build_array(pg_temp.av3('intake'))));
  assert not public.rule_conditions_pass(r, t), 'section is none of';

  insert into public.custom_fields (project_id, name, field_type, options)
  values (p, 'Channel', 'single_select', '[{"id": "o-web", "name": "Web", "color": "blue"}, {"id": "o-print", "name": "Print", "color": "red"}, {"id": "o-tv", "name": "TV", "color": "green"}]')
  returning id into f;
  insert into public.task_field_values (task_id, field_id, value) values (t, f, '"o-print"');
  r.conditions := jsonb_build_array(jsonb_build_object('type', 'field_compare', 'field_id', f, 'op', 'one_of', 'value', '["o-web", "o-print"]'::jsonb));
  assert public.rule_conditions_pass(r, t), 'field is one of';
  r.conditions := jsonb_build_array(jsonb_build_object('type', 'field_compare', 'field_id', f, 'op', 'none_of', 'value', '["o-print"]'::jsonb));
  assert not public.rule_conditions_pass(r, t), 'field is none of';
  -- Saving a one-of comparison validates its shape.
  insert into public.rules (project_id, name, trigger_type, conditions, actions)
  values (p, 'One of', 'manual', jsonb_build_array(jsonb_build_object('type', 'field_compare', 'field_id', f, 'op', 'one_of', 'value', '["o-tv"]'::jsonb)),
    '[{"type": "complete_task"}]');
end $$;

-- ---------------------------------------------------------------------------------------------
-- Batch D: portfolio rules
-- ---------------------------------------------------------------------------------------------

do $$
begin
  assert has_function_privilege('authenticated', 'public.run_portfolio_rule(uuid, uuid)', 'execute'), 'manual runs are an RPC';
  assert not has_function_privilege('anon', 'public.run_portfolio_rule(uuid, uuid)', 'execute'), 'nothing for anon';
  assert not has_function_privilege('authenticated', 'public.run_portfolio_rule_engine(public.portfolio_rules, uuid, jsonb, text)', 'execute'),
    'the engine is internal';
  assert not has_table_privilege('authenticated', 'public.portfolio_rule_runs', 'insert'), 'runs: no client writes';
  assert not has_table_privilege('anon', 'public.portfolio_rules', 'select'), 'rules: nothing for anon';
  assert (select relrowsecurity from pg_class where oid = 'public.portfolio_rules'::regclass), 'RLS on';
  assert (select pg_get_constraintdef(oid) like '%project_id%' from pg_constraint where conname = 'inbox_items_target_check_v3')
    and not exists (select 1 from pg_constraint where conname = 'inbox_items_target_check'),
    'the tail dropped the narrower Inbox target CHECK';
end $$;

-- Ava owns portfolio PF with P (hers) and a new project R (hers too); Eli is a portfolio Editor.
do $$
declare
  pf uuid;
  r uuid;
  f uuid;
begin
  insert into public.portfolios (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'AV3 Campaigns') returning id into pf;
  insert into av3_ids values ('pf', pf);
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'AV3 Spring launch') returning id into r;
  insert into av3_ids values ('proj_r', r);
  perform public.add_portfolio_member(pf, 'av3-eli@example.com', 'editor');
  perform public.add_project_member(r, 'av3-eli@example.com', 'editor');
  insert into public.portfolio_fields (portfolio_id, name, field_type, options)
  values (pf, 'Budget', 'single_select', '[{"id": "o-ok", "name": "OK", "color": "green"}, {"id": "o-over", "name": "Over", "color": "red"}]')
  returning id into f;
  insert into av3_ids values ('pf_budget', f);

  -- When a project is added: remind its owner to post a status. When Budget becomes Over: mark it at risk.
  insert into public.portfolio_rules (portfolio_id, name, enabled, trigger_type, actions)
  values (pf, 'Welcome', true, 'item_added', '[{"type": "status_reminder", "message": "Post a kickoff status for {{project.name}} in {{portfolio.name}}"}]');
  insert into public.portfolio_rules (portfolio_id, name, enabled, trigger_type, trigger_config, actions)
  values (pf, 'Over budget', true, 'field_changed', jsonb_build_object('field_id', f, 'option_id', 'o-over'),
    '[{"type": "set_status", "status": "at_risk", "note": "Over budget"}]');
  -- When a project goes off track or at risk: add Vera as a viewer (once).
  insert into public.portfolio_rules (portfolio_id, name, enabled, trigger_type, trigger_config, conditions, actions)
  values (pf, 'Watch risky', true, 'status_changed', '{"statuses": ["at_risk", "off_track"]}', '[{"type": "is_not_archived"}]',
    jsonb_build_array(jsonb_build_object('type', 'add_members', 'people', jsonb_build_array(pg_temp.av3('vera')), 'role', 'viewer')));

  perform public.add_portfolio_project(pf, r);
end $$;

do $$
declare
  r uuid := pg_temp.av3('proj_r');
begin
  assert exists (
    select 1 from public.inbox_items i
    where i.recipient_id = pg_temp.av3('ava') and i.project_id = r and i.kind = 'rule'
      and i.data ->> 'message' = 'Post a kickoff status for AV3 Spring launch in AV3 Campaigns'
  ), 'item added: the owner got a status reminder about the project';
  assert exists (select 1 from jsonb_array_elements(public.inbox_page('activity')) x where x -> 'project' ->> 'id' = r::text),
    'the Inbox page lists items about a project';
  assert public.inbox_unread_count() >= 1, 'and counts them';
end $$;

-- Budget → Over: status at risk, which adds Vera (a chain of two portfolio rules).
select public.set_portfolio_field_value(pg_temp.av3('pf_budget'), pg_temp.av3('proj_r'), '"o-over"') is null as ok \gset
do $$
declare
  r uuid := pg_temp.av3('proj_r');
begin
  assert (select status from public.projects where id = r) = 'at_risk', 'field changed → status set';
  assert public.profile_project_role(pg_temp.av3('vera'), r) = 'viewer', 'status changed → Vera added as a viewer';
  assert (select count(*) from public.portfolio_rule_runs rr where rr.project_id = r and rr.status = 'succeeded') = 3, 'three runs logged';
end $$;

-- A manual rule with conditions, the due date, a rename, and a notification; then one that acts with
-- Eli's access (an Editor of R can't archive it).
do $$
declare
  pf uuid := pg_temp.av3('pf');
  r uuid := pg_temp.av3('proj_r');
  rule uuid;
  out jsonb;
begin
  insert into public.portfolio_rules (portfolio_id, name, enabled, trigger_type, conditions, actions)
  values (pf, 'Plan it', true, 'manual', '[{"type": "status_is", "statuses": ["at_risk"]}, {"type": "no_due_date"}]',
    '[{"type": "set_due_date", "mode": "date", "date": "2026-12-15"}, {"type": "set_name", "name": "{{project.name}} (watch)"},
      {"type": "notify", "people": ["members"], "message": "{{project.name}} is due {{project.due_date}}"}]')
  returning id into rule;
  out := public.run_portfolio_rule(rule, r);
  assert out ->> 'status' = 'succeeded', format('ran: %s', out);
  assert (select (due_on, name) = (date '2026-12-15', 'AV3 Spring launch (watch)') from public.projects where id = r), 'due date and name';
  assert exists (select 1 from public.inbox_items i where i.recipient_id = pg_temp.av3('eli') and i.project_id = r
    and i.data ->> 'message' = 'AV3 Spring launch (watch) is due Dec 15, 2026'), 'members were notified';
  out := public.run_portfolio_rule(rule, r);
  assert out ->> 'status' = 'conditions', 'it has a due date now';

  insert into public.portfolio_rules (portfolio_id, name, enabled, trigger_type, owner_id, actions)
  values (pf, 'Archive', true, 'manual', pg_temp.av3('eli'), '[{"type": "archive_project"}]') returning id into rule;
  out := public.run_portfolio_rule(rule, r);
  assert out ->> 'status' = 'failed', 'the owner''s own access decides';
  assert (select archived_at is null from public.projects where id = r), 'not archived';

  -- Validation.
  begin
    insert into public.portfolio_rules (portfolio_id, name, trigger_type, actions)
    values (pf, 'Bad', 'manual', '[{"type": "delete_everything"}]');
    raise exception 'unknown actions are refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.portfolio_rules (portfolio_id, name, trigger_type, trigger_config, actions)
    values (pf, 'Bad field', 'field_changed', jsonb_build_object('field_id', pg_temp.av3('designer')), '[{"type": "archive_project"}]');
    raise exception 'a project field isn''t a portfolio field';
  exception when check_violation then null;
  end;
end $$;

-- Eli (a portfolio Editor) reads the rules but can't change them; Vera (not in the portfolio) sees none.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3030030-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  assert (select count(*) from public.portfolio_rules where portfolio_id = pg_temp.av3('pf')) >= 4, 'Editors read the rules';
  update public.portfolio_rules set enabled = false where portfolio_id = pg_temp.av3('pf');
  assert not found, 'only Admins change them';
end $$;
select set_config('request.jwt.claim.sub', 'a3030030-0000-4000-8000-000000000005', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.portfolio_rules where portfolio_id = pg_temp.av3('pf')), 'non-members see nothing';
end $$;
reset role;
select set_config('request.jwt.claim.sub', 'a3030030-0000-4000-8000-000000000001', false) is not null as ok \gset

-- Due soon (the scheduler).
do $$
declare
  pf uuid := pg_temp.av3('pf');
  r uuid := pg_temp.av3('proj_r');
begin
  update public.projects set due_on = current_date + 3 where id = r;
  insert into public.portfolio_rules (portfolio_id, name, enabled, trigger_type, trigger_config, actions)
  values (pf, 'Due soon', true, 'due_approaching', '{"days": 3, "timezone": "UTC"}', '[{"type": "status_reminder"}]');
  assert (public.workflow_tick() ->> 'portfolio_rules')::integer = 1, 'the scheduler ran it';
  assert (public.workflow_tick() ->> 'portfolio_rules')::integer = 0, 'once per project and due date';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Batch E: pause for a while, Convert to project, My Tasks rules
-- ---------------------------------------------------------------------------------------------

do $$
declare
  p uuid := pg_temp.av3('p');
  r uuid;
  t uuid;
begin
  t := public.create_task(p, pg_temp.av3('intake'), 'Pause me');
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values (p, 'Paused', true, 'manual', '[{"type": "add_comment", "body": "ran"}]') returning id into r;
  update public.rules set paused_until = now() + interval '1 day' where id = r;
  begin
    perform public.run_manual_rule(r, t);
    raise exception 'a paused rule doesn''t run';
  exception when check_violation then null;
  end;
  assert public.run_rule((select ru from public.rules ru where ru.id = r), t, '{}') = 'paused', 'the engine skips it';
  update public.rules set paused_until = now() - interval '1 minute' where id = r;
  assert (public.run_manual_rule(r, t)) ->> 'status' = 'succeeded', 'it runs again once the pause is over';
end $$;

-- Convert to project: a blank project owned by the rule's owner, with the task's people, in the
-- portfolio, with a brief that links the task's files; the task is completed and gets a comment.
do $$
declare
  p uuid := pg_temp.av3('p');
  r uuid;
  t uuid;
  made uuid;
  brief uuid;
begin
  t := public.create_task(p, pg_temp.av3('intake'), 'Holiday event');
  update public.tasks set notes = 'Venue + catering', assignee_id = pg_temp.av3('dana') where id = t;
  insert into public.task_attachments (task_id, storage_path, file_name, content_type, size_bytes, uploaded_by)
  values (t, t || '/x-plan.pdf', 'plan.pdf', 'application/pdf', 10, pg_temp.av3('ava'));
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values (p, 'Make it a project', true, 'manual', jsonb_build_array(jsonb_build_object(
    'type', 'convert_to_project', 'name', 'Event: {{task.name}}', 'members', 'task_people',
    'portfolio_id', pg_temp.av3('pf'), 'complete_task', true
  ))) returning id into r;
  assert (public.run_manual_rule(r, t)) ->> 'status' = 'succeeded', 'converted';
  select id into made from public.projects where name = 'Event: Holiday event';
  assert made is not null, 'the project exists';
  assert public.profile_project_role(pg_temp.av3('ava'), made) = 'owner', 'the rule''s owner owns it';
  assert public.profile_project_role(pg_temp.av3('dana'), made) = 'editor', 'the task''s people joined';
  assert exists (select 1 from public.portfolio_projects where portfolio_id = pg_temp.av3('pf') and project_id = made and deleted_at is null),
    'in the portfolio';
  select id into brief from public.tasks where home_project_id = made and title = 'Brief: Holiday event';
  assert (select notes from public.tasks where id = brief) = 'Venue + catering', 'the brief carries the description';
  assert exists (select 1 from public.task_attachment_links l where l.task_id = brief and l.name = 'plan.pdf' and l.attachment_id is not null),
    'and links the files';
  assert (select completed_at is not null from public.tasks where id = t), 'the task was completed';
  assert exists (select 1 from public.comments where task_id = t and body like 'Converted to the project “Event: Holiday event”%'), 'and says so';
end $$;

-- My Tasks rules: Dana's own rules on what's assigned to her.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3030030-0000-4000-8000-000000000003', false) is not null as ok \gset
select count(*) >= 0 as ok from public.my_tasks_layout() \gset
do $$
declare
  later uuid := (select id from public.my_task_sections where profile_id = pg_temp.av3('dana') and kind = 'do_later' and deleted_at is null);
  today_s uuid := (select id from public.my_task_sections where profile_id = pg_temp.av3('dana') and kind = 'do_today' and deleted_at is null);
begin
  insert into av3_ids values ('dana_later', later), ('dana_today', today_s);
  insert into public.my_task_rules (name, trigger_type, conditions, actions)
  values ('Requests wait', 'assigned', jsonb_build_array(jsonb_build_object('type', 'in_project', 'project_ids', jsonb_build_array(pg_temp.av3('p')))),
    jsonb_build_array(jsonb_build_object('type', 'move_to_section', 'section_id', later)));
  insert into public.my_task_rules (name, trigger_type, trigger_config, actions)
  values ('Due tomorrow', 'due_approaching', '{"days": 1, "timezone": "UTC"}',
    jsonb_build_array(jsonb_build_object('type', 'move_to_section', 'section_id', today_s)));
  begin
    insert into public.my_task_rules (name, trigger_type, actions)
    values ('Not mine', 'assigned', jsonb_build_array(jsonb_build_object('type', 'move_to_section',
      'section_id', (select id from public.my_task_sections where profile_id <> pg_temp.av3('dana') limit 1))));
    raise exception 'someone else''s section is refused';
  exception when check_violation then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', 'a3030030-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.my_task_rules where profile_id = pg_temp.av3('dana')), 'nobody else reads them';
end $$;
reset role;

do $$
declare
  p uuid := pg_temp.av3('p');
  t uuid;
  u uuid;
begin
  t := public.create_task(p, pg_temp.av3('intake'), 'For Dana');
  insert into av3_ids values ('t_dana', t);
  update public.tasks set assignee_id = pg_temp.av3('dana') where id = t;
  assert (select section_id from public.my_task_placements where profile_id = pg_temp.av3('dana') and task_id = t) = pg_temp.av3('dana_later'),
    'assigned → moved to Do later';
  u := public.create_task(p, pg_temp.av3('intake'), 'Due soon for Dana');
  update public.tasks set assignee_id = pg_temp.av3('dana'), due_on = (now() at time zone 'UTC')::date + 1 where id = u;
  assert (public.workflow_tick() ->> 'my_task_rules')::integer >= 1, 'the scheduler ran Dana''s rule';
  assert (select section_id from public.my_task_placements where profile_id = pg_temp.av3('dana') and task_id = u) = pg_temp.av3('dana_today'),
    'due tomorrow → Do today';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Saving V3 rules as the person (not the superuser): every validation and guard helper they reach
-- must be executable by authenticated (a browser run caught one that wasn't).
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'a3030030-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid := pg_temp.av3('p');
begin
  insert into public.rules (project_id, name, trigger_type, trigger_config, conditions, actions)
  values (p, 'As Ava: dates', 'start_approaching', '{"amount": 4, "unit": "hours"}',
    jsonb_build_array(
      jsonb_build_object('type', 'date_compare', 'date', 'due', 'op', 'between', 'value', '2026-11-01', 'to', '2026-11-30'),
      jsonb_build_object('type', 'section_is_one_of', 'section_ids', jsonb_build_array(pg_temp.av3('intake'))),
      jsonb_build_object('type', 'approval_status_is', 'statuses', jsonb_build_array('none'))),
    jsonb_build_array(
      jsonb_build_object('type', 'set_start_date', 'mode', 'date', 'date', '2026-11-02'),
      jsonb_build_object('type', 'create_task', 'title', 'Next {{task.name}}', 'link', 'blocked_by'),
      jsonb_build_object('type', 'convert_to_project', 'portfolio_id', pg_temp.av3('pf'))));
  insert into public.rules (project_id, name, trigger_type, trigger_config, actions)
  values (p, 'As Ava: schedule', 'scheduled', '{"frequency": "weekly", "weekdays": [0, 3], "interval": 2, "anchor": "2026-10-18", "minute": 30}',
    '[{"type": "set_task_type", "kind": "milestone"}]');
  insert into public.portfolio_rules (portfolio_id, name, trigger_type, trigger_config, conditions, actions)
  values (pg_temp.av3('pf'), 'As Ava: portfolio', 'scheduled', '{"frequency": "daily", "hour": 8}',
    '[{"type": "status_is", "statuses": ["at_risk"]}, {"type": "date_compare", "op": "before", "value": "2026-12-01"}]',
    '[{"type": "status_reminder"}, {"type": "set_due_date", "mode": "relative", "days": 5, "business_days": true}]');
  update public.portfolio_rules set paused_until = now() + interval '1 day', owner_id = pg_temp.av3('eli')
  where name = 'As Ava: portfolio';
  assert found, 'the portfolio rule saved and changed as Ava';
  insert into public.my_task_rules (name, trigger_type, trigger_config, conditions, actions)
  values ('As Ava: mine', 'task_overdue', '{"days": 2}', '[{"type": "is_private"}]', '[{"type": "complete_task"}]');
end $$;
reset role;

do $$
begin
  raise notice 'automations v3 smoke: all assertions passed';
end $$;
