// AI builder round 4 (notes 172–176): the role table, custom field operations and their Undo, Turn on &
// Finish, and answer mode. Synthetic fixtures only: the model is a fake provider (no billable call) and the
// database an in-memory stand-in (no live writes).
import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSISTANT_ANSWER_SCHEMA,
  ASSISTANT_JSON_SCHEMA,
  ASSISTANT_OPS,
  assistantMode,
  contextForModel,
  isHowToQuestion,
  resolveAssistantPlan,
  withRefs,
  type AssistantContext,
} from "@alhc/core/ai-assistant";
import { AI_CAPABILITIES, AI_CAPABILITY_OPS, allowedGroups, capabilityMatrix, capabilityRefusal, type AiCapabilityFacts } from "@alhc/core/ai-capabilities";
import { AI_BUILDER_CALLS, structuredOutputIssues } from "@alhc/core/ai-builder";
import { PROJECT_ROLES, type ProjectRole } from "@alhc/core/roles";
import { createApiContext } from "@alhc/core/api/core/context";
import { isApiError } from "@alhc/core/api/core/errors";
import type { AiProposalProvider, AiProviderRequest, AiProviderResult } from "@alhc/core/api/ai-builder/model";
import { applyAssistantRun, proposeChanges, turnOnAssistantRules, undoAssistantRun } from "@alhc/core/api/ai-assistant/mutations";
import { memoryDb, type MemoryState } from "./memory-db";

const WS = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const MATE = "22222222-2222-4222-8222-222222222223";
const P1 = "33333333-3333-4333-8333-333333333331";
const P2 = "33333333-3333-4333-8333-333333333332";
const S_TODO = "44444444-4444-4444-8444-444444444441";
const S_DONE = "44444444-4444-4444-8444-444444444442";
const T_FLYER = "55555555-5555-4555-8555-555555555551";
const T_POSTER = "55555555-5555-4555-8555-555555555552";
const F_PRIORITY = "66666666-6666-4666-8666-666666666661";
const F_BUDGET = "66666666-6666-4666-8666-666666666662";
const F_SHARED = "66666666-6666-4666-8666-666666666663";
const F_SOURCE = "66666666-6666-4666-8666-666666666664";
const F_STATUS = "66666666-6666-4666-8666-666666666665";
const R_OTHER = "77777777-7777-4777-8777-777777777771";

const task = (id: string, title: string) => ({
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
});
const field = (id: string, project: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  project_id: project,
  name,
  field_type: "text",
  options: [],
  bound_to_sections: false,
  show_in_views: true,
  sort_order: 1,
  locked: false,
  library_field_id: null,
  deleted_at: null,
  ...extra,
});

function world(role: ProjectRole = "owner"): MemoryState {
  return {
    ai_pilot_workspaces: [{ workspace_id: WS, cleaned_at: null }],
    workspaces: [{ id: WS, name: "Testing data", deleted_at: null }],
    projects: [
      { id: P1, name: "Launch", workspace_id: WS, archived_at: null, sections_locked: false, deleted_at: null },
      { id: P2, name: "Library", workspace_id: WS, archived_at: null, sections_locked: false, deleted_at: null },
    ],
    project_members: [
      { project_id: P1, profile_id: ME, role, deleted_at: null },
      { project_id: P1, profile_id: MATE, role: "editor", deleted_at: null },
      { project_id: P2, profile_id: ME, role: "owner", deleted_at: null },
    ],
    sections: [
      { id: S_TODO, project_id: P1, name: "To do", sort_order: 1024, deleted_at: null },
      { id: S_DONE, project_id: P1, name: "Done", sort_order: 2048, deleted_at: null },
    ],
    tasks: [task(T_FLYER, "Spring flyer"), task(T_POSTER, "Poster")],
    task_projects: [
      { task_id: T_FLYER, project_id: P1, section_id: S_TODO, sort_order: 1024, deleted_at: null },
      { task_id: T_POSTER, project_id: P1, section_id: S_TODO, sort_order: 2048, deleted_at: null },
    ],
    custom_fields: [
      field(F_PRIORITY, P1, "Priority", {
        field_type: "single_select",
        options: [
          { id: "hi", name: "High", color: "red" },
          { id: "lo", name: "Low", color: "green" },
        ],
      }),
      field(F_BUDGET, P1, "Budget", { field_type: "number", locked: true, sort_order: 2 }),
      field(F_SHARED, P1, "Channel", { library_field_id: F_SOURCE, sort_order: 3 }),
      field(F_SOURCE, P2, "Channel", { sort_order: 1 }),
      field(F_STATUS, P1, "Status", { field_type: "single_select", bound_to_sections: true, sort_order: 4 }),
    ],
    task_field_values: [
      { task_id: T_FLYER, field_id: F_PRIORITY, value: "lo" },
      { task_id: T_POSTER, field_id: F_PRIORITY, value: "hi" },
      { task_id: T_FLYER, field_id: F_SHARED, value: "Email" },
      { task_id: T_FLYER, field_id: F_SOURCE, value: "Email" },
    ],
    rules: [
      {
        id: R_OTHER,
        project_id: P1,
        name: "Someone else's",
        enabled: false,
        trigger_type: "task_created",
        trigger_config: {},
        conditions: [],
        actions: [{ type: "move_section", section_id: S_DONE }],
        preset_key: null,
        sort_order: 1024,
        deleted_at: null,
      },
    ],
    ai_assistant_runs: [],
  };
}

