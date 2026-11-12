-- Nov 12 batch 39 (20261112010000_nov12_speed39_a.sql, item 2a): "blocked by" counts in one pass.
--   1. open_blocker_counts keeps its shape (invoker, stable, empty search_path, authenticated only);
--      open_blocker_count_set is definer, authenticated only;
--   2. a mixed fixture: open / done / trashed blockers, every link kind, a removed link, a blocker in a
--      project the readers can't open, trashed and completed tasks, a subtask, a private task, an
--      archived project — open_blocker_counts answers exactly what open_blocker_count says per task;
--   3. the same for a range of people over every task with a link that earlier suites left behind, and
--      open_blocker_count_set never answers more than open_blocker_count one task at a time;
--   4. timing: 2,000 open tasks with blockers, the old per-task loop vs the new pass (NOTICEs).
--   b3900000…01 b39-owner@example.com  Ola Owner   (owns P1 and P3, a private task)
--   b3900000…02 b39-viewer@example.com Vic Viewer  (a Viewer of P1)
--   b3900000…03 b39-other@example.com  Oto Other   (owns P2, which the others can't open)
--   b3900000…04 b39-none@example.com   Nia Nobody  (allowlisted, no membership)

\set ON_ERROR_STOP 1

create temporary table b39_ids (name text primary key, id uuid) on commit preserve rows;
grant all on b39_ids to authenticated, anon, service_role;

-- The old body of open_blocker_counts (20261027020000_oct27_batch6_a.sql), as the reference.
create function pg_temp.b39_old_counts(task_ids uuid[])
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(x.id, x.n) filter (where x.n > 0), '{}'::jsonb)
  from (
    select t.id, public.open_blocker_count(t.id) as n
    from public.tasks t
    where t.id = any (task_ids[1:2000]) and t.deleted_at is null and t.completed_at is null
  ) x;
$$;
grant execute on function pg_temp.b39_old_counts(uuid[]) to authenticated;

-- 1. The functions ---------------------------------------------------------------------------------

do $$
begin
  assert not (select prosecdef from pg_catalog.pg_proc where oid = 'public.open_blocker_counts(uuid[])'::regprocedure),
    'open_blocker_counts stays invoker';
  assert (select provolatile from pg_catalog.pg_proc where oid = 'public.open_blocker_counts(uuid[])'::regprocedure) = 's',
    'open_blocker_counts stays stable';
  assert (select proconfig from pg_catalog.pg_proc where oid = 'public.open_blocker_counts(uuid[])'::regprocedure) = array['search_path=""'],
    'open_blocker_counts keeps its empty search_path';
  assert pg_get_function_result('public.open_blocker_counts(uuid[])'::regprocedure) = 'jsonb', 'still jsonb';
  assert (select prosecdef from pg_catalog.pg_proc where oid = 'public.open_blocker_count_set(uuid[])'::regprocedure),
    'open_blocker_count_set is definer (it sees links to tasks the caller can''t read)';
  assert (select proconfig from pg_catalog.pg_proc where oid = 'public.open_blocker_count_set(uuid[])'::regprocedure) = array['search_path=""'],
    'open_blocker_count_set has an empty search_path';
  assert has_function_privilege('authenticated', 'public.open_blocker_counts(uuid[])', 'execute'), 'authenticated: counts';
  assert has_function_privilege('authenticated', 'public.open_blocker_count_set(uuid[])', 'execute'), 'authenticated: set';
  assert not has_function_privilege('anon', 'public.open_blocker_counts(uuid[])', 'execute'), 'anon: no counts';
  assert not has_function_privilege('anon', 'public.open_blocker_count_set(uuid[])', 'execute'), 'anon: no set';
end $$;

-- 2. The fixture ------------------------------------------------------------------------------------

insert into public.allowed_emails (email, note) values
  ('b39-owner@example.com', 'batch 39'),
  ('b39-viewer@example.com', 'batch 39'),
  ('b39-other@example.com', 'batch 39'),
  ('b39-none@example.com', 'batch 39');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b3900000-0000-4000-8000-000000000001', 'b39-owner@example.com', now(), '{"full_name":"Ola Owner"}'),
  ('b3900000-0000-4000-8000-000000000002', 'b39-viewer@example.com', now(), '{"full_name":"Vic Viewer"}'),
  ('b3900000-0000-4000-8000-000000000003', 'b39-other@example.com', now(), '{"full_name":"Oto Other"}'),
  ('b3900000-0000-4000-8000-000000000004', 'b39-none@example.com', now(), '{"full_name":"Nia Nobody"}');

