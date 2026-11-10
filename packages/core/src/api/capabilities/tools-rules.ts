// AI builder round 5 (notes 177 / 178): the registry's automation tools — project automations, My Tasks
// automations, and portfolio automations — in the engines' FULL vocabulary (ai-rule-steps.ts, generated
// from rule-params.ts): Set task type → Approval with its approvers, Request approval, "An approval is
// decided", "Task type changes / is / isn't", "Approval status is", and everything else the builders
// offer, but Slack, webhooks, and Convert to a project (secrets, destinations, outside the pilot).
//
// Every automation the AI makes is created OFF. One whose steps message people when it runs (email, Inbox
// notices, comments, approval requests) says so in the change set, and turning it on is its own confirmed
// step that names who gets messaged (enable_automation's `notifies`). Saves go through createRule /
// updateRule (validate_rule and the approval setup's rule_approval_setup_problem check them again), My
// Tasks automations through saveMyTaskRule, portfolio automations through createPortfolioRule.
import { outwardRecipients, ruleFromSteps, ruleToSteps, type AiRuleBody } from "../../ai-rule-steps";
import { ruleState, sameState } from "../../ai-assistant";
import { toMyTaskRule } from "../../my-task-rules";
import { toPortfolioRuleDef } from "../../portfolio-rules";
import type { RuleAction, RuleCondition } from "../../rules";
import type { RuleSystem } from "../../rule-params";
import type { Json } from "../../supabase/database.types";
import type { ApiContext } from "../core/context";
import { maybe } from "../core/db";
import { ApiError, invalid } from "../core/errors";
import { createRule, deleteRule, duplicateRule, restoreRule, runManualRule, setRuleEnabled, setRulePausedUntil, updateRule } from "../automations/mutations";
import { deleteMyTaskRule, saveMyTaskRule, setMyTaskRuleEnabled } from "../automations/my-task-rules";
import { createPortfolioRule, deletePortfolioRule, setPortfolioRuleEnabled, updatePortfolioRule } from "../automations/portfolio-rules";
import { allowedIn, clean, existingTask, personName, projectArg, refArg, ruleArg, ruleNamesFor, staged } from "./env";
import { refuse, type Handler, type OpState, type StagedOp, type ToolEnv } from "./types";

const noSigningSecrets = () => {
  throw invalid("The AI doesn’t make webhook signing secrets");
};

const arg = (op: StagedOp, key: string) => String(op.args[key]);
const bodyOf = (op: StagedOp, key: "rule" | "previous"): AiRuleBody => op[key] as AiRuleBody;

// "Messages people when it runs: …" (or null).
export function outwardNote(env: ToolEnv, rule: AiRuleBody, system: RuleSystem): string | null {
  const who = outwardRecipients(rule, system, (id) => personName(env, id));
  return who.length ? who.join(", ") : null;
}

async function draft(env: ToolEnv, raw: unknown, system: RuleSystem, projectId: string | null, what: string, portfolioId?: string | null): Promise<AiRuleBody> {
  const names = await ruleNamesFor(env, projectId, system, portfolioId);
  const res = ruleFromSteps(raw, system, names, env.me, projectId);
  if (!res.ok) return refuse(`${what}: ${res.error}`);
  return res.rule;
}

// What the model is shown of an existing automation (null = part of it can't be named).
export async function ruleForModel(env: ToolEnv, rule: AiRuleBody, system: RuleSystem, projectId: string | null, portfolioId?: string | null) {
  return ruleToSteps(rule, system, await ruleNamesFor(env, projectId, system, portfolioId), projectId);
}

const stepCount = (r: AiRuleBody) => `${r.conditions.length} condition${r.conditions.length === 1 ? "" : "s"}, ${r.actions.length} action${r.actions.length === 1 ? "" : "s"}`;

// ---- Project automations ----------------------------------------------------------------------------