function db(state: MemoryState, log?: string[]) {
  return memoryDb(state, {
    log,
    defaults: { ai_assistant_runs: { status: "generating", escalated: false, op_count: 0, actor_id: ME, apply_key: null, applied: null } },
    rpcs: {
      ai_pilot_admin: () => ({ data: true }),
      ai_pilot_members: () => ({
        data: [
          { profile_id: ME, name: "Avi", email: "avi@example.com", is_me: true },
          { profile_id: MATE, name: "Dana", email: "dana@example.com", is_me: false },
        ],
      }),
      project_role: (args, s) => ({ data: s.project_members.find((m) => m.project_id === args.target_project && m.profile_id === ME && !m.deleted_at)?.role ?? null }),
      open_blocker_counts: () => ({ data: {} }),
      // The field library's answer for the project: the placement's definition belongs to P2's editors.
      project_field_sharing: (args) =>
        args.target_project === P1
          ? {
              data: [
                { field_id: F_SHARED, library_field_id: F_SOURCE, is_source: false, is_shared: true, placement_count: 2, definition_editable: false, definition_manageable: false },
              ],
            }
          : { data: [] },
    },
  });
}

type ModelCtx = ReturnType<typeof contextForModel>;
const modelContext = (request: AiProviderRequest): ModelCtx => JSON.parse(/<context>\n([\s\S]*?)\n<\/context>/.exec(request.prompt)![1]);
const blank = { target: "", name: "", text: "", section: "", before: "", project: "", person: "", field: "", value: "", due: "", start: "", rule: "", field_type: "", options: [] as string[] };
const op = (o: Partial<typeof blank> & { op: string }) => ({ ...blank, ...o });
const fieldRef = (ctx: ModelCtx, name: string, project = "P1") => ctx.fields.find((f) => f.name === name && f.project === project)!.ref;
const stepBlank = { section: "", field: "", value: "", days: -1, text: "", people: [], person: "", titles: [] };

function provider(answer: (ctx: ModelCtx, request: AiProviderRequest) => AiProviderResult | unknown) {
  const calls: AiProviderRequest[] = [];
  const p: AiProposalProvider = {
    configured: true,
    async generate(request) {
      calls.push(request);
      const out = answer(modelContext(request), request);
      if (out && typeof out === "object" && "ok" in out) return out as AiProviderResult;
      return { ok: true, output: out, model: AI_BUILDER_CALLS[request.kind ?? "assistant_small"].model, inputTokens: 10, outputTokens: 5 };
    },
  };
  return { p, calls };
}
const PAGE = { kind: "project", projectId: P1, taskId: null, ruleId: null };
let keyN = 0;
const propose = (d: ReturnType<typeof db>, prov: AiProposalProvider, instruction: string) =>
  proposeChanges(createApiContext(d), { requestKey: `req-r4-${String(++keyN).padStart(6, "0")}`, page: PAGE, instruction, localToday: "2026-11-09" }, prov);
