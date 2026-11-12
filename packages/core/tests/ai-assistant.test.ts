// AI builder rounds 3–4 (notes 171–176), on round 5's capability registry: the global assistant's change
// sets — nothing written before Confirm, only the chosen changes, stale data refused, permissions checked
// again, the blocked-task guard, rollback, Undo with conflict checks, answer mode, fields, Turn on & Finish.
// Plus round 5's MCP tools in the core. Synthetic fixtures only: a fake tool-calling model (no billable
// call) and an in-memory database (no live writes).
import assert from "node:assert/strict";
import test from "node:test";
import { ASSISTANT_ANSWER_SCHEMA, assistantMode, assistantPageFromPath, isHowToQuestion, parseAssistantPage } from "@alhc/core/ai-assistant";
import { AI_BUILDER_CALLS } from "@alhc/core/ai-builder";
import { createApiContext } from "@alhc/core/api/core/context";
import { isApiError } from "@alhc/core/api/core/errors";
import { cancelAssistantRun, turnOnAssistantRules, undoAssistantRun } from "@alhc/core/api/ai-assistant/mutations";
import { selectionProblem } from "@alhc/core/api/capabilities/engine";
import { mcpCallTool, mcpListTools, type McpIdentity } from "@alhc/core/api/mcp/tools";
import {
  ME,
  P1,
  P2,
  F_BUDGET,
  F_PRIORITY,
  PAGE,
  R_FANCY,
  R_TRIAGE,
  S_DONE,
  T_BLOCKED,
  T_FLYER,
  WS,
  apply,
  db,
  fref,
  key,
  live,
  once,
  propose,
  reject,
  rref,
  sref,
  toolModel,
  tref,
  world,
} from "./ai-fixtures";

// The live state without removed fields (a field the run made is removed by Undo, not erased).
const activeOnly = (json: string) => JSON.stringify({ ...JSON.parse(json), fields: JSON.parse(json).fields.filter((f: { deleted: boolean }) => !f.deleted) });
const renameFlyer = once((ctx) => [{ name: "rename_task", input: { task: tref(ctx, "Spring flyer"), name: "Summer flyer" } }]);

// ---- The page ------------------------------------------------------------------------------------------

test("the page comes from the address and the open task, as kinds and ids only", () => {
  assert.deepEqual(assistantPageFromPath(`/projects/${P1}/views/x`, null), { kind: "project", projectId: P1, taskId: null, ruleId: null });
  assert.equal(assistantPageFromPath(`/projects/${P1}/views/x`, T_FLYER).kind, "task");
  assert.equal(assistantPageFromPath(`/projects/${P1}/rules/${R_TRIAGE}`, null).ruleId, R_TRIAGE);
  assert.equal(assistantPageFromPath("/my-tasks", null).kind, "my_tasks");
  assert.equal(parseAssistantPage({ kind: "project", projectId: "not-an-id", taskId: null, ruleId: null }), null);
  assert.equal(parseAssistantPage({ kind: "evil", projectId: null, taskId: null, ruleId: null }), null);
});

test("pages outside the pilot, or people who aren't pilot admins, are refused before any model call", async () => {
  const m = toolModel(renameFlyer);
  await assert.rejects(propose(db(world("owner"), { admin: false }), m.p, "Rename the flyer"), reject("forbidden"));
  const outside = world("owner");
  outside.projects[0].workspace_id = "99999999-9999-4999-8999-999999999999";
  await assert.rejects(propose(db(outside), m.p, "Rename the flyer"), (e: unknown) => isApiError(e));
  assert.equal(m.calls.length, 0);
});

test("an unconfigured deployment or a malformed request makes no run and no call", async () => {
  const s = world("owner");
  const m = toolModel(renameFlyer);
  await assert.rejects(propose(db(s), { ...m.p, configured: false }, "Rename the flyer"), reject("unavailable"));
  await assert.rejects(propose(db(s), m.p, "", PAGE), reject("invalid"));
  await assert.rejects(propose(db(s), m.p, "Rename", { kind: "project" }), reject("invalid"));
  assert.equal(s.ai_assistant_runs.length, 0);
  assert.equal(m.calls.length, 0);
});

