"use client";

import { useOptimistic } from "react";
import type { ProjectTask } from "@/lib/data";
import type { Json } from "@/lib/supabase/database.types";

export type TaskChange =
  | { type: "complete"; taskId: string; completed: boolean }
  | { type: "move"; taskId: string; sectionId: string | null; sortOrder: number }
  | { type: "assign"; taskId: string; assigneeId: string | null }
  | { type: "field"; taskId: string; fieldId: string; value: Json }
  | { type: "due"; taskId: string; dueOn: string | null }
  | { type: "dates"; taskId: string; startOn: string | null; dueOn: string | null };

function apply(tasks: ProjectTask[], change: TaskChange): ProjectTask[] {
  const update = (patch: (t: ProjectTask) => ProjectTask) =>
    tasks.map((t) => (t.id === change.taskId ? patch(t) : t));
  switch (change.type) {
    case "complete":
      return update((t) => ({ ...t, completedAt: change.completed ? new Date().toISOString() : null }));
    case "move":
      return update((t) => ({ ...t, sectionId: change.sectionId, sortOrder: change.sortOrder })).sort(
        (a, b) => a.sortOrder - b.sortOrder,
      );
    case "assign":
      return update((t) => ({ ...t, assigneeId: change.assigneeId }));
    case "field":
      return update((t) => ({ ...t, fieldValues: { ...t.fieldValues, [change.fieldId]: change.value } }));
    case "due":
      return update((t) => ({ ...t, dueOn: change.dueOn }));
    case "dates":
      return update((t) => ({ ...t, startOn: change.startOn, dueOn: change.dueOn }));
  }
}

export function useProjectTasks(tasks: ProjectTask[]) {
  return useOptimistic(tasks, apply);
}

// Fractional ordering: place a task before `beforeId` within `column`, or at the end.
export function sortOrderFor(column: ProjectTask[], beforeId: string | null, movingId: string) {
  const others = column.filter((t) => t.id !== movingId);
  if (!beforeId) return (others.at(-1)?.sortOrder ?? 0) + 1024;
  const index = others.findIndex((t) => t.id === beforeId);
  if (index === -1) return (others.at(-1)?.sortOrder ?? 0) + 1024;
  const next = others[index].sortOrder;
  const prev = index > 0 ? others[index - 1].sortOrder : next - 2048;
  return (prev + next) / 2;
}