async function readProjectRule(ctx: ApiContext, ruleId: string | null): Promise<OpState> {
  if (!ruleId) return {};
  const r = maybe(await ctx.db.from("rules").select("name, enabled, trigger_type, trigger_config, conditions, actions, deleted_at, paused_until").eq("id", ruleId).maybeSingle(), "automation");
  if (!r) return { missing: true };
  return { ...ruleState({ ...r, deleted: Boolean(r.deleted_at) }), paused_until: (r.paused_until as string | null | undefined) ?? null };
}
async function verifyProjectRule(ctx: ApiContext, _ws: string, op: StagedOp) {
  const r = maybe(await ctx.db.from("rules").select("project_id").eq("id", arg(op, "rule_id")).maybeSingle(), "automation");
  if (!r || r.project_id !== op.projectId) throw new ApiError("forbidden", "That automation isn’t in this project");
}
const input = (rule: AiRuleBody, timeZone: string | undefined) => ({
  name: rule.name,
  triggerType: rule.triggerType,
  triggerConfig: rule.triggerConfig,
  conditions: rule.conditions as RuleCondition[],
  actions: rule.actions as RuleAction[],
  ...(timeZone ? { timeZone } : {}),
});

const createAutomation: Handler = {
  async stage(env, i, what) {
    const p = await projectArg(env, i.project ?? env.context.currentProjectId, what);
    allowedIn(env, "create_automation", p.id, what);
    const rule = await draft(env, i.automation, "project", p.id, what);
    const out = outwardNote(env, rule, "project");
    return staged("create_automation", p.id, `New automation in “${p.name}”: “${rule.name}”`, "—", `${rule.name} (starts off)${out ? ` · once on, it messages ${out}` : ""}`, { project_id: p.id }, { system: "project", rule });
  },
  read: (ctx, _op, created) => readProjectRule(ctx, created),
  async apply(ctx, op, a, tz) {
    const res = await createRule(ctx, String(a.project_id), { ...input(bodyOf(op, "rule"), tz), enabled: false }, noSigningSecrets);
    if (!res.ruleId) throw new ApiError("failed", "The automation wasn’t created");
    return res.ruleId;
  },
  async undo(ctx, _op, _b, created, opts) {
    if (created && opts.turnedOn) await setRuleEnabled(ctx, created, false);
    if (created) await deleteRule(ctx, created);
  },
};

const updateAutomation: Handler = {
  async stage(env, i, what) {
    const r = await ruleArg(env, i.automation_ref, what);
    allowedIn(env, "update_automation", r.projectId, what);
    const rule = await draft(env, i.automation, "project", r.projectId, what);
    const previous: AiRuleBody = { name: r.name, triggerType: r.triggerType, triggerConfig: r.triggerConfig, conditions: r.conditions, actions: r.actions };
    if (sameState(previous, rule)) refuse(`${what}: “${r.name}” already does that`);
    const out = outwardNote(env, rule, "project");
    return staged("update_automation", r.projectId, `Edit automation “${r.name}”`, `${r.name} (${stepCount(previous)})`, `${rule.name} (${stepCount(rule)})${out && r.enabled ? ` · it’s on: it will message ${out}` : out ? ` · once on, it messages ${out}` : ""}`, { rule_id: r.id }, {
      system: "project", rule, previous, notifies: out && r.enabled ? out : null,
    });
  },
  read: (ctx, op) => readProjectRule(ctx, arg(op, "rule_id")),
  verify: verifyProjectRule,
  async apply(ctx, op, a, tz) {
    await updateRule(ctx, String(a.rule_id), input(bodyOf(op, "rule"), tz), noSigningSecrets);
    return null;
  },
  async undo(ctx, op) {
    await updateRule(ctx, arg(op, "rule_id"), input(bodyOf(op, "previous"), undefined), noSigningSecrets);
  },
};

const enableAutomation: Handler = {
  async stage(env, i, what) {
    const r = await ruleArg(env, i.automation_ref, what);
    allowedIn(env, "enable_automation", r.projectId, what);
    const on = i.on !== false;
    if (r.enabled === on) refuse(`${what}: “${r.name}” is already ${on ? "on" : "off"}`);
    const out = on ? outwardNote(env, { name: r.name, triggerType: r.triggerType, triggerConfig: r.triggerConfig, conditions: r.conditions, actions: r.actions }, "project") : null;
    return staged("enable_automation", r.projectId, `Turn ${on ? "on" : "off"} automation “${r.name}”`, r.enabled ? "On" : "Off", on ? "On" : "Off", { rule_id: r.id, on }, { notifies: out });
  },
  read: (ctx, op) => readProjectRule(ctx, arg(op, "rule_id")),
  verify: verifyProjectRule,
  async apply(ctx, _op, a) {
    await setRuleEnabled(ctx, String(a.rule_id), Boolean(a.on));
    return null;
  },
  async undo(ctx, op, before) {
    await setRuleEnabled(ctx, arg(op, "rule_id"), Boolean(before.enabled));
  },
};

