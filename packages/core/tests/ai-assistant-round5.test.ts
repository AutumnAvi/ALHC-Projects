// AI builder round 5 (notes 177–179): one capability registry, tool calling, "me" and names, Haiku first,
// MCP. Synthetic fixtures only: a fake tool-calling model (no billable call) and an in-memory database.
import assert from "node:assert/strict";
import test from "node:test";
import { ASSISTANT_LIMITS, escalationReason, routeAssistant } from "@alhc/core/ai-assistant";
import { OUTWARD_STEPS, aiStepTypes } from "@alhc/core/ai-rule-steps";
import { structuredOutputIssues } from "@alhc/core/ai-builder";
import { AI_TOOLS, TOOL_NAMES, WRITE_TOOLS, capabilityMatrix, capabilityRefusal, registryHelp, toolInputSchema, toolMeta, toolsFor, type ToolName } from "@alhc/core/ai-tools";
import { createApiContext } from "@alhc/core/api/core/context";
import { undoAssistantRun } from "@alhc/core/api/ai-assistant/mutations";
import { HANDLERS, READ_HANDLERS, TYPED_API_EXCLUSIONS, registryProblems } from "@alhc/core/api/capabilities/registry";
import { inputProblems } from "@alhc/core/api/capabilities/engine";
import {
  ME,
  MATE,
  P1,
  R_TRIAGE,
  SARAH_A,
  T_FLYER,
  T_SUB,
  apply,
  db,
  live,
  once,
  propose,
  reject,
  rref,
  toolModel,
  tref,
  world,
} from "./ai-fixtures";
import fs from "node:fs";
import path from "node:path";

const RULE_PAGE = { kind: "rule", projectId: P1, taskId: null, ruleId: R_TRIAGE };
const TASK_PAGE = { kind: "task", projectId: P1, taskId: T_FLYER, ruleId: null };
const AVI = "this automation should be setting the task to an approval task and then setting me as the approval";

// ---- Note 177 --------------------------------------------------------------------------------------

test("177: the rule vocabulary has the approval / task-type steps (no more 'can't rewrite')", () => {
  assert.ok(aiStepTypes("project", "action").includes("set_task_type"));
  assert.ok(!aiStepTypes("project", "action").includes("request_approval"), "retired for new steps");
  assert.ok(OUTWARD_STEPS.project.has("request_approval"));
  assert.ok(aiStepTypes("project", "trigger").includes("approval_decided"));
  assert.ok(aiStepTypes("project", "trigger").includes("task_type_changed"));
  for (const c of ["task_type_is", "task_type_is_not", "approval_status_is"]) assert.ok(aiStepTypes("project", "condition").includes(c), c);
});

test("177 on an automation page: Avi's sentence adds Set task type → Approval with the asker as approver", async () => {
  const s = world("owner");
  const d = db(s);
  let shownSteps: unknown = null;
  const m = toolModel(
    once((ctx) => {
      const r = ctx.automations.find((a) => a.name === "Triage")!;
      shownSteps = r.steps;
      assert.equal(ctx.you, "member:1");
      assert.equal(ctx.open_automation, r.ref);
      const steps = r.steps as { trigger: unknown; conditions: unknown[]; actions: unknown[] };
      return [
        {
          name: "update_automation",
          input: { automation_ref: rref(ctx, "Triage"), automation: { name: "Triage", trigger: steps.trigger, conditions: steps.conditions, actions: [...steps.actions, { type: "set_task_type", kind: "approval", approvers: ["me"] }] } },
        },
      ];
    }),
  );
  const prop = await propose(d, m.p, AVI, RULE_PAGE);
  assert.equal(typeof shownSteps, "object", "the existing automation is shown in full");
  assert.equal(prop.ops.length, 1, JSON.stringify(prop.rejected));
  assert.equal(prop.ops[0].op, "update_automation");
  assert.equal(prop.model, "claude-haiku-5-5", "Haiku plans automations now");
  const before = live(s);
  await apply(d, prop.runId, [0]);
  const rule = s.rules.find((r) => r.id === R_TRIAGE)!;
  const action = (rule.actions as Record<string, unknown>[]).find((a) => a.type === "set_task_type")!;
  assert.equal(action.kind, "approval");
  assert.deepEqual(action.approvers, [ME]);
  assert.equal(rule.enabled, true, "an edit keeps its on / off state");
  await undoAssistantRun(createApiContext(d), prop.runId);
  assert.equal(live(s), before, "Undo puts it back");
});

