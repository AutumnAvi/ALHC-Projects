-- ALHC Projects — integrations phase.
-- Two new rule actions, send_slack (Slack incoming webhook) and call_webhook (outbound HTTPS JSON
-- webhook), delivered through integration_outbox exactly like email: the rule runner only queues a
-- row, and the app (after every Server Action and on /api/cron/workflows) claims and POSTs it with the
-- service role. The database never makes HTTP calls.
--
-- Webhook URLs and shared secrets are treated as secrets:
--   * project defaults live in project_integrations, and URLs/secrets typed into a rule action are
--     moved out of rules.actions into integration_secrets by a trigger before the rule is stored;
--     the action keeps only a reference and a redacted hint (host + last 4 characters).
--   * project_integrations, integration_secrets, and integration_outbox have RLS on, no policies, and
--     no table grants for anon/authenticated. Admins see redacted settings through
--     get_project_integrations(); delivery workers use claim/complete RPCs granted to service_role.
--   * stories, rule run logs, and scheduled actions only ever hold the redacted hint.
--
-- Same rules as earlier phases: additive, soft delete, no DELETE policies, SECURITY DEFINER helpers
-- revoked from client roles, nothing granted to anon.

-- ---------------------------------------------------------------------------
-- URL helpers
-- ---------------------------------------------------------------------------

