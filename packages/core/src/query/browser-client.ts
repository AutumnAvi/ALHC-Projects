import { isServer, type QueryClient } from "@tanstack/query-core";
import { createAlhcQueryClient } from "./client";

// Nov 4 notes, batch 28 (M4): one client data cache per browser tab and signed-in person. Stores call this
// from event handlers (hover, a live message, a write ending); the React provider passes the person, and a
// different person (another account in the same tab without a full reload) gets an empty cache, so nobody
// ever sees someone else's cached data. On the server every call is a new, throwaway client: a cache is
// never shared between requests.

let client: QueryClient | null = null;
let owner: string | null = null;

export function getQueryClient(memberId?: string): QueryClient {
  if (isServer) return createAlhcQueryClient();
  if (client && memberId !== undefined && owner !== null && owner !== memberId) {
    client.clear();
    client = null;
  }
  if (!client) client = createAlhcQueryClient();
  if (memberId !== undefined) owner = memberId;
  return client;
}
