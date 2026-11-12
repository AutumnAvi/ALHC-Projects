"use server";
// Big move 1: the comments area's Server Actions (comments, reactions, pins, followers, attachments, and
// the request's email conversation), thin wrappers around packages/core/src/api/comments/mutations.ts.
import * as commentsApi from "@alhc/core/api/comments/mutations";
import * as commentsQueries from "@alhc/core/api/comments/queries";
import type { ActionResult } from "@alhc/core/api/core/result";
import type { SubmitterConversation, TaskComment } from "@alhc/core/api/task-pane/model";
import { run, runWith, SCREEN_ONLY } from "@/lib/server/action";
import { actionContext } from "@/lib/server/context";

// ---------------------------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------------------------

// The next older page of comments (task_comment_page). The pane draws the newest page first.
export async function loadOlderComments(
  taskId: string,
  beforeAt: string,
  beforeId: string,
): Promise<ActionResult & { comments?: TaskComment[]; older?: { beforeAt: string; beforeId: string } | null }> {
  try {
    return await commentsQueries.loadOlderComments(await actionContext(), taskId, beforeAt, beforeId);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Couldn’t load earlier comments" };
  }
}

// Returns the new comment's id, so the pane can swap its optimistic row for the real one.
export async function addComment(taskId: string, body: string): Promise<ActionResult & { commentId?: string }> {
  const result = await runWith((ctx) => commentsApi.addComment(ctx, taskId, body));
  return { ...result, commentId: result.error ? undefined : result.commentId };
}

export async function sendSubmitterResponse(
  taskId: string,
  body: string,
): Promise<ActionResult & { commentId?: string }> {
  const result = await runWith((ctx) => commentsApi.sendSubmitterResponse(ctx, taskId, body));
  return { ...result, commentId: result.error ? undefined : result.commentId };
}

export async function setReplyThreadClosed(taskId: string, closed: boolean): Promise<ActionResult> {
  return run((ctx) => commentsApi.setReplyThreadClosed(ctx, taskId, closed));
}

// Nov 12 notes (batch 39, item 1): screen-only (src/lib/server/after-write.ts). Your own comment's text
// shows only in the task pane (the Inbox lists other people's comments), and the pane keeps the edit on
// screen until its own fresh copy arrives; so the save keeps the router's recently visited pages.
export async function editComment(commentId: string, body: string): Promise<ActionResult> {
  return run((ctx) => commentsApi.editComment(ctx, commentId, body), SCREEN_ONLY);
}

// Batch 39 (item 1): screen-only — reactions show only in the task pane (live-patched, refetched).
export async function toggleReaction(commentId: string, emoji: string): Promise<ActionResult> {
  return run((ctx) => commentsApi.toggleReaction(ctx, commentId, emoji), SCREEN_ONLY);
}

export async function deleteComment(commentId: string): Promise<ActionResult> {
  return run((ctx) => commentsApi.deleteComment(ctx, commentId));
}

// Nov 2 notes (batch 17, 128): saved quietly. Going through run()'s refresh made the action wait for the
// whole page and pane to re-render on the server (~2 s) before the pin showed. The pane now shows the pin
// at once (pinned-comments-store.ts) and the comments Realtime feed brings the saved state back.
export async function setCommentPinned(commentId: string, pinned: boolean): Promise<ActionResult> {
  return run((ctx) => commentsApi.setCommentPinned(ctx, commentId, pinned), { refresh: false, deliver: false });
}

// ---------------------------------------------------------------------------------------------
// Followers
// ---------------------------------------------------------------------------------------------

// Batch 39 (item 1): screen-only — followers show only in the task pane's footer, which keeps the change
// on screen until its own fresh copy arrives.
export async function setFollowing(taskId: string, profileId: string, following: boolean): Promise<ActionResult> {
  return run((ctx) => commentsApi.setFollowing(ctx, taskId, profileId, following), SCREEN_ONLY);
}

// ---------------------------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------------------------

export async function registerAttachment(input: {
  taskId: string;
  storagePath: string;
  fileName: string;
  contentType: string | null;
  sizeBytes: number;
}): Promise<ActionResult & { attachmentId?: string }> {
  return runWith((ctx) => commentsApi.registerAttachment(ctx, input));
}

export async function deleteAttachment(attachmentId: string): Promise<ActionResult> {
  return run((ctx) => commentsApi.deleteAttachment(ctx, attachmentId));
}

// ---------------------------------------------------------------------------------------------
// The request's email conversation (item 69)
// ---------------------------------------------------------------------------------------------

// Item 69: a workspace admin allows (true) or stops (false) a request's email conversation, for this
// request or for every request from its submitter; null goes back to the workspace rule.
export async function setEmailConversationOverride(
  taskId: string,
  scope: "request" | "submitter",
  allow: boolean | null,
): Promise<ActionResult> {
  return run((ctx) => commentsApi.setEmailConversationOverride(ctx, taskId, scope, allow));
}

// Item 69 (pane): whether this request's email conversation is on.
export async function loadRequestConversation(taskId: string): Promise<SubmitterConversation | null> {
  return commentsQueries.loadRequestConversation(await actionContext(), taskId);
}
