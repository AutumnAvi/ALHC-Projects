-- Nov 1 notes, batch 10 (automations UX, items 76–81). Additive: one new column with an index, and
-- asserted patches of existing functions; nothing is renamed or taken away, and there is no tail.
--
-- What the database gains (the app does the rest):
--   * 77 Live feedback: rule_runs.actor_id = the person whose request made the run (auth.uid() when the
--     row is written; null for the scheduler, inbound webhooks, and anything else without a person).
--     The app reads the caller's own recent runs (rule_runs RLS: Viewers+ of the rule's project, plus
--     actor_id = the caller) after each change and shows "Automation X ran on N tasks" or a warning.
--   * 77 Loop guard (test 14.10): a rule whose own change fires it again is not a loop — rules never
--     trigger themselves — so run_rule now returns 'self' for that without writing a "skipped: loop" row
--     (it used to log one, which read as "stopped by loop protection" on every self-matching rule, e.g.
--     "Task moves into any section → Move to section"). A real cycle of different rules (A → B → A) is
--     still stopped and logged as 'loop'. A chain of different rules without a cycle now runs up to ten
--     rules deep (was three); the per-task throttle (20 runs an hour) and the per-rule rate limit stay.
--   * 81 Wording: emails and Inbox items the database writes say "Automation" instead of "Rule"
--     (inbox_item_email_parts, queue_notification_email, on_comment_email, notify_rule_paused,
--     run_portfolio_rule_engine, run_manual_rule, run_portfolio_rule). Table and function names stay.
-- No new client function (suite 60 unchanged); nothing for anon. fire_rules, notify_with,
-- notify_message, and add_story are untouched.

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

-- =================================================================================================
-- 1. rule_runs.actor_id (77)
-- =================================================================================================

alter table public.rule_runs add column if not exists actor_id uuid default auth.uid();
create index if not exists rule_runs_actor_idx on public.rule_runs (actor_id, created_at desc) where actor_id is not null;
comment on column public.rule_runs.actor_id is
  'Nov 1 notes, batch 10: the person whose request made this run (auth.uid() when it was written; null for '
  'the scheduler and other runs without a person). The app shows each person feedback about their own runs.';

-- =================================================================================================
-- 2. The loop guard (77)
-- =================================================================================================

select public.alhc_patch_function('public.run_rule(public.rules, uuid, jsonb, jsonb, text)'::regprocedure,
  $old$  -- Loop guard (Automations V2): a rule never re-enters its own chain, and chains stop at three rules.
  if position(r.id::text in chain) > 0 or depth >= 3 then$old$,
  $new$  -- Nov 1 notes, batch 10: the rule's own change firing it again isn't a loop (rules never trigger
  -- themselves), so it is ignored without a log row.
  if previous_rule = r.id::text then
    return 'self';
  end if;
  -- Loop guard (Automations V2; batch 10): a rule never re-enters a chain it is already in (a real cycle
  -- of different rules), and a chain of different rules stops after ten.
  if position(r.id::text in chain) > 0 or depth >= 10 then$new$);

-- =================================================================================================
-- 3. "Automation" in what the database writes for people (81)
-- =================================================================================================

select public.alhc_patch_function('public.inbox_item_email_parts(public.inbox_items, uuid)'::regprocedure,
  $old$then 'Rule “' || (item.data ->> 'rule_name')$old$,
  $new$then 'Automation “' || (item.data ->> 'rule_name')$new$);

select public.alhc_patch_function('public.queue_notification_email(public.inbox_items)'::regprocedure,
  $old$then 'Rule “' || (item.data ->> 'rule_name')$old$,
  $new$then 'Automation “' || (item.data ->> 'rule_name')$new$);

select public.alhc_patch_function('public.on_comment_email()'::regprocedure,
  $old$(select 'Rule “' || ru.name || '”'$old$,
  $new$(select 'Automation “' || ru.name || '”'$new$);

select public.alhc_patch_function('public.notify_rule_paused(public.rules, uuid, text, integer)'::regprocedure,
  $old$'message', 'Rule “' || r.name || '” was paused after '$old$,
  $new$'message', 'Automation “' || r.name || '” was paused after '$new$);

select public.alhc_patch_function('public.run_portfolio_rule_engine(public.portfolio_rules, uuid, jsonb, text)'::regprocedure,
  $old$'message', 'Portfolio rule “' || r.name || '” was paused after '$old$,
  $new$'message', 'Portfolio automation “' || r.name || '” was paused after '$new$,
  $old$'The rule''s owner is no longer in the workspace'$old$,
  $new$'The automation''s owner is no longer in the workspace'$new$);

select public.alhc_patch_function('public.run_manual_rule(uuid, uuid)'::regprocedure,
  $old$raise exception 'Rule not found'$old$,
  $new$raise exception 'Automation not found'$new$,
  $old$raise exception 'This rule is off'$old$,
  $new$raise exception 'This automation is off'$new$,
  $old$raise exception 'This rule is paused until %'$old$,
  $new$raise exception 'This automation is paused until %'$new$);

select public.alhc_patch_function('public.run_portfolio_rule(uuid, uuid)'::regprocedure,
  $old$raise exception 'Rule not found'$old$,
  $new$raise exception 'Automation not found'$new$,
  $old$raise exception 'This rule is off'$old$,
  $new$raise exception 'This automation is off'$new$,
  $old$raise exception 'This rule is paused until %'$old$,
  $new$raise exception 'This automation is paused until %'$new$);
