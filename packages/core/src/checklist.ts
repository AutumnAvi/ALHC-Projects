// My tasks as a checklist (Nov 1 notes, batch 9b, item 64). Pure rules shared by My tasks and Home's
// Today list: the automatic date groups, what a ticked task does (the person's "Checked items" setting,
// profile_preferences.my_tasks_checked), the one-tap date chips, and the short due labels. No "use
// client": the server pages read the vocabulary too. Dates are local calendar days (YYYY-MM-DD).

import { DEFAULT_WORK_WEEK } from "./workdays";
import { dayLabel, shiftDays, weekdayOf } from "./date-input";

// ---------------------------------------------------------------------------------------------
// Checked items: what a task ticked today does until the day ends (every mode clears overnight)
// ---------------------------------------------------------------------------------------------

export const CHECKED_MODES = ["sink", "stay", "hide"] as const;
export type CheckedMode = (typeof CHECKED_MODES)[number];
export const DEFAULT_CHECKED_MODE: CheckedMode = "sink";
export const isCheckedMode = (value: unknown): value is CheckedMode =>
  typeof value === "string" && (CHECKED_MODES as readonly string[]).includes(value);

export const CHECKED_MODE_OPTIONS: { value: CheckedMode; label: string; description: string }[] = [
  { value: "sink", label: "Move to Done today", description: "Struck through, then tucked into a collapsed “Done today” group at the bottom." },
  { value: "stay", label: "Stay in place", description: "Struck through where they are, until tomorrow." },
  { value: "hide", label: "Hide", description: "Gone from the list right away (Undo brings one back)." },
];

// How long a ticked row stays where it is before it moves (so a mis-tap can be caught), in ms.
export const SETTLE_MS = 1000;

// The pending-create scope of the quick add (My tasks and Home's Today card): a task typed into the bar
// shows in its date group straight away, until the refreshed list has the saved one (Nov 3 notes, batch 19).
export const QUICK_ADD_PENDING_SCOPE = "my-tasks:quick-add";

// ---------------------------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------------------------

export const CHECKLIST_GROUPS = [
  { key: "overdue", title: "Overdue" },
  { key: "today", title: "Today" },
  { key: "week", title: "This week" },
  { key: "next", title: "Next week" },
  { key: "later", title: "Later" },
  { key: "none", title: "No date" },
] as const;
export type ChecklistGroupKey = (typeof CHECKLIST_GROUPS)[number]["key"];

// "This week" and "Next week" mean one thing everywhere (the checklist's groups, its date chips, the
// quick add's "this week" / "next week", the pane's quick picks; Nov 10 audit, C8). Weeks are calendar
// weeks starting on Sunday, like the app's calendars, and the days a task lands on are the WORKSPACE's
// workdays (Sunday–Thursday by default):
//   this week = the rest of this calendar week (the date it lands on: this week's last workday, today or later)
//   next week = next calendar week (the date it lands on: next week's first workday)
export function endOfThisWeek(today: string): string {
  return shiftDays(today, 6 - weekdayOf(today));
}

export function endOfNextWeek(today: string): string {
  return shiftDays(endOfThisWeek(today), 7);
}

const workdaySet = (workWeek: readonly number[]) => new Set(workWeek.length ? workWeek : DEFAULT_WORK_WEEK);

// This week's last workday on or after today; null when none is left (a Friday in a Sunday–Thursday week).
export function thisWeekWorkday(today: string, workWeek: readonly number[] = DEFAULT_WORK_WEEK): string | null {
  const week = workdaySet(workWeek);
  const dow = weekdayOf(today);
  for (let d = 6; d >= dow; d--) if (week.has(d)) return shiftDays(today, d - dow);
  return null;
}

// Next calendar week's first workday.
export function nextWeekWorkday(today: string, workWeek: readonly number[] = DEFAULT_WORK_WEEK): string {
  const week = workdaySet(workWeek);
  const sunday = shiftDays(endOfThisWeek(today), 1);
  for (let d = 0; d < 7; d++) if (week.has(d)) return shiftDays(sunday, d);
  return sunday;
}

// What a typed "this week" means: this week's last workday, else (none left) next week's first.
export function thisWeekDay(today: string, workWeek: readonly number[] = DEFAULT_WORK_WEEK): string {
  return thisWeekWorkday(today, workWeek) ?? nextWeekWorkday(today, workWeek);
}

export function checklistGroupOf(dueOn: string | null, today: string): ChecklistGroupKey {
  if (!dueOn) return "none";
  if (dueOn < today) return "overdue";
  if (dueOn === today) return "today";
  if (dueOn <= endOfThisWeek(today)) return "week";
  if (dueOn <= endOfNextWeek(today)) return "next";
  return "later";
}

export type ChecklistItem = { id: string; dueOn: string | null; completedAt: string | null; title: string };

export type ChecklistGroup<T> = { key: ChecklistGroupKey; title: string; tasks: T[] };

