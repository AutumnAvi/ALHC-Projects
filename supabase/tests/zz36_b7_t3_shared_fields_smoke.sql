-- Oct 29 notes, batch 7, track T3 — 55. Library fields shared across projects (linked placements).
--   b7c30029…01 sf-owner@example.com     owner of SF A, SF B, SF C (and the linking projects)
--   b7c30029…02 sf-editor@example.com    Editor of SF A and SF B
--   b7c30029…03 sf-bedit@example.com     Editor of SF B and SF C (not in SF A)
--   b7c30029…04 sf-viewer@example.com    Viewer of SF B
--   b7c30029…05 sf-outsider@example.com  in the workspace, in no project
--   b7c30029…06 sf-admin@example.com     workspace admin, in no project

\set ON_ERROR_STOP 1

insert into public.allowed_emails (email, note) values
  ('sf-owner@example.com', 'oct 29 batch 7 t3'),
  ('sf-editor@example.com', 'oct 29 batch 7 t3'),
  ('sf-bedit@example.com', 'oct 29 batch 7 t3'),
  ('sf-viewer@example.com', 'oct 29 batch 7 t3'),
  ('sf-outsider@example.com', 'oct 29 batch 7 t3'),
  ('sf-admin@example.com', 'oct 29 batch 7 t3');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b7c30029-0000-4000-8000-000000000001', 'sf-owner@example.com', now(), '{"full_name":"Olive Owner"}'),
  ('b7c30029-0000-4000-8000-000000000002', 'sf-editor@example.com', now(), '{"full_name":"Eddie Editor"}'),
  ('b7c30029-0000-4000-8000-000000000003', 'sf-bedit@example.com', now(), '{"full_name":"Bea Bedit"}'),
  ('b7c30029-0000-4000-8000-000000000004', 'sf-viewer@example.com', now(), '{"full_name":"Vera Viewer"}'),
  ('b7c30029-0000-4000-8000-000000000005', 'sf-outsider@example.com', now(), '{"full_name":"Otto Outsider"}'),
  ('b7c30029-0000-4000-8000-000000000006', 'sf-admin@example.com', now(), '{"full_name":"Ada Admin"}');
select public.seed_workspace_admin('sf-admin@example.com');

create temporary table sf_ids (name text primary key, id uuid);
grant all on sf_ids to authenticated, anon;

-- ---------------------------------------------------------------------------------------------
-- Schema and privileges
-- ---------------------------------------------------------------------------------------------

do $$
begin
  assert exists (
    select 1 from pg_attribute where attrelid = 'public.custom_fields'::regclass and attname = 'library_field_id' and not attisdropped
  ), 'custom_fields.library_field_id exists';
  assert (select relrowsecurity from pg_class where oid = 'public.library_field_links'::regclass), 'links: RLS on';
  assert (select relrowsecurity from pg_class where oid = 'public.library_field_link_conflicts'::regclass), 'conflicts: RLS on';
  assert not has_table_privilege('authenticated', 'public.library_field_links', 'SELECT')
    and not has_table_privilege('authenticated', 'public.library_field_link_conflicts', 'SELECT')
    and not has_table_privilege('anon', 'public.library_field_links', 'SELECT')
    and not has_table_privilege('anon', 'public.library_field_link_conflicts', 'SELECT'), 'no client access to the link tables';
  assert not has_table_privilege('authenticated', 'public.library_field_link_conflicts', 'INSERT')
    and not has_table_privilege('authenticated', 'public.library_field_link_conflicts', 'TRUNCATE'), 'no client writes';

  -- The two client definers (pinned in suite 60) and the internal helpers.
  assert (select prosecdef from pg_proc where oid = 'public.add_library_field(uuid, uuid)'::regprocedure), 'add_library_field is definer';
  assert (select prosecdef from pg_proc where oid = 'public.project_field_sharing(uuid)'::regprocedure), 'project_field_sharing is definer';
  assert has_function_privilege('authenticated', 'public.add_library_field(uuid, uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.project_field_sharing(uuid)', 'execute'), 'members call them';
  assert not has_function_privilege('anon', 'public.add_library_field(uuid, uuid)', 'execute')
    and not has_function_privilege('anon', 'public.project_field_sharing(uuid)', 'execute'), 'anon calls neither';
  assert not has_function_privilege('authenticated', 'public.link_library_field_copies()', 'execute')
    and not has_function_privilege('authenticated', 'public.link_library_placement(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.fill_library_values(uuid, uuid[])', 'execute')
    and not has_function_privilege('authenticated', 'public.library_value_siblings(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.library_field_governing_project(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.copy_library_definition(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.library_value_sync_write(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.library_field_source_for_copy(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.library_group_task_members(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.sync_library_field_value()', 'execute')
    and not has_function_privilege('authenticated', 'public.sync_library_field_definition()', 'execute')
    and not has_function_privilege('authenticated', 'public.lock_library_field_value()', 'execute')
    and not has_function_privilege('authenticated', 'public.fill_library_values_on_join()', 'execute'),
    'the engine is internal';
  assert public.library_field_definition_columns() = array['name', 'description', 'field_type', 'options', 'notify_on_change'],
    'the definition columns';
  assert exists (select 1 from pg_trigger where tgname = 'task_field_values_03_library_lock' and tgrelid = 'public.task_field_values'::regclass)
    and exists (select 1 from pg_trigger where tgname = 'task_field_values_zzz_library_sync' and tgrelid = 'public.task_field_values'::regclass)
    and exists (select 1 from pg_trigger where tgname = 'task_projects_14_library_values' and tgrelid = 'public.task_projects'::regclass)
    and exists (select 1 from pg_trigger where tgname = 'custom_fields_05_library_guard' and tgrelid = 'public.custom_fields'::regclass)
    and exists (select 1 from pg_trigger where tgname = 'custom_fields_zz_library_sync' and tgrelid = 'public.custom_fields'::regclass),
    'the triggers are in place';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Setup (Olive): SF A publishes Priority (single-select) and Budget note (text); SF B has a field of
