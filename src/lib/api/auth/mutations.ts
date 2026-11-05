// Big move 1: signing in, signing up, signing out, and passwords. Every function takes the caller's
// ApiContext first and talks to Supabase Auth only through ctx.db — the adapter's own cookie client, so the
// session cookies are still set by it; no Next.js here (redirects, headers, and the request's origin stay
// in the adapters, which pass the URLs they build in).
//
// Supabase Auth answers with its own errors (a code and an HTTP status, not a Postgres error), and each
// sign-in screen words them its own way, so these answer an AuthFailure for the adapter to show instead of
// throwing an ApiError.
import type { AuthError, User } from "@supabase/supabase-js";
import type { ApiContext } from "@/lib/api/core/context";
import { isAllowlisted } from "@/lib/api/auth/queries";

// What Supabase Auth said when it refused (its message as is, its error code, its HTTP status).
export type AuthFailure = { message: string; code: string | undefined; status: number | undefined };

function failure(error: AuthError | null): AuthFailure | null {
  return error ? { message: error.message, code: error.code, status: error.status } : null;
}

// Sign up with email and password. `session` false = Supabase Auth wants the address confirmed first (the
// confirmation link returns through emailRedirectTo).
export async function signUp(
  ctx: ApiContext,
  input: { email: string; password: string; emailRedirectTo: string },
): Promise<{ error: AuthFailure | null; session: boolean }> {
  const { data, error } = await ctx.db.auth.signUp({
    email: input.email,
    password: input.password,
    options: { emailRedirectTo: input.emailRedirectTo },
  });
  return { error: failure(error), session: Boolean(data.session) };
}

export async function signInWithPassword(
  ctx: ApiContext,
  input: { email: string; password: string },
): Promise<{ error: AuthFailure | null }> {
  const { error } = await ctx.db.auth.signInWithPassword({ email: input.email, password: input.password });
  return { error: failure(error) };
}

// The OAuth / email-confirmation / password-reset code exchange (the auth callback). `user` is null when
// Supabase Auth gave no user back.
export async function exchangeCodeForSession(
  ctx: ApiContext,
  code: string,
): Promise<{ error: AuthFailure | null; user: { email: string | undefined } | null }> {
  const { data, error } = await ctx.db.auth.exchangeCodeForSession(code);
  return { error: failure(error), user: data.user ? { email: data.user.email } : null };
}

// Ends the session (scope "global": every session of the account, on every device). Whatever Supabase
// Auth answers, the cookie client clears this browser's session.
export async function signOut(ctx: ApiContext, options?: { scope: "global" | "local" | "others" }): Promise<void> {
  await (options ? ctx.db.auth.signOut(options) : ctx.db.auth.signOut());
}

// The allowlist gate every way in ends at (sign-in, sign-up, the auth callback, a password reset): true when
// the session's person is allowlisted; otherwise the session is signed out and the answer is false.
export async function enforceAllowlist(ctx: ApiContext): Promise<boolean> {
  const { allowlisted, error } = await isAllowlisted(ctx);
  if (error || !allowlisted) {
    // Never leave a non-allowlisted user holding a session.
    await signOut(ctx);
    return false;
  }
  return true;
}

// Forgot password (Nov 1 notes, batch 8): Supabase Auth sends the email; its link returns to redirectTo.
export async function requestPasswordReset(
  ctx: ApiContext,
  email: string,
  redirectTo: string,
): Promise<{ error: AuthFailure | null }> {
  const { error } = await ctx.db.auth.resetPasswordForEmail(email, { redirectTo });
  return { error: failure(error) };
}

// The signed-in person, asked of Supabase Auth over the network. Nov 4 notes (batch 21, QW2): everything
// else reads the person from the locally verified token (getSignedInUser in queries.ts); this is the one
// place a fresh server check of the session is wanted — setting a new password through the session a reset
// link opened — so only the reset-password action calls it. Null when there's no live session.
export async function getFreshUser(ctx: ApiContext): Promise<User | null> {
  const {
    data: { user },
  } = await ctx.db.auth.getUser();
  return user;
}

// Sets the session's person's password.
export async function updatePassword(ctx: ApiContext, password: string): Promise<{ error: AuthFailure | null }> {
  const { error } = await ctx.db.auth.updateUser({ password });
  return { error: failure(error) };
}
