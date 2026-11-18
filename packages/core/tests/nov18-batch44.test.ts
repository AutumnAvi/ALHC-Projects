// Nov 18 notes (batch 44): an approval only counts once its setup is finished (item 3), and a tab hidden
// or shown again stays that way until the page's copy agrees (item 6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiContext, type Db } from "@alhc/core/api/core/context";
import { setUpApprovalTask } from "@alhc/core/api/approvals/mutations";
import { createTaskFromTemplate } from "@alhc/core/api/templates/mutations";
import { isApiError } from "@alhc/core/api/core/errors";
import { pruneTabOverrides, tabOverrideKey, withTabOverrides } from "@alhc/core/views";

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

const TASK = "11111111-1111-4111-8111-111111111111";
const SAM = "22222222-2222-4222-8222-222222222222";
const SECTION = "33333333-3333-4333-8333-333333333333";

const setup = (over: Partial<Parameters<typeof setUpApprovalTask>[2]> = {}): Parameters<typeof setUpApprovalTask>[2] => ({
  fromKind: "task",
  approvers: { approverIds: [SAM], mode: "any", dueOn: null },
  followUp: { followUp: "complete", sectionId: null, reminders: true },
  ...over,
});

// What the kind was set to, in order.
const kinds = (calls: Call[]) =>
  calls
    .filter((c) => c.target === "table:tasks")
    .map((c) => (c.steps.find(([name]) => name === "update")?.[1][0] as { kind: string }).kind);
const rpcs = (calls: Call[]) => calls.filter((c) => c.target.startsWith("rpc:")).map((c) => c.target.slice(4));

function world(fail: string | null = null) {
  return fakeDb((call) => {
    if (call.target === "table:tasks") return { data: [{ id: TASK }], error: null };
    if (call.target === `rpc:${fail}`) return { data: null, error: { code: "P0001", message: "Sam can’t approve this task" } };
    return { data: null, error: null };
  });
}

test("item 3: Done makes a plain task an approval with its approvers and follow-up, in that order", async () => {
  const { db, calls } = world();
  await setUpApprovalTask(createApiContext(db), TASK, setup({ reviewer: { email: "client@example.com", name: "Client" } }));
  assert.deepEqual(kinds(calls), ["approval"]);
  assert.deepEqual(rpcs(calls), ["set_task_approvers", "set_approval_followup", "set_task_external_reviewer"]);
  const approvers = calls.find((c) => c.target === "rpc:set_task_approvers")!.steps[0][1][0] as { approvers: string[] };
  assert.deepEqual(approvers.approvers, [SAM]);
});

test("item 3: nothing is written without an approver (or a section to move to)", async () => {
  for (const input of [
    setup({ approvers: { approverIds: [], mode: "any", dueOn: null } }),
    setup({ followUp: { followUp: "move_section", sectionId: null, reminders: true } }),
  ]) {
    const { db, calls } = world();
    await assert.rejects(setUpApprovalTask(createApiContext(db), TASK, input), (e) => isApiError(e) && e.code === "invalid");
    assert.equal(calls.length, 0, "no write at all");
  }
  const { db } = world();
  await setUpApprovalTask(createApiContext(db), TASK, setup({ followUp: { followUp: "move_section", sectionId: SECTION, reminders: false } }));
});

test("item 3: a refused step puts the task back — no approvers, and the kind it had", async () => {
  for (const [fail, from] of [
    ["set_task_approvers", "task"],
    ["set_approval_followup", "milestone"],
  ] as const) {
    const { db, calls } = world(fail);
    await assert.rejects(setUpApprovalTask(createApiContext(db), TASK, setup({ fromKind: from })), /can’t approve/);
    assert.deepEqual(kinds(calls), ["approval", from], `${fail}: back to a ${from}`);
    const cleared = calls.filter((c) => c.target === "rpc:set_task_approvers").at(-1)!.steps[0][1][0] as { approvers: string[] };
    assert.deepEqual(cleared.approvers, [], "no approvers left behind");
  }
});

