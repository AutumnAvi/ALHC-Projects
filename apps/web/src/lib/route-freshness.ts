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
  // Nov 12 notes (batch 40, item 1): when the person's last save without a refresh finished. Those keep
  // the router's cache, so a screen prefetched before one is drawn and then rendered again too.
  lastWriteAt: number;
  // When each screen's server copy was last rendered here (a fetch, or a background render on arrival).
  renderedAt: Map<string, number>;
  // Nov 16 batch 42 (item 1): the copies the router may still hold, with how long it keeps each: a screen
  // fetched on arrival or rendered again in the background (ROUTER_CACHE_SECONDS), or rendered ahead
  // (HOVER_PREFETCH_SECONDS). Used to tell whether a fresh prefetch would be taken or skipped by the router.
  copies: Map<string, { at: number; keepMs: number }>;
};

export function emptyFreshness(): FreshnessState {
  return { shownAt: new Map(), prefetchedAt: new Map(), lastWriteAt: 0, renderedAt: new Map(), copies: new Map() };
}

// Home: the screen kept ready after a save (batch 42, item 1).
export const HOME_KEY = "/";

export function noteCopy(state: FreshnessState, key: string, now: number, keepSeconds: number) {
  state.copies.delete(key);
  state.copies.set(key, { at: now, keepMs: keepSeconds * 1000 });
  if (state.copies.size > MAX_KEYS) {
    const oldest = state.copies.keys().next().value;
    if (oldest !== undefined) state.copies.delete(oldest);
  }
}

// Whether the router may still hold a copy of `key` (so a prefetch of it would be skipped). Errs on "yes".
export function mayHoldCopy(state: FreshnessState, key: string, now: number): boolean {
  const copy = state.copies.get(key);
  return copy !== undefined && now - copy.at < copy.keepMs + SLACK_MS;
}

// At most this many other recently shown screens are rendered again after the router's cache is emptied.
export const MAX_RECENT_REWARMED = 2;

export type WarmPlan = {
  // Empty the router's cache first (router.refresh): it may hold a copy of Home from before the save, and
  // the router would draw that one instead of taking a new prefetch.
  bump: boolean;
  // Render these ahead (full prefetch), Home first.
  prefetch: string[];
};

// After a save Home shows (a completion, a name, an assignee) settles on another screen (`current`): get
// a copy of Home rendered after it, so going there next draws at once and shows the save. When the router
// may still hold an older copy of Home, the cache is emptied first; the other screens the person was on in
// the last ROUTER_CACHE_SECONDS (which that empties too) are rendered again with it, up to
// MAX_RECENT_REWARMED — chosen by when they were shown, never by when they were last rendered ahead, so
// rendering a screen again never keeps it "recent".
// On Home itself there's nothing to warm (Home shows its saves itself, or its save refreshed it).
export function homeWarmPlan(state: FreshnessState, current: string, now: number): WarmPlan {
  if (current === HOME_KEY) return { bump: false, prefetch: [] };
  const bump = mayHoldCopy(state, HOME_KEY, now);
  const recent = bump
    ? [...state.shownAt.entries()]
        .filter(([key, at]) => key !== current && key !== HOME_KEY && now - at < ROUTER_CACHE_SECONDS * 1000)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_RECENT_REWARMED)
        .map(([key]) => key)
    : [];
  return { bump, prefetch: [HOME_KEY, ...recent] };
}

// Emptying the router's cache costs a render of the screen on view too: at most once in this long. A save
// in between waits for the next turn (or for the person to head for Home, see warmOnIntent).
export const MIN_BUMP_GAP_MS = 10_000;

// When a warm-up that has to empty the cache may run (now, or later at this time).
export function bumpAllowedAt(lastBumpAt: number): number {
  return lastBumpAt + MIN_BUMP_GAP_MS;
}

// The person heads for Home (pointer on the link, focus, click) while a warm-up waits. Emptying the cache
// then would throw away the copy of Home the click is about to draw, so it doesn't run: Home is drawn from
// that copy at once (with the person's own edits held on it, task-edits.ts) and rendered again in the
// background on arrival. Without an older copy to keep, the warm-up runs now.
export function warmOnIntent(plan: WarmPlan): WarmPlan | null {
  return plan.bump ? null : plan;
}

// What the router holds once a plan ran: emptied (bump) except the screen on view (rendered again by the
// refresh), plus the new prefetches.
export function applyWarmPlan(state: FreshnessState, plan: WarmPlan, current: string, now: number) {
  if (plan.bump) {
    state.copies.clear();
    noteCopy(state, current, now, ROUTER_CACHE_SECONDS);
    noteRendered(state, current, now);
  }
  for (const key of plan.prefetch) {
    noteCopy(state, key, now, HOVER_PREFETCH_SECONDS);
    remember(state.prefetchedAt, key, now);
  }
}

// A save that started before the person reached Home and ended after: the copy of Home they're looking at
// may not show it (the save skipped its refresh), so Home is rendered again.
export function homeNeedsRenderAfterSave(state: FreshnessState, current: string, saveStartedAt: number): boolean {
  if (current !== HOME_KEY) return false;
  const arrived = state.shownAt.get(HOME_KEY);
  return arrived !== undefined && arrived >= saveStartedAt;
}

export function noteRendered(state: FreshnessState, key: string, now: number) {
  remember(state.renderedAt, key, now);
}

export function noteWriteWithoutRefresh(state: FreshnessState, at: number) {
  state.lastWriteAt = Math.max(state.lastWriteAt, at);
}

// Arriving at `key`: was what's drawn possibly a copy the router kept (so render it again)?
export function arrivalNeedsRevalidation(state: FreshnessState, key: string, now: number): boolean {
  const shown = state.shownAt.get(key);
  if (shown !== undefined && now - shown < ROUTER_CACHE_SECONDS * 1000 + SLACK_MS) return true;
  // Back / Forward draws the router's copy however old it is; one rendered before a save that kept the
  // cache (batch 40) may not show it.
  const rendered = state.renderedAt.get(key);
  if (rendered !== undefined && state.lastWriteAt > 0 && state.lastWriteAt >= rendered) return true;
  const prefetched = state.prefetchedAt.get(key);
  if (prefetched === undefined || now - prefetched >= HOVER_PREFETCH_SECONDS * 1000 + SLACK_MS) return false;
  return now - prefetched > FRESH_PREFETCH_MS || (state.lastWriteAt > 0 && state.lastWriteAt >= prefetched);
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
