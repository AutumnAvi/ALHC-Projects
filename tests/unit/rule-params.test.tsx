// Rules: every step's settings can be chosen. Walks every trigger, condition, and action of project,
// portfolio, and My Tasks rules (src/lib/rule-params.ts) and fails when a setting has no editor on screen,
// when a missing required setting isn't pointed out (prompt, highlight, held Save, "(choose …)" in the
// summary), or when a chosen value doesn't save, reload, or show up in the summary.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { ParamProbeContext, StepParams, type ParamProbe } from "@/components/param-slot";
import { RuleCanvas } from "@/components/rules/rule-canvas";
import { ActionFields, ConditionFields, TriggerFields } from "@/components/rules/rule-editor";
import { describeAction, describeCondition, describeTrigger, type RuleContext } from "@/components/rules/rule-shared";
import {
  ActionSettings,
  ConditionSettings,
  PortfolioRuleBuilder,
  TriggerSettings,
} from "@/components/portfolio/portfolio-rules";
import { MyTaskActionFields, MyTaskConditionFields, MyTaskRuleEditor } from "@/components/my-tasks/my-task-rules";
import type { FieldDef } from "@/lib/fields";
import { describeMyTaskAction, describeMyTaskCondition, describeMyTaskTrigger, type MyTaskRuleContext } from "@/lib/my-task-rules";
import {
  describePortfolioAction,
  describePortfolioCondition,
  describePortfolioTrigger,
  type PortfolioRuleContext,
} from "@/lib/portfolio-rules";
import {
  STEP_TYPES,
  activeParams,
  isRequired,
  missingParams,
  ruleProblems,
  saveBlockedReason,
  stepParams,
  stepProblems,
  type ParamEditor,
  type RuleParam,
  type RuleStep,
  type RuleSystem,
  type StepKind,
  type StepScope,
} from "@/lib/rule-params";
import { compareOpsFor, type RuleDef, type TriggerType } from "@/lib/rules";
import type { Json } from "@/lib/supabase/database.types";

const SYSTEMS: RuleSystem[] = ["project", "portfolio", "my_tasks"];
const KINDS: StepKind[] = ["trigger", "condition", "action"];

const EDITORS: ReadonlySet<ParamEditor> = new Set<ParamEditor>([
  "section", "sections", "field", "field_value", "option", "person", "people", "tag", "form", "question", "endpoint", "project",
  "task_template", "project_template", "portfolio", "choice", "choices", "number", "text", "titles", "date",
]);

// ---------------------------------------------------------------------------------------------
// Test worlds
// ---------------------------------------------------------------------------------------------

const field = (id: string, name: string, fieldType: string, options: { id: string; name: string; color: string }[] = []): FieldDef =>
  ({ id, name, fieldType, boundToSections: false, options, showInViews: false }) as unknown as FieldDef;

const ctx: RuleContext = {
  sections: [
    { id: "s-intake", name: "Intake" },
    { id: "s-design", name: "Design" },
  ],
  fields: [
    field("f-channel", "Channel", "single_select", [{ id: "o-web", name: "Web", color: "blue" }]),
    field("f-launch", "Launch", "date"),
    field("f-designer", "Designer", "people"),
    field("f-email", "Client email", "text"),
  ],
  people: [{ id: "p-dana", name: "Dana" }],
  members: [{ id: "p-dana", name: "Dana" }],
  forms: [{ id: "form-1", title: "Brief", questions: [{ id: "q-budget", label: "Budget" }] }],
  integrations: null,
  inboundEndpoints: [{ id: "ep-1", name: "Zapier" }],
  tags: [{ id: "tag-1", name: "Urgent", color: "red", archived: false }],
  taskTemplates: [{ id: "tt-1", name: "Checklist" }],
  otherProjects: [{ id: "proj-2", name: "Production", sections: [{ id: "s2", name: "Queue" }] }],
  workWeek: [0, 1, 2, 3, 4],
  projectName: "Requests",
  projectTemplates: [{ id: "tpl-1", name: "Event" }],
  portfolios: [{ id: "pf-1", name: "Events" }],
  v2: true,
  v3: true,
};

