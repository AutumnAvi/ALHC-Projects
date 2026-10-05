"use client";

import { Layers, ListChecks } from "lucide-react";
import { Avatar, displayName } from "@/components/avatar";
import { formatDueDate, isOverdue, useToday } from "@/lib/dates";
import type { Profile, ProjectTask } from "@/lib/data";

export function DueDate({ task }: { task: ProjectTask }) {
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

export function TaskBadges({ task }: { task: ProjectTask }) {
  return (
    <>
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
