// Nov 4 notes, batch 28 (M4): the client data cache. Bounded per group (only entries nobody shows go),
// newest copy wins, the pane's fetches go through a transport a desktop app can configure, optimistic
// edits reach every screen and roll back with their write, project overlays and My tasks rows live in the
// cache, and whole screens are revalidated when the router drew a kept copy.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test, type TestContext } from "node:test";
import { overlayWithEdits, type TaskChange } from "@/components/project/use-project-tasks";
import type { MyTask, ProjectTask, TaskDetail } from "@/lib/data";
import { applyMyTaskPatches } from "@/lib/live-patch";
import { beginLocalMutation, endLocalMutation, failMutation, mutationEndedAt, mutationFailed, tokenTaskDropped } from "@/lib/optimistic-session";
import { CACHE_LIMITS, createAlhcQueryClient, enforceCacheLimits, overflowingEntries } from "@/lib/query/client";
import { groupOf, queryKeys } from "@/lib/query/keys";
import { newestOf, patchStamped, readStamped, writeNewest } from "@/lib/query/stamped";
import {
  addTaskEdits,
  applyEditsToDetail,
  EDIT_GRACE_MS,
  editsAsMyTaskPatches,
  isTaskEdit,
  liveEdits,
  pruneTaskEdits,
  readEdits,
  type EditStatus,
  type TaggedEdit,
} from "@/lib/query/task-edits";
import { taskPaneQuery } from "@/lib/query/task-pane";
import { configureTransport, HttpError, SignedOutError } from "@/lib/query/transport";
import {
  arrivalNeedsRevalidation,
  emptyFreshness,
  FRESH_PREFETCH_MS,
  notePrefetch,
  noteShown,
  routeKey,
  routeKeyOfHref,
} from "@/lib/route-freshness";

function testClient(t: TestContext) {
  const client = createAlhcQueryClient();
  t.after(() => client.clear());
  return client;
}

// ---------------------------------------------------------------------------------------------------
// Bounds

test("each group keeps its limit; entries on screen and the newest stay", () => {
  const entries = [
    ...Array.from({ length: 5 }, (_, n) => ({ hash: `t${n}`, group: "task", active: n === 0, usedAt: n })),
    { hash: "p1", group: "project", active: false, usedAt: 0 },
  ];
  const drop = overflowingEntries(entries, { task: 3, project: 5, total: 100 });
  assert.deepEqual(drop.sort(), ["t1", "t2"], "the two oldest not on screen");
  // The total cap takes the least recently used of any group, never one on screen.
  const total = overflowingEntries(entries, { task: 10, project: 10, total: 3 });
  assert.equal(total.length, 3);
  assert.ok(!total.includes("t0"));
  assert.deepEqual(overflowingEntries(entries, CACHE_LIMITS), []);
});

test("the cache enforces its limits by itself as entries are added", async (t) => {
  const client = testClient(t);
  for (let n = 0; n < CACHE_LIMITS.project + 10; n += 1) client.setQueryData(queryKeys.projectChanges(`p${n}`), []);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(client.getQueryCache().findAll({ queryKey: queryKeys.allProjectChanges() }).length, CACHE_LIMITS.project);
  enforceCacheLimits(client.getQueryCache());
  assert.equal(groupOf(queryKeys.task("x")), "task");
  assert.equal(groupOf(["something"]), "other");
});

// ---------------------------------------------------------------------------------------------------
// Newest copy wins (hydration)

test("a screen's server copy seeds the cache only when it's newer; live patches count as read then", (t) => {
  const client = testClient(t);
  const key = queryKeys.myTasks();
  assert.equal(writeNewest(client, key, "home render", 200), true);
  assert.equal(writeNewest(client, key, "older My tasks render (the router's copy)", 100), false);
  assert.equal(readStamped(client, key)?.value, "home render");
  assert.equal(newestOf(readStamped(client, key), { value: "older", loadedAt: 150 }).value, "home render");
  assert.equal(newestOf(readStamped(client, key), { value: "newer", loadedAt: 250 }).value, "newer");
  assert.equal(patchStamped<string>(client, key, (v) => `${v} + live`, 300), true);
  assert.equal(writeNewest(client, key, "render that read before the message", 280), false);
  assert.equal(readStamped(client, key)?.value, "home render + live");
});

