// Workload grid math (browser + server; no client-only imports). Dates are calendar dates
// (YYYY-MM-DD) handled as UTC days, like the Timeline. See “My Tasks and workload model” in AGENTS.md.

export type WorkloadZoom = "day" | "week";
export const WORKLOAD_ZOOMS: { value: WorkloadZoom; label: string }[] = [
  { value: "day", label: "Days" },
  { value: "week", label: "Weeks" },
];
export const isWorkloadZoom = (value: unknown): value is WorkloadZoom => value === "day" || value === "week";

// Day zoom shows 2 weeks; week zoom shows 12 weeks. Both start on a Sunday.
const DAY_COLUMNS = 14;
const WEEK_COLUMNS = 12;

export type WorkloadTask = {
  id: string;
  title: string;
  assigneeId: string;
  startOn: string | null;
  dueOn: string;
  value: number | null;
  projectId: string;
  canEdit: boolean;
};

export type WorkloadColumn = { start: string; end: string; label: string; sublabel: string; weekend: boolean };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const toTime = (date: string) => Date.parse(`${date}T00:00:00Z`);
export const isIsoDay = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(toTime(value));
export const addDays = (date: string, days: number) => new Date(toTime(date) + days * 86_400_000).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) => Math.round((toTime(to) - toTime(from)) / 86_400_000);
const weekdayOf = (date: string) => new Date(toTime(date)).getUTCDay();
const shortDate = (date: string) => `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;

// Today in an IANA time zone (the viewer's `tz` cookie on the server).
export function todayIn(timeZone: string) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// Visible columns around an anchor: day zoom = the anchor's week and the next; week zoom = the
// week before the anchor's week and the 11 after it.
export function workloadWindow(anchor: string, zoom: WorkloadZoom): { start: string; end: string; columns: WorkloadColumn[] } {
  const sunday = addDays(anchor, -weekdayOf(anchor));
  if (zoom === "day") {
    const columns = Array.from({ length: DAY_COLUMNS }, (_, i) => {
      const day = addDays(sunday, i);
      return {
        start: day,
        end: day,
        label: WEEKDAYS[weekdayOf(day)],
        sublabel: shortDate(day),
        weekend: weekdayOf(day) === 0 || weekdayOf(day) === 6,
      };
    });
    return { start: columns[0].start, end: columns.at(-1)!.end, columns };
  }
  const first = addDays(sunday, -7);
  const columns = Array.from({ length: WEEK_COLUMNS }, (_, i) => {
    const start = addDays(first, i * 7);
    return { start, end: addDays(start, 6), label: shortDate(start), sublabel: "Week of", weekend: false };
  });
  return { start: columns[0].start, end: columns.at(-1)!.end, columns };
}

export function stepWorkloadAnchor(anchor: string, zoom: WorkloadZoom, delta: number) {
  return addDays(anchor, delta * (zoom === "day" ? 7 : 28));
}

export function windowLabel(start: string, end: string) {
  return start.slice(0, 4) === end.slice(0, 4)
    ? `${shortDate(start)} – ${shortDate(end)}, ${end.slice(0, 4)}`
    : `${shortDate(start)}, ${start.slice(0, 4)} – ${shortDate(end)}, ${end.slice(0, 4)}`;
}

export function columnLabel(column: WorkloadColumn, zoom: WorkloadZoom) {
  return zoom === "day"
    ? `${column.label} ${column.sublabel}`
    : `${shortDate(column.start)} – ${shortDate(column.end)}`;
}

// start_on .. due_on, else just the due day.
export function spanOf(task: Pick<WorkloadTask, "startOn" | "dueOn">) {
  return { start: task.startOn && task.startOn <= task.dueOn ? task.startOn : task.dueOn, end: task.dueOn };
}

export function overlaps(task: Pick<WorkloadTask, "startOn" | "dueOn">, column: Pick<WorkloadColumn, "start" | "end">) {
  const span = spanOf(task);
  return span.start <= column.end && span.end >= column.start;
}

// What a task adds to a cell: 1 when counting tasks; with a number field, its value spread evenly over
// the days of its span (a 5-point task over 5 days adds 1 a day), so long tasks don't count in full in
// every column they touch. A task with no value adds 0.
export function taskLoad(task: WorkloadTask, column: Pick<WorkloadColumn, "start" | "end">, byField: boolean) {
  if (!overlaps(task, column)) return 0;
  if (!byField) return 1;
  if (task.value === null) return 0;
  const span = spanOf(task);
  const from = span.start > column.start ? span.start : column.start;
  const to = span.end < column.end ? span.end : column.end;
  return (task.value * (daysBetween(from, to) + 1)) / (daysBetween(span.start, span.end) + 1);
}

// Weekly capacity applies to week columns as is and to weekdays as a fifth of it; weekends have none.
export function columnCapacity(weekly: number | undefined, column: WorkloadColumn, zoom: WorkloadZoom) {
  if (weekly === undefined) return null;
  if (zoom === "week") return weekly;
  return column.weekend ? null : weekly / 5;
}

export function formatLoad(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}
