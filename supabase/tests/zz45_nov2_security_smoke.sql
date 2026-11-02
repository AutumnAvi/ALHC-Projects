-- Nov 2 security fix (20261102030000_nov2_security_a.sql), note 119: "a project Viewer can delete tasks".
-- Every destructive or editing write a Viewer or a Commenter might try on a task, subtask, section,
-- attachment, comment, field, field value, tag, dependency, or follower is refused (RLS's silent zero
-- rows, or an error), an Editor's is allowed, trash_task says why it can't, and the trash guard stands
-- behind RLS.
--   b1190000…01 sec-owner@example.com      Olive Owner (owns project P)
--   b1190000…02 sec-editor@example.com     Eddie Editor (Editor of P)
--   b1190000…03 sec-commenter@example.com  Cora Commenter (Commenter of P)
--   b1190000…04 sec-viewer@example.com     Vic Viewer (Viewer of P)

\set ON_ERROR_STOP 1

update public.workspaces set allow_commenter_role = true;

create temporary table sec_ids (name text primary key, id uuid) on commit preserve rows;
grant all on sec_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('sec-owner@example.com', 'security'),
  ('sec-editor@example.com', 'security'),
  ('sec-commenter@example.com', 'security'),
  ('sec-viewer@example.com', 'security');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b1190000-0000-4000-8000-000000000001', 'sec-owner@example.com', now(), '{"full_name":"Olive Owner"}'),
  ('b1190000-0000-4000-8000-000000000002', 'sec-editor@example.com', now(), '{"full_name":"Eddie Editor"}'),
  ('b1190000-0000-4000-8000-000000000003', 'sec-commenter@example.com', now(), '{"full_name":"Cora Commenter"}'),
  ('b1190000-0000-4000-8000-000000000004', 'sec-viewer@example.com', now(), '{"full_name":"Vic Viewer"}');

-- ---------------------------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------------------------

do $$
begin
  assert has_function_privilege('authenticated', 'public.trash_task(uuid)', 'execute'), 'people call trash_task';
  assert not has_function_privilege('anon', 'public.trash_task(uuid)', 'execute'), 'anon can''t';
  assert not (select prosecdef from pg_proc where oid = 'public.trash_task(uuid)'::regprocedure), 'invoker';
  assert not (select prosecdef from pg_proc where oid = 'public.guard_trash_change()'::regprocedure), 'the guard is invoker';
  assert not has_function_privilege('anon', 'public.guard_trash_change()', 'execute'), 'anon can''t run the guard';
  assert (select count(*) from pg_trigger where tgname in
    ('tasks_00_guard_trash', 'sections_00_guard_trash', 'custom_fields_00_guard_trash', 'task_attachments_00_guard_trash')
    and not tgisinternal) = 4, 'the trash guard sits on tasks, sections, fields, and attachments';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Setup (as the owner)
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'b1190000-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid;
  s uuid;
  t uuid;
  t2 uuid;
  st uuid;
  f uuid;
  tg uuid;
  c uuid;
  a uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'Security P')
    returning id into p;
  perform public.add_project_member(p, 'sec-editor@example.com', 'editor');
  perform public.add_project_member(p, 'sec-commenter@example.com', 'commenter');
  perform public.add_project_member(p, 'sec-viewer@example.com', 'viewer');
  insert into public.sections (project_id, name) values (p, 'Doing') returning id into s;
  t := public.create_task(p, s, 'Guarded task');
  t2 := public.create_task(p, s, 'Second task');
  st := public.create_subtask(t, 'Guarded subtask', null);
  insert into public.custom_fields (project_id, name, field_type) values (p, 'Notes', 'text') returning id into f;
  insert into public.task_field_values (task_id, field_id, value) values (t, f, '"keep"');
  insert into public.tags (name, color) values ('sec-tag', 'blue') returning id into tg;
  insert into public.task_tags (task_id, tag_id) values (t, tg);
  insert into public.comments (task_id, body) values (t, 'Owner comment') returning id into c;
  insert into public.task_attachments (task_id, storage_path, file_name, content_type, size_bytes, uploaded_by)
    values (t, t::text || '/a-file.pdf', 'file.pdf', 'application/pdf', 10, 'b1190000-0000-4000-8000-000000000001')
    returning id into a;
  perform public.set_task_dependency(t, t2, 'finish_to_start', 0);
  insert into sec_ids values ('p', p), ('s', s), ('t', t), ('t2', t2), ('st', st), ('f', f), ('tag', tg), ('c', c), ('a', a);
end $$;

-- A tiny assert helper: the statement either raises or changes no rows.
create function pg_temp.refused(stmt text) returns boolean
language plpgsql as $$
declare
  n integer;
begin
  execute stmt;
  get diagnostics n = row_count;
  return n = 0;
exception when others then
  return true;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Viewer and Commenter: every destructive or editing write is refused
-- ---------------------------------------------------------------------------------------------

