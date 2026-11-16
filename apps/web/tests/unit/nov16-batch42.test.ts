// Nov 16 batch 42: tick-then-Home (item 1), plain dates in automation text (item 2), and the Inbox's
// "latest 100" note (item 4). Item 3 (the content policy) is in nov12-security41-headers.test.ts.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { HOME_WRITE_KINDS, homeShowsWrite } from "@alhc/core/patched-writes";
import { renderPlaceholders, samplePlaceholderValues } from "@alhc/core/rule-placeholders";
import { liveSummaryCounts, summaryLine } from "@alhc/core/checklist";
import {
  applyWarmPlan,
  arrivalNeedsRevalidation,
  bumpAllowedAt,
  emptyFreshness,
  MIN_BUMP_GAP_MS,
  noteWriteWithoutRefresh,
  warmOnIntent,
  HOME_KEY,
  homeNeedsRenderAfterSave,
  homeWarmPlan,
  MAX_RECENT_REWARMED,
  mayHoldCopy,
  noteCopy,
  noteShown,
  ROUTER_CACHE_SECONDS,
  HOVER_PREFETCH_SECONDS,
} from "@/lib/route-freshness";
import { onHomeWrite, patchedAction, resetPatchedWritesForTests, type HomeWriteEvent } from "@/lib/patched-writes";
import { editsKeptLongerFor, keepEditsLonger } from "@/lib/optimistic-session";
import { FULL_PREFETCH, HOME_WARM_BUMP_DELAY_MS, HOME_WARM_DELAY_MS } from "@/components/shell/route-freshness";
import { listInbox, listInboxPage } from "@alhc/core/api/inbox/queries";
import { INBOX_LIMIT, inboxLimitNote } from "@alhc/core/inbox";

const require = createRequire(import.meta.url);

// ----- Item 1 -------------------------------------------------------------------------------------------

test("item 1: Home shows completions, names, and assignees (comments and descriptions don't change it)", () => {
  assert.deepEqual([...HOME_WRITE_KINDS].sort(), ["assign", "complete", "title"]);
  assert.equal(homeShowsWrite("complete"), true);
  assert.equal(homeShowsWrite("comment"), false);
  assert.equal(homeShowsWrite("notes"), false);
});

test("item 1: the cause — after 40 s away the router no longer holds Home, so a plain prefetch is taken", () => {
  const state = emptyFreshness();
  const t0 = 1_000_000;
  // Home fetched on arrival, then left for a project 1 s later.
  noteCopy(state, HOME_KEY, t0, ROUTER_CACHE_SECONDS);
  noteShown(state, HOME_KEY, t0 + 1000);
  noteCopy(state, "/projects/p/views/v", t0 + 1000, ROUTER_CACHE_SECONDS);
  // The tick, 40 s later: Home's copy is gone (kept 30 s from its fetch). Before batch 42 nothing rendered
  // Home again, so the click waited for a full render behind a skeleton.
  const plan = homeWarmPlan(state, "/projects/p/views/v", t0 + 41_000);
  assert.deepEqual(plan, { bump: false, prefetch: [HOME_KEY] });
});

