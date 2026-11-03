"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { TaskDetail, TaskExtras, TaskPaneContext, TaskPanePayload } from "@/lib/data";
import { mutationInFlight } from "@/lib/optimistic-session";
import { onRuleFeedbackRequest } from "@/lib/rule-feedback-bus";
import { createLimiter, PaneCache, type PaneEntry } from "@/lib/task-pane-cache";
import type { TaskSeed } from "@/lib/task-seed";

// The task pane's client side (Oct 19 notes: opening a task must feel instant).
// - The open task: a pin set the moment a row is clicked (an urgent store update, never a transition, so
//   it doesn't wait behind a pending server action), then the URL catches up with history.pushState
//   (no server render). right-panel.tsx owns the URL side.
// - Seeds: what the clicked row already knew, drawn at once while the detail loads.
// - Details: GET /api/task-pane/<id> (the person's own session; RLS decides), cached newest-wins, fetched
//   on hover / focus (a few at a time) and revalidated on open. A page's server render of the open task
//   (after a write's refresh) lands here too. Any write marks everything stale.
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
// Details and the pane context

const details = new PaneCache<TaskDetail | null>(50);
const detailEvents = emitter();
let context: { value: TaskPaneContext; loadedAt: number; receivedAt: number } | null = null;
const inflight = new Map<string, Promise<void>>();
const limitPrefetch = createLimiter(3);

// A detail fetched less than this long ago isn't fetched again on hover; on open, anything older than
// REVALIDATE_MS is refetched in the background (the cached copy shows at once).
const PREFETCH_TTL_MS = 30_000;
const REVALIDATE_MS = 10_000;
const CONTEXT_TTL_MS = 120_000;

function storePayload(id: string, payload: TaskPanePayload) {
  const now = Date.now();
  let changed = details.put(id, payload.task, payload.loadedAt, now);
  if (payload.context && (!context || context.loadedAt <= payload.loadedAt)) {
    context = { value: payload.context, loadedAt: payload.loadedAt, receivedAt: now };
    changed = true;
  }
  if (changed) detailEvents.emit();
}

// A page's server render of the open task (cold link, or the refresh after a write).
export function primeTaskPane(id: string, payload: TaskPanePayload) {
  storePayload(id, payload);
}

async function fetchPane(id: string): Promise<void> {
  const needContext = !context || Date.now() - context.receivedAt > CONTEXT_TTL_MS;
  const response = await fetch(`/api/task-pane/${encodeURIComponent(id)}${needContext ? "?context=1" : ""}`, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  // Signed out (the proxy redirects to the sign-in page): go there.
  if (response.redirected && !response.url.includes("/api/task-pane/")) {
    window.location.assign(response.url);
    return;
  }
  if (response.status === 404) {
    storePayload(id, { task: null, context: null, loadedAt: Date.now() });
    return;
  }
  if (!response.ok) throw new Error(`Task pane responded ${response.status}`);
  storePayload(id, (await response.json()) as TaskPanePayload);
}

function load(id: string, viaQueue: boolean): Promise<void> {
  const running = inflight.get(id);
  if (running) return running;
  const promise = (viaQueue ? limitPrefetch(() => fetchPane(id)) : fetchPane(id))
    .catch((error) => {
      console.error("[task pane] couldn't load the task", error instanceof Error ? error.message : error);
    })
    .finally(() => inflight.delete(id));
  inflight.set(id, promise);
  return promise;
}

// Hover / focus: load the detail unless a recent copy is already here.
export function prefetchTaskPane(id: string) {
  if (!id || details.isFresh(id, Date.now(), PREFETCH_TTL_MS)) return;
  void load(id, true);
}

// Open: show whatever is cached, and refetch (not queued behind prefetches) when missing or old.
export function ensureTaskPane(id: string) {
  details.touch(id);
  if (details.isFresh(id, Date.now(), REVALIDATE_MS)) return;
  void load(id, false);
}

// After any write (useServerAction): everything cached may be out of date. The open task's fresh copy
// comes with the refresh's server render; others are refetched when next opened or hovered.
export function invalidateTaskPanes() {
  details.markAllStale();
  extras.clear();
  extrasEvents.emit();
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
    const running = inflight.get(id);
    // A fetch already on its way may have read before the change: fetch once more after it.
    if (running) void running.then(() => load(id, false));
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

export function refreshOpenTaskPanes() {
  for (const id of watched.keys()) refreshTaskPane(id);
}

if (typeof window !== "undefined") {
  // Every finished write asks the automation feedback layer what it ran (useServerAction and the bulk bar
  // through optimistic-session, date changes through dependency-shift, a Realtime insert of one of the
  // person's runs): the open pane refetches then too.
  onRuleFeedbackRequest(() => refreshOpenTaskPanes());
}

export function useTaskPaneDetail(id: string | null): PaneEntry<TaskDetail | null> | undefined {
  return useSyncExternalStore(
    detailEvents.subscribe,
    () => (id ? details.get(id) : undefined),
    () => undefined,
  );
}

export function useTaskPaneContext(): TaskPaneContext | null {
  return useSyncExternalStore(
    detailEvents.subscribe,
    () => context?.value ?? null,
    () => null,
  );
}

// ---------------------------------------------------------------------------------------------------
// Extras: the slack ("schedule") for a dated task, and the Dependencies picker's / Convert's tasks
// ("candidates") once one of them opens. Loaded on demand, cached until the next write.

export type ExtrasPart = "schedule" | "candidates";
const extras = new Map<string, TaskExtras | "loading" | "failed">();
const extrasEvents = emitter();

function loadExtras(id: string, part: ExtrasPart) {
  const key = `${id}:${part}`;
  if (extras.has(key)) return;
  extras.set(key, "loading");
  extrasEvents.emit();
  fetch(`/api/task-pane/${encodeURIComponent(id)}?part=${part}`, { cache: "no-store", credentials: "same-origin" })
    .then(async (response) => {
      if (!response.ok) throw new Error(`Task extras responded ${response.status}`);
      extras.set(key, (await response.json()) as TaskExtras);
    })
    .catch(() => extras.set(key, "failed"))
    .finally(() => extrasEvents.emit());
}

const NO_EXTRAS: TaskExtras = { dependencyCandidates: [], schedule: [] };

// `enabled` false: nothing is loaded and null comes back. Null while loading; a failure reads as empty.
export function useTaskExtras(id: string, part: ExtrasPart, enabled: boolean): TaskExtras | null {
  const key = `${id}:${part}`;
  const value = useSyncExternalStore(
    extrasEvents.subscribe,
    () => extras.get(key),
    () => undefined,
  );
  useEffect(() => {
    if (enabled && value === undefined) loadExtras(id, part);
  }, [id, part, enabled, value]);
  if (!enabled) return null;
  if (value === "failed") return NO_EXTRAS;
  return value === undefined || value === "loading" ? null : value;
}
