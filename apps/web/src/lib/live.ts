"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { isLiveTopic, parseLiveMessage, type LiveMessage, type LiveTable } from "@alhc/core/live-patch";
import {
  mutationInFlight,
  noteMutationTraffic,
  refreshingWriteInFlight,
  setMutationQuietHandler,
} from "@/lib/optimistic-session";
import { loadBrowserClient } from "@/lib/supabase/lazy-client";

// Nov 4 notes, batch 26 (M3): live updates through Realtime Broadcast on private topics, instead of
// Postgres Changes. The database sends a message per topic when rows change (alhc_live_capture); joining
// a topic is checked by the realtime.messages policies (alhc_live_topic_allowed), so only its readers hear
// anything. One channel per topic per page, shared by every listener on it (supabase-js hands back the
// same channel for a topic, so two independent channels on one topic can't exist anyway).
//
// Nov 4 notes (batch 21, QW4), kept: a channel joins only once the signed-in token is on the socket, and
// never without a session.

export type ChannelStatus = "live" | "down" | "off";
export type LiveListener = {
  message?: (message: LiveMessage) => void;
  // rejoined: it was live before and lost the connection (messages may have been missed meanwhile).
  status?: (status: ChannelStatus, rejoined: boolean) => void;
};

const RECONNECT_BASE_MS = 800;
const RECONNECT_MAX_MS = 15_000;
const MAX_ERRORS = 6;
// A topic whose last listener left stays open this long, so a re-render or a quick tab switch doesn't
// leave and rejoin.
const LINGER_MS = 1500;

type TopicState = {
  listeners: Set<LiveListener>;
  status: ChannelStatus | null;
  wasLive: boolean;
  stop: () => void;
  lingerTimer?: number;
};

const topics = new Map<string, TopicState>();
// Channels still leaving, per topic: a new join on the same topic waits for them.
const leaving = new Map<string, Promise<unknown>>();

type BrowserClient = Awaited<ReturnType<typeof loadBrowserClient>>;

function openTopic(topic: string, state: TopicState): () => void {
  // Batch 40 (item 7): the client arrives a moment after the first paint (lazy-client.ts).
  let supabase: BrowserClient | null = null;
  let stopped = false;
  let attempt = 0;
  let reconnectTimer: number | undefined;
  let active: ReturnType<BrowserClient["channel"]> | null = null;

  const emitStatus = (status: ChannelStatus) => {
    const rejoined = status === "live" && state.wasLive && state.status !== "live";
    if (status === "live") state.wasLive = true;
    state.status = status;
    for (const listener of state.listeners) listener.status?.(status, rejoined);
  };

  const release = () => {
    if (!active || !supabase) return;
    const previous = active;
    active = null;
    const done = supabase.removeChannel(previous).catch(() => undefined);
    leaving.set(topic, done);
    void done.then(() => {
      if (leaving.get(topic) === done) leaving.delete(topic);
    });
  };

  const authorize = async (client: BrowserClient): Promise<boolean> => {
    const { data } = await client.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return false;
    if (client.realtime.accessTokenValue !== token) await client.realtime.setAuth();
    return client.realtime.accessTokenValue === token;
  };

  const connect = async () => {
    if (stopped) return;
    release();
    await leaving.get(topic);
    const client = supabase ?? (await loadBrowserClient().catch(() => null));
    if (stopped) return;
    if (!client) {
      stopped = true;
      emitStatus("off");
      return;
    }
    supabase = client;
    const authorized = await authorize(client).catch(() => false);
    if (stopped) return;
    if (!authorized) {
      stopped = true;
      emitStatus("off");
      return;
    }
    const channel = client.channel(topic, { config: { private: true } });
    channel.on("broadcast", { event: "*" }, (event: { payload?: unknown }) => {
      if (stopped) return;
      const message = parseLiveMessage(event.payload);
      if (!message) return;
      for (const listener of state.listeners) listener.message?.(message);
    });
    active = channel;
    channel.subscribe((status) => {
      if (stopped || active !== channel) return;
      if (status === "SUBSCRIBED") {
        attempt = 0;
        emitStatus("live");
        return;
      }
      if (status === "CLOSED") {
        emitStatus("down");
        return;
      }
      if (status !== "CHANNEL_ERROR" && status !== "TIMED_OUT") return;
      window.clearTimeout(reconnectTimer);
      if (attempt >= MAX_ERRORS) {
        stopped = true;
        release();
        emitStatus("off");
        return;
      }
      emitStatus("down");
      const wait = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
      attempt += 1;
      reconnectTimer = window.setTimeout(() => {
        if (!stopped) void connect();
      }, wait);
    });
  };

  void connect();
  return () => {
    stopped = true;
    window.clearTimeout(reconnectTimer);
    release();
  };
}