// ---------------------------------------------------------------------------------------------------
// The pane's fetcher and transport

test("the pane fetch goes through the transport, keeps the newer copy, and reads 404 as gone", async (t) => {
  const client = testClient(t);
  const asked: string[] = [];
  let answer: { status: number; body?: unknown; redirected?: string } = { status: 200 };
  configureTransport({
    baseUrl: "https://app.example",
    headers: () => ({ Authorization: "Bearer desktop" }),
    fetch: (async (url: string, init: RequestInit) => {
      asked.push(`${url} ${(init.headers as Record<string, string>).Authorization}`);
      const body = JSON.stringify(answer.body ?? {});
      const response = new Response(body, { status: answer.status, headers: { "Content-Type": "application/json" } });
      if (answer.redirected) {
        Object.defineProperty(response, "redirected", { value: true });
        Object.defineProperty(response, "url", { value: answer.redirected });
      }
      return response;
    }) as unknown as typeof fetch,
  });
  t.after(() => configureTransport({ baseUrl: "", headers: () => ({}), fetch: (...args) => globalThis.fetch(...args) }));

  const detail = { id: "t1", title: "From the route" } as unknown as TaskDetail;
  answer = { status: 200, body: { task: detail, context: { memberId: "m", projects: [], profiles: [], tags: [] }, loadedAt: 100 } };
  const first = await client.fetchQuery({ ...taskPaneQuery(client, "t1"), staleTime: 0 });
  assert.equal(first.value?.title, "From the route");
  assert.match(asked[0], /^https:\/\/app\.example\/api\/task-pane\/t1\?context=1 Bearer desktop$/);
  assert.equal(readStamped(client, queryKeys.taskContext())?.loadedAt, 100);

  // A live patch newer than the next answer stays.
  patchStamped<TaskDetail | null>(client, queryKeys.task("t1"), (d) => ({ ...d!, title: "Renamed live" }), 500);
  answer = { status: 200, body: { task: detail, context: null, loadedAt: 400 } };
  const second = await client.fetchQuery({ ...taskPaneQuery(client, "t1"), staleTime: 0 });
  assert.equal(second.value?.title, "Renamed live");
  assert.ok(!asked[1].includes("context=1"), "the context is fresh: not asked again");

  answer = { status: 404 };
  const gone = await client.fetchQuery({ ...taskPaneQuery(client, "t2"), staleTime: 0 });
  assert.equal(gone.value, null);

  answer = { status: 500 };
  await assert.rejects(client.fetchQuery({ ...taskPaneQuery(client, "t3"), staleTime: 0 }), HttpError);
  answer = { status: 200, redirected: "https://app.example/login?next=x" };
  await assert.rejects(client.fetchQuery({ ...taskPaneQuery(client, "t4"), staleTime: 0 }), SignedOutError);
});

// ---------------------------------------------------------------------------------------------------
// Optimistic edits across screens, with rollback

const status = (over: Partial<EditStatus> = {}): EditStatus => ({
  failed: () => false,
  dropped: () => false,
  endedAt: () => undefined,
  ...over,
});

