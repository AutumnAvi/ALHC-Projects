// Nov 12 speed batch 39 (item 5): the search palette matches people and projects in the browser and asks
// the server only for tasks. The browser's matcher is the server's (quickSearch uses it too), so the same
// query gives the same rows in the same order; and the task-only read makes fewer database calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiContext, type Db } from "@alhc/core/api/core/context";
import { quickSearch, quickSearchPeople, quickSearchTasks } from "@alhc/core/api/shell/queries";
import { matchQuickPeople, matchQuickProjects, quickLimit, quickQuery, rankByLabel } from "@alhc/core/quick-match";

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
    auth: { getClaims: async () => ({ data: { claims: { sub: "me", role: "authenticated" } }, error: null }) },
    from: (table: string) => chain(start(`table:${table}`)),
    rpc: (fn: string, args?: unknown) => {
      const call = start(`rpc:${fn}`);
      call.steps.push(["args", [args]]);
      return chain(call);
    },
  };
  return { db: db as unknown as Db, calls };
}

const PROJECTS = [
  { id: "p1", name: "Spring launch", archived_at: null },
  { id: "p2", name: "Brand refresh", archived_at: "2026-10-01T00:00:00Z" },
  { id: "p3", name: "Launch party", archived_at: null },
  { id: "p4", name: "Old launch", archived_at: "2026-09-01T00:00:00Z" },
  { id: "p5", name: "launch party", archived_at: null },
  { id: "p6", name: "Website", archived_at: null },
  { id: "p7", name: "Launch A", archived_at: null },
  { id: "p8", name: "Launch B", archived_at: null },
];
const PROFILES = [
  { id: "u1", email: "dana@example.com", full_name: "Dana Lee", avatar_url: null },
  { id: "u2", email: "lee.r@example.com", full_name: "Robin Lee", avatar_url: null },
  { id: "u3", email: "gone@example.com", full_name: "Lee Gone", avatar_url: null },
  { id: "u4", email: "sam@example.com", full_name: null, avatar_url: null },
];
const ALLOWED = [{ email: "dana@example.com" }, { email: "LEE.R@example.com" }, { email: "sam@example.com" }];
const TASKS = [{ id: "t1", title: "Launch email", completed_at: null, home_project_id: "p1", home_project_name: "Spring launch" }];

function world() {
  return fakeDb((call) => {
    if (call.target === "rpc:viewer_member") return { data: { allowlisted: true, profile: null }, error: null };
    if (call.target === "table:projects") return { data: PROJECTS, error: null };
    if (call.target === "table:profiles") return { data: PROFILES, error: null };
    if (call.target === "table:allowed_emails") return { data: ALLOWED, error: null };
    if (call.target === "rpc:search_tasks") return { data: TASKS, error: null };
    return { data: [], error: null };
  });
}

test("the browser's project and people matching equals the server's quickSearch, for every chip", async () => {
  for (const query of ["launch", "  LEE ", "party", "e", "zz", "example"]) {
    for (const kind of [null, "projects", "people"] as const) {
      const { db } = world();
      const server = await quickSearch(createApiContext(db, { memo: true }), query, kind);
      // The browser's inputs: the shell's readable projects and the active people list.
      const people = await quickSearchPeople(createApiContext(world().db, { memo: true }));
      const projects = await (await import("@alhc/core/api/projects/queries")).listReadableProjects(
        createApiContext(world().db, { memo: true }),
      );
      assert.deepEqual(matchQuickProjects(kind === "people" ? [] : projects, query, kind), server.projects, `${query} ${kind}`);
      assert.deepEqual(matchQuickPeople(kind === "projects" ? [] : people, query, kind), server.people, `${query} ${kind}`);
    }
  }
});

test("matching rules: starts-with first, then alphabetical, active before archived, limits, people by email", () => {
  assert.deepEqual(
    matchQuickProjects(PROJECTS, "launch", "projects").map((p) => p.id),
    ["p7", "p8", "p3", "p5", "p1", "p4"],
  );
  assert.equal(matchQuickProjects(PROJECTS, "launch", null).length, 5);
  assert.equal(quickLimit(null), 5);
  assert.equal(quickLimit("tasks"), 20);
  const people = [
    { id: "a", name: "Robin Lee", email: "lee.r@example.com" },
    { id: "b", name: "Dana Lee", email: "dana@x.com" },
  ];
  assert.deepEqual(matchQuickPeople(people, "lee", null).map((p) => p.id), ["b", "a"]);
  assert.deepEqual(matchQuickPeople(people, "dana@", null).map((p) => p.id), ["b"]);
  assert.deepEqual(matchQuickProjects(PROJECTS, "   ", null), []);
  assert.equal(quickQuery("x".repeat(300)).length, 200);
  // Equal names keep the list's order (a stable sort, like the server's).
  const twins = [{ n: "A", i: 1 }, { n: "a", i: 2 }];
  assert.deepEqual(rankByLabel(twins, (t) => t.n, "a").map((t) => t.i), [1, 2]);
});

test("removed people (not on the allowlist) are never offered", async () => {
  const people = await quickSearchPeople(createApiContext(world().db, { memo: true }));
  assert.deepEqual(people.map((p) => p.id).sort(), ["u1", "u2", "u4"]);
});

test("a keystroke's server work: tasks and their numbers only (no projects, people, or allowlist read)", async () => {
  const before = world();
  await quickSearch(createApiContext(before.db, { memo: true }), "launch", null);
  const after = world();
  const tasks = await quickSearchTasks(createApiContext(after.db, { memo: true }), "launch", null);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].href, "/projects/p1?task=t1");
  const targets = (calls: Call[]) => calls.map((c) => c.target).filter((t) => t !== "rpc:viewer_member");
  for (const t of ["table:projects", "table:profiles", "table:allowed_emails"]) {
    assert.ok(targets(before.calls).includes(t), `before reads ${t}`);
    assert.ok(!targets(after.calls).includes(t), `after doesn't read ${t}`);
  }
  assert.ok(targets(after.calls).includes("rpc:search_tasks"));
  assert.ok(after.calls.length < before.calls.length, `${after.calls.length} < ${before.calls.length}`);
  // The projects / people chips ask nothing of the database for tasks.
  const chip = world();
  assert.deepEqual(await quickSearchTasks(createApiContext(chip.db, { memo: true }), "launch", "people"), []);
  assert.ok(!chip.calls.some((c) => c.target === "rpc:search_tasks"));
});