const pctx: PortfolioRuleContext = {
  portfolioName: "Campaigns",
  fields: [{ id: "pf-f", name: "Budget", fieldType: "single_select", options: [{ id: "o1", name: "Over", color: "red" }] }],
  people: [{ id: "p-dana", name: "Dana" }],
  members: [{ id: "p-dana", name: "Dana" }],
  otherPortfolios: [{ id: "pf-2", name: "Brand" }],
  projects: [{ id: "proj-1", name: "Spring launch" }],
  workWeek: [0, 1, 2, 3, 4],
};

const mctx: MyTaskRuleContext = {
  sections: [{ id: "ms-1", name: "Do today" }],
  projects: [{ id: "mp-1", name: "Website" }],
};

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const render = (node: ReactNode) => renderToStaticMarkup(<AppRouterContext.Provider value={router as never}>{node}</AppRouterContext.Provider>);

// ---------------------------------------------------------------------------------------------
// Samples: a value for each setting (and the words that show it), in these worlds
// ---------------------------------------------------------------------------------------------

type Sample = { value: Json; shows?: string };

function fieldSample(system: RuleSystem, fieldId: Json | undefined, op: Json | undefined): Sample {
  if (system === "portfolio") return { value: "o1", shows: "Over" };
  if (fieldId === "f-launch") return { value: "2026-11-01" };
  if (op === "one_of" || op === "none_of") return { value: ["o-web"], shows: "Web" };
  return { value: "o-web", shows: "Web" };
}

function sample(system: RuleSystem, step: RuleStep, p: RuleParam): Sample {
  const last = p.options?.[p.options.length - 1];
  switch (p.editor) {
    case "section":
      if (system === "my_tasks") return { value: "ms-1", shows: "Do today" };
      return step.project_id === "proj-2" ? { value: "s2", shows: "Queue" } : { value: "s-intake", shows: "Intake" };
    case "sections":
      return { value: ["s-intake"], shows: "Intake" };
    case "field":
      if (system === "portfolio") return { value: "pf-f", shows: "Budget" };
      // The address an email goes to sits in a text field (the picker lists only those).
      if (step.type === "send_email" && p.key === "field_id") return { value: "f-email", shows: "Client email" };
      return { value: "f-channel", shows: "Channel" };
    case "field_value":
      return fieldSample(system, step.field_id, step.op);
    case "option":
      return system === "portfolio" ? { value: "o1", shows: "Over" } : { value: "o-web", shows: "Web" };
    case "person":
      return { value: "p-dana", shows: "Dana" };
    case "people":
      return { value: ["p-dana"], shows: "Dana" };
    case "tag":
      return { value: "tag-1", shows: "Urgent" };
    case "form":
      return { value: "form-1", shows: "Brief" };
    case "question":
      return { value: "q-budget", shows: "Budget" };
    case "endpoint":
      return { value: "ep-1", shows: "Zapier" };
    case "project":
      return system === "my_tasks" ? { value: ["mp-1"], shows: "Website" } : { value: "proj-2", shows: "Production" };
    case "task_template":
      return { value: "tt-1", shows: "Checklist" };
    case "project_template":
      return { value: "tpl-1", shows: "Event" };
    case "portfolio":
      return system === "portfolio" ? { value: "pf-2", shows: "Brand" } : { value: "pf-1", shows: "Events" };
    case "choice":
      if (p.key === "left") return { value: "creator", shows: "Creator" };
      if (step.type === "field_compare" && p.key === "op") {
        const f = ctx.fields.find((x) => x.id === step.field_id);
        const op = compareOpsFor(f?.fieldType ?? "single_select")[0];
        return { value: op.value, shows: op.label };
      }
      assert.ok(last, `${step.type}.${p.key}: a choice lists its options`);
      return { value: last.value, shows: last.label };
    case "choices":
      assert.ok(last, `${step.type}.${p.key}: a list lists its options`);
      return { value: [last.value], shows: last.label };
    case "number":
      return { value: p.range ? Math.min(Math.max(5, p.range[0]), p.range[1]) : 5, shows: "5" };
    case "text":
      return p.key === "address" ? { value: "team@example.com", shows: "team@example.com" } : { value: "Hello world", shows: "Hello world" };
    case "titles":
      return { value: ["Draft"], shows: "Draft" };
    case "date":
      return { value: "2026-11-02", shows: "Nov 2" };
  }
}

