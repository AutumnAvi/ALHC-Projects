-- Nov 24 batch 45: the task card redesign's database half. Additive only: new columns, constraints on those
-- new columns, new functions, and asserted patches of existing functions. No object or row is removed and
-- there is no tail.
--
--   1. Team and outside review at the same time ("parallel" order, task_review_settings.review_order). Until
--      now an approval task with approvers sent its outside review check only after the team approved
--      (review_check_send_problem refused it before). In the parallel order the check goes out with the team
--      round; changes asked by either side end the round for both (the next round goes to both); the task is
--      done only when both approved the same round.
--   2. When the last stage of a two-stage approval approves (the outside reviewer in the sequential order,
--      whichever comes last in the parallel one), the task's "When it's approved" step runs by itself
--      (finish_approved_round no longer stops at the team's approval once the outside one is in).
--   3. An outside reviewer due date (task_review_settings.reviewer_due_on → review_checks.due_on), shown in
--      the card and used for the one automatic reminder (the day before it's due).
--   4. The outside review email's send state on the round (sent / failed / mocked / suppressed, the error,
--      Resend's id, and later delivery events), so the card can say whether it went out and offer a retry.
--   5. A separate "Copy review link" link per round, so copying a link never breaks the one that was emailed.
-- Existing sequential and team-only approvals behave as before; existing rows stay valid (every new column is
-- nullable or defaults to the old behavior).

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

-- 1. New columns -------------------------------------------------------------------------------------------

alter table public.task_review_settings
  add column review_order text not null default 'sequential',
  add column reviewer_due_on date,
  add constraint task_review_settings_order_check check (review_order in ('sequential', 'parallel'));

comment on column public.task_review_settings.review_order is
  'Nov 24 batch 45: sequential = the team approves first, then the outside reviewer; parallel = both review '
  'the same round at the same time (only meaningful on an approval task with approvers and a reviewer).';
comment on column public.task_review_settings.reviewer_due_on is
  'Nov 24 batch 45: when the outside reviewer should answer by; copied onto each review check sent.';

grant insert (review_order, reviewer_due_on) on public.task_review_settings to authenticated;
grant update (review_order, reviewer_due_on) on public.task_review_settings to authenticated;

alter table public.review_checks
  add column due_on date,
  add column closed_reason text,
  add column email_status text,
  add column email_error text,
  add column email_attempted_at timestamptz,
  add column provider_message_id text,
  add column delivery_status text,
  add column delivery_event_at timestamptz,
  add column copy_token_hash text,
  add constraint review_checks_closed_reason_check check (closed_reason is null or closed_reason in ('team_changes', 'team_rejected', 'withdrawn_with_round')),
  add constraint review_checks_email_status_check check (email_status is null or email_status in ('sending', 'sent', 'failed', 'mocked', 'suppressed')),
  add constraint review_checks_email_error_check check (email_error is null or char_length(email_error) <= 300),
  add constraint review_checks_provider_message_check check (provider_message_id is null or provider_message_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  add constraint review_checks_delivery_status_check check (
    delivery_status is null or delivery_status in ('delivered', 'delayed', 'bounced', 'complained', 'suppressed')
  );

comment on column public.review_checks.closed_reason is
  'Nov 24 batch 45: why an open round was closed by the approval beside it (parallel order): team_changes = the '
  'team asked for changes (the next round goes to both); team_rejected = the team rejected it; '
  'withdrawn_with_round = the team round was withdrawn.';
comment on column public.review_checks.email_status is
  'Nov 24 batch 45: how the round''s email went when it was last sent (sending = started and not reported back '
  'yet, sent, failed, mocked = no email provider, suppressed = the address bounced before). Written by '
  'record_review_email.';
comment on column public.review_checks.copy_token_hash is
  'Nov 24 batch 45: sha256 of the round''s "Copy review link" link (the emailed link keeps working). Not readable '
  'by clients.';

create unique index review_checks_copy_token_idx on public.review_checks (copy_token_hash)
  where copy_token_hash is not null;
create index review_checks_provider_message_idx on public.review_checks (provider_message_id)
  where provider_message_id is not null;

-- The team reads the round's due date, why it closed, and how its email went; never the link hashes.
grant select (due_on, closed_reason, email_status, email_error, email_attempted_at, delivery_status, delivery_event_at)
  on public.review_checks to authenticated;

alter table public.approval_rounds
  add column closed_reason text,
  add constraint approval_rounds_closed_reason_check check (closed_reason is null or closed_reason in ('outside_changes'));

comment on column public.approval_rounds.closed_reason is
  'Nov 24 batch 45: outside_changes = the outside reviewer asked for changes on this round (parallel order), '
  'which ended it for the team too, even once the team had approved it; the next round goes to both.';

-- 2. Is the task reviewed at the same time? About the task, never the caller ----------------------------

create or replace function public.review_check_parallel(target_task uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.review_check_after_approval(target_task)
    and exists (
      select 1 from public.task_review_settings s
      where s.task_id = target_task and s.review_order = 'parallel'
    );
$$;

revoke all on function public.review_check_parallel(uuid) from public, anon, authenticated;

-- The order can't change under an open round (the round would be judged by the wrong rule).
create or replace function public.guard_task_review_order()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.is_client_role() and (
    tg_op = 'INSERT' and new.review_order <> 'sequential'
    or tg_op = 'UPDATE' and new.review_order is distinct from old.review_order
  ) and (
    exists (select 1 from public.approval_rounds r where r.task_id = new.task_id and r.status = 'pending')
    or exists (select 1 from public.review_checks x where x.task_id = new.task_id and x.status = 'pending')
  ) then
    raise exception 'Change the review order once the current round is decided or withdrawn'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_task_review_order() from public, anon;
grant execute on function public.guard_task_review_order() to authenticated;

create trigger task_review_settings_06_order
  before insert or update on public.task_review_settings
  for each row execute function public.guard_task_review_order();

-- The review order and the outside reviewer's due date, from the approval setup (an upsert through the API
-- would need UPDATE on task_id). Invoker: RLS and the guards decide (Editors+; the order can't change under an
-- open round).
create or replace function public.set_task_review_plan(target_task uuid, plan_order text, plan_due_on date default null)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if not public.has_task_role(target_task, 'editor') then
    raise exception 'Only Owners and Editors can change how this task is reviewed' using errcode = 'insufficient_privilege';
  end if;
  if plan_order is null or plan_order not in ('sequential', 'parallel') then
    raise exception 'Unknown review order' using errcode = 'check_violation';
  end if;
  -- Update first: an insert's BEFORE INSERT guard would see the order as new even when the row exists.
  update public.task_review_settings s
  set review_order = plan_order, reviewer_due_on = plan_due_on
  where s.task_id = target_task;
  if not found then
    insert into public.task_review_settings (task_id, review_order, reviewer_due_on)
    values (target_task, plan_order, plan_due_on);
  end if;
end;
$$;

revoke all on function public.set_task_review_plan(uuid, text, date) from public, anon;
grant execute on function public.set_task_review_plan(uuid, text, date) to authenticated;

-- An open round follows a changed due date (its reminder too).
create or replace function public.sync_review_due_on()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and new.reviewer_due_on is not null
    or tg_op = 'UPDATE' and new.reviewer_due_on is distinct from old.reviewer_due_on then
    update public.review_checks x
    set due_on = new.reviewer_due_on, updated_at = now()
    where x.task_id = new.task_id and x.status = 'pending';
  end if;
  return null;
end;
$$;

revoke all on function public.sync_review_due_on() from public, anon, authenticated;

create trigger task_review_settings_zz_due_on
  after insert or update on public.task_review_settings
  for each row execute function public.sync_review_due_on();

-- A new round takes the task's outside reviewer due date.
create or replace function public.review_checks_fill_due_on()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.due_on is null then
    select s.reviewer_due_on into new.due_on from public.task_review_settings s where s.task_id = new.task_id;
  end if;
  return new;
end;
$$;

revoke all on function public.review_checks_fill_due_on() from public, anon, authenticated;

create trigger review_checks_06_due_on
  before insert on public.review_checks
  for each row execute function public.review_checks_fill_due_on();

-- 3. Who may send the outside review: in the parallel order, Editors and the task's approvers, any time ---

select public.alhc_patch_function(
  'public.review_check_send_problem(uuid)'::regprocedure,
  $old$  if public.review_check_after_approval(target_task) then$old$,
  $new$  -- Nov 24 batch 45: reviewed at the same time, the outside review goes out with the team round, so
  -- whoever sends that round (Editors, the assignee: approval_can_act) and the task's approvers
  -- (Commenter+) send it any time.
  if public.review_check_parallel(target_task) then
    if public.approval_can_act(target_task) or (
      exists (
        select 1 from public.task_approvers a
        where a.task_id = target_task and a.profile_id = me and a.deleted_at is null
      ) and public.has_task_role(target_task, 'commenter')
    ) then
      return null;
    end if;
    return 'editor_only';
  end if;
  if public.review_check_after_approval(target_task) then$new$
);

-- One lock per task for the decisions that touch both the team round and the outside review — the team's
-- decision (decide_approval), withdrawing the round, and the outside reviewer's answer — taken before any row
-- lock, so two of them at the same moment run one after the other (each sees the other's result) instead of
-- deadlocking on the round and review rows they each update.
create or replace function public.approval_task_lock(target_task uuid)
returns void
language sql
volatile
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtextextended('alhc.approval:' || target_task::text, 0));
$$;

revoke all on function public.approval_task_lock(uuid) from public, anon, authenticated;

select public.alhc_patch_function(
  'public.decide_approval(uuid,text,text)'::regprocedure,
  $old$  select * into a from public.approval_requests where id = target_approval and deleted_at is null for update;$old$,
  $new$  -- Nov 24 batch 45: the task's approval lock before any row lock (approval_task_lock).
  perform public.approval_task_lock((select q.task_id from public.approval_requests q where q.id = target_approval));
  select * into a from public.approval_requests where id = target_approval and deleted_at is null for update;$new$
);

select public.alhc_patch_function(
  'public.withdraw_approval(uuid)'::regprocedure,
  $old$  select * into r from public.approval_rounds where task_id = target_task and status = 'pending' for update;$old$,
  $new$  -- Nov 24 batch 45: the task's approval lock before any row lock (approval_task_lock).
  perform public.approval_task_lock(target_task);
  select * into r from public.approval_rounds where task_id = target_task and status = 'pending' for update;$new$
);

select public.alhc_patch_function(
  'public.review_check_decide(text,text,text,jsonb)'::regprocedure,
  $old$  if r.id is not null then
    perform 1 from public.review_checks x where x.id = r.id for update;$old$,
  $new$  if r.id is not null then
    -- Nov 24 batch 45: the task's approval lock before any row lock (approval_task_lock).
    perform public.approval_task_lock(r.task_id);
    perform 1 from public.review_checks x where x.id = r.id for update;$new$
);

-- 4. Done needs both: the outside approval that belongs to a team round --------------------------------

-- True when the task's latest review check is approved and belongs to this team round: sent after the
-- round was sent (parallel order), or after the round was approved (sequential order).
create or replace function public.approval_external_done(target_round uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select x.status = 'approved'
      and x.created_at >= case
        when public.review_check_parallel(r.task_id) then r.sent_at
        else coalesce(r.decided_at, r.sent_at)
      end
    from public.approval_rounds r
    join lateral (
      select y.status, y.created_at from public.review_checks y
      where y.task_id = r.task_id
      order by y.round desc
      limit 1
    ) x on true
    where r.id = target_round
  ), false);
$$;

revoke all on function public.approval_external_done(uuid) from public, anon, authenticated;

select public.alhc_patch_function(
  'public.finish_approved_round(uuid)'::regprocedure,
  $old$  -- Nov 10 batch 37 (note 183): a two-stage task still goes to its external reviewer, so the internal
  -- approval never completes or moves it, whatever "When it's approved" says.
  if public.approval_two_stage(r.task_id) then
    return;
  end if;$old$,
  $new$  -- Nov 10 batch 37 (note 183): a two-stage task still goes to its external reviewer, so the internal
  -- approval alone never completes or moves it. Nov 24 batch 45: once the outside reviewer approved this
  -- round too (whichever came last), "When it's approved" runs.
  if public.approval_two_stage(r.task_id) and not public.approval_external_done(r.id) then
    return;
  end if;$new$
);

-- The outside reviewer's answer: in the parallel order, asking for changes ends the team's open round too;
-- an approval that completes both stages runs the task's "When it's approved" step.
select public.alhc_patch_function(
  'public.review_check_decide(text,text,text,jsonb)'::regprocedure,
  $old$  derived text;
begin$old$,
  $new$  derived text;
  last_round public.approval_rounds;
begin$new$,
  $old$  return jsonb_build_object('status', 'ok', 'review_status', decision);$old$,
  $new$  -- Nov 24 batch 45: reviewed at the same time, changes from the outside reviewer end the team's round as
  -- well: an open one (the round first, so closing its requests can't settle it), or one the team already
  -- approved that is still waiting on the outside reviewer (no outside approval since it was sent), so its
  -- approval can't count for a later outside round. The next round goes to both.
  if decision = 'changes_requested' and public.review_check_parallel(r.task_id) then
    update public.approval_rounds ar
    set status = 'withdrawn', withdrawn_at = now(), closed_reason = 'outside_changes', updated_at = now()
    where ar.id = (
        select lr.id from public.approval_rounds lr where lr.task_id = r.task_id order by lr.round_number desc limit 1
      )
      and (
        ar.status = 'pending'
        or ar.status = 'approved' and not exists (
          select 1 from public.review_checks y
          where y.task_id = ar.task_id and y.status = 'approved' and y.created_at >= ar.sent_at
        )
      );
    update public.approval_requests q
    set status = 'cancelled', cancel_reason = 'round_closed'
    from public.approval_rounds ar
    where ar.task_id = r.task_id and ar.closed_reason = 'outside_changes' and ar.withdrawn_at = now()
      and q.round_id = ar.id and q.status = 'pending' and q.deleted_at is null;
  end if;
  -- Nov 24 batch 45: the last stage approved (sequential: the outside reviewer after the team; parallel:
  -- whichever answered last): run the task's "When it's approved" step.
  if decision = 'approved' and public.approval_two_stage(r.task_id) then
    -- The round row is the lock both stages share (settle_approval_round locks it too): a team approval
    -- deciding at the same moment either finished first (seen here, re-read after the wait) or waits and
    -- then sees this approval, so "When it's approved" runs exactly once.
    select * into last_round from public.approval_rounds ar
    where ar.task_id = r.task_id
    order by ar.round_number desc
    limit 1
    for update;
    if found and last_round.status = 'approved' and public.approval_external_done(last_round.id) then
      perform public.finish_approved_round(last_round.id);
    end if;
  end if;
  return jsonb_build_object('status', 'ok', 'review_status', decision);$new$
);

-- The team asks for changes (or rejects) in the parallel order: the outside reviewer's open round of the
-- same round closes too, so the next round goes to both.
select public.alhc_patch_function(
  'public.settle_approval_round()'::regprocedure,
  $old$    update public.approval_requests
    set status = 'cancelled', cancel_reason = 'round_closed'
    where round_id = r.id and status = 'pending' and id <> new.id and deleted_at is null;
    return null;$old$,
  $new$    update public.approval_requests
    set status = 'cancelled', cancel_reason = 'round_closed'
    where round_id = r.id and status = 'pending' and id <> new.id and deleted_at is null;
    -- Nov 24 batch 45: reviewed at the same time, the outside reviewer's open round ends with the team's.
    if public.review_check_parallel(r.task_id) then
      update public.review_checks x
      set status = 'superseded',
          closed_reason = case when new.status = 'rejected' then 'team_rejected' else 'team_changes' end,
          updated_at = now()
      where x.task_id = r.task_id and x.status = 'pending' and x.created_at >= r.sent_at;
    end if;
    return null;$new$
);

-- Withdrawing the team round in the parallel order takes back the outside review sent with it.
select public.alhc_patch_function(
  'public.withdraw_approval(uuid)'::regprocedure,
  $old$  update public.approval_requests
  set status = 'cancelled', cancel_reason = 'withdrawn'
  where round_id = r.id and status = 'pending' and deleted_at is null;
end;$old$,
  $new$  update public.approval_requests
  set status = 'cancelled', cancel_reason = 'withdrawn'
  where round_id = r.id and status = 'pending' and deleted_at is null;
  -- Nov 24 batch 45: reviewed at the same time, the outside review sent with this round goes back too.
  if public.review_check_parallel(target_task) then
    update public.review_checks x
    set status = 'cancelled', closed_reason = 'withdrawn_with_round', updated_at = now()
    where x.task_id = target_task and x.status = 'pending' and x.created_at >= r.sent_at;
  end if;
end;$new$
);

-- 5. The one automatic reminder: the day before the outside reviewer's due date, when there is one ---------

select public.alhc_patch_function(
  'public.review_nudge_due(public.review_checks)'::regprocedure,
  $old$    and r.created_at <= now() - interval '24 hours'
    and r.created_at > now() - interval '72 hours'$old$,
  $new$    and case
      when r.due_on is null then
        r.created_at <= now() - interval '24 hours' and r.created_at > now() - interval '72 hours'
      -- Nov 24 batch 45: with a due date, the day before it's due (never in the first 12 hours after sending),
      -- until two days after it.
      else r.created_at <= now() - interval '12 hours'
        and now() >= (r.due_on - 1)::timestamptz
        and now() < (r.due_on + 2)::timestamptz
    end$new$
);

select public.alhc_patch_function(
  'public.claim_review_nudges(integer)'::regprocedure,
  $old$      and x.created_at <= now() - interval '24 hours' and x.created_at > now() - interval '72 hours'$old$,
  $new$      -- Nov 24 batch 45: only rounds whose reminder is due now (with a due date that's the day before it),
      -- before the batch limit, so rounds that aren't due never fill the batch ahead of one that is.
      and x.created_at <= now() - interval '12 hours' and public.review_nudge_due(x)$new$
);

select public.alhc_patch_function(
  'public.alhc_kick_delivery()'::regprocedure,
  $old$         and x.created_at <= now() - interval '24 hours' and x.created_at > now() - interval '72 hours'$old$,
  $new$         and x.created_at <= now() - interval '12 hours'$new$
);

-- 6. How the round's email went -------------------------------------------------------------------------

-- The app reports each send of a round's email (the first one and every "Send again"): "sending" before it
-- tries (so a send cut off midway is visible), then how it went. Whoever sent the round, or anyone who may
-- send it now. Sent (with Resend's id) clears an earlier failure.
create or replace function public.record_review_email(
  target_review uuid,
  outcome text,
  error_text text default null,
  provider_id text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.review_checks;
begin
  select * into r from public.review_checks x where x.id = target_review for update;
  if not found or not public.has_task_role(r.task_id, 'viewer') then
    raise exception 'Review not found' using errcode = 'no_data_found';
  end if;
  if r.created_by is distinct from auth.uid() and public.review_check_send_problem(r.task_id) is not null then
    raise exception 'Only whoever may send this review can record its email' using errcode = 'insufficient_privilege';
  end if;
  if outcome is null or outcome not in ('sending', 'sent', 'failed', 'mocked', 'suppressed') then
    raise exception 'Unknown email outcome' using errcode = 'check_violation';
  end if;
  update public.review_checks x
  set email_status = outcome,
      email_error = case when outcome = 'failed' then left(coalesce(nullif(btrim(error_text), ''), 'The email couldn''t be sent'), 300) end,
      email_attempted_at = now(),
      -- Resend's id, unless another email already has it (delivery events match on it, so an id copied from
      -- another email can't put this round's address on the suppression list).
      provider_message_id = case
        when outcome = 'sent' and provider_id ~ '^[A-Za-z0-9_-]{1,100}$'
          and not exists (select 1 from public.review_checks y where y.provider_message_id = provider_id and y.id <> r.id)
          and not exists (select 1 from public.email_outbox o where o.provider_message_id = provider_id)
        then provider_id
      end,
      delivery_status = null,
      delivery_event_at = null,
      updated_at = now()
  where x.id = r.id;
end;
$$;

revoke all on function public.record_review_email(uuid, text, text, text) from public, anon;
grant execute on function public.record_review_email(uuid, text, text, text) to authenticated;

-- Resend's delivery events for a review check's email (it never sits in the outbox): the strongest event
-- wins, and a permanent bounce / complaint / suppression adds the address to the suppression list, as for
-- every other email. Called by record_email_event when the id isn't an outbox row's.
create or replace function public.record_review_email_event(
  provider_email_id text,
  new_status text,
  happened timestamptz,
  bounce_type text,
  bounce_subtype text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.review_checks;
  ranks text[] := array['delayed', 'delivered', 'bounced', 'suppressed', 'complained'];
  suppress text;
  detail text;
begin
  select * into r from public.review_checks x
  where x.provider_message_id = provider_email_id
  order by x.created_at desc
  limit 1
  for update;
  if not found then
    return jsonb_build_object('ok', true, 'status', 'unknown');
  end if;
  if coalesce(array_position(ranks, new_status), 0) >= coalesce(array_position(ranks, r.delivery_status), 0) then
    update public.review_checks x
    set delivery_status = new_status, delivery_event_at = happened, updated_at = now()
    where x.id = r.id;
  end if;
  detail := case
    when new_status in ('bounced', 'suppressed') then
      nullif(left(concat_ws(' · ', nullif(btrim(bounce_type), ''), nullif(btrim(bounce_subtype), '')), 300), '')
  end;
  suppress := case
    when new_status = 'complained' then 'complained'
    when new_status = 'suppressed' then 'suppressed'
    when new_status = 'bounced' and lower(coalesce(btrim(bounce_type), '')) = 'permanent' then 'bounced'
  end;
  if suppress is not null and not exists (
    select 1 from public.email_suppressions s
    where s.email = r.recipient_email and s.cleared_at is not null and s.cleared_at >= happened
  ) then
    insert into public.email_suppressions (email, reason, detail, email_kind, created_at)
    values (r.recipient_email, suppress, detail, 'review_check', happened)
    on conflict (email) where cleared_at is null do nothing;
  end if;
  return jsonb_build_object('ok', true, 'status', new_status, 'suppressed', suppress is not null, 'review', true);
end;
$$;

revoke all on function public.record_review_email_event(text, text, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.record_review_email_event(text, text, timestamptz, text, text) to service_role;

select public.alhc_patch_function(
  'public.record_email_event(text,text,timestamp with time zone,text,text)'::regprocedure,
  $old$  for update;
  if not found then
    return jsonb_build_object('ok', true, 'status', 'unknown');
  end if;$old$,
  $new$  for update;
  if not found then
    -- Nov 24 batch 45: a review check's email (sent straight away, never through the outbox).
    return public.record_review_email_event(provider_email_id, new_status, happened, bounce_type, bounce_subtype);
  end if;$new$
);

-- 7. "Copy review link": its own link per round ----------------------------------------------------------

-- A fresh copyable link for an open round (returned once; only its hash is kept). The emailed link keeps
-- working; copying again replaces the previous copied link. Only whoever may send the round (so on an
-- approval task reviewed in order, only its approvers, as for sending).
create or replace function public.review_check_copy_link(target_review uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.review_checks;
  token text;
begin
  select * into r from public.review_checks x where x.id = target_review for update;
  if not found or not public.has_task_role(r.task_id, 'viewer') then
    raise exception 'Review not found' using errcode = 'no_data_found';
  end if;
  if public.review_check_send_problem(r.task_id) is not null then
    raise exception '%', public.review_check_send_message(public.review_check_send_problem(r.task_id))
      using errcode = 'insufficient_privilege';
  end if;
  if r.status <> 'pending' or r.expires_at <= now() then
    raise exception 'This review round is closed' using errcode = 'check_violation';
  end if;
  token := 'alhc_rev_' || public.inbound_random_hex();
  update public.review_checks x set copy_token_hash = public.inbound_token_hash(token), updated_at = now()
  where x.id = r.id;
  return token;
end;
$$;

revoke all on function public.review_check_copy_link(uuid) from public, anon;
grant execute on function public.review_check_copy_link(uuid) to authenticated;

select public.alhc_patch_function(
  'public.review_check_by_token(text)'::regprocedure,
  $old$  if r.id is null then
    select * into r from public.review_checks x where x.nudge_token_hash = public.inbound_token_hash(review_token);
  end if;$old$,
  $new$  if r.id is null then
    select * into r from public.review_checks x where x.nudge_token_hash = public.inbound_token_hash(review_token);
  end if;
  -- Nov 24 batch 45: a copied link ("Copy review link") opens the same round.
  if r.id is null then
    select * into r from public.review_checks x where x.copy_token_hash = public.inbound_token_hash(review_token);
  end if;$new$
);

-- "Send again" replaces every link of the round, the copied one too.
select public.alhc_patch_function(
  'public.rotate_review_check_token(uuid)'::regprocedure,
  $old$      nudge_token_hash = null, nudged_at = coalesce(x.nudged_at, now()),$old$,
  $new$      nudge_token_hash = null, nudged_at = coalesce(x.nudged_at, now()), copy_token_hash = null,$new$
);

-- 8. The task pane reads the plan (order, due date) and the latest round's due date and email state -----

select public.alhc_patch_function(
  'public.task_pane_rows(uuid,integer,integer)'::regprocedure,
  $old$      'latest', (
        select jsonb_build_object('id', x.id, 'round', x.round, 'status', x.status, 'recipient_email', x.recipient_email,
          'recipient_name', x.recipient_name, 'created_at', x.created_at, 'decided_at', x.decided_at, 'nudged_at', x.nudged_at)
        from public.review_checks x$old$,
  $new$      -- Nov 24 batch 45: the review order and the outside reviewer's due date.
      'plan', (
        select jsonb_build_object('order', s.review_order, 'due_on', s.reviewer_due_on)
        from public.task_review_settings s
        where s.task_id = target_task
      ),
      'latest', (
        select jsonb_build_object('id', x.id, 'round', x.round, 'status', x.status, 'recipient_email', x.recipient_email,
          'recipient_name', x.recipient_name, 'created_at', x.created_at, 'decided_at', x.decided_at, 'nudged_at', x.nudged_at,
          'due_on', x.due_on, 'closed_reason', x.closed_reason, 'created_by', x.created_by,
          'last_viewed_at', x.last_viewed_at, 'email_status', x.email_status, 'email_error', x.email_error,
          'email_attempted_at', x.email_attempted_at, 'delivery_status', x.delivery_status,
          'file_results', x.file_results,
          'file_count', (select count(*) from public.review_check_assets ra where ra.review_id = x.id),
          'pin_count', (select count(*) from public.review_check_pins rp where rp.review_id = x.id))
        from public.review_checks x$new$
);
