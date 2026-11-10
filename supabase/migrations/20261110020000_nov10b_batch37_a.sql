-- Nov 10 batch 37 (note 183): a two-stage approval never completes its task by itself. Additive: two new
-- invoker functions and two asserted patches; no object or row is removed, no tail.
--
-- A two-stage task is an approval task with approvers AND an external reviewer: one set on the task
-- (task_review_settings), else the form's requester, else the address a review check already went to —
-- the same rule the app uses (isTwoStageApproval in packages/core/src/external-review.ts). On such a task:
--   1. the internal approval doesn't complete it, move it to a section, or run any other "When it's
--      approved" step, whatever the round says (finish_approved_round returns early): it still has to go
--      to the external reviewer;
--   2. the external reviewer's approval doesn't complete it either (review_check_decide never did, and
--      since batch 36 it fires no approval automations) — there may be steps after it;
--   3. so that someone can finish it, once its latest internal round AND its latest external review are
--      approved, its assignee may complete it by hand too (guard_task_kind), next to its approvers.
-- Single-stage (internal-only) approvals keep every "When it's approved" choice exactly as before.

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

-- 1. Is the task two-stage? About the task (never the caller); invoker, so a person's guard check reads
--    through their own access (they're completing the task, so they can read it) and definer callers read
--    everything.
create or replace function public.approval_two_stage(target_task uuid)
returns boolean
language sql
stable
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
      and (
        exists (
          select 1 from public.task_review_settings s
          where s.task_id = t.id and s.reviewer_email is not null
        )
        or exists (
          select 1 from public.form_submissions fs
          where fs.task_id = coalesce(t.root_task_id, t.id) and fs.deleted_at is null
        )
        or exists (
          select 1 from public.review_checks x
          where x.task_id = t.id
        )
      )
  );
$$;

revoke all on function public.approval_two_stage(uuid) from public, anon;
grant execute on function public.approval_two_stage(uuid) to authenticated, service_role;
select public.alhc_revoke_anon_execute(array['approval_two_stage(uuid)']);

-- 2. May its assignee complete it? A two-stage task whose latest internal round and latest external review
--    are both approved, and the caller is its current assignee.
create or replace function public.approval_assignee_may_complete(target_task uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((
    select t.assignee_id = (select auth.uid())
      and public.approval_two_stage(t.id)
      and public.approval_round_approved(t.id)
      and coalesce((
        select x.status = 'approved'
        from public.review_checks x
        where x.task_id = t.id
        order by x.round desc
        limit 1
      ), false)
    from public.tasks t
    where t.id = target_task
  ), false);
$$;

revoke all on function public.approval_assignee_may_complete(uuid) from public, anon;
grant execute on function public.approval_assignee_may_complete(uuid) to authenticated, service_role;
select public.alhc_revoke_anon_execute(array['approval_assignee_may_complete(uuid)']);

-- 3. An approved round of a two-stage task does nothing to the task (no completion, no section move).
select public.alhc_patch_function(
  'public.finish_approved_round(uuid)'::regprocedure,
  $old$  select * into r from public.approval_rounds where id = target_round;
  if r.after_approval = 'complete' then$old$,
  $new$  select * into r from public.approval_rounds where id = target_round;
  -- Nov 10 batch 37 (note 183): a two-stage task still goes to its external reviewer, so the internal
  -- approval never completes or moves it, whatever "When it's approved" says.
  if public.approval_two_stage(r.task_id) then
    return;
  end if;
  if r.after_approval = 'complete' then$new$
);

-- 4. Its assignee completes it once both approvals are in (approvers still can, as before).
select public.alhc_patch_function(
  'public.guard_task_kind()'::regprocedure,
  $old$        where a.task_id = new.id and a.profile_id = (select auth.uid()) and a.deleted_at is null
      ) then
        if tg_op = 'UPDATE' and public.approval_round_approved(new.id) then$old$,
  $new$        where a.task_id = new.id and a.profile_id = (select auth.uid()) and a.deleted_at is null
      ) and not (tg_op = 'UPDATE' and public.approval_assignee_may_complete(new.id)) then
        -- Nov 10 batch 37 (note 183): a two-stage task's assignee finishes it after both approvals.
        if tg_op = 'UPDATE' and public.approval_round_approved(new.id) then$new$
);
