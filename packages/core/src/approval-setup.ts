// Nov 1 notes, batch 9a (Avi's decision b): making a task an approval task opens a short, guided setup —
// 1) choose the approver(s), 2) choose what happens after approval (complete the task / move it to a
// section / just notify). "More options" holds the rest (any one vs everyone, an approval due date,
// reminders). It can be skipped and finished later from the task. Pure and server-safe (unit-tested).
export type ApprovalFollowUp = "complete" | "move_section" | "notify";

export type ApprovalSetupDraft = {
  approverIds: string[];
  followUp: ApprovalFollowUp;
  sectionId: string | null;
  mode: "any" | "all";
  dueOn: string | null;
  reminders: boolean;
};

export const APPROVAL_SETUP_STEPS = ["approvers", "after"] as const;
export type ApprovalSetupStep = (typeof APPROVAL_SETUP_STEPS)[number];

export const FOLLOW_UP_LABELS: Record<ApprovalFollowUp, { label: string; hint: string }> = {
  complete: { label: "Complete the task", hint: "Approving it finishes the task." },
  move_section: { label: "Move it to a section", hint: "For a next step, like Ready to publish. Its approvers complete it later." },
  notify: { label: "Just notify", hint: "Tell the assignee; the task stays open. Its approvers complete it later." },
};

export function defaultApprovalSetup(input?: Partial<ApprovalSetupDraft>): ApprovalSetupDraft {
  return {
    approverIds: input?.approverIds ?? [],
    followUp: input?.followUp ?? "complete",
    sectionId: input?.sectionId ?? null,
    mode: input?.mode ?? "any",
    dueOn: input?.dueOn ?? null,
    reminders: input?.reminders ?? true,
  };
}

// What stops a step from moving on (null = fine).
export function approvalSetupProblem(step: ApprovalSetupStep, draft: ApprovalSetupDraft): string | null {
  if (step === "approvers") {
    if (draft.approverIds.length === 0) return "Choose at least one approver";
    if (draft.approverIds.length > 10) return "A task can have up to 10 approvers";
    return null;
  }
  if (draft.followUp === "move_section" && !draft.sectionId) return "Choose the section to move it to";
  return null;
}

// The setup's last line, in plain words ("Ana approves it, then the task is completed.").
// Note 183: `twoStage` = it also goes to an external reviewer, so approving it never completes it.
export function approvalSetupSummary(
  draft: ApprovalSetupDraft,
  names: string[],
  sectionName?: string | null,
  twoStage = false,
): string {
  const who =
    names.length === 0
      ? "Nobody approves it yet"
      : names.length === 1
        ? `${names[0]} approves it`
        : draft.mode === "all"
          ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} all approve it`
          : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]} approves it`;
  if (twoStage) {
    return `${who}, then it goes to the external reviewer. It stays open: after their approval, its approvers or its assignee complete it.`;
  }
  const then =
    draft.followUp === "complete"
      ? "then the task is completed"
      : draft.followUp === "move_section"
        ? `then it moves to ${sectionName ? `“${sectionName}”` : "a section"}`
        : "then the assignee is notified";
  return `${who}, ${then}.`;
}
