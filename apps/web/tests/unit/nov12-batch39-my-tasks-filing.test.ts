// Nov 12 batch 39 (2b): the My tasks checklist no longer waits on my_tasks_layout() (seeding sections and
// filing newly assigned tasks into Recently assigned). It reads the person's sections as stored and files
// after the page is sent; the classic sections view still files first, exactly as before. Only someone
// with no sections yet waits for them to be seeded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createApiContext, type Db } from "@alhc/core/api/core/context";
import { listChecklistSections, listMyTaskLayout } from "@alhc/core/api/my-tasks/queries";
import { fileMyTaskPlacements } from "@alhc/core/api/my-tasks/mutations";

type Call = { target: string };
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
          return () => chain(call);
        },
      },
    );
  const start = (target: string) => {
    const call: Call = { target };
    calls.push(call);
    return call;
  };
  const db = {
    from: (table: string) => chain(start(`table:${table}`)),
    rpc: (fn: string) => chain(start(`rpc:${fn}`)),
  };
  return { db: db as unknown as Db, calls };
}

const SECTION = { id: "s1", kind: "recently_assigned", name: "Recently assigned", sort_order: 1024 };
const PLACED = { task_id: "t1", section_id: "s1", sort_order: 1024 };

function world(sections: unknown[]) {
  return fakeDb((call) => {
    if (call.target === "table:my_task_sections") return { data: sections, error: null };
    if (call.target === "rpc:my_tasks_layout") return { data: [PLACED], error: null };
    if (call.target === "rpc:sync_my_task_placements") return { data: "s1", error: null };
    return { data: null, error: { message: `unexpected ${call.target}` } };
  });
}

test("the checklist reads the person's sections without filing", async () => {
  const { db, calls } = world([SECTION]);
  const result = await listChecklistSections(createApiContext(db));
  assert.deepEqual(result, { sections: [{ id: "s1", kind: "recently_assigned", name: "Recently assigned", sortOrder: 1024 }], filed: false });
  assert.deepEqual(calls.map((c) => c.target), ["table:my_task_sections"], "one plain read, no my_tasks_layout");
});

test("someone with no sections yet still has them seeded (and filed) before the checklist answers", async () => {
  let seeded = false;
  const { db, calls } = fakeDb((call) => {
    if (call.target === "rpc:my_tasks_layout") {
      seeded = true;
      return { data: [], error: null };
    }
    if (call.target === "table:my_task_sections") return { data: seeded ? [SECTION] : [], error: null };
    return { data: null, error: { message: call.target } };
  });
  const result = await listChecklistSections(createApiContext(db));
  assert.equal(result.filed, true);
  assert.equal(result.sections.length, 1);
  assert.deepEqual(calls.map((c) => c.target), ["table:my_task_sections", "rpc:my_tasks_layout", "table:my_task_sections"]);
});

test("the classic sections view still files first and returns the placements", async () => {
  const { db, calls } = world([SECTION]);
  const result = await listMyTaskLayout(createApiContext(db));
  assert.deepEqual(result.placements, { t1: { sectionId: "s1", sortOrder: 1024 } });
  assert.deepEqual(calls.map((c) => c.target), ["rpc:my_tasks_layout", "table:my_task_sections"], "filing before the sections read");
});

test("the follow-up filing is the database's idempotent sync", async () => {
  const { db, calls } = world([SECTION]);
  await fileMyTaskPlacements(createApiContext(db));
  await fileMyTaskPlacements(createApiContext(db));
  assert.deepEqual(calls.map((c) => c.target), ["rpc:sync_my_task_placements", "rpc:sync_my_task_placements"]);
});

test("the page: the checklist branch files after the response; the classic branch awaits the layout", () => {
  const page = readFileSync(new URL("../../src/app/(app)/my-tasks/page.tsx", import.meta.url), "utf8");
  const checklist = page.slice(page.indexOf('if (layout === "checklist")'), page.indexOf("// The classic views"));
  assert.ok(checklist.includes("listChecklistSections()"), "checklist reads sections without filing");
  assert.ok(!checklist.includes("listMyTaskLayout()"), "checklist doesn't wait on my_tasks_layout");
  assert.match(checklist, /after\(\(\) => fileMyTaskPlacements\(ctx\)/, "and files after the response");
  const classic = page.slice(page.indexOf("// The classic views"));
  assert.ok(classic.includes("await listMyTaskLayout()"), "the classic view still files first");
});
