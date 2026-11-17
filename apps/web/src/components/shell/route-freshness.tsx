"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types";
import { useEffect, useRef, useState, type ComponentProps, type FocusEvent, type PointerEvent } from "react";
import { requestLiveRefresh, useLiveRefresher } from "@/lib/live";
import { onHomeWrite, onWriteWithoutRefresh } from "@/lib/patched-writes";
import {
  applyWarmPlan,
  arrivalNeedsRevalidation,
  emptyFreshness,
  HOME_KEY,
  HOVER_PREFETCH_SECONDS,
  homeNeedsRenderAfterSave,
  homeWarmPlan,
  noteCopy,
  notePrefetch,
  noteRendered,
  noteSaveRefreshed,
  noteShown,
  noteWriteWithoutRefresh,
  ROUTER_CACHE_SECONDS,
  routeKey,
  routeKeyOfHref,
  bumpAllowedAt,
  warmOnIntent,
  type WarmPlan,
} from "@/lib/route-freshness";

// Nov 4 notes, batch 28 (M4): stale-while-revalidate for whole screens (src/lib/route-freshness.ts). Going
// back to a screen within ROUTER_CACHE_SECONDS draws the router's copy at once; this renders it again in
// the background so it doesn't stay a few seconds old. Mounted once in the app shell.

const state = emptyFreshness();
// Batch 40 (item 1): saves that kept the router's cache mark everything drawn from it before them.
if (typeof window !== "undefined") onWriteWithoutRefresh((at) => noteWriteWithoutRefresh(state, at));
// Loading skeletons drawn since the last arrival: one means the router fetched the screen (a fresh render
// is on its way), so there's nothing to revalidate. (A background refresh empties the router's whole
// cache, so the next screen may be fetched even though it was shown seconds ago.)
let skeletons = 0;
let counted = 0;

// Nov 16 batch 42 (item 1): a full prefetch (the screen's data too, kept HOVER_PREFETCH_SECONDS), what
// <Link prefetch={true}> asks for. router.prefetch's public type takes the router's enum; its value is "full".
export const FULL_PREFETCH = "full" as PrefetchKind;
function prefetchFull(router: AppRouterInstance, href: string) {
  router.prefetch(href, { kind: FULL_PREFETCH });
}

// After a save Home shows, how long to wait for more (ticking several tasks quickly renders Home once; a
// save that starts meanwhile puts it off again). Short, so the copy is usually ready before the click.
export const HOME_WARM_DELAY_MS = 250;
// A warm-up that must empty the router's cache throws away the copy of Home a quick click would draw at
// once, so it waits for the person to settle (and runs at most every MIN_BUMP_GAP_MS, route-freshness.ts).
export const HOME_WARM_BUMP_DELAY_MS = 2000;
let warmTimer: number | undefined;
let runWarm: (() => void) | null = null;

// The sidebar's Home link (pointer on it, focus, click): a warm-up still waiting runs now, unless it would
// throw away the copy of Home the click is about to draw (warmOnIntent).
export function flushHomeWarm() {
  if (warmTimer === undefined || !runWarm) return;
  runWarm();
}

// Rendered by every loading skeleton (LoadingRegion).
export function SkeletonShown() {
  useEffect(() => {
    skeletons += 1;
  }, []);
  return null;
}