// Whether a topic's channel is joined right now (batch 40: a save skips its refresh only then).
export function topicIsLive(topic: string): boolean {
  return topics.get(topic)?.status === "live";
}

// Listen to one topic. Returns the unsubscribe. A topic that isn't one of ours is ignored.
export function subscribeLive(topic: string, listener: LiveListener): () => void {
  if (typeof window === "undefined" || !isLiveTopic(topic)) return () => {};
  let state = topics.get(topic);
  if (!state) {
    const fresh: TopicState = { listeners: new Set(), status: null, wasLive: false, stop: () => {} };
    topics.set(topic, fresh);
    fresh.stop = openTopic(topic, fresh);
    state = fresh;
  }
  const current = state;
  window.clearTimeout(current.lingerTimer);
  current.listeners.add(listener);
  if (current.status) listener.status?.(current.status, false);
  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size > 0) return;
    window.clearTimeout(current.lingerTimer);
    current.lingerTimer = window.setTimeout(() => {
      if (current.listeners.size > 0 || topics.get(topic) !== current) return;
      topics.delete(topic);
      current.stop();
    }, LINGER_MS);
  };
}

// The latest callbacks without resubscribing on every render.
export function useLiveTopic(
  topic: string | null,
  onMessage: (message: LiveMessage) => void,
  onStatus?: (status: ChannelStatus, rejoined: boolean) => void,
) {
  const messageRef = useRef(onMessage);
  const statusRef = useRef(onStatus);
  useEffect(() => {
    messageRef.current = onMessage;
    statusRef.current = onStatus;
  });
  useEffect(() => {
    if (!topic) return;
    return subscribeLive(topic, {
      message: (message) => messageRef.current(message),
      status: (status, rejoined) => statusRef.current?.(status, rejoined),
    });
  }, [topic]);
}

// ---------------------------------------------------------------------------------------------------
// Page refreshes, for what a patch can't build (a new task in a List, a new notification). One
// router.refresh for the whole page: bursts collapse, and a refresh started by the person's own write is
// not doubled.

const REFRESH_MS = 400;
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

function scheduleDeferred() {
  if (noteMutationTraffic()) return;
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(runRefresh, REFRESH_MS);
}

if (typeof window !== "undefined") setMutationQuietHandler(scheduleDeferred);

// "defer" (default): a change heard while the person's own write is saving refreshes once it's done.
// "skip": the write's own refresh covers it (busy pages such as a project's List).
export type RefreshMode = "defer" | "skip";

export function requestLiveRefresh(mode: RefreshMode = "defer") {
  if (typeof window === "undefined") return;
  if (mode === "skip") {
    // The open write's own refresh covers it. A write saved without a refresh (batch 40) doesn't bring
    // one: refresh once it's done instead.
    if (refreshingWriteInFlight()) return;
    if (mutationInFlight()) {
      scheduleDeferred();
      return;
    }
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(runRefresh, REFRESH_MS);
    return;
  }
  scheduleDeferred();
}

// Lets requestLiveRefresh re-render the current route while this component is mounted.
export function useLiveRefresher() {
  const router = useRouter();
  const refreshRef = useRef(router.refresh);
  useEffect(() => {
    refreshRef.current = router.refresh;
  }, [router]);
  useEffect(() => {
    const refresh = () => refreshRef.current();
    refreshers.add(refresh);
    return () => {
      refreshers.delete(refresh);
    };
  }, []);
}

// Re-render the route when one of these tables changes on the topic (low-traffic screens: Messages, the
// approval review page).
export function useLiveRefresh(topic: string | null, tables: readonly LiveTable[], mode: RefreshMode = "defer") {
  useLiveRefresher();
  const key = tables.join(",");
  useLiveTopic(topic, (message) => {
    if (key.split(",").includes(message.table)) requestLiveRefresh(mode);
  });
}
