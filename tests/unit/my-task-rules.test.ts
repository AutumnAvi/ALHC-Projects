// My Tasks rules and Convert to a project (Automations V3, batch E): the builder's sentences. The
// database side runs in suite zz30.
import assert from "node:assert/strict";
import { test } from "node:test";
import { myTaskRuleSentence, toMyTaskRule, type MyTaskRuleContext, type MyTaskRuleItem } from "@/lib/my-task-rules";
import { describeAction, type RuleContext } from "@/components/rules/rule-shared";
import type { RuleAction } from "@/lib/rules";

const ctx: MyTaskRuleContext = {
  sections: [{ id: "s-today", name: "Do today" }],
  projects: [{ id: "p-web", name: "Website" }],
};
const item = (x: Record<string, unknown>) => x as MyTaskRuleItem;

test("My Tasks rules read as sentences", () => {
  assert.equal(
    myTaskRuleSentence({ triggerType: "due_approaching", triggerConfig: { days: 1 }, conditions: [item({ type: "in_project", project_ids: ["p-web"] })], actions: [item({ type: "move_to_section", section_id: "s-today" })] }, ctx),
    "When a task of mine is due in 1 day, if it’s in “Website”, move it to “Do today”.",
  );
  assert.equal(
    myTaskRuleSentence({ triggerType: "assigned", triggerConfig: {}, conditions: [], actions: [item({ type: "set_due_date", days: 2, business_days: true })] }, ctx),
    "When a task is assigned to me, set its due date to 2 business days from today.",
  );
  assert.equal(toMyTaskRule({ id: "r", name: "x", enabled: true, trigger_type: "weird", trigger_config: {}, conditions: [], actions: [] }).triggerType, "assigned");
});

test("Convert to a project reads as a sentence", () => {
  const rctx: RuleContext = {
    sections: [], fields: [], people: [], forms: [], integrations: null, inboundEndpoints: [],
    projectTemplates: [{ id: "t1", name: "Event" }], portfolios: [{ id: "pf", name: "Events" }],
  };
  assert.equal(
    describeAction({ type: "convert_to_project", template_id: "t1", portfolio_id: "pf", complete_task: true } as RuleAction, rctx),
    "convert to a project from “Event” in “Events” and complete the task",
  );
  assert.equal(describeAction({ type: "convert_to_project" } as RuleAction, rctx), "convert to a project");
});
