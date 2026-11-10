// Nov 1 notes, batch 9b — the pure rules (the database's side is suite zz39): My tasks' date groups,
// checked items, date chips and labels (item 64), the quick-add parser, and repeat after completion.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkedPlacement,
  checklistDueLabel,
  checklistGroupOf,
  completedToday,
  dateChips,
  groupChecklist,
  isCheckedMode,
  localDayOf,
  summaryLine,
} from "@alhc/core/checklist";
import { completeToken, describeRepeat, parseQuickAdd, tokenAtCaret } from "@alhc/core/quick-add";
import { describeRecurrence, parseRecurrence, recurrenceJson } from "@alhc/core/recurrence";

// Sunday, November 1, 2026.
const TODAY = "2026-11-01";
const projects = [
  { id: "p1", name: "Fall Campaign" },
  { id: "p2", name: "Fall" },
  { id: "p3", name: "Friday post" },
];
const people = [
  { id: "u1", name: "Dana Diaz", email: "dana@example.com" },
  { id: "u2", name: "Sam Lee", email: "sam.lee@example.com" },
];
const ctx = { today: TODAY, projects, people };

test("date groups: overdue, today, this week, next week, later, no date", () => {
  assert.equal(checklistGroupOf(null, TODAY), "none");
  assert.equal(checklistGroupOf("2026-10-31", TODAY), "overdue");
  assert.equal(checklistGroupOf(TODAY, TODAY), "today");
  // Nov 10 audit (C8): calendar weeks (Sunday to Saturday).
  assert.equal(checklistGroupOf("2026-11-02", TODAY), "week");
  assert.equal(checklistGroupOf("2026-11-07", TODAY), "week");
  assert.equal(checklistGroupOf("2026-11-08", TODAY), "next");
  assert.equal(checklistGroupOf("2026-11-14", TODAY), "next");
  assert.equal(checklistGroupOf("2026-11-15", TODAY), "later");
  assert.equal(checklistGroupOf("2026-11-07", "2026-11-05"), "week", "Thursday: Saturday is still this week");
  assert.equal(checklistGroupOf("2026-11-08", "2026-11-05"), "next", "Thursday: Sunday is next week");
  const groups = groupChecklist(
    [
      { id: "a", title: "B later", dueOn: "2026-12-01", completedAt: null },
      { id: "b", title: "A today", dueOn: TODAY, completedAt: null },
      { id: "c", title: "No date", dueOn: null, completedAt: null },
      { id: "d", title: "Old", dueOn: "2026-10-01", completedAt: null },
      { id: "e", title: "Another today", dueOn: TODAY, completedAt: null },
    ],
    TODAY,
  );
  assert.deepEqual(groups.map((g) => g.key), ["overdue", "today", "later", "none"], "empty groups are left out, in order");
  assert.deepEqual(groups[1].tasks.map((t) => t.id), ["b", "e"], "same day: by title");
});

test("checked items: stay, sink, hide; settle first; clears overnight", () => {
  assert.ok(isCheckedMode("stay") && isCheckedMode("sink") && isCheckedMode("hide"));
  assert.ok(!isCheckedMode("vanish"));
  assert.equal(checkedPlacement("sink", false), "group", "a just-ticked row stays put for a moment");
  assert.equal(checkedPlacement("sink", true), "done");
  assert.equal(checkedPlacement("stay", true), "group");
  assert.equal(checkedPlacement("hide", true), "hidden");
  assert.equal(localDayOf("2026-11-01T23:30:00Z", "UTC"), "2026-11-01");
  assert.equal(localDayOf("2026-11-01T23:30:00Z", "Asia/Jerusalem"), "2026-11-02");
  assert.ok(completedToday("2026-11-01T10:00:00Z", TODAY, "UTC"));
  assert.ok(!completedToday("2026-10-31T10:00:00Z", TODAY, "UTC"), "yesterday's ticks are gone");
  assert.ok(!completedToday(null, TODAY, "UTC"));
});

