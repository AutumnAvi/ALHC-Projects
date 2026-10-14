"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import {
  noteMutationTraffic,
  setMutationQuietHandler,
} from "@/lib/optimistic-session";
import { createClient } from "@/lib/supabase/client";

type Subscription = { table: string; filter?: string };

const REFRESH_MS = 400;
const RECONNECT_BASE_MS = 800;
const RECONNECT_MAX_MS = 15_000;

// One router.refresh for every channel on the page. Bursts (a comment, its story, its email)
// collapse into a single refresh, and a refresh started by our own write is not doubled.
const refreshers = new Set<() => void>();
let refreshTimer: number | undefined;
let waitingForVisible = false;

function runRefresh() {
  refreshTimer = undefined;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    if (!waitingForVisible) {
      waitingForVisible = true;
      document.addEventListener(
        "visibilitychange",
        () => {
          waitingForVisible = false;
          if (document.visibilityState === "visible") runRefresh();
        },
        { once: true },
      );
    }
    return;
  }
  const refresh = refreshers.values().next().value;
  refresh?.();
}

function scheduleRefresh() {
  if (noteMutationTraffic()) return;
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(runRefresh, REFRESH_MS);
}

setMutationQuietHandler(scheduleRefresh);

function usable(subscriptions: Subscription[]): { table: string; filter: string }[] {
  return subscriptions.flatMap((subscription) => {
    const filter = subscription.filter?.trim() ?? "";
    // A missing filter would stream the whole table. Every caller names one row scope.
    if (!filter.includes("=eq.")) return [];
    return [{ table: subscription.table, filter }];
  });
}

// One channel per mount. A new topic each attempt so a slow removeChannel can't hand back
// the channel that is closing. Errors back off; CLOSED is the socket's own reconnect.
export function openRealtimeChannel(
  name: string,
  subscriptions: Subscription[],
  onChange: () => void,
): () => void {
  const subs = usable(subscriptions);
  if (subs.length === 0) return () => {};

  const supabase = createClient();
  let stopped = false;
  let generation = 0;
  let attempt = 0;
  let reconnectTimer: number | undefined;
  let active: ReturnType<typeof supabase.channel> | null = null;

  const connect = () => {
    if (stopped) return;
    const gen = ++generation;
    if (active) {
      const previous = active;
      active = null;
      void supabase.removeChannel(previous);
    }
    let channel = supabase.channel(`${name}:${gen}`);
    for (const { table, filter } of subs) {
      channel = channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table, filter },
        () => {
          if (!stopped && gen === generation) onChange();
        },
      );
    }
    active = channel;
    channel.subscribe((status) => {
      if (stopped || gen !== generation) return;
      if (status === "SUBSCRIBED") {
        attempt = 0;
        return;
      }
      if (status !== "CHANNEL_ERROR" && status !== "TIMED_OUT") return;
      window.clearTimeout(reconnectTimer);
      const wait = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
      attempt += 1;
      reconnectTimer = window.setTimeout(() => {
        if (!stopped && gen === generation) connect();
      }, wait);
    });
  };

  connect();
  return () => {
    stopped = true;
    generation += 1;
    window.clearTimeout(reconnectTimer);
    if (active) void supabase.removeChannel(active);
    active = null;
  };
}

// Re-renders the current route when matching rows change. Realtime respects RLS; if the Realtime
// service is unavailable the page simply keeps its server-rendered data.
export function useRealtimeRefresh(channel: string, subscriptions: Subscription[]) {
  const router = useRouter();
  const refreshRef = useRef(router.refresh);
  const key = JSON.stringify(subscriptions);

  useEffect(() => {
    refreshRef.current = router.refresh;
  }, [router]);

  useEffect(() => {
    const refresh = () => refreshRef.current();
    refreshers.add(refresh);
    const stop = openRealtimeChannel(channel, JSON.parse(key) as Subscription[], scheduleRefresh);
    return () => {
      stop();
      refreshers.delete(refresh);
    };
    // router.refresh identity changes after every refresh; subscribing to it reconnects in a loop.
  }, [channel, key]);
}
