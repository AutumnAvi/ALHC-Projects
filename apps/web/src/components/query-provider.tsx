"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { createAlhcQueryClient } from "@alhc/core/query/client";
import { getQueryClient } from "@alhc/core/query/browser-client";

// Nov 4 notes, batch 28 (M4): the client data cache for the signed-in app (@alhc/core/query/; the React
// hook is src/lib/query/use-cache-entry.ts). In the browser it's the tab's one cache for this person;
// during the server render, an empty one per render.
export function QueryProvider({ memberId, children }: { memberId: string; children: ReactNode }) {
  const [serverClient] = useState(() => (typeof window === "undefined" ? createAlhcQueryClient() : null));
  const client = serverClient ?? getQueryClient(memberId);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
