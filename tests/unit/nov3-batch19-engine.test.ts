// Nov 3 notes, batch 19: the running-automations indicator (141), the open pane keeping itself current
// (video bugs 35.x / 37.1 / 39.x / 40.6), live project views (23.5), and the run marker's wording (35.10).
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { feedbackNotes, finishedRunsFromNotes, type FeedbackRun } from "@/lib/rule-feedback";
import {
  LINGER_MS,
  LONG_MS,
  entryStatus,
  entryTarget,
  entryTitle,
  indicatorLabel,
  indicatorVisible,
  nextTick,
  finishRunning,
  noteFinishedRuns,
  noteWriteEnded,
  resetRunning,
  runningState,
  startRunning,
  trimEntries,
  type RunningEntry,
} from "@/lib/rule-running";

const entry = (over: Partial<RunningEntry>): RunningEntry => ({
  key: "k",
  kind: "automation",
  ruleId: "r1",
  ruleName: "Triage",
  projectId: "p1",
  tasks: [{ id: "t1", title: "Flyer" }],
  taskCount: 1,
  status: "running",
  startedAt: 0,
  endedAt: null,
  detail: null,
  ...over,
});

test("141: the indicator shows only once something has run a moment, then lingers", () => {
  const quick = entry({ startedAt: 1000 });
  assert.equal(indicatorVisible([quick], 0, 1000 + LONG_MS - 1), false, "a quick run never flashes it");
  assert.equal(indicatorVisible([quick], 0, 1000 + LONG_MS), true);
  assert.equal(nextTick([quick], 0, 1000), LONG_MS, "it looks again when the run crosses LONG_MS");
  assert.equal(indicatorVisible([entry({ status: "ran", endedAt: 5000 })], 5000 + LINGER_MS, 6000), true, "lingers");
  assert.equal(indicatorVisible([entry({ status: "ran", endedAt: 5000 })], 5000 + LINGER_MS, 5000 + LINGER_MS), false);
});

test("141: labels count what's running and say Running… then Ran", () => {
  assert.equal(indicatorLabel([entry({}), entry({ key: "b" })]), "Running 2 automations…");
  assert.equal(indicatorLabel([entry({ kind: "write", ruleName: null })]), "Saving… automations may be running");
  assert.equal(indicatorLabel([entry({ status: "ran", endedAt: 1 })]), "Ran 1 automation");
  assert.equal(indicatorLabel([entry({ status: "failed", endedAt: 1 })]), "An automation failed");
  assert.equal(entryTitle(entry({})), "Automation “Triage”");
  assert.equal(entryTitle(entry({ kind: "write" })), "Your change");
  assert.equal(entryTarget(entry({})), "on “Flyer”");
  assert.equal(entryTarget(entry({ tasks: [], taskCount: 4 })), "on 4 tasks");
  assert.equal(entryStatus(entry({})), "Running…");
  assert.equal(entryStatus(entry({ status: "ran" })), "Ran");
  assert.equal(entryStatus(entry({ kind: "write" })), "Saving…");
});

test("141: the store lists a manual run once, and a slow write with what it started", () => {
  resetRunning();
  const key = startRunning({ kind: "automation", ruleId: "r1", ruleName: "Triage", projectId: "p1", tasks: [{ id: "t1", title: "Flyer" }] }, 1000);
  assert.equal(runningState().entries[0].status, "running");
  finishRunning(key, "ran", "Created 3 subtasks", 3000);
  assert.equal(runningState().entries[0].status, "ran");
  assert.ok(runningState().lingerUntil >= 3000 + LINGER_MS, "a long run lingers");
  // The feedback check reports the same run: not listed twice.
  noteFinishedRuns([{ ruleId: "r1", ruleName: "Triage", projectId: "p1", tasks: [], taskCount: 1, failed: false, detail: null }], 3500);
  assert.equal(runningState().entries.length, 1);
  // A quick write leaves nothing behind; a slow one says Saved and lingers.
  resetRunning();
  noteWriteEnded(1000, 1000 + LONG_MS - 1);
  assert.equal(runningState().entries.length, 0);
  noteWriteEnded(1000, 1000 + LONG_MS + 10);
  assert.equal(runningState().entries[0].kind, "write");
  noteFinishedRuns([{ ruleId: "r2", ruleName: "Notify", projectId: "p1", tasks: [], taskCount: 2, failed: false, detail: null }], 1000 + LONG_MS + 300);
  assert.equal(runningState().entries.length, 2, "the automations the write started join it");
  resetRunning();
});

