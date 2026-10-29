-- Oct 29 notes, batch 7, track T2 (fields) (20261029010200_b7_t2_fields.sql; ships inside
-- 20261029010000_oct29_batch7_a.sql).
--   b7f20029…01 b7f-owner@example.com   owner of B7F A, owner of the B7F portfolio
--   b7f20029…02 b7f-editor@example.com  Editor of B7F A, Editor of the B7F portfolio
--   b7f20029…03 b7f-viewer@example.com  Viewer of B7F A

\set ON_ERROR_STOP 1

insert into public.allowed_emails (email, note) values
  ('b7f-owner@example.com', 'oct 29 batch 7 fields'),
  ('b7f-editor@example.com', 'oct 29 batch 7 fields'),
  ('b7f-viewer@example.com', 'oct 29 batch 7 fields');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b7f20029-0000-4000-8000-000000000001', 'b7f-owner@example.com', now(), '{"full_name":"Fern Owner"}'),
  ('b7f20029-0000-4000-8000-000000000002', 'b7f-editor@example.com', now(), '{"full_name":"Finn Editor"}'),
  ('b7f20029-0000-4000-8000-000000000003', 'b7f-viewer@example.com', now(), '{"full_name":"Faye Viewer"}');

create temporary table b7f_ids (name text primary key, id uuid);
grant all on b7f_ids to authenticated, anon;

-- ---------------------------------------------------------------------------------------------
-- Setup: project B7F A and portfolio B7F P
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  a uuid;
  p uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B7F A') returning id into a;
  perform public.add_project_member(a, 'b7f-editor@example.com', 'editor');
  perform public.add_project_member(a, 'b7f-viewer@example.com', 'viewer');
  insert into public.portfolios (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B7F P') returning id into p;
  perform public.add_portfolio_member(p, 'b7f-editor@example.com', 'editor');
  insert into b7f_ids values ('a', a), ('p', p);
end $$;

-- ---------------------------------------------------------------------------------------------
-- 47. Select fields need at least one option (people; system paths are untouched).
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b7f_ids where name = 'a');
  f uuid;
  status_field uuid;
  t uuid;
  opts jsonb := '[{"id": "o1", "name": "High", "color": "red"}, {"id": "o2", "name": "Low", "color": "zinc"}]';
begin
  -- No options: refused for single- and multi-select, whether options are left out or sent empty.
  begin
    insert into public.custom_fields (project_id, name, field_type) values (a, 'Priority', 'single_select');
    raise exception 'a single-select with no options must be refused';
  exception when check_violation then
    assert sqlerrm like 'Add at least one option to the “Priority” field%', 'says what to do: ' || sqlerrm;
  end;
  begin
    insert into public.custom_fields (project_id, name, field_type, options) values (a, 'Channels', 'multi_select', '[]');
    raise exception 'a multi-select with no options must be refused';
  exception when check_violation then null;
  end;

  -- With an option it's fine; other types and the section-bound Status need none.
  insert into public.custom_fields (project_id, name, field_type, options) values (a, 'Priority', 'single_select', opts)
  returning id into f;
  insert into b7f_ids values ('f47', f);
  insert into public.custom_fields (project_id, name, field_type, options)
  values (a, 'Channels', 'multi_select', '[{"id": "c1", "name": "Email", "color": "blue"}]');
  insert into public.custom_fields (project_id, name, field_type) values (a, 'Notes', 'text');
  insert into public.custom_fields (project_id, name, field_type) values (a, 'Budget', 'number');
  insert into public.custom_fields (project_id, name, field_type, bound_to_sections)
  values (a, 'Status', 'single_select', true) returning id into status_field;
  assert (select options from public.custom_fields where id = status_field) = '[]'::jsonb, 'the section-bound Status keeps no options';
  update public.custom_fields set name = 'Stage' where id = status_field;
  assert (select name from public.custom_fields where id = status_field) = 'Stage', 'and is renamed as before';

  -- Emptying a select field is refused; renaming, reordering, recoloring, and replacing options work.
  begin
    update public.custom_fields set options = '[]' where id = f;
    raise exception 'emptying a select field must be refused';
  exception when check_violation then null;
  end;
  assert jsonb_array_length((select options from public.custom_fields where id = f)) = 2, 'its options are kept';
  update public.custom_fields
     set name = 'Urgency', options = '[{"id": "o2", "name": "Low", "color": "green"}]'
   where id = f;
  assert (select name from public.custom_fields where id = f) = 'Urgency', 'renamed';
  assert (select options -> 0 ->> 'color' from public.custom_fields where id = f) = 'green', 'one option left, recolored';
  update public.custom_fields set description = 'How soon' where id = f;

  -- A field can't become an empty select either (another type turned into a select).
  begin
    update public.custom_fields set field_type = 'single_select', options = '[]'
     where project_id = a and name = 'Notes';
    raise exception 'turning a text field into an empty select must be refused';
  exception when check_violation then null;
  end;

  -- Values still work on the field, and removing the field (soft delete) is allowed.
  t := public.create_task(a, null, 'Option task');
  insert into public.task_field_values (task_id, field_id, value) values (t, f, '"o2"');
  update public.custom_fields set deleted_at = now() where project_id = a and name = 'Channels';
  assert (select deleted_at is not null from public.custom_fields where project_id = a and name = 'Channels'),
    'a select field can still be removed';
end $$;

