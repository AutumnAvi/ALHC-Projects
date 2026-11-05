// Big move 1: the numbers area's writes (task numbering settings, numbering one task) and the project's
// workflow settings saved next to them. Every function takes the caller's ApiContext first, validates its
// own input, writes only through ctx.db (RLS and the RPCs decide), and throws ApiError on any refusal; no
// Next.js here.
import type { ApiContext } from "@/lib/api/core/context";
import { check } from "@/lib/api/core/db";
import { invalid } from "@/lib/api/core/errors";
import { id } from "@/lib/api/core/validate";
import { templateProblem } from "@/lib/request-numbers";

// The older Req # form's settings.
export type RequestNumberingInput = {
  enabled: boolean;
  prefix: string;
  padWidth: number;
  addToTitle: boolean;
  assignTo: "all_tasks" | "form_submissions";
  nextNumber?: number | null;
};

// The Task numbering panel's settings.
export type TaskNumberingInput = {
  enabled: boolean;
  template: string;
  wrapBrackets: boolean;
  numberScope: "all_tasks" | "form_submissions" | "sections" | "kinds";
  sectionIds: string[];
  taskKinds: string[];
  numberSubtasks: boolean;
  subtaskSeparator: "." | "-" | "/";
  reuseDeleted: boolean;
  fillGaps: boolean;
  resetPeriod: "never" | "yearly" | "monthly";
  counterFieldId: string | null;
  projectCode: string;
  renumberOnMove: boolean;
  timeZone: string;
  // Sent only when someone changed it: the next number (one counter), where each reset period /
  // field counter starts, or where Renumber all starts. Every save used to resend it, which moved
  // the start of new counters and of Renumber all to "last issued + 1".
  startNumber?: number | null;
  confirmation?: string;
};

export type TaskNumberingMode = "save" | "number_missing" | "renumber";

export async function saveRequestNumbering(ctx: ApiContext, projectId: string, input: RequestNumberingInput): Promise<void> {
  const prefix = input.prefix.trim();
  if (prefix.length > 20) throw invalid("Prefix is limited to 20 characters");
  if (!Number.isInteger(input.padWidth) || input.padWidth < 0 || input.padWidth > 8) {
    throw invalid("Padding must be between 0 and 8 digits");
  }
  if (input.assignTo !== "all_tasks" && input.assignTo !== "form_submissions") {
    throw invalid("Unknown numbering scope");
  }
  const row: {
    project_id: string;
    enabled: boolean;
    prefix: string;
    pad_width: number;
    add_to_title: boolean;
    assign_to: string;
    deleted_at: null;
    last_number?: number;
  } = {
    project_id: id(projectId),
    enabled: Boolean(input.enabled),
    prefix,
    pad_width: input.padWidth,
    add_to_title: Boolean(input.addToTitle),
    assign_to: input.assignTo,
    deleted_at: null,
  };
  if (input.nextNumber !== undefined && input.nextNumber !== null) {
    if (!Number.isInteger(input.nextNumber) || input.nextNumber < 1) {
      throw invalid("The next number must be a positive whole number");
    }
    row.last_number = input.nextNumber - 1;
  }
  const supabase = ctx.db;
  check(await supabase.from("request_sequences").upsert(row, { onConflict: "project_id" }));
}

export async function saveTaskNumbering(
  ctx: ApiContext,
  projectId: string,
  input: TaskNumberingInput,
  mode: TaskNumberingMode,
): Promise<void> {
  if (mode !== "save" && mode !== "number_missing" && mode !== "renumber") {
    throw invalid("Unknown numbering action");
  }
  const template = input.template.trim();
  const problem = templateProblem(template, input.resetPeriod);
  if (problem) throw invalid(problem);
  const startNumber = input.startNumber ?? null;
  if (startNumber !== null && (!Number.isInteger(startNumber) || startNumber < 1)) {
    throw invalid("The number must be a positive whole number");
  }
  if (input.numberScope === "sections" && input.sectionIds.length === 0) {
    throw invalid("Choose at least one section to number");
  }
  if (input.numberScope === "kinds" && input.taskKinds.length === 0) {
    throw invalid("Choose at least one task type to number");
  }
  if (mode === "renumber" && input.confirmation !== "RENUMBER") {
    throw invalid("Type RENUMBER to renumber every task");
  }
  const supabase = ctx.db;
  const saved = await supabase.rpc("apply_task_numbering", {
    target_project: id(projectId),
    settings: {
      enabled: Boolean(input.enabled),
      template,
      wrap_brackets: Boolean(input.wrapBrackets),
      add_to_title: false,
      number_scope: input.numberScope,
      section_ids: input.sectionIds,
      task_kinds: input.taskKinds,
      number_subtasks: Boolean(input.numberSubtasks),
      subtask_separator: input.subtaskSeparator,
      reuse_deleted: Boolean(input.reuseDeleted),
      fill_gaps: Boolean(input.fillGaps),
      reset_period: input.resetPeriod,
      counter_field_id: input.counterFieldId,
      project_code: input.projectCode.trim(),
      renumber_on_move: Boolean(input.renumberOnMove),
      time_zone: input.timeZone || "UTC",
      ...(startNumber !== null ? { start_number: startNumber } : {}),
      ...(mode === "renumber" ? { confirmation: "RENUMBER" } : {}),
    },
    mode,
  });
  if (saved.error?.code === "PGRST202") {
    throw invalid("Task numbering needs this release’s database update");
  }
  check(saved);
}

// Number one existing top-level task (assign_request_number refuses subtasks).
export async function assignRequestNumber(ctx: ApiContext, taskId: string): Promise<void> {
  const supabase = ctx.db;
  check(await supabase.rpc("assign_request_number", { target_task: id(taskId) }));
}

// ---------------------------------------------------------------------------------------------
// Workflow settings (project Settings: whether an approval completes the task)
// ---------------------------------------------------------------------------------------------

export async function updateProjectWorkflow(
  ctx: ApiContext,
  projectId: string,
  patch: { approvalCompletesTask: boolean },
): Promise<void> {
  const supabase = ctx.db;
  check(
    await supabase
      .from("projects")
      .update({ approval_completes_task: Boolean(patch.approvalCompletesTask) })
      .eq("id", id(projectId)),
  );
}
