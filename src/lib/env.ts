// NEXT_PUBLIC_* values must be referenced literally so Next.js can inline them into client bundles.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export type SupabasePublicEnv = { url: string; anonKey: string };

export function readSupabaseEnv(): SupabasePublicEnv | null {
  if (!supabaseUrl || !supabaseAnonKey) return null;
  return { url: supabaseUrl, anonKey: supabaseAnonKey };
}

export function isSupabaseConfigured(): boolean {
  return readSupabaseEnv() !== null;
}

// Google sign-in stays hidden until the Supabase Google provider is configured; email + password is
// the interim sign-in method.
export function isGoogleAuthEnabled(): boolean {
  return process.env.AUTH_GOOGLE_ENABLED === "true";
}

// Env is optional at build time (every Supabase-backed route is dynamic) but required at request time.
export function requireSupabaseEnv(): SupabasePublicEnv {
  const env = readSupabaseEnv();
  if (!env) {
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY " +
        "(see .env.local.example).",
    );
  }
  return env;
}
