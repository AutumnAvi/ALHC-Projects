// Big move 1: the background work's writes (packages/core/src/api/system/): outbox claims and completions, the
// scheduler's tick, trash purges and stale form uploads in Storage, forwarded emails, submitter replies,
// and Resend's delivery events. Called with the context the adapter chose — the service role in the
// drains, the cron route, and the verified inbound email webhook — never to serve a person's request.
// The callers branch on what the database said (DbAnswer) exactly as before. No Next.js here.
import type { ApiContext } from "../core/context";
import type { DbErrorDetail } from "../core/errors";
import type { DbAnswer, EmailOutboxRow, IntegrationOutboxRow, TrashStoragePurge } from "./model";
import { ATTACHMENTS_BUCKET } from "../../attachments";
import type { Json } from "../../supabase/database.types";

type Claim = { max: number; onlyId: string | null };

// ---------------------------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------------------------

// Due delayed rule actions and due-date rules (workflow_tick).
export async function workflowTick(ctx: ApiContext): Promise<DbAnswer<Json>> {
  return await ctx.db.rpc("workflow_tick");
}

// Due Inbox digests and scheduled reports (alhc_queue_scheduled_emails, Real features 3).
export async function queueScheduledEmails(ctx: ApiContext): Promise<DbAnswer<Json>> {
  return await ctx.db.rpc("alhc_queue_scheduled_emails");
}

// ---------------------------------------------------------------------------------------------
// The email outbox
// ---------------------------------------------------------------------------------------------

export async function claimEmailDeliveries(ctx: ApiContext, claim: Claim): Promise<DbAnswer<EmailOutboxRow[]>> {
  return await ctx.db.rpc("claim_email_deliveries", { max_items: claim.max, only_id: claim.onlyId });
}

export async function claimNotificationEmails(ctx: ApiContext, claim: Claim): Promise<DbAnswer<EmailOutboxRow[]>> {
  return await ctx.db.rpc("claim_notification_emails", { max_items: claim.max, only_id: claim.onlyId });
}

export async function claimScheduledEmails(ctx: ApiContext, claim: Claim): Promise<DbAnswer<EmailOutboxRow[]>> {
  return await ctx.db.rpc("claim_scheduled_emails", { max_items: claim.max, only_id: claim.onlyId });
}

export async function completeEmailOutbox(
  ctx: ApiContext,
  input: { emailId: string; outcome: string; messageId: string | null; errorMessage: string | null },
): Promise<void> {
  await ctx.db.rpc("complete_email_outbox", {
    target_email: input.emailId,
    outcome: input.outcome,
    message_id: input.messageId,
    error_message: input.errorMessage,
  });
}

// ---------------------------------------------------------------------------------------------
// The integration outbox
// ---------------------------------------------------------------------------------------------

export async function claimIntegrationOutbox(ctx: ApiContext, claim: Claim): Promise<DbAnswer<IntegrationOutboxRow[]>> {
  return await ctx.db.rpc("claim_integration_outbox", { max_items: claim.max, only_id: claim.onlyId });
}

export async function completeIntegrationOutbox(
  ctx: ApiContext,
  input: { itemId: string; outcome: string; response: Json | null; errorMessage: string | null },
): Promise<void> {
  await ctx.db.rpc("complete_integration_outbox", {
    target_item: input.itemId,
    outcome: input.outcome,
    response: input.response,
    error_message: input.errorMessage,
  });
}

// ---------------------------------------------------------------------------------------------
// Storage: the Trash purge's files, stale form uploads, received attachments
// ---------------------------------------------------------------------------------------------

// Nov 1 notes, item 66: files the daily Trash purge queued (claim_trash_storage_purges, service role).
export async function claimTrashStoragePurges(ctx: ApiContext, max: number): Promise<DbAnswer<TrashStoragePurge[]>> {
  return await ctx.db.rpc("claim_trash_storage_purges", { max_items: max });
}

export async function finishTrashStoragePurge(
  ctx: ApiContext,
  input: { target: string; removedCount: number; errorMessage: string | null },
): Promise<void> {
  await ctx.db.rpc("finish_trash_storage_purge", {
    target: input.target,
    removed_count: input.removedCount,
    error_message: input.errorMessage,
  });
}

// Removes objects from a bucket: how many Storage removed, or null when it refused.
export async function removeStorageObjects(ctx: ApiContext, bucket: string, paths: string[]): Promise<number | null> {
  const result = await ctx.db.storage.from(bucket).remove(paths);
  if (result.error) return null;
  return result.data?.length ?? 0;
}

