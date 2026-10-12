"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useOptimistic, useState, type KeyboardEvent } from "react";
import { CalendarCheck, CircleCheck, CircleCheckBig, Lock, Plus } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { CompleteToggle, kindToggleLabel } from "@/components/complete-toggle";
import { DueDate } from "@/components/project/task-meta";
import { useShell } from "@/components/shell/shell-context";
import { useServerAction } from "@/components/toast";
import { EmptyState } from "@/components/ui";
import { Widget, WidgetTitle } from "@/components/home/widget";
import { setTaskCompleted } from "@/lib/actions";
import type { MyTask } from "@/lib/data";
import { HOME_TASK_TABS, RECENT_COMPLETED_LIMIT, type HomeTaskTab } from "@/lib/home";
import { projectColorClass } from "@/lib/project-colors";

// Home → My tasks (Asana parity, batch 5): the tasks assigned to you in three tabs. A row opens the task
// in the pane next to Home (`/?task=<id>`); the circle completes it right here.
export function MyTasksWidget({
  tasks,
  openTaskId,
}: {
  // Split on the server against the viewer's local today (splitHomeTasks).
  tasks: Record<HomeTaskTab, MyTask[]>;
  openTaskId: string | null;
}) {
  const router = useRouter();
  const { member, openDialog } = useShell();
  const [, run] = useServerAction();
  // Start on the tab that holds the open task, so a reload with ?task= shows its row.
  const [tab, setTab] = useState<HomeTaskTab>(
    () => HOME_TASK_TABS.find((t) => tasks[t.key].some((task) => task.id === openTaskId))?.key ?? "upcoming",
  );
  const [toggled, setToggled] = useOptimistic(
    new Map<string, boolean>(),
    (current, change: { id: string; completed: boolean }) => new Map(current).set(change.id, change.completed),
  );

  const isDone = (task: MyTask) => toggled.get(task.id) ?? Boolean(task.completedAt);
  const toggle = (task: MyTask) => {
    const next = !isDone(task);
    run(
      () => setTaskCompleted(task.id, next),
      () => setToggled({ id: task.id, completed: next }),
    );
  };

  function onTabKey(e: KeyboardEvent<HTMLDivElement>) {
    const index = HOME_TASK_TABS.findIndex((t) => t.key === tab);
    const last = HOME_TASK_TABS.length - 1;
    const next =
      e.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : e.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : e.key === "Home" ? 0
      : e.key === "End" ? last
      : null;
    if (next === null) return;
    e.preventDefault();
    setTab(HOME_TASK_TABS[next].key);
    document.getElementById(`home-tasks-tab-${HOME_TASK_TABS[next].key}`)?.focus();
  }

  const shown = tasks[tab];
  const overdueCount = tasks.overdue.length;

  return (
    <Widget
      labelledBy="home-my-tasks"
      header={
        <>
          <div className="flex items-center gap-3">
            <Avatar name={member.name || member.email} size="lg" />
            <WidgetTitle id="home-my-tasks">
              <Link href="/my-tasks" className="hover:underline">
                My tasks
              </Link>
            </WidgetTitle>
            <span
              tabIndex={0}
              data-tooltip="Only you can see your My tasks list"
              className="inline-flex rounded text-zinc-400 focus-visible:outline-2 focus-visible:outline-accent-500"
            >
              <Lock className="size-3.5" aria-hidden />
              <span className="sr-only">Only you can see your My tasks list</span>
            </span>
          </div>
          <div role="tablist" aria-label="My tasks" onKeyDown={onTabKey} className="tab-strip mt-3 gap-4">
            {HOME_TASK_TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                id={`home-tasks-tab-${t.key}`}
                aria-selected={tab === t.key}
                aria-controls="home-tasks-panel"
                tabIndex={tab === t.key ? 0 : -1}
                onClick={() => setTab(t.key)}
                className="inline-flex h-9 shrink-0 items-center gap-1 border-b-2 border-transparent text-sm text-zinc-500 hover:text-zinc-900 aria-selected:border-accent-500 aria-selected:font-medium aria-selected:text-zinc-900"
              >
                {t.label}
                {t.key === "overdue" && overdueCount > 0 ? <span className="tabular-nums">({overdueCount})</span> : null}
              </button>
            ))}
          </div>
        </>
      }
    >
      <div id="home-tasks-panel" role="tabpanel" aria-labelledby={`home-tasks-tab-${tab}`}>
        {/* New tasks have no due date, so they land in Upcoming: the row lives there. */}
        {tab === "upcoming" ? (
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={() => openDialog({ kind: "task" })}
            className="flex h-10 w-full items-center gap-2.5 border-b border-zinc-100 px-5 text-left text-sm text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900"
          >
            <Plus className="size-4" aria-hidden />
            Create task
          </button>
        ) : null}
        {shown.length === 0 ? (
          <EmptyTab tab={tab} />
        ) : (
          <ul aria-label={HOME_TASK_TABS.find((t) => t.key === tab)?.label}>
            {shown.map((task) => {
              const done = isDone(task);
              const open = task.id === openTaskId;
              const href = `/?task=${task.id}`;
              return (
                <li
                  key={task.id}
                  onClick={(e) => {
                    // Clicking anywhere on the row opens the task; the circle, the title, and the project
                    // chip keep their own meaning.
                    if ((e.target as HTMLElement).closest("a, button")) return;
                    if (!open) router.push(href, { scroll: false });
                  }}
                  className={`group flex min-h-10 cursor-pointer items-center gap-2.5 border-b border-zinc-100 px-5 py-1.5 ${
                    open ? "bg-accent-50/60" : "hover:bg-zinc-50"
                  }`}
                >
                  <CompleteToggle
                    kind={task.kind}
                    completed={done}
                    onToggle={() => toggle(task)}
                    label={kindToggleLabel(task.kind, task.title, done)}
                  />
                  <Link
                    href={href}
                    scroll={false}
                    aria-current={open ? "true" : undefined}
                    className={`min-w-0 flex-1 truncate text-sm hover:underline ${done ? "text-zinc-400 line-through" : "text-zinc-900"}`}
                  >
                    {task.title}
                  </Link>
                  {task.parentTitle ? (
                    <span className="hidden max-w-28 shrink-0 truncate text-xs text-zinc-400 @xl:inline" title={`Subtask of ${task.parentTitle}`}>
                      <span className="sr-only">Subtask of </span>
                      <span aria-hidden>‹ </span>
                      {task.parentTitle}
                    </span>
                  ) : null}
                  <ProjectChip task={task} />
                  {/* A minimum, not a fixed width: a date in another year ("Dec 31, 2025") is wider. */}
                  <span className="flex min-w-16 shrink-0 justify-end">
                    <DueDate task={{ dueOn: task.dueOn, completedAt: done ? (task.completedAt ?? "done") : null }} />
                  </span>
                </li>
              );
            })}
            {tab === "completed" && shown.length >= RECENT_COMPLETED_LIMIT ? (
              <li className="px-5 py-3 text-xs text-zinc-500">
                Showing your {RECENT_COMPLETED_LIMIT} most recently completed tasks.
              </li>
            ) : null}
          </ul>
        )}
      </div>
    </Widget>
  );
}

