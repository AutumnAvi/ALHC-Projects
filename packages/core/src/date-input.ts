// Date and time helpers for the task pane's date picker (Asana parity, batch 3). Dates are plain
// calendar days ("YYYY-MM-DD", like tasks.due_on); times are "HH:MM" on the viewer's clock. Pure
// functions with no "use client", so server components can use them too (src/lib/dates.ts is
// client-only).

import { localDayOf, localTimeOf, zonedInstant } from "./calendar-events";

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const WEEKDAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const pad = (n: number) => String(n).padStart(2, "0");

export function isoDate(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  if (year < 1900 || year > 2999) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function parts(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
}

export function shiftDays(value: string, days: number) {
  const { year, month, day } = parts(value);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function weekdayOf(value: string) {
  const { year, month, day } = parts(value);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

// "Next week" = the Monday after this week (weeks start on Sunday, like the app's calendars).
export function nextWeekMonday(today: string) {
  return shiftDays(today, 8 - weekdayOf(today));
}

// "Tuesday, October 14, 2026" (calendar day buttons' accessible names).
export function longDate(value: string) {
  const { year, month, day } = parts(value);
  const name = MONTH_NAMES[month - 1];
  return `${WEEKDAY_NAMES[weekdayOf(value)]}, ${name[0].toUpperCase()}${name.slice(1)} ${day}, ${year}`;
}

// "10/14/26": what the picker's date boxes show (Asana's short date).
export function shortDate(value: string) {
  const { year, month, day } = parts(value);
  return `${month}/${day}/${String(year).slice(2)}`;
}

export function monthLabel(month: string) {
  const [year, m] = month.split("-").map(Number);
  const name = MONTH_NAMES[m - 1];
  return `${name[0].toUpperCase()}${name.slice(1)} ${year}`;
}

export function monthOf(value: string) {
  return value.slice(0, 7);
}

export function shiftMonth(month: string, delta: number) {
  const [year, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(year, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

// Days the project Calendar shows. Month: Sunday on or before the 1st through Saturday on or
// after the last day. Week: the Sunday-to-Saturday week that contains the anchor. Same rules as
// the grid, so the server can load only that window.
export type CalendarMode = "month" | "week";

// The Timeline's visible scale. Week: 6 weeks from the Sunday before the anchor's week.
// Month: 4 months from the anchor's month. Quarter: 4 quarters. End is inclusive.
// timeline-scale.ts visibleWindow uses this so the page loads the same days the grid draws.
export type TimelineZoom = "week" | "month" | "quarter";

export function timelineWindow(anchor: string, zoom: TimelineZoom): { start: string; end: string } {
  if (zoom === "week") {
    const start = shiftDays(anchor, -weekdayOf(anchor) - 7);
    return { start, end: shiftDays(start, 41) };
  }
  const start = zoom === "month" ? `${anchor.slice(0, 7)}-01` : quarterStart(anchor);
  const endExclusive = shiftDateByMonths(start, zoom === "month" ? 4 : 12);
  return { start, end: shiftDays(endExclusive, -1) };
}

function quarterStart(date: string) {
  const month = Number(date.slice(5, 7));
  return `${date.slice(0, 4)}-${pad(month - ((month - 1) % 3))}-01`;
}

function shiftDateByMonths(date: string, delta: number) {
  const [year, month] = date.split("-").map(Number);
  const total = year * 12 + (month - 1) + delta;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}-01`;
}

export function calendarVisibleDays(anchor: string, mode: CalendarMode): string[] {
  if (mode === "week") {
    const start = shiftDays(anchor, -weekdayOf(anchor));
    return Array.from({ length: 7 }, (_, index) => shiftDays(start, index));
  }
  const month = anchor.slice(0, 7);
  const first = `${month}-01`;
  const last = shiftDays(`${shiftMonth(month, 1)}-01`, -1);
  const start = shiftDays(first, -weekdayOf(first));
  const end = shiftDays(last, 6 - weekdayOf(last));
  const days: string[] = [];
  for (let day = start; day <= end; day = shiftDays(day, 1)) days.push(day);
  return days;
}

// The six weeks shown for a month: from the Sunday on or before the 1st, 42 days.
export function monthGrid(month: string): string[] {
  const first = `${month}-01`;
  const start = shiftDays(first, -weekdayOf(first));
  return Array.from({ length: 42 }, (_, i) => shiftDays(start, i));
}

// What people type into a date box: 10/14, 10/14/26, 10/14/2026, 2026-10-14, Oct 14, 14 Oct 2026,
// today, tomorrow, yesterday. Month/day order is US style, like the rest of the app. Null = not a date.
export function parseDateInput(text: string, today: string): string | null {
  const value = text.trim().toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ");
  if (!value) return null;
  if (value === "today") return today;
  if (value === "tomorrow" || value === "tmr") return shiftDays(today, 1);
  if (value === "yesterday") return shiftDays(today, -1);
  const thisYear = Number(today.slice(0, 4));
  const fullYear = (y: string | undefined) => (y === undefined ? thisYear : y.length <= 2 ? 2000 + Number(y) : Number(y));

  let match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) return isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = value.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/);
  if (match) return isoDate(fullYear(match[3]), Number(match[1]), Number(match[2]));

  const monthIndex = (word: string) => MONTH_NAMES.findIndex((m) => word.length >= 3 && m.startsWith(word));
  match = value.match(/^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?(?: (\d{2}|\d{4}))?$/);
  if (match && monthIndex(match[1]) >= 0) return isoDate(fullYear(match[3]), monthIndex(match[1]) + 1, Number(match[2]));
  match = value.match(/^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)\.?(?: (\d{2}|\d{4}))?$/);
  if (match && monthIndex(match[2]) >= 0) return isoDate(fullYear(match[3]), monthIndex(match[2]) + 1, Number(match[1]));
  return null;
}

// "9", "9am", "9:30", "930", "9:30 pm", "21:30", "noon", "midnight" → "HH:MM". Null = not a time.
export function parseTimeInput(text: string): string | null {
  const value = text.trim().toLowerCase().replace(/\s+/g, "").replace(/\./g, "");
  if (!value) return null;
  if (value === "noon") return "12:00";
  if (value === "midnight") return "00:00";
  const match = value.match(/^(\d{1,2})(?::?(\d{2}))?(a|am|p|pm)?$/);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3]?.[0];
  if (minutes > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (meridiem === "a") hours = hours === 12 ? 0 : hours;
    else hours = hours === 12 ? 12 : hours + 12;
  } else if (hours > 23) {
    return null;
  }
  return `${pad(hours)}:${pad(minutes)}`;
}

// Batch 45 (Isaiah, Nov 23): a time typed next to a date — "4pm", "4 PM", "4 p.m.", "4:30pm", "16:00",
// "noon", "midnight". Meridiem times need both letters ("4 a" isn't a time); bare hours ("at 4") aren't
// either: they're too often part of a name.
export const TIME_PATTERN = String.raw`(?:\d{1,2}(?::[0-5]\d)?\s?(?:a\.?\s?m\.?|p\.?\s?m\.?)(?![a-z])|(?:[01]?\d|2[0-3]):[0-5]\d(?![\d:])|noon|midnight)`;

const DATE_THEN_TIME = new RegExp(String.raw`^(.+?)[,\s]+(?:at\s+)?(${TIME_PATTERN})$`, "i");
const TIME_THEN_DATE = new RegExp(String.raw`^(?:at\s+)?(${TIME_PATTERN})[,\s]+(?:on\s+)?(.+)$`, "i");

// A date with an optional time: "tomorrow at 4 p.m." → { day: tomorrow, time: "16:00" }, "Jun 14th" →
// { day, time: null }, "4pm tomorrow" too. Null when there's no date (a time alone isn't a date).
export function parseDateTimeInput(text: string, today: string): { day: string; time: string | null } | null {
  const value = text.trim().replace(/\s+/g, " ");
  if (!value) return null;
  const day = parseDateInput(value, today);
  if (day) return { day, time: null };
  for (const [re, datePart, timePart] of [
    [DATE_THEN_TIME, 1, 2],
    [TIME_THEN_DATE, 2, 1],
  ] as const) {
    const match = re.exec(value);
    if (!match) continue;
    const found = parseDateInput(match[datePart], today);
    const time = parseTimeInput(match[timePart]);
    if (found && time) return { day: found, time };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Batch 45 (Isaiah, Nov 23): a task's times on one clock
// ---------------------------------------------------------------------------------------------
// The database keeps due_on / start_on equal to the local date of due_at / start_at in tasks.time_zone, and
// a change of time_zone alone re-reads both dates in the new zone (sync_task_times). So a task's dates and
// times are read and written on the task's own clock: its zone once it has a time (UTC when it has a time
// but no zone, as the database reads it), else the viewer's. Reading the time on the viewer's clock next to
// a date on the task's clock showed "Jun 14, 4:00 AM" for a moment that was June 15 where it was read, and
// stamping the viewer's zone when only the other time changed moved the due date to June 15.

export type TaskClock = {
  startAt: string | null;
  dueAt: string | null;
  timeZone: string | null;
};

// The zone a task's times are shown and typed in.
export function taskClockZone(task: TaskClock, viewerZone: string): string {
  return task.dueAt || task.startAt ? task.timeZone || "UTC" : viewerZone;
}

// "HH:MM" of one of the task's times on its own clock ("" when it has none).
export function taskTimeOf(task: TaskClock, kind: "start" | "due", viewerZone: string): string {
  const at = kind === "due" ? task.dueAt : task.startAt;
  return at ? localTimeOf(at, taskClockZone(task, viewerZone)) : "";
}

// The task's zone in a few letters when it isn't the viewer's ("EDT", "GMT+3"), for the time's label; null
// when it's the viewer's own (or the task has no time).
export function taskZoneLabel(task: TaskClock, viewerZone: string): string | null {
  const at = task.dueAt ?? task.startAt;
  if (!at) return null;
  const zone = taskClockZone(task, viewerZone);
  if (zone === viewerZone || localTimeOf(at, zone) + localDayOf(at, zone) === localTimeOf(at, viewerZone) + localDayOf(at, viewerZone)) {
    return null;
  }
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" })
      .formatToParts(new Date(at))
      .find((p) => p.type === "timeZoneName");
    return part?.value ?? zone;
  } catch {
    return zone;
  }
}

export type TimePatch = { startAt?: string | null; dueAt?: string | null; timeZone?: string };

// What to save when the viewer sets one of the task's times to `hhmm` on `day` (the day as shown), or
// clears it (null). With the other time set, the task keeps its zone (changing it would move the other
// time's date); else the time is the viewer's, in their zone. Either way the saved date is `day`.
export function timeEditPatch(task: TaskClock, kind: "start" | "due", day: string, hhmm: string | null, viewerZone: string): TimePatch {
  const key = kind === "due" ? "dueAt" : "startAt";
  if (!hhmm) return { [key]: null };
  const other = kind === "due" ? task.startAt : task.dueAt;
  const zone = other ? task.timeZone || "UTC" : viewerZone;
  const patch: TimePatch = { [key]: zonedInstant(day, hhmm, zone) };
  if (!other) patch.timeZone = viewerZone;
  return patch;
}

// "15:30" → "3:30 PM".
export function formatTime(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  const hours = h % 12 === 0 ? 12 : h % 12;
  return `${hours}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
}

// The time list: every half hour.
export const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => `${pad(Math.floor(i / 2))}:${i % 2 ? "30" : "00"}`);

// "Oct 14" / "Oct 14, 2027" (a year only when it isn't the current one).
export function dayLabel(value: string, currentYear: number) {
  const { year, month, day } = parts(value);
  return year === currentYear ? `${MONTH_LABELS[month - 1]} ${day}` : `${MONTH_LABELS[month - 1]} ${day}, ${year}`;
}
