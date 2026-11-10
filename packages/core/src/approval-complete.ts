// Oct 29 notes, batch 7 (item 52), as changed by Nov 1 notes, batch 9a (Avi's decision): only an approval
// task's approvers ever complete it by hand (the database refuses everyone else: guard_task_kind) — also
// once its latest round is approved (e.g. approved with More steps after approval). There is no "anyone
// can complete it" path. Every complete control asks completeModeOf() what it should be:
//   complete  the ordinary Mark complete (any task that isn't an open approval task; an approver's when no
//             round is pending, before or after an approval; reopening a completed task)
//   ready     "Ready for approval": opens the task's send flow (anyone who isn't an approver, before an
//             approval)
//   waiting   "Waiting for approval", disabled (a round is pending and the viewer has nothing to decide)
//   approve   "Approve": the viewer's own decision is open (the decision path, never a plain tick)
//   approved  "Approved", disabled: the latest round is approved and the viewer isn't an approver — it
//             explains that the approver completes it
// Note 183 (Nov 10): a two-stage task (an internal approver, then an external reviewer) is never completed
// by either approval; once the external reviewer approved it, its assignee completes it too (the database:
// approval_assignee_may_complete in 20261110020000_nov10b_batch37_a.sql).
// Pure and server-safe: rows, the pane, the preview, and shortcuts share it.
import type { ApprovalTaskStatus, TaskKind } from "./task-kinds";

export type CompleteMode = "complete" | "ready" | "waiting" | "approve" | "approved";

export type CompleteModeInput = {
  kind: TaskKind;
  completed: boolean;
  // The latest round's status (null / missing: not known — treated as not pending, not approved).
  status?: ApprovalTaskStatus | null;
  // The viewer is one of the task's active approvers (missing: not known — treated as no).
  isApprover?: boolean;
  // A pending round waits on the viewer's own decision.
  waitingOnMe?: boolean;
  // Note 183: the viewer is the task's assignee, and its latest external review was approved.
  isAssignee?: boolean;
  externallyApproved?: boolean;
};

export function completeModeOf({
  kind,
  completed,
  status,
  isApprover = false,
  waitingOnMe = false,
  isAssignee = false,
  externallyApproved = false,
}: CompleteModeInput): CompleteMode {
  if (kind !== "approval" || completed) return "complete";
  // The latest round was approved: its approvers finish it (batch 9a); everyone else is told so. Note 183:
  // after the external reviewer approved it too, so does its assignee.
  if (status === "approved") return isApprover || (isAssignee && externallyApproved) ? "complete" : "approved";
  if (status === "pending") return waitingOnMe ? "approve" : "waiting";
  return isApprover ? "complete" : "ready";
}

// The database's reasons (guard_task_kind), word for word: bulk summaries and toasts show them.
export const READY_FOR_APPROVAL_REASON = "Only its approvers can complete an approval task. Send it with Ready for approval.";
export const WAITING_FOR_APPROVAL_REASON = "This task is waiting for approval. Only its approvers can complete it.";
export const APPROVED_REASON = "This task was approved. Only its approvers can complete it.";
// Note 183: a two-stage task waiting on (or past) its external review.
export const EXTERNAL_PENDING_REASON =
  "This task was approved internally. After the external reviewer approves it, its approvers or its assignee complete it.";

// The approval banner's toasts when a row's control was stale or the viewer's role is too low: the assignee
// sends with Commenter+ (approval_can_act), an approver decides with Commenter+ (decide_approval).
export const APPROVAL_ROLE_CANT_SEND = "Your role in this project doesn’t let you send it for approval. Ask an Editor.";
export const APPROVAL_ROLE_CANT_DECIDE = "Your role in this project doesn’t let you decide approvals. Ask the project’s Owner.";

// "Ready for approval" from someone who can't send it: never "Only you or an Editor…" to the assignee.
export function cantSendMessage(viewerIsAssignee: boolean, assigneeName: string): string {
  return viewerIsAssignee ? APPROVAL_ROLE_CANT_SEND : `Only ${assigneeName} or an Editor can send it for approval`;
}

// "Approve" from someone who can't decide: still asked (their role is too low now), or no longer asked.
export function cantDecideMessage(stillAsked: boolean): string {
  return stillAsked ? APPROVAL_ROLE_CANT_DECIDE : "Your decision on this approval isn’t open anymore";
}

// The pane's header button.
export function completeModeLabel(mode: CompleteMode, kind: TaskKind = "task"): string {
  switch (mode) {
    case "ready":
      return "Ready for approval";
    case "waiting":
      return "Waiting for approval";
    case "approve":
      return "Approve";
    case "approved":
      return "Approved";
    default:
      return kind === "milestone" ? "Mark milestone complete" : "Mark complete";
  }
}

// A row's control, for screen readers: “Ready for approval: “Spring flyer”” / …
export function completeModeRowLabel(mode: Exclude<CompleteMode, "complete">, title: string): string {
  switch (mode) {
    case "ready":
      return `Ready for approval: “${title}”`;
    case "waiting":
      return `“${title}” is waiting for approval`;
    case "approved":
      return `“${title}” was approved: its approver completes it`;
    default:
      return `Approve “${title}”`;
  }
}

// The row control's tooltip.
export function completeModeTooltip(mode: Exclude<CompleteMode, "complete">): string {
  switch (mode) {
    case "ready":
      return "Ready for approval: only its approvers can complete it";
    case "waiting":
      return "Waiting for approval";
    case "approved":
      return "Approved: its approver completes it";
    default:
      return "Approve";
  }
}

// ⌘/Ctrl+Enter on one row: what to do instead of completing it (null = complete it as usual).
export function shortcutApprovalAction(mode: CompleteMode): "send" | "decide" | "waiting" | "approved" | null {
  return mode === "ready"
    ? "send"
    : mode === "approve"
      ? "decide"
      : mode === "waiting"
        ? "waiting"
        : mode === "approved"
          ? "approved"
          : null;
}

// A row (List, Board, My tasks, Home, subtasks): completeModeOf() from what the row loaded.
export function rowCompleteMode(
  task: {
    kind: TaskKind;
    completedAt: string | null;
    approvalStatus?: ApprovalTaskStatus | null;
    approvalIsApprover?: boolean;
    approvalWaitingOnMe?: boolean;
    externalApproved?: boolean;
  },
  completed = Boolean(task.completedAt),
  assignedToMe = false,
): CompleteMode {
  return completeModeOf({
    kind: task.kind,
    completed,
    status: task.approvalStatus,
    isApprover: task.approvalIsApprover,
    waitingOnMe: task.approvalWaitingOnMe,
    isAssignee: assignedToMe,
    externallyApproved: task.externalApproved,
  });
}