test("date chips: Today, Tomorrow, and the end of the work week", () => {
  // Sunday in a Sunday–Thursday workspace: this week ends Thursday.
  assert.deepEqual(dateChips(TODAY).map((c) => [c.label, c.day]), [
    ["Today", "2026-11-01"],
    ["Tomorrow", "2026-11-02"],
    ["This week · Thu", "2026-11-05"],
  ]);
  // Wednesday: this week's last workday is tomorrow, so the chip is "Next week" = Sunday.
  assert.deepEqual(dateChips("2026-11-04")[2], { key: "week", label: "Next week · Sun", day: "2026-11-08" });
  // Thursday: nothing left this week after tomorrow, so "Next week" = Sunday.
  assert.deepEqual(dateChips("2026-11-05")[2], { key: "week", label: "Next week · Sun", day: "2026-11-08" });
  // Monday–Friday workweek on a Monday: Friday.
  assert.equal(dateChips("2026-11-02", [1, 2, 3, 4, 5])[2].day, "2026-11-06");
});

test("due labels and the summary line", () => {
  assert.equal(checklistDueLabel(TODAY, TODAY), "Today");
  assert.equal(checklistDueLabel("2026-11-02", TODAY), "Tomorrow");
  assert.equal(checklistDueLabel("2026-10-31", TODAY), "Yesterday");
  assert.equal(checklistDueLabel("2026-11-04", TODAY), "Wed");
  assert.equal(checklistDueLabel("2026-11-20", TODAY), "Nov 20");
  assert.equal(checklistDueLabel("2027-01-04", TODAY), "Jan 4, 2027");
  assert.equal(summaryLine({ today: 3, overdue: 1, week: 0 }), "3 due today · 1 overdue");
  assert.equal(summaryLine({ today: 0, overdue: 0, week: 2 }), "2 due this week");
  assert.equal(summaryLine({ today: 0, overdue: 0, week: 0 }), "");
});

test("quick add: dates, #project, @person, and the name that's left", () => {
  const p = parseQuickAdd("Draft flu-shot email fri #Fall Campaign @Dana", ctx);
  // Nov 4 notes (batch 27, 162): the @person stays in the name, under their full name.
  assert.equal(p.title, "Draft flu-shot email @Dana Diaz");
  assert.equal(p.dueOn, "2026-11-06", "fri = the next Friday");
  assert.equal(p.project?.id, "p1", "the longest project name wins");
  assert.equal(p.person?.id, "u1", "first names work");
  assert.deepEqual(p.parts.map((x) => x.kind), ["date", "project", "person"]);

  assert.equal(parseQuickAdd("Call vendor tomorrow", ctx).dueOn, "2026-11-02");
  assert.equal(parseQuickAdd("Call vendor today", ctx).dueOn, TODAY);
  assert.equal(parseQuickAdd("Report in 3 days", ctx).dueOn, "2026-11-04");
  assert.equal(parseQuickAdd("Report in 2 weeks", ctx).dueOn, "2026-11-15");
  // Nov 10 audit (C8): the same meaning as the chips — next week's first workday, this week's last.
  assert.equal(parseQuickAdd("Report next week", ctx).dueOn, "2026-11-08", "next week = next week's first workday (Sunday)");
  assert.equal(parseQuickAdd("Report this week", ctx).dueOn, "2026-11-05");
  assert.equal(parseQuickAdd("Report this week", { ...ctx, today: "2026-11-05" }).dueOn, "2026-11-05", "Thursday: today");
  assert.equal(parseQuickAdd("Report this week", { ...ctx, today: "2026-11-06" }).dueOn, "2026-11-08", "Friday: next week's first workday");
  // Nov 10 audit (C6): a date word with an apostrophe is part of the name.
  assert.equal(parseQuickAdd("Draft today's newsletter", ctx).title, "Draft today's newsletter");
  assert.equal(parseQuickAdd("Draft today's newsletter", ctx).dueOn, null);
  assert.equal(parseQuickAdd("Review tomorrow’s schedule", ctx).title, "Review tomorrow’s schedule");
  assert.equal(parseQuickAdd("Monday's recap", ctx).title, "Monday's recap");
  assert.equal(parseQuickAdd("Friday's email fri", ctx).dueOn, "2026-11-06", "a plain weekday later in the line still counts");
  assert.equal(parseQuickAdd("Launch on Nov 20", ctx).dueOn, "2026-11-20");
  assert.equal(parseQuickAdd("Launch on Nov 20", ctx).title, "Launch");
  assert.equal(parseQuickAdd("Launch 10/14", ctx).dueOn, "2027-10-14", "a past month and day means next year");
  assert.equal(parseQuickAdd("Launch 2026-12-01", ctx).dueOn, "2026-12-01");
  assert.equal(parseQuickAdd("Sun safety post", ctx).dueOn, null, "“Sun” is a word, not Sunday");
  assert.equal(parseQuickAdd("Post sunday", ctx).dueOn, "2026-11-08", "a weekday that's today means next week");
  assert.equal(parseQuickAdd("Post this sunday", ctx).dueOn, TODAY);
  // A project whose name holds a weekday keeps it.
  const friday = parseQuickAdd("Caption #Friday post", ctx);
  assert.equal(friday.project?.id, "p3");
  assert.equal(friday.dueOn, null);
  // Unknown names stay in the title; emails' local parts match people.
  assert.equal(parseQuickAdd("Ping #nowhere @sam.lee", ctx).title, "Ping #nowhere @Sam Lee");
  assert.equal(parseQuickAdd("Ping #nowhere @sam.lee", ctx).person?.id, "u2");
  // A word glued to # isn't a tag.
  assert.equal(parseQuickAdd("Issue#Fall", ctx).project, null);
});

