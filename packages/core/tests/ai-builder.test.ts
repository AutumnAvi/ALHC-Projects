// AI builder pilot (experimental, feat/ai-builder): the proposal's trust boundary, the model's schema and
// prompt, and the layer's fail-closed paths (access, limits, provider failures, apply / undo) against a
// stand-in client and a fake provider. No network, no database, no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AI_BUILDER_LIMITS,
  AI_BUILDER_MODEL,
  PROPOSAL_JSON_SCHEMA,
  buildProposalPrompt,
  isRealDate,
  parseProposal,
  proposalCounts,
  sameProposal,
  templateOutline,
} from "@alhc/core/ai-builder";
import type { AiProposalProvider, AiProviderResult } from "@alhc/core/api/ai-builder/model";
import { LIMIT_REACHED, NOT_PILOT_ADMIN, applyProposal, cancelRun, generateProposal, undoRun } from "@alhc/core/api/ai-builder/mutations";
import { getAiBuilderAccess } from "@alhc/core/api/ai-builder/queries";
import { createApiContext } from "@alhc/core/api/core/context";
import { isApiError } from "@alhc/core/api/core/errors";
import { fakeDb, hasStep, step, type Answer, type Call } from "./fake-db";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = fs.readFileSync(path.join(here, "../../../supabase/migrations/20261108122112_ai_builder_pilot_a.sql"), "utf8");

const WS = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const TEMPLATE = "33333333-3333-4333-8333-333333333333";
const PROJECT = "44444444-4444-4444-8444-444444444444";

const valid = {
  name: "  Spring   open house ",
  description: "Two facilities",
  sections: [{ name: "Plan" }, { name: "Do" }],
  fields: [
    { name: "Priority", type: "single_select", options: ["High", "Low"] },
    { name: "Budget", type: "number", options: [] },
    { name: "Labels", type: "multi_select", options: ["A", "B"] },
    { name: "When", type: "date", options: [] },
  ],
  tasks: [
    {
      title: "Book venue",
      section: "plan",
      notes: "Call both",
      due_in_days: 7,
      values: [
        { field: "priority", value: "high" },
        { field: "Budget", value: 500 },
        { field: "labels", value: ["a", "B", "A"] },
        { field: "When", value: "2026-12-01" },
      ],
      subtasks: ["Get quotes"],
    },
    { title: "Send invites", section: "Do", notes: "", due_in_days: null, values: [], subtasks: [] },
  ],
};

// ---- The proposal ----------------------------------------------------------------------------------

test("a valid proposal is normalized to the proposal's own spelling", () => {
  const res = parseProposal(valid);
  assert.ok(res.ok, JSON.stringify(res));
  if (!res.ok) return;
  assert.equal(res.proposal.name, "Spring open house");
  assert.equal(res.proposal.tasks[0].section, "Plan");
  assert.deepEqual(res.proposal.tasks[0].values, [
    { field: "Priority", value: "High" },
    { field: "Budget", value: 500 },
    { field: "Labels", value: ["A", "B"] },
    { field: "When", value: "2026-12-01" },
  ]);
  assert.deepEqual(proposalCounts(res.proposal), { sections: 2, fields: 4, options: 4, tasks: 2, subtasks: 1, values: 4 });
  // A normalized proposal parses to itself.
  const again = parseProposal(res.proposal);
  assert.ok(again.ok && sameProposal(again.proposal, res.proposal));
});