const deleteAutomation: Handler = {
  async stage(env, i, what) {
    const r = await ruleArg(env, i.automation_ref, what);
    allowedIn(env, "delete_automation", r.projectId, what);
    return staged("delete_automation", r.projectId, `Remove automation “${r.name}”`, r.name, "Removed (Undo brings it back)", { rule_id: r.id });
  },
  read: (ctx, op) => readProjectRule(ctx, arg(op, "rule_id")),
  verify: verifyProjectRule,
  async apply(ctx, _op, a) {
    await deleteRule(ctx, String(a.rule_id));
    return null;
  },
  async undo(ctx, op, before) {
    await restoreRule(ctx, arg(op, "rule_id"), Boolean(before.enabled));
  },
};

const duplicateAutomation: Handler = {
  async stage(env, i, what) {
    const r = await ruleArg(env, i.automation_ref, what);
    allowedIn(env, "duplicate_automation", r.projectId, what);
    return staged("duplicate_automation", r.projectId, `Duplicate automation “${r.name}”`, "—", `Copy of ${r.name} (starts off)`, { rule_id: r.id });
  },
  read: (ctx, _op, created) => readProjectRule(ctx, created),
  async apply(ctx, _op, a) {
    return (await duplicateRule(ctx, String(a.rule_id))) ?? null;
  },
  async undo(ctx, _op, _b, created) {
    if (created) await deleteRule(ctx, created);
  },
};

const pauseAutomation: Handler = {
  async stage(env, i, what) {
    const r = await ruleArg(env, i.automation_ref, what);
    allowedIn(env, "pause_automation", r.projectId, what);
    const until = clean(i.until);
    const date = until.toLowerCase() === "none" ? null : /^\d{4}-\d{2}-\d{2}$/.test(until) && until > env.today ? until : refuse(`${what}: pause until a later date (YYYY-MM-DD) or "none"`);
    const cur = await readProjectRule(env.ctx, r.id);
    return staged("pause_automation", r.projectId, `${date ? "Pause" : "Resume"} automation “${r.name}”`, cur.paused_until ? `Paused until ${String(cur.paused_until).slice(0, 10)}` : "Not paused", date ? `Paused until ${date}` : "Not paused", { rule_id: r.id, until: date });
  },
  read: (ctx, op) => readProjectRule(ctx, arg(op, "rule_id")),
  verify: verifyProjectRule,
  async apply(ctx, _op, a) {
    await setRulePausedUntil(ctx, String(a.rule_id), (a.until as string | null) ?? null);
    return null;
  },
  async undo(ctx, op, before) {
    await setRulePausedUntil(ctx, arg(op, "rule_id"), before.paused_until ? String(before.paused_until).slice(0, 10) : null);
  },
};

const runAutomation: Handler = {
  async stage(env, i, what) {
    const r = await ruleArg(env, i.automation_ref, what);
    allowedIn(env, "run_automation", r.projectId, what);
    if (r.triggerType !== "manual") refuse(`${what}: only “Run manually” automations run on a task by hand`);
    if (!r.enabled) refuse(`${what}: “${r.name}” is off`);
    const t = await existingTask(env, i.task, what);
    if (t.projectId !== r.projectId) refuse(`${what}: “${t.title}” isn’t in that automation’s project`);
    const out = outwardNote(env, { name: r.name, triggerType: r.triggerType, triggerConfig: r.triggerConfig, conditions: r.conditions, actions: r.actions }, "project");
    return staged("run_automation", r.projectId, `Run “${r.name}” on “${t.title}”`, "—", `Runs now (what it does isn’t undone here)`, { rule_id: r.id, task_id: t.id }, { notifies: out });
  },
  verify: verifyProjectRule,
  async apply(ctx, _op, a) {
    const run = await runManualRule(ctx, String(a.rule_id), String(a.task_id));
    if (run.status === "failed") throw new ApiError("failed", run.failure ?? "The automation failed");
    return null;
  },
};

// ---- My Tasks automations ----------------------------------------------------------------------------

