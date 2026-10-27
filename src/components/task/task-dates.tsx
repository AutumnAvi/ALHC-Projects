"use client";

import { useEffect, useOptimistic, useState, useSyncExternalStore } from "react";
import { CalendarDays, Clock, Repeat, X } from "lucide-react";
import { Popover } from "@/components/popover";
import { useServerAction } from "@/components/toast";
import { updateTask } from "@/lib/actions";
import { addDays, useToday } from "@/lib/dates";
import { dayLabel, formatTime } from "@/lib/date-input";
import type { TaskDetail } from "@/lib/data";
import { describeRecurrence } from "@/lib/recurrence";
import { useDependencyShift } from "./dependency-shift";
import { DateRangePicker, TimeInput, type DateRange } from "./date-picker";
import { TaskRecurrence } from "./task-recurrence";

const subscribe = () => () => {};

// "HH:MM" of an instant in the browser's zone; null while server rendering (avoids hydration drift).
function useLocalTime(iso: string | null): string | null {
  return useSyncExternalStore(
    subscribe,
    () => {
      if (!iso) return "";
      const d = new Date(iso);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    },
    () => null,
  );
}

function browserTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export const DUE_TRIGGER_ID = "task-due-trigger";
// The pane's "…" → Repeats opens the date picker with Repeats open.
export const OPEN_REPEATS_EVENT = "alhc:task-repeats";

// How a date reads in the pane: Today / Tomorrow / Yesterday, else "Oct 14" (with the year when it
// isn't this one). Server render: the plain date (today isn't known there).
export function useDateText() {
  const today = useToday();
  const year = today ? Number(today.slice(0, 4)) : new Date().getUTCFullYear();
  return (day: string) => {
    if (today) {
      if (day === today) return "Today";
      if (day === addDays(today, 1)) return "Tomorrow";
      if (day === addDays(today, -1)) return "Yesterday";
    }
    return dayLabel(day, year);
  };
}

