// In-flight writes. Realtime refreshes wait until they finish (one trailing refresh if events
// arrived during the write), and a failed write drops the optimistic rows tagged with its token.

import { requestRuleFeedback } from "@/lib/rule-feedback-bus";

let nextToken = 0;
let activeToken = 0;
let version = 0;
const open = new Set<number>();
const failed = new Set<number>();
const dropped = new Set<string>();
const listeners = new Set<() => void>();
let dirty = false;
let onQuiet: (() => void) | null = null;

const dropKey = (token: number, taskId: string) => `${token}:${taskId}`;

function emit() {
  version += 1;
  for (const listener of listeners) listener();
}

export function setMutationQuietHandler(handler: (() => void) | null) {
  onQuiet = handler;
}

// When each open write began (Nov 3 notes, batch 18, 138 / 139): ending one asks which automations it ran.
const startedAt = new Map<number, number>();
// When each write ended (Nov 4 notes, batch 28: edits shown on other screens last a moment past it).
const endedAt = new Map<number, number>();

export function mutationEndedAt(token: number): number | undefined {
  return endedAt.get(token);
}

// Nov 3 notes (batch 19, 141): who wants to hear when a write starts or ends — the task pane refetches the
// open task after one (39.x: the pane updates live), and the running indicator shows a slow write.
const openListeners = new Set<() => void>();
const endListeners = new Set<(startedAt: number) => void>();

let openVersion = 0;
export function openMutationVersion(): number {
  return openVersion;
}

export function subscribeOpenMutations(listener: () => void): () => void {
  openListeners.add(listener);
  return () => openListeners.delete(listener);
}

export function onLocalMutationEnd(listener: (startedAt: number) => void): () => void {
  endListeners.add(listener);
  return () => endListeners.delete(listener);
}

// The open writes' start times (oldest first), for the running indicator.
export function openMutationStarts(): number[] {
  return [...open].map((token) => startedAt.get(token) ?? Date.now()).sort((a, b) => a - b);
}

export function mutationInFlight(): boolean {
  return open.size > 0;
}

export function beginLocalMutation(): number {
  const token = ++nextToken;
  open.add(token);
  startedAt.set(token, Date.now());
  activeToken = token;
  openVersion += 1;
  for (const listener of openListeners) listener();
  return token;
}

export function currentMutationToken(): number {
  return activeToken;
}

// True while a write is in flight: the caller should not refresh yet.
export function noteMutationTraffic(): boolean {
  if (open.size === 0) return false;
  dirty = true;
  return true;
}

export function endLocalMutation(token: number) {
  if (!open.delete(token)) return;
  // Every write that went through a local mutation — useServerAction, the bulk bar, … — tells the
  // automation feedback layer, so "Automation X moved 3 tasks" shows whatever path made the change.
  const began = startedAt.get(token) ?? Date.now();
  requestRuleFeedback(began);
  startedAt.delete(token);
  endedAt.set(token, Date.now());
  if (endedAt.size > 200) {
    const oldest = endedAt.keys().next().value;
    if (oldest !== undefined) endedAt.delete(oldest);
  }
  if (activeToken === token) activeToken = 0;
  openVersion += 1;
  for (const listener of openListeners) listener();
  for (const listener of endListeners) listener(began);
  if (open.size === 0 && dirty) {
    dirty = false;
    onQuiet?.();
  }
}

export function failMutation(token: number) {
  if (token === 0 || failed.has(token)) return;
  failed.add(token);
  if (failed.size > 80) {
    const oldest = failed.values().next().value;
    if (oldest !== undefined) failed.delete(oldest);
  }
  emit();
}

// A bulk write applied some tasks and skipped others: drop only the skipped ones.
export function dropTokenTasks(token: number, taskIds: string[]) {
  if (token === 0 || taskIds.length === 0) return;
  for (const taskId of taskIds) dropped.add(dropKey(token, taskId));
  if (dropped.size > 400) {
    const oldest = dropped.values().next().value;
    if (oldest !== undefined) dropped.delete(oldest);
  }
  emit();
}

export function mutationFailed(token: number) {
  return token !== 0 && failed.has(token);
}

export function tokenTaskDropped(token: number, taskId: string) {
  return dropped.has(dropKey(token, taskId));
}

export function subscribeMutationFailures(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function mutationFailureVersion() {
  return version;
}

// A date-shift / dialog that outlives a single transition. `cancel` drops its optimistic rows.
export function holdTaskChanges(): { ok: () => void; cancel: () => void } {
  const token = beginLocalMutation();
  let settled = false;
  const settle = (failedWrite: boolean) => {
    if (settled) return;
    settled = true;
    if (failedWrite) failMutation(token);
    endLocalMutation(token);
  };
  return { ok: () => settle(false), cancel: () => settle(true) };
}

// Nov 12 notes (batch 40, item 1): writes saved without a refresh (src/lib/patched-writes.ts). Their
// optimistic edits stay on other screens until those screens render again (task-edits.ts), and a live
// message that would otherwise wait for the write's own refresh asks for one (live.ts, "skip").
const withoutRefresh = new Set<number>();

export function markWriteWithoutRefresh(token: number) {
  if (token === 0) return;
  withoutRefresh.add(token);
  if (withoutRefresh.size > 200) {
    const oldest = withoutRefresh.values().next().value;
    if (oldest !== undefined) withoutRefresh.delete(oldest);
  }
}

export function writeWithoutRefresh(token: number): boolean {
  return withoutRefresh.has(token);
}

// An open write whose end brings a refresh (so a "skip" live refresh can wait for it).
export function refreshingWriteInFlight(): boolean {
  for (const token of open) if (!withoutRefresh.has(token)) return true;
  return false;
}
