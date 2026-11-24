// Nov 24 batch 45: the task card's step track (Work → Team approver → Outside reviewer → Done), the parallel
// order's rounds and Done, the outside reminder day, and the setup's plain-English summary. Mirrors
// 20261124010000_nov24_batch45_a.sql (approval_external_done, review_nudge_due).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approvalPlanSummary,
  approvalTrack,
  currentRoles,
  outsideBelongsToRound,
  outsideReminderOn,
  type TrackTask,
} from "@alhc/core/approval-track";
import { reviewSendGate, reviewsInParallel } from "@alhc/core/external-review";
import type { ApprovalRound, ExternalReview, ExternalReviewRound, TaskApprovalInfo } from "@alhc/core/api/task-pane/model";

const names: Record<string, string> = { al: "Avi Weinreb", is: "Isaiah Rappaport", cg: "CA Green" };
const nameOf = (id: string) => names[id] ?? "Someone";

function round(n: number, status: ApprovalRound["status"], extra: Partial<ApprovalRound> = {}): ApprovalRound {
  return {
    id: `r${n}`,
    number: n,
    status,
    mode: "any",
    finalText: null,
    attachmentIds: [],
    moreSteps: false,
    afterApproval: "complete",
    moveSectionId: null,
    moveSectionName: null,
    dueOn: "2026-12-11",
    sentBy: "cg",
    sentAt: "2026-12-09T10:14:00Z",
    decidedBy: null,
    decidedAt: null,
    acknowledgedAt: null,
    withdrawnAt: null,
    requests: [],
    ...extra,
  };
}

function info(rounds: ApprovalRound[], approverIds = ["al"]): TaskApprovalInfo {
  return {
    approverIds,
    mode: "any",
    dueOn: "2026-12-11",
    status: rounds[0]?.status === "withdrawn" ? "not_sent" : ((rounds[0]?.status ?? "not_sent") as TaskApprovalInfo["status"]),
    paused: false,
    waitingOnMe: false,
    rounds,
    followUp: { afterApproval: "move_section", sectionId: "ready", reminders: true },
  };
}

function check(status: ExternalReviewRound["status"], createdAt: string, extra: Partial<ExternalReviewRound> = {}): ExternalReviewRound {
  return {
    id: "x1",
    round: 1,
    status,
    recipientEmail: "sarah.k@glenoaks-al.com",
    recipientName: "Sarah K.",
    createdAt,
    decidedAt: null,
    nudgedAt: null,
    dueOn: "2026-12-15",
    ...extra,
  };
}

const reviewer = { email: "sarah.k@glenoaks-al.com", name: "Sarah K.", source: "task" as const };
function review(order: "sequential" | "parallel", latest: ExternalReviewRound | null): ExternalReview {
  return { reviewer, saved: reviewer, plan: { order, dueOn: "2026-12-15" }, latest };
}

function task(extra: Partial<TrackTask>): TrackTask {
  return { kind: "approval", completedAt: null, assigneeId: "cg", approval: info([]), externalReview: null, ...extra };
}

const states = (t: TrackTask) => approvalTrack(t, { nameOf })!.steps.map((s) => `${s.role}:${s.state}`).join(" ");

test("plain tasks have no track; a plain task with an outside review gets Work → Outside → Done", () => {
  assert.equal(approvalTrack({ kind: "task", completedAt: null, assigneeId: null, approval: null, externalReview: null }, { nameOf }), null);
  assert.equal(approvalTrack({ kind: "milestone", completedAt: null, assigneeId: null, approval: null, externalReview: review("sequential", check("pending", "2026-12-08T09:00:00Z")) }, { nameOf }), null);
  const t: TrackTask = { kind: "task", completedAt: null, assigneeId: "cg", approval: null, externalReview: review("sequential", check("pending", "2026-12-08T09:00:00Z")) };
  const track = approvalTrack(t, { nameOf })!;
  assert.equal(track.kind, "outside");
  assert.equal(track.headline, "Outside review · round 1");
  assert.equal(states(t), "work:done outside:current done:waiting");
  assert.equal(track.steps[1].label, "Outside: Sarah");
});

