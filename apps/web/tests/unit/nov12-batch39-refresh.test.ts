// Nov 12 notes, batch 39 (item 1): screen-only saves. Next.js 16's refresh() (and router.refresh) also drops
// the router's copy of every recently visited page, so a save either refreshes (full) or doesn't (screen-only:
// the screen shows the change itself). These pin which actions are screen-only and what each mode does.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { SCREEN_ONLY, afterWritePlan } from "@/lib/server/after-write";
import { heldValue, sameIdSet } from "@alhc/core/held-edit";

test("item 1: the default after a write refreshes (and so empties the router's cache)", () => {
  assert.deepEqual(afterWritePlan(), { deliver: true, revalidate: [], refresh: true });
  assert.deepEqual(afterWritePlan({ revalidate: [["/", "layout"]] }), {
    deliver: true,
    revalidate: [["/", "layout"]],
    refresh: true,
  });
  assert.equal(afterWritePlan({ refresh: false }).refresh, false);
});

test("item 1: a screen-only write neither refreshes nor revalidates, but still delivers email", () => {
  assert.deepEqual(afterWritePlan(SCREEN_ONLY), { deliver: true, revalidate: [], refresh: false });
  // Even with paths named, screen-only never invalidates anything.
  assert.deepEqual(afterWritePlan({ ...SCREEN_ONLY, revalidate: [["/", "layout"]] }).revalidate, []);
});

const actionsDir = new URL("../../src/lib/actions/", import.meta.url);
const actionSources = readdirSync(actionsDir)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ file: f, source: readFileSync(new URL(f, actionsDir), "utf8") }));

function functionBody(source: string, name: string): string | null {
  const start = source.indexOf(`export async function ${name}(`);
  if (start === -1) return null;
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

test("item 1: exactly the pane-only actions are screen-only", () => {
  const screenOnly: string[] = [];
  for (const { source } of actionSources) {
    for (const match of source.matchAll(/export async function (\w+)\(/g)) {
      const body = functionBody(source, match[1]);
      if (body?.includes("SCREEN_ONLY")) screenOnly.push(match[1]);
    }
  }
  // Batch 40 (item 1) adds four that are screen-only only when the browser says so (`screenOnly`).
  assert.deepEqual(screenOnly.sort(), [
    "addComment",
    "deleteComment",
    "editComment",
    "setFollowing",
    "setTaskCompleted",
    "toggleReaction",
    "updateTask",
  ]);
});

test("item 1: writes other screens show keep the full refresh", () => {
  const full = ["renameSection", "decideApproval", "restoreTask", "deleteTask"];
  for (const name of full) {
    const body = actionSources.map(({ source }) => functionBody(source, name)).find(Boolean);
    assert.ok(body, `${name} exists`);
    assert.ok(!body.includes("SCREEN_ONLY") && !body.includes("refresh: false"), `${name} keeps the full refresh`);
  }
});

test("item 1: the open pane fetches its own fresh copy after every write (what screen-only relies on)", () => {
  const store = readFileSync(new URL("../../src/components/task/task-pane-store.ts", import.meta.url), "utf8");
  assert.match(store, /onRuleFeedbackRequest\(\(\) => refreshOpenTaskPanes\(\)\)/);
  const session = readFileSync(new URL("../../src/lib/optimistic-session.ts", import.meta.url), "utf8");
  assert.match(session, /requestRuleFeedback\(began\)/);
});

test("item 1: a saved change stays on screen until the screen's own copy changes", () => {
  assert.equal(heldValue("old", null), "old");
  // Saved, the pane's copy not refetched yet: the new text shows.
  assert.equal(heldValue("old", { value: "new", base: "old" }), "new");
  // The refetch brought the saved text (or anything newer): the server's copy wins.
  assert.equal(heldValue("new", { value: "new", base: "old" }), "new");
  assert.equal(heldValue("newer", { value: "new", base: "old" }), "newer");
  // Follower ids compare as sets.
  assert.deepEqual(heldValue(["b", "a"], { value: ["a", "b", "c"], base: ["a", "b"] }, sameIdSet), ["a", "b", "c"]);
  assert.deepEqual(heldValue(["a", "b", "c"], { value: ["a", "b", "c"], base: ["a", "b"] }, sameIdSet), ["a", "b", "c"]);
});
