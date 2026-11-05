// Nov 4 notes, batch 28 (M4): the client data cache's query keys, in one place. Every key starts with
// "alhc" and its second part is its group (task, project, me, …): the cache's size limits are per group
// (client.ts), and invalidating a group is one prefix (["alhc", "task"]).
//
// No Next.js or React imports here or anywhere in packages/core/src/query/ except the React provider: a desktop
// app (Tauri, online-only) reuses the same keys, fetchers, and cache rules over the same HTTP routes.

export const QUERY_ROOT = "alhc" as const;

export type QueryGroup = "task" | "task-context" | "task-extras" | "project" | "me" | "edits";

export const queryKeys = {
  // A task pane's detail (GET /api/task-pane/<id>), per task.
  task: (taskId: string) => [QUERY_ROOT, "task", taskId] as const,
  tasks: () => [QUERY_ROOT, "task"] as const,
  // What the pane's pickers need (people, projects, tags): one per person.
  taskContext: () => [QUERY_ROOT, "task-context"] as const,
  // The pane's slow parts, loaded when used.
  taskExtras: (taskId: string, part: "schedule" | "candidates") => [QUERY_ROOT, "task-extras", taskId, part] as const,
  allTaskExtras: () => [QUERY_ROOT, "task-extras"] as const,
  // A project's views' overlay: the person's own optimistic changes and live changes from others, shared by
  // its List, Board, Calendar, and Timeline.
  projectChanges: (projectId: string) => [QUERY_ROOT, "project", projectId, "changes"] as const,
  allProjectChanges: () => [QUERY_ROOT, "project"] as const,
  // The person's own tasks (My tasks and Home's Today read the same bundle): the newest copy a screen
  // loaded, and the live patches on top of it.
  myTasks: () => [QUERY_ROOT, "me", "tasks"] as const,
  myTaskPatches: () => [QUERY_ROOT, "me", "task-patches"] as const,
  // Inbox items' read / archived / bookmarked changes heard live, shared by every Inbox tab.
  inboxPatches: () => [QUERY_ROOT, "me", "inbox-patches"] as const,
  // Edits made on one screen that every other screen showing the task applies at once (the pane's rename
  // reaching the List row, a List row's completion reaching the pane).
  taskEdits: () => [QUERY_ROOT, "edits"] as const,
};

export function groupOf(queryKey: readonly unknown[]): string {
  return queryKey[0] === QUERY_ROOT && typeof queryKey[1] === "string" ? queryKey[1] : "other";
}
