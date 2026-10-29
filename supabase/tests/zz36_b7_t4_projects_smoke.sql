-- Oct 29 notes, batch 7 — track T4 (20261029010400_b7_t4_projects.sql): 55b. No home project.
--   b7d40029…01 b7t4-owner@example.com   owner of T4 A, T4 B, T4 C, T4 D
--   b7d40029…02 b7t4-editor@example.com  Editor of T4 A, T4 B, T4 D (not T4 C)
--   b7d40029…03 b7t4-viewer@example.com  Viewer of T4 B only

\set ON_ERROR_STOP 1

insert into public.allowed_emails (email, note) values
  ('b7t4-owner@example.com', 'oct 29 batch 7 t4'),
  ('b7t4-editor@example.com', 'oct 29 batch 7 t4'),
  ('b7t4-viewer@example.com', 'oct 29 batch 7 t4');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b7d40029-0000-4000-8000-000000000001', 'b7t4-owner@example.com', now(), '{"full_name":"Oona Owner"}'),
  ('b7d40029-0000-4000-8000-000000000002', 'b7t4-editor@example.com', now(), '{"full_name":"Eddie Editor"}'),
  ('b7d40029-0000-4000-8000-000000000003', 'b7t4-viewer@example.com', now(), '{"full_name":"Vera Viewer"}');

create temporary table b7t4_ids (name text primary key, id uuid);
grant all on b7t4_ids to authenticated, anon;

-- ---------------------------------------------------------------------------------------------
-- Setup: A ("A-{n}"), B ("B-{n}"), C ("C-{n}", the editor can't open it), D (numbers only one
-- section's tasks and renumbers on move).
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7d40029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  a uuid;
  b uuid;
  c uuid;
  d uuid;
  sa uuid;
  sd uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'T4 A') returning id into a;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'T4 B') returning id into b;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'T4 C') returning id into c;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'T4 D') returning id into d;
  insert into public.sections (project_id, name, sort_order) values (a, 'Intake', 1024) returning id into sa;
  insert into public.sections (project_id, name, sort_order) values (d, 'Numbered', 1024) returning id into sd;
  insert into b7t4_ids values ('a', a), ('b', b), ('c', c), ('d', d), ('sa', sa), ('sd', sd);
  perform public.add_project_member(a, 'b7t4-editor@example.com', 'editor');
  perform public.add_project_member(b, 'b7t4-editor@example.com', 'editor');
  perform public.add_project_member(d, 'b7t4-editor@example.com', 'editor');
  perform public.add_project_member(b, 'b7t4-viewer@example.com', 'viewer');
  perform public.apply_task_numbering(a, '{"enabled": true, "number_scope": "all_tasks", "template": "A-{n}"}'::jsonb, 'save');
  perform public.apply_task_numbering(b, '{"enabled": true, "number_scope": "all_tasks", "template": "B-{n}"}'::jsonb, 'save');
  perform public.apply_task_numbering(c, '{"enabled": true, "number_scope": "all_tasks", "template": "C-{n}"}'::jsonb, 'save');
  perform public.apply_task_numbering(d, jsonb_build_object(
    'enabled', true, 'number_scope', 'sections', 'section_ids', jsonb_build_array(sd),
    'template', 'D-{n}', 'renumber_on_move', true), 'save');
end $$;