// ---- Confirm / Undo ------------------------------------------------------------------------------------

test("nothing is written before Confirm; apply writes every chosen change; Undo puts it all back", async () => {
  const s = world("owner");
  const d = db(s);
  const original = live(s);
  const m = toolModel(
    once((ctx) => [
      { name: "rename_task", input: { task: tref(ctx, "Spring flyer"), name: "Summer flyer" } },
      { name: "move_task", input: { task: tref(ctx, "Print run"), section: sref(ctx, "Done") } },
      { name: "set_field_value", input: { task: tref(ctx, "Spring flyer"), field: fref(ctx, "Priority"), value: "High" } },
      { name: "rename_section", input: { section: sref(ctx, "Doing"), name: "In progress" } },
    ]),
  );
  const prop = await propose(d, m.p, "Tidy up the launch project");
  assert.equal(prop.ops.length, 4, JSON.stringify(prop.rejected));
  assert.equal(live(s), original, "staging writes nothing");
  assert.equal(s.ai_assistant_runs[0].status, "proposed");
  const res = await apply(d, prop.runId, [0, 1, 2, 3]);
  assert.equal(res.applied, 4);
  assert.equal(s.tasks.find((t) => t.id === T_FLYER)!.title, "Summer flyer");
  assert.equal(s.task_projects.find((tp) => tp.task_id === T_BLOCKED)!.section_id, S_DONE);
  assert.equal(s.task_field_values.find((v) => v.task_id === T_FLYER && v.field_id === F_PRIORITY)!.value, "hi");
  assert.deepEqual(await undoAssistantRun(createApiContext(d), prop.runId), { status: "undone", undone: 4, notUndone: [] });
  assert.equal(live(s), original);
});

test("applying again with the same key is harmless; another key on an applied run is refused", async () => {
  const s = world("owner");
  const d = db(s);
  const prop = await propose(d, toolModel(renameFlyer).p);
  const { applyAssistantRun } = await import("@alhc/core/api/ai-assistant/mutations");
  const k = key("apply");
  await applyAssistantRun(createApiContext(d), { runId: prop.runId, applyKey: k, selected: [0] });
  const again = await applyAssistantRun(createApiContext(d), { runId: prop.runId, applyKey: k, selected: [0] });
  assert.equal(again.repeated, true);
  await assert.rejects(apply(d, prop.runId, [0]), (e: unknown) => isApiError(e));
});

test("only the chosen changes are applied; a selection missing what it needs is refused", async () => {
  const s = world("owner");
  const d = db(s);
  const m = toolModel(
    once((ctx) => [
      { name: "rename_task", input: { task: tref(ctx, "Spring flyer"), name: "Summer flyer" } },
      { name: "rename_task", input: { task: tref(ctx, "Print run"), name: "Big print" } },
    ]),
  );
  const prop = await propose(d, m.p);
  await apply(d, prop.runId, [1]);
  assert.equal(s.tasks.find((t) => t.id === T_FLYER)!.title, "Spring flyer");
  assert.equal(s.tasks.find((t) => t.id === T_BLOCKED)!.title, "Big print");
  assert.equal(selectionProblem([{ dependsOn: [] }, { dependsOn: [0] }] as never, [1]), "Change 2 needs change 1");
  assert.equal(selectionProblem([] as never, []), "Choose at least one change");
});

test("stale data is refused before anything is written", async () => {
  const s = world("owner");
  const d = db(s);
  const prop = await propose(d, toolModel(renameFlyer).p);
  s.tasks.find((t) => t.id === T_FLYER)!.title = "Changed by hand";
  const before = live(s);
  await assert.rejects(apply(d, prop.runId, [0]), reject("conflict"));
  assert.equal(live(s), before);
});

test("Undo refuses, and says so, when what it changed has changed since", async () => {
  const s = world("owner");
  const d = db(s);
  const prop = await propose(d, toolModel(renameFlyer).p);
  await apply(d, prop.runId, [0]);
  s.tasks.find((t) => t.id === T_FLYER)!.title = "Edited again";
  const res = await undoAssistantRun(createApiContext(d), prop.runId);
  assert.equal(res.status, "conflict");
  assert.equal(s.tasks.find((t) => t.id === T_FLYER)!.title, "Edited again");
});

