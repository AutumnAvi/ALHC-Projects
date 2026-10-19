-- Oct 19 test notes (20261019020000_oct19_notes.sql).
-- 1. Task numbering: "Wrap the label in brackets" on and off reaches every reader
--    (task_request_labels, task_request_display_label, email_design_context), plus the settings
--    that didn't take effect: a reset period and a per-field counter (task creation failed),
--    "Number subtasks" off / on, {parent} after one save, a sequence apply_task_numbering creates,
--    and Duplicate project keeping every setting.
--   a1a19019…01 o19-owner@example.com   owner
--   a1a19019…02 o19-viewer@example.com  viewer
--   a1a19019…03 o19-out@example.com     allowlisted, not a member

\set ON_ERROR_STOP 1

create temporary table o19_ids (name text primary key, id uuid) on commit preserve rows;
grant all on o19_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('o19-owner@example.com', 'oct 19 notes'),
  ('o19-viewer@example.com', 'oct 19 notes'),
  ('o19-out@example.com', 'oct 19 notes');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a1a19019-0000-4000-8000-000000000001', 'o19-owner@example.com', now(), '{"full_name":"Olive Owner"}'),
  ('a1a19019-0000-4000-8000-000000000002', 'o19-viewer@example.com', now(), '{"full_name":"Victor Viewer"}'),
  ('a1a19019-0000-4000-8000-000000000003', 'o19-out@example.com', now(), '{"full_name":"Oscar Outsider"}');

-- ---------------------------------------------------------------------------------------------
-- 1. Task numbering
-- ---------------------------------------------------------------------------------------------

do $$
begin
  assert not (select prosecdef from pg_proc where oid = 'public.request_display_label(text, boolean)'::regprocedure),
    'request_display_label is not a definer';
  assert not (select prosecdef from pg_proc where oid = 'public.task_request_display_label(uuid)'::regprocedure),
    'task_request_display_label is invoker';
  assert not (select prosecdef from pg_proc where oid = 'public.task_request_labels(uuid[])'::regprocedure),
    'task_request_labels is invoker';
  assert not has_function_privilege('anon', 'public.task_request_labels(uuid[])', 'execute'), 'anon: no label map';
  assert not has_function_privilege('anon', 'public.task_request_display_label(uuid)', 'execute'), 'anon: no display label';
  assert not has_function_privilege('anon', 'public.request_display_label(text, boolean)', 'execute'), 'anon: no helper';
  assert has_function_privilege('authenticated', 'public.task_request_labels(uuid[])', 'execute'), 'members read labels';
  assert pg_get_functiondef('public.allocate_request_number(uuid, text, text)'::regprocedure)
    like '%on conflict on constraint request_counters_key%', 'the counter upsert names its constraint';
  assert public.request_display_label('Task #3', true) = '[Task #3]', 'wrapped';
  assert public.request_display_label('Task #3', false) = 'Task #3', 'bare';
  assert public.request_display_label('  ', true) is null and public.request_display_label(null, false) is null,
    'no label, nothing to show';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'a1a19019-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  p uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'Brackets')
    returning id into p;
  perform public.add_project_member(p, 'o19-viewer@example.com', 'viewer');
  insert into o19_ids values ('p', p);
  insert into o19_ids values ('alpha', public.create_task(p, null, 'Alpha'));
end $$;

-- Its own transaction, so it's numbered after Alpha (numbers go in creation order).
do $$
begin
  insert into o19_ids values ('beta', public.create_task((select id from o19_ids where name = 'p'), null, 'Beta'));
end $$;

-- Brackets ON: the exact settings object saveTaskNumbering sends.
do $$
declare
  p uuid := (select id from o19_ids where name = 'p');
  a uuid := (select id from o19_ids where name = 'alpha');
  labels jsonb;
begin
  perform public.apply_task_numbering(p, jsonb_build_object(
    'enabled', true, 'template', 'Task #{n}', 'wrap_brackets', true, 'add_to_title', false,
    'number_scope', 'all_tasks', 'section_ids', '[]'::jsonb, 'task_kinds', '["task","milestone","approval"]'::jsonb,
    'number_subtasks', true, 'subtask_separator', '.', 'reuse_deleted', false, 'fill_gaps', false,
    'reset_period', 'never', 'counter_field_id', null, 'project_code', '', 'renumber_on_move', false,
    'time_zone', 'UTC', 'start_number', 1
  ), 'number_missing');
  assert public.task_request_label(a) = 'Task #1', 'bare label';
  assert public.task_request_display_label(a) = '[Task #1]', 'wrapped display label';
  labels := public.task_request_labels(array[a]);
  assert labels -> a::text ->> 'label' = 'Task #1', format('map label: %s', labels);
  assert (labels -> a::text ->> 'wrap')::boolean, 'map says wrap';
  assert (select title from public.tasks where id = a) = 'Alpha', 'title stays bare';
end $$;