test("an edit shows everywhere until its write fails (rollback) or a moment after it ends", (t) => {
  const client = testClient(t);
  addTaskEdits(client, 7, [{ type: "title", taskId: "a", title: "New name" }], 1_000);
  addTaskEdits(client, 8, [{ type: "complete", taskId: "b", completed: true }], 1_000);
  const items = readEdits(client);
  assert.equal(liveEdits(items, status()).length, 2);
  // Write 7 fails: its edit is gone at once (the screens draw the server's copy again).
  assert.deepEqual(
    liveEdits(items, status({ failed: (token) => token === 7 })).map((e) => e.edit.taskId),
    ["b"],
  );
  // A bulk write that skipped task b drops only b.
  assert.deepEqual(
    liveEdits(items, status({ dropped: (token, id) => token === 8 && id === "b" })).map((e) => e.edit.taskId),
    ["a"],
  );
  // Write 8 ended: its edit lasts EDIT_GRACE_MS more, then the prune timer removes it.
  const ended = status({ endedAt: (token) => (token === 8 ? 2_000 : undefined) });
  assert.equal(pruneTaskEdits(client, ended, 2_000 + EDIT_GRACE_MS - 1), 2_000 + EDIT_GRACE_MS);
  assert.equal(readEdits(client).length, 2);
  pruneTaskEdits(client, ended, 2_000 + EDIT_GRACE_MS + 1);
  assert.deepEqual(readEdits(client).map((e) => e.edit.taskId), ["a"]);
});

test("rollback through the real write session: a failed write's edit disappears", (t) => {
  const client = testClient(t);
  const token = beginLocalMutation();
  addTaskEdits(client, token, [{ type: "assign", taskId: "x", assigneeId: "p2" }]);
  const real: EditStatus = { failed: mutationFailed, dropped: tokenTaskDropped, endedAt: mutationEndedAt };
  assert.equal(liveEdits(readEdits(client), real).length, 1);
  failMutation(token);
  endLocalMutation(token);
  assert.equal(liveEdits(readEdits(client), real).length, 0);
});

test("the latest edit per task and kind wins", () => {
  const items: TaggedEdit[] = [
    { token: 1, edit: { type: "title", taskId: "a", title: "One" }, at: 1 },
    { token: 2, edit: { type: "title", taskId: "a", title: "Two" }, at: 2 },
  ];
  assert.deepEqual(liveEdits(items, status()).map((e) => (e.edit.type === "title" ? e.edit.title : "")), ["Two"]);
  assert.equal(isTaskEdit({ type: "move" }), false);
  assert.equal(isTaskEdit({ type: "dates" }), true);
});

test("the pane's detail takes edits made on a List row; dates only on a date-only task", () => {
  const detail = {
    id: "a",
    title: "Old",
    completedAt: null,
    assigneeId: null,
    dueOn: "2026-11-01",
    startOn: null,
    dueAt: null,
    startAt: null,
  } as unknown as TaskDetail;
  const edits: TaggedEdit[] = [
    { token: 1, edit: { type: "title", taskId: "a", title: "New" }, at: Date.parse("2026-11-04T10:00:00Z") },
    { token: 1, edit: { type: "complete", taskId: "a", completed: true }, at: Date.parse("2026-11-04T10:00:00Z") },
    { token: 1, edit: { type: "dates", taskId: "a", startOn: "2026-11-02", dueOn: "2026-11-05" }, at: 1 },
    { token: 1, edit: { type: "title", taskId: "other", title: "Not this one" }, at: 1 },
  ];
  const next = applyEditsToDetail(detail, edits);
  assert.equal(next.title, "New");
  assert.equal(next.completedAt, "2026-11-04T10:00:00.000Z");
  assert.equal(next.dueOn, "2026-11-05");
  assert.equal(applyEditsToDetail(detail, []), detail, "nothing to apply: the same object");
  const timed = { ...detail, dueAt: "2026-11-01T15:00:00Z" } as TaskDetail;
  assert.equal(applyEditsToDetail(timed, edits).dueOn, "2026-11-01", "a time moves with its date: left to the refetch");
});

test("My tasks takes the same edits: renamed, completed, handed to someone else", () => {
  const mine = (id: string): MyTask => ({ id, title: id, completedAt: null, dueOn: null, startOn: null }) as unknown as MyTask;
  const edits: TaggedEdit[] = [
    { token: 1, edit: { type: "title", taskId: "a", title: "Renamed" }, at: 1 },
    { token: 1, edit: { type: "complete", taskId: "b", completed: true }, at: 1 },
    { token: 1, edit: { type: "assign", taskId: "c", assigneeId: "someone-else" }, at: 1 },
    { token: 1, edit: { type: "assign", taskId: "a", assigneeId: "me" }, at: 1 },
  ];
  const patches = editsAsMyTaskPatches(edits, "me");
  const { open, completed } = applyMyTaskPatches([mine("a"), mine("b"), mine("c")], [], patches);
  assert.deepEqual(open.map((t) => t.title), ["Renamed"]);
  assert.deepEqual(completed.map((t) => t.id), ["b"]);
});

