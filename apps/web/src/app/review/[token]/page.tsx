import type { Metadata } from "next";
import { cache } from "react";
import { connection } from "next/server";
import { ReviewClosedNotice, ReviewPortal } from "@/components/review/review-portal";
import { BRAND_LOGO_PATH } from "@/lib/email-design";
import { isUuid } from "@alhc/core/ids";
import { viewPublicReview } from "@alhc/core/api/reviews/queries";
import { REVIEW_REFUSALS, type PublicReviewResult } from "@alhc/core/review-checks";
import { anonContext } from "@/lib/server/context";

// Oct 26 notes (batch 3): the public review page. No sign-in: the token in the link is the only key, checked
// by review_check_view (anon; the token's hash, its expiry, 600 requests an hour) with a cookie-less anon
// client. Never indexed, never sends a referrer (the URL is the key). Oct 27 notes (batch 5): ?file=<file id>
// opens that file first (the email's thumbnails link to their file).
export const dynamic = "force-dynamic";

const loadReview = cache(async (token: string): Promise<PublicReviewResult> => {
  const anon = anonContext();
  if (!anon) return { status: "unknown" };
  return viewPublicReview(anon, token);
});

export async function generateMetadata({ params }: PageProps<"/review/[token]">): Promise<Metadata> {
  const { token } = await params;
  const result = await loadReview(token);
  return {
    // Nov 10 audit (G16): public pages carry the company's name, not the app's.
    title: { absolute: `${result.status === "ok" ? `Review: ${result.review.taskTitle}` : "Review"} · Autumn Lake Marketing` },
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

export default async function ReviewPage({ params, searchParams }: PageProps<"/review/[token]">) {
  await connection();
  const [{ token }, query] = await Promise.all([params, searchParams]);
  const result = await loadReview(token);
  if (result.status !== "ok") return <ReviewClosedNotice message={REVIEW_REFUSALS[result.status]} />;
  const action = query.action === "approve" || query.action === "feedback" ? query.action : null;
  const file = typeof query.file === "string" && isUuid(query.file) ? query.file : null;
  // C33 (Nov 10): the review page wears the Autumn Lake brand, like the review emails.
  return <ReviewPortal token={token} review={result.review} logoUrl={BRAND_LOGO_PATH} initialAction={action} initialFile={file} />;
}
