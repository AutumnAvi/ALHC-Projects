"use server";
// Big move 1: review checks from the task pane (Oct 26 notes, batch 3), thin wrappers around
// packages/core/src/api/reviews/. The person's own client (RLS and the definer RPCs' Editor checks decide; never the
// service role). Sending creates the round in the database (which generates the link's token and keeps
// only its hash), then emails the link straight away with the built-in requester look: the token can't
// wait in the outbox, where task readers can see rows. The email (rendering, sending, the request's
// origin, the thumbnails route) is Next.js work, so it stays here.

import type { ApiContext } from "@alhc/core/api/core/context";
import type { ActionResult } from "@alhc/core/api/core/result";
import { getViewer } from "@alhc/core/api/auth/queries";
import type { ReviewRoundLink, RoundAsset, SendReviewResult } from "@alhc/core/api/reviews/model";
import * as reviewsApi from "@alhc/core/api/reviews/mutations";
import * as reviewsQueries from "@alhc/core/api/reviews/queries";
import { isEmailConfigured, sendEmailNow } from "@/lib/email";
import { requestOrigin } from "@/lib/origin";
import type { TaskReviewRound } from "@alhc/core/review-checks";
import { reviewUrls, renderReviewEmail } from "@/lib/review-email";
import type { ReviewThumbnail } from "@alhc/core/review-thumbnail-shared";
import { requestReviewThumbnails } from "@/lib/review-thumbnail-request";
import { run, runWith } from "@/lib/server/action";
import { actionContext } from "@/lib/server/context";


async function emailRound(
  ctx: ApiContext,
  review: ReviewRoundLink,
  assetIds: RoundAsset[],
): Promise<{ emailed: boolean; link?: string }> {
  const origin = await requestOrigin();
  const urls = reviewUrls(origin, review.token);
  try {
    const { user } = await getViewer(ctx);
    // Oct 27 notes (batch 5): thumbnails of the images and PDFs (first page), drawn on the server and
    // stored with the Editor's own client, signed until the link expires. Only when an email can go out;
    // any file that can't be drawn gets a file tile instead. Nov 4 notes (batch 21, QW3): drawn by
    // /api/review-thumbnails (the one server function that ships pdf.js and Skia) as this same person,
    // started first so it runs alongside the reads below (it reads the files through RLS itself).
    const thumbnailsPending = isEmailConfigured()
      ? requestReviewThumbnails({ taskId: review.taskId, expiresAt: review.expiresAt.toISOString(), assets: assetIds })
      : Promise.resolve(new Map<string, ReviewThumbnail>());
    const { task, sender, attachments } = await reviewsQueries.reviewEmailDetails(
      ctx,
      review.taskId,
      user?.id ?? "",
      assetIds.map((a) => a.attachmentId),
    );
    // The request's project (Oct 29 notes, 55b: no home project) is the one the database chose for this
    // round with the sender's access, so the email and the review page name the same project.
    const byId = new Map(attachments.map((a) => [a.id, a] as const));
    const thumbnails = await thumbnailsPending;
    const email = renderReviewEmail({
      origin,
      token: review.token,
      round: review.round ?? 1,
      recipientName: review.recipientName,
      senderName: sender?.full_name?.trim() || sender?.email || "Someone",
      taskTitle: task?.title ?? "A request",
      projectName: review.project?.name ?? null,
      message: review.message,
      assets: assetIds.flatMap(({ assetId, attachmentId }) => {
        const a = byId.get(attachmentId);
        const thumb = thumbnails.get(assetId);
        return a
          ? [{ assetId, name: a.file_name, contentType: a.content_type, thumbnailUrl: thumb?.url ?? null, thumbnailWidth: thumb?.width ?? null }]
          : [];
      }),
    });
    const outcome = await sendEmailNow(review.recipientEmail, email, "review check");
    return outcome === "sent" ? { emailed: true } : { emailed: false, link: urls.page };
  } catch (error) {
    console.error("Review check email failed", error instanceof Error ? error.message.slice(0, 80) : "error");
    return { emailed: false, link: urls.page };
  }
}

// A suppressed address gets no email (the link is shown once instead); else the round's email goes out.
async function deliverRound(ctx: ApiContext, review: ReviewRoundLink) {
  if (review.suppressed) {
    return { round: review.round, emailed: false, suppressed: true, link: reviewUrls(await requestOrigin(), review.token).page };
  }
  const sent = await emailRound(ctx, review, await reviewsQueries.roundAssets(ctx, review.reviewId));
  return { round: review.round, ...sent };
}

export async function sendReviewCheck(input: {
  taskId: string;
  attachmentIds: string[];
  recipientEmail: string;
  recipientName?: string | null;
  message?: string | null;
}): Promise<SendReviewResult> {
  return runWith(async (ctx) => deliverRound(ctx, await reviewsApi.createReviewCheck(ctx, input)), { deliver: false });
}

// "Send again": a new link for an open round (the old one stops working) and a new email.
export async function resendReviewCheck(reviewId: string): Promise<SendReviewResult> {
  return runWith(async (ctx) => deliverRound(ctx, await reviewsApi.rotateReviewCheck(ctx, reviewId)), { deliver: false });
}

export async function withdrawReviewCheck(reviewId: string): Promise<ActionResult> {
  return run((ctx) => reviewsApi.cancelReviewCheck(ctx, reviewId), { deliver: false });
}

// The task's Reviews tab: every round, newest first, with its files, pins, and the reviewer's uploads (RLS:
// the task's Viewers+). Null without this release's database update.
export async function loadTaskReviews(taskId: string): Promise<TaskReviewRound[] | null> {
  return reviewsQueries.loadTaskReviews(await actionContext(), taskId);
}
