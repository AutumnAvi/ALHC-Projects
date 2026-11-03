-- Nov 3 notes, batch 19 (20261103020000_nov3_batch19_a.sql).
--   142 search matches every word; 147 a subtask that blocks its parent; 140 personal workdays for
--       business-day automation steps (core, b1900100…).
--   Automation vocabulary and note 145's approval setup (b1900200…).
--   Engine: "Create a task" lands in the first section; tasks / task_projects in Realtime (b1900300…).
--   148 Timeline Shift+drag plan, preview_dependency_move_along (b1900190…).

\set ON_ERROR_STOP 1

-- ---------------------------------------------------------------------------------------------
-- 142: search matches every word (any order), phrase matches first; one word unchanged.
--   b1900100…11 b19-core-owner@example.com   Cora Owner (owns the search project)
--   b1900100…12 b19-core-out@example.com     Cy Outsider (no membership)
-- ---------------------------------------------------------------------------------------------

create temporary table b19core_ids (name text primary key, id uuid) on commit preserve rows;
grant all on b19core_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('b19-core-owner@example.com', 'batch 19'),
  ('b19-core-out@example.com', 'batch 19');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b1900100-0000-4000-8000-000000000011', 'b19-core-owner@example.com', now(), '{"full_name":"Cora Owner"}'),
  ('b1900100-0000-4000-8000-000000000012', 'b19-core-out@example.com', now(), '{"full_name":"Cy Outsider"}');

do $$
begin
  assert public.search_word_patterns('brochure') = '{}'::text[], 'one word: no word list';
  assert public.search_word_patterns('  zz-video   brochure ') = array['%zz-video%', '%brochure%'], 'two words';
  assert public.search_word_patterns('50% off_x') = array['%50\%%', '%off\_x%'], 'words are escaped';
  assert cardinality(public.search_word_patterns('a b c d e f g h i j')) = 8, 'at most 8 words';
  assert not has_function_privilege('anon', 'public.search_word_patterns(text)', 'execute'), 'nothing for anon';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b1900100-0000-4000-8000-000000000011', false) is not null as ok \gset
do $$
declare
  p uuid;
  s uuid;
  draft uuid;
  exact uuid;
  notes_only uuid;
  other uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B19 Search') returning id into p;
  insert into public.sections (project_id, name) values (p, 'Doing') returning id into s;
  draft := public.create_task(p, s, 'B19 zz-video Draft brochure');
  exact := public.create_task(p, s, 'B19 zz-video brochure final');
  notes_only := public.create_task(p, s, 'B19 Flyer');
  update public.tasks set notes = 'For the zz-video team: a brochure' where id = notes_only;
  other := public.create_task(p, s, 'B19 zz-video poster');
  insert into b19core_ids values ('p', p), ('draft', draft), ('exact', exact), ('notes_only', notes_only), ('other', other);
end $$;

do $$
declare
  found uuid[];
begin
  found := array(select id from public.search_tasks('zz-video brochure', 50));
  assert (select id from b19core_ids where name = 'draft') = any (found), 'words in any position match';
  assert (select id from b19core_ids where name = 'notes_only') = any (found), 'words in the description match';
  assert not (select id from b19core_ids where name = 'other') = any (found), 'a task missing a word does not match';
  assert found[1] = (select id from b19core_ids where name = 'exact'), format('the phrase match sorts first: %s', found);
  found := array(select id from public.search_tasks('BROCHURE draft', 50));
  assert found = array[(select id from b19core_ids where name = 'draft')], 'any order, any case';
  found := array(select id from public.search_tasks('poster', 50));
  assert found = array[(select id from b19core_ids where name = 'other')], 'one word works as before';
end $$;

select set_config('request.jwt.claim.sub', 'b1900100-0000-4000-8000-000000000012', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.search_tasks('zz-video brochure', 50)), 'an outsider finds nothing';
end $$;
reset role;

-- ---------------------------------------------------------------------------------------------
-- 147: a subtask created with "Blocks parent" blocks its parent; an outsider can't.
-- ---------------------------------------------------------------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', 'b1900100-0000-4000-8000-000000000011', false) is not null as ok \gset
do $$
declare
  parent uuid := (select id from b19core_ids where name = 'draft');
  sub uuid;
begin
  sub := public.create_subtask_blocking_parent(parent, 'B19 Proof', null);
  assert (select parent_task_id from public.tasks where id = sub) = parent, 'it is a subtask of the task';
  assert exists (
    select 1 from public.task_dependencies d
    where d.predecessor_id = sub and d.successor_id = parent and d.kind = 'finish_to_start' and d.lag_days = 0 and d.deleted_at is null
  ), 'the subtask blocks its parent';
  assert public.open_blocker_count(parent) = 1, 'the parent is blocked';
  begin
    update public.tasks set completed_at = now() where id = parent;
    assert false, 'a blocked parent cannot be completed';
  exception when check_violation then null;
  end;
  insert into b19core_ids values ('blocking_sub', sub);
