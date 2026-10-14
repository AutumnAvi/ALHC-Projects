"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import type { ProjectTask } from "@/lib/data";
import {
  currentMutationToken,
  mutationFailed,
  mutationFailureVersion,
  subscribeMutationFailures,
  tokenTaskDropped,
} from "@/lib/optimistic-session";
import type { Json } from "@/lib/supabase/database.types";

export type TaskChange =
  | { type: "complete"; taskId: string; completed: boolean }
  | { type: "move"; taskId: string; sectionId: string | null; sortOrder: number }
  | { type: "assign"; taskId: string; assigneeId: string | null }
  | { type: "field"; taskId: string; fieldId: string; value: Json }
  | { type: "due"; taskId: string; dueOn: string | null }
  | { type: "dates"; taskId: string; startOn: string | null; dueOn: string | null }
  | { type: "tags"; taskId: string; tagIds: string[] }
  | { type: "title"; taskId: string; title: string };

type TaggedChange = { token: number; change: TaskChange };

function apply(tasks: ProjectTask[], change: TaskChange): ProjectTask[] {
  const update = (patch: (task: ProjectTask) => ProjectTask) =>
    tasks.map((task) => (task.id === change.taskId ? patch(task) : task));
  switch (change.type) {
    case "complete":
      return update((task) => ({ ...task, completedAt: change.completed ? new Date().toISOString() : null }));
    case "move": {
      // Slide the one task into place. Sorting the whole list here reordered every row.
      let moved: ProjectTask | undefined;
      const rest: ProjectTask[] = [];
      for (const task of tasks) {
        if (task.id === change.taskId) moved = { ...task, sectionId: change.sectionId, sortOrder: change.sortOrder };
        else rest.push(task);
      }
      if (!moved) return tasks;
      const placed = moved;
      const at = rest.findIndex((task) => task.sortOrder > placed.sortOrder);
      rest.splice(at === -1 ? rest.length : at, 0, placed);
      return rest;
    }
    case "assign":
      return update((task) => ({ ...task, assigneeId: change.assigneeId }));
    case "field":
      return update((task) => ({ ...task, fieldValues: { ...task.fieldValues, [change.fieldId]: change.value } }));
    case "due":
      return update((task) => ({ ...task, dueOn: change.dueOn }));
    case "dates":
      return update((task) => ({ ...task, startOn: change.startOn, dueOn: change.dueOn }));
    case "tags":
      return update((task) => ({ ...task, tagIds: change.tagIds }));
    case "title":
      return update((task) => ({ ...task, title: change.title }));
  }
}

function changeKey(change: TaskChange) {
  return change.type === "field" ? `${change.taskId}:field:${change.fieldId}` : `${change.taskId}:${change.type}`;
}

function sectionIndex(tasks: ProjectTask[], sectionId: string | null, taskId: string, sortOrder: number | null) {
  const rows = tasks
    .filter((task) => task.sectionId === sectionId)
    .map((task) => ({
      id: task.id,
      sortOrder: task.id === taskId && sortOrder !== null ? sortOrder : task.sortOrder,
    }));
  rows.sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows.findIndex((task) => task.id === taskId);
}

// The server list already shows this change (a reindexed sort order still counts when the
// task sits at the same place in its section).
export function changeAbsorbed(tasks: ProjectTask[], change: TaskChange) {
  const task = tasks.find((item) => item.id === change.taskId);
  if (!task) return true;
  switch (change.type) {
    case "complete":
      return Boolean(task.completedAt) === change.completed;
    case "move":
      return (
        task.sectionId === change.sectionId &&
        sectionIndex(tasks, change.sectionId, change.taskId, null) ===
          sectionIndex(tasks, change.sectionId, change.taskId, change.sortOrder)
      );
    case "assign":
      return task.assigneeId === change.assigneeId;
    case "field":
      return JSON.stringify(task.fieldValues[change.fieldId] ?? null) === JSON.stringify(change.value ?? null);
    case "due":
      return task.dueOn === change.dueOn;
    case "dates":
      return task.startOn === change.startOn && task.dueOn === change.dueOn;
    case "tags":
      return [...task.tagIds].sort().join("\0") === [...change.tagIds].sort().join("\0");
    case "title":
      return task.title === change.title;
  }
}

export function overlayProjectTasks(tasks: ProjectTask[], changes: TaskChange[]) {
  const latestAt = new Map<string, number>();
  changes.forEach((change, index) => latestAt.set(changeKey(change), index));
  const live = changes.filter(
    (change, index) => latestAt.get(changeKey(change)) === index && !changeAbsorbed(tasks, change),
  );
  return live.reduce(apply, tasks);
}

// One turn's changes flush together, after the event, so a bulk edit doesn't re-render once
// per task and the new position paints before the server answers.
let queued: TaggedChange[] = [];
let flushScheduled = false;
let commitBatch: ((batch: TaggedChange[]) => void) | null = null;

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    const batch = queued;
    queued = [];
    if (batch.length === 0 || !commitBatch) return;
    flushSync(() => commitBatch?.(batch));
  });
}

export function useProjectTasks(tasks: ProjectTask[]) {
  const [changes, setChanges] = useState<TaggedChange[]>([]);
  const revision = useSyncExternalStore(subscribeMutationFailures, mutationFailureVersion, () => 0);
  useEffect(() => {
    commitBatch = (batch) => setChanges((current) => [...current, ...batch]);
    return () => {
      commitBatch = null;
    };
  }, []);

  const applyChange = useCallback((change: TaskChange) => {
    queued.push({ token: currentMutationToken(), change });
    scheduleFlush();
  }, []);

  // `revision` re-renders this list when a write fails or a bulk skip drops rows.
  const pending = pendingChanges(changes, tasks, revision);
  if (pending.length !== changes.length) setChanges(pending);

  return [overlayProjectTasks(tasks, pending.map((item) => item.change)), applyChange] as const;
}

// Fractional ordering: place a task before `beforeId` within `column`, or at the end.
export function sortOrderFor(
  column: ProjectTask[],
  beforeId: string | null,
  movingId: string,
  next?: { id: string; sortOrder: number } | null,
) {
  const others = column.filter((t) => t.id !== movingId);
  if (!beforeId) return (others.at(-1)?.sortOrder ?? 0) + 1024;
  const index = others.findIndex((t) => t.id === beforeId);
  if (index === -1) {
    // The next row was not loaded. Place this task just before it, not at the end of the section.
    if (next && beforeId === next.id) {
      const prev = others.at(-1)?.sortOrder ?? next.sortOrder - 2048;
      return (prev + next.sortOrder) / 2;
    }
    return (others.at(-1)?.sortOrder ?? 0) + 1024;
  }
  const next = others[index].sortOrder;
  const prev = index > 0 ? others[index - 1].sortOrder : next - 2048;
  return (prev + next) / 2;
}

function pendingChanges(changes: TaggedChange[], tasks: ProjectTask[], revision: number) {
  void revision;
  const live = changes.filter((item) => !mutationFailed(item.token) && !tokenTaskDropped(item.token, item.change.taskId));
  const latestAt = new Map<string, number>();
  live.forEach((item, index) => latestAt.set(changeKey(item.change), index));
  return live.filter((item, index) => latestAt.get(changeKey(item.change)) === index && !changeAbsorbed(tasks, item.change));
}
