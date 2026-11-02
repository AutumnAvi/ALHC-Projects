"use client";

import { useSyncExternalStore } from "react";

// Nov 2 notes (batch 17, 128): Pin / Unpin shows at once. A click records the comment's new pin time here
// (null = unpinned) before the save starts; the feed draws it until the task's own data agrees (the
// comments Realtime feed refreshes it), and a refused save takes it away again. Module-level, so it
// survives the pane closing and reopening.
export type PinOverride = { taskId: string; pinnedAt: string | null };
let overrides: ReadonlyMap<string, PinOverride> = new Map();
const listeners = new Set<() => void>();

function emit(next: Map<string, PinOverride>) {
  overrides = next;
  listeners.forEach((listener) => listener());
}

export function setPinOverride(taskId: string, commentId: string, pinnedAt: string | null) {
  const next = new Map(overrides);
  next.set(commentId, { taskId, pinnedAt });
  emit(next);
}

export function clearPinOverrides(commentIds: readonly string[]) {
  if (!commentIds.some((commentId) => overrides.has(commentId))) return;
  const next = new Map(overrides);
  commentIds.forEach((commentId) => next.delete(commentId));
  emit(next);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = () => overrides;

export function usePinOverrides(): ReadonlyMap<string, PinOverride> {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

// This task's overrides its own data already shows (pinned or not), to forget. `serverPinnedAt` is the
// comment's pin time as the task's data has it (undefined = not loaded and not among the pinned ones).
export function settledPinOverrides(
  current: ReadonlyMap<string, PinOverride>,
  taskId: string,
  serverPinnedAt: (commentId: string) => string | null | undefined,
): string[] {
  return [...current.entries()]
    .filter(([commentId, o]) => o.taskId === taskId && Boolean(serverPinnedAt(commentId)) === Boolean(o.pinnedAt))
    .map(([commentId]) => commentId);
}
