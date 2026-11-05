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
