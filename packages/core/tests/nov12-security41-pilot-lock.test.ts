// Security audit 2 (Nov 12, batch 41, Medium): the AI never touches anything outside the Testing data
// pilot workspace, even in a real project the test person is a member of. One lock (pilot-lock.ts) that
// every assistant and MCP tool call goes through: the ids a call names, the ids staged changes carry, the
// ids a lookup answers with, and again just before every write and Undo. Synthetic: in-memory database.
import assert from "node:assert/strict";
import test from "node:test";
import { createApiContext } from "@alhc/core/api/core/context";
import { checkOp } from "@alhc/core/api/capabilities/engine";
import { idsIn, idsOutsidePilot, OUTSIDE_PILOT } from "@alhc/core/api/capabilities/pilot-lock";
import type { StagedOp } from "@alhc/core/api/capabilities/types";
import { mcpCallTool, type McpIdentity } from "@alhc/core/api/mcp/tools";
import type { MemoryState } from "./memory-db";
import { ME, MATE, P1, S_DONE, S_TODO, T_FLYER, WS, apply, db, once, propose, reject, task, toolModel, tref, world } from "./ai-fixtures";

// The real workspace, where the test person is (wrongly) an Owner of a real project.
const REAL_WS = "99999999-9999-4999-8999-999999999901";
const P_REAL = "99999999-9999-4999-8999-999999999911";
const S_REAL = "99999999-9999-4999-8999-999999999921";
const T_REAL = "99999999-9999-4999-8999-999999999931";
const C_REAL = "99999999-9999-4999-8999-999999999941";
const G_REAL = "99999999-9999-4999-8999-999999999951";
const TAG_REAL = "99999999-9999-4999-8999-999999999961";
const R_REAL = "99999999-9999-4999-8999-999999999971";

function both(role = "owner"): MemoryState {
  const s = world(role);
  s.workspaces.push({ id: REAL_WS, name: "ALHC", deleted_at: null, goals_enabled: true });
  s.projects.push({ id: P_REAL, name: "Real client work", workspace_id: REAL_WS, archived_at: null, sections_locked: false, deleted_at: null });
  s.project_members.push({ project_id: P_REAL, profile_id: ME, role: "owner", deleted_at: null }, { project_id: P_REAL, profile_id: MATE, role: "editor", deleted_at: null });
  s.sections.push({ id: S_REAL, project_id: P_REAL, name: "Real to do", sort_order: 1024, deleted_at: null });
  s.tasks.push({ ...task(T_REAL, "Real launch plan"), workspace_id: REAL_WS });
  for (const t of s.tasks) if (!t.workspace_id) t.workspace_id = WS;
  s.task_projects.push({ task_id: T_REAL, project_id: P_REAL, section_id: S_REAL, sort_order: 1024, deleted_at: null });
  s.comments = [{ id: C_REAL, task_id: T_REAL, author_id: ME, body: "Real comment", created_at: "2026-11-10T10:00:00Z", deleted_at: null }];
  s.goals = [{ id: G_REAL, title: "Real goal", workspace_id: REAL_WS, status: "on_track", deleted_at: null }];
  s.tags = [{ id: TAG_REAL, name: "real", workspace_id: REAL_WS, deleted_at: null, archived_at: null }];
  s.rules.push({ id: R_REAL, project_id: P_REAL, name: "Real automation", enabled: true, trigger_type: "task_created", trigger_config: {}, conditions: [], actions: [], preset_key: null, sort_order: 1024, deleted_at: null });
  return s;
}

const ident = (): McpIdentity => ({ profileId: ME, workspaceId: WS, scopes: ["read", "write"], tokenId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });

test("the lock finds every row of another workspace among the ids, and only those", async () => {
  const s = both();
  const ctx = createApiContext(db(s));
  const outside = await idsOutsidePilot(ctx, WS, [P_REAL, S_REAL, T_REAL, C_REAL, G_REAL, TAG_REAL, R_REAL, REAL_WS, P1, S_TODO, T_FLYER, ME, MATE, "12345678-1234-4234-8234-123456789012"]);
  assert.deepEqual(outside.sort(), [P_REAL, S_REAL, T_REAL, C_REAL, G_REAL, TAG_REAL, R_REAL, REAL_WS].sort());
  // Ids inside text and nested steps are found too (an automation's step, a widget's filter).
  assert.deepEqual(idsIn({ actions: [{ type: "move_section", section_id: S_REAL.toUpperCase() }] }, [`see ${T_REAL}`]), [S_REAL, T_REAL]);
});

