"use server";
// Big move 1: the messages area's Server Actions (project and team Messages), thin wrappers around
// packages/core/src/api/messages/mutations.ts. Only what Next.js does (redirects, the request's context) stays here.
import { redirect } from "next/navigation";
import type { ActionResult } from "@alhc/core/api/core/result";
import { id } from "@alhc/core/api/core/validate";
import * as messagesApi from "@alhc/core/api/messages/mutations";
import { run } from "@/lib/server/action";

// ---------------------------------------------------------------------------------------------
// Project Messages
// ---------------------------------------------------------------------------------------------

export async function createMessageThread(projectId: string, title: string, body: string): Promise<ActionResult> {
  let threadId: string | undefined;
  const outcome = await run(async (ctx) => {
    threadId = await messagesApi.createMessageThread(ctx, projectId, title, body);
  });
  if (outcome.error || !threadId) return outcome;
  redirect(`/projects/${projectId}/messages/${threadId}`);
}

export async function replyToThread(threadId: string, body: string): Promise<ActionResult> {
  return run((ctx) => messagesApi.replyToThread(ctx, threadId, body));
}

export async function editMessage(messageId: string, patch: { title?: string; body: string }): Promise<ActionResult> {
  return run((ctx) => messagesApi.editMessage(ctx, messageId, patch));
}

export async function deleteMessage(messageId: string, projectId?: string): Promise<ActionResult> {
  const outcome = await run((ctx) => messagesApi.deleteMessage(ctx, messageId));
  // Deleting a thread leaves its page; go back to the list.
  if (!outcome.error && projectId) redirect(`/projects/${id(projectId, "project")}/messages`);
  return outcome;
}

export async function toggleMessageReaction(messageId: string, emoji: string): Promise<ActionResult> {
  return run((ctx) => messagesApi.toggleMessageReaction(ctx, messageId, emoji));
}

// ---------------------------------------------------------------------------------------------
// Team Messages (Real features 2)
// ---------------------------------------------------------------------------------------------

export async function createTeamMessageThread(teamId: string, title: string, body: string): Promise<ActionResult> {
  let threadId: string | undefined;
  const outcome = await run(async (ctx) => {
    threadId = await messagesApi.createTeamMessageThread(ctx, teamId, title, body);
  });
  if (outcome.error || !threadId) return outcome;
  redirect(`/teams/${teamId}/messages/${threadId}`);
}

export async function replyToTeamThread(threadId: string, body: string): Promise<ActionResult> {
  return run((ctx) => messagesApi.replyToTeamThread(ctx, threadId, body));
}

export async function editTeamMessage(messageId: string, patch: { title?: string; body: string }): Promise<ActionResult> {
  return run((ctx) => messagesApi.editTeamMessage(ctx, messageId, patch));
}

export async function deleteTeamMessage(messageId: string, teamId?: string): Promise<ActionResult> {
  const outcome = await run((ctx) => messagesApi.deleteTeamMessage(ctx, messageId));
  // Deleting a thread leaves its page; go back to the list.
  if (!outcome.error && teamId) redirect(`/teams/${id(teamId, "team")}/messages`);
  return outcome;
}

export async function toggleTeamMessageReaction(messageId: string, emoji: string): Promise<ActionResult> {
  return run((ctx) => messagesApi.toggleTeamMessageReaction(ctx, messageId, emoji));
}

// Follow or unfollow a team thread yourself (anyone who can read it). Following means its replies
// reach your Inbox.
export async function setTeamThreadFollowing(threadId: string, following: boolean): Promise<ActionResult> {
  return run((ctx) => messagesApi.setTeamThreadFollowing(ctx, threadId, following));
}