// What a setting needs set first to apply at all (its `when`).
const BEFORE: Record<string, Record<string, Json>> = {
  "project.condition.source_is.form_id": { source: "form" },
  "project.condition.field_compare.to": { field_id: "f-launch", op: "between" },
  "project.condition.date_compare.to": { op: "between" },
  "project.action.send_email.field_id": { to: "field" },
  "project.action.send_email.address": { to: "address" },
  "project.action.set_assignee.people": { mode: "round_robin" },
  "project.action.set_due_date.date": { mode: "date" },
  "project.action.set_start_date.date": { mode: "date" },
  "project.action.add_to_project.section_id": { project_id: "proj-2" },
  "project.action.move_to_project.section_id": { project_id: "proj-2" },
  "project.action.set_description.text": { mode: "append" },
  "portfolio.condition.date_compare.to": { op: "between" },
  "portfolio.action.set_due_date.date": { mode: "date" },
};

// A step of this type with every required setting filled (settings that depend on others last), plus
// whatever `key` needs to apply.
function filledStep(system: RuleSystem, kind: StepKind, type: string, key?: string): RuleStep {
  const scope: StepScope = { system, kind };
  let step: RuleStep = { type, ...(key ? (BEFORE[`${system}.${kind}.${type}.${key}`] ?? {}) : {}) };
  for (let pass = 0; pass < 10; pass += 1) {
    // The setting under test gets its sample too (once it applies), then whatever that makes required.
    const own = key ? activeParams(step, scope).find((p) => p.key === key) : undefined;
    if (own && step[own.key] === undefined) step = { ...step, [own.key]: sample(system, step, own).value };
    const missing = missingParams(step, scope);
    if (missing.length === 0) break;
    for (const p of missing) step = { ...step, [p.key]: sample(system, step, p).value };
  }
  assert.deepEqual(stepProblems(step, scope), [], `${system} ${kind} ${type}: the samples fill every required setting`);
  return step;
}

function without(step: RuleStep, key: string): RuleStep {
  const copy = { ...step };
  delete copy[key];
  return copy;
}

function describe(system: RuleSystem, kind: StepKind, step: RuleStep): string {
  const { type, ...cfg } = step;
  if (system === "project") {
    if (kind === "trigger") return describeTrigger({ triggerType: type as TriggerType, triggerConfig: cfg }, ctx);
    return kind === "condition" ? describeCondition(step as never, ctx) : describeAction(step as never, ctx);
  }
  if (system === "portfolio") {
    if (kind === "trigger") return describePortfolioTrigger({ triggerType: type as never, triggerConfig: cfg }, pctx);
    return kind === "condition" ? describePortfolioCondition(step, pctx) : describePortfolioAction(step, pctx);
  }
  if (kind === "trigger") return describeMyTaskTrigger({ triggerType: type as never, triggerConfig: cfg });
  return kind === "condition" ? describeMyTaskCondition(step, mctx) : describeMyTaskAction(step, mctx);
}

