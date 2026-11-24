import "server-only";
// Nov 24 batch 45 (item 5): one path for every outside review email sent from the app — Send review check,
// Send again (Retry), and the parallel order's review that goes out with the team round — so they can't
// drift. The round is created (or given a new link) first; whatever happens to the email afterwards, the
// round stays, its outcome is recorded on it (record_review_email: sent, failed, mocked, suppressed) so the
// task card can show sent / failed with a Retry, and a link the sender can pass on comes back whenever the
// email didn't go out. Nothing here throws once the round exists.
//
// Time: the Server Action is waiting, so the thumbnails get at most THUMBNAIL_WAIT_MS (they were awaited
// up to 8 s before) and Resend a short retry budget (email-send.ts), well inside a function's limit.

import type { ApiContext } from "@alhc/core/api/core/context";
import { getViewer } from "@alhc/core/api/auth/queries";
import type { ParallelReviewResult, ReviewDelivery, ReviewRoundLink, RoundAsset } from "@alhc/core/api/reviews/model";
import * as reviewsApi from "@alhc/core/api/reviews/mutations";
import * as reviewsQueries from "@alhc/core/api/reviews/queries";
import { MAX_REVIEW_MESSAGE } from "@alhc/core/review-checks";
import { THUMBNAIL_BUDGET_MS, type ReviewThumbnail } from "@alhc/core/review-thumbnail-shared";
import { isEmailConfigured, sendEmailNowResult } from "@/lib/email";
import { sendKey } from "@/lib/email-send";
import { requestOrigin, backgroundOrigin } from "@/lib/origin";
import { renderReviewEmail, reviewUrls } from "@/lib/review-email";
import { requestReviewThumbnails } from "@/lib/review-thumbnail-request";

// The longest the email waits for its thumbnails (the drawing route's own budget plus the hop).
export const THUMBNAIL_WAIT_MS = THUMBNAIL_BUDGET_MS + 1500;

// "Resend didn’t answer in time" → shown under the yellow block; the same words for every failure kind.
const NOT_CONFIGURED = "No email provider is set up on this site, so nothing was sent";
const SUPPRESSED = "This address bounced or marked an earlier email as spam, so nothing was sent";

async function originOf(): Promise<string> {
  try {
    return await requestOrigin();
  } catch {
    return backgroundOrigin() ?? "";
  }
}

function withCap<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([work.catch(() => fallback), cap]).finally(() => clearTimeout(timer));
}

async function record(ctx: ApiContext, review: ReviewRoundLink, delivery: ReviewDelivery, providerId: string | null = null) {
  try {
    await reviewsApi.recordReviewEmail(ctx, {
      reviewId: review.reviewId,
      outcome: delivery.emailStatus ?? "failed",
      error: delivery.reason ?? null,
      providerId,
    });
  } catch (error) {
    // Recording is for the card; never fail the send over it. Codes only.
    console.error("Recording the review email failed", error instanceof Error ? error.name : "error");
  }
}