-- Viewers still can't write fields at all (RLS, unchanged).
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b7f_ids where name = 'a');
begin
  begin
    insert into public.custom_fields (project_id, name, field_type, options)
    values (a, 'Sneaky', 'single_select', '[{"id": "s1", "name": "S", "color": "zinc"}]');
    raise exception 'viewers can''t add fields';
  exception when insufficient_privilege then null;
  end;
end $$;

-- System paths keep making empty select fields: a direct write as the database owner, and the seeded
-- Creative Requests template (its two select fields have no options) through create_project_from_template.
reset role;
do $$
declare
  a uuid := (select id from b7f_ids where name = 'a');
  legacy uuid;
begin
  insert into public.custom_fields (project_id, name, field_type) values (a, 'Legacy pick', 'single_select')
  returning id into legacy;
  insert into b7f_ids values ('legacy', legacy);
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  legacy uuid := (select id from b7f_ids where name = 'legacy');
  created jsonb;
  copy uuid;
begin
  -- An existing select field with no options can still be renamed and described (and saved empty again),
  -- but once it has options it can't be emptied.
  update public.custom_fields set name = 'Legacy choice', description = 'Older field' where id = legacy;
  assert (select name from public.custom_fields where id = legacy) = 'Legacy choice', 'an empty select is renameable';
  update public.custom_fields set options = '[]' where id = legacy;
  update public.custom_fields set options = '[{"id": "l1", "name": "Yes", "color": "green"}]' where id = legacy;
  begin
    update public.custom_fields set options = '[]' where id = legacy;
    raise exception 'once it has options it can''t be emptied';
  exception when check_violation then null;
  end;

  -- The seeded template (definer code) still copies its option-less select fields.
  created := public.create_project_from_template('00000000-0000-4000-8000-0000000000c1', 'B7F from template', current_date);
  copy := (created ->> 'project_id')::uuid;
  insert into b7f_ids values ('template_copy', copy);
  assert (select count(*) from public.custom_fields
           where project_id = copy and field_type = 'single_select' and not bound_to_sections
             and options = '[]'::jsonb and deleted_at is null) = 2,
    'a project from Creative Requests keeps its two option-less select fields';
  -- Its creator (the owner) can rename them, and give them options.
  update public.custom_fields set name = 'Kind of request'
   where project_id = copy and name = 'Request type';
  assert exists (select 1 from public.custom_fields where project_id = copy and name = 'Kind of request'),
    'a template''s empty select is renameable';
end $$;

-- Duplicate project (definer copy engine) copies a project with an empty select field too.
do $$
declare
  copy uuid := (select id from b7f_ids where name = 'template_copy');
  dup jsonb;
begin
  dup := public.duplicate_project(copy, 'B7F duplicate', '{}'::jsonb);
  assert (select count(*) from public.custom_fields
           where project_id = (dup ->> 'project_id')::uuid and options = '[]'::jsonb
             and field_type = 'single_select' and not bound_to_sections and deleted_at is null) = 2,
    'Duplicate project copies option-less select fields';
end $$;

-- Portfolio fields: single-select needs an option too.
do $$
declare
  p uuid := (select id from b7f_ids where name = 'p');
  pf uuid;
begin
  begin
    insert into public.portfolio_fields (portfolio_id, name, field_type) values (p, 'Phase', 'single_select');
    raise exception 'an option-less portfolio single-select must be refused';
  exception when check_violation then
    assert sqlerrm like 'Add at least one option to the “Phase” field%', 'says what to do: ' || sqlerrm;
  end;
  insert into public.portfolio_fields (portfolio_id, name, field_type, options)
  values (p, 'Phase', 'single_select', '[{"id": "ph1", "name": "Plan", "color": "blue"}]') returning id into pf;
  insert into public.portfolio_fields (portfolio_id, name, field_type) values (p, 'Spend', 'number');
  begin
    update public.portfolio_fields set options = '[]' where id = pf;
    raise exception 'emptying a portfolio single-select must be refused';
  exception when check_violation then null;
  end;
  update public.portfolio_fields set name = 'Stage of work' where id = pf;
  assert (select name from public.portfolio_fields where id = pf) = 'Stage of work', 'renamed';
  update public.portfolio_fields set deleted_at = now() where id = pf;
end $$;

reset role;
do $$
declare
  p uuid := (select id from b7f_ids where name = 'p');
  pf uuid;
begin
  -- Older option-less portfolio single-selects stay renameable by people.
  insert into public.portfolio_fields (portfolio_id, name, field_type) values (p, 'Old phase', 'single_select')
  returning id into pf;
  insert into b7f_ids values ('old_pf', pf);
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  pf uuid := (select id from b7f_ids where name = 'old_pf');
begin
  update public.portfolio_fields set name = 'Older phase' where id = pf;
  assert (select name from public.portfolio_fields where id = pf) = 'Older phase', 'an empty portfolio select is renameable';
end $$;

-- The guard is a trigger helper: no client executes it.
reset role;
do $$
begin
  assert not has_function_privilege('anon', 'public.guard_select_field_options()', 'execute'), 'anon can''t execute the guard';
  assert not has_function_privilege('authenticated', 'public.guard_select_field_options()', 'execute'),
    'authenticated can''t execute the guard';
  assert exists (select 1 from pg_trigger where tgname = 'custom_fields_07_select_options' and not tgisinternal), 'project trigger';
  assert exists (select 1 from pg_trigger where tgname = 'portfolio_fields_07_select_options' and not tgisinternal), 'portfolio trigger';
end $$;

do $$ begin raise notice 'Oct 29 batch 7 fields (T2) smoke: all assertions passed'; end $$;
