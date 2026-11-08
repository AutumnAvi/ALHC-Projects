// AI builder round 3 (note 171): the global assistant. Synthetic fixtures only: the model is a fake
// provider (no billable call) and the database an in-memory stand-in (no live writes).
import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSISTANT_JSON_SCHEMA,
  ASSISTANT_RULE_ACTIONS,
  assistantPageFromPath,
  contextForModel,
  escalationReason,
  parseAssistantPage,
  resolveAssistantPlan,
  routeAssistant,
  selectionProblem,
  withRefs,
  type AssistantContext,
} from "@alhc/core/ai-assistant";
import { AI_BUILDER_CALLS, structuredOutputIssues } from "@alhc/core/ai-builder";
import { createApiContext } from "@alhc/core/api/core/context";
import { isApiError } from "@alhc/core/api/core/errors";
import type { AiProposalProvider, AiProviderRequest, AiProviderResult } from "@alhc/core/api/ai-builder/model";
import { applyAssistantRun, proposeChanges, undoAssistantRun } from "@alhc/core/api/ai-assistant/mutations";
import { memoryDb, type MemoryState, type Refuse } from "./memory-db";

// ---- Fixtures -------------------------------------------------------------------------------------

const WS = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const MATE = "22222222-2222-4222-8222-222222222223";
const OUTSIDER = "22222222-2222-4222-8222-222222222224";
const P1 = "33333333-3333-4333-8333-333333333331";
const P2 = "33333333-3333-4333-8333-333333333332";
const S_TODO = "44444444-4444-4444-8444-444444444441";
const S_DOING = "44444444-4444-4444-8444-444444444442";
const S_DONE = "44444444-4444-4444-8444-444444444443";
const S_P2 = "44444444-4444-4444-8444-444444444444";
const T_FLYER = "55555555-5555-4555-8555-555555555551";
const T_BLOCKED = "55555555-5555-4555-8555-555555555552";
const T_APPROVAL = "55555555-5555-4555-8555-555555555553";
const T_SUB = "55555555-5555-4555-8555-555555555554";
const F_PRIORITY = "66666666-6666-4666-8666-666666666661";
const R_TRIAGE = "77777777-7777-4777-8777-777777777771";
const R_FANCY = "77777777-7777-4777-8777-777777777772";

const task = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
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

function world(role = "owner"): MemoryState {
  return {
    ai_pilot_workspaces: [{ workspace_id: WS, cleaned_at: null }],
    workspaces: [{ id: WS, name: "Testing data", deleted_at: null }],
    projects: [
      { id: P1, name: "Launch", workspace_id: WS, archived_at: null, sections_locked: false, deleted_at: null },
      { id: P2, name: "Ops", workspace_id: WS, archived_at: null, sections_locked: false, deleted_at: null },
    ],
    project_members: [
      { project_id: P1, profile_id: ME, role, deleted_at: null },
      { project_id: P1, profile_id: MATE, role: "editor", deleted_at: null },
      { project_id: P2, profile_id: ME, role: "editor", deleted_at: null },
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
        deleted_at: null,
      },
    ],
    task_field_values: [{ task_id: T_FLYER, field_id: F_PRIORITY, value: "lo" }],
    rules: [
      {
        id: R_TRIAGE,
        project_id: P1,
        name: "Triage",
        enabled: true,
        trigger_type: "task_created",
        trigger_config: {},
        conditions: [],
        actions: [{ type: "move_section", section_id: S_DOING }],
        preset_key: null,
        sort_order: 1024,
        deleted_at: null,
      },
      {
        id: R_FANCY,
        project_id: P1,
        name: "Email the client",
        enabled: false,
        trigger_type: "task_completed",
        trigger_config: {},
        conditions: [],
        actions: [{ type: "send_email", to: "submitter", template: "custom" }],
        preset_key: null,
        sort_order: 2048,
        deleted_at: null,
      },
    ],
    ai_assistant_runs: [],
  };
}

