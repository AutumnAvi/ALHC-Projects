"use client";

import Link from "next/link";
import { useState, type DragEvent } from "react";
import { CalendarDays } from "lucide-react";
import { Popover } from "@/components/popover";
import { DateRangePicker } from "@/components/task/date-picker";
import { addDays } from "@/lib/dates";
import { longDate } from "@/lib/date-input";

// The month / week grid shared by the project Calendar and the team Calendar (Real features 4). A task is
// a bar from its start date (else its due date) through its due date, split at week ends, stacked in
// lanes. People who can edit a task drag it to another day (start and due move together, so the span is
// kept), drag its left or right end to change the start or due date, or open the calendar button on the
// bar (keyboard: Tab to it, Enter) for the date picker. Others see the same bars without any of that.
// The parent saves through the task pane's path (useDependencyShift → updateTask / the shift RPCs) and
// shows the move optimistically; a refused change rolls back with the error toast.

export const CALENDAR_DRAG_TYPE = "application/x-alhc-task";
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Month view: bars per week before "+N more".
const MONTH_LANES = 3;

export type CalendarItem = {
  id: string;
  title: string;
  // On or before dueOn; null for a one-day task.
  startOn: string | null;
  dueOn: string;
  completed: boolean;
  milestone: boolean;
  overdue: boolean;
  canEdit: boolean;
  // The task open in the pane.
  open?: boolean;
  href: string;
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

type Segment = {
  item: CalendarItem;
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

function layoutWeek(week: string[], items: CalendarItem[], primaryWeek: Map<string, string>): Segment[] {
  const weekStart = week[0];
  const weekEnd = week[6];
  const inWeek = items
    .filter((item) => spanStart(item) <= weekEnd && item.dueOn >= weekStart)
    .map((item) => {
      const from = spanStart(item) < weekStart ? weekStart : spanStart(item);
      const to = item.dueOn > weekEnd ? weekEnd : item.dueOn;
      return { item, col: between(weekStart, from), span: between(from, to) + 1 };
    })
    .sort(
      (a, b) =>
        a.col - b.col ||
        b.span - a.span ||
        Number(a.item.completed) - Number(b.item.completed) ||
        a.item.title.localeCompare(b.item.title),
    );
  const laneEnds: number[] = [];
  return inWeek.map(({ item, col, span }) => {
    let lane = laneEnds.findIndex((end) => end < col);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = col + span - 1;
    return {
      item,
      col,
      span,
      lane,
      startsHere: spanStart(item) >= weekStart,
      endsHere: item.dueOn <= weekEnd,
      primary: primaryWeek.get(item.id) === weekStart,
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
  drag,
  onDragChange,
  onChange,
  onDropExternal,
  label,
  tall = false,
}: {
  // Whole weeks, Sunday first.
  days: string[];
  // "YYYY-MM": days outside it are shaded (month view); null in week view.
  month: string | null;
  today: string | null;
  items: CalendarItem[];
  drag: CalendarDrag | null;
  onDragChange: (drag: CalendarDrag | null) => void;
  onChange: (item: CalendarItem, dates: CalendarDates) => void;
  // A task dragged in from outside the grid dropped on a day.
  onDropExternal?: (taskId: string, day: string) => void;
  label: string;
  // Week view: one tall week, every bar shown.
  tall?: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<string | null>(null);
  const weeks: string[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  const byId = new Map(items.map((item) => [item.id, item] as const));

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
          const segments = layoutWeek(week, items, primaryWeek);
          const open = tall || expanded.has(week[0]);
          const lanes = Math.max(0, ...segments.map((s) => s.lane + 1));
          const visibleLanes = open ? lanes : Math.min(lanes, MONTH_LANES);
          const hidden = week.map((_, col) =>
            segments.filter((s) => s.lane >= visibleLanes && s.col <= col && col < s.col + s.span).length,
          );
          return (
            <div
              key={week[0]}
              data-week
              role="group"
              aria-label={`Week of ${longDate(week[0])}`}
              className={`relative flex-1 ${tall ? "min-h-[16rem]" : "min-h-[7rem]"}`}
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
                  .map((s) => (
                    <Bar
                      key={s.item.id}
                      segment={s}
                      dragging={drag?.id === s.item.id}
                      onDragStart={(e, mode) => {
                        if (mode === "move") {
                          const day = dayAt(e.clientX, e.currentTarget.closest("[data-week]"), week);
                          startDrag(e, { id: s.item.id, mode, offset: between(spanStart(s.item), day) });
                        } else {
                          startDrag(e, { id: s.item.id, mode });
                        }
                      }}
                      onDragEnd={endDrag}
                      onChange={onChange}
                    />
                  ))}
                {!open
                  ? hidden.map((count, col) =>
                      count > 0 ? (
                        <button
                          key={week[col]}
                          type="button"
                          onClick={() => setExpanded((current) => new Set(current).add(week[0]))}
                          aria-label={`Show ${count} more ${count === 1 ? "task" : "tasks"} the week of ${longDate(week[0])}`}
                          className="mx-1 self-start justify-self-start rounded px-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
                          style={{ gridColumn: `${col + 1} / span 1`, gridRow: visibleLanes + 1 }}
                        >
                          +{count} more
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
  dragging,
  onDragStart,
  onDragEnd,
  onChange,
}: {
  segment: Segment;
  dragging: boolean;
  onDragStart: (e: DragEvent<HTMLElement>, mode: "move" | "start" | "end") => void;
  onDragEnd: () => void;
  onChange: (item: CalendarItem, dates: CalendarDates) => void;
}) {
  const { item, col, span, lane, startsHere, endsHere, primary } = segment;
  const resizable = item.canEdit && !item.milestone;
  const shape = `${startsHere ? "rounded-l-md" : "rounded-l-none border-l-0"} ${endsHere ? "rounded-r-md" : "rounded-r-none border-r-0"}`;
  return (
    <div
      className={`group/bar relative min-w-0 ${startsHere ? "pl-1" : ""} ${endsHere ? "pr-1" : ""}`}
      style={{ gridColumn: `${col + 1} / span ${span}`, gridRow: lane + 1 }}
    >
      <Link
        href={item.href}
        scroll={false}
        draggable={item.canEdit}
        onDragStart={item.canEdit ? (e) => onDragStart(e, "move") : undefined}
        onDragEnd={item.canEdit ? onDragEnd : undefined}
        data-tooltip={item.tooltip}
        aria-current={item.open ? "true" : undefined}
        className={`flex h-6 min-w-0 items-center gap-1.5 border bg-white px-1.5 text-xs shadow-xs hover:border-zinc-300 ${shape} ${
          item.open ? "border-accent-500 ring-2 ring-accent-100" : item.overdue ? "border-red-200" : "border-zinc-200"
        } ${item.canEdit ? "cursor-grab active:cursor-grabbing" : ""} ${dragging ? "opacity-40" : ""} ${
          primary && item.canEdit ? "pr-6" : ""
        }`}
      >
        <span aria-hidden className={`size-2 shrink-0 ${item.milestone ? "rotate-45 rounded-[1px]" : "rounded-full"} ${item.dotClass}`} />
        <span
          className={`min-w-0 flex-1 truncate ${
            item.completed ? "text-zinc-400 line-through" : item.overdue ? "text-red-700" : "text-zinc-800"
          }`}
        >
          {item.title}
          <span className="sr-only">
            {`, ${spanText(item)}`}
            {item.srDetail ?? ""}
            {item.milestone ? " (milestone)" : ""}
            {item.completed ? " (completed)" : ""}
            {item.overdue ? " (overdue)" : ""}
          </span>
        </span>
      </Link>
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
        label={`Change the dates of ${item.title} (${spanText(item)})`}
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
