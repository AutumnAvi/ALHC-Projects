-- Local performance seed for docs/PERF-AUDIT.md.
--
-- Same shape as the stage 1 EXPLAIN runs, plus the inbox rows stage 2 measures:
--   one project, 10,000 tasks (task_projects memberships)
--   50,000 comments, 5,005 of them on task 1
--   1,700 open tasks assigned to perf-seed@example.com
--   30 recently completed tasks assigned to that person
--   2,000 unread, unarchived inbox items for that person
--
-- Run only after supabase/tests/auth_shim.sql and every supabase/migrations/*.sql,
-- on a throwaway Postgres. Never on the hosted project. See scripts/perf/README.md.
--
-- Ids (stable, so plans can name them):
--   a1000000-0000-4000-8000-000000000001  perf-seed@example.com   project owner
--   a1000000-0000-4000-8000-000000000002  perf-other@example.com  allowlisted, not a member
--   b1000000-0000-4000-8000-000000000001  project "Perf seed"
--   c1000000-0000-4000-8000-000000000001  task 1, the one with 5,005 comments

\set ON_ERROR_STOP 1

do $$
begin
  if exists (select 1 from public.projects where id = 'b1000000-0000-4000-8000-000000000001') then
    raise exception 'perf seed already applied; start from a fresh database';
  end if;
end $$;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a1000000-0000-4000-8000-000000000001', 'perf-seed@example.com', now(), '{"full_name":"Perf Seed"}'),
  ('a1000000-0000-4000-8000-000000000002', 'perf-other@example.com', now(), '{"full_name":"Perf Other"}');

insert into public.allowed_emails (email, note) values
  ('perf-seed@example.com', 'perf seed'),
  ('perf-other@example.com', 'perf seed');

select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', false);

insert into public.projects (id, workspace_id, name, created_by)
values (
  'b1000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001',
  'Perf seed',
  'a1000000-0000-4000-8000-000000000001'
);

insert into public.sections (id, project_id, name, sort_order)
values (
  'b2000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001',
  'To do',
  1024
);

-- Bulk rows skip per-row triggers (stories, followers, request numbers, notification emails).
-- The columns those triggers would fill are set here. Foreign keys stay on.
alter table public.tasks disable trigger user;
alter table public.task_projects disable trigger user;
alter table public.comments disable trigger user;
alter table public.inbox_items disable trigger user;

insert into public.tasks (
  id, workspace_id, home_project_id, title, assignee_id, due_on, completed_at,
  created_by, created_at, updated_at, assigned_at, kind, source
)
select
  ('c1000000-0000-4000-8000-' || lpad(to_hex(i), 12, '0'))::uuid,
  '00000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001',
  'Task ' || i,
  case when i <= 1730 then 'a1000000-0000-4000-8000-000000000001'::uuid else null end,
  case when i % 5 = 0 then null else date '2026-10-01' + (i % 60) end,
  case when i > 1700 and i <= 1730 then timestamptz '2026-10-01' + ((i || ' minutes')::interval) else null end,
  'a1000000-0000-4000-8000-000000000001',
  timestamptz '2026-01-01' + ((i || ' seconds')::interval),
  timestamptz '2026-01-01' + ((i || ' seconds')::interval),
  case when i <= 1730 then timestamptz '2026-01-01' + ((i || ' seconds')::interval) else null end,
  'task',
  'manual'
from generate_series(1, 10000) as i;

insert into public.task_projects (task_id, project_id, section_id, sort_order, created_at, updated_at)
select
  ('c1000000-0000-4000-8000-' || lpad(to_hex(i), 12, '0'))::uuid,
  'b1000000-0000-4000-8000-000000000001',
  'b2000000-0000-4000-8000-000000000001',
  i * 1024,
  timestamptz '2026-01-01' + ((i || ' seconds')::interval),
  timestamptz '2026-01-01' + ((i || ' seconds')::interval)
from generate_series(1, 10000) as i;

-- 5,005 comments on task 1; the other 44,995 cycle across tasks 2..10000.
insert into public.comments (id, task_id, author_id, body, created_at, updated_at)
select
  ('d1000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
  ('c1000000-0000-4000-8000-' || lpad(to_hex(
    case when n <= 5005 then 1 else 2 + ((n - 5006) % 9999) end
  ), 12, '0'))::uuid,
  'a1000000-0000-4000-8000-000000000001',
  'Comment ' || n,
  timestamptz '2025-01-01' + ((n || ' seconds')::interval),
  timestamptz '2025-01-01' + ((n || ' seconds')::interval)
from generate_series(1, 50000) as n;

insert into public.inbox_items (id, recipient_id, actor_id, task_id, kind, data, created_at)
select
  ('e1000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
  'a1000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000002',
  ('c1000000-0000-4000-8000-' || lpad(to_hex(((n - 1) % 1700) + 1), 12, '0'))::uuid,
  'assigned',
  '{}'::jsonb,
  timestamptz '2026-06-01' + ((n || ' seconds')::interval)
from generate_series(1, 2000) as n;

alter table public.tasks enable trigger user;
alter table public.task_projects enable trigger user;
alter table public.comments enable trigger user;
alter table public.inbox_items enable trigger user;

analyze public.tasks;
analyze public.task_projects;
analyze public.comments;
analyze public.inbox_items;
analyze public.project_members;

do $$
declare
  n_tasks int;
  n_comments int;
  n_heavy int;
  n_open int;
  n_inbox int;
begin
  select count(*) into n_tasks
  from public.task_projects
  where project_id = 'b1000000-0000-4000-8000-000000000001' and deleted_at is null;
  select count(*) into n_comments from public.comments where deleted_at is null
    and task_id in (
      select task_id from public.task_projects
      where project_id = 'b1000000-0000-4000-8000-000000000001'
    );
  select count(*) into n_heavy from public.comments
  where task_id = 'c1000000-0000-4000-8000-000000000001' and deleted_at is null;
  select count(*) into n_open from public.tasks
  where assignee_id = 'a1000000-0000-4000-8000-000000000001'
    and deleted_at is null and completed_at is null;
  select count(*) into n_inbox from public.inbox_items
  where recipient_id = 'a1000000-0000-4000-8000-000000000001'
    and read_at is null and archived_at is null;
  if n_tasks <> 10000 or n_comments <> 50000 or n_heavy <> 5005 or n_open <> 1700 or n_inbox <> 2000 then
    raise exception 'perf seed counts off: tasks % comments % heavy % open % inbox %',
      n_tasks, n_comments, n_heavy, n_open, n_inbox;
  end if;
  raise notice 'perf seed: % tasks, % comments (% on task 1), % open assigned, % inbox',
    n_tasks, n_comments, n_heavy, n_open, n_inbox;
end $$;
