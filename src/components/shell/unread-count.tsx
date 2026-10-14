"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { openRealtimeChannel } from "@/lib/realtime";
import { createClient } from "@/lib/supabase/client";

const POLL_MS = 60_000;

// Server-rendered count (re-sent whenever a server action refreshes the layout), kept fresh between
// refreshes by Realtime when available and by polling/focus otherwise.
export function useUnreadCount(initial: number, memberId: string, scope: string) {
  const [state, setState] = useState({ initial, count: initial });
  if (state.initial !== initial) setState({ initial, count: initial });

  const request = useRef(0);
  const refetch = useCallback(async () => {
    const ticket = ++request.current;
    // Same rows as countUnreadInbox: unread and still in the inbox. Counting archived
    // items made the badge jump when the server render landed.
    const supabase = createClient();
    const counted = await supabase.rpc("inbox_unread_count");
    if (ticket !== request.current) return;
    if (!counted.error && typeof counted.data === "number") {
      setState((current) => ({ ...current, count: counted.data ?? 0 }));
      return;
    }
    // A database without inbox_unread_count still counts through the table.
    if (counted.error && counted.error.code !== "PGRST202" && counted.error.code !== "42883") return;
    const { count, error } = await supabase
      .from("inbox_items")
      .select("id", { count: "exact", head: true })
      .is("read_at", null)
      .is("archived_at", null);
    if (!error && count !== null && ticket === request.current) setState((current) => ({ ...current, count }));
  }, []);

  useEffect(() => {
    let timer: number | undefined;
    let stopped = false;
    const refetchSoon = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!stopped) void refetch();
      }, 300);
    };
    const stopChannel = openRealtimeChannel(
      `inbox-count-${scope}-${memberId}`,
      [{ table: "inbox_items", filter: `recipient_id=eq.${memberId}` }],
      refetchSoon,
    );
    const interval = window.setInterval(refetchSoon, POLL_MS);
    const onFocus = () => {
      if (document.visibilityState === "visible") refetchSoon();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      stopChannel();
    };
  }, [memberId, scope, refetch]);

  return state.count;
}

export function UnreadBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span
      data-testid="inbox-badge"
      className="ml-auto min-w-5 rounded-full bg-accent-600 px-1.5 text-center text-2xs font-semibold leading-5 tabular-nums text-white"
    >
      {count > 99 ? "99+" : count}
      <span className="sr-only"> unread</span>
    </span>
  );
}