test("sequential: the team first; the outside reviewer is locked until the team approves", () => {
  const sent = task({ approval: info([round(2, "pending", { requests: [{ approverId: "al", status: "pending" } as never] }), round(1, "changes_requested", { decidedAt: "2026-12-08T12:00:00Z" })]), externalReview: review("sequential", null) });
  const track = approvalTrack(sent, { nameOf })!;
  assert.equal(track.headline, "Approval · team first, then outside · round 2");
  assert.equal(states(sent), "work:done team:current outside:locked done:waiting");
  assert.equal(track.steps[1].label, "Team: Avi");
  assert.equal(track.steps[1].status, "Waiting on Avi");
  assert.equal(track.steps[1].reminderOn, "2026-12-10", "the team's reminder: the day before the approval due date");
  assert.deepEqual(track.steps[1].previous, { number: 1, status: "changes_requested", at: "2026-12-08T12:00:00Z" });
  assert.equal(track.steps[2].status, "Up next, after the team approves");
  assert.deepEqual(currentRoles(track), ["team"]);

  // Team approved, nothing sent yet: the outside step is up.
  const approved = task({ approval: info([round(2, "approved", { decidedAt: "2026-12-10T09:00:00Z" })]), externalReview: review("sequential", null) });
  assert.equal(states(approved), "work:done team:done outside:current done:waiting");
  assert.match(approvalTrack(approved, { nameOf })!.steps[2].status, /Ready to send/);

  // An old check from before the team's approval doesn't count.
  const old = task({ approval: info([round(2, "approved", { decidedAt: "2026-12-10T09:00:00Z" })]), externalReview: review("sequential", check("approved", "2026-12-01T09:00:00Z")) });
  assert.equal(states(old), "work:done team:done outside:current done:waiting");

  // Sent after the approval and approved: Done.
  const both = task({ approval: info([round(2, "approved", { decidedAt: "2026-12-10T09:00:00Z" })]), externalReview: review("sequential", check("approved", "2026-12-10T10:00:00Z")) });
  assert.equal(states(both), "work:done team:done outside:done done:done");
});

test("parallel: team and outside side by side; Done needs both in the same round", () => {
  const r = round(1, "pending", { sentAt: "2026-12-09T10:00:00Z", requests: [{ approverId: "is", status: "pending" } as never] });
  const t = task({ approval: info([r], ["is"]), externalReview: review("parallel", check("pending", "2026-12-09T10:00:05Z")) });
  const track = approvalTrack(t, { nameOf })!;
  assert.equal(track.order, "parallel");
  assert.equal(track.headline, "Approval · team and outside at the same time · round 1");
  assert.equal(states(t), "work:done team:current outside:current done:waiting");
  assert.deepEqual(currentRoles(track), ["team", "outside"]);
  assert.equal(track.steps[2].reminderOn, "2026-12-14", "the outside reminder: the day before its due date");

  // The outside reviewer approved first: still waiting on the team.
  const outsideFirst = task({ approval: info([r], ["is"]), externalReview: review("parallel", check("approved", "2026-12-09T10:00:05Z")) });
  assert.equal(states(outsideFirst), "work:done team:current outside:done done:waiting");
  // Both approved the same round: Done.
  const bothYes = task({ approval: info([round(1, "approved", { sentAt: "2026-12-09T10:00:00Z", decidedAt: "2026-12-10T08:00:00Z" })], ["is"]), externalReview: review("parallel", check("approved", "2026-12-09T10:00:05Z")) });
  assert.equal(states(bothYes), "work:done team:done outside:done done:done");
  // A previous round's outside approval doesn't count for round 2 (its outside review is still to send).
  const stale = task({
    approval: info([round(2, "approved", { sentAt: "2026-12-12T10:00:00Z", decidedAt: "2026-12-12T12:00:00Z" }), round(1, "changes_requested")], ["is"]),
    externalReview: review("parallel", check("approved", "2026-12-09T10:00:05Z")),
  });
  assert.equal(states(stale), "work:done team:done outside:current done:waiting");
});

test("parallel: changes from either side send it back for round 2 to both", () => {
  // The outside reviewer asked for changes: the team round ended (withdrawn by the database).
  const outsideChanges = task({
    approval: info([round(1, "withdrawn", { sentAt: "2026-12-09T10:00:00Z", closedReason: "outside_changes", withdrawnAt: "2026-12-10T09:00:00Z" })], ["is"]),
    externalReview: review("parallel", check("changes_requested", "2026-12-09T10:00:05Z")),
  });
  const a = approvalTrack(outsideChanges, { nameOf })!;
  assert.equal(states(outsideChanges), "work:current team:waiting outside:changes done:waiting");
  assert.match(a.steps[1].status, /outside reviewer asked for changes/);
  assert.match(a.steps[0].status, /Back with the assignee/);
  // The team asked for changes: the outside round closed (superseded, team_changes).
  const teamChanges = task({
    approval: info([round(1, "changes_requested", { sentAt: "2026-12-09T10:00:00Z", decidedAt: "2026-12-10T09:00:00Z" })], ["is"]),
    externalReview: review("parallel", check("superseded", "2026-12-09T10:00:05Z", { closedReason: "team_changes" })),
  });
  const b = approvalTrack(teamChanges, { nameOf })!;
  assert.equal(states(teamChanges), "work:current team:changes outside:waiting done:waiting");
  assert.match(b.steps[2].status, /team asked for changes/);
});

test("team only, no approvers yet, and completion", () => {
  const solo = task({ approval: info([]), externalReview: null });
  assert.equal(states(solo), "work:current team:waiting done:waiting");
  assert.equal(approvalTrack(solo, { nameOf })!.headline, "Approval · team only");
  const unset = task({ approval: info([], []) });
  assert.equal(approvalTrack(unset, { nameOf })!.steps[1].label, "Team: not set");
  const two = task({ approval: info([], ["al", "is"]) });
  assert.equal(approvalTrack(two, { nameOf })!.steps[1].label, "Team: Avi + Isaiah");
  const done = task({ completedAt: "2026-12-12T09:00:00Z", approval: info([round(1, "approved", { decidedAt: "2026-12-11T09:00:00Z" })]) });
  assert.equal(states(done), "work:done team:done done:done");
});

