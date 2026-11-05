// Oct 29 notes (batch 7, 55b): a task's projects. There is no "home project" any more: removing a task
// from a project removes it there only, and the database refuses to remove the task's last active
// project (guard_home_membership: check_violation with detail "last_project"), so a task never ends up
// in no project at all — nor only in archived projects (detail "archived_only": archived projects are
// read-only for everyone, so nobody could edit, complete, or trash it until one is unarchived). The pane
// offers to delete the task instead (it goes to the Trash, with Undo).

/** removeTaskFromProject's code when the project is the task's only one. */
export const LAST_PROJECT_CODE = "last_project" as const;

/** removeTaskFromProject's code when the task's other projects are all archived. */
export const ARCHIVED_ONLY_CODE = "archived_only" as const;

export type LastProjectCode = typeof LAST_PROJECT_CODE | typeof ARCHIVED_ONLY_CODE;

/** The database's message (guard_home_membership), for screens that need it before asking. */
export const LAST_PROJECT_MESSAGE = "This is the task’s only project. Add it to another project first, or move the task to the Trash.";

/** The database's message when the task's other projects are all archived. */
export const ARCHIVED_ONLY_MESSAGE =
  "This is the task’s only active project: its other projects are archived. Unarchive one or add the task to another project first, or move the task to the Trash.";

/** Is this code one of the two "can't remove the task's last project" refusals? */
export function isLastProjectCode(code: string | null | undefined): code is LastProjectCode {
  return code === LAST_PROJECT_CODE || code === ARCHIVED_ONLY_CODE;
}

/**
 * Which "last project" refusal this database error is (PostgREST error shape): "last_project" (its only
 * project), "archived_only" (its other projects are archived), or null for anything else.
 */
export function lastProjectRefusal(
  error: { code?: string; details?: string | null; message?: string } | null | undefined,
): LastProjectCode | null {
  if (!error || error.code !== "23514") return null;
  if (isLastProjectCode(error.details)) return error.details;
  const message = error.message ?? "";
  if (message.startsWith("This is the task’s only active project")) return ARCHIVED_ONLY_CODE;
  if (message.startsWith("This is the task’s only project")) return LAST_PROJECT_CODE;
  return null;
}

/** Is this the database refusing to remove a task's last (active) project? */
export function isLastProjectError(error: { code?: string; details?: string | null; message?: string } | null | undefined): boolean {
  return lastProjectRefusal(error) !== null;
}

/**
 * The question "Remove from <project>" asks when that project is the task's only one: delete the task
 * instead? (useConfirm's options: "“Spring flyer” is only in Marketing" / "Delete the task instead? It
 * goes to the Trash and you can restore it." / Delete task, in red.) When its other projects are all
 * archived ("archived_only"): "“Spring flyer” is only active in Marketing" / "Its other projects are
 * archived. Delete the task instead? …".
 */
export function lastProjectQuestion(
  taskTitle: string,
  projectName: string,
  refusal: LastProjectCode = LAST_PROJECT_CODE,
): { title: string; message: string; confirmLabel: string; tone: "danger" } {
  const name = taskTitle.trim();
  const archived = refusal === ARCHIVED_ONLY_CODE;
  return {
    title: `${name ? `“${name}”` : "This task"} is only ${archived ? "active " : ""}in ${projectName.trim() || "this project"}`,
    message: `${archived ? "Its other projects are archived. " : ""}Delete the task instead? It goes to the Trash and you can restore it.`,
    confirmLabel: "Delete task",
    tone: "danger",
  };
}

/** What "Remove from <project>" ended up doing. */
export type RemoveFromProjectOutcome =
  | { kind: "removed" }
  | { kind: "deleted" }
  | { kind: "kept" }
  | { kind: "error"; error: string };

/**
 * "Remove from <project>" in the pane: removes the task from that project only. When the database refuses
 * because it's the task's last project, or its last one that isn't archived (another project the viewer
 * can't open still counts, so only the database knows), it asks whether to delete the task instead (`ask`
 * gets which refusal it was), and deletes it (to the Trash) when they agree. The caller shows the Undo
 * toast for "deleted" and the message for "error"; "kept" changes nothing.
 */
export async function removeFromProjectOrDelete(steps: {
  remove: () => Promise<{ error?: string; code?: string }>;
  ask: (refusal: LastProjectCode) => Promise<boolean>;
  deleteTask: () => Promise<{ error?: string }>;
}): Promise<RemoveFromProjectOutcome> {
  const removed = await steps.remove();
  if (isLastProjectCode(removed.code)) {
    if (!(await steps.ask(removed.code))) return { kind: "kept" };
    const deleted = await steps.deleteTask();
    return deleted.error ? { kind: "error", error: deleted.error } : { kind: "deleted" };
  }
  if (removed.error) return { kind: "error", error: removed.error };
  return { kind: "removed" };
}
