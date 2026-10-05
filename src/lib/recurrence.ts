// Recurrence rules, mirrored from public.normalize_recurrence() in 20261005060000_task_depth.sql.
// The database normalizes and validates every rule; this module only parses and describes them.

import type { Json } from "@/lib/supabase/database.types";

export const FREQUENCIES = ["daily", "weekly", "monthly", "yearly"] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export type RecurrenceEnds =
  | { type: "never" }
  | { type: "after"; count: number }
  | { type: "until"; until: string };

export type Recurrence = {
  freq: Frequency;
  interval: number;
  // Weekly only; 0 = Sunday. Empty = the weekday of the task's date.
  weekdays: number[];
  ends: RecurrenceEnds;
  timezone?: string;
};

export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const UNIT: Record<Frequency, string> = { daily: "days", weekly: "weeks", monthly: "months", yearly: "years" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function isFrequency(value: unknown): value is Frequency {
  return typeof value === "string" && (FREQUENCIES as readonly string[]).includes(value);
}

function isObject(value: unknown): value is Record<string, Json | undefined> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseRecurrence(value: Json | null | undefined): Recurrence | null {
  if (!isObject(value) || !isFrequency(value.freq)) return null;
  const interval = typeof value.interval === "number" && value.interval >= 1 ? Math.floor(value.interval) : 1;
  const weekdays = Array.isArray(value.weekdays)
    ? value.weekdays.filter((d): d is number => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6)
    : [];
  let ends: RecurrenceEnds = { type: "never" };
  if (isObject(value.ends)) {
    if (value.ends.type === "after" && typeof value.ends.count === "number") {
      ends = { type: "after", count: value.ends.count };
    } else if (value.ends.type === "until" && typeof value.ends.until === "string") {
      ends = { type: "until", until: value.ends.until };
    }
  }
  return {
    freq: value.freq,
    interval,
    weekdays: value.freq === "weekly" ? [...new Set(weekdays)].sort((a, b) => a - b) : [],
    ends,
    timezone: typeof value.timezone === "string" ? value.timezone : undefined,
  };
}

// The JSON written to tasks.recurrence (the database adds defaults and month_day).
export function recurrenceJson(rule: Recurrence): Json {
  return {
    freq: rule.freq,
    interval: rule.interval,
    ...(rule.freq === "weekly" && rule.weekdays.length ? { weekdays: rule.weekdays } : {}),
    ends: rule.ends,
    ...(rule.timezone ? { timezone: rule.timezone } : {}),
  };
}

function formatDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

// "Every 2 weeks on Mon, Wed · 5 times", "Daily", "Monthly · until Dec 31, 2026".
export function describeRecurrence(rule: Recurrence): string {
  const many = UNIT[rule.freq];
  let text =
    rule.interval === 1
      ? { daily: "Daily", weekly: "Weekly", monthly: "Monthly", yearly: "Yearly" }[rule.freq]
      : `Every ${rule.interval} ${many}`;
  if (rule.freq === "weekly" && rule.weekdays.length) {
    text += ` on ${rule.weekdays.map((d) => WEEKDAY_SHORT[d]).join(", ")}`;
  }
  if (rule.ends.type === "after") text += ` · ${rule.ends.count} time${rule.ends.count === 1 ? "" : "s"}`;
  if (rule.ends.type === "until") text += ` · until ${formatDate(rule.ends.until)}`;
  return text;
}
