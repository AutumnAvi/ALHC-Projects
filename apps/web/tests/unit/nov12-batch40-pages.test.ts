// Nov 12 notes, batch 40: "Show more" adds one group's next page (item 4), and a cold task link reads the
// task while the identity check runs (item 5) without changing any answer.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ProjectTask, ProjectTaskGroupPage } from "@alhc/core/api/tasks/model";
import { mergePagedGroups } from "@/components/project/paged-groups";

const task = (id: string) => ({ id, title: id }) as unknown as ProjectTask;
const page = (key: string, ids: string[], total: number): ProjectTaskGroupPage => ({
  key,
  total,
  nextId: null,
  nextSortOrder: null,
  tasks: ids.map(task),
});

test("item 4: the next page is added under the rows already there, never twice", () => {
  const tasks = ["a1", "a2", "b1"].map(task);
  const taskPage = [page("a", ["a1", "a2"], 5), page("b", ["b1"], 1)];
  const none = mergePagedGroups(tasks, taskPage, new Map());
  assert.equal(none.tasks, tasks);
  assert.equal(none.taskPage, taskPage);
  // a2 moved into the next page's window too (a change between the two reads): drawn once.
  const appended = new Map([["a", { total: 6, nextId: "a6", nextSortOrder: 6, tasks: ["a2", "a3", "a4", "a5"].map(task) }]]);
  const merged = mergePagedGroups(tasks, taskPage, appended);
  assert.deepEqual(merged.taskPage?.[0].tasks.map((t) => t.id), ["a1", "a2", "a3", "a4", "a5"]);
  assert.equal(merged.taskPage?.[0].total, 6);
  assert.equal(merged.taskPage?.[0].nextId, "a6");
  // The other group and the rows already drawn are the same objects (nothing remounts).
  assert.equal(merged.taskPage?.[1], taskPage[1]);
  assert.equal(merged.tasks[0], tasks[0]);
  assert.deepEqual(merged.tasks.map((t) => t.id), ["a1", "a2", "b1", "a3", "a4", "a5"]);
  // A later server render that already holds those rows (its ?n= covers them): nothing is added.
  const fuller = [page("a", ["a1", "a2", "a3", "a4", "a5"], 6), page("b", ["b1"], 1)];
  const again = mergePagedGroups(fuller.flatMap((p) => p.tasks), fuller, appended);
  assert.deepEqual(again.taskPage?.[0].tasks.map((t) => t.id), ["a1", "a2", "a3", "a4", "a5"]);
});

const src = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");

test("item 4: Show more reads one group through its own GET route, with the person's own client", () => {
  const route = src("app/api/projects/[projectId]/task-page/route.ts");
  assert.match(route, /routeContext\(\)/);
  assert.match(route, /if \(!user\) return NextResponse\.json\(\{ error: "Sign in" \}, \{ status: 401 \}\)/);
  assert.match(route, /if \(!allowlisted\) return NextResponse\.json\(\{ error: "Forbidden" \}, \{ status: 403 \}\)/);
  assert.doesNotMatch(route, /adminContext|service/i);
  const hook = src("components/project/paged-groups.ts");
  assert.match(hook, /window\.history\.replaceState/);
  assert.doesNotMatch(hook, /router\.(replace|push|refresh)/);
});

test("item 5: the task route answers exactly as before — the check decides before anything is sent", () => {
  const route = src("app/api/task-pane/[taskId]/route.ts");
  const check = route.indexOf("await getViewer(ctx)");
  const used = route.indexOf("const loaded = await load;");
  assert.ok(check > 0 && used > check, "the read's result is used only after the check");
  assert.ok(route.indexOf('NextResponse.redirect(new URL("/login"') > check);
  assert.ok(route.indexOf('{ error: "Forbidden" }, { status: 403 }') > check);
  assert.ok(route.indexOf('{ error: "Not found" }, { status: 404 }') > check);
  assert.match(route, /load\?\.catch\(\(\) => undefined\)/);
});
