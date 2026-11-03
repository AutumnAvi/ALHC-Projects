// Nov 2 notes, batch 16 (items 120–126): things that only showed after a delay or a reload. Pure rules
// and stores; the database side is suite zz47 (the dependency shift vectors below are the same).
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { flattenSubtaskRows, shownSubtaskCount } from "@/components/project/inline-cells";
import { predictedDependents } from "@/components/task/dependency-shift";
import {
  finishPendingReview,
  pendingReviewsFor,
  resetReviewEventsForTests,
  reviewsReloaded,
  reviewsVersion,
  startPendingReview,
  useReviewEvents,
} from "@/components/task/review-events";
import { blockParentLabel, convertedToast } from "@/components/task/task-convert";
import { applyApprovalChange, decisionSummary, type ApprovalChange } from "@/lib/approval-optimistic";
import type { ApprovalRound, SubtaskItem, TaskApproval, TaskApprovalInfo } from "@/lib/data";
import { planDependencyShifts, rollToWorkday, workdaySteps, type PlanLink, type PlanTask } from "@/lib/dependency-plan";
import { pendingCreateResolved, unresolvedPendingCreates, type PendingCreate } from "@/lib/pending-creates";

// ---- 120 ----------------------------------------------------------------------------------------

function sub(id: string, parentId: string, done: boolean, counts: [number, number] = [0, 0]): SubtaskItem {
  return {
    id,
    parentId,
    title: id,
    completedAt: done ? "2026-11-02T10:00:00Z" : null,
    assigneeId: null,
    startOn: null,
    dueOn: null,
    kind: "task",
    sortOrder: 0,
    subtaskCount: counts[0],
    subtaskDoneCount: counts[1],
  };
}

test("120: with completed tasks hidden, the List's subtask rows hide completed subtasks (and what's under them)", () => {
  const childrenOf = new Map<string, SubtaskItem[]>([
    ["root", [sub("open", "root", false, [2, 1]), sub("done", "root", true, [1, 0])]],
    ["open", [sub("open-open", "open", false), sub("open-done", "open", true)]],
    ["done", [sub("done-open", "done", false)]],
  ]);
  const all = () => true;
  const shown = flattenSubtaskRows("root", "Root", childrenOf, all);
  assert.deepEqual(shown.map((r) => r.item.id), ["open", "open-open", "open-done", "done", "done-open"]);
  const hidden = flattenSubtaskRows("root", "Root", childrenOf, all, 1, { hideCompleted: true });
  assert.deepEqual(hidden.map((r) => r.item.id), ["open", "open-open"], "completed subtasks and their trees are left out");
  // A subtask whose own subtasks are all done has nothing to open.
  const onlyDone = new Map<string, SubtaskItem[]>([["root", [sub("a", "root", false, [2, 2])]]]);
  assert.equal(flattenSubtaskRows("root", "Root", onlyDone, all, 1, { hideCompleted: true })[0].hasChildren, false);
  assert.equal(flattenSubtaskRows("root", "Root", onlyDone, all)[0].hasChildren, true);
  assert.equal(shownSubtaskCount({ subtaskCount: 3, subtaskDoneCount: 3 }, { hideCompleted: true }), 0);
  assert.equal(shownSubtaskCount({ subtaskCount: 3, subtaskDoneCount: 1 }, { hideCompleted: true }), 2);
  assert.equal(shownSubtaskCount({ subtaskCount: 3, subtaskDoneCount: 3 }), 3);
  const list = fs.readFileSync("src/components/project/list-view.tsx", "utf8");
  assert.match(list, /hideCompleted: completionOf\(config\.filters\) === "incomplete"/, "the List follows Show completed");
});

// ---- 121 ----------------------------------------------------------------------------------------

function pending(over: Partial<PendingCreate>): PendingCreate {
  return { key: "k", scope: "s", title: "Logo", known: new Set(["old"]), savedId: null, addedAt: 0, ...over };
}

