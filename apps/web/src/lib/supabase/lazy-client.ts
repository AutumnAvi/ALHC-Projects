"use client";

// Nov 12 notes (batch 40, item 7): the browser's Supabase client (about 216 KB before compression) is
// loaded just after the first paint — by live updates, the unread badge's recount — instead of with
// every signed-in page's first download. The same client (createBrowserClient keeps one per tab).
import type { createClient } from "./client";

type BrowserClient = ReturnType<typeof createClient>;

let loading: Promise<BrowserClient> | null = null;

export function loadBrowserClient(): Promise<BrowserClient> {
  loading ??= import("./client").then((module) => module.createClient());
  // A failed download (offline) can be tried again.
  loading.catch(() => {
    loading = null;
  });
  return loading;
}