test("item 1: within the router's window an older Home copy is held: empty the cache, render Home and recent screens again", () => {
  const state = emptyFreshness();
  const t0 = 2_000_000;
  noteCopy(state, HOME_KEY, t0, ROUTER_CACHE_SECONDS);
  // Shown in turn (the screens the person was on), and one only rendered ahead on hover, never shown.
  for (const [key, at] of [["/my-tasks", t0 + 1000], ["/inbox", t0 + 2000], ["/reports", t0 + 3000]] as const) {
    noteShown(state, key, at);
    noteCopy(state, key, at, ROUTER_CACHE_SECONDS);
  }
  noteCopy(state, "/goals", t0 + 3500, HOVER_PREFETCH_SECONDS);
  noteShown(state, "/projects/p/views/v", t0 + 4000);
  const now = t0 + 5000;
  assert.equal(mayHoldCopy(state, HOME_KEY, now), true);
  const plan = homeWarmPlan(state, "/projects/p/views/v", now);
  assert.equal(plan.bump, true);
  assert.equal(plan.prefetch[0], HOME_KEY);
  // The newest screens the person was on, never the one on view (the refresh renders it), never one only
  // rendered ahead, at most two.
  assert.deepEqual(plan.prefetch.slice(1), ["/reports", "/inbox"]);
  assert.equal(plan.prefetch.length, 1 + MAX_RECENT_REWARMED);
  applyWarmPlan(state, plan, "/projects/p/views/v", now);
  // The emptied cache: only what was rendered just now is held.
  assert.equal(mayHoldCopy(state, "/my-tasks", now + 1), false);
  assert.equal(mayHoldCopy(state, HOME_KEY, now + 1), true);
  assert.equal(mayHoldCopy(state, "/projects/p/views/v", now + 1), true);
  // A second tick soon after: our own copy of Home predates it, so the cache is emptied again…
  assert.equal(homeWarmPlan(state, "/projects/p/views/v", now + 3000).bump, true);
  // …but rendering a screen again never keeps it "recent" (Opus r1 F1): 31 s after it was last shown, it
  // isn't rendered again, however many warm-ups ran.
  const later = homeWarmPlan(state, "/projects/p/views/v", t0 + 3000 + ROUTER_CACHE_SECONDS * 1000 + 1000);
  assert.deepEqual(later.prefetch, [HOME_KEY]);
  // A prefetched copy is kept 60 s.
  assert.equal(homeWarmPlan(state, "/projects/p/views/v", now + HOVER_PREFETCH_SECONDS * 1000 + 5000).bump, false);
});

test("item 1: the cache is emptied at most every 10 s; heading for Home never throws its copy away", () => {
  assert.equal(MIN_BUMP_GAP_MS, 10_000);
  // A warm-up that only prefetches runs soon; one that empties the cache waits for the person to settle, so
  // a quick click still has the held copy to draw (Codex r1 F1).
  assert.equal(HOME_WARM_DELAY_MS, 250);
  assert.ok(HOME_WARM_BUMP_DELAY_MS >= 2000);
  assert.equal(bumpAllowedAt(50_000), 60_000);
  assert.ok(bumpAllowedAt(-Infinity) < 0, "the first may run at once");
  // Pointer on the Home link (or a click) while a warm-up that would empty the cache waits: the click draws
  // the held copy, rendered again on arrival (Codex r1 F1).
  assert.equal(warmOnIntent({ bump: true, prefetch: [HOME_KEY, "/inbox"] }), null);
  assert.deepEqual(warmOnIntent({ bump: false, prefetch: [HOME_KEY] }), { bump: false, prefetch: [HOME_KEY] });
  // That copy is older than the save, so arriving renders it again.
  const state = emptyFreshness();
  noteCopy(state, HOME_KEY, 1000, ROUTER_CACHE_SECONDS);
  state.renderedAt.set(HOME_KEY, 1000);
  noteShown(state, HOME_KEY, 1500);
  noteWriteWithoutRefresh(state, 60_000);
  assert.equal(arrivalNeedsRevalidation(state, HOME_KEY, 61_000), true);
});

test("item 1: Home's summary line counts the Today card's live list (completions, reopens, reassignments)", () => {
  const today = "2026-11-16";
  const open = [
    { id: "a", dueOn: "2026-11-10" },
    { id: "b", dueOn: today },
    { id: "c", dueOn: today },
    { id: "t", dueOn: "2026-11-17" },
  ];
  const none = new Map<string, boolean>();
  assert.equal(summaryLine(liveSummaryCounts(open, ["w"], none, new Set(), today)), "2 due today · 1 overdue");
  // The card's live list after a tick no longer holds the task: the line follows it.
  assert.equal(summaryLine(liveSummaryCounts(open.filter((t) => t.id !== "b"), ["w"], none, new Set(), today)), "1 due today · 1 overdue");
  // A task reopened elsewhere comes back onto the live list, so the line counts it again (Codex r2 F4).
  assert.equal(summaryLine(liveSummaryCounts([...open, { id: "r", dueOn: today }], [], none, new Set(), today)), "3 due today · 1 overdue");
  // This week's tasks the card doesn't hold: by id, minus what was just completed or given away.
  assert.equal(summaryLine(liveSummaryCounts([], ["w", "x", "y"], new Map([["w", true]]), new Set(["x"]), today)), "1 due this week");
  assert.equal(liveSummaryCounts(open, ["t"], none, new Set(), today).week, 1, "tomorrow's task once, held or hidden");
  const page = readFileSync(new URL("../../src/app/(app)/page.tsx", import.meta.url), "utf8");
  assert.match(page, /<HomeSummary\s+open=\{todayCard\.shown\}/);
});

