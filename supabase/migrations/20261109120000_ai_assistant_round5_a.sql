-- AI builder round 5, "AI can do anything (in your role)" + MCP server (notes 177–179; EXPERIMENTAL,
-- branch feat/ai-builder-p5 → feat/ai-builder; draft PR "[Asana Recreation PM] Nov 9 feat: AI can do
-- anything + MCP server (do not merge to main)"). NOT applied anywhere. Additive: nothing is removed
-- or retyped (no TAIL). Apply after 20261108152314_ai_assistant_round3_a.sql (round 4 added no
-- migration).
--
-- What this adds to the Testing data pilot:
--   * personal_access_tokens: a person's tokens for the MCP endpoint (/api/mcp). The app makes the token
--     (alhc_pat_ + 43 base64url characters), shows it once, and stores only its keyed hash
--     (HMAC-SHA256 with a server-side pepper the database never sees), a short prefix to recognise it,
--     its owner, the pilot workspace it reaches, its scopes (read, or read + write), when it was made /
--     last used / expires (at most 90 days), and when it was revoked. Own rows only; the hash column is
--     never readable by clients; a token can only be revoked, never edited or brought back. Only workspace
--     admins of the live pilot make tokens (at most 10 live ones each).
--   * mcp_token_verify(token_hash) (SECURITY DEFINER, service_role only — never a client): the MCP route's
--     one lookup. Answers the owner's profile id, workspace, scopes, and token id when the token is live,
--     unexpired, its owner is still allowlisted and still a workspace admin of the live pilot, and it is
--     within 120 calls a minute (else a status: unknown / revoked / expired / not_allowed /
--     rate_limited). It records last_used_at. It returns nothing else: the route then acts as that person
--     through RLS (a short-lived token for them; the service role is never used for the work itself).
--   * ai_assistant_runs.source ('app' | 'mcp') and token_id: writes made from an MCP client are logged as
--     runs (with Undo in the app's run history) and say which token made them.
--
-- No new client SECURITY DEFINER function (suite 60 unchanged); nothing for anon.

create table public.personal_access_tokens (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null default auth.uid() references public.profiles (id),
  workspace_id uuid not null references public.workspaces (id),
  name text not null check (char_length(btrim(name)) between 1 and 100),
  token_prefix text not null check (token_prefix ~ '^alhc_pat_[A-Za-z0-9_-]{4,8}$'),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] not null check (
    cardinality(scopes) between 1 and 2 and scopes <@ array['read', 'write']::text[] and 'read' = any (scopes)
  ),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  use_window_started_at timestamptz,
  use_window_count integer not null default 0 check (use_window_count >= 0),
  updated_at timestamptz not null default now()
);

create index personal_access_tokens_profile_idx on public.personal_access_tokens (profile_id, created_at desc);
create index personal_access_tokens_workspace_idx on public.personal_access_tokens (workspace_id);

alter table public.personal_access_tokens enable row level security;
select public.alhc_revoke_anon_grants(array['personal_access_tokens']);
select public.alhc_revoke_client_truncate(array['personal_access_tokens']);
revoke insert, update, select on public.personal_access_tokens from authenticated;
-- Never the hash, never the rate-limit window.
grant select (id, profile_id, workspace_id, name, token_prefix, scopes, created_at, last_used_at, expires_at, revoked_at)
  on public.personal_access_tokens to authenticated;
grant insert (workspace_id, name, token_prefix, token_hash, scopes, expires_at) on public.personal_access_tokens to authenticated;
grant update (revoked_at) on public.personal_access_tokens to authenticated;

create policy personal_access_tokens_select_own on public.personal_access_tokens
  for select to authenticated using (profile_id = (select auth.uid()));
create policy personal_access_tokens_insert_own on public.personal_access_tokens
  for insert to authenticated
  with check (profile_id = (select auth.uid()) and (select public.ai_pilot_admin(workspace_id)));
create policy personal_access_tokens_update_own on public.personal_access_tokens
  for update to authenticated
  using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));

create or replace function public.guard_personal_access_token()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if public.is_client_role() then
      new.profile_id := auth.uid();
      new.created_at := now();
      new.last_used_at := null;
      new.revoked_at := null;
      new.use_window_started_at := null;
      new.use_window_count := 0;
    end if;
    new.updated_at := now();
    new.name := btrim(new.name);
    if new.expires_at <= now() or new.expires_at > now() + interval '90 days 1 minute' then
      raise exception 'A token expires within 90 days' using errcode = 'check_violation';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('alhc.pat:' || new.profile_id::text, 0));
    if (select count(*) from public.personal_access_tokens t
        where t.profile_id = new.profile_id and t.revoked_at is null and t.expires_at > now()) >= 10 then
      raise exception 'You have 10 live tokens; revoke one first' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if public.is_client_role() then
    if new.id <> old.id or new.profile_id <> old.profile_id or new.workspace_id <> old.workspace_id
       or new.name <> old.name or new.token_prefix <> old.token_prefix or new.token_hash <> old.token_hash
       or new.scopes <> old.scopes or new.created_at <> old.created_at or new.expires_at <> old.expires_at
       or new.last_used_at is distinct from old.last_used_at
       or new.use_window_started_at is distinct from old.use_window_started_at
       or new.use_window_count <> old.use_window_count then
      raise exception 'A token can only be revoked' using errcode = 'insufficient_privilege';
    end if;
    if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
      raise exception 'A revoked token stays revoked' using errcode = 'check_violation';
    end if;
    if new.revoked_at is not null and old.revoked_at is null then
      new.revoked_at := now();
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

