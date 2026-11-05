"use server";
// Big move 1: the goals area's Server Actions, thin wrappers around packages/core/src/api/goals/mutations.ts.
// Only what Next.js does (redirects, the request's context) stays here.
import { redirect } from "next/navigation";
import type { ActionResult } from "@alhc/core/api/core/result";
import type { GoalInput, GoalLinkTarget, GoalPatch } from "@alhc/core/api/goals/model";
import * as goalsApi from "@alhc/core/api/goals/mutations";
import { run } from "@/lib/server/action";

export async function createGoal(
  input: GoalInput,
  { open = false }: { open?: boolean } = {},
): Promise<ActionResult> {
  let goalId: string | null = null;
  const result = await run(async (ctx) => {
    goalId = await goalsApi.createGoal(ctx, input);
  });
  if (open && goalId && !result.error) redirect(`/goals/${goalId}`);
  return result;
}

export async function updateGoal(goalId: string, patch: GoalPatch): Promise<ActionResult> {
  return run((ctx) => goalsApi.updateGoal(ctx, goalId, patch));
}

export async function deleteGoal(goalId: string): Promise<ActionResult> {
  const result = await run((ctx) => goalsApi.deleteGoal(ctx, goalId));
  if (!result.error) redirect("/goals");
  return result;
}

export async function linkGoal(goalId: string, target: GoalLinkTarget): Promise<ActionResult> {
  return run((ctx) => goalsApi.linkGoal(ctx, goalId, target));
}

export async function unlinkGoal(linkId: string): Promise<ActionResult> {
  return run((ctx) => goalsApi.unlinkGoal(ctx, linkId));
}

// Posting an update also sets the goal's status (trigger).
export async function postGoalStatusUpdate(goalId: string, status: string, body: string | null): Promise<ActionResult> {
  return run((ctx) => goalsApi.postGoalStatusUpdate(ctx, goalId, status, body));
}

export async function deleteGoalStatusUpdate(updateId: string): Promise<ActionResult> {
  return run((ctx) => goalsApi.deleteGoalStatusUpdate(ctx, updateId));
}
