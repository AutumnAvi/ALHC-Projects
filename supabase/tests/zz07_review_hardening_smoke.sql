-- Checks for Review hardening: anon holds no privilege on any ALHC table and can execute only
-- get_public_form, submit_form, and receive_inbound_webhook; the performance fixes (covering indexes
-- for foreign keys, auth.uid() wrapped in a sub-select, one permissive policy per table / role /
-- command); and log retention (alhc_purge_old_logs keeps pending / retrying outbox rows and recent rows;
-- the alhc-log-purge cron job exists). Everything in a database built from supabase/migrations is ALHC's,
-- so the checks cover every table and (non-extension) function in public: a future table or function
-- that keeps Supabase's default anon grant fails here.

\set ON_ERROR_STOP 1

-- 1. anon grants ---------------------------------------------------------------------------------

do $$
declare
  exposed text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into exposed
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
    and (
      has_table_privilege('anon', c.oid, 'select, insert, update, delete, truncate, references, trigger')
      or has_any_column_privilege('anon', c.oid, 'select, insert, update, references')
    );
  assert exposed is null, format('anon must hold no privilege on ALHC tables, still has: %s', exposed);

  select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text) into exposed
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
    and has_function_privilege('anon', p.oid, 'execute');
  assert exposed = 'get_public_form(uuid), receive_inbound_webhook(text,text,text,text,text), submit_form(uuid,text,jsonb)',
    format('anon may execute exactly the three public entry points, got: %s', exposed);

  -- Trigger functions that anon reached through PUBLIC keep their authenticated / service_role grants.
  assert has_function_privilege('authenticated', 'public.set_updated_at()', 'execute')
    and has_function_privilege('service_role', 'public.set_updated_at()', 'execute'), 'other roles keep access';
  assert has_function_privilege('authenticated', 'public.create_task(uuid, uuid, text)', 'execute'),
    'client RPCs stay callable';
  -- The migration helpers are internal.
  assert not has_function_privilege('authenticated', 'public.alhc_revoke_anon_grants(text[])', 'execute')
    and not has_function_privilege('anon', 'public.alhc_revoke_anon_grants(text[])', 'execute'), 'helper is internal';
  assert not has_function_privilege('authenticated', 'public.alhc_revoke_anon_execute(text[])', 'execute')
    and not has_function_privilege('anon', 'public.alhc_revoke_anon_execute(text[])', 'execute'), 'helper is internal';
end $$;

-- The helpers are safe to run again and skip names that don't exist.
select public.alhc_revoke_anon_grants(array['tasks', 'no_such_table']) = 1 as ok \gset
\if :ok
\else
  \echo 'alhc_revoke_anon_grants must skip missing tables'
  select 1/0;
\endif
select public.alhc_revoke_anon_execute(array['create_task(uuid,uuid,text)', 'submit_form(uuid,text,jsonb)', 'no_such_fn()']) = 0 as ok \gset
\if :ok
\else
  \echo 'alhc_revoke_anon_execute must skip revoked, kept, and missing functions'
  select 1/0;
\endif

set role anon;
do $$
begin
  begin
    perform 1 from public.tasks limit 1;
    raise exception 'anon must not read tasks';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.allowed_emails limit 1;
    raise exception 'anon must not read the allowlist';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.search_tasks('x', 5);
    raise exception 'anon must not run invoker RPCs';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- 2. Performance advisor fixes -------------------------------------------------------------------

do $$
declare
  missing text;
