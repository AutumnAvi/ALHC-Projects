// Big move 1: the messages area's types and pure mappers (no database access; safe to import anywhere,
// the browser included).
import type { ReactionKey } from "@/lib/reactions";

// ---------------------------------------------------------------------------------------------
// Project Messages (threads + replies; RLS: project Viewer+ reads)
// ---------------------------------------------------------------------------------------------

type MessageReaction = { emoji: ReactionKey; profileIds: string[] };

export type ProjectMessage = {
  id: string;
  authorId: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  mentionIds: string[];
  reactions: MessageReaction[];
};

export type MessageThreadSummary = {
  id: string;
  title: string;
  body: string;
  authorId: string;
  createdAt: string;
  lastActivityAt: string;
  replyCount: number;
};

export type MessageThread = ProjectMessage & {
  projectId: string;
  title: string;
  lastActivityAt: string;
  replies: ProjectMessage[];
};

export type MessageRow = {
  id: string;
  body: string;
  author_id: string;
  created_at: string;
  edited_at: string | null;
  project_message_mentions: { profile_id: string }[];
  project_message_reactions: { emoji: string; profile_id: string; deleted_at: string | null; created_at: string }[];
};

// ---------------------------------------------------------------------------------------------
// Team Messages (Real features 2: threads + replies; RLS: whoever can see the team reads)
// ---------------------------------------------------------------------------------------------

export type TeamThreadSummary = MessageThreadSummary & { following: boolean };

export type TeamMessageThread = ProjectMessage & {
  teamId: string;
  title: string;
  lastActivityAt: string;
  replies: ProjectMessage[];
  // Who follows the thread (gets its replies in the Inbox), in the order they started.
  followerIds: string[];
};