end $$;
select set_config('request.jwt.claim.sub', 'b1900100-0000-4000-8000-000000000012', false) is not null as ok \gset
do $$
begin
  begin
    perform public.create_subtask_blocking_parent((select id from b19core_ids where name = 'draft'), 'Nope', null);
    assert false, 'an outsider cannot add a subtask';
  exception when insufficient_privilege or no_data_found or check_violation then null;
  end;
end $$;
reset role;

-- ---------------------------------------------------------------------------------------------
-- 140: business-day steps count the organization's days, or the owner's own.
-- ---------------------------------------------------------------------------------------------
do $$
begin
  assert has_function_privilege('authenticated', 'public.set_my_work_week(smallint[])', 'execute');
  assert not has_function_privilege('anon', 'public.set_my_work_week(smallint[])', 'execute'), 'nothing for anon';
  assert not has_function_privilege('authenticated', 'public.rule_work_days(smallint[], uuid, text, boolean)', 'execute'), 'internal';
  assert not (select prosecdef from pg_proc where oid = 'public.set_my_work_week(smallint[])'::regprocedure), 'invoker';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b1900100-0000-4000-8000-000000000011', false) is not null as ok \gset
do $$
declare
  solo uuid := (select id from b19core_ids where name = 'p');
  shared uuid;
  s uuid;
begin
  assert public.set_my_work_week(array[5, 1, 2, 3, 4, 3]::smallint[]) = array[1, 2, 3, 4, 5]::smallint[], 'cleaned and sorted';
  begin
    perform public.set_my_work_week(array[9]::smallint[]);
    assert false, 'no real day is refused';
  exception when check_violation then null;
  end;
  assert (select work_week from public.profile_preferences where profile_id = auth.uid()) = array[1, 2, 3, 4, 5]::smallint[];

  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B19 Shared') returning id into shared;
  perform public.add_project_member(shared, 'b19-core-out@example.com', 'viewer');
  select id into s from public.sections where project_id = shared limit 1;
  insert into b19core_ids values ('shared', shared);

  insert into public.rules (project_id, name, enabled, trigger_type, actions) values
    (solo, 'B19 solo default', true, 'task_created', '[{"type":"set_due_date","days":1,"business_days":true}]'),
    (shared, 'B19 shared default', true, 'task_created', '[{"type":"set_due_date","days":1,"business_days":true}]');
  begin
    insert into public.rules (project_id, name, trigger_type, actions)
    values (shared, 'B19 bad', 'task_created', '[{"type":"set_due_date","days":1,"business_days":true,"workdays":"mine"}]');
    assert false, 'an unknown workdays choice is refused';
  exception when check_violation then null;
  end;
end $$;

-- One task in each (the task_created automations run at commit).
insert into b19core_ids select 'solo_task', public.create_task((select id from b19core_ids where name = 'p'), null, 'B19 solo task');
insert into b19core_ids select 'shared_task', public.create_task((select id from b19core_ids where name = 'shared'), null, 'B19 shared task');
reset role;

do $$
declare
  today date := (now() at time zone 'UTC')::date;
  org smallint[] := (select work_week from public.workspaces where id = '00000000-0000-4000-8000-000000000001');
begin
  assert (select due_on from public.tasks where id = (select id from b19core_ids where name = 'solo_task')) = public.rule_add_days(today, 1, true, array[1, 2, 3, 4, 5]::smallint[]),
    'a personal project counts its owner''s own days';
  assert (select due_on from public.tasks where id = (select id from b19core_ids where name = 'shared_task')) = public.rule_add_days(today, 1, true, org),
    'a shared project counts the organization''s days';
  assert public.rule_work_days(org, 'b1900100-0000-4000-8000-000000000011', 'personal', false) = array[1, 2, 3, 4, 5]::smallint[];
  assert public.rule_work_days(org, 'b1900100-0000-4000-8000-000000000011', 'org', true) = org;
  assert public.rule_work_days(org, 'b1900100-0000-4000-8000-000000000012', 'personal', false) = org, 'no own days: the organization''s';
end $$;

-- Batch 19, fork A (20_vocab.sql): automation vocabulary and note 145.
--   37.1 assignee_changed { to }      fires only when the task is assigned to someone it names.
--   37.8 task_created { via: import }  fires once per imported task when the import finishes; never
--                                      for tasks people add, and ordinary task_created rules never fire
--                                      for the import.
--   39.3 in_project / not_in_project; 39.4 is_private / is_not_private.
--   145  Set task type → Approval sets the approvers, mode, due date, follow-up, reminders, assignee.
--   b1900200…21 b19a-owner@example.com   Ann Owner (owns P and Q)
--   b1900200…22 b19a-editor@example.com  Ed Editor (Editor of P)
--   b1900200…23 b19a-out@example.com     Oz Outsider (owns R only)

\set ON_ERROR_STOP 1

