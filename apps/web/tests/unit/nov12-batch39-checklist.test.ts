// Nov 12 notes, batch 39 (item 3): the My tasks checklist mounts the first screen of rows at once and the rest
// in steps; opening a task re-renders only the old and new open rows; Home's Today card gets only its tasks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CHECKLIST_FIRST_ROWS,
  CHECKLIST_ROW_STEP,
  checklistRowPropsEqual,
  mountedCounts,
  nextMountLimit,
} from "@/components/my-tasks/checklist-rows";
import { todayCardSplit } from "@alhc/core/checklist";
import { touchesHiddenMyTask } from "@alhc/core/live-patch";

test("item 3: a long checklist mounts the first rows at once, then the rest in steps until all are in", () => {
  const total = 1500;
  let limit = CHECKLIST_FIRST_ROWS;
  let steps = 0;
  while (limit < total) {
    limit = nextMountLimit(limit, total);
    steps += 1;
  }
  assert.equal(limit, total, "every row ends up mounted (find-in-page)");
  assert.equal(steps, Math.ceil((total - CHECKLIST_FIRST_ROWS) / CHECKLIST_ROW_STEP));
  // Before: 1,500 rows built on the first render. After: 40.
  assert.equal(CHECKLIST_FIRST_ROWS, 40);
});

test("item 3: the mounted rows fill the groups in order; headers still count from the data", () => {
  assert.deepEqual(mountedCounts([10, 50, 30], 40), [10, 30, 0]);
  assert.deepEqual(mountedCounts([10, 50, 30], 1000), [10, 50, 30]);
  assert.deepEqual(mountedCounts([], 40), []);
});

test("item 3: opening a task changes the props of only the old and new open rows", () => {
  const actions = {};
  const tasks = Array.from({ length: 1500 }, (_, i) => ({ id: `t${i}` }));
  const props = (task: { id: string }, openId: string | null) => ({
    task,
    done: false,
    due: null,
    today: "2026-11-12",
    prompt: false,
    isOpen: openId === task.id,
    group: "today",
    chips: false,
    actions,
  });
  const rerendered = (from: string | null, to: string | null) =>
    tasks.filter((t) => !checklistRowPropsEqual(props(t, from), props(t, to))).length;
  // Before: every row read the open task itself, so all 1,500 re-rendered.
  assert.equal(rerendered(null, "t5"), 1);
  assert.equal(rerendered("t5", "t900"), 2);
  assert.equal(rerendered("t5", "t5"), 0);
});

test("item 3: rows no longer read the open task themselves", () => {
  const source = readFileSync(new URL("../../src/components/my-tasks/checklist.tsx", import.meta.url), "utf8");
  const row = source.slice(source.indexOf("const ChecklistRow = memo("), source.indexOf("function DateChips("));
  assert.ok(!row.includes("useOpenTaskId"), "the row gets isOpen as a prop");
  assert.ok(!row.includes("useOpenTask("));
  assert.match(source, /cv-row/);
  assert.match(source, /ui-anim-row-in/, "the row just added fades in");
});

test("item 3: Home's Today card gets overdue, today, and tomorrow's tasks; the rest only as ids", () => {
  const open = [
    { id: "a", dueOn: "2026-11-01" },
    { id: "b", dueOn: "2026-11-12" },
    { id: "c", dueOn: "2026-11-13" },
    { id: "d", dueOn: "2026-11-14" },
    { id: "e", dueOn: null },
  ];
  const { shown, hiddenIds } = todayCardSplit(open, "2026-11-12");
  assert.deepEqual(shown.map((t) => t.id), ["a", "b", "c"]);
  assert.deepEqual(hiddenIds, ["d", "e"]);
});

test("item 3: a hidden task re-dated or reopened asks Home for the page; a rename doesn't", () => {
  const hidden = new Set(["d"]);
  const msg = (row: Record<string, unknown>) => ({ v: 1, table: "tasks", op: "update", at: 0, rows: [row] }) as never;
  assert.equal(touchesHiddenMyTask(msg({ id: "d", due_on: "2026-11-12", _changed: ["due_on"] }), hidden), true);
  assert.equal(touchesHiddenMyTask(msg({ id: "d", completed_at: null, _changed: ["completed_at"] }), hidden), true);
  assert.equal(touchesHiddenMyTask(msg({ id: "d", title: "x", _changed: ["title"] }), hidden), false);
  assert.equal(touchesHiddenMyTask(msg({ id: "b", due_on: "2026-11-20", _changed: ["due_on"] }), hidden), false);
});

test("item 3: Home's partial list never replaces the shared copy My tasks draws", () => {
  const source = readFileSync(new URL("../../src/components/my-tasks/use-live-my-tasks.ts", import.meta.url), "utf8");
  assert.match(source, /loadedAt !== undefined && !partial\) writeNewest/);
  const home = readFileSync(new URL("../../src/app/(app)/page.tsx", import.meta.url), "utf8");
  assert.match(home, /open=\{todayCard\.shown\}/);
  // Counts still come from the whole list.
  assert.match(home, /laterCount = open\.length/);
});
