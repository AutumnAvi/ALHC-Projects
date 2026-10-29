-- ALHC Projects — Oct 29 notes, batch 7, track T1 (concatenated by the lead into
-- 20261029010000_oct29_batch7_a.sql, T1 first).
--
-- 52. Only approvers approve or complete an approval task (BUG: before "Ready for approval" any Editor
--     could tick an approval task complete; the guard only refused it while a round was pending).
--
-- No row-removal or object-removal keywords anywhere in this file (the hosted connector refuses them).
-- Additive: no tail.

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

-- ---------------------------------------------------------------------------------------------------
-- 52. Only approvers approve or complete an approval task.
--
--   * A person (client role) may complete a task of kind 'approval' (top-level or subtask) — its
--     completed_at going from null to a value, or a new row inserted complete — only while they are one
--     of its active approvers (task_approvers). While a round is pending nobody ticks it complete: an
--     approver whose decision is still open is told to Approve (the decision path), everyone else that
--     it's waiting for approval. With no approvers nobody completes it by hand. A statement that switches
--     an approval task to another type and completes it at once is checked the same way.
--   * Rules never complete approval tasks: the rule engine's "Mark complete" step (and "Convert to a
--     project … and complete the task", and My Tasks rules' "Mark complete") skip them with a logged
--     reason instead of failing the run; the guard refuses a completion in rule context as a backstop.
--   * System paths keep working: an approved round (finish_approved_round, which names its task in the
--     transaction-local alhc.approval_finish), the older approval_completes_task / complete_approval_task
--     decisions, imports, copies (templates, Duplicate project), and recurrence (definer code, not a
--     client role). Reopening is unchanged.
--   * bulk_update_tasks needs no change: the guard's message is its skip reason ("Only its approvers can
--     complete an approval task. Send it with Ready for approval.").
--   * Rows learn whether the viewer approves the task: project_task_cards adds approval_is_approver,
--     task_approval_state adds is_approver, and task_approval_states (invoker) returns the state of many
--     approval tasks at once (My tasks rows, subtask rows).
-- ---------------------------------------------------------------------------------------------------

select public.alhc_patch_function(
  'public.guard_task_kind()'::regprocedure,
  $old$  if tg_op = 'UPDATE'
     and public.is_client_role()
     and new.kind = 'approval'
     and old.completed_at is null and new.completed_at is not null
     and exists (
       select 1 from public.approval_rounds r where r.task_id = new.id and r.status = 'pending'
     ) then
    raise exception 'This task is waiting for approval. Withdraw the request first, or wait for the approver'
      using errcode = 'check_violation';
  end if;$old$,
  $new$  -- Oct 29 notes, batch 7 (item 52): only an approval task's approvers complete it by hand, never
  -- while a round is pending, and rules never do — also when the same statement switches it to another
  -- type. Imports, copies, and an approved round (which names its task in alhc.approval_finish) aren't
  -- checked; other system code isn't a client role.
  if (new.kind = 'approval' or (tg_op = 'UPDATE' and old.kind = 'approval'))
     and new.completed_at is not null
     and (tg_op = 'INSERT' or old.completed_at is null)
     and public.import_context_id() is null
     and public.copy_context_id() is null
     and coalesce(current_setting('alhc.approval_finish', true), '') is distinct from new.id::text then
    if public.is_client_role() then
      if tg_op = 'UPDATE' and exists (
        select 1 from public.approval_rounds r where r.task_id = new.id and r.status = 'pending'
      ) then
        if exists (
          select 1 from public.approval_requests q
          join public.approval_rounds r on r.id = q.round_id
          where r.task_id = new.id and r.status = 'pending' and q.status = 'pending'
            and q.approver_id = (select auth.uid()) and q.deleted_at is null
        ) then
          raise exception 'This task is waiting for your approval. Approve it instead of marking it complete.'
            using errcode = 'check_violation';
        elsif exists (
          select 1 from public.task_approvers a
          where a.task_id = new.id and a.profile_id = (select auth.uid()) and a.deleted_at is null
        ) then
          raise exception 'This task is waiting for the other approvers.'
            using errcode = 'check_violation';
        end if;
        raise exception 'This task is waiting for approval. Only its approvers can complete it.'
          using errcode = 'check_violation';
      end if;
      if not exists (
        select 1 from public.task_approvers a
        where a.task_id = new.id and a.profile_id = (select auth.uid()) and a.deleted_at is null
      ) then
        raise exception 'Only its approvers can complete an approval task. Send it with Ready for approval.'
          using errcode = 'check_violation';
      end if;
    elsif tg_op = 'UPDATE' and coalesce(current_setting('alhc.rule_id', true), '') <> '' then
      raise exception 'Approval tasks are completed by their approvers'
        using errcode = 'check_violation';
    end if;
  end if;$new$
);