test("MCP: a real project the person is a member of is out of reach (reads, previews, and confirmed writes)", async () => {
  const s = both();
  const before = JSON.stringify({ tasks: s.tasks, task_projects: s.task_projects, comments: s.comments });
  for (const [tool, args] of [
    ["get_task", { task: T_REAL }],
    ["get_project", { project: P_REAL }],
    ["get_automation", { automation: R_REAL }],
    ["search_tasks", { query: "Real launch", project: P_REAL }],
    ["rename_task", { task: T_REAL, name: "Hijacked", confirm: true }],
    ["rename_task", { task: T_REAL, name: "Hijacked" }],
    ["move_task", { task: T_FLYER, section: S_REAL, confirm: true }],
    ["create_task", { project: P_REAL, name: "Planted", confirm: true }],
    ["add_comment", { task: T_REAL, body: "Planted", confirm: true }],
    ["delete_comment", { comment: C_REAL, confirm: true }],
  ] as const) {
    const r = await mcpCallTool(createApiContext(db(s)), ident(), tool, args).catch((e: unknown) => ({ ok: false, error: String(e) }));
    assert.equal(r.ok === false || (r as { data?: { applied?: boolean } }).data?.applied === false, true, `${tool}: ${JSON.stringify(r)}`);
    if (r.ok) assert.equal(((r as { data: { preview?: unknown[] } }).data.preview ?? []).length, 0, `${tool} previewed something outside`);
  }
  assert.equal(JSON.stringify({ tasks: s.tasks, task_projects: s.task_projects, comments: s.comments }), before);
  // Inside Testing data it still works.
  const ok = await mcpCallTool(createApiContext(db(s)), ident(), "rename_task", { task: T_FLYER, name: "Summer flyer", confirm: true });
  assert.equal((ok as { data: { applied: boolean } }).data.applied, true, JSON.stringify(ok));
  assert.equal(s.tasks.find((t) => t.id === T_FLYER)!.title, "Summer flyer");
});

test("a lookup never hands out another workspace's things (inbox items, templates)", async () => {
  const s = both();
  s.inbox_items = [
    { id: "88888888-8888-4888-8888-888888888801", recipient_id: ME, kind: "comment", task_id: T_REAL, project_id: null, read_at: null, archived_at: null, created_at: "2026-11-11T10:00:00Z" },
    { id: "88888888-8888-4888-8888-888888888802", recipient_id: ME, kind: "assigned", task_id: T_FLYER, project_id: null, read_at: null, archived_at: null, created_at: "2026-11-11T09:00:00Z" },
  ];
  s.project_templates = [
    { id: "88888888-8888-4888-8888-888888888811", name: "Creative Requests", workspace_id: REAL_WS, deleted_at: null },
    { id: "88888888-8888-4888-8888-888888888812", name: "Pilot template", workspace_id: WS, deleted_at: null },
  ];
  const inbox = await mcpCallTool(createApiContext(db(s)), ident(), "list_my_things", { what: "inbox" });
  assert.equal(inbox.ok, true, JSON.stringify(inbox));
  assert.deepEqual((inbox as { data: { items: { item: string }[] } }).data.items.map((x) => x.item), ["88888888-8888-4888-8888-888888888802"]);
  const templates = await mcpCallTool(createApiContext(db(s)), ident(), "list_my_things", { what: "project_templates" });
  assert.deepEqual((templates as { data: { templates: { name: string }[] } }).data.templates.map((t) => t.name), ["Pilot template"]);
});

test("the second wall: a change aimed outside Testing data is refused at Confirm and Undo even if it got staged", async () => {
  const s = both();
  const ctx = createApiContext(db(s));
  const op = { op: "rename_task", group: "tasks", projectId: P1, projects: [P1], label: "Rename", before: "x", after: "y", expect: null, args: { task_id: T_REAL, title: "Hijacked" }, dependsOn: [], destructive: false, notifies: null, noUndo: false } as unknown as StagedOp;
  await assert.rejects(checkOp(ctx, WS, op), reject("forbidden", OUTSIDE_PILOT));
  await assert.rejects(checkOp(ctx, WS, op, { undoing: true }), reject("forbidden", OUTSIDE_PILOT));
  await assert.rejects(checkOp(ctx, WS, { ...op, projectId: P_REAL, projects: [P_REAL], args: { task_id: T_FLYER, title: "x" } } as StagedOp), reject("forbidden", OUTSIDE_PILOT));
  await checkOp(ctx, WS, { ...op, args: { task_id: T_FLYER, title: "Fine" } } as StagedOp);
});

test("the in-app assistant: a stored change set pointed at a real task is refused at Confirm; nothing changes", async () => {
  const s = both();
  const d = db(s);
  const { p } = toolModel(once((ctx) => [{ name: "rename_task", input: { task: tref(ctx, "Spring flyer"), name: "Summer flyer" } }]));
  const proposal = await propose(d, p);
  const run = s.ai_assistant_runs.find((r) => r.id === proposal.runId)!;
  // Tamper with the stored plan, as if a staging bug had let a real task through.
  run.proposal = JSON.parse(JSON.stringify(run.proposal).split(T_FLYER).join(T_REAL));
  await assert.rejects(apply(d, proposal.runId, [0]), (e: unknown) => String((e as Error).message).includes(OUTSIDE_PILOT));
  assert.equal(s.tasks.find((t) => t.id === T_REAL)!.title, "Real launch plan");
  assert.equal(s.tasks.find((t) => t.id === T_FLYER)!.title, "Spring flyer");
  // Untampered, inside Testing data, the same change set applies.
  const again = await propose(d, toolModel(once((ctx) => [{ name: "rename_task", input: { task: tref(ctx, "Spring flyer"), name: "Summer flyer" } }])).p);
  await apply(d, again.runId, [0]);
  assert.equal(s.tasks.find((t) => t.id === T_FLYER)!.title, "Summer flyer");
  assert.ok(S_DONE && S_TODO);
});
