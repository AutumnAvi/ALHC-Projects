"use client";

import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import type { TaskDetail, TaskExtras, TaskPaneContext, TaskPanePayload } from "@/lib/data";
import { patchTaskDetail, type LiveMessage } from "@/lib/live-patch";
import { mutationInFlight } from "@/lib/optimistic-session";
import { getQueryClient } from "@/lib/query/browser-client";
import { noteQueryUse } from "@/lib/query/client";
import { queryKeys } from "@/lib/query/keys";
import { patchStamped, readStamped, type Stamped } from "@/lib/query/stamped";
import {
  isPaneFresh,
  markPanesStale,
  NO_EXTRAS,
  PREFETCH_TTL_MS,
  REVALIDATE_MS,
  storePanePayload,
  taskExtrasQuery,
  taskPaneQuery,
  type ExtrasPart,
  type PaneDetail,
} from "@/lib/query/task-pane";
import { SignedOutError } from "@/lib/query/transport";
import { onRuleFeedbackRequest } from "@/lib/rule-feedback-bus";
import { createLimiter } from "@/lib/task-pane-cache";
import type { TaskSeed } from "@/lib/task-seed";
import { useCacheEntry, type EntryOptions } from "@/lib/query/use-cache-entry";

// The task pane's client side (Oct 19 notes: opening a task must feel instant).
// - The open task: a pin set the moment a row is clicked (an urgent store update, never a transition, so
//   it doesn't wait behind a pending server action), then the URL catches up with history.pushState
//   (no server render). right-panel.tsx owns the URL side.
// - Seeds: what the clicked row already knew, drawn at once while the detail loads.
// - Details: GET /api/task-pane/<id> (the person's own session; RLS decides), cached newest-wins in the
//   client data cache (Nov 4 notes, batch 28), fetched on hover / focus (a few at a time) and revalidated
//   on open. A page's server render of the open task (after a write's refresh) lands here too. Any write
//   marks everything stale.
// - Extras: the Dependencies picker's / Convert's tasks and the slack, only when the pane needs them.

type Listener = () => void;

