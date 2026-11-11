// Big move 1: the comments area's writes (comments, reactions, pins, followers, attachments, and the
// request's email conversation). Every function takes the caller's ApiContext first, validates its own
// input, writes only through ctx.db (RLS and the RPCs decide), and throws ApiError on any refusal; no
// Next.js here.
import { getSignedInUser } from "../auth/queries";
import type { ApiContext } from "../core/context";
import { check, checkUpdated, nowIso } from "../core/db";
import { invalid } from "../core/errors";
import { id, text } from "../core/validate";
import { MAX_ATTACHMENT_BYTES } from "../../attachments";
import { isReactionKey } from "../../reactions";
import { COMMENT_EDIT_EXPIRED, commentEditWindowOpen } from "../../comment-edit";

// ---------------------------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------------------------

// Answers the new comment's id, so the pane can swap its optimistic row for the real one.
export async function addComment(ctx: ApiContext, taskId: string, body: string): Promise<{ commentId: string | undefined }> {
  const supabase = ctx.db;
  const inserted = await supabase
    .from("comments")
    .insert({ task_id: id(taskId), body: text(body, "Comment", { max: 10000 }) })
    .select("id")
    .single();
  check(inserted);
  return { commentId: inserted.data?.id };
}

// "Send response to submitter" (Comments and reply by email): the comment is posted as the viewer and
// emailed to the form task's submitter, with a Reply-To that brings their answer back as a comment. The
// database fills in the address and subject and refuses a task without a submitter.
export async function sendSubmitterResponse(
  ctx: ApiContext,
  taskId: string,
  body: string,
): Promise<{ commentId: string | undefined }> {
  const supabase = ctx.db;
  const sent = await supabase.rpc("send_submitter_response", {
    target_task: id(taskId),
    response_body: text(body, "Comment", { max: 10000 }),
  });
  if (sent.error?.code === "PGRST202") {
    throw invalid("Sending responses to submitters needs this release’s database update");
  }
  check(sent);
  return { commentId: sent.data ?? undefined };
}

// Close (or reopen) the request's reply thread: while closed, the submitter's emailed replies are refused
// and logged, never posted, and responses go out without a Reply-To. Editors+ (the database checks).
export async function setReplyThreadClosed(ctx: ApiContext, taskId: string, closed: boolean): Promise<void> {
  const supabase = ctx.db;
  const result = await supabase.rpc("set_submitter_thread_closed", { target_task: id(taskId), closed: closed === true });
  if (result.error?.code === "PGRST202") throw invalid("Closing reply threads needs this release’s database update");
  check(result);
}

// Authors edit only the text; the database stamps edited_at and notifies people the edit newly mentions.
// Nov 11 notes (189): only for 15 minutes after posting. Checked here so the answer is a plain message,
// and again by the database (guard_comment_update), which decides on its own clock.
export async function editComment(ctx: ApiContext, commentId: string, body: string): Promise<void> {
  const supabase = ctx.db;
  const cleanBody = text(body, "Comment", { max: 10000 });
  const current = await supabase
    .from("comments")
    .select("id, created_at")
    .eq("id", id(commentId))
    .is("deleted_at", null)
    .maybeSingle();
  check(current);
  if (!current.data) throw invalid("You can only edit your own comments");
  if (!commentEditWindowOpen(current.data.created_at)) throw invalid(COMMENT_EDIT_EXPIRED);
  const result = await supabase
    .from("comments")
    .update({ body: cleanBody })
    .eq("id", id(commentId))
    .is("deleted_at", null)
    .select("id");
  check(result);
  if (!result.data?.length) throw invalid("You can only edit your own comments");
}

// Adds the viewer's reaction, or removes it (soft delete) when they already reacted with that emoji.
export async function toggleReaction(ctx: ApiContext, commentId: string, emoji: string): Promise<void> {
  if (!isReactionKey(emoji)) throw invalid("Unknown reaction");
  const supabase = ctx.db;
  const user = await getSignedInUser(ctx);
  if (!user) throw invalid("Sign in again to react");
  const existing = await supabase
    .from("comment_reactions")
    .select("id")
    .eq("comment_id", id(commentId))
    .eq("profile_id", user.id)
    .eq("emoji", emoji)
    .is("deleted_at", null);
  check(existing);
  if (existing.data?.length) {
    checkUpdated(
      await supabase
        .from("comment_reactions")
        .update({ deleted_at: nowIso() })
        .in("id", existing.data.map((r) => r.id))
        .select("id"),
    );
    return;
  }
  const inserted = await supabase.from("comment_reactions").insert({ comment_id: commentId, emoji });
  // A double click can race the unique index; the reaction is there either way.
  if (inserted.error?.code === "23505") return;
  check(inserted);
}

