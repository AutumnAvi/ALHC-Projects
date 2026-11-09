// AI builder round 5: shared synthetic fixtures for the assistant / registry / MCP tests. The model is a fake
// tool-calling provider (no billable call) and the database an in-memory stand-in (no live writes).
import type { contextForModel } from "@alhc/core/ai-assistant";
import { AI_BUILDER_CALLS } from "@alhc/core/ai-builder";
import { createApiContext } from "@alhc/core/api/core/context";
import { isApiError } from "@alhc/core/api/core/errors";
import type { AiContentBlock, AiConverseRequest, AiConverseResult, AiProposalProvider, AiProviderRequest, AiProviderResult } from "@alhc/core/api/ai-builder/model";
import { applyAssistantRun, proposeChanges } from "@alhc/core/api/ai-assistant/mutations";
import { memoryDb, type MemoryState, type Refuse, type Rpc } from "./memory-db";

export const WS = "11111111-1111-4111-8111-111111111111";
export const ME = "22222222-2222-4222-8222-222222222222";
export const MATE = "22222222-2222-4222-8222-222222222223";
export const SARAH_A = "22222222-2222-4222-8222-222222222225";
export const SARAH_B = "22222222-2222-4222-8222-222222222226";
export const P1 = "33333333-3333-4333-8333-333333333331";
export const P2 = "33333333-3333-4333-8333-333333333332";
export const S_TODO = "44444444-4444-4444-8444-444444444441";
export const S_DOING = "44444444-4444-4444-8444-444444444442";
export const S_DONE = "44444444-4444-4444-8444-444444444443";
export const S_P2 = "44444444-4444-4444-8444-444444444444";
export const T_FLYER = "55555555-5555-4555-8555-555555555551";
export const T_BLOCKED = "55555555-5555-4555-8555-555555555552";
export const T_APPROVAL = "55555555-5555-4555-8555-555555555553";
export const T_SUB = "55555555-5555-4555-8555-555555555554";
export const F_PRIORITY = "66666666-6666-4666-8666-666666666661";
export const F_BUDGET = "66666666-6666-4666-8666-666666666662";
export const R_TRIAGE = "77777777-7777-4777-8777-777777777771";
export const R_FANCY = "77777777-7777-4777-8777-777777777772";

export const task = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  notes: null,
  assignee_id: null,
  due_on: null,
  start_on: null,
  completed_at: null,
  kind: "task",
  recurrence: null,
  parent_task_id: null,
  root_task_id: null,
  deleted_at: null,
  ...extra,
});

export function world(role = "owner", opts: { sarahs?: boolean } = {}): MemoryState {
  return {
    ai_pilot_workspaces: [{ workspace_id: WS, cleaned_at: null }],
    workspaces: [{ id: WS, name: "Testing data", deleted_at: null, goals_enabled: true }],
    projects: [
      { id: P1, name: "Launch", workspace_id: WS, archived_at: null, sections_locked: false, deleted_at: null },
      { id: P2, name: "Ops", workspace_id: WS, archived_at: null, sections_locked: false, deleted_at: null },
    ],
    project_members: [
      { project_id: P1, profile_id: ME, role, deleted_at: null },
      { project_id: P1, profile_id: MATE, role: "editor", deleted_at: null },
      { project_id: P2, profile_id: ME, role: "editor", deleted_at: null },
      ...(opts.sarahs
        ? [
            { project_id: P1, profile_id: SARAH_A, role: "editor", deleted_at: null },
            { project_id: P1, profile_id: SARAH_B, role: "commenter", deleted_at: null },
          ]
        : []),
    ],
    sections: [
      { id: S_TODO, project_id: P1, name: "To do", sort_order: 1024, deleted_at: null },
      { id: S_DOING, project_id: P1, name: "Doing", sort_order: 2048, deleted_at: null },
      { id: S_DONE, project_id: P1, name: "Done", sort_order: 3072, deleted_at: null },
      { id: S_P2, project_id: P2, name: "Inbox", sort_order: 1024, deleted_at: null },
    ],
    tasks: [
      task(T_FLYER, "Spring flyer", { due_on: "2026-11-20" }),
      task(T_BLOCKED, "Print run"),
      task(T_APPROVAL, "Sign-off", { kind: "approval" }),
      task(T_SUB, "Proofread", { parent_task_id: T_FLYER, root_task_id: T_FLYER }),
    ],
    task_projects: [
      { task_id: T_FLYER, project_id: P1, section_id: S_TODO, sort_order: 1024, deleted_at: null },
      { task_id: T_BLOCKED, project_id: P1, section_id: S_TODO, sort_order: 2048, deleted_at: null },
      { task_id: T_APPROVAL, project_id: P1, section_id: S_DOING, sort_order: 1024, deleted_at: null },
    ],
    custom_fields: [
      {
        id: F_PRIORITY,
        project_id: P1,
        name: "Priority",
        field_type: "single_select",
        options: [
          { id: "hi", name: "High", color: "red" },
          { id: "lo", name: "Low", color: "green" },
        ],
        bound_to_sections: false,
        show_in_views: true,
        sort_order: 1,
        locked: false,
        library_field_id: null,
        deleted_at: null,
      },
      { id: F_BUDGET, project_id: P1, name: "Budget", field_type: "number", options: [], bound_to_sections: false, show_in_views: true, sort_order: 2, locked: true, library_field_id: null, deleted_at: null },
    ],
    task_field_values: [{ task_id: T_FLYER, field_id: F_PRIORITY, value: "lo" }],
    rules: [
      { id: R_TRIAGE, project_id: P1, name: "Triage", enabled: true, trigger_type: "task_created", trigger_config: {}, conditions: [], actions: [{ type: "move_section", section_id: S_DOING }], preset_key: null, sort_order: 1024, deleted_at: null },
      { id: R_FANCY, project_id: P1, name: "Email the client", enabled: false, trigger_type: "task_completed", trigger_config: {}, conditions: [], actions: [{ type: "send_email", to: "submitter", template: "custom", message: "Done" }], preset_key: null, sort_order: 2048, deleted_at: null },
    ],
    task_approvers: [],
    task_approval_settings: [],
    ai_assistant_runs: [],
    personal_access_tokens: [],
  };
}

