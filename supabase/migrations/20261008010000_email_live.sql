-- ALHC Projects — Phase: Email live.
-- Real email end to end, plus the Asana-style conversation around a form submission.
--
--   1. Fast delivery. The app still makes every HTTP call (Resend, Slack, webhooks); the database only
--      queues. Server Actions already drain the outboxes right after the response. On top of that,
--      alhc_kick_delivery() runs every minute from pg_cron (job alhc-delivery-kick): when an outbox row
--      is due, it asks the app to drain through pg_net — a GET to <app url>/api/cron/workflows with the
--      CRON_SECRET bearer — reading both values from Supabase Vault (secrets alhc_app_url and
--      alhc_cron_secret). Without pg_net, pg_cron, or the two secrets it does nothing. No secret lives
--      in this file. The service role stays inside the app's background routes.
--   2. Honest status. Email rows keep their status (pending → sending → sent | failed, or mocked); the
--      activity line for an email_queued story reads it live. Failed sends retry with the integration
--      backoff (5, 10, 20, 30 minutes) up to the row's max_attempts (5). Settings → Deliveries lists
--      the project's emails next to Slack and webhooks: list_email_deliveries and retry_email_delivery,
--      the two new client SECURITY DEFINER functions (Admin+ of a project of the email's task, pinned
--      in suite 60; email_outbox has no client write path).
--   3. Form submitters follow their request: after a submission, the submitter's profile (matched by
--      email, allowlisted) follows the task through follow_task(), which only adds people who can read
--      it. Everyone else keeps getting the requester emails only.
--   4. Comment emails. A new comment queues one email per follower except its author: only followers
--      who are allowlisted, can read the task (profile_task_role), and have profiles.email_comments on
--      (default on; Settings → Profile). The recipient's project is one they are a member of, so no
--      email names a project its reader can't open. Every check is made again when the email is
--      claimed for sending; a recipient who lost access by then gets nothing (the row fails with the
--      reason). Imports and copies queue nothing.
--   5. Reply by email. Comment emails carry a Reply-To of r-<token>@<reply domain>, one token per
--      (task, follower) in email_reply_tokens (no client access). /api/inbound/email verifies Resend's
--      webhook signature, then calls post_email_reply() (service_role only), which posts the reply as
--      that person only when the sender matches the token's person, who must still be allowlisted and
--      a Commenter+ on the task. email_replies logs each attempt (never the body or address).
--
-- fire_rules, notify_with, notify_message, and add_story are untouched, as are their import and copy
-- checks. Additive: the previous release keeps working once this is applied.
--
-- Shipping note: the hosted connector refuses any statement that contains the keywords for removing
-- rows or objects, so everything that needs one is in the tail section at the very end of this file.
-- Nothing above the tail depends on it.

-- ---------------------------------------------------------------------------
-- Patch helper (kept on the hosted project; see AGENTS.md → Conventions)
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
-- Columns
-- ---------------------------------------------------------------------------

-- "Email me about comments" (Settings → Profile). People change their own row through
-- profiles_update_own, like their name.
alter table public.profiles add column email_comments boolean not null default true;

-- Comment emails: the follower and the comment they are about. template stays 'custom' for them (the
-- template CHECK is unchanged); comment_id marks the kind. max_attempts mirrors integration_outbox.
alter table public.email_outbox
  add column to_profile_id uuid references public.profiles (id),
  add column comment_id uuid references public.comments (id),
  add column max_attempts integer not null default 5
    constraint email_outbox_max_attempts_check check (max_attempts between 1 and 10);

create index email_outbox_to_profile_idx on public.email_outbox (to_profile_id);
create index email_outbox_comment_idx on public.email_outbox (comment_id);

comment on column public.email_outbox.comment_id is
  'Set for comment emails (template custom): the comment the follower is told about. Re-checked at claim.';

-- ---------------------------------------------------------------------------
-- Reply tokens and the reply log (no client access at all)
-- ---------------------------------------------------------------------------