export async function deleteComment(ctx: ApiContext, commentId: string): Promise<void> {
  const supabase = ctx.db;
  const result = await supabase
    .from("comments")
    .update({ deleted_at: nowIso() })
    .eq("id", id(commentId))
    .select("id");
  check(result);
  if (!result.data?.length) throw invalid("You can only delete your own comments");
}

// Comment pinning (Asana test 10.4): Editors and above of the task (set_comment_pinned checks).
export async function setCommentPinned(ctx: ApiContext, commentId: string, pinned: boolean): Promise<void> {
  const supabase = ctx.db;
  const result = await supabase.rpc("set_comment_pinned", { target_comment: id(commentId, "comment"), pin: Boolean(pinned) });
  if (result.error?.code === "PGRST202") throw invalid("Pinning comments needs this release’s database update");
  check(result);
}

// ---------------------------------------------------------------------------------------------
// Followers
// ---------------------------------------------------------------------------------------------

export async function setFollowing(ctx: ApiContext, taskId: string, profileId: string, following: boolean): Promise<void> {
  const supabase = ctx.db;
  check(
    await supabase.from("task_followers").upsert(
      {
        task_id: id(taskId),
        profile_id: id(profileId, "person"),
        deleted_at: following ? null : nowIso(),
      },
      { onConflict: "task_id,profile_id" },
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Attachments (bytes are uploaded from the browser straight to Storage; this records metadata)
// ---------------------------------------------------------------------------------------------

// Records an uploaded file. Answers the new attachment's id (Oct 27 notes, batch 5: the Send review check
// dialog picks what it uploads).
export async function registerAttachment(
  ctx: ApiContext,
  input: {
    taskId: string;
    storagePath: string;
    fileName: string;
    contentType: string | null;
    sizeBytes: number;
  },
): Promise<{ attachmentId: string | undefined }> {
  const taskId = id(input.taskId);
  if (!input.storagePath.startsWith(`${taskId}/`) || input.storagePath.includes("..")) {
    throw invalid("Invalid attachment path");
  }
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 0) {
    throw invalid("Invalid file size");
  }
  if (input.sizeBytes > MAX_ATTACHMENT_BYTES) throw invalid("Files are limited to 25 MB");
  const supabase = ctx.db;
  const inserted = await supabase
    .from("task_attachments")
    .insert({
      task_id: taskId,
      storage_path: input.storagePath,
      file_name: text(input.fileName, "File name", { max: 255 }),
      content_type: input.contentType?.slice(0, 255) || null,
      size_bytes: input.sizeBytes,
    })
    .select("id")
    .single();
  check(inserted);
  return { attachmentId: inserted.data?.id };
}

export async function deleteAttachment(ctx: ApiContext, attachmentId: string): Promise<void> {
  const supabase = ctx.db;
  checkUpdated(
    await supabase
      .from("task_attachments")
      .update({ deleted_at: nowIso() })
      .eq("id", id(attachmentId))
      .select("id"),
  );
}

// ---------------------------------------------------------------------------------------------
// The request's email conversation (item 69)
// ---------------------------------------------------------------------------------------------

// Item 69: a workspace admin allows (true) or stops (false) a request's email conversation, for this
// request or for every request from its submitter; null goes back to the workspace rule.
export async function setEmailConversationOverride(
  ctx: ApiContext,
  taskId: string,
  scope: "request" | "submitter",
  allow: boolean | null,
): Promise<void> {
  if (scope !== "request" && scope !== "submitter") throw invalid("Choose this request or this submitter");
  const supabase = ctx.db;
  check(
    await supabase.rpc("set_email_conversation_override", {
      target_task: id(taskId, "task"),
      scope,
      allow: allow === null ? null : Boolean(allow),
    }),
  );
}
