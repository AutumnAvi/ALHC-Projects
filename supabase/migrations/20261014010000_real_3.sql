-- ALHC Projects — Phase: Real features 3 (email extras).
-- ROADMAP.md section 0 listed three email features with no code yet; this makes them real on the
-- existing pipeline (the email outbox, the app's drain through Resend, the every-minute delivery kick,
-- and the verified Resend webhook). No new sender: every email below is an email_outbox row.
--
--   Inbox email digest. email_preferences (own rows only): Off / Daily / Weekly, a send hour, a weekday
--     for weekly, and the person's time zone (null = never set = Off). A pg_cron job (every 5 minutes,
--     alhc-scheduled-emails → alhc_queue_scheduled_emails) queues one digest per due person through the
--     outbox, listing their unread, unarchived Inbox items since the last digest (the first one looks
--     back one day / one week), checked with that person's own access (the Inbox's read policy, run as
--     them). Empty digests are skipped. digest_last_sent_at records each digest's window end, so an
--     item is never in two digests. At send time the drain claims digests separately
--     (claim_scheduled_emails, service_role) and re-reads the items through digest_email_items(): only
--     items still unread, unarchived, and readable go out; nothing left = not sent. Each digest carries
--     a "Turn off digest" link with the person's unsubscribe token, which email_unsubscribe() (the one
--     new anon-callable function: a token in, digest or report emails off, nothing returned about
--     anyone) honors without a sign-in.
--   Scheduled report emails. report_schedules (owner-only RLS, like personal dashboards): the Reports
--     page's filters (or the All projects report), recipients (people in the workspace, 1–50), daily /
--     weekly on a weekday / monthly on a day, an hour, and the owner's time zone; pause, edit, and
--     remove (soft). The same job builds each recipient's copy as that recipient
--     (report_email_payload sets request.jwt.claim.sub locally, so the report functions' explicit
--     has_project_role checks count only projects they can open), skips recipients who can open none
--     of the report's projects, who left the workspace, who turned report emails off, or whose address
--     is suppressed, and stores the numbers in the outbox row's payload. last_sent_at / next_run_at are
--     the owner's "Last sent" and next run.
--   Bounce and complaint tracking. The verified Resend webhook (/api/inbound/email) now also takes
--     email.delivered, email.delivery_delayed, email.bounced, email.complained, and email.suppressed;
--     record_email_event() (service_role) stores them on the outbox row whose provider_message_id
--     matches (email_outbox.delivery_status / delivery_event_at / delivery_detail; a later, weaker
--     event never overrides a stronger one) and ignores ids we never sent. A permanent bounce, a spam
--     complaint, or Resend's own suppression adds the address to email_suppressions; every claim
--     (asserted patches of claim_email_deliveries, claim_email_outbox, claim_notification_emails, and
--     the new claim) first fails due rows to a suppressed address, so no further email goes to it —
--     the Inbox is unaffected — until a workspace admin clears the entry in Admin console → Email.
--     Workspace admins read the suppression list (list_email_suppressions, clear_email_suppression) and a
--     delivery overview (list_workspace_email_deliveries, workspace_email_summary): recipient, kind,
--     status — never a subject, body, task, or project, and addresses outside the workspace are masked.
--
-- New client surface: four SECURITY DEFINER functions for authenticated (list_workspace_email_deliveries,
-- workspace_email_summary, list_email_suppressions, and clear_email_suppression — workspace admins only;
-- pinned in suite 60) and one for anon
-- (email_unsubscribe; pinned in suites 50, 60, and zz07). record_email_event, digest_email_items,
-- claim_scheduled_emails, and alhc_queue_scheduled_emails are service_role only; every other new
-- definer helper is revoked from client roles. set_email_digest, set_report_emails, and the guards are
-- invoker. fire_rules, notify_with, notify_message, and add_story are untouched. Workspace admins get no
-- project or task data from any of it. Additive: the release still on main keeps working once this is
-- applied (its drains never claim digest or report rows, a suppressed address only fails rows sooner,
-- and nobody gets a digest or report until they set one up). No tail.
--
-- The grant on email_preferences is the last statement: the app treats this release's database features
-- as present once that table is readable.

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
-- Shared: the next local send time of a schedule
-- ---------------------------------------------------------------------------

-- The first moment after `after_time` that is `send_hour`:00 in `zone` (daily), also on `send_weekday`
-- (weekly, 0 = Sunday), or on day `send_month_day` (monthly, 1–28, so every month has it). Null for any
-- other frequency (off). Invoker: used by the guards and the queue.
create or replace function public.email_schedule_next_at(
  frequency text,
  send_hour integer,
  send_weekday integer,
  send_month_day integer,
  zone text,
  after_time timestamptz
)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  tz text := public.safe_timezone(zone);
  local_after timestamp := after_time at time zone public.safe_timezone(zone);
  local_day date := (after_time at time zone public.safe_timezone(zone))::date;
  at_hour interval := make_interval(hours => least(greatest(coalesce(send_hour, 8), 0), 23));
  step interval;
  candidate timestamp;
  result timestamptz;
begin
  if frequency = 'daily' then
    step := interval '1 day';
    candidate := local_day + at_hour;
  elsif frequency = 'weekly' then
    step := interval '7 days';
    candidate := (local_day + ((least(greatest(coalesce(send_weekday, 1), 0), 6) - extract(dow from local_day)::integer + 7) % 7)) + at_hour;
  elsif frequency = 'monthly' then
    step := interval '1 month';
    candidate := make_date(
      extract(year from local_day)::integer,
      extract(month from local_day)::integer,
      least(greatest(coalesce(send_month_day, 1), 1), 28)
    ) + at_hour;
  else
    return null;
  end if;
  if candidate <= local_after then
    candidate := candidate + step;
  end if;
  result := candidate at time zone tz;
  -- A wall-clock time that a clock change skips or repeats can land at or before after_time.
  if result <= after_time then
    result := (candidate + step) at time zone tz;
  end if;
  return result;
end;
$$;