const apply = (d: ReturnType<typeof db>, runId: string, selected: number[]) =>
  applyAssistantRun(createApiContext(d), { runId, applyKey: `apply-r4-${String(++keyN).padStart(6, "0")}`, selected });
const live = (s: MemoryState) =>
  JSON.stringify({
    fields: s.custom_fields.map(({ id, name, options, deleted_at }) => ({ id, name, options, deleted: Boolean(deleted_at) })),
    values: s.task_field_values,
    rules: s.rules.map(({ id, enabled, deleted_at }) => ({ id, enabled, deleted: Boolean(deleted_at) })),
    tasks: s.tasks,
  });

// ---- The role table --------------------------------------------------------------------------------

const facts = (role: ProjectRole | null, extra: Partial<AiCapabilityFacts> = {}): AiCapabilityFacts => ({ projectName: "Launch", role, archived: false, sectionsLocked: false, ...extra });
const plainField = { name: "Priority", locked: false, boundToSections: false, shared: false, definitionEditable: null, definitionManageable: null };

test("the role table covers every assistant operation and mirrors the manual roles", () => {
  assert.deepEqual(new Set(ASSISTANT_OPS), new Set(AI_CAPABILITY_OPS), "one entry per operation");
  const groups = { automations: "admin", sections: "editor", tasks: "editor", fields: "editor" } as const;
  for (const opName of AI_CAPABILITY_OPS) assert.equal(AI_CAPABILITIES[opName].minRole, groups[AI_CAPABILITIES[opName].group], opName);
  for (const role of PROJECT_ROLES) {
    for (const opName of AI_CAPABILITY_OPS) {
      const extra = opName.includes("field") ? { field: plainField } : {};
      const allowed = capabilityRefusal(opName, facts(role, extra)) === null;
      const expected = role === "owner" || role === "admin" || (role === "editor" && AI_CAPABILITIES[opName].group !== "automations");
      assert.equal(allowed, expected, `${role} ${opName}`);
    }
  }
  // Commenters and Viewers: nothing at all; an archived project: nothing for anyone.
  for (const row of capabilityMatrix()) assert.ok(!row.commenter && !row.viewer && row.owner, row.op);
  assert.match(capabilityRefusal("rename_task", facts("owner", { archived: true }))!, /archived/);
  assert.deepEqual(allowedGroups("viewer", false, false), []);
  assert.deepEqual(allowedGroups("editor", false, true), ["tasks", "fields"], "locked sections: Owners only");
  assert.deepEqual(allowedGroups("owner", false, true).sort(), ["automations", "fields", "sections", "tasks"]);
});

test("locked, shared, and Status fields follow the manual rules", () => {
  const locked = { ...plainField, name: "Budget", locked: true };
  for (const o of ["rename_field", "update_field_options", "remove_field", "set_field"] as const) {
    assert.match(capabilityRefusal(o, facts("editor", { field: locked }))!, /locked/, `editor ${o}`);
    assert.equal(capabilityRefusal(o, facts("admin", { field: locked })), null, `admin ${o}`);
  }
  // A shared library field's definition belongs to the publishing project's editors; removing it here is
  // this project's own business.
  const shared = { ...plainField, name: "Channel", shared: true, definitionEditable: false, definitionManageable: false };
  assert.match(capabilityRefusal("rename_field", facts("owner", { field: shared }))!, /field library/);
  assert.match(capabilityRefusal("update_field_options", facts("owner", { field: shared }))!, /field library/);
  assert.equal(capabilityRefusal("remove_field", facts("editor", { field: shared })), null);
  // A locked field whose governing project is another: its own Owner can't change the definition.
  assert.match(capabilityRefusal("rename_field", facts("owner", { field: { ...locked, shared: true, definitionEditable: true, definitionManageable: false } }))!, /locked/);
  const status = { ...plainField, name: "Status", boundToSections: true };
  assert.match(capabilityRefusal("remove_field", facts("owner", { field: status }))!, /follows the sections/);
  assert.match(capabilityRefusal("update_field_options", facts("owner", { field: status }))!, /follows the sections/);
  assert.match(capabilityRefusal("set_field", facts("owner", { field: status }))!, /move the task/);
});

// ---- Resolver ----------------------------------------------------------------------------------

