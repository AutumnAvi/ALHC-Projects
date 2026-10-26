"use server";

// Oct 26 notes (batch 3): review checks from the task pane, with the signed-in person's own client (RLS and
// the definer RPCs' Editor checks decide; never the service role). Sending creates the round in the
// database (which generates the link's token and keeps only its hash), then emails the link straight away
// with the requester design: the token can't wait in the outbox, where task readers can see rows.

import { refresh } from "next/cache";
import { getViewer } from "@/lib/auth";
import { sendEmailNow } from "@/lib/email";
import { isUuid } from "@/lib/ids";
import { requestOrigin } from "@/lib/origin";
import {
  MAX_REVIEW_ASSETS,
  MAX_REVIEW_MESSAGE,
  isReviewStatus,
  isReviewToken,
  parseReviewFiles,
  type ReviewPin,
  type TaskReviewRound,
} from "@/lib/review-checks";
import { reviewUrls, renderReviewEmail } from "@/lib/review-email";
import { createClient } from "@/lib/supabase/server";

type Supabase = Awaited<ReturnType<typeof createClient>>;

export type SendReviewResult = {
  error?: string;
  round?: number;
  // The email went out (false: no email provider here, or sending failed).
  emailed?: boolean;
  // Only when the email didn't go out: the link, shown once so the sender can pass it on themselves.
  link?: string;
};

const EMAIL = /^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$/;
const UNAVAILABLE = "Review checks need this release’s database update";

function dbError(error: { code?: string; message: string; hint?: string | null }): string {
  if (error.code === "PGRST202") return UNAVAILABLE;
  return error.hint ? `${error.message}. ${error.hint}` : error.message;
}