-- its own; SF C.
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  a uuid;
  b uuid;
  c uuid;
  f uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF A') returning id into a;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF B') returning id into b;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF C') returning id into c;
  insert into sf_ids values ('a', a), ('b', b), ('c', c);
  with x as (insert into public.sections (project_id, name, sort_order) values (a, 'Intake', 1024) returning id) insert into sf_ids select 'sa', id from x;
  with x as (insert into public.sections (project_id, name, sort_order) values (b, 'Inbox', 1024) returning id) insert into sf_ids select 'sb', id from x;
  with x as (insert into public.sections (project_id, name, sort_order) values (c, 'Queue', 1024) returning id) insert into sf_ids select 'sc', id from x;
  perform public.add_project_member(a, 'sf-editor@example.com', 'editor');
  perform public.add_project_member(b, 'sf-editor@example.com', 'editor');
  perform public.add_project_member(b, 'sf-bedit@example.com', 'editor');
  perform public.add_project_member(c, 'sf-bedit@example.com', 'editor');
  perform public.add_project_member(b, 'sf-viewer@example.com', 'viewer');

  insert into public.custom_fields (project_id, name, field_type, options, in_library, notify_on_change, description, sort_order,
                                    show_in_views)
  values (a, 'Priority', 'single_select',
    '[{"id": "p-low", "name": "Low", "color": "green"}, {"id": "p-high", "name": "High", "color": "red"}]',
    true, true, 'How urgent it is', 1024, true)
  returning id into f;
  insert into sf_ids values ('priority', f);
  insert into public.custom_fields (project_id, name, field_type, in_library, description, sort_order)
  values (a, 'Budget note', 'text', true, 'What it costs', 2048) returning id into f;
  insert into sf_ids values ('budget', f);
  insert into public.custom_fields (project_id, name, field_type, sort_order)
  values (a, 'Unshared', 'text', 3072) returning id into f;
  insert into sf_ids values ('unshared', f);
  insert into public.custom_fields (project_id, name, field_type, sort_order)
  values (b, 'Local', 'text', 1024) returning id into f;
  insert into sf_ids values ('local', f);
end $$;

-- ---------------------------------------------------------------------------------------------
-- add_library_field: who may add, idempotent, the placement's shape
-- ---------------------------------------------------------------------------------------------

-- Vera (Viewer of SF B), Otto (in no project), and Ada (a workspace admin, in no project) get nothing.
do $$
declare
  who text;
begin
  foreach who in array array['b7c30029-0000-4000-8000-000000000004', 'b7c30029-0000-4000-8000-000000000005',
                             'b7c30029-0000-4000-8000-000000000006'] loop
    perform set_config('request.jwt.claim.sub', who, true);
    begin
      perform public.add_library_field((select id from sf_ids where name = 'b'), (select id from sf_ids where name = 'priority'));
      raise exception 'add_library_field should be refused for %', who;
    exception when insufficient_privilege then
      null;
    end;
    if who = 'b7c30029-0000-4000-8000-000000000004' then
      assert exists (select 1 from public.project_field_sharing((select id from sf_ids where name = 'b')))
        and not exists (select 1 from public.project_field_sharing((select id from sf_ids where name = 'b')) s
                        where s.definition_editable or s.definition_manageable),
        'a Viewer sees SF B''s fields and changes none';
    else
      assert not exists (select 1 from public.project_field_sharing((select id from sf_ids where name = 'b'))),
        format('project_field_sharing says nothing to %s about SF B', who);
    end if;
  end loop;
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  b uuid := (select id from sf_ids where name = 'b');
  priority uuid := (select id from sf_ids where name = 'priority');
  placement uuid;
  again uuid;
  f public.custom_fields;
