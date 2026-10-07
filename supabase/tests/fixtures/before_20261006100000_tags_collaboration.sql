-- Pre-migration fixture for 20261006100000_tags_collaboration.sql (loaded by run.sh just before it).
-- A project imported from Asana before native tags: the importer's multi-select "Tags" field (mapped in
-- import_external_ids as kind 'field', external_id 'asana:tags' — the marker), values on two tasks and
-- on a trashed one, plus a same-named "Tags" field that was NOT imported (no marker), so
-- zz02_tags_collaboration_smoke.sql can check that only the marked field's values became native tags,
-- once. Written with triggers off (session_replication_role = replica), consistent with the old schema.
-- Never run on Supabase.

\set ON_ERROR_STOP 1

set session_replication_role = replica;

insert into auth.users (id, email, email_confirmed_at) values
  ('f1f1f1f1-0000-4000-8000-000000000001', 'legacy-importer@example.com', now());
insert into public.profiles (id, email, full_name) values
  ('f1f1f1f1-0000-4000-8000-000000000001', 'legacy-importer@example.com', 'Ivy Importer');

insert into public.projects (id, workspace_id, name, created_by) values
  ('f1f1f1f1-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000001', 'Legacy tagged import',
   'f1f1f1f1-0000-4000-8000-000000000001');

insert into public.tasks (id, workspace_id, home_project_id, title, deleted_at) values
  ('f1f1f1f1-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-000000000001',
   'f1f1f1f1-0000-4000-8000-0000000000a1', 'Tagged flyer', null),
  ('f1f1f1f1-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-000000000001',
   'f1f1f1f1-0000-4000-8000-0000000000a1', 'Tagged banner', null),
  ('f1f1f1f1-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-000000000001',
   'f1f1f1f1-0000-4000-8000-0000000000a1', 'Trashed tagged task', '2026-09-01T10:00:00Z');
insert into public.task_projects (task_id, project_id, sort_order) values
  ('f1f1f1f1-0000-4000-8000-0000000000b1', 'f1f1f1f1-0000-4000-8000-0000000000a1', 1024),
  ('f1f1f1f1-0000-4000-8000-0000000000b2', 'f1f1f1f1-0000-4000-8000-0000000000a1', 2048),
  ('f1f1f1f1-0000-4000-8000-0000000000b3', 'f1f1f1f1-0000-4000-8000-0000000000a1', 3072);

-- The imported Tags field (marker below) and an unrelated hand-made field with the same name.
insert into public.custom_fields (id, project_id, name, field_type, options) values
  ('f1f1f1f1-0000-4000-8000-0000000000c1', 'f1f1f1f1-0000-4000-8000-0000000000a1', 'Tags', 'multi_select',
   '[{"id": "opt-print", "name": "Legacy Print", "color": "blue"},
     {"id": "opt-web", "name": "Legacy Web", "color": "green"},
     {"id": "opt-unused", "name": "Legacy Unused", "color": "red"}]'),
  ('f1f1f1f1-0000-4000-8000-0000000000c2', 'f1f1f1f1-0000-4000-8000-0000000000a1', 'Tags', 'multi_select',
   '[{"id": "opt-hand", "name": "Legacy Handmade", "color": "pink"}]');

insert into public.task_field_values (task_id, field_id, value) values
  ('f1f1f1f1-0000-4000-8000-0000000000b1', 'f1f1f1f1-0000-4000-8000-0000000000c1', '["opt-print", "opt-web"]'),
  ('f1f1f1f1-0000-4000-8000-0000000000b2', 'f1f1f1f1-0000-4000-8000-0000000000c1', '["opt-print"]'),
  ('f1f1f1f1-0000-4000-8000-0000000000b3', 'f1f1f1f1-0000-4000-8000-0000000000c1', '["opt-web"]'),
  ('f1f1f1f1-0000-4000-8000-0000000000b1', 'f1f1f1f1-0000-4000-8000-0000000000c2', '["opt-hand"]');

insert into public.import_runs (id, project_id, source, status, created_by, finished_at) values
  ('f1f1f1f1-0000-4000-8000-0000000000d1', 'f1f1f1f1-0000-4000-8000-0000000000a1', 'asana', 'completed',
   'f1f1f1f1-0000-4000-8000-000000000001', '2026-09-01T09:00:00Z');
insert into public.import_external_ids (project_id, source, kind, external_id, local_id, run_id) values
  ('f1f1f1f1-0000-4000-8000-0000000000a1', 'asana', 'field', 'asana:tags',
   'f1f1f1f1-0000-4000-8000-0000000000c1', 'f1f1f1f1-0000-4000-8000-0000000000d1');

set session_replication_role = origin;