function staticContext(role: ProjectRole): AssistantContext {
  return withRefs({
    page: "project",
    today: "2026-11-09",
    currentProjectId: P1,
    openTaskId: null,
    openRuleId: null,
    people: [{ id: ME, alias: "member:1", name: "Avi" }],
    projects: [{ id: P1, name: "Launch", role, archived: false, sectionsLocked: false, memberIds: [ME] }],
    sections: [{ id: S_TODO, projectId: P1, name: "To do" }],
    fields: [
      { id: F_PRIORITY, projectId: P1, name: "Priority", fieldType: "single_select", options: [{ id: "hi", name: "High", color: "red" }, { id: "lo", name: "Low", color: "green" }], boundToSections: false, locked: false },
      { id: F_BUDGET, projectId: P1, name: "Budget", fieldType: "number", options: [], boundToSections: false, locked: true },
      { id: F_SHARED, projectId: P1, name: "Channel", fieldType: "text", options: [], boundToSections: false, locked: false, shared: true, definitionEditable: false, definitionManageable: false },
    ],
    tasks: [],
    rules: [],
  });
}

const fieldOps = [
  op({ op: "create_field", project: "P1", name: "Effort", field_type: "single_select", options: ["S", "M", "L"] }),
  op({ op: "rename_field", target: "F1", name: "Urgency" }),
  op({ op: "update_field_options", target: "F1", options: ["High", "Low => Lowest", "Medium"] }),
  op({ op: "remove_field", target: "F2" }),
  op({ op: "rename_field", target: "F3", name: "Medium" }),
  op({ op: "remove_field", target: "F3" }),
];

test("the validator: each role × each field op, allowed and refused with a plain reason", () => {
  for (const role of PROJECT_ROLES) {
    const res = resolveAssistantPlan({ summary: "", unsupported: "", rules: [], ops: fieldOps }, staticContext(role));
    if (role === "commenter" || role === "viewer") {
      assert.ok(!res.ok && /doesn’t allow editing/.test(res.error), role);
      continue;
    }
    assert.ok(res.ok, role);
    if (!res.ok) continue;
    const kept = res.plan.ops.map((o) => `${o.op}:${"fieldId" in o ? o.fieldId : "new"}`);
    const admin = role !== "editor";
    assert.deepEqual(kept, [
      "create_field:new",
      "rename_field:" + F_PRIORITY,
      "update_field_options:" + F_PRIORITY,
      ...(admin ? ["remove_field:" + F_BUDGET] : []),
      "remove_field:" + F_SHARED,
    ], role);
    const reasons = res.plan.rejected.map((r) => r.reason).join(" | ");
    assert.match(reasons, /field library/, "a shared field's rename is refused for everyone here");
    if (!admin) assert.match(reasons, /locked/);
  }
});

test("field ops resolve options by name: kept ids, renames keep their values, new ones get ids", () => {
  const res = resolveAssistantPlan({ summary: "", unsupported: "", rules: [], ops: [fieldOps[0], fieldOps[2]] }, staticContext("owner"));
  assert.ok(res.ok);
  if (!res.ok) return;
  const [create, options] = res.plan.ops;
  assert.equal(create.op, "create_field");
  if (create.op === "create_field") {
    assert.equal(create.fieldType, "single_select");
    assert.deepEqual(create.options.map((o) => o.name), ["S", "M", "L"]);
    assert.equal(new Set(create.options.map((o) => o.id)).size, 3);
  }
  assert.equal(options.op, "update_field_options");
  if (options.op === "update_field_options") {
    assert.deepEqual(options.options.slice(0, 2), [
      { id: "hi", name: "High", color: "red" },
      { id: "lo", name: "Lowest", color: "green" },
    ]);
    assert.equal(options.options[2].name, "Medium");
    assert.deepEqual(options.removedOptionIds, []);
    assert.match(options.label, /adds “Medium”; renames Low → Lowest/);
  }
  const bad = resolveAssistantPlan(
    {
      summary: "",
      unsupported: "",
      rules: [],
      ops: [
        op({ op: "create_field", project: "P1", name: "Size", field_type: "single_select", options: [] }),
        op({ op: "create_field", project: "P1", name: "Priority", field_type: "text" }),
        op({ op: "create_field", project: "P1", name: "Weird", field_type: "formula" }),
        op({ op: "update_field_options", target: "F1", options: ["Ghost => Real"] }),
        op({ op: "update_field_options", target: "F1", options: [] }),
      ],
    },
    staticContext("owner"),
  );
  assert.ok(!bad.ok);
});

