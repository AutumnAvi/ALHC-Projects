"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const POLL_MS = 60_000;

// Server-rendered count (re-sent whenever a server action refreshes the layout), kept fresh between
// refreshes by Realtime when available and by polling/focus otherwise.
export function useUnreadCount(initial: number, memberId: string, scope: string) {
  const [state, setState] = useState({ initial, count: initial });
  if (state.initial !== initial) setState({ initial, count: initial });

  const refetch = useCallback(async () => {
    const { count, error } = await createClient()
      .from("inbox_items")
      .select("id", { count: "exact", head: true })
      .is("read_at", null);
    if (!error && count !== null) setState((current) => ({ ...current, count }));
  }, []);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`inbox-count-${scope}-${memberId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "inbox_items", filter: `recipient_id=eq.${memberId}` },
        () => void refetch(),
      )
      .subscribe();
    const interval = window.setInterval(() => void refetch(), POLL_MS);
    const onFocus = () => void refetch();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      void supabase.removeChannel(channel);
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
