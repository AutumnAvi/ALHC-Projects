-- ALHC Projects — Phase: Integration depth.
-- Slack Block Kit messages with a {task_link} token, HMAC body signing for outbound webhooks, and a
-- per-project delivery log with automatic (capped exponential) and manual retry. Free only: Slack stays
-- incoming webhooks (no Slack app, no OAuth), and the database still never makes HTTP calls — the app
-- drains integration_outbox with the service role as before.
--
-- Security shape (pinned by supabase/tests/zz05_integration_depth_smoke.sql):
--   * Signing secrets live in integration_secrets (kind signing_secret): per project (rule_id null, one
--     active row) or per call_webhook action (signing_ref + signing_set in rules.actions, like the shared
--     secret). The app generates them and shows them once; nothing returns them afterwards. When a row
--     is queued, its secret is copied into integration_outbox.signing_secret so retries sign with the
--     same key. Signatures are computed by the drain at send time and never stored.
--   * integration_secrets and integration_outbox keep RLS on, no policies, and no client grants. The
--     delivery log is read through list_integration_deliveries (Admin+ of the project, hints only — never
--     a URL, header, payload, secret, or signature), and one delivery is retried or cancelled through
--     retry_integration_delivery / cancel_integration_delivery (Admin+). These three are the new
--     client-callable SECURITY DEFINER functions (the tables have no client path at all), pinned in suite
--     60 and revoked from public and anon. Workspace admins get nothing: every check is has_project_role.
--   * Automatic retries back off 5, 10, 20, then 30 minutes (capped) and stop after 5 attempts as before;
--     a manual retry allows one more attempt, up to 10 in total. Retries reuse the stored payload, and
--     webhooks keep the stable Idempotency-Key integration-outbox-<id>.
--   * Additive: existing rows, rule actions, and the drain of the previous release keep working once this
--     is applied (a new column defaults to the old 5-attempt limit; Slack messages stay plain text unless
--     a rule picks Block Kit).
--
-- fire_rules, notify_with, notify_message, and add_story are untouched (their import and copy checks
-- included). Existing functions are changed with asserted text patches (alhc_patch_function below): each
-- edit must match the live definition exactly once, and every other line stays. Grants are kept.
--
-- Applying to the hosted project: the "apply chunk" markers below are statement boundaries (never inside
-- a dollar-quoted body). Each chunk is applied with apply_migration as integration_depth_a, _b, … in order.

-- ===== apply chunk: integration_depth_a =====

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
-- Signing secrets in integration_secrets
-- ---------------------------------------------------------------------------

-- A project's signing secret belongs to no rule.
alter table public.integration_secrets alter column rule_id drop not null;

alter table public.integration_secrets drop constraint integration_secrets_kind_check;
alter table public.integration_secrets add constraint integration_secrets_kind_check
  check (kind in ('slack_url', 'webhook_url', 'webhook_secret', 'signing_secret'));

alter table public.integration_secrets add constraint integration_secrets_rule_check
  check (rule_id is not null or kind = 'signing_secret');

-- One active project-level signing secret per project.
create unique index integration_secrets_project_signing_idx on public.integration_secrets (project_id)
  where rule_id is null and kind = 'signing_secret' and deleted_at is null;

comment on table public.integration_secrets is
  'URLs, shared secrets, and signing secrets typed into send_slack / call_webhook actions (rule_id set), '
  'plus each project''s signing secret (rule_id null). rules.actions keeps only {*_ref, *_hint / *_set}. '
  'No client policies or grants; superseded values are soft-deleted.';

-- ---------------------------------------------------------------------------
-- Outbox: signing secret snapshot, per-row attempt limit, cancelled
-- ---------------------------------------------------------------------------

alter table public.integration_outbox
  add column signing_secret text check (signing_secret is null or length(signing_secret) between 16 and 500),
  add column max_attempts integer not null default 5 check (max_attempts between 1 and 10);

alter table public.integration_outbox drop constraint integration_outbox_status_check;
alter table public.integration_outbox add constraint integration_outbox_status_check
  check (status in ('pending', 'sending', 'sent', 'mocked', 'failed', 'cancelled'));

comment on column public.integration_outbox.signing_secret is
  'HMAC-SHA256 key for X-ALHC-Signature, copied from the project or action when the row was queued so '
  'retries sign with the same key. Never readable by clients; signatures are computed by the drain.';
comment on column public.integration_outbox.max_attempts is
  'Attempts allowed before the row fails: 5 automatic; each manual retry (Admin+) allows one more, up to 10.';

