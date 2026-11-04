"use client";

import Link from "next/link";
import { useEffect, useOptimistic, useRef, useState, type ReactNode } from "react";
import { CalendarClock, CalendarDays, ChevronRight, FolderClosed, Lock, Repeat, Sparkles } from "lucide-react";
import { Popover } from "@/components/popover";
import { useOpenTaskId } from "@/components/shell/right-panel";
import { useShell } from "@/components/shell/shell-context";
import { RowCompleteControl } from "@/components/task/row-complete-control";
import { useDependencyShift } from "@/components/task/dependency-shift";
import { SingleDatePicker } from "@/components/task/date-picker";
import { TaskLink, useOpenTask, useTaskPrefetch } from "@/components/task/task-link";
import { MoreTaskNumbers } from "@/components/task/task-number";
import { useNotify, useServerAction } from "@/components/toast";
import { SkeletonRows } from "@/components/ui";
import { blockedCount } from "@/components/project/inline-cells";
import { ApprovalStatusBadge } from "@/components/project/task-meta";
import { dismissDatePrompt, setTaskCompleted, undoTaskCompleted } from "@/lib/actions";
import {
  QUICK_ADD_PENDING_SCOPE,
  SETTLE_MS,
  checkedPlacement,
  checklistDueLabel,
  checklistGroupOf,
  completedToday,
  dateChips,
  groupChecklist,
  type CheckedMode,
  type ChecklistGroupKey,
} from "@/lib/checklist";
import { useToday } from "@/lib/dates";
import type { MyTask } from "@/lib/data";
import { bareTaskTitle, formatRequestLabel } from "@/lib/request-numbers";
import { TaskTitleText } from "@/components/task/title-text";
import { seedFromMyTask } from "@/lib/task-seed";
import { trackCompletion } from "@/lib/completion-store";
import { isPendingCreateId, usePendingCreates, type PendingCreate } from "@/lib/pending-creates";

// My tasks as a simple checklist (Nov 1 notes, batch 9b, item 64), also Home's Today list: one list in
// automatic date groups (Overdue, Today, This week, Later, No date), big tap targets, and a tick that
// strikes the task through and — after a moment, so a mis-tap can be caught — does what the person's
// "Checked items" setting says (sink into a collapsed Done today, stay, or hide), with an Undo toast.
// Everything ticked clears overnight (only today's completions are shown). Dates change through
// useDependencyShift (the app's one date path), completion through setTaskCompleted.

export type ChecklistScope = "all" | "today";