-- Brackets OFF: saved, read back, and every reader follows it (new tasks, subtasks, renumber).
do $$
declare
  p uuid := (select id from o19_ids where name = 'p');
  a uuid := (select id from o19_ids where name = 'alpha');
  g uuid;
  child uuid;
  labels jsonb;
begin
  perform public.apply_task_numbering(p, jsonb_build_object('wrap_brackets', false, 'template', 'Task #{n}'), 'save');
  assert not (select wrap_brackets from public.request_sequences where project_id = p), 'the setting is stored';
  assert public.task_request_display_label(a) = 'Task #1', 'no brackets on an existing task';
  labels := public.task_request_labels(array[a]);
  assert not (labels -> a::text ->> 'wrap')::boolean, format('map says no wrap: %s', labels);
  g := public.create_task(p, null, 'Gamma');
  insert into o19_ids values ('gamma', g);
  assert (select title from public.tasks where id = g) = 'Gamma', 'a new task title stays bare';
  assert public.task_request_display_label(g) = 'Task #3', 'a new task, no brackets';
  child := public.create_subtask(a, 'Alpha part', null);
  insert into o19_ids values ('alpha_child', child);
  assert public.task_request_display_label(child) = 'Task #1.1', 'a subtask, no brackets';
  assert (public.task_request_labels(array[child]) -> child::text ->> 'label') = 'Task #1.1', 'subtask in the map';
end $$;

do $$
declare
  p uuid := (select id from o19_ids where name = 'p');
  a uuid := (select id from o19_ids where name = 'alpha');
  g uuid := (select id from o19_ids where name = 'gamma');
begin
  perform public.apply_task_numbering(p, jsonb_build_object('confirmation', 'RENUMBER'), 'renumber');
  assert public.task_request_display_label(a) = 'Task #1', 'renumbered, still no brackets';
  assert public.task_request_display_label(g) = 'Task #3', 'renumber starts at the start number';
  assert (select title from public.tasks where id = a) = 'Alpha' and (select title from public.tasks where id = g) = 'Gamma',
    'renumbering never touches titles';
  perform public.apply_task_numbering(p, jsonb_build_object('wrap_brackets', true), 'save');
  assert public.task_request_display_label(g) = '[Task #3]', 'brackets come back';
  perform public.apply_task_numbering(p, jsonb_build_object('wrap_brackets', false), 'save');
end $$;

