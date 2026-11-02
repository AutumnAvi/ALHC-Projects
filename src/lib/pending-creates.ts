"use client";

import { useEffect, useSyncExternalStore } from "react";

// Nov 2 notes (batch 16, 121): a new task or subtask shows the moment Enter is pressed. Adding one puts a
// pending row into this store under a scope (a project section's add box, a task's subtask list); the
// List, Board, and the pane draw it (typed title, no number yet) where the saved one will land, and it
// gives way to the saved row as soon as the page's own list has it — by the id the save returned, or,
// before that answer, by a new id with the same title. A refused save takes it away (the toast says why);
// a saved one the page never shows (a filtered view) is gone a moment after the save.

export type PendingCreate = {
  key: string;
  scope: string;
  title: string;
  // Ids the scope's list had when it was added: the saved row is a new id.
  known: ReadonlySet<string>;
  // The saved row's id, once the save answered.
  savedId: string | null;
  addedAt: number;
  // Free-form details the drawing side needs (the task's kind, top or bottom of the section).
  meta?: Record<string, unknown>;
};

type Item = { id: string; title: string };

export const PENDING_CREATE_PREFIX = "pending-create-";
// How long a saved row may take to show up in the page's list before the pending one goes anyway.
export const PENDING_SETTLE_MS = 2500;
// Never left behind: a save that never answers.
export const PENDING_MAX_MS = 30_000;

let entries: PendingCreate[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => entries;
const empty: PendingCreate[] = [];
const latest = new Map<string, readonly Item[]>();

export function isPendingCreateId(id: string) {
  return id.startsWith(PENDING_CREATE_PREFIX);
}

// Whether the page's list already shows the saved row for this pending one.
export function pendingCreateResolved(entry: Pick<PendingCreate, "known" | "savedId" | "title">, items: readonly Item[]): boolean {
  if (entry.savedId) return items.some((item) => item.id === entry.savedId);
  const title = entry.title.trim();
  return items.some((item) => !entry.known.has(item.id) && item.title.trim() === title);
}

// The pending rows of a scope the list hasn't caught up with, oldest first. Each saved row resolves at most
// one pending row (two "Logo" rows added back to back stay two until both are saved).
export function unresolvedPendingCreates(scope: string, items: readonly Item[], all: readonly PendingCreate[]): PendingCreate[] {
  const claimed = new Set<string>();
  const out: PendingCreate[] = [];
  for (const entry of all) {
    if (entry.scope !== scope) continue;
    const match = entry.savedId
      ? items.find((item) => item.id === entry.savedId)
      : items.find((item) => !claimed.has(item.id) && !entry.known.has(item.id) && item.title.trim() === entry.title.trim());
    if (match && !claimed.has(match.id)) {
      claimed.add(match.id);
      continue;
    }
    out.push(entry);
  }
  return out;
}

function remove(entry: PendingCreate) {
  if (!entries.includes(entry)) return;
  entries = entries.filter((e) => e !== entry);
  emit();
}

export type PendingHandle = {
  key: string;
  // The save answered: with the new row's id (it goes once the list shows it), or refused (it goes now).
  settle: (result: { savedId?: string | null; failed?: boolean }) => void;
};

export function addPendingCreate(
  scope: string,
  title: string,
  meta?: Record<string, unknown>,
  items: readonly Item[] = latest.get(scope) ?? [],
): PendingHandle {
  let entry: PendingCreate = {
    key: `${PENDING_CREATE_PREFIX}${Math.random().toString(36).slice(2)}`,
    scope,
    title,
    known: new Set(items.map((i) => i.id)),
    savedId: null,
    addedAt: Date.now(),
    meta,
  };
  entries = [...entries, entry];
  emit();
  const cap = setTimeout(() => remove(entry), PENDING_MAX_MS);
  return {
    key: entry.key,
    settle({ savedId, failed }) {
      if (failed) {
        clearTimeout(cap);
        remove(entry);
        return;
      }
      if (savedId && entries.includes(entry)) {
        const next = { ...entry, savedId };
        entries = entries.map((e) => (e === entry ? next : e));
        entry = next;
        emit();
      }
      setTimeout(() => {
        clearTimeout(cap);
        remove(entry);
      }, PENDING_SETTLE_MS);
    },
  };
}

// Runs a create with a pending row shown meanwhile. `save` returns the action's result; its `taskId`
// (when given) is the new row's id.
export async function withPendingCreate<R extends { error?: string; taskId?: string | null } | void>(
  scope: string,
  title: string,
  save: () => Promise<R>,
  meta?: Record<string, unknown>,
): Promise<R> {
  const handle = addPendingCreate(scope, title, meta);
  try {
    const result = await save();
    handle.settle(result && result.error ? { failed: true } : { savedId: result ? (result.taskId ?? null) : null });
    return result;
  } catch (error) {
    handle.settle({ failed: true });
    throw error;
  }
}

// The scope's pending rows still waiting for the list (and the list remembered, so the next add knows
// which ids are old). Resolved ones are dropped from the store.
export function usePendingCreates(scope: string, items: readonly Item[]): PendingCreate[] {
  const all = useSyncExternalStore(subscribe, snapshot, () => empty);
  latest.set(scope, items);
  const open = unresolvedPendingCreates(scope, items, all);
  const resolved = all.filter((e) => e.scope === scope && !open.includes(e));
  useEffect(() => {
    if (resolved.length === 0) return;
    entries = entries.filter((e) => !resolved.includes(e));
    emit();
  });
  return open;
}

export function resetPendingCreatesForTests() {
  entries = [];
  latest.clear();
  emit();
}
