// Nov 10 batch 36 (Avi's answer 1): one automatic reminder email to an external reviewer 24 hours after a
// review check was sent, if they haven't answered. Run by the cron route with the service role (the
// delivery kick wakes it when one is due). The database picks the due rounds and hands back a fresh
// reminder link for each (only its hash is stored; the first email's link keeps working), so the link is
// emailed straight away and never waits in a table task readers can see — like every review email.
// Nothing here is about the internal approval: approvers get their own reminders in the Inbox.
import "server-only";
import type { ApiContext } from "@alhc/core/api/core/context";
import { claimReviewNudges, finishReviewNudge } from "@alhc/core/api/system/mutations";
import { sendEmailNow } from "@/lib/email";
import { backgroundOrigin } from "@/lib/origin";
import { renderReviewEmail } from "@/lib/review-email";

export async function sendReviewNudges(ctx: ApiContext, max = 20) {
  const origin = backgroundOrigin();
  const counts = { claimed: 0, sent: 0, failed: 0 };
  if (!origin) return counts;
  const { data, error } = await claimReviewNudges(ctx, max);
  if (error) {
    // A database without this release's update doesn't have it yet.
    if (error.code !== "PGRST202") console.error("Claiming review reminders failed", error.code);
    return counts;
  }
  for (const nudge of data ?? []) {
    counts.claimed += 1;
    let sent = false;
    try {
      const email = renderReviewEmail({
        origin,
        token: nudge.token,
        round: nudge.round,
        recipientName: nudge.recipient_name,
        senderName: nudge.sender_name?.trim() || "The team",
        taskTitle: nudge.task_title ?? "A request",
        projectName: nudge.project_name,
        message: nudge.message,
        assets: (Array.isArray(nudge.files) ? nudge.files : []).map((f) => ({
          assetId: f.asset_id,
          name: f.name,
          contentType: f.content_type,
        })),
        reminder: true,
      });
      await sendEmailNow(nudge.recipient_email, email, "review reminder", `review-nudge-${nudge.review_id}`);
      sent = true;
      counts.sent += 1;
    } catch (e) {
      counts.failed += 1;
      console.error("Review reminder failed", e instanceof Error ? e.message.slice(0, 80) : "error");
    }
    await finishReviewNudge(ctx, nudge.review_id, sent);
  }
  return counts;
}
