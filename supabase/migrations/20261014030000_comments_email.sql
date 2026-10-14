-- ALHC Projects — Phase: Comments and reply by email (Avi's redesign).
-- Before this, every comment email to a follower carried Reply-To r-<token>@<reply domain>, and replying
-- posted a comment as that follower (email_reply_tokens, post_email_reply). That was the wrong shape:
-- workspace people comment in the app, and the only person who should answer by email is someone outside
-- it — a form's submitter. Now:
--
--   Ordinary emails are no-reply. email_reply_token() returns nothing (so no release, the one still on
--     main included, can put a follower's Reply-To on an email again), every follower token is revoked,
--     and post_email_reply() refuses everything ('follower_replies_off', logged in email_replies).
--   Responses to a form's submitter. On a task created by a form (tasks.source = 'form' with a
--     form_submissions row), a Commenter+ can tick "Send response to submitter <email>" under the comment
--     box: send_submitter_response(task, body) (invoker) posts the comment marked as an email
--     (comments.email_direction = 'sent', email_address = the submitter, email_subject =
--     'Re: "<form title>" submission received' — filled by the database, never by the client), and an
--     AFTER INSERT trigger queues one email to the submitter (email_outbox, payload.kind =
--     'submitter_response', task_id set so the task's readers see its status, comment_id null so it is
--     never treated as a follower's comment email). The thread (task + submitter address) gets a secret
--     reply token in submitter_reply_threads (no client access); the app's drain asks
--     submitter_reply_token(email) (service_role) for it and puts Reply-To r-<token>@<reply domain> on that
--     email only. claim_email_deliveries fails a response whose comment was removed or whose task was
--     trashed before it went out (submitter_response_block_reason).
--   Replies from the submitter. The verified Resend webhook calls post_submitter_reply(token, sender, body,
--     provider id) (service_role): a known, unrevoked thread token, sent from the thread's submitter
--     address, on a live task, at most 20 an hour per thread, posts the text as a comment with no author
--     (email_direction = 'received', email_address = the submitter, the thread's subject). Followers hear
--     about it like any comment (Inbox, comment emails naming the address); it @mentions nobody. Anything
--     else — an unknown or revoked token, an old follower token, another sender — is refused and logged
--     (email_replies, never the body or the address).
--
-- New client surface: send_submitter_response (invoker) and two invoker guard triggers; nothing new in
-- suite 60's definer list (post_submitter_reply and submitter_reply_token are service_role only, the
-- other definer helpers and triggers are revoked from clients). fire_rules, notify_with, notify_message,
-- and add_story are untouched; imports and copies queue no response.
--
-- The tail: comments_author_or_rule requires an author or a rule. A submitter's reply has neither, so the
-- migration adds the wider comments_author_or_rule_v2 (author, rule, or a received email) and the tail
-- retires the old CHECK and renames the new one. Until the tail is applied, post_submitter_reply catches
-- the old CHECK's refusal and logs the reply as 'not_ready' (nothing is posted); sending responses works.
--
-- Additive otherwise: the release still on main never reads the new columns, its drain gets no Reply-To
-- (email_reply_token returns null), and its route's post_email_reply calls are refused and logged.

-- ---------------------------------------------------------------------------
-- Asserted patches (the helper stays on the hosted project; see AGENTS.md)
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
-- Comments: email metadata
-- ---------------------------------------------------------------------------

alter table public.comments
  add column email_direction text constraint comments_email_direction_check
    check (email_direction in ('sent', 'received')),
  add column email_address text constraint comments_email_address_check
    check (email_address is null or (public.is_email(email_address) and email_address = lower(email_address))),
  add column email_subject text constraint comments_email_subject_check
    check (email_subject is null or length(btrim(email_subject)) between 1 and 300),
  add constraint comments_email_shape_check check (
    (email_direction is null) = (email_address is null) and (email_direction is null) = (email_subject is null)
  ),
  -- A received email has no author; everything else keeps the old rule. Replaces comments_author_or_rule
  -- in the tail.
  add constraint comments_author_or_rule_v2 check (
    author_id is not null or rule_id is not null or email_direction = 'received'
  );

comment on column public.comments.email_direction is
  'Comments and reply by email: ''sent'' = also emailed to the task''s form submitter (email_address); '
  '''received'' = the submitter''s emailed reply (no author). Null for ordinary comments.';

-- Clients set the email columns only through send_submitter_response (which sets the transaction-local
-- alhc.submitter_response to the task) and only to 'sent'; the definer trigger below then fills the
-- address and subject from the task's form submission. An email comment's text can't be edited (it was
-- emailed as it stands) and its email columns never change. Runs as the caller (is_client_role()).
create or replace function public.guard_comment_email()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.is_client_role() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.email_direction is not null or new.email_address is not null or new.email_subject is not null then
      if new.email_direction is distinct from 'sent'
         or coalesce(current_setting('alhc.submitter_response', true), '') <> new.task_id::text then
        raise exception 'Use “Send response to submitter” to email a comment' using errcode = 'insufficient_privilege';
      end if;
    end if;
    return new;
  end if;
  if new.email_direction is distinct from old.email_direction
     or new.email_address is distinct from old.email_address
     or new.email_subject is distinct from old.email_subject then
    raise exception 'Only the text of a comment can be edited' using errcode = 'insufficient_privilege';
  end if;
  if old.email_direction is not null and new.body is distinct from old.body then
    raise exception 'This comment was emailed, so it can’t be edited' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_comment_email() from public, anon;
grant execute on function public.guard_comment_email() to authenticated;

create trigger comments_04_guard_email
  before insert or update on public.comments
  for each row execute function public.guard_comment_email();

-- The task's form submitter (latest submission) and the response subject, or nothing when the task isn't
-- a form task. Internal.
create or replace function public.task_submitter(target_task uuid)
returns table (submission_id uuid, form_id uuid, submitter_email text, subject text)
language sql
stable
security definer
set search_path = ''
as $$
  select fs.id, fs.form_id, lower(btrim(fs.submitter_email)),
    left('Re: "' || coalesce(nullif(btrim(f.title), ''), 'Your request') || '" submission received', 300)
  from public.tasks t
  join public.form_submissions fs on fs.task_id = t.id and fs.deleted_at is null
  left join public.forms f on f.id = fs.form_id
  where t.id = target_task
    and t.source = 'form'
    and t.parent_task_id is null
    and public.is_email(lower(btrim(fs.submitter_email)))
  order by fs.created_at desc, fs.id
  limit 1;
$$;

revoke all on function public.task_submitter(uuid) from public, anon, authenticated;

-- BEFORE INSERT (definer, after the guard): a 'sent' comment gets the submitter's address and the subject
-- from the database, whatever the client sent; refuses a task without a submitter. Received emails come
-- only from post_submitter_reply (the guard refuses them from clients).
create or replace function public.fill_comment_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  s record;
begin
  if new.email_direction is distinct from 'sent' then
    return new;
  end if;
  select * into s from public.task_submitter(new.task_id);
  if s.submitter_email is null then
    raise exception 'This task wasn’t created by a form, so there’s no submitter to email'
      using errcode = 'check_violation';
  end if;
  new.email_address := s.submitter_email;
  new.email_subject := s.subject;
  return new;
end;
$$;

revoke all on function public.fill_comment_email() from public, anon, authenticated;

create trigger comments_04b_fill_email
  before insert on public.comments
  for each row execute function public.fill_comment_email();

-- ---------------------------------------------------------------------------
-- Submitter reply threads (no client access at all)
-- ---------------------------------------------------------------------------

do $do$
begin
  execute $sql$
    create table public.submitter_reply_threads (
      id uuid primary key default gen_random_uuid(),
      task_id uuid not null references public.tasks (id),
      submission_id uuid references public.form_submissions (id),
      submitter_email text not null constraint submitter_reply_threads_email_check
        check (public.is_email(submitter_email) and submitter_email = lower(submitter_email)),
      subject text not null constraint submitter_reply_threads_subject_check check (length(btrim(subject)) between 1 and 300),
      token text not null unique constraint submitter_reply_threads_token_check check (token ~ '^[0-9a-f]{40}$'),
      created_by uuid references public.profiles (id),
      created_at timestamptz not null default now(),
      last_used_at timestamptz,
      revoked_at timestamptz
    )
  $sql$;
  execute 'alter table public.submitter_reply_threads enable row level security';
  execute 'revoke all on public.submitter_reply_threads from anon, authenticated';
end;
$do$;

comment on table public.submitter_reply_threads is
  'Comments and reply by email: one reply token per (task, form submitter address), minted when someone '
  'first sends a response to the submitter. Secret: no client access. Read by submitter_reply_token() '
  '(the drain''s Reply-To) and post_submitter_reply() (the inbound webhook).';

create unique index submitter_reply_threads_active_idx
  on public.submitter_reply_threads (task_id, submitter_email) where revoked_at is null;
create index submitter_reply_threads_submission_idx on public.submitter_reply_threads (submission_id);
create index submitter_reply_threads_created_by_idx on public.submitter_reply_threads (created_by);

alter table public.email_replies add column thread_id uuid references public.submitter_reply_threads (id);
create index email_replies_thread_idx on public.email_replies (thread_id);

comment on column public.email_replies.thread_id is
  'The submitter reply thread a reply came in on (Comments and reply by email). Null for the retired '
  'follower replies.';

-- ---------------------------------------------------------------------------
-- Ordinary emails are no-reply
-- ---------------------------------------------------------------------------

update public.email_reply_tokens set revoked_at = now() where revoked_at is null;

select public.alhc_patch_function('public.email_reply_token(uuid)'::regprocedure,
$p$begin
  select * into o from public.email_outbox where id = target_email;
$p$,
$p$begin
  -- Comments and reply by email: follower emails are no-reply; no token is ever handed out again.
  return null;
  select * into o from public.email_outbox where id = target_email;
$p$);

select public.alhc_patch_function('public.post_email_reply(text,text,text,text)'::regprocedure,
$p$  if coalesce(reply_token, '') !~ '^[0-9a-f]{40}$' then
$p$,
$p$  -- Comments and reply by email: followers no longer reply by email; only a form submitter's thread
  -- does (post_submitter_reply).
  perform public.log_email_reply(provider, null, null, null, null, 'rejected', 'follower_replies_off');
  return jsonb_build_object('ok', false, 'status', 'rejected', 'reason', 'follower_replies_off');

  if coalesce(reply_token, '') !~ '^[0-9a-f]{40}$' then
$p$);

-- ---------------------------------------------------------------------------
-- Sending a response to the submitter
-- ---------------------------------------------------------------------------

-- The comment box's "Send response to submitter": posts the comment as the caller (comments RLS:
-- Commenter+, own author) marked as an email; the triggers fill in the address and subject and queue the
-- email. Returns the comment id. Invoker.
create or replace function public.send_submitter_response(target_task uuid, response_body text)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  new_comment uuid;
  body text := btrim(coalesce(response_body, ''));
begin
  if body = '' then
    raise exception 'Comment can’t be empty' using errcode = 'check_violation';
  end if;
  perform set_config('alhc.submitter_response', target_task::text, true);
  insert into public.comments (task_id, body, email_direction)
  values (target_task, left(body, 10000), 'sent')
  returning id into new_comment;
  perform set_config('alhc.submitter_response', '', true);
  return new_comment;
end;
$$;

revoke all on function public.send_submitter_response(uuid, text) from public, anon;
grant execute on function public.send_submitter_response(uuid, text) to authenticated;

-- AFTER INSERT (definer): a 'sent' comment queues one email to the submitter and makes sure the thread
-- has a reply token. No story: the comment is the activity. Nothing for imports or copies.
create or replace function public.on_comment_submitter_response()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tasks;
  s record;
  thread uuid;
  author_name text;
begin
  if new.email_direction is distinct from 'sent' or new.deleted_at is not null
     or public.import_context_id() is not null or public.copy_context_id() is not null then
    return new;
  end if;
  select * into t from public.tasks where id = new.task_id;
  select * into s from public.task_submitter(new.task_id);
  if t.id is null or s.submitter_email is null then
    return new;
  end if;

  insert into public.submitter_reply_threads (task_id, submission_id, submitter_email, subject, token, created_by)
  values (t.id, s.submission_id, s.submitter_email, s.subject, left(public.inbound_random_hex(), 40), new.author_id)
  on conflict (task_id, submitter_email) where revoked_at is null do nothing;
  select k.id into thread from public.submitter_reply_threads k
  where k.task_id = t.id and k.submitter_email = s.submitter_email and k.revoked_at is null;

  author_name := coalesce(
    (select coalesce(nullif(btrim(p.full_name), ''), p.email) from public.profiles p where p.id = new.author_id),
    'The team'
  );
  insert into public.email_outbox (task_id, to_email, template, subject, payload)
  values (
    t.id,
    new.email_address,
    'custom',
    new.email_subject,
    jsonb_build_object(
      'kind', 'submitter_response',
      'comment_id', new.id,
      'thread_id', thread,
      'author_name', author_name,
      'task_title', t.title,
      'request_label', public.task_request_label(t.id),
      'message', left(new.body, 10000)
    )
  );
  return new;
end;
$$;

revoke all on function public.on_comment_submitter_response() from public, anon, authenticated;

create trigger comments_after_insert_zz_submitter
  after insert on public.comments
  for each row execute function public.on_comment_submitter_response();

-- Why a queued response to a submitter must not go out now (null = send it). Internal.
create or replace function public.submitter_response_block_reason(target_email uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when o.created_at < now() - interval '24 hours' then 'Not sent: more than a day late'
    when c.id is null or c.deleted_at is not null then 'Not sent: the comment was removed'
    when t.id is null or t.deleted_at is not null then 'Not sent: the task is in the Trash'
  end
  from public.email_outbox o
  left join public.comments c on c.id = (o.payload ->> 'comment_id')::uuid
  left join public.tasks t on t.id = o.task_id
  where o.id = target_email
    and o.payload ->> 'kind' = 'submitter_response'
    and coalesce(o.payload ->> 'comment_id', '') ~ '^[0-9a-f-]{36}$';
$$;

revoke all on function public.submitter_response_block_reason(uuid) from public, anon, authenticated;

select public.alhc_patch_function('public.claim_email_deliveries(integer,uuid)'::regprocedure,
$p$  perform public.fail_suppressed_emails(only_id);
$p$,
$p$  perform public.fail_suppressed_emails(only_id);

  update public.email_outbox o
  set status = 'failed', last_error = public.submitter_response_block_reason(o.id)
  where o.status in ('pending', 'sending')
    and o.payload ->> 'kind' = 'submitter_response'
    and (only_id is null or o.id = only_id)
    and public.submitter_response_block_reason(o.id) is not null;
$p$);

-- The release still on main would send a response without its Reply-To; leave those to this release.
select public.alhc_patch_function('public.claim_email_outbox(integer,uuid)'::regprocedure,
$p$      and coalesce(c.payload ->> 'kind', '') not in ('notification', 'digest', 'report')
$p$,
$p$      and coalesce(c.payload ->> 'kind', '') not in ('notification', 'digest', 'report', 'submitter_response')
$p$);

select public.alhc_patch_function('public.email_outbox_kind(public.email_outbox)'::regprocedure,
$p$('invite', 'notification', 'digest', 'report')$p$,
$p$('invite', 'notification', 'digest', 'report', 'submitter_response')$p$);

-- The reply token for a response email (the drain's Reply-To), or null for any other email or a revoked
-- thread. service_role only.
create or replace function public.submitter_reply_token(target_email uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select k.token
  from public.email_outbox o
  join public.submitter_reply_threads k on k.id = (o.payload ->> 'thread_id')::uuid
  where o.id = target_email
    and o.payload ->> 'kind' = 'submitter_response'
    and coalesce(o.payload ->> 'thread_id', '') ~ '^[0-9a-f-]{36}$'
    and k.revoked_at is null
    and k.submitter_email = lower(btrim(o.to_email));
$$;

revoke all on function public.submitter_reply_token(uuid) from public, anon, authenticated;
grant execute on function public.submitter_reply_token(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Replies from the submitter
-- ---------------------------------------------------------------------------

-- Logs one submitter reply attempt (internal). Never the body or the address.
create or replace function public.log_submitter_reply(
  provider text, thread uuid, task uuid, comment uuid, reply_status text, reply_reason text
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.email_replies (provider_id, thread_id, task_id, comment_id, status, reason)
  values (left(provider, 200), thread, task, comment, reply_status, left(reply_reason, 200));
$$;

revoke all on function public.log_submitter_reply(text, uuid, uuid, uuid, text, text) from public, anon, authenticated;

-- Posts a form submitter's emailed reply as a comment with no author. Called by /api/inbound/email after
-- it verified Resend's webhook signature and stripped quotes and signatures; service_role only. Refuses
-- (logged, nothing posted) a malformed, unknown, or revoked token (old follower tokens included), a sender
-- that isn't the thread's submitter, a trashed task, more than 20 replies an hour on one thread, and an
-- empty body. The same provider email id posts once ('duplicate' afterwards).
create or replace function public.post_submitter_reply(
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
  k public.submitter_reply_threads;
  t public.tasks;
  body text := btrim(coalesce(reply_body, ''), E' \t\r\n');
  sender text := lower(btrim(coalesce(sender_email, '')));
  provider text := nullif(btrim(coalesce(provider_email_id, '')), '');
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
    perform public.log_submitter_reply(provider, null, null, null, 'rejected', 'unknown_token');
    return jsonb_build_object('ok', false, 'status', 'rejected', 'reason', 'unknown_token');
  end if;
  select * into k from public.submitter_reply_threads x where x.token = reply_token and x.revoked_at is null;
  if not found then
    perform public.log_submitter_reply(provider, null, null, null, 'rejected', 'unknown_token');
    return jsonb_build_object('ok', false, 'status', 'rejected', 'reason', 'unknown_token');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('alhc.submitter_thread:' || k.id::text, 0));

  if sender = '' or sender <> k.submitter_email then
    perform public.log_submitter_reply(provider, k.id, k.task_id, null, 'rejected', 'sender_mismatch');
    return jsonb_build_object('ok', false, 'status', 'rejected', 'reason', 'sender_mismatch');
  end if;

  select * into t from public.tasks x where x.id = k.task_id;
  if t.id is null or t.deleted_at is not null then
    perform public.log_submitter_reply(provider, k.id, k.task_id, null, 'rejected', 'task_unavailable');
    return jsonb_build_object('ok', false, 'status', 'rejected', 'reason', 'task_unavailable');
  end if;

  if (select count(*) from public.email_replies r
      where r.thread_id = k.id and r.status = 'posted' and r.created_at > now() - interval '1 hour') >= 20 then
    perform public.log_submitter_reply(provider, k.id, k.task_id, null, 'rejected', 'rate_limited');
    return jsonb_build_object('ok', false, 'status', 'rejected', 'reason', 'rate_limited');
  end if;

  if body = '' then
    perform public.log_submitter_reply(provider, k.id, k.task_id, null, 'rejected', 'empty');
    return jsonb_build_object('ok', false, 'status', 'rejected', 'reason', 'empty');
  end if;

  -- Nobody is signed in: the comment and its Inbox items have no actor.
  previous_sub := current_setting('request.jwt.claim.sub', true);
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    insert into public.comments (task_id, author_id, body, email_direction, email_address, email_subject)
    values (t.id, null, left(body, 10000), 'received', k.submitter_email, k.subject)
    returning id into new_comment;
  exception when check_violation then
    -- Before the tail retires comments_author_or_rule, a comment without an author is refused.
    perform set_config('request.jwt.claim.sub', coalesce(previous_sub, ''), true);
    perform public.log_submitter_reply(provider, k.id, k.task_id, null, 'rejected', 'not_ready');
    return jsonb_build_object('ok', false, 'status', 'rejected', 'reason', 'not_ready');
  end;
  perform set_config('request.jwt.claim.sub', coalesce(previous_sub, ''), true);

  update public.submitter_reply_threads set last_used_at = now() where id = k.id;
  perform public.log_submitter_reply(provider, k.id, t.id, new_comment, 'posted', null);
  return jsonb_build_object('ok', true, 'status', 'posted', 'comment_id', new_comment, 'task_id', t.id);
end;
$$;

revoke all on function public.post_submitter_reply(text, text, text, text) from public, anon, authenticated;
grant execute on function public.post_submitter_reply(text, text, text, text) to service_role;

-- A submitter's reply @mentions nobody (an email signature's "@name" isn't a mention), and the comment
-- emails to followers name the address instead of "Someone".
select public.alhc_patch_function('public.on_comment_insert()'::regprocedure,
$p$  from public.comment_mention_ids(new.task_id, new.author_id, new.body) as m (id)
$p$,
$p$  from public.comment_mention_ids(new.task_id, new.author_id, new.body) as m (id)
  where new.email_direction is distinct from 'received'
$p$);

select public.alhc_patch_function('public.on_comment_email()'::regprocedure,
$p$    (select 'Rule “' || ru.name || '”' from public.rules ru where ru.id = new.rule_id),
$p$,
$p$    (select 'Rule “' || ru.name || '”' from public.rules ru where ru.id = new.rule_id),
    case when new.email_direction = 'received' then new.email_address end,
$p$);

select public.alhc_revoke_anon_grants(array['submitter_reply_threads']);
select public.alhc_revoke_anon_execute(array[
  'guard_comment_email()', 'task_submitter(uuid)', 'fill_comment_email()', 'send_submitter_response(uuid,text)',
  'on_comment_submitter_response()', 'submitter_response_block_reason(uuid)', 'submitter_reply_token(uuid)',
  'log_submitter_reply(text,uuid,uuid,uuid,text,text)', 'post_submitter_reply(text,text,text,text)'
]);

-- TAIL
alter table public.comments drop constraint comments_author_or_rule;
alter table public.comments rename constraint comments_author_or_rule_v2 to comments_author_or_rule;
