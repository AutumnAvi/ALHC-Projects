// Nov 4 notes, batch 28 (M4): stale-while-revalidate for whole screens. Next's router keeps a screen's
// server render for ROUTER_CACHE_SECONDS (next.config.ts, staleTimes.dynamic), so going back to a screen
// you just saw draws it at once instead of a skeleton; a project link you rest the pointer on is rendered
// ahead of the click (staleTimes.static, HOVER_PREFETCH_SECONDS). Either way what's drawn may be a few
// seconds old, so the screen is then rendered again in the background (router.refresh: the server's copy
// replaces it without losing scroll or what's typed). Pure, so the rules are unit-tested.

// Keep in step with next.config.ts.
export const ROUTER_CACHE_SECONDS = 30;
export const HOVER_PREFETCH_SECONDS = 60;
// A hover prefetch this recent is fresh enough as it is.
export const FRESH_PREFETCH_MS = 10_000;
// Clocks and timers aren't exact: err on the side of asking again.
const SLACK_MS = 2_000;

// The router's key for a screen: the path and its query, without ?task= (opening a task moves the URL
// without a server render) and in a stable order.
export function routeKey(pathname: string, search: string | URLSearchParams | null | undefined): string {
  const params = new URLSearchParams(search ?? "");
  params.delete("task");
  params.sort();
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function routeKeyOfHref(href: string): string {
  const url = new URL(href, "http://x");
  return routeKey(url.pathname, url.search);
}

export type FreshnessState = {
  // When each screen was last drawn here (client clock).
  shownAt: Map<string, number>;
  // When each screen was prefetched on hover.
  prefetchedAt: Map<string, number>;
};

export function emptyFreshness(): FreshnessState {
  return { shownAt: new Map(), prefetchedAt: new Map() };
}

// Arriving at `key`: was what's drawn possibly a copy the router kept (so render it again)?
export function arrivalNeedsRevalidation(state: FreshnessState, key: string, now: number): boolean {
  const shown = state.shownAt.get(key);
  if (shown !== undefined && now - shown < ROUTER_CACHE_SECONDS * 1000 + SLACK_MS) return true;
  const prefetched = state.prefetchedAt.get(key);
  return (
    prefetched !== undefined && now - prefetched > FRESH_PREFETCH_MS && now - prefetched < HOVER_PREFETCH_SECONDS * 1000 + SLACK_MS
  );
}

const MAX_KEYS = 200;

function remember(map: Map<string, number>, key: string, now: number) {
  map.delete(key);
  map.set(key, now);
  if (map.size > MAX_KEYS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

export function noteShown(state: FreshnessState, key: string, now: number) {
  remember(state.shownAt, key, now);
  // The screen is drawn now: a prefetch of it was used (or replaced).
  state.prefetchedAt.delete(key);
}

// Returns false when it was prefetched too recently to ask again.
export function notePrefetch(state: FreshnessState, key: string, now: number): boolean {
  const last = state.prefetchedAt.get(key);
  if (last !== undefined && now - last < FRESH_PREFETCH_MS) return false;
  const shown = state.shownAt.get(key);
  // Drawn moments ago: the router still has it.
  if (shown !== undefined && now - shown < FRESH_PREFETCH_MS) return false;
  remember(state.prefetchedAt, key, now);
  return true;
}
