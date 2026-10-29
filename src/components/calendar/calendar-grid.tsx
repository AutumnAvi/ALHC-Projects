"use client";

import { useState, type DragEvent } from "react";
import { CalendarClock, CalendarDays } from "lucide-react";
import { Popover } from "@/components/popover";
import { DateRangePicker } from "@/components/task/date-picker";
import { TaskLink } from "@/components/task/task-link";
import { TaskNumberBadge, taskNumberText } from "@/components/task/task-number";
import { compareEvents, eventAriaLabel, eventBarTime, eventShortWhen, moreLabel, type CalendarEvent } from "@/lib/calendar-events";
import { displayTaskTitle, moreTaskNumbers, type RequestLabel, type TaskNumber } from "@/lib/request-numbers";
import type { TaskSeed } from "@/lib/task-seed";
import { addDays } from "@/lib/dates";
import { longDate } from "@/lib/date-input";

// The month / week grid shared by the project Calendar and the team Calendar (Real features 4). A task is
// a bar from its start date (else its due date) through its due date, split at week ends, stacked in
// lanes. People who can edit a task drag it to another day (start and due move together, so the span is
// kept), drag its left or right end to change the start or due date, or open the calendar button on the
// bar (keyboard: Tab to it, Enter) for the date picker. Others see the same bars without any of that.
// The parent saves through the task pane's path (useDependencyShift → updateTask / the shift RPCs) and
// shows the move optimistically; a refused change rolls back with the error toast.
// Since Oct 26 notes (batch 4) the grid also draws calendar events (not tasks) in the same lanes: a violet
// bar with a calendar icon instead of the task dot and the start time in front when it has one, never
// struck through and never dragged (an event changes in its dialog). A click (or Enter) on one calls
// onOpenEvent; a double-click on an empty part of a day calls onAddEvent with that day. A task's number
// is drawn tiny after its name, so the start of the name always shows.

export const CALENDAR_DRAG_TYPE = "application/x-alhc-task";
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Month view: bars per week before "+N more".
const MONTH_LANES = 3;

export type CalendarItem = {
  id: string;
  // The bare name: the number isn't in front of it (see label).
  title: string;
  // The task's number when its project numbers tasks (drawn tiny after the name), and the project's name
  // when the task comes from another project than the one on screen (the team Calendar: always).
  label?: RequestLabel | null;
  projectName?: string | null;
  // Calendars that mix projects (the team Calendar; Oct 29 notes, 55b): every number the viewer can read,
  // in the stable order. The bar shows the first and "+N"; its tooltip and screen-reader text list them all.
  numbers?: TaskNumber[] | null;
  // On or before dueOn; null for a one-day task.
  startOn: string | null;
  dueOn: string;
  completed: boolean;
  milestone: boolean;
  overdue: boolean;
  canEdit: boolean;
  // The task open in the pane.
  open?: boolean;
  // What the bar knows about the task: the pane draws it at once when the bar is clicked (no navigation).
  seed?: () => TaskSeed;
  // The dot's color class.
  dotClass: string;
  // Read after the title by screen readers (e.g. " in Marketing").
  srDetail?: string;
  tooltip?: string;
};

export type CalendarDates = { startOn: string | null; dueOn: string | null };

// What is being dragged: a bar's body (move; offset = the day grabbed, counted from its first day), one
// of its ends, or a task from outside the grid (the No due date tray).
export type CalendarDrag =
  | { id: string; mode: "move"; offset: number }
  | { id: string; mode: "start" | "end" }
  | { id: string; mode: "external" };

const dayIndex = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
const between = (from: string, to: string) => dayIndex(to) - dayIndex(from);
const spanStart = (item: Pick<CalendarItem, "startOn" | "dueOn">) => item.startOn ?? item.dueOn;

// "[Task #3] Logo" (or "Task #3 Logo"): the name with its number, for tooltips and screen readers.
export function fullTaskTitle(item: Pick<CalendarItem, "title" | "label">) {
  return displayTaskTitle(item.title, item.label ?? null);
}