create function pg_temp.check_refused(who text) returns void
language plpgsql as $$
declare
  p uuid := (select id from sec_ids where name = 'p');
  s uuid := (select id from sec_ids where name = 's');
  t uuid := (select id from sec_ids where name = 't');
  t2 uuid := (select id from sec_ids where name = 't2');
  st uuid := (select id from sec_ids where name = 'st');
  f uuid := (select id from sec_ids where name = 'f');
  tg uuid := (select id from sec_ids where name = 'tag');
  c uuid := (select id from sec_ids where name = 'c');
  a uuid := (select id from sec_ids where name = 'a');
  dep uuid := (select d.id from public.task_dependencies d where d.predecessor_id = t and d.deleted_at is null limit 1);
  result jsonb;
begin
  -- note 119 itself
  assert pg_temp.refused(format('update public.tasks set deleted_at = now() where id = %L', t)), who || ': trash a task';
  assert pg_temp.refused(format('update public.tasks set deleted_at = now() where id = %L', st)), who || ': trash a subtask';
  begin
    perform public.trash_task(t);
    assert false, who || ': trash_task must refuse';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform public.trash_task(st);
    assert false, who || ': trash_task must refuse a subtask';
  exception when insufficient_privilege then
    null;
  end;
  result := public.bulk_update_tasks(array[t, t2], '{"action":"delete"}');
  assert jsonb_array_length(result -> 'updated') = 0 and jsonb_array_length(result -> 'skipped') = 2, who || ': bulk delete skips both';
  -- editing tasks and subtasks
  assert pg_temp.refused(format('update public.tasks set title = %L where id = %L', 'x', t)), who || ': rename';
  assert pg_temp.refused(format('update public.tasks set completed_at = now() where id = %L', t2)), who || ': complete';
  assert pg_temp.refused(format('update public.tasks set due_on = current_date where id = %L', t)), who || ': due date';
  assert pg_temp.refused(format('update public.tasks set title = %L where id = %L', 'x', st)), who || ': rename a subtask';
  assert pg_temp.refused(format('select public.create_subtask(%L, %L, null)', t, 'sneaky')), who || ': add a subtask';
  assert pg_temp.refused(format('select public.create_task(%L, %L, %L)', p, s, 'sneaky')), who || ': add a task';
  assert pg_temp.refused(format('select public.place_task(%L, %L, %L, null)', t, p, s)), who || ': reorder';
  assert pg_temp.refused(format('select public.place_subtask(%L, null, null)', st)), who || ': reorder a subtask';
  assert pg_temp.refused(format('select public.duplicate_task(%L, %L)', t, '{}')), who || ': duplicate';
  assert pg_temp.refused(format('select public.convert_to_subtask(%L, %L)', t2, t)), who || ': convert';
  assert pg_temp.refused(format('update public.task_projects set deleted_at = now() where task_id = %L', t)), who || ': remove from project';
  -- sections and fields
  assert pg_temp.refused(format('update public.sections set deleted_at = now() where id = %L', s)), who || ': trash a section';
  assert pg_temp.refused(format('update public.sections set name = %L where id = %L', 'x', s)), who || ': rename a section';
  assert pg_temp.refused(format('update public.custom_fields set deleted_at = now() where id = %L', f)), who || ': trash a field';
  assert pg_temp.refused(format('update public.task_field_values set value = %L where task_id = %L and field_id = %L', '"x"', t, f)),
    who || ': change a field value';
  -- attachments, tags, dependencies
  assert pg_temp.refused(format('update public.task_attachments set deleted_at = now() where id = %L', a)), who || ': remove an attachment';
  assert pg_temp.refused(format('update public.task_tags set deleted_at = now() where task_id = %L', t)), who || ': remove a tag';
  assert pg_temp.refused(format('insert into public.task_tags (task_id, tag_id) values (%L, %L)', t2, tg)), who || ': add a tag';
  assert pg_temp.refused(format('select public.remove_task_dependency(%L)', dep)), who || ': remove a dependency';
  assert pg_temp.refused(format('select public.set_task_dependency(%L, %L, %L, 0)', t2, st, 'finish_to_start')), who || ': add a dependency';
  -- someone else's comment; removing someone else as a follower
  assert pg_temp.refused(format('update public.comments set deleted_at = now() where id = %L', c)), who || ': remove another''s comment';
  assert pg_temp.refused(format('update public.comments set body = %L where id = %L', 'x', c)), who || ': edit another''s comment';
  assert pg_temp.refused(format(
    'insert into public.task_followers (task_id, profile_id, deleted_at) values (%L, %L, now()) '
    'on conflict (task_id, profile_id) do update set deleted_at = excluded.deleted_at',
    t, 'b1190000-0000-4000-8000-000000000001')), who || ': remove another follower';
  -- restoring needs Editor too
  assert pg_temp.refused(format('select public.restore_task(%L)', t)), who || ': restore';
end;
$$;