create table public.email_reply_tokens (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id),
  profile_id uuid not null references public.profiles (id),
  token text not null unique check (token ~ '^[0-9a-f]{40}$'),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create unique index email_reply_tokens_active_idx
  on public.email_reply_tokens (task_id, profile_id) where revoked_at is null;
create index email_reply_tokens_profile_idx on public.email_reply_tokens (profile_id);

alter table public.email_reply_tokens enable row level security;
revoke all on public.email_reply_tokens from anon, authenticated;

comment on table public.email_reply_tokens is
  'Reply-by-email tokens, one per (task, follower). Secret: no client access. Written by email_reply_token().';

create table public.email_replies (
  id uuid primary key default gen_random_uuid(),
  provider_id text check (length(provider_id) <= 200),
  token_id uuid references public.email_reply_tokens (id),
  task_id uuid references public.tasks (id),
  profile_id uuid references public.profiles (id),
  comment_id uuid references public.comments (id),
  status text not null check (status in ('posted', 'rejected')),
  reason text check (length(reason) <= 200),
  created_at timestamptz not null default now()
);

create unique index email_replies_posted_idx on public.email_replies (provider_id)
  where status = 'posted' and provider_id is not null;
create index email_replies_token_idx on public.email_replies (token_id);
create index email_replies_task_idx on public.email_replies (task_id);
create index email_replies_profile_idx on public.email_replies (profile_id);
create index email_replies_comment_idx on public.email_replies (comment_id);
create index email_replies_created_idx on public.email_replies (created_at);

alter table public.email_replies enable row level security;
revoke all on public.email_replies from anon, authenticated;

comment on table public.email_replies is
  'One row per inbound reply email (posted or rejected with a reason). Never the body or the sender address.';

-- ---------------------------------------------------------------------------
-- Delivery: the new claim re-checks comment emails, retries back off, max_attempts per row
-- ---------------------------------------------------------------------------

-- Why a queued comment email must not go out now (null = send it). Internal.
create or replace function public.comment_email_block_reason(target_email uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when o.to_profile_id is null or p.id is null then 'Not sent: no recipient'
    when o.created_at < now() - interval '24 hours' then 'Not sent: more than a day late'
    when not public.profile_is_allowlisted(p.id) then 'Not sent: the recipient no longer has access to ALHC Projects'
    when t.id is null or t.deleted_at is not null then 'Not sent: the task is in the Trash'
    when public.profile_task_role(p.id, t.id) is null then 'Not sent: the recipient can no longer open this task'
    when c.id is null or c.deleted_at is not null then 'Not sent: the comment was removed'
    when not p.email_comments then 'Not sent: the recipient turned off comment emails'
    when lower(p.email) is distinct from o.to_email then 'Not sent: the recipient''s email address changed'
    when (o.payload ->> 'project_id') is not null
      and public.profile_project_role(p.id, (o.payload ->> 'project_id')::uuid) is null
      then 'Not sent: the recipient can no longer open this task''s project'
  end
  from public.email_outbox o
  left join public.profiles p on p.id = o.to_profile_id
  left join public.tasks t on t.id = o.task_id
  left join public.comments c on c.id = o.comment_id
  where o.id = target_email and o.comment_id is not null;
$$;

revoke all on function public.comment_email_block_reason(uuid) from public, anon, authenticated;

-- The drain's claim since Email live (service_role only): due rows of every kind, oldest first. Comment
-- emails whose recipient can no longer read the task (or turned comment emails off, …) fail with the
-- reason instead of being claimed. The attempt limit is the row's max_attempts (5, plus one per manual
-- retry).
create or replace function public.claim_email_deliveries(max_items integer default 20, only_id uuid default null)
returns setof public.email_outbox
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.email_outbox o
  set status = 'failed', last_error = public.comment_email_block_reason(o.id)
  where o.comment_id is not null
    and o.deleted_at is null
    and (only_id is null or o.id = only_id)
    and o.send_after <= now()
    and (o.status = 'pending' or (o.status = 'sending' and o.updated_at < now() - interval '10 minutes'))
    and public.comment_email_block_reason(o.id) is not null;

  return query
  update public.email_outbox o
  set status = 'sending', attempts = o.attempts + 1
  where o.id in (
    select c.id from public.email_outbox c
    where c.deleted_at is null
      and (only_id is null or c.id = only_id)
      and c.attempts < c.max_attempts
      and c.send_after <= now()
      and (c.status = 'pending' or (c.status = 'sending' and c.updated_at < now() - interval '10 minutes'))
    order by c.created_at
    limit least(greatest(coalesce(max_items, 20), 1), 100)
    for update skip locked
  )
  returning o.*;
