// Oct 26 notes, batch 4: events on a project or team Calendar that aren't tasks (an offsite, a launch
// day), mirrored from calendar_events in 20261026020000_oct26_batch4_a.sql. An event has a title, a day
// or a range of days, optional start / end times, and notes. Project events: Viewers read, Editors+ add,
// change, and remove them; team events: the team's readers read, its members, leads, and workspace admins
// write (RLS decides either way). Client-safe and pure: the types, limits, input checks, the zoned-time
// math the Server Actions use (a typed "9:00 AM" on a day in the person's time zone → an instant), and how
// an event reads on a bar, in an aria-label, and in its dialog.

export const EVENT_TITLE_MAX = 200;
export const EVENT_NOTES_MAX = 5000;
// end_on − start_on (calendar_events_dates_check).
export const EVENT_MAX_DAYS = 366;
// The most events one Calendar period loads.
export const CALENDAR_EVENT_LIMIT = 500;

export type CalendarEventScope = { projectId: string } | { teamId: string };

export type CalendarEvent = {
  id: string;
  title: string;
  notes: string | null;
  // Days in the event's own time zone (a time decides its day); endOn >= startOn.
  startOn: string;
  endOn: string;
  // Instants (ISO), or null for an all-day event / no end time.
  startAt: string | null;
  endAt: string | null;
  // The zone its times were typed in (the creator's browser).
  timeZone: string;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
};

// What the event dialog sends. Times are "HH:MM" on the clock of `timeZone` (an IANA name).
export type CalendarEventInput = {
  title: string;
  notes?: string | null;
  startOn: string;
  // null / missing = the start day (a one-day event).
  endOn?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  timeZone: string;
};

// The row the actions write (the database trims the text and checks it all again).
export type CalendarEventRow = {
  title: string;
  notes: string | null;
  start_on: string;
  end_on: string;
  start_at: string | null;
  end_at: string | null;
  time_zone: string;
};

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function isCalendarDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// "HH:MM", 00:00–23:59.
export function isTimeOfDay(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function isTimeZoneName(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const dayNumber = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
export const daysBetween = (from: string, to: string) => dayNumber(to) - dayNumber(from);

const formatters = new Map<string, Intl.DateTimeFormat>();
function wallClock(utcMs: number, timeZone: string) {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, format);
  }
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour % 24,
    minute: parts.minute,
    second: parts.second,
  };
}

// The zone's offset from UTC at that instant, in minutes (New York in November: −300).
export function zoneOffsetMinutes(utcMs: number, timeZone: string): number {
  const p = wallClock(utcMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60_000);
}

// "2026-11-03" + "19:30" in America/New_York → "2026-11-04T00:30:00.000Z". A time a clock change skips
// lands that much later (2:30 AM on the spring-forward night is 3:30 AM); a repeated one takes the first.
export function zonedInstant(day: string, hhmm: string, timeZone: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, h, mi);
  // The zone's offset on either side of any clock change that day.
  const before = zoneOffsetMinutes(wall - 86_400_000, timeZone);
  const after = zoneOffsetMinutes(wall + 86_400_000, timeZone);
  const fits = [before, after]
    .map((offset) => wall - offset * 60_000)
    .filter((utc) => wall - zoneOffsetMinutes(utc, timeZone) * 60_000 === utc)
    .sort((a, b) => a - b);
  return new Date(fits[0] ?? wall - before * 60_000).toISOString();
}