test("permissions are checked again at Confirm: a role lowered since refuses, writing nothing", async () => {
  const s = world("owner");
  const d = db(s);
  const prop = await propose(d, toolModel(renameFlyer).p);
  s.project_members.find((m) => m.project_id === P1 && m.profile_id === ME)!.role = "viewer";
  const before = live(s);
  await assert.rejects(apply(d, prop.runId, [0]), (e: unknown) => isApiError(e) && /doesn’t allow/.test(e.message));
  assert.equal(live(s), before);
  // Archived since: refused too.
  const s2 = world("owner");
  const d2 = db(s2);
  const p2 = await propose(d2, toolModel(renameFlyer).p);
  s2.projects[0].archived_at = new Date().toISOString();
  await assert.rejects(apply(d2, p2.runId, [0]), (e: unknown) => isApiError(e) && /archived/.test(e.message));
});

test("the blocked-task guard holds: a blocked task isn't completed, at staging or at Confirm", async () => {
  const s = world("owner");
  const m = toolModel(once((ctx) => [{ name: "complete_task", input: { task: tref(ctx, "Print run") } }]));
  await assert.rejects(propose(db(s), m.p, "Complete the print run"), reject("invalid", /blocked/i));
  // Blocked after the proposal.
  const s2 = world("owner");
  const free = db(s2, { blockers: {} });
  const prop = await propose(free, toolModel(once((ctx) => [{ name: "complete_task", input: { task: tref(ctx, "Spring flyer") } }])).p);
  await assert.rejects(apply(db(s2, { blockers: { [T_FLYER]: 2 } }), prop.runId, [0]), (e: unknown) => isApiError(e) && /blocked/i.test(e.message));
  assert.equal(s2.tasks.find((t) => t.id === T_FLYER)!.completed_at, null);
});

test("approval tasks are only completed by their approvers", async () => {
  const s = world("owner");
  const m = toolModel(once((ctx) => [{ name: "complete_task", input: { task: tref(ctx, "Sign-off") } }]));
  await assert.rejects(propose(db(s), m.p, "Complete the sign-off"), reject("invalid", /approver/i));
});

test("a change refused part way rolls back what was already written", async () => {
  const s = world("owner");
  const original = live(s);
  const m = toolModel(
    once((ctx) => [
      { name: "rename_task", input: { task: tref(ctx, "Spring flyer"), name: "Summer flyer" } },
      { name: "rename_task", input: { task: tref(ctx, "Print run"), name: "Big print" } },
    ]),
  );
  const prop = await propose(db(s), m.p);
  const refusing = db(s, { refuse: (table, op, row) => (table === "tasks" && op === "update" && (row as { title?: string }).title === "Big print" ? { code: "42501", message: "refused" } : null) });
  await assert.rejects(apply(refusing, prop.runId, [0, 1]), (e: unknown) => isApiError(e));
  assert.equal(live(s), original, "the first change was put back");
});

test("a cancelled proposal can't be applied", async () => {
  const s = world("owner");
  const d = db(s);
  const prop = await propose(d, toolModel(renameFlyer).p);
  await cancelAssistantRun(createApiContext(d), prop.runId);
  await assert.rejects(apply(d, prop.runId, [0]), (e: unknown) => isApiError(e));
});

test("provider failures are logged safely and nothing is applied", async () => {
  const s = world("owner");
  const original = live(s);
  const m = toolModel(() => ({ ok: false, code: "overloaded", detail: "overloaded_error", model: AI_BUILDER_CALLS.assistant_small.model, inputTokens: null, outputTokens: null }));
  await assert.rejects(propose(db(s), m.p, "Rename the flyer"), reject("unavailable"));
  const run = s.ai_assistant_runs[0];
  assert.equal(run.status, "failed");
  assert.ok(!JSON.stringify(run).includes("Rename the flyer"), "never the request's text");
  assert.equal(live(s), original);
});

// ---- Answer mode (notes 172, 176) -----------------------------------------------------------------------

