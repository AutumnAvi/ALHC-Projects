-- Oct 19 test notes (20261019020000_oct19_notes.sql).
-- 1. Task numbering: "Wrap the label in brackets" on and off reaches every reader
--    (task_request_labels, task_request_display_label, email_design_context), plus the settings
--    that didn't take effect: a reset period and a per-field counter (task creation failed),
--    "Number subtasks" off / on, {parent} after one save, a sequence apply_task_numbering creates,
--    and Duplicate project keeping every setting.
-- 2. Email control: the new design settings (grants, guard, resolution), the SQL subject fill-in
--    (parity vectors shared with the unit tests), and a response's subject rendered by the database:
--    the same on the comment, its thread, its email, later responses, a subtask's, and the reply.
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

-- ---------------------------------------------------------------------------------------------
-- 2. Email control: subject and heading templates, small print, show / hide per block
-- ---------------------------------------------------------------------------------------------

do $$
declare
  col text;
begin
  foreach col in array array['subject_template', 'heading_text', 'notice_text', 'show_logo', 'show_header', 'show_heading',
    'show_intro', 'show_body', 'show_details', 'show_button', 'show_notice', 'show_footer'] loop
    assert has_column_privilege('authenticated', 'public.email_designs', col, 'INSERT')
      and has_column_privilege('authenticated', 'public.email_designs', col, 'UPDATE'),
      format('designers write %s', col);
    assert not has_column_privilege('anon', 'public.email_designs', col, 'SELECT'), format('anon: no %s', col);
  end loop;
  assert not (select prosecdef from pg_proc where oid = 'public.email_subject_fill_in(text,jsonb,text)'::regprocedure)
    and not (select prosecdef from pg_proc where oid = 'public.submitter_response_subject(uuid,uuid)'::regprocedure),
    'the subject helpers are not definers';
  assert not has_function_privilege('authenticated', 'public.email_subject_fill_in(text,jsonb,text)', 'execute')
    and not has_function_privilege('anon', 'public.email_subject_fill_in(text,jsonb,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.submitter_response_subject(uuid,uuid)', 'execute')
    and not has_function_privilege('anon', 'public.submitter_response_subject(uuid,uuid)', 'execute'),
    'clients call neither subject helper';
end $$;

-- The SQL fill-in matches the app's (the same vectors are in tests/unit/email-design-blocks.test.ts).
do $$
begin
  assert public.email_subject_fill_in('Re: {request_number} – {Task_Name} for { requester_name } {nonsense}{task_link}',
    jsonb_build_object('request_number', 'Req #042', 'task_name', E'  Spring\tflyer ', 'requester_name', 'Jordan', 'task_link', 'x'),
    'requester') = 'Re: Req #042 – Spring flyer for Jordan', 'tokens, case, spaces in braces, unknown and internal-only fields';
  assert public.email_subject_fill_in(E'[Creative]\n  {email_subject}  ', jsonb_build_object('email_subject', '{task_name} \ back'),
    'internal') = '[Creative] {task_name} \ back', 'one line; a value is never filled in again; backslashes kept';
  assert public.email_subject_fill_in('{task_link}', '{"task_link":"L"}', 'internal') = 'L', 'task_link for internal emails';
  assert public.email_subject_fill_in('{task_link}', '{"task_link":"L"}', 'requester') = '', 'never for requester emails';
  assert public.email_subject_fill_in('Due {due_date}', '{"due_date":"Sep 5, 2026"}', 'requester') = 'Due Sep 5, 2026', 'dates';
  assert public.email_subject_fill_in(repeat('é', 310), '{}', 'requester') = repeat('é', 300), 'cut at 300 characters';
  assert public.email_subject_fill_in('', '{}', 'requester') = '' and public.email_subject_fill_in(null, '{}', 'requester') = '',
    'empty in, empty out';
  assert to_char(date '2026-09-05', 'Mon FMDD, YYYY') = 'Sep 5, 2026', 'the due date reads like the app''s';
end $$;

-- A project with two forms; the owner designs, the viewer reads.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a1a19019-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid;
  s uuid;
  fa uuid;
  fb uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'O19 Mail') returning id into p;
  insert into public.sections (project_id, name, sort_order) values (p, 'Intake', 1024) returning id into s;
  perform public.add_project_member(p, 'o19-viewer@example.com', 'viewer');
  insert into public.forms (project_id, title, accepting_responses, send_confirmation, destination_section_id, questions)
  values (p, 'Mail Form', true, false, s, '[{"id":"q1","type":"short_text","label":"Your name"}]'::jsonb) returning id into fa;
  insert into public.forms (project_id, title, accepting_responses, send_confirmation, destination_section_id)
  values (p, 'Mail Other', true, false, s) returning id into fb;
  insert into o19_ids values ('mp', p), ('fa', fa), ('fb', fb);
