import { NextResponse, type NextRequest } from "next/server";
import { safeNextPath } from "@/lib/auth";
import { expiredResetPath, isResetNext } from "@/lib/password-reset";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const next = safeNextPath(searchParams.get("next"));
  const providerError = searchParams.get("error_description") ?? searchParams.get("error");

  const toLogin = (message: string) => {
    // A reset link that expired, was used already, or opened in another browser (its PKCE verifier is a
    // cookie of the browser that asked) goes back to Forgot password with a note, not to Sign in.
    if (isResetNext(next)) return NextResponse.redirect(new URL(expiredResetPath(), origin));
    const url = new URL("/login", origin);
    url.searchParams.set("error", message);
    return NextResponse.redirect(url);
  };

  if (providerError) return toLogin(providerError);
  if (!code) return toLogin("Sign-in was interrupted. Please try again.");

  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user) return toLogin(error?.message ?? "Could not complete sign-in.");

  const { data: allowlisted, error: allowlistError } = await supabase.rpc("is_allowlisted");
  if (allowlistError || allowlisted !== true) {
    // Never leave a non-allowlisted user holding a session.
    await supabase.auth.signOut();
    const url = new URL("/denied", origin);
    if (data.user.email) url.searchParams.set("email", data.user.email);
    return NextResponse.redirect(url);
  }

  return NextResponse.redirect(new URL(next, origin));
}