begin
  -- Every foreign key in public has an index whose leading columns are exactly its columns (lint 0001).
  select string_agg(format('%s.%s', con.conrelid::regclass, con.conname), ', ') into missing
  from pg_constraint con join pg_namespace n on n.oid = con.connamespace
  where n.nspname = 'public' and con.contype = 'f'
    and not exists (
      select 1 from pg_index i
      where i.indrelid = con.conrelid
        and (select array_agg(k order by k) from unnest((i.indkey::int2[])[0:cardinality(con.conkey) - 1]) k)
          = (select array_agg(k order by k) from unnest(con.conkey) k)
    );
  assert missing is null, format('foreign keys without a covering index: %s', missing);

  -- auth.uid() / auth.jwt() in policies only inside a sub-select (lint 0003).
  select string_agg(format('%s.%s', tablename, policyname), ', ') into missing
  from pg_policies
  where schemaname = 'public'
    and (
      (regexp_count(coalesce(qual, ''), 'auth\.(uid|jwt|role)\(\)')
        <> regexp_count(coalesce(qual, ''), 'SELECT auth\.(uid|jwt|role)\(\)'))
      or (regexp_count(coalesce(with_check, ''), 'auth\.(uid|jwt|role)\(\)')
        <> regexp_count(coalesce(with_check, ''), 'SELECT auth\.(uid|jwt|role)\(\)'))
    );
  assert missing is null, format('policies calling auth functions per row: %s', missing);

  -- At most one permissive policy per table, role, and command (lint 0006).
  select string_agg(format('%s %s %s', tablename, r, c), ', ') into missing
  from (
    select p.tablename, r, c
    from pg_policies p
    cross join lateral unnest(p.roles) r
    cross join lateral unnest(
      case when p.cmd = 'ALL' then array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] else array[p.cmd] end
    ) c
    where p.schemaname = 'public' and p.permissive = 'PERMISSIVE'
    group by p.tablename, r, c
    having count(*) > 1
  ) dup;
  assert missing is null, format('several permissive policies for one role and command: %s', missing);

  assert exists (select 1 from pg_policies where tablename = 'import_runs' and policyname = 'import_runs_select_admin_or_workspace_admin')
    and not exists (select 1 from pg_policies where tablename = 'import_runs' and policyname in ('import_runs_select_admin', 'import_runs_select_workspace_admin')),
    'import_runs has one merged select policy';
  assert exists (select 1 from pg_policies where tablename = 'team_members' and policyname = 'team_members_update_lead_or_own')
    and not exists (select 1 from pg_policies where tablename = 'team_members' and policyname in ('team_members_update_lead', 'team_members_update_own')),
    'team_members has one merged update policy';
end $$;

-- Merged policies keep the same access (suites 94 and 96 cover the workflows; these are direct checks).
create temporary table rh_ids (name text primary key, id uuid) on commit preserve rows;
create temporary table rh_vals (name text primary key, val text) on commit preserve rows;
grant all on rh_ids, rh_vals to authenticated;

insert into public.allowed_emails (email, note) values
  ('rh-owner@example.com', 'review hardening suite'),
  ('rh-viewer@example.com', 'review hardening suite'),
  ('rh-member@example.com', 'review hardening suite');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('f7f7f7f7-0000-4000-8000-000000000001', 'rh-owner@example.com', now(), '{"full_name":"Rho Owner"}'),
  ('f7f7f7f7-0000-4000-8000-000000000002', 'rh-viewer@example.com', now(), '{"full_name":"Rho Viewer"}'),
  ('f7f7f7f7-0000-4000-8000-000000000003', 'rh-member@example.com', now(), '{"full_name":"Rho Member"}');
insert into rh_ids values
  ('owner', 'f7f7f7f7-0000-4000-8000-000000000001'),
  ('viewer', 'f7f7f7f7-0000-4000-8000-000000000002'),
  ('member', 'f7f7f7f7-0000-4000-8000-000000000003');

set role authenticated;
select set_config('request.jwt.claim.sub', 'f7f7f7f7-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid;
  t uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'RH P') returning id into p;
  perform public.add_project_member(p, 'rh-viewer@example.com', 'viewer');
  insert into rh_ids values ('project', p), ('run', public.start_import_run(p, 'asana', array['a.json']));
  insert into public.teams (name) values ('RH Team') returning id into t;
  perform public.add_team_member(t, 'rh-member@example.com', 'member');
  insert into rh_ids values ('team', t);
end $$;
reset role;

do $$
declare
  ws_admin uuid := (select profile_id from public.workspace_admins where deleted_at is null order by created_at limit 1);
