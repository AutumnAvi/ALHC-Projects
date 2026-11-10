// Big move 1: the messages area's writes (project Messages and team Messages: threads, replies, edits,
// removals, reactions, following). Every function takes the caller's ApiContext first, validates its own
// input, writes only through ctx.db (RLS and the database's guards decide), and throws ApiError on any
// refusal; no Next.js here.
import { getSignedInUser } from "../auth/queries";
import type { ApiContext } from "../core/context";
import { check, checkUpdated, nowIso } from "../core/db";
import { type DbErrorDetail, invalid } from "../core/errors";
import { id, text } from "../core/validate";
import { isReactionKey } from "../../reactions";
import type { TablesUpdate } from "../../supabase/database.types";

const MAX_MESSAGE = 20000;

// ---------------------------------------------------------------------------------------------
// Project Messages
// ---------------------------------------------------------------------------------------------

// A new thread. Answers its id (the caller opens it).
export async function createMessageThread(
  ctx: ApiContext,
  projectId: string,
  title: string,
  body: string,
): Promise<string | undefined> {
  const supabase = ctx.db;
  const result = await supabase
    .from("project_messages")
    .insert({
      project_id: id(projectId, "project"),
      title: text(title, "Title", { max: 200 }),
      body: text(body, "Message", { max: MAX_MESSAGE }),
    })
    .select("id")
    .single();
  check(result, "Only people who can comment in this project can post messages");
  return result.data?.id;
}

export async function replyToThread(ctx: ApiContext, threadId: string, body: string): Promise<void> {
  const supabase = ctx.db;
  const thread = await supabase
    .from("project_messages")
    .select("project_id")
    .eq("id", id(threadId, "thread"))
    .is("deleted_at", null)
    .maybeSingle();
  check(thread);
  if (!thread.data) throw invalid("This thread was deleted");
  check(
    await supabase
      .from("project_messages")
      .insert({ project_id: thread.data.project_id, thread_id: threadId, body: text(body, "Reply", { max: MAX_MESSAGE }) }),
    "Only people who can comment in this project can reply",
  );
}

export async function editMessage(ctx: ApiContext, messageId: string, patch: { title?: string; body: string }): Promise<void> {
  const supabase = ctx.db;
  const update: TablesUpdate<"project_messages"> = { body: text(patch.body, "Message", { max: MAX_MESSAGE }) };
  if (patch.title !== undefined) update.title = text(patch.title, "Title", { max: 200 });
  const result = await supabase
    .from("project_messages")
    .update(update)
    .eq("id", id(messageId, "message"))
    .is("deleted_at", null)
    .select("id");
  check(result);
  if (!result.data?.length) throw invalid("You can only edit your own messages");
}

export async function deleteMessage(ctx: ApiContext, messageId: string): Promise<void> {
  const supabase = ctx.db;
  const result = await supabase
    .from("project_messages")
    .update({ deleted_at: nowIso() })
    .eq("id", id(messageId, "message"))
    .select("id");
  check(result);
  if (!result.data?.length) throw invalid("You can only delete your own messages");
}

export async function toggleMessageReaction(ctx: ApiContext, messageId: string, emoji: string): Promise<void> {
  if (!isReactionKey(emoji)) throw invalid("Unknown reaction");
  const supabase = ctx.db;
  const user = await getSignedInUser(ctx);
  if (!user) throw invalid("Sign in again to react");
  const existing = await supabase
    .from("project_message_reactions")
    .select("id")
    .eq("message_id", id(messageId, "message"))
    .eq("profile_id", user.id)
    .eq("emoji", emoji)
    .is("deleted_at", null);
  check(existing);
  if (existing.data?.length) {
    checkUpdated(
      await supabase
        .from("project_message_reactions")
        .update({ deleted_at: nowIso() })
        .in("id", existing.data.map((r) => r.id))
        .select("id"),
    );
    return;
  }
  const inserted = await supabase.from("project_message_reactions").insert({ message_id: messageId, emoji });
  if (inserted.error?.code === "23505") return;
  check(inserted, "Only people who can comment in this project can react to messages");
}

// ---------------------------------------------------------------------------------------------
// Team Messages (Real features 2): the database decides who may post (team members, leads, workspace
// admins), who is told, and who follows.
// ---------------------------------------------------------------------------------------------

const TEAM_POST_ONLY = "Only members of this team can post in its Messages";
const TEAM_MESSAGES_UPDATE = "Team messages need this release’s database update";