end $$;
reset role;

set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
insert into o19_ids select 'ma1', (public.submit_form((select id from o19_ids where name = 'fa'), 'Rhea@Example.org', '{"q1":"Rhea Rowntree"}') ->> 'task_id')::uuid;
insert into o19_ids select 'ma2', (public.submit_form((select id from o19_ids where name = 'fa'), 'rhea2@example.org', '{"q1":"Rex Second"}') ->> 'task_id')::uuid;
insert into o19_ids select 'mb1', (public.submit_form((select id from o19_ids where name = 'fb'), 'bea@example.org', '{}') ->> 'task_id')::uuid;
insert into o19_ids select 'mb2', (public.submit_form((select id from o19_ids where name = 'fb'), 'bo@example.org', '{}') ->> 'task_id')::uuid;
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', 'a1a19019-0000-4000-8000-000000000001', false) is not null as ok \gset
-- No template: Asana's subject, as before.
insert into o19_ids select 'rb1', public.send_submitter_response((select id from o19_ids where name = 'mb1'), 'First, no template');
do $$
begin
  assert (select email_subject from public.comments where id = (select id from o19_ids where name = 'rb1')) = 'Re: "Mail Other" submission received',
    'no template = the default subject';
end $$;

-- The guard puts a pasted subject on one line and trims; the CHECKs keep the limits.
insert into public.email_designs (workspace_id, kind, project_id, subject_template, heading_text, show_heading, show_details)
values ('00000000-0000-4000-8000-000000000001', 'requester', (select id from o19_ids where name = 'mp'),
  E'Proj:  {form_name}\n', '  Hello  ', false, false);
insert into public.email_designs (workspace_id, kind, project_id, form_id, subject_template, show_heading)
values ('00000000-0000-4000-8000-000000000001', 'requester', (select id from o19_ids where name = 'mp'),
  (select id from o19_ids where name = 'fa'), 'Re: {request_number} {task_name} for {requester_name} {nonsense}{task_link}', true);
do $$
declare
  p uuid := (select id from o19_ids where name = 'mp');
  d jsonb;
begin
  assert (select subject_template from public.email_designs where project_id = p and form_id is null and deleted_at is null) = 'Proj: {form_name}'
    and (select heading_text from public.email_designs where project_id = p and form_id is null and deleted_at is null) = 'Hello',
    'subject collapsed to one line, heading trimmed';
  begin
    update public.email_designs set heading_text = repeat('h', 301) where project_id = p and form_id is null and deleted_at is null;
    raise exception 'a heading over 300 characters should fail';
  exception when check_violation then null;
  end;
  begin
    update public.email_designs set notice_text = repeat('n', 501) where project_id = p and form_id is null and deleted_at is null;
    raise exception 'small print over 500 characters should fail';
  exception when check_violation then null;
  end;
  -- Resolution: the form's switch beats the project's; another form gets the project's; kinds never mix.
  d := public.resolve_email_design('requester', p, (select id from o19_ids where name = 'fa'));
  assert (d ->> 'show_heading')::boolean and not (d ->> 'show_details')::boolean
    and d ->> 'subject_template' like 'Re: {request_number}%' and d ->> 'heading_text' = 'Hello',
    format('form, then project: %s', d);
  d := public.resolve_email_design('requester', p, (select id from o19_ids where name = 'fb'));
  assert not (d ->> 'show_heading')::boolean and d ->> 'subject_template' = 'Proj: {form_name}', 'another form: the project''s';
  assert d ->> 'show_logo' is null, 'a switch nobody set = the built-in default';
  d := public.resolve_email_design('internal', p, null);
  assert d ->> 'show_heading' is null and d ->> 'subject_template' is null, 'internal emails don''t see requester settings';
end $$;
reset role;

-- The viewer can't change a design.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a1a19019-0000-4000-8000-000000000002', false) is not null as ok \gset
update public.email_designs set subject_template = 'Hijack' where project_id = (select id from o19_ids where name = 'mp');
reset role;
do $$
begin
  assert not exists (select 1 from public.email_designs where subject_template = 'Hijack'), 'a Viewer can''t change a design';
end $$;

