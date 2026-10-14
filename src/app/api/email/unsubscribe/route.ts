import { createClient } from "@supabase/supabase-js";
import { isUnsubscribeWhat, UNSUBSCRIBE_TOKEN, type UnsubscribeWhat } from "@/lib/email-schedules";
import { readSupabaseEnv } from "@/lib/env";
import type { Database } from "@/lib/supabase/database.types";

// The one-click "Turn off" links in Inbox digests and scheduled report emails (Real features 3). No
// sign-in: the token in the link is the person's unsubscribe token, and email_unsubscribe() turns off
// that one switch (the digest, or report emails) and says nothing about whose token it is. A cookie-less
// anon client — never the service role, never the visitor's session.
//
// POST is the action: the /email/off page's button (then back to that page with the outcome) and mail
// apps' own "Unsubscribe" (RFC 8058 List-Unsubscribe-Post, answered with plain text). GET never changes
// anything — link scanners open every link in an email — and just shows the page.

export const dynamic = "force-dynamic";

function input(url: URL, form: FormData | null): { token: string | null; what: UnsubscribeWhat | null; fromPage: boolean } {
  const token = String(form?.get("t") ?? url.searchParams.get("t") ?? "").trim();
  const what = String(form?.get("what") ?? url.searchParams.get("what") ?? "");
  return {
    token: UNSUBSCRIBE_TOKEN.test(token) ? token.toLowerCase() : null,
    what: isUnsubscribeWhat(what) ? what : null,
    fromPage: form?.get("source") === "page",
  };
}

function pageUrl(url: URL, params: Record<string, string>) {
  const target = new URL("/email/off", url);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return target;
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const contentType = request.headers.get("content-type") ?? "";
  const form =
    contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")
      ? await request.formData().catch(() => null)
      : null;
  const { token, what, fromPage } = input(url, form);

  let status = "unknown";
  const env = readSupabaseEnv();
  if (token && what && env) {
    const supabase = createClient<Database>(env.url, env.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await supabase.rpc("email_unsubscribe", { unsubscribe_token: token, what });
    if (error) {
      console.error("Unsubscribe failed", error.code);
      status = "error";
    } else {
      status = (data as { status?: string } | null)?.status ?? "unknown";
    }
  }

  if (fromPage) {
    return Response.redirect(pageUrl(url, { ...(what ? { what } : {}), result: status }), 303);
  }
  const ok = status === "off" || status === "already_off";
  return new Response(ok ? "Turned off.\n" : "This link no longer works.\n", {
    status: ok ? 200 : status === "error" ? 500 : 400,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const { token, what } = input(url, null);
  return Response.redirect(pageUrl(url, { ...(token ? { t: token } : {}), ...(what ? { what } : {}) }), 303);
}
