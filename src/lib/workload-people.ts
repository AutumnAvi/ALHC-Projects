// Nov 2 notes (batch 13, note 86): the Workload tab's people view (project and portfolio). Pure rules,
// shared by the server page and the browser; unit-tested. Dates are calendar dates (YYYY-MM-DD) as UTC
// days, like the rest of the workload math. Days of the week are 0 = Sunday … 6 = Saturday.

import { addDays, daysBetween, isIsoDay } from "@/lib/workload";
import { DEFAULT_WORK_WEEK, WEEKDAYS } from "@/lib/workdays";

export const WORKLOAD_PERIODS = [
  { value: "this_week", label: "This week" },
  { value: "last_week", label: "Last week" },
  { value: "last_30", label: "Last 30 days" },
  { value: "custom", label: "Custom" },
] as const;
export type WorkloadPeriod = (typeof WORKLOAD_PERIODS)[number]["value"];
export const isWorkloadPeriod = (value: unknown): value is WorkloadPeriod =>
  WORKLOAD_PERIODS.some((p) => p.value === value);

// The longest custom period (the database refuses more).
export const MAX_PERIOD_DAYS = 366;
// Up to this many days the trend shows one bar a day; longer periods show one bar a week.
export const DAILY_TREND_MAX_DAYS = 14;

export type PeopleWindow = { period: WorkloadPeriod; start: string; end: string };

const weekdayOf = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`)).getUTCDay();
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (date: string) => `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;

// The period's days. Weeks start on Sunday (the app's weeks). A custom range must be in order and at most
// a year long; anything else falls back to this week.
export function peopleWindow(period: unknown, today: string, from?: unknown, to?: unknown): PeopleWindow {
  const sunday = addDays(today, -weekdayOf(today));
  if (period === "last_week") return { period, start: addDays(sunday, -7), end: addDays(sunday, -1) };
  if (period === "last_30") return { period, start: addDays(today, -29), end: today };
  if (period === "custom" && isIsoDay(from) && isIsoDay(to) && from <= to && daysBetween(from, to) <= MAX_PERIOD_DAYS) {
    return { period, start: from, end: to };
  }
  return { period: "this_week", start: sunday, end: addDays(sunday, 6) };
}

// "Sun–Thu" for the default week, else the workdays' short names.
export function workweekShort(workWeek: readonly number[]): string {
  const days = [...new Set(workWeek)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
  if (days.length === 0 || days.length === 7) return "every day";
  const run = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  if (run && days.length > 2) return `${WEEKDAYS[days[0]].short}–${WEEKDAYS[days.at(-1)!].short}`;
  return days.map((d) => WEEKDAYS[d].short).join(", ");
}

// "This week · Sun, Nov 1 – Sat, Nov 7 (workweek Sun–Thu)" — the period in words. A week's workdays are
// named so it's clear Friday and Saturday are days off (their completions still count).
export function periodLabel(window: PeopleWindow, workWeek: readonly number[] = DEFAULT_WORK_WEEK): string {
  const name = WORKLOAD_PERIODS.find((p) => p.value === window.period)?.label ?? "Period";
  const range =
    window.start.slice(0, 4) === window.end.slice(0, 4)
      ? `${WEEKDAYS[weekdayOf(window.start)].short}, ${shortDate(window.start)} – ${WEEKDAYS[weekdayOf(window.end)].short}, ${shortDate(window.end)}`
      : `${shortDate(window.start)}, ${window.start.slice(0, 4)} – ${shortDate(window.end)}, ${window.end.slice(0, 4)}`;
  return `${name} · ${range} (workweek ${workweekShort(workWeek)})`;
}

export type TrendBucket = {
  start: string;
  end: string;
  // "Sun 1" for a day, "Nov 1" for a week.
  label: string;
  count: number;
  // A day off in the workspace's week (only for daily buckets).
  dayOff: boolean;
};

// Completions per day (short periods) or per week starting Sunday (longer ones), every bucket present
// (zeros too). The first and last week may be partial; they cover only the period's days.
export function trendBuckets(
  window: Pick<PeopleWindow, "start" | "end">,
  completedDays: Record<string, number>,
  workWeek: readonly number[] = DEFAULT_WORK_WEEK,
): TrendBucket[] {
  const length = daysBetween(window.start, window.end) + 1;
  const countOn = (day: string) => Number(completedDays[day] ?? 0) || 0;
  if (length <= DAILY_TREND_MAX_DAYS) {
    return Array.from({ length }, (_, i) => {
      const day = addDays(window.start, i);
      return {
        start: day,
        end: day,
        label: `${WEEKDAYS[weekdayOf(day)].short} ${Number(day.slice(8, 10))}`,
        count: countOn(day),
        dayOff: !workWeek.includes(weekdayOf(day)),
      };
    });
  }
  const buckets: TrendBucket[] = [];
  let start = window.start;
  while (start <= window.end) {
    const weekEnd = addDays(start, 6 - weekdayOf(start));
    const end = weekEnd < window.end ? weekEnd : window.end;
    let count = 0;
    for (let day = start; day <= end; day = addDays(day, 1)) count += countOn(day);
    buckets.push({ start, end, label: shortDate(start), count, dayOff: false });
    start = addDays(end, 1);
  }
  return buckets;
}

export type PersonSummary = {
  id: string;
  name: string;
  completed: number;
  open: number;
  overdue: number;
  completedDays: Record<string, number>;
};

export function parseCompletedDays(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [day, n] of Object.entries(value as Record<string, unknown>)) {
    if (isIsoDay(day) && typeof n === "number" && Number.isFinite(n) && n > 0) out[day] = n;
  }
  return out;
}

export const PEOPLE_SORTS = ["name", "completed", "open", "overdue"] as const;
export type PeopleSort = (typeof PEOPLE_SORTS)[number];
export const isPeopleSort = (value: unknown): value is PeopleSort => PEOPLE_SORTS.some((s) => s === value);
export type SortDir = "asc" | "desc";

// Numbers sort largest first by default, names A–Z; ties go by name.
export function defaultDir(key: PeopleSort): SortDir {
  return key === "name" ? "asc" : "desc";
}

export function sortPeople(rows: PersonSummary[], key: PeopleSort, dir: SortDir): PersonSummary[] {
  const byName = (a: PersonSummary, b: PersonSummary) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === "name") return sign * byName(a, b);
    return sign * (a[key] - b[key]) || byName(a, b);
  });
}
