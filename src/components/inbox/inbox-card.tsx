"use client";

import Link from "next/link";
import {
  AlarmClock,
  Archive,
  ArchiveRestore,
  AtSign,
  Bookmark,
  BookmarkMinus,
  CheckCircle2,
  CirclePause,
  Mail,
  MailOpen,
  MessageSquare,
  MessagesSquare,
  Megaphone,
  ShieldCheck,
  UserPlus,
  Workflow,
} from "lucide-react";
import { Avatar, displayName } from "@/components/avatar";
import { ApprovalDecisionForm, type Decision } from "@/components/task/task-approval-banner";
import { TaskLink } from "@/components/task/task-link";
import { Timestamp } from "@/components/timestamp";
import type { InboxItem, Profile } from "@/lib/data";
import { isUuid } from "@/lib/ids";
import { accessRequestOf, isAccessGranted } from "@/lib/access-requests";
import { AccessRequestDecision } from "@/components/inbox/access-request-decision";
import { isFieldChange, type InboxDensity } from "@/lib/inbox";
import { seedFromTitle } from "@/lib/task-seed";
import { formatDueDate } from "@/lib/dates";

// One notification card in the Inbox (Asana parity, batch 5): unread dot, actor, "Actor verb Task",
// where it happened, the comment or message (Detailed density), an approver's decision buttons, the
// time, and hover actions (always shown on touch screens).

const KIND = {
  assigned: { icon: UserPlus, verb: "assigned you" },
  comment: { icon: MessageSquare, verb: "commented on" },
  mention: { icon: AtSign, verb: "mentioned you on" },
  completed: { icon: CheckCircle2, verb: "completed" },
  approval_requested: { icon: ShieldCheck, verb: "asked for your approval on" },
  approval_decided: { icon: ShieldCheck, verb: "decided an approval on" },
  rule: { icon: Workflow, verb: "notified you about" },
  message: { icon: MessagesSquare, verb: "replied in" },
  status_update: { icon: Megaphone, verb: "posted a status update on" },
} as const;

const STATUS_LABELS: Record<string, string> = {
  on_track: "On track",
  at_risk: "At risk",
  off_track: "Off track",
  on_hold: "On hold",
  complete: "Complete",
};

const APPROVAL_STATE: Record<string, string> = {
  pending: "Waiting for your decision",
  approved: "You approved this",
  changes_requested: "You requested changes",
  rejected: "You rejected this",
  cancelled: "This request was cancelled",
};

const DECISION_VERB: Record<string, string> = {
  approved: "approved",
  changes_requested: "requested changes on",
  rejected: "rejected",
};

export type { Decision };

// An approval reminder (Oct 27 notes, batch 6): approval_reminders_tick nudges each approver still
// deciding the day before the approval due date (due_soon) and once it's overdue.
export function approvalReminderOf(item: Pick<InboxItem, "kind" | "data">): "due_soon" | "overdue" | null {
  if (item.kind !== "approval_requested") return null;
  const reminder = dataText(item.data, "reminder");
  return reminder === "due_soon" || reminder === "overdue" ? reminder : null;
}

export function approvalReminderText(reminder: "due_soon" | "overdue"): string {
  return reminder === "overdue" ? "Reminder: approval overdue" : "Reminder: approval due tomorrow";
}

// The card's read / archived / bookmarked state, with the page's optimistic changes applied.
export type CardState = { read: boolean; archived: boolean; bookmarked: boolean };

function dataText(data: InboxItem["data"], key: string): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data[key];
  return typeof value === "string" && value ? value : null;
}

