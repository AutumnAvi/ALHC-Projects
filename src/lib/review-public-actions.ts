"use server";

// Oct 26 notes (batch 3): the public review page's Server Actions. No sign-in: each one checks only the
// link's token, through the anon-callable database functions (review_check_*), which look up the token's
// hash, refuse expired / replaced / closed links, and count every request toward 600 an hour per link.
// They run with a cookie-less anon client, never the visitor's session. The service role is used for one
// thing only: a one-time upload link (and removing a refused upload) for exactly the storage path the
// database handed back for this token — the private bucket has no anon write path.

import { createAdminClient } from "@/lib/supabase/admin";
import { createAnonServerClient } from "@/lib/supabase/anon-server";
import { ATTACHMENTS_BUCKET } from "@/lib/attachments";
import { isUuid } from "@/lib/ids";
import {
  MAX_PIN_TEXT,
  MAX_REVIEW_NOTE,
  MAX_REVIEW_PINS,
  REVIEW_REFUSALS,
  isReviewStatus,
  isReviewToken,
  parseReviewFiles,
  reviewUploadProblem,
  type ReviewDecision,
  type ReviewFile,
  type ReviewStatus,
} from "@/lib/review-checks";

type Answer = { status?: string; review_status?: string; file_id?: string; path?: string; file?: unknown };

const NOT_SET_UP = "Reviews aren’t set up on this site yet.";
const refusal = (status: string | undefined) => REVIEW_REFUSALS[status ?? ""] ?? "Something went wrong. Try again.";

async function call(
  name: "review_check_decide" | "review_check_upload_start" | "review_check_upload_finish" | "review_check_save",
  args: Record<string, unknown>,
) {
  const supabase = createAnonServerClient();
  if (!supabase) return { error: NOT_SET_UP };
  const { data, error } = await supabase.rpc(name, args as never);
  if (error) {
    console.error("Review page:", name, error.code);
    return { error: error.code === "PGRST202" ? NOT_SET_UP : "Something went wrong. Try again." };
  }
  return { answer: (data ?? {}) as Answer };
}

export type DraftPin = { assetId: string; page?: number | null; x?: number | null; y?: number | null; time?: number | null; body: string };

export async function submitReviewDecision(
  token: string,
  decision: "approved" | "changes_requested",
  note: string,
  pins: DraftPin[],
): Promise<{ error?: string; status?: ReviewStatus }> {
  if (!isReviewToken(token)) return { error: refusal("unknown") };
  if (decision !== "approved" && decision !== "changes_requested") return { error: refusal("invalid") };
  if (!Array.isArray(pins) || pins.length > MAX_REVIEW_PINS) return { error: refusal("invalid") };
  const clean = pins.map((p) => ({
    asset_id: isUuid(p.assetId) ? p.assetId : null,
    page: typeof p.page === "number" ? Math.round(p.page) : null,
    x: typeof p.x === "number" ? p.x : null,
    y: typeof p.y === "number" ? p.y : null,
    time: typeof p.time === "number" ? p.time : null,
    body: typeof p.body === "string" ? p.body.trim().slice(0, MAX_PIN_TEXT) : "",
  }));
  const result = await call("review_check_decide", {
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

export async function startReviewUpload(
  token: string,
  file: { name: string; type: string; size: number },
): Promise<{ error?: string; fileId?: string; path?: string; uploadToken?: string }> {
  if (!isReviewToken(token)) return { error: refusal("unknown") };
  const problem = reviewUploadProblem(file);
  if (problem) return { error: problem };
  const admin = createAdminClient();
  if (!admin) return { error: NOT_SET_UP };
  const result = await call("review_check_upload_start", {
    review_token: token,
    file_name: file.name.slice(0, 255),
    file_type: file.type.slice(0, 255),
    file_size: file.size,
  });
  if (result.error) return { error: result.error };
  const answer = result.answer!;
  if (answer.status !== "ok" || !answer.path || !isUuid(answer.file_id)) return { error: refusal(answer.status) };
  const signed = await admin.storage.from(ATTACHMENTS_BUCKET).createSignedUploadUrl(answer.path);
  if (signed.error || !signed.data) return { error: "Couldn’t start the upload. Try again." };
  return { fileId: answer.file_id, path: answer.path, uploadToken: signed.data.token };
}

export async function finishReviewUpload(token: string, fileId: string): Promise<{ error?: string; file?: ReviewFile }> {
  if (!isReviewToken(token) || !isUuid(fileId)) return { error: refusal("unknown") };
  const result = await call("review_check_upload_finish", { review_token: token, target_file: fileId });
  if (result.error) return { error: result.error };
  const answer = result.answer!;
  if (answer.status !== "ok") {
    // A file Storage took but the database refused (too large, or a blocked type) doesn't stay in the
    // task's folder.
    if ((answer.status === "too_large" || answer.status === "blocked_type") && answer.path) {
      await createAdminClient()?.storage.from(ATTACHMENTS_BUCKET).remove([answer.path]);
    }
    return { error: refusal(answer.status) };
  }
  const [file] = parseReviewFiles([answer.file]);
  return file ? { file } : { error: refusal("missing") };
}

// Oct 27 notes (batch 5): the reviewer's progress, saved as they go (pins, the note, the answer they picked,
// the file they're on), so leaving the page loses nothing; and / or "they closed the walkthrough". Only the
// token decides (review_check_save: open rounds only, pins on this round's files only, its own rate limit).
export type ReviewProgress = {
  pins: DraftPin[];
  note: string;
  decision: ReviewDecision | null;
  activeAsset: string | null;
};

export async function saveReviewProgress(
  token: string,
  progress: ReviewProgress | null,
  walkthroughSeen = false,
): Promise<{ error?: string; status?: string; savedAt?: string }> {
  if (!isReviewToken(token)) return { error: refusal("unknown"), status: "unknown" };
  let clean: Record<string, unknown> | null = null;
  if (progress) {
    if (!Array.isArray(progress.pins) || progress.pins.length > MAX_REVIEW_PINS) return { error: refusal("invalid"), status: "invalid" };
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
    };
  }
  const result = await call("review_check_save", { review_token: token, progress: clean, walkthrough_seen: walkthroughSeen });
  if (result.error) return { error: result.error };
  const answer = result.answer as Answer & { saved_at?: string };
  if (answer.status !== "ok") return { error: refusal(answer.status), status: answer.status };
  return { status: "ok", savedAt: typeof answer.saved_at === "string" ? answer.saved_at : undefined };
}
