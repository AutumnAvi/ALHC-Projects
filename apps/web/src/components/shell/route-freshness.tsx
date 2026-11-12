"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type ComponentProps, type FocusEvent, type PointerEvent } from "react";
import { requestLiveRefresh, useLiveRefresher } from "@/lib/live";
import { onWriteWithoutRefresh } from "@/lib/patched-writes";
import {
  arrivalNeedsRevalidation,
  emptyFreshness,
  notePrefetch,
  noteRendered,
  noteShown,
  noteWriteWithoutRefresh,
  routeKey,
  routeKeyOfHref,
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
  useLiveRefresher();
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
      if (left === null || fetched || revisit) noteRendered(state, key, Date.now());
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
      if (notePrefetch(state, routeKeyOfHref(target), Date.now())) setActive(true);
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