set role authenticated;
select set_config('request.jwt.claim.sub', 'b3900000-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  p uuid;
  s uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B39 Hidden') returning id into p;
  insert into public.sections (project_id, name) values (p, 'S') returning id into s;
  insert into b39_ids values ('p2', p), ('hidden', public.create_task(p, s, 'B39 hidden blocker'));
end $$;

select set_config('request.jwt.claim.sub', 'b3900000-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid;
  p3 uuid;
  s uuid;
  n text;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B39 Mixed') returning id into p;
  insert into public.sections (project_id, name) values (p, 'S') returning id into s;
  perform public.add_project_member(p, 'b39-viewer@example.com', 'viewer');
  insert into b39_ids values ('p1', p);
  foreach n in array array[
    'pred_open', 'pred_done', 'pred_trashed', 'pred_future', 'pred_started', 'pred_open2',
    's_fs', 's_done', 's_ss', 's_ff', 's_sf_future', 's_sf_started', 's_hidden', 's_pred_trashed',
    's_link_removed', 's_trashed', 's_completed', 's_multi', 's_none', 'parent'
  ] loop
    insert into b39_ids values (n, public.create_task(p, s, 'B39 ' || n));
  end loop;
  insert into b39_ids values ('sub', public.create_subtask((select id from b39_ids where name = 'parent'), 'B39 sub', null));
  insert into b39_ids values ('private', public.create_private_task('B39 private'));
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B39 Archived') returning id into p3;
  insert into public.sections (project_id, name) values (p3, 'S') returning id into s;
  insert into b39_ids values ('p3', p3), ('a_pred', public.create_task(p3, s, 'B39 a_pred')),
    ('a_task', public.create_task(p3, s, 'B39 a_task'));
end $$;

reset role;
-- Links and states written directly (the link to the hidden project couldn't be made through
-- set_task_dependency by anyone here, which is the point).
do $$
declare
  id_of jsonb := (select jsonb_object_agg(name, id) from b39_ids);
  p1 uuid := (id_of ->> 'p1')::uuid;
  link record;
begin
  for link in select * from (values
    ('pred_open', 's_fs', 'finish_to_start'),
    ('pred_done', 's_done', 'finish_to_start'),
    ('pred_open', 's_ss', 'start_to_start'),
    ('pred_open', 's_ff', 'finish_to_finish'),
    ('pred_future', 's_sf_future', 'start_to_finish'),
    ('pred_started', 's_sf_started', 'start_to_finish'),
    ('hidden', 's_hidden', 'finish_to_start'),
    ('pred_trashed', 's_pred_trashed', 'finish_to_start'),
    ('pred_open', 's_link_removed', 'finish_to_start'),
    ('pred_open', 's_trashed', 'finish_to_start'),
    ('pred_open', 's_completed', 'finish_to_start'),
    ('pred_open', 's_multi', 'finish_to_start'),
    ('pred_open2', 's_multi', 'finish_to_finish'),
    ('pred_done', 's_multi', 'finish_to_start'),
    ('hidden', 's_multi', 'finish_to_start'),
    ('pred_open', 'sub', 'finish_to_start'),
    ('pred_open', 'private', 'finish_to_start'),
    ('a_pred', 'a_task', 'finish_to_start')
  ) v(pred, succ, kind) loop
    insert into public.task_dependencies (project_id, predecessor_id, successor_id, kind)
    values (p1, (id_of ->> link.pred)::uuid, (id_of ->> link.succ)::uuid, link.kind);
  end loop;
  update public.tasks set completed_at = now() where id = (id_of ->> 'pred_done')::uuid;
  update public.tasks set start_on = current_date + 30, due_on = current_date + 40 where id = (id_of ->> 'pred_future')::uuid;
  update public.tasks set start_on = current_date - 5, due_on = current_date + 40 where id = (id_of ->> 'pred_started')::uuid;
  update public.tasks set deleted_at = now() where id in ((id_of ->> 'pred_trashed')::uuid, (id_of ->> 's_trashed')::uuid);
  update public.task_dependencies set deleted_at = now() where successor_id = (id_of ->> 's_link_removed')::uuid;
  update public.tasks set completed_at = now() where id = (id_of ->> 's_completed')::uuid;
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b3900000-0000-4000-8000-000000000001', false) is not null as ok \gset
select public.set_project_archived((select id from b39_ids where name = 'p3'), true) is not null as ok \gset

-- What each person sees, by name.
do $$
declare
  ids uuid[] := (select array_agg(id) from b39_ids where name not like 'p_' and name not in ('p1', 'p2', 'p3'));
  owner jsonb;
  viewer jsonb;
  other jsonb;
  nobody jsonb;
  expected jsonb := jsonb_build_object('s_fs', 1, 's_ff', 1, 's_sf_future', 1, 's_hidden', 1, 's_multi', 3, 'sub', 1);
  named jsonb;
begin
  perform set_config('request.jwt.claim.sub', 'b3900000-0000-4000-8000-000000000001', false);
  owner := public.open_blocker_counts(ids);
  assert owner = pg_temp.b39_old_counts(ids), format('owner: new %s, old %s', owner, pg_temp.b39_old_counts(ids));
  select jsonb_object_agg(b.name, v.value) into named from jsonb_each(owner) v join b39_ids b on b.id::text = v.key;
  assert named = expected || jsonb_build_object('private', 1, 'a_task', 1),
    format('owner counts by name: %s', named);

  perform set_config('request.jwt.claim.sub', 'b3900000-0000-4000-8000-000000000002', false);
  viewer := public.open_blocker_counts(ids);
  assert viewer = pg_temp.b39_old_counts(ids), format('viewer: new %s, old %s', viewer, pg_temp.b39_old_counts(ids));
  select jsonb_object_agg(b.name, v.value) into named from jsonb_each(viewer) v join b39_ids b on b.id::text = v.key;
  assert named = expected, format('viewer counts by name (no private task, no archived project): %s', named);

  perform set_config('request.jwt.claim.sub', 'b3900000-0000-4000-8000-000000000003', false);
  other := public.open_blocker_counts(ids);
  assert other = pg_temp.b39_old_counts(ids) and other = '{}'::jsonb, format('other: %s', other);

  perform set_config('request.jwt.claim.sub', 'b3900000-0000-4000-8000-000000000004', false);
  nobody := public.open_blocker_counts(ids);
  assert nobody = '{}'::jsonb and nobody = pg_temp.b39_old_counts(ids), format('nobody: %s', nobody);
  assert not exists (select 1 from public.open_blocker_count_set(ids)), 'the set answers nothing for nobody';

  perform set_config('request.jwt.claim.sub', '', false);
  assert public.open_blocker_counts(ids) = '{}'::jsonb, 'signed out: nothing';
  assert not exists (select 1 from public.open_blocker_count_set(ids)), 'the set answers nothing signed out';
end $$;

-- 3. Everyone, every linked task --------------------------------------------------------------------

reset role;
create temporary table b39_people (id uuid) on commit preserve rows;
insert into b39_people
select id from (
  (select m.profile_id as id from public.project_members m where m.deleted_at is null
   group by m.profile_id order by count(*) desc, m.profile_id limit 8)
  union
  (select m.profile_id from public.project_members m where m.deleted_at is not null
   group by m.profile_id order by m.profile_id limit 2)
  union
  (select t.created_by from public.tasks t where t.home_project_id is null and t.created_by is not null
   group by t.created_by order by count(*) desc, t.created_by limit 2)
  union
  (select m.profile_id from public.project_members m join public.projects pj on pj.id = m.project_id
   where pj.archived_at is not null and m.deleted_at is null order by m.profile_id limit 2)
  union
  (select p.id from public.profiles p join public.allowed_emails a on a.email = lower(p.email)
   where a.removed_at is not null order by p.id limit 2)
  union
  (select p.id from public.profiles p
   where not exists (select 1 from public.project_members m where m.profile_id = p.id)
   order by p.id limit 2)
  union
  (select id from (values
    ('b3900000-0000-4000-8000-000000000001'::uuid), ('b3900000-0000-4000-8000-000000000002'::uuid),
    ('b3900000-0000-4000-8000-000000000003'::uuid), ('b3900000-0000-4000-8000-000000000004'::uuid)) v(id))
) x
union all select null;
grant select on b39_people to authenticated;

create temporary table b39_linked (id uuid primary key) on commit preserve rows;
insert into b39_linked select distinct successor_id from public.task_dependencies
  union select distinct predecessor_id from public.task_dependencies;
grant select on b39_linked to authenticated;

do $$
begin
  assert (select count(*) from b39_people) >= 12, 'enough people to check';
  assert (select count(*) from b39_linked) >= 40, 'enough linked tasks to check';
end $$;

set role authenticated;
do $$
declare
  who uuid;
  bad bigint;
  chunk uuid[];
  i int := 0;
  all_ids uuid[] := (select array_agg(id order by id) from b39_linked);
begin
  for who in select id from b39_people loop
    perform set_config('request.jwt.claim.sub', coalesce(who::text, ''), false);
    i := 1;
    while i <= cardinality(all_ids) loop
      chunk := all_ids[i:i + 1999];
      assert public.open_blocker_counts(chunk) = pg_temp.b39_old_counts(chunk),
        format('open_blocker_counts differs for %s', who);
      i := i + 2000;
    end loop;
    -- The client-callable set never says more than open_blocker_count one task at a time (which
    -- answers 0 for tasks the caller can't ask about), trashed and completed tasks included.
    select count(*) into bad
    from b39_linked l
    left join public.open_blocker_count_set(all_ids[1:2000]) s on s.task_id = l.id
    where l.id = any (all_ids[1:2000])
      and coalesce(s.blockers, 0) <> public.open_blocker_count(l.id);
    assert bad = 0, format('open_blocker_count_set differs from open_blocker_count for %s (%s)', who, bad);
  end loop;
  perform set_config('request.jwt.claim.sub', '', false);
end $$;

-- 4. Timing: one person, 2,000 open assigned tasks (1,000 blocked) -------------------------------------

reset role;
do $$
declare
  owner uuid := 'b3900000-0000-4000-8000-000000000001';
  p uuid;
  s uuid;
begin
  perform set_config('request.jwt.claim.sub', owner::text, true);
  insert into public.projects (workspace_id, name, created_by) values ('00000000-0000-4000-8000-000000000001', 'B39 Bench', owner)
    returning id into p;
  insert into public.sections (project_id, name) values (p, 'S') returning id into s;
  insert into b39_ids values ('bench', p);
  insert into public.tasks (workspace_id, home_project_id, title, created_by, assignee_id)
  select '00000000-0000-4000-8000-000000000001', p, 'B39 bench ' || g, owner, owner from generate_series(1, 2000) g;
  insert into public.task_dependencies (project_id, predecessor_id, successor_id)
  select p, a.id, b.id
  from (select id, row_number() over (order by id) n from public.tasks where home_project_id = p) a
  join (select id, row_number() over (order by id) n from public.tasks where home_project_id = p) b on b.n = a.n + 1000
  where a.n <= 1000;
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b3900000-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  ids uuid[] := (select array_agg(id) from public.tasks where home_project_id = (select id from b39_ids where name = 'bench'));
  t0 timestamptz;
  old_ms numeric;
  new_ms numeric;
  old_counts jsonb;
  new_counts jsonb;
begin
  assert cardinality(ids) = 2000, 'bench tasks';
  t0 := clock_timestamp();
  old_counts := pg_temp.b39_old_counts(ids);
  old_ms := extract(epoch from clock_timestamp() - t0) * 1000;
  t0 := clock_timestamp();
  new_counts := public.open_blocker_counts(ids);
  new_ms := extract(epoch from clock_timestamp() - t0) * 1000;
  assert old_counts = new_counts, 'bench: same counts';
  assert (select count(*) from jsonb_object_keys(new_counts)) = 1000, 'bench: 1,000 blocked';
  raise notice 'batch 39 open_blocker_counts, 2,000 open tasks (1,000 blocked): per-task loop % ms, one pass % ms',
    round(old_ms, 1), round(new_ms, 1);
end $$;

explain (analyze, buffers, costs off, timing off, summary on)
select public.open_blocker_counts((select array_agg(id) from public.tasks where home_project_id = (select id from b39_ids where name = 'bench')));

reset role;
