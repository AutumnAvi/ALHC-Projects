-- ALHC Projects — Rules: every step's settings can be chosen (follow-up to Automations V3).
--
-- validate_portfolio_rule() ran on every update of a portfolio rule, including the engine's own: the
-- scheduler moving next_run_at, the failure counter, and auto-pause. Its "Add to another portfolio"
-- check asks whether the person signed in edits that portfolio, so under the scheduler (nobody signed
-- in) — or when someone else's change set a rule off — a rule with that action, or with a setting that
-- has since gone stale, raised inside the engine and rolled back the whole tick (or the person's own
-- status change). The rule is now checked only when what it does changes, like project rules
-- (validate_rule runs on updates of its vocabulary columns only). The function itself is unchanged.
-- Additive: no tail.

create or replace trigger portfolio_rules_10_validate
before insert or update of portfolio_id, trigger_type, trigger_config, conditions, actions on public.portfolio_rules
for each row execute function public.validate_portfolio_rule();