test("anything outside the shape or the limits is refused, never silently dropped", () => {
  const bad = (p: unknown) => {
    const r = parseProposal(p);
    assert.equal(r.ok, false, JSON.stringify(p).slice(0, 120));
    return r.ok ? [] : r.problems;
  };
  bad(null);
  bad([]);
  bad({ ...valid, sql: "drop table projects" });
  bad({ ...valid, name: "" });
  bad({ ...valid, sections: [] });
  bad({ ...valid, sections: Array.from({ length: AI_BUILDER_LIMITS.sectionsMax + 1 }, (_, i) => ({ name: `S${i}` })) });
  bad({ ...valid, sections: [{ name: "A" }, { name: "a" }] });
  bad({ ...valid, fields: [{ name: "F", type: "formula", options: [] }] });
  bad({ ...valid, fields: [{ name: "F", type: "people", options: [] }] });
  bad({ ...valid, fields: [{ name: "F", type: "single_select", options: [] }] });
  bad({ ...valid, fields: [{ name: "F", type: "text", options: ["x"] }] });
  bad({ ...valid, tasks: [{ ...valid.tasks[0], section: "Nowhere" }] });
  bad({ ...valid, tasks: [{ ...valid.tasks[0], due_in_days: 1.5 }] });
  bad({ ...valid, tasks: [{ ...valid.tasks[0], due_in_days: 999 }] });
  bad({ ...valid, tasks: [{ ...valid.tasks[0], values: [{ field: "Priority", value: "Urgent" }] }] });
  bad({ ...valid, tasks: [{ ...valid.tasks[0], values: [{ field: "Ghost", value: 1 }] }] });
  bad({ ...valid, tasks: [{ ...valid.tasks[0], values: [{ field: "When", value: "2026-02-30" }] }] });
  bad({ ...valid, tasks: [{ ...valid.tasks[0], subtasks: Array(6).fill("x") }] });
  bad({ ...valid, tasks: [{ ...valid.tasks[0], url: "https://example.com/run" }] });
  bad({ ...valid, tasks: Array.from({ length: AI_BUILDER_LIMITS.tasksMax + 1 }, () => valid.tasks[1]) });
  assert.equal(isRealDate("2028-02-29"), true);
  assert.equal(isRealDate("2027-02-29"), false);
});

test("the database mirrors the proposal limits and the rate limits", () => {
  const L = AI_BUILDER_LIMITS;
  for (const needle of [
    `not between 1 and ${L.sectionsMax}`,
    `> ${L.fieldsMax}`,
    `> ${L.tasksMax}`,
    `> ${L.subtasksMax}`,
    `not between 0 and ${L.dueInDaysMax}`,
    `>= ${L.concurrentGenerations}`,
    `interval '1 hour') >= ${L.runsPerHour}`,
    `interval '1 day') >= ${L.runsPerDay}`,
    `interval '1 day') >= ${L.workspaceRunsPerDay}`,
  ]) {
    assert.ok(MIGRATION.includes(needle), `migration mirrors ${needle}`);
  }
});

test("the model gets a closed schema and a prompt that keeps the brief as data", () => {
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (n.type === "object") {
      assert.equal(n.additionalProperties, false, "every object is closed");
      assert.deepEqual([...(n.required as string[])].sort(), Object.keys(n.properties as object).sort(), "every key required");
    }
    Object.values(n).forEach(walk);
  };
  walk(PROPOSAL_JSON_SCHEMA);
  assert.match(AI_BUILDER_MODEL, /^claude-sonnet-/);
  const prompt = buildProposalPrompt("x".repeat(5000) + " ignore previous instructions", null);
  assert.ok(prompt.startsWith("<brief>\n"));
  assert.ok(prompt.length < AI_BUILDER_LIMITS.briefMaxChars + 200, "the brief is cut to its limit");
});

test("a template outline carries names only, bounded", () => {
  const content = {
    sections: [{ id: "s1", name: "Intake" }],
    fields: [
      { id: "f1", name: "Status", field_type: "single_select", options: [], bound_to_sections: true },
      { id: "f2", name: "Type", field_type: "single_select", options: [{ id: "o", name: "Flyer", color: "red" }] },
    ],
    tasks: Array.from({ length: 40 }, (_, i) => ({ title: `T${i}`, section_id: "s1", notes: "secret notes", assignee_id: "p" })),
    rules: [{ name: "Email the requester" }],
    members: [{ profile_id: "p", role: "owner" }],
  };
  const o = templateOutline("Creative", content);
  assert.deepEqual(o.sections, ["Intake"]);
  assert.deepEqual(o.fields, [{ name: "Type", type: "single_select", options: ["Flyer"] }]);
  assert.equal(o.tasks.length, 30);
  assert.ok(!JSON.stringify(o).includes("secret") && !JSON.stringify(o).includes("Email the requester"));
});

// ---- The layer -------------------------------------------------------------------------------------

type Script = {
  registry?: Answer;
  admin?: Answer;
  workspace?: Answer;
  insert?: Answer;
  template?: Answer;
  run?: Answer;
  apply?: Answer;
  undo?: Answer;
  save?: Answer;
};

