"use client";

import { Layers, ListChecks, Lock, Repeat } from "lucide-react";
import { Avatar, displayName } from "@/components/avatar";
import { formatDueDate, isOverdue, useToday } from "@/lib/dates";
import type { Profile, ProjectTask } from "@/lib/data";
import { APPROVAL_STATUS_LABELS, type ApprovalTaskStatus } from "@/lib/task-kinds";

export function DueDate({ task }: { task: Pick<ProjectTask, "dueOn" | "completedAt"> }) {
  const today = useToday();
  if (!task.dueOn) return null;
  const overdue = isOverdue(task.dueOn, today, Boolean(task.completedAt));
  const year = today ? Number(today.slice(0, 4)) : undefined;
  return (
    <span className={`whitespace-nowrap text-xs tabular-nums ${overdue ? "font-medium text-red-600" : "text-zinc-500"}`}>
      {formatDueDate(task.dueOn, year)}
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
      <Avatar name={name} />
      {showName ? <span className="truncate text-xs text-zinc-600">{name}</span> : null}
      <span className="sr-only">Assigned to {name}</span>
    </span>
  );
}

const APPROVAL_STATUS_CLASSES: Record<ApprovalTaskStatus, string> = {
  pending: "bg-amber-50 text-amber-800 ring-amber-200",
  changes_requested: "bg-orange-50 text-orange-800 ring-orange-200",
  approved: "bg-green-50 text-green-800 ring-green-200",
  rejected: "bg-red-50 text-red-700 ring-red-200",
};

// Status of an approval task's request (List rows, Board cards, the pane).
export function ApprovalStatusBadge({ status }: { status: ApprovalTaskStatus }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded px-1.5 py-px text-2xs font-medium whitespace-nowrap ring-1 ring-inset ${APPROVAL_STATUS_CLASSES[status]}`}
    >
      {APPROVAL_STATUS_LABELS[status]}
    </span>
  );
}

export function TaskBadges({ task }: { task: ProjectTask }) {
  return (
    <>
      {task.kind === "approval" && task.approvalStatus ? <ApprovalStatusBadge status={task.approvalStatus} /> : null}
      {task.recurring ? (
        <span className="inline-flex items-center text-zinc-400" title="Repeats">
          <Repeat className="size-3.5" aria-hidden />
          <span className="sr-only">Repeats</span>
        </span>
      ) : null}
      {task.blockedBy > 0 && !task.completedAt ? (
        <span
          className="inline-flex items-center gap-1 text-xs tabular-nums text-amber-700"
          title={`Blocked by ${task.blockedBy} incomplete task${task.blockedBy === 1 ? "" : "s"}`}
        >
          <Lock className="size-3.5" aria-hidden />
          <span className="sr-only">Blocked by</span>
          {task.blockedBy}
        </span>
      ) : null}
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