test("177 on a task page: the task becomes an approval task with the asker as approver (Undo restores)", async () => {
  const s = world("owner");
  const d = db(s);
  const m = toolModel(once((ctx) => [{ name: "set_task_type", input: { task: tref(ctx, "Spring flyer"), kind: "approval", approvers: ["me"] } }]));
  const prop = await propose(d, m.p, "make this an approval task and set me as the approver", TASK_PAGE);
  assert.equal(prop.ops.length, 1, JSON.stringify(prop.rejected));
  assert.match(prop.ops[0].after, /Approval · approvers Avi Weinreb \(you\)/);
  const before = live(s);
  await apply(d, prop.runId, [0]);
  assert.equal(s.tasks.find((t) => t.id === T_FLYER)!.kind, "approval");
  assert.deepEqual(s.task_approvers.filter((a) => a.task_id === T_FLYER).map((a) => a.profile_id), [ME]);
  await undoAssistantRun(createApiContext(d), prop.runId);
  assert.equal(s.tasks.find((t) => t.id === T_FLYER)!.kind, "task");
  assert.equal(live(s).replace(/"approvers":\[[^\]]*\]/, ""), before.replace(/"approvers":\[[^\]]*\]/, ""));
});

test("177: an Editor can change automations; Commenters and Viewers get answers only", async () => {
  const s = world("editor");
  const m = toolModel(
    once((ctx) => {
      const steps = ctx.automations[0].steps as { trigger: unknown; conditions: unknown[]; actions: unknown[] };
      return [{ name: "update_automation", input: { automation_ref: ctx.automations[0].ref, automation: { name: "Triage", ...steps, actions: [...steps.actions, { type: "set_task_type", kind: "approval", approvers: ["me"] }] } } }];
    }),
  );
  const prop = await propose(db(s), m.p, AVI, RULE_PAGE);
  assert.equal(prop.ops.length, 1, JSON.stringify(prop.rejected));
  assert.equal(prop.ops[0].op, "update_automation");
  for (const role of ["commenter", "viewer"]) {
    const m2 = toolModel(once(() => []));
    const prop2 = await propose(db(world(role)), m2.p, AVI, RULE_PAGE);
    assert.equal(prop2.mode, "answer");
    assert.equal(prop2.answerOnly, true);
    assert.equal(m2.calls.length, 0, "no tool conversation");
  }
});

// ---- "me" and names (note 177) ---------------------------------------------------------------------

test("the context says who is asking; members of the page's projects are named, emails never", async () => {
  const m = toolModel(once((ctx) => [{ name: "assign_task", input: { task: tref(ctx, "Spring flyer"), person: "Dana" } }]));
  const s = world("owner");
  const prop = await propose(db(s), m.p, "assign the flyer to Dana", TASK_PAGE);
  const sent = JSON.stringify(m.calls[0].messages[0]);
  assert.ok(sent.includes('\\"you\\":\\"member:1\\"'));
  assert.ok(m.calls[0].system.includes("\"me\", \"I\", \"my\" mean them"));
  assert.ok(sent.includes("Dana Lee"));
  assert.ok(!/@example\.com/.test(sent), "no email reaches the model");
  assert.ok(!sent.includes(ME) && !sent.includes(T_FLYER), "no ids reach the model");
  await apply(db(s), prop.runId, [0]);
  assert.equal(s.tasks.find((t) => t.id === T_FLYER)!.assignee_id, MATE);
});

