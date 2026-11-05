// Nov 5 note 163: automations never complete a blocked task. Avi ran an automation with Mark complete
// on a task blocked by an open task, and it completed it. The rule engine's completion is database code
// the dependency guard doesn't check; until the database patch is applied, a hand-run or bulk-run
// automation that would complete its task isn't run on a blocked one (skipped, with why — never "Ran").
// And once the database logs the step as outcome "blocked", every place that shows a run reads it as
// "Partly ran".
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiContext, type Db } from "@alhc/core/api/core/context";
import { runManualRule, runManualRuleOnTasks } from "@alhc/core/api/automations/mutations";
import { BLOCKED_OUTCOME, blockedCompletionReason, parseBlockerCounts, ruleCompletesTask } from "@alhc/core/blocked-completion";
import { bulkRuleRunMessage, bulkRuleRunTone, type BulkRuleRun } from "@alhc/core/bulk";
import { partialOf, runOutcome, runOutcomeText, stepWasMissed } from "@alhc/core/run-outcome";
import { stepOutcomeLabel } from "@alhc/core/rule-steps";

// ---- A stand-in Supabase client (as in api-layer.test.ts) ---------------------------------------

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

const RULE = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const BLOCKED = "33333333-3333-4333-8333-333333333333";
const FREE = "44444444-4444-4444-8444-444444444444";

const COMPLETES = [{ type: "complete_task" }, { type: "add_comment", body: "done" }];

// The engine's answer for a run that finished and marked the task complete.
const RAN = { status: "succeeded", detail: { actions: [{ step: 1, type: "complete_task", outcome: "done", result: "Marked complete" }] } };

function world(actions: unknown, blockers: Record<string, number>) {
  return fakeDb((call) => {
    if (call.target === "table:rules") return { data: { project_id: PROJECT, actions }, error: null };
    if (call.target === "table:task_projects") return { data: [{ task_id: BLOCKED }, { task_id: FREE }], error: null };
    if (call.target === "rpc:open_blocker_counts") return { data: blockers, error: null };
    if (call.target === "rpc:run_manual_rule") return { data: RAN, error: null };
    return { data: null, error: null };
  });
}

const runsOf = (calls: Call[]) =>
  calls
    .filter((c) => c.target === "rpc:run_manual_rule")
    .map((c) => (c.steps[0][1][0] as { target_task: string }).target_task);

// ---- Avi's case: Run an automation that marks a blocked task complete -----------------------------

test("a hand-run automation that marks a blocked task complete doesn't run on it, and says why", async () => {
  const { db, calls } = world(COMPLETES, { [BLOCKED]: 2 });
  const result = await runManualRule(createApiContext(db), RULE, BLOCKED);
  assert.deepEqual(runsOf(calls), [], "run_manual_rule is never called, so nothing completes the task");
  assert.equal(result.status, "skipped");
  assert.equal(result.partial, null);
  assert.equal(result.reason, "it’s blocked by 2 tasks that aren’t done, and this automation would mark it complete");
});

test("the same automation runs on a task that isn't blocked", async () => {
  const { db, calls } = world(COMPLETES, {});
  const result = await runManualRule(createApiContext(db), RULE, FREE);
  assert.deepEqual(runsOf(calls), [FREE]);
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.summary, ["Marked complete"]);
});

test("an automation that doesn't complete anything runs on a blocked task (no blocker read)", async () => {
  const { db, calls } = world([{ type: "add_comment", body: "hi" }], { [BLOCKED]: 1 });
  await runManualRule(createApiContext(db), RULE, BLOCKED);
  assert.deepEqual(runsOf(calls), [BLOCKED]);
  assert.equal(calls.filter((c) => c.target === "rpc:open_blocker_counts").length, 0);
});

test("a failed blocker count refuses the run instead of letting a completion through", async () => {
  const { db, calls } = fakeDb((call) => {
    if (call.target === "table:rules") return { data: { project_id: PROJECT, actions: COMPLETES }, error: null };
    if (call.target === "rpc:open_blocker_counts") return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
    return { data: RAN, error: null };
  });
  await assert.rejects(runManualRule(createApiContext(db), RULE, BLOCKED));
  assert.deepEqual(runsOf(calls), []);
});

test("Convert to a project with “complete the task” counts as completing", async () => {
  const { db, calls } = world([{ type: "convert_to_project", complete_task: true }], { [BLOCKED]: 1 });
  const result = await runManualRule(createApiContext(db), RULE, BLOCKED);
  assert.deepEqual(runsOf(calls), []);
  assert.equal(result.status, "skipped");
});

// ---- The bulk bar's Run automation -------------------------------------------------------------

test("the bulk run skips blocked tasks, runs the rest, and the notice says so in amber", async () => {
  const { db, calls } = world(COMPLETES, { [BLOCKED]: 1 });
  const run = await runManualRuleOnTasks(createApiContext(db), RULE, [BLOCKED, FREE]);
  assert.deepEqual(runsOf(calls), [FREE], "only the unblocked task runs");
  assert.equal(run.ran, 1);
  assert.equal(run.blocked, 1);
  assert.equal(bulkRuleRunTone(run), "partial");
  assert.equal(
    bulkRuleRunMessage("Finish", run),
    "Ran “Finish” on 1 task · 1 task not run: blocked by tasks that aren’t done, and it would mark it complete.",
  );
});

test("a bulk run where every task is blocked never reads as ran", () => {
  const run: BulkRuleRun = { ran: 0, conditions: 0, skipped: 0, failed: 0, notInProject: 0, blocked: 3 };
  assert.equal(bulkRuleRunTone(run), "partial");
  assert.match(bulkRuleRunMessage("Finish", run), /didn’t change any task · 3 tasks not run: blocked/);
});

// ---- Once the database logs the step as "blocked" ------------------------------------------------

test("a run whose Mark complete was blocked reads Partly ran everywhere, never Ran", () => {
  const detail = {
    actions: [
      { step: 1, type: "complete_task", outcome: BLOCKED_OUTCOME, result: "Not completed: blocked by 1 task that isn’t done" },
      { step: 2, type: "add_comment", outcome: "done", result: "Commented" },
    ],
  };
  assert.ok(stepWasMissed(BLOCKED_OUTCOME));
  assert.equal(stepOutcomeLabel(BLOCKED_OUTCOME), "Blocked");
  const outcome = runOutcome("succeeded", detail);
  assert.equal(outcome.tone, "partial");
  assert.equal(runOutcomeText(outcome), "Partly ran · 1 of 2 actions skipped");
  assert.deepEqual(partialOf("succeeded", detail), { missed: 1, total: 2, reason: "Not completed: blocked by 1 task that isn’t done" });
});

// ---- Pure helpers --------------------------------------------------------------------------------

test("ruleCompletesTask looks at every action of every branch", () => {
  assert.equal(ruleCompletesTask([{ type: "add_comment" }, { type: "complete_task", branch: 2 }]), true);
  assert.equal(ruleCompletesTask([{ type: "convert_to_project", complete_task: false }]), false);
  assert.equal(ruleCompletesTask([{ type: "reopen_task" }]), false);
  assert.equal(ruleCompletesTask(null), false);
  assert.equal(ruleCompletesTask({ type: "complete_task" } as never), false);
});

test("blocker counts and reasons", () => {
  assert.deepEqual([...parseBlockerCounts({ a: 2, b: 0, c: "x" } as never)], [["a", 2]]);
  assert.equal(parseBlockerCounts(null).size, 0);
  assert.equal(blockedCompletionReason(1), "it’s blocked by 1 task that isn’t done, and this automation would mark it complete");
});