-- An approved round completes its task (the system, not a person or a rule).
select public.alhc_patch_function(
  'public.finish_approved_round(uuid)'::regprocedure,
  $old$  if r.after_approval = 'complete' then
    update public.tasks set completed_at = now()
    where id = r.task_id and completed_at is null and deleted_at is null;$old$,
  $new$  if r.after_approval = 'complete' then
    perform set_config('alhc.approval_finish', r.task_id::text, true);
    update public.tasks set completed_at = now()
    where id = r.task_id and completed_at is null and deleted_at is null;
    perform set_config('alhc.approval_finish', '', true);$new$
);

-- The rule engine's "Mark complete" skips approval tasks (logged), and so does "Convert to a project …
-- and complete the task".
select public.alhc_patch_function(
  'public.execute_rule_actions(public.rules,uuid,jsonb,jsonb)'::regprocedure,
  $old$        when 'complete_task' then
          update public.tasks set completed_at = now() where id = target_task and completed_at is null;
          if not found then
            outcome := 'unchanged';
            result := 'Already complete';
          else
            result := 'Marked complete';
          end if;$old$,
  $new$        when 'complete_task' then
          if t.kind = 'approval' and t.completed_at is null then
            outcome := 'skipped';
            result := 'Approval tasks are completed by their approvers';
          else
            update public.tasks set completed_at = now() where id = target_task and completed_at is null;
            if not found then
              outcome := 'unchanged';
              result := 'Already complete';
            else
              result := 'Marked complete';
            end if;
          end if;$new$,
  $old$          if coalesce((a ->> 'complete_task')::boolean, false) then
            update public.tasks set completed_at = now() where id = target_task and completed_at is null;
          end if;$old$,
  $new$          if coalesce((a ->> 'complete_task')::boolean, false) and t.kind is distinct from 'approval' then
            update public.tasks set completed_at = now() where id = target_task and completed_at is null;
          end if;$new$,
  $old$            || coalesce(' in “' || (input ->> 'portfolio') || '”', '');$old$,
  $new$            || coalesce(' in “' || (input ->> 'portfolio') || '”', '')
            || case when coalesce((a ->> 'complete_task')::boolean, false) and t.kind = 'approval' and t.completed_at is null
                 then '. The task wasn’t marked complete: approval tasks are completed by their approvers' else '' end;$new$
);

-- My Tasks rules' "Mark complete" skips approval tasks too.
select public.alhc_patch_function(
  'public.run_my_task_rule(public.my_task_rules,uuid,jsonb,text)'::regprocedure,
  $old$        when 'complete_task' then
          if not public.has_task_role(target_task, 'editor') then$old$,
  $new$        when 'complete_task' then
          if t.kind = 'approval' then
            outcome := 'skipped';
            result := 'Approval tasks are completed by their approvers';
          else
          if not public.has_task_role(target_task, 'editor') then$new$,
  $old$          update public.tasks set completed_at = now() where id = target_task and completed_at is null;
          result := 'Marked complete';$old$,
  $new$          update public.tasks set completed_at = now() where id = target_task and completed_at is null;
          result := 'Marked complete';
          end if;$new$
);

-- Whether the caller is one of the task's approvers (rows draw "Ready for approval" for everyone else).
select public.alhc_patch_function(
  'public.task_approval_state(uuid)'::regprocedure,
  $old$    'round_number', r.round_number
  )$old$,
  $new$    'round_number', r.round_number,
    'is_approver', exists (
      select 1 from public.task_approvers a
      where a.task_id = target_task and a.profile_id = (select auth.uid()) and a.deleted_at is null
    )
  )$new$
);

select public.alhc_patch_function(
  'public.project_task_cards(uuid,uuid[])'::regprocedure,
  $old$           ), false) as waiting_on_me
    from member m$old$,
  $new$           ), false) as waiting_on_me,
           exists (
             select 1 from public.task_approvers ta
             where ta.task_id = m.task_id and ta.profile_id = (select auth.uid()) and ta.deleted_at is null
           ) as is_approver
    from member m$new$,
  $old$      'approval_waiting_on_me', coalesce(ap.waiting_on_me, false)$old$,
  $new$      'approval_waiting_on_me', coalesce(ap.waiting_on_me, false),
      'approval_is_approver', coalesce(ap.is_approver, false)$new$
);

-- The approval state of many tasks at once ({ "<task id>": task_approval_state }), approval tasks the
-- caller can read only (RLS), at most 500.
create or replace function public.task_approval_states(task_ids uuid[])
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(t.id, public.task_approval_state(t.id)), '{}'::jsonb)
  from public.tasks t
  where t.id = any ((task_ids)[1:500])
    and t.kind = 'approval'
    and t.deleted_at is null;
$$;

revoke all on function public.task_approval_states(uuid[]) from public, anon;
grant execute on function public.task_approval_states(uuid[]) to authenticated;
select public.alhc_revoke_anon_execute(array['task_approval_states(uuid[])']);