function db(state: MemoryState, opts: { admin?: boolean; blockers?: Record<string, number>; refuse?: Refuse; log?: string[] } = {}) {
  return memoryDb(state, {
    log: opts.log,
    defaults: { ai_assistant_runs: { status: "generating", escalated: false, op_count: 0, actor_id: ME, apply_key: null, applied: null } },
    refuse: opts.refuse,
    rpcs: {
      ai_pilot_admin: () => ({ data: opts.admin ?? true }),
      ai_pilot_members: () => ({
        data: [
          { profile_id: ME, name: "Avi", email: "avi@example.com", is_me: true },
          { profile_id: MATE, name: "Dana", email: "dana@example.com", is_me: false },
        ],
      }),
      project_role: (args, s) => ({ data: s.project_members.find((m) => m.project_id === args.target_project && m.profile_id === ME && !m.deleted_at)?.role ?? null }),
      open_blocker_counts: () => ({ data: opts.blockers ?? { [T_BLOCKED]: 1 } }),
      place_section: (args, s) => {
        const target = s.sections.find((x) => x.id === args.target_section)!;
        const project = s.sections.filter((x) => x.project_id === target.project_id && !x.deleted_at && x !== target).sort((a, b) => (a.sort_order as number) - (b.sort_order as number));
        const at = args.before_section ? project.findIndex((x) => x.id === args.before_section) : project.length;
        project.splice(at, 0, target);
        project.forEach((x, i) => (x.sort_order = (i + 1) * 1024));
        return { data: null };
      },
    },
  });
}

// The parts of the world the assistant may change (compared before and after).
const live = (s: MemoryState) =>
  JSON.stringify({
    tasks: s.tasks,
    task_projects: s.task_projects.filter((m) => !m.deleted_at).map(({ task_id, project_id, section_id, sort_order }) => ({ task_id, project_id, section_id, sort_order })),
    sections: s.sections.filter((x) => !x.deleted_at).map(({ id, name }) => ({ id, name })),
    sectionOrder: s.sections.filter((x) => !x.deleted_at).sort((a, b) => (a.sort_order as number) - (b.sort_order as number)).map((x) => x.id),
    rules: s.rules.filter((r) => !r.deleted_at).map(({ id, name, enabled, trigger_type, conditions, actions }) => ({ id, name, enabled, trigger_type, conditions, actions })),
    values: s.task_field_values.map(({ task_id, field_id, value }) => ({ task_id, field_id, value })),
  });

type ModelCtx = ReturnType<typeof contextForModel>;
const modelContext = (request: AiProviderRequest): ModelCtx => JSON.parse(/<context>\n([\s\S]*?)\n<\/context>/.exec(request.prompt)![1]);
const ref = (ctx: ModelCtx, kind: "tasks" | "automations", name: string) =>
  (ctx[kind] as { ref: string; title?: string; name?: string }[]).find((x) => (x.title ?? x.name) === name)!.ref;
const sectionRef = (ctx: ModelCtx, name: string) => ctx.projects.flatMap((p) => p.sections).find((s) => s.name === name)!.ref;

const blank = { target: "", name: "", text: "", section: "", before: "", project: "", person: "", field: "", value: "", due: "", start: "", rule: "" };
const op = (o: Partial<typeof blank> & { op: string }) => ({ ...blank, ...o });
const stepBlank = { section: "", field: "", value: "", days: -1, text: "", people: [], person: "", titles: [] };

function provider(answer: (ctx: ModelCtx, request: AiProviderRequest) => AiProviderResult | unknown) {
  const calls: AiProviderRequest[] = [];
  const p: AiProposalProvider = {
    configured: true,
    async generate(request) {
      calls.push(request);
      const out = answer(modelContext(request), request);
      if (out && typeof out === "object" && "ok" in out) return out as AiProviderResult;
      return { ok: true, output: out, model: AI_BUILDER_CALLS[request.kind ?? "assistant_small"].model, inputTokens: 100, outputTokens: 50 };
    },
  };
  return { p, calls };
}

const PAGE = { kind: "project", projectId: P1, taskId: null, ruleId: null };
const propose = (d: ReturnType<typeof db>, prov: AiProposalProvider, instruction = "Tidy this up and then rename things", page: unknown = PAGE) =>
  proposeChanges(createApiContext(d), { requestKey: `req-${Math.random().toString(36).slice(2, 12)}`, page, instruction, localToday: "2026-11-08" }, prov);
const reject = (code: string, includes?: string) => (e: unknown) => isApiError(e) && e.code === code && (!includes || e.message.includes(includes));

// ---- Schema ----------------------------------------------------------------------------------------

function countUnions(node: unknown): { anyOf: number; nullable: number } {
  let anyOf = 0;
  let nullable = 0;
  const visit = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(visit);
    if (!n || typeof n !== "object") return;
    const o = n as Record<string, unknown>;
    if (Array.isArray(o.anyOf)) {
      anyOf += 1;
      if (o.anyOf.some((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "null")) nullable += 1;
    }
    if (Array.isArray(o.type) && o.type.includes("null")) nullable += 1;
    if (o.type === "null") nullable += 1;
    Object.values(o).forEach(visit);
  };
  visit(node);
  return { anyOf, nullable };
}

