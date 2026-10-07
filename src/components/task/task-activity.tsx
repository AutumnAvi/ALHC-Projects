"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Bell, BellOff, Pencil, SmilePlus, Trash2 } from "lucide-react";
import { Avatar, displayName } from "@/components/avatar";
import { Popover } from "@/components/popover";
import { Timestamp } from "@/components/timestamp";
import { useServerAction } from "@/components/toast";
import { MentionTextarea } from "@/components/task/mention-textarea";
import { addComment, deleteComment, editComment, setFollowing, toggleReaction } from "@/lib/actions";
import { REACTIONS, reactionOf, type ReactionKey } from "@/lib/reactions";
import { formatDueDate } from "@/lib/dates";
import type { Profile, TaskComment, TaskDetail, TaskStory } from "@/lib/data";
import { hasRole } from "@/lib/roles";
import { fieldChips } from "@/lib/fields";
import type { Json } from "@/lib/supabase/database.types";
import { useRealtimeRefresh } from "@/lib/realtime";
import { describeRecurrence, parseRecurrence } from "@/lib/recurrence";
import { TASK_KIND_LABELS, parseTaskKind } from "@/lib/task-kinds";
import { useTaskHref } from "@/components/project/shared";

type Entry =
  | { type: "comment"; at: string; comment: TaskComment }
  | { type: "story"; at: string; story: TaskStory };

function str(data: Json, key: string): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = (data as Record<string, Json | undefined>)[key];
  return typeof value === "string" ? value : null;
}

