// Task kinds (mirror the tasks_kind_check CHECK in 20261006070000_task_types_rollups.sql).
//   task       a normal task
//   milestone  a date-only marker: no start date (the database clears it), zero length on the critical
//              path, drawn as a diamond on the due day
//   approval   the assignee is the approver: assigning opens an approval request (no approval subtask),
//              the assignee approves / requests changes / rejects; approved or rejected completes it

export const TASK_KINDS = ["task", "milestone", "approval"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const TASK_KIND_LABELS: Record<TaskKind, string> = {
  task: "Task",
  milestone: "Milestone",
  approval: "Approval",
};

export function parseTaskKind(value: unknown): TaskKind {
  return value === "milestone" || value === "approval" ? value : "task";
}

// Status of an approval task's request (approval_requests.status, cancelled ones aside).
export type ApprovalTaskStatus = "pending" | "changes_requested" | "approved" | "rejected";

export const APPROVAL_STATUS_LABELS: Record<ApprovalTaskStatus, string> = {
  pending: "Pending approval",
  changes_requested: "Changes requested",
  approved: "Approved",
  rejected: "Rejected",
};

export function parseApprovalTaskStatus(value: unknown): ApprovalTaskStatus | null {
  return value === "pending" || value === "changes_requested" || value === "approved" || value === "rejected"
    ? value
    : null;
}

// Open = still waiting on the assignee; people can't tick the task complete then.
export function approvalOpen(status: ApprovalTaskStatus | null) {
  return status === "pending" || status === "changes_requested";
}

// The request that belongs to an approval task: no approval subtask, approver = the current assignee,
// not cancelled; the latest one wins.
export function approvalTaskRequest<
  T extends { subtaskId: string | null; approverId: string; status: string; createdAt: string },
>(kind: TaskKind, assigneeId: string | null, approvals: T[]): T | null {
  if (kind !== "approval" || !assigneeId) return null;
  let latest: T | null = null;
  for (const a of approvals) {
    if (a.subtaskId !== null || a.approverId !== assigneeId || a.status === "cancelled") continue;
    if (!latest || a.createdAt > latest.createdAt) latest = a;
  }
  return latest;
}