// ---- Apply and Undo (in-memory database) -----------------------------------------------------------

test("fields: apply creates, renames, changes options, removes; Undo brings every one back, values intact", async () => {
  const s = world("owner");
  const original = live(s);
  const d = db(s);
  const prov = provider((ctx) => ({
    summary: "Fields",
    unsupported: "",
    rules: [],
    ops: [
      op({ op: "create_field", project: "P1", name: "Effort", field_type: "single_select", options: ["S", "M"] }),
      op({ op: "rename_field", target: fieldRef(ctx, "Priority"), name: "Urgency" }),
      op({ op: "update_field_options", target: fieldRef(ctx, "Priority"), options: ["High"] }),
      op({ op: "remove_field", target: fieldRef(ctx, "Budget") }),
    ],
  }));
  const proposal = await propose(d, prov.p, "Take away the budget field, add effort, rename priority and drop Low");
  assert.equal(live(s), original, "proposing writes nothing");
  const options = proposal.ops.find((o) => o.op === "update_field_options")!;
  assert.match(options.after, /1 task uses a removed option/);
  const removal = proposal.ops.find((o) => o.op === "remove_field")!;
  assert.match(removal.after, /no task has a value|values are kept/);

  await apply(d, proposal.runId, [0, 1, 2, 3]);
  const effort = s.custom_fields.find((f) => f.name === "Effort")!;
  assert.ok(effort && !effort.deleted_at && effort.show_in_views === true);
  const priority = s.custom_fields.find((f) => f.id === F_PRIORITY)!;
  assert.equal(priority.name, "Urgency");
  assert.deepEqual((priority.options as { name: string }[]).map((o) => o.name), ["High"]);
  assert.ok(s.custom_fields.find((f) => f.id === F_BUDGET)!.deleted_at);
  assert.equal(s.task_field_values.length, 4, "no value is removed by any of it");

  assert.deepEqual(await undoAssistantRun(createApiContext(d), proposal.runId), { status: "undone", undone: 4 });
  const after = JSON.parse(live(s));
  const before = JSON.parse(original);
  assert.deepEqual(
    after.fields.filter((f: { id: string }) => f.id !== effort.id),
    before.fields,
    "the removed field is back, the options and name are as they were",
  );
  assert.ok(effort.deleted_at, "Undo removes only what it made");
  assert.deepEqual(after.values, before.values, "values intact");
});

test("removing a shared library field removes it from this project only", async () => {
  const s = world("editor");
  const d = db(s);
  const prov = provider((ctx) => ({ summary: "", unsupported: "", rules: [], ops: [op({ op: "remove_field", target: fieldRef(ctx, "Channel") })] }));
  const proposal = await propose(d, prov.p, "Remove the channel field");
  assert.match(proposal.ops[0].label, /from “Launch”/);
  assert.match(proposal.ops[0].after, /other projects keep it/);
  assert.match(proposal.ops[0].after, /1 task has a value; values are kept/);
  await apply(d, proposal.runId, [0]);
  assert.ok(s.custom_fields.find((f) => f.id === F_SHARED)!.deleted_at);
  assert.equal(s.custom_fields.find((f) => f.id === F_SOURCE)!.deleted_at, null, "the source and other projects keep it");
  await undoAssistantRun(createApiContext(d), proposal.runId);
  assert.equal(s.custom_fields.find((f) => f.id === F_SHARED)!.deleted_at, null);
});

