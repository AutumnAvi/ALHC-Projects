// Automations V3 (docs/AUTOMATIONS-GAP-CHECK.md §10): the builder's vocabulary and sentences. The
// database side (validation and the engine) runs in suite zz30.
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeAction, describeCondition, describeTrigger, needsUpdate, personName, personOptions, ruleSentence, type RuleContext } from "@/components/rules/rule-shared";
import { fieldOfSlot, fieldSlot, type RuleAction, type RuleCondition } from "@/lib/rules";
import type { FieldDef } from "@/lib/fields";

const field = (id: string, name: string, fieldType: string): FieldDef =>
  ({ id, name, fieldType, boundToSections: false, options: [], showInViews: false }) as unknown as FieldDef;

const ctx: RuleContext = {
  sections: [{ id: "s-intake", name: "Intake" }],
  fields: [field("f-designer", "Designer", "people"), field("f-notes", "Notes", "text")],
  people: [
    { id: "p-dana", name: "Dana" },
    { id: "p-sam", name: "Sam" },
  ],
  forms: [{ id: "form-brief", title: "Brief" }],
  integrations: null,
  inboundEndpoints: [],
  v2: true,
  v3: true,
};

const action = (a: Record<string, unknown>) => a as RuleAction;
const condition = (c: Record<string, unknown>) => c as RuleCondition;

test("People fields are person slots", () => {
  assert.equal(fieldSlot("f-designer"), "field:f-designer");
  assert.equal(fieldOfSlot("field:f-designer"), "f-designer");
  assert.equal(fieldOfSlot("assignee"), null);
  assert.equal(personName(ctx, "field:f-designer"), "the “Designer” field");
  assert.equal(personName(ctx, "field:gone"), "the removed People field");
  const options = personOptions(ctx);
  const slot = options.find((o) => o.value === "field:f-designer");
  assert.ok(slot, "the People field is offered");
  assert.equal(slot?.group, "People fields");
  assert.ok(!options.some((o) => o.value === "field:f-notes"), "a text field isn't");
  assert.equal(personOptions(ctx, { many: true }).find((o) => o.value === "field:f-designer")?.description, "Everyone in this field on the task");
  assert.equal(personOptions({ ...ctx, v3: false }).find((o) => o.value === "field:f-designer")?.disabled, true, "disabled before the update");
});

test("Set assignee reads round robin, least busy, and People fields", () => {
  assert.equal(describeAction(action({ type: "set_assignee", mode: "round_robin", people: ["p-dana", "p-sam"] }), ctx), "assign round robin among Dana and Sam");
  assert.equal(
    describeAction(action({ type: "set_assignee", mode: "balanced", people: ["p-dana", "field:f-designer", "p-sam"] }), ctx),
    "assign whoever has the fewest open tasks of Dana, the “Designer” field, and Sam",
  );
  assert.equal(describeAction(action({ type: "set_assignee", assignee: "field:f-designer" }), ctx), "assign the “Designer” field");
  assert.equal(describeAction(action({ type: "remove_followers", people: ["p-dana"] }), ctx), "remove follower Dana");
  assert.equal(describeAction(action({ type: "remove_followers", people: ["p-dana", "p-sam"] }), ctx), "remove followers Dana and Sam");
});

test("Compare people, a picked form, and the collaborator trigger", () => {
  assert.equal(describeCondition(condition({ type: "person_compare", left: "assignee", op: "is", people: ["creator"] }), ctx), "the assignee is the task creator");
  assert.equal(describeCondition(condition({ type: "person_compare", left: "assignee", op: "is_not", people: ["creator"] }), ctx), "the assignee isn’t the task creator");
  assert.equal(
    describeCondition(condition({ type: "person_compare", left: "field:f-designer", op: "is", people: ["p-sam"] }), ctx),
    "the “Designer” field includes Sam",
  );
  assert.equal(describeCondition(condition({ type: "person_compare", left: "followers", op: "is_not", people: ["p-dana"] }), ctx), "the collaborators don’t include Dana");
  assert.equal(describeCondition(condition({ type: "source_is", source: "form", form_id: "form-brief" }), ctx), "task came from “Brief”");
  assert.equal(describeCondition(condition({ type: "source_is", source: "form" }), ctx), "task came from a form");
  assert.equal(describeTrigger({ triggerType: "follower_added", triggerConfig: {} }, ctx), "A collaborator is added");
  assert.equal(describeTrigger({ triggerType: "follower_added", triggerConfig: { people: ["p-dana"] } }, ctx), "Dana starts following a task");
  assert.equal(
    ruleSentence({ triggerType: "follower_added", triggerConfig: {}, conditions: [], actions: [action({ type: "remove_followers", people: ["p-sam"] })] }, ctx),
    "When a collaborator is added, remove follower Sam.",
  );
});

test("V3 vocabulary is disabled until the database update is applied", () => {
  assert.equal(needsUpdate({ ...ctx, v3: false })("round_robin"), null, "not a vocabulary value");
  assert.ok(needsUpdate({ ...ctx, v3: false })("follower_added"));
  assert.ok(needsUpdate({ ...ctx, v3: false })("person_compare"));
  assert.ok(needsUpdate({ ...ctx, v3: false })("remove_followers"));
  assert.equal(needsUpdate(ctx)("remove_followers"), null);
  assert.ok(needsUpdate({ ...ctx, v2: false })("task_completed"), "V2's still apply");
});
