import "server-only";
import { createClient } from "@supabase/supabase-js";
import { readSupabaseEnv } from "@/lib/env";
import type { Database } from "./database.types";

// Service-role client for background work only (email outbox, scheduled rules). Bypasses RLS:
// never use it to serve a user's request, and never expose the key to the browser.
export function createAdminClient() {
  const env = readSupabaseEnv();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!env || !serviceKey) return null;
  return createClient<Database>(env.url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
