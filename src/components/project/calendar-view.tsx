"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState, type DragEvent } from "react";
import { ChevronLeft, ChevronRight, Inbox } from "lucide-react";
import { useCan } from "@/components/project/project-access";
import { useServerAction } from "@/components/toast";
import { updateTask } from "@/lib/actions";
import { addDays, useToday } from "@/lib/dates";
import type { Profile, ProjectTask } from "@/lib/data";
import { isIsoDate } from "@/lib/views";
import { useTaskHref } from "./shared";
import { Assignee } from "./task-meta";
import { useProjectTasks } from "./use-project-tasks";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DRAG_TYPE = "application/x-alhc-task";
const MONTH_CELL_LIMIT = 3;

const pad = (n: number) => String(n).padStart(2, "0");
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

function monthStart(date: string) {
  return `${date.slice(0, 7)}-01`;
}

function shiftMonth(date: string, delta: number) {
  const [y, m] = date.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}-01`;
}

function range(start: string, end: string) {
  const days: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  return days;
}

// Calendar days for the visible period, starting on Sunday.
function visibleDays(anchor: string, mode: "month" | "week") {
  if (mode === "week") {
    const start = addDays(anchor, -weekday(anchor));
    return range(start, addDays(start, 6));
  }
  const first = monthStart(anchor);
  const last = addDays(shiftMonth(anchor, 1), -1);
  return range(addDays(first, -weekday(first)), addDays(last, 6 - weekday(last)));
}

function periodLabel(anchor: string, mode: "month" | "week") {
  const [y, m] = anchor.split("-").map(Number);
  if (mode === "month") return `${MONTHS[m - 1]} ${y}`;
  const start = addDays(anchor, -weekday(anchor));
  const end = addDays(start, 6);
  const fmt = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1].slice(0, 3)} ${Number(d.slice(8))}`;
  return `${fmt(start)} – ${fmt(end)}, ${end.slice(0, 4)}`;
}

