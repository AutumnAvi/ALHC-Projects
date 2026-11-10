// Big move 1: the reviews area's writes (review checks, Oct 26 notes, batch 3). No Next.js here.
//
// Signed in (the task pane): the person's own client; RLS and the definer RPCs' Editor checks decide,
// never the service role. Sending creates the round in the database, which generates the link's token and
// keeps only its hash; the caller emails the link straight away (the token can't wait in the outbox,
// where task readers can see rows).
//
// The public review page: no sign-in. Each write checks only the link's token, through the anon-callable
// database functions (review_check_*), which look up the token's hash, refuse expired / replaced / closed
// links, and count every request toward 600 an hour per link. They run with a cookie-less anon context,
// never the visitor's session. The service role is used for one thing only: a one-time upload link (and
// removing a refused upload) for exactly the storage path the database handed back for this token — the
// private bucket has no anon write path. Those functions answer their result (an error message to show,
// a status) instead of throwing, and take a null context where the site has no Supabase set up: they say
// so only after their own input checks, as the page always did.
import { removeObjects, signedUploadToken } from "../attachments/mutations";
import type { ApiContext } from "../core/context";
import { ApiError, codeOf, invalid, notFound, type DbErrorDetail } from "../core/errors";
import { id } from "../core/validate";
import type { DraftPin, ReviewProgress, ReviewRoundLink } from "./model";
import { isUuid } from "../../ids";
import {
  MAX_PIN_TEXT,
  MAX_REVIEW_ASSETS,
  MAX_REVIEW_MESSAGE,
  MAX_REVIEW_NOTE,
  MAX_REVIEW_PINS,
  REVIEW_LINK_DAYS,
  REVIEW_REFUSALS,
  isReviewStatus,
  isReviewToken,
  parseReviewFiles,
  parseRoundProject,
  reviewUploadProblem,
  type ReviewFile,
  type ReviewStatus,
} from "../../review-checks";

// ---------------------------------------------------------------------------------------------
// Signed in: send, send again, withdraw
// ---------------------------------------------------------------------------------------------

const EMAIL = /^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$/;
const UNAVAILABLE = "Review checks need this release’s database update";

function reviewError(error: DbErrorDetail & { message: string }): ApiError {
  if (error.code === "PGRST202") return new ApiError("not_deployed", UNAVAILABLE, error);
  return new ApiError(codeOf(error), error.hint ? `${error.message}. ${error.hint}` : error.message, error);
}

// The link's expiry as the database returned it (30 days from now otherwise).
function expiryOf(value: unknown): Date {
  const parsed = typeof value === "string" ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date(Date.now() + REVIEW_LINK_DAYS * 86_400_000);
}

// A new round of these files for a reviewer (create_review_check: Editor+ on the task; an open earlier
// round is superseded). Answers what the sender's email needs.
export async function createReviewCheck(
  ctx: ApiContext,
  input: {
    taskId: string;
    attachmentIds: string[];
    recipientEmail: string;
    recipientName?: string | null;
    message?: string | null;
  },
): Promise<ReviewRoundLink> {
  const taskId = id(input.taskId, "task");
  const ids = [...new Set(input.attachmentIds)].filter(isUuid);
  if (!ids.length) throw invalid("Pick at least one file to review");
  if (ids.length > MAX_REVIEW_ASSETS) throw invalid(`Pick at most ${MAX_REVIEW_ASSETS} files`);
  const email = input.recipientEmail.trim().toLowerCase();
  if (!EMAIL.test(email)) throw invalid("Enter the reviewer’s email address");
  const message = input.message?.trim() || null;
  if (message && message.length > MAX_REVIEW_MESSAGE) throw invalid("The message is too long");
  const { data, error } = await ctx.db.rpc("create_review_check", {
    target_task: taskId,
    attachment_ids: ids,
    recipient: email,
    recipient_display: input.recipientName?.trim() || null,
    review_message: message,
  });
  if (error) throw reviewError(error);
  const created = data as { id?: string; round?: number; token?: string; suppressed?: boolean; expires_at?: string } | null;
  if (!created?.id || !isReviewToken(created.token)) throw new ApiError("failed", "Couldn’t create the review check");
  return {
    reviewId: created.id,
    taskId,
    round: created.round,
    token: created.token,
    suppressed: Boolean(created.suppressed),
    recipientEmail: email,
    recipientName: input.recipientName?.trim() || null,
    message,
    expiresAt: expiryOf(created.expires_at),
    project: parseRoundProject(created),
  };
}