test("121: a pending row gives way to the saved one — by the id the save returned, or a new row with its title", () => {
  const items = [
    { id: "old", title: "Logo" },
    { id: "new", title: "Logo" },
  ];
  assert.equal(pendingCreateResolved(pending({}), [{ id: "old", title: "Logo" }]), false, "an older row with the same title doesn't count");
  assert.equal(pendingCreateResolved(pending({}), items), true);
  assert.equal(pendingCreateResolved(pending({ savedId: "other" }), items), false, "once the id is known, only that row counts");
  assert.equal(pendingCreateResolved(pending({ savedId: "new" }), items), true);
  // Two "Logo" rows added back to back: one saved row resolves one of them.
  const two = [pending({ key: "a" }), pending({ key: "b" })];
  assert.deepEqual(unresolvedPendingCreates("s", items, two).map((p) => p.key), ["b"]);
  assert.deepEqual(unresolvedPendingCreates("other", items, two), [], "other scopes are left alone");
});

test("121: new subtasks and tasks show at once in the pane, List, and Board", () => {
  const subtasks = fs.readFileSync("src/components/task/task-subtasks.tsx", "utf8");
  // Nov 3 notes (batch 19, 147): the create row also passes "Blocks parent".
  assert.match(subtasks, /withPendingCreate\(pendingScope, title, \(\) => createSubtask\(task\.id, title(, null, \{ blockParent \})?\)\)/);
  assert.match(subtasks, /data-pending-subtask/);
  const shared = fs.readFileSync("src/components/project/shared.tsx", "utf8");
  assert.match(shared, /withPendingCreate\(\s*pendingTaskScope\(projectId, sectionId\)/);
  for (const view of ["list-view", "board-view"]) {
    const source = fs.readFileSync(`src/components/project/${view}.tsx`, "utf8");
    assert.match(source, /<PendingTaskRows[\s\S]*position="top"/, `${view} draws pending tasks at the top`);
    assert.match(source, /<PendingTaskRows[\s\S]*position="bottom"/, `${view} and at the end`);
  }
  const actions = fs.readFileSync("src/lib/actions.ts", "utf8");
  assert.match(actions, /export async function createSubtask\([\s\S]*?Promise<ActionResult & \{ taskId\?: string \}>/, "createSubtask returns the new id");
});

// ---- 122 ----------------------------------------------------------------------------------------

test("122: a review being sent shows on the Reviews tab at once, and the tab reloads when the send lands", () => {
  resetReviewEventsForTests();
  const key = startPendingReview("t1", "client@example.com", 2);
  assert.equal(pendingReviewsFor("t1").length, 1);
  assert.equal(pendingReviewsFor("t2").length, 0);
  const before = reviewsVersion("t1");
  finishPendingReview(key, true);
  assert.equal(reviewsVersion("t1"), before + 1, "a successful send reloads the tab");
  assert.equal(pendingReviewsFor("t1")[0].settled, true, "kept until the reload is drawn");
  reviewsReloaded("t1", before);
  assert.equal(pendingReviewsFor("t1").length, 1, "an older reload doesn't drop it");
  reviewsReloaded("t1", reviewsVersion("t1"));
  assert.equal(pendingReviewsFor("t1").length, 0);
  const refused = startPendingReview("t1", "x@example.com", 1);
  finishPendingReview(refused, false);
  assert.equal(pendingReviewsFor("t1").length, 0, "a refused send goes at once");
  assert.equal(typeof useReviewEvents, "function");
  const thumbs = fs.readFileSync("src/lib/review-thumbnails.ts", "utf8");
  assert.match(thumbs, /THUMBNAIL_BUDGET_MS = 4000/, "the email waits at most a few seconds for thumbnails");
  assert.match(thumbs, /Promise\.race\(\[done, budget\]\)/);
});

// ---- 123 ----------------------------------------------------------------------------------------

test("123: Convert to main task can make the new task block the task it came from", () => {
  assert.equal(blockParentLabel("Spring flyer"), "Make this task block “Spring flyer”");
  assert.equal(blockParentLabel(null), "Make this task block the task it came from");
  assert.equal(convertedToast("Logo", "Website", "Spring flyer"), "“Logo” is now a task in Website, and blocks “Spring flyer”");
  assert.equal(convertedToast("Logo", "Website", null), "“Logo” is now a task in Website");
  const actions = fs.readFileSync("src/lib/actions.ts", "utf8");
  assert.match(actions, /rpc\("convert_subtask_to_task", \{ \.\.\.args, block_parent: true \}\)/);
});

// ---- 124 ----------------------------------------------------------------------------------------

test("124: the parent picker searches through a GET route (never queued behind other actions)", () => {
  const convert = fs.readFileSync("src/components/task/task-convert.tsx", "utf8");
  assert.ok(!/searchSubtaskParents/.test(convert), "no Server Action per keystroke");
  assert.match(convert, /searchParents\(taskId, trimmed, controller\.signal\)/);
  const search = fs.readFileSync("src/components/task/parent-search.ts", "utf8");
  assert.match(search, /\/api\/task-pane\/\$\{encodeURIComponent\(taskId\)\}\/parents\?q=/);
  assert.ok(fs.existsSync("src/app/api/task-pane/[taskId]/parents/route.ts"));
  const menu = fs.readFileSync("src/components/task/task-more-menu.tsx", "utf8");
  assert.match(menu, /prefetchParents\(task\.id\)/, "opening the … menu loads the list ahead");
});

// ---- 125 ----------------------------------------------------------------------------------------

const SUN_THU = [0, 1, 2, 3, 4];

test("125: workdays (Sunday–Thursday)", () => {
  assert.equal(rollToWorkday("2026-11-06", SUN_THU), "2026-11-08", "Friday rolls to Sunday");
  assert.equal(rollToWorkday("2026-11-05", SUN_THU), "2026-11-05");
  assert.equal(workdaySteps("2026-11-04", "2026-11-05", SUN_THU), 1);
  assert.equal(workdaySteps("2026-11-05", "2026-11-08", SUN_THU), 1, "Thursday to Sunday is one workday");
  assert.equal(workdaySteps("2026-11-05", "2026-11-05", SUN_THU), 0);
  assert.equal(workdaySteps("2026-11-05", "2026-11-08", [0, 1, 2, 3, 4, 5, 6]), 3, "all seven days: calendar days");
});

// The chain suite zz47 builds too: A (Sun 11-01 – Tue 11-03) → B (Wed 11-04 – Thu 11-05) → C (Thu 11-05);
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

const brief = (rows: ReturnType<typeof planDependencyShifts>) =>
  rows.map((r) => `${r.taskId} ${r.status} ${r.newStart ?? "-"} ${r.newDue ?? "-"} ${r.shiftDays}`).sort();

test("125: moving a task later pushes every dependent it now overlaps, chained, on workdays", () => {
  const { tasks, links } = chain();
  const later = planDependencyShifts({ tasks, links, moves: [{ taskId: "a", dueOn: "2026-11-05" }], pullEarlier: false, workWeek: SUN_THU });
  assert.deepEqual(brief(later), [
    "b move 2026-11-05 2026-11-08 1", // keeps its one workday: Thursday → Sunday
    "c move 2026-11-08 2026-11-08 3", // pushed by B (chain)
    "e skipped 2026-11-04 2026-11-04 1", // completed: listed, not moved
    "h move 2026-11-09 2026-11-09 5", // lag of 2 workdays: Thu → Sun → Mon
  ]);
  const friday = planDependencyShifts({ tasks, links, moves: [{ taskId: "a", dueOn: "2026-11-06" }], pullEarlier: false, workWeek: SUN_THU });
  assert.deepEqual(brief(friday), [
    "b move 2026-11-08 2026-11-09 4", // a Friday due date: B starts on Sunday
    "c move 2026-11-09 2026-11-09 4",
    "e skipped 2026-11-04 2026-11-04 4",
    "h move 2026-11-09 2026-11-09 5",
  ]);
});

test("125: moving earlier pulls dependents only when asked, keeping the gap and never before a link allows", () => {
  const { tasks, links } = chain();
  const move = [{ taskId: "a", dueOn: "2026-11-02" }];
  assert.deepEqual(planDependencyShifts({ tasks, links, moves: move, pullEarlier: false, workWeek: SUN_THU }), []);
  assert.deepEqual(brief(planDependencyShifts({ tasks, links, moves: move, pullEarlier: true, workWeek: SUN_THU })), [
    "b move 2026-11-03 2026-11-04 -1",
    "c move 2026-11-04 2026-11-04 -1",
    "e skipped 2026-11-04 2026-11-04 -1",
  ]);
});

test("125: a dependent already too early is pushed even when its predecessor moves earlier (every conflict resolves)", () => {
  const tasks = new Map<string, PlanTask>([
    ["f", { id: "f", title: "F", startOn: "2026-11-01", dueOn: "2026-11-09" }],
    ["g", { id: "g", title: "G", startOn: "2026-11-04", dueOn: "2026-11-04" }],
  ]);
  const links: PlanLink[] = [{ predecessorId: "f", successorId: "g", kind: "finish_to_start", lagDays: 0 }];
  const rows = planDependencyShifts({ tasks, links, moves: [{ taskId: "f", dueOn: "2026-11-05" }], pullEarlier: false, workWeek: SUN_THU });
  assert.deepEqual(brief(rows), ["g move 2026-11-05 2026-11-05 1"]);
});

test("125: Auto-shift moves the dependents on screen at once; Ask me and Off wait", () => {
  const { tasks, links } = chain();
  const plan = (moves: Parameters<typeof planDependencyShifts>[0]["moves"], pull: boolean) =>
    planDependencyShifts({ tasks, links, moves: [...moves], pullEarlier: pull, workWeek: SUN_THU });
  const moves = [{ taskId: "a", startOn: "2026-11-01", dueOn: "2026-11-05" }];
  assert.deepEqual(
    predictedDependents(moves, "auto", plan).map((m) => `${m.taskId} ${m.startOn} ${m.dueOn}`).sort(),
    ["b 2026-11-05 2026-11-08", "c 2026-11-08 2026-11-08", "h 2026-11-09 2026-11-09"],
    "completed dependents aren't drawn as moved",
  );
  assert.deepEqual(predictedDependents(moves, "ask", plan), []);
  assert.deepEqual(predictedDependents(moves, "off", plan), []);
  assert.deepEqual(predictedDependents(moves, "auto", undefined), []);
  const timeline = fs.readFileSync("src/components/project/timeline-view.tsx", "utf8");
  // Nov 3 notes (batch 19, 148): Timeline drags pick the plan with keys (moveWith + planFor) instead.
  assert.match(timeline, /shift\.moveWith\(task, dates, how, \{[\s\S]*?planFor,/, "Timeline hands its plan to the shift");
});

test("125: the database plan and the browser plan are written from one rule", () => {
  const sql = fs.readFileSync("supabase/migrations/20261102050000_nov2_batch16_a.sql", "utf8");
  assert.match(sql, /if required > cur_start then/, "any moved predecessor that asks for a later start pushes");
  assert.match(sql, /public\.rule_add_days\(next_start, span, true, ww\)/, "lengths are kept in workdays");
  assert.ok(!/\b(drop|delete)\b/i.test(sql.replace(/deleted_at/g, "")), "no removal keywords (no tail)");
});

// ---- 126 ----------------------------------------------------------------------------------------

function request(id: string, approverId: string, status: TaskApproval["status"] = "pending"): TaskApproval {
  return {
    id,
    subtaskId: null,
    approverId,
    requestedBy: "asg",
    ruleName: null,
    note: null,
    status,
    decidedAt: null,
    decisionNote: null,
    createdAt: "2026-11-02T08:00:00Z",
    roundId: "r1",
    cancelReason: null,
  };
}

function info(mode: "any" | "all", requests: TaskApproval[]): TaskApprovalInfo {
  const round: ApprovalRound = {
    id: "r1",
    number: 1,
    status: "pending",
    mode,
    finalText: null,
    attachmentIds: [],
    moreSteps: false,
    afterApproval: "complete",
    moveSectionId: null,
    moveSectionName: null,
    dueOn: null,
    sentBy: "asg",
    sentAt: "2026-11-02T08:00:00Z",
    decidedBy: null,
    decidedAt: null,
    acknowledgedAt: null,
    withdrawnAt: null,
    requests,
  };
  return { approverIds: requests.map((r) => r.approverId), mode, dueOn: null, status: "pending", paused: false, waitingOnMe: true, rounds: [round] };
}

const at = "2026-11-02T09:00:00Z";

test("126: Request changes / Reject show at once: the round ends and the task is paused", () => {
  const start = info("any", [request("q1", "ana"), request("q2", "bo")]);
  const change: ApprovalChange = { type: "decide", requestId: "q1", decision: "changes_requested", note: "Bigger logo", by: "ana", at };
  const next = applyApprovalChange(start, change);
  assert.equal(next.status, "changes_requested");
  assert.equal(next.paused, true);
  assert.equal(next.waitingOnMe, false);
  assert.equal(next.rounds[0].status, "changes_requested");
  assert.equal(next.rounds[0].requests[0].decisionNote, "Bigger logo");
  assert.equal(next.rounds[0].requests[1].status, "cancelled", "the others aren't asked any more");
  const received = applyApprovalChange(next, { type: "acknowledge", at });
  assert.equal(received.paused, false, "Feedback received un-pauses it at once");
  assert.equal(received.rounds[0].acknowledgedAt, at);
});

test("126: Approve settles a round right away for Any one; Everyone waits for the rest", () => {
  const any = applyApprovalChange(info("any", [request("q1", "ana"), request("q2", "bo")]), {
    type: "decide", requestId: "q1", decision: "approved", note: null, by: "ana", at,
  });
  assert.equal(any.status, "approved");
  const all = applyApprovalChange(info("all", [request("q1", "ana"), request("q2", "bo")]), {
    type: "decide", requestId: "q1", decision: "approved", note: null, by: "ana", at,
  });
  assert.equal(all.status, "pending", "still waiting on Bo");
  assert.equal(all.rounds[0].requests[0].status, "approved");
  const both = applyApprovalChange(all, { type: "decide", requestId: "q2", decision: "approved", note: null, by: "bo", at });
  assert.equal(both.status, "approved");
});

test("126: Withdraw and Hand off show at once; a stale action changes nothing", () => {
  const start = info("any", [request("q1", "ana")]);
  const withdrawn = applyApprovalChange(start, { type: "withdraw", at });
  assert.equal(withdrawn.status, "not_sent");
  assert.equal(withdrawn.rounds[0].status, "withdrawn");
  assert.equal(withdrawn.rounds[0].requests[0].cancelReason, "withdrawn");
  const handed = applyApprovalChange(start, { type: "hand_off", requestId: "q1", from: "ana", to: "cy", note: "Out today", at });
  assert.deepEqual(handed.approverIds, ["cy"]);
  assert.equal(handed.rounds[0].requests.find((r) => r.approverId === "cy")?.status, "pending");
  assert.equal(handed.rounds[0].requests[0].cancelReason, "handed_off");
  assert.equal(applyApprovalChange(withdrawn, { type: "decide", requestId: "q1", decision: "approved", note: null, by: "ana", at }), withdrawn);
  assert.equal(applyApprovalChange(start, { type: "acknowledge", at }), start, "nothing to mark received");
});

test("126: the decision note folds to one line after a few seconds (and opens again)", () => {
  assert.equal(decisionSummary("Ana", "changes_requested", "Make   the logo\nbigger"), "Ana requested changes: Make the logo bigger");
  assert.equal(decisionSummary("Ana", "rejected", null), "Ana rejected this");
  assert.ok(decisionSummary("Ana", "changes_requested", "x".repeat(200)).endsWith("…"));
  const banner = fs.readFileSync("src/components/task/task-approval-banner.tsx", "utf8");
  assert.match(banner, /useOptimistic\(serverInfo, applyApprovalChange\)/, "the card draws the optimistic approval");
  assert.match(banner, /setTimeout\(\(\) => setOpen\(false\), DECISION_NOTE_OPEN_MS\)/);
  assert.match(banner, /aria-expanded=\{open\}/, "the folded line opens again");
});
