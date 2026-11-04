import "server-only";
import { cookies, headers } from "next/headers";
import {
  REVIEW_THUMBNAILS_PATH,
  THUMBNAIL_BUDGET_MS,
  parseThumbnailResponse,
  type ReviewThumbnail,
  type ReviewThumbnailRequest,
} from "@/lib/review-thumbnail-shared";

// Nov 4 notes (batch 21, QW3): the review Server Actions get their email's thumbnails from the route that
// draws them (POST /api/review-thumbnails), on the same deployment and as the same signed-in person: the
// request carries this request's own session cookies, so the route reads and stores files with that
// person's own Supabase client exactly as the action did before (never the service role). Best effort,
// like before: no answer within the budget (plus room for the hop) or any failure = file tiles.
//
// It goes to the host this request came in on, so it reaches this same deployment (on a protected
// preview the forwarded cookies include Vercel's own access cookie) — but only when that host is one of
// this app's own (the configured app URL, or this deployment's Vercel URLs; localhost outside Vercel), so
// the session cookies never go anywhere else. Null = no hop (file tiles).
function hostOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).host.toLowerCase();
  } catch {
    return null;
  }
}

export function thumbnailRouteOrigin(
  host: string | null,
  proto: string | null,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const own = new Set(
    [env.NEXT_PUBLIC_APP_URL, env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL]
      .map(hostOf)
      .filter((h): h is string => h !== null),
  );
  const requested = host?.toLowerCase() ?? null;
  const local = requested !== null && !env.VERCEL && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(requested);
  if (requested && (own.has(requested) || local)) {
    return `${proto === "http" || (local && proto !== "https") ? "http" : "https"}://${requested}`;
  }
  const deployment = hostOf(env.VERCEL_URL);
  return deployment ? `https://${deployment}` : null;
}

export async function requestReviewThumbnails(request: ReviewThumbnailRequest): Promise<Map<string, ReviewThumbnail>> {
  if (request.assets.length === 0) return new Map();
  try {
    const h = await headers();
    const origin = thumbnailRouteOrigin(h.get("x-forwarded-host") ?? h.get("host"), h.get("x-forwarded-proto"));
    if (!origin) return new Map();
    const cookieHeader = (await cookies())
      .getAll()
      .map(({ name, value }) => `${name}=${encodeURIComponent(value)}`)
      .join("; ");
    const requestHeaders: Record<string, string> = { "content-type": "application/json", cookie: cookieHeader };
    // Preview deployments behind Vercel's deployment protection let the app's own calls through with the
    // project's automation bypass secret (set by Vercel when protection bypass is turned on).
    const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    if (bypass) requestHeaders["x-vercel-protection-bypass"] = bypass;
    const response = await fetch(new URL(REVIEW_THUMBNAILS_PATH, origin), {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(request),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(THUMBNAIL_BUDGET_MS + 4000),
    });
    if (!response.ok) {
      console.error(`Review thumbnails: the drawing route answered ${response.status}`);
      return new Map();
    }
    return parseThumbnailResponse(await response.json());
  } catch (error) {
    console.error("Review thumbnails skipped:", error instanceof Error ? error.name : "error");
    return new Map();
  }
}