export type DbOpts = { admin?: boolean; blockers?: Record<string, number>; refuse?: Refuse; log?: string[]; rpcs?: Record<string, Rpc>; sarahs?: boolean; me?: string };

export function db(state: MemoryState, opts: DbOpts = {}) {
  const me = opts.me ?? ME;
  return memoryDb(state, {
    log: opts.log,
    defaults: { ai_assistant_runs: { status: "generating", escalated: false, op_count: 0, actor_id: me, apply_key: null, applied: null, source: "app", token_id: null } },
    refuse: opts.refuse,
    rpcs: {
      ai_pilot_admin: () => ({ data: opts.admin ?? true }),
      ai_pilot_members: () => ({
        data: [
          { profile_id: ME, name: "Avi Weinreb", email: "avi@example.com", is_me: me === ME },
          { profile_id: MATE, name: "Dana Lee", email: "dana@example.com", is_me: me === MATE },
          ...(opts.sarahs
            ? [
                { profile_id: SARAH_A, name: "Sarah Kim", email: "sk@example.com", is_me: false },
                { profile_id: SARAH_B, name: "Sarah Ortiz", email: "so@example.com", is_me: false },
              ]
            : []),
        ],
      }),
      project_role: (args, s) => ({ data: s.project_members.find((m) => m.project_id === args.target_project && m.profile_id === me && !m.deleted_at)?.role ?? null }),
      open_blocker_counts: () => ({ data: opts.blockers ?? { [T_BLOCKED]: 1 } }),
      place_section: (args, s) => {
        const target = s.sections.find((x) => x.id === args.target_section)!;
        const project = s.sections.filter((x) => x.project_id === target.project_id && !x.deleted_at && x !== target).sort((a, b) => (a.sort_order as number) - (b.sort_order as number));
        const at = args.before_section ? project.findIndex((x) => x.id === args.before_section) : project.length;
        project.splice(at, 0, target);
        project.forEach((x, i) => (x.sort_order = (i + 1) * 1024));
        return { data: null };
      },
      set_task_approvers: (args, s) => {
        s.task_approvers = (s.task_approvers ?? []).filter((a) => a.task_id !== args.target_task);
        for (const p of (args.approvers as string[]) ?? []) s.task_approvers.push({ task_id: args.target_task, profile_id: p, created_at: new Date().toISOString(), deleted_at: null });
        s.task_approval_settings = (s.task_approval_settings ?? []).filter((x) => x.task_id !== args.target_task);
        s.task_approval_settings.push({ task_id: args.target_task, mode: args.approval_mode, due_on: args.approval_due });
        return { data: null };
      },
      restore_task: (args, s) => {
        const t = s.tasks.find((x) => x.id === args.target_task);
        if (!t) return { data: null, error: { code: "P0002", message: "Task not found" } };
        const at = t.deleted_at;
        t.deleted_at = null;
        for (const sub of s.tasks) if (sub.root_task_id === t.id && sub.deleted_at === at) sub.deleted_at = null;
        return { data: null };
      },
      ...(opts.rpcs ?? {}),
    },
  });
}

