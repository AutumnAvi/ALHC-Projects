// Automations V2, batch 2 — business days on the workspace's workweek (mirrors rule_add_days; the same
// vectors run in supabase/tests/zz29_automations_v2_smoke.sql). Oct 19, 2026 is a Monday.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_WORK_WEEK, addWorkdays, describeWorkWeek, normalizeWorkWeek } from "@/lib/workdays";

const SUN_THU = [0, 1, 2, 3, 4];
const MON_FRI = [1, 2, 3, 4, 5];

test("the default workweek is Sunday–Thursday", () => {
  assert.deepEqual([...DEFAULT_WORK_WEEK], SUN_THU);
  assert.equal(describeWorkWeek(SUN_THU), "Sunday–Thursday");
  assert.equal(describeWorkWeek(MON_FRI), "Monday–Friday");
  assert.equal(describeWorkWeek([0, 2, 4]), "Sun, Tue, Thu");
  assert.equal(describeWorkWeek([0, 1, 2, 3, 4, 5, 6]), "Every day");
});

test("business days skip Friday and Saturday (shared vectors)", () => {
  assert.equal(addWorkdays("2026-10-22", 1, true, SUN_THU), "2026-10-25"); // Thu + 1 = Sun
  assert.equal(addWorkdays("2026-10-22", 3, true, SUN_THU), "2026-10-27"); // Thu + 3 = Tue
  assert.equal(addWorkdays("2026-10-19", 5, true, SUN_THU), "2026-10-26"); // Mon + 5 = next Mon
  assert.equal(addWorkdays("2026-10-23", 0, true, SUN_THU), "2026-10-25"); // Fri + 0 = next workday
  assert.equal(addWorkdays("2026-10-22", 0, true, SUN_THU), "2026-10-22"); // a workday + 0 = itself
  assert.equal(addWorkdays("2026-10-25", -1, true, SUN_THU), "2026-10-22"); // Sun − 1 = Thu
  assert.equal(addWorkdays("2026-10-24", -1, true, SUN_THU), "2026-10-22"); // Sat − 1 = Thu
  assert.equal(addWorkdays("2026-10-22", 3, false, SUN_THU), "2026-10-25"); // calendar days
  assert.equal(addWorkdays("2026-10-23", 1, true, MON_FRI), "2026-10-26"); // Mon–Fri: Fri + 1 = Mon
  assert.equal(addWorkdays("2026-10-23", 1, true, [0, 1, 2, 3, 4, 5, 6]), "2026-10-24"); // every day
});

test("month and year boundaries, and long spans", () => {
  assert.equal(addWorkdays("2026-12-31", 1, true, SUN_THU), "2027-01-03"); // Thu → Sun across the year
  assert.equal(addWorkdays("2026-10-19", 10, true, SUN_THU), "2026-11-02"); // two full workweeks
  assert.equal(addWorkdays("2026-10-19", -10, true, SUN_THU), "2026-10-05");
  assert.equal(addWorkdays("2028-02-28", 1, false, SUN_THU), "2028-02-29"); // leap day
});

test("bad input gives null; a bad workweek falls back to the default", () => {
  assert.equal(addWorkdays("2026-02-30", 1, true, SUN_THU), null);
  assert.equal(addWorkdays("10/22/2026", 1, true, SUN_THU), null);
  assert.equal(addWorkdays("2026-10-22", 1.5, true, SUN_THU), null);
  assert.deepEqual(normalizeWorkWeek([4, 0, 9, 2, 2, "x"]), [0, 2, 4]);
  assert.deepEqual(normalizeWorkWeek([]), SUN_THU);
  assert.deepEqual(normalizeWorkWeek(null), SUN_THU);
});
