"use client";

import { useEffect, useOptimistic, useState, useSyncExternalStore } from "react";
import { CalendarDays, Clock, Repeat, X } from "lucide-react";
import { Popover } from "@/components/popover";
import { useServerAction } from "@/components/toast";
import { updateTask } from "@/lib/actions/tasks";
import { addDays, useToday } from "@/lib/dates";
import { dayLabel, formatTime, taskTimeOf, taskZoneLabel, timeEditPatch } from "@alhc/core/date-input";
import type { TaskDetail } from "@alhc/core/api/task-pane/model";
import { describeRecurrence } from "@alhc/core/recurrence";
import { useDependencyShift } from "./dependency-shift";
import { DateRangePicker, TimeInput, type DateRange } from "./date-picker";
import { TaskRecurrence } from "./task-recurrence";
import { recordTaskEdits } from "./task-edits";

const subscribe = () => () => {};

function browserTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// The browser's zone; null while server rendering (avoids hydration drift).
function useViewerZone(): string | null {
  return useSyncExternalStore(subscribe, browserTimeZone, () => null);
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
  // Batch 45 (Isaiah, Nov 23): the times on the task's own clock, like its dates (@alhc/core/date-input),
  // with the zone's letters when it isn't the viewer's — never a viewer-clock time next to a task-clock date.
  const viewerZone = useViewerZone();
  const dueTime = viewerZone ? taskTimeOf(task, "due", viewerZone) : null;
  const startTime = viewerZone ? taskTimeOf(task, "start", viewerZone) : null;
  const zoneLabel = viewerZone ? taskZoneLabel(task, viewerZone) : null;
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

  function save(next: DateRange, close: () => void, shouldClose: boolean, typed?: { kind: "start" | "due"; time: string }) {
    // Batch 45 (Isaiah, Nov 23): "tomorrow at 4 p.m." typed into a date box keeps its time: saved on the
    // new day once the date has moved (or at once when the day is the same).
    const typedDay = typed ? (typed.kind === "due" ? next.due : next.start) : null;
    const saveTyped = () => {
      if (typed && typedDay && !(milestone && typed.kind === "start")) saveTime(typed.kind, typed.time, typedDay);
    };
    if (next.start === start && next.due === due) {
      saveTyped();
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
          // Nov 4 notes, batch 28 (M4): the List / Board / Timeline beside the pane move too.
          recordTaskEdits(moves.map((m) => ({ type: "dates" as const, taskId: m.taskId, startOn: m.startOn, dueOn: m.dueOn })));
        },
        onPrompt: close,
        onResult: ({ moved }) => {
          if (moved.includes(task.id)) saveTyped();
        },
        projectId: task.memberships[0]?.projectId ?? null,
      },
    );
  }

  // Batch 45 (Isaiah, Nov 23): written on the task's clock, so the date stays the day shown (it used to be
  // the browser's clock, and stamping the browser's zone when the other time was set moved that one's date).
  function saveTime(kind: "start" | "due", hhmm: string | null, onDay?: string | null) {
    const day = onDay ?? (kind === "start" ? start : due);
    if (!day) return;
    run(() => updateTask(task.id, timeEditPatch(task, kind, day, hhmm, browserTimeZone())));
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
  const time = dueTime ? ` ${formatTime(dueTime)}${zoneLabel ? ` ${zoneLabel}` : ""}` : "";
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
          <DateRangePicker
            value={dates}
            allowStart={!milestone}
            onChange={(next, shouldClose, typed) => save(next, close, shouldClose, typed)}
          >
            <TimeRows
              start={milestone ? null : start}
              due={due}
              startTime={startTime}
              dueTime={dueTime}
              zoneLabel={zoneLabel}
              onChange={(kind, hhmm) => saveTime(kind, hhmm)}
            />
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
  zoneLabel = null,
  onChange,
}: {
  start: string | null;
  due: string | null;
  startTime: string | null;
  dueTime: string | null;
  // The task's zone when it isn't the viewer's (its times are shown and typed on its clock).
  zoneLabel?: string | null;
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
      {zoneLabel ? <p className="text-2xs text-zinc-500">Times are in {zoneLabel}, where they were set.</p> : null}
    </div>
  );
}