function teamMessagesMissing(result: { error: DbErrorDetail | null }): boolean {
  return ["PGRST205", "42P01"].includes(result.error?.code ?? "");
}

// A new team thread. Answers its id (the caller opens it).
export async function createTeamMessageThread(
  ctx: ApiContext,
  teamId: string,
  title: string,
  body: string,
): Promise<string | undefined> {
  const supabase = ctx.db;
  const result = await supabase
    .from("team_messages")
    .insert({
      team_id: id(teamId, "team"),
      title: text(title, "Title", { max: 200 }),
      body: text(body, "Message", { max: MAX_MESSAGE }),
    })
    .select("id")
    .single();
  if (teamMessagesMissing(result)) throw invalid(TEAM_MESSAGES_UPDATE);
  check(result, TEAM_POST_ONLY);
  return result.data?.id;
}

export async function replyToTeamThread(ctx: ApiContext, threadId: string, body: string): Promise<void> {
  const supabase = ctx.db;
  const thread = await supabase
    .from("team_messages")
    .select("team_id")
    .eq("id", id(threadId, "thread"))
    .is("thread_id", null)
    .is("deleted_at", null)
    .maybeSingle();
  check(thread);
  if (!thread.data) throw invalid("This thread was deleted");
  check(
    await supabase
      .from("team_messages")
      .insert({ team_id: thread.data.team_id, thread_id: threadId, body: text(body, "Reply", { max: MAX_MESSAGE }) }),
    TEAM_POST_ONLY,
  );
}

export async function editTeamMessage(ctx: ApiContext, messageId: string, patch: { title?: string; body: string }): Promise<void> {
  const supabase = ctx.db;
  const update: TablesUpdate<"team_messages"> = { body: text(patch.body, "Message", { max: MAX_MESSAGE }) };
  if (patch.title !== undefined) update.title = text(patch.title, "Title", { max: 200 });
  const result = await supabase
    .from("team_messages")
    .update(update)
    .eq("id", id(messageId, "message"))
    .is("deleted_at", null)
    .select("id");
  check(result);
  if (!result.data?.length) throw invalid("You can only edit your own messages");
}

export async function deleteTeamMessage(ctx: ApiContext, messageId: string): Promise<void> {
  const supabase = ctx.db;
  const result = await supabase
    .from("team_messages")
    .update({ deleted_at: nowIso() })
    .eq("id", id(messageId, "message"))
    .select("id");
  check(result);
  if (!result.data?.length) throw invalid("You can only delete your own messages");
}

export async function toggleTeamMessageReaction(ctx: ApiContext, messageId: string, emoji: string): Promise<void> {
  if (!isReactionKey(emoji)) throw invalid("Unknown reaction");
  const supabase = ctx.db;
  const user = await getSignedInUser(ctx);
  if (!user) throw invalid("Sign in again to react");
  const existing = await supabase
    .from("team_message_reactions")
    .select("id")
    .eq("message_id", id(messageId, "message"))
    .eq("profile_id", user.id)
    .eq("emoji", emoji)
    .is("deleted_at", null);
  check(existing);
  if (existing.data?.length) {
    checkUpdated(
      await supabase
        .from("team_message_reactions")
        .update({ deleted_at: nowIso() })
        .in("id", existing.data.map((r) => r.id))
        .select("id"),
    );
    return;
  }
  const inserted = await supabase.from("team_message_reactions").insert({ message_id: messageId, emoji });
  if (inserted.error?.code === "23505") return;
  check(inserted, "Only members of this team can react to its messages");
}

// Follow or unfollow a team thread yourself (anyone who can read it). Following means its replies
// reach your Inbox.
export async function setTeamThreadFollowing(ctx: ApiContext, threadId: string, following: boolean): Promise<void> {
  const supabase = ctx.db;
  const user = await getSignedInUser(ctx);
  if (!user) throw invalid("Sign in again to follow this thread");
  const existing = await supabase
    .from("team_message_followers")
    .select("id, deleted_at")
    .eq("thread_id", id(threadId, "thread"))
    .eq("profile_id", user.id)
    .maybeSingle();
  check(existing);
  if (existing.data) {
    checkUpdated(
      await supabase
        .from("team_message_followers")
        .update({ deleted_at: following ? null : nowIso() })
        .eq("id", existing.data.id)
        .select("id"),
      "Couldn’t change following",
    );
    return;
  }
  if (!following) return;
  check(
    await supabase.from("team_message_followers").insert({ thread_id: threadId, profile_id: user.id }),
    "Couldn’t follow this thread",
  );
}