test("item 1: checklist Undo is a save Home shows and records the reopen (Grok r2 F5)", () => {
  const src = readFileSync(new URL("../../src/components/my-tasks/checklist.tsx", import.meta.url), "utf8");
  assert.match(src, /patchedAction\("complete", \(\) => undoTaskCompleted\(task\.id\), \{ refresh: true \}\)/);
  assert.match(src, /recordTaskEdits\(\[\{ type: "complete", taskId: task\.id, completed: false \}\]\)/);
});

test("item 1: on Home itself nothing is warmed; reaching Home during the save renders it again", () => {
  const state = emptyFreshness();
  assert.deepEqual(homeWarmPlan(state, HOME_KEY, 10), { bump: false, prefetch: [] });
  noteShown(state, HOME_KEY, 5000);
  assert.equal(homeNeedsRenderAfterSave(state, HOME_KEY, 4000, 5500), true, "arrived while the save ran");
  assert.equal(homeNeedsRenderAfterSave(state, HOME_KEY, 4000, 4500), false, "arrived after it ended (arrival handles it)");
  assert.equal(homeNeedsRenderAfterSave(state, HOME_KEY, 6000, 7000), false, "the save started after arriving");
  assert.equal(homeNeedsRenderAfterSave(state, "/my-tasks", 4000, 5500), false);
});

test("item 1: a warmed Home is still rendered again in the background on arrival when it's older than 10 s", () => {
  const state = emptyFreshness();
  const plan = homeWarmPlan(state, "/my-tasks", 100_000);
  applyWarmPlan(state, plan, "/my-tasks", 100_000);
  assert.equal(arrivalNeedsRevalidation(state, HOME_KEY, 103_000), false, "fresh: drawn as is");
  assert.equal(arrivalNeedsRevalidation(state, HOME_KEY, 125_000), true, "older: drawn, then rendered again");
});

test("item 1: saves Home shows keep their edits as long as saves without a refresh (Opus r2 F8)", () => {
  const token = 987_654;
  assert.equal(editsKeptLongerFor(token), false);
  keepEditsLonger(token);
  assert.equal(editsKeptLongerFor(token), true);
  const src = readFileSync(new URL("../../src/lib/patched-writes.ts", import.meta.url), "utf8");
  assert.match(src, /if \(home\) keepEditsLonger\(token\);/);
  const edits = readFileSync(new URL("../../src/components/task/task-edits.ts", import.meta.url), "utf8");
  assert.match(edits, /held: editsKeptLongerFor/);
});

test("item 1: patchedAction tells Home's warmer when a save Home shows starts and ends (refreshing or not)", async () => {
  resetPatchedWritesForTests();
  const events: HomeWriteEvent[] = [];
  const stop = onHomeWrite((e) => events.push(e));
  await patchedAction("complete", async () => ({}))();
  await patchedAction("title", async () => ({ error: "No" }))();
  await patchedAction("comment", async () => ({}))();
  await assert.rejects(patchedAction("assign", async () => {
    throw new Error("network");
  })());
  stop();
  assert.deepEqual(
    events.map((e) => (e.phase === "start" ? "start" : `end:${e.ok}:${e.screenOnly}`)),
    // No screen declared patches here, so every save refreshes (screenOnly false); comments aren't Home's.
    ["start", "end:true:false", "start", "end:false:false", "start", "end:false:false"],
  );
});

test("item 1: the full prefetch is the router's FULL kind (what <Link prefetch={true}> asks for)", () => {
  const types = require("next/dist/client/components/router-reducer/router-reducer-types.js") as { PrefetchKind: { FULL: string } };
  assert.equal(FULL_PREFETCH, types.PrefetchKind.FULL);
});

// ----- Item 2 -------------------------------------------------------------------------------------------