export function TaskActivity({
  task,
  profiles,
  memberId,
}: {
  task: TaskDetail;
  profiles: Profile[];
  memberId: string;
}) {
  useRealtimeRefresh(`task-${task.id}`, [
    { table: "comments", filter: `task_id=eq.${task.id}` },
    { table: "comment_reactions", filter: `task_id=eq.${task.id}` },
    { table: "task_stories", filter: `task_id=eq.${task.id}` },
  ]);

  const taskHref = useTaskHref();
  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const canComment = hasRole(task.viewerRole, "commenter");
  const candidates = mentionCandidates(task, profiles, memberId);
  const nameOf = (profileId: string | null) => {
    const profile = profileId ? profilesById.get(profileId) : undefined;
    return profile ? displayName(profile) : "Someone";
  };

  const entries: Entry[] = [
    ...task.comments.map((comment) => ({ type: "comment" as const, at: comment.createdAt, comment })),
    ...task.stories.map((story) => ({ type: "story" as const, at: story.createdAt, story })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  function storyActor(story: TaskStory): string {
    const ruleName = str(story.data, "rule_name");
    if (ruleName) return `Rule “${ruleName}”`;
    if (!story.actorId && story.kind === "form_submitted") return str(story.data, "submitter_email") ?? "Someone";
    return nameOf(story.actorId);
  }

  function storyText(story: TaskStory): ReactNode {
    const d = story.data;
    switch (story.kind) {
      case "created": {
        const source = d && typeof d === "object" && !Array.isArray(d) ? d.import : null;
        return source && typeof source === "object" && !Array.isArray(source) && source.source === "asana"
          ? "imported this task from Asana"
          : "created this task";
      }
      case "completed":
        return "marked this task complete";
      case "reopened":
        return "marked this task incomplete";
      case "renamed":
        return <>renamed this to “{str(d, "to")}”</>;
      case "assigned": {
        const assignee = str(d, "assignee_id");
        return assignee === story.actorId ? "assigned this to themselves" : <>assigned this to {nameOf(assignee)}</>;
      }
      case "unassigned":
        return "removed the assignee";
      case "due_changed": {
        const to = str(d, "to");
        return to ? <>changed the due date to {formatDueDate(to)}</> : "removed the due date";
      }
      case "start_changed": {
        const to = str(d, "to");
        return to ? <>changed the start date to {formatDueDate(to)}</> : "removed the start date";
      }
      case "section_changed":
        return (
          <>
            moved this to {str(d, "to") ?? "No section"} in {str(d, "project_name")}
          </>
        );
      case "project_added":
        return <>added this to {str(d, "project_name")}</>;
      case "project_removed":
        return <>removed this from {str(d, "project_name")}</>;
      case "attachment_added":
        return <>attached {str(d, "file_name")}</>;
      case "approval_requested":
        return <>requested approval from {nameOf(str(d, "approver_id"))}</>;
      case "approval_decided": {
        const note = str(d, "note");
        const verb =
          str(d, "status") === "approved"
            ? "approved this"
            : str(d, "status") === "rejected"
              ? "rejected this"
              : "requested changes";
        return note ? <>{verb}: “{note}”</> : verb;
      }
      case "approval_cancelled":
        return <>cancelled the approval request for {nameOf(str(d, "approver_id"))}</>;
      case "approval_resubmitted":
        return <>resubmitted this to {nameOf(str(d, "approver_id"))} for approval</>;
      case "form_submitted":
        return <>submitted the form “{str(d, "form_title")}”</>;
      case "request_number_assigned":
        return <>assigned request number {str(d, "label")}</>;
      case "email_queued":
        return <>emailed {str(d, "to")}</>;
      case "integration_queued":
        return str(d, "channel") === "slack" ? (
          <>queued a Slack message to {str(d, "target")}</>
        ) : (
          <>queued a webhook call to {str(d, "target")}</>
        );
      case "integration_failed":
        return (
          <>
            couldn’t deliver a {str(d, "channel") === "slack" ? "Slack message" : "webhook call"} to {str(d, "target")}{" "}
            after {String(d && typeof d === "object" && !Array.isArray(d) ? (d.attempts ?? 5) : 5)} attempts
          </>
        );
      case "field_changed": {
        const fieldId = str(d, "field_id");
        const field = task.fields.find((f) => f.id === fieldId);
        const value = d && typeof d === "object" && !Array.isArray(d) ? d.value : null;
        const label = field
          ? fieldChips(field, value ?? null, {
              personName: (personId) => {
                const p = profilesById.get(personId);
                return p ? displayName(p) : null;
              },
            })
              .map((chip) => chip.label)
              .join(", ")
          : "";
        return label ? (
          <>
            set {str(d, "field_name")} to {label}
          </>
        ) : (
          <>cleared {str(d, "field_name")}</>
        );
      }
      case "recurrence_changed": {
        const rule = d && typeof d === "object" && !Array.isArray(d) ? parseRecurrence(d.recurrence) : null;
        return rule ? <>set this to repeat ({describeRecurrence(rule)})</> : "stopped this task repeating";
      }
      case "recurrence_spawned": {
        const nextId = str(d, "next_task_id");
        const due = str(d, "due_on");
        return (
          <>
            created the{" "}
            {nextId ? (
              <Link href={taskHref(nextId)} scroll={false} className="text-accent-700 hover:underline">
                next occurrence
              </Link>
            ) : (
              "next occurrence"
            )}
            {due ? <>, due {formatDueDate(due)}</> : null}
          </>
        );
      }
      case "dependency_added":
      case "dependency_removed": {
        const verb = story.kind === "dependency_added" ? "marked" : "unmarked";
        const other = <>“{str(d, "task_title")}”</>;
        return str(d, "relation") === "blocked_by" ? (
          <>
            {verb} this as blocked by {other}
          </>
        ) : (
          <>
            {verb} this as blocking {other}
          </>
        );
      }
      case "restored":
        return "restored this task from the Trash";
      case "kind_changed":
        return <>changed the type to {TASK_KIND_LABELS[parseTaskKind(str(d, "to"))].toLowerCase()}</>;
      default:
        return "updated this task";
    }
  }

  return (
    <section className="mt-8 border-t border-zinc-200 pt-4" aria-labelledby="activity-heading">
      <h3 id="activity-heading" className="text-sm font-semibold text-zinc-900">
        Activity
      </h3>
      <ol className="mt-3 flex flex-col gap-3">
        {entries.map((entry) =>
          entry.type === "story" ? (
            <li key={entry.story.id} className="flex items-baseline gap-2 pl-1 text-xs text-zinc-500">
              <span aria-hidden className="size-1.5 shrink-0 translate-y-[-1px] rounded-full bg-zinc-300" />
              <p className="min-w-0">
                <span className="font-medium text-zinc-700">{storyActor(entry.story)}</span>{" "}
                {storyText(entry.story)} · <Timestamp iso={entry.story.createdAt} />
              </p>
            </li>
          ) : (
            <CommentItem
              key={entry.comment.id}
              comment={entry.comment}
              authorName={entry.comment.ruleName ? `Rule “${entry.comment.ruleName}”` : nameOf(entry.comment.authorId)}
              mine={entry.comment.authorId !== null && entry.comment.authorId === memberId}
              canComment={canComment}
              memberId={memberId}
              nameOf={nameOf}
              candidates={candidates}
              mentionNames={entry.comment.mentionIds.map((mentionId) => nameOf(mentionId))}
            />
          ),
        )}
      </ol>
    </section>
  );
}

// People who can read the task (members of its projects), for @mention autocomplete; not the viewer.
function mentionCandidates(task: TaskDetail, profiles: Profile[], memberId: string): Profile[] {
  return profiles
    .filter((p) => p.id !== memberId && task.memberRoles[p.id] !== undefined)
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));
}

