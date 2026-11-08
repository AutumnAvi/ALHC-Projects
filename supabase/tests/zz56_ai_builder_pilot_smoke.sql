-- AI builder pilot (20261108122112_ai_builder_pilot_a.sql), experimental branch feat/ai-builder.
--   a3100156…01 aib-admin@example.com   Ai Admin   (a main-workspace admin: sets up and runs the pilot)
--   a3100156…02 aib-member@example.com  Ai Member  (main workspace member, not an admin)
--   a3100156…03 aib-other@example.com   Ai Other   (another main-workspace admin, not the pilot's)

\set ON_ERROR_STOP 1

create temporary table aib_ids (name text primary key, id uuid) on commit preserve rows;
grant all on aib_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('aib-admin@example.com', 'ai builder'), ('aib-member@example.com', 'ai builder'), ('aib-other@example.com', 'ai builder');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a3100156-0000-4000-8000-000000000001', 'aib-admin@example.com', now(), '{"full_name":"Ai Admin"}'),
  ('a3100156-0000-4000-8000-000000000002', 'aib-member@example.com', now(), '{"full_name":"Ai Member"}'),
  ('a3100156-0000-4000-8000-000000000003', 'aib-other@example.com', now(), '{"full_name":"Ai Other"}');
insert into public.workspace_admins (workspace_id, profile_id) values
  ('00000000-0000-4000-8000-000000000001', 'a3100156-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000001', 'a3100156-0000-4000-8000-000000000003');

-- Grants: one new client definer; the cleanup is nobody's but the owner's; nothing for anon.
do $$
begin
  assert has_function_privilege('authenticated', 'public.ai_pilot_ensure_workspace(uuid)', 'execute'), 'ensure is a client RPC';
  assert not has_function_privilege('anon', 'public.ai_pilot_ensure_workspace(uuid)', 'execute'), 'anon: no ensure';
  assert not has_function_privilege('authenticated', 'public.ai_pilot_cleanup(uuid, uuid, text, boolean)', 'execute'), 'cleanup: not clients';
  assert not has_function_privilege('service_role', 'public.ai_pilot_cleanup(uuid, uuid, text, boolean)', 'execute'), 'cleanup: not service_role';
  assert not has_function_privilege('anon', 'public.ai_builder_apply(uuid, integer, date)', 'execute'), 'anon: no apply';
  assert not has_table_privilege('anon', 'public.ai_builder_runs', 'select'), 'anon: no runs';
  assert not has_table_privilege('authenticated', 'public.ai_pilot_workspaces', 'insert'), 'nobody writes the registry';
  assert not has_table_privilege('authenticated', 'public.ai_builder_runs', 'truncate'), 'no truncate';
end $$;

-- An unregistered workspace already named Testing data makes setup ambiguous: refused.
insert into public.workspaces (id, name) values ('d1ec0156-0000-4000-8000-000000000001', 'Testing data');

set role authenticated;

-- A member who isn't a workspace admin can't set up the pilot.
select set_config('request.jwt.claim.sub', 'a3100156-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  perform public.ai_pilot_ensure_workspace('5eed0156-0000-4000-8000-000000000001');
  raise exception 'a member set up the pilot';
exception when insufficient_privilege then null;
end $$;

select set_config('request.jwt.claim.sub', 'a3100156-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  perform public.ai_pilot_ensure_workspace('5eed0156-0000-4000-8000-000000000001');
  raise exception 'an ambiguous Testing data workspace was accepted';
exception when check_violation then null;
end $$;

reset role;
update public.workspaces set name = 'Decoy (not a pilot)' where id = 'd1ec0156-0000-4000-8000-000000000001';
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100156-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  first jsonb := public.ai_pilot_ensure_workspace('5eed0156-0000-4000-8000-000000000001');
  again jsonb := public.ai_pilot_ensure_workspace('5eed0156-0000-4000-8000-000000000001');
begin
  assert (first ->> 'created')::boolean, 'created: ' || first::text;
  assert not (again ->> 'created')::boolean and again ->> 'workspace_id' = first ->> 'workspace_id', 'idempotent: ' || again::text;
  insert into aib_ids values ('ws', (first ->> 'workspace_id')::uuid);
  assert public.ai_pilot_admin((first ->> 'workspace_id')::uuid), 'the operator administers the pilot';
  assert not public.ai_pilot_admin('00000000-0000-4000-8000-000000000001'), 'the main workspace is never a pilot';
  assert not public.ai_pilot_admin('d1ec0156-0000-4000-8000-000000000001'), 'an unregistered workspace is never a pilot';
  assert not public.ai_pilot_admin(null), 'null is no pilot';
  assert (select count(*) from public.ai_pilot_workspaces) = 1, 'the operator reads the registry';
end $$;

reset role;
do $$
declare
  ws uuid := (select id from aib_ids where name = 'ws');
  team uuid := (select w.default_team_id from public.workspaces w where w.id = ws);
begin
  assert (select name from public.workspaces where id = ws) = 'Testing data', 'named Testing data';
  assert (select name from public.teams where id = team) = 'Testing data', 'its team is renamed';
  assert (select array_agg(profile_id) from public.team_members where team_id = team and deleted_at is null)
    = array['a3100156-0000-4000-8000-000000000001'::uuid], 'only the operator is on the pilot team';
  assert (select role from public.team_members where team_id = team and deleted_at is null) = 'lead', 'as its lead';
end $$;

set role authenticated;

-- Another main-workspace admin: no second pilot, and the existing one isn't theirs.
select set_config('request.jwt.claim.sub', 'a3100156-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
begin
  begin
    perform public.ai_pilot_ensure_workspace('5eed0156-0000-4000-8000-000000000002');
    raise exception 'a second pilot';
  exception when check_violation then null;
  end;
  begin
    perform public.ai_pilot_ensure_workspace('5eed0156-0000-4000-8000-000000000001');
    raise exception 'someone else reopened the pilot';
  exception when insufficient_privilege then null;
  end;
  assert not public.ai_pilot_admin((select id from aib_ids where name = 'ws')), 'not the other admin''s pilot';
  assert (select count(*) from public.ai_pilot_workspaces) = 0, 'the registry is hidden from non-admins of the pilot';
end $$;

-- Runs: only pilot admins, only in the pilot workspace, nothing forged.
select set_config('request.jwt.claim.sub', 'a3100156-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  begin
    insert into public.ai_builder_runs (workspace_id, request_key) values ((select id from aib_ids where name = 'ws'), 'member-key-0001');
    raise exception 'a member logged a run';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.ai_builder_apply(gen_random_uuid(), 1, current_date);
    raise exception 'apply of a missing run';
  exception when no_data_found then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'a3100156-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  ws uuid := (select id from aib_ids where name = 'ws');
  run uuid;
begin
  begin
    insert into public.ai_builder_runs (workspace_id, request_key) values ('00000000-0000-4000-8000-000000000001', 'main-key-00001');
    raise exception 'a run in the main workspace';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.ai_builder_runs (workspace_id, request_key, project_id) values (ws, 'forged-key-001', gen_random_uuid());
    raise exception 'a forged project id';
  exception when insufficient_privilege then null;
  end;
  insert into public.ai_builder_runs (workspace_id, request_key, brief_chars) values (ws, 'run-key-000001', 120) returning id into run;
  insert into aib_ids values ('run1', run);
  assert (select status from public.ai_builder_runs where id = run) = 'generating', 'starts generating';
  assert (select actor_id from public.ai_builder_runs where id = run) = 'a3100156-0000-4000-8000-000000000001', 'actor = caller';
end $$;

-- A template of another workspace can't be named.
reset role;
insert into public.project_templates (id, workspace_id, name, content, summary)
values ('7e000156-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'AIB main template', '{}', '{}');
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100156-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  insert into public.ai_builder_runs (workspace_id, request_key, template_id)
  values ((select id from aib_ids where name = 'ws'), 'tmpl-key-00001', '7e000156-0000-4000-8000-000000000001');
  raise exception 'a main-workspace template in the pilot';
exception when no_data_found then null;
end $$;

-- Proposal validation (the database's own copy of the rules).
do $$
declare
  ok jsonb := '{"name":"Launch","sections":[{"name":"To do"}],"fields":[],"tasks":[]}';
begin
  assert public.ai_builder_proposal_problem(ok) is null, 'a minimal proposal is fine';
  assert public.ai_builder_proposal_problem('[]') is not null, 'not an object';
  assert public.ai_builder_proposal_problem('{"name":"","sections":[{"name":"A"}]}') is not null, 'empty name';
  assert public.ai_builder_proposal_problem('{"name":"X","sections":[]}') is not null, 'no sections';
  assert public.ai_builder_proposal_problem('{"name":"X","sections":[{"name":"A"},{"name":"a"}]}') is not null, 'duplicate sections';
  assert public.ai_builder_proposal_problem('{"name":"X","sections":[{"name":"A"}],"fields":[{"name":"F","type":"formula","options":[]}]}') is not null, 'unsupported type';
  assert public.ai_builder_proposal_problem('{"name":"X","sections":[{"name":"A"}],"fields":[{"name":"F","type":"single_select","options":[]}]}') is not null, 'choice without options';
  assert public.ai_builder_proposal_problem('{"name":"X","sections":[{"name":"A"}],"tasks":[{"title":"T","section":"B"}]}') is not null, 'unknown section';
  assert public.ai_builder_proposal_problem('{"name":"X","sections":[{"name":"A"}],"tasks":[{"title":"T","section":"A","due_in_days":"soon"}]}') is not null, 'bad due';
  assert public.ai_builder_proposal_problem('{"name":"X","sections":[{"name":"A"}],"tasks":[{"title":"T","section":"A","due_in_days":400}]}') is not null, 'due too far';
  assert public.ai_builder_proposal_problem('{"name":"X","sections":[{"name":"A"}],"fields":[{"name":"P","type":"single_select","options":["Hi"]}],"tasks":[{"title":"T","section":"A","values":[{"field":"P","value":"Lo"}]}]}') is not null, 'unknown option';
  assert public.ai_builder_proposal_problem('{"name":"X","sections":[{"name":"A"}],"fields":[{"name":"M","type":"multi_select","options":["Hi"]}],"tasks":[{"title":"T","section":"A","values":[{"field":"M","value":"Hi"}]}]}') is not null, 'multi needs an array';
  assert public.ai_builder_proposal_problem('{"name":"X","sections":[{"name":"A"}],"tasks":[{"title":"T","section":"A","values":[{"field":"Nope","value":1}]}]}') is not null, 'unknown field';
  assert public.ai_builder_proposal_problem('{"name":"X","sections":[{"name":"A"}],"fields":[{"name":"D","type":"date","options":[]}],"tasks":[{"title":"T","section":"A","values":[{"field":"D","value":"2026-02-30"}]}]}') is not null, 'impossible date';
  assert public.ai_builder_proposal_problem('{"name":"X","sections":[{"name":"A"}],"fields":[{"name":"D","type":"date","options":[]}],"tasks":[{"title":"T","section":"A","values":[{"field":"D","value":"2026-02-28"}]}]}') is null, 'real date';
end $$;

-- generating → proposed (v1); edits are new versions; only apply applies.
do $$
declare
  run uuid := (select id from aib_ids where name = 'run1');
  draft jsonb := '{"name":"AIB Launch","description":"Practice launch","sections":[{"name":"To do"},{"name":"Doing"}],'
    '"fields":[{"name":"Priority","type":"single_select","options":["High","Low"]},{"name":"Budget","type":"number","options":[]},'
    '{"name":"Labels","type":"multi_select","options":["A","B"]}],'
    '"tasks":[{"title":"AIB Kickoff","section":"To do","notes":"Agenda","due_in_days":3,'
    '"values":[{"field":"Priority","value":"High"},{"field":"Budget","value":12.5},{"field":"Labels","value":["A","B"]}],'
    '"subtasks":["Book room","Send invite"]},{"title":"AIB Draft","section":"Doing"}]}';
begin
  update public.ai_builder_runs set status = 'proposed', proposal = draft, proposal_version = 1, model = 'test-model',
    input_tokens = 100, output_tokens = 200, generated_at = now()
  where id = run;
  begin
    update public.ai_builder_runs set proposal = draft || '{"name":"Other"}' where id = run;
    raise exception 'an edit without a new version';
  exception when check_violation then null;
  end;
  update public.ai_builder_runs set proposal = draft || '{"name":"AIB Launch v2"}', proposal_version = 2 where id = run;
  begin
    update public.ai_builder_runs set status = 'applied' where id = run;
    raise exception 'applied by hand';
  exception when check_violation then null;
  end;
  begin
    update public.ai_builder_runs set project_id = gen_random_uuid() where id = run;
    raise exception 'a forged project';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.ai_builder_apply(run, 1, current_date);
    raise exception 'an old version applied';
  exception when serialization_failure then null;
  end;
end $$;

-- Apply: one transaction, as the caller, in the pilot workspace; a repeat returns the same answer.
do $$
declare
  run uuid := (select id from aib_ids where name = 'run1');
  ws uuid := (select id from aib_ids where name = 'ws');
  res jsonb := public.ai_builder_apply(run, 2, current_date);
  again jsonb := public.ai_builder_apply(run, 2, current_date);
  proj uuid := (res ->> 'project_id')::uuid;
  kickoff uuid;
begin
  assert res ->> 'status' = 'applied' and not (res ->> 'repeated')::boolean, 'applied: ' || res::text;
  assert (again ->> 'repeated')::boolean and again ->> 'project_id' = res ->> 'project_id', 'idempotent: ' || again::text;
  insert into aib_ids values ('proj', proj);
  assert (select workspace_id from public.projects where id = proj) = ws, 'in the pilot workspace';
  assert (select name from public.projects where id = proj) = 'AIB Launch v2', 'the latest version';
  assert (select visibility from public.projects where id = proj) = 'private', 'private';
  assert (select team_id from public.projects where id = proj) = (select default_team_id from public.workspaces where id = ws), 'pilot team';
  assert public.project_role(proj) = 'owner', 'the caller owns it';
  assert (select count(*) from public.sections where project_id = proj and deleted_at is null) = 2, 'sections';
  assert (select count(*) from public.custom_fields where project_id = proj) = 3, 'fields';
  assert jsonb_array_length(res -> 'created_ids' -> 'tasks') = 2 and jsonb_array_length(res -> 'created_ids' -> 'subtasks') = 2, 'tasks: ' || res::text;
  select t.id into kickoff from public.tasks t where t.home_project_id = proj and t.title = 'AIB Kickoff';
  insert into aib_ids values ('kickoff', kickoff);
  assert (select due_on from public.tasks where id = kickoff) = current_date + 3, 'due in 3 days';
  assert (select notes from public.tasks where id = kickoff) = 'Agenda', 'notes';
  assert (select count(*) from public.task_field_values where task_id = kickoff and value <> 'null'::jsonb) = 3, 'values';
  assert (select count(*) from public.tasks where parent_task_id = kickoff) = 2, 'subtasks';
  assert (select count(*) from public.tasks where workspace_id = ws) = 4, 'every created task is in the pilot';
  assert (select count(*) from public.rules where project_id = proj) = 0, 'no automations';
  assert (select status from public.ai_builder_runs where id = run) = 'applied', 'logged';
end $$;

-- Nothing was sent or notified, and nobody else hears about it.
reset role;
do $$
declare
  proj uuid := (select id from aib_ids where name = 'proj');
begin
  assert not exists (select 1 from public.inbox_items i join public.tasks t on t.id = i.task_id where t.workspace_id = (select id from aib_ids where name = 'ws')), 'no inbox items';
  assert not exists (select 1 from public.email_outbox o join public.tasks t on t.id = o.task_id where t.workspace_id = (select id from aib_ids where name = 'ws')), 'no email';
  assert not exists (select 1 from public.integration_outbox o where o.project_id = proj), 'no Slack / webhooks';
  assert (select count(*) from public.project_members where project_id = proj and deleted_at is null) = 1, 'one member';
end $$;

-- Another pilot admin sees the run but can't apply or undo someone else's.
insert into public.workspace_admins (workspace_id, profile_id)
values ((select id from aib_ids where name = 'ws'), 'a3100156-0000-4000-8000-000000000003');
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100156-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
begin
  assert (select count(*) from public.ai_builder_runs where id = (select id from aib_ids where name = 'run1')) = 1, 'pilot admins read runs';
  begin
    perform public.ai_builder_undo((select id from aib_ids where name = 'run1'));
    raise exception 'someone else undid the run';
  exception when insufficient_privilege or no_data_found then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', 'a3100156-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  assert (select count(*) from public.ai_builder_runs) = 0, 'members read no runs';
end $$;

-- Undo refuses while anything changed, then moves the project to the Trash; repeating is harmless.
select set_config('request.jwt.claim.sub', 'a3100156-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  run uuid := (select id from aib_ids where name = 'run1');
  kickoff uuid := (select id from aib_ids where name = 'kickoff');
  res jsonb;
begin
  update public.tasks set title = 'AIB Kickoff (edited)' where id = kickoff;
  res := public.ai_builder_undo(run);
  assert res ->> 'status' = 'conflict' and res -> 'changed' ? 'tasks', 'conflict: ' || res::text;
  assert (select deleted_at from public.projects where id = (select id from aib_ids where name = 'proj')) is null, 'untouched on conflict';
  assert (select undo_conflicts from public.ai_builder_runs where id = run) is not null, 'the conflict is logged';
end $$;
do $$
declare
  run uuid := (select id from aib_ids where name = 'run1');
  res jsonb;
begin
  update public.tasks set title = 'AIB Kickoff' where id = (select id from aib_ids where name = 'kickoff');
  res := public.ai_builder_undo(run);
  assert res ->> 'status' = 'undone', 'undone: ' || res::text;
  assert (select deleted_at from public.projects where id = (select id from aib_ids where name = 'proj')) is not null, 'in the Trash';
  res := public.ai_builder_undo(run);
  assert res ->> 'status' = 'already_undone', 'repeat: ' || res::text;
end $$;

-- A failing apply leaves nothing behind (a test-only trigger refuses the second task, after the project,
-- its section, and the first task were written), and a cancelled run can't apply.
reset role;
create function public.aib_test_refuse_task() returns trigger language plpgsql set search_path = '' as $f$
begin
  if new.title = 'AIB refused' then
    raise exception 'test refusal' using errcode = 'check_violation';
  end if;
  return new;
end;
$f$;
create trigger aib_test_refuse_task before insert on public.tasks for each row execute function public.aib_test_refuse_task();
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100156-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  ws uuid := (select id from aib_ids where name = 'ws');
  run uuid;
begin
  insert into public.ai_builder_runs (workspace_id, request_key) values (ws, 'run-key-000002') returning id into run;
  update public.ai_builder_runs set status = 'proposed', proposal_version = 1,
    proposal = '{"name":"AIB Broken","sections":[{"name":"A"}],"fields":[],'
               '"tasks":[{"title":"AIB fine","section":"A"},{"title":"AIB refused","section":"A"}]}'
  where id = run;
  begin
    perform public.ai_builder_apply(run, 1, current_date);
    raise exception 'a refused task applied';
  exception when check_violation then null;
  end;
  assert not exists (select 1 from public.projects where name = 'AIB Broken'), 'no project left behind';
  assert not exists (select 1 from public.tasks where title = 'AIB fine'), 'no task left behind';
  assert (select status from public.ai_builder_runs where id = run) = 'proposed', 'still a proposal';
  update public.ai_builder_runs set status = 'cancelled' where id = run;
  begin
    perform public.ai_builder_apply(run, 1, current_date);
    raise exception 'a cancelled run applied';
  exception when check_violation then null;
  end;
end $$;

reset role;
drop trigger aib_test_refuse_task on public.tasks;
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100156-0000-4000-8000-000000000001', false) is not null as ok \gset

-- Rate limits hold in the database: two generating at once, ten an hour.
do $$
declare
  ws uuid := (select id from aib_ids where name = 'ws');
  i integer;
begin
  insert into public.ai_builder_runs (workspace_id, request_key) values (ws, 'gen-key-000001'), (ws, 'gen-key-000002');
  begin
    insert into public.ai_builder_runs (workspace_id, request_key) values (ws, 'gen-key-000003');
    raise exception 'a third concurrent generation';
  exception when program_limit_exceeded then null;
  end;
  update public.ai_builder_runs set status = 'failed', error_code = 'timeout' where status = 'generating';
  for i in 1 .. 6 loop
    insert into public.ai_builder_runs (workspace_id, request_key) values (ws, 'hour-key-00000' || i);
    update public.ai_builder_runs set status = 'failed' where request_key = 'hour-key-00000' || i;
  end loop;
  begin
    insert into public.ai_builder_runs (workspace_id, request_key) values (ws, 'hour-key-000099');
    raise exception 'an eleventh run this hour';
  exception when program_limit_exceeded then null;
  end;
end $$;

-- Seed supplements: once per key, only on pilot tasks, never overwriting.
do $$
declare
  ws uuid := (select id from aib_ids where name = 'ws');
  proj uuid;
  t uuid;
  f uuid;
  c1 uuid;
  c2 uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'AIB Seeded') returning id into proj;
  insert into aib_ids values ('seeded', proj);
  t := public.create_task(proj, null, 'AIB seeded task');
  insert into aib_ids values ('seeded_task', t);
  insert into public.custom_fields (project_id, name, field_type, options) values (proj, 'Note', 'text', '[]') returning id into f;
  c1 := public.ai_pilot_seed_comment(ws, 'asana:story:1', t, 'Hello from Asana');
  c2 := public.ai_pilot_seed_comment(ws, 'asana:story:1', t, 'Hello from Asana');
  assert c1 = c2 and (select count(*) from public.comments where task_id = t) = 1, 'one comment per key';
  assert public.ai_pilot_seed_field_value(ws, 'asana:value:1', t, f, '"first"') = 'set', 'set';
  assert public.ai_pilot_seed_field_value(ws, 'asana:value:1', t, f, '"again"') = 'done', 'done';
  assert public.ai_pilot_seed_field_value(ws, 'asana:value:2', t, f, '"other"') = 'kept', 'kept';
  assert (select value from public.task_field_values where task_id = t and field_id = f) = '"first"', 'never overwritten';
end $$;

-- Main-workspace data that points at the pilot (kept by the cleanup; the pointer is cleared or the link goes).
do $$
declare
  main_proj uuid;
  main_task uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'AIB Main project') returning id into main_proj;
  main_task := public.create_task(main_proj, null, 'AIB main task');
  insert into aib_ids values ('main_proj', main_proj), ('main_task', main_task);
  begin
    perform public.ai_pilot_seed_comment((select id from aib_ids where name = 'ws'), 'asana:story:x', main_task, 'nope');
    raise exception 'a seed comment on a main task';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.ai_pilot_seed_comment('00000000-0000-4000-8000-000000000001', 'asana:story:y', main_task, 'nope');
    raise exception 'a seed comment in the main workspace';
  exception when insufficient_privilege then null;
  end;
  perform public.set_project_starred((select id from aib_ids where name = 'seeded'), true);
end $$;

reset role;
insert into public.project_templates (id, workspace_id, name, content, summary, source_project_id)
values ('7e000156-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'AIB main from pilot', '{}', '{}',
        (select id from aib_ids where name = 'seeded'));

-- Cleanup: refuses anything but the registered id + marker + exact name; dry run changes nothing.
create temporary table aib_before on commit preserve rows as
select
  (select count(*) from public.projects where workspace_id = '00000000-0000-4000-8000-000000000001') as projects,
  (select count(*) from public.tasks where workspace_id = '00000000-0000-4000-8000-000000000001') as tasks,
  (select count(*) from public.profiles) as profiles,
  (select count(*) from public.allowed_emails) as emails,
  (select count(*) from public.workspaces) as workspaces,
  (select count(*) from public.team_members m join public.teams t on t.id = m.team_id where t.workspace_id = '00000000-0000-4000-8000-000000000001') as main_team_members,
  (select count(*) from auth.users) as users;

do $$
declare
  ws uuid := (select id from aib_ids where name = 'ws');
  res jsonb;
begin
  begin
    perform public.ai_pilot_cleanup(ws, '5eed0156-0000-4000-8000-000000000999', 'Testing data');
    raise exception 'a wrong marker';
  exception when check_violation then null;
  end;
  begin
    perform public.ai_pilot_cleanup('00000000-0000-4000-8000-000000000001', '5eed0156-0000-4000-8000-000000000001', 'ALHC');
    raise exception 'the main workspace';
  exception when check_violation then null;
  end;
  begin
    perform public.ai_pilot_cleanup('d1ec0156-0000-4000-8000-000000000001', '5eed0156-0000-4000-8000-000000000001', 'Decoy (not a pilot)');
    raise exception 'an unregistered workspace';
  exception when check_violation then null;
  end;
  begin
    perform public.ai_pilot_cleanup(ws, '5eed0156-0000-4000-8000-000000000001', 'testing data');
    raise exception 'a loose name';
  exception when check_violation then null;
  end;
  begin
    perform public.ai_pilot_cleanup(ws, null, 'Testing data');
    raise exception 'no marker';
  exception when invalid_parameter_value then null;
  end;

  res := public.ai_pilot_cleanup(ws, '5eed0156-0000-4000-8000-000000000001', 'Testing data');
  assert res ->> 'status' = 'dry_run', 'dry run by default: ' || res::text;
  assert (res -> 'would_remove' ->> 'public.projects')::integer = 2, 'two pilot projects: ' || res::text;
  assert (res -> 'would_remove' ->> 'public.workspaces')::integer = 1, 'one workspace: ' || res::text;
  assert (res -> 'references_cleared' ->> 'public.project_templates.source_project_id')::integer = 1, 'template pointer: ' || res::text;
  assert exists (select 1 from public.workspaces where id = ws), 'dry run kept the workspace';
  assert (select count(*) from public.projects where workspace_id = ws) = 2, 'dry run kept the projects';
end $$;

do $$
declare
  ws uuid := (select id from aib_ids where name = 'ws');
  res jsonb := public.ai_pilot_cleanup((select id from aib_ids where name = 'ws'), '5eed0156-0000-4000-8000-000000000001', 'Testing data', true);
  b record;
begin
  select * into b from aib_before;
  assert res ->> 'status' = 'cleaned', 'cleaned: ' || res::text;
  assert not exists (select 1 from public.workspaces where id = ws), 'the pilot workspace is gone';
  assert not exists (select 1 from public.projects where workspace_id = ws), 'its projects are gone';
  assert not exists (select 1 from public.tasks where workspace_id = ws), 'its tasks are gone';
  assert not exists (select 1 from public.ai_builder_runs where workspace_id = ws), 'its runs are gone';
  assert exists (select 1 from public.trash_storage_purges where path = (select id from aib_ids where name = 'seeded_task')::text || '/'), 'files queued';
  assert (select count(*) from public.projects where workspace_id = '00000000-0000-4000-8000-000000000001') = b.projects, 'main projects kept';
  assert (select count(*) from public.tasks where workspace_id = '00000000-0000-4000-8000-000000000001') = b.tasks, 'main tasks kept';
  assert (select count(*) from public.profiles) = b.profiles and (select count(*) from auth.users) = b.users, 'people kept';
  assert (select count(*) from public.allowed_emails) = b.emails, 'allowlist kept';
  assert (select count(*) from public.workspaces) = b.workspaces - 1, 'only the pilot workspace went';
  assert (select count(*) from public.team_members m join public.teams t on t.id = m.team_id where t.workspace_id = '00000000-0000-4000-8000-000000000001') = b.main_team_members, 'main teams kept';
  assert exists (select 1 from public.workspaces where id = 'd1ec0156-0000-4000-8000-000000000001'), 'the decoy workspace kept';
  assert exists (select 1 from public.project_templates where id = '7e000156-0000-4000-8000-000000000002' and source_project_id is null), 'main template kept, pointer cleared';
  assert exists (select 1 from public.tasks where id = (select id from aib_ids where name = 'main_task')), 'main task kept';
  assert exists (select 1 from public.workspace_admins where workspace_id = '00000000-0000-4000-8000-000000000001'
                 and profile_id = 'a3100156-0000-4000-8000-000000000001' and deleted_at is null), 'main admin kept';
  assert (select cleaned_at from public.ai_pilot_workspaces where workspace_id = ws) is not null, 'the registry keeps the audit row';

  res := public.ai_pilot_cleanup(ws, '5eed0156-0000-4000-8000-000000000001', 'Testing data', true);
  assert res ->> 'status' = 'already_cleaned', 'repeat: ' || res::text;
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100156-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  assert not public.ai_pilot_admin((select id from aib_ids where name = 'ws')), 'a cleaned pilot is no pilot';
  begin
    perform public.ai_pilot_ensure_workspace('5eed0156-0000-4000-8000-000000000001');
    raise exception 'a cleaned marker reopened';
  exception when check_violation then null;
  end;
end $$;
reset role;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
