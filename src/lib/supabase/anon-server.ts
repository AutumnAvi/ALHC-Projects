import "server-only";
import { createClient } from "@supabase/supabase-js";
import { readSupabaseEnv } from "@/lib/env";
import type { Database } from "./database.types";

// A cookie-less anon client for public, token-checked work on the server (Oct 26 notes, batch 3: the review
// page): never the visitor's session, never the service role. Null when Supabase isn't configured.
export function createAnonServerClient() {
  const env = readSupabaseEnv();
  if (!env) return null;
  return createClient<Database>(env.url, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
