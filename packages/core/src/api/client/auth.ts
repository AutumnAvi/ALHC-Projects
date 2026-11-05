// Big move 1: signing in with Google starts in the browser (Supabase Auth redirects the page to Google and
// keeps the PKCE verifier in a cookie of this browser). Browser-safe: no Next.js, no server-only; the
// caller hands in a context over the browser's own client and the URL Google sends the person back to.
import type { ApiContext } from "../core/context";

// Answers only when Supabase Auth refused to start (the page is leaving for Google otherwise).
export async function signInWithGoogle(ctx: ApiContext, redirectTo: string): Promise<{ error: string | null }> {
  const { error } = await ctx.db.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo,
      queryParams: { prompt: "select_account" },
    },
  });
  return { error: error ? error.message : null };
}
