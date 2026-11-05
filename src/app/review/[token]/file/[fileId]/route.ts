import { NextResponse, type NextRequest } from "next/server";
import { reviewFileLink } from "@/lib/api/reviews/queries";
import { isUuid } from "@/lib/ids";
import { isReviewToken } from "@/lib/review-checks";
import { adminContext, anonContext } from "@/lib/server/context";

// Oct 26 notes (batch 3): one file of a review round, for the public review page (and the email's
// thumbnail). GET /review/<token>/file/<file id>[?download=1]. The anon-callable review_check_file checks
// the link (hash, expiry, 600 requests an hour) and returns the storage path only of a file of that
// round (one of its assets, or one the reviewer sent back); then the service role signs a link to exactly
// that object (an hour, so a video keeps playing) — the private bucket has no anon read path. Images,
// PDFs, and videos open in the browser when their name, recorded type, and stored type agree; anything
// else downloads. Nothing logs the token.
export const dynamic = "force-dynamic";

const TTL_SECONDS = 3600;

function plain(status: number, text: string) {
  return withHeaders(new NextResponse(text, { status }));
}

function withHeaders(response: NextResponse) {
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}

export async function GET(request: NextRequest, ctx: RouteContext<"/review/[token]/file/[fileId]">) {
  const { token, fileId } = await ctx.params;
  if (!isReviewToken(token) || !isUuid(fileId)) return plain(404, "Not found");
  const anon = anonContext();
  const admin = adminContext();
  if (!anon || !admin) return plain(503, "Reviews aren’t set up on this site yet");
  const link = await reviewFileLink(anon, admin, token, fileId, {
    download: request.nextUrl.searchParams.has("download"),
    seconds: TTL_SECONDS,
  });
  if (link.status === "error") return plain(503, "Something went wrong");
  if (link.status === "rate_limited") return plain(429, "Too many requests on this link just now");
  if (link.status === "expired") return plain(410, "This review link has expired");
  if (link.status === "missing") return plain(404, "Not found");
  if (link.status === "unsigned") return plain(502, "File unavailable");
  return withHeaders(NextResponse.redirect(link.url));
}
