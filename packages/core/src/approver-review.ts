// Nov 2 notes (batch 15, 114): the approver's review inside the task — the requester review page's
// per-file rules (review-portal.ts) for an approval round's files: each file is Approved or Has
// feedback (a note on that file), Submit waits until every file is reviewed, and the answer is derived
// (all approved → Approve; any feedback → Request changes). The decision goes through decide_approval
// (approver only, Commenter+, pending only), with each file's outcome written into its note.
import type { CommentRefs } from "./api/comments/model";
import type { ApprovalRound, TaskAttachment, TaskMembership } from "./api/task-pane/model";
import { fieldChips, repeatedSharedFieldIds, type FieldChip, type FieldDef, type FieldType } from "./fields";
import { derivedDecision, fileStatus, type FileReviews } from "./review-portal";
import type { ReviewFile } from "./review-checks";
import type { Json } from "./supabase/database.types";

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

// Nov 8 note 167: what the approval review page shows about the task besides the files. Built from the
// task the viewer can already read (getTaskDetail / task_pane_rows). Comments, activity, and followers
// are not part of it — the page never sends them to the panel.
export const REVIEW_DETAIL_FIELD_LIMIT = 6;

const EMPTY_REFS: CommentRefs = { tasks: {}, projects: {} };

export type ReviewTaskDetails = {
  title: string;
  notes: string | null;
  dueOn: string | null;
  completed: boolean;
  assigneeId: string | null;
  // Projects of the task the viewer can read, in the stable order (the pane's memberships). None = private.
  projects: { id: string; name: string }[];
  sections: { projectId: string; sectionId: string | null; sections: { id: string; name: string }[] }[];
  fields: FieldDef[];
  fieldValues: Record<string, Json>;
  // Names of tasks and projects the description links to, already limited to what the viewer can open.
  refs: CommentRefs;
  // The task's files by id and name, so a name that mentions one can chip it. Nothing else about them.
  files: { id: string; name: string; contentType: string | null }[];
};

export function reviewTaskDetails(task: {
  title: string;
  notes: string | null;
  dueOn: string | null;
  completedAt: string | null;
  assigneeId: string | null;
  memberships: Pick<TaskMembership, "projectId" | "projectName" | "sectionId" | "sections">[];
  fields: FieldDef[];
  fieldValues: Record<string, Json>;
  commentRefs?: CommentRefs;
  attachments: Pick<TaskAttachment, "id" | "fileName" | "contentType">[];
}): ReviewTaskDetails {
  return {
    title: task.title,
    notes: task.notes,
    dueOn: task.dueOn,
    completed: task.completedAt !== null,
    assigneeId: task.assigneeId,
    projects: task.memberships.map((m) => ({ id: m.projectId, name: m.projectName })),
    sections: task.memberships.map((m) => ({
      projectId: m.projectId,
      sectionId: m.sectionId,
      sections: m.sections,
    })),
    fields: task.fields,
    fieldValues: task.fieldValues,
    refs: task.commentRefs ?? EMPTY_REFS,
    files: task.attachments.map((a) => ({ id: a.id, name: a.fileName, contentType: a.contentType })),
  };
}

// The collapsed line's project: the ones the viewer can open, or Private when the task has none.
export function reviewDetailProjectLabel(names: readonly string[]): string {
  if (names.length === 0) return "Private";
  if (names.length === 1) return names[0];
  return `${names[0]} +${names.length - 1}`;
}

export type ReviewDetailField = {
  id: string;
  name: string;
  fieldType: FieldType;
  boundToSections: boolean;
  chips: FieldChip[];
};

// Fields worth a line on the review page: a shared field once, pinned (Show in List and Board) ones
// first, then the rest by their order, and only when they have something to read. Capped so the files
// stay the page. A person the caller can't name is left out (no id in their place).
export function reviewDetailFields(
  details: Pick<ReviewTaskDetails, "fields" | "fieldValues" | "sections">,
  personName: (id: string) => string | null,
): { shown: ReviewDetailField[]; hidden: number } {
  // Keep the placement shown in views when a shared field is on the task more than once.
  const repeated = repeatedSharedFieldIds(details.fields, details.fieldValues, (field) => (field.showInViews ? 0 : 1));
  const ranked = details.fields
    .filter((field) => !repeated.has(field.id))
    .sort(
      (a, b) => Number(b.showInViews) - Number(a.showInViews) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
    );
  const valued: ReviewDetailField[] = [];
  for (const field of ranked) {
    const membership = details.sections.find((s) => s.projectId === field.projectId);
    const sectionName = field.boundToSections
      ? (membership?.sections.find((s) => s.id === membership.sectionId)?.name ?? null)
      : null;
    const chips = fieldChips(field, field.boundToSections ? null : details.fieldValues[field.id], {
      personName,
      sectionName,
    });
    if (chips.length === 0) continue;
    valued.push({
      id: field.id,
      name: field.name,
      fieldType: field.fieldType,
      boundToSections: field.boundToSections,
      chips,
    });
  }
  return {
    shown: valued.slice(0, REVIEW_DETAIL_FIELD_LIMIT),
    hidden: Math.max(0, valued.length - REVIEW_DETAIL_FIELD_LIMIT),
  };
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
