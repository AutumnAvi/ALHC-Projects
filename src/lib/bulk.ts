import type { Json } from "@/lib/supabase/database.types";

// Bulk edit vocabulary, mirrored by bulk_update_tasks() in 20261006010000_bulk_edit.sql.
export const MAX_BULK_TASKS = 200;

export type BulkOperation =
  | { action: "complete" | "reopen" | "delete" }
  | { action: "assign"; assignee_id: string | null }
  | { action: "set_due"; due_on: string | null }
  | { action: "move_section"; project_id: string; section_id: string | null }
  | { action: "add_to_project"; project_id: string; section_id?: string | null }
  | { action: "set_field"; field_id: string; value: Json }
  | { action: "add_tag" | "remove_tag"; tag_id: string }
  // My Tasks only: one of the viewer's own My Tasks sections (move_my_tasks()).
  | { action: "my_section"; section_id: string };

export type BulkSkip = { taskId: string; title: string | null; reason: string };

export type BulkResult = {
  updated: string[];
  unchanged: string[];
  skipped: BulkSkip[];
};

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function parseBulkResult(value: unknown): BulkResult {
  const row = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const skipped = Array.isArray(row.skipped) ? row.skipped : [];
  return {
    updated: ids(row.updated),
    unchanged: ids(row.unchanged),
    skipped: skipped.flatMap((s) => {
      const item = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
      if (typeof item.task_id !== "string") return [];
      return [
        {
          taskId: item.task_id,
          title: typeof item.title === "string" ? item.title : null,
          reason: typeof item.reason === "string" ? item.reason : "Couldn’t be changed",
        },
      ];
    }),
  };
}

// "Completed 8 tasks" / "Moved 1 task"; used for the summary heading.
export function bulkVerb(action: BulkOperation["action"]): string {
  switch (action) {
    case "complete":
      return "Completed";
    case "reopen":
      return "Reopened";
    case "delete":
      return "Moved to Trash";
    case "assign":
      return "Updated the assignee of";
    case "set_due":
      return "Updated the due date of";
    case "move_section":
    case "my_section":
      return "Moved";
    case "add_to_project":
      return "Added";
    case "set_field":
      return "Updated";
    case "add_tag":
      return "Tagged";
    case "remove_tag":
      return "Removed the tag from";
  }
}

export function taskCount(n: number) {
  return `${n} task${n === 1 ? "" : "s"}`;
}

// Nov 2 notes (batch 17, 127): what running one "Run manually" automation on the selected tasks did
// (runManualRuleOnTasks), and the toast that says so.
export type BulkRuleRun = {
  ran: number;
  conditions: number;
  skipped: number;
  failed: number;
  // Selected tasks that aren't in the automation's project (it can't run on them).
  notInProject: number;
  firstError?: string;
  // Nov 4 notes, batch 24 (157): runs that finished with a step skipped (no recipient, approval task, …),
  // and the first skipped step's reason. Not counted in `ran`.
  partial?: number;
  firstSkipped?: string;
  // Nov 5 note 163: tasks the automation wasn't run on because it would complete them while they're
  // blocked by tasks that aren't done. Not counted in `ran`.
  blocked?: number;
};

// Whether the bulk run needs a look (the notice goes amber): anything failed or partly ran.
export function bulkRuleRunTone(run: BulkRuleRun): "ran" | "partial" | "failed" {
  if (run.failed > 0 && run.ran === 0 && !run.partial) return "failed";
  if (run.failed > 0 || (run.partial ?? 0) > 0 || (run.blocked ?? 0) > 0) return "partial";
  return "ran";
}

// The toast after a bulk run: what ran, and what didn't and why.
export function bulkRuleRunMessage(name: string, run: BulkRuleRun): string {
  const parts = [
    run.ran ? `Ran “${name}” on ${taskCount(run.ran)}` : null,
    run.partial
      ? `${run.ran ? "partly ran" : `“${name}” partly ran`} on ${taskCount(run.partial)} (an action was skipped${
          run.firstSkipped ? `: ${run.firstSkipped.replace(/[.\s]+$/, "")}` : ""
        })`
      : null,
    !run.ran && !run.partial ? `“${name}” didn’t change any task` : null,
    run.blocked ? `${taskCount(run.blocked)} not run: blocked by tasks that aren’t done, and it would mark ${run.blocked === 1 ? "it" : "them"} complete` : null,
    run.conditions ? `${taskCount(run.conditions)} didn’t match its conditions` : null,
    run.skipped ? `${taskCount(run.skipped)} skipped (ran too often or would loop)` : null,
    run.notInProject ? `${taskCount(run.notInProject)} not in its project` : null,
    run.failed ? `${taskCount(run.failed)} failed${run.firstError ? `: ${run.firstError.replace(/[.\s]+$/, "")}` : ""}` : null,
  ].filter((part): part is string => Boolean(part));
  return `${parts.join(" · ")}.`;
}

