"use client";

import { TaskReviews } from "@/components/task/task-reviews";
import { useTagsEnabled } from "@/components/tags/tags-enabled";
import { useEffect, useMemo, useOptimistic, useState, type ReactNode } from "react";
import { Bell, BellOff, Pencil, SmilePlus, Trash2, UserPlus, X } from "lucide-react";
import { Avatar, displayName } from "@/components/avatar";
import { useConfirm } from "@/components/confirm";
import { Popover } from "@/components/popover";
import { Timestamp } from "@/components/timestamp";
import { useNotify, useServerAction } from "@/components/toast";
import { MentionTextarea } from "@/components/task/mention-textarea";
import {
  addComment,
  deleteComment,
  editComment,
  loadOlderComments,
  sendSubmitterResponse,
  setFollowing,
  toggleReaction,
} from "@/lib/actions";
import { canRespondToSubmitter, submitterResponseSubject } from "@/lib/comment-email";
import { mentionSegments } from "@/lib/mentions";
import { mergePendingComments, type PendingComment } from "@/lib/pending-comments";
import { taskPermissions } from "@/lib/permissions";
import { ROLE_LABELS } from "@/lib/roles";
import { EmailCard, EmailCommentHeader, EmailFiles, MailAvatar, MentionText, type DescribePerson } from "./comment-parts";
import {
  addPendingComment,
  dropPendingComment,
  forgetArrivedComments,
  rememberedCommentKeys,
  settlePendingComment,
  usePendingComments,
} from "./pending-comments-store";
import { REACTIONS, reactionOf, type ReactionKey } from "@/lib/reactions";
import { formatDueDate } from "@/lib/dates";
import type { Profile, TaskComment, TaskDetail, TaskStory } from "@/lib/data";
import { fieldChips } from "@/lib/fields";
import type { Json } from "@/lib/supabase/database.types";
import { useRealtimeRefresh } from "@/lib/realtime";
import { describeRecurrence, parseRecurrence } from "@/lib/recurrence";
import { TASK_KIND_LABELS, parseTaskKind } from "@/lib/task-kinds";
import { dependencyLabel, parseDependencyKind } from "@/lib/dependencies";
import { setActivityTab, useActivityTab } from "./pane-size";
import { PeopleList } from "./person-picker";
import { TaskLink } from "@/components/task/task-link";
import { seedFromTitle } from "@/lib/task-seed";

// The live state of a queued email, after "queued an email to …": sending, sent, failed with the reason,
// or not sent because no email provider is configured.
function EmailStatusNote({ email }: { email: TaskStory["email"] }) {
  if (!email) return null;
  switch (email.status) {
    case "sent":
      // Real features 3: what Resend reported after sending, once it has.
      switch (email.delivery) {
        case "delivered":
          return <span className="text-emerald-700"> · Delivered</span>;
        case "delayed":
          return <span className="text-amber-700"> · Sent (delivery delayed)</span>;
        case "bounced":
        case "suppressed":
          return <span className="text-red-700"> · Bounced</span>;
        case "complained":
          return <span className="text-red-700"> · Delivered, then marked as spam</span>;
        default:
          return <span className="text-emerald-700"> · Sent</span>;
      }
    case "mocked":
      return <span className="text-zinc-500"> · Not sent (no email provider is set up)</span>;
    case "sending":
      return <span> · Sending…</span>;
    case "failed":
      return (
        <span className="text-red-700">
          {" "}
          · Failed{email.error ? `: ${email.error}` : ""}
        </span>
      );
    default:
      return email.attempts > 0 ? (
        <span className="text-amber-700">
          {" "}
          · Retrying (attempt {email.attempts} of {email.maxAttempts} failed{email.error ? `: ${email.error}` : ""})
        </span>
      ) : (
        <span> · Queued</span>
      );
  }
}

type Entry =
  | { type: "comment"; at: string; comment: TaskComment; key: string; pending: boolean }
  | { type: "story"; at: string; story: TaskStory };

export { MentionText };

// A comment still on its way to the server, drawn like the real one (Comments and reply by email).
function pendingAsComment(p: PendingComment, mentionIds: string[]): TaskComment {
  return {
    id: p.tempId,
    authorId: p.authorId,
    ruleName: null,
    body: p.body,
    createdAt: p.createdAt,
    editedAt: null,
    deleted: false,
    mentionIds,
    reactions: [],
    email: p.email ? { ...p.email, status: "sending", error: null } : null,
  };
}

