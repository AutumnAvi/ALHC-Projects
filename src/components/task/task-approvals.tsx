"use client";

import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Avatar, displayName } from "@/components/avatar";
import { Timestamp } from "@/components/timestamp";
import { useServerAction } from "@/components/toast";
import { cancelApproval, decideApproval, requestApproval, resubmitApproval } from "@/lib/actions";
import type { Profile, TaskApproval, TaskDetail } from "@/lib/data";
import { hasRole } from "@/lib/roles";

export const APPROVAL_STATUS: Record<TaskApproval["status"], { label: string; className: string }> = {
  pending: { label: "Pending", className: "bg-amber-100 text-amber-800" },
  approved: { label: "Approved", className: "bg-green-100 text-green-800" },
  changes_requested: { label: "Changes requested", className: "bg-orange-100 text-orange-800" },
  rejected: { label: "Rejected", className: "bg-red-100 text-red-800" },
  cancelled: { label: "Cancelled", className: "bg-zinc-100 text-zinc-600" },
};

const inputClass =
  "field h-auto w-full py-1.5";

export function TaskApprovals({
  task,
  profiles,
  memberId,
  excludeId = null,
}: {
  task: TaskDetail;
  profiles: Profile[];
  memberId: string;
  // An approval task's own request, shown in the banner at the top of the pane instead.
  excludeId?: string | null;
}) {
  const [pending, run] = useServerAction();
  const [open, setOpen] = useState(false);
  const [approverId, setApproverId] = useState("");
  const [note, setNote] = useState("");
  const [asSubtask, setAsSubtask] = useState(true);
  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const approvals = task.approvals.filter((a) => a.id !== excludeId);
  // Requesting/cancelling needs Editor; an approver needs at least Commenter to be able to decide.
  const canEdit = hasRole(task.viewerRole, "editor");
  const approvers = profiles.filter((p) => hasRole(task.memberRoles[p.id], "commenter"));
  const nameOf = (profileId: string | null) => {
    const profile = profileId ? profilesById.get(profileId) : undefined;
    return profile ? displayName(profile) : "Someone";
  };

  return (
    <section className="mt-6" aria-labelledby="approvals-heading">
      <div className="flex items-baseline justify-between">
        <h3 id="approvals-heading" className="text-sm font-semibold text-zinc-900">
          Approvals
        </h3>
        {canEdit ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="rounded px-1.5 py-0.5 text-xs font-medium text-accent-700 hover:bg-accent-50"
          >
            {open ? "Cancel" : "Request approval"}
          </button>
        ) : null}
      </div>

      {open && canEdit ? (
        <form
          className="mt-2 space-y-2 rounded-md border border-zinc-200 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!approverId) return;
            run(async () => {
              const result = await requestApproval(task.id, {
                approverId,
                note,
                asSubtask,
                title: `Approve: ${task.title}`,
              });
              if (!result.error) {
                setOpen(false);
                setNote("");
                setApproverId("");
              }
              return result;
            });
          }}
        >
          <div>
            <label htmlFor="approval-approver" className="text-xs font-medium text-zinc-600">
              Approver
            </label>
            <select
              id="approval-approver"
              value={approverId}
              onChange={(e) => setApproverId(e.currentTarget.value)}
              className={`${inputClass} mt-1`}
              required
            >
              <option value="">Choose a person…</option>
              {approvers.map((p) => (
                <option key={p.id} value={p.id}>
                  {displayName(p)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="approval-note" className="text-xs font-medium text-zinc-600">
              Note (optional)
            </label>
            <textarea
              id="approval-note"
              value={note}
              onChange={(e) => setNote(e.currentTarget.value)}
              rows={2}
              maxLength={2000}
              className={`${inputClass} mt-1 resize-y`}
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-zinc-600">
            <input
              type="checkbox"
              checked={asSubtask}
              onChange={(e) => setAsSubtask(e.currentTarget.checked)}
              className="size-3.5 accent-zinc-900"
            />
            Track as an approval subtask
          </label>
          <button
            type="submit"
            disabled={pending || !approverId}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            Send request
          </button>
        </form>
      ) : null}

      {approvals.length === 0 && !open ? (
        <p className="mt-2 text-xs text-zinc-500">
          {excludeId ? "No other approvals requested." : "No approvals requested."}
        </p>
      ) : (
        <ul className="mt-2 space-y-2" aria-label="Approval requests">
          {approvals.map((approval) => (
            <ApprovalItem
              key={approval.id}
              approval={approval}
              approverName={nameOf(approval.approverId)}
              requesterName={approval.ruleName ? `Rule “${approval.ruleName}”` : nameOf(approval.requestedBy)}
              isApprover={approval.approverId === memberId}
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
  const [decisionNote, setDecisionNote] = useState("");
  const status = APPROVAL_STATUS[approval.status];
  const open = approval.status === "pending" || approval.status === "changes_requested";

  return (
    <li className="rounded-md border border-zinc-200 p-3" data-approval-status={approval.status}>
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-4 text-zinc-400" aria-hidden />
        <Avatar name={approverName} />
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
            onClick={() => {
              if (window.confirm("Cancel this approval request?")) run(() => cancelApproval(approval.id));
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
