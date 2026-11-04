"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import {
  mutationInFlight,
  noteMutationTraffic,
  setMutationQuietHandler,
} from "@/lib/optimistic-session";
import { createClient } from "@/lib/supabase/client";

type Subscription = { table: string; filter?: string };

// Nov 3 notes (batch 19): a channel on a table the hosted database may not publish yet (tasks and
// task_projects join supabase_realtime in this batch's migration) gives up after a few errors instead of
// retrying forever; the page keeps its server-rendered data.
// Nov 4 notes (batch 21, QW4): onStatus says whether the channel is live ("live" once subscribed, again
// after every rejoin; "down" while it reconnects; "off" when it gave up or there is no session), so a
// caller can fall back to polling only while it isn't.
export type ChannelStatus = "live" | "down" | "off";
export type ChannelOptions = { maxErrors?: number; onStatus?: (status: ChannelStatus) => void };

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
  options: ChannelOptions = {},
): () => void {
  const subs = usable(subscriptions);
  if (subs.length === 0) return () => {};

  const supabase = createClient();
  let stopped = false;
  let generation = 0;
  let attempt = 0;
  let reconnectTimer: number | undefined;
  let active: ReturnType<typeof supabase.channel> | null = null;

  // Nov 4 notes (batch 21, QW4): a channel joins with whatever token the Realtime socket holds at that
  // moment. The browser client reads the session asynchronously after it's created, so a channel opened on
  // a page's first render (the inbox badge, automation feedback) used to join with only the anon key: the
  // server then checks the filter column as role anon, which holds no privilege on any ALHC table
  // (Review hardening), and refuses with "invalid column for filter". Every join now waits for the
  // signed-in token first, and nothing joins without a session.
  const authorize = async (): Promise<boolean> => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return false;
    if (supabase.realtime.accessTokenValue !== token) await supabase.realtime.setAuth();
    return supabase.realtime.accessTokenValue === token;
  };

  const connect = async () => {
    if (stopped) return;
    const gen = ++generation;
    if (active) {
      const previous = active;
      active = null;
      void supabase.removeChannel(previous);
    }
    const authorized = await authorize().catch(() => false);
    if (stopped || gen !== generation) return;
    if (!authorized) {
      stopped = true;
      options.onStatus?.("off");
      return;
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
        options.onStatus?.("live");
        return;
      }
      if (status === "CLOSED") {
        options.onStatus?.("down");
        return;
      }
      if (status !== "CHANNEL_ERROR" && status !== "TIMED_OUT") return;
      window.clearTimeout(reconnectTimer);
      if (options.maxErrors !== undefined && attempt >= options.maxErrors) {
        stopped = true;
        if (active) void supabase.removeChannel(active);
        active = null;
        options.onStatus?.("off");
        return;
      }
      options.onStatus?.("down");
      const wait = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
      attempt += 1;
      reconnectTimer = window.setTimeout(() => {
        if (!stopped && gen === generation) void connect();
      }, wait);
    });
  };

  void connect();
  return () => {
    stopped = true;
    generation += 1;
    window.clearTimeout(reconnectTimer);
    if (active) void supabase.removeChannel(active);
    active = null;
  };
}

// Changes heard while the person's own write is saving: "defer" refreshes once it's done (the default:
// someone else's change may have landed meanwhile); "skip" lets the write's own refresh cover them (busy
// pages, e.g. a project's List, where every edit would otherwise render twice).
export type RefreshOptions = ChannelOptions & { duringWrites?: "defer" | "skip" };

function scheduleRefreshSkippingWrites() {
  if (mutationInFlight()) return;
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(runRefresh, REFRESH_MS);
}

// Re-renders the current route when matching rows change. Realtime respects RLS; if the Realtime
// service is unavailable the page simply keeps its server-rendered data.
export function useRealtimeRefresh(channel: string, subscriptions: Subscription[], options: RefreshOptions = {}) {
  const router = useRouter();
  const refreshRef = useRef(router.refresh);
  const key = JSON.stringify(subscriptions);
  const skip = options.duringWrites === "skip";
  const maxErrors = options.maxErrors;

  useEffect(() => {
    refreshRef.current = router.refresh;
  }, [router]);

  useEffect(() => {
    const refresh = () => refreshRef.current();
    refreshers.add(refresh);
    const stop = openRealtimeChannel(
      channel,
      JSON.parse(key) as Subscription[],
      skip ? scheduleRefreshSkippingWrites : scheduleRefresh,
      maxErrors === undefined ? {} : { maxErrors },
    );
    return () => {
      stop();
      refreshers.delete(refresh);
    };
    // router.refresh identity changes after every refresh; subscribing to it reconnects in a loop.
  }, [channel, key, skip, maxErrors]);
}