export const COMMENT_INPUT =
  "field-sizing-content min-h-16 w-full resize-none rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm placeholder:text-zinc-400 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-100";

function CommentItem({
  comment,
  authorName,
  mine,
  canComment,
  memberId,
  nameOf,
  candidates,
  mentionNames,
}: {
  comment: TaskComment;
  authorName: string;
  mine: boolean;
  canComment: boolean;
  memberId: string;
  nameOf: (profileId: string | null) => string;
  candidates: Profile[];
  mentionNames: string[];
}) {
  const [pending, run] = useServerAction();
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  const editable = mine && canComment && !comment.deleted;

  function save() {
    const body = draft?.trim();
    if (!body) return;
    if (body === comment.body) return setDraft(null);
    run(async () => {
      const result = await editComment(comment.id, body);
      if (!result.error) setDraft(null);
      return result;
    });
  }

  if (comment.deleted) {
    return (
      <li className="flex gap-2.5">
        <Avatar name={authorName} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium text-zinc-500">{authorName}</span>
            <Timestamp iso={comment.createdAt} className="text-xs text-zinc-400" />
          </div>
          <p className="mt-0.5 text-sm italic text-zinc-400">Comment deleted</p>
        </div>
      </li>
    );
  }

  return (
    <li className="group flex gap-2.5">
      <Avatar name={authorName} size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-zinc-900">{authorName}</span>
          <Timestamp iso={comment.createdAt} className="text-xs text-zinc-400" />
          {comment.editedAt ? (
            <span className="text-xs text-zinc-400">
              (edited<span className="sr-only">
                {" "}
                <Timestamp iso={comment.editedAt} />
              </span>
              )
            </span>
          ) : null}
          {editable && !editing ? (
            <span className="ml-auto flex items-center opacity-0 focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
              <button
                type="button"
                aria-label="Edit comment"
                title="Edit"
                onClick={() => setDraft(comment.body)}
                className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"
              >
                <Pencil className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label="Delete comment"
                title="Delete"
                onClick={() => {
                  if (window.confirm("Delete this comment?")) run(() => deleteComment(comment.id));
                }}
                className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-red-600"
              >
                <Trash2 className="size-3.5" />
              </button>
            </span>
          ) : null}
        </div>
        {editing ? (
          <div className="mt-1">
            <label htmlFor={`edit-comment-${comment.id}`} className="sr-only">
              Edit comment
            </label>
            <MentionTextarea
              id={`edit-comment-${comment.id}`}
              value={draft}
              onValueChange={setDraft}
              candidates={candidates}
              onSubmit={save}
              onCancel={() => setDraft(null)}
              autoFocus
              rows={2}
              className={COMMENT_INPUT}
            />
            <div className="mt-1.5 flex items-center justify-end gap-2">
              <span className="mr-auto text-xs text-zinc-500">People you newly @mention are notified.</span>
              <button type="button" onClick={() => setDraft(null)} className="btn-ghost">
                Cancel
              </button>
              <button type="button" onClick={save} disabled={pending || !draft.trim()} className="btn-primary">
                Save
              </button>
            </div>
          </div>
        ) : (
          <p className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-800">
            <MentionText body={comment.body} names={mentionNames} />
          </p>
        )}
        <Reactions comment={comment} canReact={canComment} memberId={memberId} nameOf={nameOf} />
      </div>
    </li>
  );
}

function Reactions({
  comment,
  canReact,
  memberId,
  nameOf,
}: {
  comment: TaskComment;
  canReact: boolean;
  memberId: string;
  nameOf: (profileId: string | null) => string;
}) {
  const [, run] = useServerAction();
  return (
    <ReactionBar
      reactions={comment.reactions}
      canReact={canReact}
      memberId={memberId}
      nameOf={nameOf}
      onReact={(emoji) => run(() => toggleReaction(comment.id, emoji))}
    />
  );
}

