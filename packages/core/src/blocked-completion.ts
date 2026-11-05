// Nov 5 note 163: automations never complete a blocked task (one with an open finish-type blocker,
// hidden blockers included). The rule engine's Mark complete runs as database code, which the dependency
// guard (tasks_12_guard_dependencies) doesn't check, so until the database patch described in the PR for
// note 163 is applied, a hand-run or bulk-run automation that would complete a blocked task isn't run on
// it at all: runManualRule / runManualRuleOnTasks ask `ruleCompletesTask` and the task's blocker count
// first and answer "skipped" with `blockedCompletionReason` — never a green "Ran". Once the database logs
// the step itself as outcome "blocked", run-outcome.ts already reads it as a skipped step ("Partly ran").
// Pure, so it is unit-tested.

import type { Json } from "./supabase/database.types";

// The step outcome the database logs for a Mark complete it refused because the task is blocked.
export const BLOCKED_OUTCOME = "blocked";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

// Whether any of a rule's actions (any branch) would mark its task complete: Mark complete, or Convert
// to a project with "complete the task" ticked.
export function ruleCompletesTask(actions: Json | readonly unknown[] | null | undefined): boolean {
  if (!Array.isArray(actions)) return false;
  return actions.some((item) => {
    const action = record(item);
    if (!action) return false;
    if (action.type === "complete_task") return true;
    return action.type === "convert_to_project" && action.complete_task === true;
  });
}

function tasks(count: number): string {
  return count === 1 ? "1 task that isn’t done" : `${count} tasks that aren’t done`;
}

// Why the automation didn't run on a blocked task (the manual run dialog says "Skipped: <this>.").
export function blockedCompletionReason(count: number): string {
  return `it’s blocked by ${tasks(Math.max(1, Math.floor(count)))}, and this automation would mark it complete`;
}

// The open-blocker counts open_blocker_counts answers ({ "<task id>": n }), only tasks with blockers.
export function parseBlockerCounts(data: Json | null | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  const map = record(data);
  if (!map) return counts;
  for (const [taskId, count] of Object.entries(map)) {
    if (typeof count === "number" && Number.isFinite(count) && count > 0) counts.set(taskId, count);
  }
  return counts;
}
