// Big move 1: portfolio automations' writes (Automations V3, batch D: the portfolio's Rules tab). Every
// function takes the caller's ApiContext first, validates its own input, writes only through ctx.db
// (portfolio Admins+ through RLS; run_portfolio_rule checks Editors+), and throws ApiError on any refusal.
import type { ApiContext } from "@/lib/api/core/context";
import { check, checkUpdated, nowIso } from "@/lib/api/core/db";
import { invalid, type DbErrorDetail } from "@/lib/api/core/errors";
import { id, text } from "@/lib/api/core/validate";
import { pauseUntil } from "@/lib/api/automations/shared";
import { isPortfolioTrigger } from "@/lib/portfolio-rules";
import { ruleProblems, type RuleStep, type RuleSystem } from "@/lib/rule-params";
import { partialOf, type PartialRun } from "@/lib/run-outcome";
import type { Json } from "@/lib/supabase/database.types";

export type PortfolioRuleInput = {
  name: string;
  enabled: boolean;
  triggerType: string;
  triggerConfig: Record<string, Json>;
  conditions: Record<string, Json>[];
  actions: Record<string, Json>[];
  ownerId?: string | null;
  timeZone?: string;
};

// What a manual run of a portfolio automation answered.
export type PortfolioRuleRun = {
  status: string;
  // Each step's result line.
  summary: string[];
  // The run's error, when it failed before its steps.
  failure?: string;
  // A run that finished with steps that didn't do their job (Nov 4 notes, batch 24).
  partial: PartialRun | null;
};

const PORTFOLIO_RULES_MISSING = "Portfolio automations need this release’s database update";
const PORTFOLIO_RULES_ADMINS = "Only portfolio admins and owners change its automations";

// Every step's required settings (src/lib/rule-params.ts, the builders' own check): the first
// problem, said where it is ("Action 2: Choose a task type"), instead of the database's raw refusal.
// (Project automations make the same check; My Tasks automations import this one.)
export function checkRuleSteps(
  input: { triggerType: string; triggerConfig?: Record<string, Json>; conditions?: unknown; actions?: unknown },
  system: RuleSystem,
) {
  const steps = (value: unknown) => (Array.isArray(value) ? value.filter((x): x is RuleStep => Boolean(x) && typeof x === "object" && typeof x.type === "string") : []);
  const problems = ruleProblems(
    { triggerType: input.triggerType, triggerConfig: input.triggerConfig ?? {}, conditions: steps(input.conditions), actions: steps(input.actions) },
    system,
  );
  if (problems.length) throw invalid(problems[0]);
}

function portfolioRuleRow(input: PortfolioRuleInput) {
  if (!isPortfolioTrigger(input.triggerType)) throw invalid("Choose a trigger");
  if (!Array.isArray(input.actions) || input.actions.length === 0) throw invalid("Add at least one action");
  checkRuleSteps(input, "portfolio");
  const triggerConfig: Record<string, Json> = { ...(input.triggerConfig ?? {}) };
  // Dates and schedules count in the browser's time zone (like project rules).
  if (input.timeZone && input.timeZone.length <= 64) triggerConfig.timezone = input.timeZone;
  return {
    name: text(input.name, "Automation name", { max: 200 }),
    enabled: Boolean(input.enabled),
    trigger_type: input.triggerType,
    trigger_config: triggerConfig,
    conditions: Array.isArray(input.conditions) ? input.conditions : [],
    actions: Array.isArray(input.actions) ? input.actions : [],
    ...(input.ownerId ? { owner_id: id(input.ownerId, "owner") } : {}),
  };
}

function portfolioRuleError(result: { error: DbErrorDetail | null }) {
  if (result.error && (result.error.code === "PGRST205" || result.error.code === "42P01")) throw invalid(PORTFOLIO_RULES_MISSING);
  check(result, PORTFOLIO_RULES_ADMINS);
}

// Answers the new automation's id.
export async function createPortfolioRule(
  ctx: ApiContext,
  portfolioId: string,
  input: PortfolioRuleInput,
): Promise<{ ruleId: string | undefined }> {
  const supabase = ctx.db;
  const inserted = await supabase
    .from("portfolio_rules")
    .insert({ portfolio_id: id(portfolioId, "portfolio"), ...portfolioRuleRow(input), sort_order: Date.now() / 1000 })
    .select("id")
    .single();
  portfolioRuleError(inserted);
  return { ruleId: inserted.data?.id };
}