create temporary table b19a_ids (name text primary key, id uuid) on commit preserve rows;
grant all on b19a_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('b19a-owner@example.com', 'batch 19 A'),
  ('b19a-editor@example.com', 'batch 19 A'),
  ('b19a-out@example.com', 'batch 19 A');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b1900200-0000-4000-8000-000000000021', 'b19a-owner@example.com', now(), '{"full_name":"Ann Owner"}'),
  ('b1900200-0000-4000-8000-000000000022', 'b19a-editor@example.com', now(), '{"full_name":"Ed Editor"}'),
  ('b1900200-0000-4000-8000-000000000023', 'b19a-out@example.com', now(), '{"full_name":"Oz Outsider"}');

do $$
begin
  assert not (select prosecdef from pg_proc where oid = 'public.rule_approval_setup_problem(uuid, jsonb)'::regprocedure),
    'the setup check is invoker';
  assert (select prosecdef from pg_proc where oid = 'public.rule_apply_approval_setup(public.rules, uuid, jsonb, boolean)'::regprocedure),
    'applying the setup is definer';
  assert not has_function_privilege('authenticated', 'public.rule_apply_approval_setup(public.rules, uuid, jsonb, boolean)', 'execute'),
    'clients can''t apply a setup';
  assert not has_function_privilege('anon', 'public.rule_approval_setup_problem(uuid, jsonb)', 'execute'), 'nothing for anon';
  assert pg_get_functiondef('public.fire_rules(text, uuid, uuid, jsonb)'::regprocedure)
    ~ 'if public\.import_context_id\(\) is not null then\s+return;\s+end if;\s+if public\.copy_context_id\(\) is not null then\s+return;',
    'fire_rules keeps its import and copy checks first';
end $$;

-- R is the outsider's: nobody else can name it.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b1900200-0000-4000-8000-000000000023', false) is not null as ok \gset
do $$
declare
  r uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B19A R') returning id into r;
  insert into b19a_ids values ('r', r);
end $$;

select set_config('request.jwt.claim.sub', 'b1900200-0000-4000-8000-000000000021', false) is not null as ok \gset
do $$
declare
  p uuid;
  q uuid;
  s uuid;
  s2 uuid;
  qs uuid;
  a uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B19A P') returning id into p;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B19A Q') returning id into q;
  perform public.add_project_member(p, 'b19a-editor@example.com', 'editor');
  insert into public.sections (project_id, name) values (p, 'Doing') returning id into s;
  insert into public.sections (project_id, name) values (p, 'Approved') returning id into s2;
  insert into public.sections (project_id, name) values (q, 'Q doing') returning id into qs;
  a := public.create_task(p, s, 'B19A A');
  insert into b19a_ids values ('p', p), ('q', q), ('s', s), ('s2', s2), ('qs', qs), ('a', a);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Validation
-- ---------------------------------------------------------------------------------------------

do $$
declare
  p uuid := (select id from b19a_ids where name = 'p');
  r uuid := (select id from b19a_ids where name = 'r');
  s2 uuid := (select id from b19a_ids where name = 's2');
  ok boolean;
begin
  -- 37.1
  insert into public.rules (project_id, name, trigger_type, trigger_config, actions)
  values (p, 'B19A to', 'assignee_changed', '{"to":["b1900200-0000-4000-8000-000000000022"]}', '[{"type":"complete_task"}]');
  begin
    insert into public.rules (project_id, name, trigger_type, trigger_config, actions)
    values (p, 'B19A to empty', 'assignee_changed', '{"to":[]}', '[{"type":"complete_task"}]');
    ok := false;
  exception when check_violation then ok := true;
  end;
  assert ok, 'Task assigned to needs someone';
  begin
    insert into public.rules (project_id, name, trigger_type, trigger_config, actions)
    values (p, 'B19A to nobody', 'assignee_changed', '{"to":["b1900200-0000-4000-8000-0000000000ff"]}', '[{"type":"complete_task"}]');
    ok := false;
  exception when check_violation then ok := true;
  end;
  assert ok, 'Task assigned to: only real people';
  -- 37.8
  begin
    insert into public.rules (project_id, name, trigger_type, trigger_config, actions)
    values (p, 'B19A via form', 'task_created', '{"via":"form"}', '[{"type":"complete_task"}]');
    ok := false;
  exception when check_violation then ok := true;
  end;
  assert ok, 'task_created: only via = import';
  -- 39.3: a project the person saving can''t open is refused.
  begin
    insert into public.rules (project_id, name, trigger_type, conditions, actions)
    values (p, 'B19A in R', 'manual', jsonb_build_array(jsonb_build_object('type', 'in_project', 'project_ids', jsonb_build_array(r))),
      '[{"type":"complete_task"}]');
    ok := false;
  exception when check_violation then ok := true;
  end;
  assert ok, 'In project: only projects the saver can open';
  begin
    insert into public.rules (project_id, name, trigger_type, conditions, actions)
    values (p, 'B19A in none', 'manual', '[{"type":"in_project","project_ids":[]}]', '[{"type":"complete_task"}]');
    ok := false;
  exception when check_violation then ok := true;
  end;
  assert ok, 'In project: pick at least one';
  -- 145
  begin
    insert into public.rules (project_id, name, trigger_type, actions)
    values (p, 'B19A approvers on a milestone', 'manual',
      '[{"type":"set_task_type","kind":"milestone","approvers":["b1900200-0000-4000-8000-000000000022"]}]');
    ok := false;
  exception when check_violation then ok := true;
  end;
  assert ok, 'approvers only go with Approval';
  begin
    insert into public.rules (project_id, name, trigger_type, actions)
    values (p, 'B19A move without section', 'manual', '[{"type":"set_task_type","kind":"approval","after_approval":"move_section"}]');
    ok := false;
  exception when check_violation then ok := true;
  end;
  assert ok, 'moving after approval needs a section';
  begin
    insert into public.rules (project_id, name, trigger_type, actions)
    values (p, 'B19A bad mode', 'manual', '[{"type":"set_task_type","kind":"approval","approval_mode":"most"}]');
    ok := false;
  exception when check_violation then ok := true;
  end;
  assert ok, 'any or all';
  insert into public.rules (project_id, name, trigger_type, actions)
  values (p, 'B19A full setup', 'manual', jsonb_build_array(jsonb_build_object(
    'type', 'set_task_type', 'kind', 'approval', 'approvers', jsonb_build_array('b1900200-0000-4000-8000-000000000022'),
    'approval_mode', 'all', 'approval_due_days', 3, 'after_approval', 'move_section', 'after_section_id', s2,
    'reminders', false, 'assignee', 'b1900200-0000-4000-8000-000000000021')));
