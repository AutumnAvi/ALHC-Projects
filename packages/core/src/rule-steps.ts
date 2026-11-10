// Run details and dry-run results (Automations V2, batch 4). The database logs one entry per step of
// every run (rule_runs.detail.actions, or detail.steps for a failed run; see execute_rule_actions in
// 20261020010000_automations_v2.sql) and test_rule() returns the same steps plus each branch's
// conditions. This module reads both for the builder's Test panel and the run history.

import type { Json } from "./supabase/database.types";
import { EMAIL_TEMPLATES, TASK_KIND_OPTIONS, type RuleCondition } from "./rules";
import { PROJECT_STATUS_LABELS } from "./portfolios";
import { stepWasMissed } from "./run-outcome";

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

// "attention": the step didn't do its job (skipped, no recipient, field locked, …; Nov 4 notes, batch 24).
export type StepTone = "ok" | "unchanged" | "wait" | "send" | "attention" | "error";

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
  // Automations V3
  no_candidate: "Nobody can take it",
  no_person: "Nobody to assign",
  // Oct 29 notes, batch 7: Set field on a locked field, the rule's owner not an Owner / Admin.
  locked: "Field locked",
  // Oct 29 notes, batch 7: Mark complete on an approval task that isn't approved yet (its result says why).
  skipped: "Skipped",
  // Nov 4 notes, batch 24 (155): Mark complete on a task still blocked by open tasks.
  blocked: "Blocked",
  only_project: "Kept in project",
  error: "Failed",
};

// Outcomes that leave the task as it was (a test's headline doesn't count them as steps that would run).
const NO_CHANGE_OUTCOMES = new Set(["unchanged", "empty", "skipped", "locked"]);

export function stepOutcomeLabel(outcome: string): string {
  return LABELS[outcome] ?? outcome.replace(/_/g, " ");
}

export function stepTone(outcome: string): StepTone {
  if (outcome === "error") return "error";
  if (outcome === "would_wait" || outcome === "scheduled") return "wait";
  if (outcome === "would_send" || outcome === "queued") return "send";
  if (outcome === "done") return "ok";
  if (stepWasMissed(outcome)) return "attention";
  return "unchanged";
}

// One line about a test: what would happen overall.
export function testHeadline(result: RuleTestResult): string {
  if (result.invalid) return "The automation can’t be saved like this yet";
  if (result.chosenBranch === null) return "Nothing would run: the conditions don’t match this task";
  if (result.error) return "This automation would fail on this task";
  const changes = result.steps.filter((s) => !NO_CHANGE_OUTCOMES.has(s.outcome) && !stepWasMissed(s.outcome)).length;
  // Nov 4 notes, batch 24 (157): steps that would be skipped (no recipient, approval task, …) are said too.
  const missed = result.steps.filter((s) => stepWasMissed(s.outcome)).length;
  const skippedNote = missed ? ` · ${missed} would be skipped` : "";
  return changes === 0
    ? `It would run, but nothing on this task would change${skippedNote}`
    : `${changes} step${changes === 1 ? "" : "s"} would run${skippedNote}`;
}

// ---------------------------------------------------------------------------------------------
// C19 (Nov 10): a step's logged inputs in plain words. The database logs raw values ("template:
// requester_update", "mode: round_robin", "unit: days", "business_days: true"); these are the builder's own
// labels. Keys the reader learns nothing from are left out; an offset and its unit read as one line.

const INPUT_LABELS: Record<string, string> = {
  template: "Email",
  mode: "How",
  from: "From",
  kind: "Type",
  status: "Status",
  to: "To",
  people: "People",
  person: "Person",
  workdays: "Whose workdays",
  assignee_skipped: "Assignee left out",
  due_on: "Due date",
  task_id: "",
  project_id: "",
};

const INPUT_VALUES: Record<string, Record<string, string>> = {
  template: Object.fromEntries(EMAIL_TEMPLATES.map((t) => [t.value, t.label])),
  mode: {
    person: "A person",
    round_robin: "Round robin",
    balanced: "The least busy",
    relative: "Some days from a date",
    absolute: "On a date",
    clear: "Clear it",
    replace: "Replace",
    append: "Add at the end",
    prepend: "Add at the start",
  },
  from: {
    today: "Today",
    due_date: "The due date",
    start_date: "The start date",
    due: "The due date",
    start: "The start date",
  },
  kind: Object.fromEntries(TASK_KIND_OPTIONS.map((k) => [k.value, k.label])),
  status: { ...PROJECT_STATUS_LABELS },
  workdays: { org: "The organization’s", personal: "The owner’s own" },
};

function plainValue(value: Json): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(plainValue).join(", ");
  return JSON.stringify(value);
}

// "business_days" → "Business days".
function plainKey(key: string) {
  const words = key.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function stepInputs(input: Record<string, Json> | null): { label: string; value: string }[] {
  const entries = Object.entries(input ?? {}).filter(([, v]) => v !== "" && v !== null);
  const has = (key: string) => entries.some(([k]) => k === key);
  const get = (key: string) => input?.[key];
  const out: { label: string; value: string }[] = [];
  for (const [key, value] of entries) {
    // An offset: "Days: 3, Unit: weeks, Business days: Yes" → "Offset: 3 workdays".
    if ((key === "days" || key === "hours") && (has("unit") || has("business_days"))) {
      const n = typeof value === "number" ? value : Number(value);
      const unit = typeof get("unit") === "string" ? String(get("unit")) : key;
      const business = get("business_days") === true && unit === "days";
      const word = business ? "workday" : unit.replace(/s$/, "");
      out.push({ label: "Offset", value: `${plainValue(value)} ${word}${n === 1 ? "" : "s"}` });
      continue;
    }
    if (key === "unit" || key === "business_days") continue;
    const label = INPUT_LABELS[key] ?? plainKey(key);
    if (!label) continue;
    const mapped = typeof value === "string" ? INPUT_VALUES[key]?.[value] : undefined;
    out.push({ label, value: mapped ?? plainValue(value) });
  }
  return out;
}