async function myRuleArg(env: ToolEnv, value: unknown, what: string) {
  const r = await refArg(env, "my_rule", value, what, async (id) => maybe(await env.ctx.db.from("my_task_rules").select("name").eq("id", id).eq("profile_id", env.me).is("deleted_at", null).maybeSingle(), "automation")?.name ?? null);
  const row = maybe(await env.ctx.db.from("my_task_rules").select("id, profile_id, name, enabled, trigger_type, trigger_config, conditions, actions").eq("id", r.id).is("deleted_at", null).maybeSingle(), "automation");
  if (!row || row.profile_id.toLowerCase() !== env.me) refuse(`${what}: that isn’t one of your My Tasks automations`);
  const def = toMyTaskRule(row!);
  return { id: row!.id, enabled: row!.enabled, body: { name: def.name, triggerType: def.triggerType, triggerConfig: def.triggerConfig, conditions: def.conditions, actions: def.actions } as AiRuleBody };
}
async function readMyRule(ctx: ApiContext, ruleId: string | null): Promise<OpState> {
  if (!ruleId) return {};
  const r = maybe(await ctx.db.from("my_task_rules").select("name, enabled, trigger_type, trigger_config, conditions, actions, deleted_at").eq("id", ruleId).maybeSingle(), "automation");
  return r ? ruleState({ ...r, deleted: Boolean(r.deleted_at) }) : { missing: true };
}
const myInput = (rule: AiRuleBody, enabled: boolean, tz: string | undefined) => ({ name: rule.name, enabled, triggerType: rule.triggerType, triggerConfig: rule.triggerConfig, conditions: rule.conditions as Record<string, Json>[], actions: rule.actions as Record<string, Json>[], ...(tz ? { timeZone: tz } : {}) });

const createMyAutomation: Handler = {
  async stage(env, i, what) {
    const rule = await draft(env, i.automation, "my_tasks", null, what);
    return staged("create_my_automation", null, `New My Tasks automation “${rule.name}”`, "—", `${rule.name} (starts off; only your tasks)`, { me: env.me }, { system: "my_tasks", rule });
  },
  read: (ctx, _op, created) => readMyRule(ctx, created),
  async apply(ctx, op, a, tz) {
    const rule = bodyOf(op, "rule");
    await saveMyTaskRule(ctx, null, myInput(rule, false, tz));
    const row = maybe(await ctx.db.from("my_task_rules").select("id").eq("profile_id", String(a.me)).eq("name", rule.name).is("deleted_at", null).order("created_at", { ascending: false }).limit(1).maybeSingle(), "automation");
    return row?.id ?? null;
  },
  async undo(ctx, _op, _b, created) {
    if (created) await deleteMyTaskRule(ctx, created);
  },
};

const updateMyAutomation: Handler = {
  async stage(env, i, what) {
    const cur = await myRuleArg(env, i.automation_ref, what);
    const rule = await draft(env, i.automation, "my_tasks", null, what);
    if (sameState(cur.body, rule)) refuse(`${what}: it already does that`);
    return staged("update_my_automation", null, `Edit My Tasks automation “${cur.body.name}”`, `${cur.body.name} (${stepCount(cur.body)})`, `${rule.name} (${stepCount(rule)})`, { rule_id: cur.id, enabled: cur.enabled }, { system: "my_tasks", rule, previous: cur.body });
  },
  read: (ctx, op) => readMyRule(ctx, arg(op, "rule_id")),
  async apply(ctx, op, a, tz) {
    await saveMyTaskRule(ctx, String(a.rule_id), myInput(bodyOf(op, "rule"), Boolean(a.enabled), tz));
    return null;
  },
  async undo(ctx, op, before) {
    await saveMyTaskRule(ctx, arg(op, "rule_id"), myInput(bodyOf(op, "previous"), Boolean(before.enabled), undefined));
  },
};

const enableMyAutomation: Handler = {
  async stage(env, i, what) {
    const cur = await myRuleArg(env, i.automation_ref, what);
    const on = i.on !== false;
    if (cur.enabled === on) refuse(`${what}: it’s already ${on ? "on" : "off"}`);
    const out = on ? outwardNote(env, cur.body, "my_tasks") : null;
    return staged("enable_my_automation", null, `Turn ${on ? "on" : "off"} “${cur.body.name}”`, cur.enabled ? "On" : "Off", on ? "On" : "Off", { rule_id: cur.id, on }, { notifies: out });
  },
  read: (ctx, op) => readMyRule(ctx, arg(op, "rule_id")),
  async apply(ctx, _op, a) {
    await setMyTaskRuleEnabled(ctx, String(a.rule_id), Boolean(a.on));
    return null;
  },
  async undo(ctx, op, before) {
    await setMyTaskRuleEnabled(ctx, arg(op, "rule_id"), Boolean(before.enabled));
  },
};

