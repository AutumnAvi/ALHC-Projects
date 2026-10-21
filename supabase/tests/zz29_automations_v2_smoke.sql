-- Automations V2 (20261020010000_automations_v2.sql).
-- Batch 2: business days on the workspace's workweek, schedules, AND / OR condition groups and the new
-- conditions, the new triggers and actions, per-step run logs, run_manual_rule, overdue and scheduled
-- rules in workflow_tick, and validation.
--   a2920029…01 av2-owner@example.com   Ava Owner (owns P)
--   a2920029…02 av2-editor@example.com  Eli Editor (Editor of P; owns Q, where Ava is an Editor)
--   a2920029…03 av2-viewer@example.com  Vera Viewer (Viewer of P)

\set ON_ERROR_STOP 1

create temporary table av2_ids (name text primary key, id uuid) on commit preserve rows;
grant all on av2_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('av2-owner@example.com', 'automations v2'),
  ('av2-editor@example.com', 'automations v2'),
  ('av2-viewer@example.com', 'automations v2');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a2920029-0000-4000-8000-000000000001', 'av2-owner@example.com', now(), '{"full_name":"Ava Owner"}'),
  ('a2920029-0000-4000-8000-000000000002', 'av2-editor@example.com', now(), '{"full_name":"Eli Editor"}'),
  ('a2920029-0000-4000-8000-000000000003', 'av2-viewer@example.com', now(), '{"full_name":"Vera Viewer"}');

-- ---------------------------------------------------------------------------------------------
-- Business days (shared vectors with tests/unit/workdays.test.ts). Oct 19, 2026 is a Monday.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  sun_thu smallint[] := '{0,1,2,3,4}';
  mon_fri smallint[] := '{1,2,3,4,5}';
begin
  assert (select work_week from public.workspaces where id = '00000000-0000-4000-8000-000000000001') = sun_thu,
    'the default workweek is Sunday–Thursday';
  assert public.rule_add_days('2026-10-22', 1, true, sun_thu) = '2026-10-25', 'Thu + 1 workday = Sun (Fri / Sat skipped)';
  assert public.rule_add_days('2026-10-22', 3, true, sun_thu) = '2026-10-27', 'Thu + 3 workdays = Tue';
  assert public.rule_add_days('2026-10-19', 5, true, sun_thu) = '2026-10-26', 'Mon + 5 workdays = next Mon';
  assert public.rule_add_days('2026-10-23', 0, true, sun_thu) = '2026-10-25', 'Fri + 0 workdays = the next workday';
  assert public.rule_add_days('2026-10-22', 0, true, sun_thu) = '2026-10-22', 'a workday + 0 = itself';
  assert public.rule_add_days('2026-10-25', -1, true, sun_thu) = '2026-10-22', 'Sun − 1 workday = Thu';
  assert public.rule_add_days('2026-10-24', -1, true, sun_thu) = '2026-10-22', 'Sat − 1 workday = Thu';
  assert public.rule_add_days('2026-10-22', 3, false, sun_thu) = '2026-10-25', 'calendar days ignore the workweek';
  assert public.rule_add_days('2026-10-23', 1, true, mon_fri) = '2026-10-26', 'Mon–Fri: Fri + 1 = Mon';
  assert public.rule_add_days('2026-10-23', 1, true, '{0,1,2,3,4,5,6}') = '2026-10-24', 'seven workdays = calendar days';
  assert public.rule_add_days(null, 1, true, sun_thu) is null, 'no date, no result';

  -- Schedules (UTC).
  assert public.rule_schedule_next_at('{"frequency":"daily","hour":9,"timezone":"UTC"}', sun_thu, '2026-10-19 10:00+00')
    = '2026-10-20 09:00+00', 'daily after 9:00 → tomorrow 9:00';
  assert public.rule_schedule_next_at('{"frequency":"daily","hour":9,"timezone":"UTC"}', sun_thu, '2026-10-19 08:00+00')
    = '2026-10-19 09:00+00', 'daily before 9:00 → today 9:00';
  assert public.rule_schedule_next_at('{"frequency":"weekly","weekday":0,"hour":9,"timezone":"UTC"}', sun_thu, '2026-10-19 10:00+00')
    = '2026-10-25 09:00+00', 'weekly on Sunday';
  assert public.rule_schedule_next_at('{"frequency":"workdays","hour":9,"timezone":"UTC"}', sun_thu, '2026-10-22 10:00+00')
    = '2026-10-25 09:00+00', 'workdays skip Friday and Saturday';
  assert public.rule_schedule_next_at('{"frequency":"monthly","month_day":1,"hour":9,"timezone":"UTC"}', sun_thu, '2026-10-19 10:00+00')
    = '2026-11-01 09:00+00', 'monthly on the 1st';
  assert public.rule_schedule_next_at('{"frequency":"monthly"}', sun_thu, '2026-10-19 10:00+00') is not null, 'defaults fill in';
  assert public.rule_schedule_next_at('{}', sun_thu, now()) is null, 'no frequency, no schedule';

  begin
    update public.workspaces set work_week = '{7}' where id = '00000000-0000-4000-8000-000000000001';
    raise exception 'a day outside 0–6 must be refused';
  exception when check_violation then null;
  end;

  assert not has_function_privilege('anon', 'public.run_manual_rule(uuid, uuid)', 'execute'), 'anon: no manual runs';
  assert has_function_privilege('authenticated', 'public.run_manual_rule(uuid, uuid)', 'execute'), 'members run manual rules';
  assert not has_function_privilege('authenticated', 'public.execute_rule_actions(public.rules, uuid, jsonb, jsonb)', 'execute'),
    'the engine is not an RPC';
  assert not has_function_privilege('authenticated', 'public.rule_condition_ok(public.rules, jsonb, public.tasks, uuid)', 'execute'),
    'condition checks are internal';
  assert not has_function_privilege('authenticated', 'public.rule_people(jsonb, uuid)', 'execute'), 'people resolution is internal';
  -- (Automations V3's tail replaces it with its wider rules_trigger_type_check_v3.)
  assert (select count(*) from pg_constraint where conname in ('rules_trigger_type_check', 'rules_trigger_type_check_v3')) = 1
    and not exists (select 1 from pg_constraint where conname = 'rules_trigger_type_check_v2'),
    'the tail renamed the wider trigger CHECK';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Setup: P (Ava owns; Eli Editor; Vera Viewer), Q (Eli owns; Ava Editor)
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'a2920029-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  q uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'AV2 Calendar')
    returning id into q;
  insert into av2_ids values ('q', q);
  insert into public.sections (project_id, name) values (q, 'Inbox') returning id into q;
  insert into av2_ids values ('q_inbox', q);
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'AV2 Private')
    returning id into q;
  insert into av2_ids values ('r', q);
end $$;

-- Eli adds Ava to Q as an Editor.
do $$
begin
  perform public.add_project_member((select id from av2_ids where name = 'q'), 'av2-owner@example.com', 'editor');
