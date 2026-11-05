// Big move 1: the automations area's types (no database; safe in the browser).
import type { ActionResult } from "../core/result";
import type { RuleAction, RuleCondition } from "../../rules";
import type { PartialRun } from "../../run-outcome";
import type { Json } from "../../supabase/database.types";

export type RuleInput = {
  name: string;
  triggerType: string;
  triggerConfig: Record<string, Json>;
  conditions: RuleCondition[];
  actions: RuleAction[];
  // The canvas's Active toggle (absent = unchanged; a new rule without it starts off).
  enabled?: boolean;
  // The builder's browser time zone: "today", overdue, and schedules use it (trigger_config.timezone).
  timeZone?: string;
  // Batch 4 (absent = unchanged): who the rule acts for and hears when it pauses, and whether changes
  // other rules make can trigger it.
  ownerId?: string | null;
  runOnRuleChanges?: boolean;
};

// A Call webhook action's own signing secret is generated when the rule is saved (the builder sends
// generate_signing_secret: true), stored by the database trigger like the shared secret, and returned
// once with the save result. A typed value is refused; "" removes the saved one.
export type RevealedSigningSecret = { action: number; secret: string };

export type RuleSaveResult = ActionResult & { signingSecrets?: RevealedSigningSecret[]; ruleId?: string };

// "Run manually" rules (Automations V2) a task can run from the pane's "…" menu: enabled rules with
// the manual trigger in the task's projects where the viewer is an Editor (run_manual_rule's own check;
// archived projects cap everyone at Viewer), in the order the task was added to them (Oct 29 notes, 55b:
// no home project). Read with the person's own
// client, so RLS decides; a subtask or a private task has no projects and gets none, and a database
// without the manual trigger simply has no such rules.
export type ManualRule = { id: string; name: string; projectId: string; projectName: string };

export type ManualRuleStatus = "succeeded" | "scheduled" | "failed" | "skipped" | "conditions" | "duplicate";

// What running a "Run manually" rule on a task did (runManualRule): its status, what each step did, why
// it failed or was skipped, and whether a step didn't do its job.
export type ManualRuleRun = {
  status: ManualRuleStatus;
  summary: string[];
  failure?: string;
  reason?: string;
  partial: PartialRun | null;
};

// Nov 2 notes (batch 17, 127): the bulk bar's "Run automation". The "Run manually" automations of the
// selected tasks' projects where the viewer is an Editor (the same rule as the pane's list), each with how
// many of the selected tasks are in its project (only those can run it).
export type BulkManualRule = ManualRule & { taskCount: number };