test("the change-set schema stays under Anthropic's 16-union limit, with no nullable union at all", () => {
  const { anyOf, nullable } = countUnions(ASSISTANT_JSON_SCHEMA);
  assert.ok(anyOf <= 16, `${anyOf} anyOf`);
  assert.equal(anyOf, 0, "a flat op object needs no union");
  assert.equal(nullable, 0, "no nullable keys");
  assert.deepEqual(structuredOutputIssues(ASSISTANT_JSON_SCHEMA), []);
});

test("the assistant's automations leave out the steps that post or notify", () => {
  assert.ok(!ASSISTANT_RULE_ACTIONS.includes("notify"));
  assert.ok(!ASSISTANT_RULE_ACTIONS.includes("add_comment"));
  for (const sending of ["send_email", "send_slack", "call_webhook", "request_approval"]) assert.ok(!(ASSISTANT_RULE_ACTIONS as readonly string[]).includes(sending));
});

// ---- Pages and routing -------------------------------------------------------------------------

test("the page comes from the address and the open task, as kinds and ids only", () => {
  assert.deepEqual(assistantPageFromPath(`/projects/${P1}/views/x`, null), { kind: "project", projectId: P1, taskId: null, ruleId: null });
  assert.deepEqual(assistantPageFromPath(`/projects/${P1}/views/x`, T_FLYER), { kind: "task", projectId: P1, taskId: T_FLYER, ruleId: null });
  assert.deepEqual(assistantPageFromPath(`/projects/${P1}/rules`, null), { kind: "rules", projectId: P1, taskId: null, ruleId: null });
  assert.deepEqual(assistantPageFromPath(`/projects/${P1}/rules/${R_TRIAGE}`, null), { kind: "rule", projectId: P1, taskId: null, ruleId: R_TRIAGE });
  assert.equal(assistantPageFromPath("/my-tasks", null).kind, "my_tasks");
  assert.equal(assistantPageFromPath("/my-tasks", T_FLYER).kind, "task");
  assert.equal(assistantPageFromPath("/inbox", null).kind, "other");
  assert.equal(parseAssistantPage({ kind: "project", projectId: "not-an-id" }), null);
  assert.equal(parseAssistantPage({ kind: "project", projectId: P1, name: "ignored" })?.projectId, P1);
  assert.equal(parseAssistantPage({ kind: "evil" }), null);
  assert.equal(parseAssistantPage({ kind: "rule", projectId: P1 }), null);
});

test("routing: Haiku for a small edit, Sonnet for automations or several steps; big small answers escalate", () => {
  assert.deepEqual(routeAssistant("Rename this task to Flyer v2", "task"), { call: "assistant_small", reason: "small_edit" });
  assert.equal(routeAssistant("Rename this task", "rules").reason, "rules_page");
  assert.equal(routeAssistant("Whenever a task is done, move it to Done", "project").reason, "mentions_rules");
  assert.equal(routeAssistant("Add a Blocked section and then move the print run there", "project").reason, "multi_step");
  assert.equal(routeAssistant("x".repeat(300), "project").reason, "long_request");
  assert.equal(AI_BUILDER_CALLS.assistant_small.model, "claude-haiku-5-5");
  assert.equal(AI_BUILDER_CALLS.assistant_large.model, "claude-sonnet-5-5");
  assert.equal(escalationReason({ ops: [op({ op: "rename_task" })], rules: [] }), null);
  assert.equal(escalationReason({ ops: [op({ op: "create_rule" })], rules: [] }), "escalated_rules");
  assert.equal(escalationReason({ ops: Array.from({ length: 6 }, () => op({ op: "rename_task" })), rules: [] }), "escalated_size");
  assert.equal(escalationReason("nope"), "escalated_invalid");
});

// ---- Context ---------------------------------------------------------------------------------------

