-- Behavioural checks for the core-spine migration: allowlist gate, RLS, multi-homing, soft delete.
-- Run via supabase/tests/run.sh. Any failed assertion aborts with a non-zero exit.

\set ON_ERROR_STOP 1

-- Fixtures (as the migration owner, bypassing RLS) ---------------------------------------------

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('11111111-1111-4111-8111-111111111111', 'Member@Example.com', now(), '{"full_name":"Member One"}'),
  ('22222222-2222-4222-8222-222222222222', 'outsider@example.com', now(), '{}'),
  ('33333333-3333-4333-8333-333333333333', 'unconfirmed@example.com', null, '{}');

insert into public.allowed_emails (email, note) values
  ('  MEMBER@example.com ', 'test member'),
  ('unconfirmed@example.com', 'never confirmed');

do $$
begin
  assert (select count(*) from public.allowed_emails where email = 'member@example.com') = 1,
    'allowlist emails are normalised to lowercase';
  assert (select full_name from public.profiles where id = '11111111-1111-4111-8111-111111111111') = 'Member One',
    'allowlisting an existing auth user backfills their profile';
  assert not exists (select 1 from public.profiles where id = '22222222-2222-4222-8222-222222222222'),
    'non-allowlisted users get no profile';
end $$;

insert into public.allowed_emails (email) values ('later@example.com');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('44444444-4444-4444-8444-444444444444', 'later@example.com', now(), '{"name":"Later Person"}');

do $$
begin
  assert (select full_name from public.profiles where id = '44444444-4444-4444-8444-444444444444') = 'Later Person',
    'signing up with an allowlisted email creates a profile';
end $$;

-- Outsider: authenticated but not allowlisted ----------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false) is not null as ok \gset

do $$
begin
  assert not public.is_allowlisted(), 'outsider is not allowlisted';
  assert (select count(*) from public.workspaces) = 0, 'outsider cannot read workspaces';
  assert (select count(*) from public.profiles) = 0, 'outsider cannot read profiles';
  begin
    insert into public.projects (workspace_id, name)
    values ('00000000-0000-4000-8000-000000000001', 'Sneaky');
    raise exception 'outsider project insert should have failed';
  exception when insufficient_privilege then
    null;
  end;
end $$;

-- Unconfirmed email on the allowlist is still rejected -------------------------------------------

select set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', false) is not null as ok \gset

do $$
begin
  assert not public.is_allowlisted(), 'unconfirmed email is not treated as allowlisted';
end $$;

-- Member: full core-spine flow -------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  p1 uuid;
  p2 uuid;
  s_todo uuid;
  s_doing uuid;
  s_p2 uuid;
  t1 uuid;
  st1 uuid;
  affected int;
begin
  assert public.is_allowlisted(), 'member is allowlisted';
  assert (select count(*) from public.workspaces) = 1, 'member sees the default workspace';

  insert into public.projects (workspace_id, name) values (ws, 'Launch') returning id into p1;
  insert into public.projects (workspace_id, name) values (ws, 'Brand') returning id into p2;
  assert (select created_by from public.projects where id = p1) = '11111111-1111-4111-8111-111111111111',
    'created_by defaults to the caller';

  insert into public.sections (project_id, name, sort_order) values (p1, 'To do', 1024) returning id into s_todo;
  insert into public.sections (project_id, name, sort_order) values (p1, 'Doing', 2048) returning id into s_doing;
  insert into public.sections (project_id, name, sort_order) values (p2, 'Inbox', 1024) returning id into s_p2;

  insert into public.tasks (home_project_id, title) values (p1, 'Write brief') returning id into t1;
  assert (select workspace_id from public.tasks where id = t1) = ws, 'task workspace follows home project';
  assert exists (
    select 1 from public.task_projects where task_id = t1 and project_id = p1 and deleted_at is null
  ), 'home membership is created automatically';

  update public.task_projects set section_id = s_todo where task_id = t1 and project_id = p1;

  begin
    update public.task_projects set section_id = s_p2 where task_id = t1 and project_id = p1;
    raise exception 'cross-project section should have failed';
  exception when foreign_key_violation then
    null;
  end;

  insert into public.task_projects (task_id, project_id, section_id, sort_order) values (t1, p2, s_p2, 1024);
  assert (select count(*) from public.task_projects where task_id = t1 and deleted_at is null) = 2,
    'task is multi-homed in two projects';

  update public.task_projects set section_id = s_doing where task_id = t1 and project_id = p1;
  assert (select section_id from public.task_projects where task_id = t1 and project_id = p2) = s_p2,
    'moving within one project leaves the other membership alone';

  begin
    update public.task_projects set deleted_at = now() where task_id = t1 and project_id = p1;
    raise exception 'removing home membership should have failed';
  exception when check_violation then
    null;
  end;

  update public.task_projects set deleted_at = now() where task_id = t1 and project_id = p2;
  assert (select count(*) from public.task_projects where task_id = t1 and deleted_at is null) = 1,
    'non-home membership can be soft-removed';

  update public.tasks set completed_at = now() where id = t1;
  update public.tasks set completed_at = null where id = t1;

  insert into public.subtasks (task_id, title, sort_order) values (t1, 'Collect assets', 1024) returning id into st1;
  update public.subtasks set completed_at = now() where id = st1;
  update public.subtasks set deleted_at = now() where id = st1;
  assert (select deleted_at is not null from public.subtasks where id = st1), 'subtask soft-deleted';

  update public.sections set deleted_at = now() where id = s_doing;
  assert (select section_id from public.task_projects where task_id = t1 and project_id = p1) is null,
    'soft-deleting a section releases its tasks to no section';

  delete from public.tasks where id = t1;
  get diagnostics affected = row_count;
  assert affected = 0, 'hard delete is blocked by RLS (no delete policy)';

  update public.tasks set deleted_at = now() where id = t1;
  assert (select deleted_at is not null from public.tasks where id = t1), 'task soft-deleted';

  begin
    insert into public.allowed_emails (email) values ('self-service@example.com');
    raise exception 'members should not be able to edit the allowlist';
  exception when insufficient_privilege then
    null;
  end;

  update public.profiles set full_name = 'Renamed' where id = '44444444-4444-4444-8444-444444444444';
  get diagnostics affected = row_count;
  assert affected = 0, 'members cannot edit other profiles';
end $$;

-- Anonymous callers ------------------------------------------------------------------------------

reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset

do $$
begin
  assert (select count(*) from public.projects) = 0, 'anon cannot read projects';
  begin
    perform public.is_allowlisted();
    raise exception 'anon should not be able to execute is_allowlisted';
  exception when insufficient_privilege then
    null;
  end;
end $$;

reset role;
select 'rls smoke: all assertions passed' as result;