-- A viewer reads the same labels; a non-member reads none.
select set_config('request.jwt.claim.sub', 'a1a19019-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from o19_ids where name = 'alpha');
begin
  assert public.task_request_labels(array[a]) -> a::text ->> 'label' = 'Task #1', 'viewer reads the label';
  assert public.task_request_display_label(a) = 'Task #1', 'viewer: display label';
end $$;
select set_config('request.jwt.claim.sub', 'a1a19019-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from o19_ids where name = 'alpha');
begin
  assert public.task_request_labels(array[a]) = '{}'::jsonb, 'outsider: empty map';
  assert public.task_request_display_label(a) is null, 'outsider: no display label';
end $$;
select set_config('request.jwt.claim.sub', 'a1a19019-0000-4000-8000-000000000001', false) is not null as ok \gset

-- Numbering off hides labels and keeps the numbers.
do $$
declare
  p uuid := (select id from o19_ids where name = 'p');
  a uuid := (select id from o19_ids where name = 'alpha');
begin
  perform public.apply_task_numbering(p, jsonb_build_object('enabled', false), 'save');
  assert public.task_request_labels(array[a]) = '{}'::jsonb, 'off: nothing in the map';
  assert public.task_request_display_label(a) is null, 'off: no display label';
  assert (select req_number from public.tasks where id = a) = 1, 'the stored number stays';
  perform public.apply_task_numbering(p, jsonb_build_object('enabled', true), 'save');
  assert public.task_request_display_label(a) = 'Task #1', 'on again: the label is back';
end $$;

-- "Number subtasks" off hides subtask labels; on again (Save) numbers the ones made meanwhile.
do $$
declare
  p uuid := (select id from o19_ids where name = 'p');
  a uuid := (select id from o19_ids where name = 'alpha');
  child uuid := (select id from o19_ids where name = 'alpha_child');
  late uuid;
begin
  perform public.apply_task_numbering(p, jsonb_build_object('number_subtasks', false), 'save');
  assert public.task_request_label(child) is null, 'subtask label hidden';
  assert not (public.task_request_labels(array[a, child]) ? child::text), 'subtask not in the map';
  assert public.task_request_labels(array[a, child]) ? a::text, 'top-level task still is';
  late := public.create_subtask(a, 'Made while off', null);
  insert into o19_ids values ('late_child', late);
  assert (select req_subindex from public.tasks where id = late) is null, 'no index while off';
  perform public.apply_task_numbering(p, jsonb_build_object('number_subtasks', true), 'save');
  assert public.task_request_label(child) = 'Task #1.1', 'the old subtask label is back';
  assert public.task_request_label(late) = 'Task #1.2', format('Save numbers the late subtask: %s', public.task_request_label(late));
end $$;

-- {parent} is current after one save, at every depth.
do $$
declare
  p uuid := (select id from o19_ids where name = 'p');
  a uuid := (select id from o19_ids where name = 'alpha');
  child uuid := (select id from o19_ids where name = 'alpha_child');
  grandchild uuid;
begin
  grandchild := public.create_subtask(child, 'Deeper', null);
  perform public.apply_task_numbering(p, jsonb_build_object('template', 'J{parent}/{n}'), 'save');
  assert public.task_request_label(a) = 'J/1', format('top level: %s', public.task_request_label(a));
  assert public.task_request_label(child) = 'JJ/1/1.1', format('child: %s', public.task_request_label(child));
  assert public.task_request_label(grandchild) = 'JJJ/1/1.1/1.1.1', format('grandchild: %s', public.task_request_label(grandchild));
  perform public.apply_task_numbering(p, jsonb_build_object('template', 'Task #{n}'), 'save');
end $$;

-- A yearly reset and a per-field counter no longer break task creation and field writes.
do $$
declare
  p uuid;
  t uuid;
  f uuid;
  u uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'Yearly')
    returning id into p;
  insert into o19_ids values ('yearly', p);
  perform public.apply_task_numbering(p, jsonb_build_object(
    'enabled', true, 'template', '{yyyy}-{n}', 'reset_period', 'yearly', 'wrap_brackets', false,
    'number_scope', 'all_tasks'
  ), 'save');
  t := public.create_task(p, null, 'First of the year');
  assert (select req_number from public.tasks where id = t) = 1, 'a reset period starts at 1';
  assert public.task_request_display_label(t) = to_char(now() at time zone 'UTC', 'YYYY') || '-1', 'year label';
  assert (select title from public.tasks where id = t) = 'First of the year',
    'a sequence apply_task_numbering created never bakes the label into titles';

  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'Offices')
    returning id into p;
  insert into o19_ids values ('offices', p);
  insert into public.custom_fields (project_id, name, field_type, options)
  values (p, 'Office', 'single_select', '[{"id":"hq","name":"HQ"},{"id":"north","name":"North"}]')
  returning id into f;
  perform public.apply_task_numbering(p, jsonb_build_object(
    'enabled', true, 'template', '{field:Office}-{n}', 'counter_field_id', f, 'wrap_brackets', true,
    'project_code', 'OF', 'subtask_separator', '-', 'time_zone', 'America/New_York', 'renumber_on_move', true,
    'number_scope', 'all_tasks'
  ), 'save');
  u := public.create_task(p, null, 'Office task');
  insert into public.task_field_values (task_id, field_id, value) values (u, f, '"hq"');
  assert public.task_request_display_label(u) = '[HQ-1]', format('per-field counter: %s', public.task_request_display_label(u));
end $$;

-- Duplicate project keeps every numbering setting, with the counter field pointing at the copy's field.
do $$
declare
  src uuid := (select id from o19_ids where name = 'offices');
  result jsonb;
  copy_id uuid;
  s public.request_sequences;
begin
  result := public.duplicate_project(src, 'Offices copy', '{"tasks": false}'::jsonb);
  copy_id := (result ->> 'project_id')::uuid;
  select * into s from public.request_sequences where project_id = copy_id;
  assert s.template = '{field:Office}-{n}', format('template copied: %s', s.template);
  assert s.wrap_brackets, 'wrap copied';
  assert s.project_code = 'OF' and s.subtask_separator = '-' and s.renumber_on_move, 'code, separator, move copied';
  assert s.time_zone = 'America/New_York', 'time zone copied';
  assert s.counter_field_id is not null
    and (select project_id from public.custom_fields where id = s.counter_field_id) = copy_id,
    'the counter field is the copy''s own field';
  assert not s.add_to_title or (select add_to_title from public.request_sequences where project_id = src),
    'add_to_title follows the source';
end $$;

reset role;

-- The drain learns the bracket setting at send time.
do $$
declare
  a uuid := (select id from o19_ids where name = 'alpha');
  e uuid;
begin
  e := public.enqueue_email('someone@example.com', 'custom', 'Hello', '{"message":"x"}'::jsonb, a);
  insert into o19_ids values ('email', e);
end $$;
set role service_role;
do $$
declare
  e uuid := (select id from o19_ids where name = 'email');
begin
  assert public.email_design_context(e) -> 'values' ->> 'request_wrap' = 'false',
    format('wrap off reaches the drain: %s', public.email_design_context(e) -> 'values');
end $$;
reset role;
update public.request_sequences set wrap_brackets = true where project_id = (select id from o19_ids where name = 'p');
set role service_role;
do $$
begin
  assert public.email_design_context((select id from o19_ids where name = 'email')) -> 'values' ->> 'request_wrap' = 'true',
    'wrap on reaches the drain';
end $$;
reset role;

do $$ begin raise notice 'oct 19 notes smoke: all assertions passed'; end $$;