test("how-to questions are told apart from change requests", () => {
  for (const q of ["How do I add a form?", "what does this automation do", "Where are the task templates?", "Is there a way to lock sections?", "Can I export this list?"]) assert.ok(isHowToQuestion(q), q);
  for (const c of ["Take away the priority field in this project", "Can you rename this task to Flyer?", "Move the poster to Done", "Rename the flyer"]) assert.ok(!isHowToQuestion(c), c);
  assert.deepEqual(assistantMode("Rename it", false), { mode: "answer", reason: "answer_only_role" });
  assert.deepEqual(assistantMode("How do I add a form?", true), { mode: "answer", reason: "question" });
  assert.deepEqual(assistantMode("Rename it", true), { mode: "change" });
});

test("answer mode: Haiku answers from the registry's help, nothing is written, the run keeps no text", async () => {
  const s = world("owner");
  const original = live(s);
  const m = toolModel(once(() => []), {
    answer: (request) => {
      assert.equal(request.kind, "assistant_answer");
      assert.equal(request.schema, ASSISTANT_ANSWER_SCHEMA);
      assert.match(request.prompt, /<help>/);
      assert.match(request.prompt, /Set a task's type/, "help generated from the registry");
      return { answer: "Open Customize → Forms → + Add form." };
    },
  });
  const res = await propose(db(s), m.p, "How do I add a form?");
  assert.equal(res.mode, "answer");
  assert.equal(res.answer, "Open Customize → Forms → + Add form.");
  assert.equal(m.calls.length, 0, "no tool conversation");
  assert.equal(AI_BUILDER_CALLS.assistant_answer.model, "claude-haiku-5-5");
  assert.equal(live(s), original);
  const run = s.ai_assistant_runs[0];
  assert.ok(!JSON.stringify(run).includes("Add form") && !JSON.stringify(run).includes("How do I"));
  await assert.rejects(apply(db(s), res.runId, [0]), reject("invalid"));
});

test("Commenters and Viewers: a change request gets the role note without any model call", async () => {
  for (const role of ["commenter", "viewer"] as const) {
    const s = world(role);
    const m = toolModel(once(() => []));
    const res = await propose(db(s), m.p, "Take away the priority field in this project");
    assert.equal(res.answerOnly, true);
    assert.match(res.answer!, /role here doesn’t allow changes/);
    assert.equal(m.calls.length + m.answers.length, 0);
  }
});

// ---- Fields (round 4) -------------------------------------------------------------------------------------

test("fields: create, rename, change options (renames keep values), remove; Undo brings each back", async () => {
  const s = world("owner");
  const d = db(s);
  const original = live(s);
  const m = toolModel(
    once((ctx) => [
      { name: "create_field", input: { project: ctx.current_project, name: "Channel", type: "single_select", options: ["Email", "Print"] } },
      { name: "rename_field", input: { field: fref(ctx, "Priority"), name: "Urgency" } },
      { name: "update_field_options", input: { field: fref(ctx, "Priority"), options: ["High", "Low => Later", "Medium"] } },
    ]),
  );
  const prop = await propose(d, m.p, "fields");
  assert.equal(prop.ops.length, 3, JSON.stringify(prop.rejected));
  await apply(d, prop.runId, [0, 1, 2]);
  const priority = s.custom_fields.find((f) => f.id === F_PRIORITY)!;
  assert.equal(priority.name, "Urgency");
  const opts = priority.options as { id: string; name: string }[];
  assert.deepEqual(opts.map((o) => o.name), ["High", "Later", "Medium"]);
  assert.equal(opts.find((o) => o.name === "Later")!.id, "lo", "a rename keeps its id, so values stay");
  assert.ok(s.custom_fields.some((f) => f.name === "Channel"));
  await undoAssistantRun(createApiContext(d), prop.runId);
  assert.equal(activeOnly(live(s)), activeOnly(original), "the new field is removed again, the rest as it was");
  assert.ok(s.custom_fields.find((f) => f.name === "Channel")!.deleted_at);
});

test("a locked field: Editors can't change its values or remove it (the manual rule)", async () => {
  const s = world("editor");
  const m = toolModel(once((ctx) => [{ name: "set_field_value", input: { task: tref(ctx, "Spring flyer"), field: fref(ctx, "Budget"), value: "10" } }]));
  await assert.rejects(propose(db(s), m.p, "budget"), reject("invalid", "locked"));
  const m2 = toolModel(once((ctx) => [{ name: "remove_field", input: { field: fref(ctx, "Budget") } }]));
  await assert.rejects(propose(db(world("editor")), m2.p, "remove budget"), reject("invalid", "locked"));
  assert.ok(F_BUDGET);
});

// ---- Automations: created off, Turn on & Finish ----------------------------------------------------------

const newRule = once((ctx) => [
  { name: "create_automation", input: { project: ctx.current_project, automation: { name: "Done to Done", trigger: { type: "task_completed" }, conditions: [], actions: [{ type: "move_section", section_id: "Done" }] } } },
]);

test("Turn on & Finish turns on only this run's automations; Undo turns it off, then removes it", async () => {
  const s = world("owner");
  const d = db(s);
  const prop = await propose(d, toolModel(newRule).p, "Whenever a task is done, move it to Done");
  assert.equal(prop.ops.length, 1, JSON.stringify(prop.rejected));
  const res = await apply(d, prop.runId, [0]);
  assert.equal(res.createdRules.length, 1);
  const made = s.rules.find((r) => r.id === res.createdRules[0].ruleId)!;
  assert.equal(made.enabled, false, "created off");
  await assert.rejects(turnOnAssistantRules(createApiContext(d), prop.runId, [R_FANCY]), reject("invalid"));
  assert.deepEqual(await turnOnAssistantRules(createApiContext(d), prop.runId), { turnedOn: [made.id], alreadyOn: [] });
  assert.equal(s.rules.find((r) => r.id === R_FANCY)!.enabled, false, "never another automation");
  await undoAssistantRun(createApiContext(d), prop.runId);
  assert.equal(made.enabled, false);
  assert.ok(made.deleted_at);
});

test("a hand-changed AI-made automation is refused; Editors can turn an unchanged one on", async () => {
  const s = world("owner");
  const d = db(s);
  const prop = await propose(d, toolModel(newRule).p, "Whenever a task is done, move it to Done");
  const res = await apply(d, prop.runId, [0]);
  const made = s.rules.find((r) => r.id === res.createdRules[0].ruleId)!;
  made.name = "Edited by hand";
  await assert.rejects(turnOnAssistantRules(createApiContext(d), prop.runId), reject("conflict"));
  made.name = "Done to Done";
  s.project_members.find((m) => m.project_id === P1 && m.profile_id === ME)!.role = "editor";
  await turnOnAssistantRules(createApiContext(d), prop.runId);
  assert.equal(made.enabled, true);
});

test("an automation that would message people is drafted off and flagged; turning it on needs its own acknowledgement", async () => {
  const s = world("owner");
  const d = db(s);
  const m = toolModel(
    once((ctx) => [
      { name: "create_automation", input: { project: ctx.current_project, automation: { name: "Ping", trigger: { type: "task_completed" }, conditions: [], actions: [{ type: "notify", people: ["me"], message: "Done" }] } } },
    ]),
  );
  const prop = await propose(d, m.p, "Create an automation that notifies me when a task is completed");
  assert.equal(prop.ops.length, 1, JSON.stringify(prop.rejected));
  assert.match(prop.ops[0].after, /starts off\) · once on, it messages Avi Weinreb \(you\) \(Inbox\)/, "it says who it would message");
  const res = await apply(d, prop.runId, [0]);
  const made = s.rules.find((r) => r.id === res.createdRules[0].ruleId)!;
  assert.equal(made.enabled, false, "never on by itself");
  await assert.rejects(turnOnAssistantRules(createApiContext(d), prop.runId), reject("invalid", /messages .* when it runs/));
  assert.equal(made.enabled, false);
  await turnOnAssistantRules(createApiContext(d), prop.runId, undefined, true);
  assert.equal(made.enabled, true, "on only with the explicit acknowledgement");
  assert.ok(rref);
});

