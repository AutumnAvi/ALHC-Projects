// Nov 10 batch 36 (APPROVAL-DESIGN-NOV10 + Avi's answers): the internal approval and the external review
// check (the email link) are two separate things. When a task has both — an approval task with approvers —
// they run in order: the internal approvers decide first, then one of them sends the review check, through
// the same Send review check screen, to the external reviewer. These rules mirror the database's
// (review_check_send_problem in 20261110010000_nov10_batch36_a.sql), which decides anyway.
import type { ExternalReview, TaskApprovalInfo } from "./api/task-pane/model";
import type { TaskKind } from "./task-kinds";
import { hasRole, type ProjectRole } from "./roles";

export const TWO_STEP_NOTE =
  "Because this task has an internal approver and an external reviewer, only the internal approver can send it to the external reviewer, and only after the internal approval is done.";

type GateTask = {
  kind: TaskKind;
  viewerRole: ProjectRole | null;
  approval: Pick<TaskApprovalInfo, "approverIds" | "rounds"> | null;
};

// An approval task with approvers: the review check comes second.
export function reviewComesAfterApproval(task: Pick<GateTask, "kind" | "approval">): boolean {
  return task.kind === "approval" && (task.approval?.approverIds.length ?? 0) > 0;
}

// Note 183: a two-stage task — an approval task with approvers AND an external reviewer (set on the task,
// the form's requester, or the latest review's address). Neither approval completes it, whatever "When it's
// approved" says; the task stays open (the green badge once the external reviewer approves) and its
// approvers or its assignee complete it. Mirrors approval_two_stage() (20261110020000_nov10b_batch37_a.sql).
export function isTwoStageApproval(
  task: Pick<GateTask, "kind" | "approval"> & { externalReview?: Pick<ExternalReview, "reviewer"> | null },
): boolean {
  return reviewComesAfterApproval(task) && Boolean(task.externalReview?.reviewer);
}

// Note 183: what "When it's approved" means on a two-stage task, said where the choice is shown.
export const TWO_STAGE_FOLLOW_UP_NOTE =
  "This task also goes to an external reviewer, so approving it never completes it or runs the step below: it stays open for the external review. After the external reviewer approves it, its approvers or its assignee complete it by hand.";

export type ReviewSendGate = {
  // "after_approval": the two-step order applies to this task.
  order: "any_time" | "after_approval";
  allowed: boolean;
  // Why not, in plain words (null when allowed).
  reason: string | null;
};

export function reviewSendGate(task: GateTask, memberId: string): ReviewSendGate {
  if (reviewComesAfterApproval(task)) {
    const approver = task.approval!.approverIds.includes(memberId) && hasRole(task.viewerRole, "commenter");
    if (!approver) {
      return {
        order: "after_approval",
        allowed: false,
        reason: "This task has an internal approver, so only the internal approver can send it to the external reviewer, after approving it.",
      };
    }
    if (task.approval!.rounds[0]?.status !== "approved") {
      return {
        order: "after_approval",
        allowed: false,
        reason: "Approve the task first. It goes to the external reviewer after the internal approval is done.",
      };
    }
    return { order: "after_approval", allowed: true, reason: null };
  }
  return hasRole(task.viewerRole, "editor")
    ? { order: "any_time", allowed: true, reason: null }
    : { order: "any_time", allowed: false, reason: "Only the project’s Owners and Editors can send a review check." };
}

// "Jordan Lee at jordan@client.com", or the address alone.
export function reviewerLabel(reviewer: { email: string; name: string | null } | null | undefined): string {
  if (!reviewer) return "the external reviewer";
  return reviewer.name ? `${reviewer.name} at ${reviewer.email}` : reviewer.email;
}

export type ReviewStep = { label: string; state: "done" | "current" | "waiting" };

// The steps the internal approver sees on their review page when the task has both: 1. you approve →
// 2. you send it to the external reviewer → 3. they review.
// `you`: the viewer is one of the internal approvers (else the steps are told from the team's side).
export function twoStepSteps(
  approval: Pick<TaskApprovalInfo, "rounds"> | null,
  review: ExternalReview | null | undefined,
  you = true,
): ReviewStep[] {
  const approved = approval?.rounds[0]?.status === "approved";
  const latest = review?.latest ?? null;
  // A round sent after the latest internal approval is this approval's external step.
  const approvedAt = approval?.rounds[0]?.decidedAt ?? null;
  const sentAfter = Boolean(approved && latest && approvedAt && latest.createdAt >= approvedAt && latest.status !== "cancelled" && latest.status !== "superseded");
  const decided = sentAfter && (latest!.status === "approved" || latest!.status === "changes_requested");
  const who = reviewerLabel(sentAfter ? { email: latest!.recipientEmail, name: latest!.recipientName } : review?.reviewer);
  return [
    { label: you ? "You approve" : "Internal approval", state: approved ? "done" : "current" },
    {
      label: you ? `You send it to ${who}` : `The approver sends it to ${who}`,
      state: !approved ? "waiting" : sentAfter ? "done" : "current",
    },
    {
      label: decided
        ? latest!.status === "approved"
          ? you ? "They approved it" : "The external reviewer approved it"
          : you ? "They asked for changes" : "The external reviewer asked for changes"
        : you ? "They review it" : "The external reviewer reviews it",
      state: decided ? "done" : sentAfter ? "current" : "waiting",
    },
  ];
}

// The latest external review was approved: the green badge in the pane and the dot in task lists.
export function externallyApproved(review: ExternalReview | null | undefined): boolean {
  return review?.latest?.status === "approved";
}
