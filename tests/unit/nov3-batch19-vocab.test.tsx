// Nov 3 notes (batch 19), automation vocabulary: When-grid presets (37.1 "Task assigned to me", 37.2 "Due date
// arrives" / "Due soon", 37.8 "Task is imported"), the tag steps greyed out (not hidden) while tags are off
// (37.4 / 39.3), required decisions and link kinds (37.5 / 37.6), In project / Is private conditions (39.3 /
// 39.4), and Set task type → Approval's setup (note 145).
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActionFields, ConditionFields, TriggerFields } from "@/components/rules/rule-editor";
import { vocabOptions } from "@/components/rules/rule-icons";
import { TAGS_OFF, describeAction, describeCondition, describeTrigger, vocabDisabled, type RuleContext } from "@/components/rules/rule-shared";
import { stepProblems } from "@/lib/rule-params";
import {
  CONDITIONS,
  TRIGGERS,
  TRIGGER_PRESETS,
  presetTrigger,
  triggerBlockLabel,
  triggerPickerValue,
} from "@/lib/rules";

const ctx: RuleContext = {
  sections: [{ id: "s-review", name: "Review" }, { id: "s-done", name: "Approved" }],
  fields: [],
  people: [{ id: "p-me", name: "Avi" }, { id: "p-dana", name: "Dana" }],
  members: [{ id: "p-me", name: "Avi" }, { id: "p-dana", name: "Dana" }],
  forms: [],
  integrations: null,
  inboundEndpoints: [],
  tags: [],
  viewerId: "p-me",
  readableProjects: [{ id: "proj-mkt", name: "Marketing" }],
  v2: true,
  v3: true,
};

test("When-grid presets are an existing trigger with its settings filled in", () => {
  assert.deepEqual(presetTrigger("preset:assigned_to_me", "p-me"), { triggerType: "assignee_changed", triggerConfig: { to: ["p-me"] } });
  assert.deepEqual(presetTrigger("preset:due_arrives", null), { triggerType: "due_approaching", triggerConfig: { days: 0 } });
  assert.deepEqual(presetTrigger("preset:due_soon", null), { triggerType: "due_approaching", triggerConfig: { days: 2 } });
  assert.deepEqual(presetTrigger("preset:imported", null), { triggerType: "task_created", triggerConfig: { via: "import" } });
  assert.equal(presetTrigger("task_created", null), null, "a plain trigger isn't a preset");
  for (const label of ["Task assigned to me", "Due date arrives", "Due soon", "Task is imported"]) {
    assert.ok(TRIGGER_PRESETS.some((p) => p.label === label), `the When grid lists “${label}”`);
  }
  assert.ok(TRIGGER_PRESETS.every((p) => TRIGGERS.some((t) => t.value === p.triggerType)), "every preset is a real trigger");
});

test("the block reads as the preset it matches", () => {
  assert.equal(triggerPickerValue("assignee_changed", { to: ["p-me"] }), "preset:assigned_to_me");
  assert.equal(triggerPickerValue("assignee_changed", {}), "assignee_changed");
  assert.equal(triggerPickerValue("due_approaching", { days: 0 }), "preset:due_arrives");
  assert.equal(triggerPickerValue("due_approaching", { days: 2 }), "due_approaching");
  assert.equal(triggerPickerValue("task_created", { via: "import" }), "preset:imported");
  assert.equal(triggerBlockLabel("assignee_changed", { to: ["p-me"] }, "p-me"), "Task assigned to me");
  assert.equal(triggerBlockLabel("assignee_changed", { to: ["p-dana"] }, "p-me"), "Task is assigned to");
  assert.equal(triggerBlockLabel("task_created", { via: "import" }), "Task is imported");
  assert.equal(triggerBlockLabel("task_completed", {}), "Task is completed");
});

test("summaries of the new trigger settings", () => {
  assert.equal(describeTrigger({ triggerType: "assignee_changed", triggerConfig: { to: ["p-me", "p-dana"] } }, ctx), "A task is assigned to Avi or Dana");
  assert.equal(describeTrigger({ triggerType: "assignee_changed", triggerConfig: {} }, ctx), "A task's assignee changes");
  assert.equal(describeTrigger({ triggerType: "task_created", triggerConfig: { via: "import" } }, ctx), "A task is added by an Asana import");
  assert.equal(describeTrigger({ triggerType: "due_approaching", triggerConfig: { days: 0 } }, ctx), "A task is due today");
});

test("decisions and link kinds are picked before saving (37.5, 37.6)", () => {
  const trigger = { system: "project", kind: "trigger" } as const;
  assert.deepEqual(stepProblems({ type: "approval_decided" }, trigger), ["Choose decisions"]);
  assert.deepEqual(stepProblems({ type: "approval_decided", statuses: ["approved"] }, trigger), []);
  assert.deepEqual(stepProblems({ type: "task_unblocked" }, trigger), ["Choose which dependencies"]);
  assert.deepEqual(stepProblems({ type: "task_unblocked", kinds: ["finish_to_start"] }, trigger), []);
  assert.match(describeTrigger({ triggerType: "approval_decided", triggerConfig: {} }, ctx), /\(choose decisions\)/);
});