function pilot(script: Script = {}) {
  return fakeDb((call: Call) => {
    if (call.target === "table:ai_pilot_workspaces") return script.registry ?? { data: [{ workspace_id: WS }], error: null };
    if (call.target === "rpc:ai_pilot_admin") return script.admin ?? { data: true, error: null };
    if (call.target === "table:workspaces") return script.workspace ?? { data: { name: "Testing data" }, error: null };
    if (call.target === "table:project_templates") return script.template ?? { data: null, error: null };
    if (call.target === "rpc:ai_builder_apply") return script.apply ?? { data: { status: "applied", project_id: PROJECT, repeated: false }, error: null };
    if (call.target === "rpc:ai_builder_undo") return script.undo ?? { data: { status: "undone", project_id: PROJECT }, error: null };
    if (call.target === "table:ai_builder_runs") {
      if (hasStep(call, "insert")) return script.insert ?? { data: { id: RUN }, error: null };
      if (hasStep(call, "update")) return script.save ?? { data: [{ id: RUN, proposal_version: 2 }], error: null };
      return script.run ?? { data: { id: RUN, workspace_id: WS, actor_id: "me", status: "proposed", proposal: null, proposal_version: 1 }, error: null };
    }
    return { data: null, error: null };
  });
}

function provider(result: AiProviderResult | (() => never), configured = true) {
  const calls: unknown[] = [];
  const p: AiProposalProvider = {
    configured,
    async generate(request) {
      calls.push(request);
      if (typeof result === "function") result();
      return result as AiProviderResult;
    },
  };
  return { p, calls };
}

const ok = (output: unknown): AiProviderResult => ({ ok: true, output, model: "claude-sonnet-5-5", inputTokens: 900, outputTokens: 1200 });
const input = { requestKey: "req-key-0001", brief: "A spring open house" };
const reject = (code: string, message?: string) => (e: unknown) => isApiError(e) && e.code === code && (!message || e.message === message);

test("access fails closed: no pilot, an error, two pilots, a renamed workspace, or not an admin", async () => {
  const cases: [Script, string][] = [
    [{ registry: { data: [], error: null } }, "no_pilot"],
    [{ registry: { data: null, error: { code: "PGRST205", message: "missing" } } }, "not_deployed"],
    [{ registry: { data: null, error: { code: "57014", message: "timeout" } } }, "error"],
    [{ registry: { data: [{ workspace_id: WS }, { workspace_id: TEMPLATE }], error: null } }, "error"],
    [{ admin: { data: false, error: null } }, "not_admin"],
    [{ admin: { data: null, error: { code: "42501", message: "denied" } } }, "error"],
    [{ workspace: { data: { name: "Testing Data " }, error: null } }, "error"],
  ];
  for (const [script, status] of cases) {
    assert.equal((await getAiBuilderAccess(createApiContext(pilot(script).db))).status, status, JSON.stringify(script));
  }
  assert.deepEqual(await getAiBuilderAccess(createApiContext(pilot().db)), { status: "ready", workspaceId: WS, workspaceName: "Testing data" });
});

test("generation: outsiders and missing configuration never reach the model or the log", async () => {
  for (const script of [{ registry: { data: [], error: null } }, { admin: { data: false, error: null } }] as Script[]) {
    const fake = pilot(script);
    const prov = provider(ok(valid));
    await assert.rejects(generateProposal(createApiContext(fake.db), input, prov.p), reject("forbidden", NOT_PILOT_ADMIN));
    assert.equal(prov.calls.length, 0);
    assert.ok(!fake.calls.some((c) => c.target === "table:ai_builder_runs"), "no run logged");
  }
  const fake = pilot();
  const prov = provider(ok(valid), false);
  await assert.rejects(generateProposal(createApiContext(fake.db), input, prov.p), reject("unavailable"));
  assert.equal(prov.calls.length, 0);
  assert.ok(!fake.calls.some((c) => c.target === "table:ai_builder_runs"));
});

test("generation: a template outside the pilot workspace, a bad brief, or the database's limit stop before the model", async () => {
  const prov = provider(ok(valid));
  await assert.rejects(generateProposal(createApiContext(pilot().db), { ...input, templateId: TEMPLATE }, prov.p), reject("not_found"));
  await assert.rejects(generateProposal(createApiContext(pilot().db), { ...input, brief: "   " }, prov.p), reject("invalid"));
  await assert.rejects(generateProposal(createApiContext(pilot().db), { ...input, brief: "x".repeat(2001) }, prov.p), reject("invalid"));
  await assert.rejects(generateProposal(createApiContext(pilot().db), { ...input, requestKey: "x" }, prov.p), reject("invalid"));
  const limited = pilot({ insert: { data: null, error: { code: "54000", message: "limit", hint: "ai_builder_rate_limited" } } });
  await assert.rejects(generateProposal(createApiContext(limited.db), input, prov.p), reject("unavailable", LIMIT_REACHED));
  const dup = pilot({ insert: { data: null, error: { code: "23505", message: "duplicate" } } });
  await assert.rejects(generateProposal(createApiContext(dup.db), input, prov.p), reject("conflict"));
  assert.equal(prov.calls.length, 0, "the model is never called");
});

