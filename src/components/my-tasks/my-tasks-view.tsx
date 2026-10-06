"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useOptimistic, useState } from "react";
import { ChevronDown, ChevronRight, CircleCheck, FolderClosed, CheckCheck } from "lucide-react";
import { BulkBar, useBulkEdit, type BulkContext } from "@/components/bulk/bulk-bar";
import { useTaskSelection, type TaskSelection } from "@/components/bulk/use-task-selection";
import { CompleteToggle } from "@/components/complete-toggle";
import { useTaskHref } from "@/components/project/shared";
import { scrollRowIntoView, useListKeys } from "@/components/shortcuts/keyboard";
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
  bulk,
}: {
  open: MyTask[];
  completed: MyTask[];
  openTaskId: string | null;
  bulk: Omit<BulkContext, "project">;
}) {
  const router = useRouter();
  const taskHref = useTaskHref();
  const today = useToday();
  const [, run] = useServerAction();
  const bulkEdit = useBulkEdit();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(["completed"]));
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

  const groups: Group[] = [
    ...(today === null ? [] : groupTasks(open, today)),
    ...(completed.length > 0 ? [{ key: "completed", title: "Recently completed", tasks: completed }] : []),
  ];
  const tasksById = new Map([...open, ...completed].map((t) => [t.id, t]));
  const selection = useTaskSelection(
    groups.flatMap((g) => g.tasks.map((t) => t.id)),
    groups.filter((g) => !collapsed.has(g.key)).flatMap((g) => g.tasks.map((t) => t.id)),
  );
  const targets = () => {
    if (selection.selected.length) return selection.selected;
    const one = openTaskId && tasksById.has(openTaskId) ? openTaskId : selection.active;
    return one ? [one] : [];
  };

  useListKeys({
    move(delta, extend) {
      const next = selection.move(delta, extend);
      if (next) requestAnimationFrame(() => scrollRowIntoView(next));
    },
    open() {
      const id = selection.active ?? (selection.selected.length === 1 ? selection.selected[0] : null);
      if (id) router.push(taskHref(id), { scroll: false });
    },
    escape() {
      if (openTaskId || selection.selected.length === 0) return false;
      selection.clear();
      return true;
    },
    complete() {
      const ids = targets();
      if (ids.length === 0) return;
      const next = !ids.every((id) => {
        const task = tasksById.get(id);
        return task ? isDone(task) : true;
      });
      bulkEdit.apply(ids, { action: next ? "complete" : "reopen" }, () => {
        for (const id of ids) setToggled({ id, completed: next });
      });
    },
    assignToMe() {
      const ids = targets();
      if (ids.length) bulkEdit.apply(ids, { action: "assign", assignee_id: bulk.viewerId });
    },
  });

  const rowProps = { openTaskId, today, isDone, onToggle: toggle, selection, selecting: selection.selected.length > 0 };
  const collapseProps = (key: string) => ({
    collapsed: collapsed.has(key),
    onToggleCollapsed: () =>
      setCollapsed((c) => {
        const next = new Set(c);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
  });

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
    <div className="pb-20">
      {today === null ? (
        <div role="status" className="mt-4">
          <span className="sr-only">Loading your tasks…</span>
          <SkeletonRows rows={Math.min(open.length || 3, 8)} />
        </div>
      ) : (
        groupTasks(open, today).map((group) => (
          <TaskGroup
            key={group.key}
            id={group.key}
            title={group.title}
            count={group.tasks.length}
            {...collapseProps(group.key)}
          >
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
        <TaskGroup id="completed" title="Recently completed" count={completed.length} {...collapseProps("completed")}>
          {completed.map((task) => (
            <MyTaskRow key={task.id} task={task} {...rowProps} />
          ))}
        </TaskGroup>
      ) : null}
      <BulkBar
        selected={selection.selected}
        completedCount={selection.selected.filter((id) => {
          const task = tasksById.get(id);
          return task ? isDone(task) : false;
        }).length}
        context={bulk}
        bulk={bulkEdit}
        onClear={selection.clear}
      />
    </div>
  );
}

function TaskGroup({
  id,
  title,
  count,
  collapsed,
  onToggleCollapsed,
  children,
}: {
  id: string;
  title: string;
  count: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  children: React.ReactNode;
}) {
  const headingId = `group-${id}`;
  return (
    <section className="mt-4" aria-labelledby={headingId}>
      <button
        type="button"
        onClick={onToggleCollapsed}
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
  selection,
  selecting,
}: {
  task: MyTask;
  openTaskId: string | null;
  today: string | null;
  isDone: (task: MyTask) => boolean;
  onToggle: (task: MyTask) => void;
  selection: TaskSelection;
  selecting: boolean;
}) {
  const taskHref = useTaskHref();
  const done = isDone(task);
  const open = openTaskId === task.id;
  const overdue = Boolean(task.dueOn && today && !done && task.dueOn < today);
  const selected = selection.isSelected(task.id);

  return (
    <li
      data-task-row={task.id}
      onMouseDown={(e) => {
        if (e.shiftKey) e.preventDefault(); // no text selection on Shift-click ranges
      }}
      onClick={(e) => {
        const control = (e.target as HTMLElement).closest("a, button, input, select, textarea, label");
        const modified = e.shiftKey || e.metaKey || e.ctrlKey;
        if (control && !(control.tagName === "A" && modified && control.getAttribute("data-task-link") !== null)) {
          if (control.getAttribute("data-task-link") !== null) selection.setActive(task.id);
          return;
        }
        e.preventDefault();
        selection.click(task.id, e);
      }}
      className={`group flex min-h-row items-center gap-3 border-b border-zinc-100 px-3 py-1 ${
        selected ? "bg-accent-50" : open ? "bg-accent-50/60" : "hover:bg-zinc-50"
      } ${selection.active === task.id ? "shadow-[inset_2px_0_0_var(--color-accent-500)]" : ""}`}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={() => undefined}
        onClick={(e) => {
          e.stopPropagation();
          selection.toggle(task.id, e.shiftKey);
        }}
        aria-label={`Select “${task.title}”`}
        className={`-mr-1 size-3.5 shrink-0 rounded border-zinc-300 accent-accent-600 ${
          selected || selecting ? "" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
        }`}
      />
      <CompleteToggle
        completed={done}
        onToggle={() => onToggle(task)}
        label={done ? `Mark “${task.title}” incomplete` : `Mark “${task.title}” complete`}
      />
      <Link
        href={taskHref(task.id)}
        scroll={false}
        data-task-link=""
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
