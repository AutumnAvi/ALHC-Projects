// Big move 1: the automations area's reads. Every function takes the caller's ApiContext first and reads only
// through ctx.db (RLS decides); no Next.js here.
import { getViewer } from "@/lib/api/auth/queries";
import { type ApiContext, read } from "@/lib/api/core/context";
import { maybe, rows } from "@/lib/api/core/db";
import { type MyTaskRule, toMyTaskRule } from "@/lib/my-task-rules";
import { type PortfolioRuleDef, type PortfolioRuleRun, toPortfolioRuleDef } from "@/lib/portfolio-rules";
import { type FeedbackRun, firstChangingAction } from "@/lib/rule-feedback";
import {
  parsePresetInputs,
  type RuleDef,
  type RulePreset,
  type RuleRun,
  type RuleRunStats,
  runReason,
  toRuleDef,
} from "@/lib/rules";
import { partialOf } from "@/lib/run-outcome";

export const listProjectRules = read(async (ctx: ApiContext, projectId: string): Promise<RuleDef[]> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("rules")
    .select(
      "id, project_id, name, enabled, trigger_type, trigger_config, conditions, actions, preset_key, owner_id, next_run_at, last_edited_by, last_edited_at, run_on_rule_changes, paused_at, pause_reason, consecutive_failures, paused_until",
    )
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  return rows(result, "rules").map(toRuleDef);
});

// Tasks to test a rule on (the builder's Test panel): the project's top-level tasks the viewer can
// read, open ones first, most recently changed first (at most 300).
export const listRuleTestTasks = read(
  async (ctx: ApiContext, projectId: string): Promise<{ id: string; title: string; completed: boolean }[]> => {
    const supabase = ctx.db;
    const result = await supabase
      .from("tasks")
      .select("id, title, completed_at, task_projects!inner(project_id)")
      .eq("task_projects.project_id", projectId)
      .is("task_projects.deleted_at", null)
      .is("parent_task_id", null)
      .is("deleted_at", null)
      .order("completed_at", { ascending: false, nullsFirst: true })
      .order("updated_at", { ascending: false })
      .limit(300);
    if (result.error) {
      console.error(`[rules] couldn't load tasks to test on: ${result.error.message}`);
      return [];
    }
    return (result.data ?? []).map((t) => ({ id: t.id, title: t.title, completed: t.completed_at !== null }));
  },
);

// Each rule's last run and failures in the last 7 days (the rules list's health line). RLS on rule_runs
// decides; empty without Automations V2's database update.
export const listRuleRunStats = read(async (ctx: ApiContext, ruleIds: string[]): Promise<Map<string, RuleRunStats>> => {
  const out = new Map<string, RuleRunStats>();
  if (ruleIds.length === 0) return out;
  const supabase = ctx.db;
  const result = await supabase.rpc("rule_run_stats", { rule_ids: ruleIds.slice(0, 200) });
  if (result.error) {
    console.error(`[rules] couldn't load run stats: ${result.error.message}`);
    return out;
  }
  for (const row of result.data ?? []) {
    out.set(row.rule_id, {
      ruleId: row.rule_id,
      lastRunAt: row.last_run_at,
      lastStatus: (row.last_status as RuleRunStats["lastStatus"]) ?? null,
      runs7d: row.runs_7d,
      failures7d: row.failures_7d,
    });
  }
  return out;
});

export const listRecentRuleRuns = read(async (ctx: ApiContext, ruleIds: string[], limit = 50): Promise<RuleRun[]> => {
  if (ruleIds.length === 0) return [];
  const supabase = ctx.db;
  const runs = rows(
    await supabase
      .from("rule_runs")
      .select("id, rule_id, task_id, status, detail, created_at")
      .in("rule_id", ruleIds)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 500)),
    "automation runs",
  );
  const taskIds = [...new Set(runs.map((r) => r.task_id).filter((t): t is string => Boolean(t)))];
  const tasks = taskIds.length
    ? rows(
        await supabase.from("tasks").select("id, title").in("id", taskIds).is("deleted_at", null),
        "tasks",
      )
    : [];
  const titles = new Map(tasks.map((t) => [t.id, t.title] as const));
  return runs.map((r) => ({
    id: r.id,
    ruleId: r.rule_id,
    taskId: r.task_id && titles.has(r.task_id) ? r.task_id : null,
    taskTitle: r.task_id ? (titles.get(r.task_id) ?? null) : null,
    status: r.status as RuleRun["status"],
    detail: r.detail,
    createdAt: r.created_at,
  }));
});

