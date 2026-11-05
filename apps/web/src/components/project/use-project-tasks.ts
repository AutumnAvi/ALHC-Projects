"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useTaskEdits, recordTaskEdits } from "@/components/task/task-edits";
import { completionsVersion, recentCompletion, subscribeCompletions } from "@/lib/completion-store";
import type { ProjectTask } from "@alhc/core/api/tasks/model";
import {
  currentMutationToken,
  mutationFailed,
  mutationFailureVersion,
  subscribeMutationFailures,
  tokenTaskDropped,
} from "@/lib/optimistic-session";
import { getQueryClient } from "@alhc/core/query/browser-client";
import { queryKeys } from "@alhc/core/query/keys";
import { isTaskEdit, type TaggedEdit } from "@alhc/core/query/task-edits";
import { useCacheEntry } from "@/lib/query/use-cache-entry";
import type { TaskChange } from "@alhc/core/live-patch";

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
    case "presence":
      return change.present ? tasks : tasks.filter((task) => task.id !== change.taskId);
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
  if (change.type === "presence") return change.present || !task;
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

// Rows whose visible blockers were completed in this browser (or in this list's overlay) count them as
// done before the server's refresh says so (Nov 2 notes, batch 15, 111). `version` only re-runs it.
export function unblockCompleted(tasks: ProjectTask[], version: number): ProjectTask[] {
  void version;
  const doneHere = new Set(tasks.filter((t) => t.completedAt).map((t) => t.id));
  let changed = false;
  const next = tasks.map((task) => {
    if (!task.blockedBy || !task.blockerIds?.length) return task;
    const done = task.blockerIds.filter((id) => doneHere.has(id) || recentCompletion(id) === true).length;
    const open = Math.max(0, task.blockedBy - done);
    if (open === task.blockedBy) return task;
    changed = true;
    return { ...task, blockedBy: open };
  });
  return changed ? next : tasks;
}

export function overlayProjectTasks(tasks: ProjectTask[], changes: TaskChange[]) {
  const latestAt = new Map<string, number>();
  changes.forEach((change, index) => latestAt.set(changeKey(change), index));
  const live = changes.filter(
    (change, index) => latestAt.get(changeKey(change)) === index && !changeAbsorbed(tasks, change),
  );
  return live.reduce(apply, tasks);
}

// Nov 4 notes, batch 28 (M4): the overlay lives in the client data cache, one entry per project
// (queryKeys.projectChanges), shared by the project's List, Board, Calendar, and Timeline and kept across
// navigations: a change still saving, or one heard live, shows on the next view too (and on a revisit drawn
// from the router's cache), until the server's copy agrees. The person's own changes made elsewhere (the
// pane's rename, completion, dates, assignee: task-edits.ts) apply here too.
//
// One turn's changes flush together, after the event, so a bulk edit doesn't re-render once per task. The
// cache's notifications aren't transitions, so the new position paints before the server answers.
type StampedChange = TaggedChange & { at: number };

const queued = new Map<string, StampedChange[]>();
let flushScheduled = false;

function flushQueued() {
  flushScheduled = false;
  const client = getQueryClient();
  for (const [projectId, batch] of queued) {
    client.setQueryData<StampedChange[]>(queryKeys.projectChanges(projectId), (current) =>
      [...(current ?? []), ...batch].slice(-MAX_CHANGES),
    );
  }
  queued.clear();
}

function enqueue(projectId: string, items: StampedChange[]) {
  if (typeof window === "undefined" || items.length === 0) return;
  const list = queued.get(projectId);
  if (list) list.push(...items);
  else queued.set(projectId, [...items]);
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flushQueued);
}

const MAX_CHANGES = 500;

// Nov 4 notes, batch 26 (M3): live updates from other people land in the same overlay as the person's own
// changes (token 0: never "failed"), kept until the server's copy agrees. The mounted list publishes what
// it shows so a live message is compared with that.
const shownTasks = new Map<string, ProjectTask[]>();

export function shownProjectTasks(projectId: string): ProjectTask[] {
  return shownTasks.get(projectId) ?? [];
}

export function applyLiveTaskChanges(projectId: string, changes: TaskChange[]) {
  const at = Date.now();
  enqueue(
    projectId,
    changes.map((change) => ({ token: 0, change, at })),
  );
}

const NO_CHANGES: StampedChange[] = [];

export function useProjectTasks(projectId: string, tasks: ProjectTask[]) {
  const entry = useMemo(() => ({ queryKey: queryKeys.projectChanges(projectId) }), [projectId]);
  const stored = useCacheEntry<StampedChange[]>(entry) ?? NO_CHANGES;
  const revision = useSyncExternalStore(subscribeMutationFailures, mutationFailureVersion, () => 0);
  const edits = useTaskEdits();

  const applyChange = useCallback(
    (change: TaskChange) => {
      const token = currentMutationToken();
      enqueue(projectId, [{ token, change, at: Date.now() }]);
      // The pane beside the List (and any other screen showing the task) draws it at once too.
      if (isTaskEdit(change)) recordTaskEdits([change], token);
    },
    [projectId],
  );

  // `revision` re-renders this list when a write fails or a bulk skip drops rows.
  const pending = pendingChanges(stored, tasks, revision);
  useEffect(() => {
    if (pending.length === stored.length) return;
    // What the server's copy already shows (or a failed write) leaves the shared entry; anything added
    // since this render stays.
    const keep = new Set<StampedChange>(pending);
    const seen = new Set<StampedChange>(stored);
    getQueryClient().setQueryData<StampedChange[]>(queryKeys.projectChanges(projectId), (current) =>
      (current ?? []).filter((item) => keep.has(item) || !seen.has(item)),
    );
  }, [projectId, pending, stored]);
  // Nov 2 notes (batch 15, 111): a task blocked only by tasks just completed here is unblocked at once.
  const completions = useSyncExternalStore(subscribeCompletions, completionsVersion, () => 0);

  const shown = unblockCompleted(overlayWithEdits(tasks, pending, edits), completions);
  useEffect(() => {
    shownTasks.set(projectId, shown);
  });
  useEffect(
    () => () => {
      shownTasks.delete(projectId);
    },
    [projectId],
  );
  return [shown, applyChange] as const;
}

// The project's own changes and the edits made on other screens, oldest first: the latest per task and
// kind of change wins, and what the server's copy already shows is left out.
export function overlayWithEdits(
  tasks: ProjectTask[],
  changes: readonly { change: TaskChange; at: number }[],
  edits: readonly TaggedEdit[],
): ProjectTask[] {
  const all = edits.length
    ? [...changes, ...edits.map((item) => ({ change: item.edit as TaskChange, at: item.at }))].sort((x, y) => x.at - y.at)
    : changes;
  return overlayProjectTasks(tasks, all.map((item) => item.change));
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
  const nextOrder = others[index].sortOrder;
  const prev = index > 0 ? others[index - 1].sortOrder : nextOrder - 2048;
  return (prev + nextOrder) / 2;
}

function pendingChanges<C extends TaggedChange>(changes: C[], tasks: ProjectTask[], revision: number): C[] {
  void revision;
  const live = changes.filter((item) => !mutationFailed(item.token) && !tokenTaskDropped(item.token, item.change.taskId));
  const latestAt = new Map<string, number>();
  live.forEach((item, index) => latestAt.set(changeKey(item.change), index));
  return live.filter((item, index) => latestAt.get(changeKey(item.change)) === index && !changeAbsorbed(tasks, item.change));
}