const deleteMyAutomation: Handler = {
  async stage(env, i, what) {
    const cur = await myRuleArg(env, i.automation_ref, what);
    return staged("delete_my_automation", null, `Delete My Tasks automation “${cur.body.name}”`, cur.body.name, "Deleted (can’t be undone here)", { rule_id: cur.id });
  },
  async apply(ctx, _op, a) {
    await deleteMyTaskRule(ctx, String(a.rule_id));
    return null;
  },
};

// ---- Portfolio automations ---------------------------------------------------------------------------

const PORTFOLIO_RANK: Record<string, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };
async function portfolioAdmin(env: ToolEnv, portfolioId: string, what: string) {
  const p = maybe(await env.ctx.db.from("portfolios").select("id, name, workspace_id").eq("id", portfolioId).is("deleted_at", null).maybeSingle(), "portfolio");
  if (!p || p.workspace_id !== env.workspaceId) refuse(`${what}: that portfolio isn’t in the Testing data workspace`);
  const role = (await env.ctx.db.rpc("portfolio_role", { target_portfolio: portfolioId })).data as string | null;
  if ((PORTFOLIO_RANK[role ?? ""] ?? 0) < PORTFOLIO_RANK.editor) refuse(`${what}: only Owners and Editors of “${p!.name}” change its automations`);
  return p!;
}
async function portfolioRuleArg(env: ToolEnv, value: unknown, what: string) {
  const r = await refArg(env, "portfolio_rule", value, what, async (id) => maybe(await env.ctx.db.from("portfolio_rules").select("name").eq("id", id).is("deleted_at", null).maybeSingle(), "automation")?.name ?? null);
  const row = maybe(await env.ctx.db.from("portfolio_rules").select("*").eq("id", r.id).is("deleted_at", null).maybeSingle(), "automation");
  if (!row) refuse(`${what}: that portfolio automation isn’t available`);
  const portfolio = await portfolioAdmin(env, row!.portfolio_id, what);
  const def = toPortfolioRuleDef(row!);
  return { id: row!.id, enabled: row!.enabled, portfolio, body: { name: def.name, triggerType: def.triggerType, triggerConfig: def.triggerConfig, conditions: def.conditions, actions: def.actions } as AiRuleBody };
}
async function readPortfolioRule(ctx: ApiContext, ruleId: string | null): Promise<OpState> {
  if (!ruleId) return {};
  const r = maybe(await ctx.db.from("portfolio_rules").select("name, enabled, trigger_type, trigger_config, conditions, actions, deleted_at").eq("id", ruleId).maybeSingle(), "automation");
  return r ? ruleState({ ...r, deleted: Boolean(r.deleted_at) }) : { missing: true };
}
async function verifyPortfolioAdmin(ctx: ApiContext, ws: string, op: StagedOp) {
  const portfolioId = arg(op, "portfolio_id");
  const p = maybe(await ctx.db.from("portfolios").select("workspace_id").eq("id", portfolioId).maybeSingle(), "portfolio");
  if (!p || p.workspace_id !== ws) throw new ApiError("forbidden", "That portfolio isn’t in the Testing data workspace");
  const role = (await ctx.db.rpc("portfolio_role", { target_portfolio: portfolioId })).data as string | null;
  if ((PORTFOLIO_RANK[role ?? ""] ?? 0) < PORTFOLIO_RANK.editor) throw new ApiError("forbidden", "Only the portfolio’s Owners and Editors change its automations");
}
const portfolioInput = (rule: AiRuleBody, enabled: boolean, tz: string | undefined) => ({ ...myInput(rule, enabled, tz) });

