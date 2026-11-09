import "server-only";
import { createClient } from "@supabase/supabase-js";
import { readSupabaseEnv } from "@/lib/env";
import type { Database } from "@alhc/core/supabase/database.types";

// AI builder round 5 (note 178): a cookie-less client that acts as one person with a short-lived token the
// server minted for them (the MCP endpoint): RLS decides exactly as for that person signed in. Never the
// service role, never the request's cookies. Null when Supabase isn't configured.
export function createBearerServerClient(accessToken: string) {
  const env = readSupabaseEnv();
  if (!env) return null;
  return createClient<Database>(env.url, env.anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
