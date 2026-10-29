// Oct 29 notes (batch 7, 55b): a task's projects. There is no "home project" any more: removing a task
// from a project removes it there only, and the database refuses to remove the task's last active
// project (guard_home_membership: check_violation with detail "last_project"), so a task never ends up
// in no project at all. The pane offers to delete the task instead (it goes to the Trash, with Undo).

/** removeTaskFromProject's code when the project is the task's only one. */
export const LAST_PROJECT_CODE = "last_project" as const;

/** The database's message (guard_home_membership), for screens that need it before asking. */
export const LAST_PROJECT_MESSAGE = "This is the task’s only project. Add it to another project first, or move the task to the Trash.";

/** Is this the database refusing to remove a task's last project? (PostgREST error shape.) */
export function isLastProjectError(error: { code?: string; details?: string | null; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "23514" && (error.details === LAST_PROJECT_CODE || (error.message ?? "").startsWith("This is the task’s only project"));
}

/**
 * The question "Remove from <project>" asks when that project is the task's only one: delete the task
 * instead? (useConfirm's options: "“Spring flyer” is only in Marketing" / "Delete the task instead? It
 * goes to the Trash and you can restore it." / Delete task, in red.)
 */
export function lastProjectQuestion(
  taskTitle: string,
  projectName: string,
): { title: string; message: string; confirmLabel: string; tone: "danger" } {
  const name = taskTitle.trim();
  return {
    title: `${name ? `“${name}”` : "This task"} is only in ${projectName.trim() || "this project"}`,
    message: "Delete the task instead? It goes to the Trash and you can restore it.",
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
 * because it's the task's last project (another project the viewer can't open still counts, so only the
 * database knows), it asks whether to delete the task instead, and deletes it (to the Trash) when they
 * agree. The caller shows the Undo toast for "deleted" and the message for "error"; "kept" changes nothing.
 */
export async function removeFromProjectOrDelete(steps: {
  remove: () => Promise<{ error?: string; code?: string }>;
  ask: () => Promise<boolean>;
  deleteTask: () => Promise<{ error?: string }>;
}): Promise<RemoveFromProjectOutcome> {
  const removed = await steps.remove();
  if (removed.code === LAST_PROJECT_CODE) {
    if (!(await steps.ask())) return { kind: "kept" };
    const deleted = await steps.deleteTask();
    return deleted.error ? { kind: "error", error: deleted.error } : { kind: "deleted" };
  }
  if (removed.error) return { kind: "error", error: removed.error };
  return { kind: "removed" };
}
