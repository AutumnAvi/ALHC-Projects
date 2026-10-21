-- ALHC Projects — Automations V3 follow-up: saving portfolio rules.
--
-- guard_portfolio_rule() runs as the person saving the rule but called profile_portfolio_role(), which
-- clients can't execute, so creating a portfolio rule in the app failed with "permission denied".
-- It now checks portfolio_members directly (a portfolio Admin+ reads it through RLS). Only this function changes.

create or replace function public.guard_portfolio_rule()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if public.is_client_role() then
      new.created_by := auth.uid();
      new.owner_id := coalesce(new.owner_id, auth.uid());
      new.paused_at := null;
      new.pause_reason := null;
      new.consecutive_failures := 0;
      new.last_edited_by := auth.uid();
      new.last_edited_at := now();
      new.created_at := now();
    else
      new.owner_id := coalesce(new.owner_id, new.created_by);
    end if;
  else
    if new.portfolio_id is distinct from old.portfolio_id then
      raise exception 'A rule stays in its portfolio' using errcode = 'check_violation';
    end if;
    if old.deleted_at is not null and new.deleted_at is null then
      raise exception 'A removed rule stays removed' using errcode = 'check_violation';
    end if;
    if public.is_client_role() then
      new.created_by := old.created_by;
      new.created_at := old.created_at;
      new.paused_at := old.paused_at;
      new.pause_reason := old.pause_reason;
      new.consecutive_failures := old.consecutive_failures;
      new.last_edited_by := auth.uid();
      new.last_edited_at := now();
      if new.enabled and not old.enabled then
        new.paused_at := null;
        new.pause_reason := null;
        new.consecutive_failures := 0;
      end if;
    end if;
    new.updated_at := now();
  end if;
  if public.is_client_role() and new.owner_id is not null
     and (tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id)
     -- Runs as the person saving (a portfolio Admin+, so RLS lets them read the members).
     and not exists (
       select 1 from public.portfolio_members m
       where m.portfolio_id = new.portfolio_id and m.profile_id = new.owner_id and m.deleted_at is null
     ) then
    raise exception 'The rule’s owner must be a member of this portfolio' using errcode = 'check_violation';
  end if;
  -- The next run of a scheduled rule (the workspace's workweek for "every workday").
  if new.trigger_type = 'scheduled' and new.enabled and new.deleted_at is null then
    if tg_op = 'INSERT' or new.trigger_config is distinct from old.trigger_config or new.enabled is distinct from old.enabled
       or new.trigger_type is distinct from old.trigger_type or (new.next_run_at is null and not public.is_client_role()) then
      new.next_run_at := public.rule_schedule_next_at(new.trigger_config,
        (select w.work_week from public.portfolios pf join public.workspaces w on w.id = pf.workspace_id where pf.id = new.portfolio_id), now());
    elsif public.is_client_role() then
      new.next_run_at := old.next_run_at;
    end if;
  else
    new.next_run_at := null;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_portfolio_rule() from public, anon;
grant execute on function public.guard_portfolio_rule() to authenticated;
