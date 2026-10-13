"use client";

import Link from "next/link";
import { useState } from "react";
import { Bell, BellOff, ChevronLeft, MessagesSquare, Pencil, Trash2 } from "lucide-react";
import { Avatar, displayName } from "@/components/avatar";
import { useCan } from "@/components/project/project-access";
import { MentionTextarea } from "@/components/task/mention-textarea";
import { COMMENT_INPUT, MentionText, ReactionBar } from "@/components/task/task-activity";
import { Timestamp } from "@/components/timestamp";
import { useServerAction } from "@/components/toast";
import { EmptyState } from "@/components/ui";
import {
  createMessageThread,
  createTeamMessageThread,
  deleteMessage,
  deleteTeamMessage,
  editMessage,
  editTeamMessage,
  replyToTeamThread,
  replyToThread,
  setTeamThreadFollowing,
  toggleMessageReaction,
  toggleTeamMessageReaction,
  type ActionResult,
} from "@/lib/actions";
import type {
  MessageThread,
  MessageThreadSummary,
  Profile,
  ProjectMessage,
  TeamMessageThread,
  TeamThreadSummary,
} from "@/lib/data";
import { personHref } from "@/lib/people";
import { useRealtimeRefresh } from "@/lib/realtime";

// Messages: threads (title + body) with replies, @mentions, and reactions on the comment machinery, for
// a project (Viewers read; Commenters and above post, reply, and react) or, since Real features 2, a
// team (everyone who can see the team reads; its members, leads, and workspace admins post; threads
// can be followed). Authors edit and delete their own. Who is notified is decided by the database.

type Scope =
  | { kind: "project"; id: string }
  | { kind: "team"; id: string; name: string };

type ScopeActions = {
  create: (scopeId: string, title: string, body: string) => Promise<ActionResult>;
  reply: (threadId: string, body: string) => Promise<ActionResult>;
  edit: (messageId: string, patch: { title?: string; body: string }) => Promise<ActionResult>;
  remove: (messageId: string, scopeId?: string) => Promise<ActionResult>;
  react: (messageId: string, emoji: string) => Promise<ActionResult>;
};

const ACTIONS: Record<Scope["kind"], ScopeActions> = {
  project: {
    create: createMessageThread,
    reply: replyToThread,
    edit: editMessage,
    remove: deleteMessage,
    react: toggleMessageReaction,
  },
  team: {
    create: createTeamMessageThread,
    reply: replyToTeamThread,
    edit: editTeamMessage,
    remove: deleteTeamMessage,
    react: toggleTeamMessageReaction,
  },
};

const basePath = (scope: Scope) => (scope.kind === "project" ? `/projects/${scope.id}/messages` : `/teams/${scope.id}/messages`);

function useMessagesRealtime(scope: Scope, key: string, reactions: boolean) {
  const table = scope.kind === "project" ? "project_messages" : "team_messages";
  const column = scope.kind === "project" ? "project_id" : "team_id";
  useRealtimeRefresh(`${key}-${scope.id}`, [
    { table, filter: `${column}=eq.${scope.id}` },
    ...(reactions
      ? [{ table: scope.kind === "project" ? "project_message_reactions" : "team_message_reactions", filter: `${column}=eq.${scope.id}` }]
      : []),
  ]);
}

function useNames(profiles: Profile[]) {
  const byId = new Map(profiles.map((p) => [p.id, p] as const));
  return (profileId: string | null) => {
    const p = profileId ? byId.get(profileId) : undefined;
    return p ? displayName(p) : "Former member";
  };
}

function mentionNamesOf(message: ProjectMessage, profiles: Profile[]) {
  return message.mentionIds.flatMap((pid) => {
    const p = profiles.find((x) => x.id === pid);
    if (!p) return [];
    return [p.full_name?.trim(), p.email.split("@")[0]].filter((n): n is string => Boolean(n));
  });
}

// ---------------------------------------------------------------------------------------------
// Thread lists
// ---------------------------------------------------------------------------------------------

export function MessageThreadList(props: {
  projectId: string;
  threads: MessageThreadSummary[];
  profiles: Profile[];
  candidates: Profile[];
}) {
  const canPost = useCan("commenter");
  return (
    <ThreadList
      scope={{ kind: "project", id: props.projectId }}
      canPost={canPost}
      threads={props.threads}
      profiles={props.profiles}
      candidates={props.candidates}
    />
  );
}

export function TeamMessageThreadList(props: {
  teamId: string;
  teamName: string;
  canPost: boolean;
  threads: TeamThreadSummary[];
  profiles: Profile[];
  candidates: Profile[];
}) {
  return (
    <ThreadList
      scope={{ kind: "team", id: props.teamId, name: props.teamName }}
      canPost={props.canPost}
      threads={props.threads}
      profiles={props.profiles}
      candidates={props.candidates}
    />
  );
}