// ---- MCP (round 5, note 178) -----------------------------------------------------------------------------

const ident = (scopes: string[] = ["read", "write"]): McpIdentity => ({ profileId: ME, workspaceId: WS, scopes, tokenId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });

test("MCP: a read token lists and runs read tools only; writes need the write scope", async () => {
  const readOnly = mcpListTools(ident(["read"]));
  assert.ok(readOnly.every((t) => t.annotations.readOnlyHint));
  assert.ok(mcpListTools(ident()).some((t) => t.name === "rename_task"));
  const s = world("owner");
  const r = await mcpCallTool(createApiContext(db(s)), ident(["read"]), "rename_task", { task: T_FLYER, name: "x" });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /only read/);
  const found = await mcpCallTool(createApiContext(db(s)), ident(["read"]), "get_task", { task: T_FLYER });
  assert.equal(found.ok, true, JSON.stringify(found));
  assert.equal(s.tasks.find((t) => t.id === T_FLYER)!.title, "Spring flyer");
});

test("MCP: a write is checked like the app's, written as the person, and logged as a run with Undo", async () => {
  const s = world("owner");
  const d = db(s);
  // Security audit 2 (Nov 12, batch 41): without confirm: true it's a preview only.
  const preview = await mcpCallTool(createApiContext(d), ident(), "rename_task", { task: T_FLYER, name: "Summer flyer" });
  assert.equal((preview as { data: { applied: boolean } }).data.applied, false);
  assert.equal(s.tasks.find((t) => t.id === T_FLYER)!.title, "Spring flyer");
  const r = await mcpCallTool(createApiContext(d), ident(), "rename_task", { task: T_FLYER, name: "Summer flyer", confirm: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(s.tasks.find((t) => t.id === T_FLYER)!.title, "Summer flyer");
  const run = s.ai_assistant_runs.find((x) => x.source === "mcp")!;
  assert.ok(run, "logged as a run");
  assert.equal(run.status, "applied");
  await undoAssistantRun(createApiContext(d), run.id as string);
  assert.equal(s.tasks.find((t) => t.id === T_FLYER)!.title, "Spring flyer");
  // A Viewer is refused exactly as by hand.
  const v = world("viewer");
  const r2 = await mcpCallTool(createApiContext(db(v)), ident(), "rename_task", { task: T_FLYER, name: "x", confirm: true });
  assert.equal(r2.ok, false);
  assert.equal(v.tasks.find((t) => t.id === T_FLYER)!.title, "Spring flyer");
});

test("MCP: a destructive change is only a preview until confirm: true", async () => {
  const s = world("owner");
  const d = db(s);
  const r = await mcpCallTool(createApiContext(d), ident(), "delete_task", { task: T_FLYER });
  assert.equal(r.ok, true);
  assert.equal((r as { data: { applied: boolean } }).data.applied, false);
  assert.equal(s.tasks.find((t) => t.id === T_FLYER)!.deleted_at, null);
  const r2 = await mcpCallTool(createApiContext(d), ident(), "delete_task", { task: T_FLYER, confirm: true });
  assert.equal((r2 as { data: { applied: boolean } }).data.applied, true);
  assert.ok(s.tasks.find((t) => t.id === T_FLYER)!.deleted_at);
});

test("MCP: non-pilot people, another workspace's token, or another person's token are refused", async () => {
  const s = world("owner");
  await assert.rejects(mcpCallTool(createApiContext(db(s, { admin: false })), ident(), "get_task", { task: T_FLYER }), reject("forbidden"));
  await assert.rejects(mcpCallTool(createApiContext(db(s)), { ...ident(), workspaceId: "99999999-9999-4999-8999-999999999999" }, "get_task", { task: T_FLYER }), reject("forbidden"));
  await assert.rejects(mcpCallTool(createApiContext(db(s, { me: "22222222-2222-4222-8222-222222222223" })), ident(), "get_task", { task: T_FLYER }), reject("forbidden"));
  // A project of another workspace isn't reachable.
  const r = await mcpCallTool(createApiContext(db(s)), ident(), "get_project", { project: "99999999-9999-4999-8999-999999999990" });
  assert.equal(r.ok, false);
  assert.ok(P2);
});
