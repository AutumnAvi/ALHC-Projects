// Big move 1: the reviews area's reads (review checks, Oct 26 notes, batch 3). Signed-in reads go through
// the person's own client (RLS: the task's Viewers+). The public review page's reads take a cookie-less
// anon context: the anon-callable review_check_* functions check only the link's token (its hash, expiry,
// 600 requests an hour), and a file's link is signed by a separate context the caller hands in (the
// service role on the public page, for exactly the storage path the database returned for the token —
// the private bucket has no anon read path). No Next.js here.
import { getViewer } from "@/lib/api/auth/queries";
import { listAttachmentFiles, signedFileUrl } from "@/lib/api/attachments/queries";
import type { ApiContext } from "@/lib/api/core/context";
import type { ReturnedReviewFile, ReviewEmailDetails, ReviewFileLink, RoundAsset } from "@/lib/api/reviews/model";
import { isUuid } from "@/lib/ids";
import {
  isReviewStatus,
  isReviewToken,
  parsePublicReview,
  parseReviewFiles,
  type PublicReviewResult,
  type ReviewPin,
  type TaskReviewRound,
} from "@/lib/review-checks";

// ---------------------------------------------------------------------------------------------
// Signed in: the task's Reviews tab and the sender's email
// ---------------------------------------------------------------------------------------------

// A round's files, in order (a failed read = none).
export async function roundAssets(ctx: ApiContext, reviewId: string): Promise<RoundAsset[]> {
  const { data } = await ctx.db
    .from("review_check_assets")
    .select("id, attachment_id, sort_order")
    .eq("review_id", reviewId)
    .order("sort_order");
  return (data ?? []).map((a) => ({ assetId: a.id, attachmentId: a.attachment_id }));
}

// What the review email needs, read at once with the sender's own client: the task's name, the sender's
// name and address, and the round's files.
export async function reviewEmailDetails(
  ctx: ApiContext,
  taskId: string,
  senderId: string,
  attachmentIds: string[],
): Promise<ReviewEmailDetails> {
  const supabase = ctx.db;
  const [task, sender, attachments] = await Promise.all([
    supabase.from("tasks").select("title, root_task_id").eq("id", taskId).maybeSingle(),
    supabase.from("profiles").select("full_name, email").eq("id", senderId).maybeSingle(),
    listAttachmentFiles(ctx, attachmentIds),
  ]);
  return { task: task.data, sender: sender.data, attachments };
}

// The task's Reviews tab: every round, newest first, with its files, pins, and the reviewer's uploads (RLS:
// the task's Viewers+). Null without this release's database update.
export async function loadTaskReviews(ctx: ApiContext, taskId: string): Promise<TaskReviewRound[] | null> {
  if (!isUuid(taskId)) return [];
  const { user, allowlisted } = await getViewer(ctx);
  if (!user || !allowlisted) return [];
  const supabase = ctx.db;
  const rounds = await supabase
    .from("review_checks")
    .select("id, round, status, recipient_email, recipient_name, message, created_by, created_at, expires_at, decided_at, decision_note, last_viewed_at")
    .eq("task_id", taskId)
    .order("round", { ascending: false });
  if (rounds.error) return rounds.error.code === "PGRST205" || rounds.error.code === "42P01" ? null : [];
  const ids = (rounds.data ?? []).map((r) => r.id);
  if (!ids.length) return [];
  const [assets, pins, files, saved] = await Promise.all([
    supabase.from("review_check_assets").select("id, review_id, attachment_id, sort_order").in("review_id", ids).order("sort_order"),
    supabase
      .from("review_check_pins")
      .select("review_id, asset_id, number, page, x, y, time_seconds, body")
      .in("review_id", ids)
      .order("number"),
    supabase
      .from("review_check_files")
      .select("id, review_id, file_name, content_type, size_bytes")
      .in("review_id", ids)
      .order("created_at"),
    // Oct 27 notes (batch 5): when the reviewer last saved progress (a database without the column: none).
    supabase.from("review_checks").select("id, draft_saved_at").in("id", ids),
  ]);
  const savedAt = new Map((saved.error ? [] : (saved.data ?? [])).map((r) => [r.id, r.draft_saved_at] as const));
  const attachmentIds = [...new Set((assets.data ?? []).map((a) => a.attachment_id))];
  const attachments = attachmentIds.length
    ? await supabase.from("task_attachments").select("id, file_name, content_type, size_bytes").in("id", attachmentIds)
    : { data: [] as { id: string; file_name: string; content_type: string | null; size_bytes: number }[] };
  const attachmentById = new Map((attachments.data ?? []).map((a) => [a.id, a] as const));
  return (rounds.data ?? []).map((r) => ({
    id: r.id,
    round: r.round,
    status: isReviewStatus(r.status) ? r.status : "pending",
    recipientEmail: r.recipient_email,
    recipientName: r.recipient_name,
    message: r.message,
    senderId: r.created_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    decidedAt: r.decided_at,
    decisionNote: r.decision_note,
    lastViewedAt: r.last_viewed_at,
    draftSavedAt: savedAt.get(r.id) ?? null,
    assets: (assets.data ?? [])
      .filter((a) => a.review_id === r.id)
      .flatMap((a) => {
        const file = attachmentById.get(a.attachment_id);
        return file
          ? [{ id: a.id, attachmentId: a.attachment_id, name: file.file_name, contentType: file.content_type, size: file.size_bytes }]
          : [];
      }),
    pins: (pins.data ?? [])
      .filter((p) => p.review_id === r.id)
      .map(
        (p): ReviewPin => ({
          number: p.number,
          assetId: p.asset_id,
          page: p.page,
          x: p.x,
          y: p.y,
          time: p.time_seconds,
          body: p.body,
        }),
      ),
    files: parseReviewFiles(
      (files.data ?? [])
        .filter((f) => f.review_id === r.id)
        .map((f) => ({ id: f.id, name: f.file_name, content_type: f.content_type, size: f.size_bytes })),
    ),
  }));
}