end $$;

-- ---------------------------------------------------------------------------------------------
-- 37.1: assigned to the person named
-- ---------------------------------------------------------------------------------------------

do $$
declare
  p uuid := (select id from b19a_ids where name = 'p');
  s uuid := (select id from b19a_ids where name = 's');
  t uuid;
begin
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions)
  values (p, 'B19A assigned to Ed', true, 'assignee_changed', '{"to":["b1900200-0000-4000-8000-000000000022"]}',
    '[{"type":"add_comment","body":"assigned to Ed"}]');
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values (p, 'B19A any assignee', true, 'assignee_changed', '[{"type":"add_comment","body":"assignee changed"}]');
  t := public.create_task(p, s, 'B19A assign me');
  insert into b19a_ids values ('t_assign', t);
  update public.tasks set assignee_id = 'b1900200-0000-4000-8000-000000000021' where id = t;
  assert (select count(*) from public.comments where task_id = t and body = 'assigned to Ed') = 0, 'not for Ann';
  assert (select count(*) from public.comments where task_id = t and body = 'assignee changed') = 1, 'any change still fires';
  update public.tasks set assignee_id = 'b1900200-0000-4000-8000-000000000022' where id = t;
  assert (select count(*) from public.comments where task_id = t and body = 'assigned to Ed') = 1, 'for Ed';
  assert (select count(*) from public.comments where task_id = t and body = 'assignee changed') = 2, 'both fire for Ed';
  update public.tasks set assignee_id = null where id = t;
  assert (select count(*) from public.comments where task_id = t and body = 'assigned to Ed') = 1, 'not when unassigned';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 37.8: imports
-- ---------------------------------------------------------------------------------------------

do $$
declare
  p uuid := (select id from b19a_ids where name = 'p');
  s uuid := (select id from b19a_ids where name = 's');
  t uuid;
  run uuid;
begin
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions)
  values (p, 'B19A imported', true, 'task_created', '{"via":"import"}', '[{"type":"add_comment","body":"came from an import"}]');
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values (p, 'B19A added', true, 'task_created', '[{"type":"add_comment","body":"added here"}]');
  t := public.create_task(p, s, 'B19A typed by hand');
  insert into b19a_ids values ('t_hand', t);
  run := public.start_import_run(p, 'asana', array['b19a.json']);
  insert into b19a_ids values ('run', run);
end $$;
-- The deferred task_created trigger runs at commit: check after it.
do $$
declare
  t uuid := (select id from b19a_ids where name = 't_hand');
begin
  assert (select count(*) from public.comments where task_id = t and body = 'added here') = 1, 'a person''s task fires task_created';
  assert (select count(*) from public.comments where task_id = t and body = 'came from an import') = 0, 'not the import rule';
end $$;

-- An "imported" task: in the real importer import_batch writes these rows (muted); here by hand.
reset role;
do $$
declare
  p uuid := (select id from b19a_ids where name = 'p');
  s uuid := (select id from b19a_ids where name = 's');
  run uuid := (select id from b19a_ids where name = 'run');
  t uuid;
