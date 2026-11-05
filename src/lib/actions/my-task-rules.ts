"use server";
// Big move 1: My Tasks automations' Server Actions, thin wrappers around
// src/lib/api/automations/my-task-rules.ts.
import * as myTaskRulesApi from "@/lib/api/automations/my-task-rules";
import type { MyTaskRuleInput } from "@/lib/api/automations/my-task-rules";
import type { ActionResult } from "@/lib/api/core/result";
import { run } from "@/lib/server/action";

export async function saveMyTaskRule(ruleId: string | null, input: MyTaskRuleInput): Promise<ActionResult> {
  return run((ctx) => myTaskRulesApi.saveMyTaskRule(ctx, ruleId, input));
}

export async function setMyTaskRuleEnabled(ruleId: string, enabled: boolean): Promise<ActionResult> {
  return run((ctx) => myTaskRulesApi.setMyTaskRuleEnabled(ctx, ruleId, enabled));
}

export async function deleteMyTaskRule(ruleId: string): Promise<ActionResult> {
  return run((ctx) => myTaskRulesApi.deleteMyTaskRule(ctx, ruleId));
}
