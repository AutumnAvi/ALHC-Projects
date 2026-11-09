import "server-only";
// Big move 1: how the Next.js app hands the data-access layer (packages/core/src/api/) its context. The layer never
// makes a client; these do, from the request's cookies (the person's own session: RLS decides), or a
// cookie-less anon client for public token-checked pages, or the service role for background work only.
import { cache } from "react";
import { createApiContext, type ApiContext } from "@alhc/core/api/core/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAnonServerClient } from "@/lib/supabase/anon-server";
import { createBearerServerClient } from "@/lib/supabase/bearer-server";
import { createClient } from "@/lib/supabase/server";

// One context per server render: the layout, the page, and every read under them share one client and
// one memo (what React's cache() did per read before). Outside a render (Server Actions, route handlers)
// React's cache() doesn't hold, so each call gets a fresh context — use actionContext / routeContext there.
export const renderContext = cache(
  async (): Promise<ApiContext> => createApiContext(await createClient(), { memo: true }),
);

// A Server Action's context: no memo, so a read after a write sees the write.
export async function actionContext(): Promise<ApiContext> {
  return createApiContext(await createClient());
}

// A route handler's context (GET routes read only): one memo for the whole request.
export async function routeContext(): Promise<ApiContext> {
  return createApiContext(await createClient(), { memo: true });
}

// Public, token-checked work (the review page, calendar links, one-click unsubscribe, inbound webhooks):
// the anon key and no session. Null when Supabase isn't configured.
export function anonContext(): ApiContext | null {
  const db = createAnonServerClient();
  return db ? createApiContext(db) : null;
}

// Background work only (outbox drains, cron, the verified inbound email webhook): the service role
// bypasses RLS, so never use it to serve a person's request. Null without the service role key.
export function adminContext(): ApiContext | null {
  const db = createAdminClient();
  return db ? createApiContext(db) : null;
}

// AI builder round 5 (note 178): the MCP endpoint's context — one person, through a short-lived token the
// server minted for them after their personal access token checked out (lib/mcp/auth.ts). RLS decides as for
// that person; never the service role, never cookies. Null when Supabase isn't configured.
export function bearerContext(accessToken: string): ApiContext | null {
  const db = createBearerServerClient(accessToken);
  return db ? createApiContext(db) : null;
}

// A layer read bound to the render's context, for Server Components.
export function bind<A extends unknown[], R>(fn: (ctx: ApiContext, ...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A) => fn(await renderContext(), ...args);
}