test("quick add: ignored parts stay in the name", () => {
  const p = parseQuickAdd("Plan the friday meeting", { ...ctx, ignored: ["friday"] });
  assert.equal(p.dueOn, null);
  assert.equal(p.title, "Plan the friday meeting");
});

test("quick add: repeats, including after completion", () => {
  const weekly = parseQuickAdd("Social post every week", ctx);
  assert.deepEqual(weekly.repeat, { freq: "weekly", interval: 1, weekdays: [], fromCompletion: false });
  assert.equal(weekly.dueOn, TODAY, "no date typed: starts today");
  assert.equal(weekly.title, "Social post");

  const water = parseQuickAdd("Water plants every! 3 days", ctx);
  assert.deepEqual(water.repeat, { freq: "daily", interval: 3, weekdays: [], fromCompletion: true });
  assert.equal(describeRepeat(water.repeat!), "Every 3 days after completion");

  const after = parseQuickAdd("Inventory every month after completion", ctx);
  assert.equal(after.repeat?.freq, "monthly");
  assert.ok(after.repeat?.fromCompletion);
  assert.equal(after.title, "Inventory");

  const days = parseQuickAdd("Standup every mon and wed", ctx);
  assert.deepEqual(days.repeat?.weekdays, [1, 3]);
  assert.equal(days.dueOn, "2026-11-02", "the first listed weekday from today");
  assert.equal(describeRepeat(days.repeat!), "Every Mon, Wed");

  const dated = parseQuickAdd("Report every month nov 30", ctx);
  assert.equal(dated.dueOn, "2026-11-30", "a typed date is the first one");
  assert.equal(parseQuickAdd("Check every other week", ctx).repeat?.interval, 2);
  assert.equal(parseQuickAdd("Check every weekday", ctx).repeat?.weekdays.length, 5);
});

test("quick add: suggestions for the token being typed", () => {
  assert.deepEqual(tokenAtCaret("Draft #Fa", 9), { marker: "#", query: "Fa", start: 6 });
  assert.deepEqual(tokenAtCaret("Ping @", 6), { marker: "@", query: "", start: 5 });
  assert.equal(tokenAtCaret("Draft email", 11), null);
  assert.equal(tokenAtCaret("a#b", 3), null, "a # inside a word isn't a token");
  const done = completeToken("Draft #Fa now", { marker: "#", query: "Fa", start: 6 }, "Fall Campaign");
  assert.equal(done.text, "Draft #Fall Campaign now");
  assert.equal(done.caret, "Draft #Fall Campaign ".length);
});

test("repeat after completion round-trips through the stored rule", () => {
  const rule = parseRecurrence({ freq: "daily", interval: 3, from_completion: true, ends: { type: "never" } });
  assert.ok(rule?.fromCompletion);
  assert.deepEqual(recurrenceJson(rule!), { freq: "daily", interval: 3, ends: { type: "never" }, from_completion: true });
  assert.equal(describeRecurrence(rule!), "Every 3 days after completion");
  const plain = parseRecurrence({ freq: "weekly", interval: 1 });
  assert.equal(plain?.fromCompletion, undefined);
  assert.ok(!("from_completion" in (recurrenceJson(plain!) as object)));
});
