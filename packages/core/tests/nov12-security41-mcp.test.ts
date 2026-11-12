// Security audit 2 (Nov 12, batch 41, Medium): over MCP every change waits for an explicit yes. Without
// `confirm: true` (the boolean) a write tool answers a preview and nothing in the database changes; only the
// tools on the explicit read list run at once. Synthetic: the in-memory database (no live writes).
import assert from "node:assert/strict";
import test from "node:test";
import { toolMeta, toolsFor, type Param, type ToolName } from "@alhc/core/ai-tools";
import { createApiContext } from "@alhc/core/api/core/context";
import { isConfirmed, MCP_READ_TOOLS, mcpCallTool, mcpListTools, mcpRunsWithoutConfirm, type McpIdentity } from "@alhc/core/api/mcp/tools";
import { F_PRIORITY, ME, P1, R_TRIAGE, S_DONE, S_TODO, T_FLYER, WS, db, world } from "./ai-fixtures";

const ident = (scopes: string[] = ["read", "write"]): McpIdentity => ({ profileId: ME, workspaceId: WS, scopes, tokenId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
const WRITES = toolsFor("mcp").filter((n) => !mcpRunsWithoutConfirm(n));

// A plausible value for each parameter, so most tools get far enough to stage a real change.
function sample(p: Param): unknown {
  switch (p.t) {
    case "ref":
      return { task: T_FLYER, project: P1, section: S_DONE, field: F_PRIORITY, rule: R_TRIAGE }[p.kind as string] ?? T_FLYER;
    case "refs":
      return p.kind === "task" ? [T_FLYER] : [];
    case "str":
      return "Security check";
    case "int":
      return p.min ?? 1;
    case "bool":
      return true;
    case "enum":
      return p.values[0];
    case "strs":
      return ["Security check"];
    case "date":
      return "2026-11-20";
    case "person":
      return "me";
    case "people":
      return ["me"];
    case "automation":
      return { name: "Security check", trigger: { type: "task_created" }, conditions: [], actions: [{ type: "mark_complete" }] };
  }
}
// The database's rows (the in-memory stand-in adds an empty table when something reads one: not a change).
const snapshot = (s: Record<string, unknown[]>) =>
  JSON.stringify(Object.entries(s).filter(([, rows]) => rows.length > 0).sort(([a], [b]) => a.localeCompare(b)));
const argsFor = (name: ToolName) => Object.fromEntries(Object.entries(toolMeta(name).params as Record<string, Param>).map(([k, p]) => [k, sample(p)]));

test("only the explicit read list runs without a yes; every other tool (and any new one) needs confirm: true", () => {
  assert.deepEqual([...MCP_READ_TOOLS].sort(), ["get_automation", "get_project", "get_task", "list_my_things", "search_people", "search_projects", "search_tasks"]);
  for (const n of toolsFor("mcp")) assert.equal(mcpRunsWithoutConfirm(n), MCP_READ_TOOLS.has(n), n);
  // Every lookup offered over MCP today is on the list (reads are unchanged)…
  for (const n of toolsFor("mcp")) if (toolMeta(n).kind === "read") assert.ok(MCP_READ_TOOLS.has(n), n);
  // …and a tool that isn't on it, whatever its kind, needs a confirmation (find_tools is a lookup of the
  // in-app assistant only: if it were ever offered over MCP, it would wait for a yes until listed here).
  assert.equal(toolMeta("find_tools").kind, "read");
  assert.equal(mcpRunsWithoutConfirm("find_tools"), false);
  assert.ok(WRITES.length > 60, `${WRITES.length} write tools`);
  // Only the boolean true confirms.
  assert.equal(isConfirmed(true), true);
  for (const v of [false, "true", "yes", 1, null, undefined, {}, [true]]) assert.equal(isConfirmed(v), false, String(v));
});

test("the tool list says so: no write is read-only, every write takes confirm and says it changes nothing without it", () => {
  for (const t of mcpListTools(ident())) {
    const needs = !MCP_READ_TOOLS.has(t.name as ToolName);
    assert.equal(t.annotations.readOnlyHint, !needs, t.name);
    const props = (t.inputSchema as { properties: Record<string, { description?: string }> }).properties;
    if (needs) {
      assert.ok(props.confirm, `${t.name} takes confirm`);
      assert.match(props.confirm.description ?? "", /must be true to make this change.*without it you get a preview and nothing changes/, t.name);
      assert.match(t.description, /Changes nothing until called with confirm: true/, t.name);
    } else {
      assert.equal(props.confirm, undefined, t.name);
    }
  }
  // A read-only token is offered the read list only.
  assert.deepEqual(mcpListTools(ident(["read"])).map((t) => t.name).sort(), [...MCP_READ_TOOLS].sort());
});

test("every write tool: without confirm: true (missing, false, \"true\", 1) nothing in the database changes", async () => {
  let previews = 0;
  const previewed: string[] = [];
  for (const name of WRITES) {
    for (const confirm of [undefined, false, "true", 1]) {
      for (const args of [argsFor(name), {}]) {
        const s = world("owner");
        const before = snapshot(s);
        const call = confirm === undefined ? args : { ...args, confirm };
        let answer: unknown;
        try {
          answer = await mcpCallTool(createApiContext(db(s)), ident(), name, call);
        } catch (error) {
          answer = { thrown: String(error) };
        }
        assert.equal(snapshot(s), before, `${name} (confirm ${String(confirm)}) changed the database`);
        const data = (answer as { ok?: boolean; data?: { applied?: boolean; preview?: unknown[] } }).data;
        if (data) {
          assert.equal(data.applied, false, `${name}: ${JSON.stringify(answer)}`);
          if (confirm === undefined && args !== undefined && (data.preview?.length ?? 0) > 0 && !previewed.includes(name)) {
            previews += 1;
            previewed.push(name);
          }
        }
      }
    }
  }
  // Enough tools staged a real preview that this isn't only refusals.
  assert.ok(previews >= 20, `${previews} tools previewed: ${previewed.join(", ")}`);
  for (const n of ["rename_task", "set_description", "assign_task", "set_dates", "create_task", "add_comment", "complete_task", "delete_task"]) {
    assert.ok(previewed.includes(n), `${n} previews (got ${previewed.join(", ")})`);
  }
});

test("with confirm: true the previewed change is made (and logged as a run with Undo)", async () => {
  const s = world("owner");
  const d = db(s);
  const preview = await mcpCallTool(createApiContext(d), ident(), "rename_task", { task: T_FLYER, name: "Summer flyer" });
  assert.equal((preview as { data: { applied: boolean } }).data.applied, false);
  assert.equal(s.tasks.find((t) => t.id === T_FLYER)!.title, "Spring flyer");
  assert.equal(s.ai_assistant_runs.length, 0, "a preview logs no run");
  const done = await mcpCallTool(createApiContext(d), ident(), "rename_task", { task: T_FLYER, name: "Summer flyer", confirm: true });
  assert.equal((done as { data: { applied: boolean } }).data.applied, true, JSON.stringify(done));
  assert.equal(s.tasks.find((t) => t.id === T_FLYER)!.title, "Summer flyer");
  assert.equal(s.ai_assistant_runs.find((r) => r.source === "mcp")?.status, "applied");

  const s2 = world("owner");
  const r = await mcpCallTool(createApiContext(db(s2)), ident(), "move_task", { task: T_FLYER, section: S_DONE, confirm: true });
  assert.equal((r as { data: { applied: boolean } }).data.applied, true, JSON.stringify(r));
  assert.equal(s2.task_projects.find((m) => m.task_id === T_FLYER && m.project_id === P1)!.section_id, S_DONE);
  assert.notEqual(S_TODO, S_DONE);
});

test("read tools are unchanged: they answer at once, with or without confirm, and change nothing", async () => {
  const s = world("owner");
  const before = snapshot(s);
  const r = await mcpCallTool(createApiContext(db(s)), ident(["read"]), "get_task", { task: T_FLYER });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((r as { data: { title: string } }).data.title, "Spring flyer");
  const p = await mcpCallTool(createApiContext(db(s)), ident(["read"]), "search_projects", { query: "" });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(snapshot(s), before);
});