// Stores a received file in the private task-attachments bucket (never over an existing object): false
// when Storage refused.
export async function uploadAttachmentFile(
  ctx: ApiContext,
  path: string,
  bytes: Uint8Array,
  contentType: string | null,
): Promise<boolean> {
  const uploaded = await ctx.db.storage
    .from(ATTACHMENTS_BUCKET)
    .upload(path, bytes, { contentType: contentType ?? undefined, upsert: false });
  return !uploaded.error;
}

type ReceivedFileRecord = { path: string; name: string; type: string | null; size: number };

// A forwarded email's file, recorded as the person (attach_forwarded_file): what the database said when
// it refused, else null.
export async function attachForwardedFile(
  ctx: ApiContext,
  forwardId: string,
  file: ReceivedFileRecord,
): Promise<DbErrorDetail | null> {
  const { error } = await ctx.db.rpc("attach_forwarded_file", {
    target_forward: forwardId,
    file_path: file.path,
    file_name: file.name,
    file_type: file.type,
    file_size: file.size,
  });
  return error;
}

// A submitter's emailed reply's file, linked on the reply comment (attach_reply_file).
export async function attachReplyFile(
  ctx: ApiContext,
  commentId: string,
  file: ReceivedFileRecord,
): Promise<DbErrorDetail | null> {
  const { error } = await ctx.db.rpc("attach_reply_file", {
    target_comment: commentId,
    file_path: file.path,
    file_name: file.name,
    file_type: file.type,
    file_size: file.size,
  });
  return error;
}

// The reply's files that weren't saved, with why, noted on the comment (note_reply_skipped_files).
export async function noteReplySkippedFiles(ctx: ApiContext, commentId: string, files: Json): Promise<DbErrorDetail | null> {
  const { error } = await ctx.db.rpc("note_reply_skipped_files", { target_comment: commentId, files });
  return error;
}

// ---------------------------------------------------------------------------------------------
// The verified inbound email webhook
// ---------------------------------------------------------------------------------------------

// A form submitter's emailed reply (post_submitter_reply, service role only).
export async function postSubmitterReply(
  ctx: ApiContext,
  input: { token: string; sender: string; body: string; emailId: string },
): Promise<DbAnswer<Json>> {
  return await ctx.db.rpc("post_submitter_reply", {
    reply_token: input.token,
    sender_email: input.sender,
    reply_body: input.body,
    provider_email_id: input.emailId,
  });
}

// A forwarded email becomes the person's task (post_email_forward, service role only).
export async function postEmailForward(
  ctx: ApiContext,
  input: { token: string; sender: string; verified: boolean; subject: string; body: string; emailId: string },
): Promise<DbAnswer<Json>> {
  return await ctx.db.rpc("post_email_forward", {
    forward_token: input.token,
    sender_email: input.sender,
    sender_verified: input.verified,
    email_subject: input.subject,
    email_body: input.body,
    provider_email_id: input.emailId,
  });
}

// A Resend delivery event on the outbox row it belongs to (record_email_event, service role only).
export async function recordEmailEvent(
  ctx: ApiContext,
  input: {
    emailId: string;
    type: string;
    eventTime: string | null;
    bounceType: string | null;
    bounceSubtype: string | null;
  },
): Promise<DbAnswer<Json>> {
  return await ctx.db.rpc("record_email_event", {
    provider_email_id: input.emailId,
    event_type: input.type,
    event_time: input.eventTime,
    bounce_type: input.bounceType,
    bounce_subtype: input.bounceSubtype,
  });
}

// ---------------------------------------------------------------------------------------------
// External review reminders (Nov 10 batch 36)
// ---------------------------------------------------------------------------------------------

// A round due its one automatic reminder (24 hours after it was sent, still undecided), with a fresh
// reminder link (the token is handed back once; the first email's link keeps working).
export type ReviewNudge = {
  review_id: string;
  task_id: string;
  token: string;
  recipient_email: string;
  recipient_name: string | null;
  round: number;
  message: string | null;
  task_title: string | null;
  sender_name: string | null;
  project_name: string | null;
  sent_at: string;
  expires_at: string;
  files: { asset_id: string; name: string; content_type: string | null }[] | null;
};

export async function claimReviewNudges(ctx: ApiContext, max: number): Promise<DbAnswer<ReviewNudge[]>> {
  const { data, error } = await ctx.db.rpc("claim_review_nudges", { max_items: max });
  return { data: (data as unknown as ReviewNudge[] | null) ?? null, error };
}

export async function finishReviewNudge(ctx: ApiContext, reviewId: string, sent: boolean): Promise<void> {
  await ctx.db.rpc("finish_review_nudge", { target_review: reviewId, sent });
}