test("generation: the template's outline (pilot workspace only) goes into the prompt", async () => {
  const fake = pilot({ template: { data: { name: "Events", workspace_id: WS, content: { sections: [{ id: "s", name: "Prep" }], tasks: [] } }, error: null } });
  const prov = provider(ok(valid));
  await generateProposal(createApiContext(fake.db), { ...input, templateId: TEMPLATE }, prov.p);
  const tpl = fake.calls.find((c) => c.target === "table:project_templates")!;
  assert.ok(tpl.steps.some(([s, a]) => s === "eq" && a[0] === "workspace_id" && a[1] === WS), "scoped to the pilot workspace");
  assert.match((prov.calls[0] as { prompt: string }).prompt, /<template_outline>[\s\S]*Prep/);
});

test("generation: provider failures and bad output are logged as failed runs with a code, nothing else", async () => {
  for (const code of ["auth", "rate_limited", "timeout", "refused", "truncated", "invalid_output"] as const) {
    const fake = pilot();
    const prov = provider({ ok: false, code, model: "claude-sonnet-5-5", inputTokens: 10, outputTokens: null });
    await assert.rejects(generateProposal(createApiContext(fake.db), input, prov.p), reject("unavailable"));
    const update = fake.calls.find((c) => c.target === "table:ai_builder_runs" && hasStep(c, "update"))!;
    assert.equal((step(update, "update")![0] as { status: string; error_code: string }).status, "failed");
    assert.equal((step(update, "update")![0] as { error_code: string }).error_code, code);
  }
  const thrown = pilot();
  await assert.rejects(generateProposal(createApiContext(thrown.db), input, provider(() => { throw new Error("boom: sk-ant-secret"); }).p), (e: unknown) => isApiError(e) && !e.message.includes("sk-ant"));
  const malformed = pilot();
  await assert.rejects(generateProposal(createApiContext(malformed.db), input, provider(ok({ name: "x", sections: [], extra: 1 })).p), reject("failed"));
  const failed = malformed.calls.find((c) => c.target === "table:ai_builder_runs" && hasStep(c, "update"))!;
  assert.equal((step(failed, "update")![0] as { error_code: string }).error_code, "invalid_output");
});

test("generation: a valid answer is stored as version 1 of the run, with usage; nothing is created", async () => {
  const fake = pilot();
  const res = await generateProposal(createApiContext(fake.db), input, provider(ok(valid)).p);
  assert.equal(res.runId, RUN);
  assert.equal(res.version, 1);
  const update = fake.calls.find((c) => c.target === "table:ai_builder_runs" && hasStep(c, "update"))!;
  const patch = step(update, "update")![0] as Record<string, unknown>;
  assert.equal(patch.status, "proposed");
  assert.equal(patch.proposal_version, 1);
  assert.equal(patch.input_tokens, 900);
  const insert = fake.calls.find((c) => c.target === "table:ai_builder_runs" && hasStep(c, "insert"))!;
  const row = step(insert, "insert")![0] as Record<string, unknown>;
  // Round 2 adds the run's kind (build); still never the brief's text.
  assert.deepEqual(Object.keys(row).sort(), ["brief_chars", "kind", "request_key", "template_id", "workspace_id"], "the brief's text is never logged");
  assert.ok(!fake.calls.some((c) => /projects|tasks|sections|custom_fields|ai_builder_apply/.test(c.target)), "no project writes");
});