test("the model sees refs and aliases, never an id, an email, or a person's name", async () => {
  const prov = provider((ctx) => ({ summary: "", unsupported: "", ops: [op({ op: "rename_task", target: ref(ctx, "tasks", "Spring flyer"), name: "Flyer" })], rules: [] }));
  await propose(db(world()), prov.p, "Rename the flyer");
  const prompt = prov.calls[0].prompt;
  for (const secret of [WS, ME, MATE, P1, S_TODO, T_FLYER, F_PRIORITY, R_TRIAGE, "avi@example.com", "Dana"]) assert.ok(!prompt.includes(secret), `leaked ${secret}`);
  assert.ok(prompt.includes("member:1"));
  const ctx = modelContext(prov.calls[0]);
  assert.equal(ctx.current_project, "P1");
  assert.ok(!ctx.tasks.some((t) => t.title === "Proofread"), "a project page lists top-level tasks");
  const onTask = provider((c) => ({ summary: "", unsupported: "", ops: [op({ op: "rename_task", target: ref(c, "tasks", "Proofread"), name: "Proof" })], rules: [] }));
  await propose(db(world()), onTask.p, "Rename it", { kind: "task", projectId: null, taskId: T_FLYER, ruleId: null });
  const taskCtx = modelContext(onTask.calls[0]);
  assert.equal(taskCtx.open_task, ref(taskCtx, "tasks", "Spring flyer"));
  assert.equal(taskCtx.tasks.find((t) => t.title === "Proofread")?.subtask_of, taskCtx.open_task, "the open task's subtasks come along");
  assert.equal(ctx.automations.find((a) => a.name === "Email the client")?.steps, "uses steps the assistant can’t rewrite (it can still turn it on, off, or remove it)");
});

test("the context is loaded on the server from the page's ids, refusing pages outside the pilot", async () => {
  const prov = provider(() => ({ summary: "", unsupported: "", ops: [], rules: [] }));
  const s = world();
  s.projects.push({ id: "33333333-3333-4333-8333-333333333339", name: "Main", workspace_id: "99999999-9999-4999-8999-999999999999", archived_at: null, deleted_at: null });
  await assert.rejects(propose(db(s), prov.p, "x", { kind: "project", projectId: "33333333-3333-4333-8333-333333333339", taskId: null, ruleId: null }), reject("forbidden"));
  await assert.rejects(propose(db(world(), { admin: false }), prov.p), reject("forbidden"));
  assert.equal(prov.calls.length, 0, "no model call outside the pilot");
});

// ---- Resolving ----------------------------------------------------------------------------------

function staticContext(role: "owner" | "editor" | "viewer" = "owner"): AssistantContext {
  return withRefs({
    page: "project",
    today: "2026-11-08",
    currentProjectId: P1,
    openTaskId: null,
    openRuleId: null,
    people: [
      { id: ME, alias: "member:1", name: "Avi" },
      { id: MATE, alias: "member:2", name: "Dana" },
      { id: OUTSIDER, alias: "member:3", name: "Out" },
    ],
    projects: [{ id: P1, name: "Launch", role, archived: false, sectionsLocked: false, memberIds: [ME, MATE] }],
    sections: [
      { id: S_TODO, projectId: P1, name: "To do" },
      { id: S_DOING, projectId: P1, name: "Doing" },
    ],
    fields: [{ id: F_PRIORITY, projectId: P1, name: "Priority", fieldType: "single_select", options: [{ id: "hi", name: "High" }, { id: "lo", name: "Low" }], boundToSections: false, locked: false }],
    tasks: [
      { id: T_FLYER, title: "Spring flyer", notes: null, projectId: P1, sectionId: S_TODO, sortOrder: 1024, parentId: null, assigneeId: null, dueOn: null, startOn: null, completed: false, kind: "task", recurring: false, openBlockers: 0, values: {} },
      { id: T_BLOCKED, title: "Print run", notes: null, projectId: P1, sectionId: S_TODO, sortOrder: 2048, parentId: null, assigneeId: null, dueOn: null, startOn: null, completed: false, kind: "task", recurring: false, openBlockers: 2, values: {} },
      { id: T_APPROVAL, title: "Sign-off", notes: null, projectId: P1, sectionId: S_DOING, sortOrder: 1, parentId: null, assigneeId: null, dueOn: null, startOn: null, completed: false, kind: "approval", recurring: false, openBlockers: 0, values: {} },
    ],
    rules: [{ id: R_TRIAGE, projectId: P1, name: "Triage", enabled: true, triggerType: "task_created", triggerConfig: {}, conditions: [], actions: [{ type: "move_section", section_id: S_DOING }] }],
  });
}