test("a project view applies its own changes and edits from other screens, latest first", () => {
  const row = { id: "a", title: "Old", completedAt: null, sectionId: "s", sortOrder: 1, tagIds: [], fieldValues: {} } as unknown as ProjectTask;
  const own: { change: TaskChange; at: number }[] = [{ change: { type: "title", taskId: "a", title: "From the List" }, at: 1 }];
  const fromPane: TaggedEdit[] = [{ token: 2, edit: { type: "title", taskId: "a", title: "From the pane" }, at: 2 }];
  assert.equal(overlayWithEdits([row], own, fromPane)[0].title, "From the pane");
  assert.equal(overlayWithEdits([row], [{ ...own[0], at: 3 }], fromPane)[0].title, "From the List");
  // The server's copy already shows it: nothing is overlaid.
  assert.equal(overlayWithEdits([{ ...row, title: "From the pane" }], [], fromPane)[0].title, "From the pane");
});

// ---------------------------------------------------------------------------------------------------
// Whole screens: revalidate what the router drew from its cache

test("route keys ignore ?task= and parameter order", () => {
  assert.equal(routeKey("/projects/p", "?task=t1"), "/projects/p");
  assert.equal(routeKey("/projects/p/views/v", "f=x&d=2026-11-04&task=t"), "/projects/p/views/v?d=2026-11-04&f=x");
  assert.equal(routeKeyOfHref("/inbox?tab=archive"), "/inbox?tab=archive");
});

test("going back within the router's 30 seconds revalidates; later (a fresh render) doesn't", () => {
  const state = emptyFreshness();
  noteShown(state, "/my-tasks", 0);
  noteShown(state, "/my-tasks", 20_000); // left it at 20 s
  assert.equal(arrivalNeedsRevalidation(state, "/my-tasks", 45_000), true);
  assert.equal(arrivalNeedsRevalidation(state, "/my-tasks", 60_000), false);
  assert.equal(arrivalNeedsRevalidation(state, "/never-seen", 1_000), false);
});

test("a hover prefetch is fresh for a moment, then revalidated when used", () => {
  const state = emptyFreshness();
  assert.equal(notePrefetch(state, "/projects/p", 0), true);
  assert.equal(notePrefetch(state, "/projects/p", FRESH_PREFETCH_MS - 1), false, "not asked twice");
  assert.equal(arrivalNeedsRevalidation(state, "/projects/p", 2_000), false);
  assert.equal(arrivalNeedsRevalidation(state, "/projects/p", FRESH_PREFETCH_MS + 1_000), true);
  noteShown(state, "/projects/q", 100);
  assert.equal(notePrefetch(state, "/projects/q", 200), false, "on screen now: the router has it");
});

test("the pieces are wired: staleTimes match, the shell revalidates, project links prefetch", () => {
  const config = fs.readFileSync("next.config.ts", "utf8");
  assert.ok(config.includes("staleTimes: { dynamic: 30, static: 60 }"));
  const shell = fs.readFileSync("src/components/shell/app-shell.tsx", "utf8");
  assert.ok(shell.includes("<RouteFreshness />"));
  assert.ok(fs.readFileSync("src/components/shell/sidebar-projects.tsx", "utf8").includes("<PrefetchLink"));
  assert.ok(fs.readFileSync("src/app/(app)/layout.tsx", "utf8").includes("<QueryProvider memberId={member.id}>"));
  // No Next.js in the query layer (a desktop app reuses it).
  for (const file of fs.readdirSync("src/lib/query")) {
    assert.ok(!/from "next\//.test(fs.readFileSync(`src/lib/query/${file}`, "utf8")), file);
  }
});
