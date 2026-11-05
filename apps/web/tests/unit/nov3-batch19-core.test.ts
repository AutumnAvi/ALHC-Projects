// Nov 3 notes, batch 19: the retry for passing database errors, the error page's one automatic try, the
// role-change prompt's wording, and the design doc for form paths (note 143). Pure rules.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { AUTO_RETRY_WINDOW_MS, canAutoRetry, markAutoRetried } from "@/lib/page-error";
import { roleSlotsLabel } from "@alhc/core/project-roles";
import { retryingFetch, shouldRetry } from "@alhc/core/supabase/retry-fetch";

test("142: only passing errors are tried again", () => {
  assert.equal(shouldRetry(500, "57014", false), true, "a cancelled statement wrote nothing: retry even a write");
  assert.equal(shouldRetry(504, "PGRST003", false), true, "no free connection: nothing ran");
  assert.equal(shouldRetry(503, null, true), true, "a gateway hiccup on a read");
  assert.equal(shouldRetry(503, null, false), false, "never a write that may have reached the database");
  assert.equal(shouldRetry(500, "P0001", true), false, "a real error isn't retried");
  assert.equal(shouldRetry(400, null, true), false);
});

test("142: retryingFetch tries once more, then gives up", async () => {
  const answers = [
    new Response(JSON.stringify({ code: "57014", message: "canceling statement due to statement timeout" }), { status: 500 }),
    new Response("[]", { status: 200 }),
  ];
  let calls = 0;
  const fake = (async () => answers[calls++]) as unknown as typeof fetch;
  const warn = console.warn;
  console.warn = () => {};
  try {
    const response = await retryingFetch(fake)("https://example.test/rest/v1/rpc/portfolio_report", { method: "POST", body: "{}" });
    assert.equal(response.status, 200);
    assert.equal(calls, 2);

    calls = 0;
    const always = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ code: "57014" }), { status: 500 });
    }) as unknown as typeof fetch;
    const failed = await retryingFetch(always)("https://example.test/rest/v1/tasks", { method: "GET" });
    assert.equal(failed.status, 500, "the second answer is returned as it is");
    assert.equal(calls, 2, "only one more try");

    calls = 0;
    const real = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ code: "42501" }), { status: 403 });
    }) as unknown as typeof fetch;
    await retryingFetch(real)("https://example.test/rest/v1/tasks");
    assert.equal(calls, 1, "a refusal isn't retried");

    calls = 0;
    const offline = (async () => {
      calls += 1;
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await assert.rejects(retryingFetch(offline)("https://example.test/rest/v1/rpc/x", { method: "POST", body: "{}" }));
    assert.equal(calls, 1, "a write with no answer is never sent twice");
  } finally {
    console.warn = warn;
  }
});

test("142: the error page tries once by itself, never in a loop", () => {
  const memory = new Map<string, string>();
  const store = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v) };
  assert.equal(canAutoRetry("123", store, 1000), true);
  markAutoRetried("123", store, 1000);
  assert.equal(canAutoRetry("123", store, 2000), false, "not again for the same error");
  assert.equal(canAutoRetry("456", store, 2000), true, "another error gets its own try");
  assert.equal(canAutoRetry("123", store, 1000 + AUTO_RETRY_WINDOW_MS), true, "a minute later it may try again");
  assert.equal(canAutoRetry("123", null, 0), false, "no storage: only the button");
});

test("146: a task's links to a role read in slot order", () => {
  assert.equal(roleSlotsLabel(["follower", "assignee"]), "Assignee · Follower");
  assert.equal(roleSlotsLabel(["approver"]), "Approver");
  assert.equal(roleSlotsLabel([]), "");
});

test("143: the form paths design doc exists and says it isn't built", () => {
  const doc = fs.readFileSync("../../docs/design/form-branching.md", "utf8");
  assert.match(doc, /design only/i);
  assert.match(doc, /Open questions for Avi/);
});
