import { addDays, formatDueDate } from "@/lib/dates";
import type { ProjectTask } from "@/lib/data";

// Date math for the Timeline. Dates are calendar dates (YYYY-MM-DD) with no time zone, handled as
// UTC days so every viewer sees the same columns.

export type Zoom = "week" | "month" | "quarter";

export const ZOOMS: { value: Zoom; label: string; dayWidth: number }[] = [
  { value: "week", label: "Week", dayWidth: 36 },
  { value: "month", label: "Month", dayWidth: 12 },
  { value: "quarter", label: "Quarter", dayWidth: 4 },
];

export const isZoom = (value: unknown): value is Zoom => ZOOMS.some((z) => z.value === value);
export const dayWidthOf = (zoom: Zoom) => ZOOMS.find((z) => z.value === zoom)!.dayWidth;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"];

const pad = (n: number) => String(n).padStart(2, "0");
const toTime = (date: string) => Date.parse(`${date}T00:00:00Z`);
export const weekday = (date: string) => new Date(toTime(date)).getUTCDay();
export const daysBetween = (from: string, to: string) => Math.round((toTime(to) - toTime(from)) / 86_400_000);

function shiftMonth(date: string, delta: number) {
  const [y, m] = date.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}-01`;
}

const monthStart = (date: string) => `${date.slice(0, 7)}-01`;
function quarterStart(date: string) {
  const m = Number(date.slice(5, 7));
  return `${date.slice(0, 4)}-${pad(m - ((m - 1) % 3))}-01`;
}

// Visible window for a zoom level around an anchor date: week = 6 weeks starting the Sunday before
// the anchor's week, month = 4 months from the anchor's month, quarter = 4 quarters.
export function visibleWindow(anchor: string, zoom: Zoom): { start: string; days: number } {
  if (zoom === "week") return { start: addDays(anchor, -weekday(anchor) - 7), days: 42 };
  const start = zoom === "month" ? monthStart(anchor) : quarterStart(anchor);
  const end = shiftMonth(start, zoom === "month" ? 4 : 12);
  return { start, days: daysBetween(start, end) };
}

export function stepAnchor(anchor: string, zoom: Zoom, delta: number) {
  if (zoom === "week") return addDays(anchor, delta * 7);
  return shiftMonth(anchor, delta * (zoom === "month" ? 1 : 3));
}

export function windowLabel(start: string, days: number) {
  const end = addDays(start, days - 1);
  return start.slice(0, 4) === end.slice(0, 4)
    ? `${formatDueDate(start)} – ${formatDueDate(end)}, ${end.slice(0, 4)}`
    : `${formatDueDate(start)}, ${start.slice(0, 4)} – ${formatDueDate(end)}, ${end.slice(0, 4)}`;
}

export type Segment = { key: string; label: string; offset: number; length: number };

// Consecutive days sharing a key become one header cell.
function segments(start: string, days: number, keyOf: (date: string) => string, labelOf: (date: string) => string) {
  const out: Segment[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(start, i);
    const key = keyOf(date);
    const last = out.at(-1);
    if (last?.key === key) last.length += 1;
    else out.push({ key, label: labelOf(date), offset: i, length: 1 });
  }
  return out;
}

export function headerTiers(start: string, days: number, zoom: Zoom): { top: Segment[]; bottom: Segment[] } {
  const month = (d: string) => d.slice(0, 7);
  const monthLong = (d: string) => `${MONTHS_LONG[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
  if (zoom === "week") {
    return {
      top: segments(start, days, month, monthLong),
      bottom: segments(start, days, (d) => d, (d) => `${WEEKDAY_INITIALS[weekday(d)]} ${Number(d.slice(8))}`),
    };
  }
  if (zoom === "month") {
    return {
      top: segments(start, days, month, monthLong),
      bottom: segments(
        start,
        days,
        (d) => addDays(d, -weekday(d)),
        (d) => (weekday(d) === 0 ? String(Number(d.slice(8))) : ""),
      ),
    };
  }
  const quarter = (d: string) => `Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1} ${d.slice(0, 4)}`;
  return {
    top: segments(start, days, quarter, quarter),
    bottom: segments(start, days, month, (d) => MONTHS[Number(d.slice(5, 7)) - 1]),
  };
}

// Bar semantics (documented in AGENTS.md): start→due when both are set; a one-day bar on the due
// day for due-only tasks; a one-day, open-ended bar on the start day for start-only tasks.
export type Span = { start: string; end: string; openEnded: boolean };

export function spanOf(task: Pick<ProjectTask, "startOn" | "dueOn">): Span | null {
  const start = task.startOn ?? task.dueOn;
  const end = task.dueOn ?? task.startOn;
  if (!start || !end) return null;
  return { start, end, openEnded: !task.dueOn };
}

export type DragMode = "move" | "start" | "end";
export type Dates = { startOn: string | null; dueOn: string | null };

// Moving shifts whichever dates are set. Resizing sets the dragged edge and keeps the other one,
// so a single-date task gains both dates. Edges never cross.
export function draggedDates(task: Pick<ProjectTask, "startOn" | "dueOn">, mode: DragMode, delta: number): Dates {
  const span = spanOf(task)!;
  if (mode === "move") {
    return {
      startOn: task.startOn ? addDays(task.startOn, delta) : null,
      dueOn: task.dueOn ? addDays(task.dueOn, delta) : null,
    };
  }
  if (mode === "start") {
    const start = addDays(span.start, delta);
    return { startOn: start < span.end ? start : span.end, dueOn: span.end };
  }
  const end = addDays(span.end, delta);
  return { startOn: span.start, dueOn: end > span.start ? end : span.start };
}

export function spanLabel(span: Span) {
  if (span.openEnded) return `Starts ${formatDueDate(span.start)}`;
  if (span.start === span.end) return formatDueDate(span.end);
  return `${formatDueDate(span.start)} – ${formatDueDate(span.end)}`;
}
