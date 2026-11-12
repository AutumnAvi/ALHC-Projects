// Nov 11 batch 38: comment edits only for 15 minutes (189), the automation toasts' run links (190), and
// new forms taking verified-domain submitters only (192).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiContext, type Db } from "@alhc/core/api/core/context";
import { ApiError } from "@alhc/core/api/core/errors";
import { editComment } from "@alhc/core/api/comments/mutations";
import { createForm } from "@alhc/core/api/forms/mutations";
import {
  COMMENT_EDIT_EXPIRED,
  COMMENT_EDIT_WINDOW_MINUTES,
  commentEditMsLeft,
  commentEditWindowOpen,
} from "@alhc/core/comment-edit";
import {
  feedbackNotes,
  finishedRunsFromNotes,
  runHistoryHref,
  runHref,
  runLinkLabel,
  type FeedbackRun,
} from "@alhc/core/rule-feedback";

// ---- A stand-in Supabase client (as in nov5-note163.test.ts) --------------------------------------

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

const COMMENT = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const RULE = "33333333-3333-4333-8333-333333333333";
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const updates = (calls: Call[]) => calls.filter((c) => c.steps.some(([step]) => step === "update"));

// ---- 189 ------------------------------------------------------------------------------------------

test("189: the edit window is 15 minutes from posting", () => {
  assert.equal(COMMENT_EDIT_WINDOW_MINUTES, 15);
  const posted = "2026-11-11T10:00:00.000Z";
  const at = (iso: string) => Date.parse(iso);
  assert.equal(commentEditWindowOpen(posted, at("2026-11-11T10:00:00.000Z")), true);
  assert.equal(commentEditWindowOpen(posted, at("2026-11-11T10:14:59.000Z")), true);
  assert.equal(commentEditWindowOpen(posted, at("2026-11-11T10:15:00.000Z")), true, "exactly 15 minutes still edits");
  assert.equal(commentEditWindowOpen(posted, at("2026-11-11T10:15:01.000Z")), false);
  assert.equal(commentEditWindowOpen("not a date"), false);
  assert.equal(commentEditMsLeft(posted, at("2026-11-11T10:10:00.000Z")), 5 * 60_000);
  assert.equal(commentEditMsLeft(posted, at("2026-11-11T11:00:00.000Z")), 0);
  assert.equal(COMMENT_EDIT_EXPIRED, "Comments can only be edited for 15 minutes");
});

test("189: editComment saves a comment posted 5 minutes ago", async () => {
  const { db, calls } = fakeDb((call) => {
    if (call.steps.some(([s]) => s === "maybeSingle")) return { data: { id: COMMENT, created_at: minutesAgo(5) }, error: null };
    return { data: [{ id: COMMENT }], error: null };
  });
  await editComment(createApiContext(db), COMMENT, "Fixed typo");
  const [update] = updates(calls);
  assert.ok(update, "the body is updated");
  assert.deepEqual(update.steps.find(([s]) => s === "update")?.[1][0], { body: "Fixed typo" });
});

test("189: editComment refuses a comment posted 16 minutes ago with a plain message, writing nothing", async () => {
  const { db, calls } = fakeDb((call) => {
    if (call.steps.some(([s]) => s === "maybeSingle")) return { data: { id: COMMENT, created_at: minutesAgo(16) }, error: null };
    return { data: [{ id: COMMENT }], error: null };
  });
  await assert.rejects(editComment(createApiContext(db), COMMENT, "Too late"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, "invalid");
    assert.equal(error.message, COMMENT_EDIT_EXPIRED);
    return true;
  });
  assert.equal(updates(calls).length, 0, "no update is sent");
});

test("189: the database's refusal (its own clock) reads the same", async () => {
  const { db } = fakeDb((call) => {
    if (call.steps.some(([s]) => s === "maybeSingle")) return { data: { id: COMMENT, created_at: minutesAgo(14.99) }, error: null };
    return { data: null, error: { code: "23514", message: COMMENT_EDIT_EXPIRED } };
  });
  await assert.rejects(editComment(createApiContext(db), COMMENT, "Just too late"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.message, COMMENT_EDIT_EXPIRED);
    return true;
  });
});

// ---- 190 ------------------------------------------------------------------------------------------

function run(overrides: Partial<FeedbackRun>): FeedbackRun {
  return {
    id: "run-1",
    ruleId: RULE,
    ruleName: "Triage",
    projectId: PROJECT,
    taskId: "task-1",
    taskTitle: "Flyer",
    status: "succeeded",
    reason: null,
    createdAt: "2026-11-11T10:00:00.000Z",
    ...overrides,
  };
}

test("190: run and history links", () => {
  assert.equal(runHistoryHref(PROJECT, RULE), `/projects/${PROJECT}/rules?view=history&rule=${RULE}`);
  assert.equal(runHref(PROJECT, RULE, "run-9"), `/projects/${PROJECT}/rules?view=history&rule=${RULE}&run=run-9`);
  assert.equal(runLinkLabel(1), "View this run");
  assert.equal(runLinkLabel(3), "View latest run");
});

test("190: a failed run's warning carries its run id", () => {
  const notes = feedbackNotes([run({ id: "run-f", status: "failed", reason: "No recipient" })]);
  assert.equal(notes.length, 1);
  const [note] = notes;
  assert.equal(note.kind, "stopped");
  assert.equal(note.kind === "stopped" && note.runId, "run-f");
  assert.equal(finishedRunsFromNotes(notes)[0].runId, "run-f", "the running list links the same run");
});

test("190: a loop stop carries its run id", () => {
  const [note] = feedbackNotes([run({ id: "run-l", status: "skipped", reason: "loop" })]);
  assert.equal(note.kind === "stopped" && note.runId, "run-l");
});

test("190: one partial run links that run", () => {
  const [note] = feedbackNotes([run({ id: "run-p", partial: { missed: 1, total: 3, reason: "No one to email" } })]);
  assert.equal(note.kind, "ran");
  if (note.kind !== "ran") return;
  assert.equal(note.runId, "run-p");
  assert.equal(note.runCount, 1);
});

test("190: several runs of one automation link the latest that partly ran", () => {
  const [note] = feedbackNotes([
    run({ id: "a", taskId: "t1", createdAt: "2026-11-11T10:00:00.000Z", partial: { missed: 1, total: 2, reason: null } }),
    run({ id: "b", taskId: "t2", createdAt: "2026-11-11T10:00:01.000Z", partial: { missed: 1, total: 2, reason: null } }),
    run({ id: "c", taskId: "t3", createdAt: "2026-11-11T10:00:02.000Z" }),
  ]);
  if (note.kind !== "ran") return assert.fail("a ran note");
  assert.equal(note.runCount, 3);
  assert.equal(note.runId, "b", "the latest partial one, not the clean one after it");
  assert.equal(runLinkLabel(note.runCount), "View latest run");
});

// ---- 192 ------------------------------------------------------------------------------------------

test("192: a new form starts verified-domain only", async () => {
  const { db, calls } = fakeDb((call) => {
    if (call.target === "table:sections") return { data: [{ id: "s1" }], error: null };
    return { data: { id: "f1" }, error: null };
  });
  const formId = await createForm(createApiContext(db), PROJECT, "Design requests");
  assert.equal(formId, "f1");
  const insert = calls.find((c) => c.target === "table:forms")?.steps.find(([s]) => s === "insert")?.[1][0] as Record<string, unknown>;
  assert.equal(insert.verified_domains_only, true);
});
