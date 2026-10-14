import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { CALENDAR_FEED_TOKEN } from "@/lib/calendar-feeds";
import { readSupabaseEnv } from "@/lib/env";
import { buildCalendar, type FeedEvent } from "@/lib/ical";
import type { Database } from "@/lib/supabase/database.types";

// The calendar subscribe links (Real features 4): GET /api/calendar/<token>.ics, no sign-in. The token is
// the whole credential, so this route never logs it (errors log a code only). calendar_feed() — one
// SECURITY DEFINER function anon can call — looks up the token's hash and builds the events with the
// link owner's own access at this very fetch, so a task they lost access to is gone from the next
// refresh. A cookie-less anon client: never the service role, never a visitor's session.
//
//   unknown token (malformed, never made, or replaced)  → 404
//   turned off, or the owner left the workspace         → 200 with an empty calendar (subscribed
//                                                         calendars drop the old events)
//   more than 60 fetches in an hour                     → 429 (the calendar app keeps what it has)
//   otherwise                                           → 200 text/calendar, ETag / If-None-Match → 304

export const dynamic = "force-dynamic";

type FeedResult = {
  ok?: boolean;
  status?: string;
  name?: string;
  events?: FeedEvent[];
};

const PRIVATE_HEADERS = {
  "Cache-Control": "private, max-age=900",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
};

function plain(status: number, text: string, extra: Record<string, string> = {}) {
  return new Response(`${text}\n`, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}

function fileName(name: string) {
  const slug =
    name
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "-")
      .slice(0, 60) || "calendar";
  return `alhc-${slug}.ics`;
}

export async function GET(request: Request, ctx: RouteContext<"/api/calendar/[token]">) {
  const { token: raw } = await ctx.params;
  // Tokens are plain ASCII; anything that isn't one (or isn't valid percent-encoding) is just not found.
  const token = raw.replace(/\.ics$/i, "").trim();
  if (!CALENDAR_FEED_TOKEN.test(token)) return plain(404, "Not found");

  const env = readSupabaseEnv();
  if (!env) return plain(503, "Calendar feeds aren't set up here");
  const supabase = createClient<Database>(env.url, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await supabase.rpc("calendar_feed", { feed_token: token });
  if (error) {
    // Never the token or the URL.
    console.error("Calendar feed failed", error.code);
    return plain(503, "Try again later", { "Retry-After": "300" });
  }
  const result = (data ?? {}) as FeedResult;
  if (result.status === "unknown" || !result.status) return plain(404, "Not found");
  if (result.status === "rate_limited") {
    return plain(429, "Too many requests for this calendar link; try again in an hour", { "Retry-After": "3600" });
  }

  const name = result.name || "ALHC Projects";
  const url = new URL(request.url);
  const origin = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") || url.origin;
  const body = buildCalendar({ name, events: result.status === "ok" ? (result.events ?? []) : [], origin });
  // The event stamps change every fetch, so the ETag covers everything else.
  const etag = `W/"${createHash("sha256").update(body.replace(/^DTSTAMP:.*\r\n/gm, "")).digest("base64url").slice(0, 27)}"`;
  const headers = {
    ...PRIVATE_HEADERS,
    "Content-Type": "text/calendar; charset=utf-8",
    "Content-Disposition": `inline; filename="${fileName(name)}"`,
    ETag: etag,
  };
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, { status: 200, headers });
}