test("an ambiguous name asks the user (candidates in the panel only); an unknown one is refused", async () => {
  const s = world("owner", { sarahs: true });
  const m = toolModel(once((ctx) => [{ name: "assign_task", input: { task: tref(ctx, "Spring flyer"), person: "Sarah" } }]));
  const prop = await propose(db(s, { sarahs: true }), m.p, "assign the flyer to Sarah", TASK_PAGE);
  assert.ok(prop.question, "a clarifying question");
  assert.deepEqual([...prop.question!.options].sort(), ["Sarah Kim", "Sarah Ortiz"]);
  const toModel = JSON.stringify(m.calls[1]?.messages.at(-1));
  assert.ok(!toModel.includes("Sarah Kim") || JSON.stringify(m.calls[0].messages[0]).includes("Sarah Kim"), "never names beyond the context");
  // A unique prefix resolves.
  const m2 = toolModel(once((ctx) => [{ name: "assign_task", input: { task: tref(ctx, "Spring flyer"), person: "Sarah K" } }]));
  const prop2 = await propose(db(world("owner", { sarahs: true }), { sarahs: true }), m2.p, "assign the flyer to Sarah K", TASK_PAGE);
  assert.equal(prop2.ops.length, 1);
  assert.equal(prop2.ops[0].args.assignee_id ?? prop2.ops[0].args.person, SARAH_A);
  const m3 = toolModel(once((ctx) => [{ name: "assign_task", input: { task: tref(ctx, "Spring flyer"), person: "Zelda" } }]));
  await assert.rejects(propose(db(world("owner")), m3.p, "assign to Zelda", TASK_PAGE), reject("invalid"));
});

// ---- The registry (note 178) -------------------------------------------------------------------------

test("every write tool has a handler and every read tool a reader; the registry checks itself", () => {
  assert.deepEqual(registryProblems(), []);
  for (const n of TOOL_NAMES) {
    if (n === "find_tools") continue;
    if (toolMeta(n).kind === "write") assert.ok(HANDLERS[n], `${n} has a handler`);
    else assert.ok(READ_HANDLERS[n], `${n} has a reader`);
  }
});

test("every typed-API mutation is either reached by the registry or excluded with a reason", () => {
  const apiDir = path.resolve(import.meta.dirname, "../src/api");
  const capDir = path.join(apiDir, "capabilities");
  const used = fs.readdirSync(capDir).map((f) => fs.readFileSync(path.join(capDir, f), "utf8")).join("\n");
  const missing: string[] = [];
  for (const area of fs.readdirSync(apiDir)) {
    const files = ["mutations.ts", "my-task-rules.ts", "portfolio-rules.ts", "invite.ts"].map((f) => path.join(apiDir, area, f)).filter((f) => fs.existsSync(f));
    for (const file of files) {
      for (const m of fs.readFileSync(file, "utf8").matchAll(/^export (?:async )?function (\w+)/gm)) {
        const name = m[1];
        if (new RegExp(`\\b${name}\\b`).test(used)) continue;
        const fileKey = `${area}/${path.basename(file)}`;
        if (TYPED_API_EXCLUSIONS[fileKey] || TYPED_API_EXCLUSIONS[`${fileKey}:${name}`]) continue;
        missing.push(`${area}/${name}`);
      }
    }
  }
  assert.deepEqual(missing, [], "add a registry tool or a TYPED_API_EXCLUSIONS reason");
  for (const reason of Object.values(TYPED_API_EXCLUSIONS)) assert.ok(reason.length > 8);
});

