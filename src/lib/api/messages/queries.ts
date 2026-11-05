// Big move 1: the messages area's reads. Every function takes the caller's ApiContext first and reads only
// through ctx.db (RLS decides); no Next.js here.
import { type ApiContext, read } from "@/lib/api/core/context";
import { maybe, rows } from "@/lib/api/core/db";
import type { MessageRow, MessageThread, MessageThreadSummary, ProjectMessage } from "@/lib/api/messages/model";
import { REACTIONS } from "@/lib/reactions";

const MESSAGE_COLUMNS =
  "id, project_id, thread_id, title, body, author_id, created_at, edited_at, last_activity_at, project_message_mentions(profile_id), project_message_reactions(emoji, profile_id, deleted_at, created_at)";

function toProjectMessage(row: MessageRow): ProjectMessage {
  return toMessage(row, row.project_message_mentions, row.project_message_reactions);
}

// A project or team message (same shape; the mention / reaction tables differ).
function toMessage(
  row: { id: string; body: string; author_id: string; created_at: string; edited_at: string | null },
  mentions: { profile_id: string }[],
  reactions: { emoji: string; profile_id: string; deleted_at: string | null; created_at: string }[],
): ProjectMessage {
  const active = reactions.filter((r) => !r.deleted_at).sort((a, b) => a.created_at.localeCompare(b.created_at));
  return {
    id: row.id,
    authorId: row.author_id,
    body: row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    mentionIds: mentions.map((m) => m.profile_id),
    reactions: REACTIONS.flatMap(({ key }) => {
      const profileIds = active.filter((r) => r.emoji === key).map((r) => r.profile_id);
      return profileIds.length ? [{ emoji: key, profileIds }] : [];
    }),
  };
}

// Threads of a project, most recently active first.
export const listMessageThreads = read(async (ctx: ApiContext, projectId: string): Promise<MessageThreadSummary[]> => {
  const supabase = ctx.db;
  const threads = rows(
    await supabase
      .from("project_messages")
      .select("id, title, body, author_id, created_at, last_activity_at")
      .eq("project_id", projectId)
      .is("thread_id", null)
      .is("deleted_at", null)
      .order("last_activity_at", { ascending: false })
      .limit(200),
    "messages",
  );
  if (threads.length === 0) return [];
  const replies = rows(
    await supabase
      .from("project_messages")
      .select("thread_id")
      .in(
        "thread_id",
        threads.map((t) => t.id),
      )
      .is("deleted_at", null),
    "replies",
  );
  const counts = new Map<string, number>();
  for (const r of replies) if (r.thread_id) counts.set(r.thread_id, (counts.get(r.thread_id) ?? 0) + 1);
  return threads.map((t) => ({
    id: t.id,
    title: t.title ?? "Untitled",
    body: t.body,
    authorId: t.author_id,
    createdAt: t.created_at,
    lastActivityAt: t.last_activity_at,
    replyCount: counts.get(t.id) ?? 0,
  }));
});

// One thread with its replies (oldest first); null when missing, deleted, or unreadable.
export const getMessageThread = read(async (ctx: ApiContext, threadId: string): Promise<MessageThread | null> => {
  const supabase = ctx.db;
  const thread = maybe(
    await supabase
      .from("project_messages")
      .select(MESSAGE_COLUMNS)
      .eq("id", threadId)
      .is("thread_id", null)
      .is("deleted_at", null)
      .maybeSingle(),
    "message",
  );
  if (!thread) return null;
  const replies = rows(
    await supabase
      .from("project_messages")
      .select(MESSAGE_COLUMNS)
      .eq("thread_id", threadId)
      .is("deleted_at", null)
      .order("created_at"),
    "replies",
  );
  return {
    ...toProjectMessage(thread),
    projectId: thread.project_id,
    title: thread.title ?? "Untitled",
    lastActivityAt: thread.last_activity_at,
    replies: replies.map(toProjectMessage),
  };
});

// Can the viewer post in this team's Messages (its members, leads, and workspace admins)?
export const canPostTeamMessage = read(async (ctx: ApiContext, teamId: string): Promise<boolean> => {
  const supabase = ctx.db;
  const result = await supabase.rpc("can_post_team_message", { target_team: teamId });
  return !result.error && result.data === true;
});