test("every supported operation resolves to ids from the context", () => {
  const ctx = staticContext();
  const res = resolveAssistantPlan(
    {
      summary: "s",
      unsupported: "",
      rules: [{ key: "D1", name: "Done mover", trigger: { type: "task_completed", ...stepBlank }, conditions: [], actions: [{ type: "move_section", ...stepBlank, section: "Doing" }] }],
      ops: [
        op({ op: "create_rule", project: "P1", rule: "D1" }),
        op({ op: "disable_rule", target: "R1" }),
        op({ op: "create_section", project: "P1", name: "Blocked", before: "S2" }),
        op({ op: "rename_section", target: "S1", name: "Backlog" }),
        op({ op: "move_section", target: "S2", before: "S1" }),
        op({ op: "rename_task", target: "T1", name: "Flyer" }),
        op({ op: "set_description", target: "T1", text: "Two sides" }),
        op({ op: "move_task", target: "T2", section: "Blocked" }),
        op({ op: "assign_task", target: "T1", person: "member:2" }),
        op({ op: "set_dates", target: "T1", due: "2026-11-30", start: "2026-11-20" }),
        op({ op: "set_field", target: "T1", field: "F1", value: "High" }),
        op({ op: "complete_task", target: "T1" }),
      ],
    },
    ctx,
  );
  assert.ok(res.ok, JSON.stringify(res));
  if (!res.ok) return;
  assert.deepEqual(res.plan.rejected, []);
  assert.equal(res.plan.ops.length, 12);
  const move = res.plan.ops.find((o) => o.op === "move_task");
  assert.equal(move?.op === "move_task" ? move.newSection : -1, 2, "the move needs the new section");
  const field = res.plan.ops.find((o) => o.op === "set_field");
  assert.equal(field?.op === "set_field" ? field.value : null, "hi");
  const rule = res.plan.ops[0];
  assert.equal(rule.op === "create_rule" ? rule.rule.actions[0].section_id : null, S_DOING);
  assert.equal(selectionProblem(res.plan.ops, [7]), "Change 8 needs change 3 (the new section)");
  assert.equal(selectionProblem(res.plan.ops, [2, 7]), null);
});

test("anything unsupported, unknown, or not allowed is left out with a reason, never invented", () => {
  const ctx = staticContext();
  const res = resolveAssistantPlan(
    {
      summary: "",
      unsupported: "Sending an email isn’t something I can do",
      rules: [{ key: "D1", name: "Ping", trigger: { type: "task_completed", ...stepBlank }, conditions: [], actions: [{ type: "notify", ...stepBlank, people: ["member:1"], text: "hi" }] }],
      ops: [
        op({ op: "drop_table", target: "T1" }),
        op({ op: "rename_task", target: "T99", name: "Ghost" }),
        op({ op: "rename_task", target: "11111111-1111-4111-8111-111111111111", name: "By id" }),
        op({ op: "assign_task", target: "T1", person: "member:3" }),
        op({ op: "complete_task", target: "T2" }),
        op({ op: "complete_task", target: "T3" }),
        op({ op: "create_rule", project: "P1", rule: "D1" }),
        op({ op: "set_field", target: "T1", field: "F1", value: "Urgent" }),
        op({ op: "rename_task", target: "T1", name: "Ok" }),
      ],
    },
    ctx,
  );
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.plan.ops.length, 1);
  assert.equal(res.plan.ops[0].op, "rename_task");
  const reasons = res.plan.rejected.map((r) => r.reason).join(" | ");
  assert.match(reasons, /not something the assistant can do/);
  assert.match(reasons, /isn’t on this page/);
  assert.match(reasons, /isn’t a member/);
  assert.match(reasons, /blocked by 2 tasks/);
  assert.match(reasons, /approvers/);
  assert.match(reasons, /not an action this builder supports/);
  assert.match(reasons, /isn’t an option/);
  assert.equal(res.plan.unsupported, "Sending an email isn’t something I can do");
});

test("roles: Viewers change nothing, Editors don't touch automations", () => {
  const viewer = resolveAssistantPlan({ summary: "", unsupported: "", rules: [], ops: [op({ op: "rename_task", target: "T1", name: "X" })] }, staticContext("viewer"));
  assert.ok(!viewer.ok && /doesn’t allow editing/.test(viewer.error));
  const editor = resolveAssistantPlan({ summary: "", unsupported: "", rules: [], ops: [op({ op: "disable_rule", target: "R1" }), op({ op: "rename_task", target: "T1", name: "X" })] }, staticContext("editor"));
  assert.ok(editor.ok);
  if (editor.ok) {
    assert.deepEqual(editor.plan.ops.map((o) => o.op), ["rename_task"]);
    assert.match(editor.plan.rejected[0].reason, /Owners and Admins/);
  }
});

// ---- Propose, confirm, apply, undo (in-memory database) --------------------------------------------