begin
  perform set_config('request.jwt.claim.sub', 'b1900200-0000-4000-8000-000000000021', true);
  perform set_config('alhc.import_run_id', run::text, true);
  t := public.create_task(p, s, 'B19A imported task');
  insert into public.import_external_ids (project_id, source, kind, external_id, local_id, run_id)
  values (p, 'asana', 'task', 'b19a-gid-1', t, run);
  insert into b19a_ids values ('t_imported', t);
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub', 'b1900200-0000-4000-8000-000000000021', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b19a_ids where name = 't_imported');
begin
  assert (select count(*) from public.comments where task_id = t) = 0, 'nothing fires inside the import';
  perform public.finish_import_run((select id from b19a_ids where name = 'run'), 'completed', '{}');
  assert (select count(*) from public.comments where task_id = t and body = 'came from an import') = 1, 'the import rule ran once';
  assert (select count(*) from public.comments where task_id = t and body = 'added here') = 0, 'ordinary task_created rules stay quiet';
  perform public.finish_import_run((select id from b19a_ids where name = 'run'), 'completed', '{}');
  assert (select count(*) from public.comments where task_id = t and body = 'came from an import') = 1, 'finishing again changes nothing';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 39.3 / 39.4: in project, private
-- ---------------------------------------------------------------------------------------------

do $$
declare
  p uuid := (select id from b19a_ids where name = 'p');
  q uuid := (select id from b19a_ids where name = 'q');
  s uuid := (select id from b19a_ids where name = 's');
  qs uuid := (select id from b19a_ids where name = 'qs');
  both_t uuid;
  only_t uuid;
  sub uuid;
  r_in uuid;
  r_out uuid;
  r_priv uuid;
  r_pub uuid;
begin
  both_t := public.create_task(p, s, 'B19A in both');
  only_t := public.create_task(p, s, 'B19A only P');
  insert into public.task_projects (task_id, project_id, section_id) values (both_t, q, qs);
  sub := public.create_subtask(both_t, 'B19A sub of both', null);
  insert into public.rules (project_id, name, enabled, trigger_type, conditions, actions)
  values (p, 'B19A in Q', true, 'manual', jsonb_build_array(jsonb_build_object('type', 'in_project', 'project_ids', jsonb_build_array(q))),
    '[{"type":"add_comment","body":"in Q"}]') returning id into r_in;
  insert into public.rules (project_id, name, enabled, trigger_type, conditions, actions)
  values (p, 'B19A not in Q', true, 'manual', jsonb_build_array(jsonb_build_object('type', 'not_in_project', 'project_ids', jsonb_build_array(q))),
    '[{"type":"add_comment","body":"not in Q"}]') returning id into r_out;
  insert into public.rules (project_id, name, enabled, trigger_type, conditions, actions)
  values (p, 'B19A private', true, 'manual', '[{"type":"is_private"}]', '[{"type":"add_comment","body":"private"}]') returning id into r_priv;
  insert into public.rules (project_id, name, enabled, trigger_type, conditions, actions)
  values (p, 'B19A public', true, 'manual', '[{"type":"is_not_private"}]', '[{"type":"add_comment","body":"public"}]') returning id into r_pub;
  insert into b19a_ids values ('both', both_t), ('only', only_t), ('r_in', r_in), ('r_out', r_out), ('r_priv', r_priv), ('r_pub', r_pub);

  perform public.run_manual_rule(r_in, both_t);
  perform public.run_manual_rule(r_in, only_t);
  perform public.run_manual_rule(r_out, both_t);
  perform public.run_manual_rule(r_out, only_t);
  assert (select count(*) from public.comments where task_id = both_t and body = 'in Q') = 1, 'in Q';
  assert (select count(*) from public.comments where task_id = only_t and body = 'in Q') = 0, 'only P is not in Q';
  assert (select count(*) from public.comments where task_id = both_t and body = 'not in Q') = 0, 'both is in Q';
  assert (select count(*) from public.comments where task_id = only_t and body = 'not in Q') = 1, 'only P isn''t';
  insert into b19a_ids values ('sub', sub);

  -- Both projects are private (the default): every task is private.
  perform public.run_manual_rule(r_priv, both_t);
  perform public.run_manual_rule(r_pub, both_t);
  assert (select count(*) from public.comments where task_id = both_t and body = 'private') = 1, 'private while every project is private';
  assert (select count(*) from public.comments where task_id = both_t and body = 'public') = 0;
end $$;
reset role;
do $$
begin
  assert public.rule_condition_ok((select x from public.rules x where x.id = (select id from b19a_ids where name = 'r_in')),
    jsonb_build_object('type', 'in_project', 'project_ids', jsonb_build_array((select id from b19a_ids where name = 'q'))),
    (select x from public.tasks x where x.id = (select id from b19a_ids where name = 'sub')), null),
    'a subtask is in its top-level task''s projects';
