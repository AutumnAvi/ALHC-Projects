"use server";
// Big move 1: task numbering, the project's workflow settings, and numbering one task — thin Server
// Action wrappers around src/lib/api/numbers/mutations.ts.
import type { ActionResult } from "@/lib/api/core/result";
import * as numbersApi from "@/lib/api/numbers/mutations";
import type { RequestNumberingInput, TaskNumberingInput, TaskNumberingMode } from "@/lib/api/numbers/mutations";
import { run } from "@/lib/server/action";

export async function saveRequestNumbering(projectId: string, input: RequestNumberingInput): Promise<ActionResult> {
  return run((ctx) => numbersApi.saveRequestNumbering(ctx, projectId, input));
}

export async function saveTaskNumbering(
  projectId: string,
  input: TaskNumberingInput,
  mode: TaskNumberingMode,
): Promise<ActionResult> {
  return run((ctx) => numbersApi.saveTaskNumbering(ctx, projectId, input, mode));
}

export async function updateProjectWorkflow(
  projectId: string,
  patch: { approvalCompletesTask: boolean },
): Promise<ActionResult> {
  return run((ctx) => numbersApi.updateProjectWorkflow(ctx, projectId, patch));
}

export async function assignRequestNumber(taskId: string): Promise<ActionResult> {
  return run((ctx) => numbersApi.assignRequestNumber(ctx, taskId));
}