function describe(item: InboxItem) {
  const ruleName = dataText(item.data, "rule_name");
  const reminder = approvalReminderOf(item);
  if (reminder) {
    const dueOn = dataText(item.data, "due_on");
    return { ruleName: null, verb: approvalReminderText(reminder), detail: dueOn && /^\d{4}-\d{2}-\d{2}$/.test(dueOn) ? `Approval due ${formatDueDate(dueOn)}` : null };
  }
  let verb: string = KIND[item.kind].verb;
  if (item.kind === "approval_decided") verb = DECISION_VERB[dataText(item.data, "status") ?? ""] ?? verb;
  if (item.kind === "approval_requested" && item.data && typeof item.data === "object" && !Array.isArray(item.data) && item.data.resubmitted) {
    verb = "resubmitted for your approval";
  }
  if ((item.message || item.teamMessage) && item.kind === "mention") verb = "mentioned you in";
  // A new team thread (Real features 2) tells every team member: "posted".
  if (item.teamMessage && item.kind === "message" && isNewThread(item)) verb = "posted";
  // A field set to "Notify followers when changed" (Asana parity, batch 4): kind rule with
  // data.field_change, so the release before it still shows it as a notification.
  const fieldName = isFieldChange(item) ? dataText(item.data, "field_name") : null;
  if (fieldName) {
    const value = dataText(item.data, "value_text");
    return { ruleName, verb: `changed ${fieldName} on`, detail: value ? `${fieldName}: ${value}` : `${fieldName} was cleared` };
  }
  // Oct 26 notes (batch 3): someone asked to be added to a project, or an owner added them.
  if (accessRequestOf(item.data)) return { ruleName: null, verb: "asked to be added to", detail: null };
  if (isAccessGranted(item.data)) return { ruleName: null, verb: "added you to", detail: null };
  // A portfolio rule's status reminder (Automations V3) asks for an update.
  if (item.project && item.data && typeof item.data === "object" && !Array.isArray(item.data) && item.data.status_reminder === true) {
    return { ruleName, verb: "asks for a status update on", detail: item.commentBody };
  }
  if (item.statusUpdate) {
    const status = STATUS_LABELS[item.statusUpdate.status] ?? item.statusUpdate.status;
    const lines = [item.statusUpdate.title ? `${status} · ${item.statusUpdate.title}` : status, item.commentBody];
    return { ruleName, verb, detail: lines.filter(Boolean).join("\n") };
  }
  const detail =
    item.commentBody ?? dataText(item.data, "message") ?? dataText(item.data, "note") ?? null;
  return { ruleName, verb, detail };
}

// A rule that paused itself after failing again and again (Automations V2) tells its owner with a
// kind "rule" item carrying data.rule_paused; the card links to the rule so they can fix it.
function pausedRuleHref(item: InboxItem): string | null {
  const d = item.data;
  if (item.kind !== "rule" || !d || typeof d !== "object" || Array.isArray(d) || d.rule_paused !== true) return null;
  // A portfolio rule (Automations V3) links to the portfolio's rule.
  if (isUuid(d.portfolio_id) && isUuid(d.portfolio_rule_id)) return `/portfolios/${d.portfolio_id}/rules/${d.portfolio_rule_id}`;
  return isUuid(d.project_id) && isUuid(d.rule_id) ? `/projects/${d.project_id}/rules/${d.rule_id}` : null;
}

function isNewThread(item: InboxItem): boolean {
  const d = item.data;
  return !!d && typeof d === "object" && !Array.isArray(d) && d.new_thread === true;
}

// Where a card's link goes: a task opens in the pane next to the list, a message in its thread (a
// project's or a team's), a status update on its project's Overview.
export function inboxItemHref(item: InboxItem, taskHref: (taskId: string) => string) {
  if (item.message) {
    return `/projects/${item.message.projectId}/messages/${item.message.threadId}#message-${item.message.id}`;
  }
  if (item.teamMessage) {
    return `/teams/${item.teamMessage.teamId}/messages/${item.teamMessage.threadId}#message-${item.teamMessage.id}`;
  }
  if (item.statusUpdate) return `/projects/${item.statusUpdate.projectId}/overview`;
  // An item about a project (a portfolio rule's notification or status reminder): its Overview.
  if (item.project) return `/projects/${item.project.id}/overview`;
  return taskHref(item.taskId ?? "");
}

// Hidden until the card is hovered or something in it has focus; part of the row on touch screens.
// Positioned (relative, not static) there too, so the buttons stay above the card link's overlay.
const ACTIONS =
  "absolute right-2 z-10 flex items-center gap-0.5 rounded-md border border-zinc-200 bg-white p-0.5 opacity-0 shadow-sm group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 [@media(hover:none)]:relative [@media(hover:none)]:inset-auto [@media(hover:none)]:translate-y-0 [@media(hover:none)]:border-0 [@media(hover:none)]:p-0 [@media(hover:none)]:opacity-100 [@media(hover:none)]:shadow-none";