test("item 2: the builder's preview shows dates the way the automation writes them", () => {
  const values = samplePlaceholderValues({ fields: [{ name: "Launch", fieldType: "date" }] });
  assert.equal(renderPlaceholders("Due {{task.due_date}}, launch {{field.Launch}}", values), "Due Oct 24, 2026, launch Oct 24, 2026");
  assert.doesNotMatch(renderPlaceholders("{{task.start_date}} {{today}} {{field.launch}}", values), /\d{4}-\d{2}-\d{2}/);
  // No due date: empty, like the database.
  assert.equal(renderPlaceholders("[{{task.due_date}}]", { ...values, "task.due_date": null }), "[]");
});

// ----- Item 4 -------------------------------------------------------------------------------------------

// inbox_page's JSON rows (project message items: no task, so no number lookups).
function pageRow(n: number) {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    kind: "message",
    data: {},
    actor_id: null,
    read_at: null,
    archived_at: null,
    bookmarked_at: null,
    created_at: new Date(Date.UTC(2026, 10, 1, 0, 0, 1000 - n)).toISOString(),
    task_id: null,
    task_title: `Thread ${n}`,
    message: { id: `m-${n}`, thread_id: `m-${n}`, project_id: "p", project_name: "Project" },
  };
}

// A database stub: inbox_page_window(tab, n) returns the newest n of `total`; `windowed: false` = before
// 20261116010000_nov16_batch42_a.sql (the function isn't there; inbox_page returns 100 at most).
function stubContext(total: number, windowed = true) {
  const calls: string[] = [];
  const all = Array.from({ length: total }, (_, i) => pageRow(i + 1));
  const db = {
    rpc: async (name: string, args: { max_items?: number }) => {
      calls.push(name);
      if (name === "inbox_page_window") {
        if (!windowed) return { data: null, error: { code: "PGRST202", message: "missing" } };
        return { data: all.slice(0, args.max_items ?? 100), error: null };
      }
      if (name === "inbox_page") return { data: all.slice(0, 100), error: null };
      return { data: [], error: null };
    },
  };
  return { ctx: { db: db as never, memo: null }, calls };
}

test("item 4: no 'latest 100' note at 99 or exactly 100 notifications; shown only when there are more", async () => {
  for (const [total, more] of [[99, false], [100, false], [101, true], [150, true]] as const) {
    const { ctx, calls } = stubContext(total);
    const page = await listInboxPage(ctx, "activity");
    assert.equal(page.items.length, Math.min(total, INBOX_LIMIT), `${total}: shows ${INBOX_LIMIT} at most`);
    assert.equal(page.hasMore, more, `${total}: has more`);
    assert.equal(inboxLimitNote("activity", page.hasMore) !== null, more, `${total}: the note`);
    assert.deepEqual(calls.filter((c) => c.startsWith("inbox")), ["inbox_page_window"], "one read, one more than shown");
  }
  // Same items, same order as listInbox (the page of before, which had no team message rows here).
  const { ctx } = stubContext(150);
  const [page, plain] = [await listInboxPage(ctx, "activity"), await listInbox(stubContext(150).ctx, "activity")];
  assert.deepEqual(page.items.map((i) => i.id), plain.map((i) => i.id));
});

test("item 4: before the migration the Inbox answers as it did (a full page may have more)", async () => {
  const exact = await listInboxPage(stubContext(100, false).ctx, "activity");
  assert.equal(exact.items.length, 100);
  assert.equal(exact.hasMore, true);
  assert.equal((await listInboxPage(stubContext(40, false).ctx, "activity")).hasMore, false);
});

test("item 4: the Inbox page passes hasMore through and the view draws the note from it", () => {
  const page = readFileSync(new URL("../../src/app/(app)/inbox/page.tsx", import.meta.url), "utf8");
  assert.match(page, /listInboxPage\(tab\)/);
  assert.match(page, /hasMore=\{page\.hasMore\}/);
  const view = readFileSync(new URL("../../src/components/inbox/inbox-view.tsx", import.meta.url), "utf8");
  assert.match(view, /inboxLimitNote\(tab, hasMore\)/);
  assert.doesNotMatch(view, /items\.length >= INBOX_LIMIT/);
});
