-- Automations V3 (20261021010000_automations_v3_a.sql + 20261021020000_automations_v3_tail.sql).
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
  assert (select count(*) from pg_constraint where conname = 'rules_trigger_type_check') = 1
    and not exists (select 1 from pg_constraint where conname in ('rules_trigger_type_check_v2', 'rules_trigger_type_check_v3')),
    'the V3 tail renamed the wider trigger CHECK';
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

do $$
begin
  raise notice 'automations v3 smoke: all assertions passed';
end $$;