test("nothing is written before Confirm; apply writes every chosen change; Undo puts it all back", async () => {
  const s = world();
  const original = live(s);
  const d = db(s);
  const prov = provider((ctx) => ({
    summary: "Reorganize",
    unsupported: "",
    rules: [{ key: "D1", name: "Done mover", trigger: { type: "task_completed", ...stepBlank }, conditions: [], actions: [{ type: "move_section", ...stepBlank, section: "Done" }] }],
    ops: [
      op({ op: "create_rule", project: "P1", rule: "D1" }),
      op({ op: "disable_rule", target: ref(ctx, "automations", "Triage") }),
      op({ op: "create_section", project: "P1", name: "Blocked", before: sectionRef(ctx, "Doing") }),
      op({ op: "rename_section", target: sectionRef(ctx, "To do"), name: "Backlog" }),
      op({ op: "move_section", target: sectionRef(ctx, "Done"), before: sectionRef(ctx, "To do") }),
      op({ op: "rename_task", target: ref(ctx, "tasks", "Spring flyer"), name: "Flyer v2" }),
      op({ op: "set_description", target: ref(ctx, "tasks", "Spring flyer"), text: "Two sides" }),
      op({ op: "move_task", target: ref(ctx, "tasks", "Print run"), section: "Blocked" }),
      op({ op: "assign_task", target: ref(ctx, "tasks", "Spring flyer"), person: "member:2" }),
      op({ op: "set_dates", target: ref(ctx, "tasks", "Spring flyer"), due: "2026-11-30", start: "2026-11-21" }),
      op({ op: "set_field", target: ref(ctx, "tasks", "Spring flyer"), field: "F1", value: "High" }),
      op({ op: "complete_task", target: ref(ctx, "tasks", "Proofread") }),
      op({ op: "move_task", target: ref(ctx, "tasks", "Sign-off"), project: "P2", section: sectionRef(ctx, "Inbox") }),
      op({ op: "remove_rule", target: ref(ctx, "automations", "Email the client") }),
    ],
  }));
  const proposal = await propose(d, prov.p, "Reorganize everything and add an automation", { kind: "task", projectId: P1, taskId: T_FLYER, ruleId: null });
  assert.equal(prov.calls[0].kind, "assistant_large", "automations go to Sonnet");
  assert.deepEqual(proposal.rejected, []);
  assert.equal(proposal.ops.length, 14);
  assert.equal(live(s), original, "proposing writes nothing");
  assert.equal(s.ai_assistant_runs[0].status, "proposed");
  assert.equal(s.ai_assistant_runs[0].route_reason, "mentions_rules");

  const ctx = createApiContext(d);
  const result = await applyAssistantRun(ctx, { runId: proposal.runId, applyKey: "apply-key-0001", selected: proposal.ops.map((_, i) => i) });
  assert.equal(result.applied, 14);
  const flyer = s.tasks.find((t) => t.id === T_FLYER)!;
  assert.equal(flyer.title, "Flyer v2");
  assert.equal(flyer.assignee_id, MATE);
  assert.equal(flyer.due_on, "2026-11-30");
  assert.ok(s.tasks.find((t) => t.id === T_SUB)!.completed_at, "the subtask was completed");
  const blocked = s.sections.find((x) => x.name === "Blocked")!;
  assert.equal(s.task_projects.find((m) => m.task_id === T_BLOCKED && !m.deleted_at)!.section_id, blocked.id);
  assert.equal(s.task_projects.find((m) => m.task_id === T_APPROVAL && m.project_id === P2 && !m.deleted_at)?.section_id, S_P2);
  assert.ok(s.task_projects.find((m) => m.task_id === T_APPROVAL && m.project_id === P1)!.deleted_at);
  const made = s.rules.find((r) => r.name === "Done mover")!;
  assert.equal(made.enabled, false, "an AI-made automation starts off");
  assert.equal(s.rules.find((r) => r.id === R_TRIAGE)!.enabled, false);
  assert.ok(s.rules.find((r) => r.id === R_FANCY)!.deleted_at);
  assert.equal(s.ai_assistant_runs[0].status, "applied");

  // The same Confirm again does nothing new.
  const again = await applyAssistantRun(ctx, { runId: proposal.runId, applyKey: "apply-key-0001", selected: [0] });
  assert.equal(again.repeated, true);

  const undo = await undoAssistantRun(ctx, proposal.runId);
  assert.deepEqual(undo, { status: "undone", undone: 14 });
  assert.equal(live(s), original, "Undo restores every value, the removed automation, and removes only what it made");
  assert.ok(s.sections.find((x) => x.name === "Blocked")!.deleted_at);
  assert.ok(made.deleted_at);
  assert.deepEqual(await undoAssistantRun(ctx, proposal.runId), { status: "already_undone", undone: 0 }, "a repeated Undo is safe");
});

