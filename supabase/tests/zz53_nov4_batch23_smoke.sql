-- Nov 4 notes, batch 23 (20261104040000_nov4_batch23_a.sql): per-query permission checks. Every rewritten
-- policy answers exactly as before. Runs last, over the rows every earlier suite left behind:
--   1. the two new functions: definer, stable, an empty search_path, authenticated only;
--   2. no policy calls has_project_role / has_portfolio_role / custom_field_has_role per row any more,
--      and every has_task_role call sits behind the indexed membership check (task_projects' own aside);
--   3. the sets equal the helpers (every project and portfolio, every role) and the task check is
--      sufficient (true only where has_task_role is) — for a range of people, anyone signed out included;
--   4. the old and new expression of every rewritten policy (USING and WITH CHECK) give the same answer
--      on every row of its table, for the same people (fixtures/batch23_policy_expressions.sql);
--   5. a removed membership of a task that has since become a subtask can't come back;
--   6. the plans compute the sets once (InitPlan), not per row.

\set ON_ERROR_STOP 1

-- 1. The functions -------------------------------------------------------------------------------------

do $$
declare
  fn regprocedure;
begin
  foreach fn in array array['public.project_ids_with_role(text)', 'public.portfolio_ids_with_role(text)']::regprocedure[] loop
    assert (select prosecdef from pg_catalog.pg_proc where oid = fn), format('%s is definer', fn);
    assert (select provolatile from pg_catalog.pg_proc where oid = fn) = 's', format('%s is stable', fn);
    assert (select proconfig from pg_catalog.pg_proc where oid = fn) = array['search_path=""'],
      format('%s has an empty search_path', fn);
    assert has_function_privilege('authenticated', fn, 'execute'), format('%s: authenticated executes it', fn);
    assert not has_function_privilege('anon', fn, 'execute'), format('%s: nothing for anon', fn);
  end loop;
end $$;

-- 2. The policies --------------------------------------------------------------------------------------

do $$
declare
  r record;
  n_role int;
  n_fast int;
begin
  for r in
    select c.relname as tbl, p.polname, coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
           coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as body
    from pg_catalog.pg_policy p
    join pg_catalog.pg_class c on c.oid = p.polrelid
    where c.relnamespace = 'public'::regnamespace
  loop
    assert r.body !~ '(^|[^_a-z])(has_project_role|has_portfolio_role|custom_field_has_role)\(',
      format('%s.%s still checks a project / portfolio / field role per row', r.tbl, r.polname);
    if r.tbl <> 'task_projects' then
      -- Each has_task_role call has the membership check in front.
      n_role := (select count(*) from regexp_matches(r.body, 'has_task_role\(', 'g'));
      n_fast := (select count(*) from regexp_matches(r.body, 'FROM (public\.)?task_projects tp_rls', 'g'));
      assert n_role = n_fast, format('%s.%s: has_task_role without the membership check in front', r.tbl, r.polname);
    end if;
  end loop;
  -- The check relies on this: only top-level tasks have active memberships.
  assert not exists (
    select 1 from public.task_projects tp join public.tasks t on t.id = tp.task_id
    where tp.deleted_at is null and t.parent_task_id is not null
  ), 'no subtask has an active membership';
end $$;

-- The people the checks run as: the most connected members, portfolio members, private-task owners,
-- members of archived projects, people removed from the workspace, people with no membership, and
-- someone signed out (null).
create temporary table b23_people (id uuid) on commit preserve rows;
insert into b23_people
select id from (
  (select m.profile_id as id from public.project_members m where m.deleted_at is null
   group by m.profile_id order by count(*) desc, m.profile_id limit 8)
  union
  (select m.profile_id from public.project_members m where m.deleted_at is not null
   group by m.profile_id order by m.profile_id limit 2)
  union
  (select m.profile_id from public.portfolio_members m where m.deleted_at is null
   group by m.profile_id order by count(*) desc, m.profile_id limit 3)
  union
  (select t.created_by from public.tasks t where t.home_project_id is null and t.created_by is not null
   group by t.created_by order by count(*) desc, t.created_by limit 2)
  union
  (select m.profile_id from public.project_members m join public.projects pj on pj.id = m.project_id
   where pj.archived_at is not null and m.deleted_at is null and m.role in ('owner', 'admin', 'editor')
   order by m.profile_id limit 2)
  union
  (select p.id from public.profiles p join public.allowed_emails a on a.email = lower(p.email)
   where a.removed_at is not null order by p.id limit 2)
  union
  (select p.id from public.profiles p
   where not exists (select 1 from public.project_members m where m.profile_id = p.id)
   order by p.id limit 2)
) x
union all select null;

do $$
begin
  assert (select count(*) from b23_people) >= 12, 'enough people to check';
  assert exists (select 1 from b23_people p join public.project_members m on m.profile_id = p.id
                 join public.projects pj on pj.id = m.project_id where pj.archived_at is not null),
    'someone in an archived project';
  assert exists (select 1 from b23_people p join public.portfolio_members m on m.profile_id = p.id), 'a portfolio member';
end $$;

-- 3. The sets equal the helpers -------------------------------------------------------------------------

do $$
declare
  who uuid;
  bad bigint;
begin
  for who in select id from b23_people loop
    perform set_config('request.jwt.claim.sub', coalesce(who::text, ''), false);

    select count(*) into bad
    from public.projects pj, unnest(array['viewer', 'commenter', 'editor', 'admin', 'owner', 'nobody']) r
    where public.has_project_role(pj.id, r) is distinct from (pj.id = any (public.project_ids_with_role(r)));
    assert bad = 0, format('project_ids_with_role differs from has_project_role for %s (%s)', who, bad);

    select count(*) into bad
    from public.portfolios pf, unnest(array['viewer', 'editor', 'admin', 'owner', 'nobody']) r
    where public.has_portfolio_role(pf.id, r) is distinct from (pf.id = any (public.portfolio_ids_with_role(r)));
    assert bad = 0, format('portfolio_ids_with_role differs from has_portfolio_role for %s (%s)', who, bad);

    assert public.project_ids_with_role('viewer') @> public.viewer_project_ids()
       and public.viewer_project_ids() @> public.project_ids_with_role('viewer'), 'the viewer set is batch 18''s';

    -- The task check is sufficient: wherever a membership is in r's set, has_task_role(task, r) holds.
    select count(*) into bad
    from public.task_projects tp, unnest(array['viewer', 'commenter', 'editor', 'admin', 'owner']) r
    where tp.deleted_at is null
      and case when tp.project_id = any (public.project_ids_with_role(r))
               then not public.has_task_role(tp.task_id, r) else false end;
    assert bad = 0, format('the membership check allows a task has_task_role refuses for %s (%s)', who, bad);
  end loop;
  perform set_config('request.jwt.claim.sub', '', false);
end $$;

-- 4. Old and new expressions agree on every row ---------------------------------------------------------

create temporary table b23_exprs (tbl text, policy text, kind text, old_expr text, new_expr text) on commit preserve rows;
\ir fixtures/batch23_policy_expressions.sql

do $$
declare
  who uuid;
  e record;
  bad bigint;
  checked int := 0;
begin
  assert (select count(*) from b23_exprs) > 150, 'every rewritten policy is listed';
  -- Each listed policy's live expression is the new one (the migration applied them all). Nov 10 batch 36
  -- renamed the rules / forms / portfolio_rules write policies to _editor (Owners and Editors build them).
  for e in select * from b23_exprs loop
    assert exists (
      select 1 from pg_catalog.pg_policy p
      where p.polrelid = format('public.%I', e.tbl)::regclass
        and (p.polname = e.policy
          or (e.tbl in ('rules', 'forms', 'portfolio_rules') and p.polname = replace(e.policy, '_admin', '_editor')))
    ), format('%s.%s exists', e.tbl, e.policy);
  end loop;
  for who in select id from b23_people loop
    perform set_config('request.jwt.claim.sub', coalesce(who::text, ''), false);
    for e in select * from b23_exprs order by tbl, policy, kind loop
      execute format('select count(*) from public.%I where (%s) is distinct from (%s)', e.tbl, e.old_expr, e.new_expr)
        into bad;
      assert bad = 0, format('%s.%s (%s) answers differently for %s on %s rows', e.tbl, e.policy, e.kind, who, bad);
      checked := checked + 1;
    end loop;
  end loop;
  perform set_config('request.jwt.claim.sub', '', false);
  raise notice 'batch 23: % policy expressions agree for every row', checked;
end $$;

-- And through RLS: what each person reads from the hot tables is what the helpers allow.
do $$
declare
  who uuid;
  n_rls bigint;
  n_helper bigint;
begin
  for who in select id from b23_people where id is not null loop
    perform set_config('request.jwt.claim.sub', who::text, false);
    select count(*) into n_helper from (
      select 1 from public.task_field_values v where public.custom_field_has_role(v.field_id, 'viewer')
      union all select 1 from public.comments c where public.has_task_role(c.task_id, 'viewer')
      union all select 1 from public.sections s where public.has_project_role(s.project_id, 'viewer')
      union all select 1 from public.project_members m where public.has_project_role(m.project_id, 'viewer')
      union all select 1 from public.task_stories st where public.has_task_role(st.task_id, 'viewer')
      union all select 1 from public.portfolio_members pm where public.has_portfolio_role(pm.portfolio_id, 'viewer')
    ) x;
    set local role authenticated;
    select count(*) into n_rls from (
      select 1 from public.task_field_values
      union all select 1 from public.comments
      union all select 1 from public.sections
      union all select 1 from public.project_members
      union all select 1 from public.task_stories
      union all select 1 from public.portfolio_members
    ) x;
    reset role;
    assert n_rls = n_helper, format('RLS reads %s rows for %s, the helpers allow %s', n_rls, who, n_helper);
  end loop;
  perform set_config('request.jwt.claim.sub', '', false);
end $$;

-- 5. A removed membership of a task that is now a subtask stays removed ---------------------------------

do $$
declare
  tp record;
  refused boolean := false;
begin
  select tp2.task_id, tp2.project_id into tp
  from public.task_projects tp2 join public.tasks t on t.id = tp2.task_id
  where tp2.deleted_at is not null and t.parent_task_id is not null
  limit 1;
  -- Earlier suites converted tasks with memberships into subtasks (zz03, zz35).
  assert tp.task_id is not null, 'a removed membership of a subtask to try';
  begin
    update public.task_projects set deleted_at = null where task_id = tp.task_id and project_id = tp.project_id;
  exception when check_violation then
    refused := true;
  end;
  assert refused, 'bringing back a subtask''s membership is refused';
end $$;

-- 6. The sets are InitPlans ---------------------------------------------------------------------------

do $$
declare
  q text;
  line text;
  prev text[];
  n_sets int;
begin
  perform set_config('request.jwt.claim.sub',
    (select m.profile_id::text from public.project_members m where m.deleted_at is null
     group by m.profile_id order by count(*) desc, m.profile_id limit 1), false);
  foreach q in array array[
    'select c.id from public.comments c',
    'select v.task_id from public.task_field_values v',
    'select s.id from public.sections s',
    'select f.task_id from public.task_followers f'
  ] loop
    n_sets := 0;
    prev := array['', ''];
    set local role authenticated;
    for line in execute 'explain (verbose, costs off) ' || q loop
      if line ~ 'project_ids_with_role\(' then
        -- Every use is the output of an InitPlan: computed once per statement, never per row.
        assert line ~ '^\s*Output: (public\.)?project_ids_with_role\(''\w+''::text\)$'
           and prev[2] ~ '->  Result' and prev[1] ~ 'InitPlan \d+',
          format('%s: the set isn''t an InitPlan here: %s', q, line);
        n_sets := n_sets + 1;
      end if;
      prev := array[prev[2], line];
    end loop;
    reset role;
    assert n_sets > 0, format('%s uses project_ids_with_role', q);
  end loop;
  perform set_config('request.jwt.claim.sub', '', false);
end $$;
