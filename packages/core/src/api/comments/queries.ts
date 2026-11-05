// Big move 1: the comments area's reads. Every function takes the caller's ApiContext first and reads only
// through ctx.db (RLS decides); no Next.js here.
import {
  COMMENT_PAGE_SIZE,
  commentFromPageRow,
  type CommentPage,
  type CommentRefs,
  olderCursor,
  parseCommentPage,
} from "./model";
import type { ApiContext, Db } from "../core/context";
import { rpcMissing } from "../core/db";
import { ApiError } from "../core/errors";
import { id } from "../core/validate";
import type { SubmitterConversation, TaskComment, TaskDetail, TaskStory } from "../task-pane/model";
import { loadSubmitterConversation, withRuleProjects } from "../task-pane/queries";
import { appLinkIds } from "../../app-links";
import { type CommentEmail, commentEmailStatus } from "../../comment-email";
import { SKIP_REASONS, type SkipReason } from "../../reply-attachments";
import type { Json } from "../../supabase/database.types";

// Newest page of a task's comments (task_comment_page), with sent-response status filled from the outbox.
// Null when that function is not on the database yet.
export async function loadTaskCommentPage(
  ctx: ApiContext, taskId: string,
  before?: { at: string; id: string } | null,
): Promise<CommentPage | null> {
  const supabase = ctx.db;
  const result = await supabase.rpc("task_comment_page", {
    target_task: taskId,
    before_at: before?.at ?? null,
    before_id: before?.id ?? null,
    max_results: COMMENT_PAGE_SIZE,
  });
  if (result.error) {
    if (rpcMissing(result.error)) return null;
    throw new Error(`Failed to load comments: ${result.error.message}`);
  }
  const responseEmails = await supabase
    .from("email_outbox")
    .select("status, delivery_status, last_error, comment_id:payload->>comment_id")
    .eq("task_id", taskId)
    .eq("payload->>kind", "submitter_response")
    .order("created_at");
  const outbox = new Map(
    (responseEmails.error ? [] : (responseEmails.data ?? [])).map((row) => [
      String(row.comment_id),
      {
        status: commentEmailStatus(row),
        error: row.status === "failed" ? (typeof row.last_error === "string" ? row.last_error.slice(0, 200) : null) : null,
      },
    ]),
  );
  const page = await withReviewChecks(supabase, await withReplyFiles(supabase, parseCommentPage(result.data, outbox)));
  return { ...page, comments: await withRuleProjects(supabase, page.comments) };
}

// Oct 26 notes (batch 3): which comments report a review check's outcome. A database without this
// release's update has no such column: none do.
export async function withReviewChecks(supabase: Db, page: CommentPage): Promise<CommentPage> {
  const ids = page.comments.map((c) => c.id);
  if (!ids.length) return page;
  const { data, error } = await supabase.from("comments").select("id, review_check_id").in("id", ids).not("review_check_id", "is", null);
  if (error || !data?.length) return page;
  const byId = new Map(data.map((c) => [c.id, c.review_check_id] as const));
  return { ...page, comments: page.comments.map((c) => (byId.has(c.id) ? { ...c, reviewCheckId: byId.get(c.id) ?? null } : c)) };
}

// A received reply's files (task_attachments.comment_id) and the ones left out (email_skipped_files),
// read with the viewer's client. A database without the email designs update has neither column.
export async function withReplyFiles(supabase: Db, page: CommentPage): Promise<CommentPage> {
  const ids = page.comments.filter((c) => c.email?.direction === "received").map((c) => c.id);
  if (!ids.length) return page;
  const [files, skipped] = await Promise.all([
    supabase
      .from("task_attachments")
      .select("id, comment_id, file_name, size_bytes, content_type")
      .in("comment_id", ids)
      .is("deleted_at", null)
      .order("created_at"),
    supabase.from("comments").select("id, email_skipped_files").in("id", ids),
  ]);
  const byComment = new Map<string, NonNullable<TaskComment["emailFiles"]>>();
  for (const f of files.error ? [] : (files.data ?? [])) {
    if (!f.comment_id) continue;
    const list = byComment.get(f.comment_id) ?? [];
    list.push({ id: f.id, name: f.file_name, sizeBytes: f.size_bytes, contentType: f.content_type });
    byComment.set(f.comment_id, list);
  }
  const skippedBy = new Map<string, NonNullable<TaskComment["emailSkipped"]>>();
  for (const c of skipped.error ? [] : (skipped.data ?? [])) {
    if (!Array.isArray(c.email_skipped_files)) continue;
    skippedBy.set(
      c.id,
      c.email_skipped_files.flatMap((item) => {
        const o = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, Json | undefined>) : null;
        const reason = o?.reason;
        return o && typeof o.name === "string" && typeof reason === "string" && (SKIP_REASONS as readonly string[]).includes(reason)
          ? [{ name: o.name, reason: reason as SkipReason }]
          : [];
      }),
    );
  }
  return {
    ...page,
    comments: page.comments.map((c) =>
      byComment.has(c.id) || skippedBy.has(c.id)
        ? { ...c, emailFiles: byComment.get(c.id) ?? [], emailSkipped: skippedBy.get(c.id) ?? [] }
        : c,
    ),
  };
}

