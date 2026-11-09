-- AI builder round 5 (20261109120000_ai_assistant_round5_a.sql), experimental branch feat/ai-builder-p5:
-- personal access tokens for the MCP endpoint, the service-role lookup, and MCP runs. Runs after zz58 and
-- uses zz57's pilot and people:
--   a3100157…01 aib2-admin@example.com  (a workspace admin of the pilot)
--   a3100157…03 aib2-out@example.com    (main workspace only)

\set ON_ERROR_STOP 1

create temporary table pat_ids (name text primary key, id uuid) on commit preserve rows;
grant all on pat_ids to authenticated, anon, service_role;
insert into pat_ids select 'ws', workspace_id from public.ai_pilot_workspaces where cleaned_at is null limit 1;

-- zz58's runs count toward the per-person hourly limit; move them back a day (harness only, triggers off).
set session_replication_role = replica;
update public.ai_assistant_runs set created_at = created_at - interval '2 days';
set session_replication_role = origin;

-- Grants: the hash is never readable by clients; the lookup is service role only; nothing for anon.
do $$
begin
  assert (select count(*) from pat_ids where name = 'ws' and id is not null) = 1, 'zz57 left its pilot';
  assert (select relrowsecurity from pg_class where oid = 'public.personal_access_tokens'::regclass), 'RLS on';
  assert not has_table_privilege('anon', 'public.personal_access_tokens', 'select'), 'anon: nothing';
  assert not has_table_privilege('anon', 'public.personal_access_tokens', 'insert'), 'anon: no inserts';
  assert not has_column_privilege('authenticated', 'public.personal_access_tokens', 'token_hash', 'select'), 'the hash is never read back';
  assert not has_column_privilege('authenticated', 'public.personal_access_tokens', 'use_window_count', 'update'), 'no rate-limit edits';
  assert not has_column_privilege('authenticated', 'public.personal_access_tokens', 'scopes', 'update'), 'scopes never change';
  assert has_column_privilege('authenticated', 'public.personal_access_tokens', 'revoked_at', 'update'), 'revoking';
  assert not has_table_privilege('authenticated', 'public.personal_access_tokens', 'truncate'), 'no truncate';
  assert not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'personal_access_tokens' and column_name in ('token', 'plaintext', 'secret')), 'no plaintext column';
  assert (select prosecdef from pg_proc where oid = 'public.mcp_token_verify(text)'::regprocedure), 'the lookup is a definer';
  assert not has_function_privilege('authenticated', 'public.mcp_token_verify(text)', 'execute'), 'never a client';
  assert not has_function_privilege('anon', 'public.mcp_token_verify(text)', 'execute'), 'never anon';
  assert has_function_privilege('service_role', 'public.mcp_token_verify(text)', 'execute'), 'the route''s lookup';
  assert not (select prosecdef from pg_proc where oid = 'public.guard_personal_access_token()'::regprocedure), 'the guard is invoker';
end $$;

-- A pilot admin makes a token: the guard sets the owner and the timestamps; at most 90 days.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100157-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  ws uuid := (select id from pat_ids where name = 'ws');
  r record;
begin
  insert into public.personal_access_tokens (workspace_id, name, token_prefix, token_hash, scopes, expires_at)
  values (ws, ' Claude Desktop ', 'alhc_pat_abcd', repeat('a', 64), array['read', 'write'], now() + interval '30 days')
  returning id, profile_id, name, revoked_at into r;
  assert r.profile_id = 'a3100157-0000-4000-8000-000000000001' and r.name = 'Claude Desktop' and r.revoked_at is null, 'normalized insert';
  insert into pat_ids values ('t1', r.id);
  insert into public.personal_access_tokens (workspace_id, name, token_prefix, token_hash, scopes, expires_at)
  values (ws, 'Read only', 'alhc_pat_efgh', repeat('b', 64), array['read'], now() + interval '1 day') returning id into r;
  insert into pat_ids values ('t2', r.id);
  begin
    insert into public.personal_access_tokens (workspace_id, name, token_prefix, token_hash, scopes, expires_at)
    values (ws, 'Forever', 'alhc_pat_ijkl', repeat('c', 64), array['read'], now() + interval '1 year');
    raise exception 'a year-long token was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.personal_access_tokens (workspace_id, name, token_prefix, token_hash, scopes, expires_at)
    values (ws, 'Write only', 'alhc_pat_mnop', repeat('d', 64), array['write'], now() + interval '1 day');
    raise exception 'a token without read';
  exception when check_violation then null;
  end;
  begin
    insert into public.personal_access_tokens (workspace_id, name, token_prefix, token_hash, scopes, expires_at)
    values ('00000000-0000-4000-8000-000000000001', 'Main', 'alhc_pat_qrst', repeat('e', 64), array['read'], now() + interval '1 day');
    raise exception 'a token for the main workspace';
  exception when insufficient_privilege then null;
  end;
  -- Only revoking: never renaming, re-scoping, or bringing one back.
  begin
    update public.personal_access_tokens set name = 'Renamed' where id = (select id from pat_ids where name = 't1');
    raise exception 'a rename was accepted';
  exception when insufficient_privilege then null;
  end;
  update public.personal_access_tokens set revoked_at = now() where id = (select id from pat_ids where name = 't2');
  begin
    update public.personal_access_tokens set revoked_at = null where id = (select id from pat_ids where name = 't2');
    raise exception 'a revoked token came back';
  exception when check_violation then null;
  end;
