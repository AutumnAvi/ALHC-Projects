-- Nov 12 batch 40 (20261112020000_nov12_speed40_a.sql): speed only.
--   1. project_file_page and workspace_report_groups: invoker, stable, empty search_path, authenticated only;
--   2. Files (item 2): a mixed fixture (a project with more than 500 files, subtasks and a sub-subtask,
--      removed files, a trashed task, a live subtask of a trashed task, a removed membership, a task in two
--      projects, a project the reader can't open) — project_file_page answers exactly what the old reads
--      did (every task's files plus its subtasks' files, newest 500), for a range of people, on every
--      project with files that the suites left behind too;
--   3. Reports (item 3): workspace_report_groups' four groupings equal workspace_report's four calls, for
--      a range of people and filters (none, include subtasks, people, status, a project list, a date range);
--   4. timing: a project with 1,500 tasks and 2,000 files, the old reads vs the new one (NOTICEs, EXPLAIN).

\set ON_ERROR_STOP 1

create temporary table b40_ids (name text primary key, id uuid) on commit preserve rows;
grant all on b40_ids to authenticated, anon, service_role;

-- The old Files reads (packages/core/src/api/projects/queries.ts before batch 40), as the reference: the
-- project's memberships with their tasks (RLS), each live task's live files, then the live subtasks of
-- every one of those tasks (trashed ones included) and their live files; newest first, 500.
create function pg_temp.b40_old_files(target_project uuid)
returns table (id uuid, task_id uuid, task_title text, created_at timestamptz)
language sql
stable
set search_path = ''
as $$
  with tops as (
    select t.id, t.title, t.deleted_at
    from public.task_projects tp join public.tasks t on t.id = tp.task_id
    where tp.project_id = target_project and tp.deleted_at is null
  ),
  holders as (
    select tops.id, tops.title from tops where tops.deleted_at is null
    union all
    select s.id, s.title from public.tasks s where s.root_task_id in (select tops.id from tops) and s.deleted_at is null
  )
  select a.id, h.id, h.title, a.created_at
  from holders h join public.task_attachments a on a.task_id = h.id
  where a.deleted_at is null
  order by a.created_at desc, a.id
  limit 500;
$$;
grant execute on function pg_temp.b40_old_files(uuid) to authenticated;

-- 1. The functions ---------------------------------------------------------------------------------

do $$
declare
  fn regprocedure;
begin
  foreach fn in array array['public.project_file_page(uuid, integer)'::regprocedure, 'public.workspace_report_groups(jsonb, text)'::regprocedure] loop
    assert not (select prosecdef from pg_catalog.pg_proc where oid = fn), format('%s is invoker', fn);
    assert (select provolatile from pg_catalog.pg_proc where oid = fn) = 's', format('%s is stable', fn);
    assert (select proconfig from pg_catalog.pg_proc where oid = fn) = array['search_path=""'], format('%s: empty search_path', fn);
    assert has_function_privilege('authenticated', fn, 'execute'), format('authenticated: %s', fn);
    assert not has_function_privilege('anon', fn, 'execute'), format('anon: no %s', fn);
  end loop;
end $$;

-- 2. Files ------------------------------------------------------------------------------------------

insert into public.allowed_emails (email, note) values
  ('b40-owner@example.com', 'batch 40'),
  ('b40-viewer@example.com', 'batch 40'),
  ('b40-other@example.com', 'batch 40'),
  ('b40-none@example.com', 'batch 40');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b4000000-0000-4000-8000-000000000001', 'b40-owner@example.com', now(), '{"full_name":"Ola Owner"}'),
  ('b4000000-0000-4000-8000-000000000002', 'b40-viewer@example.com', now(), '{"full_name":"Vic Viewer"}'),
  ('b4000000-0000-4000-8000-000000000003', 'b40-other@example.com', now(), '{"full_name":"Oto Other"}'),
  ('b4000000-0000-4000-8000-000000000004', 'b40-none@example.com', now(), '{"full_name":"Nia Nobody"}');

set role authenticated;
select set_config('request.jwt.claim.sub', 'b4000000-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  p uuid;
  s uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B40 Hidden') returning id into p;
  insert into public.sections (project_id, name) values (p, 'S') returning id into s;
  insert into b40_ids values ('p2', p), ('hidden_task', public.create_task(p, s, 'B40 hidden task'));
end $$;

select set_config('request.jwt.claim.sub', 'b4000000-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid;
  s uuid;
  n text;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B40 Files') returning id into p;
  insert into public.sections (project_id, name) values (p, 'S') returning id into s;
  perform public.add_project_member(p, 'b40-viewer@example.com', 'viewer');
  insert into b40_ids values ('p1', p);
  foreach n in array array['plain', 'trashed', 'parent', 'trashed_parent', 'removed', 'shared'] loop
    insert into b40_ids values (n, public.create_task(p, s, 'B40 ' || n));
  end loop;
  insert into b40_ids values ('sub', public.create_subtask((select id from b40_ids where name = 'parent'), 'B40 sub', null));
  insert into b40_ids values ('subsub', public.create_subtask((select id from b40_ids where name = 'sub'), 'B40 subsub', null));
  insert into b40_ids values ('sub_trashed', public.create_subtask((select id from b40_ids where name = 'parent'), 'B40 sub trashed', null));
  insert into b40_ids values ('orphan', public.create_subtask((select id from b40_ids where name = 'trashed_parent'), 'B40 orphan', null));
end $$;

reset role;
do $$
declare
  id_of jsonb := (select jsonb_object_agg(name, id) from b40_ids);
  owner uuid := 'b4000000-0000-4000-8000-000000000001';
  t record;
  g int;
begin
  -- The "shared" task also sits in the hidden project; the hidden task in P1 through a removed membership.
  insert into public.task_projects (task_id, project_id) values ((id_of ->> 'shared')::uuid, (id_of ->> 'p2')::uuid);
  insert into public.task_projects (task_id, project_id, deleted_at)
  values ((id_of ->> 'hidden_task')::uuid, (id_of ->> 'p1')::uuid, now());
  -- Files: 150 on each of four tasks, older to newer, plus a few on the rest; some removed.
  for t in select name, id from b40_ids where name in ('plain', 'parent', 'sub', 'subsub', 'trashed', 'sub_trashed', 'orphan', 'removed', 'shared', 'hidden_task') loop
    for g in 1 .. case when t.name in ('plain', 'parent', 'sub', 'subsub') then 150 else 6 end loop
      insert into public.task_attachments (task_id, storage_path, file_name, content_type, size_bytes, uploaded_by, created_at, deleted_at)
      values (t.id, t.id || '/' || gen_random_uuid() || '-f.png', 'B40 ' || t.name || ' ' || g || '.png', 'image/png', 100, owner,
              now() - make_interval(mins => g * 7 + length(t.name)), case when g % 25 = 0 then now() end);
    end loop;
  end loop;
  update public.tasks set deleted_at = now() where id in ((id_of ->> 'trashed')::uuid, (id_of ->> 'sub_trashed')::uuid);
  -- A trashed parent whose subtask stays live (the trash cascade would trash it; written directly).
  update public.tasks set deleted_at = now() where id = (id_of ->> 'trashed_parent')::uuid;
  set local session_replication_role = replica;
  update public.tasks set deleted_at = null where id = (id_of ->> 'orphan')::uuid;
  set local session_replication_role = origin;
  insert into public.task_projects (task_id, project_id) values ((id_of ->> 'removed')::uuid, (id_of ->> 'p2')::uuid);
  update public.task_projects set deleted_at = now()
  where task_id = (id_of ->> 'removed')::uuid and project_id = (id_of ->> 'p1')::uuid;
end $$;

create temporary table b40_people (id uuid) on commit preserve rows;
insert into b40_people
select id from (
  (select m.profile_id as id from public.project_members m where m.deleted_at is null
   group by m.profile_id order by count(*) desc, m.profile_id limit 8)
  union
  (select m.profile_id from public.project_members m where m.deleted_at is not null
   group by m.profile_id order by m.profile_id limit 2)
  union
  (select p.id from public.profiles p join public.allowed_emails a on a.email = lower(p.email)
   where a.removed_at is not null order by p.id limit 2)
  union
  (select id from (values
    ('b4000000-0000-4000-8000-000000000001'::uuid), ('b4000000-0000-4000-8000-000000000002'::uuid),
    ('b4000000-0000-4000-8000-000000000003'::uuid), ('b4000000-0000-4000-8000-000000000004'::uuid)) v(id))
) x
union all select null;
grant select on b40_people to authenticated;

create temporary table b40_projects (id uuid primary key) on commit preserve rows;
insert into b40_projects
select distinct tp.project_id from public.task_projects tp join public.task_attachments a on a.task_id = tp.task_id;
insert into b40_projects select id from b40_ids where name in ('p1', 'p2') on conflict do nothing;
grant select on b40_projects to authenticated;

set role authenticated;
do $$
declare
  p1 uuid := (select id from b40_ids where name = 'p1');
  n bigint;
  names text[];
begin
  perform set_config('request.jwt.claim.sub', 'b4000000-0000-4000-8000-000000000001', false);
  select count(*) into n from public.project_file_page(p1);
  assert n = 500, format('owner: the newest 500 of P1 (%s)', n);
  select array_agg(distinct split_part(file_name, ' ', 2)) into names from public.project_file_page(p1, 100000);
  -- Every kind that shows: tasks, subtasks, a sub-subtask, the live subtask of a trashed task, a task
  -- also in a project the owner can't open; never the trashed task, the trashed subtask, the removed membership.
  assert names <@ array['plain', 'parent', 'sub', 'subsub', 'orphan', 'shared'], format('owner names %s', names);
  assert not exists (select 1 from public.project_file_page(p1) where file_name like 'B40 hidden_task%'), 'no removed membership';
  perform set_config('request.jwt.claim.sub', 'b4000000-0000-4000-8000-000000000003', false);
  assert not exists (select 1 from public.project_file_page(p1)), 'other: nothing of P1';
  perform set_config('request.jwt.claim.sub', 'b4000000-0000-4000-8000-000000000004', false);
  assert not exists (select 1 from public.project_file_page(p1)), 'nobody: nothing';
  perform set_config('request.jwt.claim.sub', '', false);
  assert not exists (select 1 from public.project_file_page(p1)), 'signed out: nothing';
end $$;

do $$
declare
  who uuid;
  proj uuid;
  diff bigint;
  checked int := 0;
begin
  for who in select id from b40_people loop
    perform set_config('request.jwt.claim.sub', coalesce(who::text, ''), false);
    for proj in select id from b40_projects loop
      select count(*) into diff from (
        (select id, task_id, task_title, created_at from public.project_file_page(proj)
         except all select * from pg_temp.b40_old_files(proj))
        union all
        (select * from pg_temp.b40_old_files(proj)
         except all select id, task_id, task_title, created_at from public.project_file_page(proj))
      ) d;
      assert diff = 0, format('files differ for %s in %s (%s rows)', who, proj, diff);
      -- Same order too.
      assert (select array_agg(id) from public.project_file_page(proj)) is not distinct from
             (select array_agg(id) from pg_temp.b40_old_files(proj)), format('order differs for %s in %s', who, proj);
      checked := checked + 1;
    end loop;
  end loop;
  assert checked >= 30, format('enough (person, project) pairs checked: %s', checked);
  perform set_config('request.jwt.claim.sub', '', false);
end $$;

-- 3. Reports -----------------------------------------------------------------------------------------

create function pg_temp.b40_rows(f jsonb, g text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(r) order by r.bucket nulls first, r.project_id nulls first), '[]'::jsonb)
  from public.workspace_report(f, g, 'America/New_York') r;
$$;
grant execute on function pg_temp.b40_rows(jsonb, text) to authenticated;

create function pg_temp.b40_sorted(a jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(e order by e ->> 'bucket' nulls first, e ->> 'project_id' nulls first), '[]'::jsonb)
  from jsonb_array_elements(a) e;
$$;
grant execute on function pg_temp.b40_sorted(jsonb) to authenticated;

do $$
declare
  who uuid;
  f jsonb;
  g text;
  combined jsonb;
  checked int := 0;
  p1 uuid := (select id from b40_ids where name = 'p1');
begin
  for who in select id from b40_people loop
    perform set_config('request.jwt.claim.sub', coalesce(who::text, ''), false);
    foreach f in array array[
      '{}'::jsonb,
      '{"include_subtasks": true}'::jsonb,
      '{"assignees": ["me", null]}'::jsonb,
      '{"status": "open"}'::jsonb,
      '{"status": "overdue", "include_subtasks": true}'::jsonb,
      jsonb_build_object('projects', jsonb_build_array(p1)),
      jsonb_build_object('from', (current_date - 10)::text, 'to', (current_date + 10)::text)
    ] loop
      combined := public.workspace_report_groups(f, 'America/New_York');
      foreach g in array array['none', 'project', 'assignee', 'section'] loop
        assert pg_temp.b40_sorted(combined -> g) = pg_temp.b40_rows(f, g),
          format('%s differs for %s with %s: new %s, old %s', g, who, f, pg_temp.b40_sorted(combined -> g), pg_temp.b40_rows(f, g));
      end loop;
      checked := checked + 1;
    end loop;
  end loop;
  assert checked >= 80, format('enough (person, filter) pairs: %s', checked);
  perform set_config('request.jwt.claim.sub', '', false);
end $$;

-- 4. Timing: 1,500 tasks, 2,000 files ------------------------------------------------------------------

reset role;
do $$
declare
  owner uuid := 'b4000000-0000-4000-8000-000000000001';
  p uuid;
begin
  perform set_config('request.jwt.claim.sub', owner::text, true);
  insert into public.projects (workspace_id, name, created_by) values ('00000000-0000-4000-8000-000000000001', 'B40 Bench', owner)
    returning id into p;
  insert into b40_ids values ('bench', p);
  insert into public.tasks (workspace_id, home_project_id, title, created_by)
  select '00000000-0000-4000-8000-000000000001', p, 'B40 bench ' || g, owner from generate_series(1, 1500) g;
  insert into public.task_attachments (task_id, storage_path, file_name, content_type, size_bytes, uploaded_by, created_at)
  select t.id, t.id || '/' || gen_random_uuid() || '-b.pdf', 'B40 bench.pdf', 'application/pdf', 10, owner, now() - make_interval(secs => g)
  from (select id, row_number() over (order by id) n from public.tasks where home_project_id = p) t
  join generate_series(1, 2000) g on (g % 1500) + 1 = t.n;
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b4000000-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b40_ids where name = 'bench');
  t0 timestamptz;
  old_ms numeric;
  new_ms numeric;
  n bigint;
begin
  assert (select count(*) from public.task_attachments a join public.tasks t on t.id = a.task_id where t.home_project_id = p) = 2000,
    'bench files';
  -- The old reads in SQL: every membership with its task's files, then the subtasks' files.
  t0 := clock_timestamp();
  perform jsonb_agg(x) from (
    select t.id, t.title, (select jsonb_agg(a) from public.task_attachments a where a.task_id = t.id) files
    from public.task_projects tp join public.tasks t on t.id = tp.task_id
    where tp.project_id = p and tp.deleted_at is null
  ) x;
  perform count(*) from public.tasks s
  where s.root_task_id in (select tp.task_id from public.task_projects tp where tp.project_id = p) and s.deleted_at is null;
  old_ms := extract(epoch from clock_timestamp() - t0) * 1000;
  t0 := clock_timestamp();
  select count(*) into n from public.project_file_page(p);
  new_ms := extract(epoch from clock_timestamp() - t0) * 1000;
  assert n = 500, 'bench: 500 shown';
  raise notice 'batch 40 Files, 1,500 tasks / 2,000 files: old reads % ms (plus sorting 2,000 files in the app), project_file_page % ms',
    round(old_ms, 1), round(new_ms, 1);

  t0 := clock_timestamp();
  perform public.workspace_report('{}', 'none', 'UTC'), public.workspace_report('{}', 'project', 'UTC'),
          public.workspace_report('{}', 'assignee', 'UTC'), public.workspace_report('{}', 'section', 'UTC');
  old_ms := extract(epoch from clock_timestamp() - t0) * 1000;
  t0 := clock_timestamp();
  perform public.workspace_report_groups('{}', 'UTC');
  new_ms := extract(epoch from clock_timestamp() - t0) * 1000;
  raise notice 'batch 40 Reports, owner''s workspace: four workspace_report calls % ms, workspace_report_groups % ms',
    round(old_ms, 1), round(new_ms, 1);
end $$;

explain (analyze, buffers, costs off, timing off, summary on)
select * from public.project_file_page((select id from b40_ids where name = 'bench'));

reset role;
