// Big move 1: the approvals area's writes. Approval state changes go through RPCs; triggers write stories,
// inbox items, and fire rules. Every function takes the caller's ApiContext first, validates its own input,
// writes only through ctx.db (RLS and the RPCs decide), and throws ApiError on any refusal; no Next.js here.
import type {
  ApprovalDecision,
  ApprovalFollowUpInput,
  SendForApprovalInput,
  SentForApproval,
  TaskApproversInput,
} from "./model";
import type { ApiContext } from "../core/context";
import { check } from "../core/db";
import { invalid } from "../core/errors";
import { id, optionalDate, optionalText } from "../core/validate";

// ---------------------------------------------------------------------------------------------
// Approval requests
// ---------------------------------------------------------------------------------------------

export async function requestApproval(
  ctx: ApiContext,
  taskId: string,
  input: { approverId: string; note?: string; asSubtask?: boolean; title?: string },
): Promise<void> {
  const supabase = ctx.db;
  check(
    await supabase.rpc("request_approval", {
      target_task: id(taskId),
      approver: id(input.approverId, "approver"),
      approval_note: optionalText(input.note, 2000),
      as_subtask: input.asSubtask ?? true,
      subtask_title: optionalText(input.title, 500),
    }),
  );
}

export async function decideApproval(
  ctx: ApiContext,
  approvalId: string,
  decision: ApprovalDecision,
  note?: string,
): Promise<void> {
  if (!["approved", "changes_requested", "rejected"].includes(decision)) {
    throw invalid("Unknown decision");
  }
  const supabase = ctx.db;
  check(
    await supabase.rpc("decide_approval", {
      target_approval: id(approvalId),
      decision,
      decision_note: optionalText(note, 2000),
    }),
  );
}

export async function cancelApproval(ctx: ApiContext, approvalId: string): Promise<void> {
  const supabase = ctx.db;
  check(await supabase.rpc("cancel_approval", { target_approval: id(approvalId) }));
}

export async function resubmitApproval(ctx: ApiContext, approvalId: string, note?: string): Promise<void> {
  const supabase = ctx.db;
  check(
    await supabase.rpc("resubmit_approval", {
      target_approval: id(approvalId),
      approval_note: optionalText(note, 2000),
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// 45 / 45b. Approval tasks
// ---------------------------------------------------------------------------------------------

export async function setTaskApprovers(ctx: ApiContext, taskId: string, input: TaskApproversInput): Promise<void> {
  if (!Array.isArray(input?.approverIds) || input.approverIds.length > 10) throw invalid("A task can have up to 10 approvers");
  if (input.mode !== "any" && input.mode !== "all") throw invalid("Choose how approvers decide");
  const supabase = ctx.db;
  check(
    await supabase.rpc("set_task_approvers", {
      target_task: id(taskId, "task"),
      approvers: [...new Set(input.approverIds.map((p) => id(p, "approver")))],
      approval_mode: input.mode,
      approval_due: optionalDate(input.dueOn, "approval due date"),
    }),
  );
}

// Ready for approval. Answers the new round's id and the files sent with it (the caller draws their
// thumbnails for the approvers' email).
export async function sendForApproval(ctx: ApiContext, taskId: string, input: SendForApprovalInput): Promise<SentForApproval> {
  const finalText = typeof input?.finalText === "string" ? input.finalText.trim() : "";
  if (finalText.length > 10000) throw invalid("The final text is limited to 10,000 characters");
  const files = Array.isArray(input?.attachmentIds) ? [...new Set(input.attachmentIds.map((a) => id(a, "file")))] : [];
  if (!finalText && files.length === 0) throw invalid("Add the final text or at least one file before sending for approval");
  const moreSteps = input?.moreSteps === true;
  const after = moreSteps ? (input.afterApproval === "move_section" ? "move_section" : "notify") : "complete";
  if (after === "move_section" && !input.moveSectionId) throw invalid("Choose the section to move it to");
  const supabase = ctx.db;
  const response = await supabase.rpc("send_for_approval", {
    target_task: id(taskId, "task"),
    final_text: finalText || null,
    attachment_ids: files,
    more_steps: moreSteps,
    after_approval: after,
    move_section: after === "move_section" ? id(input.moveSectionId!, "section") : null,
  });
  check(response);
  return { roundId: typeof response.data === "string" ? response.data : undefined, files };
}

export async function withdrawApproval(ctx: ApiContext, taskId: string): Promise<void> {
  const supabase = ctx.db;
  check(await supabase.rpc("withdraw_approval", { target_task: id(taskId, "task") }));
}

export async function acknowledgeApproval(ctx: ApiContext, taskId: string): Promise<void> {
  const supabase = ctx.db;
  check(await supabase.rpc("acknowledge_approval", { target_task: id(taskId, "task") }));
}

export async function handOffApproval(ctx: ApiContext, taskId: string, newApproverId: string, note: string): Promise<void> {
  const supabase = ctx.db;
  check(
    await supabase.rpc("hand_off_approval", {
      target_task: id(taskId, "task"),
      new_approver: id(newApproverId, "approver"),
      handoff_note: optionalText(note, 2000),
    }),
  );
}

// Nov 1 notes, batch 9a: the guided approval setup's follow-up step (what happens after approval) and
// whether approvers get due-date reminders. Editors+ of an approval task (set_approval_followup checks).
export async function setApprovalFollowUp(ctx: ApiContext, taskId: string, input: ApprovalFollowUpInput): Promise<void> {
  if (!["complete", "move_section", "notify"].includes(input?.followUp)) throw invalid("Choose what happens after approval");
  const supabase = ctx.db;
  const result = await supabase.rpc("set_approval_followup", {
    target_task: id(taskId, "task"),
    followup: input.followUp,
    followup_section: input.followUp === "move_section" && input.sectionId ? id(input.sectionId, "section") : null,
    send_reminders: Boolean(input.reminders),
  });
  if (result.error?.code === "PGRST202") throw invalid("The approval follow-up needs this release’s database update");
  check(result);
}

// Nov 1 notes, batch 9a: an approval task's approver completes it (approvers often have only Commenter
// access, which can't edit the task; complete_approval_as_approver checks they approve it).
export async function completeApprovalAsApprover(ctx: ApiContext, taskId: string): Promise<void> {
  const supabase = ctx.db;
  const result = await supabase.rpc("complete_approval_as_approver", { target_task: id(taskId, "task") });
  if (result.error?.code === "PGRST202") throw invalid("This needs this release’s database update");
  check(result);
}
