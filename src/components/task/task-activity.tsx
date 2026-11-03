"use client";

import { TaskReviews } from "@/components/task/task-reviews";
import { useTagsEnabled } from "@/components/tags/tags-enabled";
import { useEffect, useMemo, useOptimistic, useState, type ReactNode } from "react";
import { clearPinOverrides, setPinOverride, settledPinOverrides, usePinOverrides } from "@/components/task/pinned-comments-store";
import { FeedbackSubtaskButton } from "@/components/task/feedback-subtask";
import Link from "next/link";
import { Bell, BellOff, FileCheck, Mail, Pencil, Pin, PinOff, SmilePlus, Trash2, UserPlus, X, Zap } from "lucide-react";
import { SendReviewDialog } from "@/components/task/send-review-dialog";
import { RequestConversationNotice } from "@/components/task/request-conversation";
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
  setCommentPinned,
  setFollowing,
  toggleReaction,
} from "@/lib/actions";
import { canRespondToSubmitter, submitterResponseSubject } from "@/lib/comment-email";
import { mentionSegments } from "@/lib/mentions";
import { mergePendingComments, type PendingComment } from "@/lib/pending-comments";
import { followerChange, taskPermissions } from "@/lib/permissions";
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
import type { CommentRefs, Profile, TaskComment, TaskDetail, TaskEmailActivity, TaskRuleRun, TaskStory } from "@/lib/data";
import { ACTIVITY_RANK, compareActivity, isEmailCreatedStory, runIsProblem, runVerb } from "@/lib/automation-activity";
import { emailActivityText } from "@/lib/project-page";
import { automationHref } from "@/lib/rule-feedback";
import { fieldChips } from "@/lib/fields";
import type { Json } from "@/lib/supabase/database.types";
import { useRealtimeRefresh } from "@/lib/realtime";
import { describeRecurrence, parseRecurrence } from "@/lib/recurrence";
import { TASK_KIND_LABELS, parseTaskKind } from "@/lib/task-kinds";
import { dependencyLabel, parseDependencyKind } from "@/lib/dependencies";
import { setActivityTab, useActivityTab, type ActivityTab } from "./pane-size";

