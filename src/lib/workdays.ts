// Business days for rules (Automations V2). Mirrors public.rule_add_days() in
// 20261020010000_automations_v2.sql; tests/unit/workdays.test.ts and suite zz29 share the vectors.
// Days of the week are 0 = Sunday … 6 = Saturday. A workspace's workweek is workspaces.work_week.

export const DEFAULT_WORK_WEEK: readonly number[] = [0, 1, 2, 3, 4]; // Sunday–Thursday

export const WEEKDAYS = [
  { value: 0, label: "Sunday", short: "Sun" },
  { value: 1, label: "Monday", short: "Mon" },
  { value: 2, label: "Tuesday", short: "Tue" },
  { value: 3, label: "Wednesday", short: "Wed" },
  { value: 4, label: "Thursday", short: "Thu" },
  { value: 5, label: "Friday", short: "Fri" },
  { value: 6, label: "Saturday", short: "Sat" },
] as const;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parse(date: string): Date | null {
  const m = ISO_DATE.exec(date);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? d : null;
}

function format(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// A valid workweek: 1–7 distinct days from 0 to 6 (sorted). Anything else falls back to the default.
export function normalizeWorkWeek(value: unknown): number[] {
  if (!Array.isArray(value)) return [...DEFAULT_WORK_WEEK];
  const days = [...new Set(value.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
  return days.length ? days : [...DEFAULT_WORK_WEEK];
}

// `date` plus `days`, counting only workdays when `business` is on. Zero business days from a day off
// moves to the next workday; a negative count walks back. Without a workweek (or with all seven days)
// business days are calendar days. Null for an invalid date.
export function addWorkdays(date: string, days: number, business: boolean, workWeek: readonly number[] = DEFAULT_WORK_WEEK): string | null {
  const start = parse(date);
  if (!start || !Number.isInteger(days)) return null;
  const week = new Set(workWeek);
  if (!business || week.size === 0 || week.size >= 7) {
    start.setUTCDate(start.getUTCDate() + days);
    return format(start);
  }
  const d = new Date(start);
  if (days === 0) {
    while (!week.has(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
    return format(d);
  }
  const direction = days < 0 ? -1 : 1;
  let remaining = Math.abs(days);
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + direction);
    if (week.has(d.getUTCDay())) remaining -= 1;
  }
  return format(d);
}

// "Sunday–Thursday", "Monday–Friday", or a list ("Sun, Tue, Thu") for a workweek that isn't a run.
export function describeWorkWeek(workWeek: readonly number[]): string {
  const days = normalizeWorkWeek([...workWeek]);
  if (days.length === 7) return "Every day";
  const contiguous = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  if (contiguous && days.length > 2) return `${WEEKDAYS[days[0]].label}–${WEEKDAYS[days[days.length - 1]].label}`;
  return days.map((d) => WEEKDAYS[d].short).join(", ");
}