// What a live state looks like (compared before and after).
export const live = (s: MemoryState) =>
  JSON.stringify({
    tasks: s.tasks,
    task_projects: s.task_projects.filter((m) => !m.deleted_at).map(({ task_id, project_id, section_id, sort_order }) => ({ task_id, project_id, section_id, sort_order })),
    sections: s.sections.filter((x) => !x.deleted_at).map(({ id, name }) => ({ id, name })),
    sectionOrder: s.sections.filter((x) => !x.deleted_at).sort((a, b) => (a.sort_order as number) - (b.sort_order as number)).map((x) => x.id),
    rules: s.rules.filter((r) => !r.deleted_at).map(({ id, name, enabled, trigger_type, conditions, actions }) => ({ id, name, enabled, trigger_type, conditions, actions })),
    values: s.task_field_values.map(({ task_id, field_id, value }) => ({ task_id, field_id, value })),
    fields: s.custom_fields.map(({ id, name, options, deleted_at }) => ({ id, name, options, deleted: Boolean(deleted_at) })),
    approvers: s.task_approvers,
  });

// ---- The fake model ------------------------------------------------------------------------------------

export type ModelCtx = ReturnType<typeof contextForModel>;
export type Call = { name: string; input: Record<string, unknown> };
export type Script = (ctx: ModelCtx, request: AiConverseRequest, round: number, results: AiContentBlock[]) => Call[] | AiConverseResult;

export const contextOf = (request: AiConverseRequest): ModelCtx => {
  const first = request.messages[0].content;
  const text = typeof first === "string" ? first : "";
  return JSON.parse(/<context>\n([\s\S]*?)\n<\/context>/.exec(text)![1]);
};

// A tool-calling model: each round, the script answers tool calls (or a failure); it ends when the script
// answers []. `finish(summary)` is added automatically to the last round unless the script calls it.
export function toolModel(script: Script, opts: { answer?: (request: AiProviderRequest) => unknown } = {}) {
  const calls: AiConverseRequest[] = [];
  const answers: AiProviderRequest[] = [];
  let n = 0;
  const p: AiProposalProvider = {
    configured: true,
    async generate(request) {
      answers.push(request);
      const out = opts.answer ? opts.answer(request) : { answer: "Use Customize → Forms." };
      if (out && typeof out === "object" && "ok" in out) return out as AiProviderResult;
      return { ok: true, output: out, model: AI_BUILDER_CALLS[request.kind ?? "assistant_answer"].model, inputTokens: 10, outputTokens: 5 };
    },
    async converse(request) {
      const round = calls.filter((c) => c.messages[0] === request.messages[0]).length;
      calls.push({ ...request, messages: [...request.messages] });
      const last = request.messages[request.messages.length - 1];
      const results = typeof last.content === "string" ? [] : last.content.filter((b) => b.type === "tool_result");
      const out = script(contextOf(request), request, round, results);
      if (!Array.isArray(out)) return out;
      const content: AiContentBlock[] = out.map((c) => ({ type: "tool_use", id: `tu_${++n}`, name: c.name, input: c.input }));
      if (!out.length) content.push({ type: "tool_use", id: `tu_${++n}`, name: "finish", input: { summary: "Done", unsupported: "" } });
      return { ok: true, content, stopReason: "tool_use", model: AI_BUILDER_CALLS[request.kind].model, inputTokens: 100, outputTokens: 50 };
    },
  };
  return { p, calls, answers };
}

// A script that makes these calls in the first round, then finishes.
export const once = (make: (ctx: ModelCtx) => Call[]): Script => (ctx, _r, round) => (round === 0 ? make(ctx) : []);

export const tref = (ctx: ModelCtx, title: string) => ctx.tasks.find((t) => t.title === title)!.ref;
export const sref = (ctx: ModelCtx, name: string) => ctx.projects.flatMap((p) => p.sections).find((s) => s.name === name)!.ref;
export const rref = (ctx: ModelCtx, name: string) => ctx.automations.find((a) => a.name === name)!.ref;
export const fref = (ctx: ModelCtx, name: string) => ctx.fields.find((f) => f.name === name)!.ref;

export const PAGE = { kind: "project", projectId: P1, taskId: null, ruleId: null };
let keyN = 0;
export const key = (p = "k") => `${p}-${String(++keyN).padStart(8, "0")}`;
export const propose = (d: ReturnType<typeof db>, prov: AiProposalProvider, instruction = "Tidy this up", page: unknown = PAGE) =>
  proposeChanges(createApiContext(d), { requestKey: key("req"), page, instruction, localToday: "2026-11-09" }, prov);
export const apply = (d: ReturnType<typeof db>, runId: string, selected: number[], acknowledged: number[] = []) =>
  applyAssistantRun(createApiContext(d), { runId, applyKey: key("apply"), selected, acknowledged });
export const reject = (code: string, includes?: string | RegExp) => (e: unknown) =>
  isApiError(e) && e.code === code && (!includes || (typeof includes === "string" ? e.message.includes(includes) : includes.test(e.message)));
