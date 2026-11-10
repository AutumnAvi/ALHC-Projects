import { NextResponse, type NextRequest } from "next/server";
import * as authApi from "@alhc/core/api/auth/mutations";
import { safeNextPath } from "@/lib/auth";
import { expiredResetPath, isResetNext } from "@alhc/core/password-reset";
import { routeContext } from "@/lib/server/context";
import type { SignInErrorCode } from "@alhc/core/sign-in-errors";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const next = safeNextPath(searchParams.get("next"));
  const providerError = searchParams.get("error_description") ?? searchParams.get("error");

  // A code, never the provider's text (Nov 10 audit, C88): /login shows a fixed message for it.
  const toLogin = (code: SignInErrorCode) => {
    // A reset link that expired, was used already, or opened in another browser (its PKCE verifier is a
    // cookie of the browser that asked) goes back to Forgot password with a note, not to Sign in.
    if (isResetNext(next)) return NextResponse.redirect(new URL(expiredResetPath(), origin));
    const url = new URL("/login", origin);
    url.searchParams.set("error", code);
    return NextResponse.redirect(url);
  };

  if (providerError) return toLogin("provider");
  if (!code) return toLogin("interrupted");

  const ctx = await routeContext();
  const { error, user } = await authApi.exchangeCodeForSession(ctx, code);
  if (error || !user) return toLogin("failed");

  // Never leave a non-allowlisted user holding a session (the gate signs them out).
  if (!(await authApi.enforceAllowlist(ctx))) {
    const url = new URL("/denied", origin);
    if (user.email) url.searchParams.set("email", user.email);
    return NextResponse.redirect(url);
  }

  return NextResponse.redirect(new URL(next, origin));
}