async function emailRound(
  supabase: Supabase,
  taskId: string,
  review: { round: number; token: string; recipientEmail: string; recipientName: string | null; message: string | null },
  assetIds: { assetId: string; attachmentId: string }[],
): Promise<{ emailed: boolean; link?: string }> {
  const origin = await requestOrigin();
  const urls = reviewUrls(origin, review.token);
  try {
    const { user } = await getViewer();
    const [task, sender, attachments] = await Promise.all([
      supabase.from("tasks").select("title, home_project_id, root_task_id").eq("id", taskId).maybeSingle(),
      supabase.from("profiles").select("full_name, email").eq("id", user?.id ?? "").maybeSingle(),
      supabase.from("task_attachments").select("id, file_name, content_type").in("id", assetIds.map((a) => a.attachmentId)),
    ]);
    const rootId = task.data?.root_task_id ?? taskId;
    const root = rootId === taskId ? task.data : (await supabase.from("tasks").select("home_project_id").eq("id", rootId).maybeSingle()).data;
    const projectId = root?.home_project_id ?? null;
    const [project, form] = await Promise.all([
      projectId ? supabase.from("projects").select("name").eq("id", projectId).maybeSingle() : Promise.resolve({ data: null }),
      supabase.from("form_submissions").select("form_id").eq("task_id", rootId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    const design = projectId
      ? await supabase.rpc("resolve_email_design", {
          design_kind: "requester",
          target_project: projectId,
          target_form: form.data?.form_id ?? undefined,
        })
      : { data: null };
    const byId = new Map((attachments.data ?? []).map((a) => [a.id, a] as const));
    const email = renderReviewEmail({
      origin,
      token: review.token,
      round: review.round,
      recipientName: review.recipientName,
      senderName: sender.data?.full_name?.trim() || sender.data?.email || "Someone",
      taskTitle: task.data?.title ?? "A request",
      projectName: project.data?.name ?? null,
      message: review.message,
      assets: assetIds.flatMap(({ assetId, attachmentId }) => {
        const a = byId.get(attachmentId);
        return a ? [{ assetId, name: a.file_name, contentType: a.content_type }] : [];
      }),
      design: design.data ?? null,
    });
    const outcome = await sendEmailNow(review.recipientEmail, email, "review check");
    return outcome === "sent" ? { emailed: true } : { emailed: false, link: urls.page };
  } catch (error) {
    console.error("Review check email failed", error instanceof Error ? error.message.slice(0, 80) : "error");
    return { emailed: false, link: urls.page };
  }
}

async function roundAssets(supabase: Supabase, reviewId: string) {
  const { data } = await supabase
    .from("review_check_assets")
    .select("id, attachment_id, sort_order")
    .eq("review_id", reviewId)
    .order("sort_order");
  return (data ?? []).map((a) => ({ assetId: a.id, attachmentId: a.attachment_id }));
}

export async function sendReviewCheck(input: {
  taskId: string;
  attachmentIds: string[];
  recipientEmail: string;
  recipientName?: string | null;
  message?: string | null;
}): Promise<SendReviewResult> {
  if (!isUuid(input.taskId)) return { error: "Invalid task" };
  const ids = [...new Set(input.attachmentIds)].filter(isUuid);
  if (!ids.length) return { error: "Pick at least one file to review" };
  if (ids.length > MAX_REVIEW_ASSETS) return { error: `Pick at most ${MAX_REVIEW_ASSETS} files` };
  const email = input.recipientEmail.trim().toLowerCase();
  if (!EMAIL.test(email)) return { error: "Enter the reviewer’s email address" };
  const message = input.message?.trim() || null;
  if (message && message.length > MAX_REVIEW_MESSAGE) return { error: "The message is too long" };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_review_check", {
    target_task: input.taskId,
    attachment_ids: ids,
    recipient: email,
    recipient_display: input.recipientName?.trim() || null,
    review_message: message,
  });
  if (error) return { error: dbError(error) };
  const created = data as { id?: string; round?: number; token?: string } | null;
  if (!created?.id || !isReviewToken(created.token)) return { error: "Couldn’t create the review check" };
  const sent = await emailRound(
    supabase,
    input.taskId,
    { round: created.round ?? 1, token: created.token, recipientEmail: email, recipientName: input.recipientName?.trim() || null, message },
    await roundAssets(supabase, created.id),
  );
  refresh();
  return { round: created.round, ...sent };
}

// "Send again": a new link for an open round (the old one stops working) and a new email.
export async function resendReviewCheck(reviewId: string): Promise<SendReviewResult> {
  if (!isUuid(reviewId)) return { error: "Invalid review check" };
  const supabase = await createClient();
  const { data: review } = await supabase
    .from("review_checks")
    .select("id, task_id, round, recipient_email, recipient_name, message")
    .eq("id", reviewId)
    .maybeSingle();
  if (!review) return { error: "Review check not found" };
  const { data, error } = await supabase.rpc("rotate_review_check_token", { target_review: reviewId });
  if (error) return { error: dbError(error) };
  const token = (data as { token?: string } | null)?.token;
  if (!isReviewToken(token)) return { error: "Couldn’t make a new link" };
  const sent = await emailRound(
    supabase,
    review.task_id,
    { round: review.round, token, recipientEmail: review.recipient_email, recipientName: review.recipient_name, message: review.message },
    await roundAssets(supabase, reviewId),
  );
  refresh();
  return { round: review.round, ...sent };
}

export async function withdrawReviewCheck(reviewId: string): Promise<{ error?: string }> {
  if (!isUuid(reviewId)) return { error: "Invalid review check" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("cancel_review_check", { target_review: reviewId });
  if (error) return { error: dbError(error) };
  refresh();
  return {};
}

// The task's Reviews tab: every round, newest first, with its files, pins, and the reviewer's uploads (RLS:
// the task's Viewers+). Null without this release's database update.
export async function loadTaskReviews(taskId: string): Promise<TaskReviewRound[] | null> {
  if (!isUuid(taskId)) return [];
  const { user, allowlisted } = await getViewer();
  if (!user || !allowlisted) return [];
  const supabase = await createClient();
  const rounds = await supabase
    .from("review_checks")
    .select("id, round, status, recipient_email, recipient_name, message, created_by, created_at, expires_at, decided_at, decision_note, last_viewed_at")
    .eq("task_id", taskId)
    .order("round", { ascending: false });
  if (rounds.error) return rounds.error.code === "PGRST205" || rounds.error.code === "42P01" ? null : [];
  const ids = (rounds.data ?? []).map((r) => r.id);
  if (!ids.length) return [];
  const [assets, pins, files] = await Promise.all([
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
  ]);
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