select public.alhc_revoke_anon_execute(array['guard_personal_access_token()']);
revoke all on function public.guard_personal_access_token() from public, anon;
grant execute on function public.guard_personal_access_token() to authenticated, service_role;

create trigger personal_access_tokens_05_guard
  before insert or update on public.personal_access_tokens
  for each row execute function public.guard_personal_access_token();

-- The MCP route's lookup (service role only). A hash in; whether the token may be used, and whose it is.
create or replace function public.mcp_token_verify(target_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.personal_access_tokens;
begin
  if target_hash is null or target_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'unknown');
  end if;
  select * into t from public.personal_access_tokens where token_hash = target_hash for update;
  if t.id is null then
    return jsonb_build_object('status', 'unknown');
  end if;
  if t.revoked_at is not null then
    return jsonb_build_object('status', 'revoked');
  end if;
  if t.expires_at <= now() then
    return jsonb_build_object('status', 'expired');
  end if;
  if not public.profile_is_allowlisted(t.profile_id)
     or t.workspace_id is not distinct from public.ai_main_workspace_id()
     or not public.profile_is_workspace_admin(t.profile_id, t.workspace_id)
     or not exists (
       select 1 from public.ai_pilot_workspaces r
       join public.workspaces w on w.id = r.workspace_id and w.deleted_at is null
       where r.workspace_id = t.workspace_id and r.cleaned_at is null) then
    return jsonb_build_object('status', 'not_allowed');
  end if;
  if t.use_window_started_at is null or t.use_window_started_at < now() - interval '1 minute' then
    update public.personal_access_tokens
       set use_window_started_at = now(), use_window_count = 1, last_used_at = now(), updated_at = now()
     where id = t.id;
  elsif t.use_window_count >= 120 then
    return jsonb_build_object('status', 'rate_limited');
  else
    update public.personal_access_tokens
       set use_window_count = use_window_count + 1, last_used_at = now(), updated_at = now()
     where id = t.id;
  end if;
  return jsonb_build_object(
    'status', 'ok',
    'token_id', t.id,
    'profile_id', t.profile_id,
    'workspace_id', t.workspace_id,
    'scopes', to_jsonb(t.scopes));
end;
$$;

comment on function public.mcp_token_verify(text) is
  'AI builder round 5 (note 178): the MCP endpoint''s token lookup (service role only). Never a client.';

select public.alhc_revoke_anon_execute(array['mcp_token_verify(text)']);
revoke all on function public.mcp_token_verify(text) from public, anon, authenticated;
grant execute on function public.mcp_token_verify(text) to service_role;

-- Runs made from an MCP client.
alter table public.ai_assistant_runs
  add column source text not null default 'app' check (source in ('app', 'mcp')),
  add column token_id uuid references public.personal_access_tokens (id);

create index ai_assistant_runs_token_idx on public.ai_assistant_runs (token_id);

grant insert (source, token_id) on public.ai_assistant_runs to authenticated;

create or replace function public.guard_ai_assistant_run_source()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.source <> old.source or new.token_id is distinct from old.token_id then
      raise exception 'A run''s identity can''t change' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  if new.source = 'mcp' then
    if new.token_id is null or not exists (
      select 1 from public.personal_access_tokens t
      where t.id = new.token_id and t.profile_id = auth.uid() and t.revoked_at is null and t.expires_at > now()
        and 'write' = any (t.scopes) and t.workspace_id = new.workspace_id) then
      raise exception 'That token can''t make changes' using errcode = 'insufficient_privilege';
    end if;
  elsif new.token_id is not null then
    raise exception 'Only MCP runs name a token' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

select public.alhc_revoke_anon_execute(array['guard_ai_assistant_run_source()']);
revoke all on function public.guard_ai_assistant_run_source() from public, anon;
grant execute on function public.guard_ai_assistant_run_source() to authenticated, service_role;

create trigger ai_assistant_runs_06_source
  before insert or update on public.ai_assistant_runs
  for each row execute function public.guard_ai_assistant_run_source();
