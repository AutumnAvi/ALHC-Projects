// Nov 24 batch 45: the approval setup's live preview (planTrack) and its plain-English summary
// (approvalPlanSummary), plus saving the review order and the outside reviewer's due date.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planDoneLabel, planTeamLabel, planTrack, type PlanInput } from "@alhc/core/approval-plan";
import { approvalPlanSummary } from "@alhc/core/approval-track";
import { createApiContext, type Db } from "@alhc/core/api/core/context";
import { setTaskReviewPlan, setUpApprovalTask } from "@alhc/core/api/approvals/mutations";
import { isApiError } from "@alhc/core/api/core/errors";

const base: PlanInput = {
  assigneeId: "cg",
  approverIds: ["avi", "isaiah"],
  approverNames: ["Avi W.", "Isaiah Rappaport"],
  mode: "all",
  reviewer: { email: "sarah.k@glenoaks-al.com", name: "Sarah K." },
  reviewerDueOn: "2026-12-15",
  order: "parallel",
  after: "move_section",
  sectionName: "Ready to publish",
  approvalDueOn: "2026-12-11",
};

test("planTrack: the mockup's parallel plan", () => {
  const plan = planTrack(base);
  assert.equal(plan.order, "parallel");
  assert.deepEqual(
    plan.steps.map((s) => [s.role, s.label]),
    [
      ["work", "Work"],
      ["team", "Team: Avi + Isaiah · both"],
      ["outside", "Outside: Sarah · due Dec 15"],
      ["done", "Done → Ready to publish"],
    ],
  );
  assert.deepEqual(plan.steps[0].personIds, ["cg"]);
  assert.deepEqual(plan.steps[1].personIds, ["avi", "isaiah"]);
  assert.equal(plan.steps[1].dueOn, "2026-12-11");
  assert.deepEqual(plan.steps[2].outside, base.reviewer);
});

test("planTrack: sequential and team-only plans", () => {
  const sequential = planTrack({ ...base, order: "sequential", mode: "any", reviewerDueOn: null, after: "complete" });
  assert.equal(sequential.order, "sequential");
  assert.deepEqual(
    sequential.steps.map((s) => s.label),
    ["Work", "Team: Avi + Isaiah · any one", "Outside: Sarah", "Done"],
  );
  const teamOnly = planTrack({ ...base, reviewer: null, approverIds: ["avi"], approverNames: ["Avi W."], after: "notify" });
  assert.equal(teamOnly.order, "sequential", "no outside reviewer: nothing runs at the same time");
  assert.deepEqual(teamOnly.steps.map((s) => s.label), ["Work", "Team: Avi", "Done · notify"]);
  // Without a team approver there is no approval to run beside, so the outside reviewer isn't drawn.
  const nobody = planTrack({ ...base, approverIds: [], approverNames: [] });
  assert.deepEqual(nobody.steps.map((s) => s.label), ["Work", "Team: not set", "Done → Ready to publish"]);
  assert.equal(nobody.order, "sequential");
});

test("plan labels", () => {
  assert.equal(planTeamLabel(["Avi W.", "Isaiah R.", "Chana S."], "all"), "Team: Avi + Isaiah +1 · all");
  assert.equal(planTeamLabel(["Avi W."], "all"), "Team: Avi");
  assert.equal(planDoneLabel("move_section", null), "Done → a section");
  assert.equal(planDoneLabel("complete", "Ignored"), "Done");
});

