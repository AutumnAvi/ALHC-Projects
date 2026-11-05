// Nov 4 notes, batch 28 (M4): the client data cache (TanStack Query), one per signed-in person, in memory
// only (nothing is written to the browser's storage). Screens are server-rendered as before; the cache
// holds what they share and what outlives a navigation — task pane details, each project's overlay of
// optimistic and live changes, the person's own tasks, live Inbox patches — so revisiting a screen draws
// the newest copy at once and the server's render replaces it when it lands.
//
// Bounded: entries nobody shows are dropped after GC_TIME_MS, and each group keeps at most its limit
// (the least recently used entries nobody shows go first), so a long session over a big workspace stays
// small.

import { isServer, QueryClient, type Query, type QueryCache } from "@tanstack/query-core";
import { groupOf } from "./keys";
import { HttpError } from "./transport";

export const STALE_TIME_MS = 30_000;
export const GC_TIME_MS = 5 * 60_000;

// Per group (keys.ts); "total" caps everything together.
export const CACHE_LIMITS: Record<string, number> = {
  task: 50,
  "task-extras": 40,
  "task-context": 1,
  project: 40,
  me: 10,
  edits: 1,
  other: 40,
  total: 200,
};

export function createAlhcQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE_TIME_MS,
        // On the server a cache lives for one render and is dropped whole: no timers (TanStack's own default).
        gcTime: isServer ? Infinity : GC_TIME_MS,
        // Live updates and the revalidation on revisit keep screens current; a focus refetch of every
        // cached entry would only add load.
        refetchOnWindowFocus: false,
        // A refused or missing read (401 / 403 / 404) won't change by asking again.
        retry: (failures, error) => failures < 1 && !(error instanceof HttpError && error.status < 500),
      },
    },
  });
  bindCacheLimits(client.getQueryCache());
  return client;
}

export type CacheEntryInfo = { hash: string; group: string; active: boolean; usedAt: number };

// Which entries to drop so every group (and the whole cache) fits its limit: only entries nobody shows,
// least recently used first. Pure, for the unit tests.
export function overflowingEntries(entries: readonly CacheEntryInfo[], limits: Record<string, number> = CACHE_LIMITS): string[] {
  const drop = new Set<string>();
  const byUse = [...entries].sort((a, b) => a.usedAt - b.usedAt);
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.group, (counts.get(entry.group) ?? 0) + 1);
  for (const entry of byUse) {
    if (entry.active) continue;
    const limit = limits[entry.group] ?? limits.other ?? Infinity;
    const count = counts.get(entry.group) ?? 0;
    if (count > limit) {
      drop.add(entry.hash);
      counts.set(entry.group, count - 1);
    }
  }
  let total = entries.length - drop.size;
  const cap = limits.total ?? Infinity;
  for (const entry of byUse) {
    if (total <= cap) break;
    if (entry.active || drop.has(entry.hash)) continue;
    drop.add(entry.hash);
    total -= 1;
  }
  return [...drop];
}

// When each entry was last shown or written (observers come and go as screens mount).
const usedAt = new WeakMap<Query, number>();

export function noteQueryUse(query: Query | undefined, now = Date.now()) {
  if (query) usedAt.set(query, now);
}

function lastUse(query: Query) {
  return Math.max(usedAt.get(query) ?? 0, query.state.dataUpdatedAt);
}

export function enforceCacheLimits(cache: QueryCache, limits: Record<string, number> = CACHE_LIMITS) {
  const queries = cache.getAll();
  const drop = new Set(
    overflowingEntries(
      queries.map((q) => ({ hash: q.queryHash, group: groupOf(q.queryKey), active: q.getObserversCount() > 0, usedAt: lastUse(q) })),
      limits,
    ),
  );
  if (drop.size === 0) return;
  for (const query of queries) if (drop.has(query.queryHash)) cache.remove(query);
}

function bindCacheLimits(cache: QueryCache) {
  let scheduled = false;
  cache.subscribe((event) => {
    if (event.type === "observerAdded" || event.type === "observerRemoved") noteQueryUse(event.query);
    if (event.type !== "added" && event.type !== "observerRemoved") return;
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      enforceCacheLimits(cache);
    });
  });
}