// The dates a drop on `day` gives. Ends never cross; a start that lands on the due date is dropped (a
// one-day task). Milestones only move.
export function droppedDates(item: CalendarItem, drag: CalendarDrag, day: string): CalendarDates | null {
  const first = spanStart(item);
  let startOn = item.startOn;
  let dueOn = item.dueOn;
  if (drag.mode === "move") {
    const delta = between(first, day) - drag.offset;
    if (delta === 0) return null;
    startOn = item.startOn ? addDays(item.startOn, delta) : null;
    dueOn = addDays(item.dueOn, delta);
  } else if (drag.mode === "start" && !item.milestone) {
    startOn = day < item.dueOn ? day : null;
  } else if (drag.mode === "end" && !item.milestone) {
    if (day > first) {
      startOn = first;
      dueOn = day;
    } else {
      startOn = null;
      dueOn = first;
    }
  } else {
    return null;
  }
  if (startOn === dueOn) startOn = null;
  if (startOn === item.startOn && dueOn === item.dueOn) return null;
  return { startOn, dueOn };
}

// One bar's worth of whatever the grid draws: a task (its start, else due, date through its due date)
// or an event (its first through last day).
type Entry =
  | { kind: "task"; id: string; first: string; last: string; item: CalendarItem }
  | { kind: "event"; id: string; first: string; last: string; event: CalendarEvent };

type Segment = {
  entry: Entry;
  col: number;
  span: number;
  lane: number;
  // The bar's real first / last day is in this week (its ends can be dragged here).
  startsHere: boolean;
  endsHere: boolean;
  // The one segment per task that carries the date picker button (where its due date is, else the
  // last visible week it reaches).
  primary: boolean;
};

const entryTitle = (entry: Entry) => (entry.kind === "task" ? entry.item.title : entry.event.title);

function byOrder(a: { entry: Entry; col: number; span: number }, b: { entry: Entry; col: number; span: number }) {
  if (a.col !== b.col) return a.col - b.col;
  if (a.span !== b.span) return b.span - a.span;
  // On the same first day: events before tasks (all-day before timed), open tasks before completed ones.
  if (a.entry.kind !== b.entry.kind) return a.entry.kind === "event" ? -1 : 1;
  if (a.entry.kind === "event" && b.entry.kind === "event") return compareEvents(a.entry.event, b.entry.event);
  if (a.entry.kind === "task" && b.entry.kind === "task" && a.entry.item.completed !== b.entry.item.completed) {
    return a.entry.item.completed ? 1 : -1;
  }
  return entryTitle(a.entry).localeCompare(entryTitle(b.entry));
}

// Tasks and events share the week's lanes.
function layoutWeek(week: string[], entries: Entry[], primaryWeek: Map<string, string>): Segment[] {
  const weekStart = week[0];
  const weekEnd = week[6];
  const inWeek = entries
    .filter((entry) => entry.first <= weekEnd && entry.last >= weekStart)
    .map((entry) => {
      const from = entry.first < weekStart ? weekStart : entry.first;
      const to = entry.last > weekEnd ? weekEnd : entry.last;
      return { entry, col: between(weekStart, from), span: between(from, to) + 1 };
    })
    .sort(byOrder);
  const laneEnds: number[] = [];
  return inWeek.map(({ entry, col, span }) => {
    let lane = laneEnds.findIndex((end) => end < col);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = col + span - 1;
    return {
      entry,
      col,
      span,
      lane,
      startsHere: entry.first >= weekStart,
      endsHere: entry.last <= weekEnd,
      primary: entry.kind === "task" && primaryWeek.get(entry.id) === weekStart,
    };
  });
}

function spanText(item: Pick<CalendarItem, "startOn" | "dueOn">) {
  return item.startOn ? `${longDate(item.startOn)} to ${longDate(item.dueOn)}` : `due ${longDate(item.dueOn)}`;
}