test("whose outside review belongs to which team round", () => {
  const r = round(2, "approved", { sentAt: "2026-12-09T10:00:00Z", decidedAt: "2026-12-10T09:00:00Z" });
  assert.equal(outsideBelongsToRound({ createdAt: "2026-12-09T10:00:05Z" }, r, "parallel"), true);
  assert.equal(outsideBelongsToRound({ createdAt: "2026-12-09T10:00:05Z" }, r, "sequential"), false, "sequential: only after the approval");
  assert.equal(outsideBelongsToRound({ createdAt: "2026-12-10T09:30:00Z" }, r, "sequential"), true);
  assert.equal(outsideBelongsToRound({ createdAt: "2026-12-10T09:30:00Z" }, round(2, "pending"), "sequential"), false);
});

test("the outside reminder day mirrors review_nudge_due", () => {
  assert.equal(outsideReminderOn({ createdAt: "2026-12-09T10:00:00Z", dueOn: "2026-12-15" }), "2026-12-14");
  assert.equal(outsideReminderOn({ createdAt: "2026-12-09T10:00:00Z", dueOn: "2026-12-09" }), "2026-12-09", "never in the first 12 hours");
  assert.equal(outsideReminderOn({ createdAt: "2026-12-09T10:00:00Z", dueOn: null }), "2026-12-10", "a day after, without a due date");
});

test("the parallel order lets Editors and approvers send the outside review any time", () => {
  const t = { kind: "approval" as const, viewerRole: "editor" as const, approval: { approverIds: ["al"], rounds: [round(1, "pending")] }, externalReview: { plan: { order: "parallel" as const, dueOn: null } } };
  assert.equal(reviewsInParallel(t), true);
  assert.equal(reviewSendGate(t, "ed").allowed, true, "an Editor, before the team approved");
  assert.equal(reviewSendGate({ ...t, viewerRole: "commenter" }, "al").allowed, true, "an approver who is a Commenter");
  assert.equal(reviewSendGate({ ...t, viewerRole: "commenter" }, "ed").allowed, false);
  assert.equal(reviewSendGate({ ...t, externalReview: { plan: { order: "sequential", dueOn: null } } }, "ed").allowed, false, "sequential unchanged");
  // Review round 1: the assignee who sends the team round (a Commenter) sends the outside review with it.
  assert.equal(reviewSendGate({ ...t, viewerRole: "commenter", assigneeId: "cy" }, "cy").allowed, true, "the assignee, a Commenter");
  assert.equal(reviewSendGate({ ...t, viewerRole: "viewer", assigneeId: "cy" }, "cy").allowed, false, "not below Commenter");
});

test("parallel: an outside review skipped at send time can still go out once the team approved (review round 2)", () => {
  const approved = task({
    approval: info([round(1, "approved", { sentAt: "2026-12-09T10:00:00Z", decidedAt: "2026-12-10T08:00:00Z" })], ["is"]),
    externalReview: review("parallel", null),
  });
  assert.equal(states(approved), "work:done team:done outside:current done:waiting");
  assert.equal(approvalTrack(approved, { nameOf })!.steps.find((s) => s.role === "outside")!.status, "Not sent yet");
  // Before the round is sent, it waits for the round.
  assert.match(states(task({ approval: info([], ["is"]), externalReview: review("parallel", null) })), /outside:waiting/);
});

test("the setup's plain-English summary", () => {
  assert.deepEqual(
    approvalPlanSummary({ approverNames: ["Avi", "Isaiah"], mode: "all", reviewerName: "Sarah", order: "parallel", after: "move_section", sectionName: "Ready to publish" }),
    {
      flow: "Work, then Team and Outside review at the same time, then Done",
      sentence: "Avi and Isaiah both approve it while Sarah reviews by email. When all three say yes, it moves to Ready to publish. If anyone asks for changes, round 2 goes to all three.",
    },
  );
  assert.equal(
    approvalPlanSummary({ approverNames: ["Avi"], mode: "any", reviewerName: "Sarah", order: "sequential", after: "complete", sectionName: null }).flow,
    "Work, then Team review, then Outside review, then Done",
  );
  assert.match(
    approvalPlanSummary({ approverNames: ["Avi", "Isaiah"], mode: "any", reviewerName: null, order: "sequential", after: "notify", sectionName: null }).sentence,
    /^Avi or Isaiah approves it\. When one of them says yes, the assignee is told\./,
  );
  assert.equal(approvalPlanSummary({ approverNames: [], mode: "any", reviewerName: null, order: "sequential", after: null, sectionName: null }).sentence, "Choose who on the team approves it.");
});
