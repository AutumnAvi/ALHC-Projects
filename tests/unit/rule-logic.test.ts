// Automations V2, batches 2 and 4 — AND / OR condition groups (mirrors rule_conditions_pass; the
// database side runs in suite zz29), run-step logs and dry-run results, and the loop-guard wording.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  conditionGroup,
  groupsPass,
  joinBranches,
  joinGroups,
  runReason,
  splitBranches,
  splitGroups,
  type RuleCondition,
} from "@/lib/rules";
import { parseRuleTestResult, runSteps, stepOutcomeLabel, stepTone, testHeadline } from "@/lib/rule-steps";

const c = (type: string, group?: number): RuleCondition => ({ type, ...(group === undefined ? {} : { group }) }) as RuleCondition;

test("AND within a group, OR between groups; no conditions always pass", () => {
  // (Intake AND assigned) OR urgent
  const conditions = [c("section_is"), c("assignee_is_set"), c("title_contains", 1)];
  const run = (passing: Set<string>) => groupsPass(conditions, conditionGroup, (x) => passing.has(x.type));
  assert.equal(run(new Set(["section_is", "assignee_is_set"])), true, "the first group alone");
  assert.equal(run(new Set(["title_contains"])), true, "the second group alone");
  assert.equal(run(new Set(["section_is"])), false, "half of the AND group");
  assert.equal(run(new Set()), false, "nothing");
  assert.equal(groupsPass([], conditionGroup, () => false), true, "no conditions: always");
});

test("groups split and join without leaving stray keys (one group = the old shape)", () => {
  const groups = splitGroups([c("a"), c("b", 2), c("d"), c("e", 2)]);
  assert.deepEqual(groups.map((g) => g.map((x) => x.type)), [["a", "d"], ["b", "e"]], "group order kept, keys dropped");
  assert.deepEqual(joinGroups(groups), [c("a"), c("d"), c("b", 1), c("e", 1)], "renumbered from 0");
  assert.deepEqual(joinGroups([[c("a")], []]), [c("a")], "an emptied group disappears with its keys");
  assert.deepEqual(joinGroups([[], [c("b")]]), [c("b")], "the remaining group becomes group 0");
  assert.equal(conditionGroup({ type: "x", group: 12 }), 0, "out of range = 0");
});

test("groups survive branches (Else if keeps its own OR groups)", () => {
  const rule = {
    conditions: [c("a"), { ...c("b"), group: 1 }, { type: "c", branch: 1 } as unknown as RuleCondition, { type: "d", branch: 1, group: 1 } as unknown as RuleCondition],
    actions: [{ type: "complete_task" }, { type: "reopen_task", branch: 1 }] as never[],
  };
  const branches = splitBranches(rule);
  assert.deepEqual(splitGroups(branches[1].conditions).map((g) => g.map((x) => x.type)), [["c"], ["d"]]);
  assert.deepEqual(joinBranches(branches), rule, "round trip");
});

test("loop-guard and limit reasons read in words", () => {
  assert.match(runReason({ reason: "loop" }) ?? "", /can’t trigger itself/);
  assert.match(runReason({ reason: "depth_limit" }) ?? "", /three/);
  assert.match(runReason({ reason: "throttled" }) ?? "", /20 runs an hour/);
  assert.match(runReason({ reason: "rate_limited" }) ?? "", /1,000/);
  assert.equal(runReason({ actions: { error: "Add to project: no access" } }), "Add to project: no access");
});

test("a run's steps: successful runs list them; failed runs keep the steps that ran and the error", () => {
  const ok = runSteps({ actions: [{ step: 1, type: "move_section", outcome: "done", result: "Moved to “Review”", input: { section: "Review" } }] });
  assert.equal(ok.error, null);
  assert.deepEqual(ok.steps[0], { step: 1, type: "move_section", outcome: "done", result: "Moved to “Review”", error: null, input: { section: "Review" }, afterWait: false });
  const failed = runSteps({
    actions: { error: "boom" },
    steps: [{ step: 1, type: "add_tag", outcome: "done", result: "Tagged" }, { step: 2, type: "add_to_project", outcome: "error", error: "boom" }],
  });
  assert.equal(failed.error, "boom");
  assert.deepEqual(failed.steps.map((s) => [s.step, s.outcome]), [[1, "done"], [2, "error"]]);
  assert.deepEqual(runSteps({ reason: "loop" }), { steps: [], error: null }, "a skipped run has no steps");
  assert.deepEqual(runSteps(null), { steps: [], error: null });
});

test("dry-run results parse, and the headline says what would happen", () => {
  const result = parseRuleTestResult({
    task_id: "t1",
    task_title: "Flyer",
    trigger_type: "manual",
    branches: [{ branch: 0, conditions: [{ condition: { type: "is_incomplete" }, ok: true }, { condition: { type: "title_contains", text: "x", group: 1 }, ok: false }] }],
    chosen_branch: 0,
    steps: [
      { step: 1, type: "send_email", outcome: "would_send", result: "Email to the form submitter" },
      { step: 2, type: "delay", outcome: "would_wait", result: "Wait 2 h, then continue" },
      { step: 3, type: "add_tag", outcome: "unchanged", result: "Already tagged", after_wait: true },
    ],
    error: null,
    invalid: false,
    written: false,
  });
  assert.ok(result);
  assert.equal(result.branches[0].conditions[1].ok, false);
  assert.equal(result.steps[2].afterWait, true);
  assert.equal(testHeadline(result), "2 steps would run");
  assert.deepEqual(result.steps.map((s) => stepTone(s.outcome)), ["send", "wait", "unchanged"]);
  assert.equal(stepOutcomeLabel("would_send"), "Would send");
  assert.equal(stepOutcomeLabel("some_new_outcome"), "some new outcome");

  assert.equal(testHeadline({ ...result, chosenBranch: null }), "Nothing would run: the conditions don’t match this task");
  assert.equal(testHeadline({ ...result, error: "Add to project: no access" }), "This rule would fail on this task");
  assert.equal(testHeadline({ ...result, invalid: true, error: "Unknown action" }), "The rule can’t be saved like this yet");
  assert.equal(parseRuleTestResult(null), null);
  assert.equal(parseRuleTestResult({ steps: [] }), null, "no task, no result");
});
