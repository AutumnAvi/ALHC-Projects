-- Pre-migration fixture for 20261102020000_nov2_batch14_a.sql (loaded by run.sh just before it).
-- A project that set up Slack the old way (its own incoming webhook in project_integrations), so
-- zz44_nov2_batch14_smoke.sql can check the one-time move to a workspace-level Slack destination. Written
-- with triggers off (session_replication_role = replica), consistent with the old schema. Never run on
-- Supabase.

\set ON_ERROR_STOP 1

set session_replication_role = replica;

insert into auth.users (id, email, email_confirmed_at) values
  ('f14f14f1-0000-4000-8000-000000000001', 'legacy-slack@example.com', now());
insert into public.allowed_emails (email, note) values ('legacy-slack@example.com', 'batch 14 fixture');
insert into public.profiles (id, email, full_name) values
  ('f14f14f1-0000-4000-8000-000000000001', 'legacy-slack@example.com', 'Sam Slack');

insert into public.projects (id, workspace_id, name, created_by, team_id)
select 'f14f14f1-0000-4000-8000-0000000000a1', w.id, 'Legacy Slack', 'f14f14f1-0000-4000-8000-000000000001', w.default_team_id
from public.workspaces w where w.id = '00000000-0000-4000-8000-000000000001';
insert into public.project_members (project_id, profile_id, role, created_by) values
  ('f14f14f1-0000-4000-8000-0000000000a1', 'f14f14f1-0000-4000-8000-000000000001', 'owner',
   'f14f14f1-0000-4000-8000-000000000001');
insert into public.project_integrations (project_id, slack_webhook_url, updated_by) values
  ('f14f14f1-0000-4000-8000-0000000000a1', 'https://hooks.slack.com/services/T000/B000/legacyTokenAbcd',
   'f14f14f1-0000-4000-8000-000000000001');

set session_replication_role = origin;