const ACTION = "btn-icon size-6";

export function InboxCard({
  item,
  actor,
  state,
  density,
  active,
  href,
  memberId,
  bookmarks,
  onOpen,
  onRead,
  onArchive,
  onBookmark,
  onDecide,
}: {
  item: InboxItem;
  actor: Profile | undefined;
  state: CardState;
  density: InboxDensity;
  // The task open in the pane came from this card.
  active: boolean;
  href: string;
  memberId: string;
  // Bookmarks need this release's migration (hasBatch5Schema()); without it there's no button.
  bookmarks: boolean;
  onOpen: () => void;
  onRead: (read: boolean) => void;
  onArchive: (archived: boolean) => void;
  onBookmark: (bookmarked: boolean) => void;
  onDecide: (decision: Decision, note: string) => void;
}) {
  const { read, archived, bookmarked } = state;
  const compact = density === "compact";
  // A task item opens in this page's pane; messages and status updates are links to other pages.
  const taskCard = !item.message && !item.teamMessage && !item.statusUpdate && !item.project;
  const linkClass = `block text-sm text-zinc-700 outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-accent-400 ${
    compact ? "truncate" : ""
  }`;
  const { ruleName, verb, detail } = describe(item);
  const reminder = approvalReminderOf(item);
  // A form submitter's emailed reply has no actor: name the address it came from.
  // Oct 26 notes (batch 3): a review check's outcome names the reviewer's address.
  const reviewer = dataText(item.data, "reviewer_email");
  const actorName = actor ? displayName(actor) : ruleName ? `Rule “${ruleName}”` : (item.emailFrom ?? reviewer ?? "Someone");
  const ruleHref = pausedRuleHref(item);
  const accessRequest = accessRequestOf(item.data);
  const Icon = reminder
    ? AlarmClock
    : ruleHref
      ? CirclePause
      : accessRequest || isAccessGranted(item.data)
        ? UserPlus
        : KIND[item.kind].icon;
  const strong = read ? "font-medium text-zinc-800" : "font-semibold text-zinc-900";
  const linkText = reminder ? (
    <>
      <span className={reminder === "overdue" ? `${strong} text-red-700` : strong}>{verb}</span> ·{" "}
      <span className={strong}>{item.taskTitle}</span>
      {item.parentTitle ? <span className="text-zinc-500"> (subtask of {item.parentTitle})</span> : null}
      {read ? null : <span className="sr-only"> (unread)</span>}
      {bookmarked ? <span className="sr-only"> (bookmarked)</span> : null}
    </>
  ) : (
    <>
      <span className={strong}>{actorName}</span> {verb} <span className={strong}>{item.taskTitle}</span>
      {item.parentTitle ? <span className="text-zinc-500"> (subtask of {item.parentTitle})</span> : null}
      {item.message ? <span className="text-zinc-500"> · Messages in {item.message.projectName}</span> : null}
      {item.teamMessage ? <span className="text-zinc-500"> · {item.teamMessage.teamName} team messages</span> : null}
      {read ? null : <span className="sr-only"> (unread)</span>}
      {bookmarked ? <span className="sr-only"> (bookmarked)</span> : null}
    </>
  );
  const decides = item.approval !== null && item.approval.approverId === memberId;
  const titleLink =
    taskCard && item.taskId ? (
      // A task opens in the pane next to the list at once (no navigation; Oct 19 notes).
      <TaskLink
        taskId={item.taskId}
        seed={() => seedFromTitle(item.taskId!, item.taskTitle ?? "Task", { parentTitle: item.parentTitle ?? null })}
        onClick={onOpen}
        className={linkClass}
      >
        {linkText}
      </TaskLink>
    ) : (
      <Link href={href} onClick={onOpen} className={linkClass}>
        {linkText}
      </Link>
    );
  // Above the card link's overlay, and kept from opening the task.
  const openRule = ruleHref ? (
    <Link
      href={ruleHref}
      onClick={(e) => e.stopPropagation()}
      aria-label={ruleName ? `Open rule “${ruleName}”` : undefined}
      className="relative z-10 shrink-0 text-xs font-medium text-accent-700 hover:underline focus-visible:outline-2 focus-visible:outline-accent-500"
    >
      Open rule
    </Link>
  ) : null;

  return (
    <li>
      <div
        data-unread={read ? undefined : "true"}
        className={`cv-card group relative flex gap-2.5 rounded-lg border transition-shadow hover:shadow-md ${
          compact ? "items-center px-3 py-2" : "px-3 py-3"
        } ${active ? "border-accent-400 bg-accent-50 ring-1 ring-accent-400" : "border-zinc-200 bg-white"}`}
      >
        <span
          aria-hidden
          className={`size-2 shrink-0 rounded-full ${read ? "" : "bg-accent-500"} ${compact ? "" : "mt-2.5"}`}
        />
        {reminder ? (
          <span
            aria-hidden
            className={`inline-flex shrink-0 items-center justify-center rounded-full ${
              reminder === "overdue" ? "bg-red-50 text-red-600" : "bg-amber-50 text-amber-700"
            } ${compact ? "size-5" : "size-7"}`}
          >
            <AlarmClock className={compact ? "size-3" : "size-3.5"} />
          </span>
        ) : actor || !ruleName ? (
          <Avatar name={actorName} src={actor?.avatar_url} profileId={actor?.id} size={compact ? "sm" : "md"} />
        ) : (
          <span
            aria-hidden
            className={`inline-flex shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-500 ${compact ? "size-5" : "size-7"}`}
          >
            <Workflow className={compact ? "size-3" : "size-3.5"} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          {titleLink}
          {!compact && detail ? (
            <p className="mt-1 line-clamp-2 whitespace-pre-line text-sm text-zinc-600">{detail}</p>
          ) : null}
          {/* Under the title in both densities (like the approver's buttons): at the right end of a
              compact row the hover / focus actions would cover it. */}
          {openRule ? <p className="mt-1">{openRule}</p> : null}
          {accessRequest ? <AccessRequestDecision request={accessRequest} compact={compact} /> : null}
          {decides && item.approval?.status === "pending" ? (
            // Request changes needs a note (the form won't send without one); Approve and Reject ask for one.
            <div className="relative z-10 mt-2" role="group" aria-label={`Decide on “${item.taskTitle}”`}>
              <ApprovalDecisionForm idPrefix={`inbox-${item.id}`} pending={false} compact onDecide={onDecide} />
            </div>
          ) : decides && item.kind === "approval_requested" && !compact && item.approval ? (
            <p className="mt-1 text-xs text-zinc-500">{APPROVAL_STATE[item.approval.status]}</p>
          ) : null}
          {compact ? null : (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-zinc-400">
              <Icon className="size-3.5" aria-hidden />
              <Timestamp iso={item.createdAt} />
              {bookmarked ? <Bookmark className="size-3.5 fill-current text-accent-600" aria-hidden /> : null}
            </p>
          )}
        </div>
        {compact ? (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-zinc-400">
            {bookmarked ? <Bookmark className="size-3.5 fill-current text-accent-600" aria-hidden /> : null}
            <Timestamp iso={item.createdAt} />
          </span>
        ) : null}
        <div className={`${ACTIONS} ${compact ? "top-1/2 -translate-y-1/2 self-center" : "top-2 self-start"}`}>
          {bookmarks ? (
            <button
              type="button"
              onClick={() => onBookmark(!bookmarked)}
              aria-label={bookmarked ? `Remove bookmark from “${item.taskTitle}”` : `Bookmark “${item.taskTitle}”`}
              data-tooltip={bookmarked ? "Remove bookmark" : "Bookmark"}
              className={`${ACTION} ${bookmarked ? "text-accent-600" : ""}`}
            >
              {bookmarked ? <BookmarkMinus className="size-3.5" /> : <Bookmark className="size-3.5" />}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => onRead(!read)}
            aria-label={read ? `Mark “${item.taskTitle}” as unread` : `Mark “${item.taskTitle}” as read`}
            data-tooltip={read ? "Mark as unread" : "Mark as read"}
            className={ACTION}
          >
            {read ? <Mail className="size-3.5" /> : <MailOpen className="size-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => onArchive(!archived)}
            aria-label={archived ? `Move “${item.taskTitle}” to Activity` : `Archive “${item.taskTitle}”`}
            data-tooltip={archived ? "Move to Activity" : "Archive"}
            className={ACTION}
          >
            {archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
          </button>
        </div>
      </div>
    </li>
  );
}