// The task's reply thread state (submitter_thread_status: Viewer+, never the token). Null without one or
// without the database update.
export async function loadReplyThread(
  supabase: Db,
  taskId: string,
  preRead?: { data: Json | null; error: unknown },
): Promise<TaskDetail["replyThread"]> {
  const { data, error } = preRead ?? (await supabase.rpc("submitter_thread_status", { target_task: taskId }));
  if (error || !data || typeof data !== "object" || Array.isArray(data)) return null;
  const o = data as Record<string, Json | undefined>;
  if (typeof o.submitter_email !== "string") return null;
  return {
    closed: o.closed === true,
    closedAt: typeof o.closed_at === "string" ? o.closed_at : null,
    closedByName: typeof o.closed_by_name === "string" ? o.closed_by_name : null,
    submitterEmail: o.submitter_email,
    subject: typeof o.subject === "string" && o.subject.trim() ? o.subject : null,
  };
}

// The task's pinned comments (task_pinned_comments, in the comment page's shape) and the Pin / Unpin
// events for All activity (stories with kind comment_pinned / comment_unpinned). Empty without the update.
export async function loadCommentPins(
  supabase: Db,
  taskId: string,
  outbox: Map<string, { status: CommentEmail["status"]; error: string | null }>,
  preRead?: { pinned: Json | undefined; events: Json | undefined },
): Promise<{ pinned: TaskComment[]; events: TaskStory[] }> {
  type PinEvent = { id: string; comment_id: string; actor_id: string | null; pinned: boolean; created_at: string };
  const [pinned, events] = preRead
    ? [
        { data: (preRead.pinned ?? []) as Json, error: null },
        { data: (Array.isArray(preRead.events) ? preRead.events : []) as unknown as PinEvent[], error: null },
      ]
    : await Promise.all([
        supabase.rpc("task_pinned_comments", { target_task: taskId }),
        supabase.from("comment_pin_events").select("id, comment_id, actor_id, pinned, created_at").eq("task_id", taskId).order("created_at"),
      ]);
  const rowsOf = !pinned.error && Array.isArray(pinned.data) ? pinned.data : [];
  return {
    pinned: rowsOf.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const comment = commentFromPageRow(item as Record<string, Json | undefined>, outbox);
      return comment ? [comment] : [];
    }),
    events: events.error
      ? []
      : (events.data ?? []).map((e) => ({
          id: `pin-${e.id}`,
          actorId: e.actor_id,
          kind: e.pinned ? "comment_pinned" : "comment_unpinned",
          data: { comment_id: e.comment_id } as Json,
          createdAt: e.created_at,
        })),
  };
}

// Names for the app links in comment bodies, read with the viewer's own client (RLS): a task or project
// they can't open simply isn't in the result.
export async function loadCommentRefs(supabase: Db, bodies: string[]): Promise<CommentRefs> {
  const { taskIds, projectIds } = appLinkIds(bodies);
  const refs: CommentRefs = { tasks: {}, projects: {} };
  if (!taskIds.length && !projectIds.length) return refs;
  const [tasks, projects] = await Promise.all([
    taskIds.length
      ? supabase.from("tasks").select("id, title, home_project_id").in("id", taskIds.slice(0, 200)).is("deleted_at", null)
      : Promise.resolve({ data: [], error: null }),
    projectIds.length
      ? supabase.from("projects").select("id, name").in("id", projectIds.slice(0, 200)).is("deleted_at", null)
      : Promise.resolve({ data: [], error: null }),
  ]);
  for (const t of tasks.data ?? []) refs.tasks[t.id] = { title: t.title, projectId: t.home_project_id };
  for (const p of projects.data ?? []) refs.projects[p.id] = { name: p.name };
  return refs;
}

// The next older page of comments (task_comment_page). The pane draws the newest page first. Also answers
// where the page after it starts (null = none left).
export async function loadOlderComments(
  ctx: ApiContext,
  taskId: string,
  beforeAt: string,
  beforeId: string,
): Promise<{ comments: TaskComment[]; older: { beforeAt: string; beforeId: string } | null }> {
  const page = await loadTaskCommentPage(ctx, id(taskId), { at: beforeAt, id: beforeId });
  if (!page) throw new ApiError("not_deployed", "Earlier comments need this release’s database update");
  return { comments: page.comments, older: olderCursor(page) };
}

// Item 69 (pane): whether this request's email conversation is on.
export async function loadRequestConversation(ctx: ApiContext, taskId: string): Promise<SubmitterConversation | null> {
  return loadSubmitterConversation(ctx, id(taskId, "task"));
}
