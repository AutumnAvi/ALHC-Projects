// Nov 12 notes, batch 40 (items 2 and 3): the Files tab and Reports' four groupings each read once
// (project_file_page, workspace_report_groups), and fall back to the old reads while those functions
// aren't on the database yet (20261112020000_nov12_speed40_a.sql applied after the code).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiContext, type Db } from "@alhc/core/api/core/context";
import { listProjectFiles } from "@alhc/core/api/projects/queries";
import { workspaceReportGroups } from "@alhc/core/api/reports/queries";

type Call = { target: string; steps: Array<[string, unknown[]]> };
type Answer = { data: unknown; error: { code?: string; message: string } | null };

function fakeDb(answer: (call: Call) => Answer): { db: Db; calls: Call[] } {
  const calls: Call[] = [];
  const chain = (call: Call): unknown =>
    new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === "then") {
            const result = answer(call);
            return (resolve: (value: Answer) => unknown) => resolve(result);
          }
          return (...args: unknown[]) => {
            call.steps.push([String(prop), args]);
            return chain(call);
          };
        },
      },
    );
  const start = (target: string) => {
    const call: Call = { target, steps: [] };
    calls.push(call);
    return call;
  };
  const db = {
    from: (table: string) => chain(start(`table:${table}`)),
    rpc: (fn: string, args?: unknown) => {
      const call = start(`rpc:${fn}`);
      call.steps.push(["args", [args]]);
      return chain(call);
    },
  };
  return { db: db as unknown as Db, calls };
}

const MISSING = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
const PROJECT = "00000000-0000-4000-8000-0000000000aa";
const file = (id: string, createdAt: string, task = "t1") => ({
  id,
  file_name: `${id}.png`,
  content_type: "image/png",
  size_bytes: 10,
  uploaded_by: "u1",
  source: "upload",
  created_at: createdAt,
  deleted_at: null,
  task_id: task,
  task_title: `Task ${task}`,
});

test("item 2: Files is one read of project_file_page", async () => {
  const world = fakeDb((call) =>
    call.target === "rpc:project_file_page" ? { data: [file("f2", "2026-11-02"), file("f1", "2026-11-01", "s1")], error: null } : MISSING,
  );
  const files = await listProjectFiles(createApiContext(world.db, { memo: false }), PROJECT);
  assert.deepEqual(world.calls.map((c) => c.target), ["rpc:project_file_page"]);
  assert.deepEqual(world.calls[0].steps[0], ["args", [{ target_project: PROJECT, max_results: 500 }]]);
  assert.deepEqual(files.map((f) => [f.id, f.taskId, f.taskTitle, f.source, f.sizeBytes]), [
    ["f2", "t1", "Task t1", "upload", 10],
    ["f1", "s1", "Task s1", "upload", 10],
  ]);
});

test("item 2: without project_file_page, the old reads give the same files", async () => {
  const world = fakeDb((call) => {
    if (call.target === "rpc:project_file_page") return MISSING;
    if (call.target === "table:task_projects")
      return {
        data: [
          { task_id: "t1", tasks: { id: "t1", title: "Task t1", deleted_at: null, task_attachments: [file("f2", "2026-11-02"), { ...file("fx", "2026-11-03"), deleted_at: "2026-11-04" }] } },
        ],
        error: null,
      };
    if (call.target === "table:tasks")
      return { data: [{ id: "s1", title: "Task s1", deleted_at: null, task_attachments: [file("f1", "2026-11-01", "s1")] }], error: null };
    return { data: null, error: null };
  });
  const files = await listProjectFiles(createApiContext(world.db, { memo: false }), PROJECT);
  assert.deepEqual(world.calls.map((c) => c.target), ["rpc:project_file_page", "table:task_projects", "table:tasks"]);
  assert.deepEqual(files.map((f) => [f.id, f.taskId]), [["f2", "t1"], ["f1", "s1"]]);
});

const row = (bucket: string | null, total: number) => ({
  bucket,
  project_id: null,
  task_count: total,
  completed_count: 1,
  incomplete_count: total - 1,
  overdue_count: 0,
  completed_recent_count: 1,
});

function reportsWorld(groups: "deployed" | "missing") {
  return fakeDb((call) => {
    if (call.target === "table:workspaces") return { data: { id: "w", name: "W", tags_enabled: true }, error: null };
    if (call.target === "rpc:workspace_report_groups")
      return groups === "missing"
        ? MISSING
        : { data: { none: [row(null, 5)], project: [row("p1", 5)], assignee: [row("u1", 3), row(null, 2)], section: [] }, error: null };
    if (call.target === "rpc:workspace_report") {
      const by = (call.steps[0][1][0] as { group_by: string }).group_by;
      const data = { none: [row(null, 5)], project: [row("p1", 5)], assignee: [row("u1", 3), row(null, 2)], section: [] }[by];
      return { data, error: null };
    }
    return { data: null, error: null };
  });
}

test("item 3: Reports' four groupings are one call, the same rows as four", async () => {
  const one = reportsWorld("deployed");
  const four = reportsWorld("missing");
  const a = await workspaceReportGroups(createApiContext(one.db, { memo: false }), {}, "UTC");
  const b = await workspaceReportGroups(createApiContext(four.db, { memo: false }), {}, "UTC");
  assert.deepEqual(a, b);
  assert.equal(a.none[0].total, 5);
  assert.equal(a.assignee.length, 2);
  const rpcs = (calls: Call[]) => calls.filter((c) => c.target.startsWith("rpc:")).map((c) => c.target);
  assert.deepEqual(rpcs(one.calls), ["rpc:workspace_report_groups"]);
  // Before the migration: the function is missing, so the page falls back to the four calls.
  assert.deepEqual(rpcs(four.calls), [
    "rpc:workspace_report_groups",
    "rpc:workspace_report",
    "rpc:workspace_report",
    "rpc:workspace_report",
    "rpc:workspace_report",
  ]);
});
