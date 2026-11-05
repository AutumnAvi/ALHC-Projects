"use server";
// Big move 1: portfolio automations' Server Actions, thin wrappers around
// packages/core/src/api/automations/portfolio-rules.ts.
import * as portfolioRulesApi from "@alhc/core/api/automations/portfolio-rules";
import type { PortfolioRuleInput } from "@alhc/core/api/automations/portfolio-rules";
import type { ActionResult } from "@alhc/core/api/core/result";
import type { PartialRun } from "@alhc/core/run-outcome";
import { run, runWith } from "@/lib/server/action";

export async function createPortfolioRule(portfolioId: string, input: PortfolioRuleInput): Promise<ActionResult & { ruleId?: string }> {
  return runWith((ctx) => portfolioRulesApi.createPortfolioRule(ctx, portfolioId, input));
}

export async function updatePortfolioRule(ruleId: string, input: PortfolioRuleInput): Promise<ActionResult> {
  return run((ctx) => portfolioRulesApi.updatePortfolioRule(ctx, ruleId, input));
}

export async function setPortfolioRuleEnabled(ruleId: string, enabled: boolean): Promise<ActionResult> {
  return run((ctx) => portfolioRulesApi.setPortfolioRuleEnabled(ctx, ruleId, enabled));
}

export async function deletePortfolioRule(ruleId: string): Promise<ActionResult> {
  return run((ctx) => portfolioRulesApi.deletePortfolioRule(ctx, ruleId));
}

// Run a "Run manually" portfolio rule on one of its projects (Editors+ of the portfolio).
export async function runPortfolioRule(
  ruleId: string,
  projectId: string,
): Promise<ActionResult & { status?: string; summary: string[]; partial?: PartialRun }> {
  const result = await runWith((ctx) => portfolioRulesApi.runPortfolioRule(ctx, ruleId, projectId));
  if (result.error) return { error: result.error, code: result.code, summary: [] };
  const { status, summary = [], failure, partial } = result;
  return failure ? { status, summary, error: failure } : { status, summary, ...(partial ? { partial } : {}) };
}

export async function duplicatePortfolioRule(ruleId: string): Promise<ActionResult> {
  return run((ctx) => portfolioRulesApi.duplicatePortfolioRule(ctx, ruleId));
}

export async function setPortfolioRulePausedUntil(ruleId: string, until: string | null): Promise<ActionResult> {
  return run((ctx) => portfolioRulesApi.setPortfolioRulePausedUntil(ctx, ruleId, until));
}