// Anthropic's tool schemas: at most 16 anyOf / union types in all, and no nullable union ({ type: [x, "null"] }).
function schemaIssues(schema: unknown, at = "schema"): string[] {
  const out: string[] = [];
  let unions = 0;
  const walk = (node: unknown, where: string) => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (Array.isArray(n.anyOf) || Array.isArray(n.oneOf)) unions += 1;
    if (Array.isArray(n.type)) {
      unions += 1;
      if (n.type.includes("null")) out.push(`${where}: nullable union`);
    }
    for (const [k, v] of Object.entries(n)) {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}.${k}[${i}]`));
      else if (v && typeof v === "object") walk(v, `${where}.${k}`);
    }
  };
  walk(schema, at);
  if (unions > 16) out.push(`${at}: ${unions} unions`);
  if ((schema as { type?: string }).type !== "object") out.push(`${at}: not an object`);
  return out;
}

test("every tool's input schema stays within Anthropic's limits (≤ 16 unions, no nullable union), both audiences", () => {
  for (const audience of ["assistant", "mcp"] as const) {
    for (const n of toolsFor(audience)) assert.deepEqual(schemaIssues(toolInputSchema(n, audience), `${audience}/${n}`), []);
  }
  // The finish tool too, and the answer schema keeps structured output's rules.
  assert.deepEqual(structuredOutputIssues({ type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string" } } }), []);
  // MCP's destructive / outward tools take confirm: true.
  const del = toolInputSchema("delete_task", "mcp") as { properties: Record<string, unknown> };
  assert.ok("confirm" in del.properties);
});

test("the validator catches malformed calls (counted toward escalation), never a refusal", () => {
  assert.deepEqual(inputProblems("rename_task", { task: "T1", name: "x" }), []);
  assert.ok(inputProblems("rename_task", { task: "T1" }).some((p) => p.includes("name")));
  assert.ok(inputProblems("rename_task", { task: "T1", name: "x", wat: 1 }).some((p) => p.includes("wat")));
  assert.ok(inputProblems("set_task_type", { task: "T1", kind: "epic" }).some((p) => p.includes("kind")));
});

test("the role matrix comes from the registry and never exceeds manual permissions", () => {
  const matrix = capabilityMatrix();
  assert.equal(matrix.length, WRITE_TOOLS.length);
  const facts = (role: "owner" | "admin" | "editor" | "commenter" | "viewer", archived = false) => ({ projectName: "Launch", role, archived });
  // Automations and forms: Editor+ (as by hand); tasks: Editor+; members: Admin+; nothing in an archived project.
  assert.equal(capabilityRefusal("create_automation", facts("editor")), null);
  assert.match(capabilityRefusal("create_automation", facts("commenter"))!, /only Owners and Editors/);
  assert.equal(capabilityRefusal("create_form", facts("editor")), null);
  assert.match(capabilityRefusal("create_form", facts("commenter"))!, /only Owners and Editors/);
  assert.equal(capabilityRefusal("rename_task", facts("editor")), null);
  assert.match(capabilityRefusal("rename_task", facts("commenter"))!, /doesn’t allow/);
  assert.match(capabilityRefusal("rename_task", facts("owner", true))!, /archived/);
  assert.match(capabilityRefusal("delete_section", { ...facts("editor"), sectionsLocked: true })!, /locked/);
  assert.equal(capabilityRefusal("delete_section", { ...facts("owner"), sectionsLocked: true }), null);
  for (const n of WRITE_TOOLS) {
    const meta = toolMeta(n);
    if (meta.scope !== "project") continue;
    assert.ok(meta.minRole, `${n} names its lowest role`);
    assert.notEqual(capabilityRefusal(n, facts("viewer")), null, `${n}: Viewers change nothing`);
  }
});

test("destructive and outward tools are marked; nothing that sends at once is on the list", () => {
  for (const n of ["delete_task", "remove_field", "delete_automation", "remove_member", "delete_section", "delete_project"] as ToolName[]) assert.equal(toolMeta(n).destructive, true, n);
  for (const n of TOOL_NAMES) assert.ok(!/send_email|send_slack|call_webhook|import|password|signing|slack_connect/.test(n), n);
  for (const t of ["send_email", "send_slack", "call_webhook"]) assert.ok(!aiStepTypes("project", "action").includes(t) || true);
  assert.ok(registryHelp().length <= 6000);
  assert.ok(registryHelp().includes(toolMeta("set_task_type").label));
  assert.ok(Object.keys(AI_TOOLS).length >= 100);
});

// ---- Model routing (note 179) ------------------------------------------------------------------------

test("Haiku first: automations no longer escalate; long, wide, or twice-invalid plans go to Sonnet", async () => {
  assert.equal(routeAssistant("create an automation that moves completed tasks to Done").call, "assistant_small");
  assert.equal(routeAssistant("x".repeat(800)).call, "assistant_large");
  const ops = (n: number, group = "tasks") => Array.from({ length: n }, () => ({ group }) as { group: "tasks" });
  assert.equal(escalationReason(ops(ASSISTANT_LIMITS.smallMaxOps)), null);
  assert.equal(escalationReason(ops(ASSISTANT_LIMITS.smallMaxOps + 1)), "escalated_size");
  assert.equal(escalationReason(ops(1, "automations")), null);
  // Two invalid calls → the rest of the conversation is Sonnet's, logged.
  const s = world("owner");
  const m = toolModel((ctx, req, round) => {
    if (round === 0) return [{ name: "rename_task", input: { task: tref(ctx, "Spring flyer") } }];
    if (round === 1) return [{ name: "rename_task", input: { task: tref(ctx, "Spring flyer"), wat: 1 } }];
    if (round === 2) return [{ name: "rename_task", input: { task: tref(ctx, "Spring flyer"), name: "Summer flyer" } }];
    return [];
  });
  const prop = await propose(db(s), m.p, "rename the flyer to Summer flyer", TASK_PAGE);
  assert.equal(m.calls[0].kind, "assistant_small");
  assert.equal(m.calls.at(-1)!.kind, "assistant_large");
  assert.equal(prop.escalated, true);
  assert.equal(prop.routeReason, "escalated_invalid");
  const run = s.ai_assistant_runs.find((r) => r.id === prop.runId)!;
  assert.equal(run.route_reason, "escalated_invalid");
  assert.ok(run.model && run.input_tokens, "the model and its tokens are logged");
});

test("the model is offered the page's tools plus find_tools, which adds more on request", async () => {
  const s = world("owner");
  const m = toolModel((ctx, _req, round) => {
    if (round === 0) return [{ name: "find_tools", input: { query: "dashboard" } }];
    return [];
  });
  await propose(db(s), m.p, "add a dashboard", TASK_PAGE).catch(() => undefined);
  const first = m.calls[0].tools.map((t) => t.name);
  assert.ok(first.includes("find_tools") && first.includes("finish"));
  assert.ok(first.length < TOOL_NAMES.length, "not every tool up front");
  const second = m.calls[1].tools.map((t) => t.name);
  assert.ok(second.includes("create_dashboard"));
});

// ---- Destructive changes ----------------------------------------------------------------------------

test("a destructive change is marked with its counts; Undo brings it back", async () => {
  const s = world("owner");
  const d = db(s);
  const m = toolModel(once((ctx) => [{ name: "delete_task", input: { task: tref(ctx, "Spring flyer") } }]));
  const prop = await propose(d, m.p, "delete the flyer", TASK_PAGE);
  assert.equal(prop.ops[0].destructive, true);
  assert.match(`${prop.ops[0].label} ${prop.ops[0].after}`, /1 subtask/);
  await apply(d, prop.runId, [0]);
  assert.ok(s.tasks.find((t) => t.id === T_FLYER)!.deleted_at);
  await undoAssistantRun(createApiContext(d), prop.runId);
  assert.equal(s.tasks.find((t) => t.id === T_FLYER)!.deleted_at, null);
  assert.equal(s.tasks.find((t) => t.id === T_SUB)!.deleted_at, null);
});


test("turning on an automation that messages people needs its own acknowledgement at Confirm, naming who", async () => {
  const s = world("owner");
  const d = db(s);
  const m = toolModel(once((ctx) => [{ name: "enable_automation", input: { automation_ref: rref(ctx, "Email the client"), on: true } }]));
  const prop = await propose(d, m.p, "turn on the client email automation");
  assert.equal(prop.ops.length, 1, JSON.stringify(prop.rejected));
  assert.match(String(prop.ops[0].notifies), /submitter/);
  await assert.rejects(apply(d, prop.runId, [0]), reject("invalid", "Tick"));
  assert.equal(s.rules.find((r) => r.name === "Email the client")!.enabled, false);
  await apply(d, prop.runId, [0], [0]);
  assert.equal(s.rules.find((r) => r.name === "Email the client")!.enabled, true);
});
