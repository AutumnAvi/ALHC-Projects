-- AI builder round 2 (20261108140817_ai_builder_round2_a.sql), experimental branch feat/ai-builder-p2.
-- Runs after zz56 (which cleaned its own pilot up), so it sets up a fresh pilot with a new marker.
--   a3100157…01 aib2-admin@example.com  Aib Admin  (a main-workspace admin: runs the pilot)
--   a3100157…02 aib2-mate@example.com   Aib Mate   (on the pilot's team: may be assigned)
--   a3100157…03 aib2-out@example.com    Aib Out    (main workspace only: an outsider to the pilot)

\set ON_ERROR_STOP 1

create temporary table aib2_ids (name text primary key, id uuid) on commit preserve rows;
grant all on aib2_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('aib2-admin@example.com', 'ai builder 2'), ('aib2-mate@example.com', 'ai builder 2'), ('aib2-out@example.com', 'ai builder 2');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a3100157-0000-4000-8000-000000000001', 'aib2-admin@example.com', now(), '{"full_name":"Aib Admin"}'),
  ('a3100157-0000-4000-8000-000000000002', 'aib2-mate@example.com', now(), '{"full_name":"Aib Mate"}'),
  ('a3100157-0000-4000-8000-000000000003', 'aib2-out@example.com', now(), '{"full_name":"Aib Out"}');
insert into public.workspace_admins (workspace_id, profile_id) values
  ('00000000-0000-4000-8000-000000000001', 'a3100157-0000-4000-8000-000000000001');

-- Grants: no new client definer; the new function is invoker; nothing for anon.
do $$
begin
  assert has_function_privilege('authenticated', 'public.ai_pilot_members(uuid)', 'execute'), 'members: a client RPC';
  assert not has_function_privilege('anon', 'public.ai_pilot_members(uuid)', 'execute'), 'anon: no members';
  assert not (select prosecdef from pg_proc where oid = 'public.ai_pilot_members(uuid)'::regprocedure), 'members is invoker';
  assert not (select prosecdef from pg_proc where oid = 'public.ai_builder_apply(uuid, integer, date)'::regprocedure), 'apply stays invoker';
  assert not has_table_privilege('anon', 'public.ai_builder_runs', 'select'), 'anon: no runs';
  assert has_column_privilege('authenticated', 'public.ai_builder_runs', 'kind', 'insert'), 'kind is set on insert';
  assert not has_column_privilege('authenticated', 'public.ai_builder_runs', 'kind', 'update'), 'kind never changes';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100157-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  res jsonb := public.ai_pilot_ensure_workspace('5eed0157-0000-4000-8000-000000000001');
begin
  insert into aib2_ids values ('ws', (res ->> 'workspace_id')::uuid);
end $$;

-- The mate joins the pilot's team (the team's lead adds them).
reset role;
insert into public.team_members (team_id, profile_id, role, created_by)
select w.default_team_id, 'a3100157-0000-4000-8000-000000000002', 'member', 'a3100157-0000-4000-8000-000000000001'
from public.workspaces w where w.id = (select id from aib2_ids where name = 'ws');
-- A project in the main workspace (an outsider's world).
insert into public.projects (id, workspace_id, name, created_by)
values ('9e000157-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'AIB2 main project', 'a3100157-0000-4000-8000-000000000001');

-- ai_pilot_members: the pilot's people for its admins, nothing for anyone else.
set role authenticated;
do $$
declare
  ws uuid := (select id from aib2_ids where name = 'ws');
begin
  perform set_config('request.jwt.claim.sub', 'a3100157-0000-4000-8000-000000000001', true);
  assert (select count(*) from public.ai_pilot_members(ws)) = 2, 'admin and mate';
  assert (select profile_id from public.ai_pilot_members(ws) where is_me) = 'a3100157-0000-4000-8000-000000000001', 'me first';
  assert not exists (select 1 from public.ai_pilot_members(ws) where profile_id = 'a3100157-0000-4000-8000-000000000003'), 'outsider not a member';
  assert (select count(*) from public.ai_pilot_members('00000000-0000-4000-8000-000000000001')) = 0, 'the main workspace is no pilot';
  perform set_config('request.jwt.claim.sub', 'a3100157-0000-4000-8000-000000000002', true);
  assert (select count(*) from public.ai_pilot_members(ws)) = 0, 'a member who is not an admin gets nothing';
  perform set_config('request.jwt.claim.sub', 'a3100157-0000-4000-8000-000000000003', true);
  assert (select count(*) from public.ai_pilot_members(ws)) = 0, 'an outsider gets nothing';
end $$;

-- Proposal validation: start dates and assignees.
do $$
declare
  base text := '{"name":"X","sections":[{"name":"A"}],"tasks":[{"title":"T","section":"A",%s}]}';
begin
  assert public.ai_builder_proposal_problem(format(base, '"due_in_days":5,"start_in_days":2')::jsonb) is null, 'start before due';
  assert public.ai_builder_proposal_problem(format(base, '"due_in_days":2,"start_in_days":5')::jsonb) is not null, 'start after due';
  assert public.ai_builder_proposal_problem(format(base, '"start_in_days":-1')::jsonb) is not null, 'start in the past';
  assert public.ai_builder_proposal_problem(format(base, '"start_in_days":1.5')::jsonb) is not null, 'start not whole days';
  assert public.ai_builder_proposal_problem(format(base, '"assignee":null')::jsonb) is null, 'nobody';
  assert public.ai_builder_proposal_problem(format(base, '"assignee":{"placeholder":"Designer"}')::jsonb) is null, 'placeholder';
  assert public.ai_builder_proposal_problem(format(base, '"assignee":{"member":"a3100157-0000-4000-8000-000000000002"}')::jsonb) is null, 'member';
  assert public.ai_builder_proposal_problem(format(base, '"assignee":"Dana"')::jsonb) is not null, 'a bare name';
  assert public.ai_builder_proposal_problem(format(base, '"assignee":{"member":"not-a-uuid"}')::jsonb) is not null, 'bad member';
  assert public.ai_builder_proposal_problem(format(base, '"assignee":{"placeholder":""}')::jsonb) is not null, 'empty placeholder';
  assert public.ai_builder_proposal_problem(format(base, '"assignee":{"member":"a3100157-0000-4000-8000-000000000002","placeholder":"x"}')::jsonb) is not null, 'both';
  assert public.ai_builder_proposal_problem(format(base, '"assignee":{"email":"x@example.com"}')::jsonb) is not null, 'an email';
end $$;

-- Run kinds: a build, an AI change of the caller's own proposal, an automation draft of a pilot project.
select set_config('request.jwt.claim.sub', 'a3100157-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  ws uuid := (select id from aib2_ids where name = 'ws');
  build uuid;
  edit uuid;
  draft jsonb := '{"name":"AIB2 Event","description":"","sections":[{"name":"Plan"},{"name":"Do"}],"fields":[],'
    '"tasks":['
    '{"title":"Mine","section":"Plan","notes":"","due_in_days":5,"start_in_days":2,"assignee":{"member":"a3100157-0000-4000-8000-000000000001"},"values":[],"subtasks":[]},'
    '{"title":"Mate''s","section":"Plan","notes":"","due_in_days":null,"start_in_days":null,"assignee":{"member":"a3100157-0000-4000-8000-000000000002"},"values":[],"subtasks":[]},'
    '{"title":"Design A","section":"Do","notes":"","due_in_days":null,"start_in_days":null,"assignee":{"placeholder":"Designer"},"values":[],"subtasks":[]},'
    '{"title":"Design B","section":"Do","notes":"","due_in_days":null,"start_in_days":null,"assignee":{"placeholder":"designer"},"values":[],"subtasks":[]}'
    ']}';
begin
  insert into public.ai_builder_runs (workspace_id, request_key) values (ws, 'r2-build-00001') returning id into build;
  assert (select kind from public.ai_builder_runs where id = build) = 'build', 'kind defaults to build';
  begin
    insert into public.ai_builder_runs (workspace_id, request_key, kind, parent_run_id) values (ws, 'r2-edit-000000', 'edit', build);
    raise exception 'an AI change of a proposal still generating';
  exception when check_violation then null;
  end;
  update public.ai_builder_runs set status = 'proposed', proposal = draft, proposal_version = 1, model = 'claude-sonnet-5-5',
    effort = 'low', generated_at = now()
  where id = build;
  assert (select effort from public.ai_builder_runs where id = build) = 'low', 'effort is logged';
  begin
    update public.ai_builder_runs set effort = 'high' where id = build;
    raise exception 'effort changed after the proposal';
  exception when check_violation then null;
  end;
  insert into aib2_ids values ('build', build);

  insert into public.ai_builder_runs (workspace_id, request_key, kind, parent_run_id, brief_chars)
  values (ws, 'r2-edit-000001', 'edit', build, 40) returning id into edit;
  update public.ai_builder_runs set status = 'proposed', proposal = draft || '{"name":"AIB2 Event v2"}', proposal_version = 1,
    model = 'claude-haiku-5-5', effort = 'low', generated_at = now()
  where id = edit;
  insert into aib2_ids values ('edit', edit);
  begin
    update public.ai_builder_runs set proposal = draft, proposal_version = 2 where id = edit;
    raise exception 'an AI change''s answer changed';
  exception when check_violation then null;
  end;
  begin
    update public.ai_builder_runs set status = 'applied' where id = edit;
    raise exception 'an AI change applied';
  exception when check_violation then null;
  end;
  begin
    perform public.ai_builder_apply(edit, 1, current_date);
    raise exception 'ai_builder_apply applied an AI change';
  exception when check_violation then null;
  end;
  begin
    insert into public.ai_builder_runs (workspace_id, request_key, kind) values (ws, 'r2-edit-000002', 'edit');
    raise exception 'an AI change without a parent';
  exception when check_violation then null;
  end;
  begin
    insert into public.ai_builder_runs (workspace_id, request_key, kind, target_project_id) values (ws, 'r2-auto-000001', 'automation', '9e000157-0000-4000-8000-000000000001');
    raise exception 'an automation draft for a main-workspace project';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.ai_builder_runs (workspace_id, request_key, kind) values (ws, 'r2-oops-000001', 'something');
    raise exception 'an unknown kind';
  exception when check_violation then null;
  end;
end $$;

-- The mate (not a pilot admin) can't start an AI change of the admin's proposal, nor any run.
select set_config('request.jwt.claim.sub', 'a3100157-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  insert into public.ai_builder_runs (workspace_id, request_key, kind, parent_run_id)
  values ((select id from aib2_ids where name = 'ws'), 'r2-mate-000001', 'edit', (select id from aib2_ids where name = 'build'));
  raise exception 'the mate changed the admin''s draft';
exception when insufficient_privilege then null;
end $$;

-- Apply: start dates, members (the mate joins as an Editor), one role for both placeholders.
select set_config('request.jwt.claim.sub', 'a3100157-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  res jsonb := public.ai_builder_apply((select id from aib2_ids where name = 'build'), 1, current_date);
  proj uuid := (res ->> 'project_id')::uuid;
  rid uuid;
begin
  assert res ->> 'status' = 'applied', 'applied: ' || res::text;
  insert into aib2_ids values ('proj', proj);
  assert (select start_on from public.tasks where home_project_id = proj and title = 'Mine') = current_date + 2, 'start date';
  assert (select due_on from public.tasks where home_project_id = proj and title = 'Mine') = current_date + 5, 'due date';
  assert (select assignee_id from public.tasks where home_project_id = proj and title = 'Mine') = 'a3100157-0000-4000-8000-000000000001', 'me';
  assert (select assignee_id from public.tasks where home_project_id = proj and title = 'Mate''s') = 'a3100157-0000-4000-8000-000000000002', 'the mate';
  assert (select role from public.project_members where project_id = proj and profile_id = 'a3100157-0000-4000-8000-000000000002' and deleted_at is null) = 'editor', 'the mate joined as an Editor';
  assert (select count(*) from public.project_roles where project_id = proj and deleted_at is null) = 1, 'one role for both placeholders';
  select id into rid from public.project_roles where project_id = proj and deleted_at is null;
  assert (select name from public.project_roles where id = rid) = 'Designer', 'named as first written';
  assert (select profile_id from public.project_roles where id = rid) is null, 'nobody fills it yet';
  assert (select count(*) from public.task_role_links where project_role_id = rid and slot = 'assignee' and deleted_at is null) = 2, 'both tasks linked';
  assert (select assignee_id from public.tasks where home_project_id = proj and title = 'Design A') is null, 'a placeholder assigns nobody';
  assert jsonb_array_length(res -> 'created_ids' -> 'roles') = 1, 'the role is recorded';
  assert (select fingerprint ? 'roles' from public.ai_builder_runs where id = (select id from aib2_ids where name = 'build')), 'roles in the fingerprint';
end $$;

-- Only the assignment notice goes out (to the mate); no email, Slack, or webhook.
reset role;
do $$
declare
  proj uuid := (select id from aib2_ids where name = 'proj');
begin
  assert (select count(*) from public.inbox_items i join public.tasks t on t.id = i.task_id where t.home_project_id = proj) <= 1, 'at most the mate''s assignment notice';
  assert not exists (select 1 from public.inbox_items i join public.tasks t on t.id = i.task_id
                     where t.home_project_id = proj and i.recipient_id = 'a3100157-0000-4000-8000-000000000001'), 'nothing to the caller';
  assert not exists (select 1 from public.email_outbox o join public.tasks t on t.id = o.task_id where t.home_project_id = proj), 'no email';
  assert not exists (select 1 from public.integration_outbox o where o.project_id = proj), 'no Slack / webhooks';
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100157-0000-4000-8000-000000000001', false) is not null as ok \gset

-- An outsider can't be assigned: the whole apply is refused and nothing is left behind.
do $$
declare
  ws uuid := (select id from aib2_ids where name = 'ws');
  run uuid;
  before_count bigint := (select count(*) from public.projects where workspace_id = ws);
begin
  insert into public.ai_builder_runs (workspace_id, request_key) values (ws, 'r2-build-00002') returning id into run;
  update public.ai_builder_runs set status = 'proposed', proposal_version = 1, generated_at = now(),
    proposal = '{"name":"AIB2 Outsider","sections":[{"name":"A"}],"fields":[],"tasks":[{"title":"T","section":"A","assignee":{"member":"a3100157-0000-4000-8000-000000000003"}}]}'
  where id = run;
  begin
    perform public.ai_builder_apply(run, 1, current_date);
    raise exception 'an outsider was assigned';
  exception when check_violation then null;
  end;
  assert (select count(*) from public.projects where workspace_id = ws) = before_count, 'nothing created';
  assert (select status from public.ai_builder_runs where id = run) = 'proposed', 'still a proposal';
end $$;

-- Undo: a renamed placeholder role is a change (refused), put back it undoes.
do $$
declare
  run uuid := (select id from aib2_ids where name = 'build');
  proj uuid := (select id from aib2_ids where name = 'proj');
  res jsonb;
begin
  update public.project_roles set name = 'Lead designer' where project_id = proj;
  res := public.ai_builder_undo(run);
  assert res ->> 'status' = 'conflict' and res -> 'changed' ? 'roles', 'roles conflict: ' || res::text;
  update public.project_roles set name = 'Designer' where project_id = proj;
end $$;

-- Automation drafts: the caller's own pilot project (Admin+); finished only by a rule the same person saved
-- from it in that project. The saved rule runs through the engine like any other: a blocked task stays
-- open (notes 163 / 163b).
reset role;
insert into public.projects (id, workspace_id, name, created_by)
values ('9e000157-0000-4000-8000-000000000002', (select id from aib2_ids where name = 'ws'), 'AIB2 rules project', 'a3100157-0000-4000-8000-000000000001');
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100157-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  ws uuid := (select id from aib2_ids where name = 'ws');
  p uuid := '9e000157-0000-4000-8000-000000000002';
  other uuid := (select id from aib2_ids where name = 'proj');
  sec uuid;
  run uuid;
  rule uuid;
  wrong uuid;
  a uuid;
  b uuid;
  ran jsonb;
begin
  insert into public.sections (project_id, name) values (p, 'Start') returning id into sec;
  insert into public.ai_builder_runs (workspace_id, request_key, kind, target_project_id) values (ws, 'r2-auto-000002', 'automation', p) returning id into run;
  update public.ai_builder_runs set status = 'proposed', proposal_version = 1, model = 'claude-haiku-5-5', effort = 'low', generated_at = now(),
    proposal = '{"name":"Finish","triggerType":"manual","triggerConfig":{},"conditions":[],"actions":[{"type":"complete_task"}],"missing":[]}'
  where id = run;
  begin
    update public.ai_builder_runs set status = 'applied' where id = run;
    raise exception 'an automation draft finished without a rule';
  exception when check_violation then null;
  end;
  -- A rule of another project can't finish it.
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values (other, 'AIB2 elsewhere', false, 'manual', '[{"type":"complete_task"}]') returning id into wrong;
  begin
    update public.ai_builder_runs set status = 'applied', rule_id = wrong where id = run;
    raise exception 'a rule of another project finished it';
  exception when check_violation then null;
  end;
  begin
    update public.ai_builder_runs set rule_id = wrong where id = (select id from aib2_ids where name = 'edit');
    raise exception 'an AI change recorded a rule';
  exception when check_violation then null;
  end;
  -- The normal rule-save path (what the rule canvas does): an ordinary insert, validate_rule decides.
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values (p, 'Finish', true, 'manual', '[{"type":"complete_task"}]') returning id into rule;
  update public.ai_builder_runs set status = 'applied', rule_id = rule where id = run;
  assert (select rule_id from public.ai_builder_runs where id = run) = rule, 'the saved rule is recorded';
  begin
    update public.ai_builder_runs set rule_id = wrong where id = run;
    raise exception 'the recorded rule changed';
  exception when check_violation then null;
  end;

  a := public.create_task(p, sec, 'AIB2 blocker');
  b := public.create_task(p, sec, 'AIB2 blocked');
  perform public.set_task_dependency(a, b, 'finish_to_start', 0);
  ran := public.run_manual_rule(rule, b);
  assert ran -> 'detail' -> 'actions' -> 0 ->> 'outcome' = 'blocked', 'the AI-made rule is blocked like any other: ' || ran::text;
  assert (select completed_at from public.tasks where id = b) is null, 'the blocked task stays open';
end $$;

-- The mate is no admin of the rules project: no automation draft for it.
reset role;
insert into public.project_members (project_id, profile_id, role, created_by)
values ('9e000157-0000-4000-8000-000000000002', 'a3100157-0000-4000-8000-000000000002', 'editor', 'a3100157-0000-4000-8000-000000000001');
insert into public.workspace_admins (workspace_id, profile_id)
values ((select id from aib2_ids where name = 'ws'), 'a3100157-0000-4000-8000-000000000002');
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100157-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  insert into public.ai_builder_runs (workspace_id, request_key, kind, target_project_id)
  values ((select id from aib2_ids where name = 'ws'), 'r2-mate-000002', 'automation', '9e000157-0000-4000-8000-000000000002');
  raise exception 'an Editor drafted an automation';
exception when insufficient_privilege then null;
end $$;

-- Rate limits per kind: thirty AI changes an hour, then the next is refused; builds keep their own count.
select set_config('request.jwt.claim.sub', 'a3100157-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  ws uuid := (select id from aib2_ids where name = 'ws');
  build uuid := (select id from aib2_ids where name = 'build');
  base uuid;
  run uuid;
  i int;
begin
  -- A proposal to change (the first one was applied).
  insert into public.ai_builder_runs (workspace_id, request_key) values (ws, 'r2-build-00003') returning id into base;
  update public.ai_builder_runs set status = 'proposed', proposal_version = 1, generated_at = now(),
    proposal = '{"name":"AIB2 Base","sections":[{"name":"A"}],"fields":[],"tasks":[]}'
  where id = base;
  for i in 2 .. 30 loop
    insert into public.ai_builder_runs (workspace_id, request_key, kind, parent_run_id)
    values (ws, 'r2-edit-' || lpad(i::text, 6, '0'), 'edit', base) returning id into run;
    update public.ai_builder_runs set status = 'failed', error_code = 'invalid_output' where id = run;
  end loop;
  begin
    insert into public.ai_builder_runs (workspace_id, request_key, kind, parent_run_id) values (ws, 'r2-edit-limit1', 'edit', base);
    raise exception 'a thirty-first AI change in an hour';
  exception when program_limit_exceeded then null;
  end;
  insert into public.ai_builder_runs (workspace_id, request_key) values (ws, 'r2-build-00004') returning id into run;
  update public.ai_builder_runs set status = 'cancelled' where id = run;
  assert build is not null, 'builds still count on their own';
end $$;

reset role;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset

select 'zz57_ai_builder_round2_smoke: ok';
