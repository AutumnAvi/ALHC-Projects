// Forgot password (Nov 1 notes, batch 8): the wording and checks shared by /forgot-password,
// /reset-password, and the auth callback. No "use client" and no server-only imports, so both sides
// (and the unit tests) use the same rules.

// Sign-up's own minimum (the sign-up form's minLength); Supabase Auth still enforces its configured one.
export const MIN_PASSWORD_LENGTH = 6;
// bcrypt, which Supabase Auth uses, reads only the first 72 bytes; refuse longer so nothing is silently cut.
export const MAX_PASSWORD_BYTES = 72;

// The one answer to a reset request, whether or not the address has an account or is allowlisted: the
// page must never tell an outsider which addresses exist.
export const RESET_SENT_NOTICE = "If that address has an account, we’ve sent a link to reset your password.";
export const RESET_RATE_LIMITED = "Too many requests. Try again in a minute.";
export const RESET_LINK_EXPIRED = "That reset link has expired or was already used. Send yourself a new one.";
export const PASSWORD_UPDATED = "Password updated. Sign in with your new password.";
// The browser waits this long before another request can be sent from the form.
export const RESET_COOLDOWN_SECONDS = 60;

// Where the reset email's link returns: the callback exchanges the code (PKCE), runs the allowlist gate,
// and then opens the page that sets the new password.
export const RESET_PASSWORD_PATH = "/reset-password";
export const FORGOT_PASSWORD_PATH = "/forgot-password";

export function resetRedirectUrl(origin: string): string {
  const url = new URL("/auth/callback", origin);
  url.searchParams.set("next", RESET_PASSWORD_PATH);
  return url.toString();
}

// The link the callback sends a failed or expired reset link to.
export function expiredResetPath(): string {
  return `${FORGOT_PASSWORD_PATH}?expired=1`;
}

// Whether a callback's next path is the reset page (so a broken link lands on /forgot-password, not on
// the sign-in screen with Supabase's raw message).
export function isResetNext(next: string): boolean {
  return next === RESET_PASSWORD_PATH || next.startsWith(`${RESET_PASSWORD_PATH}?`);
}

export function normalizeResetEmail(value: unknown): string | null {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email || email.length > 320 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
  return email;
}

type AuthErrorLike = { code?: string | null; status?: number | null } | null | undefined;

// What a failed resetPasswordForEmail may tell the person. Supabase Auth answers an unknown address with
// success, and its per-address limits ("you can only request this after 60 seconds", the email quota)
// only ever apply to an address that exists — so those, like every other error, read as the same
// "we've sent a link" notice. Only the request-rate limit, which counts requests rather than accounts,
// says "try again".
export function resetRequestOutcome(error: AuthErrorLike): "sent" | "rate_limited" {
  if (!error) return "sent";
  if (error.code === "over_request_rate_limit") return "rate_limited";
  return "sent";
}

export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

// The new password's problem, or null when it can be sent to Supabase.
export function passwordProblem(password: string, confirm: string): string | null {
  if (!password) return "Enter a new password.";
  if ([...password].length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (utf8Length(password) > MAX_PASSWORD_BYTES) return "That password is too long. Use 72 characters or fewer.";
  if (password.trim().length === 0) return "Use letters, numbers, or symbols, not only spaces.";
  if (password !== confirm) return "The two passwords don’t match.";
  return null;
}

// updateUser's refusals in plain words; anything unexpected is generic (the server logs its code).
export function updatePasswordError(error: { code?: string | null; message?: string | null }): string {
  switch (error.code) {
    case "same_password":
      return "Choose a password that’s different from your current one.";
    case "weak_password":
      return error.message?.trim() || "That password is too weak. Try a longer one.";
    case "session_not_found":
    case "session_expired":
    case "reauthentication_needed":
      return RESET_LINK_EXPIRED;
    default:
      return "Couldn’t update your password. Try again, or send yourself a new reset link.";
  }
}