test("apply re-checks the role table: a field locked (or a role lowered) since the proposal is refused, nothing written", async () => {
  const s = world("editor");
  const d = db(s);
  const prov = provider((ctx) => ({ summary: "", unsupported: "", rules: [], ops: [op({ op: "rename_field", target: fieldRef(ctx, "Priority"), name: "Urgency" })] }));
  const proposal = await propose(d, prov.p, "Rename priority");
  s.custom_fields.find((f) => f.id === F_PRIORITY)!.locked = true;
  const before = live(s);
  await assert.rejects(apply(d, proposal.runId, [0]), (e: unknown) => isApiError(e) && e.code === "forbidden" && /locked/.test(e.message));
  assert.equal(live(s), before);

  const s2 = world("owner");
  const d2 = db(s2);
  const p2 = await propose(d2, provider((ctx) => ({ summary: "", unsupported: "", rules: [], ops: [op({ op: "remove_field", target: fieldRef(ctx, "Budget") })] })).p, "Remove budget");
  s2.project_members.find((m) => m.project_id === P1 && m.profile_id === ME)!.role = "editor";
  await assert.rejects(apply(d2, p2.runId, [0]), (e: unknown) => isApiError(e) && e.code === "forbidden");
  assert.equal(s2.custom_fields.find((f) => f.id === F_BUDGET)!.deleted_at, null);
});

// ---- Turn on & Finish (note 173) --------------------------------------------------------------------

const draft = { key: "D1", name: "Done mover", trigger: { type: "task_completed", ...stepBlank }, conditions: [], actions: [{ type: "move_section", ...stepBlank, section: "Done" }] };

test("Turn on & Finish turns on only this run's automations; Undo turns it off, then removes it", async () => {
  const s = world("owner");
  const log: string[] = [];
  const d = db(s, log);
  const prov = provider(() => ({ summary: "", unsupported: "", rules: [draft], ops: [op({ op: "create_rule", project: "P1", rule: "D1" })] }));
  const proposal = await propose(d, prov.p, "Whenever a task is done, move it to Done");
  const result = await apply(d, proposal.runId, [0]);
  assert.equal(result.createdRules.length, 1);
  const made = s.rules.find((r) => r.id === result.createdRules[0].ruleId)!;
  assert.equal(made.enabled, false, "created off");

  await assert.rejects(turnOnAssistantRules(createApiContext(d), proposal.runId, [R_OTHER]), (e: unknown) => isApiError(e) && e.code === "invalid");
  const on = await turnOnAssistantRules(createApiContext(d), proposal.runId);
  assert.deepEqual(on, { turnedOn: [made.id], alreadyOn: [] });
  assert.equal(made.enabled, true);
  assert.equal(s.rules.find((r) => r.id === R_OTHER)!.enabled, false, "never another automation");
  assert.deepEqual(await turnOnAssistantRules(createApiContext(d), proposal.runId), { turnedOn: [], alreadyOn: [made.id] }, "repeating is safe");

  log.length = 0;
  assert.deepEqual(await undoAssistantRun(createApiContext(d), proposal.runId), { status: "undone", undone: 1 });
  assert.equal(made.enabled, false);
  assert.ok(made.deleted_at);
  const ruleWrites = log.filter((l) => l === "update:rules");
  assert.ok(ruleWrites.length >= 2, "off, then removed");
});

test("Editors can't turn on an AI-made automation (the role table again)", async () => {
  const s = world("owner");
  const d = db(s);
  const prov = provider(() => ({ summary: "", unsupported: "", rules: [draft], ops: [op({ op: "create_rule", project: "P1", rule: "D1" })] }));
  const proposal = await propose(d, prov.p, "Whenever a task is done, move it to Done");
  const result = await apply(d, proposal.runId, [0]);
  s.project_members.find((m) => m.project_id === P1 && m.profile_id === ME)!.role = "editor";
  await assert.rejects(turnOnAssistantRules(createApiContext(d), proposal.runId), (e: unknown) => isApiError(e) && e.code === "forbidden" && /Owners and Admins/.test(e.message));
  assert.equal(s.rules.find((r) => r.id === result.createdRules[0].ruleId)!.enabled, false);
});

test("Turn on refuses an automation changed since the run made it", async () => {
  const s = world("owner");
  const d = db(s);
  const prov = provider(() => ({ summary: "", unsupported: "", rules: [draft], ops: [op({ op: "create_rule", project: "P1", rule: "D1" })] }));
  const proposal = await propose(d, prov.p, "Whenever a task is done, move it to Done");
  const result = await apply(d, proposal.runId, [0]);
  s.rules.find((r) => r.id === result.createdRules[0].ruleId)!.name = "Edited by hand";
  await assert.rejects(turnOnAssistantRules(createApiContext(d), proposal.runId), (e: unknown) => isApiError(e) && e.code === "conflict");
});

