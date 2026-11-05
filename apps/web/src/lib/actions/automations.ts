"use server";
// Big move 1: the automations area's Server Actions, thin wrappers around packages/core/src/api/automations/
// (mutations.ts and, for the lists, queries.ts). Only what Next.js does (the request's context, delivering
// the outboxes, re-rendering) and the signing secret generator (server-only) stay here.
import type {
  BulkManualRule,
  ManualRule,
  ManualRuleStatus,
  RuleInput,
  RuleSaveResult,
} from "@alhc/core/api/automations/model";
import * as automationsApi from "@alhc/core/api/automations/mutations";
import * as automationsQueries from "@alhc/core/api/automations/queries";
import type { ActionResult } from "@alhc/core/api/core/result";
import type { BulkRuleRun } from "@alhc/core/bulk";
import { generateSigningSecret } from "@/lib/integrations";
import type { RuleTestResult } from "@alhc/core/rule-steps";
import type { PartialRun } from "@alhc/core/run-outcome";
import { readAction, run, runWith } from "@/lib/server/action";
import type { Json } from "@alhc/core/supabase/database.types";

export async function createRule(projectId: string, input: RuleInput): Promise<RuleSaveResult> {
  return runWith((ctx) => automationsApi.createRule(ctx, projectId, input, generateSigningSecret));
}

export async function updateRule(ruleId: string, input: RuleInput): Promise<RuleSaveResult> {
  return runWith((ctx) => automationsApi.updateRule(ctx, ruleId, input, generateSigningSecret));
}

// Nothing is written, so nothing is delivered or refreshed afterwards.
export async function testRule(
  projectId: string,
  ruleId: string | null,
  taskId: string,
  draft: RuleInput | null,
): Promise<ActionResult & { result?: RuleTestResult }> {
  return runWith(
    async (ctx) => ({ result: await automationsApi.testRule(ctx, projectId, ruleId, taskId, draft) }),
    { refresh: false, deliver: false },
  );
}

export async function setRuleEnabled(ruleId: string, enabled: boolean): Promise<ActionResult> {
  return run((ctx) => automationsApi.setRuleEnabled(ctx, ruleId, enabled));
}

export async function deleteRule(ruleId: string): Promise<ActionResult> {
  return run((ctx) => automationsApi.deleteRule(ctx, ruleId));
}

export async function installRulePreset(
  projectId: string,
  presetKey: string,
  inputs: Record<string, Json>,
  enable: boolean,
): Promise<ActionResult> {
  return run((ctx) => automationsApi.installRulePreset(ctx, projectId, presetKey, inputs, enable));
}

export async function listManualRules(taskId: string): Promise<ActionResult & { rules: ManualRule[] }> {
  const outcome = await readAction((ctx) => automationsQueries.listManualRules(ctx, taskId));
  return { error: outcome.error, ...(outcome.code ? { code: outcome.code } : {}), rules: outcome.data ?? [] };
}

// The rule may queue emails, Slack messages, or webhooks, so the outboxes are delivered like after any
// write. Nov 3 notes (batch 19, 141): no refresh here; RunRuleDialog refreshes the page in the background.
export async function runManualRule(
  ruleId: string,
  taskId: string,
): Promise<ActionResult & { status?: ManualRuleStatus; summary: string[]; reason?: string; partial?: PartialRun }> {
  const result = await runWith((ctx) => automationsApi.runManualRule(ctx, ruleId, taskId), { refresh: false });
  if (result.error) return { error: result.error, ...(result.code ? { code: result.code } : {}), summary: [] };
  const { status, summary = [], failure, reason, partial } = result;
  return { status, summary, ...(failure ? { error: failure } : {}), ...(reason ? { reason } : {}), ...(partial ? { partial } : {}) };
}

export async function listBulkManualRules(taskIds: string[]): Promise<ActionResult & { rules: BulkManualRule[] }> {
  const outcome = await readAction((ctx) => automationsQueries.listBulkManualRules(ctx, taskIds));
  return { error: outcome.error, ...(outcome.code ? { code: outcome.code } : {}), rules: outcome.data ?? [] };
}

// Nov 3 notes (batch 19, 141): no refresh here; the bulk bar refreshes the page in the background.
export async function runManualRuleOnTasks(ruleId: string, taskIds: string[]): Promise<ActionResult & { run?: BulkRuleRun }> {
  return runWith(
    async (ctx) => ({ run: await automationsApi.runManualRuleOnTasks(ctx, ruleId, taskIds) }),
    { refresh: false },
  );
}

export async function duplicateRule(ruleId: string): Promise<ActionResult & { ruleId?: string }> {
  return runWith(async (ctx) => ({ ruleId: await automationsApi.duplicateRule(ctx, ruleId) }));
}

// Pause a rule until a time (null = resume now).
export async function setRulePausedUntil(ruleId: string, until: string | null): Promise<ActionResult> {
  return run((ctx) => automationsApi.setRulePausedUntil(ctx, ruleId, until));
}
