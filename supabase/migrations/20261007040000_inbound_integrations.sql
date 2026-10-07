-- ALHC Projects — Phase: Inbound integrations.
-- Inbound webhook endpoints: an Admin+ creates an endpoint per project (name, target section, default
-- assignee, default tags). Anything that can POST JSON (Zapier, a website form, a script) sends
-- { title, notes?, due_on?, assignee_email?, tags?, fields? } to /api/inbound/<token>, and a task is
-- created in that project as the endpoint's creator. Free only: no paid services, no Slack app or OAuth.
--
-- Security shape (pinned by supabase/tests/zz06_inbound_integrations_smoke.sql):
--   * Tokens are random (generated here, 244 random bits), shown once, and stored only as a SHA-256 hash.
--     An optional signing secret reuses the Integration depth scheme: X-ALHC-Timestamp + X-ALHC-Signature
--     = sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>; timestamps more than 300 seconds off
--     and replayed signatures are rejected. Neither the hash nor the secret is ever readable by clients
--     (column grants), and nothing returns them after the one-time reveal.
--   * receive_inbound_webhook is the one new client-callable SECURITY DEFINER function, mirroring
--     submit_form: executable by anon and authenticated, it checks the hashed token, the signature, size
--     limits, a per-endpoint rate limit, and an Idempotency-Key, then writes the task as the endpoint's
--     creator (who must still be an allowlisted Editor+ of the project, which an archived project caps
--     at Viewer). It never uses the service role. Every authentication failure — unknown, disabled,
--     deleted, or rotated token, bad or stale signature, replay, a creator without access — returns the
--     same generic 401, so no response confirms that a token exists.
--   * Managing endpoints is SECURITY INVOKER over RLS (Admin+ of the project via has_project_role):
--     create_inbound_endpoint, rotate_inbound_token, set_inbound_signing_secret, and plain updates for
--     name / section / assignee / tags / enabled / delete. The invoker guard trigger generates tokens and
--     secrets itself and hands them back once through transaction-local settings. Workspace admins get
--     nothing: no policy here consults is_workspace_admin().
--   * inbound_calls logs every authenticated call (status, HTTP status, created task, error, warnings) —
--     never the body, token, signature, or secret. Admin+ read it; nobody writes it but the receiver.
--   * Rules: a new trigger inbound_received { endpoint_id? } and source_is "inbound". fire_rules gains
--     one trigger-matching line; its import and copy checks are untouched, as are notify_with,
--     notify_message, and add_story. Imported and copied tasks still never fire rules.
--   * Additive: the previous release keeps working once this is applied (new tables, a new task source,
--     a new story kind, and a new rule trigger nobody uses until this release's UI offers it).
--
-- Existing functions are changed with asserted text patches (alhc_patch_function below): each edit must
-- match the live definition exactly once, and every other line stays. Grants are kept.

-- ---------------------------------------------------------------------------
-- Patch helper (dropped at the end of this migration)
-- ---------------------------------------------------------------------------

create or replace function public.alhc_patch_function(target regprocedure, variadic edits text[])
returns void
language plpgsql
set search_path = ''
as $$
declare
  def text := pg_get_functiondef(target);
  hits integer;
begin
  if coalesce(array_length(edits, 1), 0) = 0 or array_length(edits, 1) % 2 <> 0 then
    raise exception 'alhc_patch_function(%): pass (old, new) text pairs', target;
  end if;
  for i in 1 .. array_length(edits, 1) / 2 loop
    if coalesce(edits[2 * i - 1], '') = '' then
      raise exception 'alhc_patch_function(%): edit % has no text to replace', target, i;
    end if;
    hits := (length(def) - length(replace(def, edits[2 * i - 1], ''))) / length(edits[2 * i - 1]);
    if hits <> 1 then
      raise exception 'alhc_patch_function(%): edit % matched % times (expected exactly once)', target, i, hits;
    end if;
    def := replace(def, edits[2 * i - 1], edits[2 * i]);
  end loop;
  execute def;
end;
$$;

revoke all on function public.alhc_patch_function(regprocedure, text[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Vocabulary: task source, story kind, rule trigger
-- ---------------------------------------------------------------------------

alter table public.tasks drop constraint tasks_source_check;
alter table public.tasks add constraint tasks_source_check
  check (source in ('manual', 'form', 'import', 'inbound'));

alter table public.task_stories drop constraint task_stories_kind_check;
alter table public.task_stories add constraint task_stories_kind_check check (kind in (
  'created', 'completed', 'reopened', 'renamed', 'assigned', 'unassigned', 'due_changed', 'start_changed',
  'section_changed', 'project_added', 'project_removed', 'attachment_added', 'field_changed',
  'deleted', 'approval_requested', 'approval_decided', 'approval_cancelled', 'approval_resubmitted',
  'form_submitted', 'request_number_assigned', 'email_queued',
  'recurrence_changed', 'recurrence_spawned', 'dependency_added', 'dependency_removed', 'restored',
  'integration_queued', 'integration_failed', 'kind_changed',
  'dependency_changed', 'tag_added', 'tag_removed', 'converted_to_subtask', 'converted_to_task',
  'inbound_received'
));

alter table public.rules drop constraint rules_trigger_type_check;
alter table public.rules add constraint rules_trigger_type_check check (trigger_type in (
  'task_created', 'section_changed', 'field_changed', 'assignee_changed', 'due_approaching',
  'approval_decided', 'form_submitted', 'inbound_received'
));

-- ---------------------------------------------------------------------------
-- Crypto helpers (core SHA-256 only, no extension needed)
-- ---------------------------------------------------------------------------

-- HMAC-SHA256 (RFC 2104) over core sha256(). Internal.
create or replace function public.inbound_hmac_sha256(secret bytea, message bytea)
returns bytea
language plpgsql
immutable
set search_path = ''
as $$
declare
  k bytea := secret;
  inner_key bytea;
  outer_key bytea;
begin
  if length(k) > 64 then
    k := sha256(k);
  end if;
  k := k || decode(repeat('00', 64 - length(k)), 'hex');
  inner_key := k;
  outer_key := k;
  for i in 0 .. 63 loop
    inner_key := set_byte(inner_key, i, get_byte(k, i) # 54);
    outer_key := set_byte(outer_key, i, get_byte(k, i) # 92);
  end loop;
  return sha256(outer_key || sha256(inner_key || message));
end;
$$;

revoke all on function public.inbound_hmac_sha256(bytea, bytea) from public, anon, authenticated;

-- 64 hex characters from two random UUIDs (gen_random_uuid uses the strong random source; 244 random
-- bits). Callable by the invoker guard below, so granted to authenticated; it reveals nothing.
create or replace function public.inbound_random_hex()
returns text
language sql
volatile
set search_path = ''
as $$
  select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
$$;

revoke all on function public.inbound_random_hex() from public, anon;
grant execute on function public.inbound_random_hex() to authenticated;

create or replace function public.inbound_token_hash(token text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(coalesce(token, ''), 'UTF8')), 'hex');
$$;

revoke all on function public.inbound_token_hash(text) from public, anon;
grant execute on function public.inbound_token_hash(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Endpoints
-- ---------------------------------------------------------------------------

create table public.inbound_endpoints (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  name text not null check (length(trim(name)) between 1 and 100),
  section_id uuid references public.sections (id),
  assignee_id uuid references public.profiles (id),
  tag_ids uuid[] not null default '{}' check (cardinality(tag_ids) <= 20),
  enabled boolean not null default true,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  token_hint text not null,
  token_rotated_at timestamptz not null default now(),
  signing_secret text check (signing_secret is null or length(signing_secret) between 16 and 500),
  signing_secret_set_at timestamptz,
  created_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index inbound_endpoints_project_idx on public.inbound_endpoints (project_id) where deleted_at is null;

comment on table public.inbound_endpoints is
  'Inbound webhook endpoints (Phase: Inbound integrations). A POST to /api/inbound/<token> creates a task '
  'in project_id as created_by. token_hash = sha256 of the token (shown once); signing_secret signs requests '
  '(X-ALHC-Signature). Neither column is readable by clients. Admin+ of the project manage endpoints.';

create trigger inbound_endpoints_set_updated_at
  before update on public.inbound_endpoints
  for each row execute function public.set_updated_at();

-- Invoker guard: generates the token (and the signing secret when one is asked for) and hands the plain
-- values back once through transaction-local settings (alhc.inbound_token / alhc.inbound_signing_secret)
-- that the invoker RPCs below return. A client never chooses a token or secret: the hash and secret
-- columns aren't grantable, and this trigger overwrites them. Writing token_rotated_at rotates the
-- token; writing signing_secret_set_at (null = remove) replaces or removes the signing secret.
create or replace function public.guard_inbound_endpoint()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  token text;
  ws uuid;
begin
  if tg_op = 'INSERT' then
    if public.is_client_role() then
      new.created_by := auth.uid();
      new.created_at := now();
    end if;
    new.deleted_at := null;
  else
    if old.deleted_at is not null then
      raise exception 'This endpoint was deleted' using errcode = 'check_violation';
    end if;
    if new.id <> old.id or new.project_id <> old.project_id or new.created_by is distinct from old.created_by
       or new.created_at <> old.created_at then
      raise exception 'An endpoint can''t move' using errcode = 'insufficient_privilege';
    end if;
  end if;

  new.name := trim(new.name);
  new.tag_ids := coalesce((select array_agg(distinct x) from unnest(new.tag_ids) x where x is not null), '{}');

  if tg_op = 'INSERT' or new.section_id is distinct from old.section_id then
    if new.section_id is not null and not exists (
      select 1 from public.sections s
      where s.id = new.section_id and s.project_id = new.project_id and s.deleted_at is null
    ) then
      raise exception 'Choose a section of this project' using errcode = 'check_violation';
    end if;
  end if;
  if tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id then
    if new.assignee_id is not null and not exists (
      select 1 from public.project_members m
      where m.project_id = new.project_id and m.profile_id = new.assignee_id and m.deleted_at is null
    ) then
      raise exception 'The default assignee must be a member of this project' using errcode = 'check_violation';
    end if;
  end if;
  if tg_op = 'INSERT' or new.tag_ids is distinct from old.tag_ids then
    select p.workspace_id into ws from public.projects p where p.id = new.project_id;
    if (
      select count(*) from public.tags t
      where t.id = any (new.tag_ids) and t.workspace_id = ws and t.deleted_at is null
        and (t.archived_at is null or (tg_op = 'UPDATE' and t.id = any (old.tag_ids)))
    ) <> cardinality(new.tag_ids) then
      raise exception 'Choose active tags of this workspace' using errcode = 'check_violation';
    end if;
  end if;

  if tg_op = 'INSERT' or new.token_rotated_at is distinct from old.token_rotated_at then
    token := 'alhc_in_' || public.inbound_random_hex();
    new.token_hash := public.inbound_token_hash(token);
    new.token_hint := '…' || right(token, 4);
    new.token_rotated_at := clock_timestamp();
    perform set_config('alhc.inbound_token', token, true);
  else
    new.token_hash := old.token_hash;
    new.token_hint := old.token_hint;
  end if;

  if (tg_op = 'INSERT' and new.signing_secret_set_at is not null)
     or (tg_op = 'UPDATE' and new.signing_secret_set_at is distinct from old.signing_secret_set_at and new.signing_secret_set_at is not null) then
    new.signing_secret := 'whsec_' || public.inbound_random_hex();
    new.signing_secret_set_at := clock_timestamp();
    perform set_config('alhc.inbound_signing_secret', new.signing_secret, true);
  elsif new.signing_secret_set_at is null then
    new.signing_secret := null;
  else
    new.signing_secret := old.signing_secret;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_inbound_endpoint() from public, anon;
grant execute on function public.guard_inbound_endpoint() to authenticated;

create trigger inbound_endpoints_05_guard
  before insert or update on public.inbound_endpoints
  for each row execute function public.guard_inbound_endpoint();

alter table public.inbound_endpoints enable row level security;

create policy inbound_endpoints_select_admin on public.inbound_endpoints
  for select to authenticated
  using ((select public.has_project_role(project_id, 'admin')));

create policy inbound_endpoints_insert_admin on public.inbound_endpoints
  for insert to authenticated
  with check ((select public.has_project_role(project_id, 'admin')) and created_by = auth.uid());

create policy inbound_endpoints_update_admin on public.inbound_endpoints
  for update to authenticated
  using ((select public.has_project_role(project_id, 'admin')))
  with check ((select public.has_project_role(project_id, 'admin')));

revoke all on public.inbound_endpoints from anon, authenticated;
grant select (
  id, project_id, name, section_id, assignee_id, tag_ids, enabled, token_hint, token_rotated_at,
  signing_secret_set_at, created_by, created_at, updated_at, deleted_at
) on public.inbound_endpoints to authenticated;
grant insert (project_id, name, section_id, assignee_id, tag_ids, enabled, signing_secret_set_at)
  on public.inbound_endpoints to authenticated;
grant update (name, section_id, assignee_id, tag_ids, enabled, token_rotated_at, signing_secret_set_at, deleted_at)
  on public.inbound_endpoints to authenticated;

-- ---------------------------------------------------------------------------
-- Call log
-- ---------------------------------------------------------------------------

create table public.inbound_calls (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references public.inbound_endpoints (id),
  project_id uuid not null references public.projects (id),
  status text not null check (status in ('created', 'duplicate', 'rejected', 'invalid', 'rate_limited', 'failed')),
  http_status integer not null check (http_status between 100 and 599),
  task_id uuid references public.tasks (id),
  error text check (error is null or length(error) <= 500),
  warnings jsonb not null default '[]'::jsonb check (jsonb_typeof(warnings) = 'array'),
  idempotency_key text check (idempotency_key is null or length(idempotency_key) between 1 and 200),
  replay_digest text,
  created_at timestamptz not null default now()
);

create index inbound_calls_endpoint_idx on public.inbound_calls (endpoint_id, created_at desc);
create index inbound_calls_project_idx on public.inbound_calls (project_id, created_at desc);
create index inbound_calls_idempotency_idx on public.inbound_calls (endpoint_id, idempotency_key)
  where idempotency_key is not null and status = 'created';
create index inbound_calls_replay_idx on public.inbound_calls (endpoint_id, replay_digest)
  where replay_digest is not null;

comment on table public.inbound_calls is
  'Log of authenticated calls to inbound endpoints: status, HTTP status, created task, error, warnings. '
  'Never the body, token, signature, or secret. Written only by receive_inbound_webhook; Admin+ read.';

alter table public.inbound_calls enable row level security;

create policy inbound_calls_select_admin on public.inbound_calls
  for select to authenticated
  using ((select public.has_project_role(project_id, 'admin')));

revoke all on public.inbound_calls from anon, authenticated;
grant select (id, endpoint_id, project_id, status, http_status, task_id, error, warnings, idempotency_key, created_at)
  on public.inbound_calls to authenticated;

-- ---------------------------------------------------------------------------
-- Managing endpoints (invoker; Admin+ through RLS)
-- ---------------------------------------------------------------------------

-- Creates an endpoint and returns its token (and signing secret) — the only time they are shown.
create or replace function public.create_inbound_endpoint(
  target_project uuid,
  endpoint_name text,
  target_section uuid default null,
  default_assignee uuid default null,
  default_tags uuid[] default '{}',
  with_signing_secret boolean default false
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  new_id uuid;
  token text;
  secret text;
begin
  if not public.has_project_role(target_project, 'admin') then
    raise exception 'Only project admins can manage inbound webhooks' using errcode = 'insufficient_privilege';
  end if;
  perform set_config('alhc.inbound_token', '', true);
  perform set_config('alhc.inbound_signing_secret', '', true);
  insert into public.inbound_endpoints (project_id, name, section_id, assignee_id, tag_ids, signing_secret_set_at)
  values (
    target_project, endpoint_name, target_section, default_assignee, coalesce(default_tags, '{}'),
    case when coalesce(with_signing_secret, false) then now() end
  )
  returning id into new_id;
  token := nullif(current_setting('alhc.inbound_token', true), '');
  secret := nullif(current_setting('alhc.inbound_signing_secret', true), '');
  perform set_config('alhc.inbound_token', '', true);
  perform set_config('alhc.inbound_signing_secret', '', true);
  return jsonb_build_object('id', new_id, 'token', token, 'signing_secret', secret);
end;
$$;

revoke all on function public.create_inbound_endpoint(uuid, text, uuid, uuid, uuid[], boolean) from public, anon;
grant execute on function public.create_inbound_endpoint(uuid, text, uuid, uuid, uuid[], boolean) to authenticated;

-- Replaces the token; the old one stops working at once. Returns the new token once.
create or replace function public.rotate_inbound_token(target_endpoint uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  token text;
  hits integer;
begin
  perform set_config('alhc.inbound_token', '', true);
  update public.inbound_endpoints e set token_rotated_at = clock_timestamp()
  where e.id = target_endpoint and e.deleted_at is null;
  get diagnostics hits = row_count;
  if hits = 0 then
    raise exception 'Endpoint not found' using errcode = 'no_data_found';
  end if;
  token := nullif(current_setting('alhc.inbound_token', true), '');
  perform set_config('alhc.inbound_token', '', true);
  return jsonb_build_object('id', target_endpoint, 'token', token);
end;
$$;

revoke all on function public.rotate_inbound_token(uuid) from public, anon;
grant execute on function public.rotate_inbound_token(uuid) to authenticated;

-- enable = true: a new signing secret (returned once; the previous one stops working); false: removes it.
create or replace function public.set_inbound_signing_secret(target_endpoint uuid, enable boolean)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  secret text;
  hits integer;
begin
  perform set_config('alhc.inbound_signing_secret', '', true);
  update public.inbound_endpoints e
  set signing_secret_set_at = case when coalesce(enable, false) then clock_timestamp() end
  where e.id = target_endpoint and e.deleted_at is null;
  get diagnostics hits = row_count;
  if hits = 0 then
    raise exception 'Endpoint not found' using errcode = 'no_data_found';
  end if;
  secret := nullif(current_setting('alhc.inbound_signing_secret', true), '');
  perform set_config('alhc.inbound_signing_secret', '', true);
  return jsonb_build_object('id', target_endpoint, 'signing_secret', secret);
end;
$$;

revoke all on function public.set_inbound_signing_secret(uuid, boolean) from public, anon;
grant execute on function public.set_inbound_signing_secret(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Receiving (the one new anon-callable SECURITY DEFINER function)
-- ---------------------------------------------------------------------------

-- Logs one call (internal).
create or replace function public.log_inbound_call(
  e public.inbound_endpoints,
  call_status text,
  http integer,
  call_error text default null,
  call_task uuid default null,
  call_warnings jsonb default '[]'::jsonb,
  call_key text default null,
  call_digest text default null
)
returns uuid
language sql
set search_path = ''
as $$
  insert into public.inbound_calls (
    endpoint_id, project_id, status, http_status, task_id, error, warnings, idempotency_key, replay_digest
  )
  values (e.id, e.project_id, call_status, http, call_task, left(call_error, 500),
    coalesce(call_warnings, '[]'::jsonb), call_key, call_digest)
  returning id;
$$;

revoke all on function public.log_inbound_call(public.inbound_endpoints, text, integer, text, uuid, jsonb, text, text)
  from public, anon, authenticated;

-- Request body (JSON object, ≤ 64 KB):
--   title           string, required, ≤ 500 characters
--   notes           string, ≤ 20,000 characters
--   due_on          "YYYY-MM-DD"
--   assignee_email  an active member of the project (else the endpoint's default assignee + a warning)
--   tags            [names] of active workspace tags (unknown ones are skipped with a warning), added
--                   to the endpoint's default tags
--   fields          { "<field name>": value } of the project's custom fields, by name (case-insensitive):
--                   text → string, number → number, date → "YYYY-MM-DD", boolean → true / false,
--                   single-select → option name, multi-select → [option names], people → [emails],
--                   a section-bound Status field → a section name. Values that don't fit are skipped
--                   with a warning (the warning never echoes the value).
-- Other keys are ignored (with a warning). Returns { ok, status (HTTP), task_id?, duplicate?, warnings?,
-- error? }. Authentication failures are always { ok: false, status: 401, error: "Unauthorized" }.
create or replace function public.receive_inbound_webhook(
  endpoint_token text,
  raw_body text,
  request_timestamp text default null,
  request_signature text default null,
  idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  unauthorized constant jsonb := jsonb_build_object('ok', false, 'status', 401, 'error', 'Unauthorized');
  per_minute constant integer := 60;
  e public.inbound_endpoints;
  ws uuid;
  recent integer;
  auth_error text;
  problem text;
  ts bigint;
  sig text;
  digest text;
  call_key text := nullif(idempotency_key, '');
  existing uuid;
  body jsonb;
  warnings jsonb := '[]'::jsonb;
  k text;
  task_title text;
  task_notes text;
  task_due date;
  assignee uuid;
  target_section uuid;
  tag_list uuid[];
  tag_name text;
  tag_id uuid;
  field public.custom_fields;
  field_key text;
  field_raw jsonb;
  field_value jsonb;
  prev_sub text;
  new_task uuid;
  call_id uuid;
begin
  if endpoint_token is null or endpoint_token !~ '^alhc_in_[0-9a-f]{64}$' then
    return unauthorized;
  end if;
  select en.* into e from public.inbound_endpoints en
  join public.projects p on p.id = en.project_id and p.deleted_at is null
  where en.token_hash = public.inbound_token_hash(endpoint_token) and en.deleted_at is null and en.enabled;
  if e.id is null then
    return unauthorized;
  end if;

  -- One call at a time per endpoint: the rate limit, idempotency, and replay checks see each other.
  perform pg_advisory_xact_lock(hashtextextended('alhc.inbound:' || e.id::text, 0));
  select count(*) into recent from public.inbound_calls c
  where c.endpoint_id = e.id and c.created_at > clock_timestamp() - interval '1 minute';

  -- Signature (when the endpoint has a signing secret): fresh timestamp, matching HMAC, not a replay.
  if e.signing_secret is not null then
    if coalesce(request_timestamp, '') !~ '^[0-9]{1,12}$' then
      auth_error := 'Missing or malformed X-ALHC-Timestamp';
    else
      ts := request_timestamp::bigint;
      sig := lower(coalesce(request_signature, ''));
      if abs(extract(epoch from clock_timestamp()) - ts) > 300 then
        auth_error := 'Stale X-ALHC-Timestamp (more than 300 seconds from the server clock)';
      elsif sig !~ '^sha256=[0-9a-f]{64}$' then
        auth_error := 'Missing or malformed X-ALHC-Signature';
      elsif sha256(convert_to(sig, 'UTF8')) <> sha256(convert_to('sha256=' || encode(public.inbound_hmac_sha256(
          convert_to(e.signing_secret, 'UTF8'),
          convert_to(request_timestamp || '.' || coalesce(raw_body, ''), 'UTF8')
        ), 'hex'), 'UTF8')) then
        auth_error := 'X-ALHC-Signature doesn''t match the body';
      else
        digest := encode(sha256(convert_to(e.id::text || ':' || request_timestamp || ':' || sig, 'UTF8')), 'hex');
      end if;
    end if;
    if auth_error is not null then
      if recent < per_minute then
        perform public.log_inbound_call(e, 'rejected', 401, auth_error);
      end if;
      return unauthorized;
    end if;
  end if;

  if recent >= per_minute then
    if not exists (
      select 1 from public.inbound_calls c
      where c.endpoint_id = e.id and c.status = 'rate_limited' and c.created_at > clock_timestamp() - interval '1 minute'
    ) then
      perform public.log_inbound_call(e, 'rate_limited', 429, 'More than ' || per_minute || ' calls in a minute');
    end if;
    return jsonb_build_object('ok', false, 'status', 429, 'error', 'Too many requests. Try again in a minute.');
  end if;

  -- The endpoint acts as its creator, who must still be an allowlisted Editor+ of the project (an
  -- archived project caps every membership at Viewer).
  if not public.profile_is_allowlisted(e.created_by)
     or public.project_role_rank(public.profile_project_role(e.created_by, e.project_id)) < 3 then
    perform public.log_inbound_call(e, 'rejected', 401,
      'The endpoint''s creator can no longer add tasks to this project (removed, below Editor, or the project is archived)');
    return unauthorized;
  end if;

  if call_key is not null and call_key !~ '^[!-~]{1,200}$' then
    perform public.log_inbound_call(e, 'invalid', 400, 'Idempotency-Key must be 1–200 printable characters');
    return jsonb_build_object('ok', false, 'status', 400, 'error', 'Idempotency-Key must be 1–200 printable characters');
  end if;
  if call_key is not null then
    select c.task_id into existing from public.inbound_calls c
    where c.endpoint_id = e.id and c.idempotency_key = call_key and c.status = 'created'
    order by c.created_at limit 1;
    if existing is not null then
      perform public.log_inbound_call(e, 'duplicate', 200, null, existing, '[]'::jsonb, null, digest);
      return jsonb_build_object('ok', true, 'status', 200, 'task_id', existing, 'duplicate', true);
    end if;
  end if;
  if digest is not null and exists (
    select 1 from public.inbound_calls c where c.endpoint_id = e.id and c.replay_digest = digest
  ) then
    perform public.log_inbound_call(e, 'rejected', 401, 'Replayed request (same timestamp and signature)');
    return unauthorized;
  end if;

  if octet_length(coalesce(raw_body, '')) > 65536 then
    perform public.log_inbound_call(e, 'invalid', 413, 'Body larger than 64 KB', null, '[]'::jsonb, null, digest);
    return jsonb_build_object('ok', false, 'status', 413, 'error', 'The body is limited to 64 KB');
  end if;
  begin
    body := raw_body::jsonb;
  exception when others then
    body := null;
  end;
  if body is null or jsonb_typeof(body) <> 'object' then
    perform public.log_inbound_call(e, 'invalid', 400, 'The body isn''t a JSON object', null, '[]'::jsonb, null, digest);
    return jsonb_build_object('ok', false, 'status', 400, 'error', 'The body must be a JSON object');
  end if;

  -- Validate: structural problems reject the call; references that don't match are warnings.
  for k in select jsonb_object_keys(body) loop
    if k not in ('title', 'notes', 'due_on', 'assignee_email', 'tags', 'fields') then
      warnings := warnings || to_jsonb('Ignored unknown key “' || left(k, 50) || '”');
    end if;
  end loop;
  problem := case
    when jsonb_typeof(body -> 'title') is distinct from 'string' or trim(body ->> 'title') = '' then 'title is required (a string)'
    when length(trim(body ->> 'title')) > 500 then 'title is limited to 500 characters'
    when body ? 'notes' and jsonb_typeof(body -> 'notes') not in ('string', 'null') then 'notes must be a string'
    when length(body ->> 'notes') > 20000 then 'notes are limited to 20,000 characters'
    when body ? 'due_on' and jsonb_typeof(body -> 'due_on') not in ('string', 'null') then 'due_on must be a date (YYYY-MM-DD)'
    when coalesce(body ->> 'due_on', '') <> '' and body ->> 'due_on' !~ '^\d{4}-\d{2}-\d{2}$' then 'due_on must be a date (YYYY-MM-DD)'
    when body ? 'assignee_email' and jsonb_typeof(body -> 'assignee_email') not in ('string', 'null') then 'assignee_email must be a string'
    when body ? 'tags' and jsonb_typeof(body -> 'tags') not in ('array', 'null') then 'tags must be an array of tag names'
    when jsonb_typeof(body -> 'tags') = 'array' and (jsonb_array_length(body -> 'tags') > 20 or exists (
      select 1 from jsonb_array_elements(case when jsonb_typeof(body -> 'tags') = 'array' then body -> 'tags' else '[]'::jsonb end) x where jsonb_typeof(x) <> 'string' or length(x #>> '{}') > 50
    )) then 'tags must be at most 20 tag names'
    when body ? 'fields' and jsonb_typeof(body -> 'fields') not in ('object', 'null') then 'fields must be an object of field name → value'
    when jsonb_typeof(body -> 'fields') = 'object' and (select count(*) from jsonb_object_keys(case when jsonb_typeof(body -> 'fields') = 'object' then body -> 'fields' else '{}'::jsonb end)) > 50 then 'fields is limited to 50 fields'
  end;
  if problem is null and coalesce(body ->> 'due_on', '') <> '' then
    begin
      task_due := (body ->> 'due_on')::date;
      if to_char(task_due, 'YYYY-MM-DD') <> body ->> 'due_on' then
        problem := 'due_on must be a date (YYYY-MM-DD)';
      end if;
    exception when others then
      problem := 'due_on must be a date (YYYY-MM-DD)';
    end;
  end if;
  if problem is not null then
    perform public.log_inbound_call(e, 'invalid', 422, problem, null, warnings, null, digest);
    return jsonb_build_object('ok', false, 'status', 422, 'error', problem);
  end if;

  task_title := trim(body ->> 'title');
  task_notes := nullif(body ->> 'notes', '');
  select p.workspace_id into ws from public.projects p where p.id = e.project_id;

  -- Assignee: the payload's email when it's an active member, else the endpoint's default (still a member).
  if coalesce(trim(body ->> 'assignee_email'), '') <> '' then
    select pr.id into assignee from public.profiles pr
    where lower(pr.email) = lower(trim(body ->> 'assignee_email'))
      and public.profile_project_role(pr.id, e.project_id) is not null
    limit 1;
    if assignee is null then
      warnings := warnings || to_jsonb('assignee_email isn''t a member of this project; used the default assignee'::text);
    end if;
  end if;
  if assignee is null and e.assignee_id is not null
     and public.profile_project_role(e.assignee_id, e.project_id) is not null then
    assignee := e.assignee_id;
  end if;

  target_section := (
    select s.id from public.sections s
    where s.id = e.section_id and s.project_id = e.project_id and s.deleted_at is null
  );

  -- Tags: the endpoint's defaults plus the payload's names (active, unarchived tags of the workspace).
  tag_list := coalesce((
    select array_agg(t.id) from public.tags t
    where t.id = any (e.tag_ids) and t.workspace_id = ws and t.deleted_at is null and t.archived_at is null
  ), '{}');
  if jsonb_typeof(body -> 'tags') = 'array' then
    for tag_name in select x from jsonb_array_elements_text(body -> 'tags') x loop
      select t.id into tag_id from public.tags t
      where t.workspace_id = ws and t.deleted_at is null and t.archived_at is null
        and lower(trim(t.name)) = lower(trim(tag_name))
      limit 1;
      if tag_id is null then
        warnings := warnings || to_jsonb('Unknown or archived tag “' || left(tag_name, 50) || '” skipped');
      elsif not tag_id = any (tag_list) then
        tag_list := tag_list || tag_id;
      end if;
      tag_id := null;
    end loop;
  end if;

  begin
    -- Write as the endpoint's creator: stories, follows, and inbox items name them as the actor.
    prev_sub := current_setting('request.jwt.claim.sub', true);
    perform set_config('request.jwt.claim.sub', e.created_by::text, true);

    insert into public.tasks (home_project_id, title, notes, due_on, assignee_id, source, created_by)
    values (e.project_id, task_title, task_notes, task_due, assignee, 'inbound', e.created_by)
    returning id into new_task;

    -- Custom fields by name.
    if jsonb_typeof(body -> 'fields') = 'object' then
      for field_key, field_raw in select x.key, x.value from jsonb_each(body -> 'fields') x loop
        select cf.* into field from public.custom_fields cf
        where cf.project_id = e.project_id and cf.deleted_at is null and lower(trim(cf.name)) = lower(trim(field_key))
        order by cf.sort_order, cf.created_at limit 1;
        if field.id is null then
          warnings := warnings || to_jsonb('Unknown field “' || left(field_key, 50) || '” skipped');
          continue;
        end if;
        if field.bound_to_sections then
          target_section := coalesce(
            case when jsonb_typeof(field_raw) = 'string'
              then public.match_section(e.project_id, field_raw #>> '{}', field_raw #>> '{}') end,
            target_section
          );
          if jsonb_typeof(field_raw) <> 'string' or public.match_section(e.project_id, field_raw #>> '{}', field_raw #>> '{}') is null then
            warnings := warnings || to_jsonb('Field “' || left(field.name, 50) || '”: no matching section; skipped');
          end if;
          field := null;
          continue;
        end if;
        field_value := case
          when field_raw is null or field_raw = 'null'::jsonb then null
          when field.field_type = 'text' then case when jsonb_typeof(field_raw) in ('string', 'number')
            then to_jsonb(left(field_raw #>> '{}', 2000)) end
          when field.field_type = 'number' then case
            when jsonb_typeof(field_raw) = 'number' then field_raw
            when jsonb_typeof(field_raw) = 'string' and field_raw #>> '{}' ~ '^-?\d+(\.\d+)?$' then to_jsonb((field_raw #>> '{}')::numeric) end
          when field.field_type = 'date' then case when jsonb_typeof(field_raw) = 'string' and field_raw #>> '{}' ~ '^\d{4}-\d{2}-\d{2}$'
            then field_raw end
          when field.field_type = 'boolean' then case when jsonb_typeof(field_raw) = 'boolean' then field_raw end
          when field.field_type = 'single_select' then case when jsonb_typeof(field_raw) = 'string'
            then to_jsonb(public.match_field_option(field.options, field_raw #>> '{}', field_raw #>> '{}')) end
          when field.field_type = 'multi_select' then (
            select jsonb_agg(distinct m) from (
              select public.match_field_option(field.options, a, a) as m
              from jsonb_array_elements_text(case when jsonb_typeof(field_raw) = 'array' then field_raw else jsonb_build_array(field_raw) end) a
            ) matched where m is not null
          )
          when field.field_type = 'people' then (
            select jsonb_agg(distinct pr.id) from public.profiles pr
            where lower(pr.email) in (
              select lower(trim(a)) from jsonb_array_elements_text(
                case when jsonb_typeof(field_raw) = 'array' then field_raw else jsonb_build_array(field_raw) end
              ) a
            ) and public.profile_project_role(pr.id, e.project_id) is not null
          )
        end;
        if field_value is null or field_value = 'null'::jsonb then
          if field_raw is not null and field_raw <> 'null'::jsonb then
            warnings := warnings || to_jsonb('Field “' || left(field.name, 50) || '”: the value doesn''t fit; skipped');
          end if;
        else
          begin
            insert into public.task_field_values (task_id, field_id, value)
            values (new_task, field.id, field_value)
            on conflict (task_id, field_id) do update set value = excluded.value;
          exception when others then
            warnings := warnings || to_jsonb('Field “' || left(field.name, 50) || '”: the value doesn''t fit; skipped');
          end;
        end if;
        field := null;
      end loop;
    end if;

    if target_section is not null then
      update public.task_projects set section_id = target_section
      where task_id = new_task and project_id = e.project_id and deleted_at is null;
    end if;

    if cardinality(tag_list) > 0 then
      insert into public.task_tags (task_id, tag_id)
      select new_task, x from unnest(tag_list) x;
    end if;

    -- Like the importer: the creator doesn't follow every inbound task unless it's assigned to them.
    if assignee is distinct from e.created_by then
      update public.task_followers set deleted_at = now()
      where task_id = new_task and profile_id = e.created_by and deleted_at is null;
    end if;

    call_id := public.log_inbound_call(e, 'created', 201, null, new_task, warnings, call_key, digest);
    perform public.add_story(new_task, 'inbound_received', jsonb_build_object(
      'endpoint_id', e.id, 'endpoint_name', e.name, 'call_id', call_id
    ));

    perform set_config('request.jwt.claim.sub', coalesce(prev_sub, ''), true);

    perform public.fire_rules('inbound_received', new_task, e.project_id, jsonb_build_object(
      'endpoint_id', e.id, 'call_id', call_id
    ));
  exception when others then
    -- Everything above is rolled back (the task, its values, and the impersonation setting).
    perform public.log_inbound_call(e, 'failed', 500, 'The task couldn''t be created: ' || left(sqlerrm, 300),
      null, warnings, null, digest);
    return jsonb_build_object('ok', false, 'status', 500, 'error', 'The task couldn''t be created');
  end;

  return jsonb_build_object(
    'ok', true, 'status', 201, 'task_id', new_task,
    'request_label', public.task_request_label(new_task),
    'warnings', warnings
  );
end;
$$;

revoke all on function public.receive_inbound_webhook(text, text, text, text, text) from public;
grant execute on function public.receive_inbound_webhook(text, text, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Rules: inbound_received { endpoint_id? } and source_is "inbound"
-- ---------------------------------------------------------------------------

select public.alhc_patch_function('public.fire_rules(text, uuid, uuid, jsonb)'::regprocedure,
$p$    continue when trigger_kind = 'form_submitted' and cfg ? 'form_id' and cfg ->> 'form_id' is distinct from event ->> 'form_id';$p$,
$p$    continue when trigger_kind = 'form_submitted' and cfg ? 'form_id' and cfg ->> 'form_id' is distinct from event ->> 'form_id';
    continue when trigger_kind = 'inbound_received' and cfg ? 'endpoint_id'
      and cfg ->> 'endpoint_id' is distinct from event ->> 'endpoint_id';$p$);

select public.alhc_patch_function('public.validate_rule()'::regprocedure,
$p$    when 'form_submitted' then$p$,
$p$    when 'inbound_received' then
      if cfg ? 'endpoint_id' and not exists (
        select 1 from public.inbound_endpoints en
        where en.id::text = cfg ->> 'endpoint_id' and en.project_id = new.project_id and en.deleted_at is null
      ) then
        raise exception 'Choose an inbound webhook of this project for the trigger' using errcode = 'check_violation';
      end if;
    when 'form_submitted' then$p$,
$p$      if item ->> 'source' not in ('manual', 'form', 'import') then$p$,
$p$      if item ->> 'source' not in ('manual', 'form', 'import', 'inbound') then$p$);

-- ---------------------------------------------------------------------------
-- Done
-- ---------------------------------------------------------------------------

drop function public.alhc_patch_function(regprocedure, text[]);