test("only the chosen changes are applied", async () => {
  const s = world();
  const d = db(s);
  const prov = provider((ctx) => ({
    summary: "",
    unsupported: "",
    rules: [],
    ops: [op({ op: "rename_task", target: ref(ctx, "tasks", "Spring flyer"), name: "A" }), op({ op: "rename_task", target: ref(ctx, "tasks", "Print run"), name: "B" })],
  }));
  const proposal = await propose(d, prov.p, "Rename both");
  await applyAssistantRun(createApiContext(d), { runId: proposal.runId, applyKey: "apply-key-0002", selected: [1] });
  assert.equal(s.tasks.find((t) => t.id === T_FLYER)!.title, "Spring flyer");
  assert.equal(s.tasks.find((t) => t.id === T_BLOCKED)!.title, "B");
});

test("stale data is refused before anything is written", async () => {
  const s = world();
  const d = db(s);
  const prov = provider((ctx) => ({ summary: "", unsupported: "", rules: [], ops: [op({ op: "set_description", target: ref(ctx, "tasks", "Print run"), text: "New" }), op({ op: "rename_task", target: ref(ctx, "tasks", "Spring flyer"), name: "Flyer" })] }));
  const proposal = await propose(d, prov.p, "Change both");
  s.tasks.find((t) => t.id === T_FLYER)!.title = "Renamed by someone else";
  const before = live(s);
  await assert.rejects(applyAssistantRun(createApiContext(d), { runId: proposal.runId, applyKey: "apply-key-0003", selected: [0, 1] }), reject("conflict", "Something changed"));
  assert.equal(live(s), before);
  assert.equal(s.ai_assistant_runs[0].status, "failed");
  assert.equal(s.ai_assistant_runs[0].error_code, "stale");
});

test("Undo refuses, and lists them, when what it changed has changed since", async () => {
  const s = world();
  const d = db(s);
  const prov = provider((ctx) => ({ summary: "", unsupported: "", rules: [], ops: [op({ op: "rename_task", target: ref(ctx, "tasks", "Spring flyer"), name: "Flyer" }), op({ op: "set_description", target: ref(ctx, "tasks", "Print run"), text: "x" })] }));
  const proposal = await propose(d, prov.p, "Rename it");
  const ctx = createApiContext(d);
  await applyAssistantRun(ctx, { runId: proposal.runId, applyKey: "apply-key-0004", selected: [0, 1] });
  s.tasks.find((t) => t.id === T_FLYER)!.title = "Edited by hand";
  const undo = await undoAssistantRun(ctx, proposal.runId);
  assert.equal(undo.status, "conflict");
  assert.equal(s.tasks.find((t) => t.id === T_FLYER)!.title, "Edited by hand", "nothing was undone");
  assert.equal(s.tasks.find((t) => t.id === T_BLOCKED)!.notes, "x", "not even the unchanged one");
});

test("permissions are checked again at Confirm: a role lowered since refuses, writing nothing", async () => {
  const s = world();
  const d = db(s);
  const prov = provider((ctx) => ({ summary: "", unsupported: "", rules: [], ops: [op({ op: "rename_task", target: ref(ctx, "tasks", "Spring flyer"), name: "Flyer" })] }));
  const proposal = await propose(d, prov.p, "Rename it");
  s.project_members.find((m) => m.project_id === P1 && m.profile_id === ME)!.role = "viewer";
  const before = live(s);
  await assert.rejects(applyAssistantRun(createApiContext(d), { runId: proposal.runId, applyKey: "apply-key-0005", selected: [0] }), reject("forbidden"));
  assert.equal(live(s), before);
});

test("the blocked-task guard holds: a task blocked after the proposal isn't completed", async () => {
  const s = world();
  let blockers: Record<string, number> = {};
  const make = () => db(s, { blockers });
  const prov = provider((ctx) => ({ summary: "", unsupported: "", rules: [], ops: [op({ op: "complete_task", target: ref(ctx, "tasks", "Spring flyer") })] }));
  const proposal = await propose(make(), prov.p, "Complete the flyer");
  blockers = { [T_FLYER]: 1 };
  await assert.rejects(applyAssistantRun(createApiContext(make()), { runId: proposal.runId, applyKey: "apply-key-0006", selected: [0] }), reject("invalid", "blocked"));
  assert.equal(s.tasks.find((t) => t.id === T_FLYER)!.completed_at, null);
});

test("a change refused part way rolls back what was already written", async () => {
  const s = world();
  const d = db(s, { refuse: (table, kind, row) => (table === "tasks" && kind === "update" && row.title === "Boom" ? { code: "42501", message: "denied" } : null) });
  const prov = provider((ctx) => ({
    summary: "",
    unsupported: "",
    rules: [],
    ops: [op({ op: "rename_section", target: sectionRef(ctx, "To do"), name: "Backlog" }), op({ op: "rename_task", target: ref(ctx, "tasks", "Spring flyer"), name: "Boom" })],
  }));
  const original = live(s);
  const proposal = await propose(d, prov.p, "Rename both");
  await assert.rejects(applyAssistantRun(createApiContext(d), { runId: proposal.runId, applyKey: "apply-key-0007", selected: [0, 1] }), (e: unknown) => isApiError(e) && /Nothing was kept/.test(e.message));
  assert.equal(live(s), original);
  assert.equal(s.ai_assistant_runs[0].status, "rolled_back");
});

