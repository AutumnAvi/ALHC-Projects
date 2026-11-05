// Big move 1: what project automations and portfolio automations share.
import { invalid } from "@/lib/api/core/errors";
import { ruleProblems, type RuleStep, type RuleSystem } from "@/lib/rule-params";
import type { Json } from "@/lib/supabase/database.types";

export const RULES_V3_MISSING = "This needs this release’s database update";

// Pause an automation until a time (null = resume now): in the future, at most a year away.
export function pauseUntil(until: string | null, now = Date.now()): string | null {
  if (until === null) return null;
  const at = new Date(until);
  if (Number.isNaN(at.getTime()) || at.getTime() <= now) throw invalid("Pick a time in the future");
  if (at.getTime() > now + 366 * 24 * 3600 * 1000) throw invalid("Pause for up to a year");
  return at.toISOString();
}

// Every step's required settings (src/lib/rule-params.ts, the builders' own check): the first
// problem, said where it is ("Action 2: Choose a task type"), instead of the database's raw refusal.
// Project, portfolio, and My Tasks automations all check their steps with it.
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