end $$;
update public.projects set visibility = 'team' where id = (select id from b19a_ids where name = 'q');
set role authenticated;
select set_config('request.jwt.claim.sub', 'b1900200-0000-4000-8000-000000000021', false) is not null as ok \gset
do $$
declare
  both_t uuid := (select id from b19a_ids where name = 'both');
  only_t uuid := (select id from b19a_ids where name = 'only');
begin
  perform public.run_manual_rule((select id from b19a_ids where name = 'r_pub'), both_t);
  perform public.run_manual_rule((select id from b19a_ids where name = 'r_priv'), only_t);
  assert (select count(*) from public.comments where task_id = both_t and body = 'public') = 1, 'public once a project is public to its team';
  assert (select count(*) from public.comments where task_id = only_t and body = 'private') = 1, 'only P stays private';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 145: Set task type → Approval with its setup
-- ---------------------------------------------------------------------------------------------

do $$
declare
  p uuid := (select id from b19a_ids where name = 'p');
  s uuid := (select id from b19a_ids where name = 's');
  s2 uuid := (select id from b19a_ids where name = 's2');
  r uuid := (select id from public.rules where name = 'B19A full setup');
  t uuid;
  st public.task_approval_settings;
  log jsonb;
begin
  update public.rules set enabled = true where id = r;
  t := public.create_task(p, s, 'B19A make an approval');
  perform public.run_manual_rule(r, t);
  assert (select kind from public.tasks where id = t) = 'approval', 'it is an approval';
  assert (select assignee_id from public.tasks where id = t) = 'b1900200-0000-4000-8000-000000000021', 'assigned to the doer';
  assert (select array_agg(profile_id) from public.task_approvers where task_id = t and deleted_at is null)
    = array['b1900200-0000-4000-8000-000000000022'::uuid], 'Ed approves';
  select * into st from public.task_approval_settings where task_id = t;
  assert st.mode = 'all', 'everyone must approve';
  assert st.after_approval = 'move_section' and st.after_section_id = s2, 'then moves to Approved';
  assert st.reminders = false, 'no reminders';
  assert st.due_on = (now() at time zone 'UTC')::date + 3, format('due in three days: %s', st.due_on);
  select detail into log from public.rule_runs where rule_id = r and task_id = t order by created_at desc limit 1;
  assert log::text like '%approvers Ed Editor%', format('the log names the approvers: %s', log);

  insert into b19a_ids values ('t_approval', t);
end $$;

-- Running it again on the set-up approval task changes nothing.
reset role;
update public.task_approval_settings set mode = 'any' where task_id = (select id from b19a_ids where name = 't_approval');
set role authenticated;
select set_config('request.jwt.claim.sub', 'b1900200-0000-4000-8000-000000000021', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b19a_ids where name = 't_approval');
begin
  perform public.run_manual_rule((select id from public.rules where name = 'B19A full setup'), t);
  assert (select mode from public.task_approval_settings where task_id = t) = 'any', 'a set-up approval keeps its setup';
end $$;

reset role;

-- ---------------------------------------------------------------------------------------------
-- Engine (fork B): 40.5 "Create a task" with no section picked lands in the project's first section;
-- 23.5 tasks and task_projects are in Realtime (where the publication exists).
--   b1900300…01 b19b-owner@example.com  Bea Owner (owns P)
-- ---------------------------------------------------------------------------------------------

create temporary table b19b_ids (name text primary key, id uuid) on commit preserve rows;
grant all on b19b_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values ('b19b-owner@example.com', 'batch 19 engine');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b1900300-0000-4000-8000-000000000001', 'b19b-owner@example.com', now(), '{"full_name":"Bea Owner"}');

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    assert exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'tasks'),
      'tasks is in Realtime';
    assert exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'task_projects'),
      'task_projects is in Realtime';
  end if;
  assert not has_function_privilege('authenticated', 'public.execute_rule_actions(public.rules, uuid, jsonb, jsonb)', 'execute'),
    'the engine stays internal';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b1900300-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  p uuid;
  s uuid;
  n text;
  i integer := 0;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B19 Engine')
    returning id into p;
  insert into b19b_ids values ('p', p);
  foreach n in array array['To do', 'Doing', 'Done'] loop
    i := i + 1;
    insert into public.sections (project_id, name, sort_order) values (p, n, i * 1024) returning id into s;
    insert into b19b_ids values (n, s);
  end loop;
  insert into b19b_ids values ('t', public.create_task(p, (select id from b19b_ids where name = 'Doing'), 'Trigger task'));
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions) values
    (p, 'Follow-up anywhere', true, 'manual', '{}', '[{"type": "create_task", "kind": "task", "title": "B19 follow-up"}]'),
    (p, 'Follow-up in Done', true, 'manual', '{}',
      jsonb_build_array(jsonb_build_object('type', 'create_task', 'kind', 'task', 'title', 'B19 follow-up done',
        'section_id', (select id from b19b_ids where name = 'Done'))));
end $$;