end $$;
select set_config('request.jwt.claim.sub', 'a2920029-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  p uuid;
  s uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'AV2 Requests')
    returning id into p;
  insert into av2_ids values ('p', p);
  perform public.add_project_member(p, 'av2-editor@example.com', 'editor');
  perform public.add_project_member(p, 'av2-viewer@example.com', 'viewer');
  insert into public.sections (project_id, name, sort_order) values (p, 'Intake', 1) returning id into s;
  insert into av2_ids values ('intake', s);
  insert into public.sections (project_id, name, sort_order) values (p, 'Review', 2) returning id into s;
  insert into av2_ids values ('review', s);
  insert into public.custom_fields (project_id, name, field_type) values (p, 'Budget', 'number') returning id into s;
  insert into av2_ids values ('budget', s);
  insert into public.custom_fields (project_id, name, field_type) values (p, 'Brief', 'text') returning id into s;
  insert into av2_ids values ('brief', s);
  insert into public.tags (workspace_id, name, color) values ('00000000-0000-4000-8000-000000000001', 'av2-hot', 'red') returning id into s;
  insert into av2_ids values ('tag_hot', s);
  insert into public.tags (workspace_id, name, color) values ('00000000-0000-4000-8000-000000000001', 'av2-calendar', 'blue') returning id into s;
  insert into av2_ids values ('tag_cal', s);
  insert into public.tags (workspace_id, name, color) values ('00000000-0000-4000-8000-000000000001', 'av2-files', 'green') returning id into s;
  insert into av2_ids values ('tag_files', s);
  insert into public.tags (workspace_id, name, color) values ('00000000-0000-4000-8000-000000000001', 'av2-big', 'orange') returning id into s;
  insert into av2_ids values ('tag_big', s);
end $$;

-- ---------------------------------------------------------------------------------------------
-- AND / OR condition groups and the new conditions (rule_conditions_pass)
-- ---------------------------------------------------------------------------------------------

do $$
declare
  p uuid := (select id from av2_ids where name = 'p');
begin
  insert into av2_ids values ('t_or', public.create_task(p, (select id from av2_ids where name = 'intake'), 'Plain flyer'));
  insert into av2_ids values ('t_or2', public.create_task(p, (select id from av2_ids where name = 'review'), 'Urgent banner'));
  -- (Intake AND assigned) OR (title contains "urgent")
  insert into public.rules (project_id, name, enabled, trigger_type, conditions, actions) values (p, 'OR rule', false, 'manual',
    jsonb_build_array(
      jsonb_build_object('type', 'section_is', 'section_id', (select id from av2_ids where name = 'intake')),
      jsonb_build_object('type', 'assignee_is_set'),
      jsonb_build_object('type', 'title_contains', 'text', 'URGENT', 'group', 1)
    ),
    '[{"type": "complete_task"}]') returning id into p;
  insert into av2_ids values ('r_or', p);
end $$;

reset role;

do $$
declare
  r public.rules := (select ru from public.rules ru where ru.id = (select id from av2_ids where name = 'r_or'));
  plain uuid := (select id from av2_ids where name = 't_or');
  urgent uuid := (select id from av2_ids where name = 't_or2');
begin
  assert not public.rule_conditions_pass(r, plain), 'Intake but unassigned, no "urgent": neither group passes';
  assert public.rule_conditions_pass(r, urgent), 'the second group (title contains, any case) passes alone';
  update public.tasks set assignee_id = 'a2920029-0000-4000-8000-000000000002' where id = plain;
  assert public.rule_conditions_pass(r, plain), 'Intake and assigned: the first group passes';
  update public.task_projects set section_id = (select id from av2_ids where name = 'review') where task_id = plain;
  assert not public.rule_conditions_pass(r, plain), 'assigned but not in Intake: the AND group fails';
  r.conditions := '[]';
  assert public.rule_conditions_pass(r, plain), 'no conditions: always';

  -- New conditions, one at a time.
  r.conditions := jsonb_build_array(jsonb_build_object('type', 'assignee_is', 'people', jsonb_build_array('a2920029-0000-4000-8000-000000000002')));
  assert public.rule_conditions_pass(r, plain) and not public.rule_conditions_pass(r, urgent), 'assignee is';
  r.conditions := jsonb_build_array(jsonb_build_object('type', 'assignee_is_not', 'people', '["assignee"]'::jsonb));
  assert not public.rule_conditions_pass(r, plain) and public.rule_conditions_pass(r, urgent), 'assignee is not (a role)';
  r.conditions := jsonb_build_array(jsonb_build_object('type', 'creator_is', 'people', jsonb_build_array('a2920029-0000-4000-8000-000000000001')));
  assert public.rule_conditions_pass(r, plain), 'creator is';
  r.conditions := '[{"type": "task_type_is", "kind": "task"}]';
  assert public.rule_conditions_pass(r, plain), 'task type';
  r.conditions := '[{"type": "no_due_date"}]';
  assert public.rule_conditions_pass(r, plain), 'no due date';
  update public.tasks set due_on = (now() at time zone 'UTC')::date - 2 where id = plain;
  r.conditions := '[{"type": "is_overdue"}]';
  assert public.rule_conditions_pass(r, plain), 'overdue';
  r.conditions := '[{"type": "due_within", "days": 3}]';
  assert not public.rule_conditions_pass(r, plain), 'overdue is not "due within"';
  update public.tasks set due_on = (now() at time zone 'UTC')::date + 2 where id = plain;
  assert public.rule_conditions_pass(r, plain), 'due within 3 days';
  r.conditions := '[{"type": "has_tag", "tag_id": "' || (select id from av2_ids where name = 'tag_big') || '"}]';
  assert not public.rule_conditions_pass(r, plain), 'no tag yet';
  insert into public.task_tags (task_id, tag_id) values (plain, (select id from av2_ids where name = 'tag_big'));
  assert public.rule_conditions_pass(r, plain), 'has tag';
  r.conditions := '[{"type": "lacks_tag", "tag_id": "' || (select id from av2_ids where name = 'tag_big') || '"}]';
  assert not public.rule_conditions_pass(r, plain) and public.rule_conditions_pass(r, urgent), 'lacks tag';

  -- Field comparisons.
  insert into public.task_field_values (task_id, field_id, value) values
    (plain, (select id from av2_ids where name = 'budget'), '1500'),
    (plain, (select id from av2_ids where name = 'brief'), '"Print run for the SPRING fair"');
  r.conditions := '[{"type": "field_compare", "field_id": "' || (select id from av2_ids where name = 'budget') || '", "op": "gt", "value": 1000}]';
  assert public.rule_conditions_pass(r, plain) and not public.rule_conditions_pass(r, urgent), 'number greater than (empty never passes)';
  r.conditions := '[{"type": "field_compare", "field_id": "' || (select id from av2_ids where name = 'budget') || '", "op": "lte", "value": 1000}]';
  assert not public.rule_conditions_pass(r, plain), 'number at most';
  r.conditions := '[{"type": "field_compare", "field_id": "' || (select id from av2_ids where name = 'brief') || '", "op": "contains", "value": "spring"}]';
  assert public.rule_conditions_pass(r, plain), 'text contains (any case)';
  r.conditions := '[{"type": "field_compare", "field_id": "' || (select id from av2_ids where name = 'brief') || '", "op": "not_contains", "value": "spring"}]';
  assert not public.rule_conditions_pass(r, plain) and public.rule_conditions_pass(r, urgent), 'text does not contain (empty passes)';

  -- Subtasks.
  r.conditions := '[{"type": "all_subtasks_done"}]';
  assert not public.rule_conditions_pass(r, plain), 'no subtasks: not "all done"';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Validation
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'a2920029-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from av2_ids where name = 'p');
  budget text := (select id::text from av2_ids where name = 'budget');
  bad text[] := array[
    '{"conditions": [{"type": "explode"}]}',
    '{"conditions": [{"type": "is_overdue", "group": 10}]}',
    '{"conditions": [{"type": "is_overdue", "group": "1"}]}',
    '{"actions": [{"type": "complete_task", "group": 1}]}',
    '{"conditions": [{"type": "field_compare", "field_id": "' || budget || '", "op": "contains", "value": "x"}]}',
    '{"conditions": [{"type": "field_compare", "field_id": "' || budget || '", "op": "gt", "value": "10"}]}',
    '{"conditions": [{"type": "assignee_is", "people": []}]}',
    '{"conditions": [{"type": "due_within", "days": 900}]}',
    '{"conditions": [{"type": "task_type_is", "kind": "epic"}]}',
    '{"actions": [{"type": "set_due_date", "days": 400}]}',
    '{"actions": [{"type": "set_due_date", "days": 2, "from": "yesterday"}]}',
    '{"actions": [{"type": "add_tag", "tag_id": "00000000-0000-4000-8000-00000000dead"}]}',
    '{"actions": [{"type": "create_subtasks", "titles": []}]}',
    '{"actions": [{"type": "set_title", "title": "  "}]}',
    '{"actions": [{"type": "apply_task_template", "template_id": "00000000-0000-4000-8000-00000000dead"}]}',
    '{"actions": [{"type": "add_to_project", "project_id": "' || p || '"}]}',
    '{"trigger_type": "scheduled", "trigger_config": {}}',
    '{"trigger_type": "scheduled", "trigger_config": {"frequency": "weekly", "weekday": 7}}',
    '{"trigger_type": "task_overdue", "trigger_config": {"days": 31}}',
    '{"trigger_type": "tag_added", "trigger_config": {"tag_id": "00000000-0000-4000-8000-00000000dead"}}'
  ];
  spec jsonb;
