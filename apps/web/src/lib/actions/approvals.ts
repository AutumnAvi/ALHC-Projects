"use server";
// Big move 1: the approvals area's Server Actions, thin wrappers around packages/core/src/api/approvals/mutations.ts.
// Only what Next.js does (the request's context, work after the response) stays here.
import type {
  ApprovalDecision,
  ApprovalFollowUpInput,
  SendForApprovalInput,
  TaskApproversInput,
} from "@alhc/core/api/approvals/model";
import * as approvalsApi from "@alhc/core/api/approvals/mutations";
import type { ActionResult } from "@alhc/core/api/core/result";
import { requestReviewThumbnails } from "@/lib/review-thumbnail-request";
import { run } from "@/lib/server/action";

// ---------------------------------------------------------------------------------------------
// Approvals (state changes go through RPCs; triggers write stories, inbox items, and fire rules)
// ---------------------------------------------------------------------------------------------

export async function requestApproval(
  taskId: string,
  input: { approverId: string; note?: string; asSubtask?: boolean; title?: string },
): Promise<ActionResult> {
  return run((ctx) => approvalsApi.requestApproval(ctx, taskId, input));
}

export async function decideApproval(approvalId: string, decision: ApprovalDecision, note?: string): Promise<ActionResult> {
  return run((ctx) => approvalsApi.decideApproval(ctx, approvalId, decision, note));
}

export async function cancelApproval(approvalId: string): Promise<ActionResult> {
  return run((ctx) => approvalsApi.cancelApproval(ctx, approvalId));
}

export async function resubmitApproval(approvalId: string, note?: string): Promise<ActionResult> {
  return run((ctx) => approvalsApi.resubmitApproval(ctx, approvalId, note));
}

// 45 / 45b. Approval tasks.
export async function setTaskApprovers(taskId: string, input: TaskApproversInput): Promise<ActionResult> {
  return run((ctx) => approvalsApi.setTaskApprovers(ctx, taskId, input));
}

export async function sendForApproval(
  taskId: string,
  input: SendForApprovalInput,
): Promise<ActionResult & { roundId?: string }> {
  let roundId: string | undefined;
  let sentFiles: string[] = [];
  const result = await run(
    async (ctx) => {
      const sent = await approvalsApi.sendForApproval(ctx, taskId, input);
      roundId = sent.roundId;
      sentFiles = sent.files;
    },
    {
      beforeEmail: () =>
        // Nov 4 notes (batch 25, 160): the approvers' email shows the files. Their thumbnails (images, PDFs'
        // first pages) are drawn as the sender, through the same route as review checks (their own client;
        // reused when already drawn), before the email drain runs after the answer; a file that can't be
        // drawn in time gets a file card.
        sentFiles.length
          ? requestReviewThumbnails({
              taskId,
              expiresAt: new Date(Date.now() + 3600_000).toISOString(),
              assets: sentFiles.map((attachmentId) => ({ assetId: attachmentId, attachmentId })),
            })
          : Promise.resolve(),
    },
  );
  return result.error ? result : { roundId };
}

export async function withdrawApproval(taskId: string): Promise<ActionResult> {
  return run((ctx) => approvalsApi.withdrawApproval(ctx, taskId));
}

export async function acknowledgeApproval(taskId: string): Promise<ActionResult> {
  return run((ctx) => approvalsApi.acknowledgeApproval(ctx, taskId));
}

export async function handOffApproval(taskId: string, newApproverId: string, note: string): Promise<ActionResult> {
  return run((ctx) => approvalsApi.handOffApproval(ctx, taskId, newApproverId, note));
}

// Nov 1 notes, batch 9a: the guided approval setup's follow-up step (what happens after approval) and
// whether approvers get due-date reminders.
export async function setApprovalFollowUp(taskId: string, input: ApprovalFollowUpInput): Promise<ActionResult> {
  return run((ctx) => approvalsApi.setApprovalFollowUp(ctx, taskId, input));
}

// Nov 1 notes, batch 9a: an approval task's approver completes it.
export async function completeApprovalAsApprover(taskId: string): Promise<ActionResult> {
  return run((ctx) => approvalsApi.completeApprovalAsApprover(ctx, taskId));
}