-- A response under the form's template: the comment, its thread, and its email share the rendered subject.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a1a19019-0000-4000-8000-000000000001', false) is not null as ok \gset
insert into o19_ids select 'ra1', public.send_submitter_response((select id from o19_ids where name = 'ma1'), 'Hi Rhea');
reset role;
do $$
declare
  t uuid := (select id from o19_ids where name = 'ma1');
  expected text;
  c public.comments;
begin
  expected := 'Re: ' || coalesce(public.task_request_label(t) || ' ', '') || (select title from public.tasks where id = t) || ' for Rhea Rowntree';
  select * into c from public.comments where id = (select id from o19_ids where name = 'ra1');
  assert c.email_subject = expected, format('the form''s template, filled in: %s (expected %s)', c.email_subject, expected);
  assert (select subject from public.email_outbox where payload ->> 'comment_id' = c.id::text) = expected, 'the email''s subject';
  assert (select subject from public.submitter_reply_threads where task_id = t and revoked_at is null) = expected, 'the thread''s subject';
  perform set_config('o19.subject', expected, false);
end $$;

-- A later response keeps the conversation's subject, even after the template changes; so does a subtask's.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a1a19019-0000-4000-8000-000000000001', false) is not null as ok \gset
update public.email_designs set subject_template = 'Changed {task_name}'
where form_id = (select id from o19_ids where name = 'fa') and deleted_at is null;
insert into o19_ids select 'ra2', public.send_submitter_response((select id from o19_ids where name = 'ma1'), 'Second');
insert into o19_ids select 'msub', public.create_subtask((select id from o19_ids where name = 'ma1'), 'Mail subtask', null);
insert into o19_ids select 'rsub', public.send_submitter_response((select id from o19_ids where name = 'msub'), 'From the subtask');
-- A template that renders empty falls back to the default subject.
update public.email_designs set subject_template = '{nonsense} {task_link}'
where form_id = (select id from o19_ids where name = 'fa') and deleted_at is null;
insert into o19_ids select 'ra3', public.send_submitter_response((select id from o19_ids where name = 'ma2'), 'Blank template');
-- The project's template on the other form; the conversation that started before it keeps its subject.
insert into o19_ids select 'rb2', public.send_submitter_response((select id from o19_ids where name = 'mb2'), 'Project template');
insert into o19_ids select 'rb3', public.send_submitter_response((select id from o19_ids where name = 'mb1'), 'Second, after the template');
reset role;
do $$
declare
  expected text := current_setting('o19.subject');
begin
  assert (select email_subject from public.comments where id = (select id from o19_ids where name = 'ra2')) = expected
    and (select subject from public.email_outbox where payload ->> 'comment_id' = (select id::text from o19_ids where name = 'ra2')) = expected,
    'a conversation keeps its subject';
  assert (select email_subject from public.comments where id = (select id from o19_ids where name = 'rsub')) = expected, 'a subtask''s response too';
  assert (select email_subject from public.comments where id = (select id from o19_ids where name = 'ra3')) = 'Re: "Mail Form" submission received',
    'a template that renders empty = the default';
  assert (select email_subject from public.comments where id = (select id from o19_ids where name = 'rb2')) = 'Proj: Mail Other',
    'the project''s template on another form';
  assert (select email_subject from public.comments where id = (select id from o19_ids where name = 'rb3')) = 'Re: "Mail Other" submission received',
    'an older conversation keeps the subject it started with';
end $$;

-- The submitter's reply comes back under the same subject.
set role service_role;
do $$
declare
  result jsonb;
  tok text;
begin
  select token into tok from public.submitter_reply_threads where task_id = (select id from o19_ids where name = 'ma1') and revoked_at is null;
  result := public.post_submitter_reply(tok, 'rhea@example.org', 'Thanks!', 'o19-reply-1');
  assert result ->> 'status' = 'posted', format('the reply posts: %s', result);
  assert (select email_subject from public.comments where id = (result ->> 'comment_id')::uuid) = current_setting('o19.subject'),
    'the reply carries the conversation''s subject';
end $$;
reset role;

-- The pane reads the conversation's subject (Viewers); outsiders learn nothing.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a1a19019-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  assert public.submitter_thread_status((select id from o19_ids where name = 'ma1')) ->> 'subject' = current_setting('o19.subject'),
    'a Viewer sees the conversation''s subject';
end $$;
select set_config('request.jwt.claim.sub', 'a1a19019-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
begin
  assert public.submitter_thread_status((select id from o19_ids where name = 'ma1')) is null, 'an outsider sees nothing';
end $$;
reset role;

do $$ begin raise notice 'oct 19 notes smoke: all assertions passed'; end $$;
