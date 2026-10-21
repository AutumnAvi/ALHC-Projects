-- ALHC Projects — Automations V3, the tail (applied by hand, after automations_v3_a.sql).
--
-- DROP statements only (the ones the hosted connector refuses). automations_v3_a.sql added a wider
-- twin of each CHECK below under a …_v3 name; this retires the narrower old ones, and the …_v3 twins
-- simply keep their names. Until it's applied, the new rule triggers, finish-to-finish /
-- start-to-finish dependencies, and Inbox items about a project are refused (the app says so).
-- Works whether or not Automations V2's tail was applied.

-- Rule trigger types (the _v3 list: follower_added, start dates, no longer blocked, …).
alter table public.rules drop constraint if exists rules_trigger_type_check;
alter table public.rules drop constraint if exists rules_trigger_type_check_v2;

-- Dependency kinds: all four (batch C).
alter table public.task_dependencies drop constraint if exists task_dependencies_kind_check;

-- Inbox items about a project (portfolio rule notifications and status reminders, batch D).
alter table public.inbox_items drop constraint if exists inbox_items_target_check;
