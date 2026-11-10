"use client";

import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { displayName } from "@alhc/core/people";
import { useConfirm } from "@/components/confirm";
import { Timestamp } from "@/components/timestamp";
import { useServerAction } from "@/components/toast";
import { cancelApproval, decideApproval, resubmitApproval } from "@/lib/actions/approvals";
import type { Profile } from "@alhc/core/api/people/model";
import type { TaskApproval, TaskDetail } from "@alhc/core/api/task-pane/model";
import { taskPermissions } from "@alhc/core/permissions";

export const APPROVAL_STATUS: Record<TaskApproval["status"], { label: string; className: string }> = {
  pending: { label: "Pending", className: "bg-amber-100 text-amber-800" },
  approved: { label: "Approved", className: "bg-green-100 text-green-800" },
  changes_requested: { label: "Changes requested", className: "bg-orange-100 text-orange-800" },
  rejected: { label: "Rejected", className: "bg-red-100 text-red-800" },
  cancelled: { label: "Cancelled", className: "bg-zinc-100 text-zinc-600" },
};

// Requests that belong to an approval task's rounds are the approval panel's, not this list's.
export function legacyApprovals(approvals: TaskApproval[], excludeId: string | null = null): TaskApproval[] {
  return approvals.filter((a) => !a.roundId && a.id !== excludeId);
}

const inputClass =
  "field h-auto w-full py-1.5";

// The pane's Approvals block: approval requests on this task that aren't part of an approval-task round
// (legacy requests and ones an automation created). An approval task's own round requests are in the
// approval row instead. Shown only when there is at least one. Nov 9 notes (180): the task's "…" menu no
// longer opens this. Nov 10 batch 36: nobody starts a new one here any more (Task type → Approval and Send
// review check cover it); existing requests are still listed and decided.
export function TaskApprovals({
  task,
  profiles,
  memberId,
  excludeId = null,
}: {
  task: TaskDetail;
  profiles: Profile[];
  memberId: string;
  // A request shown elsewhere (round requests are always left out).
  excludeId?: string | null;
}) {
  const [pending, run] = useServerAction();
  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const approvals = legacyApprovals(task.approvals, excludeId);
  // Requesting/cancelling needs Editor; an approver needs at least Commenter to be able to decide.
  const canEdit = taskPermissions(task).canEdit;
  const nameOf = (profileId: string | null) => {
    const profile = profileId ? profilesById.get(profileId) : undefined;
    return profile ? displayName(profile) : "Someone";
  };
  if (approvals.length === 0) return null;

  return (
    <section className="mt-6" aria-labelledby="approvals-heading">
      <h3 id="approvals-heading" className="text-sm font-semibold text-zinc-900">
        Approvals
      </h3>

      {approvals.length === 0 ? (
        <p className="mt-2 text-xs text-zinc-500">
          {task.kind === "approval" || excludeId ? "No other approvals requested." : "No approvals requested."}
        </p>
      ) : (
        <ul className="mt-2 space-y-2" aria-label="Approval requests">
          {approvals.map((approval) => (
            <ApprovalItem
              key={approval.id}
              approval={approval}
              approverName={nameOf(approval.approverId)}
              requesterName={approval.ruleName ? `Automation “${approval.ruleName}”` : nameOf(approval.requestedBy)}
              isApprover={approval.approverId === memberId && taskPermissions(task).canComment}
              canEdit={canEdit}
              run={run}
              pending={pending}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ApprovalItem({
  approval,
  approverName,
  requesterName,
  isApprover,
  canEdit,
  run,
  pending,
}: {
  approval: TaskApproval;
  approverName: string;
  requesterName: string;
  isApprover: boolean;
  canEdit: boolean;
  run: ReturnType<typeof useServerAction>[1];
  pending: boolean;
}) {
  const confirm = useConfirm();
  const [decisionNote, setDecisionNote] = useState("");
  const status = APPROVAL_STATUS[approval.status];
  const open = approval.status === "pending" || approval.status === "changes_requested";

  return (
    <li className="rounded-md border border-zinc-200 p-3" data-approval-status={approval.status}>
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-4 text-zinc-400" aria-hidden />
        <Avatar name={approverName} profileId={approval.approverId} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-900">{approverName}</span>
        <span className={`rounded px-1.5 py-0.5 text-2xs font-medium ${status.className}`}>{status.label}</span>
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        Requested by {requesterName} · <Timestamp iso={approval.createdAt} />
      </p>
      {approval.note ? <p className="mt-1.5 whitespace-pre-wrap text-sm text-zinc-700">{approval.note}</p> : null}
      {approval.decisionNote ? (
        <p className="mt-1.5 whitespace-pre-wrap rounded bg-zinc-50 px-2 py-1 text-sm text-zinc-700">
          <span className="font-medium">{approverName}:</span> {approval.decisionNote}
        </p>
      ) : null}

      {approval.status === "pending" && isApprover ? (
        <div className="mt-2 space-y-2">
          <label htmlFor={`decision-${approval.id}`} className="sr-only">
            Decision note
          </label>
          <input
            id={`decision-${approval.id}`}
            value={decisionNote}
            onChange={(e) => setDecisionNote(e.currentTarget.value)}
            maxLength={2000}
            placeholder="Add a note (optional)"
            className={inputClass}
          />
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => decideApproval(approval.id, "approved", decisionNote))}
              className="rounded-md bg-green-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-green-800 disabled:opacity-50"
            >
              Approve
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => decideApproval(approval.id, "changes_requested", decisionNote))}
              className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
            >
              Request changes
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => decideApproval(approval.id, "rejected", decisionNote))}
              className="rounded-md border border-red-200 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              Reject
            </button>
          </div>
        </div>
      ) : null}

      {open && canEdit ? (
        <div className="mt-2 flex gap-1.5">
          {approval.status === "changes_requested" ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => resubmitApproval(approval.id))}
              className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
            >
              Resubmit for approval
            </button>
          ) : null}
          <button
            type="button"
            disabled={pending}
            onClick={async () => {
              if (await confirm({ title: "Cancel this approval request?", confirmLabel: "Cancel request", cancelLabel: "Keep it", tone: "danger" })) {
                run(() => cancelApproval(approval.id));
              }
            }}
            className="rounded-md px-2.5 py-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-50"
          >
            Cancel request
          </button>
        </div>
      ) : null}
    </li>
  );
}
