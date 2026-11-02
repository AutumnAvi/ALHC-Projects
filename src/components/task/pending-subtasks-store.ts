"use client";

import { useSyncExternalStore } from "react";

// Nov 2 notes (batch 17, 131): subtasks still on their way to the server, drawn at once at the end of the
// parent's Subtasks list ("Create subtask" from a piece of feedback, "+ Add subtask"). A row is dropped
// once the parent's data lists the saved subtask (its id), or when the save is refused.
export type PendingSubtask = { tempId: string; parentId: string; title: string; serverId: string | null };

let pending: readonly PendingSubtask[] = [];
const listeners = new Set<() => void>();

function emit(next: readonly PendingSubtask[]) {
  pending = next;
  listeners.forEach((listener) => listener());
}

export function addPendingSubtask(row: Omit<PendingSubtask, "serverId">) {
  emit([...pending, { ...row, serverId: null }]);
}

export function settlePendingSubtask(tempId: string, serverId: string) {
  emit(pending.map((p) => (p.tempId === tempId ? { ...p, serverId } : p)));
}

export function dropPendingSubtasks(tempIds: readonly string[]) {
  if (!pending.some((p) => tempIds.includes(p.tempId))) return;
  emit(pending.filter((p) => !tempIds.includes(p.tempId)));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = () => pending;

export function usePendingSubtasks(): readonly PendingSubtask[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
