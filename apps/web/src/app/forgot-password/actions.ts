"use server";

import * as authApi from "@alhc/core/api/auth/mutations";
import { authLinkOrigin } from "@/lib/origin";
import {
  RESET_RATE_LIMITED,
  RESET_SENT_NOTICE,
  normalizeResetEmail,
  resetRedirectUrl,
  resetRequestOutcome,
} from "@alhc/core/password-reset";
import { actionContext } from "@/lib/server/context";

// email: what was typed, so the form shows it again after React resets it.
export type ForgotPasswordState = { notice?: string; error?: string; sent?: boolean; email?: string };

// Forgot password (Nov 1 notes, batch 8). Supabase Auth sends the email (its "Reset password" template
// and SMTP settings); the link returns through /auth/callback, which exchanges the PKCE code — its
// verifier is the cookie this request sets — runs the allowlist gate, and opens /reset-password.
// Every outcome reads the same, so the page never tells anyone which addresses have an account.
export async function requestPasswordReset(
  _prev: ForgotPasswordState,
  formData: FormData,
): Promise<ForgotPasswordState> {
  const typed = String(formData.get("email") ?? "").slice(0, 320);
  const email = normalizeResetEmail(typed);
  if (!email) return { error: "Enter a valid email address.", email: typed };

  const ctx = await actionContext();
  const origin = await authLinkOrigin();
  const { error } = await authApi.requestPasswordReset(ctx, email, resetRedirectUrl(origin));
  // The code only, never the address.
  if (error) console.warn(`[auth:reset] request failed code=${error.code ?? "unknown"} status=${error.status ?? "?"}`);
  if (resetRequestOutcome(error) === "rate_limited") return { error: RESET_RATE_LIMITED, email };
  return { notice: RESET_SENT_NOTICE, sent: true, email };
}
