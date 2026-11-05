-- Nov 5 note 163b: automations never complete a blocked task (the database follow-up to PR #90, note 163).
-- Additive: no object or row is removed, no tail.
--
-- Rules' Mark complete (and Convert to a project's "complete the task") run as system code, which the
-- dependency guard (tasks_12_guard_dependencies → guard_task_dependencies) never checked, so a project
-- automation — triggered, scheduled, run by hand, or from the bulk bar — completed a task that waits on
-- incomplete tasks. My Tasks automations checked, but failed the whole run instead of skipping the step.
--
-- Now:
--   * task_blocker_total(task): the completion check's count of open finish-type blockers, hidden ones
--     included, whoever (or nobody) is the caller — open_blocker_count answers 0 for a caller who can't
--     read the task (the scheduler, an anonymous form submission), so it can't be used inside a rule.
--   * execute_rule_actions: Mark complete on a blocked task logs the step as outcome 'blocked'
--     ("Not completed: blocked by N tasks that aren’t done") and the run goes on; Convert to a project
--     still makes the project but leaves the task open, outcome 'blocked'. The app already reads 'blocked'
--     as a skipped step, so the run reads "Partly ran" in amber everywhere (notes 155 / 157).
--   * run_my_task_rule: the same skip instead of failing the run.
--   * guard_task_dependencies: a backstop at the one place every completion passes — while an automation
--     runs (alhc.rule_id or alhc.my_task_rule set), completing a blocked task is refused. Imports, copies,
--     and an approved round (alhc.approval_finish) aren't checked; people were already checked.

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

create or replace function public.task_blocker_total(target_task uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select count(*)::integer
  from public.task_dependencies d
  join public.tasks p on p.id = d.predecessor_id
  where d.successor_id = target_task
    and d.kind <> 'start_to_start'
    and d.deleted_at is null
    and p.deleted_at is null
    and not public.dependency_satisfied(d.kind, p);
$$;

revoke all on function public.task_blocker_total(uuid) from public, anon, authenticated;
select public.alhc_revoke_anon_execute(array['task_blocker_total(uuid)']);

select public.alhc_patch_function(
  'public.execute_rule_actions(public.rules,uuid,jsonb,jsonb)'::regprocedure,
  $old$        when 'complete_task' then
          if t.kind = 'approval' and t.completed_at is null then
            outcome := 'skipped';
            result := 'Approval tasks are completed by their approvers';
          else$old$,
  $new$        when 'complete_task' then
          if t.kind = 'approval' and t.completed_at is null then
            outcome := 'skipped';
            result := 'Approval tasks are completed by their approvers';
          elsif t.completed_at is null and public.task_blocker_total(target_task) > 0 then
            outcome := 'blocked';
            result := 'Not completed: blocked by ' || public.task_blocker_total(target_task)
              || case when public.task_blocker_total(target_task) = 1 then ' task that isn’t' else ' tasks that aren’t' end
              || ' done';
          else$new$,
  $old$          if coalesce((a ->> 'complete_task')::boolean, false)
             and t.kind is distinct from 'approval' then$old$,
  $new$          if coalesce((a ->> 'complete_task')::boolean, false)
             and t.kind is distinct from 'approval'
             and t.completed_at is null
             and public.task_blocker_total(target_task) > 0 then
            outcome := 'blocked';
          end if;
          if coalesce((a ->> 'complete_task')::boolean, false)
             and t.kind is distinct from 'approval'
             and public.task_blocker_total(target_task) = 0 then$new$,
  $old$                 then '. The task wasn’t marked complete: approval tasks are completed by their approvers' else '' end;$old$,
  $new$                 then '. The task wasn’t marked complete: approval tasks are completed by their approvers' else '' end
            || case when outcome = 'blocked'
                 then '. The task wasn’t marked complete: it’s blocked by tasks that aren’t done' else '' end;$new$
);

select public.alhc_patch_function(
  'public.run_my_task_rule(public.my_task_rules,uuid,jsonb,text)'::regprocedure,
  $old$          elsif t.kind = 'approval' then
            outcome := 'skipped';
            result := 'Approval tasks are completed by their approvers';
          else$old$,
  $new$          elsif t.kind = 'approval' then
            outcome := 'skipped';
            result := 'Approval tasks are completed by their approvers';
          elsif public.task_blocker_total(target_task) > 0 then
            outcome := 'blocked';
            result := 'Not completed: blocked by ' || public.task_blocker_total(target_task)
              || case when public.task_blocker_total(target_task) = 1 then ' task that isn’t' else ' tasks that aren’t' end
              || ' done';
          else$new$
);

select public.alhc_patch_function(
  'public.guard_task_dependencies()'::regprocedure,
  $old$  if not public.is_client_role() then
    return new;
  end if;$old$,
  $new$  if not public.is_client_role() then
    -- Nov 5 note 163: automations never complete a blocked task (their steps skip it with outcome
    -- 'blocked'; this is the backstop for any rule path). Imports, copies, and an approved round aren't
    -- automations' choices and aren't checked.
    if (coalesce(current_setting('alhc.rule_id', true), '') <> ''
        or coalesce(current_setting('alhc.my_task_rule', true), '') <> '')
       and public.import_context_id() is null
       and public.copy_context_id() is null
       and coalesce(current_setting('alhc.approval_finish', true), '') is distinct from new.id::text
       and public.task_blocker_total(new.id) > 0 then
      raise exception 'Automations don’t complete blocked tasks'
        using errcode = 'check_violation',
              hint = 'Complete the tasks it waits on first, or remove the dependency';
    end if;
    return new;
  end if;$new$
);