// The task's project (its home project when the viewer can read it), or "Private" for a task that is
// in no project yet.
function ProjectChip({ task }: { task: MyTask }) {
  if (!task.projectId) {
    return (
      <span
        className="chip hidden shrink-0 @md:inline-flex"
        title="Private: only you and its assignee can see it, until it’s added to a project"
      >
        <Lock className="size-3 shrink-0" aria-hidden />
        Private
      </span>
    );
  }
  return (
    <Link
      href={`/projects/${task.projectId}`}
      className="chip hidden max-w-36 shrink-0 gap-1.5 hover:bg-zinc-200 hover:text-zinc-900 @md:inline-flex"
    >
      <span aria-hidden className={`size-2 shrink-0 rounded-[3px] ${projectColorClass(task.projectId)}`} />
      <span className="truncate">{task.projectName}</span>
    </Link>
  );
}

function EmptyTab({ tab }: { tab: HomeTaskTab }) {
  if (tab === "overdue") {
    return (
      <EmptyState size="inline" icon={CalendarCheck} title="No overdue tasks">
        Open tasks assigned to you that are past their due date show up here.
      </EmptyState>
    );
  }
  if (tab === "completed") {
    return (
      <EmptyState size="inline" icon={CircleCheckBig} title="No completed tasks yet">
        Tasks assigned to you show up here once they’re marked complete.
      </EmptyState>
    );
  }
  return (
    <EmptyState size="inline" icon={CircleCheck} title="No upcoming tasks">
      Tasks assigned to you that are due from today on, or have no due date, show up here. Create one, or ask a
      teammate to assign you one.
    </EmptyState>
  );
}