test("tag steps stay in the pickers while tags are off, greyed out with the reason", () => {
  const off = { ...ctx, tagsEnabled: false };
  const triggers = vocabOptions(TRIGGERS, { disabled: vocabDisabled(off) });
  const tag = triggers.find((o) => o.value === "tag_added");
  assert.ok(tag, "still listed");
  assert.equal(tag.disabled, true);
  assert.equal(tag.disabledReason, TAGS_OFF);
  const kept = vocabOptions(CONDITIONS, { disabled: vocabDisabled(off, ["has_tag"]) }).find((o) => o.value === "has_tag");
  assert.ok(kept && !kept.disabled, "a step the automation already uses stays usable");
  const on = vocabOptions(TRIGGERS, { disabled: vocabDisabled({ ...ctx, tagsEnabled: true }) }).find((o) => o.value === "tag_added");
  assert.ok(on && !on.disabled);
});

test("In project / Is private conditions (39.3, 39.4)", () => {
  for (const value of ["in_project", "not_in_project", "is_private", "is_not_private"]) {
    assert.ok(CONDITIONS.some((c) => c.value === value), `${value} is offered`);
  }
  assert.ok(CONDITIONS.some((c) => /project/i.test(c.label)), "searching “project” finds one");
  assert.ok(CONDITIONS.some((c) => c.keywords.some((k) => k.includes("private"))), "searching “private” finds one");
  assert.equal(describeCondition({ type: "in_project", project_ids: ["proj-mkt"] }, ctx), "is in “Marketing”");
  assert.equal(describeCondition({ type: "not_in_project", project_ids: ["proj-mkt"] }, ctx), "isn’t in “Marketing”");
  assert.match(describeCondition({ type: "in_project" }, ctx), /\(choose projects\)/);
  assert.deepEqual(stepProblems({ type: "in_project" }, { system: "project", kind: "condition" }), ["Choose projects"]);
  const html = renderToStaticMarkup(<ConditionFields prefix="c" condition={{ type: "in_project", project_ids: ["proj-mkt"] }} ctx={ctx} onChange={() => {}} />);
  assert.match(html, /data-param="project_ids"/);
  assert.match(html, /Marketing/);
});

test("Set task type → Approval carries the approval's setup (note 145)", () => {
  const action = { system: "project", kind: "action" } as const;
  const step = {
    type: "set_task_type" as const,
    kind: "approval",
    approvers: ["p-dana"],
    approval_mode: "all",
    approval_due_days: 3,
    approval_business_days: true,
    after_approval: "move_section",
    after_section_id: "s-done",
    reminders: false,
    assignee: "p-me",
  };
  assert.deepEqual(stepProblems(step, action), []);
  assert.deepEqual(stepProblems({ type: "set_task_type", kind: "approval", after_approval: "move_section" }, action), ["Choose the section it moves to"]);
  assert.equal(
    describeAction(step, ctx),
    "make it an approval (approved by Dana, everyone must approve, due in 3 business days, then move it to Approved, no reminders, Avi does the work)",
  );
  assert.equal(describeAction({ type: "set_task_type", kind: "approval" }, ctx), "make it an approval");
  const html = renderToStaticMarkup(<ActionFields projectId="p" prefix="a" action={step} ctx={ctx} onChange={() => {}} part="block" />);
  for (const key of ["approvers", "approval_mode", "approval_due_days", "after_approval", "after_section_id", "assignee"]) {
    assert.match(html, new RegExp(`data-param="${key}"`), `${key} has its editor`);
  }
  assert.match(html, /Remind approvers/);
  const milestone = renderToStaticMarkup(<ActionFields projectId="p" prefix="a" action={{ type: "set_task_type", kind: "milestone" }} ctx={ctx} onChange={() => {}} part="block" />);
  assert.doesNotMatch(milestone, /approvers/, "no approval setup for a milestone");
});

test("Task is added by an import, and Task assigned to someone, have editors", () => {
  const via = renderToStaticMarkup(<TriggerFields prefix="t" triggerType="task_created" triggerConfig={{ via: "import" }} ctx={ctx} onChange={() => {}} />);
  assert.match(via, /data-param="via"/);
  assert.match(via, /by an Asana import/);
  const to = renderToStaticMarkup(<TriggerFields prefix="t" triggerType="assignee_changed" triggerConfig={{ to: ["p-me"] }} ctx={ctx} onChange={() => {}} />);
  assert.match(to, /data-param="to"/);
  assert.match(to, /Avi/);
});
