"use client";

import Link from "next/link";
import { startTransition, useEffect, useOptimistic, useRef, useState, type KeyboardEvent } from "react";
import { CalendarCheck, CircleCheck, CircleCheckBig, Lock, Plus } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { RowCompleteControl } from "@/components/task/row-complete-control";
import { DueDate } from "@/components/project/task-meta";
import { useOpenTaskId } from "@/components/shell/right-panel";
import { useShell } from "@/components/shell/shell-context";
import { TaskLink, useOpenTask } from "@/components/task/task-link";
import { useTabChord } from "@/components/shortcuts/keyboard";
import { useServerAction } from "@/components/toast";
import { EmptyState } from "@/components/ui";
import { Widget, WidgetTitle } from "@/components/home/widget";
import { createPrivateTask, setTaskCompleted } from "@/lib/actions";
import type { MyTask } from "@/lib/data";
import { seedFromMyTask } from "@/lib/task-seed";
import { HOME_TASK_TABS, RECENT_COMPLETED_LIMIT, createdFirst, type HomeTaskTab } from "@/lib/home";
import { projectColorClass } from "@/lib/project-colors";

// A task being saved from the add row: its title shows where it was typed until the page refreshes.
type SavingTask = { key: number; title: string };
const NONE_SAVING: SavingTask[] = [];

