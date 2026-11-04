"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ApprovalDecisionForm } from "@/components/task/task-approval-banner";
import { useServerAction } from "@/components/toast";
import { decideApproval } from "@/lib/actions";
import type { ApprovalRound, TaskAttachment } from "@/lib/api/task-pane/model";
import { approverReviewFiles } from "@/lib/approver-review";
import { ApproverReview } from "./approver-review";

// The /approve/<task> page's client part. Nov 4 notes (batch 25, 159): this page is where an approver
// decides (the Inbox, reminders, and emails only link here). A round with files is the full per-file
// review, with Reject below it; a round with only text shows that text and the three decisions. Once
// sent, back to the task.
export function ApproverReviewPage(props: {
  taskId: string;
  requestId: string;
  round: ApprovalRound;
  attachments: TaskAttachment[];
  backHref: string;
  recipientName?: string | null;
}) {
  const router = useRouter();
  const [pending, run] = useServerAction();
  const [rejecting, setRejecting] = useState(false);
  const { backHref, recipientName, ...rest } = props;
  const hasFiles = approverReviewFiles(rest.round, rest.attachments).length > 0;

  function decide(decision: "approved" | "changes_requested" | "rejected", note: string) {
    run(async () => {
      const result = await decideApproval(rest.requestId, decision, note || undefined);
      if (!result.error) router.push(backHref);
      return result;
    });
  }

  const finalText = rest.round.finalText ? (
    <section className="rounded-lg border border-zinc-200 bg-white px-4 py-3" data-approve-final-text="">
      <h2 className="text-xs font-medium text-zinc-500">What you’re approving</h2>
      <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-800">{rest.round.finalText}</p>
    </section>
  ) : null;

  if (!hasFiles) {
    return (
      <div className="mx-auto max-w-3xl space-y-4" data-approve-text-only="">
        {finalText}
        <ApprovalDecisionForm idPrefix={`approve-${rest.taskId}`} pending={pending} recipientName={recipientName} onDecide={decide} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      {finalText}
      <ApproverReview {...rest} variant="full" onDone={() => router.push(backHref)} />
      <div className="border-t border-zinc-200 pt-3" data-approve-reject="">
        {rejecting ? (
          <ApprovalDecisionForm
            idPrefix={`approve-reject-${rest.taskId}`}
            pending={pending}
            recipientName={recipientName}
            initialDecision="rejected"
            onCancel={() => setRejecting(false)}
            onDecide={decide}
          />
        ) : (
          <button
            type="button"
            disabled={pending}
            onClick={() => setRejecting(true)}
            className="btn-secondary border-red-200 text-red-700 hover:bg-red-50"
          >
            Reject this round…
          </button>
        )}
      </div>
    </div>
  );
}
