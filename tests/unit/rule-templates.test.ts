// Automations V2, batch 3 — the templates gallery: about 20 recipes, built only from the rule
// vocabulary, filling sections / fields / tags by name and listing every slot they can't fill.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIONS, CONDITIONS, TRIGGERS } from "@/lib/rules";
import { RULE_TEMPLATES, TEMPLATE_CATEGORIES, findRuleTemplate } from "@/lib/rule-templates";

const empty = { sections: [], fields: [], tags: [], otherProjects: [] };
const full = {
  sections: ["Intake", "Video", "In progress", "Review", "Approved", "Done", "At risk"].map((name, i) => ({ id: `s${i}`, name })),
  fields: [
    { id: "f-type", name: "Request type", fieldType: "single_select", boundToSections: false, options: [{ id: "o-video", name: "Video" }] },
    { id: "f-pri", name: "Priority", fieldType: "single_select", boundToSections: false, options: [{ id: "o-low", name: "Low" }, { id: "o-high", name: "High" }] },
  ],
  tags: [{ id: "t-urgent", name: "Urgent", archived: false }],
  otherProjects: [{ id: "p-cal", name: "Creative calendar" }],
};
const PEOPLE = /^the (video lead|triage owner|reviewer|approver|designer)$/;

test("about twenty recipes, each in a known category, with unique keys", () => {
  assert.ok(RULE_TEMPLATES.length >= 20, `${RULE_TEMPLATES.length} templates`);
  const keys = new Set(RULE_TEMPLATES.map((t) => t.key));
  assert.equal(keys.size, RULE_TEMPLATES.length);
  const categories = new Set<string>(TEMPLATE_CATEGORIES.map((c) => c.value));
  for (const t of RULE_TEMPLATES) assert.ok(categories.has(t.category), t.key);
  for (const c of TEMPLATE_CATEGORIES) assert.ok(RULE_TEMPLATES.some((t) => t.category === c.value), `${c.label} has templates`);
  assert.equal(findRuleTemplate("review_assign")?.name, "Review → assign the reviewer");
  assert.equal(findRuleTemplate("nope"), null);
});

test("every recipe uses only the rule vocabulary", () => {
  const triggers = new Set<string>(TRIGGERS.map((t) => t.value));
  const conditions = new Set<string>(CONDITIONS.map((c) => c.value));
  const actions = new Set<string>(ACTIONS.map((a) => a.value));
  for (const t of RULE_TEMPLATES) {
    const built = t.build(full);
    assert.ok(triggers.has(built.triggerType), `${t.key}: trigger ${built.triggerType}`);
    for (const c of built.conditions) assert.ok(conditions.has(c.type), `${t.key}: condition ${c.type}`);
    assert.ok(built.actions.length >= 1 && built.actions.length <= 10, `${t.key}: 1–10 actions`);
    for (const a of built.actions) assert.ok(actions.has(a.type), `${t.key}: action ${a.type}`);
  }
});

test("a project with matching names leaves only people to pick", () => {
  for (const t of RULE_TEMPLATES) {
    const built = t.build(full);
    assert.deepEqual(built.missing.filter((m) => !PEOPLE.test(m)), [], `${t.key}: ${built.missing.join("; ")}`);
  }
  const review = findRuleTemplate("review_assign")!.build(full);
  assert.equal(review.triggerConfig.section_id, "s3", "“Review” matched by name");
  const overdue = findRuleTemplate("overdue_priority")!.build(full);
  assert.deepEqual(overdue.actions[0], { type: "set_field", field_id: "f-pri", value: "o-high" }, "Priority → High by name");
});

test("an empty project lists what to pick and leaves those slots empty", () => {
  const routed = findRuleTemplate("route_by_type")!.build(empty);
  assert.deepEqual(routed.missing, ["a Request type field with a “Video” option", "the video lead", "the section for video work"]);
  assert.equal(routed.conditions[0].field_id, "");
  assert.equal(findRuleTemplate("subtasks_done")!.build(empty).missing.length, 0, "some recipes need nothing");
});