function emitter() {
  const listeners = new Set<Listener>();
  return {
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit() {
      for (const listener of listeners) listener();
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// The open-task pin. undefined = follow the URL; a task id or null = what the person just chose, until
// the URL says the same.

let pinned: string | null | undefined = undefined;
const pinEvents = emitter();

export function setPinnedTask(task: string | null | undefined) {
  if (pinned === task) return;
  pinned = task;
  pinEvents.emit();
}

export function usePinnedTask(): string | null | undefined {
  return useSyncExternalStore(
    pinEvents.subscribe,
    () => pinned,
    () => undefined,
  );
}

// ---------------------------------------------------------------------------------------------------
// Seeds

const seeds = new Map<string, TaskSeed>();

export function seedTask(seed: TaskSeed | null | undefined) {
  if (!seed) return;
  seeds.delete(seed.id);
  seeds.set(seed.id, seed);
  if (seeds.size > 500) {
    const oldest = seeds.keys().next().value;
    if (oldest !== undefined) seeds.delete(oldest);
  }
}

export function taskSeed(id: string): TaskSeed | undefined {
  return seeds.get(id);
}

// ---------------------------------------------------------------------------------------------------
// Details and the pane context: entries of the client data cache (Nov 4 notes, batch 28: TanStack Query,
// src/lib/query/task-pane.ts), keyed per task, the newest copy winning.

const limitPrefetch = createLimiter(3);

// A page's server render of the open task (cold link, or the refresh after a write).
export function primeTaskPane(id: string, payload: TaskPanePayload) {
  storePanePayload(getQueryClient(), id, payload);
}

function load(id: string, viaQueue: boolean): Promise<void> {
  const client = getQueryClient();
  return client
    .fetchQuery({
      ...taskPaneQuery(client, id, viaQueue ? limitPrefetch : undefined),
      // Opens and refreshes always ask (the freshness rules are checked by the callers).
      staleTime: 0,
    })
    .then(
      () => undefined,
      (error: unknown) => {
        if (error instanceof SignedOutError) {
          window.location.assign(error.location);
          return;
        }
        console.error("[task pane] couldn't load the task", error instanceof Error ? error.message : error);
      },
    );
}

// A fetch already on its way (it may have read before a change), or undefined.
function running(id: string): Promise<unknown> | undefined {
  const query = getQueryClient().getQueryCache().find({ queryKey: queryKeys.task(id), exact: true });
  return query?.state.fetchStatus === "fetching" ? query.promise : undefined;
}

// Hover / focus: load the detail unless a recent copy is already here.
export function prefetchTaskPane(id: string) {
  if (!id || isPaneFresh(getQueryClient(), id, PREFETCH_TTL_MS)) return;
  void load(id, true);
}

// Open: show whatever is cached, and refetch (not queued behind prefetches) when missing or old.
export function ensureTaskPane(id: string) {
  const client = getQueryClient();
  noteQueryUse(client.getQueryCache().find({ queryKey: queryKeys.task(id), exact: true }));
  if (isPaneFresh(client, id, REVALIDATE_MS)) return;
  void load(id, false);
}

// After any write (useServerAction): everything cached may be out of date. The open task's fresh copy
// comes with the refresh's server render; others are refetched when next opened or hovered.
export function invalidateTaskPanes() {
  void markPanesStale(getQueryClient());
}

// ---------------------------------------------------------------------------------------------------
// Nov 3 notes (batch 19; video bugs 35.5, 35.8, 35.12, 35.17, 37.1, 39.x, 40.6): the open pane fetches its
// own fresh copy after a write and when Realtime says the task changed, instead of waiting for the page's
// whole refresh (which re-renders the List and could take seconds, so an automation's comment or due date
// only showed after closing and reopening the task). The pane says which task it shows (watchTaskPane);
// refreshes are coalesced, never overlap for one task, and wait until the person's own writes are done.

const watched = new Map<string, number>();
const queuedRefresh = new Set<string>();
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
// How long after the last write / event the refetch runs (a burst of events is one request).
export const PANE_REFRESH_MS = 250;

export function watchTaskPane(id: string): () => void {
  watched.set(id, (watched.get(id) ?? 0) + 1);
  return () => {
    const n = (watched.get(id) ?? 1) - 1;
    if (n <= 0) watched.delete(id);
    else watched.set(id, n);
  };
}

function flushPaneRefresh() {
  refreshTimer = null;
  // The person's own write is still saving: its end asks again (below).
  if (mutationInFlight()) return;
  const ids = [...queuedRefresh];
  queuedRefresh.clear();
  for (const id of ids) {
    if (!watched.has(id)) continue;
    const pending = running(id);
    // A fetch already on its way may have read before the change: fetch once more after it.
    if (pending) void pending.then(
      () => load(id, false),
      () => load(id, false),
    );
    else void load(id, false);
  }
}

// Fetch this task's pane again soon (when it's still open).
export function refreshTaskPane(id: string) {
  if (!watched.has(id)) return;
  queuedRefresh.add(id);
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(flushPaneRefresh, PANE_REFRESH_MS);
}

// Nov 4 notes, batch 26 (M3): a live message on the task's topic patches the cached copy in place (its
// row, subtasks, comments, reactions, followers, tags, removed files); what it can't patch refetches just
// this task. The patched copy counts as read when the database sent the message, so a fetch that read
// before the change can't put the old values back. Returns whether the Reviews tab should reload.
export function applyLivePane(id: string, message: LiveMessage): { reviews: boolean } {
  const client = getQueryClient();
  const entry = readStamped<TaskDetail | null>(client, queryKeys.task(id));
  if (!entry || !entry.value) {
    refreshTaskPane(id);
    return { reviews: message.table === "review_checks" };
  }
  const patch = patchTaskDetail(entry.value, message);
  if (patch.changed) patchStamped<TaskDetail | null>(client, queryKeys.task(id), () => patch.detail, message.at);
  if (patch.refetch) refreshTaskPane(id);
  return { reviews: patch.reviews };
}

export function refreshOpenTaskPanes() {
  for (const id of watched.keys()) refreshTaskPane(id);
}

if (typeof window !== "undefined") {
  // Every finished write asks the automation feedback layer what it ran (useServerAction and the bulk bar
  // through optimistic-session, date changes through dependency-shift, a Realtime insert of one of the
  // person's runs): the open pane refetches then too.
  onRuleFeedbackRequest(() => refreshOpenTaskPanes());
}

export function useTaskPaneDetail(id: string | null): PaneDetail | undefined {
  return useCacheEntry<PaneDetail>(id ? ({ ...taskPaneQuery(getQueryClient(), id), staleTime: REVALIDATE_MS } as EntryOptions) : null);
}

export function useTaskPaneContext(): TaskPaneContext | null {
  return useCacheEntry<Stamped<TaskPaneContext>>(CONTEXT_ENTRY)?.value ?? null;
}

const CONTEXT_ENTRY = { queryKey: queryKeys.taskContext() };

// ---------------------------------------------------------------------------------------------------
// Extras: the slack ("schedule") for a dated task, and the Dependencies picker's / Convert's tasks
// ("candidates") once one of them opens. Loaded on demand, cached until the next write (which loads the
// shown ones again).

export type { ExtrasPart };

// `enabled` false: nothing is loaded and null comes back. Null while loading; a failure reads as empty.
export function useTaskExtras(id: string, part: ExtrasPart, enabled: boolean): TaskExtras | null {
  const result = useQuery({ ...taskExtrasQuery(id, part), enabled }, getQueryClient());
  if (!enabled) return null;
  if (result.isError) return NO_EXTRAS;
  return result.data ?? null;
}