function num(data: Json, key: string): number | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data[key];
  return typeof value === "number" ? value : null;
}

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
    { table: "email_outbox", filter: `task_id=eq.${task.id}` },
  ]);

  const tab = useActivityTab();
  const tagsOn = useTagsEnabled();
  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const canComment = taskPermissions(task).canComment;
  const candidates = mentionCandidates(task, profiles, memberId);
  const nameOf = (profileId: string | null) => {
    const profile = profileId ? profilesById.get(profileId) : undefined;
    return profile ? displayName(profile) : "Someone";
  };

  // Optimistic comments: the server's rows, plus the ones still on their way at the end (in the order
  // they were sent), each keeping its React key when the real row replaces it.
  const notify = useNotify();
  const pending = usePendingComments(task.id);
  const [earlier, setEarlier] = useState<TaskComment[]>([]);
  const [olderCursor, setOlderCursor] = useState(task.olderComments);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const commentsOnTask = useMemo(() => {
    const seen = new Set(task.comments.map((comment) => comment.id));
    return [...earlier.filter((comment) => !seen.has(comment.id)), ...task.comments];
  }, [earlier, task.comments]);
  const merged = mergePendingComments(commentsOnTask, pending, rememberedCommentKeys());
  const arrivedKey = merged.arrived.map((a) => a.tempId).join(",");
  useEffect(() => {
    if (arrivedKey) forgetArrivedComments(merged.arrived);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- arrivedKey stands for merged.arrived
  }, [arrivedKey]);
  const profileById = (profileId: string) => profilesById.get(profileId);
  const describe: DescribePerson = (profileId) => {
    const role = task.memberRoles[profileId];
    if (role) return `${ROLE_LABELS[role]} in this task’s ${task.memberships.length === 1 ? "project" : "projects"}`;
    return task.isPrivate && task.privateReaderIds.includes(profileId) ? "Can open this private task" : null;
  };

  const history = useMemo(() => {
    return [
      ...commentsOnTask.map((comment) => ({
        type: "comment" as const,
        at: comment.createdAt,
        comment,
        key: merged.keys.get(comment.id) ?? comment.id,
        pending: false as const,
      })),
      // Oct 26 notes (batch 3): tag lines are hidden while the workspace's tags are switched off.
      ...task.stories
        .filter((story) => tagsOn || (story.kind !== "tag_added" && story.kind !== "tag_removed"))
        .map((story) => ({ type: "story" as const, at: story.createdAt, story })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    // arrivedKey changes when a pending comment becomes a server row (its React key moves with it).
    // Pending-only updates leave it alone, so the feed isn't re-sorted on send.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- merged.keys is current whenever arrivedKey changes
  }, [commentsOnTask, task.stories, arrivedKey, tagsOn]);
  const entries: Entry[] = [
    ...history,
    ...merged.waiting.map((p) => ({
      type: "comment" as const,
      at: p.createdAt,
      comment: pendingAsComment(p, pendingMentionIds(p.body, candidates)),
      key: p.tempId,
      pending: true,
    })),
  ];

  function storyActor(story: TaskStory): string {
    const ruleName = str(story.data, "rule_name");
    if (ruleName) return `Rule “${ruleName}”`;
    if (!story.actorId && story.kind === "form_submitted") return str(story.data, "submitter_email") ?? "Someone";
    // Files a form's (anonymous) submitter attached (Real features 1).
    if (!story.actorId && story.kind === "attachment_added" && str(story.data, "source") === "form") return "The form’s submitter";
    return nameOf(story.actorId);
  }

  function storyText(story: TaskStory): ReactNode {
    const d = story.data;
    switch (story.kind) {
      case "created": {
        const source = d && typeof d === "object" && !Array.isArray(d) ? d.import : null;
        if (source && typeof source === "object" && !Array.isArray(source) && source.source === "asana") {
          return "imported this task from Asana";
        }
        // A forwarded email (Real features 1).
        return str(d, "via") === "email" ? "created this task by forwarding an email" : "created this task";
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
      case "attachment_added": {
        const source = str(d, "source");
        return (
          <>
            attached {str(d, "file_name")}
            {source === "form" ? " with the form" : source === "email" ? " from the forwarded email" : ""}
          </>
        );
      }
      case "approval_requested":
        return <>asked {nameOf(str(d, "approver_id"))} to approve this</>;
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
      case "approval_cancelled": {
        // Oct 27 notes (batch 6): why an approval request ended (data.reason).
        const approver = nameOf(str(d, "approver_id"));
        switch (str(d, "reason")) {
          case "withdrawn":
            return <>withdrew the approval request to {approver}</>;
          case "handed_off": {
            const note = str(d, "note");
            const to = nameOf(str(d, "handoff_to"));
            return note ? (
              <>
                handed off the approval to {to}: “{note}”
              </>
            ) : (
              <>handed off the approval to {to}</>
            );
          }
          case "reassigned":
            return <>removed {approver} as an approver</>;
          case "kind_changed":
            return <>cancelled the approval request to {approver} (it’s no longer an approval task)</>;
          default:
            return <>cancelled the approval request for {approver}</>;
        }
      }
      case "approval_resubmitted":
        // "Feedback received" / "Rejection received" (Oct 27 notes, batch 6) reuse this kind.
        if (str(d, "event") === "acknowledged") {
          return str(d, "status") === "rejected" ? "marked the rejection received" : "marked the feedback received";
        }
        return <>resubmitted this to {nameOf(str(d, "approver_id"))} for approval</>;
      case "form_submitted":
        return <>submitted the form “{str(d, "form_title")}”</>;
      case "inbound_received":
        return <>added this through the inbound webhook “{str(d, "endpoint_name")}”</>;
      case "request_number_assigned":
        return <>assigned request number {str(d, "label")}</>;
      case "email_queued":
        return (
          <>
            queued an email to {str(d, "to")}
            <EmailStatusNote email={story.email ?? null} />
          </>
        );
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
              <TaskLink taskId={nextId} seed={() => seedFromTitle(nextId, task.title, { kind: task.kind })} className="text-accent-700 hover:underline">
                next occurrence
              </TaskLink>
            ) : (
              "next occurrence"
            )}
            {due ? <>, due {formatDueDate(due)}</> : null}
          </>
        );
      }
      case "dependency_added":
      case "dependency_removed":
      case "dependency_changed": {
        // The other task's title is only there when the viewer can read it.
        const title = str(d, "task_title");
        const other = title ? <>“{title}”</> : <>a task you can’t open</>;
        const lag = typeof num(d, "lag_days") === "number" ? (num(d, "lag_days") as number) : 0;
        const how = str(d, "kind") ? <> ({dependencyLabel(parseDependencyKind(str(d, "kind")), lag).toLowerCase()})</> : null;
        if (story.kind === "dependency_changed") {
          return (
            <>
              changed the dependency {str(d, "relation") === "blocked_by" ? "on" : "of"} {other} to{" "}
              {dependencyLabel(parseDependencyKind(str(d, "kind")), lag).toLowerCase()}
            </>
          );
        }
        const verb = story.kind === "dependency_added" ? "marked" : "unmarked";
        return str(d, "relation") === "blocked_by" ? (
          <>
            {verb} this as blocked by {other}
            {how}
          </>
        ) : (
          <>
            {verb} this as blocking {other}
            {how}
          </>
        );
      }
      case "tag_added":
        return <>added the tag “{str(d, "tag_name")}”</>;
      case "tag_removed":
        return <>removed the tag “{str(d, "tag_name")}”</>;
      case "converted_to_subtask": {
        const parentId = str(d, "parent_id");
        return (
          <>
            made this a subtask of{" "}
            {parentId ? (
              <TaskLink taskId={parentId} seed={() => seedFromTitle(parentId, str(d, "parent_title") || "Parent task")} className="font-medium text-zinc-700 hover:underline">
                “{str(d, "parent_title")}”
              </TaskLink>
            ) : (
              <>“{str(d, "parent_title")}”</>
            )}
          </>
        );
      }
      case "converted_to_task":
        return <>made this subtask a task in {str(d, "project_name")}</>;
      case "deleted":
        return "moved this task to the Trash";
      case "restored":
        return "restored this task from the Trash";
      case "kind_changed":
        return <>changed the type to {TASK_KIND_LABELS[parseTaskKind(str(d, "to"))].toLowerCase()}</>;
      default:
        return "updated this task";
    }
  }

  const comments = entries.filter((entry) => entry.type === "comment");
  const shown = tab === "comments" ? comments : entries;
  const commentCount = task.commentTotal + merged.waiting.length;

  return (
    <section className="mt-8 border-t border-zinc-200 pt-1" aria-label="Comments and activity">
      <div role="tablist" aria-label="Comments and activity" className="tab-strip gap-4">
        {(
          [
            { key: "comments", label: "Comments", count: commentCount },
            { key: "all", label: "All activity", count: 0 },
            // Oct 26 notes (batch 3): each review check sent for this task, with its pins and files.
            { key: "reviews", label: "Reviews", count: 0 },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`activity-tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls="activity-panel"
            onClick={() => setActivityTab(t.key)}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 border-transparent text-sm text-zinc-500 hover:text-zinc-900 aria-selected:border-accent-500 aria-selected:font-medium aria-selected:text-zinc-900"
          >
            {t.label}
            {t.count ? <span className="rounded-full bg-zinc-100 px-1.5 text-2xs font-medium tabular-nums text-zinc-600">{t.count}</span> : null}
          </button>
        ))}
      </div>
      {tab === "reviews" ? (
        <div id="activity-panel" role="tabpanel" aria-labelledby="activity-tab-reviews" className="pt-3">
          <TaskReviews task={task} profiles={profiles} />
        </div>
      ) : (
        <>
          {shown.length === 0 ? (
            <p id="activity-panel" role="tabpanel" aria-labelledby={`activity-tab-${tab}`} className="py-4 text-sm text-zinc-500">
              {canComment ? "No comments yet. Ask a question or share an update below." : "No comments yet."}
            </p>
          ) : null}
          {olderCursor ? (
            <button
              type="button"
              className="btn-ghost mt-3 text-zinc-500"
              disabled={loadingEarlier}
              onClick={() => {
                const cursor = olderCursor;
                setLoadingEarlier(true);
                void loadOlderComments(task.id, cursor.beforeAt, cursor.beforeId).then((result) => {
                  setLoadingEarlier(false);
                  if (result.error || !result.comments) {
                    notify(result.error ?? "Couldn’t load earlier comments");
                    return;
                  }
                  setEarlier((current) => [...result.comments!, ...current]);
                  setOlderCursor(result.older ?? null);
                });
              }}
            >
              {loadingEarlier ? "Loading…" : "Show earlier comments"}
            </button>
          ) : null}
          <ol
            id={shown.length ? "activity-panel" : undefined}
            role={shown.length ? "tabpanel" : undefined}
            aria-labelledby={shown.length ? `activity-tab-${tab}` : undefined}
            className={`flex flex-col gap-3 ${shown.length ? "mt-3" : ""}`}
          >
            {shown.map((entry) =>
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
                  key={entry.key}
                  comment={entry.comment}
                  pending={entry.pending}
                  authorName={entry.comment.ruleName ? `Rule “${entry.comment.ruleName}”` : nameOf(entry.comment.authorId)}
                  mine={entry.comment.authorId !== null && entry.comment.authorId === memberId}
                  canComment={canComment}
                  memberId={memberId}
                  nameOf={nameOf}
                  candidates={candidates}
                  mentioned={entry.comment.mentionIds.flatMap((mentionId) => profileById(mentionId) ?? [])}
                  describe={describe}
                  teams={task.mentionTeams}
                />
              ),
            )}
          </ol>
        </>
      )}
    </section>
  );
}

// Who a comment that isn't saved yet mentions (the database decides for real once it is): the people the
// autocomplete offers whose @name or @emailname is in the text.
function pendingMentionIds(body: string, candidates: Profile[]): string[] {
  return [
    ...new Set(
      mentionSegments(body, candidates).flatMap((s) => (s.type === "mention" ? [s.profileId] : [])),
    ),
  ];
}

// People who can read the task (members of its projects), for @mention autocomplete; not the viewer.
function mentionCandidates(task: TaskDetail, profiles: Profile[], memberId: string): Profile[] {
  return profiles
    .filter((p) => p.id !== memberId && task.memberRoles[p.id] !== undefined)
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));
}

export const COMMENT_INPUT =
  "field-sizing-content min-h-16 w-full resize-none rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm placeholder:text-zinc-400 focus:border-accent-500/60 focus:shadow-[0_0_0_3px_var(--focus-ring)] focus:outline-none";

function CommentItem({
  comment,
  pending: sending,
  authorName,
  mine,
  canComment,
  memberId,
  nameOf,
  candidates,
  mentioned,
  describe,
  teams,
}: {
  comment: TaskComment;
  // Still on its way to the server (optimistic): no edit, delete, or reactions yet.
  pending: boolean;
  authorName: string;
  mine: boolean;
  canComment: boolean;
  memberId: string;
  nameOf: (profileId: string | null) => string;
  candidates: Profile[];
  mentioned: Profile[];
  describe: DescribePerson;
  teams: TaskDetail["mentionTeams"];
}) {
  const [pending, run] = useServerAction();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  // An emailed comment went out as written: it can be removed, not edited.
  const editable = mine && canComment && !comment.deleted && !sending && !comment.email;
  const removable = mine && canComment && !comment.deleted && !sending;

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
        <Avatar name={authorName} profileId={comment.ruleName ? null : comment.authorId} size="md" />
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

  const controls =
    (editable || removable) && !editing ? (
      <span className="ml-auto flex items-center opacity-0 focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
        {editable ? (
          <button
            type="button"
            aria-label="Edit comment"
            data-tooltip="Edit"
            onClick={() => setDraft(comment.body)}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"
          >
            <Pencil className="size-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Delete comment"
          data-tooltip="Delete"
          onClick={async () => {
            if (
              await confirm({
                title: "Delete this comment?",
                message: comment.email ? "The email was already sent." : undefined,
                confirmLabel: "Delete",
                tone: "danger",
              })
            ) {
              run(() => deleteComment(comment.id));
            }
          }}
          className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-red-600"
        >
          <Trash2 className="size-3.5" />
        </button>
      </span>
    ) : null;

  // Asana's email cards: a response sent to the form's submitter, or the submitter's emailed reply.
  if (comment.email) {
    const received = comment.email.direction === "received";
    return (
      <li className="group flex gap-2.5" data-comment-id={sending ? undefined : comment.id} aria-busy={sending || undefined}>
        {received ? <MailAvatar /> : <Avatar name={authorName} profileId={comment.ruleName ? null : comment.authorId} size="md" />}
        <div className="min-w-0 flex-1">
          <EmailCommentHeader email={comment.email} authorName={authorName} createdAt={comment.createdAt} actions={controls} />
          <EmailCard
            email={comment.email}
            createdAt={comment.createdAt}
            files={
              received ? <EmailFiles files={comment.emailFiles ?? []} skipped={comment.emailSkipped ?? []} /> : null
            }
          >
            {received ? comment.body : <MentionText body={comment.body} people={mentioned} describe={describe} teams={teams} />}
          </EmailCard>
          {comment.reviewCheckId ? <ReviewLink /> : null}
          {sending ? null : <Reactions comment={comment} canReact={canComment} memberId={memberId} nameOf={nameOf} />}
        </div>
      </li>
    );
  }

  return (
    <li className="group flex gap-2.5" data-comment-id={sending ? undefined : comment.id} aria-busy={sending || undefined}>
      <Avatar name={authorName} profileId={comment.ruleName ? null : comment.authorId} size="md" />
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
          {sending ? <span className="text-xs text-zinc-400">Sending…</span> : null}
          {controls}
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
            <MentionText body={comment.body} people={mentioned} describe={describe} teams={teams} />
          </p>
        )}
        {comment.reviewCheckId ? <ReviewLink /> : null}
        {sending ? null : <Reactions comment={comment} canReact={canComment} memberId={memberId} nameOf={nameOf} />}
      </div>
    </li>
  );
}

// Oct 26 notes (batch 3): a review's outcome comment links to the Reviews tab (its pins on the files).
function ReviewLink() {
  return (
    <button type="button" onClick={() => setActivityTab("reviews")} className="mt-1 text-xs font-medium text-accent-700 hover:underline">
      See the pins and files in Reviews
    </button>
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

// People who can read the task: who can be added as a follower (followers must be able to read it).
function readers(task: TaskDetail, profiles: Profile[]) {
  return task.isPrivate
    ? profiles.filter((p) => task.privateReaderIds.includes(p.id))
    : profiles.filter((p) => task.memberRoles[p.id] !== undefined);
}

// The pane's footer (Asana parity, batch 3): a one-line "Add a comment" box that grows while you write,
// and one row of followers (Oct 27 notes, batch 5: "Followers", not "Collaborators") with Add follower, a
// remove × on each, and Follow task / Unfollow. Followers hear about comments, completion, and changes.
// Commenters and above.
export function TaskPaneFooter({
  task,
  profiles,
  memberId,
}: {
  task: TaskDetail;
  profiles: Profile[];
  memberId: string;
}) {
  const [, run] = useServerAction();
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  // "Send response to submitter" (form tasks only; unchecked by default and after each send).
  const [toSubmitter, setToSubmitter] = useState(false);
  const [followerIds, setFollowerIds] = useOptimistic(task.followerIds);
  const me = profiles.find((p) => p.id === memberId);
  const following = followerIds.includes(memberId);
  const followers = followerIds
    .map((followerId) => profiles.find((p) => p.id === followerId))
    .filter((p): p is Profile => Boolean(p));
  const canComment = taskPermissions(task).canComment;
  const submitterEmail = canRespondToSubmitter(task) ? (task.submission?.email ?? null) : null;
  const open = focused || draft.trim() !== "" || toSubmitter;

  // ⌘/Ctrl+Enter and the Comment button: the comment shows in the feed at once (a pending row), the
  // server saves it, and the real row takes its place; a failure takes the row away, puts the text back,
  // and the toast says why.
  function submit() {
    const body = draft.trim();
    if (!body) return;
    const emailed = Boolean(submitterEmail && toSubmitter);
    const tempId = `pending-${crypto.randomUUID()}`;
    addPendingComment({
      tempId,
      taskId: task.id,
      authorId: memberId,
      body,
      createdAt: new Date().toISOString(),
      email:
        emailed && submitterEmail
          ? {
              direction: "sent",
              address: submitterEmail.toLowerCase(),
              // The conversation's subject once there is one (a first response under a subject template
              // shows the default until the server's row replaces this one).
              subject: task.replyThread?.subject ?? submitterResponseSubject(task.submission?.formTitle),
            }
          : null,
      serverId: null,
      knownIds: task.comments.map((c) => c.id),
    });
    setDraft("");
    setToSubmitter(false);
    run(async () => {
      const result = emailed ? await sendSubmitterResponse(task.id, body) : await addComment(task.id, body);
      if (result.error || !result.commentId) {
        dropPendingComment(tempId);
        setDraft((current) => (current.trim() ? current : body));
        if (emailed) setToSubmitter(true);
      } else {
        settlePendingComment(tempId, result.commentId);
      }
      return result;
    });
  }

  function follow(profileId: string, on: boolean) {
    run(
      () => setFollowing(task.id, profileId, on),
      () => setFollowerIds(on ? [...followerIds, profileId] : followerIds.filter((id) => id !== profileId)),
    );
  }

  return (
    <div className="shrink-0 border-t border-zinc-200 bg-white px-gutter pb-2 pt-2.5 print:hidden">
      {canComment ? (
        <div className="flex items-start gap-2">
          <Avatar name={me ? displayName(me) : "You"} src={me?.avatar_url} profileId={me?.id} size="md" />
          <div
            onFocus={() => setFocused(true)}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
            }}
            className={`min-w-0 flex-1 rounded-lg border bg-white transition-[border-color,box-shadow] ${
              open ? "border-accent-500/60 shadow-[0_0_0_3px_var(--focus-ring)]" : "border-zinc-200 hover:border-zinc-300"
            }`}
          >
            <label htmlFor="new-comment" className="sr-only">
              Add a comment
            </label>
            <MentionTextarea
              id="new-comment"
              rows={1}
              value={draft}
              onValueChange={setDraft}
              candidates={mentionCandidates(task, profiles, memberId)}
              onSubmit={submit}
              placeholder="Add a comment"
              className={`block w-full resize-none border-0 bg-transparent px-3 text-sm shadow-none outline-none placeholder:text-zinc-500 focus-visible:shadow-none field-sizing-content ${
                open ? "min-h-16 py-2" : "h-8 min-h-8 py-1.5"
              }`}
            />
            {open && submitterEmail ? (
              <div className="flex items-center gap-2 px-3 pb-1.5 pt-0.5 text-sm text-zinc-600">
                <input
                  id="send-to-submitter"
                  type="checkbox"
                  checked={toSubmitter}
                  onChange={(e) => setToSubmitter(e.target.checked)}
                  className="size-4 shrink-0 rounded border-zinc-300 accent-accent-600"
                />
                <label htmlFor="send-to-submitter" className="min-w-0">
                  Send response to submitter{" "}
                  <a
                    href={`mailto:${submitterEmail}`}
                    className="break-all text-accent-700 hover:underline"
                  >
                    {submitterEmail}
                  </a>
                </label>
              </div>
            ) : null}
            {open ? (
              <div className="flex items-center gap-2 px-2 pb-1.5">
                <span className="mr-auto text-2xs text-zinc-500">
                  {toSubmitter && submitterEmail
                    ? task.replyThread?.closed
                      ? "Emailed to the submitter. Replies are closed, so their answers won’t be posted"
                      : "This comment is emailed to the submitter; their reply comes back here"
                    : "Type @ to mention someone · ⌘/Ctrl+Enter to send"}
                </span>
                <button type="button" onClick={submit} disabled={!draft.trim()} className="btn-primary h-7 px-3">
                  {toSubmitter && submitterEmail ? "Send" : "Comment"}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="text-sm text-zinc-600">You can view this task. Commenters and above can comment and follow it.</p>
      )}
      <div className="mt-1.5 flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
        <span
          className="shrink-0 font-medium text-zinc-600"
          data-tooltip="Followers are notified about new comments, completion, and changes to this task"
        >
          Followers
        </span>
        <ul className="flex flex-wrap items-center gap-1" aria-label={`Followers: ${followers.map(displayName).join(", ") || "none"}`}>
          {followers.slice(0, 8).map((p) => (
            <li key={p.id} className="group/follower relative">
              <span className="block rounded-full ring-2 ring-white" data-tooltip={displayName(p)}>
                <Avatar name={displayName(p)} src={p.avatar_url} profileId={p.id} />
              </span>
              {canComment ? (
                <button
                  type="button"
                  onClick={() => follow(p.id, false)}
                  aria-label={p.id === memberId ? "Stop following this task" : `Remove ${displayName(p)} as a follower`}
                  data-tooltip={p.id === memberId ? "Unfollow" : `Remove ${displayName(p)}`}
                  className="absolute -right-1 -top-1 hidden size-3.5 items-center justify-center rounded-full bg-zinc-700 text-white ring-1 ring-white hover:bg-red-600 focus-visible:flex group-hover/follower:flex [@media(hover:none)]:flex"
                >
                  <X className="size-2.5" aria-hidden />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {followers.length > 8 ? <span className="tabular-nums">+{followers.length - 8}</span> : null}
        {followers.length === 0 ? <span className="text-zinc-400">No followers yet</span> : null}
        {canComment ? (
          <Popover
            label="Add or remove followers"
            tooltip="Followers are notified about comments, completion, and changes"
            side="top"
            panelClassName="w-72 p-0"
            buttonClassName="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-zinc-300 px-2 text-zinc-600 hover:border-zinc-400 hover:text-zinc-900 aria-expanded:border-zinc-400"
            button={
              <>
                <UserPlus className="size-3.5" aria-hidden />
                Add follower
              </>
            }
          >
            {() => (
              <PeopleList
                label="Followers"
                people={readers(task, profiles)}
                selected={followerIds}
                emptyNote="Only people who can open this task can follow it."
                footer={
                  <p className="px-2.5 py-1.5 text-2xs text-zinc-500">
                    Ticked people follow this task. Pick someone again to remove them.
                  </p>
                }
                onPick={(profileId) => follow(profileId, !followerIds.includes(profileId))}
              />
            )}
          </Popover>
        ) : null}
        {canComment ? (
          <button
            type="button"
            onClick={() => follow(memberId, !following)}
            aria-pressed={following}
            className={`ml-auto inline-flex h-7 items-center gap-1 rounded-md border px-2 font-medium ${
              following
                ? "border-zinc-200 text-zinc-700 hover:bg-zinc-100"
                : "border-accent-200 bg-accent-50 text-accent-800 hover:bg-accent-100"
            }`}
          >
            {following ? <BellOff className="size-3.5" aria-hidden /> : <Bell className="size-3.5" aria-hidden />}
            {following ? "Unfollow" : "Follow task"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