// The pane's Due date row (Asana parity, batch 3): one field for the start date, due date, times, and
// Repeats, edited in the date picker. Dates go through useDependencyShift, so tasks that depend on this
// one move (later or earlier) as the project's Settings → Dependencies says: Auto-shift, Ask me, or Off.
export function TaskDueDate({ task, canEdit }: { task: TaskDetail; canEdit: boolean }) {
  const [, run] = useServerAction();
  const shift = useDependencyShift();
  const today = useToday();
  const dateText = useDateText();
  const [dates, setDates] = useOptimistic<DateRange>({ start: task.startOn, due: task.dueOn });
  const [repeatsOpen, setRepeatsOpen] = useState(false);
  const dueTime = useLocalTime(task.dueAt);
  const startTime = useLocalTime(task.startAt);
  const milestone = task.kind === "milestone";
  const completed = Boolean(task.completedAt);
  const { start, due } = dates;

  // The "…" menu's Repeats: open the picker with the Repeats section open (both updates batch).
  useEffect(() => {
    if (!canEdit) return;
    const open = () => {
      setRepeatsOpen(true);
      document.getElementById(DUE_TRIGGER_ID)?.click();
    };
    window.addEventListener(OPEN_REPEATS_EVENT, open);
    return () => window.removeEventListener(OPEN_REPEATS_EVENT, open);
  }, [canEdit]);

  function save(next: DateRange, close: () => void, shouldClose: boolean) {
    if (next.start === start && next.due === due) {
      if (shouldClose) close();
      return;
    }
    if (shouldClose) close();
    shift.changeDates(
      task,
      { startOn: milestone ? null : next.start, dueOn: next.due },
      {
        onOptimistic: (moves) => {
          const self = moves.find((m) => m.taskId === task.id);
          if (self) setDates({ start: self.startOn, due: self.dueOn });
        },
        onPrompt: close,
        projectId: task.homeProjectId,
      },
    );
  }

  function saveTime(kind: "start" | "due", hhmm: string | null) {
    const day = kind === "start" ? start : due;
    if (!day) return;
    const at = hhmm ? new Date(`${day}T${hhmm}`).toISOString() : null;
    const patch = kind === "start" ? { startAt: at } : { dueAt: at };
    run(() => updateTask(task.id, at ? { ...patch, timeZone: browserTimeZone() } : patch));
  }

  const overdue = Boolean(due && today && !completed && due < today);
  const soon = Boolean(due && today && !completed && (due === today || due === addDays(today, 1)));
  let text: string;
  if (start && due && start !== due) {
    text = `${dateText(start)} – ${dateText(due)}`;
  } else if (due) {
    text = dateText(due);
  } else if (start) {
    text = `Starts ${dateText(start)}`;
  } else {
    text = "No due date";
  }
  const time = dueTime ? ` ${formatTime(dueTime)}` : "";
  const label = due || start ? `${text}${time}` : text;
  const tone = !due && !start ? "text-zinc-500" : overdue ? "text-red-600" : soon ? "text-green-700" : "text-zinc-800";

  const display = (
    <>
      <span
        aria-hidden
        className={`inline-flex size-6 shrink-0 items-center justify-center rounded-full ${
          due || start ? "text-zinc-500" : "border border-dashed border-zinc-300 text-zinc-400"
        }`}
      >
        <CalendarDays className="size-3.5" />
      </span>
      <span className={`truncate ${tone}`}>{label}</span>
      {task.recurrence ? (
        <span className="inline-flex shrink-0 items-center text-zinc-400" title={describeRecurrence(task.recurrence)}>
          <Repeat className="size-3.5" aria-hidden />
          <span className="sr-only">, repeats {describeRecurrence(task.recurrence).toLowerCase()}</span>
        </span>
      ) : null}
    </>
  );

  if (!canEdit) {
    return <div className="flex min-h-8 items-center gap-1.5 px-1 text-sm">{display}</div>;
  }

  return (
    <div className="group/due flex min-h-8 items-center">
      {shift.dialog}
      <Popover
        label={`Due date: ${label}${task.recurrence ? `, repeats ${describeRecurrence(task.recurrence).toLowerCase()}` : ""}. Change`}
        buttonId={DUE_TRIGGER_ID}
        panelClassName="w-[19rem] p-0"
        buttonClassName="inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-md px-1 text-sm hover:bg-zinc-100 aria-expanded:bg-zinc-100"
        button={display}
        onOpenChange={(open) => {
          if (!open) setRepeatsOpen(false);
        }}
      >
        {(close) => (
          <DateRangePicker value={dates} allowStart={!milestone} onChange={(next, shouldClose) => save(next, close, shouldClose)}>
            <TimeRows start={milestone ? null : start} due={due} startTime={startTime} dueTime={dueTime} onChange={saveTime} />
            <TaskRecurrence key={repeatsOpen ? "open" : "closed"} task={task} defaultOpen={repeatsOpen} />
          </DateRangePicker>
        )}
      </Popover>
      {due || start ? (
        <button
          type="button"
          onClick={() => save({ start: null, due: null }, () => undefined, false)}
          aria-label="Clear the dates"
          data-tooltip="Clear dates"
          className="ml-0.5 rounded p-1 text-zinc-400 opacity-0 hover:bg-zinc-100 hover:text-zinc-700 focus-visible:opacity-100 group-hover/due:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

// Optional times on the start and due dates, on the viewer's clock (stored with their time zone).
function TimeRows({
  start,
  due,
  startTime,
  dueTime,
  onChange,
}: {
  start: string | null;
  due: string | null;
  startTime: string | null;
  dueTime: string | null;
  onChange: (kind: "start" | "due", hhmm: string | null) => void;
}) {
  const [adding, setAdding] = useState(false);
  const hasTime = Boolean(dueTime || startTime);
  if (!hasTime && !adding) {
    return (
      <button
        type="button"
        disabled={!due && !start}
        onClick={() => setAdding(true)}
        title={!due && !start ? "Pick a date first" : undefined}
        className="btn-ghost -mx-1 h-7 self-start px-1.5 text-xs"
      >
        <Clock className="size-3.5" aria-hidden />
        Add time
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      {start ? (
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-xs text-zinc-500">Start time</span>
          <TimeInput label="Start time" value={startTime || null} onChange={(t) => onChange("start", t)} />
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-xs text-zinc-500">Due time</span>
        <TimeInput label="Due time" value={dueTime || null} disabled={!due} onChange={(t) => onChange("due", t)} />
      </div>
    </div>
  );
}