// The checklist's state: optimistic ticks and dates, rows that are still settling, and "Not now"s.
// `initial` is the server's view of the viewer's day and time zone (the tz cookie), so the list renders
// on the server and hydrates without a skeleton; the browser's own date takes over after that.
export function useChecklist(
  open: MyTask[],
  completed: MyTask[],
  mode: CheckedMode,
  initial: { today?: string | null; timeZone?: string } = {},
) {
  const today = useToday() ?? initial.today ?? null;
  const [, run] = useServerAction();
  const notify = useNotify();
  const shift = useDependencyShift();
  const [toggled, setToggled] = useOptimistic(
    new Map<string, boolean>(),
    (current, change: { id: string; completed: boolean }) => new Map(current).set(change.id, change.completed),
  );
  // Ticks still on screen in their group (SETTLE_MS), and dates changed here until fresh data arrives.
  const [settling, setSettling] = useState<ReadonlySet<string>>(new Set());
  const [dueEdits, setDueEdits] = useState<Record<string, string | null>>({});
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [seenOpen, setSeenOpen] = useState(open);
  if (seenOpen !== open) {
    setSeenOpen(open);
    setDueEdits({});
  }
  const timers = useRef(new Map<string, number>());
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((t) => window.clearTimeout(t));
  }, []);

  const isDone = (task: MyTask) => toggled.get(task.id) ?? Boolean(task.completedAt);
  const dueOf = (task: MyTask) => (task.id in dueEdits ? dueEdits[task.id] : task.dueOn);

  function settle(id: string) {
    window.clearTimeout(timers.current.get(id));
    setSettling((s) => new Set(s).add(id));
    timers.current.set(
      id,
      window.setTimeout(() => {
        timers.current.delete(id);
        setSettling((s) => {
          const next = new Set(s);
          next.delete(id);
          return next;
        });
      }, SETTLE_MS),
    );
  }

  function check(task: MyTask) {
    const next = !isDone(task);
    if (next && blockedCount(task) > 0) return;
    if (next) settle(task.id);
    run(
      async () => {
        const result = await trackCompletion(task.id, next, () => setTaskCompleted(task.id, next))();
        if (!result.error && next) {
          const name = bareTaskTitle(task.title, task.requestLabel);
          notify(task.recurring ? `Completed “${name}”. The next one is on your list.` : `Completed “${name}”`, {
            label: "Undo",
            onClick: () =>
              run(
                () => undoTaskCompleted(task.id),
                () => setToggled({ id: task.id, completed: false }),
              ),
          });
        }
        return result;
      },
      () => setToggled({ id: task.id, completed: next }),
    );
  }

  function setDue(task: MyTask, dueOn: string | null, close?: () => void) {
    if (dueOn === dueOf(task)) return;
    setDueEdits((current) => ({ ...current, [task.id]: dueOn }));
    // A start date after the new due date would be refused: it moves with it.
    const startOn = task.startOn && dueOn && task.startOn > dueOn ? dueOn : undefined;
    shift.changeMany(
      [{ taskId: task.id, dueOn, ...(startOn !== undefined ? { startOn } : {}) }],
      `“${bareTaskTitle(task.title, task.requestLabel)}”`,
      null,
      {
        onPrompt: close,
        onRevert: () =>
          setDueEdits((current) => {
            const next = { ...current };
            delete next[task.id];
            return next;
          }),
      },
    );
  }

  function notNow(task: MyTask) {
    setDismissed((d) => new Set(d).add(task.id));
    run(() => dismissDatePrompt(task.id));
  }

  const asksForDate = (task: MyTask) =>
    Boolean(task.datePrompt) && task.canEdit && !dismissed.has(task.id) && !dueOf(task) && !isDone(task);

  // Every row the list may show: open tasks, tasks typed into the quick add that the refreshed list doesn't
  // have yet (Nov 3 notes, batch 19), and today's completions (yesterday's are gone).
  const doneToday = (task: MyTask) => (today ? completedToday(task.completedAt, today, initial.timeZone) : false);
  const openIds = new Set(open.map((t) => t.id));
  const pending = usePendingCreates(QUICK_ADD_PENDING_SCOPE, open).map(pendingTask);
  const rows = [...open, ...pending, ...completed.filter((t) => !openIds.has(t.id) && doneToday(t))];
  const placementOf = (task: MyTask) => (isDone(task) ? checkedPlacement(mode, !settling.has(task.id)) : "group");

  return { today, isDone, dueOf, check, setDue, notNow, asksForDate, rows, placementOf, dialog: shift.dialog };
}

export type Checklist = ReturnType<typeof useChecklist>;

// A quick-added task still saving, drawn like a row (its id is the pending entry's key).
function pendingTask(entry: PendingCreate): MyTask {
  const meta = entry.meta ?? {};
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    id: entry.key,
    title: entry.title,
    completedAt: null,
    dueOn: text(meta.dueOn),
    projectId: text(meta.projectId),
    projectName: text(meta.projectName),
    kind: "task",
    parentTitle: null,
    canEdit: false,
    recurring: meta.recurring === true,
  };
}

const GROUP_HINT: Partial<Record<ChecklistGroupKey, string>> = {
  week: "The next seven days",
  none: "Give each one a day so it shows up when it matters",
};