// ---- Answer mode (notes 172, 176) -------------------------------------------------------------------

test("how-to questions are told apart from change requests", () => {
  for (const q of ["How do I add a form?", "what does this automation do", "Where are the task templates?", "Is there a way to lock sections?", "explain the Triage automation", "Can I export this list?"]) {
    assert.ok(isHowToQuestion(q), q);
  }
  for (const c of ["Take away the priority field in this project", "Can you rename this task to Flyer?", "Move the poster to Done", "please add a Blocked section", "Rename the flyer"]) {
    assert.ok(!isHowToQuestion(c), c);
  }
  assert.deepEqual(assistantMode("Rename it", false), { mode: "answer", reason: "answer_only_role" });
  assert.deepEqual(assistantMode("How do I add a form?", true), { mode: "answer", reason: "question" });
  assert.deepEqual(assistantMode("Rename it", true), { mode: "change" });
});

test("answer mode: Haiku answers, nothing is written, the run is logged without the text", async () => {
  const s = world("owner");
  const original = live(s);
  const prov = provider((_ctx, request) => {
    assert.equal(request.kind, "assistant_answer");
    assert.equal(request.schema, ASSISTANT_ANSWER_SCHEMA);
    assert.match(request.prompt, /<help>/);
    return { answer: "Open Customize → Forms → + Add form." };
  });
  const res = await propose(db(s), prov.p, "How do I add a form?");
  assert.equal(res.mode, "answer");
  assert.equal(res.answer, "Open Customize → Forms → + Add form.");
  assert.deepEqual(res.ops, []);
  assert.equal(prov.calls.length, 1);
  assert.equal(AI_BUILDER_CALLS.assistant_answer.model, "claude-haiku-5-5");
  assert.equal(live(s), original, "nothing written");
  const runRow = s.ai_assistant_runs[0];
  assert.equal(runRow.status, "proposed");
  assert.equal(runRow.op_count, 0);
  assert.equal(runRow.route_reason, "answer_question");
  assert.ok(!JSON.stringify(runRow).includes("Add form") && !JSON.stringify(runRow).includes("How do I"), "never the question or the answer");
  await assert.rejects(apply(db(s), res.runId, [0]), (e: unknown) => isApiError(e) && e.code === "invalid", "an answer can't be applied");
});

test("Commenters and Viewers get answers only: a change request is declined without a model call", async () => {
  for (const role of ["commenter", "viewer"] as const) {
    const s = world(role);
    const original = live(s);
    const prov = provider(() => ({ answer: "Forms live under Customize." }));
    const res = await propose(db(s), prov.p, "Take away the priority field in this project");
    assert.equal(res.mode, "answer");
    assert.equal(res.answerOnly, true);
    assert.match(res.answer!, /role here doesn’t allow changes/);
    assert.equal(prov.calls.length, 0, "no model call for a change it can't make");
    const q = await propose(db(s), prov.p, "How do I add a form?");
    assert.equal(q.answer, "Forms live under Customize.");
    assert.match(prov.calls[0].prompt, /<role_note>/);
    assert.equal(live(s), original);
  }
});

test("the model's context says what each project lets this person change; the schemas stay within limits", async () => {
  const prov = provider(() => ({ summary: "", unsupported: "", rules: [], ops: [op({ op: "rename_task", target: "T1", name: "x" })] }));
  await propose(db(world("editor")), prov.p, "Rename the first task");
  const ctx = modelContext(prov.calls[0]);
  assert.deepEqual(ctx.projects.find((p) => p.name === "Launch")!.may_change, ["tasks", "fields", "sections"]);
  assert.equal(ctx.fields.find((f) => f.name === "Budget")!.locked, true);
  assert.equal(ctx.fields.find((f) => f.name === "Channel")!.shared, true);
  for (const schema of [ASSISTANT_JSON_SCHEMA, ASSISTANT_ANSWER_SCHEMA]) {
    const text = JSON.stringify(schema);
    assert.equal((text.match(/"anyOf"/g) ?? []).length, 0);
    assert.ok(!text.includes('"null"'));
    assert.deepEqual(structuredOutputIssues(schema), []);
  }
});
