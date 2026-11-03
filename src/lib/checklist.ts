// My tasks as a checklist (Nov 1 notes, batch 9b, item 64). Pure rules shared by My tasks and Home's
// Today list: the automatic date groups, what a ticked task does (the person's "Checked items" setting,
// profile_preferences.my_tasks_checked), the one-tap date chips, and the short due labels. No "use
// client": the server pages read the vocabulary too. Dates are local calendar days (YYYY-MM-DD).

import { DEFAULT_WORK_WEEK } from "@/lib/workdays";
import { dayLabel, shiftDays, weekdayOf } from "@/lib/date-input";

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
  { key: "later", title: "Later" },
  { key: "none", title: "No date" },
] as const;
export type ChecklistGroupKey = (typeof CHECKLIST_GROUPS)[number]["key"];

// "This week" is the next seven days (today's seven-day window), so it never empties on a Thursday.
export const WEEK_DAYS = 6;

export function checklistGroupOf(dueOn: string | null, today: string): ChecklistGroupKey {
  if (!dueOn) return "none";
  if (dueOn < today) return "overdue";
  if (dueOn === today) return "today";
  if (dueOn <= shiftDays(today, WEEK_DAYS)) return "week";
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

// Today, Tomorrow, and the end of this work week — the last workday of this calendar week (weeks start
// on Sunday) after tomorrow. When none is left this week (a Thursday in a Sunday–Thursday workspace),
// the chip reads "Next week" and picks next week's first workday.
export function dateChips(today: string, workWeek: readonly number[] = DEFAULT_WORK_WEEK): DateChip[] {
  const week = new Set(workWeek.length ? workWeek : DEFAULT_WORK_WEEK);
  const tomorrow = shiftDays(today, 1);
  const dow = weekdayOf(today);
  let endOfWeek: string | null = null;
  for (let d = 6; d > dow + 1; d--) {
    if (week.has(d)) {
      endOfWeek = shiftDays(today, d - dow);
      break;
    }
  }
  let third: DateChip;
  if (endOfWeek) {
    third = { key: "week", label: "This week", day: endOfWeek };
  } else {
    const sunday = shiftDays(today, 7 - dow);
    let first = sunday;
    for (let d = 0; d < 7; d++) {
      if (week.has(d)) {
        first = shiftDays(sunday, d);
        break;
      }
    }
    third = { key: "week", label: "Next week", day: first };
  }
  return [
    { key: "today", label: "Today", day: today },
    { key: "tomorrow", label: "Tomorrow", day: tomorrow },
    third,
  ];
}

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// A due date the way a checklist says it: Today, Tomorrow, Yesterday, a weekday within the week ahead,
// else "Oct 28" (with the year when it isn't this year).
export function checklistDueLabel(dueOn: string, today: string): string {
  if (dueOn === today) return "Today";
  if (dueOn === shiftDays(today, 1)) return "Tomorrow";
  if (dueOn === shiftDays(today, -1)) return "Yesterday";
  if (dueOn > today && dueOn <= shiftDays(today, WEEK_DAYS)) return WEEKDAY_SHORT[weekdayOf(dueOn)];
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
