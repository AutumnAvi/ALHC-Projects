// Opening a task must feel instant (Oct 19 notes): the client cache keeps the newest copy, evicts the
// least recently used, marks everything stale after a write, and prefetches a few at a time; rows hand the
// pane a seed it can draw at once; the open task is pinned until the URL catches up.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { MyTask } from "@alhc/core/api/my-tasks/model";
import type { ProjectTask, SubtaskItem } from "@alhc/core/api/tasks/model";
import type { FieldDef } from "@alhc/core/fields";
import { QueryObserver } from "@tanstack/query-core";
import type { TaskDetail } from "@alhc/core/api/task-pane/model";
import { openTaskOf, pinCaughtUp } from "@/lib/right-panel";
import { CACHE_LIMITS, createAlhcQueryClient, enforceCacheLimits } from "@alhc/core/query/client";
import { queryKeys } from "@alhc/core/query/keys";
import { readStamped } from "@alhc/core/query/stamped";
import { isPaneFresh, markPanesStale, storePanePayload } from "@alhc/core/query/task-pane";
import { createLimiter } from "@/lib/task-pane-cache";
import { seedFromMyTask, seedFromProjectTask, seedFromSubtask, seedFromTitle } from "@/lib/task-seed";

// Since Nov 4 notes (batch 28) the pane's copies are entries of the client data cache (TanStack Query),
// with the same rules.
const pane = (task: string, loadedAt: number) => ({ task: task as unknown as TaskDetail, context: null, loadedAt });
// A cache whose timers are let go when the test ends (garbage collection keeps Node alive otherwise).
function testClient(t: TestContext) {
  const client = createAlhcQueryClient();
  t.after(() => client.clear());
  return client;
}

test("the newest copy of a task wins, whichever arrives last", (t) => {
  const client = testClient(t);
  assert.equal(storePanePayload(client, "t1", pane("prefetched", 100)), true);
  assert.equal(storePanePayload(client, "t1", pane("older server render", 90)), false);
  assert.equal(readStamped(client, queryKeys.task("t1"))?.value, "prefetched");
  assert.equal(storePanePayload(client, "t1", pane("after a write", 200)), true);
  assert.equal(readStamped(client, queryKeys.task("t1"))?.value, "after a write");
});

test("least recently used entries go first; the open task stays", (t) => {
  const client = testClient(t);
  const cache = client.getQueryCache();
  for (let n = 0; n < CACHE_LIMITS.task + 5; n += 1) storePanePayload(client, `t${n}`, pane(`t${n}`, n));
  // The first one is open (observed), so it stays whatever its age.
  const open = cache.find({ queryKey: queryKeys.task("t0"), exact: true });
  const unsubscribe = new QueryObserver(client, { queryKey: queryKeys.task("t0"), enabled: false }).subscribe(() => {});
  assert.ok(open);
  enforceCacheLimits(cache);
  const left = cache.findAll({ queryKey: queryKeys.tasks() }).map((q) => q.queryKey[2]);
  assert.equal(left.length, CACHE_LIMITS.task);
  assert.ok(left.includes("t0"), "the open task is kept");
  assert.ok(!left.includes("t1") && !left.includes("t5"), "the oldest unopened ones went");
  assert.ok(left.includes(`t${CACHE_LIMITS.task + 4}`));
  unsubscribe();
});

test("a write marks everything stale; stale or old copies are refetched", async (t) => {
  const client = testClient(t);
  storePanePayload(client, "a", pane("a", 1));
  const now = Date.now();
  assert.equal(isPaneFresh(client, "a", 10_000, now), true);
  assert.equal(isPaneFresh(client, "a", 10_000, now + 20_000), false);
  await markPanesStale(client);
  assert.equal(readStamped(client, queryKeys.task("a"))?.value, "a", "a stale copy still shows");
  assert.equal(isPaneFresh(client, "a", 10_000, now), false);
  storePanePayload(client, "a", pane("fresh", 2));
  assert.equal(isPaneFresh(client, "a", 10_000, Date.now()), true);
});

test("prefetches run a few at a time, in order", async () => {
  const limit = createLimiter(2);
  let running = 0;
  let peak = 0;
  const order: number[] = [];
  const job = (n: number) => () =>
    new Promise<number>((resolve) => {
      running += 1;
      peak = Math.max(peak, running);
      setTimeout(() => {
        running -= 1;
        order.push(n);
        resolve(n);
      }, 5);
    });
  const results = await Promise.all([1, 2, 3, 4, 5].map((n) => limit(job(n))));
  assert.deepEqual(results, [1, 2, 3, 4, 5]);
  assert.equal(peak, 2);
  assert.equal(order.length, 5);
});