-- The signature headers are set by the drain; a shared secret can't be sent under their names.
select public.alhc_patch_function('public.integration_header_ok(text)'::regprocedure,
$p$    and lower(header) not in ('content-type', 'content-length', 'host', 'user-agent', 'idempotency-key',$p$,
$p$    and lower(header) not in ('content-type', 'content-length', 'host', 'user-agent', 'idempotency-key',
      'x-alhc-signature', 'x-alhc-timestamp',$p$);

-- ===== apply chunk: integration_depth_b =====

-- ---------------------------------------------------------------------------
-- Retry backoff
-- ---------------------------------------------------------------------------

-- Delay before the next automatic attempt after `attempts` tries: 5 minutes, doubling, capped at 30.
create or replace function public.integration_retry_delay(attempts integer)
returns interval
language sql
immutable
set search_path = ''
as $$
  select least(
    interval '5 minutes' * power(2, least(greatest(coalesce(attempts, 1), 1), 10) - 1),
    interval '30 minutes'
  );
$$;

revoke all on function public.integration_retry_delay(integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Slack: {task_link} and Block Kit
-- ---------------------------------------------------------------------------

-- A Slack link to the task, with the app origin left as a marker the drain fills in from
-- NEXT_PUBLIC_APP_URL (else the Vercel production URL), or unwraps to the plain title when neither is
-- set. The URL is the ordinary signed-in task link — never a public or tokenized one. Substituted values
-- are Slack-escaped, so no task text can contain "<" and forge a marker.
create or replace function public.slack_task_link(target_task uuid, target_project uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select case when t.id is null or target_project is null then ''
    else '<alhc-link:/projects/' || target_project || '?task=' || t.id || '|'
      || public.slack_escape(left(t.title, 200)) || '>' end
  from (select 1) one
  left join public.tasks t on t.id = target_task;
$$;

revoke all on function public.slack_task_link(uuid, uuid) from public, anon, authenticated;

-- Block Kit body for a send_slack action with format "blocks": the rendered message, the task title
-- linked, project / assignee / due date / status fields, and an Open task button. `text` is the same
-- message as a plain-text fallback (notifications, clients without blocks). Every value is escaped.
create or replace function public.slack_block_payload(message text, target_task uuid, target_project uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  t public.tasks;
  blocks jsonb := jsonb_build_array(jsonb_build_object(
    'type', 'section', 'text', jsonb_build_object('type', 'mrkdwn', 'text', left(message, 3000))
  ));
  assignee text;
  section_name text;
  project_name text;
begin
  select * into t from public.tasks where id = target_task;
  if t.id is not null and target_project is not null then
    select coalesce(nullif(trim(p.full_name), ''), split_part(p.email, '@', 1)) into assignee
    from public.profiles p where p.id = t.assignee_id;
    select s.name into section_name
    from public.task_projects tp join public.sections s on s.id = tp.section_id
    where tp.task_id = t.id and tp.project_id = target_project and tp.deleted_at is null;
    select pj.name into project_name from public.projects pj where pj.id = target_project;

    blocks := blocks || jsonb_build_array(
      jsonb_build_object(
        'type', 'section',
        'text', jsonb_build_object('type', 'mrkdwn', 'text', '*' || public.slack_task_link(t.id, target_project) || '*'),
        'fields', (
          select jsonb_agg(jsonb_build_object('type', 'mrkdwn',
            'text', '*' || f.label || '*' || chr(10) || public.slack_escape(left(f.value, 1900))) order by f.n)
          from (values
            (1, 'Project', coalesce(project_name, '')),
            (2, 'Assignee', coalesce(assignee, 'Unassigned')),
            (3, 'Due', coalesce(to_char(t.due_on, 'Mon FMDD, YYYY'), 'No due date')),
            (4, 'Status', case when t.completed_at is not null then 'Completed'
              else 'Open · ' || coalesce(section_name, 'No section') end)
          ) f (n, label, value)
        )
      ),
      jsonb_build_object(
        'type', 'actions',
        'elements', jsonb_build_array(jsonb_build_object(
          'type', 'button',
          'action_id', 'open_task',
          'text', jsonb_build_object('type', 'plain_text', 'text', 'Open task'),
          'url', 'alhc-link:/projects/' || target_project || '?task=' || t.id
        ))
      )
    );
  end if;
  return jsonb_build_object('text', message, 'blocks', blocks);
end;
$$;

revoke all on function public.slack_block_payload(text, uuid, uuid) from public, anon, authenticated;

-- {task_link} in Slack messages (send_slack only; other rule text leaves it as typed).
select public.alhc_patch_function('public.render_rule_text_as(text, uuid, uuid, jsonb, text)'::regprocedure,
$p$  for token in$p$,
$p$  -- {task_link} (Slack only, Integration depth): replaced before the other tokens; the values they
  -- substitute are escaped, so they can't produce a link marker.
  if text_format = 'slack' then
    result := replace(result, '{task_link}', public.slack_task_link(target_task, target_project));
  end if;
  for token in$p$);

-- Enqueue: Block Kit for send_slack { format: "blocks" }, and the signing secret for call_webhook —
-- the action's own (signing_ref) when it posts to its own URL, else the project's (same rule as the
-- shared secret: a project secret only ever goes to the project URL).
select public.alhc_patch_function('public.enqueue_integration(public.rules, uuid, jsonb, jsonb)'::regprocedure,
$p$  header text;
$p$,
$p$  header text;
  signing text;
$p$,
$p$    body := jsonb_build_object('text', message);$p$,
$p$    body := case when action ->> 'format' = 'blocks'
      then public.slack_block_payload(message, target_task, r.project_id)
      else jsonb_build_object('text', message) end;$p$,
$p$      header := nullif(action ->> 'secret_header', '');
    else
      secret := settings.webhook_secret;
$p$,
$p$      header := nullif(action ->> 'secret_header', '');
      if action ? 'signing_ref' then
        select s.value into signing from public.integration_secrets s
        where s.id::text = action ->> 'signing_ref' and s.project_id = r.project_id
          and s.kind = 'signing_secret' and s.deleted_at is null;
      end if;
    else
      secret := settings.webhook_secret;
      select s.value into signing from public.integration_secrets s
      where s.project_id = r.project_id and s.rule_id is null and s.kind = 'signing_secret' and s.deleted_at is null;
$p$,
$p$    channel, project_id, task_id, rule_id, rule_run_id, target_url, target_hint, headers, payload
  )$p$,
$p$    channel, project_id, task_id, rule_id, rule_run_id, target_url, target_hint, headers, payload,
    signing_secret
  )$p$,
$p$    body
  )
  returning id into new_id;$p$,
$p$    body,
    case when length(signing) between 16 and 500 then signing end
  )
  returning id into new_id;$p$);

-- ===== apply chunk: integration_depth_c =====

-- ---------------------------------------------------------------------------
-- Per-action signing secret (call_webhook) and Slack format in rules
-- ---------------------------------------------------------------------------

-- A plain signing_secret key in a call_webhook action is stored like the shared secret and replaced by
-- signing_ref + signing_set: true. "" removes it.
select public.alhc_patch_function('public.stash_rule_integration_secrets()'::regprocedure,
$p$          ('call_webhook', 'secret', 'secret_ref', 'secret_set', 'webhook_secret')
$p$,
$p$          ('call_webhook', 'secret', 'secret_ref', 'secret_set', 'webhook_secret'),
          ('call_webhook', 'signing_secret', 'signing_ref', 'signing_set', 'signing_secret')
$p$,
$p$            if slot.kind = 'webhook_secret' then
              if length(plain) > 500 then
                raise exception 'Call webhook: the shared secret is limited to 500 characters'
                  using errcode = 'check_violation';
              end if;$p$,
$p$            if slot.kind = 'webhook_secret' then
              if length(plain) > 500 then
                raise exception 'Call webhook: the shared secret is limited to 500 characters'
                  using errcode = 'check_violation';
              end if;
            elsif slot.kind = 'signing_secret' then
              if length(plain) not between 16 and 500 then
                raise exception 'Call webhook: a signing secret is 16 to 500 characters'
                  using errcode = 'check_violation';
              end if;$p$,
$p$case when slot.kind = 'webhook_secret' then to_jsonb(true) else to_jsonb(public.integration_url_hint(plain)) end$p$,
$p$case when slot.kind in ('webhook_secret', 'signing_secret') then to_jsonb(true) else to_jsonb(public.integration_url_hint(plain)) end$p$,
$p$case when slot.kind = 'webhook_secret' then to_jsonb(true) else to_jsonb(public.integration_url_hint(secret.value)) end$p$,
$p$case when slot.kind in ('webhook_secret', 'signing_secret') then to_jsonb(true) else to_jsonb(public.integration_url_hint(secret.value)) end$p$,
$p$case when slot.kind = 'webhook_secret' then 'secret' else 'URL' end$p$,
$p$case when slot.kind in ('webhook_secret', 'signing_secret') then 'secret' else 'URL' end$p$);

select public.alhc_patch_function('public.validate_rule()'::regprocedure,
$p$        if item ? 'webhook_url' then
          raise exception 'Send Slack message: webhook URLs are stored separately' using errcode = 'check_violation';$p$,
$p$        if item ? 'format' and coalesce(item ->> 'format', '') not in ('text', 'blocks') then
          raise exception 'Send Slack message: the format is plain text or Block Kit' using errcode = 'check_violation';
        end if;
        if item ? 'webhook_url' then
          raise exception 'Send Slack message: webhook URLs are stored separately' using errcode = 'check_violation';$p$,
$p$        if item ? 'url' or item ? 'secret' then$p$,
$p$        if item ? 'url' or item ? 'secret' or item ? 'signing_secret' then$p$);

-- Templates and Duplicate project never carry a signing secret reference either.
select public.alhc_patch_function('public.project_snapshot(uuid, jsonb)'::regprocedure,
$p$- 'secret_ref' - 'secret_set'$p$,
$p$- 'secret_ref' - 'secret_set' - 'signing_ref' - 'signing_set'$p$);

-- ---------------------------------------------------------------------------
-- Project signing secret (Settings → Integrations, Admin+)
-- ---------------------------------------------------------------------------

select public.alhc_patch_function('public.get_project_integrations(uuid)'::regprocedure,
$p$    'webhook_secret_header', settings.webhook_secret_header,$p$,
$p$    'webhook_secret_header', settings.webhook_secret_header,
    'signing_secret_set', exists (
      select 1 from public.integration_secrets s
      where s.project_id = target_project and s.rule_id is null and s.kind = 'signing_secret' and s.deleted_at is null
    ),
    'signing_secret_created_at', (
      select s.created_at from public.integration_secrets s
      where s.project_id = target_project and s.rule_id is null and s.kind = 'signing_secret' and s.deleted_at is null
    ),$p$);

-- setting signing_secret: stores a new project signing secret (the app generates it and shows it once),
-- retiring the previous one; empty clears it. Rows already queued keep the key they were queued with.
select public.alhc_patch_function('public.set_project_integration(uuid, text, text)'::regprocedure,
$p$  insert into public.project_integrations (project_id, updated_by) values (target_project, auth.uid())$p$,
$p$  if setting = 'signing_secret' and length(v) not between 16 and 500 then
    raise exception 'A signing secret is 16 to 500 characters' using errcode = 'check_violation';
  end if;

  insert into public.project_integrations (project_id, updated_by) values (target_project, auth.uid())$p$,
$p$    else
      raise exception 'Unknown integration setting %'$p$,
$p$    when 'signing_secret' then
      update public.integration_secrets set deleted_at = now()
      where project_id = target_project and rule_id is null and kind = 'signing_secret' and deleted_at is null;
      if v is not null then
        insert into public.integration_secrets (project_id, rule_id, kind, value)
        values (target_project, null, 'signing_secret', v);
      end if;
      update public.project_integrations set updated_by = auth.uid(), deleted_at = null
      where project_id = target_project;
    else
      raise exception 'Unknown integration setting %'$p$);

-- ===== apply chunk: integration_depth_d =====

-- ---------------------------------------------------------------------------
-- Delivery workers: per-row attempt limit and capped exponential backoff
-- ---------------------------------------------------------------------------

select public.alhc_patch_function('public.claim_integration_outbox(integer, uuid)'::regprocedure,
$p$      and c.attempts < 5$p$,
$p$      and c.attempts < c.max_attempts$p$);

select public.alhc_patch_function('public.complete_integration_outbox(uuid, text, jsonb, text)'::regprocedure,
$p$        when attempts >= 5 then 'failed'$p$,
$p$        when attempts >= max_attempts then 'failed'$p$,
$p$else now() + interval '5 minutes' end$p$,
$p$else now() + public.integration_retry_delay(attempts) end$p$);

-- ---------------------------------------------------------------------------
-- Delivery log (Settings → Deliveries, Admin+)
-- ---------------------------------------------------------------------------

-- The project's latest deliveries, newest first. Only what an admin needs to see what happened: the
-- redacted target, status, attempts, the receiver's HTTP status, the drain's error (already redacted,
-- and any URL masked again here), and times. Never the URL, headers, payload, response body, secret, or
-- signature. The task title only when the caller can read the task.
create or replace function public.list_integration_deliveries(target_project uuid, max_results integer default 100)
returns table (
  id uuid,
  channel text,
  task_id uuid,
  task_title text,
  rule_id uuid,
  rule_name text,
  target_hint text,
  status text,
  attempts integer,
  max_attempts integer,
  response_status integer,
  last_error text,
  signed boolean,
  next_attempt_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.has_project_role(target_project, 'admin') then
    raise exception 'Only project admins can see the delivery log' using errcode = 'insufficient_privilege';
  end if;
  return query
  select
    o.id, o.channel, o.task_id,
    case when o.task_id is not null and public.has_task_role(o.task_id, 'viewer') then t.title end,
    o.rule_id, ru.name, o.target_hint, o.status, o.attempts, o.max_attempts,
    case when o.provider_response ->> 'status' ~ '^[0-9]{3}$' then (o.provider_response ->> 'status')::integer end,
    regexp_replace(o.last_error, 'https?://[^[:space:]]+', '[URL]', 'gi'),
    o.signing_secret is not null,
    case when o.status = 'pending' then o.send_after end,
    o.sent_at, o.created_at, o.updated_at
  from public.integration_outbox o
  left join public.tasks t on t.id = o.task_id
  left join public.rules ru on ru.id = o.rule_id
  where o.project_id = target_project and o.deleted_at is null
  order by o.created_at desc, o.id
  limit least(greatest(coalesce(max_results, 100), 1), 200);
end;
$$;

revoke all on function public.list_integration_deliveries(uuid, integer) from public, anon;
grant execute on function public.list_integration_deliveries(uuid, integer) to authenticated;

-- Locks one delivery for an Admin+ action. Non-members learn nothing (no_data_found).
create or replace function public.integration_delivery_for_admin(target_delivery uuid)
returns public.integration_outbox
language plpgsql
set search_path = ''
as $$
declare
  d public.integration_outbox;
begin
  select * into d from public.integration_outbox o
  where o.id = target_delivery and o.deleted_at is null
  for update;
  if d.id is null or public.project_role(d.project_id) is null then
    raise exception 'Delivery not found' using errcode = 'no_data_found';
  end if;
  if not public.has_project_role(d.project_id, 'admin') then
    raise exception 'Only project admins can retry or cancel deliveries' using errcode = 'insufficient_privilege';
  end if;
  return d;
end;
$$;

revoke all on function public.integration_delivery_for_admin(uuid) from public, anon, authenticated;

-- Send a waiting delivery now, or give a failed one one more attempt (10 attempts at most in total).
-- The stored payload, target, headers, and signing secret are reused; the drain picks it up next.
create or replace function public.retry_integration_delivery(target_delivery uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.integration_outbox := public.integration_delivery_for_admin(target_delivery);
begin
  if d.status not in ('pending', 'failed') then
    raise exception 'Only waiting or failed deliveries can be retried' using errcode = 'check_violation';
  end if;
  if d.attempts >= 10 then
    raise exception 'This delivery was already tried 10 times' using errcode = 'check_violation',
      hint = 'Fix the receiver, then trigger the rule again to queue a new delivery.';
  end if;
  update public.integration_outbox o
  set status = 'pending', send_after = now(), max_attempts = greatest(o.max_attempts, o.attempts + 1)
  where o.id = d.id
  returning * into d;
  return jsonb_build_object('id', d.id, 'status', d.status, 'attempts', d.attempts, 'max_attempts', d.max_attempts);
end;
$$;

revoke all on function public.retry_integration_delivery(uuid) from public, anon;
grant execute on function public.retry_integration_delivery(uuid) to authenticated;

-- Stop a delivery that is still waiting to be sent.
create or replace function public.cancel_integration_delivery(target_delivery uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.integration_outbox := public.integration_delivery_for_admin(target_delivery);
begin
  if d.status <> 'pending' then
    raise exception 'Only deliveries that are waiting to be sent can be cancelled' using errcode = 'check_violation';
  end if;
  update public.integration_outbox o set status = 'cancelled' where o.id = d.id returning * into d;
  return jsonb_build_object('id', d.id, 'status', d.status, 'attempts', d.attempts, 'max_attempts', d.max_attempts);
end;
$$;

revoke all on function public.cancel_integration_delivery(uuid) from public, anon;
grant execute on function public.cancel_integration_delivery(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Done
-- ---------------------------------------------------------------------------

drop function public.alhc_patch_function(regprocedure, text[]);