// Oct 26 notes (batch 3): a file a reviewer sent back, for the task's Reviews tab, read with the viewer's
// own client (RLS: Viewer+ on the task, finished uploads only). Null when it's missing or unreadable.
export async function getReturnedReviewFile(ctx: ApiContext, fileId: string): Promise<ReturnedReviewFile | null> {
  const { data: file } = await ctx.db
    .from("review_check_files")
    .select("storage_path, file_name, content_type")
    .eq("id", fileId)
    .maybeSingle();
  return file;
}

// ---------------------------------------------------------------------------------------------
// The public review page (anon, token-checked)
// ---------------------------------------------------------------------------------------------

// The public review page's round: the token in the link is the only key, checked by review_check_view
// (anon; the token's hash, its expiry, 600 requests an hour). Anything that isn't a round says "unknown".
export async function viewPublicReview(anon: ApiContext, token: string): Promise<PublicReviewResult> {
  if (!isReviewToken(token)) return { status: "unknown" };
  const { data, error } = await anon.db.rpc("review_check_view", { review_token: token });
  if (error) {
    console.error("Review page:", error.code);
    return { status: "unknown" };
  }
  return parsePublicReview(data);
}

// One file of a review round, for the public review page (and the email's thumbnail). The anon-callable
// review_check_file checks the link (hash, expiry, 600 requests an hour) and returns the storage path only
// of a file of that round (one of its assets, or one the reviewer sent back); then `signer` (the service
// role) signs a link to exactly that object — the private bucket has no anon read path. Images, PDFs, and
// videos open in the browser when their name, recorded type, and stored type agree; anything else
// downloads. Nothing logs the token.
export async function reviewFileLink(
  anon: ApiContext,
  signer: ApiContext,
  token: string,
  fileId: string,
  options: { download: boolean; seconds: number },
): Promise<ReviewFileLink> {
  if (!isReviewToken(token) || !isUuid(fileId)) return { status: "missing" };
  const { data, error } = await anon.db.rpc("review_check_file", { review_token: token, target_file: fileId });
  if (error) return { status: "error" };
  const answer = (data ?? {}) as { status?: string; path?: string; name?: string; content_type?: string | null };
  if (answer.status === "rate_limited") return { status: "rate_limited" };
  if (answer.status === "expired") return { status: "expired" };
  if (answer.status !== "ok" || !answer.path || !answer.name) return { status: "missing" };
  const url = await signedFileUrl(
    signer,
    { storagePath: answer.path, fileName: answer.name, contentType: answer.content_type ?? null },
    { download: options.download, media: true, seconds: options.seconds },
  );
  return url ? { status: "ok", url } : { status: "unsigned" };
}