begin
  foreach spec in array bad::jsonb[] loop
    begin
      insert into public.rules (project_id, name, trigger_type, trigger_config, conditions, actions)
      values (p, 'Bad', coalesce(spec ->> 'trigger_type', 'manual'), coalesce(spec -> 'trigger_config', '{}'),
        coalesce(spec -> 'conditions', '[]'), coalesce(spec -> 'actions', '[{"type": "complete_task"}]'));
      raise exception 'must be refused: %', spec;
    exception when check_violation then null;
    end;
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- New triggers and actions
-- ---------------------------------------------------------------------------------------------

do $$
declare
  p uuid := (select id from av2_ids where name = 'p');
begin
  insert into public.rules (project_id, name, enabled, trigger_type, actions) values
    (p, 'Completed → comment', true, 'task_completed', '[{"type": "add_comment", "body": "Finished {task}"}]'),
    (p, 'Reopened → Review', true, 'task_reopened',
      jsonb_build_array(jsonb_build_object('type', 'move_section', 'section_id', (select id from av2_ids where name = 'review')))),
    (p, 'Due changed → hot', true, 'due_date_changed',
      jsonb_build_array(jsonb_build_object('type', 'add_tag', 'tag_id', (select id from av2_ids where name = 'tag_hot')))),
    (p, 'Subtasks done → complete', true, 'subtasks_completed', '[{"type": "complete_task"}]'),
    (p, 'File → tag', true, 'attachment_added',
      jsonb_build_array(jsonb_build_object('type', 'add_tag', 'tag_id', (select id from av2_ids where name = 'tag_files'))));
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions) values
    (p, 'Hot → rename', true, 'tag_added', jsonb_build_object('tag_id', (select id from av2_ids where name = 'tag_hot')),
      '[{"type": "set_title", "title": "[Hot] {task}"}]');
  insert into public.rules (project_id, name, enabled, trigger_type, conditions, actions) values
    (p, 'Comment ping → notify', true, 'comment_added', '[{"type": "title_contains", "text": "ping"}]',
      '[{"type": "notify", "people": ["a2920029-0000-4000-8000-000000000003"], "message": "New comment on {task}"}]');
  insert into av2_ids values ('t_main', public.create_task(p, (select id from av2_ids where name = 'intake'), 'Spring poster'));
  insert into av2_ids values ('t_ping', public.create_task(p, (select id from av2_ids where name = 'intake'), 'ping me'));
end $$;