select public.run_manual_rule((select id from public.rules where name = 'Follow-up anywhere' and project_id = (select id from b19b_ids where name = 'p')),
  (select id from b19b_ids where name = 't')) ->> 'status' = 'succeeded' as ran \gset
select public.run_manual_rule((select id from public.rules where name = 'Follow-up in Done' and project_id = (select id from b19b_ids where name = 'p')),
  (select id from b19b_ids where name = 't')) ->> 'status' = 'succeeded' as ran2 \gset

reset role;
do $$
declare
  p uuid := (select id from b19b_ids where name = 'p');
begin
  assert (select tp.section_id from public.task_projects tp join public.tasks t on t.id = tp.task_id
          where t.title = 'B19 follow-up' and tp.project_id = p and tp.deleted_at is null)
         = (select id from b19b_ids where name = 'To do'),
    '40.5: no section picked = the project''s first section, not "No section"';
  assert (select tp.section_id from public.task_projects tp join public.tasks t on t.id = tp.task_id
          where t.title = 'B19 follow-up done' and tp.project_id = p and tp.deleted_at is null)
         = (select id from b19b_ids where name = 'Done'),
    '40.5: a picked section is kept';
  assert (select count(*) from public.rule_runs rr join public.rules r on r.id = rr.rule_id
          where r.project_id = p and rr.status = 'succeeded') = 2, 'both runs succeeded and are logged';
end $$;

-- 148 Timeline drags: Shift moves dependents along by the same amount (preview_dependency_move_along), a plain
--     drag moves only the task (apply_dependency_shifts with nothing confirmed), Alt pushes as needed
--     (preview_dependency_shifts without pulling). The vectors are tests/unit/nov3-batch19-timeline.test.ts's.
--   b1900190…d1 b19d-owner@example.com   Ona Owner (owns P)
--   b1900190…d2 b19d-viewer@example.com  Vi Viewer (Viewer of P)

\set ON_ERROR_STOP 1

create temporary table b19d_ids (name text primary key, id uuid) on commit preserve rows;
grant all on b19d_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('b19d-owner@example.com', 'batch 19'),
  ('b19d-viewer@example.com', 'batch 19');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b1900190-0000-4000-8000-0000000000d1', 'b19d-owner@example.com', now(), '{"full_name":"Ona Owner"}'),
  ('b1900190-0000-4000-8000-0000000000d2', 'b19d-viewer@example.com', now(), '{"full_name":"Vi Viewer"}');

do $$
begin
  assert not (select prosecdef from pg_proc where oid = 'public.preview_dependency_move_along(jsonb)'::regprocedure),
    'the along plan is invoker';
  assert has_function_privilege('authenticated', 'public.preview_dependency_move_along(jsonb)', 'execute');
  assert not has_function_privilege('anon', 'public.preview_dependency_move_along(jsonb)', 'execute'), 'nothing for anon';
end $$;

-- The batch 16 chain: A (Sun 11-01 – Tue 11-03) → B (Wed 11-04 – Thu 11-05) → C (Thu 11-05);
-- A → D start-to-start +1; A → E (completed); A → H finish-to-start +2.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b1900190-0000-4000-8000-0000000000d1', false) is not null as ok \gset
do $$
declare
  p uuid;
  s uuid;
  a uuid; b uuid; c uuid; d uuid; e uuid; h uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B19 Timeline') returning id into p;
  perform public.add_project_member(p, 'b19d-viewer@example.com', 'viewer');
  insert into public.sections (project_id, name) values (p, 'Doing') returning id into s;
  a := public.create_task(p, s, 'A');
  b := public.create_task(p, s, 'B');
  c := public.create_task(p, s, 'C');
  d := public.create_task(p, s, 'D');
  e := public.create_task(p, s, 'E');
  h := public.create_task(p, s, 'H');
  update public.tasks set start_on = '2026-11-01', due_on = '2026-11-03' where id = a;
  update public.tasks set start_on = '2026-11-04', due_on = '2026-11-05' where id = b;
  update public.tasks set start_on = '2026-11-05', due_on = '2026-11-05' where id = c;
  update public.tasks set start_on = '2026-11-04', due_on = '2026-11-04' where id in (d, e, h);
  update public.tasks set completed_at = now() where id = e;
  perform public.set_task_dependency(a, b, 'finish_to_start', 0);
  perform public.set_task_dependency(b, c, 'finish_to_start', 0);
  perform public.set_task_dependency(a, d, 'start_to_start', 1);
  perform public.set_task_dependency(a, e, 'finish_to_start', 0);
  perform public.set_task_dependency(a, h, 'finish_to_start', 2);
  insert into b19d_ids values ('p', p), ('a', a), ('b', b), ('c', c), ('d', d), ('e', e), ('h', h);
end $$;

