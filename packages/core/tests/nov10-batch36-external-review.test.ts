// Nov 10 batch 36: the internal approval and the external review check, in order when a task has both
// (APPROVAL-DESIGN-NOV10 with Avi's answers). Mirrors review_check_send_problem in the migration.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  externallyApproved,
  reviewComesAfterApproval,
  reviewSendGate,
  reviewerLabel,
  twoStepSteps,
} from "@alhc/core/external-review";
import type { ApprovalRound, ExternalReview, TaskApprovalInfo } from "@alhc/core/api/task-pane/model";

const round = (status: ApprovalRound["status"], decidedAt: string | null = null) =>
  ({ status, decidedAt }) as unknown as ApprovalRound;

const approval = (approverIds: string[], rounds: ApprovalRound[]): Pick<TaskApprovalInfo, "approverIds" | "rounds"> => ({
  approverIds,
  rounds,
});

test("an approval task with approvers puts the external review second", () => {
  assert.equal(reviewComesAfterApproval({ kind: "approval", approval: approval(["a"], []) }), true);
  assert.equal(reviewComesAfterApproval({ kind: "approval", approval: approval([], []) }), false);
  assert.equal(reviewComesAfterApproval({ kind: "task", approval: null }), false);
});

test("who may send the review check", () => {
  const pending = approval(["al"], [round("pending")]);
  const approved = approval(["al"], [round("approved", "2026-11-10T10:00:00Z")]);
  // The assignee (an Editor, not an approver) can't, before or after.
  assert.equal(reviewSendGate({ kind: "approval", viewerRole: "editor", approval: approved }, "ed").allowed, false);
  assert.match(reviewSendGate({ kind: "approval", viewerRole: "editor", approval: approved }, "ed").reason ?? "", /only the internal approver/);
  // The approver only once the internal round is approved.
  assert.equal(reviewSendGate({ kind: "approval", viewerRole: "editor", approval: pending }, "al").allowed, false);
  assert.match(reviewSendGate({ kind: "approval", viewerRole: "editor", approval: pending }, "al").reason ?? "", /Approve the task first/);
  assert.equal(reviewSendGate({ kind: "approval", viewerRole: "commenter", approval: approved }, "al").allowed, true);
  // An approver lowered to Viewer can't.
  assert.equal(reviewSendGate({ kind: "approval", viewerRole: "viewer", approval: approved }, "al").allowed, false);
  // Anywhere else: Owners and Editors, any time.
  assert.deepEqual(reviewSendGate({ kind: "task", viewerRole: "editor", approval: null }, "ed"), { order: "any_time", allowed: true, reason: null });
  assert.equal(reviewSendGate({ kind: "task", viewerRole: "commenter", approval: null }, "ed").allowed, false);
});

test("the approver's steps: approve, send, they review", () => {
  const reviewer = { email: "jordan@client.com", name: "Jordan", source: "task" as const };
  const none: ExternalReview = { reviewer, saved: reviewer, latest: null };
  assert.deepEqual(
    twoStepSteps(approval(["al"], [round("pending")]), none).map((s) => s.state),
    ["current", "waiting", "waiting"],
  );
  const approvedAt = "2026-11-10T10:00:00Z";
  const afterYes = twoStepSteps(approval(["al"], [round("approved", approvedAt)]), none);
  assert.deepEqual(afterYes.map((s) => s.state), ["done", "current", "waiting"]);
  assert.equal(afterYes[1].label, "You send it to Jordan at jordan@client.com");
  const sent: ExternalReview = {
    reviewer,
    saved: reviewer,
    latest: {
      id: "rc",
      round: 1,
      status: "approved",
      recipientEmail: "jordan@client.com",
      recipientName: "Jordan",
      createdAt: "2026-11-10T11:00:00Z",
      decidedAt: "2026-11-11T09:00:00Z",
      nudgedAt: null,
    },
  };
  const done = twoStepSteps(approval(["al"], [round("approved", approvedAt)]), sent, false);
  assert.deepEqual(done.map((s) => s.state), ["done", "done", "done"]);
  assert.equal(done[2].label, "The external reviewer approved it");
  assert.equal(externallyApproved(sent), true);
  // A review from before the internal approval doesn't count as the second step.
  const early = { ...sent, latest: { ...sent.latest!, createdAt: "2026-11-09T09:00:00Z" } };
  assert.equal(twoStepSteps(approval(["al"], [round("approved", approvedAt)]), early)[1].state, "current");
});

test("reviewer labels", () => {
  assert.equal(reviewerLabel(null), "the external reviewer");
  assert.equal(reviewerLabel({ email: "a@b.co", name: null }), "a@b.co");
});
