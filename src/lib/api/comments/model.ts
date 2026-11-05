// Big move 1: the comments area's types and pure mappers (no database access; safe to import anywhere,
// the browser included).
import type { TaskComment } from "@/lib/api/task-pane/model";
import { type CommentEmail, parseCommentEmail } from "@/lib/comment-email";
import { isReactionKey, type ReactionKey, REACTIONS } from "@/lib/reactions";
import type { Json } from "@/lib/supabase/database.types";

export const COMMENT_PAGE_SIZE = 100;

export type CommentPage = {
  comments: TaskComment[];
  hasMore: boolean;
  total: number;
};

export function commentFromPageRow(
  row: Record<string, Json | undefined>,
  outbox: Map<string, { status: CommentEmail["status"]; error: string | null }>,
): TaskComment | null {
  if (typeof row.id !== "string" || typeof row.created_at !== "string") return null;
  const deleted = row.deleted_at != null;
  const byEmoji = new Map<ReactionKey, string[]>();
  if (!deleted && Array.isArray(row.reactions)) {
    const reactions = row.reactions.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const reaction = item as Record<string, Json | undefined>;
      return [
        {
          emoji: reaction.emoji,
          profileId: reaction.profile_id,
          at: typeof reaction.created_at === "string" ? reaction.created_at : "",
        },
      ];
    });
    reactions.sort((a, b) => a.at.localeCompare(b.at));
    for (const reaction of reactions) {
      if (!isReactionKey(reaction.emoji) || typeof reaction.profileId !== "string") continue;
      const ids = byEmoji.get(reaction.emoji) ?? [];
      ids.push(reaction.profileId);
      byEmoji.set(reaction.emoji, ids);
    }
  }
  const emailBase = deleted
    ? null
    : parseCommentEmail({
        email_direction: typeof row.email_direction === "string" ? row.email_direction : null,
        email_address: typeof row.email_address === "string" ? row.email_address : null,
        email_subject: typeof row.email_subject === "string" ? row.email_subject : null,
      });
  const sent = emailBase?.direction === "sent" ? outbox.get(row.id) : undefined;
  const ruleId = typeof row.rule_id === "string" ? row.rule_id : null;
  return {
    id: row.id,
    authorId: typeof row.author_id === "string" ? row.author_id : null,
    ruleName: ruleId ? (typeof row.rule_name === "string" ? row.rule_name : "Automation") : null,
    ruleId,
    body: deleted ? "" : typeof row.body === "string" ? row.body : "",
    createdAt: row.created_at,
    editedAt: deleted || typeof row.edited_at !== "string" ? null : row.edited_at,
    deleted,
    mentionIds:
      deleted || !Array.isArray(row.mention_ids)
        ? []
        : row.mention_ids.filter((profileId): profileId is string => typeof profileId === "string"),
    reactions: REACTIONS.map(({ key }) => ({ emoji: key, profileIds: byEmoji.get(key) ?? [] })).filter(
      (reaction) => reaction.profileIds.length > 0,
    ),
    email: emailBase ? { ...emailBase, status: sent?.status ?? null, error: sent?.error ?? null } : null,
    pinnedAt: !deleted && typeof row.pinned_at === "string" ? row.pinned_at : null,
    pinnedBy: !deleted && typeof row.pinned_by === "string" ? row.pinned_by : null,
  };
}

export function parseCommentPage(
  data: Json,
  outbox: Map<string, { status: CommentEmail["status"]; error: string | null }>,
): CommentPage {
  const root = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, Json | undefined>) : {};
  const raw = Array.isArray(root.comments) ? root.comments : [];
  const comments = raw.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const comment = commentFromPageRow(item as Record<string, Json | undefined>, outbox);
    return comment ? [comment] : [];
  });
  return {
    comments,
    hasMore: root.has_more === true,
    total: typeof root.total === "number" ? root.total : comments.filter((comment) => !comment.deleted).length,
  };
}

export function olderCursor(page: CommentPage): { beforeAt: string; beforeId: string } | null {
  const oldest = page.comments[0];
  if (!page.hasMore || !oldest) return null;
  return { beforeAt: oldest.createdAt, beforeId: oldest.id };
}

export type CommentRefs = {
  tasks: Record<string, { title: string; projectId: string | null }>;
  projects: Record<string, { name: string }>;
};
