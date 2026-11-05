"use client";

import type { ParentCandidate } from "@/lib/api/tasks/model";

// Nov 2 notes (batch 16, 124): the "Make a subtask of…" picker's searches. A GET route (never queued
// behind other Server Actions), the newest search wins (older ones are aborted), and the blank list
// (recent open tasks of its projects) is kept a little while and fetched as soon as the "…" menu opens,
// so the dialog opens with it already there.

export type ParentSearchResult = { data: ParentCandidate[]; error?: string };

const BLANK_TTL_MS = 30_000;
const blank = new Map<string, { at: number; promise: Promise<ParentSearchResult> }>();

async function fetchParents(taskId: string, query: string, signal?: AbortSignal): Promise<ParentSearchResult> {
  const response = await fetch(`/api/task-pane/${encodeURIComponent(taskId)}/parents?q=${encodeURIComponent(query)}`, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal,
  });
  const body = (await response.json().catch(() => null)) as { data?: ParentCandidate[]; error?: string } | null;
  if (!response.ok || !body) return { data: [], error: body?.error ?? "Couldn’t load tasks. Try again." };
  return { data: body.data ?? [] };
}

// The blank list, fetched once and reused for a while (opening the menu prefetches it).
export function blankParents(taskId: string): Promise<ParentSearchResult> {
  const cached = blank.get(taskId);
  if (cached && Date.now() - cached.at < BLANK_TTL_MS) return cached.promise;
  const promise = fetchParents(taskId, "").catch(() => ({ data: [], error: "Couldn’t load tasks. Try again." }));
  blank.set(taskId, { at: Date.now(), promise });
  return promise;
}

export function prefetchParents(taskId: string) {
  void blankParents(taskId);
}

export function searchParents(taskId: string, query: string, signal: AbortSignal): Promise<ParentSearchResult> {
  const trimmed = query.trim();
  return trimmed ? fetchParents(taskId, trimmed, signal) : blankParents(taskId);
}

// After a conversion the candidates changed.
export function forgetParents(taskId?: string) {
  if (taskId) blank.delete(taskId);
  else blank.clear();
}