function ThreadList({
  scope,
  canPost,
  threads,
  profiles,
  candidates,
}: {
  scope: Scope;
  canPost: boolean;
  threads: (MessageThreadSummary & { following?: boolean })[];
  profiles: Profile[];
  candidates: Profile[];
}) {
  const nameOf = useNames(profiles);
  const [pending, run] = useServerAction();
  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  useMessagesRealtime(scope, "messages", false);
  const team = scope.kind === "team" ? scope : null;

  function submit() {
    if (!title.trim() || !body.trim()) return;
    run(() => ACTIONS[scope.kind].create(scope.id, title, body));
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-gutter py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900">Messages</h2>
          <p className="text-sm text-zinc-600">
            {team
              ? `Conversations for everyone on ${team.name}: announcements, questions, and decisions. Everyone in the workspace can read them; team members post.`
              : "Project-wide conversations: announcements, questions, and decisions that aren’t about one task."}
          </p>
        </div>
        {canPost && !composing ? (
          <button type="button" className="btn-primary" onClick={() => setComposing(true)}>
            <MessagesSquare className="size-4" aria-hidden /> New message
          </button>
        ) : null}
      </div>

      {composing ? (
        <form
          className="space-y-2 rounded-lg border border-zinc-200 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label htmlFor="message-title" className="sr-only">
            Title
          </label>
          <input
            id="message-title"
            value={title}
            maxLength={200}
            required
            autoFocus
            onChange={(e) => setTitle(e.currentTarget.value)}
            placeholder="Title"
            className="control w-full font-medium"
          />
          <label htmlFor="message-body" className="sr-only">
            Message
          </label>
          <MentionTextarea
            id="message-body"
            rows={4}
            value={body}
            onValueChange={setBody}
            candidates={candidates}
            onSubmit={submit}
            placeholder={
              team ? "Write a message. Type @ to mention someone" : "Write a message. Type @ to mention someone in this project"
            }
            className={COMMENT_INPUT}
          />
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-xs text-zinc-500">
              {team
                ? `Everyone on ${team.name} is notified. Anyone you @mention is too, and follows the thread.`
                : "Only project members can be @mentioned."}
            </span>
            <button type="button" className="btn-ghost" onClick={() => setComposing(false)}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={pending || !title.trim() || !body.trim()}>
              Post
            </button>
          </div>
        </form>
      ) : null}

      {threads.length === 0 ? (
        <EmptyState icon={MessagesSquare} title="No messages yet">
          {team
            ? canPost
              ? `Start a thread to share an update or ask ${team.name} a question. Everyone on the team hears about it; replies, @mentions, and reactions work like task comments.`
              : `Messages posted to ${team.name} show up here. Team members can start one.`
            : canPost
              ? "Start a thread to share an update or ask the project a question. Replies, @mentions, and reactions work like task comments."
              : "Messages posted in this project show up here. Commenters and above can start one."}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200" aria-label="Message threads">
          {threads.map((t) => (
            <li key={t.id} className="hover:bg-zinc-50">
              <Link href={`${basePath(scope)}/${t.id}`} className="flex gap-3 px-4 py-3">
                <Avatar name={nameOf(t.authorId)} size="md" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-zinc-900">{t.title}</span>
                    {t.following ? <span className="chip shrink-0">Following</span> : null}
                  </span>
                  <span className="mt-0.5 line-clamp-1 block text-sm text-zinc-500">{t.body}</span>
                  <span className="mt-1 block text-xs text-zinc-400">
                    {nameOf(t.authorId)} · {t.replyCount} {t.replyCount === 1 ? "reply" : "replies"} · last activity{" "}
                    <Timestamp iso={t.lastActivityAt} />
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// One thread
// ---------------------------------------------------------------------------------------------

export function MessageThreadView(props: {
  thread: MessageThread;
  profiles: Profile[];
  candidates: Profile[];
  memberId: string;
}) {
  const canPost = useCan("commenter");
  return (
    <ThreadView
      scope={{ kind: "project", id: props.thread.projectId }}
      thread={props.thread}
      canPost={canPost}
      profiles={props.profiles}
      candidates={props.candidates}
      memberId={props.memberId}
      followerIds={null}
    />
  );
}

export function TeamMessageThreadView(props: {
  thread: TeamMessageThread;
  teamName: string;
  canPost: boolean;
  profiles: Profile[];
  candidates: Profile[];
  memberId: string;
}) {
  return (
    <ThreadView
      scope={{ kind: "team", id: props.thread.teamId, name: props.teamName }}
      thread={props.thread}
      canPost={props.canPost}
      profiles={props.profiles}
      candidates={props.candidates}
      memberId={props.memberId}
      followerIds={props.thread.followerIds}
    />
  );
}

function ThreadView({
  scope,
  thread,
  canPost,
  profiles,
  candidates,
  memberId,
  followerIds,
}: {
  scope: Scope;
  thread: ProjectMessage & { title: string; replies: ProjectMessage[] };
  canPost: boolean;
  profiles: Profile[];
  candidates: Profile[];
  memberId: string;
  // Team threads: who follows it (null for project threads, which have no following).
  followerIds: string[] | null;
}) {
  const nameOf = useNames(profiles);
  const [pending, run] = useServerAction();
  const [reply, setReply] = useState("");
  useMessagesRealtime(scope, "thread", true);

  function submitReply() {
    const body = reply.trim();
    if (!body) return;
    setReply("");
    run(async () => {
      const result = await ACTIONS[scope.kind].reply(thread.id, body);
      if (result.error) setReply(body);
      return result;
    });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-gutter py-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href={basePath(scope)} className="btn-ghost -ml-2 w-fit">
          <ChevronLeft className="size-4" aria-hidden /> All messages
        </Link>
        {followerIds ? (
          <FollowControl threadId={thread.id} memberId={memberId} followerIds={followerIds} nameOf={nameOf} />
        ) : null}
      </div>

      <article className="rounded-lg border border-zinc-200 p-4" aria-labelledby="thread-title">
        <MessageItem
          scope={scope}
          message={thread}
          title={thread.title}
          isThread
          nameOf={nameOf}
          profiles={profiles}
          candidates={candidates}
          memberId={memberId}
          canPost={canPost}
        />
      </article>

      <section aria-label={`Replies (${thread.replies.length})`} className="space-y-3">
        <h2 className="text-xs font-medium text-zinc-500">
          {thread.replies.length} {thread.replies.length === 1 ? "reply" : "replies"}
        </h2>
        {thread.replies.length ? (
          <ol className="space-y-4">
            {thread.replies.map((r) => (
              <li key={r.id} id={`message-${r.id}`} className="scroll-mt-20">
                <MessageItem
                  scope={scope}
                  message={r}
                  nameOf={nameOf}
                  profiles={profiles}
                  candidates={candidates}
                  memberId={memberId}
                  canPost={canPost}
                />
              </li>
            ))}
          </ol>
        ) : null}
      </section>

      {canPost ? (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
          <label htmlFor="message-reply" className="sr-only">
            Reply
          </label>
          <MentionTextarea
            id="message-reply"
            rows={2}
            value={reply}
            onValueChange={setReply}
            candidates={candidates}
            onSubmit={submitReply}
            placeholder={scope.kind === "team" ? "Reply. Type @ to mention someone" : "Reply. Type @ to mention someone in this project"}
            className={COMMENT_INPUT}
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            {scope.kind === "team" ? (
              <span className="mr-auto text-xs text-zinc-500">Replying makes you follow this thread.</span>
            ) : null}
            <button type="button" className="btn-primary" onClick={submitReply} disabled={pending || !reply.trim()}>
              Reply
            </button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-zinc-600">
          {scope.kind === "team"
            ? `You can read this thread. Members of ${scope.name} can reply and react; follow it to hear about replies.`
            : "You can read this thread. Commenters and above can reply and react."}
        </p>
      )}
    </div>
  );
}

// Team threads: Follow / Following (replies reach the Inbox of everyone following) and who follows.
function FollowControl({
  threadId,
  memberId,
  followerIds,
  nameOf,
}: {
  threadId: string;
  memberId: string;
  followerIds: string[];
  nameOf: (profileId: string | null) => string;
}) {
  const [pending, run] = useServerAction();
  const serverFollowing = followerIds.includes(memberId);
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const following = optimistic ?? serverFollowing;
  const others = followerIds.filter((id) => id !== memberId);
  const shown = following ? [memberId, ...others] : others;
  const names = shown.map((id) => (id === memberId ? "You" : nameOf(id)));

  return (
    <div className="flex items-center gap-2">
      {shown.length ? (
        <span className="flex items-center gap-1.5 text-xs text-zinc-500" data-tooltip={`Following: ${names.join(", ")}`}>
          <span className="flex -space-x-1.5" aria-hidden>
            {shown.slice(0, 4).map((id) => (
              <span key={id} className="rounded-full ring-2 ring-white">
                <Avatar name={id === memberId ? nameOf(memberId) : nameOf(id)} />
              </span>
            ))}
          </span>
          <span>
            {shown.length} following
            <span className="sr-only">: {names.join(", ")}</span>
          </span>
        </span>
      ) : null}
      <button
        type="button"
        className={following ? "btn-secondary" : "btn-primary"}
        aria-pressed={following}
        disabled={pending}
        onClick={() => {
          const next = !following;
          setOptimistic(next);
          run(async () => {
            const result = await setTeamThreadFollowing(threadId, next);
            if (result.error) setOptimistic(null);
            return result;
          });
        }}
      >
        {following ? <BellOff className="size-4" aria-hidden /> : <Bell className="size-4" aria-hidden />}
        {following ? "Unfollow" : "Follow"}
      </button>
    </div>
  );
}

function MessageItem({
  scope,
  message,
  title,
  isThread = false,
  nameOf,
  profiles,
  candidates,
  memberId,
  canPost,
}: {
  scope: Scope;
  message: ProjectMessage;
  title?: string;
  isThread?: boolean;
  nameOf: (profileId: string | null) => string;
  profiles: Profile[];
  candidates: Profile[];
  memberId: string;
  canPost: boolean;
}) {
  const [pending, run] = useServerAction();
  const [draft, setDraft] = useState<{ title: string; body: string } | null>(null);
  const mine = message.authorId === memberId && canPost;
  const author = nameOf(message.authorId);
  const actions = ACTIONS[scope.kind];

  function save() {
    if (!draft || !draft.body.trim() || (isThread && !draft.title.trim())) return;
    run(async () => {
      const result = await actions.edit(message.id, isThread ? draft : { body: draft.body });
      if (!result.error) setDraft(null);
      return result;
    });
  }

  return (
    <div className="group flex gap-2.5">
      <Avatar name={author} size="md" />
      <div className="min-w-0 flex-1">
        {isThread && !draft ? (
          <h1 id="thread-title" className="text-base font-semibold text-zinc-900">
            {title}
          </h1>
        ) : null}
        <div className="flex items-baseline gap-2">
          <Link href={personHref(message.authorId)} className="text-sm font-medium text-zinc-900 hover:underline">
            {author}
          </Link>
          <Timestamp iso={message.createdAt} className="text-xs text-zinc-400" />
          {message.editedAt ? <span className="text-xs text-zinc-400">(edited)</span> : null}
          {mine && !draft ? (
            <span className="ml-auto flex items-center opacity-0 focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
              <button
                type="button"
                aria-label={isThread ? "Edit message" : "Edit reply"}
                data-tooltip="Edit"
                onClick={() => setDraft({ title: title ?? "", body: message.body })}
                className="btn-icon"
              >
                <Pencil className="size-3.5" aria-hidden />
              </button>
              <button
                type="button"
                aria-label={isThread ? "Delete message and its replies" : "Delete reply"}
                data-tooltip="Delete"
                onClick={() => {
                  if (window.confirm(isThread ? "Delete this message and hide its replies?" : "Delete this reply?")) {
                    run(() => actions.remove(message.id, isThread ? scope.id : undefined));
                  }
                }}
                className="btn-icon hover:text-red-600"
              >
                <Trash2 className="size-3.5" aria-hidden />
              </button>
            </span>
          ) : null}
        </div>
        {draft ? (
          <div className="mt-1 space-y-2">
            {isThread ? (
              <>
                <label htmlFor={`edit-title-${message.id}`} className="sr-only">
                  Title
                </label>
                <input
                  id={`edit-title-${message.id}`}
                  value={draft.title}
                  maxLength={200}
                  onChange={(e) => setDraft({ ...draft, title: e.currentTarget.value })}
                  className="control w-full font-medium"
                />
              </>
            ) : null}
            <label htmlFor={`edit-body-${message.id}`} className="sr-only">
              Message
            </label>
            <MentionTextarea
              id={`edit-body-${message.id}`}
              value={draft.body}
              onValueChange={(body) => setDraft({ ...draft, body })}
              candidates={candidates}
              onSubmit={save}
              onCancel={() => setDraft(null)}
              autoFocus
              rows={3}
              className={COMMENT_INPUT}
            />
            <div className="flex items-center justify-end gap-2">
              <span className="mr-auto text-xs text-zinc-500">People you newly @mention are notified.</span>
              <button type="button" className="btn-ghost" onClick={() => setDraft(null)}>
                Cancel
              </button>
              <button type="button" className="btn-primary" onClick={save} disabled={pending}>
                Save
              </button>
            </div>
          </div>
        ) : (
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-800">
            <MentionText body={message.body} names={mentionNamesOf(message, profiles)} />
          </p>
        )}
        <ReactionBar
          reactions={message.reactions}
          canReact={canPost}
          memberId={memberId}
          nameOf={nameOf}
          onReact={(emoji) => run(() => actions.react(message.id, emoji))}
        />
      </div>
    </div>
  );
}
