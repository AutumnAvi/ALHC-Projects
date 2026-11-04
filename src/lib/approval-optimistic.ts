// Nov 2 notes (batch 16, 126): what an approval action looks like the moment it's clicked. The approval
// card draws the task's approval through this (useOptimistic), so Approve, Request changes, Reject,
// Feedback / Rejection received, Withdraw, and Hand off change the card at once; the server's answer then
// replaces it (the same rules as decide_approval, acknowledge_approval, withdraw_approval, and
// hand_off_approval: Any one — the first approval decides; Everyone — every approver; Request changes /
// Reject end the round and pause it until the feedback is marked received).

import type { TaskApproval, TaskApprovalInfo } from "@/lib/api/task-pane/model";

export type ApprovalDecision = "approved" | "changes_requested" | "rejected";

export type ApprovalChange =
  | { type: "decide"; requestId: string; decision: ApprovalDecision; note: string | null; by: string; at: string }
  | { type: "acknowledge"; at: string }
  | { type: "withdraw"; at: string }
  | { type: "hand_off"; requestId: string; from: string; to: string; note: string | null; at: string };

export function applyApprovalChange(info: TaskApprovalInfo, change: ApprovalChange): TaskApprovalInfo {
  const [latest, ...older] = info.rounds;
  if (!latest) return info;

  if (change.type === "acknowledge") {
    if (!info.paused) return info;
    return { ...info, paused: false, rounds: [{ ...latest, acknowledgedAt: change.at }, ...older] };
  }

  if (change.type === "withdraw") {
    if (latest.status !== "pending") return info;
    const requests = latest.requests.map(
      (r): TaskApproval => (r.status === "pending" ? { ...r, status: "cancelled", cancelReason: "withdrawn" } : r),
    );
    return {
      ...info,
      status: "not_sent",
      paused: false,
      waitingOnMe: false,
      rounds: [{ ...latest, status: "withdrawn", withdrawnAt: change.at, requests }, ...older],
    };
  }

  if (change.type === "hand_off") {
    if (latest.status !== "pending") return info;
    const mine = latest.requests.find((r) => r.id === change.requestId && r.status === "pending");
    if (!mine) return info;
    const requests: TaskApproval[] = latest.requests.map((r) =>
      r.id === change.requestId ? { ...r, status: "cancelled", cancelReason: "handed_off", handoffTo: change.to, handoffNote: change.note } : r,
    );
    if (!requests.some((r) => r.approverId === change.to && r.status === "pending")) {
      requests.push({
        ...mine,
        id: `pending-${change.requestId}-${change.to}`,
        approverId: change.to,
        status: "pending",
        decidedAt: null,
        decisionNote: null,
        createdAt: change.at,
        cancelReason: null,
        handoffTo: null,
        handoffNote: null,
      });
    }
    const approverIds = [...new Set(info.approverIds.map((id) => (id === change.from ? change.to : id)))];
    return { ...info, approverIds, waitingOnMe: false, rounds: [{ ...latest, requests }, ...older] };
  }

  // decide
  if (latest.status !== "pending") return info;
  const target = latest.requests.find((r) => r.id === change.requestId && r.status === "pending");
  if (!target) return info;
  const requests: TaskApproval[] = latest.requests.map((r) =>
    r.id === change.requestId ? { ...r, status: change.decision, decisionNote: change.note, decidedAt: change.at } : r,
  );
  const decided = { ...latest, requests };
  if (change.decision !== "approved") {
    // Request changes / Reject end the round; the others aren't asked any more.
    const closed = requests.map(
      (r): TaskApproval => (r.status === "pending" ? { ...r, status: "cancelled", cancelReason: "round_closed" } : r),
    );
    return {
      ...info,
      status: change.decision,
      paused: true,
      waitingOnMe: false,
      rounds: [{ ...decided, requests: closed, status: change.decision, decidedBy: change.by, decidedAt: change.at, acknowledgedAt: null }, ...older],
    };
  }
  const live = requests.filter((r) => r.status !== "cancelled");
  const settled = latest.mode === "any" || live.every((r) => r.status === "approved");
  if (!settled) return { ...info, waitingOnMe: false, rounds: [decided, ...older] };
  const closed = requests.map(
    (r): TaskApproval => (r.status === "pending" ? { ...r, status: "cancelled", cancelReason: "round_closed" } : r),
  );
  return {
    ...info,
    status: "approved",
    paused: false,
    waitingOnMe: false,
    rounds: [{ ...decided, requests: closed, status: "approved", decidedBy: change.by, decidedAt: change.at }, ...older],
  };
}

// How long the big "requested changes" / "rejected" note stays open after it appears before it folds to
// one line (it opens again with a click).
export const DECISION_NOTE_OPEN_MS = 5000;

// One line for the folded note: who, what, and the start of their note.
export function decisionSummary(name: string, decision: "changes_requested" | "rejected", note: string | null, max = 90): string {
  const what = decision === "rejected" ? "rejected this" : "requested changes";
  const text = (note ?? "").replace(/\s+/g, " ").trim();
  if (!text) return `${name} ${what}`;
  return `${name} ${what}: ${text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text}`;
}
