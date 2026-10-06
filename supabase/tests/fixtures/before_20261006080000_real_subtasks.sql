-- Pre-migration fixture for 20261006080000_real_subtasks.sql (loaded by run.sh just before it).
-- Old-model checklist rows in public.subtasks — open, completed, approval-linked, and soft-deleted —
-- so 99_real_subtasks_smoke.sql can check that each became a child task with the same id, completion,
-- and order, and that approval_requests.subtask_id still points at it. Written with triggers off
-- (session_replication_role = replica), like a database restored from before this phase; every row
-- is consistent with the old schema's constraints. Never run on Supabase.

\set ON_ERROR_STOP 1

set session_replication_role = replica;

insert into auth.users (id, email, email_confirmed_at) values
  ('f0f0f0f0-0000-4000-8000-000000000001', 'legacy-approver@example.com', now());
insert into public.profiles (id, email, full_name) values
  ('f0f0f0f0-0000-4000-8000-000000000001', 'legacy-approver@example.com', 'Lee Legacy');

insert into public.projects (id, workspace_id, name) values
  ('f0f0f0f0-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000001', 'Legacy checklist');

insert into public.tasks (id, workspace_id, home_project_id, title) values
  ('f0f0f0f0-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-000000000001',
   'f0f0f0f0-0000-4000-8000-0000000000a1', 'Legacy parent');
insert into public.task_projects (task_id, project_id, sort_order) values
  ('f0f0f0f0-0000-4000-8000-0000000000b1', 'f0f0f0f0-0000-4000-8000-0000000000a1', 1024);

insert into public.subtasks (id, task_id, title, completed_at, sort_order, created_at, deleted_at) values
  ('f0f0f0f0-0000-4000-8000-0000000000c1', 'f0f0f0f0-0000-4000-8000-0000000000b1', 'Done step',
   '2026-09-01T10:00:00Z', 1024, '2026-08-01T10:00:00Z', null),
  ('f0f0f0f0-0000-4000-8000-0000000000c2', 'f0f0f0f0-0000-4000-8000-0000000000b1', 'Open step',
   null, 2048, '2026-08-01T10:01:00Z', null),
  ('f0f0f0f0-0000-4000-8000-0000000000c3', 'f0f0f0f0-0000-4000-8000-0000000000b1', 'Approval',
   null, 1536, '2026-08-01T10:02:00Z', null),
  ('f0f0f0f0-0000-4000-8000-0000000000c4', 'f0f0f0f0-0000-4000-8000-0000000000b1', 'Removed step',
   null, 4096, '2026-08-01T10:03:00Z', '2026-08-15T10:00:00Z');

insert into public.approval_requests (id, task_id, subtask_id, approver_id, note, status) values
  ('f0f0f0f0-0000-4000-8000-0000000000d1', 'f0f0f0f0-0000-4000-8000-0000000000b1',
   'f0f0f0f0-0000-4000-8000-0000000000c3', 'f0f0f0f0-0000-4000-8000-000000000001', 'Legacy approval', 'pending');

set session_replication_role = origin;
