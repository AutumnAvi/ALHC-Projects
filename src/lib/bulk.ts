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
  }
}

export function taskCount(n: number) {
  return `${n} task${n === 1 ? "" : "s"}`;
}