begin
  -- Bea can't read SF A (the source's project) but adds its library field to SF B.
  assert not exists (select 1 from public.custom_fields where id = priority), 'Bea can''t read the source row';
  placement := public.add_library_field(b, priority);
  assert placement is not null and placement <> priority, 'a placement in SF B';
  insert into sf_ids values ('pb', placement);
  again := public.add_library_field(b, priority);
  assert again = placement, 'adding it again returns the same placement';
  select * into f from public.custom_fields where id = placement;
  assert f.library_field_id = priority, 'the placement points at the source';
  assert f.project_id = b and f.name = 'Priority' and f.field_type = 'single_select' and f.description = 'How urgent it is'
    and f.notify_on_change and not f.in_library and f.show_in_views, 'definition copied, pinned, not itself in the library';
  assert f.options = '[{"id": "p-low", "name": "Low", "color": "green"}, {"id": "p-high", "name": "High", "color": "red"}]'::jsonb,
    'same option ids';
  assert f.sort_order > (select sort_order from public.custom_fields where id = (select id from sf_ids where name = 'local')),
    'it goes last';

  -- Not a library field.
  begin
    perform public.add_library_field(b, (select id from sf_ids where name = 'unshared'));
    raise exception 'a field that isn''t in the library can''t be added';
  exception when no_data_found then
    null;
  end;
  -- People never set the link themselves.
  begin
    insert into public.custom_fields (project_id, name, field_type, library_field_id) values (b, 'Sneaky', 'single_select', priority);
    raise exception 'a client insert can''t set library_field_id';
  exception when insufficient_privilege then
    null;
  end;
  begin
    update public.custom_fields set library_field_id = null where id = placement;
    raise exception 'a client can''t unlink a placement';
  exception when insufficient_privilege then
    null;
  end;
  begin
    update public.custom_fields set library_field_id = priority where id = (select id from sf_ids where name = 'local');
    raise exception 'a client can''t link a field';
  exception when insufficient_privilege then
    null;
  end;
  begin
    update public.custom_fields set in_library = true where id = placement;
    raise exception 'a placement can''t join the library';
  exception when check_violation then
    null;
  end;
end $$;

-- Eddie adds it to SF A, the source's own project: the source itself.
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  assert public.add_library_field((select id from sf_ids where name = 'a'), (select id from sf_ids where name = 'priority'))
    = (select id from sf_ids where name = 'priority'), 'the source''s own project gets the source back';
  assert (select count(*) from public.list_field_library() where field_id = (select id from sf_ids where name = 'priority')) = 1
    and not exists (select 1 from public.list_field_library() where field_id = (select id from sf_ids where name = 'pb')),
    'the library lists the source only';
end $$;

-- ---------------------------------------------------------------------------------------------
-- project_field_sharing: booleans and counts only
-- ---------------------------------------------------------------------------------------------

do $$
declare
  s record;
begin
  -- Eddie (Editor of SF A and SF B).
  select * into s from public.project_field_sharing((select id from sf_ids where name = 'b'))
  where field_id = (select id from sf_ids where name = 'pb');
  assert s.library_field_id = (select id from sf_ids where name = 'priority') and s.is_shared and not s.is_source
    and s.placement_count = 2 and s.definition_editable and not s.definition_manageable,
    format('Eddie: the placement is shared and he edits the definition (%s)', row_to_json(s));
  select * into s from public.project_field_sharing((select id from sf_ids where name = 'b'))
  where field_id = (select id from sf_ids where name = 'local');
  assert s.library_field_id is null and not s.is_shared and not s.is_source and s.placement_count = 1 and s.definition_editable,
    'a project-only field';
  select * into s from public.project_field_sharing((select id from sf_ids where name = 'a'))
  where field_id = (select id from sf_ids where name = 'budget');
  assert s.is_source and not s.is_shared and s.placement_count = 1, 'published, used nowhere else yet';
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  s record;
begin
  select * into s from public.project_field_sharing((select id from sf_ids where name = 'b'))
  where field_id = (select id from sf_ids where name = 'pb');
  assert s.is_shared and s.placement_count = 2 and not s.definition_editable and not s.definition_manageable,
    'Bea (not in SF A) can''t change the shared definition';
  assert not exists (select 1 from public.project_field_sharing((select id from sf_ids where name = 'a'))),
    'nothing about a project she can''t open';
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  s record;
begin
  select * into s from public.project_field_sharing((select id from sf_ids where name = 'a'))
  where field_id = (select id from sf_ids where name = 'priority');
  assert s.library_field_id is null and s.is_source and s.is_shared and s.placement_count = 2
    and s.definition_editable and s.definition_manageable, 'Olive owns the source';
end $$;

-- ---------------------------------------------------------------------------------------------
-- One value per task
-- ---------------------------------------------------------------------------------------------

-- Eddie makes Shared one in SF A, adds it to SF B, and assigns it to Olive (who follows it).
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from sf_ids where name = 'a');
  b uuid := (select id from sf_ids where name = 'b');
  priority uuid := (select id from sf_ids where name = 'priority');
  pb uuid := (select id from sf_ids where name = 'pb');
  t uuid;
  stories integer;
  notes integer;
  locks integer;
begin
  t := public.create_task(a, (select id from sf_ids where name = 'sa'), 'Shared one');
  insert into sf_ids values ('t1', t);
  insert into public.task_projects (task_id, project_id, section_id) values (t, b, (select id from sf_ids where name = 'sb'));
  update public.tasks set assignee_id = 'b7c30029-0000-4000-8000-000000000001' where id = t;
end $$;

-- (A later transaction: changes in the one that created the task notify nobody.) Olive's Inbox is
-- counted as the database owner (people read only their own items).
reset role;
create temporary table sf_counts (name text primary key, n integer);
insert into sf_counts
select 'notes', count(*) from public.inbox_items
where task_id = (select id from sf_ids where name = 't1') and recipient_id = 'b7c30029-0000-4000-8000-000000000001'
  and (data ->> 'field_change')::boolean;
set role authenticated;
do $$
declare
  priority uuid := (select id from sf_ids where name = 'priority');
  pb uuid := (select id from sf_ids where name = 'pb');
  t uuid := (select id from sf_ids where name = 't1');
  stories integer;
  locks integer;