test("item 3: an approval task already (Finish setup, a template's approval) keeps its kind either way", async () => {
  const ok = world();
  await setUpApprovalTask(createApiContext(ok.db), TASK, setup({ fromKind: "approval" }));
  assert.deepEqual(kinds(ok.calls), [], "the kind isn't written");
  const refused = world("set_task_approvers");
  await assert.rejects(setUpApprovalTask(createApiContext(refused.db), TASK, setup({ fromKind: "approval" })));
  assert.deepEqual(kinds(refused.calls), [], "and isn't changed back");
  await assert.rejects(
    setUpApprovalTask(createApiContext(ok.db), TASK, setup({ fromKind: "epic" as never })),
    (e) => isApiError(e) && e.code === "invalid",
  );
});

test("item 3: a template's approval task is saved as a plain task until its setup is done", async () => {
  const TEMPLATE = "44444444-4444-4444-8444-444444444444";
  const make = (refuse = false, templateKind = "approval") =>
    fakeDb((call) => {
      if (call.target === "rpc:create_task_from_template") return { data: TASK, error: null };
      if (call.target === "table:tasks") {
        const update = call.steps.find(([name]) => name === "update");
        // The flip only touches an approval (eq kind = approval).
        const onlyApproval = call.steps.some(([name, args]) => name === "eq" && args[0] === "kind" && args[1] === "approval");
        if (update) return refuse || (onlyApproval && templateKind !== "approval") ? { data: [], error: null } : { data: [{ id: TASK }], error: null };
        return { data: { kind: templateKind }, error: null };
      }
      if (call.target === "table:task_templates") return { data: { project_id: SECTION, field_values: [] }, error: null };
      return { data: null, error: null };
    });
  const ui = make();
  const made = await createTaskFromTemplate(createApiContext(ui.db), TEMPLATE, null, "Sign-off", { approvalAfterSetup: true });
  assert.deepEqual([made.kind, made.approvalSetup], ["task", true]);
  assert.deepEqual(kinds(ui.calls.filter((c) => c.steps.some(([name]) => name === "update"))), ["task"]);
  assert.equal(ui.calls.filter((c) => c.target === "table:tasks").length, 1, "one step: no read that could fail first");
  // Any other template's task keeps its kind (a milestone stays a milestone).
  const milestone = make(false, "milestone");
  const kept2 = await createTaskFromTemplate(createApiContext(milestone.db), TEMPLATE, null, null, { approvalAfterSetup: true });
  assert.deepEqual([kept2.kind, kept2.approvalSetup], ["milestone", undefined]);
  // Refused: it stays an approval (the setup's Cancel turns it back), and the setup still opens.
  const refused = make(true);
  const kept = await createTaskFromTemplate(createApiContext(refused.db), TEMPLATE, null, null, { approvalAfterSetup: true });
  assert.deepEqual([kept.kind, kept.approvalSetup], ["approval", true]);
  // Anyone else asking (not the person's own add row) gets the template's kind, as before.
  const other = make();
  const plain = await createTaskFromTemplate(createApiContext(other.db), TEMPLATE, null, null);
  assert.deepEqual([plain.kind, plain.approvalSetup], ["approval", undefined]);
  assert.equal(other.calls.filter((c) => c.steps.some(([name]) => name === "update")).length, 0);
});

test("item 6: overrides apply on top of the page's hidden lists, and go once the page agrees", () => {
  const o = { [tabOverrideKey("tab", "files")]: false, [tabOverrideKey("view", "v2")]: true };
  assert.deepEqual(withTabOverrides(["files", "workload"], "tab", o), ["workload"], "Files shown again at once");
  assert.deepEqual(withTabOverrides([], "view", o), ["v2"], "a view hidden at once");
  assert.deepEqual(withTabOverrides(["files"], "view", o), ["files", "v2"], "kinds don't mix (a tab override never touches views)");
  // The refresh hasn't landed: the overrides stay (the same object).
  assert.equal(pruneTabOverrides(["files", "workload"], [], o), o);
  // Files is shown on the page now; the view isn't hidden there yet.
  assert.deepEqual(pruneTabOverrides(["workload"], [], o), { "view:v2": true });
  assert.deepEqual(pruneTabOverrides(["workload"], ["v2"], o), {});
});
