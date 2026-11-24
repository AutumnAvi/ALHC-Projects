"use server";
// Big move 1: the approvals area's Server Actions, thin wrappers around packages/core/src/api/approvals/mutations.ts.
// Only what Next.js does (the request's context, work after the response) stays here.
import type {
  ApprovalDecision,
  ApprovalFollowUpInput,
  ApprovalTaskSetupInput,
  ReviewPlanInput,
  SendForApprovalInput,
  TaskApproversInput,
} from "@alhc/core/api/approvals/model";
import * as approvalsApi from "@alhc/core/api/approvals/mutations";
import type { ActionResult } from "@alhc/core/api/core/result";
import type { ParallelReviewResult } from "@alhc/core/api/reviews/model";
import { requestReviewThumbnails } from "@/lib/review-thumbnail-request";
import { sendParallelReview } from "@/lib/review-send";
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

// Nov 18 notes (batch 44, item 3): the approval setup's Done — the task becomes an approval only now.
export async function setUpApprovalTask(taskId: string, input: ApprovalTaskSetupInput): Promise<ActionResult> {
  return run((ctx) => approvalsApi.setUpApprovalTask(ctx, taskId, input));
}

// Nov 24 batch 45: the review order (team first, or at the same time) and the outside reviewer's due date.
export async function setTaskReviewPlan(taskId: string, input: ReviewPlanInput): Promise<ActionResult> {
  return run((ctx) => approvalsApi.setTaskReviewPlan(ctx, { taskId, ...input }));
}

// 45 / 45b. Approval tasks.
export async function setTaskApprovers(taskId: string, input: TaskApproversInput): Promise<ActionResult> {
  return run((ctx) => approvalsApi.setTaskApprovers(ctx, taskId, input));
}

export async function sendForApproval(
  taskId: string,
  input: SendForApprovalInput,
): Promise<ActionResult & { roundId?: string; outsideReview?: ParallelReviewResult }> {
  let roundId: string | undefined;
  let sentFiles: string[] = [];
  let outsideReview: ParallelReviewResult | null = null;
  const result = await run(
    async (ctx) => {
      const sent = await approvalsApi.sendForApproval(ctx, taskId, input);
      roundId = sent.roundId;
      sentFiles = sent.files;
      // Nov 24 batch 45: reviewed at the same time (parallel order), the outside review goes out with this
      // round — its files and final text — through the same path as Send review check. Never throws: the
      // team round is already out, so a problem comes back as outsideReview.skipped.
      outsideReview = await sendParallelReview(ctx, {
        taskId,
        attachmentIds: sent.files,
        finalText: typeof input?.finalText === "string" ? input.finalText.trim() || null : null,
      });
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
  return result.error ? result : { roundId, ...(outsideReview ? { outsideReview } : {}) };
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