create function pg_temp.b19d_along(moves jsonb) returns text[] language sql as $$
  select coalesce(array_agg(x order by x), '{}') from (
    select n.name || ' ' || p.status || ' ' || coalesce(p.new_start::text, '-') || ' ' || coalesce(p.new_due::text, '-') || ' ' || p.shift_days as x
    from public.preview_dependency_move_along(moves) p
    join b19d_ids n on n.id = p.task_id
  ) q;
$$;

do $$
declare
  a uuid := (select id from b19d_ids where name = 'a');
  plan text[];
begin
  plan := pg_temp.b19d_along(jsonb_build_array(jsonb_build_object('task_id', a, 'start_on', '2026-11-08', 'due_on', '2026-11-10')));
  assert plan = array[
    'b move 2026-11-11 2026-11-12 7',
    'c move 2026-11-12 2026-11-12 7',
    'd move 2026-11-11 2026-11-11 7',
    'e skipped 2026-11-04 2026-11-04 7',
    'h move 2026-11-12 2026-11-12 8'
  ], format('a week later: the whole chain moves a week: %s', plan);

  plan := pg_temp.b19d_along(jsonb_build_array(jsonb_build_object('task_id', a, 'due_on', '2026-11-05')));
  assert plan = array[
    'b move 2026-11-08 2026-11-09 4',
    'c move 2026-11-09 2026-11-09 4',
    'e skipped 2026-11-04 2026-11-04 4',
    'h move 2026-11-09 2026-11-09 5'
  ], format('the end two workdays later: what waits on the end moves two workdays: %s', plan);

  plan := pg_temp.b19d_along(jsonb_build_array(jsonb_build_object('task_id', a, 'due_on', '2026-11-02')));
  assert plan = array[
    'b move 2026-11-03 2026-11-04 -1',
    'c move 2026-11-04 2026-11-04 -1',
    'e skipped 2026-11-04 2026-11-04 -1'
  ], format('earlier: pulled along, never before a link allows: %s', plan);
end $$;

-- Shift + drag applies as explicit moves (nothing confirmed): exactly the planned tasks move; Undo restores.
do $$
declare
  a uuid := (select id from b19d_ids where name = 'a');
  b uuid := (select id from b19d_ids where name = 'b');
  c uuid := (select id from b19d_ids where name = 'c');
  d uuid := (select id from b19d_ids where name = 'd');
  e uuid := (select id from b19d_ids where name = 'e');
  root jsonb := jsonb_build_object('task_id', a, 'start_on', '2026-11-08', 'due_on', '2026-11-10');
  moves jsonb;
  result jsonb;
  undone jsonb;
begin
  select jsonb_build_array(root) || coalesce(jsonb_agg(jsonb_build_object('task_id', p.task_id, 'start_on', p.new_start, 'due_on', p.new_due)), '[]')
  into moves
  from public.preview_dependency_move_along(jsonb_build_array(root)) p where p.status = 'move';
  result := public.apply_dependency_shifts(moves, '{}', false);
  assert jsonb_array_length(result -> 'changes') = 5, format('the task and four dependents: %s', result);
  assert (select (start_on, due_on) from public.tasks where id = b) = ('2026-11-11'::date, '2026-11-12'::date), 'B moved a week';
  assert (select (start_on, due_on) from public.tasks where id = c) = ('2026-11-12'::date, '2026-11-12'::date), 'C moved a week';
  assert (select (start_on, due_on) from public.tasks where id = d) = ('2026-11-11'::date, '2026-11-11'::date), 'D moved a week';
  assert (select start_on from public.tasks where id = e) = '2026-11-04', 'completed tasks stay';
  undone := public.undo_dependency_shift(result -> 'changes');
  assert jsonb_array_length(undone -> 'restored') = 5, format('Undo restores them: %s', undone);
  assert (select (start_on, due_on) from public.tasks where id = a) = ('2026-11-01'::date, '2026-11-03'::date), 'A is back';

  -- A plain drag: only the task moves, whatever its dependents.
  result := public.apply_dependency_shifts(jsonb_build_array(root), '{}', false);
  assert (select jsonb_agg(x ->> 'task_id') from jsonb_array_elements(result -> 'changes') x) = jsonb_build_array(a::text),
    format('only the dragged task: %s', result);
  assert (select start_on from public.tasks where id = b) = '2026-11-04', 'B stays';
  perform public.undo_dependency_shift(result -> 'changes');
end $$;

-- A Viewer's along plan lists the dependents as ones they can't edit.
select set_config('request.jwt.claim.sub', 'b1900190-0000-4000-8000-0000000000d2', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b19d_ids where name = 'a');
  plan text[];
begin
  plan := pg_temp.b19d_along(jsonb_build_array(jsonb_build_object('task_id', a, 'start_on', '2026-11-08', 'due_on', '2026-11-10')));
  assert 'b skipped 2026-11-04 2026-11-05 7' = any (plan), format('read-only dependents are listed: %s', plan);
  assert not exists (select 1 from unnest(plan) x where x like '% move %'), format('a Viewer moves nothing: %s', plan);
end $$;

reset role;

