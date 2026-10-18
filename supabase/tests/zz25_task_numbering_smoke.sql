-- Task numbering: turn on and number existing tasks in creation order, the next new task,
-- subtask paths, reuse of trashed numbers, a start number, template rendering, and label
-- functions that a non-member cannot read.
--   b5b5…01 tn-owner@example.com   owner
--   b5b5…02 tn-editor@example.com  editor
--   b5b5…03 tn-viewer@example.com  viewer
--   b5b5…04 tn-out@example.com     allowlisted, not a member

\set ON_ERROR_STOP 1

create temporary table tn_ids (name text primary key, id uuid) on commit preserve rows;
grant all on tn_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('tn-owner@example.com', 'task numbering'),
  ('tn-editor@example.com', 'task numbering'),
  ('tn-viewer@example.com', 'task numbering'),
  ('tn-out@example.com', 'task numbering');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b5b5b5b5-0000-4000-8000-000000000001', 'tn-owner@example.com', now(), '{"full_name":"Nina Owner"}'),
  ('b5b5b5b5-0000-4000-8000-000000000002', 'tn-editor@example.com', now(), '{"full_name":"Ned Editor"}'),
  ('b5b5b5b5-0000-4000-8000-000000000003', 'tn-viewer@example.com', now(), '{"full_name":"Vera Viewer"}'),
  ('b5b5b5b5-0000-4000-8000-000000000004', 'tn-out@example.com', now(), '{"full_name":"Otto Outsider"}');

do $$
begin
  assert not (select prosecdef from pg_proc where oid = 'public.format_request_label(uuid, bigint)'::regprocedure),
    'format_request_label is invoker';
  assert not (select prosecdef from pg_proc where oid = 'public.task_request_label(uuid)'::regprocedure),
    'task_request_label is invoker';
  assert (select prosecdef from pg_proc where oid = 'public.apply_task_numbering(uuid, jsonb, text)'::regprocedure),
    'apply_task_numbering checks membership itself';
  assert pg_get_functiondef('public.allocate_request_number(uuid, text, text)'::regprocedure) like '%for update%',
    'the counter row is locked';
  assert exists (
    select 1 from pg_index i
    join pg_class c on c.oid = i.indexrelid
    where c.relname = 'tasks_req_number_scope_idx'
  ), 'active numbers are unique per project, period, and counter';
  assert not exists (select 1 from pg_class where relname = 'tasks_req_number_idx'),
    'the old index that also covered trashed tasks is gone';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b5b5b5b5-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  p uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'Numbered work')
    returning id into p;
  perform public.add_project_member(p, 'tn-editor@example.com', 'editor');
  perform public.add_project_member(p, 'tn-viewer@example.com', 'viewer');
  insert into tn_ids values ('p', p);
end $$;

do $$
declare
  p uuid := (select id from tn_ids where name = 'p');
  t uuid;
begin
  t := public.create_task(p, null, 'First');
  insert into tn_ids values ('a', t);
end $$;

do $$
declare
  p uuid := (select id from tn_ids where name = 'p');
  t uuid;
begin
  t := public.create_task(p, null, 'Second');
  insert into tn_ids values ('b', t);
end $$;

do $$
declare
  p uuid := (select id from tn_ids where name = 'p');
  t uuid;
begin
  t := public.create_task(p, null, 'Third');
  insert into tn_ids values ('c', t);
end $$;

do $$
declare
  p uuid := (select id from tn_ids where name = 'p');
  result jsonb;
begin
  result := public.apply_task_numbering(p, jsonb_build_object(
    'enabled', true,
    'template', 'Req #{n}',
    'wrap_brackets', true,
    'add_to_title', false,
    'number_scope', 'all_tasks',
    'number_subtasks', true,
    'subtask_separator', '.',
    'start_number', 484,
    'reuse_deleted', false
  ), 'number_missing');
  assert (result ->> 'numbered')::int = 3, format('three existing tasks numbered: %s', result);
  assert (select req_number from public.tasks where id = (select id from tn_ids where name = 'a')) = 484, 'oldest task is 484';
  assert (select req_number from public.tasks where id = (select id from tn_ids where name = 'b')) = 485, 'next is 485';
  assert (select req_number from public.tasks where id = (select id from tn_ids where name = 'c')) = 486, 'then 486';
  assert (select title from public.tasks where id = (select id from tn_ids where name = 'a')) = 'First',
    'the number is not baked into the title';
  assert public.task_request_label((select id from tn_ids where name = 'a')) = 'Req #484', 'template rendering';
