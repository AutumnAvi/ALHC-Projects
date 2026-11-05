// Nov 3 notes, batch 19 (note 148): Timeline drags with modifier keys. A plain drag moves only the task,
// Alt pushes its dependents only as far as their links ask, Shift moves them along by the same amount.
// The vectors are suite zz49's (public.preview_dependency_move_along()).
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import {
  dependentCount,
  planDependencyShifts,
  planMoveAlong,
  signedWorkdaySteps,
  timelineDragHint,
  timelineDragHow,
  TIMELINE_DRAG_KEYS,
  type PlanLink,
  type PlanTask,
} from "@alhc/core/dependency-plan";

const SUN_THU = [0, 1, 2, 3, 4];

// The batch 16 chain: A (Sun 11-01 – Tue 11-03) → B (Wed 11-04 – Thu 11-05) → C (Thu 11-05);
// A → D start-to-start +1; A → E (completed); A → H finish-to-start +2 workdays.
function chain(): { tasks: Map<string, PlanTask>; links: PlanLink[] } {
  const list: PlanTask[] = [
    { id: "a", title: "A", startOn: "2026-11-01", dueOn: "2026-11-03" },
    { id: "b", title: "B", startOn: "2026-11-04", dueOn: "2026-11-05" },
    { id: "c", title: "C", startOn: "2026-11-05", dueOn: "2026-11-05" },
    { id: "d", title: "D", startOn: "2026-11-04", dueOn: "2026-11-04" },
    { id: "e", title: "E", startOn: "2026-11-04", dueOn: "2026-11-04", completed: true },
    { id: "h", title: "H", startOn: "2026-11-04", dueOn: "2026-11-04" },
  ];
  const links: PlanLink[] = [
    { predecessorId: "a", successorId: "b", kind: "finish_to_start", lagDays: 0 },
    { predecessorId: "b", successorId: "c", kind: "finish_to_start", lagDays: 0 },
    { predecessorId: "a", successorId: "d", kind: "start_to_start", lagDays: 1 },
    { predecessorId: "a", successorId: "e", kind: "finish_to_start", lagDays: 0 },
    { predecessorId: "a", successorId: "h", kind: "finish_to_start", lagDays: 2 },
  ];
  return { tasks: new Map(list.map((t) => [t.id, t])), links };
}

const brief = (rows: ReturnType<typeof planMoveAlong>) =>
  rows.map((r) => `${r.taskId} ${r.status} ${r.newStart ?? "-"} ${r.newDue ?? "-"} ${r.shiftDays}`).sort();

test("148: the keys pick the plan — plain = only this task, Shift = along, Alt = push as needed", () => {
  assert.equal(timelineDragHow({ shiftKey: false, altKey: false }), "only");
  assert.equal(timelineDragHow({ shiftKey: true, altKey: false }), "along");
  assert.equal(timelineDragHow({ shiftKey: false, altKey: true }), "push");
  assert.equal(timelineDragHow({ shiftKey: true, altKey: true }), "along", "Shift wins when both are held");
  assert.deepEqual(TIMELINE_DRAG_KEYS.map((k) => k.keys), ["Drag", "Shift + drag", "Alt + drag", "Esc"]);
});

test("148: Shift + drag moves the whole chain a week when the task moves a week", () => {
  const { tasks, links } = chain();
  const rows = planMoveAlong({ tasks, links, moves: [{ taskId: "a", startOn: "2026-11-08", dueOn: "2026-11-10" }], workWeek: SUN_THU });
  assert.deepEqual(brief(rows), [
    "b move 2026-11-11 2026-11-12 7",
    "c move 2026-11-12 2026-11-12 7", // chained through B
    "d move 2026-11-11 2026-11-11 7", // start-to-start follows the start
    "e skipped 2026-11-04 2026-11-04 7", // completed: listed, not moved
    "h move 2026-11-12 2026-11-12 8", // was already too early for its +2 lag: also fixed
  ]);
});

test("148: Shift + resizing the end moves only what waits on the end, keeping each gap in workdays", () => {
  const { tasks, links } = chain();
  // A's due date Tue → Thu (two workdays later); its start stays, so D (start-to-start) stays.
  const rows = planMoveAlong({ tasks, links, moves: [{ taskId: "a", dueOn: "2026-11-05" }], workWeek: SUN_THU });
  assert.deepEqual(brief(rows), [
    "b move 2026-11-08 2026-11-09 4", // Wed + 2 workdays = Sun (Fri and Sat are off); the day's gap stays
    "c move 2026-11-09 2026-11-09 4",
    "e skipped 2026-11-04 2026-11-04 4",
    "h move 2026-11-09 2026-11-09 5",
  ]);
  // The push plan (Alt) for the same change moves them only as far as the links ask.
  const push = planDependencyShifts({ tasks, links, moves: [{ taskId: "a", dueOn: "2026-11-05" }], pullEarlier: false, workWeek: SUN_THU });
  assert.deepEqual(brief(push), [
    "b move 2026-11-05 2026-11-08 1",
    "c move 2026-11-08 2026-11-08 3",
    "e skipped 2026-11-04 2026-11-04 1",
    "h move 2026-11-09 2026-11-09 5",
  ]);
});

test("148: Shift + moving earlier pulls along, never before what a link allows", () => {
  const { tasks, links } = chain();
  const rows = planMoveAlong({ tasks, links, moves: [{ taskId: "a", dueOn: "2026-11-02" }], workWeek: SUN_THU });
  assert.deepEqual(brief(rows), [
    "b move 2026-11-03 2026-11-04 -1",
    "c move 2026-11-04 2026-11-04 -1",
    "e skipped 2026-11-04 2026-11-04 -1",
    // H needs A's due + 2 workdays = Wed 11-04, where it already is: it stays.
  ]);
});