// Nov 2 notes (batch 17, 129): after posting, scroll the feed so the new comment is in view (it's drawn
// at the end of the feed, below any older comments). The pending row shows up within a frame or two.
function revealPendingComment(tempId: string) {
  let tries = 0;
  const step = () => {
    const row = document.querySelector(`[data-pending-comment="${CSS.escape(tempId)}"]`);
    if (row) {
      row.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return;
    }
    if (++tries < 30) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
import { PeopleList } from "./person-picker";
import { TaskLink } from "@/components/task/task-link";
import { canAddSubtask } from "@/components/task/task-subtasks";
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
  | { type: "story"; at: string; story: TaskStory }
  // Nov 1 notes, batch 12: a thin marker per automation run (84), and what came in by email (83).
  | { type: "run"; at: string; run: TaskRuleRun }
  | { type: "email"; at: string; email: TaskEmailActivity };

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
  // Nov 1 notes, batch 9a (10.4): Editors and above pin and unpin comments (set_comment_pinned).
  const canPin = taskPermissions(task).canEdit && task.pinnedComments !== undefined;
  // Nov 2 notes (batch 17, 131): Editors turn a piece of feedback into a subtask.
  const canFeedbackSubtask = canAddSubtask(task);
  const refs: CommentRefs = task.commentRefs ?? { tasks: {}, projects: {} };
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
  // Nov 2 notes (batch 17, 128): pins and unpins show at once (pinned-comments-store.ts).
  const pinOverrides = usePinOverrides();
  const serverComments = useMemo(() => {
    const seen = new Set(task.comments.map((comment) => comment.id));
    return [...earlier.filter((comment) => !seen.has(comment.id)), ...task.comments];
  }, [earlier, task.comments]);
  const commentsOnTask = useMemo(
    () =>
      pinOverrides.size === 0
        ? serverComments
        : serverComments.map((comment) => {
            const o = pinOverrides.get(comment.id);
            return o && o.taskId === task.id ? { ...comment, pinnedAt: o.pinnedAt } : comment;
          }),
    [serverComments, pinOverrides, task.id],
  );
  useEffect(() => {
    if (pinOverrides.size === 0) return;
    const pinnedOnServer = new Map((task.pinnedComments ?? []).map((c) => [c.id, c.pinnedAt] as const));
    const loaded = new Map(serverComments.map((c) => [c.id, c.pinnedAt] as const));
    clearPinOverrides(
      settledPinOverrides(pinOverrides, task.id, (commentId) => pinnedOnServer.get(commentId) ?? loaded.get(commentId)),
    );
  }, [pinOverrides, serverComments, task.pinnedComments, task.id]);
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

  const emailIn = task.emailActivity ?? [];
  const createdByEmail = emailIn.some((e) => e.kind === "task_created");
  const history = useMemo(() => {
    const rank = (automation: boolean) => (automation ? ACTIVITY_RANK.automation : ACTIVITY_RANK.person);
    return [
      ...commentsOnTask.map((comment) => ({
        type: "comment" as const,
        at: comment.createdAt,
        rank: rank(Boolean(comment.ruleName)),
        comment,
        key: merged.keys.get(comment.id) ?? comment.id,
        pending: false as const,
      })),
      // Oct 26 notes (batch 3): tag lines are hidden while the workspace's tags are switched off.
      ...task.stories
        .filter((story) => tagsOn || (story.kind !== "tag_added" && story.kind !== "tag_removed"))
        // Nov 1 notes, batch 12 (83): "Created by email from …" replaces the older forwarding line.
        .filter((story) => !(createdByEmail && isEmailCreatedStory(story)))
        .map((story) => ({ type: "story" as const, at: story.createdAt, rank: rank(Boolean(str(story.data, "rule_id"))), story })),
      ...(task.ruleRuns ?? []).map((run) => ({ type: "run" as const, at: run.createdAt, rank: ACTIVITY_RANK.run, run })),
      ...emailIn.map((email) => ({ type: "email" as const, at: email.createdAt, rank: ACTIVITY_RANK.person, email })),
    ]
      .sort(compareActivity) as Entry[];
    // arrivedKey changes when a pending comment becomes a server row (its React key moves with it).
    // Pending-only updates leave it alone, so the feed isn't re-sorted on send.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- merged.keys is current whenever arrivedKey changes
  }, [commentsOnTask, task.stories, task.ruleRuns, task.emailActivity, arrivedKey, tagsOn]);
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
    if (ruleName) return `Automation “${ruleName}”`;
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
        // Nov 1 notes, item 66: the other task was purged from the Trash.
        const purged = Boolean(d && typeof d === "object" && !Array.isArray(d) && (d as Record<string, Json | undefined>).purged === true);
        const other = title ? <>“{title}”</> : purged ? <>a deleted task</> : <>a task you can’t open</>;
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
      case "comment_pinned":
        return "pinned a comment";
      case "comment_unpinned":
        return "unpinned a comment";
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

  // The Comments tab: comments, plus the line saying the task came in by email (Nov 1 notes, batch 12).
  const comments = entries.filter(
    (entry) => entry.type === "comment" || (entry.type === "email" && entry.email.kind === "task_created"),
  );
  // Pinned comments at the top of the feed (newest pin first); the loaded page's copy carries the latest pin,
  // and a pin or unpin still saving wins (128).
  const serverPinned = task.pinnedComments ?? [];
  const pinned = [
    ...serverPinned.map((p) => {
      const loaded = commentsOnTask.find((c) => c.id === p.id);
      if (loaded) return loaded;
      const o = pinOverrides.get(p.id);
      return o && o.taskId === task.id ? { ...p, pinnedAt: o.pinnedAt } : p;
    }),
    ...commentsOnTask.filter((c) => c.pinnedAt && !serverPinned.some((p) => p.id === c.id)),
  ]
    .filter((c) => c.pinnedAt && !c.deleted)
    .sort((a, b) => (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? ""));
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
          {pinned.length ? (
            <section aria-label="Pinned comments" data-pinned-comments="" className="mt-3 rounded-lg border border-amber-200 bg-amber-50/40 p-2.5">
              <p className="mb-2 flex items-center gap-1 text-xs font-semibold text-amber-800">
                <Pin className="size-3.5" aria-hidden />
                Pinned
              </p>
              <ol className="flex flex-col gap-3">
                {pinned.map((comment) => (
                  <CommentItem
                    key={`pinned-${comment.id}`}
                    comment={comment}
                    pending={false}
                    authorName={comment.ruleName ? `Automation “${comment.ruleName}”` : nameOf(comment.authorId)}
                    mine={comment.authorId !== null && comment.authorId === memberId}
                    canComment={canComment}
                    memberId={memberId}
                    nameOf={nameOf}
                    candidates={candidates}
                    mentioned={comment.mentionIds.flatMap((mentionId) => profileById(mentionId) ?? [])}
                    describe={describe}
                    teams={task.mentionTeams}
                    refs={refs}
                    canPin={canPin}
                    inPinned
                    people={profiles}
                    taskId={task.id}
                    feedbackTask={canFeedbackSubtask ? task : null}
                  />
                ))}
              </ol>
            </section>
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
              entry.type === "run" ? (
                <RunMarker key={`run-${entry.run.id}`} run={entry.run} />
              ) : entry.type === "email" ? (
                <EmailInLine
                  key={`email-${entry.email.id}`}
                  email={entry.email}
                  sender={
                    entry.email.senderProfileId && profilesById.get(entry.email.senderProfileId)
                      ? displayName(profilesById.get(entry.email.senderProfileId)!)
                      : entry.email.senderEmail
                  }
                />
              ) : entry.type === "story" ? (
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
                  authorName={entry.comment.ruleName ? `Automation “${entry.comment.ruleName}”` : nameOf(entry.comment.authorId)}
                  mine={entry.comment.authorId !== null && entry.comment.authorId === memberId}
                  canComment={canComment}
                  memberId={memberId}
                  nameOf={nameOf}
                  candidates={candidates}
                  mentioned={entry.comment.mentionIds.flatMap((mentionId) => profileById(mentionId) ?? [])}
                  describe={describe}
                  teams={task.mentionTeams}
                  refs={refs}
                  canPin={canPin}
                  people={profiles}
                  taskId={task.id}
                  feedbackTask={canFeedbackSubtask ? task : null}
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
  refs,
  canPin = false,
  inPinned = false,
  people = [],
  taskId,
  feedbackTask = null,
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
  refs: CommentRefs;
  // Editors+ (10.4): Pin / Unpin; inPinned = drawn in the Pinned section at the top.
  canPin?: boolean;
  inPinned?: boolean;
  // Everyone in the workspace: in an automation's comment their raw email addresses show as chips.
  people?: Profile[];
  taskId: string;
  // Editors (131): a submitter's emailed reply or a review's outcome gets "Create subtask".
  feedbackTask?: TaskDetail | null;
}) {
  const notify = useNotify();
  const [pending, run] = useServerAction();
  // Nov 1 notes, batch 12 (84): posted by an automation — its own look (lightning, tint, "Automation · X").
  const automation = Boolean(comment.ruleName);
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
        {automation ? <AutomationAvatar /> : <Avatar name={authorName} profileId={comment.authorId} size="md" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            {automation ? (
              <AutomationLabel comment={comment} />
            ) : (
              <span className="text-sm font-medium text-zinc-500">{authorName}</span>
            )}
            <Timestamp iso={comment.createdAt} className="text-xs text-zinc-400" />
          </div>
          <p className="mt-0.5 text-sm italic text-zinc-400">Comment deleted</p>
        </div>
      </li>
    );
  }

  const pinnable = canPin && !comment.deleted && !sending;
  const pinButton = pinnable ? (
    <button
      type="button"
      aria-label={comment.pinnedAt ? "Unpin comment" : "Pin comment to the top"}
      data-tooltip={comment.pinnedAt ? "Unpin" : "Pin to top"}
      data-pin-comment={comment.pinnedAt ? "unpin" : "pin"}
      onClick={() => {
        // Shown at once; a refused save puts it back and the toast says why (128).
        const before = comment.pinnedAt ?? null;
        const next = before ? null : new Date().toISOString();
        setPinOverride(taskId, comment.id, next);
        void setCommentPinned(comment.id, Boolean(next)).then(
          (result) => {
            if (result.error) {
              setPinOverride(taskId, comment.id, before);
              notify(result.error);
            }
          },
          () => {
            setPinOverride(taskId, comment.id, before);
            notify(next ? "Couldn’t pin the comment" : "Couldn’t unpin the comment");
          },
        );
      }}
      className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"
    >
      {comment.pinnedAt ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
    </button>
  ) : null;
  const controls =
    (editable || removable || pinnable) && !editing ? (
      <span className="ml-auto flex items-center opacity-0 focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
        {pinButton}
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
        {removable ? (
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
        ) : null}
      </span>
    ) : null;

  // Asana's email cards: a response sent to the form's submitter, or the submitter's emailed reply.
  if (comment.email) {
    const received = comment.email.direction === "received";
    return (
      <li
        className="group flex gap-2.5"
        data-comment-id={sending ? undefined : comment.id}
        data-pending-comment={sending ? comment.id : undefined}
        aria-busy={sending || undefined}
      >
        {received ? <MailAvatar /> : automation ? <AutomationAvatar /> : <Avatar name={authorName} profileId={comment.authorId} size="md" />}
        <div className="min-w-0 flex-1">
          <EmailCommentHeader email={comment.email} authorName={authorName} createdAt={comment.createdAt} actions={controls} />
          <EmailCard
            email={comment.email}
            createdAt={comment.createdAt}
            files={
              received ? <EmailFiles files={comment.emailFiles ?? []} skipped={comment.emailSkipped ?? []} /> : null
            }
          >
            {received ? comment.body : <MentionText body={comment.body} people={mentioned} describe={describe} teams={teams} refs={refs} />}
          </EmailCard>
          {comment.reviewCheckId ? <ReviewLink /> : null}
          {received && feedbackTask && !sending ? (
            <FeedbackSubtaskButton
              task={feedbackTask}
              feedback={comment.body}
              from={comment.email.address}
              className="mt-1"
            />
          ) : null}
          {sending ? null : <Reactions comment={comment} canReact={canComment} memberId={memberId} nameOf={nameOf} />}
        </div>
      </li>
    );
  }

  return (
    <li
      className={
        automation
          ? "group -mx-1.5 flex gap-2.5 rounded-md border-l-2 border-accent-300 bg-accent-50/50 py-1.5 pr-1.5 pl-1"
          : "group flex gap-2.5"
      }
      data-comment-id={sending ? undefined : comment.id}
      data-pending-comment={sending ? comment.id : undefined}
      data-automation-comment={automation ? "" : undefined}
      aria-busy={sending || undefined}
    >
      {automation ? <AutomationAvatar /> : <Avatar name={authorName} profileId={comment.authorId} size="md" />}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          {automation ? (
            <AutomationLabel comment={comment} />
          ) : (
            <span className="text-sm font-medium text-zinc-900">{authorName}</span>
          )}
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
          {comment.pinnedAt && !inPinned ? (
            <span className="inline-flex items-center gap-0.5 rounded bg-amber-50 px-1 text-2xs font-medium text-amber-800" data-comment-pinned="">
              <Pin className="size-3" aria-hidden />
              Pinned
            </span>
          ) : null}
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
              links
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
            <MentionText
              body={comment.body}
              people={mentioned}
              describe={describe}
              teams={teams}
              refs={refs}
              emailPeople={automation ? people : undefined}
            />
          </p>
        )}
        {comment.reviewCheckId ? <ReviewLink /> : null}
        {sending ? null : <Reactions comment={comment} canReact={canComment} memberId={memberId} nameOf={nameOf} />}
      </div>
    </li>
  );
}

// Nov 1 notes, batch 12 (84): an automation's comment shows a lightning mark instead of a letter avatar.
function AutomationAvatar() {
  return (
    <span
      aria-hidden
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-100 text-accent-700"
      data-automation-avatar=""
    >
      <Zap className="size-3.5" />
    </span>
  );
}

// "Automation · <name>" in small muted text; the name opens the automation when the viewer can read it.
function AutomationLabel({ comment }: { comment: TaskComment }) {
  const name = comment.ruleName ?? "Automation";
  return (
    <span className="min-w-0 truncate text-xs text-zinc-500" data-automation-label="">
      Automation ·{" "}
      {comment.ruleId && comment.ruleProjectId ? (
        <Link
          href={automationHref(comment.ruleProjectId, comment.ruleId)}
          className="font-medium text-zinc-700 hover:text-accent-700 hover:underline"
        >
          {name}
        </Link>
      ) : (
        <span className="font-medium text-zinc-700">{name}</span>
      )}
    </span>
  );
}

// Nov 1 notes, batch 12 (84): every automation run leaves a thin, muted line in All activity — even when
// it changed nothing visible. A run loop protection, a limit, or an error stopped reads in amber.
function RunMarker({ run }: { run: TaskRuleRun }) {
  const problem = runIsProblem(run);
  return (
    <li
      className={`flex items-center gap-2 text-2xs ${problem ? "text-amber-700" : "text-zinc-400"}`}
      data-automation-run={run.status}
    >
      <span aria-hidden className={`h-px flex-1 ${problem ? "bg-amber-200" : "bg-zinc-200"}`} />
      <span className="inline-flex min-w-0 max-w-[85%] items-center gap-1">
        <Zap className="size-3 shrink-0" aria-hidden />
        <span className="truncate">
          <Link href={automationHref(run.projectId, run.ruleId)} className="hover:text-accent-700 hover:underline">
            {run.ruleName}
          </Link>{" "}
          {runVerb(run)}
          {run.status === "failed" && run.reason ? <>: {run.reason}</> : null} · <Timestamp iso={run.createdAt} />
        </span>
      </span>
      <span aria-hidden className={`h-px flex-1 ${problem ? "bg-amber-200" : "bg-zinc-200"}`} />
    </li>
  );
}

// Nov 1 notes, batch 12 (83): the task came in by email, or a comment did.
function EmailInLine({ email, sender }: { email: TaskEmailActivity; sender: string }) {
  return (
    <li className="flex items-baseline gap-2 pl-0.5 text-xs text-zinc-500" data-email-activity={email.kind}>
      <Mail className="size-3 shrink-0 translate-y-[1px] text-zinc-400" aria-hidden />
      <p className="min-w-0">
        {emailActivityText(email.kind, sender, email.subject)} · <Timestamp iso={email.createdAt} />
      </p>
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
        // Nov 1 notes (batch 11): people who can't react see the counts as plain chips, not disabled buttons.
        if (!canReact) {
          return (
            <span
              key={emoji}
              role="img"
              aria-label={`${label}: ${who}`}
              title={who}
              className="inline-flex h-6 items-center gap-1 rounded-full border border-zinc-200 bg-white px-2 text-xs tabular-nums text-zinc-700"
            >
              <span aria-hidden>{glyph}</span>
              {profileIds.length}
            </span>
          );
        }
        return (
          <button
            key={emoji}
            type="button"
            aria-pressed={mine}
            aria-label={`${label}: ${who}${mine ? ". Remove your reaction" : ". Add your reaction"}`}
            title={who}
            onClick={() => react(emoji)}
            className="inline-flex h-6 items-center gap-1 rounded-full border border-zinc-200 bg-white px-2 text-xs tabular-nums text-zinc-700 hover:border-zinc-300 aria-pressed:border-accent-300 aria-pressed:bg-accent-50 aria-pressed:text-accent-800"
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
  const permissions = taskPermissions(task);
  const canComment = permissions.canComment;
  const submitterEmail = canRespondToSubmitter(task) ? (task.submission?.email ?? null) : null;
  // Nov 1 notes (batch 8, item 60): "Send for review" next to "Send response to submitter" opens the review
  // check dialog (pick or upload files, then send) with what was typed as the message. Editors and above
  // (create_review_check needs Editor+); the dialog clears the box once the review is sent.
  const canSendReview = permissions.canEdit;
  const [reviewing, setReviewing] = useState<string | null>(null);
  const open = focused || draft.trim() !== "" || toSubmitter;
  const activityTab: ActivityTab = useActivityTab();

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
    // The Reviews tab doesn't list comments: show the comments the new one joins.
    if (activityTab === "reviews") setActivityTab("comments");
    revealPendingComment(tempId);
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
      {reviewing !== null ? (
        <SendReviewDialog
          task={task}
          initialMessage={reviewing}
          onClose={() => setReviewing(null)}
          onSent={() => {
            // The typed text went out as the review's message; don't leave it in the box to post twice.
            if (reviewing && draft.trim() === reviewing) setDraft("");
          }}
        />
      ) : null}
      {/* Nov 2 notes (batch 17, 130): only a note when the email conversation is off; never "on … Change". */}
      {canComment ? <RequestConversationNotice task={task} /> : null}
      {canComment ? (
        <div className="flex items-start gap-2">
          <Avatar name={me ? displayName(me) : "You"} src={me?.avatar_url} profileId={me?.id} size="md" />
          <div
            onFocus={() => setFocused(true)}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
            }}
            className={`@container/composer min-w-0 flex-1 rounded-lg border bg-white transition-[border-color,box-shadow] ${
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
              links
              placeholder="Add a comment"
              className={`block w-full resize-none border-0 bg-transparent px-3 text-sm shadow-none outline-none placeholder:text-zinc-500 focus-visible:shadow-none field-sizing-content ${
                open ? "min-h-16 py-2" : "h-8 min-h-8 py-1.5"
              }`}
            />
            {/* Nov 2 notes (batch 17, 132): at most two short lines under the text. The text eases down to
                12px in a narrow pane (container units) before anything wraps, the email stays on one line
                (cut with an ellipsis, the whole address in its tooltip), and the labels shorten instead of
                stacking word by word. */}
            {open && (submitterEmail || canSendReview) ? (
              <div
                className="flex min-w-0 items-center gap-2 px-3 pb-1 pt-0.5 text-[clamp(0.75rem,3.2cqi,0.8125rem)] text-zinc-600"
                data-composer-options=""
              >
                {submitterEmail ? (
                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    <input
                      id="send-to-submitter"
                      type="checkbox"
                      checked={toSubmitter}
                      onChange={(e) => setToSubmitter(e.target.checked)}
                      className="size-4 shrink-0 rounded border-zinc-300 accent-accent-600"
                    />
                    <label
                      htmlFor="send-to-submitter"
                      className="flex min-w-0 items-baseline gap-1 whitespace-nowrap"
                      title={`Send response to submitter ${submitterEmail}`}
                    >
                      <span className="shrink-0 @max-[30rem]/composer:hidden">Send response to submitter</span>
                      <span className="hidden shrink-0 @max-[30rem]/composer:inline">Email submitter</span>
                      <a
                        href={`mailto:${submitterEmail}`}
                        title={submitterEmail}
                        className="min-w-0 truncate text-accent-700 hover:underline"
                        data-submitter-email=""
                      >
                        {submitterEmail}
                      </a>
                    </label>
                  </span>
                ) : (
                  <span className="flex-1" />
                )}
                {canSendReview ? (
                  <button
                    type="button"
                    onClick={() => setReviewing(draft.trim())}
                    aria-label="Send for review…"
                    data-tooltip="Pick or upload files and send them for approval or feedback"
                    className="btn-secondary h-7 shrink-0 gap-1 whitespace-nowrap px-2 text-xs"
                  >
                    <FileCheck className="size-3.5" aria-hidden />
                    <span className="@max-[22rem]/composer:hidden">Send for review…</span>
                  </button>
                ) : null}
              </div>
            ) : null}
            {open ? (
              <div className="flex min-w-0 items-center gap-2 px-2 pb-1.5">
                {(() => {
                  const hint =
                    toSubmitter && submitterEmail
                      ? task.replyThread?.closed
                        ? "Emailed to the submitter. Replies are closed, so their answers won’t be posted"
                        : "This comment is emailed to the submitter; their reply comes back here"
                      : "@ for people · # for tasks and projects · ⌘/Ctrl+Enter to send";
                  return (
                    <span className="mr-auto min-w-0 truncate pl-1 text-2xs text-zinc-500" title={hint}>
                      {hint}
                    </span>
                  );
                })()}
                <button type="button" onClick={submit} disabled={!draft.trim()} className="btn-primary h-7 shrink-0 px-3">
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
              {followerChange(permissions, memberId, p.id, true) === "remove" ? (
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
                    {permissions.canEdit
                      ? "Ticked people follow this task. Pick someone again to remove them."
                      : "Ticked people follow this task. Only Editors remove other followers."}
                  </p>
                }
                onPick={(profileId) => {
                  const change = followerChange(permissions, memberId, profileId, followerIds.includes(profileId));
                  if (change) follow(profileId, change === "add");
                }}
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