test("approvalPlanSummary: the mockup's exact sentence and the other orders", () => {
  const parallel = approvalPlanSummary({
    approverNames: ["Avi", "Isaiah"],
    mode: "all",
    reviewerName: "Sarah",
    order: "parallel",
    after: "move_section",
    sectionName: "Ready to publish",
  });
  assert.equal(
    parallel.sentence,
    "Avi and Isaiah both approve it while Sarah reviews by email. When all three say yes, it moves to Ready to publish. If anyone asks for changes, round 2 goes to all three.",
  );
  assert.equal(parallel.flow, "Work, then Team and Outside review at the same time, then Done");

  const sequential = approvalPlanSummary({ approverNames: ["Avi"], mode: "any", reviewerName: "Sarah", order: "sequential", after: "complete", sectionName: null });
  assert.equal(sequential.flow, "Work, then Team review, then Outside review, then Done");
  assert.match(sequential.sentence, /^Avi approves it first, then Sarah reviews it by email\. When Sarah says yes too, it’s completed\./);

  const teamOnly = approvalPlanSummary({ approverNames: ["Avi", "Isaiah"], mode: "any", reviewerName: null, order: "parallel", after: "notify", sectionName: null });
  assert.equal(teamOnly.flow, "Work, then Team review, then Done");
  assert.match(teamOnly.sentence, /^Avi or Isaiah approves it\. When one of them says yes, the assignee is told\./);

  assert.equal(approvalPlanSummary({ approverNames: [], mode: "any", reviewerName: null, order: "sequential", after: "complete", sectionName: null }).sentence, "Choose who on the team approves it.");
});

// --- Saving -----------------------------------------------------------------------------------------------

type Call = { target: string; steps: [string, unknown[]][] };

function fakeDb(answer: (call: Call) => { data: unknown; error: unknown }) {
  const calls: Call[] = [];
  const chain = (call: Call): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            const result = answer(call);
            return (resolve: (v: unknown) => unknown) => resolve(result);
          }
          return (...args: unknown[]) => {
            call.steps.push([prop, args]);
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

test("setTaskReviewPlan saves the order and due date through set_task_review_plan (never a table upsert)", async () => {
  const { db, calls } = fakeDb(() => ({ data: null, error: null }));
  await setTaskReviewPlan(createApiContext(db), { taskId: TASK, order: "parallel", dueOn: "2026-12-15" });
  assert.equal(calls[0].target, "rpc:set_task_review_plan");
  assert.deepEqual(calls[0].steps[0][1][0], { target_task: TASK, plan_order: "parallel", plan_due_on: "2026-12-15" });
  for (const bad of [{ order: "later" as never, dueOn: null }, { order: "parallel" as const, dueOn: "Dec 15" }]) {
    await assert.rejects(setTaskReviewPlan(createApiContext(db), { taskId: TASK, ...bad }), (e) => isApiError(e) && e.code === "invalid");
  }
});

test("setUpApprovalTask saves the plan first, and a refused order change puts a new approval back", async () => {
  const ok = fakeDb((call) => (call.target === "table:tasks" ? { data: [{ id: TASK }], error: null } : { data: null, error: null }));
  await setUpApprovalTask(createApiContext(ok.db), TASK, {
    fromKind: "approval",
    approvers: { approverIds: [SAM], mode: "any", dueOn: null },
    followUp: { followUp: "complete", sectionId: null, reminders: true },
    plan: { order: "parallel", dueOn: null },
  });
  assert.deepEqual(
    ok.calls.map((c) => c.target),
    ["rpc:set_task_review_plan", "rpc:set_task_approvers", "rpc:set_approval_followup"],
  );

  const refused = fakeDb((call) => {
    if (call.target === "table:tasks") return { data: [{ id: TASK }], error: null };
    if (call.target === "rpc:set_task_review_plan") {
      return { data: null, error: { code: "23514", message: "Change the review order once the current round is decided or withdrawn" } };
    }
    return { data: null, error: null };
  });
  await assert.rejects(
    setUpApprovalTask(createApiContext(refused.db), TASK, {
      fromKind: "task",
      approvers: { approverIds: [SAM], mode: "any", dueOn: null },
      followUp: { followUp: "complete", sectionId: null, reminders: true },
      plan: { order: "parallel", dueOn: null },
    }),
    /review order/,
  );
  const targets = refused.calls.map((c) => c.target);
  assert.ok(!targets.includes("rpc:set_approval_followup"), "nothing after the refusal is written");
  const kinds = refused.calls
    .filter((c) => c.target === "table:tasks")
    .map((c) => (c.steps.find(([name]) => name === "update")?.[1][0] as { kind: string }).kind);
  assert.deepEqual(kinds, ["approval", "task"], "made an approval, then put back");
});