revoke all on function public.email_schedule_next_at(text, integer, integer, integer, text, timestamptz) from public, anon;
grant execute on function public.email_schedule_next_at(text, integer, integer, integer, text, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- Delivery events on the outbox row
-- ---------------------------------------------------------------------------

alter table public.email_outbox add column delivery_status text;
alter table public.email_outbox add column delivery_event_at timestamptz;
alter table public.email_outbox add column delivery_detail text;
alter table public.email_outbox add constraint email_outbox_delivery_status_check
  check (delivery_status in ('delivered', 'delayed', 'bounced', 'complained', 'suppressed'));
alter table public.email_outbox add constraint email_outbox_delivery_detail_check
  check (length(delivery_detail) <= 300);

comment on column public.email_outbox.delivery_status is
  'Real features 3: what Resend reported after sending (delivered, delayed, bounced, complained, or suppressed '
  'by Resend), from the verified webhook. Null = nothing reported yet.';

create index email_outbox_provider_message_idx on public.email_outbox (provider_message_id)
  where provider_message_id is not null;

-- The kind of email a row is, in the words the Admin console uses (never its content).
create or replace function public.email_outbox_kind(o public.email_outbox)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when o.comment_id is not null then 'comment'
    when coalesce(o.payload ->> 'kind', '') in ('invite', 'notification', 'digest', 'report') then o.payload ->> 'kind'
    else o.template
  end;
$$;

revoke all on function public.email_outbox_kind(public.email_outbox) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Suppression list
-- ---------------------------------------------------------------------------

-- Created and locked (RLS on, no client privileges) in one statement; grants come with the policies.
-- outbox_id is a plain reference (no foreign key): the 90-day log purge may remove that outbox row while
-- the suppression stays.
do $do$
begin
  execute $sql$
    create table public.email_suppressions (
      id uuid primary key default gen_random_uuid(),
      email text not null constraint email_suppressions_email_check check (public.is_email(email) and email = lower(email)),
      reason text not null constraint email_suppressions_reason_check check (reason in ('bounced', 'complained', 'suppressed')),
      detail text constraint email_suppressions_detail_check check (length(detail) <= 300),
      email_kind text constraint email_suppressions_kind_check check (length(email_kind) <= 40),
      outbox_id uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      cleared_at timestamptz,
      cleared_by uuid references public.profiles (id)
    )
  $sql$;
  execute 'alter table public.email_suppressions enable row level security';
  execute 'revoke all on public.email_suppressions from anon, authenticated';
end;
$do$;

comment on table public.email_suppressions is
  'Real features 3: addresses that no email goes to (a permanent bounce, a spam complaint, or Resend''s own '
  'suppression, from the verified webhook) until a workspace admin clears the entry (cleared_at). The Inbox '
  'is unaffected. No client access: list_email_suppressions() / clear_email_suppression().';

create unique index email_suppressions_active_idx on public.email_suppressions (email) where cleared_at is null;
create index email_suppressions_email_idx on public.email_suppressions (email, cleared_at);
create index email_suppressions_cleared_by_idx on public.email_suppressions (cleared_by);

create trigger email_suppressions_set_updated_at
  before update on public.email_suppressions
  for each row execute function public.set_updated_at();

-- No client policies or grants (like the integration tables): workspace admins read the list through
-- list_email_suppressions() — addresses outside the workspace masked, like the delivery overview — and
-- clear an entry through clear_email_suppression(); only bounce and complaint reports add entries.

-- Why no email may go to this address now (null = it may). Internal.
create or replace function public.email_suppression_reason(address text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case s.reason
    when 'complained' then 'Not sent: this address marked an earlier email as spam (Admin console → Email)'
    when 'suppressed' then 'Not sent: Resend suppressed this address after earlier bounces (Admin console → Email)'
    else 'Not sent: this address bounced (Admin console → Email)'
  end
  from public.email_suppressions s
  where s.email = lower(btrim(address)) and s.cleared_at is null
  limit 1;
$$;

revoke all on function public.email_suppression_reason(text) from public, anon, authenticated;

-- Every claim runs this first: due rows to a suppressed address fail with the reason instead of
-- being sent (the drain never sees them). Internal.
create or replace function public.fail_suppressed_emails(only_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  failed_count integer;
begin
  update public.email_outbox o
  set status = 'failed', last_error = public.email_suppression_reason(o.to_email)
  where o.deleted_at is null
    and (only_id is null or o.id = only_id)
    and o.send_after <= now()
    and (o.status = 'pending' or (o.status = 'sending' and o.updated_at < now() - interval '10 minutes'))
    and exists (
      select 1 from public.email_suppressions s
      where s.email = lower(btrim(o.to_email)) and s.cleared_at is null
    );
  get diagnostics failed_count = row_count;
  return failed_count;
end;
$$;

revoke all on function public.fail_suppressed_emails(uuid) from public, anon, authenticated;

-- The verified Resend webhook (service_role only): a delivery event for an email we sent. Unknown
-- provider ids (another app's email, or one the log purge has removed) are ignored. A weaker event never
-- replaces a stronger one (delayed < delivered < bounced < suppressed < complained), so retries and
-- out-of-order deliveries are harmless. A permanent bounce, a complaint, or Resend's suppression adds the
-- address to the suppression list, unless an admin cleared it after this event happened (a late retry of
-- an old event doesn't put it back).
create or replace function public.record_email_event(
  provider_email_id text,
  event_type text,
  event_time timestamptz default null,
  bounce_type text default null,
  bounce_subtype text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.email_outbox;
  new_status text := case event_type
    when 'email.delivered' then 'delivered'
    when 'email.delivery_delayed' then 'delayed'
    when 'email.bounced' then 'bounced'
    when 'email.complained' then 'complained'
    when 'email.suppressed' then 'suppressed'
  end;
  ranks text[] := array['delayed', 'delivered', 'bounced', 'suppressed', 'complained'];
  happened timestamptz := least(coalesce(event_time, now()), now());
  detail text;
  suppress text;
  address text;
begin
  if new_status is null then
    return jsonb_build_object('ok', true, 'status', 'ignored');
  end if;
  if provider_email_id is null or provider_email_id !~ '^[A-Za-z0-9_-]{1,100}$' then
    return jsonb_build_object('ok', true, 'status', 'unknown');
  end if;
  select * into o from public.email_outbox x
  where x.provider_message_id = provider_email_id
  order by x.created_at desc
  limit 1
  for update;
  if not found then
    return jsonb_build_object('ok', true, 'status', 'unknown');
  end if;

  detail := case
    when new_status in ('bounced', 'suppressed') then
      nullif(left(concat_ws(' · ', nullif(btrim(bounce_type), ''), nullif(btrim(bounce_subtype), '')), 300), '')
  end;
  if coalesce(array_position(ranks, new_status), 0) >= coalesce(array_position(ranks, o.delivery_status), 0) then
    update public.email_outbox
    set delivery_status = new_status,
        delivery_event_at = happened,
        delivery_detail = case when new_status = o.delivery_status then coalesce(detail, o.delivery_detail) else detail end
    where id = o.id;
  end if;

  suppress := case
    when new_status = 'complained' then 'complained'
    when new_status = 'suppressed' then 'suppressed'
    when new_status = 'bounced' and lower(coalesce(btrim(bounce_type), '')) = 'permanent' then 'bounced'
  end;
  address := lower(btrim(o.to_email));
  if suppress is not null and not exists (
    select 1 from public.email_suppressions s
    where s.email = address and s.cleared_at is not null and s.cleared_at >= happened
  ) then
    insert into public.email_suppressions (email, reason, detail, email_kind, outbox_id, created_at)
    values (address, suppress, detail, public.email_outbox_kind(o), o.id, happened)
    on conflict (email) where cleared_at is null do nothing;
  end if;
  return jsonb_build_object('ok', true, 'status', new_status, 'suppressed', suppress is not null);
end;
$$;

revoke all on function public.record_email_event(text, text, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.record_email_event(text, text, timestamptz, text, text) to service_role;

-- Every existing claim skips suppressed addresses, and none of them takes a digest or report email (the
-- release still on main can't render one; claim_scheduled_emails below does).
select public.alhc_patch_function('public.claim_email_deliveries(integer,uuid)'::regprocedure,
$p$begin
  update public.email_outbox o
  set status = 'failed', last_error = public.comment_email_block_reason(o.id)
$p$,
$p$begin
  perform public.fail_suppressed_emails(only_id);

  update public.email_outbox o
  set status = 'failed', last_error = public.comment_email_block_reason(o.id)
$p$,
$p$      and coalesce(c.payload ->> 'kind', '') <> 'notification'
$p$,
$p$      and coalesce(c.payload ->> 'kind', '') not in ('notification', 'digest', 'report')
$p$);

select public.alhc_patch_function('public.claim_email_outbox(integer,uuid)'::regprocedure,
$p$      and coalesce(c.payload ->> 'kind', '') <> 'notification'
$p$,
$p$      and coalesce(c.payload ->> 'kind', '') not in ('notification', 'digest', 'report')
      and not exists (
        select 1 from public.email_suppressions s
        where s.email = lower(btrim(c.to_email)) and s.cleared_at is null
      )
$p$);

select public.alhc_patch_function('public.claim_notification_emails(integer,uuid)'::regprocedure,
$p$begin
  update public.email_outbox o
  set status = 'failed', last_error = public.notification_email_block_reason(o.id)
$p$,
$p$begin
  perform public.fail_suppressed_emails(only_id);

  update public.email_outbox o
  set status = 'failed', last_error = public.notification_email_block_reason(o.id)
$p$);

-- ---------------------------------------------------------------------------
-- Admin console → Email: delivery overview (workspace admins; never content)
-- ---------------------------------------------------------------------------

-- j•••@example.com: an address outside the workspace, enough to recognize, not to read off.
create or replace function public.mask_email(address text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when position('@' in coalesce(address, '')) > 1
      then left(address, 1) || '•••' || substr(address, position('@' in address))
    else '•••'
  end;
$$;

revoke all on function public.mask_email(text) from public, anon, authenticated;

-- The latest emails of every kind: who (an address in the workspace; others masked), what kind, the
-- send status and what Resend reported. Never a subject, body, payload, task, or project, so being a
-- workspace admin opens nothing of a private project. Errors are shown for workspace addresses and for
-- the app's own "Not sent: …" reasons only.
create or replace function public.list_workspace_email_deliveries(max_results integer default 100)
returns table (
  id uuid,
  kind text,
  recipient text,
  in_workspace boolean,
  status text,
  delivery_status text,
  delivery_detail text,
  attempts integer,
  max_attempts integer,
  last_error text,
  created_at timestamptz,
  sent_at timestamptz,
  delivery_event_at timestamptz,
  suppressed boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.is_workspace_admin() then
    raise exception 'Only workspace admins can see the workspace''s emails' using errcode = 'insufficient_privilege';
  end if;
  return query
  select
    o.id,
    public.email_outbox_kind(o),
    case when k.known then lower(o.to_email) else public.mask_email(lower(o.to_email)) end,
    k.known,
    o.status,
    o.delivery_status,
    o.delivery_detail,
    o.attempts,
    o.max_attempts,
    case when k.known or o.last_error like 'Not sent:%' then left(o.last_error, 300) end,
    o.created_at,
    o.sent_at,
    o.delivery_event_at,
    exists (
      select 1 from public.email_suppressions s where s.email = lower(btrim(o.to_email)) and s.cleared_at is null
    )
  from public.email_outbox o
  cross join lateral (
    select exists (select 1 from public.allowed_emails a where a.email = lower(btrim(o.to_email))) as known
  ) k
  where o.deleted_at is null
  order by o.created_at desc, o.id
  limit least(greatest(coalesce(max_results, 100), 1), 200);
end;
$$;

revoke all on function public.list_workspace_email_deliveries(integer) from public, anon;
grant execute on function public.list_workspace_email_deliveries(integer) to authenticated;

-- Counts for the last N days (1–90): sent, delivered, delayed, bounced (incl. Resend's suppression),
-- complained, failed before sending, still waiting, and the addresses on the suppression list now.
create or replace function public.workspace_email_summary(window_days integer default 30)
returns table (
  sent bigint,
  delivered bigint,
  delayed bigint,
  bounced bigint,
  complained bigint,
  failed bigint,
  waiting bigint,
  suppressed_addresses bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_workspace_admin() then
    raise exception 'Only workspace admins can see the workspace''s emails' using errcode = 'insufficient_privilege';
  end if;
  return query
  select
    count(*) filter (where o.status = 'sent'),
    count(*) filter (where o.delivery_status = 'delivered'),
    count(*) filter (where o.delivery_status = 'delayed'),
    count(*) filter (where o.delivery_status in ('bounced', 'suppressed')),
    count(*) filter (where o.delivery_status = 'complained'),
    count(*) filter (where o.status = 'failed'),
    count(*) filter (where o.status in ('pending', 'sending')),
    (select count(*) from public.email_suppressions s where s.cleared_at is null)
  from public.email_outbox o
  where o.deleted_at is null
    and o.created_at >= now() - make_interval(days => least(greatest(coalesce(window_days, 30), 1), 90));
end;
$$;

revoke all on function public.workspace_email_summary(integer) from public, anon;
grant execute on function public.workspace_email_summary(integer) to authenticated;

-- The suppression list (workspace admins): active entries, newest first, with addresses outside the
-- workspace masked — never the email's subject, task, or project.
create or replace function public.list_email_suppressions()
returns table (
  id uuid,
  email text,
  in_workspace boolean,
  reason text,
  detail text,
  email_kind text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.is_workspace_admin() then
    raise exception 'Only workspace admins can see the suppression list' using errcode = 'insufficient_privilege';
  end if;
  return query
  select s.id,
         case when k.known then s.email else public.mask_email(s.email) end,
         k.known,
         s.reason, s.detail, s.email_kind, s.created_at
  from public.email_suppressions s
  cross join lateral (
    select exists (select 1 from public.allowed_emails a where a.email = s.email) as known
  ) k
  where s.cleared_at is null
  order by s.created_at desc, s.id
  limit 500;
end;
$$;

revoke all on function public.list_email_suppressions() from public, anon;
grant execute on function public.list_email_suppressions() to authenticated;

-- A workspace admin lets email go to a suppressed address again (stamped now, by them). Resend keeps its
-- own list for addresses it suppressed; the Admin console says so.
create or replace function public.clear_email_suppression(target_suppression uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_workspace_admin() then
    raise exception 'Only workspace admins can clear an address' using errcode = 'insufficient_privilege';
  end if;
  update public.email_suppressions
  set cleared_at = now(), cleared_by = auth.uid()
  where id = target_suppression and cleared_at is null;
  if not found then
    raise exception 'That address isn''t on the suppression list' using errcode = 'no_data_found';
  end if;
end;
$$;

revoke all on function public.clear_email_suppression(uuid) from public, anon;
grant execute on function public.clear_email_suppression(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Email preferences: the Inbox digest, report emails, and the unsubscribe token
-- ---------------------------------------------------------------------------

do $do$
begin
  execute $sql$
    create table public.email_preferences (
      profile_id uuid primary key default auth.uid() references public.profiles (id),
      digest text not null default 'off' constraint email_preferences_digest_check check (digest in ('off', 'daily', 'weekly')),
      digest_hour integer not null default 8 constraint email_preferences_digest_hour_check check (digest_hour between 0 and 23),
      digest_weekday integer not null default 1 constraint email_preferences_digest_weekday_check check (digest_weekday between 0 and 6),
      time_zone text not null default 'UTC' constraint email_preferences_time_zone_check check (char_length(time_zone) between 1 and 100),
      report_emails boolean not null default true,
      unsubscribe_token text not null constraint email_preferences_token_check check (unsubscribe_token ~ '^[0-9a-f]{64}$'),
      digest_next_at timestamptz,
      digest_last_sent_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint email_preferences_token_key unique (unsubscribe_token)
    )
  $sql$;
  execute 'alter table public.email_preferences enable row level security';
  execute 'revoke all on public.email_preferences from anon, authenticated';
end;
$do$;

comment on table public.email_preferences is
  'Real features 3: a person''s Inbox email digest (off / daily / weekly at an hour in their time zone), whether '
  'they get scheduled report emails, and the token behind the emails'' one-click "Turn off" links. Own rows '
  'only; no row = digest off, report emails on.';

create index email_preferences_digest_due_idx on public.email_preferences (digest_next_at) where digest <> 'off';

create trigger email_preferences_set_updated_at
  before update on public.email_preferences
  for each row execute function public.set_updated_at();

-- Runs as the caller: a row is the writer's own, its token is generated here (never chosen or changed),
-- and the next digest time follows the schedule.
create or replace function public.guard_email_preferences()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if public.is_client_role() then
      new.profile_id := auth.uid();
      new.created_at := now();
      new.digest_last_sent_at := null;
    end if;
    new.unsubscribe_token := public.inbound_random_hex();
  elsif public.is_client_role() and (
    new.profile_id <> old.profile_id
    or new.unsubscribe_token <> old.unsubscribe_token
    or new.created_at <> old.created_at
    or new.digest_last_sent_at is distinct from old.digest_last_sent_at
  ) then
    raise exception 'Only your email settings can change' using errcode = 'insufficient_privilege';
  end if;
  new.time_zone := public.safe_timezone(new.time_zone);
  if tg_op = 'INSERT'
     or new.digest is distinct from old.digest
     or new.digest_hour is distinct from old.digest_hour
     or new.digest_weekday is distinct from old.digest_weekday
     or new.time_zone is distinct from old.time_zone then
    new.digest_next_at := case
      when new.digest = 'off' then null
      else public.email_schedule_next_at(new.digest, new.digest_hour, new.digest_weekday, 1, new.time_zone, now())
    end;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_email_preferences() from public, anon;
grant execute on function public.guard_email_preferences() to authenticated;

create trigger email_preferences_05_guard
  before insert or update on public.email_preferences
  for each row execute function public.guard_email_preferences();

create policy email_preferences_select_own on public.email_preferences
  for select to authenticated
  using (profile_id = (select auth.uid()) and (select public.is_allowlisted()));
create policy email_preferences_insert_own on public.email_preferences
  for insert to authenticated
  with check (profile_id = (select auth.uid()) and (select public.is_allowlisted()));
create policy email_preferences_update_own on public.email_preferences
  for update to authenticated
  using (profile_id = (select auth.uid()) and (select public.is_allowlisted()))
  with check (profile_id = (select auth.uid()) and (select public.is_allowlisted()));

grant insert (profile_id, digest, digest_hour, digest_weekday, time_zone, report_emails) on public.email_preferences to authenticated;
grant update (digest, digest_hour, digest_weekday, time_zone, report_emails) on public.email_preferences to authenticated;

-- Settings → Notifications → Email digest: off / daily / weekly, the hour (0–23) and weekday (0 = Sunday)
-- in `zone` (the browser's time zone). Returns when the next digest is due (null = off). Invoker: RLS
-- keeps it to the caller's own row.
create or replace function public.set_email_digest(frequency text, send_hour integer, send_weekday integer, zone text)
returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  next_at timestamptz;
begin
  if auth.uid() is null or not public.is_allowlisted() then
    raise exception 'Sign in again to change your email digest' using errcode = 'insufficient_privilege';
  end if;
  if frequency is null or frequency not in ('off', 'daily', 'weekly') then
    raise exception 'Choose Off, Daily, or Weekly' using errcode = 'check_violation';
  end if;
  if send_hour is null or send_hour not between 0 and 23 then
    raise exception 'Choose an hour of the day' using errcode = 'check_violation';
  end if;
  if send_weekday is null or send_weekday not between 0 and 6 then
    raise exception 'Choose a day of the week' using errcode = 'check_violation';
  end if;
  insert into public.email_preferences (profile_id, digest, digest_hour, digest_weekday, time_zone)
  values (auth.uid(), frequency, send_hour, send_weekday, coalesce(nullif(btrim(zone), ''), 'UTC'))
  on conflict (profile_id) do update
    set digest = excluded.digest,
        digest_hour = excluded.digest_hour,
        digest_weekday = excluded.digest_weekday,
        time_zone = excluded.time_zone
  returning digest_next_at into next_at;
  return next_at;
end;
$$;

revoke all on function public.set_email_digest(text, integer, integer, text) from public, anon;
grant execute on function public.set_email_digest(text, integer, integer, text) to authenticated;

-- Settings → Notifications: whether scheduled report emails reach you at all. Invoker.
create or replace function public.set_report_emails(enabled boolean)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_allowlisted() then
    raise exception 'Sign in again to change your email settings' using errcode = 'insufficient_privilege';
  end if;
  if enabled is null then
    raise exception 'Choose on or off' using errcode = 'check_violation';
  end if;
  insert into public.email_preferences (profile_id, report_emails)
  values (auth.uid(), enabled)
  on conflict (profile_id) do update set report_emails = excluded.report_emails;
end;
$$;

revoke all on function public.set_report_emails(boolean) from public, anon;
grant execute on function public.set_report_emails(boolean) to authenticated;

-- The one-click "Turn off" links in digest and report emails (no sign-in): the token from the email
-- turns that person's digest ('digest') or report emails ('reports') off. Anon only (the public
-- /email/off page posts here with the anon key). Narrow: it changes one switch, reveals nothing (not
-- whose token it is), and an unknown or malformed token is just "unknown".
create or replace function public.email_unsubscribe(unsubscribe_token text, what text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  token text := lower(btrim(coalesce(unsubscribe_token, '')));
  pref public.email_preferences;
begin
  if token !~ '^[0-9a-f]{64}$' or what is null or what not in ('digest', 'reports') then
    return jsonb_build_object('ok', false, 'status', 'unknown');
  end if;
  select * into pref from public.email_preferences p where p.unsubscribe_token = token for update;
  if not found then
    return jsonb_build_object('ok', false, 'status', 'unknown');
  end if;
  if what = 'digest' then
    if pref.digest = 'off' then
      return jsonb_build_object('ok', true, 'status', 'already_off');
    end if;
    update public.email_preferences set digest = 'off' where profile_id = pref.profile_id;
  else
    if not pref.report_emails then
      return jsonb_build_object('ok', true, 'status', 'already_off');
    end if;
    update public.email_preferences set report_emails = false where profile_id = pref.profile_id;
  end if;
  return jsonb_build_object('ok', true, 'status', 'off');
end;
$$;

revoke all on function public.email_unsubscribe(text, text) from public, anon, authenticated;
grant execute on function public.email_unsubscribe(text, text) to anon;

-- A person's preferences row, made with the defaults when they have none (definer callers only: the
-- queue needs every recipient's unsubscribe token). Internal.
create or replace function public.ensure_email_preferences(target_profile uuid)
returns public.email_preferences
language plpgsql
security definer
set search_path = ''
as $$
declare
  pref public.email_preferences;
begin
  insert into public.email_preferences (profile_id) values (target_profile)
  on conflict (profile_id) do nothing;
  select * into pref from public.email_preferences p where p.profile_id = target_profile;
  return pref;
end;
$$;

revoke all on function public.ensure_email_preferences(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The Inbox digest
-- ---------------------------------------------------------------------------

-- The Inbox's read rule (inbox_items_select_own_viewer) for one item, for whoever auth.uid() is: the
-- digest code sets that to the recipient first. Hidden as well: items whose task is in the Trash or
-- whose comment or message was removed. Internal.
create or replace function public.inbox_item_readable(item public.inbox_items)
returns boolean
language sql
stable
set search_path = ''
as $$
  select item.recipient_id = auth.uid()
    and (
      (item.task_id is not null
        and public.has_task_role(item.task_id, 'viewer')
        and exists (select 1 from public.tasks t where t.id = item.task_id and t.deleted_at is null)
        and not exists (select 1 from public.comments c where c.id = item.comment_id and c.deleted_at is not null))
      or (item.task_id is null and exists (
        select 1 from public.project_messages m
        where m.id = item.message_id and m.deleted_at is null and public.has_project_role(m.project_id, 'viewer')
      ))
      or (item.task_id is null and exists (
        select 1 from public.team_messages m
        where m.id = item.team_message_id and m.deleted_at is null and public.can_read_team(m.team_id)
      ))
      or (item.task_id is null and exists (
        select 1 from public.project_status_updates u
        where u.id = item.status_update_id and public.has_project_role(u.project_id, 'viewer')
      ))
    );
$$;

revoke all on function public.inbox_item_readable(public.inbox_items) from public, anon, authenticated;

-- One digest line's parts for a recipient: who, the title, where (the group it's listed under: the
-- recipient's project for the task, the project, or the team), a link path, and a short excerpt. The
-- caller has checked that the recipient can read the item. Internal.
create or replace function public.inbox_item_email_parts(item public.inbox_items, recipient uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_name text;
  item_title text;
  group_key text;
  group_label text;
  link text;
  detail text;
  target_project uuid;
  t public.tasks;
  pm public.project_messages;
  tm public.team_messages;
  su public.project_status_updates;
begin
  actor_name := coalesce(
    (select coalesce(nullif(trim(p.full_name), ''), p.email) from public.profiles p where p.id = item.actor_id),
    case when nullif(item.data ->> 'rule_name', '') is not null then 'Rule “' || (item.data ->> 'rule_name') || '”' end,
    'Someone'
  );
  if item.task_id is not null then
    select * into t from public.tasks x where x.id = item.task_id;
    item_title := t.title;
    target_project := public.comment_email_project(recipient, t.id);
    group_key := coalesce('project:' || target_project, 'private');
    group_label := coalesce((select pr.name from public.projects pr where pr.id = target_project), 'Private tasks (My tasks)');
    link := case
      when target_project is null then '/my-tasks?task=' || t.id
      else '/projects/' || target_project || '?task=' || t.id
    end;
    detail := coalesce(
      (select c.body from public.comments c where c.id = item.comment_id and c.deleted_at is null),
      item.data ->> 'message', item.data ->> 'note', item.data ->> 'value_text'
    );
  elsif item.message_id is not null then
    select * into pm from public.project_messages x where x.id = item.message_id;
    item_title := (select coalesce(m.title, 'Message') from public.project_messages m where m.id = coalesce(pm.thread_id, pm.id));
    group_key := 'project:' || pm.project_id;
    group_label := (select pr.name from public.projects pr where pr.id = pm.project_id);
    link := '/projects/' || pm.project_id || '/messages/' || coalesce(pm.thread_id, pm.id) || '#message-' || pm.id;
    detail := pm.body;
  elsif item.team_message_id is not null then
    select * into tm from public.team_messages x where x.id = item.team_message_id;
    item_title := (select coalesce(m.title, 'Message') from public.team_messages m where m.id = coalesce(tm.thread_id, tm.id));
    group_key := 'team:' || tm.team_id;
    group_label := (select 'Team: ' || te.name from public.teams te where te.id = tm.team_id);
    link := '/teams/' || tm.team_id || '/messages/' || coalesce(tm.thread_id, tm.id) || '#message-' || tm.id;
    detail := tm.body;
  elsif item.status_update_id is not null then
    select * into su from public.project_status_updates x where x.id = item.status_update_id;
    item_title := (select pr.name from public.projects pr where pr.id = su.project_id);
    group_key := 'project:' || su.project_id;
    group_label := item_title;
    link := '/projects/' || su.project_id || '/overview';
    detail := coalesce(su.title, su.note);
  end if;
  return jsonb_strip_nulls(jsonb_build_object(
    'actor_name', actor_name,
    'title', left(item_title, 300),
    'group_key', group_key,
    'group_label', left(coalesce(group_label, 'Other'), 200),
    'path', link,
    'detail', left(regexp_replace(detail, '\s+', ' ', 'g'), 200)
  ));
end;
$$;

revoke all on function public.inbox_item_email_parts(public.inbox_items, uuid) from public, anon, authenticated;

-- A queued digest's items as they stand now (service_role, for the drain; also the send-time check):
-- only those still unread, unarchived, and readable by the recipient, newest first, each with its
-- line's parts. Runs the read rule as the recipient (request.jwt.claim.sub, set locally and restored).
create or replace function public.digest_email_items(target_email uuid)
returns table (item_id uuid, kind text, data jsonb, created_at timestamptz, parts jsonb)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  o public.email_outbox;
  previous_sub text;
begin
  select * into o from public.email_outbox x where x.id = target_email and x.payload ->> 'kind' = 'digest';
  if not found or o.to_profile_id is null or jsonb_typeof(o.payload -> 'item_ids') <> 'array' then
    return;
  end if;
  previous_sub := current_setting('request.jwt.claim.sub', true);
  perform set_config('request.jwt.claim.sub', o.to_profile_id::text, true);
  return query
  select i.id, i.kind, i.data, i.created_at, public.inbox_item_email_parts(i, o.to_profile_id)
  from public.inbox_items i
  where i.recipient_id = o.to_profile_id
    and (o.payload -> 'item_ids') ? i.id::text
    and i.read_at is null
    and i.archived_at is null
    and public.inbox_item_readable(i)
  order by i.created_at desc, i.id;
  perform set_config('request.jwt.claim.sub', coalesce(previous_sub, ''), true);
end;
$$;

revoke all on function public.digest_email_items(uuid) from public, anon, authenticated;
grant execute on function public.digest_email_items(uuid) to service_role;

-- The send-time check's cheap twin of digest_email_items(): is anything in the digest still unread,
-- unarchived, and readable by the recipient? Internal.
create or replace function public.digest_has_items(target_email uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.email_outbox;
  previous_sub text;
  found_one boolean;
begin
  select * into o from public.email_outbox x where x.id = target_email and x.payload ->> 'kind' = 'digest';
  if not found or o.to_profile_id is null or jsonb_typeof(o.payload -> 'item_ids') <> 'array' then
    return false;
  end if;
  previous_sub := current_setting('request.jwt.claim.sub', true);
  perform set_config('request.jwt.claim.sub', o.to_profile_id::text, true);
  select exists (
    select 1 from public.inbox_items i
    where i.recipient_id = o.to_profile_id
      and (o.payload -> 'item_ids') ? i.id::text
      and i.read_at is null
      and i.archived_at is null
      and public.inbox_item_readable(i)
  ) into found_one;
  perform set_config('request.jwt.claim.sub', coalesce(previous_sub, ''), true);
  return found_one;
end;
$$;

revoke all on function public.digest_has_items(uuid) from public, anon, authenticated;

-- The send-time check for a report copy: can the recipient still open every project it names (its table
-- and its overdue list)? Internal.
create or replace function public.report_copy_still_readable(target_email uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.email_outbox;
  previous_sub text;
  readable boolean;
begin
  select * into o from public.email_outbox x where x.id = target_email and x.payload ->> 'kind' = 'report';
  if not found or o.to_profile_id is null then
    return false;
  end if;
  previous_sub := current_setting('request.jwt.claim.sub', true);
  perform set_config('request.jwt.claim.sub', o.to_profile_id::text, true);
  select not exists (
    select 1
    from (
      select p ->> 'id' as project_id from jsonb_array_elements(coalesce(o.payload -> 'projects', '[]'::jsonb)) p
      union
      select d ->> 'project_id' from jsonb_array_elements(coalesce(o.payload -> 'overdue', '[]'::jsonb)) d
    ) ids
    where ids.project_id is null
       or ids.project_id !~ '^[0-9a-f-]{36}$'
       or not public.has_project_role(ids.project_id::uuid, 'viewer')
  ) into readable;
  perform set_config('request.jwt.claim.sub', coalesce(previous_sub, ''), true);
  return readable;
end;
$$;

revoke all on function public.report_copy_still_readable(uuid) from public, anon, authenticated;

-- Queues every due digest (internal; from alhc_queue_scheduled_emails). The window is (the last
-- digest's end, or one day / one week back for the first; at most 31 days) → two minutes ago; the items are the
-- recipient's unread, unarchived Inbox items in it that they can still read (at most 100 listed, all
-- counted). Nothing to list = nothing queued. Either way the next digest time moves on. Rows are locked
-- with skip-locked, so overlapping runs never queue a digest twice.
create or replace function public.queue_digest_emails()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  pref public.email_preferences;
  person public.profiles;
  next_at timestamptz;
  window_start timestamptz;
  window_end timestamptz;
  previous_sub text;
  ids jsonb;
  total integer;
  queued integer := 0;
begin
  for pref in
    select * from public.email_preferences p
    where p.digest <> 'off' and p.digest_next_at <= now()
    order by p.digest_next_at
    limit 500
    for update skip locked
  loop
    next_at := public.email_schedule_next_at(pref.digest, pref.digest_hour, pref.digest_weekday, 1, pref.time_zone, now());
    select * into person from public.profiles p where p.id = pref.profile_id;
    if not found
       or not public.profile_is_allowlisted(person.id)
       or not public.is_email(lower(person.email))
       or public.email_suppression_reason(person.email) is not null then
      update public.email_preferences set digest_next_at = next_at where profile_id = pref.profile_id;
      continue;
    end if;

    -- Two minutes behind: an item written by a transaction still running now (a long bulk edit) is
    -- stamped with that transaction's start, so it lands in the next window instead of being missed.
    window_end := now() - interval '2 minutes';
    window_start := greatest(
      coalesce(pref.digest_last_sent_at, window_end - case pref.digest when 'weekly' then interval '7 days' else interval '1 day' end),
      window_end - interval '31 days'
    );
    previous_sub := current_setting('request.jwt.claim.sub', true);
    -- As the recipient, in a subtransaction: a failure skips this person (and undoes the setting).
    begin
      perform set_config('request.jwt.claim.sub', person.id::text, true);
      select count(*)::integer,
             coalesce(jsonb_agg(x.id) filter (where x.n <= 100), '[]'::jsonb)
        into total, ids
      from (
        select i.id, row_number() over (order by i.created_at desc, i.id) as n
        from public.inbox_items i
        where i.recipient_id = person.id
          and i.read_at is null
          and i.archived_at is null
          and i.created_at > window_start
          and i.created_at <= window_end
          and public.inbox_item_readable(i)
      ) x;
      perform set_config('request.jwt.claim.sub', coalesce(previous_sub, ''), true);
    exception when others then
      total := 0;
    end;

    if total = 0 then
      update public.email_preferences set digest_next_at = next_at where profile_id = pref.profile_id;
      continue;
    end if;

    insert into public.email_outbox (task_id, to_email, template, subject, payload, to_profile_id)
    values (
      null,
      lower(person.email),
      'custom',
      null,
      jsonb_build_object(
        'kind', 'digest',
        'frequency', pref.digest,
        'item_ids', ids,
        'total', total,
        'window_start', window_start,
        'window_end', window_end,
        'time_zone', pref.time_zone,
        'unsubscribe_token', pref.unsubscribe_token
      ),
      person.id
    );
    update public.email_preferences
    set digest_next_at = next_at, digest_last_sent_at = window_end
    where profile_id = pref.profile_id;
    queued := queued + 1;
  end loop;
  return queued;
end;
$$;

revoke all on function public.queue_digest_emails() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Scheduled report emails
-- ---------------------------------------------------------------------------

do $do$
begin
  execute $sql$
    create table public.report_schedules (
      id uuid primary key default gen_random_uuid(),
      workspace_id uuid not null references public.workspaces (id),
      owner_id uuid not null default auth.uid() references public.profiles (id),
      name text not null constraint report_schedules_name_check check (char_length(btrim(name)) between 1 and 100),
      report text not null default 'overview' constraint report_schedules_report_check check (report in ('overview', 'projects')),
      filters jsonb not null default '{}'::jsonb,
      frequency text not null constraint report_schedules_frequency_check check (frequency in ('daily', 'weekly', 'monthly')),
      weekday integer not null default 1 constraint report_schedules_weekday_check check (weekday between 0 and 6),
      month_day integer not null default 1 constraint report_schedules_month_day_check check (month_day between 1 and 28),
      send_hour integer not null default 8 constraint report_schedules_send_hour_check check (send_hour between 0 and 23),
      time_zone text not null default 'UTC' constraint report_schedules_time_zone_check check (char_length(time_zone) between 1 and 100),
      recipients uuid[] not null constraint report_schedules_recipients_check check (cardinality(recipients) between 1 and 50),
      paused_at timestamptz,
      next_run_at timestamptz,
      last_run_at timestamptz,
      last_sent_at timestamptz,
      last_sent_count integer,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted_at timestamptz
    )
  $sql$;
  execute 'alter table public.report_schedules enable row level security';
  execute 'revoke all on public.report_schedules from anon, authenticated';
end;
$do$;

comment on table public.report_schedules is
  'Real features 3: a person''s scheduled report email (the Reports page''s filters or the All projects report), '
  'sent to people in the workspace, each built with that recipient''s own access. Owner-only RLS.';

create index report_schedules_owner_idx on public.report_schedules (owner_id, created_at);
create index report_schedules_workspace_idx on public.report_schedules (workspace_id);
create index report_schedules_due_idx on public.report_schedules (next_run_at)
  where deleted_at is null and paused_at is null;

create trigger report_schedules_set_updated_at
  before update on public.report_schedules
  for each row execute function public.set_updated_at();

-- Runs as the caller: the owner, workspace, and creation time are fixed; a person has at most 25 active
-- schedules; recipients are people in the workspace (checked when they change); the filter is a valid report filter whose "me" means the owner
-- (never each recipient); a removed schedule stays removed; the next run follows the schedule and is
-- cleared while paused.
create or replace function public.guard_report_schedule()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  person uuid;
  assignees jsonb;
begin
  if public.is_client_role() then
    if tg_op = 'INSERT' then
      new.owner_id := auth.uid();
      new.created_at := now();
      new.deleted_at := null;
      new.workspace_id := (
        select w.id from public.workspaces w where w.deleted_at is null order by w.created_at, w.id limit 1
      );
      if new.workspace_id is null then
        raise exception 'Workspace not found' using errcode = 'no_data_found';
      end if;
      if (select count(*) from public.report_schedules r where r.owner_id = auth.uid() and r.deleted_at is null) >= 25 then
        raise exception 'You can have up to 25 scheduled report emails' using errcode = 'check_violation';
      end if;
    else
      if new.owner_id <> old.owner_id or new.workspace_id <> old.workspace_id or new.created_at <> old.created_at then
        raise exception 'Only the schedule''s settings can change' using errcode = 'insufficient_privilege';
      end if;
      if old.deleted_at is not null then
        raise exception 'This schedule was removed' using errcode = 'check_violation';
      end if;
    end if;
    if new.paused_at is not null and (tg_op = 'INSERT' or old.paused_at is null) then
      new.paused_at := now();
    end if;
    if new.deleted_at is not null then
      new.deleted_at := now();
    end if;
  end if;

  new.name := btrim(new.name);
  new.time_zone := public.safe_timezone(new.time_zone);

  if tg_op = 'INSERT' or new.filters is distinct from old.filters or new.report is distinct from old.report then
    if new.report = 'projects' or jsonb_typeof(new.filters) <> 'object' then
      new.filters := '{}'::jsonb;
    end if;
    assignees := new.filters -> 'assignees';
    if jsonb_typeof(assignees) = 'array' and assignees @> '["me"]'::jsonb then
      new.filters := jsonb_set(new.filters, '{assignees}', (
        select coalesce(jsonb_agg(distinct case when a = '"me"'::jsonb then to_jsonb(new.owner_id) else a end), '[]'::jsonb)
        from jsonb_array_elements(assignees) a
      ));
    end if;
    perform public.validate_report_filters(new.filters);
    -- Only projects the owner can open (so a schedule never probes who can open a project they can't).
    if public.is_client_role() and exists (
      select 1 from jsonb_array_elements_text(coalesce(new.filters -> 'projects', '[]'::jsonb)) p
      where not public.has_project_role(p::uuid, 'viewer')
    ) then
      raise exception 'Project not found' using errcode = 'no_data_found';
    end if;
  end if;

  if tg_op = 'INSERT' or new.recipients is distinct from old.recipients then
    new.recipients := (select array_agg(distinct r order by r) from unnest(new.recipients) r where r is not null);
    if coalesce(cardinality(new.recipients), 0) = 0 then
      raise exception 'Add at least one recipient' using errcode = 'check_violation';
    end if;
    foreach person in array new.recipients loop
      if not public.profile_in_workspace(person) then
        raise exception 'Recipients must be people in this workspace' using errcode = 'check_violation';
      end if;
    end loop;
  end if;

  if new.deleted_at is not null or new.paused_at is not null then
    new.next_run_at := null;
  elsif tg_op = 'INSERT'
     or new.frequency is distinct from old.frequency
     or new.weekday is distinct from old.weekday
     or new.month_day is distinct from old.month_day
     or new.send_hour is distinct from old.send_hour
     or new.time_zone is distinct from old.time_zone
     or old.paused_at is not null
     or old.next_run_at is null then
    new.next_run_at := public.email_schedule_next_at(
      new.frequency, new.send_hour, new.weekday, new.month_day, new.time_zone, now()
    );
  end if;
  return new;
end;
$$;

revoke all on function public.guard_report_schedule() from public, anon;
grant execute on function public.guard_report_schedule() to authenticated;

create trigger report_schedules_05_guard
  before insert or update on public.report_schedules
  for each row execute function public.guard_report_schedule();

create policy report_schedules_select_own on public.report_schedules
  for select to authenticated
  using (owner_id = (select auth.uid()) and (select public.is_allowlisted()));
create policy report_schedules_insert_own on public.report_schedules
  for insert to authenticated
  with check (owner_id = (select auth.uid()) and (select public.is_allowlisted()));
create policy report_schedules_update_own on public.report_schedules
  for update to authenticated
  using (owner_id = (select auth.uid()) and (select public.is_allowlisted()))
  with check (owner_id = (select auth.uid()) and (select public.is_allowlisted()));

grant select on public.report_schedules to authenticated;
grant insert (name, report, filters, frequency, weekday, month_day, send_hour, time_zone, recipients, paused_at)
  on public.report_schedules to authenticated;
grant update (name, report, filters, frequency, weekday, month_day, send_hour, time_zone, recipients, paused_at, deleted_at)
  on public.report_schedules to authenticated;

-- The filter in words, for whoever auth.uid() is (the queue sets it to the recipient): only projects
-- they can open are named, the rest are a count. Mirrors describeReportFilters() in src/lib/reports.ts.
-- Internal.
create or replace function public.report_filter_summary(filters jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  f jsonb := case when jsonb_typeof(filters) = 'object' then filters else '{}'::jsonb end;
  parts jsonb := '[]'::jsonb;
  names text;
  listed integer;
  readable integer;
begin
  if jsonb_typeof(f -> 'projects') = 'array' and jsonb_array_length(f -> 'projects') > 0 then
    listed := jsonb_array_length(f -> 'projects');
    select string_agg(pr.name, ', ' order by pr.name), count(*)
      into names, readable
    from public.projects pr
    where pr.deleted_at is null
      and (f -> 'projects') @> jsonb_build_array(pr.id)
      and public.has_project_role(pr.id, 'viewer');
    parts := parts || to_jsonb('Projects: ' || concat_ws(', ',
      names,
      case when listed - readable > 0 then (listed - readable) || ' you can’t open' end
    ));
  end if;
  if jsonb_typeof(f -> 'assignees') = 'array' and jsonb_array_length(f -> 'assignees') > 0 then
    parts := parts || to_jsonb('Assignees: ' || (
      select string_agg(
        case
          when a = 'null'::jsonb then 'Unassigned'
          else coalesce((select coalesce(nullif(trim(p.full_name), ''), p.email) from public.profiles p where p.id::text = a #>> '{}'), 'Former member')
        end, ', ')
      from jsonb_array_elements(f -> 'assignees') a
    ));
  end if;
  if jsonb_typeof(f -> 'tags') = 'array' and jsonb_array_length(f -> 'tags') > 0 then
    parts := parts || to_jsonb('Tags: ' || (
      select string_agg(coalesce((select t.name from public.tags t where t.id::text = a #>> '{}' and t.deleted_at is null), 'Removed tag'), ', ')
      from jsonb_array_elements(f -> 'tags') a
    ));
  end if;
  if f ? 'from' or f ? 'to' then
    parts := parts || to_jsonb('Due or completed ' || coalesce(f ->> 'from', '…') || ' – ' || coalesce(f ->> 'to', '…'));
  end if;
  if coalesce(f ->> 'status', 'all') <> 'all' then
    parts := parts || to_jsonb('Status: ' || case f ->> 'status' when 'open' then 'Open' when 'completed' then 'Completed' else 'Overdue' end);
  end if;
  if f -> 'include_subtasks' = 'true'::jsonb then
    parts := parts || to_jsonb('Subtasks included'::text);
  end if;
  return parts;
end;
$$;

revoke all on function public.report_filter_summary(jsonb) from public, anon, authenticated;

-- One recipient's copy of a scheduled report, built as that recipient: request.jwt.claim.sub is set to
-- them (locally, restored before returning), so the report functions' explicit has_project_role checks
-- count only projects they can open. Null when they can open none of the report's projects. Internal.
create or replace function public.report_email_payload(schedule public.report_schedules, recipient uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f jsonb := case when schedule.report = 'overview' then schedule.filters else '{}'::jsonb end;
  tz text := public.safe_timezone(schedule.time_zone);
  previous_sub text := current_setting('request.jwt.claim.sub', true);
  readable integer;
  totals jsonb;
  project_rows jsonb;
  overdue jsonb;
  result jsonb;
begin
  perform set_config('request.jwt.claim.sub', recipient::text, true);
  select count(*)::integer into readable
  from public.projects pr
  where pr.deleted_at is null
    and (jsonb_array_length(coalesce(f -> 'projects', '[]'::jsonb)) = 0 or (f -> 'projects') @> jsonb_build_array(pr.id))
    and public.has_project_role(pr.id, 'viewer');

  if readable > 0 and schedule.report = 'overview' then
    select jsonb_build_object(
             'tasks', w.task_count, 'completed', w.completed_count, 'open', w.incomplete_count,
             'overdue', w.overdue_count, 'completed_recent', w.completed_recent_count)
      into totals
    from public.workspace_report(f, 'none', tz) w
    limit 1;
    select coalesce(jsonb_agg(x.row order by x.open desc, x.name), '[]'::jsonb) into project_rows
    from (
      select pr.name, w.incomplete_count as open, jsonb_build_object(
               'id', pr.id, 'name', pr.name, 'tasks', w.task_count, 'completed', w.completed_count,
               'open', w.incomplete_count, 'overdue', w.overdue_count, 'completed_recent', w.completed_recent_count) as row
      from public.workspace_report(f, 'project', tz) w
      join public.projects pr on pr.id = w.bucket
      order by w.incomplete_count desc, pr.name
      limit 15
    ) x;
    select coalesce(jsonb_agg(jsonb_build_object(
             'title', left(o.title, 200), 'project', pr.name, 'project_id', o.project_id, 'due_on', o.due_on, 'days', o.days_overdue,
             'path', '/projects/' || o.project_id || '?task=' || o.task_id
           ) order by o.due_on, o.title), '[]'::jsonb)
      into overdue
    from public.report_overdue_tasks(f, tz, 10) o
    join public.projects pr on pr.id = o.project_id;
    result := jsonb_build_object(
      'totals', totals,
      'projects', project_rows,
      'project_count', (select count(*) from public.workspace_report(f, 'project', tz)),
      'overdue', overdue,
      'filters_summary', public.report_filter_summary(f)
    );
  elsif readable > 0 then
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', a.project_id, 'name', a.name, 'status', a.status, 'tasks', a.task_count,
             'completed', a.completed_count, 'open', a.incomplete_count, 'overdue', a.overdue_count,
             'completed_recent', a.completed_recent_count
           ) order by a.overdue_count desc, a.incomplete_count desc, a.name) filter (where a.n <= 30), '[]'::jsonb),
           jsonb_build_object(
             'tasks', coalesce(sum(a.task_count), 0), 'completed', coalesce(sum(a.completed_count), 0),
             'open', coalesce(sum(a.incomplete_count), 0), 'overdue', coalesce(sum(a.overdue_count), 0),
             'completed_recent', coalesce(sum(a.completed_recent_count), 0)),
           count(*)
      into project_rows, totals, readable
    from (
      select r.*, row_number() over (order by r.overdue_count desc, r.incomplete_count desc, r.name) as n
      from public.all_projects_report(tz) r
    ) a;
    result := jsonb_build_object(
      'totals', totals,
      'projects', project_rows,
      'project_count', readable,
      'filters_summary', '[]'::jsonb
    );
  end if;
  perform set_config('request.jwt.claim.sub', coalesce(previous_sub, ''), true);
  return result;
end;
$$;

revoke all on function public.report_email_payload(public.report_schedules, uuid) from public, anon, authenticated;

-- Queues every due scheduled report (internal; from alhc_queue_scheduled_emails): one outbox row per
-- recipient who is still in the workspace, wants report emails, isn't suppressed, and can open at
-- least one of the report's projects. A recipient whose copy fails to build is skipped (their own
-- subtransaction), never the whole schedule. Nothing goes out while the owner has lost access. The
-- schedule's next run moves on either way; last_sent_at / last_sent_count say who got the last one.
create or replace function public.queue_report_emails()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.report_schedules;
  person public.profiles;
  pref public.email_preferences;
  recipient uuid;
  payload jsonb;
  owner_name text;
  sent integer;
  queued integer := 0;
begin
  for s in
    select * from public.report_schedules r
    where r.deleted_at is null and r.paused_at is null and r.next_run_at <= now()
    order by r.next_run_at
    limit 100
    for update skip locked
  loop
    sent := 0;
    if public.profile_is_allowlisted(s.owner_id) then
      owner_name := (select coalesce(nullif(trim(p.full_name), ''), p.email) from public.profiles p where p.id = s.owner_id);
      foreach recipient in array s.recipients loop
        select * into person from public.profiles p where p.id = recipient;
        if not found
           or not public.profile_is_allowlisted(person.id)
           or not public.is_email(lower(person.email))
           or public.email_suppression_reason(person.email) is not null then
          continue;
        end if;
        pref := public.ensure_email_preferences(person.id);
        if not pref.report_emails then
          continue;
        end if;
        begin
          payload := public.report_email_payload(s, person.id);
        exception when others then
          payload := null;
        end;
        if payload is null then
          continue;
        end if;
        insert into public.email_outbox (task_id, to_email, template, subject, payload, to_profile_id)
        values (
          null,
          lower(person.email),
          'custom',
          null,
          payload || jsonb_build_object(
            'kind', 'report',
            'schedule_id', s.id,
            'report', s.report,
            'name', s.name,
            'owner_name', owner_name,
            'frequency', s.frequency,
            'filters', s.filters,
            'time_zone', s.time_zone,
            'generated_at', now(),
            'unsubscribe_token', pref.unsubscribe_token
          ),
          person.id
        );
        sent := sent + 1;
      end loop;
    end if;
    update public.report_schedules
    set next_run_at = public.email_schedule_next_at(s.frequency, s.send_hour, s.weekday, s.month_day, s.time_zone, now()),
        last_run_at = now(),
        last_sent_at = case when sent > 0 then now() else last_sent_at end,
        last_sent_count = sent
    where id = s.id;
    queued := queued + sent;
  end loop;
  return queued;
end;
$$;

revoke all on function public.queue_report_emails() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Sending digests and reports: their own claim, with a send-time check
-- ---------------------------------------------------------------------------

-- Why a queued digest or report must not go out now (null = send it). Internal.
create or replace function public.scheduled_email_block_reason(target_email uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.email_outbox;
  person public.profiles;
  pref public.email_preferences;
  s public.report_schedules;
begin
  select * into o from public.email_outbox x where x.id = target_email;
  if not found or coalesce(o.payload ->> 'kind', '') not in ('digest', 'report') then
    return null;
  end if;
  select * into person from public.profiles p where p.id = o.to_profile_id;
  if not found then
    return 'Not sent: no recipient';
  end if;
  if o.created_at < now() - interval '12 hours' then
    return 'Not sent: more than 12 hours late';
  end if;
  if not public.profile_is_allowlisted(person.id) then
    return 'Not sent: the recipient no longer has access to ALHC Projects';
  end if;
  if lower(person.email) is distinct from o.to_email then
    return 'Not sent: the recipient''s email address changed';
  end if;
  select * into pref from public.email_preferences p where p.profile_id = person.id;
  if o.payload ->> 'kind' = 'digest' then
    if coalesce(pref.digest, 'off') = 'off' then
      return 'Not sent: the recipient turned off the digest';
    end if;
    if not public.digest_has_items(o.id) then
      return 'Not sent: everything in it was read, archived, or can no longer be opened';
    end if;
  else
    select * into s from public.report_schedules r where r.id::text = o.payload ->> 'schedule_id';
    if not found or s.deleted_at is not null then
      return 'Not sent: the schedule was removed';
    end if;
    if s.paused_at is not null then
      return 'Not sent: the schedule is paused';
    end if;
    if not (person.id = any (s.recipients)) then
      return 'Not sent: the recipient was taken off the schedule';
    end if;
    if not public.profile_is_allowlisted(s.owner_id) then
      return 'Not sent: the schedule''s owner no longer has access';
    end if;
    if pref.report_emails is false then
      return 'Not sent: the recipient turned off report emails';
    end if;
    if not public.report_copy_still_readable(o.id) then
      return 'Not sent: the recipient can no longer open a project in it';
    end if;
  end if;
  return null;
end;
$$;

revoke all on function public.scheduled_email_block_reason(uuid) from public, anon, authenticated;

-- This release's drain claims digests and reports here (service_role only): suppressed addresses fail
-- first; then a batch of due rows is locked (skip-locked, at most max_items), each checked with
-- scheduled_email_block_reason() — failed with the reason, or claimed. Only the batch is checked, so a
-- burst of due digests never makes one claim slow.
create or replace function public.claim_scheduled_emails(max_items integer default 20, only_id uuid default null)
returns setof public.email_outbox
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate uuid;
  reason text;
  claimed uuid[] := '{}';
begin
  perform public.fail_suppressed_emails(only_id);

  for candidate in
    select c.id from public.email_outbox c
    where c.deleted_at is null
      and c.payload ->> 'kind' in ('digest', 'report')
      and (only_id is null or c.id = only_id)
      and c.attempts < c.max_attempts
      and c.send_after <= now()
      and (c.status = 'pending' or (c.status = 'sending' and c.updated_at < now() - interval '10 minutes'))
    order by c.created_at
    limit least(greatest(coalesce(max_items, 20), 1), 100)
    for update skip locked
  loop
    reason := public.scheduled_email_block_reason(candidate);
    if reason is not null then
      update public.email_outbox set status = 'failed', last_error = reason where id = candidate;
    else
      claimed := claimed || candidate;
    end if;
  end loop;

  return query
  update public.email_outbox o
  set status = 'sending', attempts = o.attempts + 1
  where o.id = any (claimed)
  returning o.*;
end;
$$;

revoke all on function public.claim_scheduled_emails(integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_scheduled_emails(integer, uuid) to service_role;

-- Every 5 minutes (pg_cron job alhc-scheduled-emails), and from the app's cron route where pg_cron isn't
-- installed: queues due digests and scheduled reports. The every-minute delivery kick then sees them due
-- and asks the app to send them. service_role may run it (the cron route); no client role can.
create or replace function public.alhc_queue_scheduled_emails()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return jsonb_build_object('digests', public.queue_digest_emails(), 'reports', public.queue_report_emails());
end;
$$;

revoke all on function public.alhc_queue_scheduled_emails() from public, anon, authenticated;
grant execute on function public.alhc_queue_scheduled_emails() to service_role;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    perform cron.schedule('alhc-scheduled-emails', '*/5 * * * *', 'select public.alhc_queue_scheduled_emails()');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- anon, and the probe
-- ---------------------------------------------------------------------------

select public.alhc_revoke_anon_grants(array['email_suppressions', 'email_preferences', 'report_schedules']);
select public.alhc_revoke_anon_execute(array[
  'email_schedule_next_at(text,integer,integer,integer,text,timestamptz)', 'email_outbox_kind(public.email_outbox)',
  'list_email_suppressions()', 'clear_email_suppression(uuid)', 'email_suppression_reason(text)', 'fail_suppressed_emails(uuid)',
  'record_email_event(text,text,timestamptz,text,text)', 'mask_email(text)',
  'list_workspace_email_deliveries(integer)', 'workspace_email_summary(integer)', 'guard_email_preferences()',
  'set_email_digest(text,integer,integer,text)', 'set_report_emails(boolean)', 'ensure_email_preferences(uuid)',
  'inbox_item_readable(public.inbox_items)', 'inbox_item_email_parts(public.inbox_items,uuid)',
  'digest_email_items(uuid)', 'queue_digest_emails()', 'guard_report_schedule()', 'report_filter_summary(jsonb)',
  'report_email_payload(public.report_schedules,uuid)', 'queue_report_emails()', 'digest_has_items(uuid)',
  'report_copy_still_readable(uuid)',
  'scheduled_email_block_reason(uuid)', 'claim_scheduled_emails(integer,uuid)', 'alhc_queue_scheduled_emails()'
]);

-- Last: the app's probe for this release's database features (digest settings, report schedules, the
-- Admin console's email deliveries and suppression list) reads this table.
grant select on public.email_preferences to authenticated;
