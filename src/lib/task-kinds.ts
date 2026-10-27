// Task kinds (mirror the tasks_kind_check CHECK in 20261006070000_task_types_rollups.sql).
//   task       a normal task
//   milestone  a date-only marker: no start date (the database clears it), zero length on the critical
//              path, drawn as a diamond on the due day
//   approval   the assignee does the work and sends it with "Ready for approval"; the task's approvers
//              approve / request changes / reject (only Approve completes it; see below)

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

// Approval tasks (Oct 27 notes, batch 6): the assignee does the work and sends it with "Ready for
// approval"; the task's approvers (task_approvers) decide. The status is the latest round's
// (approval_rounds; task_approval_state() in the database):
//   not_sent           no round yet, or the last one was withdrawn
//   pending            waiting on the approvers
//   changes_requested  an approver asked for changes — back with the assignee (paused until they mark
//   rejected           the feedback received)
//   approved           approved (completes the task unless "More steps after approval" was ticked)
export const APPROVAL_TASK_STATUSES = ["not_sent", "pending", "changes_requested", "rejected", "approved"] as const;
export type ApprovalTaskStatus = (typeof APPROVAL_TASK_STATUSES)[number];

export const APPROVAL_STATUS_LABELS: Record<ApprovalTaskStatus, string> = {
  not_sent: "Not sent",
  pending: "Pending approval",
  changes_requested: "Changes requested",
  rejected: "Rejected",
  approved: "Approved",
};

export function parseApprovalTaskStatus(value: unknown): ApprovalTaskStatus | null {
  return typeof value === "string" && (APPROVAL_TASK_STATUSES as readonly string[]).includes(value)
    ? (value as ApprovalTaskStatus)
    : null;
}

// Pending = waiting on the approvers; people can't tick the task complete then (the database refuses).
export function approvalOpen(status: ApprovalTaskStatus | null) {
  return status === "pending";
}

// "Changes requested · Paused" — paused = back with the assignee, who hasn't marked the feedback received.
export function approvalStatusText(status: ApprovalTaskStatus, paused = false) {
  return paused ? `${APPROVAL_STATUS_LABELS[status]} · Paused` : APPROVAL_STATUS_LABELS[status];
}

// The view filter `approval` (validate_view_filters): any of these.
export const APPROVAL_FILTER_KEYS = [...APPROVAL_TASK_STATUSES, "paused", "waiting_on_me"] as const;
export type ApprovalFilterKey = (typeof APPROVAL_FILTER_KEYS)[number];

export const APPROVAL_FILTER_LABELS: Record<ApprovalFilterKey, string> = {
  ...APPROVAL_STATUS_LABELS,
  paused: "Paused (feedback not received yet)",
  waiting_on_me: "Waiting on me to approve",
};

export function isApprovalFilterKey(value: unknown): value is ApprovalFilterKey {
  return typeof value === "string" && (APPROVAL_FILTER_KEYS as readonly string[]).includes(value);
}

// What happens when a round is approved.
export type AfterApproval = "complete" | "move_section" | "notify";