test("the open task: what was clicked wins until the URL says the same", () => {
  assert.equal(openTaskOf(undefined, "t1"), "t1", "cold link: the URL");
  assert.equal(openTaskOf("t2", "t1"), "t2", "clicked t2 while the URL still says t1");
  assert.equal(openTaskOf(null, "t1"), null, "closed, URL not caught up yet");
  assert.equal(pinCaughtUp("t2", "t1"), false);
  assert.equal(pinCaughtUp("t2", "t2"), true);
  assert.equal(pinCaughtUp(null, null), true);
  assert.equal(pinCaughtUp(undefined, null), false);
});

const card: ProjectTask = {
  id: "t1",
  title: "Logo refresh",
  completedAt: null,
  startOn: "2026-10-20",
  dueOn: "2026-10-24",
  assigneeId: "p1",
  homeProjectId: "proj",
  createdAt: "2026-10-01T00:00:00Z",
  sectionId: "s1",
  sortOrder: 1024,
  subtaskCount: 3,
  subtaskDoneCount: 1,
  projectCount: 1,
  fieldValues: { f1: "hi", f2: "Notes" },
  recurring: false,
  blockedBy: 0,
  kind: "task",
  approvalStatus: null,
  tagIds: ["tag1", "gone"],
  commentCount: 4,
  requestLabel: { text: "Task #3", wrap: false },
};

const priority: FieldDef = {
  id: "f1",
  projectId: "proj",
  name: "Priority",
  description: "",
  fieldType: "single_select",
  options: [{ id: "hi", name: "High", color: "red" }],
  sortOrder: 0,
  showInViews: true,
  boundToSections: false,
  inLibrary: false,
  notifyOnChange: false,
} as FieldDef;

test("a List row seeds the pane with what it shows", () => {
  const seed = seedFromProjectTask(card, {
    personName: (id) => (id === "p1" ? "Ana Diaz" : null),
    tag: (id) => (id === "tag1" ? { id, name: "Print", color: "blue" } : undefined),
    projectName: "Marketing",
    sectionName: (id) => (id === "s1" ? "In progress" : null),
    fields: [priority],
  });
  assert.equal(seed.title, "Logo refresh");
  assert.deepEqual(seed.requestLabel, { text: "Task #3", wrap: false });
  assert.deepEqual(seed.assignee, { id: "p1", name: "Ana Diaz" });
  assert.deepEqual(seed.tags, [{ id: "tag1", name: "Print", color: "blue" }]);
  assert.equal(seed.projectName, "Marketing");
  assert.equal(seed.sectionName, "In progress");
  assert.deepEqual(seed.fields, [{ id: "f1", name: "Priority", value: "High", color: "red" }]);
  assert.equal(seed.subtaskCount, 3);
  assert.equal(seed.commentCount, 4);
  assert.equal(seedFromProjectTask({ ...card, assigneeId: null }).assignee, null, "no assignee");
  assert.equal(seedFromProjectTask(card).assignee, undefined, "unknown name: the preview shows a placeholder");
});

test("My tasks, subtasks, and title-only links seed the pane too", () => {
  const mine: MyTask = {
    id: "m1",
    title: "Task #4 Brief",
    completedAt: null,
    dueOn: null,
    projectId: null,
    projectName: null,
    kind: "task",
    parentTitle: null,
    canEdit: true,
    requestLabel: { text: "Task #4", wrap: false },
  };
  const seed = seedFromMyTask(mine, { id: "me", name: "Me" });
  assert.equal(seed.projectName, "Private");
  assert.equal(seed.requestLabel, null, "the title already carries the number");
  assert.deepEqual(seed.assignee, { id: "me", name: "Me" });
  const sub: SubtaskItem = {
    id: "s1",
    parentId: "t1",
    title: "Draft",
    completedAt: "2026-10-02T00:00:00Z",
    assigneeId: null,
    startOn: null,
    dueOn: null,
    kind: "task",
    sortOrder: 1,
    subtaskCount: 0,
    subtaskDoneCount: 0,
  };
  const subSeed = seedFromSubtask(sub, { title: "Logo refresh", projectName: "Marketing" });
  assert.equal(subSeed.parentTitle, "Logo refresh");
  assert.equal(subSeed.completed, true);
  assert.equal(subSeed.projectName, "Marketing");
  assert.deepEqual(seedFromTitle("x", "Name", { completed: true }), { id: "x", title: "Name", completed: true });
});
