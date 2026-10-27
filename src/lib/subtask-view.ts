// Oct 27 notes (batch 5): the task pane's Subtasks organize menu — Filter (Hide completed, Assigned to me)
// and Sort (Manual, Assignee, Due date earliest / latest first) — remembered per person
// (profile_preferences.subtask_*; set_subtask_preferences). Pure: browser + server.

export const SUBTASK_SORTS = ["manual", "assignee", "due_asc", "due_desc"] as const;
export type SubtaskSort = (typeof SUBTASK_SORTS)[number];

export const SUBTASK_SORT_LABELS: Record<SubtaskSort, string> = {
  manual: "Manual",
  assignee: "Assignee",
  due_asc: "Due date (earliest first)",
  due_desc: "Due date (latest first)",
};

export type SubtaskPrefs = { hideCompleted: boolean; assignedToMe: boolean; sort: SubtaskSort };
export const DEFAULT_SUBTASK_PREFS: SubtaskPrefs = { hideCompleted: false, assignedToMe: false, sort: "manual" };

export function isSubtaskSort(value: unknown): value is SubtaskSort {
  return typeof value === "string" && (SUBTASK_SORTS as readonly string[]).includes(value);
}

export function parseSubtaskPrefs(value: unknown): SubtaskPrefs {
  const o = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    hideCompleted: o.hide_completed === true || o.subtask_hide_completed === true,
    assignedToMe: o.assigned_to_me === true || o.subtask_assigned_to_me === true,
    sort: isSubtaskSort(o.sort) ? o.sort : isSubtaskSort(o.subtask_sort) ? o.subtask_sort : "manual",
  };
}

export function isOrganized(prefs: SubtaskPrefs): boolean {
  return prefs.hideCompleted || prefs.assignedToMe || prefs.sort !== "manual";
}

type Organizable = {
  id: string;
  completedAt: string | null;
  assigneeId: string | null;
  dueOn: string | null;
  sortOrder: number;
};

// The subtasks the pane shows, in its order. Manual = the stored order; Assignee = by name (unassigned
// last); Due date = by due date (undated last). Ties keep the manual order.
export function organizeSubtasks<T extends Organizable>(
  subtasks: T[],
  prefs: SubtaskPrefs,
  me: string | null,
  nameOf: (profileId: string) => string,
): T[] {
  const shown = subtasks.filter(
    (s) => !(prefs.hideCompleted && s.completedAt) && !(prefs.assignedToMe && (!me || s.assigneeId !== me)),
  );
  const manual = (a: T, b: T) => a.sortOrder - b.sortOrder;
  if (prefs.sort === "manual") return [...shown].sort(manual);
  return [...shown].sort((a, b) => {
    if (prefs.sort === "assignee") {
      if (!a.assigneeId || !b.assigneeId) {
        if (a.assigneeId !== b.assigneeId) return a.assigneeId ? -1 : 1;
        return manual(a, b);
      }
      return nameOf(a.assigneeId).localeCompare(nameOf(b.assigneeId), undefined, { sensitivity: "base" }) || manual(a, b);
    }
    if (!a.dueOn || !b.dueOn) {
      if (a.dueOn !== b.dueOn) return a.dueOn ? -1 : 1;
      return manual(a, b);
    }
    const byDue = a.dueOn.localeCompare(b.dueOn);
    return (prefs.sort === "due_desc" ? -byDue : byDue) || manual(a, b);
  });
}

// "Showing 3 of 7" plus what's narrowing it, for the line under the heading (null when nothing is).
export function organizeSummary(shown: number, total: number, prefs: SubtaskPrefs): string | null {
  if (!isOrganized(prefs)) return null;
  const parts = [
    prefs.hideCompleted ? "completed hidden" : null,
    prefs.assignedToMe ? "assigned to me" : null,
    prefs.sort !== "manual" ? `sorted by ${SUBTASK_SORT_LABELS[prefs.sort].toLowerCase()}` : null,
  ].filter(Boolean);
  return `Showing ${shown} of ${total} · ${parts.join(", ")}`;
}
