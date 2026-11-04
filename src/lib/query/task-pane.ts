// Nov 4 notes, batch 28 (M4): the task pane's entries in the client data cache, keyed per task (Oct 19
// notes' rules, unchanged): the newest copy wins (each carries the server time its reads started), a copy
// fetched less than PREFETCH_TTL_MS ago isn't fetched again on hover, one older than REVALIDATE_MS is
// refetched in the background on open, and every write marks them all stale (shown at once, refetched on
// the next open). Fifty tasks at most (client.ts).

import { isServer, type FetchQueryOptions, type QueryClient } from "@tanstack/query-core";
import type { TaskDetail, TaskExtras, TaskPaneContext, TaskPanePayload } from "@/lib/data";
import { queryKeys } from "./keys";
import { newestOf, readStamped, writeNewest, type Stamped } from "./stamped";
import { getJson } from "./transport";

export const PREFETCH_TTL_MS = 30_000;
export const REVALIDATE_MS = 10_000;
export const CONTEXT_TTL_MS = 120_000;
// Kept longer than the default: reopening a task from earlier in the session is common.
export const PANE_GC_MS = 10 * 60_000;

export type PaneDetail = Stamped<TaskDetail | null>;
export type ExtrasPart = "schedule" | "candidates";

// A pane load (the page's server render of ?task=, or the route's answer) goes into the cache; the
// context (people, projects, tags for the pickers) too, when it came along. Returns whether anything changed.
export function storePanePayload(client: QueryClient, taskId: string, payload: TaskPanePayload): boolean {
  const task = writeNewest(client, queryKeys.task(taskId), payload.task, payload.loadedAt);
  const context = payload.context ? writeNewest(client, queryKeys.taskContext(), payload.context, payload.loadedAt) : false;
  return task || context;
}

export async function fetchPanePayload(client: QueryClient, taskId: string): Promise<TaskPanePayload> {
  const context = client.getQueryState(queryKeys.taskContext());
  const needContext = !context?.data || Date.now() - context.dataUpdatedAt > CONTEXT_TTL_MS;
  const payload = await getJson<TaskPanePayload>(`/api/task-pane/${encodeURIComponent(taskId)}${needContext ? "?context=1" : ""}`, {
    notFoundAsNull: true,
  });
  // 404: gone, or not this person's to open.
  return payload ?? { task: null, context: null, loadedAt: Date.now() };
}

// `run` lets hover prefetches wait their turn (a few at a time); opens go straight through.
export function taskPaneQuery(
  client: QueryClient,
  taskId: string,
  run: (load: () => Promise<TaskPanePayload>) => Promise<TaskPanePayload> = (load) => load(),
): FetchQueryOptions<PaneDetail> & { queryKey: readonly unknown[] } {
  const queryKey = queryKeys.task(taskId);
  return {
    queryKey,
    queryFn: async () => {
      const payload = await run(() => fetchPanePayload(client, taskId));
      if (payload.context) writeNewest(client, queryKeys.taskContext(), payload.context, payload.loadedAt);
      // A live patch or a server render newer than this answer stays.
      return newestOf(readStamped<TaskDetail | null>(client, queryKey), { value: payload.task, loadedAt: payload.loadedAt });
    },
    retry: false,
    gcTime: isServer ? Infinity : PANE_GC_MS,
  };
}

// Held, not marked stale by a write, and arrived less than maxAgeMs ago.
export function isPaneFresh(client: QueryClient, taskId: string, maxAgeMs: number, now = Date.now()): boolean {
  const state = client.getQueryState(queryKeys.task(taskId));
  return Boolean(state && state.data !== undefined && !state.isInvalidated && now - state.dataUpdatedAt < maxAgeMs);
}

// After any write: every cached pane may be out of date (still shown; refetched when next opened or
// hovered), and the slow parts are loaded again where they're shown.
export async function markPanesStale(client: QueryClient) {
  await Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.tasks(), refetchType: "none" }),
    client.invalidateQueries({ queryKey: queryKeys.allTaskExtras() }),
  ]);
}

export function taskExtrasQuery(taskId: string, part: ExtrasPart) {
  return {
    queryKey: queryKeys.taskExtras(taskId, part),
    queryFn: async () =>
      (await getJson<TaskExtras>(`/api/task-pane/${encodeURIComponent(taskId)}?part=${part}`)) ?? NO_EXTRAS,
    staleTime: Infinity,
    retry: false,
  };
}

export const NO_EXTRAS: TaskExtras = { dependencyCandidates: [], schedule: [] };

export type { TaskPaneContext };
