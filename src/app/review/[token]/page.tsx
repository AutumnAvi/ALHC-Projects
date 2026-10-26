import type { Metadata } from "next";
import { cache } from "react";
import { connection } from "next/server";
import { ReviewClosedNotice, ReviewPortal } from "@/components/review/review-portal";
import { emailLogoUrl } from "@/lib/email";
import { REVIEW_REFUSALS, isReviewToken, parsePublicReview, type PublicReviewResult } from "@/lib/review-checks";
import { createAnonServerClient } from "@/lib/supabase/anon-server";

// Oct 26 notes (batch 3): the public review page. No sign-in: the token in the link is the only key, checked
// by review_check_view (anon; the token's hash, its expiry, 600 requests an hour) with a cookie-less anon
// client. Never indexed, never sends a referrer (the URL is the key).
export const dynamic = "force-dynamic";

const loadReview = cache(async (token: string): Promise<PublicReviewResult> => {
  if (!isReviewToken(token)) return { status: "unknown" };
  const supabase = createAnonServerClient();
  if (!supabase) return { status: "unknown" };
  const { data, error } = await supabase.rpc("review_check_view", { review_token: token });
  if (error) {
    console.error("Review page:", error.code);
    return { status: "unknown" };
  }
  return parsePublicReview(data);
});

export async function generateMetadata({ params }: PageProps<"/review/[token]">): Promise<Metadata> {
  const { token } = await params;
  const result = await loadReview(token);
  return {
    title: result.status === "ok" ? `Review: ${result.review.taskTitle}` : "Review",
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
  const logoUrl = result.review.workspaceLogoPath ? emailLogoUrl(result.review.workspaceLogoPath) : null;
  return <ReviewPortal token={token} review={result.review} logoUrl={logoUrl} initialAction={action} />;
}