// "Send again": a new link for an open round (the old one stops working), for a new email.
export async function rotateReviewCheck(ctx: ApiContext, reviewId: string): Promise<ReviewRoundLink> {
  id(reviewId, "review check");
  const supabase = ctx.db;
  const { data: review } = await supabase
    .from("review_checks")
    .select("id, task_id, round, recipient_email, recipient_name, message")
    .eq("id", reviewId)
    .maybeSingle();
  if (!review) throw notFound("Review check not found");
  const { data, error } = await supabase.rpc("rotate_review_check_token", { target_review: reviewId });
  if (error) throw reviewError(error);
  const rotated = data as { token?: string; suppressed?: boolean; expires_at?: string } | null;
  const token = rotated?.token;
  if (!isReviewToken(token)) throw new ApiError("failed", "Couldn’t make a new link");
  return {
    reviewId,
    taskId: review.task_id,
    round: review.round,
    token,
    suppressed: Boolean(rotated?.suppressed),
    recipientEmail: review.recipient_email,
    recipientName: review.recipient_name,
    message: review.message,
    expiresAt: expiryOf(rotated?.expires_at),
    project: parseRoundProject(rotated),
  };
}

// Nov 10 batch 36: who the task's external review is meant for, set ahead (approval setup) or remembered
// from a send (set_task_external_reviewer: invoker, Editors+ by RLS). A null address clears it.
export async function setTaskExternalReviewer(
  ctx: ApiContext,
  input: { taskId: string; email: string | null; name?: string | null },
): Promise<void> {
  const taskId = id(input.taskId, "task");
  const email = input.email?.trim().toLowerCase() || null;
  if (email && !EMAIL.test(email)) throw invalid("Enter the reviewer’s email address");
  const { error } = await ctx.db.rpc("set_task_external_reviewer", {
    target_task: taskId,
    reviewer: email,
    reviewer_display: email ? input.name?.trim() || null : null,
  });
  if (error) throw reviewError(error);
}

// Withdraw an open round (cancel_review_check: its link stops working).
export async function cancelReviewCheck(ctx: ApiContext, reviewId: string): Promise<void> {
  id(reviewId, "review check");
  const { error } = await ctx.db.rpc("cancel_review_check", { target_review: reviewId });
  if (error) throw reviewError(error);
}

// ---------------------------------------------------------------------------------------------
// The public review page (anon, token-checked)
// ---------------------------------------------------------------------------------------------

type Answer = { status?: string; review_status?: string; file_id?: string; path?: string; file?: unknown };

const NOT_SET_UP = "Reviews aren’t set up on this site yet.";
const refusal = (status: string | undefined) => REVIEW_REFUSALS[status ?? ""] ?? "Something went wrong. Try again.";

// `anon` null = Supabase isn't set up on this site.
async function call(
  anon: ApiContext | null,
  name: "review_check_decide" | "review_check_upload_start" | "review_check_upload_finish" | "review_check_save",
  args: Record<string, unknown>,
) {
  if (!anon) return { error: NOT_SET_UP };
  const { data, error } = await anon.db.rpc(name, args as never);
  if (error) {
    console.error("Review page:", name, error.code);
    return { error: error.code === "PGRST202" ? NOT_SET_UP : "Something went wrong. Try again." };
  }
  return { answer: (data ?? {}) as Answer };
}

// Nov 1 notes (batch 8): the page reviews file by file, so the answer goes with the reviewer's final
// progress (each file's approval and note). It's saved first (review_check_save, per_file), then
// review_check_decide checks that saved draft: every file approved or with feedback, and the answer the one
// they add up to — refused otherwise, however the answer was sent. Without progress (the page of the
// release before) the answer is checked the old way.
export async function submitReviewDecision(
  anon: ApiContext | null,
  token: string,
  decision: "approved" | "changes_requested",
  note: string,
  pins: DraftPin[],
  progress: ReviewProgress | null = null,
): Promise<{ error?: string; status?: ReviewStatus }> {
  if (!isReviewToken(token)) return { error: refusal("unknown") };
  if (decision !== "approved" && decision !== "changes_requested") return { error: refusal("invalid") };
  if (!Array.isArray(pins) || pins.length > MAX_REVIEW_PINS) return { error: refusal("invalid") };
  if (progress) {
    if (progress.decision !== decision) return { error: refusal("mismatch") };
    const saved = await saveReviewProgress(anon, token, progress);
    if (saved.error) return { error: saved.error };
  }
  const clean = pins.map((p) => ({
    asset_id: isUuid(p.assetId) ? p.assetId : null,
    page: typeof p.page === "number" ? Math.round(p.page) : null,
    x: typeof p.x === "number" ? p.x : null,
    y: typeof p.y === "number" ? p.y : null,
    time: typeof p.time === "number" ? p.time : null,
    body: typeof p.body === "string" ? p.body.trim().slice(0, MAX_PIN_TEXT) : "",
  }));
  const result = await call(anon, "review_check_decide", {
    review_token: token,
    decision,
    note: typeof note === "string" ? note.trim().slice(0, MAX_REVIEW_NOTE) || null : null,
    pins: clean,
  });
  if (result.error) return { error: result.error };
  const answer = result.answer!;
  if (answer.status !== "ok") return { error: refusal(answer.status) };
  return { status: isReviewStatus(answer.review_status) ? answer.review_status : decision };
}

