"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronLeft, MessagesSquare, Pencil, Trash2 } from "lucide-react";
import { Avatar, displayName } from "@/components/avatar";
import { useCan } from "@/components/project/project-access";
import { MentionTextarea } from "@/components/task/mention-textarea";
import { COMMENT_INPUT, MentionText, ReactionBar } from "@/components/task/task-activity";
import { Timestamp } from "@/components/timestamp";
import { useServerAction } from "@/components/toast";
import { EmptyState } from "@/components/ui";
import {
  createMessageThread,
  deleteMessage,
  editMessage,
  replyToThread,
  toggleMessageReaction,
} from "@/lib/actions";
import type { MessageThread, MessageThreadSummary, Profile, ProjectMessage } from "@/lib/data";
import { useRealtimeRefresh } from "@/lib/realtime";

// Project Messages: threads (title + body) with replies, @mentions, and reactions on the comment
// machinery. Viewers read; Commenters and above post, reply, and react; authors edit and delete their
// own. @mentions only reach people who can read the project (the database decides).

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

export function MessageThreadList({
  projectId,
  threads,
  profiles,
  candidates,
}: {
  projectId: string;
  threads: MessageThreadSummary[];
  profiles: Profile[];
  candidates: Profile[];
}) {
  const canPost = useCan("commenter");
  const nameOf = useNames(profiles);
  const [pending, run] = useServerAction();
  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  useRealtimeRefresh(`messages-${projectId}`, [{ table: "project_messages", filter: `project_id=eq.${projectId}` }]);

  function submit() {
    if (!title.trim() || !body.trim()) return;
    run(() => createMessageThread(projectId, title, body));
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-gutter py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900">Messages</h2>
          <p className="text-sm text-zinc-600">
            Project-wide conversations: announcements, questions, and decisions that aren’t about one task.
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
            placeholder="Write a message. Type @ to mention someone in this project"
            className={COMMENT_INPUT}
          />
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-xs text-zinc-500">Only project members can be @mentioned.</span>
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
          {canPost
            ? "Start a thread to share an update or ask the project a question. Replies, @mentions, and reactions work like task comments."
            : "Messages posted in this project show up here. Commenters and above can start one."}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200" aria-label="Message threads">
          {threads.map((t) => (
            <li key={t.id} className="hover:bg-zinc-50">
              <Link href={`/projects/${projectId}/messages/${t.id}`} className="flex gap-3 px-4 py-3">
                <Avatar name={nameOf(t.authorId)} size="md" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-zinc-900">{t.title}</span>
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

export function MessageThreadView({
  thread,
  profiles,
  candidates,
  memberId,
}: {
  thread: MessageThread;
  profiles: Profile[];
  candidates: Profile[];
  memberId: string;
}) {
  const canPost = useCan("commenter");
  const nameOf = useNames(profiles);
  const [pending, run] = useServerAction();
  const [reply, setReply] = useState("");
  useRealtimeRefresh(`thread-${thread.id}`, [
    { table: "project_messages", filter: `project_id=eq.${thread.projectId}` },
    { table: "project_message_reactions", filter: `project_id=eq.${thread.projectId}` },
  ]);

  function submitReply() {
    const body = reply.trim();
    if (!body) return;
    setReply("");
    run(async () => {
      const result = await replyToThread(thread.id, body);
      if (result.error) setReply(body);
      return result;
    });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-gutter py-5">
      <Link href={`/projects/${thread.projectId}/messages`} className="btn-ghost -ml-2 w-fit">
        <ChevronLeft className="size-4" aria-hidden /> All messages
      </Link>

      <article className="rounded-lg border border-zinc-200 p-4" aria-labelledby="thread-title">
        <MessageItem
          message={thread}
          title={thread.title}
          projectId={thread.projectId}
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
                  message={r}
                  projectId={thread.projectId}
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
            placeholder="Reply. Type @ to mention someone in this project"
            className={COMMENT_INPUT}
          />
          <div className="mt-2 flex justify-end">
            <button type="button" className="btn-primary" onClick={submitReply} disabled={pending || !reply.trim()}>
              Reply
            </button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-zinc-600">You can read this thread. Commenters and above can reply and react.</p>
      )}
    </div>
  );
}

function MessageItem({
  message,
  title,
  projectId,
  isThread = false,
  nameOf,
  profiles,
  candidates,
  memberId,
  canPost,
}: {
  message: ProjectMessage;
  title?: string;
  projectId: string;
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

  function save() {
    if (!draft || !draft.body.trim() || (isThread && !draft.title.trim())) return;
    run(async () => {
      const result = await editMessage(message.id, isThread ? draft : { body: draft.body });
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
          <span className="text-sm font-medium text-zinc-900">{author}</span>
          <Timestamp iso={message.createdAt} className="text-xs text-zinc-400" />
          {message.editedAt ? <span className="text-xs text-zinc-400">(edited)</span> : null}
          {mine && !draft ? (
            <span className="ml-auto flex items-center opacity-0 focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
              <button
                type="button"
                aria-label={isThread ? "Edit message" : "Edit reply"}
                title="Edit"
                onClick={() => setDraft({ title: title ?? "", body: message.body })}
                className="btn-icon"
              >
                <Pencil className="size-3.5" aria-hidden />
              </button>
              <button
                type="button"
                aria-label={isThread ? "Delete message and its replies" : "Delete reply"}
                title="Delete"
                onClick={() => {
                  if (window.confirm(isThread ? "Delete this message and hide its replies?" : "Delete this reply?")) {
                    run(() => deleteMessage(message.id, isThread ? projectId : undefined));
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
          onReact={(emoji) => run(() => toggleMessageReaction(message.id, emoji))}
        />
      </div>
    </div>
  );
}