begin
  select count(*) into stories from public.task_stories where task_id = t and kind = 'field_changed';
  insert into public.task_field_values (task_id, field_id, value) values (t, priority, '"p-high"')
  on conflict (task_id, field_id) do update set value = excluded.value;
  assert (select value from public.task_field_values where task_id = t and field_id = pb) = '"p-high"',
    'the value written in SF A shows in SF B';
  assert (select count(*) from public.task_stories where task_id = t and kind = 'field_changed') = stories + 1,
    'one story for the change, not one per project';
  select count(*) into locks from pg_locks where locktype = 'advisory' and pid = pg_backend_pid();
  assert locks > 0, 'the shared write took the per-task, per-field advisory lock';
end $$;
reset role;
do $$
begin
  assert (select count(*) from public.inbox_items
          where task_id = (select id from sf_ids where name = 't1') and recipient_id = 'b7c30029-0000-4000-8000-000000000001'
            and (data ->> 'field_change')::boolean) = (select n from sf_counts where name = 'notes') + 1,
    'one field-change notification, not one per project';
end $$;
set role authenticated;

-- Bea (Editor of SF B only) changes it through SF B; SF A has it too. Then it is cleared from SF A.
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from sf_ids where name = 't1');
  pb uuid := (select id from sf_ids where name = 'pb');
begin
  update public.task_field_values set value = '"p-low"' where task_id = t and field_id = pb;
  assert found, 'Bea writes SF B''s value';
end $$;
reset role;
do $$
begin
  assert (select value from public.task_field_values
          where task_id = (select id from sf_ids where name = 't1') and field_id = (select id from sf_ids where name = 'priority'))
    = '"p-low"', 'the value written in SF B shows in SF A';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from sf_ids where name = 't1');
  priority uuid := (select id from sf_ids where name = 'priority');
  pb uuid := (select id from sf_ids where name = 'pb');
  child uuid;
  rows_before integer;
begin
  update public.task_field_values set value = null where task_id = t and field_id = priority;
  assert (select value from public.task_field_values where task_id = t and field_id = pb) is null, 'clearing syncs';

  -- Subtasks: their values follow the top-level task's projects.
  child := public.create_subtask(t, 'Shared child', null);
  insert into sf_ids values ('t1child', child);
  insert into public.task_field_values (task_id, field_id, value) values (child, pb, '"p-high"');
  assert (select value from public.task_field_values where task_id = child and field_id = priority) = '"p-high"',
    'a subtask''s value syncs too';

  -- A project-only field stays local.
  select count(*) into rows_before from public.task_field_values where task_id = t;
  insert into public.task_field_values (task_id, field_id, value) values (t, (select id from sf_ids where name = 'unshared'), '"only here"');
  assert (select count(*) from public.task_field_values where task_id = t) = rows_before + 1, 'one row for a project-only field';
end $$;

-- A task joining SF B later gets the value; removed, it keeps its old row; added back, it catches up
-- (each step its own transaction, as in the app).
do $$
declare
  a uuid := (select id from sf_ids where name = 'a');
  b uuid := (select id from sf_ids where name = 'b');
  priority uuid := (select id from sf_ids where name = 'priority');
  pb uuid := (select id from sf_ids where name = 'pb');
  t uuid;
  child uuid;
  stories integer;
begin
  t := public.create_task(a, (select id from sf_ids where name = 'sa'), 'Joins later');
  insert into sf_ids values ('t2', t);
  insert into public.task_field_values (task_id, field_id, value) values (t, priority, '"p-high"');
  child := public.create_subtask(t, 'Joins later child', null);
  insert into public.task_field_values (task_id, field_id, value) values (child, priority, '"p-low"');
  assert not exists (select 1 from public.task_field_values where task_id = t and field_id = pb), 'not in SF B yet';
  select count(*) into stories from public.task_stories where task_id = t and kind = 'field_changed';
  insert into public.task_projects (task_id, project_id, section_id) values (t, b, (select id from sf_ids where name = 'sb'));
  assert (select value from public.task_field_values where task_id = t and field_id = pb) = '"p-high"',
    'joining SF B brings the value';
  assert (select value from public.task_field_values where task_id = child and field_id = pb) = '"p-low"',
    'and its subtasks'' values';
  assert (select count(*) from public.task_stories where task_id = t and kind = 'field_changed') = stories,
    'quietly (no story)';
end $$;

do $$
declare
  t uuid := (select id from sf_ids where name = 't2');
begin
  update public.task_projects set deleted_at = now() where task_id = t and project_id = (select id from sf_ids where name = 'b');
  update public.task_field_values set value = '"p-low"' where task_id = t and field_id = (select id from sf_ids where name = 'priority');
  assert (select value from public.task_field_values where task_id = t and field_id = (select id from sf_ids where name = 'pb')) = '"p-high"',
    'a project the task left keeps its old row';
end $$;

do $$
declare
  t uuid := (select id from sf_ids where name = 't2');
begin
  update public.task_projects set deleted_at = null where task_id = t and project_id = (select id from sf_ids where name = 'b');
  assert (select value from public.task_field_values where task_id = t and field_id = (select id from sf_ids where name = 'pb')) = '"p-low"',
    'added back, it gets the newest value';
end $$;