test("apply: the latest proposal is validated, saved as a new version when edited, then applied once", async () => {
  const stored = parseProposal(valid);
  assert.ok(stored.ok);
  if (!stored.ok) return;
  // Unchanged: applied as is.
  const same = pilot({ run: { data: { id: RUN, workspace_id: WS, status: "proposed", proposal: stored.proposal, proposal_version: 1 }, error: null } });
  const res = await applyProposal(createApiContext(same.db), { runId: RUN, proposal: stored.proposal, version: 1, localToday: "2026-11-08" });
  assert.equal(res.projectId, PROJECT);
  assert.ok(!same.calls.some((c) => c.target === "table:ai_builder_runs" && hasStep(c, "update")));
  assert.deepEqual(step(same.calls.find((c) => c.target === "rpc:ai_builder_apply")!, "args")![0], { target_run: RUN, expected_version: 1, local_today: "2026-11-08" });
  // Edited: saved as version 2 (only from version 1), then applied as version 2.
  const edited = pilot({ run: { data: { id: RUN, workspace_id: WS, status: "proposed", proposal: stored.proposal, proposal_version: 1 }, error: null } });
  await applyProposal(createApiContext(edited.db), { runId: RUN, proposal: { ...stored.proposal, name: "Renamed" }, version: 1, localToday: "2026-11-08" });
  const save = edited.calls.find((c) => c.target === "table:ai_builder_runs" && hasStep(c, "update"))!;
  assert.ok(save.steps.some(([s, a]) => s === "eq" && a[0] === "proposal_version" && a[1] === 1));
  assert.equal((step(edited.calls.find((c) => c.target === "rpc:ai_builder_apply")!, "args")![0] as { expected_version: number }).expected_version, 2);
  // Invalid edits never reach the database's apply.
  const invalid = pilot();
  await assert.rejects(applyProposal(createApiContext(invalid.db), { runId: RUN, proposal: { ...stored.proposal, sections: [] }, version: 1, localToday: "2026-11-08" }), reject("invalid"));
  assert.ok(!invalid.calls.some((c) => c.target === "rpc:ai_builder_apply"));
  // A run of another workspace, a stale version, a non-admin.
  const elsewhere = pilot({ run: { data: { id: RUN, workspace_id: TEMPLATE, status: "proposed", proposal: null, proposal_version: 1 }, error: null } });
  await assert.rejects(applyProposal(createApiContext(elsewhere.db), { runId: RUN, proposal: stored.proposal, version: 1, localToday: "2026-11-08" }), reject("forbidden"));
  const stale = pilot({ run: { data: { id: RUN, workspace_id: WS, status: "proposed", proposal: stored.proposal, proposal_version: 3 }, error: null } });
  await assert.rejects(applyProposal(createApiContext(stale.db), { runId: RUN, proposal: { ...stored.proposal, name: "Old" }, version: 2, localToday: "2026-11-08" }), reject("conflict"));
  const raced = pilot({ apply: { data: null, error: { code: "40001", message: "changed" } } });
  await assert.rejects(applyProposal(createApiContext(raced.db), { runId: RUN, proposal: stored.proposal, version: 1, localToday: "2026-11-08" }), reject("conflict"));
  const outsider = pilot({ admin: { data: false, error: null } });
  await assert.rejects(applyProposal(createApiContext(outsider.db), { runId: RUN, proposal: stored.proposal, version: 1, localToday: "2026-11-08" }), reject("forbidden"));
  assert.ok(!outsider.calls.some((c) => c.target === "rpc:ai_builder_apply"));
  // A repeat (double click) answers with the same project.
  const again = pilot({ apply: { data: { status: "applied", project_id: PROJECT, repeated: true }, error: null } });
  assert.equal((await applyProposal(createApiContext(again.db), { runId: RUN, proposal: stored.proposal, version: 1, localToday: "2026-11-08" })).repeated, true);
});

test("undo and cancel: conflicts are reported, outsiders refused, finished runs left alone", async () => {
  const conflict = pilot({ undo: { data: { status: "conflict", project_id: PROJECT, changed: ["tasks", "comments"] }, error: null } });
  assert.deepEqual(await undoRun(createApiContext(conflict.db), RUN), { status: "conflict", projectId: PROJECT, changed: ["tasks", "comments"] });
  assert.deepEqual(await undoRun(createApiContext(pilot({ undo: { data: { status: "already_undone", project_id: PROJECT }, error: null } }).db), RUN), {
    status: "already_undone",
    projectId: PROJECT,
  });
  await assert.rejects(undoRun(createApiContext(pilot({ admin: { data: false, error: null } }).db), RUN), reject("forbidden"));
  await assert.rejects(undoRun(createApiContext(pilot({ undo: { data: null, error: { code: "42501", message: "not yours" } } }).db), RUN), reject("forbidden"));
  const done = pilot({ run: { data: { id: RUN, workspace_id: WS, status: "cancelled", proposal: null, proposal_version: 1 }, error: null } });
  await cancelRun(createApiContext(done.db), RUN);
  assert.ok(!done.calls.some((c) => hasStep(c, "update")), "cancelling twice changes nothing");
  const applied = pilot({ run: { data: { id: RUN, workspace_id: WS, status: "applied", proposal: null, proposal_version: 1 }, error: null } });
  await assert.rejects(cancelRun(createApiContext(applied.db), RUN), reject("conflict"));
});
