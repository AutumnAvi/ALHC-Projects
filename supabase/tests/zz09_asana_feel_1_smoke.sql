-- Behavioural checks for Phase: Asana feel, batch 1: the "tags" view column and List column widths
-- per person per project (own rows only, Viewer+ of the project, validated shape, anon gets nothing).
-- Fresh people for this suite (no memberships from earlier suites):
--   f9f9…01 af-owner@example.com    owner of AF P
--   f9f9…02 af-viewer@example.com   Viewer of AF P
--   f9f9…03 af-other@example.com    no memberships

\set ON_ERROR_STOP 1

create temporary table af_ids (name text primary key, id uuid) on commit preserve rows;
grant all on af_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('af-owner@example.com', 'asana feel suite'),
  ('af-viewer@example.com', 'asana feel suite'),
  ('af-other@example.com', 'asana feel suite');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('f9f9f9f9-0000-4000-8000-000000000001', 'af-owner@example.com', now(), '{"full_name":"Ava Owner"}'),
  ('f9f9f9f9-0000-4000-8000-000000000002', 'af-viewer@example.com', now(), '{"full_name":"Val Viewer"}'),
  ('f9f9f9f9-0000-4000-8000-000000000003', 'af-other@example.com', now(), '{"full_name":"Otto Other"}');
insert into af_ids values
  ('owner', 'f9f9f9f9-0000-4000-8000-000000000001'),
  ('viewer', 'f9f9f9f9-0000-4000-8000-000000000002'),
  ('other', 'f9f9f9f9-0000-4000-8000-000000000003');

set role authenticated;
select set_config('request.jwt.claim.sub', 'f9f9f9f9-0000-4000-8000-000000000001', false) is not null as ok \gset

-- Views: a Tags column ------------------------------------------------------------------------------

do $$
declare
  p uuid;
  f uuid;
  v uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'AF P') returning id into p;
  perform public.add_project_member(p, 'af-viewer@example.com', 'viewer');
  insert into public.custom_fields (project_id, name, field_type) values (p, 'Priority', 'single_select') returning id into f;
  insert into af_ids values ('p', p), ('f', f);

  insert into public.project_views (project_id, name, layout, config)
  values (p, 'With tags', 'list', jsonb_build_object('columns', jsonb_build_array('assignee', 'due', 'field:' || f, 'tags')))
  returning id into v;
  assert (select config -> 'columns' ? 'tags' from public.project_views where id = v), 'a view can save a Tags column';

  begin
    insert into public.project_views (project_id, name, layout, config) values (p, 'Bad', 'list', '{"columns":["labels"]}');
    raise exception 'unknown column keys are still refused';
  exception when check_violation then null;
  end;
end $$;

-- Column widths: own rows, validated ------------------------------------------------------------------

do $$
declare
  p uuid := (select id from af_ids where name = 'p');
  f uuid := (select id from af_ids where name = 'f');
  stored jsonb;
begin
  stored := public.set_list_column_widths(p, jsonb_build_object('task', 320, 'assignee', 160, 'field:' || f, 120, 'tags', 200));
  assert stored ->> 'task' = '320', 'the owner saves widths';
  stored := public.set_list_column_widths(p, '{"task": 280}');
  assert stored = '{"task": 280}'::jsonb, 'saving again replaces the widths (upsert)';
  assert (select count(*) from public.list_column_widths where project_id = p) = 1, 'one row per person and project';
  assert (select profile_id from public.list_column_widths where project_id = p) = (select id from af_ids where name = 'owner'),
    'the row is the caller''s';

  begin
    perform public.set_list_column_widths(p, '{"title": 200}');
    raise exception 'unknown keys are refused';
  exception when check_violation then null;
  end;
  begin
    perform public.set_list_column_widths(p, '{"task": 20}');
    raise exception 'too narrow is refused';
  exception when check_violation then null;
  end;
  begin
    perform public.set_list_column_widths(p, '{"task": 200.5}');
    raise exception 'fractions are refused';
  exception when check_violation then null;
  end;
  begin
    perform public.set_list_column_widths(p, '[200]');
    raise exception 'an array is refused';
  exception when check_violation then null;
  end;

  -- Nobody writes a row for someone else.
  begin
    insert into public.list_column_widths (profile_id, project_id, widths)
    values ((select id from af_ids where name = 'viewer'), p, '{}');
    raise exception 'profile_id is not insertable by clients';
  exception when insufficient_privilege then null;
  end;
end $$;

-- A Viewer keeps their own widths and never sees the owner's.
select set_config('request.jwt.claim.sub', 'f9f9f9f9-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from af_ids where name = 'p');
begin
  assert not exists (select 1 from public.list_column_widths), 'other people''s widths are invisible';
  perform public.set_list_column_widths(p, '{"task": 400, "due": 96}');
  assert (select widths ->> 'task' from public.list_column_widths where project_id = p) = '400', 'a Viewer saves their own';
  update public.list_column_widths set widths = '{"task": 500}' where profile_id = (select id from af_ids where name = 'owner');
  assert (select count(*) from public.list_column_widths) = 1, 'still only their own row';
end $$;

-- A non-member gets nothing.
select set_config('request.jwt.claim.sub', 'f9f9f9f9-0000-4000-8000-000000000003', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from af_ids where name = 'p');
begin
  begin
    perform public.set_list_column_widths(p, '{"task": 300}');
    raise exception 'a non-member can''t save widths for the project';
  exception when no_data_found then null;
  end;
  begin
    insert into public.list_column_widths (project_id, widths) values (p, '{}');
    raise exception 'RLS refuses a direct insert too';
  exception when insufficient_privilege then null;
  end;
  assert not exists (select 1 from public.list_column_widths), 'and reads nothing';
end $$;

reset role;

do $$
begin
  assert (select widths ->> 'task' from public.list_column_widths
          where profile_id = 'f9f9f9f9-0000-4000-8000-000000000001') = '280', 'the Viewer''s update didn''t touch the owner''s row';
  assert not has_table_privilege('anon', 'public.list_column_widths', 'select, insert, update'), 'anon gets nothing';
  assert not has_function_privilege('anon', 'public.set_list_column_widths(uuid, jsonb)', 'execute'), 'anon can''t execute the RPC';
  assert not (select prosecdef from pg_proc where oid = 'public.set_list_column_widths(uuid, jsonb)'::regprocedure),
    'set_list_column_widths is invoker';
end $$;

select 'zz09 asana feel 1 smoke: ok' as result;