-- ---------------------------------------------------------------------------------------------
-- SF B's rules run when the value changes through SF A (and not when a task merely joins)
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  r uuid;
begin
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions)
  values ((select id from sf_ids where name = 'b'), 'B hears Priority', true, 'field_changed',
    jsonb_build_object('field_id', (select id from sf_ids where name = 'pb')),
    '[{"type": "add_comment", "body": "SF B saw the priority change"}]')
  returning id into r;
  insert into sf_ids values ('rule_b', r);
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from sf_ids where name = 't1');
  t3 uuid;
begin
  insert into public.task_field_values (task_id, field_id, value) values (t, (select id from sf_ids where name = 'priority'), '"p-high"')
  on conflict (task_id, field_id) do update set value = excluded.value;
  assert exists (select 1 from public.comments where task_id = t and body = 'SF B saw the priority change' and deleted_at is null),
    'SF B''s field_changed rule ran for an edit made in SF A';
  assert exists (select 1 from public.rule_runs where rule_id = (select id from sf_ids where name = 'rule_b') and task_id = t
                 and status = 'succeeded'), 'and logged its run';

  t3 := public.create_task((select id from sf_ids where name = 'a'), (select id from sf_ids where name = 'sa'), 'Joins quietly');
  insert into public.task_field_values (task_id, field_id, value) values (t3, (select id from sf_ids where name = 'priority'), '"p-low"');
  insert into public.task_projects (task_id, project_id, section_id) values (t3, (select id from sf_ids where name = 'b'), (select id from sf_ids where name = 'sb'));
  assert (select value from public.task_field_values where task_id = t3 and field_id = (select id from sf_ids where name = 'pb')) = '"p-low"',
    'joined with its value';
  assert not exists (select 1 from public.comments where task_id = t3 and body = 'SF B saw the priority change'),
    'joining runs no rule';
end $$;

-- ---------------------------------------------------------------------------------------------
-- One definition
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  pb uuid := (select id from sf_ids where name = 'pb');
begin
  begin
    update public.custom_fields set name = 'Pri' where id = pb;
    raise exception 'Bea can''t rename a shared field';
  exception when insufficient_privilege then
    assert sqlerrm like 'Shared from the field library.%', sqlerrm;
  end;
  begin
    update public.custom_fields set options = '[]' where id = pb;
    raise exception 'Bea can''t change its options';
  exception when insufficient_privilege then
    null;
  end;
  -- Her project's own settings for it are hers.
  update public.custom_fields set show_in_views = false where id = pb;
  assert found, 'show_in_views is per project';
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  priority uuid := (select id from sf_ids where name = 'priority');
begin
  assert (select show_in_views from public.custom_fields where id = priority), 'the source''s pin didn''t move';
  update public.custom_fields
  set name = 'Priority level',
      options = '[{"id": "p-low", "name": "Low", "color": "green"}, {"id": "p-mid", "name": "Medium", "color": "yellow"},
                  {"id": "p-high", "name": "High", "color": "red"}]'
  where id = priority;
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  priority uuid := (select id from sf_ids where name = 'priority');
  pb uuid := (select id from sf_ids where name = 'pb');
begin
  assert (select name = 'Priority level' and jsonb_array_length(options) = 3 and not show_in_views from public.custom_fields where id = pb),
    'renaming and a new option reach the placement; its pin stays its own';
  -- Eddie edits SF A too, so he changes the definition through SF B's placement.
  update public.custom_fields set description = 'How urgent, really' where id = pb;
  assert (select description from public.custom_fields where id = priority) = 'How urgent, really',
    'a definition change through a placement reaches the source';
end $$;

-- SF C: a task already in SF A and SF C gets the value when SF C adds the field.
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  c uuid := (select id from sf_ids where name = 'c');
  t uuid;
  pc uuid;
begin
  t := public.create_task((select id from sf_ids where name = 'a'), (select id from sf_ids where name = 'sa'), 'Already in C');
  insert into sf_ids values ('t4', t);
  insert into public.task_field_values (task_id, field_id, value) values (t, (select id from sf_ids where name = 'priority'), '"p-mid"');
  insert into public.task_projects (task_id, project_id, section_id) values (t, c, (select id from sf_ids where name = 'sc'));
  pc := public.add_library_field(c, (select id from sf_ids where name = 'priority'));
  insert into sf_ids values ('pc', pc);
  assert (select value from public.task_field_values where task_id = t and field_id = pc) = '"p-mid"',
    'adding the field fills the project''s tasks';
  assert (select name from public.custom_fields where id = pc) = 'Priority level', 'with the current definition';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Bulk edit and filters still work per placement
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  result jsonb;
begin
  result := public.bulk_update_tasks(array[(select id from sf_ids where name = 't1')],
    jsonb_build_object('action', 'set_field', 'field_id', (select id from sf_ids where name = 'pb'), 'value', 'p-mid'));
  assert jsonb_array_length(result -> 'updated') = 1, format('bulk set_field through SF B: %s', result);
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  assert (select value from public.task_field_values
          where task_id = (select id from sf_ids where name = 't1') and field_id = (select id from sf_ids where name = 'priority'))
    = '"p-mid"', 'the bulk edit reached SF A';
  assert exists (
    select 1 from public.filter_project_tasks((select id from sf_ids where name = 'a'),
      jsonb_build_object('fields', jsonb_build_array(jsonb_build_object(
        'field_id', (select id from sf_ids where name = 'priority'), 'op', 'in', 'values', '["p-mid"]'::jsonb))), 'UTC') f
    where f.task_id = (select id from sf_ids where name = 't1')
  ), 'SF A''s filter finds the task by the value set in SF B';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Copies: Duplicate project links the copy to the library field; an unpublished one is a plain copy
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  priority uuid := (select id from sf_ids where name = 'priority');
  copy_a uuid;
  copy_b uuid;
  copy_after uuid;
  f public.custom_fields;
