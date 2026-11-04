"use client";

import { useMemo, useSyncExternalStore } from "react";
import {
  currentMutationToken,
  mutationEndedAt,
  mutationFailed,
  mutationFailureVersion,
  onLocalMutationEnd,
  subscribeMutationFailures,
  tokenTaskDropped,
} from "@/lib/optimistic-session";
import { getQueryClient } from "@/lib/query/browser-client";
import { queryKeys } from "@/lib/query/keys";
import { addTaskEdits, liveEdits, pruneTaskEdits, type EditStatus, type TaggedEdit, type TaskEdit } from "@/lib/query/task-edits";
import { useCacheEntry } from "@/lib/query/use-cache-entry";

// Nov 4 notes, batch 28 (M4): the browser side of src/lib/query/task-edits.ts — optimistic edits every
// screen showing the task applies at once, rolled back the moment their write fails.

const status: EditStatus = { failed: mutationFailed, dropped: tokenTaskDropped, endedAt: mutationEndedAt };
let pruneTimer: number | undefined;

function schedulePrune() {
  window.clearTimeout(pruneTimer);
  const next = pruneTaskEdits(getQueryClient(), status);
  if (next !== null) pruneTimer = window.setTimeout(schedulePrune, Math.max(50, next - Date.now() + 20));
}

// Inside a write's optimistic step (useServerAction's), the write's token tags them.
export function recordTaskEdits(edits: readonly TaskEdit[], token = currentMutationToken()) {
  if (typeof window === "undefined" || edits.length === 0) return;
  addTaskEdits(getQueryClient(), token, edits);
  schedulePrune();
}

if (typeof window !== "undefined") {
  onLocalMutationEnd(() => schedulePrune());
  subscribeMutationFailures(() => schedulePrune());
}

const EDITS_ENTRY = { queryKey: queryKeys.taskEdits() };
const NONE: TaggedEdit[] = [];

// The edits in force (expired ones leave through the prune timer, which re-renders).
export function useTaskEdits(): TaggedEdit[] {
  const items = useCacheEntry<TaggedEdit[]>(EDITS_ENTRY) ?? NONE;
  // A failed write (or a bulk skip) drops its edits at once.
  const failures = useSyncExternalStore(subscribeMutationFailures, mutationFailureVersion, () => 0);
  return useMemo(() => {
    void failures;
    return items.length ? liveEdits(items, status) : NONE;
  }, [items, failures]);
}
