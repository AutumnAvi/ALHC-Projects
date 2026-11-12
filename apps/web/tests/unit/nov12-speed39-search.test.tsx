// Nov 12 speed batch 39 (item 5): the search palette matches people and projects in the browser and asks
// the server only for tasks, through GET /api/quick-search (not a Server Action: actions queue behind saves).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  fetchQuickSearchTasks,
  loadQuickSearchPeople,
  quickSearchTasksUrl,
  resetQuickSearchPeople,
} from "@/components/shell/quick-search-directory";

const palette = readFileSync(new URL("../../src/components/shell/search-palette.tsx", import.meta.url), "utf8");
const route = readFileSync(new URL("../../src/app/api/quick-search/route.ts", import.meta.url), "utf8");
const layout = readFileSync(new URL("../../src/app/(app)/layout.tsx", import.meta.url), "utf8");

test("the palette no longer calls the quickSearch Server Action; projects and people are matched here", () => {
  assert.doesNotMatch(palette, /\bquickSearch\(/);
  assert.doesNotMatch(palette, /import \{[^}]*\bquickSearch\b[^}]*\} from "@\/lib\/actions\/shell"/);
  assert.match(palette, /matchQuickProjects\(readableProjects/);
  assert.match(palette, /matchQuickPeople\(people/);
  assert.match(palette, /fetchQuickSearchTasks\(trimmed, kind, controller\.signal\)/);
  assert.match(palette, /controller\.abort\(\)/);
  assert.match(palette, /}, 150\);/, "the debounce is kept");
  // The projects it matches are the shell's readable projects (never a wider list).
  assert.match(layout, /shell\.readableProjects\.map/);
  // The route reads with the person's own client and answers tasks only (with their numbers).
  assert.match(route, /routeContext\(\)/);
  assert.match(route, /quickSearchTasks\(ctx/);
  assert.doesNotMatch(route, /adminContext|anonContext/);
});

test("tasks go to the route, with the chip, and a newer query cancels the older one", async () => {
  assert.equal(quickSearchTasksUrl("brand flyer", null), "/api/quick-search?q=brand+flyer");
  assert.equal(quickSearchTasksUrl("x", "tasks"), "/api/quick-search?q=x&kind=tasks");
  const seen: Array<{ url: string; signal?: AbortSignal | null }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url, signal: init?.signal });
    if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return new Response(JSON.stringify({ tasks: [{ id: "t1" }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const controller = new AbortController();
    const tasks = await fetchQuickSearchTasks("brand", null, controller.signal);
    assert.equal(tasks.length, 1);
    assert.equal(seen[0].url, "/api/quick-search?q=brand");
    assert.equal(seen[0].signal, controller.signal);
    controller.abort();
    await assert.rejects(fetchQuickSearchTasks("brand", null, controller.signal));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the people list is loaded once per palette session, not per keystroke", async () => {
  resetQuickSearchPeople();
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    calls += 1;
    assert.equal(url, "/api/quick-search?people=1");
    return new Response(JSON.stringify({ people: [{ id: "u1", name: "Dana", email: "d@x.com" }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const first = await loadQuickSearchPeople(1_000);
    await loadQuickSearchPeople(2_000);
    await loadQuickSearchPeople(3_000);
    assert.equal(calls, 1);
    assert.equal(first[0].id, "u1");
    await loadQuickSearchPeople(1_000 + 5 * 60_000 + 1);
    assert.equal(calls, 2, "reloaded after a few minutes");
  } finally {
    globalThis.fetch = realFetch;
    resetQuickSearchPeople();
  }
});
