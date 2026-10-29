// Oct 29 notes (batch 7, 55b): a task's projects. There is no "home project" any more: removing a task
// from a project removes it there only, and the database refuses to remove the task's last active
// project (guard_home_membership: check_violation with detail "last_project"), so a task never ends up
// in no project at all. The pane offers to delete the task instead (it goes to the Trash).

/** removeTaskFromProject's code when the project is the task's only one. */
export const LAST_PROJECT_CODE = "last_project" as const;

/** The database's message (guard_home_membership), for screens that need it before asking. */
export const LAST_PROJECT_MESSAGE = "This is the task’s only project. Add it to another project first, or move the task to the Trash.";

/** Is this the database refusing to remove a task's last project? (PostgREST error shape.) */
export function isLastProjectError(error: { code?: string; details?: string | null; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "23514" && (error.details === LAST_PROJECT_CODE || (error.message ?? "").startsWith("This is the task’s only project"));
}

/** The "Delete the task instead?" question for the last project's Remove. */
export function lastProjectQuestion(taskTitle: string, projectName: string): { title: string; body: string; confirm: string } {
  const name = taskTitle.trim() || "This task";
  return {
    title: "Delete the task instead?",
    body: `${name} is only in ${projectName}. Delete the task instead? It goes to the Trash and you can restore it.`,
    confirm: "Delete task",
  };
}