// Home → My tasks (Asana parity, batch 5): the tasks assigned to you in three tabs. A row opens the task
// in the pane next to Home (`/?task=<id>`); the circle completes it right here. Create task (or Tab then
// Q) opens Asana's inline new-task row at the top of Upcoming.
export function MyTasksWidget({
  tasks,
}: {
  // Split on the server against the viewer's local today (splitHomeTasks).
  tasks: Record<HomeTaskTab, MyTask[]>;
}) {
  // The task whose pane is open (instant: no server render on open / close; Oct 19 notes).
  const openTaskId = useOpenTaskId();
  const openTask = useOpenTask();
  const { member } = useShell();
  const [, run] = useServerAction();
  const [creating, create] = useServerAction();
  // Start on the tab that holds the open task, so a reload with ?task= shows its row.
  const [tab, setTab] = useState<HomeTaskTab>(
    () => HOME_TASK_TABS.find((t) => tasks[t.key].some((task) => task.id === openTaskId))?.key ?? "upcoming",
  );
  const [toggled, setToggled] = useOptimistic(
    new Map<string, boolean>(),
    (current, change: { id: string; completed: boolean }) => new Map(current).set(change.id, change.completed),
  );

  // The add row: whether it's open, and a counter that asks it for focus again (Create task or Tab→Q
  // while it's already open).
  const [adding, setAdding] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  // Tasks created here during this visit (newest first) stay at the top of Upcoming, right under the add
  // row, instead of joining the undated tasks at the end; while one is saving its title shows there.
  const [createdIds, setCreatedIds] = useState<string[]>([]);
  const [saving, addSaving] = useOptimistic(NONE_SAVING, (current, task: SavingTask) => [task, ...current]);
  const savingKey = useRef(0);
  const createButton = useRef<HTMLButtonElement>(null);

  // New tasks have no due date, so they land in Upcoming: the add row lives there.
  const startAdding = () => {
    setTab("upcoming");
    setAdding(true);
    setFocusRequest((n) => n + 1);
  };
  // Tab then Q on Home opens the row instead of Create → Task (whose menu item still opens the dialog).
  useTabChord("q", startAdding);

  const addTask = (title: string, restore: (title: string) => void) => {
    const key = ++savingKey.current;
    create(
      async () => {
        const result = await createPrivateTask(title);
        const taskId = result.taskId;
        // An update after an await needs its own transition to land with the refreshed tasks.
        if (taskId) startTransition(() => setCreatedIds((ids) => [taskId, ...ids]));
        // Not saved: give the typed name back (the error toasts).
        else if (result.error) restore(title);
        return result;
      },
      () => addSaving({ key, title }),
    );
  };

  const stopAdding = (returnFocus: boolean) => {
    setAdding(false);
    if (returnFocus) createButton.current?.focus();
  };

  // The add row belongs to Upcoming: another tab closes it.
  const selectTab = (key: HomeTaskTab) => {
    setTab(key);
    if (key !== "upcoming") setAdding(false);
  };

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
    selectTab(HOME_TASK_TABS[next].key);
    document.getElementById(`home-tasks-tab-${HOME_TASK_TABS[next].key}`)?.focus();
  }

  const shown = tab === "upcoming" ? createdFirst(tasks.upcoming, createdIds) : tasks[tab];
  const overdueCount = tasks.overdue.length;
  // With the add row open (or a task saving), the list starts there instead of with the empty state.
  const composing = tab === "upcoming" && (adding || saving.length > 0);

  return (
    <Widget
      labelledBy="home-my-tasks"
      header={
        <>
          <div className="flex items-center gap-3">
            <Avatar name={member.name || member.email} profileId={member.id} size="lg" />
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
                onClick={() => selectTab(t.key)}
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
        {tab === "upcoming" ? (
          <button
            ref={createButton}
            type="button"
            onClick={startAdding}
            className="flex h-10 w-full items-center gap-2.5 border-b border-zinc-100 px-5 text-left text-sm text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900"
          >
            <Plus className="size-4" aria-hidden />
            Create task
          </button>
        ) : null}
        {shown.length === 0 && !composing ? (
          <EmptyTab tab={tab} />
        ) : (
          <ul aria-label={HOME_TASK_TABS.find((t) => t.key === tab)?.label}>
            {tab === "upcoming" && adding ? (
              <AddTaskRow focusRequest={focusRequest} pending={creating} onAdd={addTask} onClose={stopAdding} />
            ) : null}
            {tab === "upcoming"
              ? saving.map((task) => (
                  <li
                    key={`saving-${task.key}`}
                    aria-busy="true"
                    className="flex min-h-10 items-center gap-2.5 border-b border-zinc-100 px-5 py-1.5"
                  >
                    <EmptyCircle />
                    <span className="min-w-0 flex-1 truncate text-sm text-zinc-900">
                      {task.title}
                      <span className="sr-only"> (saving)</span>
                    </span>
                    <PrivateChip />
                    <span aria-hidden className="min-w-16 shrink-0" />
                  </li>
                ))
              : null}
            {shown.map((task) => {
              const done = isDone(task);
              const open = task.id === openTaskId;
              const seed = () => seedFromMyTask(task, { id: member.id, name: member.name });
              return (
                <li
                  key={task.id}
                  onClick={(e) => {
                    // Clicking anywhere on the row opens the task; the circle, the title, and the project
                    // chip keep their own meaning.
                    if ((e.target as HTMLElement).closest("a, button")) return;
                    if (!open) openTask(task.id, seed());
                  }}
                  className={`group flex min-h-10 cursor-pointer items-center gap-2.5 border-b border-zinc-100 px-5 py-1.5 ${
                    open ? "bg-accent-50/60" : "hover:bg-zinc-50"
                  }`}
                >
                  {/* Approval tasks: only their approvers tick them; the assignee sends them (Oct 29 notes, batch 7). */}
                  <RowCompleteControl
                    task={task}
                    completed={done}
                    readOnly={!task.canEdit}
                    assignedToMe
                    seed={seed}
                    onToggle={() => toggle(task)}
                  />
                  <TaskLink
                    taskId={task.id}
                    seed={seed}
                    aria-current={open ? "true" : undefined}
                    className={`min-w-0 flex-1 truncate text-sm hover:underline ${done ? "text-zinc-400 line-through" : "text-zinc-900"}`}
                  >
                    {task.title}
                  </TaskLink>
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

// Asana's inline new-task row at the top of Upcoming. Enter saves a private task (assigned to you, in no
// project, like My tasks' add row) and leaves the box open and empty for the next one; Escape cancels and
// closes it, and so does leaving it empty.
function AddTaskRow({
  focusRequest,
  pending,
  onAdd,
  onClose,
}: {
  focusRequest: number;
  pending: boolean;
  onAdd: (title: string, restore: (title: string) => void) => void;
  onClose: (returnFocus: boolean) => void;
}) {
  const [title, setTitle] = useState("");
  const input = useRef<HTMLInputElement>(null);
  // On opening, and again whenever Create task or Tab→Q asks while it's open.
  useEffect(() => {
    input.current?.focus();
  }, [focusRequest]);

  return (
    <li>
      <form
        className="flex min-h-10 items-center gap-2.5 border-b border-zinc-100 px-5 py-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          const value = title.trim();
          if (!value) return;
          setTitle("");
          onAdd(value, (failed) => setTitle((current) => current || failed));
        }}
      >
        <EmptyCircle />
        <label htmlFor="home-add-task" className="sr-only">
          New private task name
        </label>
        <input
          ref={input}
          id="home-add-task"
          value={title}
          maxLength={1000}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={(e) => {
            if (!e.currentTarget.value.trim()) onClose(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose(true);
          }}
          placeholder={pending ? "Adding…" : "Task name, then Enter"}
          aria-describedby="home-add-task-hint"
          className="control min-w-0 flex-1"
        />
        <span id="home-add-task-hint" className="hidden shrink-0 items-center gap-1 text-xs text-zinc-500 @md:inline-flex">
          <Lock className="size-3" aria-hidden />
          Private to you
        </span>
      </form>
    </li>
  );
}

// The completion circle's place on a row that can't be completed yet (the add row, a task saving).
function EmptyCircle() {
  return <span aria-hidden className="size-[18px] shrink-0 rounded-full border border-zinc-300" />;
}

function PrivateChip() {
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

// The task's project (its home project when the viewer can read it), or "Private" for a task that is
// in no project yet.
function ProjectChip({ task }: { task: MyTask }) {
  if (!task.projectId) return <PrivateChip />;
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