-- As Eli (an Editor of P, owner of Q): Q's rule, then complete, reopen, change the due date, comment,
-- attach, multi-home.
select set_config('request.jwt.claim.sub', 'a2920029-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
begin
  -- Q's rule: tasks added from another project get the calendar tag.
  insert into public.rules (project_id, name, enabled, trigger_type, actions) values
    ((select id from av2_ids where name = 'q'), 'Joined → calendar tag', true, 'task_added_from_project',
      jsonb_build_array(jsonb_build_object('type', 'add_tag', 'tag_id', (select id from av2_ids where name = 'tag_cal'))));
end $$;

do $$
declare
  t uuid := (select id from av2_ids where name = 't_main');
begin
  update public.tasks set completed_at = now() where id = t;
end $$;

do $$
declare
  t uuid := (select id from av2_ids where name = 't_main');
begin
  assert exists (select 1 from public.comments c where c.task_id = t and c.rule_id is not null and c.body = 'Finished Spring poster'),
    'task completed → the rule commented';
  update public.tasks set completed_at = null where id = t;
end $$;

do $$
declare
  t uuid := (select id from av2_ids where name = 't_main');
begin
  assert (select tp.section_id from public.task_projects tp where tp.task_id = t) = (select id from av2_ids where name = 'review'),
    'task reopened → moved to Review';
  update public.tasks set due_on = '2026-11-02' where id = t;
end $$;

do $$
declare
  t uuid := (select id from av2_ids where name = 't_main');
begin
  assert exists (select 1 from public.task_tags tt where tt.task_id = t and tt.tag_id = (select id from av2_ids where name = 'tag_hot') and tt.deleted_at is null),
    'due date changed → tagged (by a rule)';
  assert (select title from public.tasks where id = t) = '[Hot] Spring poster', 'the rule''s tag fired "tag added" → renamed';
  assert (select count(*) from public.rule_runs rr join public.rules r on r.id = rr.rule_id
    where rr.task_id = t and r.name = 'Hot → rename' and rr.status = 'succeeded') = 1, 'renamed once';
  -- Per-step log: what each step did, in words.
  assert (select rr.detail -> 'actions' -> 0 ->> 'result' from public.rule_runs rr join public.rules r on r.id = rr.rule_id
    where rr.task_id = t and r.name = 'Hot → rename') = 'Renamed to “[Hot] Spring poster”', 'the step says what it did';
  assert (select rr.detail -> 'actions' -> 0 ->> 'step' from public.rule_runs rr join public.rules r on r.id = rr.rule_id
    where rr.task_id = t and r.name = 'Reopened → Review') = '1', 'steps are numbered';

  insert into public.comments (task_id, body) values ((select id from av2_ids where name = 't_ping'), 'Any news?');
  insert into public.task_attachments (task_id, storage_path, file_name, content_type, size_bytes)
  values (t, t::text || '/x-brief.pdf', 'brief.pdf', 'application/pdf', 10);
  insert into public.task_projects (task_id, project_id, section_id, sort_order)
  values (t, (select id from av2_ids where name = 'q'), (select id from av2_ids where name = 'q_inbox'), 1024);
end $$;

reset role;
do $$
declare
  t uuid := (select id from av2_ids where name = 't_main');
begin
  assert exists (select 1 from public.inbox_items i where i.task_id = (select id from av2_ids where name = 't_ping')
    and i.recipient_id = 'a2920029-0000-4000-8000-000000000003' and i.kind = 'rule'), 'comment added → notified';
  assert not exists (select 1 from public.inbox_items i where i.task_id = t and i.recipient_id = 'a2920029-0000-4000-8000-000000000003'
    and i.data ->> 'message' like 'New comment%'), 'the comment rule''s condition kept it off the other task';
  assert exists (select 1 from public.task_tags tt where tt.task_id = t and tt.tag_id = (select id from av2_ids where name = 'tag_files') and tt.deleted_at is null),
    'attachment added → tagged';
  assert exists (select 1 from public.task_tags tt where tt.task_id = t and tt.tag_id = (select id from av2_ids where name = 'tag_cal') and tt.deleted_at is null),
    'added to another project → that project''s rule tagged it';
  assert (select count(*) from public.rule_runs rr join public.rules r on r.id = rr.rule_id
    where rr.task_id = t and r.name = 'Joined → calendar tag') = 1, 'only Q''s rule ran for the multi-home';
end $$;
set role authenticated;

-- All subtasks done → the parent completes (once, even when they're finished together).
do $$
declare
  t uuid := (select id from av2_ids where name = 't_ping');
begin
  perform public.create_subtask(t, 'Draft', null);
  perform public.create_subtask(t, 'Proof', null);
end $$;

do $$
declare
  t uuid := (select id from av2_ids where name = 't_ping');
begin
  update public.tasks set completed_at = now() where parent_task_id = t;
end $$;

do $$
declare
  t uuid := (select id from av2_ids where name = 't_ping');
begin
  assert (select completed_at is not null from public.tasks where id = t), 'all subtasks done → the parent is complete';
  assert (select count(*) from public.rule_runs rr join public.rules r on r.id = rr.rule_id
    where rr.task_id = t and r.name = 'Subtasks done → complete') = 1, 'fired once for two subtasks finished together';
  assert exists (select 1 from public.comments c where c.task_id = t and c.body = 'Finished ping me'),
    'the rule''s completion fired "task completed" too';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Manual rules: run_manual_rule and the new actions
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'a2920029-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from av2_ids where name = 'p');
  tpl uuid;
  rid uuid;
begin
  insert into public.task_templates (project_id, name, title, subtasks, tags)
  values (p, 'Creative checklist', 'Checklist', '["Brief", "Design", "Review"]',
    jsonb_build_array((select id from av2_ids where name = 'tag_big')))
  returning id into tpl;
  insert into public.rules (project_id, name, enabled, trigger_type, actions) values (p, 'Kickoff', true, 'manual',
    jsonb_build_array(
      jsonb_build_object('type', 'set_due_date', 'days', 1, 'business_days', true, 'from', 'due_date'),
      jsonb_build_object('type', 'create_subtasks', 'titles', '["Kickoff call for {task}", "Moodboard"]'::jsonb, 'assignee', 'creator'),
      jsonb_build_object('type', 'apply_task_template', 'template_id', tpl),
      jsonb_build_object('type', 'add_to_project', 'project_id', (select id from av2_ids where name = 'q'),
        'section_id', (select id from av2_ids where name = 'q_inbox')),
      jsonb_build_object('type', 'remove_tag', 'tag_id', (select id from av2_ids where name = 'tag_big'))
    )) returning id into rid;
  insert into av2_ids values ('r_kickoff', rid);
  insert into public.rules (project_id, name, enabled, trigger_type, conditions, actions) values (p, 'Big budget', true, 'manual',
    jsonb_build_array(jsonb_build_object('type', 'field_compare', 'field_id', (select id from av2_ids where name = 'budget'), 'op', 'gte', 'value', 1000)),
    jsonb_build_array(jsonb_build_object('type', 'add_tag', 'tag_id', (select id from av2_ids where name = 'tag_big'))))
    returning id into rid;
  insert into av2_ids values ('r_big', rid);
  insert into av2_ids values ('t_kick', public.create_task(p, (select id from av2_ids where name = 'intake'), 'Launch video'));

  -- Saving "Add to project" needs Editor+ there yourself: Ava isn't in Eli's private project R.
  begin
    insert into public.rules (project_id, name, trigger_type, actions) values (p, 'Into R', 'manual',
      jsonb_build_array(jsonb_build_object('type', 'add_to_project', 'project_id', (select id from av2_ids where name = 'r'))));
    raise exception 'saving add_to_project into a project you can''t edit must be refused';
  exception when insufficient_privilege or check_violation then null;
  end;
end $$;

do $$
begin
  update public.tasks set due_on = '2026-10-22' where id = (select id from av2_ids where name = 't_kick');
end $$;

-- Vera (Viewer) can't run rules; a non-manual rule can't be run by hand.
select set_config('request.jwt.claim.sub', 'a2920029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
begin
  begin
    perform public.run_manual_rule((select id from av2_ids where name = 'r_kickoff'), (select id from av2_ids where name = 't_kick'));
    raise exception 'a Viewer must not run rules';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'a2920029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from av2_ids where name = 't_kick');
  result jsonb;
begin
  begin
    perform public.run_manual_rule((select r.id from public.rules r where r.name = 'Completed → comment'), t);
    raise exception 'only manual rules run by hand';
  exception when check_violation then null;
  end;
  begin
    perform public.run_manual_rule((select id from av2_ids where name = 'r_kickoff'), public.create_task((select id from av2_ids where name = 'q'), null, 'Only in Q'));
    raise exception 'the task must be in the rule''s project';
  exception when check_violation then null;
  end;

  result := public.run_manual_rule((select id from av2_ids where name = 'r_big'), t);
  assert result ->> 'status' = 'conditions', 'no budget: the condition stops it (and nothing is logged)';

  result := public.run_manual_rule((select id from av2_ids where name = 'r_kickoff'), t);
  assert result ->> 'status' = 'succeeded', format('kickoff ran: %s', result);
  assert jsonb_array_length(result -> 'detail' -> 'actions') = 5, 'five steps logged';
  assert (select due_on from public.tasks where id = t) = '2026-10-25', 'due Thu + 1 business day (Sun–Thu) = Sun';
  assert (select count(*) from public.tasks s where s.parent_task_id = t and s.deleted_at is null) = 5,
    'two created subtasks + three from the template';
  assert exists (select 1 from public.tasks s where s.parent_task_id = t and s.title = 'Kickoff call for [Hot] Launch video'
    and s.assignee_id = 'a2920029-0000-4000-8000-000000000001'), 'subtask names use tokens (the earlier due-date rules renamed the task); the creator is assigned';
  assert exists (select 1 from public.task_projects tp where tp.task_id = t and tp.project_id = (select id from av2_ids where name = 'q')
    and tp.section_id = (select id from av2_ids where name = 'q_inbox') and tp.deleted_at is null), 'added to Q''s Inbox';
  assert not exists (select 1 from public.task_tags tt where tt.task_id = t and tt.tag_id = (select id from av2_ids where name = 'tag_big')
    and tt.deleted_at is null), 'the template''s tag was added, then the last step removed it';
  assert (result -> 'detail' -> 'actions' -> 2 ->> 'result') like 'Applied “Creative checklist”: 3 subtasks, 1 tags%', 'template step result';

  insert into public.task_field_values (task_id, field_id, value) values (t, (select id from av2_ids where name = 'budget'), '1000');
  result := public.run_manual_rule((select id from av2_ids where name = 'r_big'), t);
  assert result ->> 'status' = 'succeeded', 'budget ≥ 1000 now matches';
end $$;

-- The rule acts for its owner: once Ava can't edit Q, "Add to project" fails, and the failed run keeps
-- the steps that ran (with the failing one's error).
do $$
begin
  perform public.update_project_member_role((select id from av2_ids where name = 'q'), 'a2920029-0000-4000-8000-000000000001', 'viewer');
  insert into av2_ids values ('t_kick2', public.create_task((select id from av2_ids where name = 'p'), null, 'Second video'));
end $$;

do $$
declare
  t uuid := (select id from av2_ids where name = 't_kick2');
  result jsonb;
begin
  result := public.run_manual_rule((select id from av2_ids where name = 'r_kickoff'), t);
  assert result ->> 'status' = 'failed', 'the owner lost Editor in Q';
  assert result -> 'detail' -> 'actions' ->> 'error' like 'Add to project: the rule''s owner can''t add tasks to%', 'the reason';
  assert jsonb_array_length(result -> 'detail' -> 'steps') = 4, 'three steps ran, the fourth failed';
  assert result -> 'detail' -> 'steps' -> 3 ->> 'outcome' = 'error', 'the failing step is marked';
  assert result -> 'detail' -> 'steps' -> 0 ->> 'outcome' = 'done', 'earlier steps are listed';
  assert not exists (select 1 from public.tasks s where s.parent_task_id = t), 'a failed run rolls everything back';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Overdue and scheduled rules (workflow_tick)
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'a2920029-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from av2_ids where name = 'p');
  rid uuid;
begin
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, conditions, actions) values
    (p, 'Overdue → hot', true, 'task_overdue', '{"days": 1}', '[{"type": "title_contains", "text": "late"}]',
      jsonb_build_array(jsonb_build_object('type', 'add_tag', 'tag_id', (select id from av2_ids where name = 'tag_big'))))
    returning id into rid;
  insert into av2_ids values ('r_overdue', rid);
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, conditions, actions) values
    (p, 'Every morning', true, 'scheduled', '{"frequency": "daily", "hour": 9, "timezone": "UTC"}',
      '[{"type": "title_contains", "text": "sched"}]', '[{"type": "add_comment", "body": "Daily check on {task}"}]')
    returning id into rid;
  insert into av2_ids values ('r_sched', rid);
  insert into av2_ids values ('t_late', public.create_task(p, null, 'late banner'));
  insert into av2_ids values ('t_sched_a', public.create_task(p, null, 'sched A'));
  insert into av2_ids values ('t_sched_b', public.create_task(p, null, 'sched B'));
end $$;

do $$
begin
  update public.tasks set due_on = (now() at time zone 'UTC')::date - 1 where id = (select id from av2_ids where name = 't_late');
  assert (select next_run_at from public.rules where id = (select id from av2_ids where name = 'r_sched')) > now(),
    'a scheduled rule gets its next run time';
  -- People can't move a schedule.
  update public.rules set next_run_at = now() - interval '1 day' where id = (select id from av2_ids where name = 'r_sched');
  assert (select next_run_at from public.rules where id = (select id from av2_ids where name = 'r_sched')) > now(),
    'next_run_at is kept by the database';
end $$;

reset role;

do $$
declare
  tick jsonb;
begin
  update public.rules set next_run_at = now() - interval '1 minute' where id = (select id from av2_ids where name = 'r_sched');
  tick := public.workflow_tick();
  assert (tick ->> 'scheduled_rules')::integer = 2, format('two matching tasks: %s', tick);
  assert (select count(*) from public.comments c where c.rule_id = (select id from av2_ids where name = 'r_sched')) = 2, 'one comment each';
  assert (select next_run_at from public.rules where id = (select id from av2_ids where name = 'r_sched')) > now(), 'moved to the next run';
  assert exists (select 1 from public.task_tags tt where tt.task_id = (select id from av2_ids where name = 't_late')
    and tt.tag_id = (select id from av2_ids where name = 'tag_big') and tt.deleted_at is null), 'overdue → tagged';
  tick := public.workflow_tick();
  assert (tick ->> 'scheduled_rules')::integer = 0 and (tick ->> 'overdue_rules')::integer = 0, 'nothing runs twice';
  assert (select count(*) from public.rule_runs where rule_id = (select id from av2_ids where name = 'r_overdue')) = 1,
    'overdue fires once per task and due date';
end $$;

-- A new workweek moves "every workday" schedules at once (no extra run on a day that's now off).
do $$
declare
  p uuid := (select id from av2_ids where name = 'p');
  rid uuid;
begin
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions)
  values (p, 'Workday check', true, 'scheduled', '{"frequency": "workdays", "hour": 9, "timezone": "UTC"}', '[{"type": "complete_task"}]')
  returning id into rid;
  update public.rules set next_run_at = '2026-10-23 09:00+00' where id = rid; -- a Friday
  update public.workspaces set work_week = '{1,2,3,4,5}' where id = '00000000-0000-4000-8000-000000000001';
  assert (select next_run_at from public.rules where id = rid) > now()
    and extract(dow from (select next_run_at from public.rules where id = rid) at time zone 'UTC') between 1 and 5,
    'recomputed on the new workweek';
  update public.workspaces set work_week = '{0,1,2,3,4}' where id = '00000000-0000-4000-8000-000000000001';
  update public.rules set enabled = false where id = rid;
end $$;

-- Ordinary members can't change the workweek (workspace admins only).
set role authenticated;
select set_config('request.jwt.claim.sub', 'a2920029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  update public.workspaces set work_week = '{1,2,3,4,5}' where id = '00000000-0000-4000-8000-000000000001';
end $$;
reset role;
do $$
begin
  assert (select work_week from public.workspaces where id = '00000000-0000-4000-8000-000000000001') = '{0,1,2,3,4}',
    'a member''s update changes nothing';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Batch 3: {{placeholders}} (render_rule_text_as; mirrored by tests/unit/rule-placeholders.test.ts)
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'a2920029-0000-4000-8000-000000000001', false) is not null as ok \gset
set role authenticated;

do $$
declare
  p uuid := (select id from av2_ids where name = 'p');
  f uuid;
begin
  insert into public.forms (project_id, title, questions, accepting_responses)
  values (p, 'Design request', '[{"id": "q1", "type": "short_text", "label": "Budget"}, {"id": "q2", "type": "short_text", "label": "What do you need?"}]', true)
  returning id into f;
  insert into av2_ids values ('form', f);
  insert into av2_ids values ('t_sneaky', public.create_task(p, null, '<!channel> {{task.assignee}} & {section}'));
end $$;

do $$
begin
  insert into av2_ids values ('t_form', (public.submit_form((select id from av2_ids where name = 'form'), 'sam@example.com',
    '{"q1": "$2,000", "q2": "A rush poster"}') ->> 'task_id')::uuid);
end $$;

reset role;

do $$
declare
  p uuid := (select id from av2_ids where name = 'p');
  t uuid := (select id from av2_ids where name = 't_main');
  form_task uuid := (select id from av2_ids where name = 't_form');
  sneaky uuid := (select id from av2_ids where name = 't_sneaky');
  rendered text;
begin
  update public.tasks set assignee_id = 'a2920029-0000-4000-8000-000000000002' where id = t;
  rendered := public.render_rule_text_as(
    '{{task.name}} | {{ Task.Assignee }} | {{assignee}} | {{project.name}} | {{task.section}} | {{field.Budget}} | {{field:brief}} | {{nope}} | {task}',
    t, p, '{}', 'plain');
  assert rendered = '[Hot] Spring poster | Eli Editor | Eli Editor | AV2 Requests | Review |  |  |  | [Hot] Spring poster', rendered;
  assert public.render_rule_text_as('{{task.due_date}} / {{task.status}} / {{task.tags}}', t, p, '{}', 'plain')
    = 'Nov 2, 2026 / Open / av2-calendar, av2-files, av2-hot', 'dates, status, and tags';
  assert public.render_rule_text_as('Open {{task.url}}', t, p, '{}', 'plain') = format('Open /projects/%s?task=%s', p, t), 'a path in comments';
  assert public.render_rule_text_as('Open {{task.url}}', t, p, '{}', 'email') = format('Open alhc-link:/projects/%s?task=%s', p, t),
    'a marker the email drain resolves';
  assert public.render_rule_text_as('{{task.url}}', t, p, '{}', 'slack') = format('<alhc-link:/projects/%s?task=%s|[Hot] Spring poster>', p, t),
    'a Slack link';
  assert public.render_rule_text_as('{{approval.note}}', t, p, '{"note": "Use the new logo"}', 'plain') = 'Use the new logo', 'the approval note';
  -- Form answers and the submitter.
  assert public.render_rule_text_as('{{form.name}}: {{form.field.Budget}} / {{form.field.what do you need?}} / {{submitter.email}}', form_task, p, '{}', 'plain')
    = 'Design request: $2,000 / A rush poster / sam@example.com', 'form answers by question label';
  -- One pass: a title can't inject tokens; Slack escapes every value.
  assert public.render_rule_text_as('{{task.name}}', sneaky, p, '{}', 'plain') = '<!channel> {{task.assignee}} & {section}',
    'values are never scanned again';
  assert public.render_rule_text_as('{{task.name}} / {task}', sneaky, p, '{}', 'slack')
    = '&lt;!channel&gt; {{task.assignee}} &amp; {section} / &lt;!channel&gt; {{task.assignee}} &amp; {section}', 'Slack-escaped';
  assert public.render_rule_text_as('{task_link}', sneaky, p, '{}', 'plain') = '{task_link}', '{task_link} is Slack-only';
  assert position('alhc-link' in public.render_rule_text_as('{{task.name}} {task_link}', sneaky, p, '{}', 'slack')) > 0
    and (length(public.render_rule_text_as('{{task.name}} {task_link}', sneaky, p, '{}', 'slack'))
      - length(replace(public.render_rule_text_as('{{task.name}} {task_link}', sneaky, p, '{}', 'slack'), 'alhc-link', ''))) / 9 = 1,
    'exactly one link';
  assert not has_function_privilege('authenticated', 'public.rule_placeholder_value(text, public.tasks, uuid, jsonb, text)', 'execute'),
    'placeholder values are internal';
end $$;

-- A rule's comment uses placeholders when it runs.
set role authenticated;
do $$
declare
  p uuid := (select id from av2_ids where name = 'p');
  rid uuid;
begin
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values (p, 'Placeholder comment', true, 'manual', '[{"type": "add_comment", "body": "{{task.name}} for {{submitter.email}} is in {{task.section}}"}]')
  returning id into rid;
  insert into av2_ids values ('r_placeholder', rid);
end $$;

select set_config('request.jwt.claim.sub', 'a2920029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  form_task uuid := (select id from av2_ids where name = 't_form');
begin
  assert public.run_manual_rule((select id from av2_ids where name = 'r_placeholder'), form_task) ->> 'status' = 'succeeded', 'ran';
  assert exists (select 1 from public.comments c where c.task_id = form_task
    and c.body = (select title from public.tasks where id = form_task) || ' for sam@example.com is in No section'), 'rendered at run time';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Batch 4: owners, the dry run (nothing written), loop limits, and auto-pause
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'a2920029-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from av2_ids where name = 'p');
  rid uuid;
begin
  insert into public.rules (project_id, name, trigger_type, actions, paused_at, consecutive_failures, owner_id)
  values (p, 'Owned', 'manual', '[{"type": "complete_task"}]', now(), 7, null)
  returning id into rid;
  assert (select owner_id from public.rules where id = rid) = 'a2920029-0000-4000-8000-000000000001', 'the creator owns a new rule';
  assert (select paused_at is null and consecutive_failures = 0 and last_edited_by = owner_id from public.rules where id = rid),
    'people can''t write rule health; the creator is the last editor';
  begin
    update public.rules set owner_id = 'a2920029-0000-4000-8000-0000000000ff' where id = rid;
    raise exception 'a non-member can''t own a rule';
  exception when check_violation or foreign_key_violation then null;
  end;
  update public.rules set owner_id = 'a2920029-0000-4000-8000-000000000002', consecutive_failures = 3 where id = rid;
  assert (select owner_id from public.rules where id = rid) = 'a2920029-0000-4000-8000-000000000002', 'ownership moves to a member';
  assert (select consecutive_failures from public.rules where id = rid) = 0, 'health stays the engine''s';
end $$;

-- Test permissions: Viewers and Editors can't run the dry run (rules are Admin+).
select set_config('request.jwt.claim.sub', 'a2920029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  begin
    perform public.test_rule((select id from av2_ids where name = 'r_kickoff'), (select id from av2_ids where name = 't_main'));
    raise exception 'an Editor must not test rules';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', 'a2920029-0000-4000-8000-000000000001', false) is not null as ok \gset

-- The dry run writes nothing: every table a rule can touch has the same rows afterwards, and the task
-- itself is unchanged.
create temporary table av2_before (name text primary key, n bigint, digest text) on commit preserve rows;
grant all on av2_before to authenticated;

reset role;
create or replace function pg_temp.av2_snapshot() returns table (name text, n bigint, digest text) language sql as $$
  select 'tasks', count(*), md5(string_agg(to_jsonb(t)::text, ',' order by t.id)) from public.tasks t
  union all select 'task_projects', count(*), md5(string_agg(to_jsonb(x)::text, ',' order by x.task_id, x.project_id)) from public.task_projects x
  union all select 'comments', count(*), md5(string_agg(x.id::text, ',' order by x.id)) from public.comments x
  union all select 'task_tags', count(*), md5(string_agg(to_jsonb(x)::text, ',' order by x.id)) from public.task_tags x
  union all select 'task_field_values', count(*), md5(string_agg(to_jsonb(x)::text, ',' order by x.task_id, x.field_id)) from public.task_field_values x
  union all select 'task_followers', count(*), md5(string_agg(to_jsonb(x)::text, ',' order by x.task_id, x.profile_id)) from public.task_followers x
  union all select 'task_stories', count(*), null from public.task_stories
  union all select 'inbox_items', count(*), null from public.inbox_items
  union all select 'email_outbox', count(*), null from public.email_outbox
  union all select 'integration_outbox', count(*), null from public.integration_outbox
  union all select 'integration_secrets', count(*), null from public.integration_secrets
  union all select 'approval_requests', count(*), null from public.approval_requests
  union all select 'scheduled_rule_actions', count(*), null from public.scheduled_rule_actions
  union all select 'rule_runs', count(*), null from public.rule_runs
  union all select 'rules', count(*), md5(string_agg(to_jsonb(x)::text, ',' order by x.id)) from public.rules x;
$$;
grant execute on function pg_temp.av2_snapshot() to authenticated;
insert into av2_before select * from pg_temp.av2_snapshot();

set role authenticated;
do $$
declare
  p uuid := (select id from av2_ids where name = 'p');
  t uuid := (select id from av2_ids where name = 't_form');
  rid uuid;
  result jsonb;
begin
  -- Saved as Off so nothing fires for real while the suite sets it up.
  insert into public.rules (project_id, name, enabled, trigger_type, conditions, actions) values (p, 'Everything', false, 'manual',
    '[{"type": "is_incomplete"}, {"type": "title_contains", "text": "nothing here", "group": 1}]',
    jsonb_build_array(
      jsonb_build_object('type', 'move_section', 'section_id', (select id from av2_ids where name = 'review')),
      jsonb_build_object('type', 'set_field', 'field_id', (select id from av2_ids where name = 'budget'), 'value', 99),
      jsonb_build_object('type', 'set_assignee', 'assignee', 'a2920029-0000-4000-8000-000000000003'),
      jsonb_build_object('type', 'add_comment', 'body', 'Dry {{task.name}}'),
      jsonb_build_object('type', 'add_followers', 'people', '["a2920029-0000-4000-8000-000000000003"]'::jsonb),
      jsonb_build_object('type', 'notify', 'people', '["creator"]'::jsonb, 'message', 'Heads up'),
      jsonb_build_object('type', 'send_email', 'to', 'submitter', 'template', 'custom', 'message', 'Hi'),
      jsonb_build_object('type', 'delay', 'hours', 2),
      jsonb_build_object('type', 'add_tag', 'tag_id', (select id from av2_ids where name = 'tag_big')),
      jsonb_build_object('type', 'create_subtasks', 'titles', '["Dry subtask"]'::jsonb)
    )) returning id into rid;
  insert into av2_ids values ('r_everything', rid);
end $$;

reset role;
delete from av2_before;
insert into av2_before select * from pg_temp.av2_snapshot();
set role authenticated;

do $$
declare
  t uuid := (select id from av2_ids where name = 't_form');
  result jsonb;
begin
  result := public.test_rule((select id from av2_ids where name = 'r_everything'), t);
  assert result ->> 'written' = 'false' and result ->> 'error' is null, format('a clean dry run: %s', result);
  assert (result ->> 'chosen_branch')::integer = 0, 'the branch that would run';
  assert result -> 'branches' -> 0 -> 'conditions' -> 0 ->> 'ok' = 'true'
    and result -> 'branches' -> 0 -> 'conditions' -> 1 ->> 'ok' = 'false', 'each condition says pass / fail (OR groups)';
  assert jsonb_array_length(result -> 'steps') = 10, format('every step is described: %s', result -> 'steps');
  assert result -> 'steps' -> 0 ->> 'result' = 'Moved to “Review”', 'what the move would do';
  assert result -> 'steps' -> 6 ->> 'outcome' = 'would_send' and result -> 'steps' -> 6 ->> 'result' = 'Email to the form submitter',
    'email: described, never queued';
  assert result -> 'steps' -> 7 ->> 'outcome' = 'would_wait', 'the wait is shown';
  assert result -> 'steps' -> 8 ->> 'after_wait' = 'true', 'steps after the wait are marked';
  assert result -> 'steps' -> 3 ->> 'result' like 'Commented: “Dry %', 'placeholders render in the test';

  -- A draft (unsaved changes) is tested instead; a draft for a new rule leaves no rule behind.
  result := public.test_rule(null, t, jsonb_build_object('project_id', (select id from av2_ids where name = 'p'),
    'trigger_type', 'manual', 'conditions', '[{"type": "title_contains", "text": "zzz"}]'::jsonb,
    'actions', '[{"type": "complete_task"}]'::jsonb));
  assert result -> 'chosen_branch' = 'null'::jsonb and result -> 'branches' -> 0 -> 'conditions' -> 0 ->> 'ok' = 'false',
    'conditions that don''t match: nothing would run';
  result := public.test_rule(null, t, jsonb_build_object('project_id', (select id from av2_ids where name = 'p'),
    'trigger_type', 'manual', 'actions', '[{"type": "explode"}]'::jsonb));
  assert result ->> 'invalid' = 'true' and result ->> 'error' like 'Unknown action%', 'an invalid draft is explained';
  result := public.test_rule((select id from av2_ids where name = 'r_everything'), t, jsonb_build_object(
    'actions', jsonb_build_array(jsonb_build_object('type', 'add_to_project', 'project_id', (select id from av2_ids where name = 'q')))));
  assert result ->> 'error' like 'Add to project: you need to be an Editor in that project%', format('the draft is checked like a save: %s', result ->> 'error');
  result := public.test_rule((select id from av2_ids where name = 'r_everything'), t, jsonb_build_object(
    'name', 'Renamed draft', 'actions', '[{"type": "add_comment", "body": "From {{rule.name}}"}]'::jsonb));
  assert result -> 'steps' -> 0 ->> 'result' = 'Commented: “From Renamed draft”', 'the draft''s name is tested too';
end $$;

reset role;
do $$
declare
  diff text;
begin
  select string_agg(b.name, ', ') into diff
  from av2_before b join pg_temp.av2_snapshot() a on a.name = b.name
  where a.n is distinct from b.n or a.digest is distinct from b.digest;
  assert diff is null, format('the dry run changed: %s', diff);
  assert coalesce(current_setting('alhc.rule_dry_run', true), '') = '', 'the dry-run flag doesn''t leak';
end $$;

-- Loop limits: a rule never re-enters itself, rule-caused changes can be ignored, chains stop at 3.
set role authenticated;
do $$
declare
  p uuid := (select id from av2_ids where name = 'p');
  ws uuid := '00000000-0000-4000-8000-000000000001';
  tags uuid[] := '{}';
  tg uuid;
begin
  for i in 1 .. 4 loop
    insert into public.tags (workspace_id, name, color) values (ws, 'av2-chain-' || i, 'zinc') returning id into tg;
    tags := tags || tg;
  end loop;
  insert into av2_ids values ('chain1', tags[1]);
  -- chain: tag 1 → add tag 2 → add tag 3 → add tag 4 → comment (the 4th rule is past the limit)
  for i in 1 .. 4 loop
    insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions) values (p, 'Chain ' || i, true, 'tag_added',
      jsonb_build_object('tag_id', tags[i]),
      case when i < 4 then jsonb_build_array(jsonb_build_object('type', 'add_tag', 'tag_id', tags[i + 1]))
        else '[{"type": "add_comment", "body": "end of chain"}]'::jsonb end);
  end loop;
  insert into public.rules (project_id, name, enabled, trigger_type, conditions, actions) values
    (p, 'Echo', true, 'comment_added', '[{"type": "title_contains", "text": "echo"}]', '[{"type": "add_comment", "body": "echo!"}]');
  insert into public.rules (project_id, name, enabled, trigger_type, conditions, actions, run_on_rule_changes) values
    (p, 'People only', true, 'comment_added', '[{"type": "title_contains", "text": "echo"}]',
      jsonb_build_array(jsonb_build_object('type', 'add_tag', 'tag_id', (select id from av2_ids where name = 'tag_hot'))), false);
  insert into av2_ids values ('t_chain', public.create_task(p, null, 'chain task'));
  insert into av2_ids values ('t_echo', public.create_task(p, null, 'echo task'));
end $$;

do $$
begin
  insert into public.task_tags (task_id, tag_id) values ((select id from av2_ids where name = 't_chain'), (select id from av2_ids where name = 'chain1'));
  insert into public.comments (task_id, body) values ((select id from av2_ids where name = 't_echo'), 'hello');
end $$;

reset role;
do $$
declare
  t uuid := (select id from av2_ids where name = 't_chain');
  e uuid := (select id from av2_ids where name = 't_echo');
begin
  assert (select count(*) from public.task_tags tt join public.tags tg on tg.id = tt.tag_id where tt.task_id = t and tg.name like 'av2-chain-%') = 4,
    'three rules ran in a chain';
  assert exists (select 1 from public.rule_runs rr join public.rules r on r.id = rr.rule_id
    where rr.task_id = t and r.name = 'Chain 4' and rr.status = 'skipped' and rr.detail ->> 'reason' = 'depth_limit'), 'the fourth is past the limit';
  assert not exists (select 1 from public.comments where task_id = t and body = 'end of chain'), 'so it did nothing';
  assert (select count(*) from public.comments where task_id = e and body = 'echo!') = 1, 'Echo answered the person once';
  assert exists (select 1 from public.rule_runs rr join public.rules r on r.id = rr.rule_id
    where rr.task_id = e and r.name = 'Echo' and rr.status = 'skipped' and rr.detail ->> 'reason' = 'loop'), 'and didn''t answer itself';
  assert (select count(*) from public.rule_runs rr join public.rules r on r.id = rr.rule_id where rr.task_id = e and r.name = 'People only') = 1,
    'a rule that ignores rule-caused changes ran for the person''s comment only';

  -- Per-rule rate limit: 1,000 runs in the last hour stop it.
  insert into public.rule_runs (rule_id, task_id, trigger_type, status, detail)
  select (select id from public.rules where name = 'Echo'), null, 'comment_added', 'succeeded', '{}'::jsonb from generate_series(1, 1000);
end $$;

set role authenticated;
do $$
begin
  insert into public.comments (task_id, body) values ((select id from av2_ids where name = 't_echo'), 'again');
end $$;
reset role;
do $$
begin
  assert exists (select 1 from public.rule_runs rr join public.rules r on r.id = rr.rule_id
    where r.name = 'Echo' and rr.status = 'skipped' and rr.detail ->> 'reason' = 'rate_limited'), 'rate limited';
  assert (select count(*) from public.comments where task_id = (select id from av2_ids where name = 't_echo') and body = 'echo!') = 1,
    'no new echo';
end $$;

-- Auto-pause: the kickoff rule keeps failing ("Add to project" into Q, where Ava is now a Viewer). It
-- already failed once; four more make five in a row → paused, and its owner is told.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a2920029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  rid uuid := (select id from av2_ids where name = 'r_kickoff');
  t uuid := (select id from av2_ids where name = 't_kick2');
begin
  for i in 1 .. 3 loop
    assert public.run_manual_rule(rid, t) ->> 'status' = 'failed', 'still failing';
  end loop;
  assert (select enabled from public.rules where id = rid), 'four failures: still on';
  assert public.run_manual_rule(rid, t) ->> 'status' = 'failed', 'the fifth';
  assert not (select enabled from public.rules where id = rid), 'paused';
  assert (select paused_at is not null and consecutive_failures = 5 and pause_reason like 'Add to project%' from public.rules where id = rid),
    'with the reason';
  begin
    perform public.run_manual_rule(rid, t);
    raise exception 'a paused rule must not run';
  exception when check_violation then null;
  end;
  assert (select count(*) from public.rule_run_stats(array[rid]) s where s.last_status = 'failed' and s.failures_7d = 5) = 1,
    'the rules list sees the failures';
end $$;

reset role;
do $$
begin
  assert exists (select 1 from public.inbox_items i where i.recipient_id = 'a2920029-0000-4000-8000-000000000001'
    and i.kind = 'rule' and i.data ->> 'rule_paused' = 'true' and i.data ->> 'rule_id' = (select id from av2_ids where name = 'r_kickoff')::text
    and i.data ->> 'message' like 'Rule “Kickoff” was paused after 5 failed runs in a row%'), 'the owner was told';
end $$;

-- Resume: turning it back on clears the pause.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a2920029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  rid uuid := (select id from av2_ids where name = 'r_kickoff');
begin
  update public.rules set enabled = true where id = rid;
  assert (select enabled and paused_at is null and pause_reason is null and consecutive_failures = 0 from public.rules where id = rid),
    'resumed';
end $$;

reset role;
do $$
begin
  raise notice 'automations v2 smoke: all assertions passed';
end $$;
