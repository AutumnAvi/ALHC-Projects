"use client";

import { useSyncExternalStore } from "react";

// Nov 2 notes (batch 16, 122): a review sent from anywhere (the Reviews tab, the "…" menu, the comment
// box) shows on the task's Reviews tab at once. Sending adds a pending round ("Sending…" with who it's
// for); when the send answers, the tab reloads its rounds, and the pending one goes once the reloaded
// list is drawn (no gap). A refused send takes it away again.

export type PendingReview = {
  key: string;
  taskId: string;
  recipient: string;
  files: number;
  // The send answered (successfully): kept until the tab's reload lands.
  settled: boolean;
};

let pending: PendingReview[] = [];
const versions = new Map<string, number>();
let stamp = 0;
const listeners = new Set<() => void>();
const emit = () => {
  stamp += 1;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function startPendingReview(taskId: string, recipient: string, files: number): string {
  const key = `pending-review-${Math.random().toString(36).slice(2)}`;
  pending = [...pending, { key, taskId, recipient, files, settled: false }];
  emit();
  return key;
}

// The send answered: ok → the task's Reviews tab reloads (and drops the pending round when that lands);
// refused → it goes now.
export function finishPendingReview(key: string, ok: boolean) {
  const entry = pending.find((p) => p.key === key);
  if (!entry) return;
  if (ok) {
    pending = pending.map((p) => (p.key === key ? { ...p, settled: true } : p));
    reviewsChanged(entry.taskId);
  } else {
    pending = pending.filter((p) => p.key !== key);
    emit();
  }
}

// Something about the task's reviews changed here (sent, sent again, withdrawn): its tab reloads.
export function reviewsChanged(taskId: string) {
  versions.set(taskId, (versions.get(taskId) ?? 0) + 1);
  emit();
}

// The tab's reload (started at `version`) landed: settled pending rounds sent before it are done.
export function reviewsReloaded(taskId: string, version: number) {
  const before = pending.length;
  pending = pending.filter((p) => !(p.taskId === taskId && p.settled && version >= (versions.get(taskId) ?? 0)));
  if (pending.length !== before) emit();
}

export function reviewsVersion(taskId: string): number {
  return versions.get(taskId) ?? 0;
}

export function pendingReviewsFor(taskId: string, all: readonly PendingReview[] = pending): PendingReview[] {
  return all.filter((p) => p.taskId === taskId);
}

export function useReviewEvents(taskId: string): { version: number; pending: PendingReview[] } {
  useSyncExternalStore(subscribe, () => stamp, () => 0);
  return { version: reviewsVersion(taskId), pending: pendingReviewsFor(taskId) };
}

export function resetReviewEventsForTests() {
  pending = [];
  versions.clear();
  emit();
}