// Nov 1 notes, batch 10 (77): the signed-in person's own runs since `from` (rule_runs.actor_id), with each
// automation's name and project and the task's title when they can read it — for the live feedback
// toasts. RLS on rule_runs (Viewers+ of the rule's project), rules, and tasks decides. A preview without
// the column reads nothing.
export async function listMyRecentRuleRuns(ctx: ApiContext, from: Date): Promise<FeedbackRun[]> {
  const { user } = await getViewer(ctx);
  if (!user) return [];
  const supabase = ctx.db;
  const result = await supabase
    .from("rule_runs")
    .select("id, rule_id, task_id, status, detail, created_at")
    .eq("actor_id", user.id)
    .gte("created_at", from.toISOString())
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(300);
  if (result.error) {
    if (result.error.code !== "42703") console.error(`[rules] couldn't load feedback runs: ${result.error.message}`);
    return [];
  }
  const runs = result.data ?? [];
  if (runs.length === 0) return [];
  const ruleIds = [...new Set(runs.map((r) => r.rule_id))];
  const taskIds = [...new Set(runs.map((r) => r.task_id).filter((t): t is string => Boolean(t)))];
  const [rules, tasks] = await Promise.all([
    supabase.from("rules").select("id, name, project_id").in("id", ruleIds),
    taskIds.length ? supabase.from("tasks").select("id, title").in("id", taskIds).is("deleted_at", null) : null,
  ]);
  const ruleById = new Map((rules.data ?? []).map((r) => [r.id, r] as const));
  const titles = new Map((tasks?.data ?? []).map((t) => [t.id, t.title] as const));
  return runs.flatMap((r) => {
    const rule = ruleById.get(r.rule_id);
    if (!rule) return [];
    const detail = r.detail && typeof r.detail === "object" && !Array.isArray(r.detail) ? r.detail : {};
    const reason =
      r.status === "failed" ? runReason(r.detail) : typeof detail.reason === "string" ? detail.reason : null;
    return [
      {
        id: r.id,
        ruleId: r.rule_id,
        ruleName: rule.name,
        projectId: rule.project_id,
        taskId: r.task_id,
        taskTitle: r.task_id ? (titles.get(r.task_id) ?? null) : null,
        status: r.status as FeedbackRun["status"],
        reason,
        createdAt: r.created_at,
        action: firstChangingAction(r.detail),
        partial: partialOf(r.status, r.detail),
      },
    ];
  });
}

export const listRulePresets = read(async (ctx: ApiContext): Promise<RulePreset[]> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("rule_presets")
    .select("key, name, description, inputs, rules")
    .is("deleted_at", null)
    .order("sort_order");
  return rows(result, "automation templates").map((p) => ({
    key: p.key,
    name: p.name,
    description: p.description,
    inputs: parsePresetInputs(p.inputs),
    ruleCount: Array.isArray(p.rules) ? p.rules.length : 1,
  }));
});

// ---------------------------------------------------------------------------------------------
// Portfolio rules (Automations V3, batch D). RLS: the portfolio's Viewers+ read rules; runs also need
// the project. Null = this release's database update isn't applied.
// ---------------------------------------------------------------------------------------------

const PORTFOLIO_RULE_COLUMNS =
  "id, portfolio_id, name, enabled, trigger_type, trigger_config, conditions, actions, owner_id, next_run_at, paused_at, pause_reason, last_edited_at, paused_until";

