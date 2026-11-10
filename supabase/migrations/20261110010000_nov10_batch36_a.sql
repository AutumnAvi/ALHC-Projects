-- Nov 10 batch 36: the production audit fixes (FLAW-AUDIT-CLAUDE-NOV9 / FLAW-AUDIT-NOV9) and the approval
-- rework (APPROVAL-DESIGN-NOV10 with Avi's final answers). Additive: no object or row is removed, no tail.
--
--   1. Owners AND Editors build automations and forms: the rules / forms / portfolio_rules write policies
--      compare with the Editor set instead of Admin, and test_rule (the dry run) needs Editor.
--   2. No more dead "Admin" role from two actions: Transfer ownership (projects and portfolios) leaves the
--      old owner an Editor, and Duplicate project's members option brings other owners (and older Admins)
--      in as Editors.
--   3. The external review check and the internal approval stay separate, and when a task has both they run
--      in order: on an approval task with approvers, only one of its approvers sends (or sends again) the
--      review check, and only after the internal round is approved. A review check's decision no longer
--      reads like (or acts like) the internal approval: its Inbox item says who the external reviewer is
--      (data.external), it also reaches the person who sent the check, and it no longer fires "An approval
--      is decided" automations.
--   4. The intended external reviewer of a task (task_review_settings), set before anything is sent, so the
--      approval setup and the approver's review page can name them and the send screen prefills them.
--   5. One automatic reminder email to the external reviewer 24 hours after the check was sent, if it's
--      still undecided (review_checks.nudged_at …; claim_review_nudges / finish_review_nudge for the app's
--      cron route, which emails the link directly like every review email; the delivery kick wakes it).
--      The reminder carries its own link (nudge_token_hash); the first email's link keeps working.
--   6. Task lists learn when a task's latest external review was approved (the green dot).
--   7. Wording the database writes: "the automation's owner", and an external reviewer named as such.
--   8. Home's "Your team" lead cards count only projects someone else is also in.

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

-- 1. Owners and Editors build automations and forms -----------------------------------------------------

alter policy rules_insert_admin on public.rules
  with check (project_id = any ((select public.project_ids_with_role('editor'))::uuid[]));
alter policy rules_update_admin on public.rules
  using (project_id = any ((select public.project_ids_with_role('editor'))::uuid[]))
  with check (project_id = any ((select public.project_ids_with_role('editor'))::uuid[]));
alter policy rules_insert_admin on public.rules rename to rules_insert_editor;
alter policy rules_update_admin on public.rules rename to rules_update_editor;

alter policy forms_insert_admin on public.forms
  with check (project_id = any ((select public.project_ids_with_role('editor'))::uuid[]));
alter policy forms_update_admin on public.forms
  using (project_id = any ((select public.project_ids_with_role('editor'))::uuid[]))
  with check (project_id = any ((select public.project_ids_with_role('editor'))::uuid[]));
alter policy forms_insert_admin on public.forms rename to forms_insert_editor;
alter policy forms_update_admin on public.forms rename to forms_update_editor;

alter policy portfolio_rules_insert_admin on public.portfolio_rules
  with check (created_by = (select auth.uid())
    and portfolio_id = any ((select public.portfolio_ids_with_role('editor'))::uuid[]));
alter policy portfolio_rules_update_admin on public.portfolio_rules
  using (portfolio_id = any ((select public.portfolio_ids_with_role('editor'))::uuid[]))
  with check (portfolio_id = any ((select public.portfolio_ids_with_role('editor'))::uuid[]));
alter policy portfolio_rules_insert_admin on public.portfolio_rules rename to portfolio_rules_insert_editor;
alter policy portfolio_rules_update_admin on public.portfolio_rules rename to portfolio_rules_update_editor;

select public.alhc_patch_function(
  'public.test_rule(uuid,uuid,jsonb)'::regprocedure,
  $old$  if rule_project is null or not public.has_project_role(rule_project, 'admin') then
    raise exception 'Only project admins and owners test rules' using errcode = 'insufficient_privilege';$old$,
  $new$  if rule_project is null or not public.has_project_role(rule_project, 'editor') then
    raise exception 'Only the project''s Owners and Editors test automations' using errcode = 'insufficient_privilege';$new$
);

-- 2. Transfer ownership and Duplicate project never hand out Admin --------------------------------------

select public.alhc_patch_function(
  'public.transfer_project_ownership(uuid,uuid)'::regprocedure,
  $old$  update public.project_members set role = 'admin'
  where project_id = target_project and profile_id = auth.uid() and deleted_at is null;$old$,
  $new$  -- Nov 10 batch 36: the old owner stays on as an Editor (Admin isn't given out any more).
  update public.project_members set role = 'editor'
  where project_id = target_project and profile_id = auth.uid() and deleted_at is null;$new$
);

select public.alhc_patch_function(
  'public.transfer_portfolio_ownership(uuid,uuid)'::regprocedure,
  $old$  update public.portfolio_members set role = 'admin'
  where portfolio_id = target_portfolio and profile_id = auth.uid() and deleted_at is null;$old$,
  $new$  -- Nov 10 batch 36: the old owner stays on as an Editor (Admin isn't given out any more).
  update public.portfolio_members set role = 'editor'
  where portfolio_id = target_portfolio and profile_id = auth.uid() and deleted_at is null;$new$
);

select public.alhc_patch_function(
  'public.instantiate_project_snapshot(jsonb,text,date,uuid,text,jsonb)'::regprocedure,
  $old$  -- Members (Duplicate project only): owners of the source join as admins; the caller stays owner.$old$,
  $new$  -- Members (Duplicate project only): owners (and older Admins) of the source join as Editors; the
  -- caller stays the only owner (Nov 10 batch 36: Admin isn't given out any more).$new$,
  $old$    values (new_project, found_id, case when item ->> 'role' = 'owner' then 'admin' else item ->> 'role' end, me);$old$,
  $new$    values (new_project, found_id, case when item ->> 'role' in ('owner', 'admin') then 'editor' else item ->> 'role' end, me);$new$
);

-- 3. The external review check and the internal approval, in order ------------------------------------

-- An approval task with approvers runs both steps in order: the internal approvers decide first, then one
-- of them sends the external review check. True for such a task (about the task, never the caller).
create or replace function public.review_check_after_approval(target_task uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tasks t
    where t.id = target_task
      and t.kind = 'approval'
      and exists (
        select 1 from public.task_approvers a
        where a.task_id = t.id and a.deleted_at is null
      )
  );
$$;

revoke all on function public.review_check_after_approval(uuid) from public, anon, authenticated;


-- Whether the caller may send (or send again, or withdraw) the task's review check. On an approval task
-- with approvers: only an active approver who can at least comment, and only once the latest internal round
-- is approved. Anywhere else: Editors, as before. Returns the reason it can't, or null.
create or replace function public.review_check_send_problem(target_task uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
begin
  if me is null or not public.has_task_role(target_task, 'viewer') then
    return 'not_found';
  end if;
  if public.review_check_after_approval(target_task) then
    if not exists (
      select 1 from public.task_approvers a
      where a.task_id = target_task and a.profile_id = me and a.deleted_at is null
    ) or not public.has_task_role(target_task, 'commenter') then
      return 'approver_only';
    end if;
    if not public.approval_round_approved(target_task) then
      return 'not_approved';
    end if;
    return null;
  end if;
  if not public.has_task_role(target_task, 'editor') then
    return 'editor_only';
  end if;
  return null;
end;
$$;

revoke all on function public.review_check_send_problem(uuid) from public, anon, authenticated;


create or replace function public.review_check_send_message(problem text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case problem
    when 'approver_only' then 'This task has an internal approver, so only the internal approver can send it to the external reviewer, after approving it'
    when 'not_approved' then 'Approve the task first: it goes to the external reviewer after the internal approval is done'
    else 'Only Owners and Editors can send a review check'
  end;
$$;

revoke all on function public.review_check_send_message(text) from public, anon, authenticated;

select public.alhc_patch_function(
  'public.create_review_check(uuid,uuid[],text,text,text)'::regprocedure,
  $old$  if not public.has_task_role(t.id, 'editor') then
    raise exception 'Only editors can send a review check' using errcode = 'insufficient_privilege';
  end if;$old$,
  $new$  -- Nov 10 batch 36: an approval task with approvers goes to the external reviewer only through one of
  -- its approvers, after the internal approval (review_check_send_problem).
  if public.review_check_send_problem(t.id) is not null then
    raise exception '%', public.review_check_send_message(public.review_check_send_problem(t.id))
      using errcode = 'insufficient_privilege';
  end if;$new$
);

select public.alhc_patch_function(
  'public.rotate_review_check_token(uuid)'::regprocedure,
  $old$  if not public.has_task_role(r.task_id, 'editor') then
    raise exception 'Only editors can send a review check' using errcode = 'insufficient_privilege';
  end if;$old$,
  $new$  if public.review_check_send_problem(r.task_id) is not null then
    raise exception '%', public.review_check_send_message(public.review_check_send_problem(r.task_id))
      using errcode = 'insufficient_privilege';
  end if;$new$
);

select public.alhc_patch_function(
  'public.cancel_review_check(uuid)'::regprocedure,
  $old$  if not public.has_task_role(r.task_id, 'editor') then
    raise exception 'Only editors can withdraw a review check' using errcode = 'insufficient_privilege';
  end if;$old$,
  $new$  -- Editors withdraw (also on an approval task, e.g. before switching to the internal-first order);
  -- so does the approver who may send it.
  if not public.has_task_role(r.task_id, 'editor') and public.review_check_send_problem(r.task_id) is not null then
    raise exception 'Only Owners, Editors, and the task''s approvers can withdraw a review check' using errcode = 'insufficient_privilege';
  end if;$new$
);

-- The decision: tell the assignee (who gets the feedback) and whoever sent the check, worded as the external
-- reviewer's, and leave the internal approval and its automations alone.
select public.alhc_patch_function(
  'public.review_check_decide(text,text,text,jsonb)'::regprocedure,
  $old$  assignee := t.assignee_id;
  if assignee is not null then
    perform public.notify_with(assignee, r.task_id, 'approval_decided', new_comment, jsonb_build_object(
      'review_check_id', r.id, 'round', r.round, 'status', decision, 'note', clean_note,
      'reviewer_email', r.recipient_email, 'pins', n
    ));
  end if;$old$,
  $new$  -- Nov 10 batch 36: the assignee and the person who sent the check hear about it, worded as the
  -- external reviewer's decision (data.external), never the internal approval's.
  for assignee in
    select distinct x from unnest(array[t.assignee_id, r.created_by]) x where x is not null
  loop
    perform public.notify_with(assignee, r.task_id, 'approval_decided', new_comment, jsonb_build_object(
      'review_check_id', r.id, 'round', r.round, 'status', decision, 'note', clean_note,
      'reviewer_email', r.recipient_email, 'reviewer_name', r.recipient_name, 'external', true, 'pins', n
    ));
  end loop;$new$,
  $old$  -- Rules skip subtasks, as for every approval.
  if t.parent_task_id is null then
    perform public.fire_rules('approval_decided', r.task_id, null, jsonb_build_object(
      'review_check_id', r.id, 'status', decision, 'note', clean_note, 'reviewer_email', r.recipient_email
    ));
  end if;$old$,
  $new$  -- Nov 10 batch 36: an external review's decision isn't the internal approval, so "An approval is
  -- decided" automations don't run for it (the comment it posts still runs "A comment is added" ones).$new$
);

-- 4. The intended external reviewer -------------------------------------------------------------------

create table public.task_review_settings (
  task_id uuid primary key references public.tasks (id),
  reviewer_email text,
  reviewer_name text,
  updated_by uuid references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint task_review_settings_email_check check (
    reviewer_email is null or (length(reviewer_email) <= 320 and reviewer_email ~ '^[^@<>",;[:space:]]+@[^@<>",;[:space:]]+\.[^@<>",;[:space:]]+$')
  ),
  constraint task_review_settings_name_check check (reviewer_name is null or length(reviewer_name) between 1 and 200)
);

comment on table public.task_review_settings is
  'Nov 10 batch 36: who a task''s external review check is meant for, set before it''s sent (prefills Send '
  'review check; named by the approval setup and the approver''s review page). Read with the task, Editors+ '
  'write; nothing here sends anything.';

alter table public.task_review_settings enable row level security;
select public.alhc_revoke_anon_grants(array['task_review_settings']);
select public.alhc_revoke_client_truncate(array['task_review_settings']);
revoke all on public.task_review_settings from authenticated;
grant select on public.task_review_settings to authenticated;
grant insert (task_id, reviewer_email, reviewer_name) on public.task_review_settings to authenticated;
grant update (reviewer_email, reviewer_name) on public.task_review_settings to authenticated;
create index task_review_settings_updated_by_idx on public.task_review_settings (updated_by);

create policy task_review_settings_select_viewer on public.task_review_settings
  for select to authenticated
  using (
    exists (
      select 1 from public.task_projects tp_rls
      where tp_rls.task_id = task_review_settings.task_id and tp_rls.deleted_at is null
        and tp_rls.project_id = any ((select public.project_ids_with_role('viewer'))::uuid[])
    )
    or (select public.has_task_role(task_review_settings.task_id, 'viewer'))
  );

create policy task_review_settings_insert_editor on public.task_review_settings
  for insert to authenticated
  with check (
    exists (
      select 1 from public.task_projects tp_rls
      where tp_rls.task_id = task_review_settings.task_id and tp_rls.deleted_at is null
        and tp_rls.project_id = any ((select public.project_ids_with_role('editor'))::uuid[])
    )
    or (select public.has_task_role(task_review_settings.task_id, 'editor'))
  );

create policy task_review_settings_update_editor on public.task_review_settings
  for update to authenticated
  using (
    exists (
      select 1 from public.task_projects tp_rls
      where tp_rls.task_id = task_review_settings.task_id and tp_rls.deleted_at is null
        and tp_rls.project_id = any ((select public.project_ids_with_role('editor'))::uuid[])
    )
    or (select public.has_task_role(task_review_settings.task_id, 'editor'))
  )
  with check (
    exists (
      select 1 from public.task_projects tp_rls
      where tp_rls.task_id = task_review_settings.task_id and tp_rls.deleted_at is null
        and tp_rls.project_id = any ((select public.project_ids_with_role('editor'))::uuid[])
    )
    or (select public.has_task_role(task_review_settings.task_id, 'editor'))
  );

-- Who writes and when, whatever the client sent; addresses lowercased and trimmed.
create or replace function public.guard_task_review_settings()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.reviewer_email := nullif(lower(btrim(coalesce(new.reviewer_email, ''))), '');
  new.reviewer_name := nullif(left(btrim(coalesce(new.reviewer_name, '')), 200), '');
  if new.reviewer_email is null then
    new.reviewer_name := null;
  end if;
  if tg_op = 'UPDATE' then
    new.task_id := old.task_id;
    new.created_at := old.created_at;
  else
    new.created_at := now();
  end if;
  new.updated_at := now();
  if public.is_client_role() then
    new.updated_by := auth.uid();
  end if;
  return new;
end;
$$;

revoke all on function public.guard_task_review_settings() from public, anon;
grant execute on function public.guard_task_review_settings() to authenticated;

create trigger task_review_settings_05_guard
  before insert or update on public.task_review_settings
  for each row execute function public.guard_task_review_settings();

-- Set (or clear, with a null address) the task's intended external reviewer. Invoker: RLS decides.
create or replace function public.set_task_external_reviewer(target_task uuid, reviewer text, reviewer_display text default null)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if not public.has_task_role(target_task, 'editor') then
    raise exception 'Only Owners and Editors can choose the external reviewer' using errcode = 'insufficient_privilege';
  end if;
  insert into public.task_review_settings (task_id, reviewer_email, reviewer_name)
  values (target_task, reviewer, reviewer_display)
  on conflict (task_id) do update
    set reviewer_email = excluded.reviewer_email, reviewer_name = excluded.reviewer_name;
end;
$$;

revoke all on function public.set_task_external_reviewer(uuid, text, text) from public, anon;
grant execute on function public.set_task_external_reviewer(uuid, text, text) to authenticated;

-- 5. One reminder 24 hours after sending ---------------------------------------------------------------

alter table public.review_checks
  add column nudged_at timestamptz,
  add column nudge_attempts integer not null default 0,
  add column nudge_claimed_at timestamptz,
  add column nudge_token_hash text;

create unique index review_checks_nudge_token_idx on public.review_checks (nudge_token_hash)
  where nudge_token_hash is not null;
create index review_checks_nudge_due_idx on public.review_checks (created_at)
  where status = 'pending' and nudged_at is null;

-- The team sees whether a reminder went out; the reminder's link hash stays unreadable like the first one.
grant select (nudged_at) on public.review_checks to authenticated;

comment on column public.review_checks.nudge_token_hash is
  'Nov 10 batch 36: sha256 of the link in the one automatic reminder (the first email''s link keeps working '
  'too). Not readable by clients.';

select public.alhc_patch_function(
  'public.review_check_by_token(text)'::regprocedure,
  $old$  select * into r from public.review_checks x where x.token_hash = public.inbound_token_hash(review_token);$old$,
  $new$  select * into r from public.review_checks x where x.token_hash = public.inbound_token_hash(review_token);
  -- Nov 10 batch 36: the automatic reminder's own link opens the same round.
  if r.id is null then
    select * into r from public.review_checks x where x.nudge_token_hash = public.inbound_token_hash(review_token);
  end if;$new$
);

-- "Send again" replaces every link of the round (the reminder's too), and counts as the reminder.
select public.alhc_patch_function(
  'public.rotate_review_check_token(uuid)'::regprocedure,
  $old$  set token_hash = public.inbound_token_hash(token), token_hint = '…' || right(token, 4),$old$,
  $new$  set token_hash = public.inbound_token_hash(token), token_hint = '…' || right(token, 4),
      nudge_token_hash = null, nudged_at = coalesce(x.nudged_at, now()),$new$
);

-- A round is due a reminder 24 to 72 hours after it was sent (older rounds — e.g. ones sent before this
-- release, or missed while the app was down — get none), still undecided, not expired, the task live, the
-- address not suppressed, at most three tries ten minutes apart.
create or replace function public.review_nudge_due(r public.review_checks)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select r.status = 'pending'
    and r.nudged_at is null
    and r.nudge_attempts < 3
    and (r.nudge_claimed_at is null or r.nudge_claimed_at < now() - interval '10 minutes')
    and r.created_at <= now() - interval '24 hours'
    and r.created_at > now() - interval '72 hours'
    and r.expires_at > now() + interval '1 hour'
    and exists (select 1 from public.tasks t where t.id = r.task_id and t.deleted_at is null)
    and not exists (
      select 1 from public.email_suppressions s where s.email = r.recipient_email and s.cleared_at is null
    );
$$;

revoke all on function public.review_nudge_due(public.review_checks) from public, anon, authenticated;

-- The app's cron route (service role) claims due reminders. Each claimed round gets a fresh reminder link
-- (returned once, only its hash is kept) and the facts its email shows. Nothing about other tasks.
create or replace function public.claim_review_nudges(max_items integer default 20)
returns table (
  review_id uuid,
  task_id uuid,
  token text,
  recipient_email text,
  recipient_name text,
  round integer,
  message text,
  task_title text,
  sender_name text,
  project_name text,
  sent_at timestamptz,
  expires_at timestamptz,
  files jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.review_checks;
  fresh text;
begin
  for r in
    select x.* from public.review_checks x
    where x.status = 'pending' and x.nudged_at is null
      and x.created_at <= now() - interval '24 hours' and x.created_at > now() - interval '72 hours'
    order by x.created_at
    limit greatest(1, least(coalesce(max_items, 20), 100))
    for update skip locked
  loop
    continue when not public.review_nudge_due(r);
    fresh := 'alhc_rev_' || public.inbound_random_hex();
    update public.review_checks x
    set nudge_claimed_at = now(), nudge_attempts = x.nudge_attempts + 1,
        nudge_token_hash = public.inbound_token_hash(fresh)
    where x.id = r.id;
    review_id := r.id;
    task_id := r.task_id;
    token := fresh;
    recipient_email := r.recipient_email;
    recipient_name := r.recipient_name;
    round := r.round;
    message := r.message;
    task_title := (select t.title from public.tasks t where t.id = r.task_id);
    sender_name := (
      select coalesce(nullif(btrim(p.full_name), ''), split_part(p.email, '@', 1))
      from public.profiles p where p.id = r.created_by
    );
    project_name := (select p.name from public.projects p where p.id = r.project_id and p.deleted_at is null);
    sent_at := r.created_at;
    expires_at := r.expires_at;
    files := coalesce((
      select jsonb_agg(jsonb_build_object('asset_id', ra.id, 'name', a.file_name, 'content_type', a.content_type)
        order by ra.sort_order, a.file_name)
      from public.review_check_assets ra
      join public.task_attachments a on a.id = ra.attachment_id
      where ra.review_id = r.id
    ), '[]'::jsonb);
    return next;
  end loop;
end;
$$;

revoke all on function public.claim_review_nudges(integer) from public, anon, authenticated;
grant execute on function public.claim_review_nudges(integer) to service_role;

-- The app reports how the reminder went: sent (or mocked) = done for good; failed = tried again later
-- (up to three tries), its link dropped.
create or replace function public.finish_review_nudge(target_review uuid, sent boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if sent then
    update public.review_checks x set nudged_at = now() where x.id = target_review and x.nudged_at is null;
  else
    update public.review_checks x set nudge_token_hash = null where x.id = target_review and x.nudged_at is null;
  end if;
end;
$$;

revoke all on function public.finish_review_nudge(uuid, boolean) from public, anon, authenticated;
grant execute on function public.finish_review_nudge(uuid, boolean) to service_role;

-- The every-minute delivery kick also wakes the app for a due reminder.
select public.alhc_patch_function(
  'public.alhc_kick_delivery()'::regprocedure,
  $old$     and not exists (
       select 1 from public.integration_outbox o
       where o.deleted_at is null and o.send_after <= now() and o.attempts < o.max_attempts
         and (o.status = 'pending' or (o.status = 'sending' and o.updated_at < now() - interval '10 minutes'))
     ) then$old$,
  $new$     and not exists (
       select 1 from public.integration_outbox o
       where o.deleted_at is null and o.send_after <= now() and o.attempts < o.max_attempts
         and (o.status = 'pending' or (o.status = 'sending' and o.updated_at < now() - interval '10 minutes'))
     )
     and not exists (
       select 1 from public.review_checks x
       where x.status = 'pending' and x.nudged_at is null
         and x.created_at <= now() - interval '24 hours' and x.created_at > now() - interval '72 hours'
         and public.review_nudge_due(x)
     ) then$new$
);

-- 6. Task lists: the latest external review was approved ----------------------------------------------

select public.alhc_patch_function(
  'public.project_task_cards(uuid,uuid[])'::regprocedure,
  $old$  approvals as (
    select m.task_id,$old$,
  $new$  -- Nov 10 batch 36: the task's latest external review check was approved (the green dot).
  external_reviews as (
    select m.task_id
    from member m
    where (
      select x.status from public.review_checks x
      where x.task_id = m.task_id
      order by x.round desc
      limit 1
    ) = 'approved'
  ),
  approvals as (
    select m.task_id,$new$,
  $old$      'approval_is_approver', coalesce(ap.is_approver, false)
    )$old$,
  $new$      'approval_is_approver', coalesce(ap.is_approver, false),
      'external_approved', er.task_id is not null
    )$new$,
  $old$  left join approvals ap on ap.task_id = m.task_id;$old$,
  $new$  left join approvals ap on ap.task_id = m.task_id
  left join external_reviews er on er.task_id = m.task_id;$new$
);

select public.alhc_patch_function(
  'public.my_task_cards()'::regprocedure,
  $old$        'assigned_at', k.assigned_at,
        'date_prompt', k.date_prompt
      ) order by k.due_on nulls last, k.created_at, k.id)$old$,
  $new$        'assigned_at', k.assigned_at,
        'date_prompt', k.date_prompt,
        -- Nov 10 batch 36: the latest external review check was approved (the green dot).
        'external_approved', coalesce((
          select x.status = 'approved' from public.review_checks x
          where x.task_id = k.id
          order by x.round desc
          limit 1
        ), false)
      ) order by k.due_on nulls last, k.created_at, k.id)$new$,
  $old$        'date_prompt', false
      ) order by c.completed_at desc, c.id desc)$old$,
  $new$        'date_prompt', false,
        'external_approved', coalesce((
          select x.status = 'approved' from public.review_checks x
          where x.task_id = c.id
          order by x.round desc
          limit 1
        ), false)
      ) order by c.completed_at desc, c.id desc)$new$
);

-- 7. Wording the database writes ----------------------------------------------------------------------

-- An external reviewer's decision names the reviewer (the item has no actor), in notification emails too.
select public.alhc_patch_function(
  'public.queue_notification_email(public.inbox_items)'::regprocedure,
  $old$    case when nullif(item.data ->> 'rule_name', '') is not null then 'Automation “' || (item.data ->> 'rule_name') || '”' end,
    'Someone'$old$,
  $new$    case when nullif(item.data ->> 'rule_name', '') is not null then 'Automation “' || (item.data ->> 'rule_name') || '”' end,
    case when item.data ? 'review_check_id' and nullif(coalesce(item.data ->> 'reviewer_name', item.data ->> 'reviewer_email'), '') is not null
      then coalesce(nullif(item.data ->> 'reviewer_name', ''), item.data ->> 'reviewer_email') || ' (external reviewer)' end,
    'Someone'$new$
);

select public.alhc_patch_function(
  'public.inbox_item_email_parts(public.inbox_items,uuid)'::regprocedure,
  $old$    case when nullif(item.data ->> 'rule_name', '') is not null then 'Automation “' || (item.data ->> 'rule_name') || '”' end,
    'Someone'$old$,
  $new$    case when nullif(item.data ->> 'rule_name', '') is not null then 'Automation “' || (item.data ->> 'rule_name') || '”' end,
    case when item.data ? 'review_check_id' and nullif(coalesce(item.data ->> 'reviewer_name', item.data ->> 'reviewer_email'), '') is not null
      then coalesce(nullif(item.data ->> 'reviewer_name', ''), item.data ->> 'reviewer_email') || ' (external reviewer)' end,
    'Someone'$new$
);

-- "the rule's owner" → "the automation's owner" in every message an automation run or save can show.
do $$
declare
  fn regprocedure;
  def text;
  fixed text;
begin
  foreach fn in array array[
    'public.execute_rule_actions(public.rules,uuid,jsonb,jsonb)',
    'public.execute_portfolio_rule_actions(public.portfolio_rules,uuid,jsonb)',
    'public.rules_guard_v2()',
    'public.guard_portfolio_rule()'
  ]::regprocedure[] loop
    def := pg_get_functiondef(fn);
    fixed := replace(replace(replace(replace(replace(def,
      'the rule''''s owner', 'the automation''''s owner'),
      'This rule''''s owner', 'This automation''''s owner'),
      'this rule''''s owner', 'this automation''''s owner'),
      'The rule’s owner', 'The automation’s owner'),
      'owner isn''''t an Admin of', 'owner isn''''t an Owner of');
    if fixed = def then
      raise exception 'nov10_batch36_a: no automation owner wording found in %', fn;
    end if;
    execute fixed;
  end loop;
end $$;

-- 8. Home's lead cards: only projects someone else is in ----------------------------------------------

select public.alhc_patch_function(
  'public.home_dashboard(text)'::regprocedure,
  $old$    and m.deleted_at is null
    and (m.role in ('owner', 'admin') or admin);$old$,
  $new$    and m.deleted_at is null
    and (m.role in ('owner', 'admin') or admin)
    -- Nov 10 batch 36: a project only you are in isn't a team to lead.
    and exists (
      select 1 from public.project_members o
      where o.project_id = p.id and o.deleted_at is null and o.profile_id <> me
    );$new$
);

-- 9. The task pane learns the external review: who it's meant for and how the latest round stands ------

select public.alhc_patch_function(
  'public.task_pane_rows(uuid,integer,integer)'::regprocedure,
  $old$    'email_activity', coalesce((
      select jsonb_agg(to_jsonb(ea) order by ea.created_at)$old$,
  $new$    -- Nov 10 batch 36: the intended external reviewer and the task's latest review check (RLS decides).
    'external_review', jsonb_build_object(
      'reviewer', (
        select jsonb_build_object('email', s.reviewer_email, 'name', s.reviewer_name)
        from public.task_review_settings s
        where s.task_id = target_task and s.reviewer_email is not null
      ),
      'latest', (
        select jsonb_build_object('id', x.id, 'round', x.round, 'status', x.status, 'recipient_email', x.recipient_email,
          'recipient_name', x.recipient_name, 'created_at', x.created_at, 'decided_at', x.decided_at, 'nudged_at', x.nudged_at)
        from public.review_checks x
        where x.task_id = target_task
        order by x.round desc
        limit 1
      )
    ),
    'email_activity', coalesce((
      select jsonb_agg(to_jsonb(ea) order by ea.created_at)$new$
);

-- 10. The public form knows whether it emails a confirmation (C34: it promised one either way) -------

select public.alhc_patch_function(
  'public.get_public_form(uuid)'::regprocedure,
  $old$    'verified_domains_only', coalesce(f.verified_domains_only, false),$old$,
  $new$    'send_confirmation', coalesce(f.send_confirmation, false),
    'verified_domains_only', coalesce(f.verified_domains_only, false),$new$
);
