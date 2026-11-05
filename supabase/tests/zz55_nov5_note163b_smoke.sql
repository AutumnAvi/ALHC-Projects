-- Nov 5 note 163b (20261105020000_nov5_note163b_a.sql): automations never complete a blocked task.
--   a3100163…01 n163-owner@example.com  Nu Owner (owns P)

\set ON_ERROR_STOP 1

create temporary table n163_ids (name text primary key, id uuid) on commit preserve rows;
grant all on n163_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values ('n163-owner@example.com', 'note 163');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a3100163-0000-4000-8000-000000000001', 'n163-owner@example.com', now(), '{"full_name":"Nu Owner"}');

do $$
begin
  assert not has_function_privilege('authenticated', 'public.task_blocker_total(uuid)', 'execute'), 'task_blocker_total is internal';
  assert not has_function_privilege('anon', 'public.task_blocker_total(uuid)', 'execute'), 'anon: no task_blocker_total';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100163-0000-4000-8000-000000000001', false) is not null as ok \gset

-- P: Start, Done. A blocks B (finish-to-start); D blocks C. Rules: manual "Finish" (complete + comment),
-- "Done → complete" (section_changed), "Wrap up" (manual, convert to a project and complete).
do $$
declare
  p uuid;
  s_start uuid;
  s_done uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'N163 Blocked')
    returning id into p;
  insert into public.sections (project_id, name) values (p, 'Start') returning id into s_start;
  insert into public.sections (project_id, name) values (p, 'Done') returning id into s_done;
  insert into n163_ids values ('p', p), ('start', s_start), ('done', s_done);
  insert into n163_ids values ('a', public.create_task(p, s_start, 'N163 blocker'));
  insert into n163_ids values ('b', public.create_task(p, s_start, 'N163 blocked'));
  insert into n163_ids values ('c', public.create_task(p, s_start, 'N163 my task'));
  insert into n163_ids values ('d', public.create_task(p, s_start, 'N163 my blocker'));
  perform public.set_task_dependency((select id from n163_ids where name = 'a'), (select id from n163_ids where name = 'b'), 'finish_to_start', 0);
  perform public.set_task_dependency((select id from n163_ids where name = 'd'), (select id from n163_ids where name = 'c'), 'finish_to_start', 0);
  insert into public.rules (project_id, name, enabled, trigger_type, actions) values
    (p, 'N163 Finish', true, 'manual', '[{"type":"complete_task"},{"type":"add_comment","body":"finish ran"}]')
    returning id into s_start;
  insert into n163_ids values ('manual', s_start);
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions) values
    (p, 'N163 Done', true, 'section_changed', jsonb_build_object('section_id', s_done), '[{"type":"complete_task"}]');
  insert into public.rules (project_id, name, enabled, trigger_type, actions) values
    (p, 'N163 Wrap up', true, 'manual', '[{"type":"convert_to_project","name":"N163 converted","brief":false,"complete_task":true}]')
    returning id into s_start;
  insert into n163_ids values ('convert', s_start);
end $$;

-- 1. Avi's case: run "Mark complete" by hand on a blocked task.
do $$
declare
  ran jsonb := public.run_manual_rule((select id from n163_ids where name = 'manual'), (select id from n163_ids where name = 'b'));
begin
  assert ran ->> 'status' = 'succeeded', 'the run goes on: ' || ran::text;
  assert ran -> 'detail' -> 'actions' -> 0 ->> 'outcome' = 'blocked', 'Mark complete is logged as blocked: ' || ran::text;
  assert ran -> 'detail' -> 'actions' -> 0 ->> 'result' = 'Not completed: blocked by 1 task that isn’t done', ran::text;
  assert ran -> 'detail' -> 'actions' -> 1 ->> 'outcome' = 'done', 'the next step still runs';
  assert (select completed_at from public.tasks where id = (select id from n163_ids where name = 'b')) is null, 'B stays open (manual run)';
  assert exists (select 1 from public.comments where task_id = (select id from n163_ids where name = 'b') and body = 'finish ran'), 'comment posted';
end $$;

-- 1b. Convert to a project … and complete the task: the project is made, the blocked task stays open.
do $$
declare
  ran jsonb := public.run_manual_rule((select id from n163_ids where name = 'convert'), (select id from n163_ids where name = 'b'));