// Reaction chips + an add-reaction picker (comments and project messages share it).
export function ReactionBar({
  reactions,
  canReact,
  memberId,
  nameOf,
  onReact,
}: {
  reactions: { emoji: ReactionKey; profileIds: string[] }[];
  canReact: boolean;
  memberId: string;
  nameOf: (profileId: string | null) => string;
  onReact: (emoji: ReactionKey) => void;
}) {
  if (reactions.length === 0 && !canReact) return null;
  const react = onReact;

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {reactions.map(({ emoji, profileIds }) => {
        const { emoji: glyph, label } = reactionOf(emoji);
        const mine = profileIds.includes(memberId);
        const who = profileIds.map((profileId) => (profileId === memberId ? "You" : nameOf(profileId))).join(", ");
        return (
          <button
            key={emoji}
            type="button"
            disabled={!canReact}
            aria-pressed={mine}
            aria-label={`${label}: ${who}${canReact ? (mine ? ". Remove your reaction" : ". Add your reaction") : ""}`}
            title={who}
            onClick={() => react(emoji)}
            className="inline-flex h-6 items-center gap-1 rounded-full border border-zinc-200 bg-white px-2 text-xs tabular-nums text-zinc-700 hover:border-zinc-300 disabled:hover:border-zinc-200 aria-pressed:border-accent-300 aria-pressed:bg-accent-50 aria-pressed:text-accent-800"
          >
            <span aria-hidden>{glyph}</span>
            {profileIds.length}
          </button>
        );
      })}
      {canReact ? (
        <Popover
          label="Add reaction"
          button={<SmilePlus className="size-3.5" />}
          buttonClassName={`inline-flex h-6 items-center rounded-full px-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 aria-expanded:bg-zinc-100 ${
            reactions.length ? "" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100 [@media(hover:none)]:opacity-100"
          }`}
          panelClassName="w-auto"
        >
          {(close) => (
            <div className="flex gap-0.5 p-1">
              {REACTIONS.map(({ key, emoji, label }) => (
                <button
                  key={key}
                  type="button"
                  aria-label={label}
                  title={label}
                  onClick={() => {
                    close();
                    react(key);
                  }}
                  className="flex size-8 items-center justify-center rounded text-base hover:bg-zinc-100"
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </Popover>
      ) : null}
    </div>
  );
}

export function MentionText({ body, names }: { body: string; names: string[] }) {
  if (names.length === 0) return <>{body}</>;
  const escaped = [...names]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts = body.split(new RegExp(`(@(?:${escaped.join("|")}))`, "gi"));
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <span key={index} className="rounded bg-accent-50 px-0.5 font-medium text-accent-700">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

export function CommentComposer({
  task,
  profiles,
  memberId,
}: {
  task: TaskDetail;
  profiles: Profile[];
  memberId: string;
}) {
  const [pending, run] = useServerAction();
  const [draft, setDraft] = useState("");
  const following = task.followerIds.includes(memberId);
  const followers = task.followerIds
    .map((followerId) => profiles.find((p) => p.id === followerId))
    .filter((p): p is Profile => Boolean(p));

  const canComment = hasRole(task.viewerRole, "commenter");

  function submit() {
    const body = draft.trim();
    if (!body) return;
    setDraft("");
    run(async () => {
      const result = await addComment(task.id, body);
      if (result.error) setDraft(body);
      return result;
    });
  }

  return (
    <div className="shrink-0 border-t border-zinc-200 bg-zinc-50 px-gutter py-2.5">
      {canComment ? (
        <>
          <label htmlFor="new-comment" className="sr-only">
            Add a comment
          </label>
          <MentionTextarea
            id="new-comment"
            rows={2}
            value={draft}
            onValueChange={setDraft}
            candidates={mentionCandidates(task, profiles, memberId)}
            onSubmit={submit}
            placeholder="Add a comment. Type @ to mention someone"
            className={COMMENT_INPUT}
          />
          <div className="mt-2 flex items-center gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-2 text-xs text-zinc-500">
              <span className="shrink-0">Followers</span>
              <span className="flex -space-x-1" aria-label={`Followers: ${followers.map(displayName).join(", ")}`}>
                {followers.slice(0, 6).map((p) => (
                  <span key={p.id} className="rounded-full ring-2 ring-zinc-50">
                    <Avatar name={displayName(p)} />
                  </span>
                ))}
              </span>
              <button
                type="button"
                onClick={() => run(() => setFollowing(task.id, memberId, !following))}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-zinc-200/70 hover:text-zinc-800"
              >
                {following ? <BellOff className="size-3.5" /> : <Bell className="size-3.5" />}
                {following ? "Unfollow" : "Follow"}
              </button>
            </div>
            <button
              type="button"
              onClick={submit}
              disabled={pending}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-60"
            >
              Comment
            </button>
          </div>
        </>
      ) : (
        <p className="text-sm text-zinc-600">You can view this task. Commenters and above can comment and follow.</p>
      )}
    </div>
  );
}