create or replace function public.integration_url_host(url text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(substring(url from '^https://([A-Za-z0-9.-]+)'));
$$;

revoke all on function public.integration_url_host(text) from public, anon, authenticated;

-- HTTPS only, a plain host name (no user:password@), and not an obviously local or private address
-- (names that merely resolve to a private address are not checked; only Admins set these URLs).
-- src/lib/integrations-shared.ts mirrors this check and the drain re-checks before every POST.
create or replace function public.integration_url_ok(url text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select url is not null
    and length(url) <= 2000
    and url ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?([/?#][^[:space:]]*)?$'
    and public.integration_url_host(url) !~ '(^|\.)(localhost|local|internal)$'
    and public.integration_url_host(url) !~ '^(0|10|127)\.'
    and public.integration_url_host(url) !~ '^(169\.254|192\.168)\.'
    and public.integration_url_host(url) !~ '^172\.(1[6-9]|2[0-9]|3[01])\.'
    -- A numeric host must be a canonical dotted quad: integer, hex, and zero-padded (octal) spellings
    -- of private addresses would slip past the checks above.
    and not (
      public.integration_url_host(url) ~ '^(0x[0-9a-f]+|[0-9]+)(\.(0x[0-9a-f]+|[0-9]+)){0,3}$'
      and public.integration_url_host(url) !~ '^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$'
    )
    and public.integration_url_host(url) <> '';
$$;

revoke all on function public.integration_url_ok(text) from public, anon, authenticated;

-- Redacted form for stories, settings, and rule actions: "hooks.slack.com …x7Yz".
create or replace function public.integration_url_hint(url text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when url is null or url = '' then null
    else coalesce(public.integration_url_host(url), 'invalid URL') || ' …' || right(url, 4) end;
$$;

revoke all on function public.integration_url_hint(text) from public, anon, authenticated;

-- Header names a shared secret may be sent in. Transport headers the drain sets itself are reserved.
create or replace function public.integration_header_ok(header text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select header ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,99}$'
    and lower(header) not in ('content-type', 'content-length', 'host', 'user-agent', 'idempotency-key',
      'transfer-encoding', 'connection', 'accept-encoding');
$$;

-- Also used by validate_rule (SECURITY INVOKER) when an admin saves a rule.
revoke all on function public.integration_header_ok(text) from public, anon;
grant execute on function public.integration_header_ok(text) to authenticated;

-- Slack treats &, <, > as control characters (<!channel>, <url|label>). Values substituted into a
-- Slack message are escaped; the rule's own template text is left as written.
create or replace function public.slack_escape(value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select replace(replace(replace(value, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
$$;

revoke all on function public.slack_escape(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Story vocabulary
-- ---------------------------------------------------------------------------

alter table public.task_stories drop constraint task_stories_kind_check;
alter table public.task_stories add constraint task_stories_kind_check check (kind in (
  'created', 'completed', 'reopened', 'renamed', 'assigned', 'unassigned', 'due_changed', 'start_changed',
  'section_changed', 'project_added', 'project_removed', 'attachment_added', 'field_changed',
  'deleted', 'approval_requested', 'approval_decided', 'approval_cancelled', 'approval_resubmitted',
  'form_submitted', 'request_number_assigned', 'email_queued',
  'recurrence_changed', 'recurrence_spawned', 'dependency_added', 'dependency_removed', 'restored',
  'integration_queued', 'integration_failed'
));

-- ---------------------------------------------------------------------------
-- Project defaults (Settings → Integrations, Admin+)
-- ---------------------------------------------------------------------------

create table public.project_integrations (
  project_id uuid primary key references public.projects (id),
  slack_webhook_url text check (slack_webhook_url is null or public.integration_url_ok(slack_webhook_url)),
  webhook_url text check (webhook_url is null or public.integration_url_ok(webhook_url)),
  webhook_secret_header text check (webhook_secret_header is null or public.integration_header_ok(webhook_secret_header)),
  webhook_secret text check (webhook_secret is null or length(webhook_secret) between 1 and 500),
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index project_integrations_updated_by_idx on public.project_integrations (updated_by);

create trigger project_integrations_set_updated_at
  before update on public.project_integrations
  for each row execute function public.set_updated_at();

alter table public.project_integrations enable row level security;
revoke all on table public.project_integrations from anon, authenticated;

comment on table public.project_integrations is
  'Default Slack incoming webhook and outbound webhook per project. Secret: no client policies; '
  'read redacted via get_project_integrations(), write via set_project_integration() (Admin+).';

-- ---------------------------------------------------------------------------
-- Secrets typed into rule actions
-- ---------------------------------------------------------------------------

create table public.integration_secrets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  -- Written by the BEFORE trigger on rules, before the rule row exists, hence deferred.
  rule_id uuid not null references public.rules (id) deferrable initially deferred,
  kind text not null check (kind in ('slack_url', 'webhook_url', 'webhook_secret')),
  value text not null check (length(value) between 1 and 2000),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index integration_secrets_rule_idx on public.integration_secrets (rule_id);
create index integration_secrets_project_idx on public.integration_secrets (project_id);

alter table public.integration_secrets enable row level security;
revoke all on table public.integration_secrets from anon, authenticated;

comment on table public.integration_secrets is
  'URLs and shared secrets typed into send_slack / call_webhook actions. rules.actions keeps only '
  '{*_ref, *_hint}. No client policies; superseded values are soft-deleted.';

-- Replaces plain webhook_url / url / secret keys in send_slack and call_webhook actions with
-- references into integration_secrets plus redacted hints. Existing references must belong to this
-- project; a reference copied from another rule of the project is cloned for this rule. Hints are
-- always recomputed, so a client can't forge one.
create or replace function public.stash_rule_integration_secrets()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  a jsonb;
  out_actions jsonb := '[]'::jsonb;
  slot record;
  plain text;
  ref uuid;
  secret public.integration_secrets;
  label text;
  kept uuid[] := '{}';
begin
  for a in select value from jsonb_array_elements(new.actions) loop
    if jsonb_typeof(a) = 'object' and a ->> 'type' in ('send_slack', 'call_webhook') then
      label := case a ->> 'type' when 'send_slack' then 'Send Slack message' else 'Call webhook' end;
      for slot in
        select * from (values
          ('send_slack', 'webhook_url', 'webhook_ref', 'webhook_hint', 'slack_url'),
          ('call_webhook', 'url', 'url_ref', 'url_hint', 'webhook_url'),
          ('call_webhook', 'secret', 'secret_ref', 'secret_set', 'webhook_secret')
        ) s (action_type, plain_key, ref_key, hint_key, kind)
        where s.action_type = a ->> 'type'
      loop
        if a ? slot.plain_key then
          if jsonb_typeof(a -> slot.plain_key) not in ('string', 'null') then
            raise exception '%: % must be text', label, slot.plain_key using errcode = 'check_violation';
          end if;
          plain := trim(coalesce(a ->> slot.plain_key, ''));
          a := a - slot.plain_key - slot.ref_key - slot.hint_key;
          if plain <> '' then
            if slot.kind = 'webhook_secret' then
              if length(plain) > 500 then
                raise exception 'Call webhook: the shared secret is limited to 500 characters'
                  using errcode = 'check_violation';
              end if;
            elsif not public.integration_url_ok(plain) then
              raise exception '%: the webhook URL must be a public https:// address', label
                using errcode = 'check_violation', hint = 'Plain http, relative, and local addresses are rejected.';
            end if;
            insert into public.integration_secrets (project_id, rule_id, kind, value)
            values (new.project_id, new.id, slot.kind, plain)
            returning id into ref;
            a := a || jsonb_build_object(slot.ref_key, ref, slot.hint_key,
              case when slot.kind = 'webhook_secret' then to_jsonb(true) else to_jsonb(public.integration_url_hint(plain)) end);
            kept := kept || ref;
          end if;
        elsif a ? slot.ref_key then
          select * into secret from public.integration_secrets s
          where s.id::text = a ->> slot.ref_key and s.project_id = new.project_id and s.kind = slot.kind
            and s.deleted_at is null;
          if secret.id is null then
            raise exception '%: the saved % is no longer available; enter it again', label,
              case when slot.kind = 'webhook_secret' then 'secret' else 'URL' end
              using errcode = 'check_violation';
          end if;
          if secret.rule_id <> new.id then
            insert into public.integration_secrets (project_id, rule_id, kind, value)
            values (new.project_id, new.id, slot.kind, secret.value)
            returning id into ref;
          else
            ref := secret.id;
          end if;
          a := a - slot.hint_key || jsonb_build_object(slot.ref_key, ref, slot.hint_key,
            case when slot.kind = 'webhook_secret' then to_jsonb(true) else to_jsonb(public.integration_url_hint(secret.value)) end);
          kept := kept || ref;
        else
          a := a - slot.hint_key;
        end if;
      end loop;
    end if;
    out_actions := out_actions || jsonb_build_array(a);
  end loop;
  new.actions := out_actions;

  -- Values this rule no longer uses are retired, unless a pending delayed job still needs them.
  if tg_op = 'UPDATE' then
    update public.integration_secrets s
    set deleted_at = now()
    where s.rule_id = new.id and s.deleted_at is null and not (s.id = any (kept))
      and not exists (
        select 1 from public.scheduled_rule_actions j
        where j.rule_id = new.id and j.status = 'pending' and j.deleted_at is null
          and position(s.id::text in j.actions::text) > 0
      );
  end if;
  return new;
end;
$$;

revoke all on function public.stash_rule_integration_secrets() from public, anon, authenticated;

-- Named to run before rules_validate (BEFORE triggers fire in name order).
create trigger rules_05_stash_integration_secrets
  before insert or update of actions, project_id on public.rules
  for each row execute function public.stash_rule_integration_secrets();

-- ---------------------------------------------------------------------------
-- Integration outbox
-- ---------------------------------------------------------------------------

create table public.integration_outbox (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('slack', 'webhook')),
  project_id uuid not null references public.projects (id),
  task_id uuid references public.tasks (id),
  rule_id uuid references public.rules (id),
  -- The run row is written after the rule's actions, so the reference is checked at commit.
  rule_run_id uuid references public.rule_runs (id) deferrable initially deferred,
  target_url text not null check (public.integration_url_ok(target_url)),
  -- Redacted target (host + last 4 characters): the only form of the URL that leaves this table.
  target_hint text not null,
  -- Extra request headers (the optional shared secret for outbound webhooks); {} for Slack.
  headers jsonb not null default '{}'::jsonb check (jsonb_typeof(headers) = 'object'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'mocked', 'failed')),
  attempts integer not null default 0,
  last_error text,
  provider_response jsonb,
  send_after timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index integration_outbox_pending_idx on public.integration_outbox (send_after)
  where status in ('pending', 'sending');
create index integration_outbox_project_idx on public.integration_outbox (project_id);
create index integration_outbox_task_idx on public.integration_outbox (task_id);
create index integration_outbox_rule_idx on public.integration_outbox (rule_id);
create index integration_outbox_rule_run_idx on public.integration_outbox (rule_run_id);

create trigger integration_outbox_set_updated_at
  before update on public.integration_outbox
  for each row execute function public.set_updated_at();

-- Rows hold secrets (URL, headers): no client policies and no client table grants. Stories
-- (integration_queued / integration_failed) are the member-visible, redacted record.
alter table public.integration_outbox enable row level security;
revoke all on table public.integration_outbox from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Rule text: adds {project} and a Slack-escaped variant
-- ---------------------------------------------------------------------------

create or replace function public.render_rule_text_as(
  template text,
  target_task uuid,
  target_project uuid,
  event jsonb,
  text_format text
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  t public.tasks;
  result text := coalesce(template, '');
  token record;
begin
  select * into t from public.tasks where id = target_task;
  for token in
    select * from (values
      ('{assignee}', coalesce(public.profile_handle(t.assignee_id), '')),
      ('{creator}', coalesce(public.profile_handle(t.created_by), '')),
      ('{task}', coalesce(t.title, '')),
      ('{req}', coalesce(public.task_request_label(target_task), '')),
      ('{due}', coalesce(to_char(t.due_on, 'Mon FMDD'), 'no due date')),
      ('{approval_note}', coalesce(event ->> 'note', '')),
      ('{project}', coalesce((select p.name from public.projects p where p.id = target_project), '')),
      ('{section}', coalesce((
        select s.name from public.task_projects tp join public.sections s on s.id = tp.section_id
        where tp.task_id = target_task and tp.project_id = target_project
      ), 'No section'))
    ) v (name, value)
  loop
    result := replace(result, token.name,
      case when text_format = 'slack' then public.slack_escape(token.value) else token.value end);
  end loop;
  return trim(result);
end;
$$;

revoke all on function public.render_rule_text_as(text, uuid, uuid, jsonb, text) from public, anon, authenticated;

create or replace function public.render_rule_text(
  template text,
  target_task uuid,
  target_project uuid,
  event jsonb
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select public.render_rule_text_as(template, target_task, target_project, event, 'plain');
$$;

revoke all on function public.render_rule_text(text, uuid, uuid, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Enqueue (called by the rule runner only)
-- ---------------------------------------------------------------------------

-- Resolves the target from the action (its own saved URL) or the project default, renders the
-- payload, queues one outbox row, and writes a redacted integration_queued story. Raises when no
-- URL is configured, which fails the rule run with that message (and queues nothing).
-- Returns null when there is nothing to send (a Slack message that renders empty).
create or replace function public.enqueue_integration(
  r public.rules,
  target_task uuid,
  action jsonb,
  event jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  kind text := action ->> 'type';
  ch text := case kind when 'send_slack' then 'slack' when 'call_webhook' then 'webhook' end;
  settings public.project_integrations;
  use_project boolean := coalesce(action -> 'use_project_webhook' = 'true'::jsonb, false);
  url text;
  secret text;
  header text;
  own_url boolean := false;
  body jsonb;
  message text;
  t public.tasks;
  new_id uuid;
begin
  if ch is null then
    raise exception 'Unknown integration action %', coalesce(kind, '(none)') using errcode = 'check_violation';
  end if;
  select * into settings from public.project_integrations pi
  where pi.project_id = r.project_id and pi.deleted_at is null;
  select * into t from public.tasks where id = target_task;

  if not use_project and action ? (case ch when 'slack' then 'webhook_ref' else 'url_ref' end) then
    select s.value into url from public.integration_secrets s
    where s.id::text = action ->> (case ch when 'slack' then 'webhook_ref' else 'url_ref' end)
      and s.project_id = r.project_id and s.deleted_at is null;
    own_url := url is not null;
  end if;
  if url is null then
    url := case ch when 'slack' then settings.slack_webhook_url else settings.webhook_url end;
  end if;
  if coalesce(url, '') = '' then
    raise exception '%', case ch
      when 'slack' then 'Send Slack message: no Slack webhook URL is set on this action or in Settings → Integrations'
      else 'Call webhook: no webhook URL is set on this action or in Settings → Integrations' end
      using errcode = 'check_violation';
  end if;
  if not public.integration_url_ok(url) then
    raise exception '%: the webhook URL must be a public https:// address',
      case ch when 'slack' then 'Send Slack message' else 'Call webhook' end using errcode = 'check_violation';
  end if;

  if ch = 'slack' then
    message := left(public.render_rule_text_as(action ->> 'message', target_task, r.project_id, event, 'slack'), 4000);
    if message = '' then
      return null;
    end if;
    body := jsonb_build_object('text', message);
  else
    -- An action with its own URL only ever sends its own secret; the project secret goes only to the
    -- project URL.
    if own_url then
      if action ? 'secret_ref' then
        select s.value into secret from public.integration_secrets s
        where s.id::text = action ->> 'secret_ref' and s.project_id = r.project_id and s.deleted_at is null;
      end if;
      header := nullif(action ->> 'secret_header', '');
    else
      secret := settings.webhook_secret;
      header := settings.webhook_secret_header;
    end if;
    body := jsonb_build_object(
      'event', r.trigger_type,
      'rule_id', r.id,
      'rule_name', r.name,
      'project', jsonb_build_object(
        'id', r.project_id,
        'name', (select p.name from public.projects p where p.id = r.project_id)
      ),
      'task', jsonb_build_object(
        'id', t.id,
        'title', t.title,
        'req', public.task_request_label(target_task),
        'section_id', (
          select tp.section_id from public.task_projects tp
          where tp.task_id = target_task and tp.project_id = r.project_id and tp.deleted_at is null
        ),
        'section_name', (
          select s.name from public.task_projects tp join public.sections s on s.id = tp.section_id
          where tp.task_id = target_task and tp.project_id = r.project_id and tp.deleted_at is null
        ),
        'assignee_id', t.assignee_id,
        'completed', t.completed_at is not null,
        'due_on', t.due_on
      ),
      'occurred_at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
  end if;

  insert into public.integration_outbox (
    channel, project_id, task_id, rule_id, rule_run_id, target_url, target_hint, headers, payload
  )
  values (
    ch, r.project_id, target_task, r.id,
    nullif(current_setting('alhc.rule_run_id', true), '')::uuid,
    url, public.integration_url_hint(url),
    case when coalesce(secret, '') <> ''
      then jsonb_build_object(coalesce(header, 'X-ALHC-Webhook-Secret'), secret)
      else '{}'::jsonb end,
    body
  )
  returning id into new_id;

  if target_task is not null then
    perform public.add_story(target_task, 'integration_queued', jsonb_build_object(
      'outbox_id', new_id, 'channel', ch, 'target', public.integration_url_hint(url)
    ));
  end if;
  return new_id;
end;
$$;

revoke all on function public.enqueue_integration(public.rules, uuid, jsonb, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Delivery workers (the app, with the service role) claim and complete rows
-- ---------------------------------------------------------------------------

create or replace function public.claim_integration_outbox(max_items integer default 20, only_id uuid default null)
returns setof public.integration_outbox
language sql
security definer
set search_path = ''
as $$
  update public.integration_outbox o
  set status = 'sending', attempts = o.attempts + 1
  where o.id in (
    select c.id from public.integration_outbox c
    where c.deleted_at is null
      and (only_id is null or c.id = only_id)
      and c.attempts < 5
      and c.send_after <= now()
      and (c.status = 'pending' or (c.status = 'sending' and c.updated_at < now() - interval '10 minutes'))
    order by c.created_at
    limit least(greatest(coalesce(max_items, 20), 1), 100)
    for update skip locked
  )
  returning o.*;
$$;

revoke all on function public.claim_integration_outbox(integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_integration_outbox(integer, uuid) to service_role;

-- outcome: sent | mocked | error. Errors go back to pending (retried after 5 minutes) until the
-- fifth attempt, then the row is failed and the task gets a redacted integration_failed story.
create or replace function public.complete_integration_outbox(
  target_item uuid,
  outcome text,
  response jsonb default null,
  error_message text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_after public.integration_outbox;
begin
  update public.integration_outbox
  set status = case
        when outcome in ('sent', 'mocked') then outcome
        when attempts >= 5 then 'failed'
        else 'pending'
      end,
      sent_at = case when outcome in ('sent', 'mocked') then now() end,
      provider_response = response,
      last_error = left(error_message, 2000),
      send_after = case when outcome in ('sent', 'mocked') then send_after else now() + interval '5 minutes' end
  where id = target_item and status = 'sending'
  returning * into row_after;

  if row_after.status = 'failed' and row_after.task_id is not null then
    perform public.add_story(row_after.task_id, 'integration_failed', jsonb_build_object(
      'outbox_id', row_after.id,
      'channel', row_after.channel,
      'target', row_after.target_hint,
      'attempts', row_after.attempts,
      'rule_id', row_after.rule_id,
      'rule_name', (select ru.name from public.rules ru where ru.id = row_after.rule_id)
    ));
  end if;
end;
$$;

revoke all on function public.complete_integration_outbox(uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.complete_integration_outbox(uuid, text, jsonb, text) to service_role;

-- ---------------------------------------------------------------------------
-- Project settings RPCs (Admin+). Values are never returned, only redacted hints.
-- ---------------------------------------------------------------------------

create or replace function public.get_project_integrations(target_project uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  settings public.project_integrations;
begin
  if not public.has_project_role(target_project, 'admin') then
    raise exception 'Only project admins can see integration settings' using errcode = 'insufficient_privilege';
  end if;
  select * into settings from public.project_integrations pi
  where pi.project_id = target_project and pi.deleted_at is null;
  return jsonb_build_object(
    'slack_webhook', public.integration_url_hint(settings.slack_webhook_url),
    'webhook', public.integration_url_hint(settings.webhook_url),
    'webhook_secret_set', coalesce(settings.webhook_secret, '') <> '',
    'webhook_secret_header', settings.webhook_secret_header,
    'updated_at', settings.updated_at
  );
end;
$$;

revoke all on function public.get_project_integrations(uuid) from public, anon, authenticated;
grant execute on function public.get_project_integrations(uuid) to authenticated;

-- setting: slack_webhook_url | webhook_url | webhook_secret | webhook_secret_header.
-- An empty or null value clears the setting. Returns the redacted settings.
create or replace function public.set_project_integration(target_project uuid, setting text, new_value text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v text := nullif(trim(coalesce(new_value, '')), '');
begin
  if not public.has_project_role(target_project, 'admin') then
    raise exception 'Only project admins can change integration settings' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.projects p where p.id = target_project and p.deleted_at is not null) then
    raise exception 'This project is deleted' using errcode = 'check_violation';
  end if;
  if setting in ('slack_webhook_url', 'webhook_url') and v is not null and not public.integration_url_ok(v) then
    raise exception 'The webhook URL must be a public https:// address' using errcode = 'check_violation',
      hint = 'Plain http, relative, and local addresses are rejected.';
  end if;
  if setting = 'webhook_secret' and length(v) > 500 then
    raise exception 'The shared secret is limited to 500 characters' using errcode = 'check_violation';
  end if;
  if setting = 'webhook_secret_header' and v is not null and not public.integration_header_ok(v) then
    raise exception 'Header names use letters, digits, and dashes (and can''t be a standard transport header)'
      using errcode = 'check_violation';
  end if;

  insert into public.project_integrations (project_id, updated_by) values (target_project, auth.uid())
  on conflict (project_id) do nothing;

  case setting
    when 'slack_webhook_url' then
      update public.project_integrations set slack_webhook_url = v, updated_by = auth.uid(), deleted_at = null
      where project_id = target_project;
    when 'webhook_url' then
      update public.project_integrations set webhook_url = v, updated_by = auth.uid(), deleted_at = null
      where project_id = target_project;
    when 'webhook_secret' then
      update public.project_integrations set webhook_secret = v, updated_by = auth.uid(), deleted_at = null
      where project_id = target_project;
    when 'webhook_secret_header' then
      update public.project_integrations set webhook_secret_header = v, updated_by = auth.uid(), deleted_at = null
      where project_id = target_project;
    else
      raise exception 'Unknown integration setting %', coalesce(setting, '(none)') using errcode = 'check_violation';
  end case;
  return public.get_project_integrations(target_project);
end;
$$;

revoke all on function public.set_project_integration(uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_project_integration(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Rules engine: new actions
--
-- send_slack   { message, use_project_webhook?, webhook_url? (input only) → webhook_ref + webhook_hint }
-- call_webhook { use_project_webhook?, url? (input only) → url_ref + url_hint,
--                secret? (input only) → secret_ref + secret_set, secret_header? }
-- Without use_project_webhook, an action's own URL wins and the project default is the fallback.
-- ---------------------------------------------------------------------------

create or replace function public.validate_rule()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  cfg jsonb := new.trigger_config;
  item jsonb;
  kind text;
  field public.custom_fields;
begin
  case new.trigger_type
    when 'section_changed' then
      if not public.rule_section_ok(new.project_id, cfg ->> 'section_id') then
        raise exception 'Choose a section in this project for the trigger' using errcode = 'check_violation';
      end if;
    when 'field_changed' then
      field := public.rule_field(new.project_id, cfg ->> 'field_id');
      if field.id is null then
        raise exception 'Choose a field in this project for the trigger' using errcode = 'check_violation';
      end if;
      if field.bound_to_sections then
        raise exception 'The section-bound Status field changes with sections: use the “Section changed” trigger'
          using errcode = 'check_violation';
      end if;
    when 'due_approaching' then
      if cfg ? 'days' and (coalesce(jsonb_typeof(cfg -> 'days'), 'missing') <> 'number' or (cfg ->> 'days')::numeric not between 0 and 30) then
        raise exception 'Days before due must be between 0 and 30' using errcode = 'check_violation';
      end if;
    when 'approval_decided' then
      if cfg ? 'statuses' and (
        coalesce(jsonb_typeof(cfg -> 'statuses'), 'missing') <> 'array'
        or not '["approved", "changes_requested", "rejected"]'::jsonb @> (cfg -> 'statuses')
      ) then
        raise exception 'Unknown approval status in trigger' using errcode = 'check_violation';
      end if;
    when 'form_submitted' then
      if cfg ? 'form_id' and not exists (
        select 1 from public.forms fo where fo.id::text = cfg ->> 'form_id' and fo.project_id = new.project_id
      ) then
        raise exception 'Choose a form in this project for the trigger' using errcode = 'check_violation';
      end if;
    else
      null;
  end case;

  if jsonb_array_length(new.conditions) > 20 then
    raise exception 'Rules are limited to 20 conditions' using errcode = 'check_violation';
  end if;
  for item in select value from jsonb_array_elements(new.conditions) loop
    kind := item ->> 'type';
    if kind in ('section_is', 'section_is_not') then
      if not public.rule_section_ok(new.project_id, item ->> 'section_id') then
        raise exception 'A condition refers to a section outside this project' using errcode = 'check_violation';
      end if;
    elsif kind in ('field_equals', 'field_is_set', 'field_is_empty') then
      if public.rule_field(new.project_id, item ->> 'field_id') is null then
        raise exception 'A condition refers to a field outside this project' using errcode = 'check_violation';
      end if;
    elsif kind = 'source_is' then
      if item ->> 'source' not in ('manual', 'form', 'import') then
        raise exception 'Unknown task source in condition' using errcode = 'check_violation';
      end if;
    elsif kind is null or kind not in ('assignee_is_set', 'assignee_is_empty', 'is_complete', 'is_incomplete') then
      raise exception 'Unknown condition %', coalesce(kind, '(none)') using errcode = 'check_violation';
    end if;
  end loop;

  if jsonb_array_length(new.actions) not between 1 and 10 then
    raise exception 'Rules need between 1 and 10 actions' using errcode = 'check_violation';
  end if;
  for item in select value from jsonb_array_elements(new.actions) loop
    kind := item ->> 'type';
    case kind
      when 'move_section' then
        if not public.rule_section_ok(new.project_id, item ->> 'section_id') then
          raise exception 'Move to section: choose a section in this project' using errcode = 'check_violation';
        end if;
      when 'set_field' then
        field := public.rule_field(new.project_id, item ->> 'field_id');
        if field.id is null then
          raise exception 'Set field: choose a field in this project' using errcode = 'check_violation';
        end if;
        if field.bound_to_sections and not public.rule_section_ok(new.project_id, item -> 'value' #>> '{}') then
          raise exception 'Set Status: choose one of this project''s sections' using errcode = 'check_violation';
        end if;
      when 'set_assignee' then
        if item -> 'assignee' <> 'null'::jsonb and not public.rule_person_ok(item -> 'assignee') then
          raise exception 'Set assignee: choose a person' using errcode = 'check_violation';
        end if;
      when 'add_comment' then
        if length(trim(coalesce(item ->> 'body', ''))) not between 1 and 5000 then
          raise exception 'Add comment: write the comment text' using errcode = 'check_violation';
        end if;
      when 'add_followers', 'notify' then
        if coalesce(jsonb_typeof(item -> 'people'), 'missing') <> 'array' or jsonb_array_length(item -> 'people') = 0
           or exists (select 1 from jsonb_array_elements(item -> 'people') p where not public.rule_person_ok(p)) then
          raise exception 'Choose at least one person for %', replace(kind, '_', ' ') using errcode = 'check_violation';
        end if;
        if kind = 'notify' and length(trim(coalesce(item ->> 'message', ''))) not between 1 and 1000 then
          raise exception 'Notify: write a message' using errcode = 'check_violation';
        end if;
      when 'request_approval' then
        if not public.rule_person_ok(item -> 'approver') then
          raise exception 'Request approval: choose an approver' using errcode = 'check_violation';
        end if;
      when 'send_email' then
        if item ->> 'to' is null or item ->> 'to' not in ('submitter', 'assignee', 'field', 'address') then
          raise exception 'Send email: choose a recipient' using errcode = 'check_violation';
        end if;
        if item ->> 'to' = 'field' and public.rule_field(new.project_id, item ->> 'field_id') is null then
          raise exception 'Send email: choose the field that holds the email address' using errcode = 'check_violation';
        end if;
        if item ->> 'to' = 'address' and not public.is_email(lower(trim(item ->> 'address'))) then
          raise exception 'Send email: enter a valid address' using errcode = 'check_violation';
        end if;
        if coalesce(item ->> 'template', 'requester_update') not in ('requester_update', 'due_tomorrow', 'custom') then
          raise exception 'Send email: unknown template' using errcode = 'check_violation';
        end if;
        if item ? 'include_field_id' and public.rule_field(new.project_id, item ->> 'include_field_id') is null then
          raise exception 'Send email: the included field is not in this project' using errcode = 'check_violation';
        end if;
      when 'send_slack' then
        if length(trim(coalesce(item ->> 'message', ''))) not between 1 and 4000 then
          raise exception 'Send Slack message: write the message' using errcode = 'check_violation';
        end if;
        if item ? 'use_project_webhook' and jsonb_typeof(item -> 'use_project_webhook') <> 'boolean' then
          raise exception 'Send Slack message: “use the project webhook” must be true or false' using errcode = 'check_violation';
        end if;
        if item ? 'webhook_url' then
          raise exception 'Send Slack message: webhook URLs are stored separately' using errcode = 'check_violation';
        end if;
      when 'call_webhook' then
        if item ? 'use_project_webhook' and jsonb_typeof(item -> 'use_project_webhook') <> 'boolean' then
          raise exception 'Call webhook: “use the project webhook” must be true or false' using errcode = 'check_violation';
        end if;
        if item ? 'secret_header' and item -> 'secret_header' <> 'null'::jsonb
           and not public.integration_header_ok(item ->> 'secret_header') then
          raise exception 'Call webhook: header names use letters, digits, and dashes (and can''t be a standard transport header)'
            using errcode = 'check_violation';
        end if;
        if item ? 'url' or item ? 'secret' then
          raise exception 'Call webhook: URLs and secrets are stored separately' using errcode = 'check_violation';
        end if;
      when 'delay' then
        if coalesce(jsonb_typeof(item -> 'hours'), 'missing') <> 'number' or (item ->> 'hours')::numeric not between 0.1 and 720 then
          raise exception 'Delay must be between 0.1 and 720 hours' using errcode = 'check_violation';
        end if;
      else
        raise exception 'Unknown action %', coalesce(kind, '(none)') using errcode = 'check_violation';
    end case;
  end loop;
  return new;
end;
$$;

-- Runs actions in order for one task. Returns a per-action log. A delay schedules the rest and stops.
-- Integrations only queue outbox rows; the log never carries a URL.
create or replace function public.execute_rule_actions(
  r public.rules,
  target_task uuid,
  rule_actions jsonb,
  event jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a jsonb;
  idx bigint;
  log jsonb := '[]'::jsonb;
  outcome text;
  t public.tasks;
  field public.custom_fields;
  person uuid;
  body text;
  recipient text;
  p jsonb;
  submission public.form_submissions;
begin
  for a, idx in select value, ordinality from jsonb_array_elements(rule_actions) with ordinality loop
    select * into t from public.tasks where id = target_task;
    outcome := 'done';
    case a ->> 'type'
      when 'delay' then
        insert into public.scheduled_rule_actions (rule_id, task_id, actions, event, run_at)
        values (
          r.id, target_task,
          coalesce((select jsonb_agg(x.value order by x.ordinality) from jsonb_array_elements(rule_actions)
            with ordinality x where x.ordinality > idx), '[]'::jsonb),
          coalesce(event, '{}'::jsonb),
          now() + make_interval(secs => ((a ->> 'hours')::numeric * 3600)::double precision)
        );
        log := log || jsonb_build_array(jsonb_build_object('type', 'delay', 'outcome', 'scheduled', 'hours', a -> 'hours'));
        return log;

      when 'move_section' then
        if not public.move_task_to_section(target_task, r.project_id, (a ->> 'section_id')::uuid) then
          outcome := 'unchanged';
        end if;

      when 'set_field' then
        field := public.rule_field(r.project_id, a ->> 'field_id');
        if field.id is null then
          outcome := 'missing_field';
        elsif field.bound_to_sections then
          -- The section-bound Status field IS the section: setting it moves the task, nothing is stored.
          if not public.move_task_to_section(target_task, r.project_id, (a -> 'value' #>> '{}')::uuid) then
            outcome := 'unchanged';
          end if;
        else
          insert into public.task_field_values (task_id, field_id, value)
          values (target_task, field.id, a -> 'value')
          on conflict (task_id, field_id) do update set value = excluded.value
          where public.task_field_values.value is distinct from excluded.value;
          if not found then outcome := 'unchanged'; end if;
        end if;

      when 'set_assignee' then
        person := case when a -> 'assignee' = 'null'::jsonb or a -> 'assignee' is null then null
          else public.resolve_rule_person(a -> 'assignee', target_task) end;
        update public.tasks set assignee_id = person
        where id = target_task and assignee_id is distinct from person;
        if not found then outcome := 'unchanged'; end if;

      when 'add_comment' then
        body := left(public.render_rule_text(a ->> 'body', target_task, r.project_id, event), 10000);
        if body = '' then
          outcome := 'empty';
        else
          insert into public.comments (task_id, author_id, rule_id, body) values (target_task, null, r.id, body);
        end if;

      when 'add_followers' then
        for p in select value from jsonb_array_elements(a -> 'people') loop
          perform public.follow_task(target_task, public.resolve_rule_person(p, target_task));
        end loop;

      when 'notify' then
        body := left(public.render_rule_text(a ->> 'message', target_task, r.project_id, event), 1000);
        for person in
          select distinct public.resolve_rule_person(x.value, target_task)
          from jsonb_array_elements(a -> 'people') x
        loop
          perform public.notify_with(person, target_task, 'rule', null, jsonb_build_object('message', body));
        end loop;

      when 'request_approval' then
        person := public.resolve_rule_person(a -> 'approver', target_task);
        if person is null then
          outcome := 'no_approver';
        elsif exists (
          select 1 from public.approval_requests ar
          where ar.task_id = target_task and ar.approver_id = person and ar.deleted_at is null
            and ar.status in ('pending', 'changes_requested')
        ) then
          outcome := 'already_open';
        else
          perform public.create_approval(
            target_task, person,
            public.render_rule_text(a ->> 'note', target_task, r.project_id, event),
            true,
            coalesce(nullif(public.render_rule_text(a ->> 'title', target_task, r.project_id, event), ''), 'Approve this work')
          );
        end if;

      when 'send_email' then
        recipient := case a ->> 'to'
          when 'submitter' then (
            select s.submitter_email from public.form_submissions s
            where s.task_id = target_task and s.deleted_at is null order by s.created_at desc limit 1
          )
          when 'assignee' then (select pr.email from public.profiles pr where pr.id = t.assignee_id)
          when 'field' then public.task_field_text(target_task, (a ->> 'field_id')::uuid)
          when 'address' then a ->> 'address'
        end;
        if not public.is_email(lower(trim(coalesce(recipient, '')))) then
          outcome := 'no_recipient';
        else
          perform public.enqueue_email(
            recipient,
            coalesce(a ->> 'template', 'requester_update'),
            nullif(public.render_rule_text(a ->> 'subject', target_task, r.project_id, event), ''),
            jsonb_build_object(
              'task_title', t.title,
              'request_label', public.task_request_label(target_task),
              'project_name', (select pj.name from public.projects pj where pj.id = r.project_id),
              'section_name', public.render_rule_text('{section}', target_task, r.project_id, event),
              'due_on', t.due_on,
              'message', nullif(public.render_rule_text(a ->> 'message', target_task, r.project_id, event), ''),
              'field', case when a ? 'include_field_id' then jsonb_build_object(
                'name', (select f.name from public.custom_fields f where f.id::text = a ->> 'include_field_id'),
                'value', public.task_field_text(target_task, (a ->> 'include_field_id')::uuid)
              ) end
            ),
            target_task
          );
        end if;

      when 'send_slack', 'call_webhook' then
        if public.enqueue_integration(r, target_task, a, event) is null then
          outcome := 'empty';
        else
          outcome := 'queued';
        end if;
    end case;
    log := log || jsonb_build_array(jsonb_build_object('type', a ->> 'type', 'outcome', outcome));
  end loop;
  return log;
end;
$$;

revoke all on function public.execute_rule_actions(public.rules, uuid, jsonb, jsonb) from public, anon, authenticated;

-- Same as the workflows version, plus: the run id is chosen up front and exposed as the
-- transaction-local GUC alhc.rule_run_id so queued integration rows can point at their run.
create or replace function public.run_rule(
  r public.rules,
  target_task uuid,
  event jsonb,
  rule_actions jsonb default null,
  dedupe text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  chain text := coalesce(current_setting('alhc.rule_chain', true), '');
  previous_rule text := coalesce(current_setting('alhc.rule_id', true), '');
  previous_run text := coalesce(current_setting('alhc.rule_run_id', true), '');
  depth integer := case when chain = '' then 0 else array_length(string_to_array(chain, ','), 1) end;
  log jsonb;
  run_status text;
  run_id uuid := gen_random_uuid();
begin
  if dedupe is not null and exists (
    select 1 from public.rule_runs rr where rr.rule_id = r.id and rr.task_id = target_task and rr.dedupe_key = dedupe
  ) then
    return 'duplicate';
  end if;

  if position(r.id::text in chain) > 0 or depth >= 5 then
    insert into public.rule_runs (rule_id, task_id, trigger_type, status, detail)
    values (r.id, target_task, r.trigger_type, 'skipped', jsonb_build_object(
      'reason', case when depth >= 5 then 'depth_limit' else 'loop' end, 'chain', chain
    ));
    return 'skipped';
  end if;

  if (
    select count(*) from public.rule_runs rr
    where rr.rule_id = r.id and rr.task_id = target_task
      and rr.status in ('succeeded', 'scheduled') and rr.created_at > now() - interval '1 hour'
  ) >= 20 then
    insert into public.rule_runs (rule_id, task_id, trigger_type, status, detail)
    values (r.id, target_task, r.trigger_type, 'skipped', jsonb_build_object('reason', 'throttled'));
    return 'skipped';
  end if;

  if not public.rule_conditions_pass(r, target_task) then
    return 'conditions';
  end if;

  perform set_config('alhc.rule_chain', case when chain = '' then r.id::text else chain || ',' || r.id::text end, true);
  perform set_config('alhc.rule_id', r.id::text, true);
  perform set_config('alhc.rule_run_id', run_id::text, true);
  begin
    log := public.execute_rule_actions(r, target_task, coalesce(rule_actions, r.actions), event);
    run_status := case when log @> '[{"outcome": "scheduled"}]'::jsonb then 'scheduled' else 'succeeded' end;
  exception when others then
    log := jsonb_build_object('error', sqlerrm);
    run_status := 'failed';
  end;
  perform set_config('alhc.rule_chain', chain, true);
  perform set_config('alhc.rule_id', previous_rule, true);
  perform set_config('alhc.rule_run_id', previous_run, true);

  insert into public.rule_runs (id, rule_id, task_id, trigger_type, status, detail, dedupe_key)
  values (run_id, r.id, target_task, r.trigger_type, run_status,
    jsonb_build_object('actions', log, 'event', coalesce(event, '{}'::jsonb)), dedupe);
  return run_status;
end;
$$;

revoke all on function public.run_rule(public.rules, uuid, jsonb, jsonb, text) from public, anon, authenticated;
