// Nov 2 notes (batch 15, 114): the approver's review inside the task — the requester review page's
// per-file rules (review-portal.ts) for an approval round's files: each file is Approved or Has
// feedback (a note on that file), Submit waits until every file is reviewed, and the answer is derived
// (all approved → Approve; any feedback → Request changes). The decision goes through decide_approval
// (approver only, Commenter+, pending only), with each file's outcome written into its note.
import type { ApprovalRound, TaskAttachment } from "./api/task-pane/model";
import { derivedDecision, fileStatus, type FileReviews } from "./review-portal";
import type { ReviewFile } from "./review-checks";

export const MAX_DECISION_NOTE = 2000;

// The round's files the task still has, in the order they were sent.
export function approverReviewFiles(round: Pick<ApprovalRound, "attachmentIds">, attachments: readonly TaskAttachment[]): ReviewFile[] {
  const byId = new Map(attachments.map((a) => [a.id, a] as const));
  return round.attachmentIds.flatMap((id) => {
    const a = byId.get(id);
    return a ? [{ id, name: a.fileName, contentType: a.contentType, size: a.sizeBytes }] : [];
  });
}

const state = (files: FileReviews) => ({ pins: [], files });

export function approverFileStatus(fileId: string, files: FileReviews) {
  return fileStatus(fileId, state(files));
}

export function approverDecision(assets: ReviewFile[], files: FileReviews) {
  return derivedDecision(assets, state(files));
}

// The decision's note: each file's outcome, then the overall note. Cut to what decide_approval keeps.
export function approverDecisionNote(assets: ReviewFile[], files: FileReviews, overall: string): string {
  const lines = assets.map((a) => {
    const note = files[a.id]?.note.trim();
    return note ? `✗ ${a.name}: ${note}` : `✓ ${a.name}: approved`;
  });
  const text = [lines.join("\n"), overall.trim()].filter(Boolean).join("\n\n");
  return text.length > MAX_DECISION_NOTE ? `${text.slice(0, MAX_DECISION_NOTE - 1)}…` : text;
}

// This browser keeps the approver's progress per request, so closing the task doesn't lose it.
export function approverReviewStorageKey(requestId: string): string {
  return `alhc.approver-review.${requestId}`;
}

export function approverReviewHref(taskId: string): string {
  return `/approve/${taskId}`;
}

// Nov 5 note 164: an Inbox approval item (a request, a resubmission, or a due / overdue reminder) the
// viewer still has to decide goes straight to the review page — the card itself and its "Open review"
// button — never just the task. No Approve / Request changes / Reject there (note 159). A request already
// decided or cancelled, or one for someone else, opens the task as before. An item whose request couldn't
// be read (an older item without approval_id) still goes to the review page, which sends an older request
// without a round to its task and otherwise says there's nothing to review.
export type InboxApprovalItem = {
  kind: string;
  taskId: string | null;
  approval: { status: string; approverId: string } | null;
};

export function inboxReviewHref(item: InboxApprovalItem, memberId: string): string | null {
  if (item.kind !== "approval_requested" || !item.taskId) return null;
  if (item.approval && (item.approval.approverId !== memberId || item.approval.status !== "pending")) return null;
  return approverReviewHref(item.taskId);
}

export function parseStoredReview(raw: string | null): { files: FileReviews; overall: string } {
  try {
    const value = raw ? (JSON.parse(raw) as { files?: unknown; overall?: unknown }) : null;
    const files: FileReviews = {};
    if (value && value.files && typeof value.files === "object") {
      for (const [id, v] of Object.entries(value.files as Record<string, unknown>)) {
        const f = v as { approved?: unknown; note?: unknown };
        files[id] = { approved: f.approved === true, note: typeof f.note === "string" ? f.note.slice(0, 1000) : "" };
      }
    }
    return { files, overall: typeof value?.overall === "string" ? value.overall.slice(0, 1000) : "" };
  } catch {
    return { files: {}, overall: "" };
  }
}
