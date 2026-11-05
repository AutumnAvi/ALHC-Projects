"use client";

import { useSyncExternalStore } from "react";
import type { PendingComment } from "@/lib/pending-comments";

// The pane's optimistic comments, shared by the composer (TaskPaneFooter adds them) and the feed
// (TaskActivity draws them): one module-level store per browser tab. See src/lib/pending-comments.ts.

let pending: PendingComment[] = [];
// Server id → the tempId it replaced, so an arrived comment keeps its React key.
const keys = new Map<string, string>();
const listeners = new Set<() => void>();
const EMPTY: PendingComment[] = [];
const cache = new Map<string, PendingComment[]>();

function emit() {
  cache.clear();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function forTask(taskId: string): PendingComment[] {
  let list = cache.get(taskId);
  if (!list) {
    list = pending.filter((p) => p.taskId === taskId);
    if (list.length === 0) list = EMPTY;
    cache.set(taskId, list);
  }
  return list;
}

export function usePendingComments(taskId: string): PendingComment[] {
  return useSyncExternalStore(
    subscribe,
    () => forTask(taskId),
    () => EMPTY,
  );
}

export function rememberedCommentKeys(): ReadonlyMap<string, string> {
  return keys;
}

export function addPendingComment(comment: PendingComment) {
  pending = [...pending, comment];
  emit();
}

// The action answered with the new comment's id.
export function settlePendingComment(tempId: string, serverId: string) {
  keys.set(serverId, tempId);
  pending = pending.map((p) => (p.tempId === tempId ? { ...p, serverId } : p));
  emit();
}

// The action failed: the row goes away (the composer restores the text and the toast says why).
export function dropPendingComment(tempId: string) {
  pending = pending.filter((p) => p.tempId !== tempId);
  emit();
}

// The server's rows include these now; forget the pending copies (their keys are remembered).
export function forgetArrivedComments(arrived: { tempId: string; serverId: string }[]) {
  if (arrived.length === 0) return;
  for (const { tempId, serverId } of arrived) keys.set(serverId, tempId);
  const done = new Set(arrived.map((a) => a.tempId));
  pending = pending.filter((p) => !done.has(p.tempId));
  emit();
}