test("148: along keeps a dependent that sits across a weekend moving by workdays, not calendar days", () => {
  const tasks = new Map<string, PlanTask>([
    ["p", { id: "p", title: "P", startOn: "2026-11-09", dueOn: "2026-11-09" }], // Mon
    ["q", { id: "q", title: "Q", startOn: "2026-11-11", dueOn: "2026-11-11" }], // Wed (two days' gap)
  ]);
  const links: PlanLink[] = [{ predecessorId: "p", successorId: "q", kind: "finish_to_start", lagDays: 0 }];
  // P one day earlier (Sun): Q one workday earlier (Tue).
  assert.deepEqual(brief(planMoveAlong({ tasks, links, moves: [{ taskId: "p", startOn: "2026-11-08", dueOn: "2026-11-08" }], workWeek: SUN_THU })), [
    "q move 2026-11-10 2026-11-10 -1",
  ]);
  // P to Thursday (three workdays later): Q three workdays later — Thu, Sun, Mon (one workday's gap kept).
  assert.deepEqual(brief(planMoveAlong({ tasks, links, moves: [{ taskId: "p", startOn: "2026-11-12", dueOn: "2026-11-12" }], workWeek: SUN_THU })), [
    "q move 2026-11-16 2026-11-16 5",
  ]);
  // Every day a workday: calendar days.
  assert.deepEqual(brief(planMoveAlong({ tasks, links, moves: [{ taskId: "p", startOn: "2026-11-12", dueOn: "2026-11-12" }], workWeek: [0, 1, 2, 3, 4, 5, 6] })), [
    "q move 2026-11-14 2026-11-14 3",
  ]);
  assert.equal(signedWorkdaySteps("2026-11-09", "2026-11-08", SUN_THU), -1);
  assert.equal(signedWorkdaySteps("2026-11-05", "2026-11-08", SUN_THU), 1, "Thursday to Sunday is one workday");
});

test("148: nothing is followed through a task that can't move, and other links still hold", () => {
  const tasks = new Map<string, PlanTask>([
    ["x", { id: "x", title: "X", startOn: "2026-11-01", dueOn: "2026-11-02" }],
    ["y", { id: "y", title: "Y", startOn: "2026-11-03", dueOn: "2026-11-03", canEdit: false }],
    ["z", { id: "z", title: "Z", startOn: "2026-11-04", dueOn: "2026-11-04" }],
    ["w", { id: "w", title: "W", startOn: "2026-11-01", dueOn: "2026-11-03" }],
    ["v", { id: "v", title: "V", startOn: "2026-11-04", dueOn: "2026-11-04" }],
  ]);
  const links: PlanLink[] = [
    { predecessorId: "x", successorId: "y", kind: "finish_to_start", lagDays: 0 },
    { predecessorId: "y", successorId: "z", kind: "finish_to_start", lagDays: 0 },
    { predecessorId: "x", successorId: "v", kind: "finish_to_start", lagDays: 0 },
    { predecessorId: "w", successorId: "v", kind: "finish_to_start", lagDays: 0 }, // W doesn't move
  ];
  // X two workdays earlier: Y is read-only (listed), Z isn't reached, V can't go before W's due (Tue).
  assert.deepEqual(brief(planMoveAlong({ tasks, links, moves: [{ taskId: "x", startOn: "2026-10-28", dueOn: "2026-10-29" }], workWeek: SUN_THU })), [
    "v move 2026-11-03 2026-11-03 -1",
    "y skipped 2026-11-03 2026-11-03 -2",
  ]);
  assert.equal(dependentCount("x", links), 3);
  assert.equal(dependentCount("z", links), 0);
});

test("148: the drag hint says what will happen", () => {
  // Nov 4 notes (batch 20, 152): the hint names both directions and the tasks that move.
  const none = { movingUpstream: [], movingDownstream: [] };
  assert.match(timelineDragHint("only", { prerequisites: 0, dependents: 0, ...none }), /isn’t linked to other tasks/);
  assert.match(timelineDragHint("only", { prerequisites: 0, dependents: 3, ...none }), /Hold Shift to move the 3 tasks that depend on it along, or Alt/);
  assert.match(
    timelineDragHint("along", { prerequisites: 0, dependents: 3, movingUpstream: [], movingDownstream: ["B", "C"] }),
    /^Shift: 2 tasks that depend on it \(“B” and “C”\) also move by the same amount/,
  );
  assert.match(timelineDragHint("push", { prerequisites: 0, dependents: 1, movingUpstream: [], movingDownstream: ["B"] }), /^Alt: 1 task that depends on it \(“B”\) also moves just far enough/);
  assert.match(timelineDragHint("push", { prerequisites: 0, dependents: 2, ...none }), /none needs to move/);
});

test("148: the database plan is the same rule, and the Timeline uses the keys", () => {
  const migration = fs.readdirSync("../../supabase/migrations").find((f) => f.endsWith("nov3_batch19_a.sql"));
  const sql = fs.readFileSync(migration ? `../../supabase/migrations/${migration}` : "/tmp/b19/sql/50_timeline.sql", "utf8");
  assert.match(sql, /create or replace function public\.preview_dependency_move_along\(moves jsonb\)/);
  assert.match(sql, /public\.rule_add_days\(cur_start, shift, true, ww\)/, "shifts count workdays");
  assert.ok(!/\b(drop|delete)\b/i.test(sql.replace(/deleted_at/g, "")), "no removal keywords (no tail)");
  const view = fs.readFileSync("src/components/project/timeline-view.tsx", "utf8");
  assert.match(view, /timelineDragHow\(/, "the bar reads the keys");
  assert.match(view, /shift\.moveWith\(/, "Timeline drags go through the keyed move");
});
