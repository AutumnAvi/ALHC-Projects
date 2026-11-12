// Nov 12 notes, batch 40 (item 1): saves that keep the router's recently visited pages. A save skips the
// refresh only when the open screen shows that kind of change by itself (and its live channel is up);
// other cached pages are rendered again in the background on arrival, with the person's edits held.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  MY_TASKS_PATCHES,
  hiddenByCompletion,
  projectViewPatches,
  screensPatch,
  withoutRows,
} from "@alhc/core/patched-writes";
import { EDIT_GRACE_MS, HELD_EDIT_GRACE_MS, liveEdits, type EditStatus, type TaggedEdit } from "@alhc/core/query/task-edits";
import {
  arrivalNeedsRevalidation,
  emptyFreshness,
  notePrefetch,
  noteRendered,
  noteShown,
  noteWriteWithoutRefresh,
} from "@/lib/route-freshness";

test("item 1: a plain project view patches every kind; filters and paged sorts take kinds away", () => {
  assert.deepEqual(projectViewPatches({}, { paged: true }).sort(), ["assign", "comment", "complete", "notes", "title"]);
  // A text filter matches the name and the description.
  assert.deepEqual(projectViewPatches({ filters: { text: "flyer" } }, { paged: false }).sort(), ["assign", "comment", "complete"]);
  // Who's assigned decides an assignee filter's rows.
  assert.ok(!projectViewPatches({ filters: { assignees: ["me"] } }, { paged: false }).includes("assign"));
  // Paged groups ordered or grouped by the field: the database's pages would be out of step.
  assert.ok(!projectViewPatches({ sort: [{ key: "title", dir: "asc" }] }, { paged: true }).includes("title"));
  assert.ok(projectViewPatches({ sort: [{ key: "title", dir: "asc" }] }, { paged: false }).includes("title"));
  assert.ok(!projectViewPatches({ group_by: "assignee" }, { paged: true }).includes("assign"));
  // "Completed in the last N days" is the server's day boundary.
  assert.ok(!projectViewPatches({ filters: { completion: "completed", completed_within_days: 7 } }, { paged: false }).includes("complete"));
});

test("item 1: every mounted screen has to say it; none = refresh", () => {
  assert.equal(screensPatch([], "complete"), false);
  assert.equal(screensPatch([MY_TASKS_PATCHES], "complete"), true);
  assert.equal(screensPatch([MY_TASKS_PATCHES, ["comment"]], "complete"), false);
});

test("item 1: own settled completions leave a view whose filter drops them; totals follow", () => {
  assert.equal(hiddenByCompletion({}, "2026-11-12T10:00:00Z"), true);
  assert.equal(hiddenByCompletion({ filters: { completion: "all" } }, "2026-11-12T10:00:00Z"), false);
  assert.equal(hiddenByCompletion({ filters: { completion: "completed" } }, null), true);
  const groups = [
    { key: "a", tasks: [{ id: "1" }, { id: "2" }], total: 2 },
    { key: "b", tasks: [{ id: "3" }], total: 9 },
    { key: "c", tasks: [{ id: "4" }] },
  ];
  const after = withoutRows(groups, new Set(["2", "3", "4"]));
  // No spurious "Show 1 more": the total goes down with the row.
  assert.deepEqual(after[0], { key: "a", tasks: [{ id: "1" }], total: 1 });
  assert.deepEqual(after[1], { key: "b", tasks: [], total: 8 });
  assert.deepEqual(after[2], { key: "c", tasks: [], total: undefined });
  assert.equal(withoutRows(groups, new Set()), groups);
});

test("item 1: edits of a save without a refresh stay until cached pages render again", () => {
  const item: TaggedEdit = { token: 7, edit: { type: "complete", taskId: "t", completed: true }, at: 1_000 };
  const base = { failed: () => false, dropped: () => false, endedAt: () => 2_000 } satisfies EditStatus;
  const later = 2_000 + EDIT_GRACE_MS + 1;
  assert.equal(liveEdits([item], base, later).length, 0);
  assert.equal(liveEdits([item], { ...base, held: () => true }, later).length, 1);
  assert.equal(liveEdits([item], { ...base, held: () => true }, 2_000 + HELD_EDIT_GRACE_MS + 1).length, 0);
  // A failed write still drops them at once.
  assert.equal(liveEdits([item], { ...base, held: () => true, failed: () => true }, later).length, 0);
});

test("item 1: a page drawn from the cache after a save that kept it is rendered again (Back too)", () => {
  const state = emptyFreshness();
  noteRendered(state, "/", 0);
  noteShown(state, "/", 0);
  // Back to Home ten minutes later, nothing saved: the router's copy stands (as before).
  assert.equal(arrivalNeedsRevalidation(state, "/", 600_000), false);
  // A save without a refresh after Home's copy was rendered: render it again on arrival.
  noteWriteWithoutRefresh(state, 300_000);
  assert.equal(arrivalNeedsRevalidation(state, "/", 600_000), true);
  noteRendered(state, "/", 600_050);
  assert.equal(arrivalNeedsRevalidation(state, "/", 700_000), false);
  // A hover prefetch made just before such a save isn't fresh enough.
  assert.equal(notePrefetch(state, "/projects/p", 800_000), true);
  assert.equal(arrivalNeedsRevalidation(state, "/projects/p", 801_000), false);
  noteWriteWithoutRefresh(state, 800_500);
  assert.equal(arrivalNeedsRevalidation(state, "/projects/p", 801_000), true);
});

const src = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");

test("item 1: the common saves are wired through patchedAction; subtasks and repeating tasks refresh", () => {
  const list = src("components/project/list-view.tsx");
  assert.match(list, /patchedAction\("complete"[\s\S]*refresh: task\.recurring/);
  assert.match(list, /patchedAction\("title"/);
  assert.match(list, /patchedAction\("assign"/);
  assert.match(list, /useScreenPatches\(/);
  const pane = src("components/task/task-detail-panel.tsx");
  assert.match(pane, /patchedAction\("complete"[\s\S]*refresh: task\.isSubtask \|\| Boolean\(task\.recurrence\)/);
  const activity = src("components/task/task-activity.tsx");
  assert.match(activity, /noteCommentCountChange\(task\.id, 1\)/);
  assert.match(activity, /noteCommentCountChange\(taskId, -1\)/);
  // Home and the Inbox say nothing, so saves there refresh as before.
  assert.doesNotMatch(src("app/(app)/page.tsx"), /useScreenPatches/);
  assert.doesNotMatch(src("components/home/today-card.tsx"), /useScreenPatches/);
  // updateTask skips the refresh only for a name, assignee, or description.
  assert.match(src("lib/actions/tasks.ts"), /key === "title" \|\| key === "assigneeId" \|\| key === "notes"/);
});

test("item 1: a live message heard during a save without a refresh still refreshes once it's done", () => {
  const live = src("lib/live.ts");
  assert.match(live, /if \(refreshingWriteInFlight\(\)\) return;\s*if \(mutationInFlight\(\)\) \{\s*scheduleDeferred\(\);/);
});
