-- AI builder round 3 (20261108152314_ai_assistant_round3_a.sql), experimental branch feat/ai-builder-p3:
-- the global assistant's run log. Runs after zz57 and uses its pilot (and its people):
--   a3100157…01 aib2-admin@example.com  (a workspace admin of the pilot)
--   a3100157…02 aib2-mate@example.com   (on the pilot's team, not an admin)
--   a3100157…03 aib2-out@example.com    (main workspace only)
-- Also checks, as the signed-in person, the two client paths the assistant's apply and Undo rely on:
-- bringing back a removed automation, and the dependency guard refusing to complete a blocked task.

\set ON_ERROR_STOP 1

create temporary table aia_ids (name text primary key, id uuid) on commit preserve rows;
grant all on aia_ids to authenticated, anon, service_role;
insert into aia_ids select 'ws', workspace_id from public.ai_pilot_workspaces where cleaned_at is null limit 1;

-- Grants: no new client definer; the guard is invoker; nothing for anon; RLS on.
do $$
begin
  assert (select count(*) from aia_ids where name = 'ws' and id is not null) = 1, 'zz57 left its pilot';
  assert not (select prosecdef from pg_proc where oid = 'public.guard_ai_assistant_run()'::regprocedure), 'the guard is invoker';
  assert not has_function_privilege('anon', 'public.guard_ai_assistant_run()', 'execute'), 'anon: no guard';
  assert not has_table_privilege('anon', 'public.ai_assistant_runs', 'select'), 'anon: no runs';
  assert not has_table_privilege('anon', 'public.ai_assistant_runs', 'insert'), 'anon: no inserts';
  assert (select relrowsecurity from pg_class where oid = 'public.ai_assistant_runs'::regclass), 'RLS on';
  assert has_column_privilege('authenticated', 'public.ai_assistant_runs', 'page_kind', 'insert'), 'page kind on insert';
  assert not has_column_privilege('authenticated', 'public.ai_assistant_runs', 'actor_id', 'insert'), 'the actor is never chosen';
  assert not has_column_privilege('authenticated', 'public.ai_assistant_runs', 'page_project_id', 'update'), 'the page never changes';
  assert not has_column_privilege('authenticated', 'public.ai_assistant_runs', 'applied_at', 'update'), 'the guard stamps applied_at';
  assert not has_table_privilege('authenticated', 'public.ai_assistant_runs', 'truncate'), 'no truncate';
end $$;

-- A pilot project (its creator owns it) and a main-workspace project.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100157-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid;
  s uuid;
begin
  insert into public.projects (workspace_id, name) values ((select id from aia_ids where name = 'ws'), 'AIA pilot project') returning id into p;
  insert into public.sections (project_id, name) values (p, 'To do') returning id into s;
  insert into aia_ids values ('p', p), ('s', s);
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'AIA main project') returning id into p;
  insert into aia_ids values ('main', p);
end $$;

-- Inserting: the guard sets the actor and the state; only pilot projects; pilot admins only.
do $$
declare
  ws uuid := (select id from aia_ids where name = 'ws');
  r record;
begin
  insert into public.ai_assistant_runs (workspace_id, request_key, page_kind, page_project_id, instruction_chars)
  values (ws, 'aia-run-000001', 'project', (select id from aia_ids where name = 'p'), 42) returning * into r;
  assert r.actor_id = 'a3100157-0000-4000-8000-000000000001' and r.status = 'generating' and r.proposal is null, 'normalized insert';
  insert into aia_ids values ('run', r.id);
  begin
    insert into public.ai_assistant_runs (workspace_id, request_key, page_kind, page_project_id)
    values (ws, 'aia-run-000002', 'project', (select id from aia_ids where name = 'main'));
    raise exception 'a main-workspace project was accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.ai_assistant_runs (workspace_id, request_key) values ('00000000-0000-4000-8000-000000000001', 'aia-run-000003');
    raise exception 'a run in the main workspace';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.ai_assistant_runs (workspace_id, request_key, page_kind) values (ws, 'aia-run-000004', 'evil');
    raise exception 'an unknown page kind';
  exception when check_violation then null;
  end;
end $$;

-- Another pilot admin (zz57 made the mate one) reads the run but can't change it; an outsider gets nothing.
do $$
declare
  ws uuid := (select id from aia_ids where name = 'ws');
  run uuid := (select id from aia_ids where name = 'run');
begin
  perform set_config('request.jwt.claim.sub', 'a3100157-0000-4000-8000-000000000002', true);
  assert (select count(*) from public.ai_assistant_runs where id = run) = 1, 'pilot admins read every run';
  update public.ai_assistant_runs set status = 'cancelled' where id = run;
  perform set_config('request.jwt.claim.sub', 'a3100157-0000-4000-8000-000000000003', true);
  assert (select count(*) from public.ai_assistant_runs) = 0, 'no runs for an outsider';
  update public.ai_assistant_runs set status = 'cancelled' where id = run;
  begin
    insert into public.ai_assistant_runs (workspace_id, request_key) values (ws, 'aia-run-out300');
    raise exception 'an outsider started a run';
  exception when insufficient_privilege or check_violation then null;
  end;
end $$;
do $$
begin
  assert (select status from public.ai_assistant_runs where id = (select id from aia_ids where name = 'run')) = 'generating', 'nobody else changed it';