begin
  assert ws_admin is not null, 'an earlier suite left a workspace admin';
  insert into rh_ids values ('ws_admin', ws_admin);
  insert into rh_vals values ('ws_admin_email', (select email from auth.users where id = ws_admin));
end $$;

-- Project owner (Admin+) sees the run; a plain Viewer doesn't; a workspace admin sees it only once they
-- can read the project.
set role authenticated;
do $$
declare
  run uuid := (select id from rh_ids where name = 'run');
  p uuid := (select id from rh_ids where name = 'project');
begin
  perform set_config('request.jwt.claim.sub', 'f7f7f7f7-0000-4000-8000-000000000001', true);
  assert exists (select 1 from public.import_runs where id = run), 'project admins see import runs';
  perform set_config('request.jwt.claim.sub', 'f7f7f7f7-0000-4000-8000-000000000002', true);
  assert not exists (select 1 from public.import_runs where id = run), 'viewers do not';
  perform set_config('request.jwt.claim.sub', (select id::text from rh_ids where name = 'ws_admin'), true);
  assert not exists (select 1 from public.import_runs where id = run), 'workspace admins outside the project do not';
end $$;
select set_config('request.jwt.claim.sub', 'f7f7f7f7-0000-4000-8000-000000000001', false) is not null as ok \gset
select public.add_project_member((select id from rh_ids where name = 'project'),
  (select val from rh_vals where name = 'ws_admin_email'), 'viewer') is not null as ok \gset
do $$
begin
  perform set_config('request.jwt.claim.sub', (select id::text from rh_ids where name = 'ws_admin'), true);
  assert exists (select 1 from public.import_runs where id = (select id from rh_ids where name = 'run')),
    'workspace admins who can read the project see its runs';
end $$;

-- A plain member can leave but not change roles; the lead can change roles.
do $$
declare
  t uuid := (select id from rh_ids where name = 'team');
  n integer;
begin
  perform set_config('request.jwt.claim.sub', 'f7f7f7f7-0000-4000-8000-000000000003', true);
  update public.team_members set role = 'lead' where team_id = t and profile_id = 'f7f7f7f7-0000-4000-8000-000000000003';
  raise exception 'a member must not promote themself';
exception when insufficient_privilege or check_violation then null;
end $$;
do $$
declare
  t uuid := (select id from rh_ids where name = 'team');
  n integer;
begin
  perform set_config('request.jwt.claim.sub', 'f7f7f7f7-0000-4000-8000-000000000002', true);
  update public.team_members set deleted_at = now() where team_id = t and profile_id = 'f7f7f7f7-0000-4000-8000-000000000003';
  get diagnostics n = row_count;
  assert n = 0, 'nobody else removes a member';
  perform set_config('request.jwt.claim.sub', 'f7f7f7f7-0000-4000-8000-000000000001', true);
  update public.team_members set role = 'lead' where team_id = t and profile_id = 'f7f7f7f7-0000-4000-8000-000000000003';
  get diagnostics n = row_count;
  assert n = 1, 'the lead changes roles';
  perform set_config('request.jwt.claim.sub', 'f7f7f7f7-0000-4000-8000-000000000003', true);
  update public.team_members set deleted_at = now() where team_id = t and profile_id = 'f7f7f7f7-0000-4000-8000-000000000003';
  get diagnostics n = row_count;
  assert n = 1, 'members can leave';
end $$;
reset role;

-- 3. Log retention -------------------------------------------------------------------------------

do $$
begin
  assert (select prosecdef from pg_proc where oid = 'public.alhc_purge_old_logs()'::regprocedure), 'purge is definer';
  assert (select proconfig from pg_proc where oid = 'public.alhc_purge_old_logs()'::regprocedure) = array['search_path=""'],
    'purge has an empty search_path';
  assert not has_function_privilege('anon', 'public.alhc_purge_old_logs()', 'execute')
    and not has_function_privilege('authenticated', 'public.alhc_purge_old_logs()', 'execute')
    and not exists (
      select 1 from pg_proc p, aclexplode(p.proacl) a
      where p.oid = 'public.alhc_purge_old_logs()'::regprocedure and a.grantee = 0
    ), 'no client role (or PUBLIC) can execute the purge';
  assert exists (
    select 1 from cron.job
    where jobname = 'alhc-log-purge' and command = 'select public.alhc_purge_old_logs()' and schedule = '17 3 * * *'
  ), 'the alhc-log-purge cron job runs the purge daily';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'f7f7f7f7-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  perform public.alhc_purge_old_logs();
  raise exception 'clients must not run the purge';