// The open tasks (and, with "stay" or while a row settles, ticked ones) in their date groups, in date
// then title order. Empty groups are left out, except "No date" when `keepNoDate` (it's where new work
// lands, so it stays visible as a place). A task's group comes from `dueOf` (the optimistic date).
export function groupChecklist<T extends ChecklistItem>(
  tasks: T[],
  today: string,
  dueOf: (task: T) => string | null = (task) => task.dueOn,
): ChecklistGroup<T>[] {
  const groups = new Map<ChecklistGroupKey, T[]>(CHECKLIST_GROUPS.map((g) => [g.key, []]));
  for (const task of tasks) groups.get(checklistGroupOf(dueOf(task), today))!.push(task);
  const order = (a: T, b: T) => {
    const x = dueOf(a) ?? "";
    const y = dueOf(b) ?? "";
    return x === y ? a.title.localeCompare(b.title) : x < y ? -1 : 1;
  };
  return CHECKLIST_GROUPS.flatMap((g) => {
    const list = groups.get(g.key)!;
    return list.length ? [{ key: g.key, title: g.title, tasks: list.sort(order) }] : [];
  });
}

// ---------------------------------------------------------------------------------------------
// Done today
// ---------------------------------------------------------------------------------------------

// The local calendar day of a timestamp (the browser's zone; `timeZone` for the server).
export function localDayOf(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  if (timeZone) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export const completedToday = (completedAt: string | null, today: string, timeZone?: string) =>
  Boolean(completedAt && localDayOf(completedAt, timeZone) === today);

// Where a ticked row goes, given the setting and whether it has settled (SETTLE_MS after the tick).
//   "group"  stays in its date group (struck through)   "done"  the Done today group   "hidden"  nowhere
export function checkedPlacement(mode: CheckedMode, settled: boolean): "group" | "done" | "hidden" {
  if (!settled || mode === "stay") return "group";
  return mode === "sink" ? "done" : "hidden";
}

// ---------------------------------------------------------------------------------------------
// Date chips (the "No date" group and "Set a date" prompts)
// ---------------------------------------------------------------------------------------------

export type DateChip = { key: "today" | "tomorrow" | "week"; label: string; day: string };

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Today, Tomorrow, and "This week · Thu" — this week's last workday — when that is after tomorrow; else
// (it's today or tomorrow, or none is left) "Next week · Sun", next week's first workday. The chip names
// the day it sets.
export function dateChips(today: string, workWeek: readonly number[] = DEFAULT_WORK_WEEK): DateChip[] {
  const tomorrow = shiftDays(today, 1);
  const endOfWeek = thisWeekWorkday(today, workWeek);
  const third: DateChip =
    endOfWeek && endOfWeek > tomorrow
      ? { key: "week", label: `This week · ${WEEKDAY_SHORT[weekdayOf(endOfWeek)]}`, day: endOfWeek }
      : (() => {
          const first = nextWeekWorkday(today, workWeek);
          return { key: "week", label: `Next week · ${WEEKDAY_SHORT[weekdayOf(first)]}`, day: first };
        })();
  return [
    { key: "today", label: "Today", day: today },
    { key: "tomorrow", label: "Tomorrow", day: tomorrow },
    third,
  ];
}

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

// A due date the way a checklist says it: Today, Tomorrow, Yesterday, a weekday within the week ahead,
// else "Oct 28" (with the year when it isn't this year).
export function checklistDueLabel(dueOn: string, today: string): string {
  if (dueOn === today) return "Today";
  if (dueOn === shiftDays(today, 1)) return "Tomorrow";
  if (dueOn === shiftDays(today, -1)) return "Yesterday";
  if (dueOn > today && dueOn <= shiftDays(today, 6)) return WEEKDAY_SHORT[weekdayOf(dueOn)];
  return dayLabel(dueOn, Number(today.slice(0, 4)));
}

// "3 due today · 1 overdue" (Home's greeting line). Empty when there's nothing open.
export function summaryLine(counts: { today: number; overdue: number; week: number }): string {
  const parts: string[] = [];
  if (counts.today) parts.push(`${counts.today} due today`);
  if (counts.overdue) parts.push(`${counts.overdue} overdue`);
  if (!parts.length && counts.week) parts.push(`${counts.week} due this week`);
  return parts.join(" · ");
}

// Nov 12 notes (batch 39, item 3): Home's Today card shows only overdue and today's tasks, so Home sends
// the browser only those — plus tomorrow's, so the card is right if the page stays open past midnight —
// and just the ids of the rest (to tell the card's live updates that a change to one of them may bring it
// into Today, which asks the server for the page). Counts on Home are worked out on the server from the
// whole list first.
export function todayCardSplit<T extends { id: string; dueOn: string | null }>(
  open: readonly T[],
  today: string,
): { shown: T[]; hiddenIds: string[] } {
  const until = shiftDays(today, 1);
  const shown: T[] = [];
  const hiddenIds: string[] = [];
  for (const task of open) {
    if (task.dueOn && task.dueOn <= until) shown.push(task);
    else hiddenIds.push(task.id);
  }
  return { shown, hiddenIds };
}
