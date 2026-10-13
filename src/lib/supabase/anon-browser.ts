import { createClient } from "@supabase/supabase-js";
import { requireSupabaseEnv } from "@/lib/env";
import type { Database } from "./database.types";

// A browser client with the anon key and no session (never the visitor's cookies): public form
// submitters upload their files as anon, so only the form-upload Storage policy applies to them
// (form_upload_allowed, Real features 1), whether or not they happen to be signed in.
export function createAnonBrowserClient() {
  const { url, anonKey } = requireSupabaseEnv();
  return createClient<Database>(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: "alhc-form-upload" },
  });
}