begin
  copy_a := (public.duplicate_project((select id from sf_ids where name = 'a'), 'SF A copy', '{}'::jsonb) ->> 'project_id')::uuid;
  insert into sf_ids values ('copy_a', copy_a);
  select * into f from public.custom_fields where project_id = copy_a and name = 'Priority level' and deleted_at is null;
  assert f.library_field_id = priority, 'the source''s copy is a placement of it';
  assert not f.in_library, 'and isn''t listed in the library itself';
  assert (select library_field_id from public.custom_fields where project_id = copy_a and name = 'Unshared') is null,
    'a project-only field is a plain copy';
  assert exists (
    select 1 from public.task_field_values v join public.tasks t on t.id = v.task_id
    where v.field_id = f.id and t.title = 'Already in C' and v.value = '"p-mid"'
  ), 'copied values sit on the copy''s placement';

  copy_b := (public.duplicate_project((select id from sf_ids where name = 'b'), 'SF B copy', '{}'::jsonb) ->> 'project_id')::uuid;
  insert into sf_ids values ('copy_b', copy_b);
  assert (select library_field_id from public.custom_fields where project_id = copy_b and name = 'Priority level' and deleted_at is null)
    = priority, 'a placement''s copy is a placement of the same library field';

  -- Unpublished: no new projects; existing placements stay linked and in step.
  update public.custom_fields set in_library = false where id = priority;
  begin
    perform public.add_library_field((select id from sf_ids where name = 'c'), (select id from sf_ids where name = 'budget'));
  exception when others then
    raise exception 'budget is still published: %', sqlerrm;
  end;
  begin
    perform public.add_library_field(copy_a, priority);
    raise exception 'an unpublished field can''t be added';
  exception when no_data_found then
    null;
  end;
  copy_after := (public.duplicate_project((select id from sf_ids where name = 'a'), 'SF A late copy', '{}'::jsonb) ->> 'project_id')::uuid;
  assert (select library_field_id from public.custom_fields where project_id = copy_after and name = 'Priority level') is null,
    'after unpublishing, a copy is a plain copy';
  update public.task_field_values set value = '"p-low"'
  where task_id = (select id from sf_ids where name = 't4') and field_id = priority;
  assert (select value from public.task_field_values
          where task_id = (select id from sf_ids where name = 't4') and field_id = (select id from sf_ids where name = 'pc')) = '"p-low"',
    'existing placements keep syncing after unpublishing';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Removing a placement, and the source going away
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
begin
  update public.custom_fields set deleted_at = now() where id = (select id from sf_ids where name = 'pb');
  assert found, 'an Editor of SF B removes the field from SF B';
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from sf_ids where name = 't1');
begin
  assert (select deleted_at is null from public.custom_fields where id = (select id from sf_ids where name = 'priority')),
    'the source is untouched';
  update public.task_field_values set value = '"p-high"' where task_id = t and field_id = (select id from sf_ids where name = 'priority');
end $$;
reset role;
do $$
begin
  assert (select value from public.task_field_values
          where task_id = (select id from sf_ids where name = 't1') and field_id = (select id from sf_ids where name = 'pb')) = '"p-mid"',
    'a removed placement gets no more values';
end $$;

-- Olive removes the source: SF C's Editors now look after the definition, and it still reaches every
-- live placement.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  update public.custom_fields set deleted_at = now() where id = (select id from sf_ids where name = 'priority');
end $$;

select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  pc uuid := (select id from sf_ids where name = 'pc');
  s record;
begin
  select * into s from public.project_field_sharing((select id from sf_ids where name = 'c')) where field_id = pc;
  assert s.definition_editable and s.is_shared, 'with the source gone, SF C''s Editors edit its definition';
  update public.custom_fields set name = 'Urgency' where id = pc;
  assert found, 'Bea renames it';