export const listPortfolioRules = read(async (ctx: ApiContext, portfolioId: string): Promise<PortfolioRuleDef[] | null> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("portfolio_rules")
    .select(PORTFOLIO_RULE_COLUMNS)
    .eq("portfolio_id", portfolioId)
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  if (result.error?.code === "PGRST205" || result.error?.code === "42P01") return null;
  return rows(result, "portfolio automations").map(toPortfolioRuleDef);
});

export const getPortfolioRule = read(async (ctx: ApiContext, ruleId: string): Promise<PortfolioRuleDef | null> => {
  const supabase = ctx.db;
  const result = await supabase.from("portfolio_rules").select(PORTFOLIO_RULE_COLUMNS).eq("id", ruleId).is("deleted_at", null).maybeSingle();
  if (result.error?.code === "PGRST205" || result.error?.code === "42P01") return null;
  const row = maybe(result, "portfolio automation");
  return row ? toPortfolioRuleDef(row) : null;
});

// The latest 50 runs of a portfolio's rules (or one rule), with project names the viewer can read.
export async function listPortfolioRuleRuns(ctx: ApiContext, portfolioId: string, ruleId?: string): Promise<PortfolioRuleRun[]> {
  const supabase = ctx.db;
  let query = supabase
    .from("portfolio_rule_runs")
    .select("id, rule_id, project_id, status, detail, created_at")
    .eq("portfolio_id", portfolioId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (ruleId) query = query.eq("rule_id", ruleId);
  const result = await query;
  if (result.error?.code === "PGRST205" || result.error?.code === "42P01") return [];
  const list = rows(result, "portfolio automation runs");
  const projectIds = [...new Set(list.map((r) => r.project_id).filter((x): x is string => Boolean(x)))];
  const names = new Map<string, string>();
  if (projectIds.length) {
    const projects = await supabase.from("projects").select("id, name").in("id", projectIds);
    for (const p of projects.data ?? []) names.set(p.id, p.name);
  }
  return list.map((r) => ({
    id: r.id,
    ruleId: r.rule_id,
    projectId: r.project_id,
    projectName: r.project_id ? (names.get(r.project_id) ?? null) : null,
    status: r.status as PortfolioRuleRun["status"],
    detail: r.detail,
    createdAt: r.created_at,
  }));
}

// Other portfolios where the viewer is an Editor+ (Add to another portfolio).
export async function listEditablePortfolios(ctx: ApiContext, exceptId: string): Promise<{ id: string; name: string }[]> {
  const supabase = ctx.db;
  const viewer = await getViewer(ctx);
  if (!viewer.user) return [];
  const result = await supabase
    .from("portfolio_members")
    .select("portfolio_id, role")
    .eq("profile_id", viewer.user.id)
    .is("deleted_at", null)
    .in("role", ["owner", "admin", "editor"]);
  const ids = (result.data ?? []).map((m) => m.portfolio_id).filter((x) => x !== exceptId);
  if (!ids.length) return [];
  const portfolios = await supabase.from("portfolios").select("id, name").in("id", ids).is("deleted_at", null).order("name");
  return (portfolios.data ?? []).map((p) => ({ id: p.id, name: p.name }));
}

// Nov 4 notes (batch 20, 149): My Tasks automations take the wider vocabulary (the database update is applied).
export const hasMyTaskRulesV2 = read(async (ctx: ApiContext): Promise<boolean> => {
  const supabase = ctx.db;
  const result = await supabase.rpc("my_task_rules_batch20_ready");
  return !result.error && result.data === true;
});

export const listMyTaskRules = read(async (ctx: ApiContext): Promise<MyTaskRule[] | null> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("my_task_rules")
    .select("id, name, enabled, trigger_type, trigger_config, conditions, actions")
    .is("deleted_at", null)
    .order("created_at");
  if (result.error?.code === "PGRST205" || result.error?.code === "42P01") return null;
  return rows(result, "My Tasks automations").map(toMyTaskRule);
});
