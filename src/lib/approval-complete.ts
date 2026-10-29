// Oct 29 notes, batch 7 (item 52): only an approval task's approvers complete it (the database refuses
// everyone else: guard_task_kind) — until its latest round is approved: then the approval has been given
// (e.g. approved with More steps) and the task completes normally again, for anyone who can edit it.
// Every complete control asks completeModeOf() what it should be:
//   complete  the ordinary Mark complete (any task that isn't an open approval task; an approval task
//             whose latest round is approved; an approver's when no round is pending; reopening a
//             completed task)
//   ready     "Ready for approval": opens the task's send flow (anyone who isn't an approver)
//   waiting   "Waiting for approval", disabled (a round is pending and the viewer has nothing to decide)
//   approve   "Approve": the viewer's own decision is open (the decision path, never a plain tick)
// Pure and server-safe: rows, the pane, the preview, and shortcuts share it.
import type { ApprovalTaskStatus, TaskKind } from "@/lib/task-kinds";

export type CompleteMode = "complete" | "ready" | "waiting" | "approve";

export type CompleteModeInput = {
  kind: TaskKind;
  completed: boolean;
  // The latest round's status (null / missing: not known — treated as not pending, not approved).
  status?: ApprovalTaskStatus | null;
  // The viewer is one of the task's active approvers (missing: not known — treated as no).
  isApprover?: boolean;
  // A pending round waits on the viewer's own decision.
  waitingOnMe?: boolean;
};

export function completeModeOf({ kind, completed, status, isApprover = false, waitingOnMe = false }: CompleteModeInput): CompleteMode {
  if (kind !== "approval" || completed) return "complete";
  // The latest round was approved: the approval has been given, so anyone who can edit it finishes it.
  if (status === "approved") return "complete";
  if (status === "pending") return waitingOnMe ? "approve" : "waiting";
  return isApprover ? "complete" : "ready";
}

// The database's reasons (guard_task_kind), word for word: bulk summaries and toasts show them.
export const READY_FOR_APPROVAL_REASON = "Only its approvers can complete an approval task. Send it with Ready for approval.";
export const WAITING_FOR_APPROVAL_REASON = "This task is waiting for approval. Only its approvers can complete it.";

// The pane's header button.
export function completeModeLabel(mode: CompleteMode, kind: TaskKind = "task"): string {
  switch (mode) {
    case "ready":
      return "Ready for approval";
    case "waiting":
      return "Waiting for approval";
    case "approve":
      return "Approve";
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
    default:
      return "Approve";
  }
}

// ⌘/Ctrl+Enter on one row: what to do instead of completing it (null = complete it as usual).
export function shortcutApprovalAction(mode: CompleteMode): "send" | "decide" | "waiting" | null {
  return mode === "ready" ? "send" : mode === "approve" ? "decide" : mode === "waiting" ? "waiting" : null;
}

// A row (List, Board, My tasks, Home, subtasks): completeModeOf() from what the row loaded.
export function rowCompleteMode(
  task: {
    kind: TaskKind;
    completedAt: string | null;
    approvalStatus?: ApprovalTaskStatus | null;
    approvalIsApprover?: boolean;
    approvalWaitingOnMe?: boolean;
  },
  completed = Boolean(task.completedAt),
): CompleteMode {
  return completeModeOf({
    kind: task.kind,
    completed,
    status: task.approvalStatus,
    isApprover: task.approvalIsApprover,
    waitingOnMe: task.approvalWaitingOnMe,
  });
}
