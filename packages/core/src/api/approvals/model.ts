// Big move 1: the approvals area's types (no database here; safe in the browser).

// What an approver decides on a request.
export type ApprovalDecision = "approved" | "changes_requested" | "rejected";

// What happens once an approval task is approved.
export type ApprovalFollowUp = "complete" | "move_section" | "notify";

// 45 / 45b. Who approves an approval task, how they decide, and by when.
export type TaskApproversInput = { approverIds: string[]; mode: "any" | "all"; dueOn: string | null };

// Ready for approval: what's being approved and what happens after.
export type SendForApprovalInput = {
  finalText: string;
  attachmentIds: string[];
  moreSteps: boolean;
  afterApproval: ApprovalFollowUp;
  moveSectionId: string | null;
};

// What sending for approval answers: the new round, and the files that went with it (the caller draws
// their email thumbnails).
export type SentForApproval = { roundId: string | undefined; files: string[] };

// Nov 1 notes, batch 9a: the guided approval setup's follow-up step.
export type ApprovalFollowUpInput = { followUp: ApprovalFollowUp; sectionId: string | null; reminders: boolean };

// Nov 18 notes (batch 44, item 3): an approval is made in one go from its setup — the kind, the approvers,
// what happens after, and (when changed) the external reviewer. `fromKind` is what the task is now; any
// failure puts it back to that, so no task is ever left a half set-up approval.
export type ApprovalTaskSetupInput = {
  fromKind: "task" | "milestone" | "approval";
  approvers: TaskApproversInput;
  followUp: ApprovalFollowUpInput;
  // Undefined: leave who the external review is meant for as it is; an email of null clears it.
  reviewer?: { email: string | null; name: string | null };
  // Nov 24 batch 45: the review order and the outside reviewer's due date (undefined: leave them as they are).
  plan?: ReviewPlanInput;
};

// Nov 24 batch 45: team first then outside (sequential) or both at the same time (parallel), and when the
// outside reviewer should answer by (task_review_settings.review_order / reviewer_due_on).
export type ReviewPlanInput = { order: "sequential" | "parallel"; dueOn: string | null };
