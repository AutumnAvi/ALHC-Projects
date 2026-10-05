"use client";

import Link from "next/link";
import { useOptimistic, useState } from "react";
import { ChevronDown, ChevronRight, CircleCheck, FolderClosed, CheckCheck } from "lucide-react";
import { CompleteToggle } from "@/components/complete-toggle";
import { useTaskHref } from "@/components/project/shared";
import { useServerAction } from "@/components/toast";
import { EmptyState, SkeletonRows } from "@/components/ui";
import { setTaskCompleted } from "@/lib/actions";
import { addDays, formatDueDate, useToday } from "@/lib/dates";
import type { MyTask } from "@/lib/data";

type Group = { key: string; title: string; tasks: MyTask[] };

// Asana-style buckets, evaluated against the viewer's local date. See AGENTS.md › My Tasks.
function groupTasks(tasks: MyTask[], today: string): Group[] {
  const weekEnd = addDays(today, 7);
  const groups: Group[] = [
    { key: "overdue", title: "Overdue", tasks: [] },
    { key: "today", title: "Today", tasks: [] },
    { key: "next-7-days", title: "Next 7 days", tasks: [] },
    { key: "later", title: "Later", tasks: [] },
    { key: "no-date", title: "No due date", tasks: [] },
  ];
  const [overdue, dueToday, soon, later, noDate] = groups;
  for (const task of tasks) {
    if (!task.dueOn) noDate.tasks.push(task);
    else if (task.dueOn < today) overdue.tasks.push(task);
    else if (task.dueOn === today) dueToday.tasks.push(task);
    else if (task.dueOn <= weekEnd) soon.tasks.push(task);
    else later.tasks.push(task);
  }
  return groups.filter((g) => g.tasks.length > 0);
}

export function MyTasksView({
  open,
  completed,
  openTaskId,
}: {
  open: MyTask[];
  completed: MyTask[];
  openTaskId: string | null;
}) {
  const today = useToday();
  const [, run] = useServerAction();
  const [toggled, setToggled] = useOptimistic(
    new Map<string, boolean>(),
    (current, change: { id: string; completed: boolean }) =>
      new Map(current).set(change.id, change.completed),
  );

  const isDone = (task: MyTask) => toggled.get(task.id) ?? Boolean(task.completedAt);
  const toggle = (task: MyTask) => {
    const next = !isDone(task);
    run(
      () => setTaskCompleted(task.id, next),
      () => setToggled({ id: task.id, completed: next }),
    );
  };
  const rowProps = { openTaskId, today, isDone, onToggle: toggle };

  if (open.length === 0 && completed.length === 0) {
    return (
      <div className="mt-6">
        <EmptyState icon={CircleCheck} title="Nothing assigned to you">
          Tasks you’re assigned to in any project show up here, grouped into Overdue, Today, Next 7 days, Later,
          and No due date.
        </EmptyState>
      </div>
    );
  }

  return (
    <div>
      {today === null ? (
        <div role="status" className="mt-4">
          <span className="sr-only">Loading your tasks…</span>
          <SkeletonRows rows={Math.min(open.length || 3, 8)} />
        </div>
      ) : (
        groupTasks(open, today).map((group) => (
          <TaskGroup key={group.key} id={group.key} title={group.title} count={group.tasks.length}>
            {group.tasks.map((task) => (
              <MyTaskRow key={task.id} task={task} {...rowProps} />
            ))}
          </TaskGroup>
        ))
      )}
      {open.length === 0 ? (
        <div className="mt-4">
          <EmptyState icon={CheckCheck} title="You’re all caught up" size="inline">
            No open tasks are assigned to you. Completed ones are listed below.
          </EmptyState>
        </div>
      ) : null}
      {completed.length > 0 ? (
        <TaskGroup
          id="completed"
          title="Recently completed"
          count={completed.length}
          defaultCollapsed
        >
          {completed.map((task) => (
            <MyTaskRow key={task.id} task={task} {...rowProps} />
          ))}
        </TaskGroup>
      ) : null}
    </div>
  );
}

function TaskGroup({
  id,
  title,
  count,
  defaultCollapsed = false,
  children,
}: {
  id: string;
  title: string;
  count: number;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const headingId = `group-${id}`;
  return (
    <section className="mt-4" aria-labelledby={headingId}>
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className="flex h-8 items-center gap-1 rounded px-1 text-sm font-semibold text-zinc-900 hover:bg-zinc-100"
      >
        {collapsed ? (
          <ChevronRight className="size-4 text-zinc-400" />
        ) : (
          <ChevronDown className="size-4 text-zinc-400" />
        )}
        <span id={headingId}>{title}</span>
        <span className="text-xs font-normal tabular-nums text-zinc-400">{count}</span>
      </button>
      {collapsed ? null : <ul className="border-t border-zinc-200">{children}</ul>}
    </section>
  );
}

function MyTaskRow({
  task,
  openTaskId,
  today,
  isDone,
  onToggle,
}: {
  task: MyTask;
  openTaskId: string | null;
  today: string | null;
  isDone: (task: MyTask) => boolean;
  onToggle: (task: MyTask) => void;
}) {
  const taskHref = useTaskHref();
  const done = isDone(task);
  const open = openTaskId === task.id;
  const overdue = Boolean(task.dueOn && today && !done && task.dueOn < today);

  return (
    <li
      className={`flex min-h-row items-center gap-3 border-b border-zinc-100 px-3 py-1 ${
        open ? "bg-accent-50" : "hover:bg-zinc-50"
      }`}
    >
      <CompleteToggle
        completed={done}
        onToggle={() => onToggle(task)}
        label={done ? `Mark “${task.title}” incomplete` : `Mark “${task.title}” complete`}
      />
      <Link
        href={taskHref(task.id)}
        scroll={false}
        aria-current={open ? "true" : undefined}
        className={`min-w-0 flex-1 truncate text-sm hover:underline ${
          done ? "text-zinc-400 line-through" : "text-zinc-900"
        }`}
      >
        {task.title}
      </Link>
      <Link
        href={`/projects/${task.projectId}/list`}
        className="chip hidden max-w-40 shrink-0 truncate hover:bg-zinc-200 hover:text-zinc-900 sm:inline-flex"
      >
        <FolderClosed className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{task.projectName}</span>
      </Link>
      <span
        className={`w-16 shrink-0 text-right text-xs tabular-nums ${
          overdue ? "font-medium text-red-600" : "text-zinc-500"
        }`}
      >
        {task.dueOn ? formatDueDate(task.dueOn, today ? Number(today.slice(0, 4)) : undefined) : ""}
      </span>
    </li>
  );
}
