// Run details and dry-run results (Automations V2, batch 4). The database logs one entry per step of
// every run (rule_runs.detail.actions, or detail.steps for a failed run; see execute_rule_actions in
// 20261020010000_automations_v2.sql) and test_rule() returns the same steps plus each branch's
// conditions. This module reads both for the builder's Test panel and the run history.

import type { Json } from "@/lib/supabase/database.types";
import type { RuleCondition } from "@/lib/rules";

export type RuleStep = {
  step: number;
  type: string;
  outcome: string;
  result: string | null;
  error: string | null;
  input: Record<string, Json> | null;
  // In a test, steps after a "Wait" (the real run re-checks the conditions before them).
  afterWait: boolean;
};

export type RuleTestResult = {
  taskId: string;
  taskTitle: string;
  triggerType: string | null;
  branches: { branch: number; conditions: { condition: RuleCondition; ok: boolean }[] }[];
  chosenBranch: number | null;
  steps: RuleStep[];
  error: string | null;
  // The draft itself was refused (validation), as opposed to a step that would fail.
  invalid: boolean;
};

export type StepTone = "ok" | "unchanged" | "wait" | "send" | "error";

function record(value: Json | undefined): Record<string, Json> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, Json>) : null;
}

function text(value: Json | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export function parseSteps(value: Json | undefined): RuleStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, i) => {
    const r = record(item);
    if (!r || typeof r.type !== "string") return [];
    return [
      {
        step: typeof r.step === "number" ? r.step : i + 1,
        type: r.type,
        outcome: typeof r.outcome === "string" ? r.outcome : "done",
        result: text(r.result),
        error: text(r.error),
        input: record(r.input),
        afterWait: r.after_wait === true,
      },
    ];
  });
}

// A logged run: its steps (successful runs) or the steps that ran plus the error (failed runs).
export function runSteps(detail: Json): { steps: RuleStep[]; error: string | null } {
  const d = record(detail) ?? {};
  if (Array.isArray(d.actions)) return { steps: parseSteps(d.actions), error: null };
  const failure = record(d.actions);
  return { steps: parseSteps(d.steps), error: text(failure?.error) };
}

export function parseRuleTestResult(value: Json): RuleTestResult | null {
  const r = record(value);
  if (!r || typeof r.task_id !== "string") return null;
  const branches = Array.isArray(r.branches)
    ? r.branches.flatMap((b) => {
        const br = record(b);
        if (!br || typeof br.branch !== "number") return [];
        const conditions = Array.isArray(br.conditions)
          ? br.conditions.flatMap((c) => {
              const cr = record(c);
              const condition = record(cr?.condition);
              return cr && condition && typeof condition.type === "string"
                ? [{ condition: condition as RuleCondition, ok: cr.ok === true }]
                : [];
            })
          : [];
        return [{ branch: br.branch, conditions }];
      })
    : [];
  return {
    taskId: r.task_id,
    taskTitle: typeof r.task_title === "string" ? r.task_title : "",
    triggerType: text(r.trigger_type),
    branches,
    chosenBranch: typeof r.chosen_branch === "number" ? r.chosen_branch : null,
    steps: parseSteps(r.steps),
    error: text(r.error),
    invalid: r.invalid === true,
  };
}

const LABELS: Record<string, string> = {
  done: "Done",
  queued: "Queued",
  scheduled: "Waiting",
  unchanged: "Nothing to change",
  empty: "Nothing to do",
  no_recipient: "No recipient",
  no_approver: "No approver",
  already_open: "Already open",
  missing_field: "Field removed",
  missing_tag: "Tag removed",
  missing_template: "Template removed",
  archived: "Tag archived",
  would_send: "Would send",
  would_wait: "Would wait",
  error: "Failed",
};

export function stepOutcomeLabel(outcome: string): string {
  return LABELS[outcome] ?? outcome.replace(/_/g, " ");
}

export function stepTone(outcome: string): StepTone {
  if (outcome === "error") return "error";
  if (outcome === "would_wait" || outcome === "scheduled") return "wait";
  if (outcome === "would_send" || outcome === "queued") return "send";
  if (outcome === "done") return "ok";
  return "unchanged";
}

// One line about a test: what would happen overall.
export function testHeadline(result: RuleTestResult): string {
  if (result.invalid) return "The rule can’t be saved like this yet";
  if (result.chosenBranch === null) return "Nothing would run: the conditions don’t match this task";
  if (result.error) return "This rule would fail on this task";
  const changes = result.steps.filter((s) => s.outcome !== "unchanged" && s.outcome !== "empty").length;
  return changes === 0 ? "It would run, but nothing on this task would change" : `${changes} step${changes === 1 ? "" : "s"} would run`;
}
