"use server";
// Big move 1: review checks from the task pane (Oct 26 notes, batch 3), thin wrappers around
// packages/core/src/api/reviews/. The person's own client (RLS and the definer RPCs' Editor checks decide; never the
// service role). Sending creates the round in the database (which generates the link's token and keeps
// only its hash), then emails the link straight away with the built-in requester look: the token can't
// wait in the outbox, where task readers can see rows. The email (rendering, sending, the request's
// origin, the thumbnails route) is Next.js work, so it stays here.

import type { ActionResult } from "@alhc/core/api/core/result";
import type { SendReviewResult } from "@alhc/core/api/reviews/model";
import * as reviewsApi from "@alhc/core/api/reviews/mutations";
import * as reviewsQueries from "@alhc/core/api/reviews/queries";
import { requestOrigin } from "@/lib/origin";
import type { TaskReviewRound } from "@alhc/core/review-checks";
import { reviewUrls } from "@/lib/review-email";
import { createAndDeliverReview, deliverReviewRound } from "@/lib/review-send";
import { run, runWith } from "@/lib/server/action";
import { actionContext } from "@/lib/server/context";

// Nov 24 batch 45 (item 5): sending and its email are one shared path (review-send.ts), which retries
// Resend's passing failures, records how it went on the round (the card's sent / failed), and answers
// `emailed`, `emailStatus`, and a plain `reason` when the email didn't go out (plus the link, once).
export async function sendReviewCheck(input: {
  taskId: string;
  attachmentIds: string[];
  recipientEmail: string;
  recipientName?: string | null;
  message?: string | null;
}): Promise<SendReviewResult> {
  return runWith((ctx) => createAndDeliverReview(ctx, input), { deliver: false });
}

// Nov 10 batch 36: set (or clear) the task's intended external reviewer from the approval setup.
export async function saveExternalReviewer(taskId: string, email: string | null, name?: string | null): Promise<ActionResult> {
  return run((ctx) => reviewsApi.setTaskExternalReviewer(ctx, { taskId, email, name }), { deliver: false });
}

// "Send again" (and the card's Retry after a failed email): a new link for an open round (the old one
// stops working) and a new email, through the same path.
export async function resendReviewCheck(reviewId: string): Promise<SendReviewResult> {
  return runWith(async (ctx) => deliverReviewRound(ctx, await reviewsApi.rotateReviewCheck(ctx, reviewId)), { deliver: false });
}

// Nov 24 batch 45: "Copy review link" — the round's own copyable link (the emailed one keeps working;
// copying again replaces the previous copied link). Editors and whoever may send the round.
export async function copyReviewLink(reviewId: string): Promise<ActionResult & { link?: string }> {
  return runWith(
    async (ctx) => ({ link: reviewUrls(await requestOrigin(), await reviewsApi.copyReviewLink(ctx, reviewId)).page }),
    { deliver: false, refresh: false },
  );
}

export async function withdrawReviewCheck(reviewId: string): Promise<ActionResult> {
  return run((ctx) => reviewsApi.cancelReviewCheck(ctx, reviewId), { deliver: false });
}

// The task's Reviews tab: every round, newest first, with its files, pins, and the reviewer's uploads (RLS:
// the task's Viewers+). Null without this release's database update.
export async function loadTaskReviews(taskId: string): Promise<TaskReviewRound[] | null> {
  return reviewsQueries.loadTaskReviews(await actionContext(), taskId);
}