test("a small model's answer with automations is asked again of the large model (logged)", async () => {
  const s = world();
  const prov = provider((ctx, request) =>
    request.kind === "assistant_small"
      ? { summary: "", unsupported: "", rules: [], ops: [op({ op: "disable_rule", target: ref(ctx, "automations", "Triage") })] }
      : { summary: "", unsupported: "", rules: [], ops: [op({ op: "disable_rule", target: ref(ctx, "automations", "Triage") })] },
  );
  await propose(db(s), prov.p, "Turn off triage");
  assert.deepEqual(prov.calls.map((c) => c.kind), ["assistant_small", "assistant_large"]);
  assert.equal(s.ai_assistant_runs[0].route_reason, "escalated_rules");
  assert.equal(s.ai_assistant_runs[0].escalated, true);
  assert.equal(s.ai_assistant_runs[0].model, "claude-sonnet-5-5");
  assert.equal(s.ai_assistant_runs[0].input_tokens, 200, "both calls' usage is logged");
});

test("provider failures are logged safely and nothing is applied", async () => {
  for (const [code, detail] of [
    ["provider_error", "HTTP 400 invalid_request_error Schemas contains too many parameters with union types (21 parameters with type arrays or anyOf). sk-ant-api03-SECRET"],
    ["rate_limited", "HTTP 429 rate_limit_error slow down"],
    ["timeout", null],
    ["not_configured", null],
  ] as const) {
    const s = world();
    const prov = provider(() => ({ ok: false, code, detail, model: "claude-haiku-5-5", inputTokens: null, outputTokens: null }));
    await assert.rejects(propose(db(s), prov.p, "Rename the flyer"), (e: unknown) => isApiError(e) && !e.message.includes("sk-ant") && !e.message.includes("HTTP"));
    const runRow = s.ai_assistant_runs[0];
    assert.equal(runRow.status, "failed");
    assert.equal(runRow.error_code, code);
    if (detail) {
      assert.ok(String(runRow.error_detail).startsWith(detail.slice(0, 8)), "the provider's status and type are kept");
      assert.ok(!String(runRow.error_detail).includes("sk-ant-api03"), "never the key");
    }
    assert.ok(!JSON.stringify(runRow).includes("Rename the flyer"), "never the prompt or the request's text");
  }
  // Malformed and truncated answers: nothing proposed, the run failed.
  for (const out of ["not json", { ops: "x" }, { summary: "", unsupported: "", ops: [op({ op: "rename_task", target: "T999", name: "x" })], rules: [] }]) {
    const s = world();
    const prov = provider(() => out);
    await assert.rejects(propose(db(s), prov.p, "Turn this into something long and then also rename"), reject("invalid"));
    assert.equal(s.ai_assistant_runs[0].status, "failed");
  }
  const s = world();
  const truncated = provider(() => ({ ok: false, code: "truncated", model: "claude-sonnet-5-5", inputTokens: 1, outputTokens: 6000 }));
  await assert.rejects(propose(db(s), truncated.p, "Several steps; and then more"), reject("unavailable"));
  assert.equal(s.ai_assistant_runs[0].error_code, "truncated");
});

test("an unconfigured deployment or a malformed request makes no run and no call", async () => {
  const s = world();
  const prov = provider(() => ({}));
  prov.p.configured = false;
  await assert.rejects(propose(db(s), prov.p), reject("unavailable"));
  prov.p.configured = true;
  await assert.rejects(proposeChanges(createApiContext(db(s)), { requestKey: "x", page: PAGE, instruction: "a", localToday: "2026-11-08" }, prov.p), reject("invalid"));
  await assert.rejects(proposeChanges(createApiContext(db(s)), { requestKey: "req-key-1234", page: PAGE, instruction: "", localToday: "2026-11-08" }, prov.p), reject("invalid"));
  await assert.rejects(proposeChanges(createApiContext(db(s)), { requestKey: "req-key-1234", page: { kind: "project" }, instruction: "a", localToday: "2026-11-08" }, prov.p), reject("invalid"));
  assert.equal(s.ai_assistant_runs.length, 0);
  assert.equal(prov.calls.length, 0);
});