select set_config('request.jwt.claim.sub', 'b1190000-0000-4000-8000-000000000004', false) is not null as ok \gset
select pg_temp.check_refused('viewer');
select set_config('request.jwt.claim.sub', 'b1190000-0000-4000-8000-000000000003', false) is not null as ok \gset
select pg_temp.check_refused('commenter');

-- Nothing changed.
reset role;
do $$
begin
  assert not exists (select 1 from public.tasks where id in (select id from sec_ids where name in ('t', 't2', 'st')) and deleted_at is not null),
    'no task or subtask was trashed';
  assert (select title from public.tasks where id = (select id from sec_ids where name = 't')) = 'Guarded task', 'title kept';
  assert (select deleted_at is null from public.sections where id = (select id from sec_ids where name = 's')), 'section kept';
  assert (select deleted_at is null from public.custom_fields where id = (select id from sec_ids where name = 'f')), 'field kept';
  assert (select deleted_at is null from public.task_attachments where id = (select id from sec_ids where name = 'a')), 'attachment kept';
  assert (select deleted_at is null from public.comments where id = (select id from sec_ids where name = 'c')), 'comment kept';
  assert (select count(*) from public.task_tags where task_id = (select id from sec_ids where name = 't') and deleted_at is null) = 1, 'tag kept';
  assert (select count(*) from public.task_dependencies where predecessor_id = (select id from sec_ids where name = 't') and deleted_at is null) = 1,
    'dependency kept';
  assert exists (select 1 from public.task_followers where task_id = (select id from sec_ids where name = 't')
    and profile_id = 'b1190000-0000-4000-8000-000000000001' and deleted_at is null), 'the owner still follows';
end $$;

-- ---------------------------------------------------------------------------------------------
-- What a Commenter still does: follow / unfollow themselves, add a follower, comment, remove their own
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'b1190000-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from sec_ids where name = 't');
  mine uuid;
begin
  insert into public.task_followers (task_id, profile_id) values (t, 'b1190000-0000-4000-8000-000000000003')
    on conflict (task_id, profile_id) do update set deleted_at = excluded.deleted_at;
  insert into public.task_followers (task_id, profile_id, deleted_at) values (t, 'b1190000-0000-4000-8000-000000000003', now())
    on conflict (task_id, profile_id) do update set deleted_at = excluded.deleted_at;
  insert into public.task_followers (task_id, profile_id) values (t, 'b1190000-0000-4000-8000-000000000004')
    on conflict (task_id, profile_id) do update set deleted_at = excluded.deleted_at;
  assert exists (select 1 from public.task_followers where task_id = t and profile_id = 'b1190000-0000-4000-8000-000000000004' and deleted_at is null),
    'a commenter adds someone who can open the task';
  insert into public.comments (task_id, body) values (t, 'Commenter note') returning id into mine;
  update public.comments set deleted_at = now() where id = mine;
  assert found, 'a commenter removes their own comment';
end $$;

-- ---------------------------------------------------------------------------------------------
-- An Editor: removes followers, trashes and restores with trash_task / restore_task
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'b1190000-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from sec_ids where name = 't');
  st uuid := (select id from sec_ids where name = 'st');
  stamp timestamptz;
begin
  insert into public.task_followers (task_id, profile_id, deleted_at) values (t, 'b1190000-0000-4000-8000-000000000004', now())
    on conflict (task_id, profile_id) do update set deleted_at = excluded.deleted_at;
  assert exists (select 1 from public.task_followers where task_id = t and profile_id = 'b1190000-0000-4000-8000-000000000004' and deleted_at is not null),
    'an editor removes a follower';

  stamp := public.trash_task(st);
  assert stamp is not null, 'an editor trashes a subtask';
  assert public.trash_task(st) = stamp, 'trashing again is a no-op that answers the same time';
  stamp := public.trash_task(t);
  assert (select deleted_at from public.tasks where id = t) = stamp, 'an editor trashes a task';
  perform public.restore_task(t);
  assert (select deleted_at is null from public.tasks where id = t), 'and restores it';
  begin
    perform public.trash_task('b1190000-0000-4000-8000-0000000000ff');
    assert false, 'unknown task';
  exception when no_data_found then
    null;
  end;
end $$;

-- The guard stands behind RLS: even a write RLS lets through is refused below Editor. Simulate a looser
-- update policy by acting as a Viewer whose RLS check passes (a permissive test-only policy in a
-- rolled-back transaction).
reset role;
begin;
create policy sec_test_loose on public.tasks for update to authenticated using (true) with check (true);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1190000-0000-4000-8000-000000000004', true) is not null as ok \gset
do $$
begin
  begin
    update public.tasks set deleted_at = now() where id = (select id from sec_ids where name = 't2');
    assert false, 'the guard refuses a viewer even past RLS';
  exception when insufficient_privilege then
    null;
  end;
end $$;
rollback;

reset role;
update public.workspaces set allow_commenter_role = false;

select 'nov2 security smoke: all assertions passed' as result;