export function CalendarGrid({
  days,
  month,
  today,
  items,
  events = [],
  drag,
  onDragChange,
  onChange,
  onDropExternal,
  onOpenEvent,
  onAddEvent,
  label,
  tall = false,
}: {
  // Whole weeks, Sunday first.
  days: string[];
  // "YYYY-MM": days outside it are shaded (month view); null in week view.
  month: string | null;
  today: string | null;
  items: CalendarItem[];
  // Calendar events (not tasks) to draw next to the tasks.
  events?: CalendarEvent[];
  drag: CalendarDrag | null;
  onDragChange: (drag: CalendarDrag | null) => void;
  onChange: (item: CalendarItem, dates: CalendarDates) => void;
  // A task dragged in from outside the grid dropped on a day.
  onDropExternal?: (taskId: string, day: string) => void;
  // An event bar was clicked: open its dialog.
  onOpenEvent?: (event: CalendarEvent) => void;
  // A double-click on an empty part of a day (people who can add events only).
  onAddEvent?: (day: string) => void;
  label: string;
  // Week view: one tall week, every bar shown.
  tall?: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<string | null>(null);
  const weeks: string[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  const byId = new Map(items.map((item) => [item.id, item] as const));
  const year = today ? Number(today.slice(0, 4)) : undefined;
  const entries: Entry[] = [
    ...items.map((item): Entry => ({ kind: "task", id: item.id, first: spanStart(item), last: item.dueOn, item })),
    ...events.map((event): Entry => ({ kind: "event", id: event.id, first: event.startOn, last: event.endOn, event })),
  ];

  // Where each task's date button goes: the week of its due date, else the last visible week it reaches.
  const primaryWeek = new Map<string, string>();
  for (const week of weeks) {
    for (const item of items) {
      if (spanStart(item) <= week[6] && item.dueOn >= week[0]) primaryWeek.set(item.id, week[0]);
    }
  }

  // The days the dragged task would cover if dropped on the day under the pointer.
  const preview = new Set<string>();
  if (drag && target) {
    const item = byId.get(drag.id);
    const dates = item && drag.mode !== "external" ? droppedDates(item, drag, target) : null;
    if (drag.mode === "external" || !item) {
      preview.add(target);
    } else if (dates?.dueOn) {
      for (let d = dates.startOn ?? dates.dueOn; d <= dates.dueOn; d = addDays(d, 1)) preview.add(d);
    } else {
      for (let d = spanStart(item); d <= item.dueOn; d = addDays(d, 1)) preview.add(d);
    }
  }

  // The day under the pointer, from its position across the week's row.
  function dayAt(clientX: number, row: Element | null, week: string[]) {
    const rect = row?.getBoundingClientRect();
    if (!rect || rect.width === 0) return week[0];
    const col = Math.min(6, Math.max(0, Math.floor(((clientX - rect.left) / rect.width) * 7)));
    return week[col];
  }

  function startDrag(e: DragEvent<HTMLElement>, next: CalendarDrag) {
    e.stopPropagation();
    e.dataTransfer.setData(CALENDAR_DRAG_TYPE, next.id);
    e.dataTransfer.effectAllowed = "move";
    onDragChange(next);
  }

  function endDrag() {
    onDragChange(null);
    setTarget(null);
  }

  return (
    <div
      role="group"
      aria-label={label}
      className="flex min-h-0 flex-1 flex-col"
      onDragLeave={(e) => {
        // Off the grid (e.g. onto the No due date tray): no preview.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setTarget(null);
      }}
    >
      <div
        aria-hidden
        className="grid grid-cols-7 rounded-t-lg border border-b-0 border-zinc-200 bg-zinc-50 py-1 text-xs font-medium text-zinc-500"
      >
        {WEEKDAYS.map((d) => (
          <span key={d} className="px-2">
            {d}
          </span>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col border-l border-zinc-200">
        {weeks.map((week) => {
          const segments = layoutWeek(week, entries, primaryWeek);
          const open = tall || expanded.has(week[0]);
          const lanes = Math.max(0, ...segments.map((s) => s.lane + 1));
          const visibleLanes = open ? lanes : Math.min(lanes, MONTH_LANES);
          const hidden = week.map((_, col) => {
            const over = segments.filter((s) => s.lane >= visibleLanes && s.col <= col && col < s.col + s.span);
            return { tasks: over.filter((s) => s.entry.kind === "task").length, events: over.filter((s) => s.entry.kind === "event").length };
          });
          return (
            <div
              key={week[0]}
              data-week
              role="group"
              aria-label={`Week of ${longDate(week[0])}`}
              className={`relative flex-1 ${tall ? "min-h-[16rem]" : "min-h-[7rem]"}`}
              onDoubleClick={
                onAddEvent
                  ? (e) => {
                      // Only an empty part of the day: bars and buttons keep their own clicks.
                      if ((e.target as Element).closest("a, button, [draggable='true']")) return;
                      onAddEvent(dayAt(e.clientX, e.currentTarget, week));
                    }
                  : undefined
              }
              onDragOver={(e) => {
                if (!drag) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const day = dayAt(e.clientX, e.currentTarget, week);
                if (day !== target) setTarget(day);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const current = drag;
                const day = dayAt(e.clientX, e.currentTarget, week);
                endDrag();
                if (!current) return;
                if (current.mode === "external") {
                  onDropExternal?.(current.id, day);
                  return;
                }
                const item = byId.get(current.id);
                const dates = item ? droppedDates(item, current, day) : null;
                if (item && dates) onChange(item, dates);
              }}
            >
              <div aria-hidden className="absolute inset-0 grid grid-cols-7">
                {week.map((day) => {
                  const outside = month !== null && !day.startsWith(month);
                  return (
                    <div
                      key={day}
                      className={`border-r border-b border-zinc-200 p-1.5 ${
                        preview.has(day) ? "bg-accent-50" : outside ? "bg-zinc-50/70" : "bg-white"
                      }`}
                    >
                      <span
                        className={`flex size-6 items-center justify-center rounded-full text-xs tabular-nums ${
                          day === today ? "bg-accent-600 font-semibold text-white" : outside ? "text-zinc-400" : "text-zinc-600"
                        }`}
                      >
                        {Number(day.slice(8))}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className="relative grid grid-cols-7 gap-y-0.5 pt-9 pb-1.5" style={{ gridAutoRows: "1.5rem" }}>
                {segments
                  .filter((s) => s.lane < visibleLanes)
                  .map((s) =>
                    s.entry.kind === "event" ? (
                      <EventBar
                        key={`event-${s.entry.id}`}
                        segment={s}
                        event={s.entry.event}
                        year={year}
                        onOpen={onOpenEvent}
                      />
                    ) : (
                      <Bar
                        key={s.entry.id}
                        segment={s}
                        item={s.entry.item}
                        dragging={drag?.id === s.entry.id}
                        onDragStart={(e, mode) => {
                          const item = (s.entry as Extract<Entry, { kind: "task" }>).item;
                          if (mode === "move") {
                            const day = dayAt(e.clientX, e.currentTarget.closest("[data-week]"), week);
                            startDrag(e, { id: item.id, mode, offset: between(spanStart(item), day) });
                          } else {
                            startDrag(e, { id: item.id, mode });
                          }
                        }}
                        onDragEnd={endDrag}
                        onChange={onChange}
                      />
                    ),
                  )}
                {!open
                  ? hidden.map((count, col) =>
                      count.tasks + count.events > 0 ? (
                        <button
                          key={week[col]}
                          type="button"
                          onClick={() => setExpanded((current) => new Set(current).add(week[0]))}
                          aria-label={`Show ${moreLabel(count.tasks, count.events)} the week of ${longDate(week[0])}`}
                          className="mx-1 self-start justify-self-start rounded px-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
                          style={{ gridColumn: `${col + 1} / span 1`, gridRow: visibleLanes + 1 }}
                        >
                          +{count.tasks + count.events} more
                        </button>
                      ) : null,
                    )
                  : null}
                {open && !tall && lanes > MONTH_LANES ? (
                  <button
                    type="button"
                    onClick={() =>
                      setExpanded((current) => {
                        const next = new Set(current);
                        next.delete(week[0]);
                        return next;
                      })
                    }
                    className="mx-1 self-start justify-self-start rounded px-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
                    style={{ gridColumn: "1 / span 1", gridRow: lanes + 1 }}
                  >
                    Show less
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Bar({
  segment,
  item,
  dragging,
  onDragStart,
  onDragEnd,
  onChange,
}: {
  segment: Segment;
  item: CalendarItem;
  dragging: boolean;
  onDragStart: (e: DragEvent<HTMLElement>, mode: "move" | "start" | "end") => void;
  onDragEnd: () => void;
  onChange: (item: CalendarItem, dates: CalendarDates) => void;
}) {
  const { col, span, lane, startsHere, endsHere, primary } = segment;
  const resizable = item.canEdit && !item.milestone;
  const shape = `${startsHere ? "rounded-l-md" : "rounded-l-none border-l-0"} ${endsHere ? "rounded-r-md" : "rounded-r-none border-r-0"}`;
  const numbered = Boolean(item.label?.text.trim()) || Boolean(item.projectName);
  const others = moreTaskNumbers(item.numbers);
  const tooltip = item.tooltip ?? fullTaskTitle(item);
  return (
    <div
      className={`group/bar relative min-w-0 ${startsHere ? "pl-1" : ""} ${endsHere ? "pr-1" : ""}`}
      style={{ gridColumn: `${col + 1} / span ${span}`, gridRow: lane + 1 }}
    >
      <TaskLink
        taskId={item.id}
        seed={item.seed}
        draggable={item.canEdit}
        onDragStart={item.canEdit ? (e) => onDragStart(e, "move") : undefined}
        onDragEnd={item.canEdit ? onDragEnd : undefined}
        data-tooltip={others ? `${tooltip}\n${others.list}` : tooltip}
        data-calendar-task=""
        aria-current={item.open ? "true" : undefined}
        className={`flex h-6 min-w-0 items-center gap-1.5 border bg-white px-1.5 text-xs shadow-xs hover:border-zinc-300 ${shape} ${
          item.open ? "border-accent-500 ring-2 ring-accent-100" : item.overdue ? "border-red-200" : "border-zinc-200"
        } ${item.canEdit ? "cursor-grab active:cursor-grabbing" : ""} ${dragging ? "opacity-40" : ""} ${
          primary && item.canEdit ? "pr-6" : ""
        }`}
      >
        <span aria-hidden className={`size-2 shrink-0 ${item.milestone ? "rotate-45 rounded-[1px]" : "rounded-full"} ${item.dotClass}`} />
        <span className="min-w-0 flex-1 truncate">
          {/* The name first, then its number, tiny: a narrow bar cuts the number, never the name's start. */}
          <span
            aria-hidden={numbered ? true : undefined}
            className={item.completed ? "text-zinc-400 line-through" : item.overdue ? "text-red-700" : "text-zinc-800"}
          >
            {item.title}
          </span>
          {numbered ? (
            <span aria-hidden>
              {" "}
              <TaskNumberBadge
                label={item.label}
                numbers={item.numbers}
                more="inline-quiet"
                projectName={item.projectName ?? null}
                size="2xs"
                className="align-middle"
              />
            </span>
          ) : null}
          <span className="sr-only">
            {numbered ? fullTaskTitle(item) : ""}
            {others ? `, also ${others.spoken}` : ""}
            {numbered && item.projectName && !item.srDetail ? `, ${taskNumberText(null, item.projectName)}` : ""}
            {`, ${spanText(item)}`}
            {item.srDetail ?? ""}
            {item.milestone ? " (milestone)" : ""}
            {item.completed ? " (completed)" : ""}
            {item.overdue ? " (overdue)" : ""}
          </span>
        </span>
      </TaskLink>
      {resizable && startsHere ? (
        <span
          aria-hidden
          draggable
          onDragStart={(e) => onDragStart(e, "start")}
          onDragEnd={onDragEnd}
          data-tooltip="Drag to change the start date"
          className="absolute inset-y-0 left-1 w-1.5 cursor-ew-resize rounded-l-md group-hover/bar:bg-zinc-900/10"
        />
      ) : null}
      {resizable && endsHere ? (
        <span
          aria-hidden
          draggable
          onDragStart={(e) => onDragStart(e, "end")}
          onDragEnd={onDragEnd}
          data-tooltip="Drag to change the due date"
          className="absolute inset-y-0 right-1 w-1.5 cursor-ew-resize rounded-r-md group-hover/bar:bg-zinc-900/10"
        />
      ) : null}
      {item.canEdit && primary ? <DatesButton item={item} onChange={onChange} inset={endsHere} /> : null}
    </div>
  );
}

// A calendar event: violet, a calendar icon instead of the dot, the start time in front on the day it
// starts. A button (Enter / click opens its dialog); never draggable, never struck through.
function EventBar({
  segment,
  event,
  year,
  onOpen,
}: {
  segment: Segment;
  event: CalendarEvent;
  year: number | undefined;
  onOpen?: (event: CalendarEvent) => void;
}) {
  const { col, span, lane, startsHere, endsHere } = segment;
  const shape = `${startsHere ? "rounded-l-md" : "rounded-l-none border-l-0"} ${endsHere ? "rounded-r-md" : "rounded-r-none border-r-0"}`;
  const time = startsHere ? eventBarTime(event) : null;
  const Icon = event.startAt ? CalendarClock : CalendarDays;
  return (
    <div
      className={`relative min-w-0 ${startsHere ? "pl-1" : ""} ${endsHere ? "pr-1" : ""}`}
      style={{ gridColumn: `${col + 1} / span ${span}`, gridRow: lane + 1 }}
    >
      <button
        type="button"
        data-calendar-event={event.id}
        draggable={false}
        onClick={() => onOpen?.(event)}
        aria-label={eventAriaLabel(event, year)}
        data-tooltip={`${event.title} · ${eventShortWhen(event, year)}`}
        className={`flex h-6 w-full min-w-0 items-center gap-1 border border-violet-200 bg-violet-50 px-1.5 text-left text-xs text-violet-900 hover:border-violet-300 hover:bg-violet-100 ${shape}`}
      >
        <Icon aria-hidden className="size-3 shrink-0 text-violet-500" />
        <span className="min-w-0 flex-1 truncate">
          {time ? <span className="mr-1 font-medium tabular-nums">{time}</span> : null}
          {event.title}
        </span>
      </button>
    </div>
  );
}

// The keyboard path (and the touch-screen one): the task's start and due dates in the date picker.
function DatesButton({
  item,
  onChange,
  inset,
}: {
  item: CalendarItem;
  onChange: (item: CalendarItem, dates: CalendarDates) => void;
  inset: boolean;
}) {
  return (
    <div
      className={`absolute top-0.5 ${inset ? "right-2.5" : "right-1"} opacity-0 group-hover/bar:opacity-100 has-focus-visible:opacity-100 has-[[aria-expanded=true]]:opacity-100 [@media(hover:none)]:opacity-100`}
    >
      <Popover
        label={`Change the dates of ${fullTaskTitle(item)} (${spanText(item)})`}
        tooltip="Change dates"
        panelClassName="w-[19rem] p-0"
        buttonClassName="flex size-5 items-center justify-center rounded bg-white/90 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
        button={<CalendarDays className="size-3.5" aria-hidden />}
      >
        {(close) => (
          <DateRangePicker
            value={{ start: item.startOn, due: item.dueOn }}
            allowStart={!item.milestone}
            onChange={(next, shouldClose) => {
              if (shouldClose) close();
              const startOn = item.milestone ? null : next.start;
              if (startOn === item.startOn && next.due === item.dueOn) return;
              // Clearing the due date takes the task off the calendar (as in the task pane).
              onChange(item, { startOn, dueOn: next.due });
            }}
          />
        )}
      </Popover>
    </div>
  );
}

// The days a calendar shows: whole weeks, Sunday first.
export function calendarWeeks(first: string, last: string): string[] {
  const start = addDays(first, -new Date(`${first}T00:00:00Z`).getUTCDay());
  const end = addDays(last, 6 - new Date(`${last}T00:00:00Z`).getUTCDay());
  const days: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  return days;
}