// An instant as "HH:MM" / "YYYY-MM-DD" on the clock of a zone (the event's own zone, so the server and
// every browser draw the same time).
export function localTimeOf(iso: string, timeZone: string): string {
  const p = wallClock(Date.parse(iso), timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

export function localDayOf(iso: string, timeZone: string): string {
  const p = wallClock(Date.parse(iso), timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

// "15:30" → "3:30 PM".
export function timeText(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
}

// The event's start / end times on its own clock (null = none).
export function eventTimes(event: Pick<CalendarEvent, "startAt" | "endAt" | "timeZone">): {
  start: string | null;
  end: string | null;
} {
  return {
    start: event.startAt ? localTimeOf(event.startAt, event.timeZone) : null,
    end: event.endAt ? localTimeOf(event.endAt, event.timeZone) : null,
  };
}

// What the dialog's form starts with for an existing event.
export function eventInputFrom(event: CalendarEvent): CalendarEventInput {
  const times = eventTimes(event);
  return {
    title: event.title,
    notes: event.notes,
    startOn: event.startOn,
    endOn: event.endOn === event.startOn ? null : event.endOn,
    startTime: times.start,
    endTime: times.end,
    timeZone: event.timeZone,
  };
}

// A problem with the input in plain words, or null. Mirrors calendar_events' CHECKs.
export function eventInputProblem(input: CalendarEventInput): string | null {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) return "Give the event a name.";
  if (title.length > EVENT_TITLE_MAX) return `An event’s name is limited to ${EVENT_TITLE_MAX} characters.`;
  if (input.notes !== undefined && input.notes !== null && typeof input.notes !== "string") return "Invalid notes.";
  if ((input.notes ?? "").trim().length > EVENT_NOTES_MAX) {
    return `Notes are limited to ${EVENT_NOTES_MAX.toLocaleString("en-US")} characters.`;
  }
  if (!isCalendarDay(input.startOn)) return "Pick the day the event starts.";
  const endOn = input.endOn ?? input.startOn;
  if (!isCalendarDay(endOn)) return "Pick the day the event ends.";
  if (endOn < input.startOn) return "The event can’t end before it starts.";
  if (daysBetween(input.startOn, endOn) > EVENT_MAX_DAYS) return "An event can last up to a year (366 days).";
  if (!isTimeZoneName(input.timeZone)) return "Invalid time zone.";
  const startTime = input.startTime ?? null;
  const endTime = input.endTime ?? null;
  if (startTime !== null && !isTimeOfDay(startTime)) return "Enter a start time like 9:00 AM.";
  if (endTime !== null && !isTimeOfDay(endTime)) return "Enter an end time like 10:00 AM.";
  if (endTime !== null && startTime === null) return "Add a start time before an end time.";
  if (startTime !== null && endTime !== null) {
    const start = zonedInstant(input.startOn, startTime, input.timeZone);
    const end = zonedInstant(endOn, endTime, input.timeZone);
    if (end < start) return "The event can’t end before it starts.";
  }
  return null;
}

// The row to write, or the problem.
export function eventRowFrom(input: CalendarEventInput): { row: CalendarEventRow } | { error: string } {
  const problem = eventInputProblem(input);
  if (problem) return { error: problem };
  const endOn = input.endOn ?? input.startOn;
  const startTime = input.startTime ?? null;
  const endTime = input.endTime ?? null;
  return {
    row: {
      title: input.title.trim(),
      notes: (input.notes ?? "").trim() || null,
      start_on: input.startOn,
      end_on: endOn,
      start_at: startTime ? zonedInstant(input.startOn, startTime, input.timeZone) : null,
      end_at: endTime ? zonedInstant(endOn, endTime, input.timeZone) : null,
      time_zone: input.timeZone,
    },
  };
}

// "Nov 3" (a year when it isn't `year`).
export function shortDay(day: string, year?: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return year !== undefined && y !== year ? `${MONTHS[m - 1]} ${d}, ${y}` : `${MONTHS[m - 1]} ${d}`;
}

// "Monday, November 3, 2026".
export function longDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${MONTH_NAMES[m - 1]} ${d}, ${y}`;
}

// When it is, short: "Nov 3, 9:00 AM", "Nov 3, 9:00 AM – 10:00 AM", "Nov 9 to Nov 13",
// "Nov 9, 9:00 AM to Nov 13, 5:00 PM" (aria-labels and tooltips).
export function eventShortWhen(event: CalendarEvent, year?: number): string {
  const { start, end } = eventTimes(event);
  const first = shortDay(event.startOn, year);
  if (event.endOn === event.startOn) {
    if (!start) return first;
    return end && end !== start ? `${first}, ${timeText(start)} – ${timeText(end)}` : `${first}, ${timeText(start)}`;
  }
  const last = shortDay(event.endOn, year);
  return `${first}${start ? `, ${timeText(start)}` : ""} to ${last}${end ? `, ${timeText(end)}` : ""}`;
}

// When it is, in full (the event dialog): "Monday, November 3, 2026 · 9:00 AM – 10:00 AM",
// "Monday, November 9, 2026 – Friday, November 13, 2026".
export function eventWhenText(event: CalendarEvent): string {
  const { start, end } = eventTimes(event);
  if (event.endOn === event.startOn) {
    if (!start) return longDay(event.startOn);
    return `${longDay(event.startOn)} · ${timeText(start)}${end && end !== start ? ` – ${timeText(end)}` : ""}`;
  }
  return `${longDay(event.startOn)}${start ? `, ${timeText(start)}` : ""} – ${longDay(event.endOn)}${end ? `, ${timeText(end)}` : ""}`;
}

// The bar's button name: "Event: Kickoff, Nov 3, 9:00 AM".
export function eventAriaLabel(event: CalendarEvent, year?: number): string {
  return `Event: ${event.title}, ${eventShortWhen(event, year)}`;
}

// The time drawn in front of the title on the bar ("9:00 AM"), on the day it starts; null all day.
export function eventBarTime(event: Pick<CalendarEvent, "startAt" | "timeZone">): string | null {
  return event.startAt ? timeText(localTimeOf(event.startAt, event.timeZone)) : null;
}

// Events in the order a day lists them: earlier first, all-day before timed, longer first, then by name.
export function compareEvents(a: CalendarEvent, b: CalendarEvent): number {
  return (
    a.startOn.localeCompare(b.startOn) ||
    Number(a.startAt !== null) - Number(b.startAt !== null) ||
    (a.startAt ?? "").localeCompare(b.startAt ?? "") ||
    b.endOn.localeCompare(a.endOn) ||
    a.title.localeCompare(b.title)
  );
}

// The day a new event starts on: today when it's in view, else the first day of the visible month
// (month view) or week.
export function defaultEventDay(days: readonly string[], today: string | null, month: string | null): string {
  if (today && days.includes(today)) return today;
  if (month) {
    const first = `${month}-01`;
    if (days.includes(first)) return first;
  }
  return days[0] ?? today ?? new Date().toISOString().slice(0, 10);
}

// What the "+N more" button says about the hidden bars of a day.
export function moreLabel(tasks: number, events: number): string {
  const count = tasks + events;
  if (events === 0) return `${count} more ${count === 1 ? "task" : "tasks"}`;
  if (tasks === 0) return `${count} more ${count === 1 ? "event" : "events"}`;
  return `${count} more items`;
}

// The database's row → the app's event.
export function toCalendarEvent(
  row: {
    id: string;
    title: string;
    notes: string | null;
    start_on: string;
    end_on: string;
    start_at: string | null;
    end_at: string | null;
    time_zone: string;
    created_by: string | null;
    created_at: string;
  },
  createdByName: string | null = null,
): CalendarEvent {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    startOn: row.start_on,
    endOn: row.end_on < row.start_on ? row.start_on : row.end_on,
    startAt: row.start_at,
    endAt: row.end_at,
    timeZone: isTimeZoneName(row.time_zone) ? row.time_zone : "UTC",
    createdBy: row.created_by,
    createdByName,
    createdAt: row.created_at,
  };
}