end $$;

do $$
declare
  p uuid := (select id from tn_ids where name = 'p');
  t uuid;
  child uuid;
begin
  t := public.create_task(p, null, 'Fourth');
  insert into tn_ids values ('d', t);
  assert (select req_number from public.tasks where id = t) = 487, 'a new task gets the next number';
  child := public.create_subtask((select id from tn_ids where name = 'a'), 'Part');
  insert into tn_ids values ('child', child);
  assert (select req_number is null and req_path = '484.1' and req_subindex = 1 from public.tasks where id = child),
    'a subtask is 484.1';
  assert public.task_request_label(child) = 'Req #484.1', 'subtask label';
  begin
    perform public.assign_request_number(child);
    raise exception 'on-demand numbering still refuses a subtask';
  exception when check_violation then null;
  end;
end $$;

do $$
declare
  p uuid := (select id from tn_ids where name = 'p');
  t uuid;
begin
  perform public.apply_task_numbering(p, jsonb_build_object('enabled', true, 'reuse_deleted', true, 'template', 'Req #{n}', 'number_scope', 'all_tasks'), 'save');
  update public.tasks set deleted_at = now() where id = (select id from tn_ids where name = 'b');
  t := public.create_task(p, null, 'Reused');
  insert into tn_ids values ('e', t);
  assert (select req_number from public.tasks where id = t) = 485, 'the trashed number is reused';
  perform public.apply_task_numbering(p, jsonb_build_object('enabled', true, 'reuse_deleted', false, 'template', 'Req #{n}', 'number_scope', 'all_tasks'), 'save');
  update public.tasks set deleted_at = now() where id = (select id from tn_ids where name = 'c');
  t := public.create_task(p, null, 'Not reused');
  assert (select req_number from public.tasks where id = t) = 488, 'with reuse off the next number is not a gap';
end $$;

do $$
declare
  p uuid := (select id from tn_ids where name = 'p');
begin
  perform public.apply_task_numbering(p, jsonb_build_object('enabled', true, 'template', 'JOB-{n:4}', 'number_scope', 'all_tasks'), 'save');
  assert public.task_request_label((select id from tn_ids where name = 'a')) = 'JOB-0484', 'a padded template';
  perform public.apply_task_numbering(p, jsonb_build_object('enabled', false, 'template', 'Req #{n}', 'number_scope', 'all_tasks'), 'save');
  assert public.task_request_label((select id from tn_ids where name = 'a')) is null, 'turning numbering off hides the label';
  assert (select req_number from public.tasks where id = (select id from tn_ids where name = 'a')) = 484, 'the stored number stays';
  perform public.apply_task_numbering(p, jsonb_build_object('enabled', true, 'template', 'Req #{n}', 'number_scope', 'all_tasks'), 'save');
end $$;

select set_config('request.jwt.claim.sub', 'b5b5b5b5-0000-4000-8000-000000000003', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from tn_ids where name = 'p');
begin
  begin
    perform public.apply_task_numbering(p, '{"enabled": true}'::jsonb, 'save');
    raise exception 'a viewer cannot change numbering';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'b5b5b5b5-0000-4000-8000-000000000004', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from tn_ids where name = 'p');
  t uuid := (select id from tn_ids where name = 'a');
begin
  assert public.task_request_label(t) is null, 'a non-member cannot read a task label';
  assert public.format_request_label(p, 484) is null, 'a non-member cannot format a project label';
  begin
    perform public.apply_task_numbering(p, '{"enabled": true}'::jsonb, 'save');
    raise exception 'a non-member cannot change numbering';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'b5b5b5b5-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from tn_ids where name = 'p');
begin
  perform public.apply_task_numbering(p, jsonb_build_object('enabled', true, 'template', 'Req #{n}', 'number_scope', 'all_tasks'), 'save');
  assert (select enabled from public.request_sequences where project_id = p), 'an editor can save numbering';
end $$;

select 'task numbering smoke: ok' as result;