-- The editor makes T in A (A-1) and, a moment later, adds it to B (B-1); the owner then adds it to C
-- (C-1), which the editor can't open. U (A-2) is in A and C only. A subtask under T. Each step is its own
-- transaction, so the memberships' times (the stable order) differ.
select set_config('request.jwt.claim.sub', 'b7d40029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b7t4_ids where name = 'a');
  t uuid;
  u uuid;
begin
  t := public.create_task(a, (select id from b7t4_ids where name = 'sa'), 'Brochure');
  u := public.create_task(a, (select id from b7t4_ids where name = 'sa'), 'Banner');
  insert into b7t4_ids values ('t', t), ('u', u);
end $$;

do $$
declare
  t uuid := (select id from b7t4_ids where name = 't');
  b uuid := (select id from b7t4_ids where name = 'b');
  stamped timestamptz;
begin
  -- A client can't choose a membership's time (the stable order reads it): the database stamps it.
  insert into public.task_projects (task_id, project_id, sort_order, created_at) values (t, b, 1024, '2001-01-01');
  select created_at into stamped from public.task_projects where task_id = t and project_id = b;
  assert stamped >= now(), 'stamped by the database';
  update public.task_projects set created_at = '2001-01-01' where task_id = t and project_id = b;
  assert (select created_at from public.task_projects where task_id = t and project_id = b) = stamped, 'and kept';
  insert into b7t4_ids values ('s', public.create_subtask(t, 'Proof', null));
end $$;

select set_config('request.jwt.claim.sub', 'b7d40029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  c uuid := (select id from b7t4_ids where name = 'c');
begin
  insert into public.task_projects (task_id, project_id, sort_order)
  values ((select id from b7t4_ids where name = 't'), c, 1024);
  insert into public.task_projects (task_id, project_id, sort_order)
  values ((select id from b7t4_ids where name = 'u'), c, 2048);
  assert (select req_label from public.task_project_numbers
          where task_id = (select id from b7t4_ids where name = 't') and project_id = c) = 'C-1', 'C numbers T';
end $$;

-- ---------------------------------------------------------------------------------------------
-- The numbers helper: every project the caller can read, in the order the task was added to them,
-- with that project's number — never a project (or number) the caller can't read.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  t uuid := (select id from b7t4_ids where name = 't');
  list jsonb := public.task_project_labels(array[t]) -> t::text;
begin
  assert jsonb_array_length(list) = 3, format('the owner reads all three: %s', list);
  assert (select jsonb_agg(e ->> 'label' order by n) from jsonb_array_elements(list) with ordinality x(e, n))
         = '["A-1", "B-1", "C-1"]'::jsonb, format('stable order: %s', list);
  assert list -> 0 ->> 'project_name' = 'T4 A' and (list -> 0 ->> 'wrap')::boolean, 'name and bracket setting';
end $$;

select set_config('request.jwt.claim.sub', 'b7d40029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b7t4_ids where name = 't');
  s uuid := (select id from b7t4_ids where name = 's');
  c uuid := (select id from b7t4_ids where name = 'c');
  all_lists jsonb := public.task_project_labels(array[t, s, null]);
  list jsonb := all_lists -> t::text;
  sub jsonb := all_lists -> s::text;
  mine uuid := public.create_private_task('Mine only');
begin
  assert (select jsonb_agg(e ->> 'label' order by n) from jsonb_array_elements(list) with ordinality x(e, n))
         = '["A-1", "B-1"]'::jsonb, format('the editor never sees C or C-1: %s', list);
  assert not (list::text like '%' || c::text || '%'), 'not even its id';
  assert (select jsonb_agg(e ->> 'label' order by n) from jsonb_array_elements(sub) with ordinality x(e, n))
         = '["A-1.1", "B-1.1"]'::jsonb, format('a subtask carries its path in each project: %s', sub);
  assert not (public.task_project_labels(array[mine]) ? mine::text), 'a private task has no projects';
end $$;

select set_config('request.jwt.claim.sub', 'b7d40029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b7t4_ids where name = 't');
  u uuid := (select id from b7t4_ids where name = 'u');
  list jsonb := public.task_project_labels(array[t, u]);
begin
  assert (select jsonb_agg(e ->> 'label' order by n) from jsonb_array_elements(list -> t::text) with ordinality x(e, n))
         = '["B-1"]'::jsonb, format('a Viewer of B reads only B-1: %s', list);
  assert not (list ? u::text), 'a task in no project you can open has no entry';
  -- Search labels with the first project the caller can read.
  assert (select s.home_project_id from public.search_tasks('Brochure', 10) s where s.id = t)
         = (select id from b7t4_ids where name = 'b'), 'search: the only readable project';
  -- Number privacy in search: T's own number columns are A's (its internal pointer), and this Viewer
  -- can't open A, so searching A's numbers finds neither T nor its subtask; B's number does.
  assert not exists (select 1 from public.search_tasks('A-1', 10) x where x.id in (t, (select id from b7t4_ids where name = 's'))),
    'search never matches a number of a project you can''t open';
  assert not exists (select 1 from public.search_tasks('A-1.1', 10) x where x.id = (select id from b7t4_ids where name = 's')),
    'nor a subtask''s path there';
  assert exists (select 1 from public.search_tasks('B-1', 10) x where x.id = t), 'B''s number finds it';
  assert not exists (
    select 1 from public.filter_project_tasks((select id from b7t4_ids where name = 'b'), '{"text": "A-1"}'::jsonb, 'UTC') f
    where f.task_id = t
  ), 'a view''s text filter in B neither';
  assert exists (
    select 1 from public.filter_project_tasks((select id from b7t4_ids where name = 'b'), '{"text": "B-1"}'::jsonb, 'UTC') f
    where f.task_id = t
  ), 'B''s number does';
end $$;

select set_config('request.jwt.claim.sub', 'b7d40029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b7t4_ids where name = 't');
begin
  -- The owner opens A: its numbers still find the task.
  assert exists (select 1 from public.search_tasks('A-1', 10) x where x.id = t), 'the owner finds A-1';
  assert exists (select 1 from public.search_tasks('A-1.1', 10) x where x.id = (select id from b7t4_ids where name = 's')),
    'and the subtask''s path';
  assert exists (
    select 1 from public.filter_project_tasks((select id from b7t4_ids where name = 'b'), '{"text": "A-1"}'::jsonb, 'UTC') f
    where f.task_id = t
  ), 'also from B''s view';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Email recipients: the first project (stable rule) they're in, and the numbers they can read.
-- ---------------------------------------------------------------------------------------------

reset role;
do $$
declare
  t uuid := (select id from b7t4_ids where name = 't');
  a uuid := (select id from b7t4_ids where name = 'a');
  b uuid := (select id from b7t4_ids where name = 'b');
  e_editor uuid;
  e_viewer uuid;
  e_address uuid;
  ctx jsonb;
begin
  assert public.comment_email_project('b7d40029-0000-4000-8000-000000000002', t) = a, 'editor: A, the first';
  assert public.comment_email_project('b7d40029-0000-4000-8000-000000000003', t) = b, 'viewer: B, the one they read';
  assert public.task_first_project(t) = a, 'no recipient: the first project';
  insert into public.email_outbox (task_id, to_email, to_profile_id, template, payload)
  values (t, 'b7t4-editor@example.com', 'b7d40029-0000-4000-8000-000000000002', 'custom', '{"kind": "rule"}')
  returning id into e_editor;
  insert into public.email_outbox (task_id, to_email, to_profile_id, template, payload)
  values (t, 'b7t4-viewer@example.com', 'b7d40029-0000-4000-8000-000000000003', 'custom', '{"kind": "rule"}')
  returning id into e_viewer;
  insert into public.email_outbox (task_id, to_email, template, payload)
  values (t, 'someone@elsewhere.example', 'custom', '{"kind": "rule"}')
  returning id into e_address;
  perform set_config('request.jwt.claim.sub', 'ffffffff-0000-4000-8000-0000000000aa', true);
  ctx := public.email_design_context(e_editor);
  assert current_setting('request.jwt.claim.sub', true) = 'ffffffff-0000-4000-8000-0000000000aa', 'the caller is put back';
  assert (select jsonb_agg(e ->> 'label' order by n) from jsonb_array_elements(ctx -> 'values' -> 'task_numbers') with ordinality x(e, n))
         = '["A-1", "B-1"]'::jsonb, format('editor: the numbers they can read: %s', ctx -> 'values');
  assert ctx -> 'values' ->> 'request_number' = 'A-1', 'their first number';
  assert ctx ->> 'project_id' = a::text, 'linked to their first project';
  ctx := public.email_design_context(e_viewer);
  assert (select jsonb_agg(e ->> 'label' order by n) from jsonb_array_elements(ctx -> 'values' -> 'task_numbers') with ordinality x(e, n))
         = '["B-1"]'::jsonb, format('viewer: B-1 only: %s', ctx -> 'values');
  assert ctx -> 'values' ->> 'request_number' = 'B-1' and ctx ->> 'project_id' = b::text, 'viewer: B';
  ctx := public.email_design_context(e_address);
  assert ctx -> 'values' -> 'task_numbers' = 'null'::jsonb, 'an address: the label it was queued with';
  assert ctx ->> 'project_id' = a::text, 'an address: the first project';
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Removing a task from a project removes it there only. The pointer's project can go: the pointer
-- moves to the next project (stable rule) and every number stays. The last project can't go.
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7d40029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b7t4_ids where name = 't');
  a uuid := (select id from b7t4_ids where name = 'a');
  b uuid := (select id from b7t4_ids where name = 'b');
  list jsonb;
begin
  -- Removing B (not the first) keeps A; nothing moves.
  update public.task_projects set deleted_at = now() where task_id = t and project_id = b;
  assert (select home_project_id from public.tasks where id = t) = a, 'pointer stays on A';
  assert exists (select 1 from public.task_projects where task_id = t and project_id = a and deleted_at is null), 'still in A';
  assert exists (select 1 from public.tasks where id = t and deleted_at is null), 'the task stays';
  -- Back in B: the same number (kept, never reissued), and B is now the last project it was added to.
  update public.task_projects set deleted_at = null where task_id = t and project_id = b;
  assert (select req_label from public.task_project_numbers where task_id = t and project_id = b) = 'B-1', 'B-1 kept';
  list := public.task_project_labels(array[t]) -> t::text;
  assert (select jsonb_agg(e ->> 'label' order by n) from jsonb_array_elements(list) with ordinality x(e, n))
         = '["A-1", "B-1"]'::jsonb, format('order: %s', list);
end $$;

do $$
declare
  t uuid := (select id from b7t4_ids where name = 't');
  u uuid := (select id from b7t4_ids where name = 'u');
  s uuid := (select id from b7t4_ids where name = 's');
  a uuid := (select id from b7t4_ids where name = 'a');
  b uuid := (select id from b7t4_ids where name = 'b');
  c uuid := (select id from b7t4_ids where name = 'c');
  list jsonb;
begin
  -- Removing A (the pointer's project) is allowed. The pointer moves to the next project the task was
  -- added to — C (B was added back later), which this editor can't even open — and every number stays.
  update public.task_projects set deleted_at = now() where task_id = t and project_id = a;
  assert (select home_project_id from public.tasks where id = t) = c, 'pointer moved to C';
  assert (select req_label from public.tasks where id = t) = 'C-1', 'C''s number became the task''s own';
  assert (select home_project_id from public.tasks where id = s) = c, 'its subtask follows';
  assert (select req_label from public.tasks where id = s) = 'C-1.1', 'and reads C''s path';
  list := public.task_project_labels(array[t]) -> t::text;
  assert (select jsonb_agg(e ->> 'label' order by n) from jsonb_array_elements(list) with ordinality x(e, n))
         = '["B-1"]'::jsonb, format('the editor still sees only B: %s', list);

  -- U is in A and in C (which the editor can't open): A isn't its last project.
  update public.task_projects set deleted_at = now() where task_id = u and project_id = a;
  assert (select count(*) from public.task_projects where task_id = u and deleted_at is null) = 0,
    'the editor no longer sees any of U''s projects';
end $$;

reset role;
do $$
declare
  t uuid := (select id from b7t4_ids where name = 't');
  a uuid := (select id from b7t4_ids where name = 'a');
  b uuid := (select id from b7t4_ids where name = 'b');
  c uuid := (select id from b7t4_ids where name = 'c');
begin
  assert (select req_label from public.task_project_numbers where task_id = t and project_id = a) = 'A-1', 'A-1 kept';
  assert (select req_label from public.task_project_numbers where task_id = t and project_id = b) = 'B-1', 'B-1 kept';
  assert (select req_label from public.task_project_numbers where task_id = t and project_id = c) = 'C-1', 'C-1 kept';
  assert (select last_number from public.request_sequences where project_id = a) = 2, 'A issued two numbers';
  assert (select last_number from public.request_sequences where project_id = b) = 1, 'B issued one';
  assert (select last_number from public.request_sequences where project_id = c) = 2, 'C issued two, nothing renumbered';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7d40029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  u uuid := (select id from b7t4_ids where name = 'u');
  c uuid := (select id from b7t4_ids where name = 'c');
  state text;
  msg text;
  detail text;
begin
  assert (select home_project_id from public.tasks where id = u) = c, 'U''s pointer moved to C';
  assert (select req_label from public.tasks where id = u) = 'C-2', 'and C''s number came along';
  -- C is U's last project.
  begin
    update public.task_projects set deleted_at = now() where task_id = u and project_id = c;
    raise exception 'removing the last project should have failed';
  exception when check_violation then
    get stacked diagnostics state = returned_sqlstate, msg = message_text, detail = pg_exception_detail;
  end;
  assert msg = 'This is the task’s only project. Add it to another project first, or move the task to the Trash.', msg;
  assert detail = 'last_project', detail;
  assert exists (select 1 from public.task_projects where task_id = u and project_id = c and deleted_at is null), 'still in C';
  -- Deleting the task instead works, and it comes back.
  update public.tasks set deleted_at = now() where id = u;
  perform public.restore_task(u);
  assert exists (select 1 from public.tasks where id = u and deleted_at is null), 'restored';
  assert exists (select 1 from public.task_projects where task_id = u and project_id = c and deleted_at is null), 'in C';
end $$;

-- The rule action Remove from this project on the pointer's project: the database moves the pointer.
select set_config('request.jwt.claim.sub', 'b7d40029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  insert into b7t4_ids values ('w', public.create_task((select id from b7t4_ids where name = 'a'),
    (select id from b7t4_ids where name = 'sa'), 'Flyer'));
end $$;
do $$
declare
  a uuid := (select id from b7t4_ids where name = 'a');
  b uuid := (select id from b7t4_ids where name = 'b');
  w uuid := (select id from b7t4_ids where name = 'w');
  r uuid;
begin
  insert into public.task_projects (task_id, project_id, sort_order) values (w, b, 1024);
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values (a, 'Leave A', true, 'manual', '[{"type": "remove_from_project"}]') returning id into r;
  perform public.run_manual_rule(r, w);
  assert not exists (select 1 from public.task_projects where task_id = w and project_id = a and deleted_at is null), 'out of A';
  assert (select home_project_id from public.tasks where id = w) = b, 'pointer on B';
  update public.rules set enabled = false where id = r;
end $$;

-- Projects a task joins in one transaction keep that order (the membership times are the clock's), so
-- the project it was created in stays first — also for a duplicate made of it.
do $$
declare
  a uuid := (select id from b7t4_ids where name = 'a');
  b uuid := (select id from b7t4_ids where name = 'b');
  v uuid;
  copy uuid;
  list jsonb;
begin
  v := public.create_task(a, (select id from b7t4_ids where name = 'sa'), 'Tie');
  insert into public.task_projects (task_id, project_id, sort_order) values (v, b, 1024);
  list := public.task_project_labels(array[v]) -> v::text;
  assert list -> 0 ->> 'project_id' = a::text and list -> 1 ->> 'project_id' = b::text, format('A, then B: %s', list);
  copy := (public.duplicate_task(v, '{}'::jsonb) ->> 'task_id')::uuid;
  list := public.task_project_labels(array[copy]) -> copy::text;
  assert list -> 0 ->> 'project_id' = a::text and list -> 1 ->> 'project_id' = b::text, format('the copy too: %s', list);
  assert (select home_project_id from public.tasks where id = copy) = a, 'its pointer is its first project';
end $$;

-- ---------------------------------------------------------------------------------------------
-- The pointer moving never renumbers, even into a project that renumbers on move.
-- ---------------------------------------------------------------------------------------------

do $$
begin
  insert into b7t4_ids values ('x', public.create_task((select id from b7t4_ids where name = 'a'),
    (select id from b7t4_ids where name = 'sa'), 'Poster'));
end $$;
do $$
declare
  a uuid := (select id from b7t4_ids where name = 'a');
  d uuid := (select id from b7t4_ids where name = 'd');
  x uuid := (select id from b7t4_ids where name = 'x');
  label text := (select req_label from public.tasks where id = x);
  d_last bigint;
begin
  insert into public.task_projects (task_id, project_id, sort_order) values (x, d, 1024);
  assert not exists (select 1 from public.task_project_numbers where task_id = x and project_id = d), 'D doesn''t number it';
  select last_number into d_last from public.request_sequences where project_id = d;
  update public.task_projects set deleted_at = now() where task_id = x and project_id = a;
  assert (select home_project_id from public.tasks where id = x) = d, 'pointer on D';
  assert (select last_number from public.request_sequences where project_id = d) = d_last, 'D issued no number';
  assert (select req_label from public.tasks where id = x) = label, 'it keeps its number';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Defaults and links follow the stable rule: dependency shifting follows the first project, restoring needs
-- one active project, subtask parent candidates and blockers name the first readable project.
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'b7d40029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b7t4_ids where name = 'a');
  b uuid := (select id from b7t4_ids where name = 'b');
  c uuid := (select id from b7t4_ids where name = 'c');
  t uuid := (select id from b7t4_ids where name = 't');
begin
  -- T is in C, then B (it was added back to B later): C, its first project, decides.
  update public.projects set dependency_shift = 'off' where id in (a, b, c);
  assert public.dependency_shift_mode(array[t]) = 'off', 'C is off';
  update public.projects set dependency_shift = 'ask' where id = b;
  assert public.dependency_shift_mode(array[t]) = 'off', 'B doesn''t decide';
  update public.projects set dependency_shift = 'auto' where id = c;
  assert public.dependency_shift_mode(array[t]) = 'auto', 'C does';
  update public.projects set dependency_shift = 'ask' where id in (a, b, c);
  insert into b7t4_ids values ('y', public.create_task(c, null, 'Sticker'));
end $$;
do $$
declare
  y uuid := (select id from b7t4_ids where name = 'y');
begin
  insert into public.task_projects (task_id, project_id, sort_order) values (y, (select id from b7t4_ids where name = 'b'), 1024);
  update public.tasks set deleted_at = now() where id = y;
end $$;

-- Restoring: the pointer's project deleted, another one active → fine; every project deleted → refused.
reset role;
update public.projects set deleted_at = now() where id = (select id from b7t4_ids where name = 'c');
set role authenticated;
do $$
declare
  y uuid := (select id from b7t4_ids where name = 'y');
begin
  perform public.restore_task(y);
  assert exists (select 1 from public.tasks where id = y and deleted_at is null), 'restored through B';
  update public.tasks set deleted_at = now() where id = y;
end $$;
reset role;
update public.projects set deleted_at = now() where id = (select id from b7t4_ids where name = 'b');
set role authenticated;
do $$
declare
  y uuid := (select id from b7t4_ids where name = 'y');
  msg text;
begin
  begin
    perform public.restore_task(y);
    raise exception 'restoring with no active project should have failed';
  exception when check_violation then
    get stacked diagnostics msg = message_text;
  end;
  assert msg = 'This task''s projects are deleted', msg;
end $$;
reset role;
update public.projects set deleted_at = null where id in (select id from b7t4_ids where name in ('b', 'c'));
set role authenticated;

select set_config('request.jwt.claim.sub', 'b7d40029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b7t4_ids where name = 'a');
  b uuid := (select id from b7t4_ids where name = 'b');
  t uuid := (select id from b7t4_ids where name = 't');
  z uuid;
  blockers jsonb;
begin
  -- T is in C (its first project now, which the editor can't open) and B: the editor's link project is B.
  z := public.create_task(a, (select id from b7t4_ids where name = 'sa'), 'Card');
  perform public.set_task_dependency(t, z, 'finish_to_start', 0);
  blockers := public.task_open_blockers(z);
  assert blockers -> 'blockers' -> 0 ->> 'home_project_id' = b::text, format('blocker linked to B: %s', blockers);
  assert (select c.home_project_id from public.subtask_parent_candidates(z, 'Brochure', 10) c where c.id = t) = b,
    'parent candidate labelled with B';
end $$;

reset role;

-- ---------------------------------------------------------------------------------------------
-- Two removals at the same time (a second session through dblink, where the test database has it):
-- a task's last two projects removed at once. The guard locks the task, so the second removal waits for
-- the first, then sees it and is refused — the task never ends up in no project, and the first removal
-- stays removed (the pointer's move doesn't write the other membership back). Both orders: the first
-- removal on the pointer's project, and on the other one.
-- ---------------------------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'dblink') then
    create extension if not exists dblink schema extensions;
  end if;
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7d40029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  insert into b7t4_ids values
    ('race1', public.create_task((select id from b7t4_ids where name = 'a'), (select id from b7t4_ids where name = 'sa'), 'Race one')),
    ('race2', public.create_task((select id from b7t4_ids where name = 'a'), (select id from b7t4_ids where name = 'sa'), 'Race two'));
end $$;
do $$
begin
  insert into public.task_projects (task_id, project_id, sort_order)
  select id, (select id from b7t4_ids where name = 'b'), 8192 from b7t4_ids where name in ('race1', 'race2');
end $$;
reset role;

create temporary table b7t4_race (task text, here text, there text);
insert into b7t4_race values ('race1', 'a', 'b'), ('race2', 'b', 'a');

do $$
declare
  r record;
begin
  if not exists (select 1 from pg_extension where extname = 'dblink') then
    raise notice 'zz36_b7_t4: dblink isn''t available here, the concurrent removal check is skipped';
    return;
  end if;
  for r in select * from b7t4_race loop
    perform extensions.dblink_connect('b7t4_' || r.task, format('host=%s port=%s dbname=%s user=postgres',
      split_part(current_setting('unix_socket_directories'), ',', 1), current_setting('port'), current_database()));
    -- This transaction removes one project (and keeps the task's lock until it ends) …
    update public.task_projects set deleted_at = now()
    where task_id = (select id from b7t4_ids where name = r.task) and project_id = (select id from b7t4_ids where name = r.here);
    -- … while a second session removes the other one.
    perform extensions.dblink_send_query('b7t4_' || r.task, format(
      'update public.task_projects set deleted_at = now() where task_id = %L and project_id = %L',
      (select id from b7t4_ids where name = r.task), (select id from b7t4_ids where name = r.there)));
  end loop;
  perform pg_sleep(0.3);
  for r in select * from b7t4_race loop
    assert extensions.dblink_is_busy('b7t4_' || r.task) = 1, format('%s: the second removal waits for the first', r.task);
  end loop;
end $$;

do $$
declare
  r record;
  err text;
begin
  if not exists (select 1 from pg_extension where extname = 'dblink') then
    return;
  end if;
  for r in select * from b7t4_race loop
    perform * from extensions.dblink_get_result('b7t4_' || r.task, false) as x(status text);
    err := extensions.dblink_error_message('b7t4_' || r.task);
    perform extensions.dblink_disconnect('b7t4_' || r.task);
    assert err like '%This is the task’s only project%', format('%s: the second removal is refused: %s', r.task, err);
    assert (select count(*) from public.task_projects
            where task_id = (select id from b7t4_ids where name = r.task) and deleted_at is null) = 1,
      format('%s: still in exactly one project', r.task);
    assert exists (select 1 from public.task_projects
                   where task_id = (select id from b7t4_ids where name = r.task) and deleted_at is null
                     and project_id = (select id from b7t4_ids where name = r.there)),
      format('%s: the one the first removal left (it didn''t come back)', r.task);
    assert (select home_project_id from public.tasks where id = (select id from b7t4_ids where name = r.task))
           = (select id from b7t4_ids where name = r.there), format('%s: the pointer is there', r.task);
  end loop;
end $$;

do $$
begin
  raise notice 'zz36_b7_t4_projects smoke: all assertions passed';
end $$;