exception when insufficient_privilege then null;
end $$;
reset role;

create temporary table rh_rows (name text primary key, id uuid) on commit preserve rows;

do $$
declare
  old timestamptz := now() - interval '91 days';
  recent timestamptz := now() - interval '89 days';
  p uuid := (select id from rh_ids where name = 'project');
  r uuid;
  ep uuid := (select id from public.inbound_endpoints order by created_at limit 1);
  run_old uuid;
  run_old_kept uuid;
  url text := 'https://hooks.example.com/review-hardening';
  v uuid;
begin
  r := (select id from public.rules order by created_at limit 1);
  assert r is not null, 'an earlier suite left a rule';
  assert ep is not null, 'an earlier suite left an inbound endpoint';

  insert into public.inbound_calls (endpoint_id, project_id, status, http_status, created_at)
  values (ep, (select project_id from public.inbound_endpoints where id = ep), 'rejected', 401, old) returning id into v;
  insert into rh_rows values ('call_old', v);
  insert into public.inbound_calls (endpoint_id, project_id, status, http_status, created_at)
  values (ep, (select project_id from public.inbound_endpoints where id = ep), 'rejected', 401, recent) returning id into v;
  insert into rh_rows values ('call_recent', v);

  insert into public.rule_runs (rule_id, trigger_type, status, created_at) values (r, 'task_created', 'succeeded', old)
  returning id into run_old;
  insert into rh_rows values ('run_old', run_old);
  insert into public.rule_runs (rule_id, trigger_type, status, created_at) values (r, 'task_created', 'succeeded', old)
  returning id into run_old_kept;
  insert into rh_rows values ('run_old_referenced', run_old_kept);
  insert into public.rule_runs (rule_id, trigger_type, status, created_at) values (r, 'task_created', 'succeeded', recent)
  returning id into v;
  insert into rh_rows values ('run_recent', v);

  -- Email outbox: old sent / failed go; old pending, sending (retrying), mocked, and recent sent stay.
  insert into public.email_outbox (to_email, template, status, attempts, created_at, updated_at)
  values ('rh@example.com', 'custom', 'sent', 1, old, old) returning id into v;
  insert into rh_rows values ('email_sent_old', v);
  insert into public.email_outbox (to_email, template, status, attempts, created_at, updated_at)
  values ('rh@example.com', 'custom', 'failed', 5, old, old) returning id into v;
  insert into rh_rows values ('email_failed_old', v);
  insert into public.email_outbox (to_email, template, status, attempts, created_at, updated_at)
  values ('rh@example.com', 'custom', 'pending', 2, old, old) returning id into v;
  insert into rh_rows values ('email_pending_old', v);
  insert into public.email_outbox (to_email, template, status, attempts, created_at, updated_at)
  values ('rh@example.com', 'custom', 'sending', 3, old, old) returning id into v;
  insert into rh_rows values ('email_sending_old', v);
  insert into public.email_outbox (to_email, template, status, attempts, created_at, updated_at)
  values ('rh@example.com', 'custom', 'mocked', 1, old, old) returning id into v;
  insert into rh_rows values ('email_mocked_old', v);
  insert into public.email_outbox (to_email, template, status, attempts, created_at, updated_at)
  values ('rh@example.com', 'custom', 'sent', 1, old, recent) returning id into v;
  insert into rh_rows values ('email_sent_recent', v);

  -- Integration outbox: same rules, plus cancelled stays and a pending row keeps its old rule run.
  insert into public.integration_outbox (channel, project_id, target_url, target_hint, payload, status, attempts, created_at, updated_at)
  values ('webhook', p, url, 'hint', '{}', 'sent', 1, old, old) returning id into v;
  insert into rh_rows values ('int_sent_old', v);
  insert into public.integration_outbox (channel, project_id, rule_run_id, target_url, target_hint, payload, status, attempts, created_at, updated_at)
  values ('webhook', p, run_old, url, 'hint', '{}', 'failed', 5, old, old) returning id into v;
  insert into rh_rows values ('int_failed_old', v);
  insert into public.integration_outbox (channel, project_id, rule_run_id, target_url, target_hint, payload, status, attempts, created_at, updated_at)
  values ('webhook', p, run_old_kept, url, 'hint', '{}', 'pending', 2, old, old) returning id into v;
  insert into rh_rows values ('int_pending_old', v);
  insert into public.integration_outbox (channel, project_id, target_url, target_hint, payload, status, attempts, created_at, updated_at)
  values ('slack', p, url, 'hint', '{}', 'sending', 1, old, old) returning id into v;
  insert into rh_rows values ('int_sending_old', v);
  insert into public.integration_outbox (channel, project_id, target_url, target_hint, payload, status, attempts, created_at, updated_at)
  values ('webhook', p, url, 'hint', '{}', 'cancelled', 0, old, old) returning id into v;
  insert into rh_rows values ('int_cancelled_old', v);
  insert into public.integration_outbox (channel, project_id, target_url, target_hint, payload, status, attempts, created_at, updated_at)
  values ('webhook', p, url, 'hint', '{}', 'failed', 5, old, recent) returning id into v;
  insert into rh_rows values ('int_failed_recent', v);