begin
  assert ran ->> 'status' = 'succeeded', 'the convert run goes on: ' || ran::text;
  assert ran -> 'detail' -> 'actions' -> 0 ->> 'outcome' = 'blocked', 'Convert logged as blocked: ' || ran::text;
  assert ran -> 'detail' -> 'actions' -> 0 ->> 'result' like '%it’s blocked by tasks that aren’t done%', ran::text;
  assert exists (select 1 from public.projects where name = 'N163 converted' and deleted_at is null), 'the project is still made';
  assert (select completed_at from public.tasks where id = (select id from n163_ids where name = 'b')) is null, 'B stays open (convert)';
end $$;

-- 2. The same through a trigger: moving B into Done fires "Done → complete".
select public.place_task((select id from n163_ids where name = 'b'), (select id from n163_ids where name = 'p'),
  (select id from n163_ids where name = 'done'), null) is not null as ok \gset

reset role;
do $$
declare
  run public.rule_runs;
begin
  assert (select completed_at from public.tasks where id = (select id from n163_ids where name = 'b')) is null, 'B stays open (triggered)';
  select rr.* into run from public.rule_runs rr join public.rules r on r.id = rr.rule_id
  where r.name = 'N163 Done' and rr.task_id = (select id from n163_ids where name = 'b')
  order by rr.created_at desc limit 1;
  assert run.status = 'succeeded', 'triggered run logged: ' || coalesce(run.status, 'none');
  assert run.detail -> 'actions' -> 0 ->> 'outcome' = 'blocked', 'triggered step blocked: ' || run.detail::text;
end $$;

-- 3. Backstop: any completion while an automation runs (also with nobody as the caller, like the
--    scheduler) is refused for a blocked task.
do $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('alhc.rule_id', (select id from n163_ids where name = 'manual')::text, true);
  begin
    update public.tasks set completed_at = now() where id = (select id from n163_ids where name = 'b');
    assert false, 'the guard refuses a rule completing a blocked task';
  exception when check_violation then null;
  end;
  perform set_config('alhc.rule_id', '', true);
  -- Outside an automation, system code is still not checked here (e.g. an approved round).
end $$;

-- 4. Once the blocker is done, the same automation completes B.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100163-0000-4000-8000-000000000001', false) is not null as ok \gset
update public.tasks set completed_at = now() where id = (select id from n163_ids where name = 'a');
do $$
declare
  ran jsonb := public.run_manual_rule((select id from n163_ids where name = 'manual'), (select id from n163_ids where name = 'b'));
begin
  assert ran -> 'detail' -> 'actions' -> 0 ->> 'outcome' = 'done', 'unblocked: completed ' || ran::text;
  assert (select completed_at from public.tasks where id = (select id from n163_ids where name = 'b')) is not null, 'B complete';
end $$;

-- 5. My Tasks automation: "assigned to me → Mark complete" skips a blocked task instead of failing.
insert into public.my_task_rules (name, trigger_type, actions) values ('N163 mine', 'assigned', '[{"type":"complete_task"}]');
update public.tasks set assignee_id = 'a3100163-0000-4000-8000-000000000001' where id = (select id from n163_ids where name = 'c');

reset role;
do $$
declare
  run public.my_task_rule_runs;
begin
  assert (select completed_at from public.tasks where id = (select id from n163_ids where name = 'c')) is null, 'C stays open (My Tasks)';
  select rr.* into run from public.my_task_rule_runs rr join public.my_task_rules r on r.id = rr.rule_id
  where r.name = 'N163 mine' and rr.task_id = (select id from n163_ids where name = 'c')
  order by rr.created_at desc limit 1;
  assert run.status = 'succeeded', 'My Tasks run succeeds (no failure): ' || coalesce(run.status, 'none');
  assert run.detail -> 'actions' -> 0 ->> 'outcome' = 'blocked', 'My Tasks step blocked: ' || run.detail::text;
end $$;

-- 6. People are still refused by the guard as before.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100163-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  update public.tasks set completed_at = now() where id = (select id from n163_ids where name = 'c');
  assert false, 'a person cannot complete a blocked task';
exception when check_violation then null;
end $$;
reset role;

select 'zz55_nov5_note163b_smoke: ok';
