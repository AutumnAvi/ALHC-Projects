"use client";

import { useOptimistic } from "react";
import type { ProjectTask } from "@/lib/data";

type Change =
  | { type: "complete"; taskId: string; completed: boolean }
  | { type: "move"; taskId: string; sectionId: string | null; sortOrder: number };

function apply(tasks: ProjectTask[], change: Change): ProjectTask[] {
  switch (change.type) {
    case "complete":
      return tasks.map((t) =>
        t.id === change.taskId
          ? { ...t, completedAt: change.completed ? new Date().toISOString() : null }
          : t,
      );
    case "move":
      return tasks
        .map((t) =>
          t.id === change.taskId
            ? { ...t, sectionId: change.sectionId, sortOrder: change.sortOrder }
            : t,
        )
        .sort((a, b) => a.sortOrder - b.sortOrder);
  }
}

export function useProjectTasks(tasks: ProjectTask[]) {
  return useOptimistic(tasks, apply);
}

export function tasksBySection(tasks: ProjectTask[]) {
  const groups = new Map<string | null, ProjectTask[]>();
  for (const task of tasks) {
    const list = groups.get(task.sectionId) ?? [];
    list.push(task);
    groups.set(task.sectionId, list);
  }
  return groups;
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