export function CalendarView({
  tasks,
  profiles,
  openTaskId,
}: {
  tasks: ProjectTask[];
  profiles: Profile[];
  openTaskId: string | null;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const today = useToday();
  const [optimisticTasks, applyChange] = useProjectTasks(tasks);
  const [, run] = useServerAction();
  const canEdit = useCan("editor");
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropDate, setDropDate] = useState<string | null | undefined>(undefined);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const requested = searchParams.get("d");
  const mode = searchParams.get("cal") === "week" ? "week" : "month";
  const anchor = isIsoDate(requested) ? requested : today;
  const profilesById = new Map(profiles.map((p) => [p.id, p]));

  function navigate(next: { d?: string | null; cal?: "month" | "week" }) {
    const params = new URLSearchParams(searchParams.toString());
    if (next.d !== undefined) {
      if (next.d) params.set("d", next.d);
      else params.delete("d");
    }
    if (next.cal) {
      if (next.cal === "week") params.set("cal", "week");
      else params.delete("cal");
    }
    const query = params.toString();
    window.history.replaceState(null, "", query ? `${pathname}?${query}` : pathname);
  }

  function reschedule(taskId: string, dueOn: string | null) {
    const task = optimisticTasks.find((t) => t.id === taskId);
    if (!task || task.dueOn === dueOn) return;
    run(
      () => updateTask(taskId, { dueOn }),
      () => applyChange({ type: "due", taskId, dueOn }),
    );
  }

  const dropProps = (date: string | null) => ({
    onDragOver: (e: DragEvent) => {
      if (!dragging) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (dropDate !== date) setDropDate(date);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const taskId = e.dataTransfer.getData(DRAG_TYPE);
      if (taskId) reschedule(taskId, date);
      setDragging(null);
      setDropDate(undefined);
    },
  });

  const chipProps = (task: ProjectTask) => ({
    task,
    assignee: task.assigneeId ? profilesById.get(task.assigneeId) : undefined,
    open: openTaskId === task.id,
    overdue: Boolean(today && task.dueOn && !task.completedAt && task.dueOn < today),
    dragging: dragging === task.id,
    draggable: canEdit,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData(DRAG_TYPE, task.id);
      e.dataTransfer.effectAllowed = "move";
      setDragging(task.id);
    },
    onDragEnd: () => {
      setDragging(null);
      setDropDate(undefined);
    },
  });

  const byDate = new Map<string, ProjectTask[]>();
  for (const task of optimisticTasks) {
    if (!task.dueOn) continue;
    const list = byDate.get(task.dueOn) ?? [];
    list.push(task);
    byDate.set(task.dueOn, list);
  }
  const tray = optimisticTasks.filter((t) => !t.dueOn && !t.completedAt);

  if (!anchor) {
    return <p className="px-6 py-6 text-sm text-zinc-400">Loading calendar…</p>;
  }

  const days = visibleDays(anchor, mode);
  const currentMonth = anchor.slice(0, 7);
  const step = (delta: number) =>
    navigate({ d: mode === "week" ? addDays(anchor, delta * 7) : shiftMonth(anchor, delta) });

  return (
    <div className="flex min-h-0 flex-1 gap-4 px-6 py-4">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="mr-2 text-base font-semibold text-zinc-900" aria-live="polite">
            {periodLabel(anchor, mode)}
          </h2>
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => step(-1)}
              aria-label={mode === "week" ? "Previous week" : "Previous month"}
              className="rounded-md p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
            >
              <ChevronLeft className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => step(1)}
              aria-label={mode === "week" ? "Next week" : "Next month"}
              className="rounded-md p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
          <button
            type="button"
            onClick={() => navigate({ d: null })}
            className="rounded-md border border-zinc-200 px-2 py-0.5 text-sm text-zinc-700 hover:border-zinc-300"
          >
            Today
          </button>
          <div role="group" aria-label="Calendar range" className="ml-auto inline-flex rounded-md border border-zinc-200 p-0.5">
            {(["month", "week"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => navigate({ cal: m })}
                className="rounded px-2 py-0.5 text-sm text-zinc-600 aria-pressed:bg-zinc-900 aria-pressed:text-white"
              >
                {m === "month" ? "Month" : "Week"}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-7 border-b border-zinc-200 pb-1 text-xs font-medium text-zinc-500" aria-hidden>
          {WEEKDAYS.map((d) => (
            <span key={d} className="px-2">
              {d}
            </span>
          ))}
        </div>
        <ol
          className={`grid min-h-0 flex-1 grid-cols-7 border-l border-zinc-200 ${mode === "week" ? "auto-rows-[minmax(16rem,1fr)]" : "auto-rows-[minmax(7rem,1fr)]"}`}
          aria-label={`Tasks due, ${periodLabel(anchor, mode)}`}
        >
          {days.map((date) => {
            const dayTasks = byDate.get(date) ?? [];
            const isOpen = mode === "week" || expanded.has(date);
            const shown = isOpen ? dayTasks : dayTasks.slice(0, MONTH_CELL_LIMIT);
            const outside = mode === "month" && date.slice(0, 7) !== currentMonth;
            const isToday = date === today;
            const target = dragging && dropDate === date;
            return (
              <li
                key={date}
                {...dropProps(date)}
                aria-label={`${date}: ${dayTasks.length} task${dayTasks.length === 1 ? "" : "s"}`}
                className={`flex min-w-0 flex-col gap-1 border-r border-b border-zinc-200 p-1.5 ${
                  target ? "bg-accent-50" : outside ? "bg-zinc-50/70" : "bg-white"
                }`}
              >
                <span
                  className={`self-start rounded-full px-1.5 text-xs tabular-nums ${
                    isToday ? "bg-accent-600 font-semibold text-white" : outside ? "text-zinc-400" : "text-zinc-600"
                  }`}
                >
                  {Number(date.slice(8))}
                </span>
                {shown.map((task) => (
                  <CalendarChip key={task.id} {...chipProps(task)} />
                ))}
                {!isOpen && dayTasks.length > MONTH_CELL_LIMIT ? (
                  <button
                    type="button"
                    onClick={() => setExpanded((s) => new Set(s).add(date))}
                    className="self-start rounded px-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
                  >
                    +{dayTasks.length - MONTH_CELL_LIMIT} more
                  </button>
                ) : null}
              </li>
            );
          })}
        </ol>
        <p className="mt-2 text-xs text-zinc-500">
          Tasks are placed by due date. Drag a task to another day to reschedule it, or onto “No due date” to clear it.
        </p>
      </div>

      <aside
        {...dropProps(null)}
        aria-label="Tasks without a due date"
        className={`hidden w-64 shrink-0 flex-col rounded-xl border p-2 md:flex ${
          dragging && dropDate === null ? "border-accent-200 bg-accent-50" : "border-transparent bg-zinc-100/70"
        }`}
      >
        <h3 className="flex items-center gap-1.5 px-1 pb-2 text-sm font-semibold text-zinc-900">
          <Inbox className="size-4 text-zinc-500" aria-hidden />
          No due date
          <span className="text-xs font-normal tabular-nums text-zinc-400">{tray.length}</span>
        </h3>
        <div className="flex min-h-0 flex-col gap-1.5 overflow-y-auto">
          {tray.map((task) => (
            <CalendarChip key={task.id} {...chipProps(task)} roomy />
          ))}
          {tray.length === 0 ? (
            <p className="px-1 text-xs text-zinc-500">Every incomplete task in this view has a due date.</p>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

function CalendarChip({
  task,
  assignee,
  open,
  overdue,
  dragging,
  roomy = false,
  draggable,
  onDragStart,
  onDragEnd,
}: {
  task: ProjectTask;
  assignee: Profile | undefined;
  open: boolean;
  overdue: boolean;
  dragging: boolean;
  roomy?: boolean;
  draggable: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
}) {
  const taskHref = useTaskHref();
  const completed = Boolean(task.completedAt);
  return (
    <Link
      href={taskHref(task.id)}
      scroll={false}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      aria-current={open ? "true" : undefined}
      title={task.title}
      className={`flex min-w-0 items-center gap-1.5 rounded-md border bg-white px-1.5 text-xs shadow-xs hover:border-zinc-300 ${
        roomy ? "py-1.5" : "py-0.5"
      } ${open ? "border-accent-500 ring-2 ring-accent-100" : overdue ? "border-red-200" : "border-zinc-200"} ${
        dragging ? "opacity-40" : ""
      }`}
    >
      <span
        aria-hidden
        className={`size-2 shrink-0 rounded-full ${completed ? "bg-green-500" : overdue ? "bg-red-500" : "bg-zinc-300"}`}
      />
      <span className={`min-w-0 flex-1 truncate ${completed ? "text-zinc-400 line-through" : "text-zinc-800"}`}>
        {task.title}
        {completed ? <span className="sr-only"> (completed)</span> : null}
        {overdue ? <span className="sr-only"> (overdue)</span> : null}
      </span>
      {roomy ? <Assignee profile={assignee} /> : null}
    </Link>
  );
}
