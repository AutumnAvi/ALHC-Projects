// Portfolio rules (Automations V3, batch D): the builder's sentences. The database side (validation,
// the engine, and the triggers) runs in suite zz30.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describePortfolioAction,
  describePortfolioCondition,
  describePortfolioTrigger,
  isPortfolioTrigger,
  portfolioRuleSentence,
  toPortfolioRuleDef,
  type PortfolioRuleContext,
  type PortfolioRuleItem,
} from "@/lib/portfolio-rules";

const ctx: PortfolioRuleContext = {
  portfolioName: "Campaigns",
  fields: [{ id: "f-budget", name: "Budget", fieldType: "single_select", options: [{ id: "o-over", name: "Over", color: "red" }] }],
  people: [
    { id: "p-dana", name: "Dana" },
    { id: "p-sam", name: "Sam" },
  ],
  members: [{ id: "p-dana", name: "Dana" }],
  otherPortfolios: [{ id: "pf-2", name: "Brand" }],
  projects: [],
};

const item = (x: Record<string, unknown>) => x as PortfolioRuleItem;

test("portfolio triggers read as sentences", () => {
  assert.equal(describePortfolioTrigger({ triggerType: "status_changed", triggerConfig: { statuses: ["at_risk", "off_track"] } }, ctx), "A project’s status changes to at risk or off track");
  assert.equal(describePortfolioTrigger({ triggerType: "field_changed", triggerConfig: { field_id: "f-budget", option_id: "o-over" } }, ctx), "Budget changes to Over");
  assert.equal(describePortfolioTrigger({ triggerType: "item_overdue", triggerConfig: { days: 3 } }, ctx), "A project is 3 days overdue");
  assert.equal(describePortfolioTrigger({ triggerType: "due_approaching", triggerConfig: { days: 0 } }, ctx), "A project is due today");
  assert.ok(isPortfolioTrigger("item_added") && !isPortfolioTrigger("task_created"));
});

test("portfolio conditions and actions read as sentences", () => {
  assert.equal(describePortfolioCondition(item({ type: "owner_is_not", people: ["p-dana"] }), ctx), "owner isn’t Dana");
  assert.equal(describePortfolioCondition(item({ type: "date_compare", op: "between", value: "2026-11-01", to: "2026-11-30" }), ctx), "the due date is between Nov 1, 2026 and Nov 30, 2026");
  assert.equal(describePortfolioAction(item({ type: "notify", people: ["owner", "p-sam"], message: "x" }), ctx), "notify the project owner and Sam");
  assert.equal(describePortfolioAction(item({ type: "add_members", people: ["p-sam"], role: "viewer" }), ctx), "add Sam as viewer");
  assert.equal(describePortfolioAction(item({ type: "add_to_portfolio", portfolio_id: "pf-2" }), ctx), "add it to “Brand”");
  assert.equal(describePortfolioAction(item({ type: "set_due_date", days: 5, business_days: true }), ctx), "set the due date to 5 business days from today");
  assert.equal(
    portfolioRuleSentence(
      { triggerType: "status_changed", triggerConfig: { statuses: ["off_track"] }, conditions: [item({ type: "is_not_archived" })], actions: [item({ type: "status_reminder" })] },
      ctx,
    ),
    "When a project’s status changes to off track, if it isn’t archived, remind the owner to post a status update.",
  );
});

test("rows parse into rule definitions", () => {
  const rule = toPortfolioRuleDef({
    id: "r1", portfolio_id: "pf", name: "Watch", enabled: true, trigger_type: "nope", trigger_config: { days: 2 },
    conditions: [{ type: "is_overdue" }, "junk"], actions: [{ type: "archive_project" }], owner_id: null,
    next_run_at: null, paused_at: null, pause_reason: null, last_edited_at: null,
  });
  assert.equal(rule.triggerType, "manual", "unknown triggers read as manual");
  assert.equal(rule.conditions.length, 1);
  assert.equal(rule.actions[0].type, "archive_project");
});