end $$;
reset role;
do $$
begin
  assert (select name from public.custom_fields
          where project_id = (select id from sf_ids where name = 'copy_a') and library_field_id = (select id from sf_ids where name = 'priority')
            and deleted_at is null) = 'Urgency', 'the rename reached the other live placements';
  assert (select name from public.custom_fields where id = (select id from sf_ids where name = 'priority')) = 'Priority level',
    'a removed field is left as it was';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Linking existing copies (link_library_field_copies, run once by the migration)
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  m1 uuid;
  m2 uuid;
  m3 uuid;
  m4 uuid;
  m5 uuid;
  s1 uuid;
  s2 uuid;
  f uuid;
  t uuid;
  opts jsonb := '[{"id": "st-a", "name": "Ay", "color": "blue"}, {"id": "st-b", "name": "Bee", "color": "pink"}]';
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF M1') returning id into m1;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF M2') returning id into m2;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF M3') returning id into m3;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF M4') returning id into m4;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'SF M5') returning id into m5;
  insert into sf_ids values ('m1', m1), ('m2', m2), ('m3', m3), ('m4', m4), ('m5', m5);
  with x as (insert into public.sections (project_id, name, sort_order) values (m1, 'One', 1024) returning id) insert into sf_ids select 'sm1', id from x;
  with x as (insert into public.sections (project_id, name, sort_order) values (m2, 'Two', 1024) returning id) insert into sf_ids select 'sm2', id from x;

  -- Sources in SF M1.
  insert into public.custom_fields (project_id, name, field_type, options, in_library) values (m1, 'Stage', 'single_select', opts, true)
  returning id into s1;
  insert into sf_ids values ('s_stage', s1);
  insert into public.custom_fields (project_id, name, field_type, description, in_library) values (m1, 'Brief', 'text', 'The brief', true)
  returning id into s2;
  insert into sf_ids values ('s_brief', s2);
  with x as (insert into public.custom_fields (project_id, name, field_type, description, in_library)
    values (m1, 'Owner', 'text', 'Who owns it', true) returning id) insert into sf_ids select 's_owner1', id from x;
  with x as (insert into public.custom_fields (project_id, name, field_type, description, in_library)
    values (m4, 'Owner', 'text', 'Who owns it', true) returning id) insert into sf_ids select 's_owner2', id from x;

  -- Same option ids (other names, other order) → linked.
  with x as (insert into public.custom_fields (project_id, name, field_type, options)
    values (m2, ' stage ', 'single_select',
      '[{"id": "st-b", "name": "B", "color": "red"}, {"id": "st-a", "name": "A", "color": "red"}]') returning id) insert into sf_ids select 'c_stage', id from x;
  -- Same name, other options → not linked.
  with x as (insert into public.custom_fields (project_id, name, field_type, options)
    values (m3, 'Stage', 'single_select', '[{"id": "st-a", "name": "Ay", "color": "blue"}]') returning id) insert into sf_ids select 'c_stage_other', id from x;
  -- Same options but made before the source → not linked.
  with x as (insert into public.custom_fields (project_id, name, field_type, options)
    values (m4, 'Stage', 'single_select', opts) returning id) insert into sf_ids select 'c_stage_early', id from x;
  -- Text with the same description (trimmed) → linked; without one → not linked.
  with x as (insert into public.custom_fields (project_id, name, field_type, description)
    values (m2, 'BRIEF', 'text', ' The brief ') returning id) insert into sf_ids select 'c_brief', id from x;
  with x as (insert into public.custom_fields (project_id, name, field_type)
    values (m3, 'Brief', 'text') returning id) insert into sf_ids select 'c_brief_bare', id from x;
  -- Matches two library fields → left alone.
  with x as (insert into public.custom_fields (project_id, name, field_type, description)
    values (m2, 'Owner', 'text', 'Who owns it') returning id) insert into sf_ids select 'c_owner', id from x;
  -- Two candidates in one project → both left alone.
  with x as (insert into public.custom_fields (project_id, name, field_type, description)
    values (m5, 'Brief', 'text', 'The brief') returning id) insert into sf_ids select 'c_brief_twin1', id from x;
  with x as (insert into public.custom_fields (project_id, name, field_type, description)
    values (m5, 'brief', 'text', 'The brief') returning id) insert into sf_ids select 'c_brief_twin2', id from x;

  -- Values. V1: only M1 has one. V2: both equal. V3: both differ. V4: only in M2.
  t := public.create_task(m1, (select id from sf_ids where name = 'sm1'), 'Link V1');
  insert into sf_ids values ('v1', t);
  insert into public.task_projects (task_id, project_id, section_id) values (t, m2, (select id from sf_ids where name = 'sm2'));
  insert into public.task_field_values (task_id, field_id, value) values (t, s1, '"st-a"'), (t, s2, '"Write it up"');
  t := public.create_task(m1, (select id from sf_ids where name = 'sm1'), 'Link V2');
  insert into sf_ids values ('v2', t);
  insert into public.task_projects (task_id, project_id, section_id) values (t, m2, (select id from sf_ids where name = 'sm2'));
  insert into public.task_field_values (task_id, field_id, value) values
    (t, s1, '"st-b"'), (t, (select id from sf_ids where name = 'c_stage'), '"st-b"');
  t := public.create_task(m1, (select id from sf_ids where name = 'sm1'), 'Link V3');
  insert into sf_ids values ('v3', t);
  insert into public.task_projects (task_id, project_id, section_id) values (t, m2, (select id from sf_ids where name = 'sm2'));
  insert into public.task_field_values (task_id, field_id, value) values
    (t, s1, '"st-a"'), (t, (select id from sf_ids where name = 'c_stage'), '"st-b"');
  t := public.create_task(m2, (select id from sf_ids where name = 'sm2'), 'Link V4');
  insert into sf_ids values ('v4', t);
  insert into public.task_field_values (task_id, field_id, value) values (t, (select id from sf_ids where name = 'c_stage'), '"st-b"');
end $$;
reset role;

do $$
declare
  result jsonb;
  again jsonb;
  stories integer;
  v1 uuid := (select id from sf_ids where name = 'v1');
  v3 uuid := (select id from sf_ids where name = 'v3');
  s1 uuid := (select id from sf_ids where name = 's_stage');
  c_stage uuid := (select id from sf_ids where name = 'c_stage');