end $$;

-- Transitions.
do $$
declare
  run uuid := (select id from aia_ids where name = 'run');
  r record;
begin
  begin
    update public.ai_assistant_runs set status = 'proposed' where id = run;
    raise exception 'proposed without a change set';
  exception when check_violation then null;
  end;
  update public.ai_assistant_runs set status = 'proposed', proposal = '{"summary":"s","ops":[],"rejected":[]}', model = 'claude-haiku-5-5',
    effort = 'low', route_reason = 'small_edit', op_count = 1, ops_summary = '{"rename_task":1}', generated_at = now() where id = run;
  begin
    update public.ai_assistant_runs set proposal = '{"summary":"changed"}' where id = run;
    raise exception 'a proposed change set changed';
  exception when check_violation then null;
  end;
  begin
    update public.ai_assistant_runs set model = 'claude-opus-5-5' where id = run;
    raise exception 'the model changed after the answer';
  exception when check_violation then null;
  end;
  begin
    update public.ai_assistant_runs set status = 'applied' where id = run;
    raise exception 'applied without applying';
  exception when check_violation then null;
  end;
  begin
    update public.ai_assistant_runs set applied = '{"records":[]}' where id = run;
    raise exception 'a record of changes before applying';
  exception when check_violation then null;
  end;
  begin
    update public.ai_assistant_runs set status = 'applying' where id = run;
    raise exception 'applying without a key';
  exception when check_violation then null;
  end;
  update public.ai_assistant_runs set status = 'applying', apply_key = 'aia-apply-0001' where id = run;
  begin
    update public.ai_assistant_runs set apply_key = 'aia-apply-0002' where id = run;
    raise exception 'a second apply key';
  exception when check_violation then null;
  end;
  update public.ai_assistant_runs set status = 'applied', applied = '{"selected":[0],"records":[]}', touched_ids = array[gen_random_uuid()] where id = run
    returning * into r;
  assert r.applied_at is not null and r.undone_at is null, 'applied_at stamped';
  update public.ai_assistant_runs set undo_conflicts = '{"changed":["x"]}' where id = run;
  update public.ai_assistant_runs set status = 'undone', undo_conflicts = null where id = run returning * into r;
  assert r.undone_at is not null, 'undone_at stamped';
  begin
    update public.ai_assistant_runs set status = 'applied' where id = run;
    raise exception 'an undone run came back';
  exception when check_violation then null;
  end;
  begin
    update public.ai_assistant_runs set page_kind = 'task' where id = run;
    raise exception 'the page changed';
  exception when insufficient_privilege or check_violation then null;
  end;
end $$;

-- Undo's client path: a removed automation comes back, as the project's Admin+, through RLS.
do $$
declare
  p uuid := (select id from aia_ids where name = 'p');
  s uuid := (select id from aia_ids where name = 's');
  rule uuid;
begin
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values (p, 'AIA move', false, 'task_created', jsonb_build_array(jsonb_build_object('type', 'move_section', 'section_id', s))) returning id into rule;
  update public.rules set deleted_at = now(), enabled = false where id = rule;
  update public.rules set deleted_at = null, enabled = true where id = rule;
  assert (select deleted_at is null and enabled from public.rules where id = rule), 'restored';
end $$;

-- The assistant's task writes are the person's own: the dependency guard refuses completing a blocked task.
do $$
declare
  p uuid := (select id from aia_ids where name = 'p');
  s uuid := (select id from aia_ids where name = 's');
  a uuid := public.create_task(p, s, 'AIA blocker');
  b uuid := public.create_task(p, s, 'AIA blocked');
begin
  perform public.set_task_dependency(a, b, 'finish_to_start', 0);
  begin
    update public.tasks set completed_at = now() where id = b;
    raise exception 'a blocked task was completed';
  exception when check_violation then null;
  end;
  assert (select completed_at is null from public.tasks where id = b), 'still open';
end $$;

-- Rate limits: two generating at once, then thirty an hour.
do $$
declare
  ws uuid := (select id from aia_ids where name = 'ws');
  run uuid;
  i int;
begin
  insert into public.ai_assistant_runs (workspace_id, request_key) values (ws, 'aia-gen-000001');
  insert into public.ai_assistant_runs (workspace_id, request_key) values (ws, 'aia-gen-000002');
  begin
    insert into public.ai_assistant_runs (workspace_id, request_key) values (ws, 'aia-gen-000003');
    raise exception 'a third request generating at once';
  exception when program_limit_exceeded then null;
  end;
  update public.ai_assistant_runs set status = 'failed', error_code = 'timeout' where status = 'generating';
  for i in 4 .. 30 loop
    insert into public.ai_assistant_runs (workspace_id, request_key) values (ws, 'aia-lim-' || lpad(i::text, 6, '0')) returning id into run;
    update public.ai_assistant_runs set status = 'cancelled' where id = run;
  end loop;
  assert (select count(*) from public.ai_assistant_runs) = 30, 'thirty runs this hour';
  begin
    insert into public.ai_assistant_runs (workspace_id, request_key) values (ws, 'aia-lim-limit1');
    raise exception 'a thirty-first run in an hour';
  exception when program_limit_exceeded then null;
  end;
end $$;

reset role;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset

select 'zz58_ai_assistant_smoke: ok';
