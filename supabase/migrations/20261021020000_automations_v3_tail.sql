-- ALHC Projects — Automations V3, the tail (applied by hand, after 20261021010000_automations_v3_a.sql).
--
-- Only the statements the hosted connector refuses. Each one retires a narrower CHECK that the V3
-- migration added a wider twin for, then gives the twin the old name. Works whether or not Automations
-- V2's tail was applied (its old trigger CHECK and the _v2 twin are both retired here).

-- Rule trigger types: the V3 list (follower_added, …).
alter table public.rules drop constraint if exists rules_trigger_type_check;
alter table public.rules drop constraint if exists rules_trigger_type_check_v2;
alter table public.rules rename constraint rules_trigger_type_check_v3 to rules_trigger_type_check;