export async function updatePortfolioRule(ctx: ApiContext, ruleId: string, input: PortfolioRuleInput): Promise<void> {
  const supabase = ctx.db;
  const updated = await supabase.from("portfolio_rules").update(portfolioRuleRow(input)).eq("id", id(ruleId, "rule")).select("id");
  portfolioRuleError(updated);
  checkUpdated(updated, PORTFOLIO_RULES_ADMINS);
}

export async function setPortfolioRuleEnabled(ctx: ApiContext, ruleId: string, enabled: boolean): Promise<void> {
  const supabase = ctx.db;
  const updated = await supabase.from("portfolio_rules").update({ enabled: Boolean(enabled) }).eq("id", id(ruleId, "rule")).select("id");
  portfolioRuleError(updated);
  checkUpdated(updated, PORTFOLIO_RULES_ADMINS);
}

export async function deletePortfolioRule(ctx: ApiContext, ruleId: string): Promise<void> {
  const supabase = ctx.db;
  const updated = await supabase
    .from("portfolio_rules")
    .update({ deleted_at: nowIso(), enabled: false })
    .eq("id", id(ruleId, "rule"))
    .select("id");
  portfolioRuleError(updated);
  checkUpdated(updated, PORTFOLIO_RULES_ADMINS);
}

// Run a "Run manually" portfolio rule on one of its projects (Editors+ of the portfolio).
export async function runPortfolioRule(ctx: ApiContext, ruleId: string, projectId: string): Promise<PortfolioRuleRun> {
  let summary: string[] = [];
  let failure: string | undefined;
  let partial: PartialRun | null = null;
  const supabase = ctx.db;
  const ran = await supabase.rpc("run_portfolio_rule", { target_rule: id(ruleId, "rule"), target_project: id(projectId, "project") });
  if (ran.error?.code === "PGRST202") throw invalid(PORTFOLIO_RULES_MISSING);
  check(ran);
  const data = (ran.data ?? {}) as { status?: unknown; detail?: Json | null };
  const status = typeof data.status === "string" ? data.status : "failed";
  if (status === "succeeded") partial = partialOf(status, data.detail ?? null);
  const detail = data.detail && typeof data.detail === "object" && !Array.isArray(data.detail) ? data.detail : null;
  if (Array.isArray(detail?.actions)) {
    summary = detail.actions.flatMap((step) =>
      step && typeof step === "object" && typeof (step as { result?: unknown }).result === "string" ? [(step as { result: string }).result] : [],
    );
  } else if (detail?.actions && typeof detail.actions === "object" && typeof (detail.actions as { error?: unknown }).error === "string") {
    failure = (detail.actions as { error: string }).error;
  }
  return { status, summary, ...(failure !== undefined ? { failure } : {}), partial };
}

export async function duplicatePortfolioRule(ctx: ApiContext, ruleId: string): Promise<void> {
  const supabase = ctx.db;
  const source = await supabase
    .from("portfolio_rules")
    .select("portfolio_id, name, trigger_type, trigger_config, conditions, actions, sort_order")
    .eq("id", id(ruleId, "rule"))
    .is("deleted_at", null)
    .maybeSingle();
  portfolioRuleError(source);
  if (!source.data) throw invalid("Automation not found");
  const inserted = await supabase.from("portfolio_rules").insert({
    portfolio_id: source.data.portfolio_id,
    name: `Copy of ${source.data.name}`.slice(0, 200),
    enabled: false,
    trigger_type: source.data.trigger_type,
    trigger_config: source.data.trigger_config,
    conditions: source.data.conditions,
    actions: source.data.actions,
    sort_order: source.data.sort_order + 1,
  });
  portfolioRuleError(inserted);
}

// Pause a portfolio automation until a time (null = resume now).
export async function setPortfolioRulePausedUntil(ctx: ApiContext, ruleId: string, until: string | null): Promise<void> {
  const supabase = ctx.db;
  const updated = await supabase.from("portfolio_rules").update({ paused_until: pauseUntil(until) }).eq("id", id(ruleId, "rule")).select("id");
  portfolioRuleError(updated);
  checkUpdated(updated, PORTFOLIO_RULES_ADMINS);
}