// `signer` (the service role; null when this site has none) signs the one-time upload link for exactly
// the path the database returned for this token.
export async function startReviewUpload(
  anon: ApiContext | null,
  signer: ApiContext | null,
  token: string,
  file: { name: string; type: string; size: number },
): Promise<{ error?: string; fileId?: string; path?: string; uploadToken?: string }> {
  if (!isReviewToken(token)) return { error: refusal("unknown") };
  const problem = reviewUploadProblem(file);
  if (problem) return { error: problem };
  if (!signer) return { error: NOT_SET_UP };
  const result = await call(anon, "review_check_upload_start", {
    review_token: token,
    file_name: file.name.slice(0, 255),
    file_type: file.type.slice(0, 255),
    file_size: file.size,
  });
  if (result.error) return { error: result.error };
  const answer = result.answer!;
  if (answer.status !== "ok" || !answer.path || !isUuid(answer.file_id)) return { error: refusal(answer.status) };
  const uploadToken = await signedUploadToken(signer, answer.path);
  if (!uploadToken) return { error: "Couldn’t start the upload. Try again." };
  return { fileId: answer.file_id, path: answer.path, uploadToken };
}

// `signer` (the service role; null when this site has none) removes only the path the database returned
// for this token, when the database refused the file.
export async function finishReviewUpload(
  anon: ApiContext | null,
  signer: ApiContext | null,
  token: string,
  fileId: string,
): Promise<{ error?: string; file?: ReviewFile }> {
  if (!isReviewToken(token) || !isUuid(fileId)) return { error: refusal("unknown") };
  const result = await call(anon, "review_check_upload_finish", { review_token: token, target_file: fileId });
  if (result.error) return { error: result.error };
  const answer = result.answer!;
  if (answer.status !== "ok") {
    // A file Storage took but the database refused (too large, or a blocked type) doesn't stay in the
    // task's folder.
    if ((answer.status === "too_large" || answer.status === "blocked_type") && answer.path) {
      if (signer) await removeObjects(signer, [answer.path]);
    }
    return { error: refusal(answer.status) };
  }
  const [file] = parseReviewFiles([answer.file]);
  return file ? { file } : { error: refusal("missing") };
}

// Oct 27 notes (batch 5): the reviewer's progress, saved as they go (see ReviewProgress); and / or "they
// closed the walkthrough".
export async function saveReviewProgress(
  anon: ApiContext | null,
  token: string,
  progress: ReviewProgress | null,
  walkthroughSeen = false,
): Promise<{ error?: string; status?: string; savedAt?: string }> {
  if (!isReviewToken(token)) return { error: refusal("unknown"), status: "unknown" };
  let clean: Record<string, unknown> | null = null;
  if (progress) {
    if (!Array.isArray(progress.pins) || progress.pins.length > MAX_REVIEW_PINS) return { error: refusal("invalid"), status: "invalid" };
    const files = Array.isArray(progress.files) ? progress.files : [];
    if (files.length > MAX_REVIEW_PINS) return { error: refusal("invalid"), status: "invalid" };
    clean = {
      pins: progress.pins.flatMap((p) =>
        isUuid(p?.assetId)
          ? [
              {
                asset_id: p.assetId,
                page: typeof p.page === "number" ? Math.round(p.page) : null,
                x: typeof p.x === "number" ? p.x : null,
                y: typeof p.y === "number" ? p.y : null,
                time: typeof p.time === "number" ? p.time : null,
                body: typeof p.body === "string" ? p.body.slice(0, MAX_PIN_TEXT) : "",
              },
            ]
          : [],
      ),
      note: typeof progress.note === "string" ? progress.note.slice(0, MAX_REVIEW_NOTE) : "",
      decision: progress.decision === "approved" || progress.decision === "changes_requested" ? progress.decision : null,
      active_asset: isUuid(progress.activeAsset) ? progress.activeAsset : null,
      ...(progress.perFile === true
        ? {
            per_file: true,
            files: files.flatMap((f) =>
              isUuid(f?.assetId)
                ? [{ asset_id: f.assetId, approved: f.approved === true, note: typeof f.note === "string" ? f.note.slice(0, MAX_PIN_TEXT) : "" }]
                : [],
            ),
          }
        : {}),
    };
  }
  const result = await call(anon, "review_check_save", { review_token: token, progress: clean, walkthrough_seen: walkthroughSeen });
  if (result.error) return { error: result.error };
  const answer = result.answer as Answer & { saved_at?: string };
  if (answer.status !== "ok") return { error: refusal(answer.status), status: answer.status };
  return { status: "ok", savedAt: typeof answer.saved_at === "string" ? answer.saved_at : undefined };
}
