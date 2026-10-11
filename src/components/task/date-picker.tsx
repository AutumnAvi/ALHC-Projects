"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useToday } from "@/lib/dates";
import {
  TIME_OPTIONS,
  WEEKDAY_LETTERS,
  formatTime,
  longDate,
  monthGrid,
  monthLabel,
  monthOf,
  nextWeekMonday,
  parseDateInput,
  parseTimeInput,
  shiftDays,
  shiftMonth,
  shortDate,
} from "@/lib/date-input";

// The task pane's date picker (Asana parity, batch 3): a month calendar with quick picks, an optional
// start date, and room below for time and Repeats. It replaces the browser's mm/dd/yyyy and time
// inputs everywhere in the pane. Days are plain calendar dates; the parent saves them.

function localToday() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The calendar only renders in the browser (inside a popover), so it can read today directly.
function useCalendarToday() {
  return useToday() ?? localToday();
}

export function QuickPicks({ onPick }: { onPick: (day: string) => void }) {
  const today = useCalendarToday();
  const picks = [
    { label: "Today", day: today },
    { label: "Tomorrow", day: shiftDays(today, 1) },
    { label: "Next week", day: nextWeekMonday(today) },
  ];
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick picks">
      {picks.map((p) => (
        <button
          key={p.label}
          type="button"
          onClick={() => onPick(p.day)}
          title={longDate(p.day)}
          className="h-6 rounded-full border border-zinc-200 px-2.5 text-xs text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50"
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

// A month of days (weeks start on Sunday, like the app's calendars). Arrow keys move between days,
// Page Up / Page Down between months, Enter or Space picks. The range between start and due is shaded.
export function MiniCalendar({
  start = null,
  due,
  onPick,
  autoFocus = false,
}: {
  start?: string | null;
  due: string | null;
  onPick: (day: string) => void;
  // Focus the selected day (else today) when it appears, so the keyboard can pick right away.
  autoFocus?: boolean;
}) {
  const today = useCalendarToday();
  const [month, setMonth] = useState(() => monthOf(due ?? start ?? today));
  const [focusDay, setFocusDay] = useState<string>(() => due ?? start ?? today);
  const gridRef = useRef<HTMLDivElement>(null);
  const moveFocus = useRef(autoFocus);
  const labelId = useId();
  const days = monthGrid(month);
  // The day that can be tabbed to: the focused one when it's in this month, else the 1st.
  const tabbable = monthOf(focusDay) === month ? focusDay : `${month}-01`;

  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${focusDay}"]`)?.focus();
  }, [focusDay, month]);

  function go(day: string) {
    moveFocus.current = true;
    setFocusDay(day);
    if (monthOf(day) !== month) setMonth(monthOf(day));
  }

  function onKey(e: KeyboardEvent<HTMLButtonElement>, day: string) {
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in steps) {
      e.preventDefault();
      go(shiftDays(day, steps[e.key]));
    } else if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      const target = shiftMonth(monthOf(day), e.key === "PageUp" ? -1 : 1);
      const dayOfMonth = Math.min(Number(day.slice(8)), 28);
      go(`${target}-${String(dayOfMonth).padStart(2, "0")}`);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
      go(shiftDays(day, e.key === "Home" ? -weekday : 6 - weekday));
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <span id={labelId} className="text-sm font-medium text-zinc-900" aria-live="polite">
          {monthLabel(month)}
        </span>
        <span className="flex items-center">
          <button
            type="button"
            onClick={() => setMonth(shiftMonth(month, -1))}
            aria-label="Previous month"
            className="btn-icon size-7"
          >
            <ChevronLeft className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => setMonth(shiftMonth(month, 1))}
            aria-label="Next month"
            className="btn-icon size-7"
          >
            <ChevronRight className="size-4" aria-hidden />
          </button>
        </span>
      </div>
      <div ref={gridRef} role="grid" aria-labelledby={labelId} className="mt-1.5">
        <div role="row" className="grid grid-cols-7">
          {WEEKDAY_LETTERS.map((letter, i) => (
            <span key={i} role="columnheader" className="flex h-7 items-center justify-center text-2xs font-medium text-zinc-500">
              <abbr title={["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][i]} className="no-underline">
                {letter}
              </abbr>
            </span>
          ))}
        </div>
        {Array.from({ length: 6 }, (_, week) => (
          <div key={week} role="row" className="grid grid-cols-7">
            {days.slice(week * 7, week * 7 + 7).map((day) => {
              const inMonth = monthOf(day) === month;
              const isDue = day === due;
              const isStart = day === start;
              const inRange = Boolean(start && due && day > start && day < due);
              const isToday = day === today;
              return (
                <span
                  key={day}
                  role="gridcell"
                  className={`relative flex h-8 items-center justify-center ${inRange ? "bg-accent-50" : ""}`}
                >
                  {/* The shaded range runs from the start's center to the due's center. */}
                  {isStart && due && due > day ? <span aria-hidden className="absolute inset-y-0 right-0 w-1/2 bg-accent-50" /> : null}
                  {isDue && start && start < day ? <span aria-hidden className="absolute inset-y-0 left-0 w-1/2 bg-accent-50" /> : null}
                  <button
                    type="button"
                    data-day={day}
                    tabIndex={day === tabbable ? 0 : -1}
                    aria-label={`${longDate(day)}${isToday ? ", today" : ""}${isDue ? ", due date" : ""}${isStart ? ", start date" : ""}`}
                    aria-pressed={isDue || isStart}
                    onClick={() => {
                      setFocusDay(day);
                      onPick(day);
                    }}
                    onKeyDown={(e) => onKey(e, day)}
                    className={`relative flex size-7 items-center justify-center rounded-full text-xs tabular-nums transition-colors ${
                      isDue || isStart
                        ? "bg-accent-500 font-semibold text-white hover:bg-accent-600"
                        : isToday
                          ? "font-semibold text-accent-700 ring-1 ring-inset ring-accent-500 hover:bg-accent-50"
                          : inMonth
                            ? "text-zinc-800 hover:bg-zinc-100"
                            : "text-zinc-400 hover:bg-zinc-100"
                    }`}
                  >
                    {Number(day.slice(8))}
                  </button>
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// A date box at the top of the picker: shows the date as 10/14/26 and takes typed dates (10/14,
// Oct 14, tomorrow…) on Enter or when it loses focus.
function DateBox({
  label,
  value,
  active,
  onActivate,
  onCommit,
  onClear,
  autoFocus = false,
}: {
  label: string;
  value: string | null;
  active: boolean;
  onActivate: () => void;
  onCommit: (day: string) => void;
  onClear?: () => void;
  autoFocus?: boolean;
}) {
  const today = useCalendarToday();
  const shown = value ? shortDate(value) : "";
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  function commit() {
    if (draft === null) return;
    const text = draft.trim();
    setDraft(null);
    if (!text || text === shown) return;
    const day = parseDateInput(text, today);
    if (day) {
      setInvalid(false);
      onCommit(day);
    } else {
      setInvalid(true);
    }
  }

  return (
    <label className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="text-2xs font-medium text-zinc-500">{label}</span>
      <div
        className={`group/box relative flex h-8 min-w-0 items-center rounded-md border bg-white ${
          invalid ? "border-red-300" : active ? "border-accent-500 shadow-[0_0_0_3px_var(--focus-ring)]" : "border-zinc-200"
        }`}
      >
        <input
          aria-label={`${label} (type a date like 10/14 or Oct 14)`}
          aria-invalid={invalid || undefined}
          autoFocus={autoFocus}
          placeholder="mm/dd/yy"
          value={draft ?? shown}
          onFocus={onActivate}
          onChange={(e) => {
            setInvalid(false);
            setDraft(e.currentTarget.value);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape" && draft !== null) {
              e.preventDefault();
              e.stopPropagation();
              setDraft(null);
              setInvalid(false);
            }
          }}
          className="h-full w-full min-w-0 rounded-md border-0 bg-transparent px-2 text-sm text-zinc-900 shadow-none outline-none placeholder:text-zinc-500 focus-visible:shadow-none"
        />
        {value && onClear ? (
          <button
            type="button"
            onClick={onClear}
            aria-label={`Clear ${label.toLowerCase()}`}
            className="mr-1 shrink-0 rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
    </label>
  );
}

export type DateRange = { start: string | null; due: string | null };

// Start and due date with a calendar. Picking a due date saves and closes (close: true); picking a start
// date saves and moves on to the due date (a due date before the new start moves to it; no due date stays
// none). allowStart = false for milestones (a due date only).
export function DateRangePicker({
  value,
  allowStart = true,
  onChange,
  children,
}: {
  value: DateRange;
  allowStart?: boolean;
  onChange: (next: DateRange, close: boolean) => void;
  // Extra sections under the calendar (time, Repeats).
  children?: ReactNode;
}) {
  const [showStart, setShowStart] = useState(allowStart && Boolean(value.start));
  const [active, setActive] = useState<"start" | "due">("due");
  const { start, due } = value;

  function pickDue(day: string) {
    onChange({ start: start && start <= day ? start : null, due: day }, true);
  }
  function pickStart(day: string) {
    onChange({ start: day, due: due && due < day ? day : due }, false);
    setActive("due");
  }
  const pick = (day: string) => (active === "start" && showStart ? pickStart(day) : pickDue(day));

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-end gap-2">
        {showStart ? (
          <DateBox
            label="Start date"
            value={start}
            active={active === "start"}
            autoFocus={!start}
            onActivate={() => setActive("start")}
            onCommit={pickStart}
            onClear={() => {
              onChange({ start: null, due }, false);
              setShowStart(false);
              setActive("due");
            }}
          />
        ) : null}
        <DateBox
          label="Due date"
          value={due}
          active={active === "due"}
          onActivate={() => setActive("due")}
          onCommit={pickDue}
          onClear={due ? () => onChange({ start, due: null }, false) : undefined}
        />
      </div>
      {allowStart && !showStart ? (
        <button
          type="button"
          onClick={() => {
            setShowStart(true);
            setActive("start");
          }}
          className="-mt-1.5 self-start rounded px-1 text-xs font-medium text-accent-700 hover:bg-accent-50"
        >
          + Add start date
        </button>
      ) : null}
      <QuickPicks onPick={pick} />
      {/* Focus starts on the due day (else today) unless the start box is waiting for a date. */}
      <MiniCalendar start={showStart ? start : null} due={due} onPick={pick} autoFocus={!(showStart && !start)} />
      {children}
      {start || due ? (
        <div className="flex justify-end border-t border-zinc-100 pt-2">
          <button type="button" onClick={() => onChange({ start: null, due: null }, true)} className="btn-ghost h-7 text-xs">
            Clear dates
          </button>
        </div>
      ) : null}
    </div>
  );
}

// One date (custom date fields): quick picks and a calendar; picking saves and closes.
export function SingleDatePicker({
  value,
  label,
  onChange,
}: {
  value: string | null;
  label: string;
  onChange: (next: string | null) => void;
}) {
  return (
    <div className="flex flex-col gap-3 p-3">
      <DateBox label={label} value={value} active onActivate={() => undefined} onCommit={onChange} />
      <QuickPicks onPick={onChange} />
      <MiniCalendar due={value} onPick={onChange} autoFocus />
      {value ? (
        <div className="flex justify-end border-t border-zinc-100 pt-2">
          <button type="button" onClick={() => onChange(null)} className="btn-ghost h-7 text-xs">
            Clear
          </button>
        </div>
      ) : null}
    </div>
  );
}

// A time box with a list of half hours under it; typing "9", "930", or "2:15 pm" works too. Commits on
// Enter, on picking from the list, or when it loses focus; Escape puts the saved time back.
export function TimeInput({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  // "HH:MM" on the viewer's clock, or null.
  value: string | null;
  onChange: (next: string | null) => void;
  disabled?: boolean;
}) {
  const listId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const shown = value ? formatTime(value) : "";
  // "9" lists 9:00 AM, 9:30 AM, 9:00 PM…; "9:3p" narrows to 9:30 PM; "21" matches 21:00 too.
  const squash = (text: string) => text.toLowerCase().replace(/\s|:00/g, "");
  const typed = squash(draft ?? "");
  const options = typed ? TIME_OPTIONS.filter((t) => squash(formatTime(t)).startsWith(typed) || t.startsWith(typed)) : TIME_OPTIONS;

  useEffect(() => {
    if (!open || draft !== null) return;
    // Show the saved time (or 9 AM) when the list opens.
    const target = listRef.current?.querySelector<HTMLElement>(`[data-time="${value ?? "09:00"}"]`);
    target?.scrollIntoView({ block: "center" });
  }, [open, draft, value]);

  function commit(text: string | null) {
    setOpen(false);
    setDraft(null);
    if (text === null) return;
    const trimmed = text.trim();
    if (!trimmed) {
      if (value) onChange(null);
      return;
    }
    const parsed = parseTimeInput(trimmed);
    if (parsed && parsed !== value) onChange(parsed);
  }

  return (
    <div className="relative min-w-0 flex-1">
      <input
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        disabled={disabled}
        placeholder={disabled ? "Set a date first" : "Add time"}
        value={draft ?? shown}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setDraft(e.currentTarget.value);
          setOpen(true);
        }}
        onBlur={() => commit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(draft ?? shown);
          } else if (e.key === "Escape" && (open || draft !== null)) {
            e.preventDefault();
            e.stopPropagation();
            setDraft(null);
            setOpen(false);
          }
        }}
        className="control h-8 w-full"
      />
      {open ? (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={`${label} options`}
          className="absolute inset-x-0 top-full z-10 mt-1 max-h-40 overflow-y-auto rounded-md border border-zinc-200 bg-white py-1 shadow-lg"
        >
          {options.length === 0 ? (
            <li className="px-2 py-1 text-xs text-zinc-500">Press Enter to use “{draft}”</li>
          ) : (
            options.map((t) => (
              <li
                key={t}
                role="option"
                data-time={t}
                aria-selected={t === value}
                // mousedown: pick before the input's blur commits the typed text.
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(formatTime(t));
                }}
                className="cursor-pointer px-2 py-1 text-sm text-zinc-700 hover:bg-zinc-100 aria-selected:bg-accent-50 aria-selected:font-medium aria-selected:text-accent-800"
              >
                {formatTime(t)}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
