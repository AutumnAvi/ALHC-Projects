// iCalendar (RFC 5545) for the calendar subscribe links (Real features 4). Pure functions, no I/O: the
// feed route (src/app/api/calendar/[token]/route.ts) hands in the events calendar_feed() returned.
//
// Every line ends with CRLF and is folded at 75 octets (a continuation line starts with one space; a
// UTF-8 character is never split). TEXT values escape backslash, semicolon, comma, and line breaks.
// One VEVENT per task with a stable UID (the task id), so calendar apps update an event in place when a
// task's dates or title change. A task with only dates is an all-day event (DTEND is the day after the
// last day, as the RFC says); one with times is a timed event in UTC.

export type FeedEvent = {
  id: string;
  title: string;
  start_on: string | null;
  due_on: string | null;
  start_at: string | null;
  due_at: string | null;
  completed: boolean;
  kind: string;
  updated_at: string | null;
  project: string | null;
  path: string;
};

const DAY_MS = 86_400_000;
// A task due at a time (no start time) is a half-hour event starting then.
const TIMED_MINUTES = 30;

// TEXT escaping (RFC 5545 3.3.11); other control characters are dropped.
export function escapeText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

const encoder = new TextEncoder();

// Folds a content line at 75 octets (RFC 5545 3.1), never inside a UTF-8 character or a surrogate pair.
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    // The first line holds 75 octets; continuation lines 74 after their leading space.
    const limit = parts.length === 0 ? 75 : 74;
    if (size + bytes > limit) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

const pad = (n: number) => String(n).padStart(2, "0");

// "2026-10-14" → "20261014".
export function icsDate(day: string): string {
  return day.slice(0, 10).replace(/-/g, "");
}

// An instant → "20261014T150000Z".
export function icsUtc(value: string | Date): string {
  const d = typeof value === "string" ? new Date(value) : value;
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day.slice(0, 10)}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

const validInstant = (value: string | null): value is string => Boolean(value) && !Number.isNaN(Date.parse(value!));

// DTSTART / DTEND for a task: timed when it has times, else all-day over its dates.
export function eventTimes(event: Pick<FeedEvent, "start_on" | "due_on" | "start_at" | "due_at">): string[] | null {
  const { start_at, due_at } = event;
  if (validInstant(due_at)) {
    const end = Date.parse(due_at);
    if (validInstant(start_at) && Date.parse(start_at) < end) {
      return [`DTSTART:${icsUtc(start_at)}`, `DTEND:${icsUtc(due_at)}`];
    }
    if (!event.start_on || event.start_on === event.due_on) {
      return [`DTSTART:${icsUtc(due_at)}`, `DTEND:${icsUtc(new Date(end + TIMED_MINUTES * 60_000))}`];
    }
  }
  const first = event.start_on ?? event.due_on;
  const last = event.due_on ?? event.start_on;
  if (!first || !last) return null;
  const [from, to] = first <= last ? [first, last] : [last, first];
  return [`DTSTART;VALUE=DATE:${icsDate(from)}`, `DTEND;VALUE=DATE:${icsDate(nextDay(to))}`];
}

export function buildCalendar({
  name,
  events,
  origin,
  now = new Date(),
}: {
  name: string;
  events: FeedEvent[];
  // Absolute origin for the links back to each task; null leaves them out.
  origin: string | null;
  now?: Date;
}): string {
  const stamp = icsUtc(now);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ALHC Projects//Calendar feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(name)}`,
    `NAME:${escapeText(name)}`,
    "X-WR-CALDESC:Tasks from ALHC Projects",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  for (const event of events) {
    const times = eventTimes(event);
    if (!times || !event.id) continue;
    const url = origin ? `${origin.replace(/\/+$/, "")}${event.path}` : null;
    const title = event.title.trim() || "Untitled task";
    const details = [
      event.project ? `Project: ${event.project}` : "Private task (My tasks)",
      event.kind === "milestone" ? "Milestone" : event.kind === "approval" ? "Approval" : null,
      event.completed ? "Completed" : null,
      url ? `Open in ALHC Projects: ${url}` : null,
    ].filter((line): line is string => Boolean(line));
    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.id}@alhc-projects`,
      `DTSTAMP:${stamp}`,
      ...(validInstant(event.updated_at) ? [`LAST-MODIFIED:${icsUtc(event.updated_at)}`] : []),
      ...times,
      `SUMMARY:${escapeText(event.completed ? `✓ ${title}` : title)}`,
      `DESCRIPTION:${escapeText(details.join("\n"))}`,
      ...(url ? [`URL:${url}`] : []),
      "STATUS:CONFIRMED",
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
