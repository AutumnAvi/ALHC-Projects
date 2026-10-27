"use client";

import { CalendarDays, Layers, ListChecks, MessageSquare, Paperclip, Repeat, UserRound } from "lucide-react";
import { Avatar, displayName } from "@/components/avatar";
import { addDays, formatDueDate, isOverdue, useToday } from "@/lib/dates";
import type { Profile, ProjectTask } from "@/lib/data";
import { APPROVAL_STATUS_LABELS, approvalStatusText, type ApprovalTaskStatus } from "@/lib/task-kinds";

// Asana's due dates: overdue in red, today and tomorrow in green (spelled out), the rest as dates.
// Completed tasks stay neutral.
export function DueDate({ task }: { task: Pick<ProjectTask, "dueOn" | "completedAt"> }) {
  const today = useToday();
  if (!task.dueOn) return null;
  const completed = Boolean(task.completedAt);
  const overdue = isOverdue(task.dueOn, today, completed);
  const soon = !completed && today !== null && (task.dueOn === today || task.dueOn === addDays(today, 1));
  const year = today ? Number(today.slice(0, 4)) : undefined;
  const label =
    today !== null && task.dueOn === today
      ? "Today"
      : today !== null && task.dueOn === addDays(today, 1)
        ? "Tomorrow"
        : today !== null && task.dueOn === addDays(today, -1)
          ? "Yesterday"
          : formatDueDate(task.dueOn, year);
  return (
    <span
      title={label === formatDueDate(task.dueOn, year) ? undefined : formatDueDate(task.dueOn, year)}
      className={`whitespace-nowrap text-xs tabular-nums ${
        overdue ? "font-medium text-red-600" : soon ? "font-medium text-green-700" : "text-zinc-500"
      }`}
    >
      {label}
      {overdue ? <span className="sr-only"> (overdue)</span> : null}
    </span>
  );
}

// The speech bubble with the number of comments (List rows, Board cards).
export function CommentCount({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums text-zinc-500"
      title={`${count} comment${count === 1 ? "" : "s"}`}
    >
      {count}
      <MessageSquare className="size-3.5" aria-hidden />
      <span className="sr-only"> comment{count === 1 ? "" : "s"}</span>
    </span>
  );
}

// Asana's paperclip on a List row (Oct 27 notes, batch 5): how many files are attached.
export function AttachmentCount({ count }: { count: number | undefined }) {
  if (!count || count <= 0) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums text-zinc-500"
      title={`${count} attachment${count === 1 ? "" : "s"}`}
    >
      {count}
      <Paperclip className="size-3.5" aria-hidden />
      <span className="sr-only"> attachment{count === 1 ? "" : "s"}</span>
    </span>
  );
}

export function StartDate({ task, prefix = "" }: { task: Pick<ProjectTask, "startOn">; prefix?: string }) {
  const today = useToday();
  if (!task.startOn) return null;
  const year = today ? Number(today.slice(0, 4)) : undefined;
  return (
    <span className="whitespace-nowrap text-xs tabular-nums text-zinc-500">
      {prefix}
      {formatDueDate(task.startOn, year)}
    </span>
  );
}

// Asana's dashed person / calendar circle in an empty assignee or date cell, shown while the row is
// hovered (rows carry `group`). Decorative: clicking the row opens the task to set it.
// hidden: people who can't edit the task get no "click to set" hint (Oct 26 notes).
export function EmptyCellHint({ kind, hidden = false }: { kind: "person" | "date"; hidden?: boolean }) {
  if (hidden) return null;
  const Icon = kind === "person" ? UserRound : CalendarDays;
  return (
    <span
      aria-hidden
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed border-zinc-300 text-zinc-400 opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:hidden"
    >
      <Icon className="size-3.5" />
    </span>
  );
}

export function Assignee({
  profile,
  showName = false,
}: {
  profile: Profile | undefined;
  showName?: boolean;
}) {
  if (!profile) return null;
  const name = displayName(profile);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Avatar name={name} src={profile.avatar_url} profileId={profile.id} />
      {showName ? <span className="truncate text-xs text-zinc-600">{name}</span> : null}
      <span className="sr-only">Assigned to {name}</span>
    </span>
  );
}

const APPROVAL_STATUS_CLASSES: Record<ApprovalTaskStatus, string> = {
  not_sent: "bg-zinc-50 text-zinc-600 ring-zinc-200",
  pending: "bg-amber-50 text-amber-800 ring-amber-200",
  changes_requested: "bg-orange-50 text-orange-800 ring-orange-200",
  approved: "bg-green-50 text-green-800 ring-green-200",
  rejected: "bg-red-50 text-red-700 ring-red-200",
};

// Status of an approval task (List rows, Board cards, My tasks, the pane). Paused = Changes requested /
// Rejected and the assignee hasn't marked the feedback received yet (Oct 27 notes, batch 6).
export function ApprovalStatusBadge({ status, paused = false }: { status: ApprovalTaskStatus; paused?: boolean }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-px text-2xs font-medium whitespace-nowrap ring-1 ring-inset ${APPROVAL_STATUS_CLASSES[status]}`}
      title={approvalStatusText(status, paused)}
    >
      {APPROVAL_STATUS_LABELS[status]}
      {paused ? <span className="rounded bg-white/70 px-1 text-[10px] uppercase tracking-wide">Paused</span> : null}
    </span>
  );
}

export function TaskBadges({ task }: { task: ProjectTask }) {
  return (
    <>
      {task.kind === "approval" && task.approvalStatus ? (
        <ApprovalStatusBadge status={task.approvalStatus} paused={task.approvalPaused} />
      ) : null}
      {task.recurring ? (
        <span className="inline-flex items-center text-zinc-400" title="Repeats">
          <Repeat className="size-3.5" aria-hidden />
          <span className="sr-only">Repeats</span>
        </span>
      ) : null}
      {/* Blocked tasks wear the lock on their completion control (BlockedToggle; Oct 27 notes, batch 6). */}
      {task.subtaskCount > 0 ? (
        <span
          className="inline-flex items-center gap-1 text-xs tabular-nums text-zinc-500"
          title={`${task.subtaskDoneCount} of ${task.subtaskCount} subtasks done`}
        >
          <ListChecks className="size-3.5" />
          {task.subtaskDoneCount}/{task.subtaskCount}
        </span>
      ) : null}
      {task.projectCount > 1 ? (
        <span
          className="inline-flex items-center gap-1 text-xs tabular-nums text-zinc-500"
          title={`In ${task.projectCount} projects`}
        >
          <Layers className="size-3.5" />
          {task.projectCount}
        </span>
      ) : null}
    </>
  );
}
