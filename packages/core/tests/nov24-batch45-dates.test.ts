// Batch 45 (Isaiah's demo, Nov 23): typed dates keep their time, and stay on the day typed in Hebron and
// US time zones. Each case runs with the process clock in Asia/Hebron, New York, and Los Angeles (Node reads
// TZ again when it changes), since the browser's clock is where the bugs lived.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDateInput,
  parseDateTimeInput,
  parseTimeInput,
  taskClockZone,
  taskTimeOf,
  taskZoneLabel,
  timeEditPatch,
  type TaskClock,
  type TimePatch,
} from "@alhc/core/date-input";
import { parseQuickAdd } from "@alhc/core/quick-add";
import { localDayOf, localTimeOf, zonedInstant } from "@alhc/core/calendar-events";

const ZONES = ["Asia/Hebron", "America/New_York", "America/Los_Angeles"] as const;
const TODAY = "2026-11-23";
const TOMORROW = "2026-11-24";

function inEachZone(run: (zone: (typeof ZONES)[number]) => void) {
  const saved = process.env.TZ;
  try {
    for (const zone of ZONES) {
      process.env.TZ = zone;
      run(zone);
    }
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}

test("the process clock really follows TZ (so the zone loops below mean something)", () => {
  const offsets: number[] = [];
  inEachZone(() => offsets.push(new Date(2027, 5, 14).getTimezoneOffset()));
  assert.deepEqual(offsets, [-180, 240, 420]);
});

// ---------------------------------------------------------------------------------------------
// Bug 1: "tomorrow at 4 p.m." dropped the time
// ---------------------------------------------------------------------------------------------

test("times typed the usual ways", () => {
  for (const [typed, want] of [
    ["4pm", "16:00"],
    ["4 PM", "16:00"],
    ["4 p.m.", "16:00"],
    ["4 P.M.", "16:00"],
    ["4:30pm", "16:30"],
    ["16:00", "16:00"],
    ["noon", "12:00"],
  ] as const) {
    assert.equal(parseTimeInput(typed), want, typed);
  }
});

test("a date box takes a time with the date (the pane's picker)", () => {
  inEachZone((zone) => {
    for (const [typed, day, time] of [
      ["tomorrow at 4 p.m.", TOMORROW, "16:00"],
      ["tomorrow at 4pm", TOMORROW, "16:00"],
      ["tomorrow 4 PM", TOMORROW, "16:00"],
      ["Tomorrow at 16:00", TOMORROW, "16:00"],
      ["tomorrow at 4:30pm", TOMORROW, "16:30"],
      ["4pm tomorrow", TOMORROW, "16:00"],
      ["June 14th, 4pm", "2026-06-14", "16:00"],
      ["Jun 14 at 9 p.m.", "2026-06-14", "21:00"],
      ["6/14 16:00", "2026-06-14", "16:00"],
      ["June 14th", "2026-06-14", null],
      ["tomorrow", TOMORROW, null],
    ] as const) {
      assert.deepEqual(parseDateTimeInput(typed, TODAY), { day, time }, `${typed} (${zone})`);
    }
    // A time alone isn't a date, and a bare hour isn't a time.
    assert.equal(parseDateTimeInput("4pm", TODAY), null);
    assert.equal(parseDateTimeInput("tomorrow at 4", TODAY), null);
  });
});

test("quick add keeps the time and takes it out of the name", () => {
  inEachZone((zone) => {
    for (const [typed, title, dueOn, dueTime] of [
      ["Call Bob tomorrow at 4 p.m.", "Call Bob", TOMORROW, "16:00"],
      ["Call Bob tomorrow at 4pm", "Call Bob", TOMORROW, "16:00"],
      ["Call Bob tomorrow 4 PM", "Call Bob", TOMORROW, "16:00"],
      ["Call Bob tomorrow 16:00", "Call Bob", TOMORROW, "16:00"],
      ["Call Bob tomorrow at 16:00", "Call Bob", TOMORROW, "16:00"],
      ["Call Bob at 4:30pm tomorrow", "Call Bob", TOMORROW, "16:30"],
      ["Call 3 vendors tomorrow at 4pm", "Call 3 vendors", TOMORROW, "16:00"],
      ["Call Bob 4pm", "Call Bob", TODAY, "16:00"],
      ["Send flyer June 14th 9pm", "Send flyer", "2027-06-14", "21:00"],
    ] as const) {
      const parsed = parseQuickAdd(typed, { today: TODAY });
      assert.deepEqual({ title: parsed.title, dueOn: parsed.dueOn, dueTime: parsed.dueTime }, { title, dueOn, dueTime }, `${typed} (${zone})`);
    }
    const parts = parseQuickAdd("Call Bob tomorrow at 4 p.m.", { today: TODAY }).parts;
    assert.deepEqual(parts.map((p) => [p.kind, p.text]), [["date", "tomorrow"], ["time", "at 4 p.m."]]);
    // Numbers that aren't times stay in the name.
    assert.deepEqual(
      (({ title, dueTime }) => ({ title, dueTime }))(parseQuickAdd("Meeting notes 9:30 slides", { today: TODAY })),
      { title: "Meeting notes 9:30 slides", dueTime: null },
    );
    // The chip's × keeps the time in the name.
    const kept = parseQuickAdd("Call Bob tomorrow at 4 p.m.", { today: TODAY, ignored: ["at 4 p.m."] });
    assert.deepEqual([kept.title, kept.dueOn, kept.dueTime], ["Call Bob at 4 p.m.", TOMORROW, null]);
  });
});

test("quick add saves the time on the person's clock and the due date stays the day typed", () => {
  inEachZone((zone) => {
    for (const time of ["00:00", "09:00", "16:00", "21:00", "23:30"]) {
      // What quickAddTask stores (due_at, time_zone), and the date the database derives from them.
      const dueAt = zonedInstant("2027-06-14", time, zone);
      assert.equal(localDayOf(dueAt, zone), "2027-06-14", `${time} in ${zone}`);
      assert.equal(localTimeOf(dueAt, zone), time, `${time} in ${zone}`);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Bug 2: "June 14th" saved June 15
// ---------------------------------------------------------------------------------------------

test("June 14th is June 14 in every zone (the parsers)", () => {
  inEachZone((zone) => {
    assert.equal(parseDateInput("June 14th", TODAY), "2026-06-14", zone);
    assert.equal(parseDateInput("june 14", TODAY), "2026-06-14", zone);
    assert.equal(parseDateInput("14th June 2027", TODAY), "2027-06-14", zone);
    // Quick add: a month and day already past this year means next year's.
    assert.equal(parseQuickAdd("Send flyer June 14th", { today: TODAY }).dueOn, "2027-06-14", zone);
  });
});

type Row = TaskClock & { dueOn: string | null; startOn: string | null };

// public.sync_task_times() (20261005060000_task_depth.sql), mirrored: dates are the local dates of the times
// in tasks.time_zone (UTC when unset); a change of zone alone re-reads both dates in the new zone.
function store(before: Row, patch: TimePatch & { dueOn?: string | null; startOn?: string | null }): Row {
  const zoneChanged = patch.timeZone !== undefined && patch.timeZone !== before.timeZone;
  const timeZone = patch.timeZone ?? before.timeZone;
  const tz = timeZone || "UTC";
  const row: Row = { ...before, ...patch, timeZone };
  for (const [at, on] of [
    ["dueAt", "dueOn"],
    ["startAt", "startOn"],
  ] as const) {
    const atChanged = at in patch && patch[at] !== before[at];
    if (atChanged || (zoneChanged && row[at])) {
      if (row[at]) row[on] = localDayOf(row[at]!, tz);
    } else if (on in patch && patch[on] !== before[on] && row[at]) {
      row[at] = row[on] ? zonedInstant(row[on]!, localTimeOf(before[at]!, tz), tz) : null;
    }
  }
  return row;
}

// A task due June 14 at 9 PM, set by someone in `setter`'s zone.
function dueNinePm(setter: string): Row {
  return { dueOn: "2027-06-14", startOn: null, dueAt: zonedInstant("2027-06-14", "21:00", setter), startAt: null, timeZone: setter };
}

test("before: the viewer's clock and zone moved a June 14 due date to June 15 (or 13)", () => {
  // The old pane: a start time written on the browser's clock with the browser's zone stamped on the task,
  // which re-read the due date in that zone.
  process.env.TZ = "Asia/Hebron";
  try {
    const task = dueNinePm("America/New_York");
    const old = store(task, { startAt: new Date("2027-06-14T08:00").toISOString(), timeZone: "Asia/Hebron" });
    assert.equal(old.dueOn, "2027-06-15", "the bug Isaiah saw: June 14th became June 15");
  } finally {
    delete process.env.TZ;
  }
});

test("after: editing times keeps every date on the day shown, whoever edits it and wherever", () => {
  inEachZone((viewer) => {
    for (const setter of ZONES) {
      const task = dueNinePm(setter);
      // Shown on the task's clock: June 14, 9:00 PM (with the zone's letters when it isn't the viewer's).
      assert.equal(taskClockZone(task, viewer), setter);
      assert.equal(taskTimeOf(task, "due", viewer), "21:00");
      assert.equal(taskZoneLabel(task, viewer) === null, setter === viewer, `${setter} seen from ${viewer}`);

      // A start time on June 14: the due date doesn't move (the task keeps its zone).
      const withStart = store(task, timeEditPatch(task, "start", "2027-06-14", "08:00", viewer));
      assert.deepEqual([withStart.startOn, withStart.dueOn], ["2027-06-14", "2027-06-14"], `${setter} → ${viewer}`);
      assert.equal(taskTimeOf(withStart, "start", viewer), "08:00");

      // The due time changed (no start time): now the viewer's, still June 14.
      for (const time of ["00:30", "16:00", "23:30"]) {
        const moved = store(task, timeEditPatch(task, "due", "2027-06-14", time, viewer));
        assert.equal(moved.dueOn, "2027-06-14", `${time}, ${setter} → ${viewer}`);
        assert.equal(taskTimeOf(moved, "due", viewer), time);
      }

      // A new date typed ("June 14th" on a task due June 20 at 9 PM): the time stays 9 PM on June 14.
      const later: Row = { ...task, dueOn: "2027-06-20", dueAt: zonedInstant("2027-06-20", "21:00", setter) };
      const typed = store(later, { dueOn: parseDateInput("June 14th 2027", TODAY) });
      assert.equal(typed.dueOn, "2027-06-14");
      assert.equal(taskTimeOf(typed, "due", viewer), "21:00");

      // Clearing a time keeps the date.
      assert.equal(store(withStart, timeEditPatch(withStart, "start", "2027-06-14", null, viewer)).dueOn, "2027-06-14");
    }
  });
});

test("after: 'June 14th 9pm' typed into the picker saves June 14 at 9 PM in every zone", () => {
  inEachZone((viewer) => {
    const parsed = parseDateTimeInput("June 14th 9pm", TODAY)!;
    const blank: Row = { dueOn: parsed.day, startOn: null, dueAt: null, startAt: null, timeZone: null };
    const saved = store(blank, timeEditPatch(blank, "due", parsed.day, parsed.time, viewer));
    assert.deepEqual([saved.dueOn, saved.timeZone, taskTimeOf(saved, "due", viewer)], ["2026-06-14", viewer, "21:00"], viewer);
    assert.equal(taskZoneLabel(saved, viewer), null);
  });
});

test("a task with a time but no zone reads on UTC, as the database does", () => {
  const legacy: Row = { dueOn: "2027-06-15", startOn: null, dueAt: "2027-06-15T01:00:00.000Z", startAt: null, timeZone: null };
  inEachZone((viewer) => {
    assert.equal(taskTimeOf(legacy, "due", viewer), "01:00");
    assert.equal(taskZoneLabel(legacy, viewer), "UTC");
    // A start time keeps the zone (UTC) instead of re-reading the due date in the viewer's.
    assert.equal(store(legacy, timeEditPatch(legacy, "start", "2027-06-14", "09:00", viewer)).dueOn, "2027-06-15");
  });
});
