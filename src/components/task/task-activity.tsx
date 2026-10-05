"use client";

import { useRef, type ReactNode } from "react";
import { Bell, BellOff, Trash2 } from "lucide-react";
import { Avatar, displayName } from "@/components/avatar";
import { Timestamp } from "@/components/timestamp";
import { useServerAction } from "@/components/toast";
import { addComment, deleteComment, setFollowing } from "@/lib/actions";
import { formatDueDate } from "@/lib/dates";
import type { Profile, TaskComment, TaskDetail, TaskStory } from "@/lib/data";
import { fieldChips } from "@/lib/fields";
import type { Json } from "@/lib/supabase/database.types";
import { useRealtimeRefresh } from "@/lib/realtime";

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
    { table: "task_stories", filter: `task_id=eq.${task.id}` },
  ]);

  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const nameOf = (profileId: string | null) => {
    const profile = profileId ? profilesById.get(profileId) : undefined;
    return profile ? displayName(profile) : "Someone";
  };

  const entries: Entry[] = [
    ...task.comments.map((comment) => ({ type: "comment" as const, at: comment.createdAt, comment })),
    ...task.stories.map((story) => ({ type: "story" as const, at: story.createdAt, story })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  function storyText(story: TaskStory): ReactNode {
    const d = story.data;
    switch (story.kind) {
      case "created":
        return "created this task";
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
      default:
        return "updated this task";
    }
  }

  return (
    <section className="mt-8 border-t border-zinc-100 pt-5" aria-labelledby="activity-heading">
      <h3 id="activity-heading" className="text-sm font-medium text-zinc-900">
        Activity
      </h3>
      <ol className="mt-3 flex flex-col gap-3">
        {entries.map((entry) =>
          entry.type === "story" ? (
            <li key={entry.story.id} className="flex items-baseline gap-2 pl-1 text-xs text-zinc-500">
              <span aria-hidden className="size-1.5 shrink-0 translate-y-[-1px] rounded-full bg-zinc-300" />
              <p className="min-w-0">
                <span className="font-medium text-zinc-700">{nameOf(entry.story.actorId)}</span>{" "}
                {storyText(entry.story)} · <Timestamp iso={entry.story.createdAt} />
              </p>
            </li>
          ) : (
            <CommentItem
              key={entry.comment.id}
              comment={entry.comment}
              authorName={nameOf(entry.comment.authorId)}
              mine={entry.comment.authorId === memberId}
              mentionNames={entry.comment.mentionIds.map((mentionId) => nameOf(mentionId))}
            />
          ),
        )}
      </ol>
    </section>
  );
}

function CommentItem({
  comment,
  authorName,
  mine,
  mentionNames,
}: {
  comment: TaskComment;
  authorName: string;
  mine: boolean;
  mentionNames: string[];
}) {
  const [, run] = useServerAction();
  return (
    <li className="group flex gap-2.5">
      <Avatar name={authorName} size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-zinc-900">{authorName}</span>
          <Timestamp iso={comment.createdAt} className="text-xs text-zinc-400" />
          {mine ? (
            <button
              type="button"
              aria-label="Delete comment"
              onClick={() => {
                if (window.confirm("Delete this comment?")) run(() => deleteComment(comment.id));
              }}
              className="ml-auto rounded p-1 text-zinc-400 opacity-0 hover:bg-zinc-100 hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100"
            >
              <Trash2 className="size-3.5" />
            </button>
          ) : null}
        </div>
        <p className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-800">
          <MentionText body={comment.body} names={mentionNames} />
        </p>
      </div>
    </li>
  );
}

function MentionText({ body, names }: { body: string; names: string[] }) {
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
  const ref = useRef<HTMLTextAreaElement>(null);
  const following = task.followerIds.includes(memberId);
  const followers = task.followerIds
    .map((followerId) => profiles.find((p) => p.id === followerId))
    .filter((p): p is Profile => Boolean(p));

  function submit() {
    const body = ref.current?.value.trim();
    if (!ref.current || !body) return;
    ref.current.value = "";
    run(() => addComment(task.id, body));
  }

  return (
    <div className="shrink-0 border-t border-zinc-200 bg-zinc-50/80 px-6 py-3">
      <label htmlFor="new-comment" className="sr-only">
        Add a comment
      </label>
      <textarea
        ref={ref}
        id="new-comment"
        rows={2}
        placeholder="Add a comment. Mention teammates with @Name"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
        className="field-sizing-content min-h-16 w-full resize-none rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm placeholder:text-zinc-400 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-100"
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
    </div>
  );
}