test("141: finished entries are capped and running ones come first", () => {
  const done = Array.from({ length: 12 }, (_, i) => entry({ key: `d${i}`, status: "ran", endedAt: i }));
  const trimmed = trimEntries([...done, entry({ key: "now" })]);
  assert.equal(trimmed[0].key, "now");
  assert.equal(trimmed.length, 9);
  assert.equal(trimmed[1].key, "d11", "newest finished first");
});

test("141: feedback notes become list entries (stops other than failures stay toasts)", () => {
  const base = { ruleName: "Triage", projectId: "p1", taskTitle: "Flyer", reason: null, createdAt: "2026-11-03T10:00:00Z" };
  const runs: FeedbackRun[] = [
    { ...base, id: "a", ruleId: "r1", taskId: "t1", status: "succeeded", action: "add_comment" },
    { ...base, id: "b", ruleId: "r2", taskId: "t1", status: "failed", reason: "boom" },
    { ...base, id: "c", ruleId: "r3", taskId: "t1", status: "skipped", reason: "loop" },
  ];
  const out = finishedRunsFromNotes(feedbackNotes(runs));
  assert.deepEqual(
    out.map((r) => [r.ruleId, r.failed]),
    [
      ["r1", false],
      ["r2", true],
    ],
  );
  assert.equal(out[0].detail, "Automation “Triage” commented on “Flyer”");
});

test("141: running an automation by hand doesn't wait for the page to render again", () => {
  const actions = fs.readFileSync("src/lib/actions.ts", "utf8");
  for (const name of ["runManualRule(", "runManualRuleOnTasks("]) {
    const at = actions.indexOf(`export async function ${name}`);
    const body = actions.slice(at, actions.indexOf("\n}\n", at));
    assert.ok(body.includes("runWithoutRefresh("), `${name} answers without a refresh`);
  }
  const dialog = fs.readFileSync("src/components/task/run-rule-dialog.tsx", "utf8");
  assert.ok(dialog.includes("startRunning(") && dialog.includes("router.refresh()"), "the dialog lists the run and refreshes in the background");
  const bulk = fs.readFileSync("src/components/bulk/bulk-bar.tsx", "utf8");
  assert.ok(bulk.includes("startRunning(") && bulk.includes("router.refresh()"), "so does the bulk bar");
});

test("39.x: the open pane refetches its own task after writes and on Realtime events", () => {
  const store = fs.readFileSync("src/components/task/task-pane-store.ts", "utf8");
  assert.ok(store.includes("onRuleFeedbackRequest(() => refreshOpenTaskPanes())"), "every finished write refreshes the open pane");
  const host = fs.readFileSync("src/components/task/task-pane-host.tsx", "utf8");
  for (const table of ["comments", "task_stories", "rule_runs", "tasks"]) {
    assert.ok(host.includes(`table: "${table}"`), `the pane listens to ${table}`);
  }
  assert.ok(host.includes("maxErrors: 3"), "the tasks channel gives up on a database that doesn't publish it");
});

test("23.5: project views listen to their tasks and memberships", () => {
  const live = fs.readFileSync("src/components/project/project-live.tsx", "utf8");
  assert.ok(live.includes("home_project_id=eq.") && live.includes("project_id=eq."));
  assert.ok(live.includes('duringWrites: "skip"'), "the person's own edits aren't rendered twice");
  const page = fs.readFileSync("src/components/project/project-view-page.tsx", "utf8");
  assert.ok(page.includes("<ProjectLiveUpdates projectId={projectId} />"));
});

test("35.10: the activity line names the automation as one", () => {
  const activity = fs.readFileSync("src/components/task/task-activity.tsx", "utf8");
  const marker = activity.slice(activity.indexOf("function RunMarker"), activity.indexOf("function EmailInLine"));
  assert.ok(marker.includes("Automation “"), "Automation “X” ran · time");
});