export function ChecklistView({
  list,
  mode,
  workWeek,
  scope = "all",
  emptyState,
  earlier = [],
}: {
  list: Checklist;
  mode: CheckedMode;
  workWeek?: readonly number[];
  scope?: ChecklistScope;
  emptyState?: ReactNode;
  // Tasks completed before today (the log; collapsed at the very bottom).
  earlier?: MyTask[];
}) {
  const [doneOpen, setDoneOpen] = useState(false);
  const [earlierOpen, setEarlierOpen] = useState(false);
  const { today } = list;
  if (today === null) {
    return (
      <div role="status" className="mt-2">
        <span className="sr-only">Loading your tasks…</span>
        <SkeletonRows rows={Math.min(list.rows.length || 3, 8)} />
      </div>
    );
  }
  const inScope = (task: MyTask) => {
    if (scope === "all") return true;
    const due = list.dueOf(task);
    return checklistGroupOf(due, today) === "overdue" || checklistGroupOf(due, today) === "today";
  };
  const visible = list.rows.filter(inScope);
  const grouped = groupChecklist(
    visible.filter((t) => list.placementOf(t) === "group"),
    today,
    list.dueOf,
  );
  const done = visible.filter((t) => list.placementOf(t) !== "group");
  const prompts = scope === "all" ? visible.filter(list.asksForDate) : [];
  const groups = grouped.map((g) =>
    // New dateless assignments first in No date.
    g.key === "none" ? { ...g, tasks: [...g.tasks].sort((a, b) => Number(list.asksForDate(b)) - Number(list.asksForDate(a))) } : g,
  );
  const openCount = visible.filter((t) => !list.isDone(t)).length;

  return (
    <div className="flex flex-col gap-5">
      {prompts.length > 0 ? (
        <a
          href="#checklist-none"
          className="flex items-center gap-2 rounded-lg border border-accent-200 bg-accent-50 px-3 py-2 text-sm text-accent-900 hover:bg-accent-100"
        >
          <Sparkles className="size-4 shrink-0 text-accent-600" aria-hidden />
          <span className="flex-1">
            {prompts.length === 1 ? "1 new task has" : `${prompts.length} new tasks have`} no date yet. Set a date so{" "}
            {prompts.length === 1 ? "it shows" : "they show"} up when {prompts.length === 1 ? "it matters" : "they matter"}.
          </span>
          <span className="shrink-0 font-medium">Set a date</span>
        </a>
      ) : null}

      {openCount === 0 && emptyState ? emptyState : null}

      {groups.map((group) => (
        <section
          key={group.key}
          id={`checklist-${group.key}`}
          aria-labelledby={`checklist-${group.key}-title`}
          className={group.key === "none" && scope === "all" ? "scroll-mt-4 rounded-xl border border-dashed border-zinc-300 bg-zinc-50/70 p-2" : ""}
        >
          <h2 id={`checklist-${group.key}-title`} className="flex items-baseline gap-2 px-2 pb-1">
            <span className={`text-sm font-semibold ${group.key === "overdue" ? "text-red-700" : "text-zinc-900"}`}>{group.title}</span>
            <span
              className={`rounded-full px-1.5 text-xs tabular-nums ${
                group.key === "overdue" ? "bg-red-100 font-medium text-red-700" : "bg-zinc-100 text-zinc-600"
              }`}
            >
              {group.tasks.filter((t) => !list.isDone(t)).length}
            </span>
            {GROUP_HINT[group.key] && scope === "all" ? (
              <span className="text-xs text-zinc-500">{GROUP_HINT[group.key]}</span>
            ) : null}
          </h2>
          <ul className="flex flex-col">
            {group.tasks.map((task) => (
              <ChecklistRow
                key={task.id}
                task={task}
                list={list}
                group={group.key}
                workWeek={workWeek}
                chips={group.key === "none"}
              />
            ))}
          </ul>
        </section>
      ))}

      {done.length > 0 && mode !== "stay" ? (
        <section aria-label="Done today">
          <button
            type="button"
            aria-expanded={doneOpen}
            onClick={() => setDoneOpen((o) => !o)}
            className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-sm hover:bg-zinc-100 ${
              mode === "hide" ? "text-xs text-zinc-500" : "font-semibold text-zinc-700"
            }`}
          >
            <ChevronRight className={`size-4 text-zinc-400 transition-transform ${doneOpen ? "rotate-90" : ""}`} aria-hidden />
            {mode === "hide" ? (doneOpen ? "Hide what you finished today" : `Show ${done.length} done today`) : "Done today"}
            {mode === "hide" ? null : <span className="rounded-full bg-zinc-100 px-1.5 text-xs font-normal tabular-nums text-zinc-600">{done.length}</span>}
          </button>
          {doneOpen ? (
            <ul className="mt-1 flex flex-col">
              {done.map((task) => (
                <ChecklistRow key={task.id} task={task} list={list} group="done" workWeek={workWeek} chips={false} />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      {earlier.length > 0 ? (
        <section aria-label="Completed earlier">
          <button
            type="button"
            aria-expanded={earlierOpen}
            onClick={() => setEarlierOpen((o) => !o)}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
          >
            <ChevronRight className={`size-3.5 transition-transform ${earlierOpen ? "rotate-90" : ""}`} aria-hidden />
            Completed earlier ({earlier.length})
          </button>
          {earlierOpen ? (
            <ul className="mt-1 flex flex-col">
              {earlier.map((task) => (
                <ChecklistRow key={task.id} task={task} list={list} group="done" workWeek={workWeek} chips={false} />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      {list.dialog}
    </div>
  );
}

function ChecklistRow({
  task,
  list,
  group,
  workWeek,
  chips,
}: {
  task: MyTask;
  list: Checklist;
  group: ChecklistGroupKey | "done";
  workWeek?: readonly number[];
  chips: boolean;
}) {
  const { member } = useShell();
  const openTaskId = useOpenTaskId();
  const openTask = useOpenTask();
  const seed = () => seedFromMyTask(task, { id: member.id, name: member.name });
  const prefetch = useTaskPrefetch(task.id, seed);
  const done = list.isDone(task);
  const isOpen = openTaskId === task.id;
  const due = list.dueOf(task);
  const today = list.today ?? "";
  const prompt = list.asksForDate(task);
  const blocked = done ? 0 : blockedCount(task);
  const title = bareTaskTitle(task.title, task.requestLabel);
  const label = formatRequestLabel(task.requestLabel);
  if (isPendingCreateId(task.id)) return <PendingChecklistRow task={task} due={due} today={today} />;

  return (
    <li
      data-checklist-row={task.id}
      data-done={done ? "" : undefined}
      onPointerEnter={prefetch.onPointerEnter}
      onPointerLeave={prefetch.onPointerLeave}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        if (!e.currentTarget.contains(target) || target.closest("a, button, input, textarea, label, [role='dialog']")) return;
        if (!isOpen) openTask(task.id, seed());
      }}
      className={`group flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2 transition-colors ${
        isOpen ? "bg-accent-50/70" : "hover:bg-zinc-50"
      } ${prompt ? "shadow-[inset_3px_0_0_var(--color-accent-500)]" : ""}`}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center">
        <RowCompleteControl
          task={task}
          completed={done}
          readOnly={!task.canEdit}
          assignedToMe={task.canComment ?? task.canEdit}
          blocked={blocked}
          size="lg"
          seed={seed}
          onToggle={() => list.check(task)}
        />
      </span>
      <div className="min-w-0 flex-1 py-0.5">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <TaskLink
            taskId={task.id}
            seed={seed}
            aria-current={isOpen ? "true" : undefined}
            className={`min-w-0 truncate text-[15px] leading-6 decoration-zinc-400 hover:underline ${
              done ? "text-zinc-400 line-through" : "text-zinc-900"
            }`}
          >
            <TaskTitleText title={title} nested />
          </TaskLink>
          {label ? <span className="shrink-0 text-2xs text-zinc-400">{label}</span> : null}
          <MoreTaskNumbers numbers={task.taskNumbers} />
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
          {task.projectId ? (
            <Link href={`/projects/${task.projectId}`} className="inline-flex max-w-48 items-center gap-1 truncate hover:text-zinc-800 hover:underline">
              <FolderClosed className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{task.projectName}</span>
            </Link>
          ) : (
            <span className="inline-flex items-center gap-1" title="Private: only you and its assignee can see it">
              <Lock className="size-3" aria-hidden />
              Private
            </span>
          )}
          {task.parentTitle ? <span className="truncate">in {task.parentTitle}</span> : null}
          {task.recurring ? <RepeatsMark /> : null}
          {(task.subtaskCount ?? 0) > 0 ? (
            <span className="tabular-nums" title={`${task.subtaskDoneCount ?? 0} of ${task.subtaskCount} subtasks done`}>
              {task.subtaskDoneCount ?? 0}/{task.subtaskCount} subtasks
            </span>
          ) : null}
          {task.kind === "approval" && task.approvalStatus ? (
            <ApprovalStatusBadge status={task.approvalStatus} paused={task.approvalPaused} />
          ) : null}
          {prompt ? <span className="font-medium text-accent-700">New · Set a date</span> : null}
        </div>
        {chips && task.canEdit && !done ? <DateChips task={task} list={list} workWeek={workWeek} prompt={prompt} /> : null}
      </div>
      {group !== "none" ? <DueControl task={task} list={list} due={due} today={today} done={done} /> : null}
    </li>
  );
}

// One-tap dates for a task with none: Today, Tomorrow, This (or Next) week, Pick date. A "Set a date"
// prompt also has Not now.
function DateChips({ task, list, workWeek, prompt }: { task: MyTask; list: Checklist; workWeek?: readonly number[]; prompt: boolean }) {
  const today = list.today;
  if (!today) return null;
  const chip = "inline-flex h-8 items-center gap-1 rounded-full border border-zinc-200 bg-white px-3 text-xs font-medium text-zinc-700 hover:border-accent-300 hover:bg-accent-50 hover:text-accent-800";
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5" role="group" aria-label={`Set a date for “${task.title}”`}>
      {dateChips(today, workWeek).map((c) => (
        <button key={c.key} type="button" className={chip} onClick={() => list.setDue(task, c.day)} title={c.day}>
          {c.label}
        </button>
      ))}
      <Popover
        label={`Pick a due date for “${task.title}”`}
        panelClassName="w-[19rem] p-0"
        buttonClassName={chip}
        button={
          <>
            <CalendarDays className="size-3.5" aria-hidden />
            Pick date
          </>
        }
      >
        {(close) => (
          <SingleDatePicker
            label="Due date"
            value={null}
            onChange={(day) => {
              close();
              if (day) list.setDue(task, day, close);
            }}
          />
        )}
      </Popover>
      {prompt ? (
        <button type="button" onClick={() => list.notNow(task)} className="h-8 rounded-full px-2 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800">
          Not now
        </button>
      ) : null}
    </div>
  );
}

// The due date on the right: Today / Tomorrow / a weekday / Oct 28 (red when overdue); editors change it
// from a date picker.
// A repeating task's mark, spelled out (Nov 3 notes, batch 19: a bare 12px icon was easy to miss).
function RepeatsMark() {
  return (
    <span className="inline-flex items-center gap-1 text-accent-700" title="Repeats: the next one is made when you check this off">
      <Repeat className="size-3" aria-hidden />
      Repeats
    </span>
  );
}

// A task typed into the quick add, in the group it will land in, until the saved row arrives.
function PendingChecklistRow({ task, due, today }: { task: MyTask; due: string | null; today: string }) {
  return (
    <li data-checklist-row={task.id} data-pending="" aria-busy="true" className="flex items-start gap-3 rounded-lg px-2 py-2">
      <span className="mt-0.5 inline-flex size-[22px] shrink-0 rounded-full border-2 border-dashed border-zinc-300" aria-hidden />
      <div className="min-w-0 flex-1 py-0.5">
        <span className="block min-w-0 truncate text-[15px] leading-6 text-zinc-500">{task.title}</span>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
          {task.projectName ? (
            <span className="inline-flex max-w-48 items-center gap-1 truncate">
              <FolderClosed className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{task.projectName}</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <Lock className="size-3" aria-hidden />
              Private
            </span>
          )}
          {task.recurring ? <RepeatsMark /> : null}
          <span className="italic text-zinc-400">Saving…</span>
        </div>
      </div>
      {due ? <span className="mt-1.5 shrink-0 text-xs tabular-nums text-zinc-500">{checklistDueLabel(due, today)}</span> : null}
    </li>
  );
}

function DueControl({ task, list, due, today, done }: { task: MyTask; list: Checklist; due: string | null; today: string; done: boolean }) {
  const overdue = Boolean(due && !done && due < today);
  const text = due ? checklistDueLabel(due, today) : "";
  const shown = (
    <span className={`inline-flex items-center gap-1 text-xs tabular-nums ${overdue ? "font-medium text-red-600" : done ? "text-zinc-400" : "text-zinc-500"}`}>
      {due ? text : <CalendarClock className="size-4 text-zinc-400" aria-hidden />}
      {overdue ? <span className="sr-only"> (overdue)</span> : null}
    </span>
  );
  if (!task.canEdit || done) return <span className="mt-1.5 shrink-0">{shown}</span>;
  return (
    <Popover
      label={`Due date of “${task.title}”: ${due ? text : "none"}. Change`}
      align="end"
      panelClassName="w-[19rem] p-0"
      buttonClassName="mt-0.5 inline-flex h-7 shrink-0 items-center rounded-md px-1.5 hover:bg-zinc-100"
      button={shown}
    >
      {(close) => (
        <SingleDatePicker
          label="Due date"
          value={due}
          onChange={(day) => {
            close();
            list.setDue(task, day, close);
          }}
        />
      )}
    </Popover>
  );
}
