"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeLive } from "@/lib/live";
import { userTopic } from "@alhc/core/live-patch";
import { countUnreadInboxRows, unreadInboxCount } from "@alhc/core/api/client/inbox";
import { createApiContext } from "@alhc/core/api/core/context";
import { createClient } from "@/lib/supabase/client";

const POLL_MS = 60_000;

// Server-rendered count (re-sent whenever a server action refreshes the layout), kept fresh between
// refreshes by Broadcast when it's live, and by polling / focus only while it isn't.
export function useUnreadCount(initial: number, memberId: string, scope: string) {
  const [state, setState] = useState({ initial, count: initial });
  if (state.initial !== initial) setState({ initial, count: initial });

  const request = useRef(0);
  const refetch = useCallback(async () => {
    const ticket = ++request.current;
    // Same rows as countUnreadInbox: unread and still in the inbox. Counting archived
    // items made the badge jump when the server render landed.
    const ctx = createApiContext(createClient());
    const counted = await unreadInboxCount(ctx);
    if (ticket !== request.current) return;
    if (typeof counted === "number") {
      setState((current) => ({ ...current, count: counted }));
      return;
    }
    // A database without inbox_unread_count still counts through the table.
    if (counted === null) return;
    const count = await countUnreadInboxRows(ctx);
    if (count !== null && ticket === request.current) setState((current) => ({ ...current, count }));
  }, []);

  // Nov 4 notes (batch 21, QW4): one mechanism at a time. While the live channel is up it alone
  // keeps the count fresh (plus one recount each time it (re)joins, for anything missed while it was
  // down); only while it's down or unavailable does the count poll every minute and recount on focus.
  useEffect(() => {
    let timer: number | undefined;
    let interval: number | undefined;
    let stopped = false;
    const refetchSoon = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!stopped) void refetch();
      }, 300);
    };
    const onFocus = () => {
      if (document.visibilityState === "visible") refetchSoon();
    };
    const startPolling = () => {
      if (interval !== undefined) return;
      interval = window.setInterval(refetchSoon, POLL_MS);
      window.addEventListener("focus", onFocus);
    };
    const stopPolling = () => {
      if (interval === undefined) return;
      window.clearInterval(interval);
      interval = undefined;
      window.removeEventListener("focus", onFocus);
    };
    // Until the channel says it's live (a second or so), poll as the fallback.
    startPolling();
    // Nov 4 notes, batch 26 (M3): the person's Broadcast topic says when one of their items is added or
    // read / archived elsewhere; the count is then asked again (one cheap count, never the page).
    const stopChannel = subscribeLive(userTopic(memberId), {
      message: (message) => {
        if (!stopped && message.table === "inbox_items") refetchSoon();
      },
      status: (status) => {
        if (stopped) return;
        if (status === "live") {
          stopPolling();
          refetchSoon();
        } else {
          startPolling();
        }
      },
    });
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stopPolling();
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
