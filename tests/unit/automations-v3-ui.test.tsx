// Automations V3: the builders render (server-side, like the first paint) for every V3 trigger,
// condition, and action, and use only the app's own pickers — never a native <select> or a browser
// date popup.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { RuleCanvas } from "@/components/rules/rule-canvas";
import type { RuleContext } from "@/components/rules/rule-shared";
import { PortfolioRuleBuilder, PortfolioRulesView } from "@/components/portfolio/portfolio-rules";
import { MyTaskRuleEditor, MyTaskRulesDialog } from "@/components/my-tasks/my-task-rules";
import { PORTFOLIO_ACTIONS, PORTFOLIO_CONDITIONS, PORTFOLIO_TRIGGERS, portfolioActionDefaults, portfolioConditionDefaults, type PortfolioRuleContext, type PortfolioRuleDef } from "@/lib/portfolio-rules";
import { V3_ACTIONS, V3_CONDITIONS, V3_TRIGGERS, type RuleDef, type TriggerType } from "@/lib/rules";
import type { MyTaskRule } from "@/lib/my-task-rules";
import type { FieldDef } from "@/lib/fields";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };

function render(node: ReactNode) {
  return renderToStaticMarkup(
    // The canvas and the portfolio builder navigate with the app router.
    <AppRouterContext.Provider value={router as never}>{node}</AppRouterContext.Provider>,
  );
}

function assertNoNativePopups(html: string, where: string) {
  assert.ok(!/<select[\s>]/.test(html), `${where}: no native <select>`);
  assert.ok(!/type="date"/.test(html), `${where}: no browser date input`);
}

const field = (id: string, name: string, fieldType: string, options: { id: string; name: string; color: string }[] = []): FieldDef =>
  ({ id, name, fieldType, boundToSections: false, options, showInViews: false }) as unknown as FieldDef;

const ctx: RuleContext = {
  sections: [
    { id: "s-intake", name: "Intake" },
    { id: "s-design", name: "Design" },
  ],
  fields: [
    field("f-designer", "Designer", "people"),
    field("f-channel", "Channel", "single_select", [{ id: "o-web", name: "Web", color: "blue" }]),
    field("f-launch", "Launch", "date"),
  ],
  people: [{ id: "p-dana", name: "Dana" }],
  members: [{ id: "p-dana", name: "Dana" }],
  forms: [{ id: "form-1", title: "Brief", questions: [] }],
  integrations: null,
  inboundEndpoints: [],
  tags: [],
  taskTemplates: [],
  otherProjects: [{ id: "proj-2", name: "Production", sections: [{ id: "s2", name: "Queue" }] }],
  workWeek: [0, 1, 2, 3, 4],
  projectName: "Requests",
  projectTemplates: [{ id: "tpl-1", name: "Event" }],
  portfolios: [{ id: "pf-1", name: "Events" }],
  v2: true,
  v3: true,
};

const configs: Record<string, Record<string, unknown>> = {
  follower_added: { people: ["p-dana"] },
  start_date_changed: { change: "set" },
  start_approaching: { amount: 4, unit: "hours" },
  start_reached: { amount: 1, unit: "weeks" },
  task_unblocked: { kinds: ["start_to_start"] },
  task_type_changed: { kind: "milestone" },
  section_left: { section_id: "s-intake" },
};

const conditions: Record<string, Record<string, unknown>> = {
  person_compare: { left: "assignee", op: "is", people: ["creator"] },
  date_compare: { date: "start", op: "between", value: "2026-11-01", to: "2026-11-30" },
  start_within: { days: 3 },
  section_is_one_of: { section_ids: ["s-intake", "s-design"] },
  section_is_none_of: { section_ids: ["s-intake"] },
  task_type_is_not: { kind: "approval" },
  approval_status_is: { statuses: ["pending"] },
};

const actions: Record<string, Record<string, unknown>> = {
  remove_followers: { people: ["p-dana"] },
  set_start_date: { mode: "date", date: "2026-11-02" },
  create_task: { kind: "milestone", title: "Launch {{task.name}}", project_id: "proj-2", section_id: "s2", assignee: "creator", due_days: 3, link: "blocked_by" },
  move_to_project: { project_id: "proj-2" },
  set_task_type: { kind: "approval" },
  set_description: { mode: "append", text: "Approved" },
  convert_to_project: { template_id: "tpl-1", portfolio_id: "pf-1", members: "task_people", complete_task: true },
};

function rule(triggerType: string, triggerConfig: Record<string, unknown>, conds: Record<string, unknown>[], acts: Record<string, unknown>[]): RuleDef {
  return {
    id: "rule-1",
    projectId: "proj-1",
    name: "Every V3 piece",
    enabled: true,
    triggerType: triggerType as TriggerType,
    triggerConfig: triggerConfig as RuleDef["triggerConfig"],
    conditions: conds as RuleDef["conditions"],
    actions: acts as RuleDef["actions"],
    presetKey: null,
    pausedUntil: "2030-01-01T00:00:00Z",
  };
}

