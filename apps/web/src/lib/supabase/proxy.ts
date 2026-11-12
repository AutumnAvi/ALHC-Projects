import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { readSupabaseEnv } from "@/lib/env";
import type { Database } from "@alhc/core/supabase/database.types";

// /forms serves public intake forms; /api/cron authorizes with CRON_SECRET and /api/inbound with an
// endpoint token (plus an optional signature) instead of a session.
const PUBLIC_PATHS = [
  "/login",
  "/signup",
  // Forgot password (Nov 1 notes, batch 8): the request form, and the new-password page, which checks the
  // reset link's session itself (signed out = the link expired, explained on /forgot-password).
  "/forgot-password",
  "/reset-password",
  "/denied",
  "/auth",
  "/forms",
  "/api/cron",
  "/api/inbound",
  // The one-click "Turn off" links in digest and report emails (Real features 3): a token, no sign-in.
  "/email/off",
  "/api/email/unsubscribe",
  // Calendar subscribe links (Real features 4): a token in the URL, no sign-in.
  "/api/calendar",
  // Review checks (Oct 26 notes, batch 3): the reviewer's page and its files; a token in the URL, no
  // sign-in (/review-files, the task's own view of uploads, is not public).
  "/review",
  // AI builder round 5 (note 178): the MCP endpoint authorizes ONLY with a personal access token
  // (Authorization: Bearer); it never reads the session cookie, so the preview auto-login can't reach it.
  "/api/mcp",
  // Security audit 2 (Nov 12, batch 41): browsers' reports of the report-only content policy, sent from
  // signed-out pages too (sign-in, public forms). It stores nothing and answers 204.
  "/api/csp-report",
];

// AI builder pilot ONLY (feat/ai-builder, never merged): on this branch's Vercel Preview, sign visitors in
// automatically as a dedicated test admin whose only membership is the "Testing data" workspace. Needs
// VERCEL_ENV === "preview" (Vercel sets it; never "preview" on production or locally) AND
// ALHC_PREVIEW_AUTOLOGIN=1 plus the account's email/password, all set for Preview on this branch only.
function previewAutoLogin(): { email: string; password: string } | null {
  if (process.env.VERCEL_ENV !== "preview") return null;
  if (process.env.ALHC_PREVIEW_AUTOLOGIN !== "1") return null;
  const email = process.env.ALHC_PREVIEW_AUTOLOGIN_EMAIL;
  const password = process.env.ALHC_PREVIEW_AUTOLOGIN_PASSWORD;
  if (!email || !password) return null;
  return { email, password };
}

function isPublicPath(pathname: string) {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export async function updateSession(request: NextRequest) {
  const env = readSupabaseEnv();
  if (!env) return NextResponse.next({ request });

  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        for (const [key, value] of Object.entries(headers ?? {})) {
          response.headers.set(key, value);
        }
      },
    },
  });

  // getClaims() validates the JWT and refreshes an expired session; do not run code between
  // client creation and this call.
  const { data } = await supabase.auth.getClaims();
  let signedIn = Boolean(data?.claims?.sub);

  const auto = previewAutoLogin();
  if (auto && !signedIn && !request.nextUrl.pathname.startsWith("/api/")) {
    const { error } = await supabase.auth.signInWithPassword(auto);
    if (!error) {
      signedIn = true;
      // Reload the same page so server components see the new session cookies.
      const target = request.nextUrl.clone();
      if (target.pathname === "/login") {
        target.pathname = "/";
        target.search = "";
      }
      const redirect = NextResponse.redirect(target);
      for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
      return redirect;
    }
  }
  if (auto && signedIn && request.nextUrl.pathname === "/login") {
    const home = request.nextUrl.clone();
    home.pathname = "/";
    home.search = "";
    const redirect = NextResponse.redirect(home);
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  }

  if (!signedIn && !isPublicPath(request.nextUrl.pathname)) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    const next = request.nextUrl.pathname + request.nextUrl.search;
    if (next !== "/") loginUrl.searchParams.set("next", next);
    const redirect = NextResponse.redirect(loginUrl);
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  }

  return response;
}