begin
  -- Creation order: sources first, the early copy before them, the rest after.
  update public.custom_fields set created_at = now() - interval '10 days'
  where id in (select id from sf_ids where name in ('s_stage', 's_brief', 's_owner1', 's_owner2'));
  update public.custom_fields set created_at = now() - interval '20 days' where id = (select id from sf_ids where name = 'c_stage_early');
  update public.custom_fields set created_at = now() - interval '5 days'
  where id in (select id from sf_ids where name like 'c\_%' and name <> 'c_stage_early');

  select count(*) into stories from public.task_stories where task_id = v1 and kind = 'field_changed';
  result := public.link_library_field_copies();
  assert (result ->> 'linked')::integer >= 2 and (result ->> 'filled')::integer >= 2
    and (result ->> 'conflicts')::integer >= 1 and (result ->> 'ambiguous')::integer >= 3, format('counts: %s', result);

  assert (select library_field_id from public.custom_fields where id = c_stage) = s1, 'same option ids: linked';
  assert (select matched_by from public.library_field_links where field_id = c_stage) = 'options', 'recorded as an options match';
  assert (select previous_definition ->> 'name' = ' stage '
            and previous_definition -> 'options' -> 0 ->> 'name' = 'B'
          from public.library_field_links where field_id = c_stage), 'with the definition it had before';
  assert (select name = 'Stage' and options = (select options from public.custom_fields where id = s1)
          from public.custom_fields where id = c_stage), 'the copy takes the library definition';
  assert (select library_field_id from public.custom_fields where id = (select id from sf_ids where name = 'c_brief'))
    = (select id from sf_ids where name = 's_brief'), 'same description: linked';
  assert (select matched_by from public.library_field_links where field_id = (select id from sf_ids where name = 'c_brief')) = 'description',
    'recorded as a description match';
  assert (select count(*) from public.custom_fields
          where id in (select id from sf_ids where name in ('c_stage_other', 'c_stage_early', 'c_brief_bare', 'c_owner',
                                                             'c_brief_twin1', 'c_brief_twin2'))
            and library_field_id is not null) = 0,
    'other options, made earlier, no description, two library fields, two in one project: left alone';

  -- Values.
  assert (select value from public.task_field_values where task_id = v1 and field_id = c_stage) = '"st-a"', 'V1 filled';
  assert (select value from public.task_field_values where task_id = v1 and field_id = (select id from sf_ids where name = 'c_brief'))
    = '"Write it up"', 'V1''s text filled';
  assert (select count(*) from public.task_stories where task_id = v1 and kind = 'field_changed') = stories, 'quietly';
  assert (select value from public.task_field_values where task_id = (select id from sf_ids where name = 'v2') and field_id = c_stage) = '"st-b"',
    'V2 equal: unchanged';
  assert (select value from public.task_field_values where task_id = v3 and field_id = s1) = '"st-a"'
    and (select value from public.task_field_values where task_id = v3 and field_id = c_stage) = '"st-b"', 'V3: both kept';
  assert (select count(*) from public.library_field_link_conflicts
          where task_id = v3 and field_id = c_stage and value = '"st-b"' and other_field_id = s1 and other_value = '"st-a"') = 1,
    'V3: the conflict is recorded';
  assert (select value from public.task_field_values where task_id = (select id from sf_ids where name = 'v4') and field_id = c_stage)
    = '"st-b"', 'V4 (one project): untouched';

  -- Running it again changes nothing for these.
  again := public.link_library_field_copies();
  assert (select count(*) from public.library_field_links where field_id = c_stage) = 1, 'linked once';
  assert (select count(*) from public.library_field_link_conflicts where task_id = v3) = 1, 'the conflict is recorded once';
end $$;

-- Linked fields share from now on.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7c30029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  v1 uuid := (select id from sf_ids where name = 'v1');
begin
  update public.task_field_values set value = '"st-b"'
  where task_id = v1 and field_id = (select id from sf_ids where name = 'c_stage');
  assert (select value from public.task_field_values where task_id = v1 and field_id = (select id from sf_ids where name = 's_stage'))
    = '"st-b"', 'after linking, a change through the copy reaches the library field';
end $$;
reset role;

-- A copy that doesn't fit the other placement is skipped; the person's own write stands. (Forced here
-- by narrowing the placement's options behind the definition sync's back.)
do $$
begin
  perform set_config('alhc.library_definition_sync', 'on', true);
  update public.custom_fields set options = '[{"id": "st-b", "name": "Bee", "color": "pink"}]'
  where id = (select id from sf_ids where name = 'c_stage');
  perform set_config('alhc.library_definition_sync', '', true);
end $$;
set role authenticated;
do $$
declare
  v1 uuid := (select id from sf_ids where name = 'v1');
begin
  update public.task_field_values set value = '"st-a"'
  where task_id = v1 and field_id = (select id from sf_ids where name = 's_stage');
  assert found, 'the write through SF M1 succeeds';
  assert (select value from public.task_field_values where task_id = v1 and field_id = (select id from sf_ids where name = 's_stage'))
    = '"st-a"', 'and keeps its value';
  assert (select value from public.task_field_values where task_id = v1 and field_id = (select id from sf_ids where name = 'c_stage'))
    = '"st-b"', 'the copy that doesn''t fit was skipped';
end $$;
reset role;

do $$
begin
  raise notice 'oct 29 batch 7 t3 shared fields smoke: all assertions passed';
end $$;