// Every (system, kind, type, param) whose setting applies once its BEFORE is set.
function* everyParam() {
  for (const system of SYSTEMS) {
    for (const kind of KINDS) {
      for (const { value: type } of STEP_TYPES[system][kind]) {
        for (const p of stepParams(type, { system, kind }) ?? []) {
          const step = filledStep(system, kind, type, p.key);
          if (!activeParams(step, { system, kind }).includes(p)) continue;
          yield { system, kind, type, p, step };
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The builders, rendered with one step
// ---------------------------------------------------------------------------------------------

function projectRule(kind: StepKind, step: RuleStep): RuleDef {
  const { type, ...cfg } = step;
  return {
    id: "rule-1",
    projectId: "proj-1",
    name: "One step",
    enabled: true,
    triggerType: (kind === "trigger" ? type : "task_created") as TriggerType,
    triggerConfig: kind === "trigger" ? cfg : {},
    conditions: kind === "condition" ? [step as never] : [],
    actions: kind === "action" ? [step as never] : [{ type: "complete_task" }],
    presetKey: null,
  };
}

function renderBuilder(system: RuleSystem, kind: StepKind, step: RuleStep, world = ctx): string {
  const { type, ...cfg } = step;
  if (system === "project") {
    return render(
      <RuleCanvas projectId="proj-1" projectName="Requests" rule={projectRule(kind, step)} runs={[]} ctx={world} batch4 canEdit backHref="/x" />,
    );
  }
  if (system === "portfolio") {
    return render(
      <PortfolioRuleBuilder
        portfolioId="pf-1"
        rule={{
          id: "pr-1", portfolioId: "pf-1", name: "One step", enabled: true,
          triggerType: (kind === "trigger" ? type : "item_added") as never, triggerConfig: kind === "trigger" ? cfg : {},
          conditions: kind === "condition" ? [step] : [], actions: kind === "action" ? [step] : [{ type: "archive_project" }],
          ownerId: "p-dana", nextRunAt: null, pausedAt: null, pauseReason: null, lastEditedAt: null, pausedUntil: null,
        }}
        runs={[]}
        ctx={pctx}
        canEdit
      />,
    );
  }
  return render(
    <MyTaskRuleEditor
      rule={{
        id: "mr-1", name: "One step", enabled: true,
        triggerType: (kind === "trigger" ? type : "assigned") as never, triggerConfig: kind === "trigger" ? cfg : {},
        conditions: kind === "condition" ? [step] : [], actions: kind === "action" ? [step] : [{ type: "complete_task" }],
      }}
      ctx={mctx}
      onDone={() => {}}
    />,
  );
}

// The HTML inside a setting's slot (a display: contents <span data-param>), so a label shown elsewhere
// (the summary) doesn't count as the editor showing it.
function slotHtml(html: string, key: string): string | null {
  const start = html.indexOf(`data-param="${key}"`);
  if (start < 0) return null;
  const open = html.lastIndexOf("<span", start);
  const tag = /<\/?span\b[^>]*>/g;
  tag.lastIndex = open;
  let depth = 0;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(open, m.index + m[0].length);
  }
  return null;
}

const decode = (html: string) =>
  html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

// ---------------------------------------------------------------------------------------------
// The registry itself
// ---------------------------------------------------------------------------------------------

test("every trigger, condition, and action of every rule system declares its settings, each with an editor", () => {
  let steps = 0;
  for (const system of SYSTEMS) {
    for (const kind of KINDS) {
      for (const { value: type } of STEP_TYPES[system][kind]) {
        const params = stepParams(type, { system, kind });
        assert.ok(params, `${system} ${kind} “${type}” declares its settings in rule-params.ts`);
        steps += 1;
        const keys = new Set<string>();
        for (const p of params) {
          assert.ok(EDITORS.has(p.editor), `${system} ${kind} ${type}.${p.key}: “${p.editor}” is a known editor`);
          assert.ok(p.ask.trim().length > 3, `${system} ${kind} ${type}.${p.key}: says what to choose`);
          assert.ok(!keys.has(p.key), `${system} ${kind} ${type}.${p.key}: declared once`);
          keys.add(p.key);
        }
      }
    }
  }
  assert.ok(steps > 120, `walked ${steps} steps`);
});

test("a required setting left out is pointed out in the builder: its editor, highlighted, with a prompt, and Save waits", () => {
  let checked = 0;
  for (const { system, kind, type, p, step } of everyParam()) {
    if (!isRequired(p, step, { system, kind })) continue;
    const where = `${system} ${kind} ${type}.${p.key}`;
    const html = decode(renderBuilder(system, kind, without(step, p.key)));
    assert.match(html, new RegExp(`data-param="${p.key}" data-param-missing="true"`), `${where}: its editor is on screen and highlighted`);
    assert.ok(html.includes(p.ask), `${where}: the step says “${p.ask}”`);
    assert.match(html, /<button[^>]*disabled=""[^>]*>(Save|Create rule)</, `${where}: Save waits`);
    checked += 1;
  }
  assert.ok(checked > 80, `checked ${checked} required settings`);
});

test("a chosen setting reloads into its editor, with no prompt left", () => {
  for (const { system, kind, type, p, step } of everyParam()) {
    const where = `${system} ${kind} ${type}.${p.key}`;
    const html = decode(renderBuilder(system, kind, step));
    const slot = slotHtml(html, p.key);
    assert.ok(slot, `${where}: its editor is on screen`);
    assert.doesNotMatch(slot, /data-param-missing/, `${where}: not highlighted once chosen`);
    const shows = sample(system, step, p).shows;
    if (shows && p.editor !== "date" && p.editor !== "field_value") {
      assert.ok(slot.toLowerCase().includes(shows.toLowerCase()), `${where}: the editor shows “${shows}”\n${slot}`);
    }
    if (isRequired(p, step, { system, kind })) assert.ok(!html.includes(`data-step-prompt`), `${where}: nothing left to choose`);
  }
});

test("summaries say “(choose …)” for a missing setting and name every chosen value", () => {
  for (const { system, kind, type, p, step } of everyParam()) {
    const where = `${system} ${kind} ${type}.${p.key}`;
    const chosen = describe(system, kind, step);
    const missing = describe(system, kind, without(step, p.key));
    assert.doesNotMatch(chosen, /\((choose|enter|write|name) /i, `${where}: nothing to choose in “${chosen}”`);
    assert.doesNotMatch(chosen, /undefined|null|\[object/, `${where}: “${chosen}”`);
    if (isRequired(p, step, { system, kind })) {
      assert.match(missing, /\((choose|enter|write|name) /i, `${where}: missing reads “(choose …)”: “${missing}”`);
    }
    if (p.summary !== false) assert.notEqual(chosen, missing, `${where}: the summary shows the chosen value (“${chosen}”)`);
  }
});

// ---------------------------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------------------------

test("stepProblems says, in plain English, what a step still needs", () => {
  const action: StepScope = { system: "project", kind: "action" };
  assert.deepEqual(stepProblems({ type: "set_task_type" }, action), ["Choose a task type"]);
  assert.deepEqual(stepProblems({ type: "set_task_type", kind: "milestone" }, action), []);
  assert.deepEqual(stepProblems({ type: "complete_task" }, action), []);
  assert.deepEqual(stepProblems({ type: "no_such_action" }, action), ["Choose an action"]);
  // Depends on other settings.
  assert.deepEqual(stepProblems({ type: "send_email", to: "address" }, action), ["Enter an email address"]);
  assert.deepEqual(stepProblems({ type: "send_email", to: "address", address: "nope" }, action), ["Enter a valid email address"]);
  assert.deepEqual(stepProblems({ type: "send_email", to: "assignee" }, action), []);
  assert.deepEqual(stepProblems({ type: "set_due_date", mode: "date" }, action), ["Choose a date"]);
  assert.deepEqual(stepProblems({ type: "set_due_date", mode: "clear" }, action), []);
  // null is a choice where it means something (unassign); "" is a slot still to fill.
  assert.deepEqual(stepProblems({ type: "set_assignee", assignee: null }, action), []);
  assert.deepEqual(stepProblems({ type: "set_assignee", assignee: "" }, action), ["Choose who to assign"]);
  // Ranges.
  assert.deepEqual(stepProblems({ type: "delay", hours: 0 }, action), ["Enter how many hours to wait: from 0.1 to 720"]);
  // An optional list emptied out is refused by the database: say so.
  const trigger: StepScope = { system: "project", kind: "trigger" };
  assert.deepEqual(stepProblems({ type: "task_unblocked" }, trigger), []);
  assert.deepEqual(stepProblems({ type: "task_unblocked", kinds: [] }, trigger), ["Choose which dependencies"]);
  // "any section" arrives with Automations V3's database update.
  assert.deepEqual(stepProblems({ type: "section_changed" }, trigger), []);
  assert.deepEqual(stepProblems({ type: "section_changed" }, { ...trigger, v3: false }), ["Choose a section"]);
  // Portfolio and My Tasks rules.
  assert.deepEqual(stepProblems({ type: "set_status" }, { system: "portfolio", kind: "action" }), ["Choose a status"]);
  assert.deepEqual(stepProblems({ type: "task_type_is" }, { system: "my_tasks", kind: "condition" }), ["Choose a task type"]);
  assert.deepEqual(stepProblems({ type: "in_project", project_ids: [] }, { system: "my_tasks", kind: "condition" }), ["Choose projects"]);
});

test("ruleProblems says where each problem is, and Save's reason reads well", () => {
  const problems = ruleProblems(
    {
      triggerType: "section_left",
      triggerConfig: {},
      conditions: [{ type: "is_incomplete" }, { type: "has_tag" }],
      actions: [{ type: "complete_task" }, { type: "set_task_type" }],
    },
    "project",
  );
  assert.deepEqual(problems, ["When: Choose the section it leaves", "Condition 2: Choose a tag", "Action 2: Choose a task type"]);
  assert.equal(saveBlockedReason(problems), "Choose the section it leaves (when) and 2 more");
  assert.equal(saveBlockedReason(["Action 2: Choose a task type"]), "Choose a task type (action 2)");
  assert.equal(saveBlockedReason([]), null);
  // Branches name theirs.
  const branched = ruleProblems(
    {
      triggerType: "task_created",
      triggerConfig: {},
      conditions: [{ type: "is_complete" }],
      actions: [{ type: "complete_task" }, { type: "set_task_type", branch: 1 }],
    },
    "project",
  );
  assert.deepEqual(branched, ["Otherwise, action 1: Choose a task type"]);
});

test("Avi's case: Set task type shows its picker, asks for a type, and holds Save", () => {
  const html = renderBuilder("project", "action", { type: "set_task_type" });
  const slot = slotHtml(html, "kind");
  assert.ok(slot, "the task type picker is on screen");
  assert.match(slot, /choose a task type/, "the empty picker shows its placeholder (it used to be blank and invisible)");
  assert.match(html, /Choose a task type/, "the step says what it needs");
  assert.match(html, /make it \(choose a task type\)/, "the summary says so too");
  assert.match(html, /disabled=""[^>]*>Save</, "Save waits");
  const chosen = renderBuilder("project", "action", { type: "set_task_type", kind: "milestone" });
  assert.match(chosen, /make it a milestone/);
  assert.doesNotMatch(chosen, /data-step-prompt/);
});

test("the other three pickers that drew nothing show their placeholders", () => {
  const unblocked = slotHtml(renderBuilder("project", "trigger", { type: "task_unblocked" }), "kinds");
  assert.match(unblocked ?? "", /any dependency/);
  const decided = slotHtml(renderBuilder("project", "trigger", { type: "approval_decided" }), "statuses");
  assert.match(decided ?? "", /any decision/);
  const status = slotHtml(renderBuilder("portfolio", "trigger", { type: "status_changed" }), "statuses");
  assert.match(status ?? "", /any status/);
});

test("before V3's database update, Task moves into a section asks for a section", () => {
  const html = decode(renderBuilder("project", "trigger", { type: "section_changed" }, { ...ctx, v3: false }));
  assert.match(html, /data-param="section_id" data-param-missing="true"/);
  assert.ok(html.includes("Choose a section"));
});

// ---------------------------------------------------------------------------------------------
// Each editor kind: placeholder when empty, saves a choice, reloads it
// ---------------------------------------------------------------------------------------------

// Renders one step's editors with a probe, "picks" the sample through the editor of `key`, and returns
// the saved step and the HTML before / after.
function pick(system: RuleSystem, kind: StepKind, step: RuleStep, key: string, value: unknown) {
  const setters = new Map<string, (value: never) => void>();
  const probe: ParamProbe = { register: (param, set) => setters.set(param, set) };
  let saved: RuleStep | null = null;
  const fields = (s: RuleStep) => {
    const { type, ...cfg } = s;
    const onStep = (next: RuleStep) => (saved = next);
    const onConfig = (next: Record<string, Json>) => (saved = { type, ...next });
    if (system === "project") {
      if (kind === "trigger") return <TriggerFields prefix="t" triggerType={type as TriggerType} triggerConfig={cfg} ctx={ctx} onChange={onConfig} />;
      if (kind === "condition") return <ConditionFields prefix="t" condition={s as never} ctx={ctx} onChange={onStep as never} />;
      return <ActionFields projectId="proj-1" prefix="t" action={s as never} ctx={ctx} onChange={onStep as never} />;
    }
    if (system === "portfolio") {
      if (kind === "trigger") return <TriggerSettings triggerType={type as never} config={cfg} ctx={pctx} onChange={onConfig} />;
      if (kind === "condition") return <ConditionSettings c={s} ctx={pctx} onChange={onStep} />;
      return <ActionSettings a={s} ctx={pctx} onChange={onStep} />;
    }
    if (kind === "condition") return <MyTaskConditionFields c={s} ctx={mctx} onChange={onStep} />;
    return <MyTaskActionFields a={s} ctx={mctx} onChange={onStep} />;
  };
  const scope: StepScope = { system, kind };
  const draw = (s: RuleStep) =>
    decode(render(<StepParams missing={missingParams(s, scope).map((p) => p.key)}>{fields(s)}</StepParams>));
  const before = renderToStaticMarkup(
    <ParamProbeContext.Provider value={probe}>
      <StepParams missing={missingParams(step, scope).map((p) => p.key)}>{fields(step)}</StepParams>
    </ParamProbeContext.Provider>,
  );
  const set = setters.get(key);
  assert.ok(set, `${system} ${kind} ${step.type}.${key}: its editor takes a choice`);
  set(value as never);
  assert.ok(saved, `${system} ${kind} ${step.type}.${key}: the choice is saved into the step`);
  return { before: decode(before), saved: saved as RuleStep, after: draw(saved) };
}

// One step per editor kind (and each builder's own number / text boxes).
const EDITOR_CASES: { system: RuleSystem; kind: StepKind; step: RuleStep; key: string; value: unknown; placeholder: RegExp; shows: string }[] = [
  { system: "project", kind: "action", step: { type: "set_task_type" }, key: "kind", value: "milestone", placeholder: /choose a task type/, shows: "milestone" },
  { system: "project", kind: "trigger", step: { type: "task_unblocked" }, key: "kinds", value: ["start_to_start"], placeholder: /any dependency/, shows: "Start → start" },
  { system: "project", kind: "trigger", step: { type: "approval_decided" }, key: "statuses", value: ["rejected"], placeholder: /any decision/, shows: "rejected" },
  { system: "project", kind: "action", step: { type: "move_section" }, key: "section_id", value: "s-design", placeholder: /choose section/, shows: "Design" },
  { system: "project", kind: "condition", step: { type: "section_is_one_of" }, key: "section_ids", value: ["s-intake"], placeholder: /choose sections/, shows: "Intake" },
  { system: "project", kind: "condition", step: { type: "field_is_set" }, key: "field_id", value: "f-channel", placeholder: /choose field/, shows: "Channel" },
  { system: "project", kind: "condition", step: { type: "field_equals", field_id: "f-channel" }, key: "value", value: "o-web", placeholder: /choose option/, shows: "Web" },
  { system: "project", kind: "trigger", step: { type: "field_changed", field_id: "f-channel" }, key: "option_id", value: "o-web", placeholder: /to any value/, shows: "to Web" },
  { system: "project", kind: "action", step: { type: "request_approval", approver: "" }, key: "approver", value: "p-dana", placeholder: /choose (approver|person)/, shows: "Dana" },
  { system: "project", kind: "action", step: { type: "add_followers", people: [] }, key: "people", value: ["p-dana"], placeholder: /choose people/, shows: "Dana" },
  { system: "project", kind: "condition", step: { type: "has_tag" }, key: "tag_id", value: "tag-1", placeholder: /choose tag/, shows: "Urgent" },
  { system: "project", kind: "trigger", step: { type: "form_submitted" }, key: "form_id", value: "form-1", placeholder: /Any form/, shows: "Brief" },
  { system: "project", kind: "condition", step: { type: "form_answer_contains", text: "x" }, key: "question_id", value: "q-budget", placeholder: /in any answer/, shows: "Budget" },
  { system: "project", kind: "trigger", step: { type: "inbound_received" }, key: "endpoint_id", value: "ep-1", placeholder: /Any inbound webhook/, shows: "Zapier" },
  { system: "project", kind: "action", step: { type: "add_to_project" }, key: "project_id", value: "proj-2", placeholder: /choose project/, shows: "Production" },
  { system: "project", kind: "action", step: { type: "apply_task_template" }, key: "template_id", value: "tt-1", placeholder: /choose template/, shows: "Checklist" },
  { system: "project", kind: "action", step: { type: "convert_to_project" }, key: "template_id", value: "tpl-1", placeholder: /blank/, shows: "Event" },
  { system: "project", kind: "action", step: { type: "convert_to_project" }, key: "portfolio_id", value: "pf-1", placeholder: /no portfolio/, shows: "Events" },
  { system: "project", kind: "action", step: { type: "send_email" }, key: "to", value: "assignee", placeholder: /choose a recipient/, shows: "Assignee" },
  { system: "project", kind: "action", step: { type: "delay" }, key: "hours", value: 2, placeholder: /placeholder="24"/, shows: 'value="2"' },
  { system: "project", kind: "condition", step: { type: "due_within" }, key: "days", value: 4, placeholder: /aria-invalid="true"/, shows: 'value="4"' },
  { system: "project", kind: "condition", step: { type: "title_contains" }, key: "text", value: "video", placeholder: /placeholder="video"/, shows: 'value="video"' },
  { system: "project", kind: "action", step: { type: "add_comment" }, key: "body", value: "Ready", placeholder: /aria-invalid="true"/, shows: ">Ready<" },
  { system: "project", kind: "action", step: { type: "create_subtasks", titles: [] }, key: "titles", value: "Draft", placeholder: /aria-invalid="true"/, shows: 'value="Draft"' },
  { system: "project", kind: "condition", step: { type: "date_compare", date: "due", op: "before" }, key: "value", value: "2026-11-02", placeholder: /choose date/, shows: "Nov 2, 2026" },
  { system: "portfolio", kind: "trigger", step: { type: "status_changed" }, key: "statuses", value: ["complete"], placeholder: /any status/, shows: "to complete" },
  { system: "portfolio", kind: "action", step: { type: "set_status" }, key: "status", value: "on_hold", placeholder: /choose status/, shows: "On hold" },
  { system: "portfolio", kind: "action", step: { type: "set_owner" }, key: "person", value: "p-dana", placeholder: /choose person/, shows: "Dana" },
  { system: "portfolio", kind: "action", step: { type: "add_to_portfolio" }, key: "portfolio_id", value: "pf-2", placeholder: /choose portfolio/, shows: "Brand" },
  { system: "portfolio", kind: "action", step: { type: "set_name" }, key: "name", value: "Q4: {{project.name}}", placeholder: /aria-invalid="true"/, shows: 'value="Q4: {{project.name}}"' },
  { system: "portfolio", kind: "condition", step: { type: "due_within" }, key: "days", value: 7, placeholder: /aria-invalid="true"/, shows: 'value="7"' },
  { system: "portfolio", kind: "condition", step: { type: "field_equals", field_id: "pf-f" }, key: "value", value: "o1", placeholder: /choose option/, shows: "Over" },
  { system: "portfolio", kind: "condition", step: { type: "date_compare", op: "before" }, key: "value", value: "2026-12-01", placeholder: /choose date/, shows: "Dec 1, 2026" },
  { system: "my_tasks", kind: "condition", step: { type: "task_type_is" }, key: "kind", value: "approval", placeholder: /choose a task type/, shows: "Approval" },
  { system: "my_tasks", kind: "condition", step: { type: "in_project", project_ids: [] }, key: "project_ids", value: ["mp-1"], placeholder: /choose projects/, shows: "Website" },
  { system: "my_tasks", kind: "action", step: { type: "move_to_section", section_id: "" }, key: "section_id", value: "ms-1", placeholder: /choose section/, shows: "Do today" },
  { system: "my_tasks", kind: "action", step: { type: "set_due_date" }, key: "days", value: 3, placeholder: /aria-invalid="true"/, shows: 'value="3"' },
];

test("each editor kind shows its placeholder when empty, saves a choice, and reloads it", () => {
  for (const c of EDITOR_CASES) {
    const where = `${c.system} ${c.kind} ${c.step.type}.${c.key}`;
    const { before, saved, after } = pick(c.system, c.kind, c.step, c.key, c.value);
    const empty = slotHtml(before, c.key);
    assert.ok(empty, `${where}: the editor is on screen`);
    assert.match(empty, c.placeholder, `${where}: shows its placeholder while empty\n${empty}`);
    const expected = c.key === "titles" ? [c.value] : c.value;
    assert.deepEqual(saved[c.key], expected, `${where}: the choice is what's saved`);
    const full = slotHtml(after, c.key);
    assert.ok(full?.includes(c.shows), `${where}: reloads showing ${c.shows}\n${full}`);
    assert.doesNotMatch(full ?? "", /data-param-missing|aria-invalid="true"/, `${where}: no longer highlighted`);
    assert.doesNotMatch(after, /<select[\s>]|type="date"/, `${where}: the app's own pickers only`);
  }
  // Every editor kind the registry uses has a case here.
  const covered = new Set(EDITOR_CASES.map((c) => stepParams(c.step.type, c)?.find((p) => p.key === c.key)?.editor));
  for (const system of SYSTEMS) {
    for (const kind of KINDS) {
      for (const { value: type } of STEP_TYPES[system][kind]) {
        for (const p of stepParams(type, { system, kind }) ?? []) assert.ok(covered.has(p.editor), `editor “${p.editor}” (${type}.${p.key}) has a render test`);
      }
    }
  }
});