end $$;

-- An outsider can't make one, and sees nobody else's.
do $$
begin
  perform set_config('request.jwt.claim.sub', 'a3100157-0000-4000-8000-000000000003', true);
  assert (select count(*) from public.personal_access_tokens) = 0, 'own rows only';
  begin
    insert into public.personal_access_tokens (workspace_id, name, token_prefix, token_hash, scopes, expires_at)
    values ((select id from pat_ids where name = 'ws'), 'Mine', 'alhc_pat_uvwx', repeat('f', 64), array['read'], now() + interval '1 day');
    raise exception 'a non-pilot person made a token';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.mcp_token_verify(repeat('a', 64));
    raise exception 'a client called the lookup';
  exception when insufficient_privilege then null;
  end;
end $$;

-- MCP runs name a live write token of the person's own; app runs name none.
do $$
declare
  ws uuid := (select id from pat_ids where name = 'ws');
begin
  perform set_config('request.jwt.claim.sub', 'a3100157-0000-4000-8000-000000000001', true);
  insert into public.ai_assistant_runs (workspace_id, request_key, page_kind, source, token_id)
  values (ws, 'pat-run-000001', 'other', 'mcp', (select id from pat_ids where name = 't1'));
  begin
    insert into public.ai_assistant_runs (workspace_id, request_key, page_kind, source, token_id)
    values (ws, 'pat-run-000002', 'other', 'mcp', (select id from pat_ids where name = 't2'));
    raise exception 'a revoked (read-only) token made a run';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.ai_assistant_runs (workspace_id, request_key, page_kind, source, token_id)
    values (ws, 'pat-run-000003', 'other', 'app', (select id from pat_ids where name = 't1'));
    raise exception 'an app run named a token';
  exception when check_violation then null;
  end;
  begin
    update public.ai_assistant_runs set source = 'app', token_id = null where request_key = 'pat-run-000001';
    raise exception 'a run changed its identity';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset

-- The service-role lookup: ok (and counts), revoked, unknown, expired, rate limited, an owner no longer an admin.
set role service_role;
do $$
declare
  j jsonb;
  t1 uuid := (select id from pat_ids where name = 't1');
begin
  j := public.mcp_token_verify(repeat('a', 64));
  assert j->>'status' = 'ok' and (j->>'profile_id')::uuid = 'a3100157-0000-4000-8000-000000000001' and j->'scopes' ? 'write', format('ok: %s', j);
  assert (j - 'status' - 'token_id' - 'profile_id' - 'workspace_id' - 'scopes') = '{}'::jsonb, 'nothing else is answered';
  assert public.mcp_token_verify(repeat('b', 64))->>'status' = 'revoked', 'revoked';
  assert public.mcp_token_verify(repeat('9', 64))->>'status' = 'unknown', 'unknown';
  assert public.mcp_token_verify('not-a-hash')->>'status' = 'unknown', 'malformed';
  assert (select last_used_at is not null from public.personal_access_tokens where id = t1), 'last used';
  update public.personal_access_tokens set use_window_count = 120, use_window_started_at = now() where id = t1;
  assert public.mcp_token_verify(repeat('a', 64))->>'status' = 'rate_limited', '120 a minute';
  update public.personal_access_tokens set use_window_count = 0, expires_at = now() - interval '1 second' where id = t1;
  assert public.mcp_token_verify(repeat('a', 64))->>'status' = 'expired', 'expired';
end $$;
reset role;

do $$
begin
  raise notice 'zz59 ai assistant round 5: ok';
end $$;