// Email one round (just created or given a new link) and record how it went.
export async function deliverReviewRound(ctx: ApiContext, review: ReviewRoundLink): Promise<ReviewDelivery> {
  const origin = await originOf();
  const urls = reviewUrls(origin, review.token);
  const base = { reviewId: review.reviewId, round: review.round };
  if (review.suppressed) {
    const delivery: ReviewDelivery = { ...base, emailed: false, emailStatus: "suppressed", suppressed: true, reason: SUPPRESSED, link: urls.page };
    await record(ctx, review, delivery);
    return delivery;
  }
  let delivery: ReviewDelivery;
  let providerId: string | null = null;
  try {
    const assets: RoundAsset[] = await reviewsQueries.roundAssets(ctx, review.reviewId).catch(() => []);
    // Thumbnails of the images and PDFs (first page), drawn as this same person by the one route that ships
    // pdf.js and Skia; only when an email can go out, and only as long as THUMBNAIL_WAIT_MS — a file
    // without one gets a tile.
    const thumbnailsPending = isEmailConfigured() && assets.length
      ? withCap(
          requestReviewThumbnails({ taskId: review.taskId, expiresAt: review.expiresAt.toISOString(), assets }),
          THUMBNAIL_WAIT_MS,
          new Map<string, ReviewThumbnail>(),
        )
      : Promise.resolve(new Map<string, ReviewThumbnail>());
    const { user } = await getViewer(ctx);
    const { task, sender, attachments } = await reviewsQueries.reviewEmailDetails(
      ctx,
      review.taskId,
      user?.id ?? "",
      assets.map((a) => a.attachmentId),
    );
    // The request's project is the one the database chose for this round with the sender's access, so the
    // email and the review page name the same project.
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
      assets: assets.flatMap(({ assetId, attachmentId }) => {
        const a = byId.get(attachmentId);
        const thumb = thumbnails.get(assetId);
        return a
          ? [{ assetId, name: a.file_name, contentType: a.content_type, thumbnailUrl: thumb?.url ?? null, thumbnailWidth: thumb?.width ?? null }]
          : [];
      }),
    });
    // One key per link: every try of this send shares it; Send again (a new token) is a new email.
    const sent = await sendEmailNowResult(review.recipientEmail, email, "review check", sendKey("review", review.reviewId, review.token));
    if (sent.outcome === "sent") {
      providerId = sent.id;
      delivery = { ...base, emailed: true, emailStatus: "sent" };
    } else if (sent.outcome === "mocked") {
      delivery = { ...base, emailed: false, emailStatus: "mocked", reason: NOT_CONFIGURED, link: urls.page };
    } else {
      delivery = { ...base, emailed: false, emailStatus: "failed", reason: sent.reason, link: urls.page };
    }
  } catch (error) {
    console.error("Review check email failed", error instanceof Error ? error.message.slice(0, 80) : "error");
    delivery = { ...base, emailed: false, emailStatus: "failed", reason: "The email couldn’t be prepared", link: urls.page };
  }
  await record(ctx, review, delivery, providerId);
  return delivery;
}

export type NewReviewInput = {
  taskId: string;
  attachmentIds: string[];
  recipientEmail: string;
  recipientName?: string | null;
  message?: string | null;
};

// A new round (create_review_check decides who may), then its email.
export async function createAndDeliverReview(ctx: ApiContext, input: NewReviewInput, options: { remember?: boolean } = {}) {
  const review = await reviewsApi.createReviewCheck(ctx, input);
  if (options.remember !== false) {
    // Nov 10 batch 36: remember who the external review went to (Editors+; an approver who is only a
    // Commenter can't, and that's fine — the round itself names them).
    await reviewsApi
      .setTaskExternalReviewer(ctx, { taskId: input.taskId, email: review.recipientEmail, name: review.recipientName })
      .catch(() => undefined);
  }
  return deliverReviewRound(ctx, review);
}

// Nov 24 batch 45: reviewed at the same time (parallel order), the outside review goes out with the team
// round — the round's files and its final text as the message. Never throws: the team round already went
// out, so anything that stops the outside review comes back as `skipped` with the reason.
export async function sendParallelReview(
  ctx: ApiContext,
  input: { taskId: string; attachmentIds: string[]; finalText: string | null },
): Promise<ParallelReviewResult | null> {
  let plan;
  try {
    plan = await reviewsQueries.outsideReviewPlan(ctx, input.taskId);
  } catch {
    return null;
  }
  if (plan.order !== "parallel") return null;
  if (!plan.reviewer) return { emailed: false, skipped: "No outside reviewer is named on this task" };
  if (!input.attachmentIds.length) {
    return { emailed: false, skipped: "The outside review needs at least one file, and this round has none" };
  }
  try {
    return await createAndDeliverReview(
      ctx,
      {
        taskId: input.taskId,
        attachmentIds: input.attachmentIds,
        recipientEmail: plan.reviewer.email,
        recipientName: plan.reviewer.name,
        message: input.finalText ? input.finalText.slice(0, MAX_REVIEW_MESSAGE) : null,
      },
      { remember: false },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return { emailed: false, skipped: message ? `The outside review wasn’t sent: ${message}` : "The outside review wasn’t sent" };
  }
}