end $$;

-- created_at / updated_at were set explicitly above; make sure no trigger overwrote them.
do $$
begin
  assert (select updated_at < now() - interval '90 days' from public.email_outbox where id = (select id from rh_rows where name = 'email_sent_old')),
    'fixture timestamps stick';
  assert (select updated_at < now() - interval '90 days' from public.integration_outbox where id = (select id from rh_rows where name = 'int_sent_old')),
    'fixture timestamps stick';
end $$;

do $$
declare
  result jsonb := public.alhc_purge_old_logs();
  gone text[] := array['call_old', 'run_old', 'email_sent_old', 'email_failed_old', 'int_sent_old', 'int_failed_old'];
  kept text[] := array['call_recent', 'run_recent', 'run_old_referenced', 'email_pending_old', 'email_sending_old',
    'email_mocked_old', 'email_sent_recent', 'int_pending_old', 'int_sending_old', 'int_cancelled_old', 'int_failed_recent'];
  item text;
  present boolean;
begin
  assert (result->>'inbound_calls')::int >= 1 and (result->>'rule_runs')::int >= 1
    and (result->>'email_outbox')::int >= 2 and (result->>'integration_outbox')::int >= 2,
    format('purge reports what it deleted: %s', result);
  foreach item in array gone || kept loop
    select exists (select 1 from public.inbound_calls where id = r.id)
        or exists (select 1 from public.rule_runs where id = r.id)
        or exists (select 1 from public.email_outbox where id = r.id)
        or exists (select 1 from public.integration_outbox where id = r.id)
      into present
    from rh_rows r where r.name = item;
    if item = any (gone) then
      assert not present, format('%s should be purged', item);
    else
      assert present, format('%s must be kept', item);
    end if;
  end loop;
  -- Nothing still pending or sending was touched anywhere.
  assert not exists (
    select 1 from rh_rows r where r.name in ('email_pending_old', 'email_sending_old')
      and not exists (select 1 from public.email_outbox where id = r.id)
  ), 'pending / retrying emails are never purged';
end $$;

-- Running it again deletes nothing more of ours.
do $$
declare
  result jsonb := public.alhc_purge_old_logs();
begin
  assert (select count(*) from rh_rows r where exists (select 1 from public.integration_outbox where id = r.id)) = 4,
    'second run keeps the kept integration rows';
  assert result is not null;
end $$;

select 'review hardening smoke: all assertions passed' as result;
