"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

type Subscription = { table: string; filter?: string };

// Re-renders the current route when matching rows change. Realtime respects RLS; if the Realtime
// service is unavailable the page simply keeps its server-rendered data.
export function useRealtimeRefresh(channel: string, subscriptions: Subscription[]) {
  const router = useRouter();
  const key = JSON.stringify(subscriptions);

  useEffect(() => {
    const supabase = createClient();
    let timer: number | undefined;
    const refresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => router.refresh(), 250);
    };
    let realtime = supabase.channel(channel);
    for (const { table, filter } of JSON.parse(key) as Subscription[]) {
      realtime = realtime.on(
        "postgres_changes",
        { event: "*", schema: "public", table, ...(filter ? { filter } : {}) },
        refresh,
      );
    }
    realtime.subscribe();
    return () => {
      window.clearTimeout(timer);
      void supabase.removeChannel(realtime);
    };
  }, [channel, key, router]);
}