const createPortfolioAutomation: Handler = {
  async stage(env, i, what) {
    const pf = await refArg(env, "portfolio", i.portfolio, what, async (id) => maybe(await env.ctx.db.from("portfolios").select("name").eq("id", id).is("deleted_at", null).maybeSingle(), "portfolio")?.name ?? null);
    const p = await portfolioAdmin(env, pf.id, what);
    const rule = await draft(env, i.automation, "portfolio", null, what, p.id);
    const out = outwardNote(env, rule, "portfolio");
    return staged("create_portfolio_automation", null, `New automation in the portfolio “${p.name}”: “${rule.name}”`, "—", `${rule.name} (starts off)${out ? ` · once on, it messages ${out}` : ""}`, { portfolio_id: p.id }, { system: "portfolio", rule });
  },
  read: (ctx, _op, created) => readPortfolioRule(ctx, created),
  verify: verifyPortfolioAdmin,
  async apply(ctx, op, a, tz) {
    const res = await createPortfolioRule(ctx, String(a.portfolio_id), portfolioInput(bodyOf(op, "rule"), false, tz));
    return res.ruleId ?? null;
  },
  async undo(ctx, _op, _b, created) {
    if (created) await deletePortfolioRule(ctx, created);
  },
};

const updatePortfolioAutomation: Handler = {
  async stage(env, i, what) {
    const cur = await portfolioRuleArg(env, i.automation_ref, what);
    const rule = await draft(env, i.automation, "portfolio", null, what, cur.portfolio.id);
    if (sameState(cur.body, rule)) refuse(`${what}: it already does that`);
    return staged("update_portfolio_automation", null, `Edit portfolio automation “${cur.body.name}”`, `${cur.body.name} (${stepCount(cur.body)})`, `${rule.name} (${stepCount(rule)})`, { rule_id: cur.id, portfolio_id: cur.portfolio.id, enabled: cur.enabled }, { system: "portfolio", rule, previous: cur.body });
  },
  read: (ctx, op) => readPortfolioRule(ctx, arg(op, "rule_id")),
  verify: verifyPortfolioAdmin,
  async apply(ctx, op, a, tz) {
    await updatePortfolioRule(ctx, String(a.rule_id), portfolioInput(bodyOf(op, "rule"), Boolean(a.enabled), tz));
    return null;
  },
  async undo(ctx, op, before) {
    await updatePortfolioRule(ctx, arg(op, "rule_id"), portfolioInput(bodyOf(op, "previous"), Boolean(before.enabled), undefined));
  },
};

const enablePortfolioAutomation: Handler = {
  async stage(env, i, what) {
    const cur = await portfolioRuleArg(env, i.automation_ref, what);
    const on = i.on !== false;
    if (cur.enabled === on) refuse(`${what}: it’s already ${on ? "on" : "off"}`);
    return staged("enable_portfolio_automation", null, `Turn ${on ? "on" : "off"} “${cur.body.name}”`, cur.enabled ? "On" : "Off", on ? "On" : "Off", { rule_id: cur.id, portfolio_id: cur.portfolio.id, on }, { notifies: on ? outwardNote(env, cur.body, "portfolio") : null });
  },
  read: (ctx, op) => readPortfolioRule(ctx, arg(op, "rule_id")),
  verify: verifyPortfolioAdmin,
  async apply(ctx, _op, a) {
    await setPortfolioRuleEnabled(ctx, String(a.rule_id), Boolean(a.on));
    return null;
  },
  async undo(ctx, op, before) {
    await setPortfolioRuleEnabled(ctx, arg(op, "rule_id"), Boolean(before.enabled));
  },
};

const deletePortfolioAutomation: Handler = {
  async stage(env, i, what) {
    const cur = await portfolioRuleArg(env, i.automation_ref, what);
    return staged("delete_portfolio_automation", null, `Delete portfolio automation “${cur.body.name}”`, cur.body.name, "Deleted (can’t be undone here)", { rule_id: cur.id, portfolio_id: cur.portfolio.id });
  },
  verify: verifyPortfolioAdmin,
  async apply(ctx, _op, a) {
    await deletePortfolioRule(ctx, String(a.rule_id));
    return null;
  },
};

export const RULE_HANDLERS: Record<string, Handler> = {
  create_automation: createAutomation,
  update_automation: updateAutomation,
  enable_automation: enableAutomation,
  delete_automation: deleteAutomation,
  duplicate_automation: duplicateAutomation,
  pause_automation: pauseAutomation,
  run_automation: runAutomation,
  create_my_automation: createMyAutomation,
  update_my_automation: updateMyAutomation,
  enable_my_automation: enableMyAutomation,
  delete_my_automation: deleteMyAutomation,
  create_portfolio_automation: createPortfolioAutomation,
  update_portfolio_automation: updatePortfolioAutomation,
  enable_portfolio_automation: enablePortfolioAutomation,
  delete_portfolio_automation: deletePortfolioAutomation,
};
