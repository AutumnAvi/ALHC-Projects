"use client";

import { useState } from "react";
import { ThumbsUp } from "lucide-react";
import { displayName } from "@/components/avatar";
import { Timestamp } from "@/components/timestamp";
import { useServerAction } from "@/components/toast";
import { decideApproval, requestApproval, resubmitApproval } from "@/lib/actions";
import type { Profile, TaskDetail } from "@/lib/data";
import { hasRole } from "@/lib/roles";
import { approvalTaskRequest, parseApprovalTaskStatus } from "@/lib/task-kinds";
import { ApprovalStatusBadge } from "@/components/project/task-meta";

// Top of the pane for approval tasks. The assignee is the approver: they see Approve / Request changes /
// Reject while the request is pending (Commenter+ is enough, so this sits outside the pane's
// Editor-only fieldset). Everyone else sees where the approval stands. The database decides who may
// act (decide_approval: the approver only; resubmit / request: Editors).
export function ApprovalTaskBanner({
  task,
  profiles,
  memberId,
}: {
  task: TaskDetail;
  profiles: Profile[];
  memberId: string;
}) {
  const [pending, run] = useServerAction();
  const [note, setNote] = useState("");
  const request = approvalTaskRequest(task.kind, task.assigneeId, task.approvals);
  const status = parseApprovalTaskStatus(request?.status);
  const canEdit = hasRole(task.viewerRole, "editor");
  const assignee = profiles.find((p) => p.id === task.assigneeId);
  const assigneeName = assignee ? displayName(assignee) : "The assignee";
  const isApprover = Boolean(request) && request?.approverId === memberId;
  const completed = Boolean(task.completedAt);

  let message: string;
  if (!task.assigneeId) message = "Assign someone to ask them for their approval.";
  else if (!request) message = completed ? "No approval was requested." : `${assigneeName} hasn’t been asked to approve this yet.`;
  else if (status === "pending") message = isApprover ? "You’re asked to approve this task." : `Waiting for ${assigneeName} to approve.`;
  else if (status === "changes_requested") message = `${isApprover ? "You" : assigneeName} requested changes.`;
  else if (status === "approved") message = `${isApprover ? "You" : assigneeName} approved this.`;
  else message = `${isApprover ? "You" : assigneeName} rejected this.`;

  return (
    <section
      aria-label="Approval"
      className="mb-3 rounded-md border border-zinc-200 bg-zinc-50/70 px-3 py-2.5"
      data-approval-status={status ?? "none"}
    >
      <div className="flex flex-wrap items-center gap-2">
        <ThumbsUp className="size-4 shrink-0 text-zinc-500" aria-hidden />
        <p className="min-w-0 flex-1 text-sm text-zinc-800">{message}</p>
        {status ? <ApprovalStatusBadge status={status} /> : null}
      </div>
      {request?.decidedAt && request.decisionNote ? (
        <p className="mt-1.5 whitespace-pre-wrap rounded bg-white px-2 py-1 text-sm text-zinc-700">
          <span className="font-medium">{assigneeName}:</span> {request.decisionNote}
        </p>
      ) : null}
      {request?.decidedAt ? (
        <p className="mt-1 text-xs text-zinc-500">
          Decided <Timestamp iso={request.decidedAt} />
        </p>
      ) : null}

      {status === "pending" && isApprover ? (
        <div className="mt-2 space-y-2">
          <label htmlFor="approval-task-note" className="sr-only">
            Note for your decision
          </label>
          <input
            id="approval-task-note"
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
            maxLength={2000}
            placeholder="Add a note (optional)"
            className="control w-full"
          />
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => decideApproval(request!.id, "approved", note))}
              className="rounded-md bg-green-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-green-800 disabled:opacity-50"
            >
              Approve
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => decideApproval(request!.id, "changes_requested", note))}
              className="btn-secondary"
            >
              Request changes
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => decideApproval(request!.id, "rejected", note))}
              className="btn-secondary border-red-200 text-red-700 hover:bg-red-50"
            >
              Reject
            </button>
          </div>
        </div>
      ) : null}

      {status === "changes_requested" && canEdit ? (
        <div className="mt-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => resubmitApproval(request!.id))}
            className="btn-secondary"
          >
            Resubmit for approval
          </button>
        </div>
      ) : null}

      {!request && task.assigneeId && !completed && canEdit ? (
        <div className="mt-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => requestApproval(task.id, { approverId: task.assigneeId!, asSubtask: false }))}
            className="btn-secondary"
          >
            Ask {assigneeName} to approve
          </button>
        </div>
      ) : null}
    </section>
  );
}
