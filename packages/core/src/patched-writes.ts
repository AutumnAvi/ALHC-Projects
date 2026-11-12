// Nov 12 notes (batch 40, item 1): saves that keep the router's recently visited pages.
//
// In Next.js 16 any refresh after a save — the action's refresh() or the browser's router.refresh() —
// bumps one version number for the router's whole back / forward cache, so every page visited in the
// last ROUTER_CACHE_SECONDS is fetched again (and can flash its skeleton) on the next visit. There is
// no "refresh only this page". So a save that should keep those pages must not refresh at all, and the
// screen showing it must show the change by itself.
//
// The rule here: a few common writes (complete, rename, assignee, comment post / delete, description)
// skip the refresh only when the screen that's open says it patches that kind of change itself (a
// project view, My tasks), and only while its live channel is connected (an automation the save ran,
// a repeating task's next occurrence, … arrive as live messages). Anything else — another page, a
// filter or a paged sort that the change could affect, a subtask (its parent's x/y count), Realtime
// down — refreshes exactly as before. Other recently visited pages are drawn from the router's cache
// at once and rendered again in the background on arrival (route-freshness.ts), with the person's own
// edits held on them (task-edits.ts) until then.
import type { ViewConfig } from "./views";
import { completionOf, sortOf } from "./views";

export type PatchedWriteKind = "complete" | "title" | "assign" | "comment" | "notes";

export const PATCHED_WRITE_KINDS: readonly PatchedWriteKind[] = ["complete", "title", "assign", "comment", "notes"];

// What a project view (List, Board, Calendar, Timeline) shows correctly without the server's render.
// `paged`: the view holds the first pages of its groups (List / Board), ordered and counted by the
// database — a change to the field it sorts or groups by would leave those pages out of step.
export function projectViewPatches(config: ViewConfig, options: { paged: boolean }): PatchedWriteKind[] {
  const filters = config.filters ?? {};
  const sortKeys = new Set(sortOf(config).map((s) => s.key));
  const kinds: PatchedWriteKind[] = ["comment"];
  // Completion: the view hides what its completion filter leaves out once the save settles (as the
  // refresh did). "Completed in the last N days" depends on the server's day boundaries: refresh.
  if (filters.completed_within_days === undefined) kinds.push("complete");
  // A text filter matches the name and the description.
  if (!filters.text) {
    if (!(options.paged && sortKeys.has("title"))) kinds.push("title");
    kinds.push("notes");
  }
  if (!filters.assignees?.length && !(options.paged && (sortKeys.has("assignee") || config.group_by === "assignee")))
    kinds.push("assign");
  return kinds;
}

// My tasks (the checklist and the classic views) groups, sorts, and counts in the browser; a task given
// to someone else leaves it, a completion moves to the completed list.
export const MY_TASKS_PATCHES: readonly PatchedWriteKind[] = ["complete", "title", "assign", "comment", "notes"];

// Every screen mounted on the page that shows tasks says what it patches; a kind not said by all of
// them (or a page where none says anything) refreshes.
export function screensPatch(declared: readonly (readonly PatchedWriteKind[])[], kind: PatchedWriteKind): boolean {
  return declared.length > 0 && declared.every((kinds) => kinds.includes(kind));
}

// Whether a row a project view still shows is one its completion filter now leaves out: the person's
// own completion (or reopen) that has finished saving. Others' completions heard live stay as they
// were (struck through, as before), so only own, settled changes count.
export function hiddenByCompletion(config: ViewConfig, completedAt: string | null): boolean {
  const completion = completionOf(config.filters);
  if (completion === "incomplete") return Boolean(completedAt);
  if (completion === "completed") return !completedAt;
  return false;
}

// Groups with some rows taken out: totals (the paged "Show N more" count) go down by the same number.
export function withoutRows<G extends { tasks: readonly { id: string }[]; total?: number }>(
  groups: readonly G[],
  hide: ReadonlySet<string>,
): G[] {
  if (hide.size === 0) return groups as G[];
  return groups.map((group) => {
    const tasks = group.tasks.filter((task) => !hide.has(task.id));
    if (tasks.length === group.tasks.length) return group;
    const removed = group.tasks.length - tasks.length;
    return { ...group, tasks, total: group.total == null ? group.total : Math.max(tasks.length, group.total - removed) };
  });
}