end;
$$;

revoke all on function public.claim_email_deliveries(integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_email_deliveries(integer, uuid) to service_role;

-- The pre-Email live claim, kept for the release that is still deployed while this migration is applied
-- ahead of the merge: same contract, the row's max_attempts, and it never claims comment emails (that
-- release can't render them). The current app calls claim_email_deliveries instead.
create or replace function public.claim_email_outbox(max_items integer default 20, only_id uuid default null)
returns setof public.email_outbox
language sql
security definer
set search_path = ''
as $$
  update public.email_outbox o
  set status = 'sending', attempts = o.attempts + 1
  where o.id in (
    select c.id from public.email_outbox c
    where c.deleted_at is null
      and c.comment_id is null
      and (only_id is null or c.id = only_id)
      and c.attempts < c.max_attempts
      and c.send_after <= now()
      and (c.status = 'pending' or (c.status = 'sending' and c.updated_at < now() - interval '10 minutes'))
    order by c.created_at
    limit least(greatest(coalesce(max_items, 20), 1), 100)
    for update skip locked
  )
  returning o.*;
$$;

revoke all on function public.claim_email_outbox(integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_email_outbox(integer, uuid) to service_role;

-- Same contract as before; errors now back off 5, 10, 20, then 30 minutes and give up at max_attempts.
create or replace function public.complete_email_outbox(
  target_email uuid,
  outcome text,
  message_id text default null,
  error_message text default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.email_outbox
  set status = case
        when outcome in ('sent', 'mocked') then outcome
        when attempts >= max_attempts then 'failed'
        else 'pending'
      end,
      sent_at = case when outcome in ('sent', 'mocked') then now() end,
      provider_message_id = message_id,
      last_error = left(error_message, 2000),
      send_after = case
        when outcome in ('sent', 'mocked') then send_after
        else now() + public.integration_retry_delay(attempts)
      end
  where id = target_email and status = 'sending';
$$;

revoke all on function public.complete_email_outbox(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.complete_email_outbox(uuid, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Form submitters follow their request
-- ---------------------------------------------------------------------------

-- After submit_form records a submission, the person whose ALHC profile has the submitter's email
-- (and who is still allowlisted) follows the task. follow_task() adds only people who can read it, so
-- a submitter who isn't a member of the form's project stays a requester: requester emails only.
create or replace function public.on_form_submission_follow()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  person uuid;
begin
  if public.import_context_id() is not null or public.copy_context_id() is not null then
    return new;
  end if;
  select p.id into person
  from public.profiles p
  where lower(p.email) = lower(new.submitter_email)
  order by p.created_at
  limit 1;
  if person is not null and public.profile_is_allowlisted(person) then
    perform public.follow_task(new.task_id, person);
  end if;
  return new;
end;
$$;

revoke all on function public.on_form_submission_follow() from public, anon, authenticated;

create trigger form_submissions_after_insert_follow
  after insert on public.form_submissions
  for each row execute function public.on_form_submission_follow();

-- ---------------------------------------------------------------------------
-- Comment emails
-- ---------------------------------------------------------------------------

-- The project a comment email names for one recipient: the task's home project when they are a member
-- of it, else another project of the task (its root's, for a subtask) they are a member of, else null
-- (a private task). Never a project the recipient can't open. Internal.
create or replace function public.comment_email_project(target_profile uuid, target_task uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
  from public.tasks t
  join public.projects p on p.deleted_at is null and (
    p.id = t.home_project_id
    or p.id in (
      select tp.project_id from public.task_projects tp
      where tp.task_id = coalesce(t.root_task_id, t.id) and tp.deleted_at is null
    )
  )
  where t.id = target_task
    and public.profile_project_role(target_profile, p.id) is not null
  order by (p.id = t.home_project_id) desc, p.name, p.id
  limit 1;
$$;

revoke all on function public.comment_email_project(uuid, uuid) from public, anon, authenticated;

-- AFTER INSERT on comments (named to run after comments_after_insert, which follows the author and
-- the people the comment mentions). One email per follower except the author, only for followers who
-- are allowlisted, can read the task, and want comment emails. Nothing for imports or copies, nothing
-- on edits. No story: the comment itself is the activity.
create or replace function public.on_comment_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tasks;
  r record;
  author_name text;
  project uuid;
begin
  if public.import_context_id() is not null or public.copy_context_id() is not null
     or new.deleted_at is not null then
    return new;
  end if;
  select * into t from public.tasks where id = new.task_id;
  if not found or t.deleted_at is not null then
    return new;
  end if;

  author_name := coalesce(
    (select coalesce(nullif(trim(p.full_name), ''), p.email) from public.profiles p where p.id = new.author_id),
    (select 'Rule “' || ru.name || '”' from public.rules ru where ru.id = new.rule_id),
    'Someone'
  );

  for r in
    select p.id, lower(p.email) as email
    from public.task_followers f
    join public.profiles p on p.id = f.profile_id
    where f.task_id = new.task_id
      and f.deleted_at is null
      and f.profile_id is distinct from new.author_id
      and p.email_comments
      and public.is_email(lower(p.email))
      and public.profile_is_allowlisted(p.id)
      and public.profile_task_role(p.id, new.task_id) is not null
    order by p.id
  loop
    project := public.comment_email_project(r.id, new.task_id);
    insert into public.email_outbox (task_id, rule_id, to_email, template, subject, payload, to_profile_id, comment_id)
    values (
      new.task_id,
      new.rule_id,
      r.email,
      'custom',
      left(author_name || ' commented on “' || t.title || '”', 300),
      jsonb_build_object(
        'kind', 'comment',
        'task_title', t.title,
        'author_name', author_name,
        'comment_body', left(new.body, 10000),
        'project_id', project,
        'project_name', (select pr.name from public.projects pr where pr.id = project),
        'request_label', public.task_request_label(new.task_id)
      ),
      r.id,
      new.id
    );
  end loop;
  return new;
end;
$$;

revoke all on function public.on_comment_email() from public, anon, authenticated;

create trigger comments_after_insert_zz_email
  after insert on public.comments
  for each row execute function public.on_comment_email();

-- ---------------------------------------------------------------------------
-- Reply by email (service_role only)
-- ---------------------------------------------------------------------------

-- The reply token for a comment email's (task, recipient), created on first use. The drain calls it
-- only when inbound replies are configured (RESEND_WEBHOOK_SECRET). Null for other emails.
create or replace function public.email_reply_token(target_email uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.email_outbox;
  found_token text;
begin
  select * into o from public.email_outbox where id = target_email;
  if not found or o.comment_id is null or o.to_profile_id is null or o.task_id is null then
    return null;
  end if;
  insert into public.email_reply_tokens (task_id, profile_id, token)
  values (o.task_id, o.to_profile_id, left(public.inbound_random_hex(), 40))
  on conflict (task_id, profile_id) where revoked_at is null do nothing;
  select k.token into found_token
  from public.email_reply_tokens k
  where k.task_id = o.task_id and k.profile_id = o.to_profile_id and k.revoked_at is null;
  return found_token;
end;
$$;

revoke all on function public.email_reply_token(uuid) from public, anon, authenticated;
grant execute on function public.email_reply_token(uuid) to service_role;

-- Logs one reply attempt (internal).
create or replace function public.log_email_reply(
  provider text, token uuid, task uuid, person uuid, comment uuid, reply_status text, reply_reason text
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.email_replies (provider_id, token_id, task_id, profile_id, comment_id, status, reason)
  values (left(provider, 200), token, task, person, comment, reply_status, left(reply_reason, 200));
$$;

revoke all on function public.log_email_reply(text, uuid, uuid, uuid, uuid, text, text) from public, anon, authenticated;

-- Posts an emailed reply as a comment by the token's person. Called by /api/inbound/email after it has
-- verified Resend's webhook signature and stripped quoted text and signatures; service_role only.
-- Refuses (status 'rejected' + reason, nothing written but the log) an unknown token, a sender address
-- that isn't the token's person's, a person no longer allowlisted or below Commenter on the task, a
-- trashed task, and an empty body. The same provider email id posts once ('duplicate' afterwards).
-- The comment is written as that person (request.jwt.claim.sub set locally, then restored), so every
-- comment trigger — mentions, follows, inbox items, comment emails to the other followers — runs as
-- for a comment typed in the app.
create or replace function public.post_email_reply(
  reply_token text,
  sender_email text,
  reply_body text,
  provider_email_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  tok public.email_reply_tokens;
  person public.profiles;
  t public.tasks;
  body text := btrim(coalesce(reply_body, ''), E' \t\r\n');
  sender text := lower(btrim(coalesce(sender_email, '')));
  provider text := nullif(btrim(coalesce(provider_email_id, '')), '');
  person_role text;
  previous_sub text;
  new_comment uuid;
begin
  if provider is not null then
    perform pg_advisory_xact_lock(hashtextextended('alhc.email_reply:' || provider, 0));
    select r.comment_id into new_comment from public.email_replies r
    where r.provider_id = left(provider, 200) and r.status = 'posted';
    if found then
      return jsonb_build_object('ok', true, 'status', 'duplicate', 'comment_id', new_comment);
    end if;
  end if;

  if coalesce(reply_token, '') !~ '^[0-9a-f]{40}$' then
    perform public.log_email_reply(provider, null, null, null, null, 'rejected', 'unknown_token');
    return jsonb_build_object('ok', false, 'status', 'rejected', 'reason', 'unknown_token');
  end if;
  select * into tok from public.email_reply_tokens k where k.token = reply_token and k.revoked_at is null;
  if not found then
    perform public.log_email_reply(provider, null, null, null, null, 'rejected', 'unknown_token');
    return jsonb_build_object('ok', false, 'status', 'rejected', 'reason', 'unknown_token');
  end if;

  select * into person from public.profiles p where p.id = tok.profile_id;
  if not found or sender = '' or sender is distinct from lower(person.email) then
    perform public.log_email_reply(provider, tok.id, tok.task_id, tok.profile_id, null, 'rejected', 'sender_mismatch');
    return jsonb_build_object('ok', false, 'status', 'rejected', 'reason', 'sender_mismatch');
  end if;

  select * into t from public.tasks x where x.id = tok.task_id;
  person_role := case when public.profile_is_allowlisted(person.id) then public.profile_task_role(person.id, tok.task_id) end;
  if t.id is null or t.deleted_at is not null or person_role is null
     or public.project_role_rank(person_role) < public.project_role_rank('commenter') then
    perform public.log_email_reply(provider, tok.id, tok.task_id, tok.profile_id, null, 'rejected', 'no_access');
    return jsonb_build_object('ok', false, 'status', 'rejected', 'reason', 'no_access');
  end if;

  if body = '' then
    perform public.log_email_reply(provider, tok.id, tok.task_id, tok.profile_id, null, 'rejected', 'empty');
    return jsonb_build_object('ok', false, 'status', 'rejected', 'reason', 'empty');
  end if;

  previous_sub := current_setting('request.jwt.claim.sub', true);
  perform set_config('request.jwt.claim.sub', person.id::text, true);
  insert into public.comments (task_id, author_id, body)
  values (t.id, person.id, left(body, 10000))
  returning id into new_comment;
  perform set_config('request.jwt.claim.sub', coalesce(previous_sub, ''), true);

  update public.email_reply_tokens set last_used_at = now() where id = tok.id;
  perform public.log_email_reply(provider, tok.id, t.id, person.id, new_comment, 'posted', null);
  return jsonb_build_object('ok', true, 'status', 'posted', 'comment_id', new_comment, 'task_id', t.id);
end;
$$;

revoke all on function public.post_email_reply(text, text, text, text) from public, anon, authenticated;
grant execute on function public.post_email_reply(text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Delivery log for emails (Settings → Deliveries, Admin+)
-- ---------------------------------------------------------------------------

-- True when the caller is Admin+ of a project the email's task (its root, for a subtask) is in. Internal.
create or replace function public.email_delivery_admin(target_task uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tasks t
    join public.projects p on p.deleted_at is null and (
      p.id = t.home_project_id
      or p.id in (
        select tp.project_id from public.task_projects tp
        where tp.task_id = coalesce(t.root_task_id, t.id) and tp.deleted_at is null
      )
    )
    where t.id = target_task and public.has_project_role(p.id, 'admin')
  );
$$;

revoke all on function public.email_delivery_admin(uuid) from public, anon, authenticated;

-- Emails about tasks in the project, newest first. Never the body, payload, or provider response;
-- the recipient address is shown (admins already see requester addresses on the task).
create or replace function public.list_email_deliveries(target_project uuid, max_results integer default 100)
returns table (
  id uuid,
  kind text,
  recipient text,
  task_id uuid,
  task_title text,
  rule_id uuid,
  rule_name text,
  status text,
  attempts integer,
  max_attempts integer,
  last_error text,
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
    o.id,
    case when o.comment_id is not null then 'comment' else o.template end,
    o.to_email,
    o.task_id,
    case when public.has_task_role(o.task_id, 'viewer') then t.title end,
    o.rule_id, ru.name, o.status, o.attempts, o.max_attempts,
    left(o.last_error, 500),
    case when o.status = 'pending' then o.send_after end,
    o.sent_at, o.created_at, o.updated_at
  from public.email_outbox o
  join public.tasks t on t.id = o.task_id
  left join public.rules ru on ru.id = o.rule_id
  where o.deleted_at is null
    and (
      t.home_project_id = target_project
      or exists (
        select 1 from public.task_projects tp
        where tp.task_id = coalesce(t.root_task_id, t.id)
          and tp.project_id = target_project
          and tp.deleted_at is null
      )
    )
  order by o.created_at desc, o.id
  limit least(greatest(coalesce(max_results, 100), 1), 200);
end;
$$;

revoke all on function public.list_email_deliveries(uuid, integer) from public, anon;
grant execute on function public.list_email_deliveries(uuid, integer) to authenticated;

-- Send now (a pending row) or one more attempt (a failed row), 10 attempts in all. Comment emails are
-- re-checked at claim as always. Returns the new status.
create or replace function public.retry_email_delivery(target_email uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.email_outbox;
begin
  select * into o from public.email_outbox x where x.id = target_email and x.deleted_at is null for update;
  if not found or o.task_id is null or not public.has_task_role(o.task_id, 'viewer') then
    raise exception 'Email not found' using errcode = 'no_data_found';
  end if;
  if not public.email_delivery_admin(o.task_id) then
    raise exception 'Only project admins can retry emails' using errcode = 'insufficient_privilege';
  end if;
  if o.status = 'pending' then
    update public.email_outbox set send_after = now() where id = o.id;
    return 'pending';
  end if;
  if o.status <> 'failed' then
    raise exception 'Only waiting or failed emails can be retried' using errcode = 'check_violation';
  end if;
  if o.attempts >= 10 then
    raise exception 'This email has been tried 10 times' using errcode = 'check_violation';
  end if;
  update public.email_outbox
  set status = 'pending', send_after = now(), max_attempts = least(greatest(o.attempts + 1, 1), 10)
  where id = o.id;
  return 'pending';
end;
$$;

revoke all on function public.retry_email_delivery(uuid) from public, anon;
grant execute on function public.retry_email_delivery(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Fast delivery: pg_cron + pg_net ask the app to drain within a minute
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_net')
     and not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net') then
    create extension pg_net;
  end if;
end;
$$;

-- Every minute (pg_cron job alhc-delivery-kick): when an email, Slack message, or webhook is due, GET
-- <alhc_app_url>/api/cron/workflows with "Authorization: Bearer <alhc_cron_secret>" through pg_net (an
-- async request; the app's drain claims rows with skip-locked, so overlapping runs are safe). Both
-- values come from Supabase Vault and never appear in SQL text, logs, or this file. Returns whether a
-- request was made. Without pg_net, Vault, or either secret it does nothing. Internal: no client
-- (and not service_role) can execute it.
create or replace function public.alhc_kick_delivery()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  app_url text;
  cron_secret text;
begin
  if to_regprocedure('net.http_get(text,jsonb,jsonb,integer)') is null
     or to_regclass('vault.decrypted_secrets') is null then
    return false;
  end if;
  if not exists (
       select 1 from public.email_outbox o
       where o.deleted_at is null and o.send_after <= now() and o.attempts < o.max_attempts
         and (o.status = 'pending' or (o.status = 'sending' and o.updated_at < now() - interval '10 minutes'))
     )
     and not exists (
       select 1 from public.integration_outbox o
       where o.deleted_at is null and o.send_after <= now() and o.attempts < o.max_attempts
         and (o.status = 'pending' or (o.status = 'sending' and o.updated_at < now() - interval '10 minutes'))
     ) then
    return false;
  end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1'
    into app_url using 'alhc_app_url';
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1'
    into cron_secret using 'alhc_cron_secret';
  app_url := rtrim(btrim(coalesce(app_url, '')), '/');
  cron_secret := btrim(coalesce(cron_secret, ''));
  if app_url !~ '^https://[^/[:space:]]+$' or cron_secret = '' then
    return false;
  end if;
  execute 'select net.http_get(url := $1, headers := $2, timeout_milliseconds := $3)'
    using app_url || '/api/cron/workflows',
      jsonb_build_object('Authorization', 'Bearer ' || cron_secret),
      30000;
  return true;
end;
$$;

revoke all on function public.alhc_kick_delivery() from public, anon, authenticated, service_role;

comment on function public.alhc_kick_delivery() is
  'Every minute (pg_cron alhc-delivery-kick): when an outbox row is due, asks the app to drain via pg_net, '
  'using the Vault secrets alhc_app_url and alhc_cron_secret. No-op without them. Internal.';

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    perform cron.schedule('alhc-delivery-kick', '* * * * *', 'select public.alhc_kick_delivery()');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Realtime: the task pane re-reads an email's status when its row changes (RLS: task Viewer+)
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'email_outbox'
     ) then
    alter publication supabase_realtime add table public.email_outbox;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- anon never reaches anything new (Review hardening convention)
-- ---------------------------------------------------------------------------

select public.alhc_revoke_anon_grants(array['email_reply_tokens', 'email_replies']);

select public.alhc_revoke_anon_execute(array[
  'comment_email_block_reason(uuid)', 'claim_email_outbox(integer,uuid)', 'claim_email_deliveries(integer,uuid)',
  'complete_email_outbox(uuid,text,text,text)', 'on_form_submission_follow()',
  'comment_email_project(uuid,uuid)', 'on_comment_email()', 'email_reply_token(uuid)',
  'log_email_reply(text,uuid,uuid,uuid,uuid,text,text)', 'post_email_reply(text,text,text,text)',
  'email_delivery_admin(uuid)', 'list_email_deliveries(uuid,integer)', 'retry_email_delivery(uuid)',
  'alhc_kick_delivery()'
]);

-- TAIL — applied by hand, not by the migration-applier. Everything below needs a row-removal keyword,
-- which the hosted connector won't deliver. Nothing above depends on it; until it runs, the reply log
-- simply isn't pruned.

-- Log retention: the daily purge (alhc-log-purge) also removes reply log rows older than 90 days.
select public.alhc_patch_function('public.alhc_purge_old_logs()'::regprocedure,
$p$  purged_runs integer;
begin$p$,
$p$  purged_runs integer;
  purged_replies integer;
begin$p$,
$p$  get diagnostics purged_runs = row_count;
$p$,
$p$  get diagnostics purged_runs = row_count;

  delete from public.email_replies where created_at < cutoff;
  get diagnostics purged_replies = row_count;
$p$,
$p$    'rule_runs', purged_runs
$p$,
$p$    'rule_runs', purged_runs,
    'email_replies', purged_replies
$p$);
