// Nov 4 notes, batch 24 (155–157): one honest outcome for an automation run. rule_runs.status says
// "succeeded" whenever the run finished, even when some of its steps did nothing they were meant to do —
// a Send email with no recipient, a Mark complete that skipped an approval task, a Set field on a locked
// field. Those runs are "Partly ran · 1 of 4 actions skipped", never a green "Ran". Every place that shows
// a run's status (the run history on the canvas and the Automations page, the task's activity, the
// bottom-left notices, the manual and bulk runs, portfolio runs) asks this module. Pure, so it is
// unit-tested.

import type { Json } from "./supabase/database.types";

// A step outcome that means the step didn't do what it was set up to do. "unchanged" (already in that
// state) and "already_open" are fine: the task already was what the step wanted.
const MISSED_OUTCOMES: ReadonlySet<string> = new Set([
  "skipped",
  "error",
  "blocked",
  "empty",
  "no_recipient",
  "no_approver",
  "no_candidate",
  "no_person",
  "missing_field",
  "missing_tag",
  "missing_template",
  "archived",
  "locked",
  "only_project",
]);

export function stepWasMissed(outcome: string): boolean {
  return MISSED_OUTCOMES.has(outcome);
}

export type RunTone = "ran" | "partial" | "waiting" | "skipped" | "failed";

export type RunOutcome = {
  tone: RunTone;
  // The short status: "Ran", "Partly ran", "Waiting", "Skipped", "Failed".
  label: string;
  // "1 of 4 actions skipped" for a partial run, else null.
  summary: string | null;
  // How many logged steps didn't do their job, out of how many.
  missed: number;
  total: number;
  // The first missed step's own words ("No email address for the form submitter"), when it has some.
  reason: string | null;
  // Shown under "Needs attention" and drawn amber / red.
  attention: boolean;
};

export type RunStatus = "succeeded" | "scheduled" | "skipped" | "failed" | string;

function record(value: Json | undefined | null): Record<string, Json> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, Json>) : null;
}

// The logged steps of a run that finished (detail.actions is the list); a failed run's detail.actions is
// its error, and nothing it did was kept.
function loggedSteps(detail: Json | undefined | null): { outcome: string; result: string | null; error: string | null }[] {
  const actions = record(detail)?.actions;
  if (!Array.isArray(actions)) return [];
  return actions.flatMap((item) => {
    const r = record(item);
    if (!r) return [];
    const text = (v: Json | undefined) => (typeof v === "string" && v !== "" ? v : null);
    return [{ outcome: typeof r.outcome === "string" ? r.outcome : "done", result: text(r.result), error: text(r.error) }];
  });
}

export function partialSummary(missed: number, total: number): string {
  return `${missed} of ${total} action${total === 1 ? "" : "s"} skipped`;
}

export function runOutcome(status: RunStatus, detail: Json | undefined | null): RunOutcome {
  if (status === "failed") {
    return { tone: "failed", label: "Failed", summary: null, missed: 0, total: 0, reason: null, attention: true };
  }
  if (status === "skipped") {
    return { tone: "skipped", label: "Skipped", summary: null, missed: 0, total: 0, reason: null, attention: true };
  }
  const steps = loggedSteps(detail);
  const missedSteps = steps.filter((s) => stepWasMissed(s.outcome));
  if (missedSteps.length > 0) {
    const first = missedSteps[0];
    return {
      tone: "partial",
      label: "Partly ran",
      summary: partialSummary(missedSteps.length, steps.length),
      missed: missedSteps.length,
      total: steps.length,
      reason: first.error ?? first.result,
      attention: true,
    };
  }
  if (status === "scheduled") {
    return { tone: "waiting", label: "Waiting", summary: null, missed: 0, total: steps.length, reason: null, attention: false };
  }
  return { tone: "ran", label: "Ran", summary: null, missed: 0, total: steps.length, reason: null, attention: false };
}

// "Partly ran · 1 of 4 actions skipped" (or just the label).
export function runOutcomeText(outcome: RunOutcome): string {
  return outcome.summary ? `${outcome.label} · ${outcome.summary}` : outcome.label;
}

// The status pill's colors.
export const RUN_TONE_CLASS: Record<RunTone, string> = {
  ran: "bg-green-50 text-green-800",
  partial: "bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200",
  waiting: "bg-accent-50 text-accent-700",
  skipped: "bg-zinc-100 text-zinc-600",
  failed: "bg-red-50 text-red-700",
};

// The run lists' filter: everything, or what needs a look (failed, partly ran, skipped).
export type RunFilter = "all" | "attention";

export function runFilterLabel(filter: RunFilter, count: number): string {
  return filter === "all" ? "All" : `Needs attention${count ? ` (${count})` : ""}`;
}

export function filterRuns<T extends { status: RunStatus; detail: Json }>(runs: readonly T[], filter: RunFilter): T[] {
  return filter === "all" ? [...runs] : runs.filter((r) => runOutcome(r.status, r.detail).attention);
}

// A compact form for passing a run's partial outcome around (task activity, feedback notices).
export type PartialRun = { missed: number; total: number; reason: string | null };

export function partialOf(status: RunStatus, detail: Json | undefined | null): PartialRun | null {
  const outcome = runOutcome(status, detail);
  return outcome.tone === "partial" ? { missed: outcome.missed, total: outcome.total, reason: outcome.reason } : null;
}