export function RouteFreshness() {
  const pathname = usePathname();
  const search = useSearchParams();
  const key = routeKey(pathname ?? "", search?.toString());
  const previous = useRef<string | null>(null);
  const router = useRouter();
  const current = useRef(key);
  useEffect(() => {
    current.current = key;
  }, [key]);
  useLiveRefresher();
  // Batch 42 (item 1): a save Home shows that settled here — a completion, a name, an assignee — gets a
  // copy of Home rendered after it (route-freshness.ts, homeWarmPlan), so "tick, then Home" draws Home at
  // once with the task done. Before, the router's copy of Home was dropped 30 seconds after it was
  // fetched, so coming back later always waited for a full render behind a skeleton.
  useEffect(() => {
    let inFlight = 0;
    let burstStartedAt = 0;
    let burstEndedAt = 0;
    let anyOk = false;
    let refreshedInBurst = false;
    let lastBumpAt = -Infinity;
    const warm = (intent: boolean) => {
      if (!intent) warmTimer = undefined;
      if (!anyOk) return;
      const now = Date.now();
      const here = current.current;
      if (here === HOME_KEY) {
        anyOk = false;
        // Reached Home while the save was still going: render it again so it shows the save.
        if (homeNeedsRenderAfterSave(state, here, burstStartedAt, burstEndedAt)) requestLiveRefresh();
        return;
      }
      let plan: WarmPlan | null = homeWarmPlan(state, here, now);
      if (intent) {
        plan = warmOnIntent(plan);
        // Not now (it would throw away the copy the click draws), but not cancelled either: the timer stays,
        // so a pointer passing over the link changes nothing (Opus r2 F7).
        if (!plan) return;
        window.clearTimeout(warmTimer);
        warmTimer = undefined;
      } else if (plan.bump && !refreshedInBurst && now < bumpAllowedAt(lastBumpAt)) {
        // (A save that refreshed keeps its edits only EDIT_GRACE_MS, so it doesn't wait for the gap: the held
        // copy of Home is replaced before its edit lapses. It refreshed this screen already anyway.)
        // Emptied the cache moments ago: once more when the gap is up (or on the way to Home).
        warmTimer = window.setTimeout(() => warm(false), bumpAllowedAt(lastBumpAt) - now);
        return;
      }
      anyOk = false;
      refreshedInBurst = false;
      if (!plan) return;
      if (plan.bump) {
        router.refresh();
        lastBumpAt = now;
      }
      for (const href of plan.prefetch) prefetchFull(router, href);
      applyWarmPlan(state, plan, here, now);
    };
    runWarm = () => warm(true);
    const stop = onHomeWrite((event) => {
      if (event.phase === "start") {
        if (inFlight === 0 && warmTimer === undefined) burstStartedAt = Date.now();
        inFlight += 1;
        window.clearTimeout(warmTimer);
        warmTimer = undefined;
        return;
      }
      inFlight = Math.max(0, inFlight - 1);
      burstEndedAt = event.at;
      if (event.ok) {
        anyOk = true;
        // Every copy drawn from the router's cache after this is rendered again on arrival. A save's own
        // refresh (next/cache refresh()) drops what was fetched on arrival but leaves rendered-ahead copies,
        // Home's included, in place (noteSaveRefreshed).
        noteWriteWithoutRefresh(state, event.at);
        if (!event.screenOnly) {
          refreshedInBurst = true;
          noteSaveRefreshed(state, current.current, event.at);
        }
      }
      if (inFlight === 0) {
        const bump = homeWarmPlan(state, current.current, Date.now()).bump;
        warmTimer = window.setTimeout(() => warm(false), bump ? HOME_WARM_BUMP_DELAY_MS : HOME_WARM_DELAY_MS);
      }
    });
    return () => {
      stop();
      runWarm = null;
    };
  }, [router]);
  useEffect(() => {
    const now = Date.now();
    const left = previous.current;
    previous.current = key;
    if (left === key) return;
    // The screen we left may stay in the router's cache until about now: remember when it was last current.
    if (left !== null) noteShown(state, left, now);
    const revisit = left !== null && arrivalNeedsRevalidation(state, key, now);
    noteShown(state, key, now);
    // Decide once this commit's effects have all run (a skeleton mounted with this URL counts).
    const timer = window.setTimeout(() => {
      const fetched = skeletons > counted || document.querySelector(".skeleton") !== null;
      counted = skeletons;
      // The first screen of the visit, a fetch, or a background render: its server copy is fresh now.
      if (left === null || fetched || revisit) {
        noteRendered(state, key, Date.now());
        noteCopy(state, key, Date.now(), ROUTER_CACHE_SECONDS);
      }
      if (revisit && !fetched) requestLiveRefresh();
    }, 50);
    return () => window.clearTimeout(timer);
  }, [key]);
  return null;
}

// How long the pointer rests on a link before its screen is rendered ahead (a pass over the sidebar
// renders nothing).
const HOVER_DELAY_MS = 120;

// A Link whose whole screen (data included) is rendered ahead when the pointer rests on it or it's focused
// (prefetch={true} from then on: Next's documented hover pattern), so the click draws it at once. Used for
// project links (sidebar, Home, Browse, a project's tabs). Prefetching runs in production builds only.
export function PrefetchLink({ href, onPointerEnter, onPointerLeave, onFocus, prefetch, ...rest }: ComponentProps<typeof Link>) {
  const [active, setActive] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const target = typeof href === "string" ? href : null;
  const start = (delay: number) => {
    if (!target) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const now = Date.now();
      const routeKeyOfTarget = routeKeyOfHref(target);
      if (notePrefetch(state, routeKeyOfTarget, now)) {
        noteCopy(state, routeKeyOfTarget, now, HOVER_PREFETCH_SECONDS);
        setActive(true);
      }
    }, delay);
  };
  return (
    <Link
      {...rest}
      href={href}
      prefetch={active ? true : prefetch}
      onPointerEnter={(e: PointerEvent<HTMLAnchorElement>) => {
        onPointerEnter?.(e);
        if (e.pointerType !== "touch") start(HOVER_DELAY_MS);
      }}
      onPointerLeave={(e: PointerEvent<HTMLAnchorElement>) => {
        onPointerLeave?.(e);
        window.clearTimeout(timer.current);
      }}
      onFocus={(e: FocusEvent<HTMLAnchorElement>) => {
        onFocus?.(e);
        start(0);
      }}
    />
  );
}
