-- Pre-migration fixture for 20261101060000_nov1_batch12_a.sql (loaded by run.sh just before it).
-- Email that came in before the email-in activity existed: a forwarded email that became a task (an
-- email_forwards row) and a form submitter's emailed reply on that task (a "received" comment), so
-- zz42_nov1_batch12_smoke.sql can check the one-time backfill. Written with triggers off
-- (session_replication_role = replica), consistent with the old schema. Never run on Supabase.

\set ON_ERROR_STOP 1

set session_replication_role = replica;

insert into auth.users (id, email, email_confirmed_at) values
  ('f12f12f1-0000-4000-8000-000000000001', 'legacy-forwarder@example.com', now());
insert into public.allowed_emails (email, note) values ('legacy-forwarder@example.com', 'batch 12 fixture');
insert into public.profiles (id, email, full_name) values
  ('f12f12f1-0000-4000-8000-000000000001', 'legacy-forwarder@example.com', 'Lee Forwarder');

insert into public.projects (id, workspace_id, name, created_by, team_id)
select 'f12f12f1-0000-4000-8000-0000000000a1', w.id, 'Legacy email-in', 'f12f12f1-0000-4000-8000-000000000001', w.default_team_id
from public.workspaces w where w.id = '00000000-0000-4000-8000-000000000001';
insert into public.project_members (project_id, profile_id, role, created_by) values
  ('f12f12f1-0000-4000-8000-0000000000a1', 'f12f12f1-0000-4000-8000-000000000001', 'owner',
   'f12f12f1-0000-4000-8000-000000000001');

insert into public.tasks (id, workspace_id, home_project_id, title, created_by, assignee_id, created_at) values
  ('f12f12f1-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-000000000001',
   'f12f12f1-0000-4000-8000-0000000000a1', 'Legacy brief', 'f12f12f1-0000-4000-8000-000000000001',
   'f12f12f1-0000-4000-8000-000000000001', '2026-10-20T09:00:00Z');
insert into public.task_projects (task_id, project_id, sort_order) values
  ('f12f12f1-0000-4000-8000-0000000000b1', 'f12f12f1-0000-4000-8000-0000000000a1', 1024);

insert into public.email_forwards (provider_id, profile_id, task_id, project_id, status, created_at) values
  ('legacy-fw-1', 'f12f12f1-0000-4000-8000-000000000001', 'f12f12f1-0000-4000-8000-0000000000b1',
   'f12f12f1-0000-4000-8000-0000000000a1', 'created', '2026-10-20T09:00:00Z'),
  ('legacy-fw-2', 'f12f12f1-0000-4000-8000-000000000001', null, null, 'rejected', '2026-10-20T09:05:00Z');

insert into public.comments (id, task_id, author_id, body, email_direction, email_address, email_subject, created_at) values
  ('f12f12f1-0000-4000-8000-0000000000c1', 'f12f12f1-0000-4000-8000-0000000000b1', null, 'Looks good, thanks!',
   'received', 'client@example.org', 'Re: "Brief" submission received', '2026-10-21T10:00:00Z');

set session_replication_role = origin;