test("the rule canvas draws every V3 trigger, condition, and action with the app's pickers", () => {
  // Every V3 condition and action at once (two rules: a branch holds at most ten actions).
  const allConditions = [...V3_CONDITIONS].map((type) => ({ type, ...(conditions[type] ?? {}) }));
  const allActions = [...V3_ACTIONS].map((type) => ({ type, ...(actions[type] ?? {}) }));
  for (const triggerType of V3_TRIGGERS) {
    const html = render(
      <RuleCanvas
        projectId="proj-1"
        projectName="Requests"
        rule={rule(triggerType, configs[triggerType] ?? {}, allConditions, allActions.slice(0, 5))}
        runs={[]}
        ctx={ctx}
        batch4
        canEdit
        backHref="/projects/proj-1/rules"
      />,
    );
    assert.ok(html.includes("Every V3 piece"), `${triggerType}: the canvas rendered`);
    assertNoNativePopups(html, `canvas (${triggerType})`);
  }
  const rest = render(
    <RuleCanvas projectId="proj-1" projectName="Requests" rule={rule("scheduled", { frequency: "weekly", weekdays: [0, 2], interval: 2, hour: 8, minute: 30 }, [{ type: "field_compare", field_id: "f-launch", op: "between", value: "2026-11-01", to: "2026-11-30" }, { type: "field_compare", field_id: "f-channel", op: "one_of", value: ["o-web"] }], allActions.slice(5))} runs={[]} ctx={ctx} batch4 canEdit backHref="/x" />,
  );
  assert.ok(rest.includes("Every 2 weeks on Sunday and Tuesday at 8:30 AM"), "the schedule reads as a sentence");
  assert.ok(rest.includes("convert to a project from “Event” in “Events” and complete the task"), "Convert to a project is summarized");
  assertNoNativePopups(rest, "canvas (schedule, ranges, convert)");
});

const pctx: PortfolioRuleContext = {
  portfolioName: "Campaigns",
  fields: [{ id: "pf-f", name: "Budget", fieldType: "single_select", options: [{ id: "o1", name: "Over", color: "red" }] }],
  people: [{ id: "p-dana", name: "Dana" }],
  members: [{ id: "p-dana", name: "Dana" }],
  otherPortfolios: [{ id: "pf-2", name: "Brand" }],
  projects: [{ id: "proj-1", name: "Spring launch" }],
  workWeek: [0, 1, 2, 3, 4],
};

function portfolioRule(triggerType: string, conds: Record<string, unknown>[], acts: Record<string, unknown>[]): PortfolioRuleDef {
  return {
    id: "pr-1", portfolioId: "pf-1", name: "Watch the budget", enabled: true,
    triggerType: triggerType as PortfolioRuleDef["triggerType"], triggerConfig: triggerType === "scheduled" ? { frequency: "daily", hour: 9 } : {},
    conditions: conds as PortfolioRuleDef["conditions"], actions: acts as PortfolioRuleDef["actions"],
    ownerId: "p-dana", nextRunAt: null, pausedAt: null, pauseReason: null, lastEditedAt: null, pausedUntil: null,
  };
}

test("the portfolio Rules tab and builder render every trigger, condition, and action", () => {
  const conds = PORTFOLIO_CONDITIONS.map((c) => portfolioConditionDefaults(c.value));
  const acts = PORTFOLIO_ACTIONS.map((a) => portfolioActionDefaults(a.value));
  for (const t of PORTFOLIO_TRIGGERS) {
    const html = render(<PortfolioRuleBuilder portfolioId="pf-1" rule={portfolioRule(t.value, conds, acts.slice(0, 10))} runs={[]} ctx={pctx} canEdit />);
    assert.ok(html.includes("Summary"), `${t.value}: the builder rendered`);
    assertNoNativePopups(html, `portfolio builder (${t.value})`);
  }
  const more = render(<PortfolioRuleBuilder portfolioId="pf-1" rule={portfolioRule("manual", [], acts.slice(10))} runs={[]} ctx={pctx} canEdit />);
  assertNoNativePopups(more, "portfolio builder (last actions)");
  const list = render(
    <PortfolioRulesView
      portfolioId="pf-1"
      rules={[portfolioRule("manual", [], [{ type: "status_reminder" }])]}
      runs={[{ id: "run-1", ruleId: "pr-1", projectId: "proj-1", projectName: "Spring launch", status: "succeeded", detail: { actions: [] }, createdAt: "2026-10-21T08:00:00Z" }]}
      ctx={pctx}
      canEdit
      canRun
    />,
  );
  assert.ok(list.includes("Watch the budget") && list.includes("Run on") && list.includes("Spring launch"), "rules, manual runs, and the run log");
  assert.ok(list.includes("Duplicate Watch the budget") && list.includes("Pause"), "duplicate and pause");
  assertNoNativePopups(list, "portfolio Rules tab");
  const missing = render(<PortfolioRulesView portfolioId="pf-1" rules={null} runs={[]} ctx={pctx} canEdit canRun />);
  assert.ok(missing.includes("need this release’s database update"), "without the database update it says so");
});

test("My Tasks rules: the list and the editor", () => {
  const mctx = { sections: [{ id: "s-today", name: "Do today" }], projects: [{ id: "proj-1", name: "Website" }] };
  const myRule: MyTaskRule = {
    id: "m1", name: "Due tomorrow", enabled: true, triggerType: "due_approaching", triggerConfig: { days: 1 },
    conditions: [{ type: "in_project", project_ids: ["proj-1"] }, { type: "due_within", days: 2 }, { type: "task_type_is", kind: "task" }],
    actions: [{ type: "move_to_section", section_id: "s-today" }, { type: "set_due_date", days: 1, business_days: true }, { type: "complete_task" }],
  };
  const list = render(<MyTaskRulesDialog rules={[myRule]} ctx={mctx} onClose={() => {}} />);
  assert.ok(list.includes("When a task of mine is due in 1 day, if it’s in “Website”"), "the rule reads as a sentence");
  assertNoNativePopups(list, "My Tasks rules list");
  const editor = render(<MyTaskRuleEditor rule={myRule} ctx={mctx} onDone={() => {}} />);
  assert.ok(editor.includes("Do today") && editor.includes("business days from today"), "the editor shows the picked values");
  assertNoNativePopups(editor, "My Tasks rule editor");
});
