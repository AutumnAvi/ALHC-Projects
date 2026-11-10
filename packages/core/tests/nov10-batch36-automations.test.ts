// Nov 10 audit fixes (automations, forms): plain-word run-log inputs (C19), lost form branches (C36),
// the retired Request approval action (C26), the build permission (C10), and template wording (C18, C108).
import assert from "node:assert/strict";
import { test } from "node:test";
import { stepInputs } from "@alhc/core/rule-steps";
import { lostBranches, lostBranchesMessage, type FormQuestion } from "@alhc/core/forms";
import { ACTIONS, RETIRED_ACTIONS } from "@alhc/core/rules";
import { RULE_TEMPLATES } from "@alhc/core/rule-templates";
import { permissionsFor } from "@alhc/core/permissions";
import { describeMyTaskAction } from "@alhc/core/my-task-rules";

test("C19: run-log inputs read in plain words", () => {
  assert.deepEqual(stepInputs({ template: "requester_update" }), [{ label: "Email", value: "Requester update" }]);
  assert.deepEqual(stepInputs({ mode: "round_robin", person: "Dana" }), [
    { label: "How", value: "Round robin" },
    { label: "Person", value: "Dana" },
  ]);
  assert.deepEqual(stepInputs({ days: 3, unit: "days", business_days: true, from: "today" }), [
    { label: "Offset", value: "3 workdays" },
    { label: "From", value: "Today" },
  ]);
  assert.deepEqual(stepInputs({ days: 1, unit: "weeks", business_days: false, from: "due_date" }), [
    { label: "Offset", value: "1 week" },
    { label: "From", value: "The due date" },
  ]);
  assert.deepEqual(stepInputs({ kind: "milestone" }), [{ label: "Type", value: "Milestone" }]);
  assert.deepEqual(stepInputs({ status: "on_track" }), [{ label: "Status", value: "On track" }]);
  assert.deepEqual(stepInputs({ task_id: "x", text: "" }), []);
});

test("C36: a delete or type change that clears a branch is reported", () => {
  const before: FormQuestion[] = [
    { id: "a", type: "single_select", label: "Kind", options: [{ id: "o1", label: "Print" }] },
    { id: "b", type: "short_text", label: "Size", show_if: { question_id: "a", option_ids: ["o1"] } },
  ];
  const after: FormQuestion[] = [{ id: "b", type: "short_text", label: "Size" }];
  assert.deepEqual(lostBranches(before, after).map((q) => q.id), ["b"]);
  assert.match(lostBranchesMessage(lostBranches(before, after)), /“Size” now always shows/);
  assert.deepEqual(lostBranches(before, before), []);
});

test("C26: Request approval is retired from new steps, and its template is gone", () => {
  assert.ok(RETIRED_ACTIONS.has("request_approval"));
  assert.ok(ACTIONS.some((a) => a.value === "request_approval"), "an existing step still has its label");
  assert.ok(!RULE_TEMPLATES.some((t) => t.key === "review_approval"));
  assert.ok(!RULE_TEMPLATES.some((t) => t.build({ sections: [], fields: [], tags: [], otherProjects: [] }).actions.some((a) => a.type === "request_approval")));
});

test("C18 / C108: no broken due-date sentence, no duplicate comment notice", () => {
  assert.ok(!RULE_TEMPLATES.some((t) => t.key === "reply_notify"));
  const empty = { sections: [], fields: [], tags: [], otherProjects: [] };
  // Templates whose task may have no due date never print one.
  for (const t of RULE_TEMPLATES.filter((x) => ["stage_email", "handoff_comment", "rush_tag"].includes(x.key))) {
    const text = JSON.stringify(t.build(empty).actions);
    assert.ok(!/task\.due_date/.test(text), `${t.key} doesn't promise a date that may be empty`);
  }
});

test("C10: Owners and Editors build automations and forms", () => {
  assert.equal(permissionsFor("owner").canBuild, true);
  assert.equal(permissionsFor("editor").canBuild, true);
  assert.equal(permissionsFor("commenter").canBuild, false);
  assert.equal(permissionsFor("viewer").canBuild, false);
  assert.equal(permissionsFor("editor").canManage, false);
});

test("C72: one follower is “a follower”", () => {
  const ctx = { sections: [], projects: [], people: [{ id: "p1", name: "Dana" }, { id: "p2", name: "Sam" }] };
  assert.equal(describeMyTaskAction({ type: "add_followers", people: ["p1"] }, ctx), "add Dana as a follower");
  assert.equal(describeMyTaskAction({ type: "add_followers", people: ["p1", "p2"] }, ctx), "add Dana, Sam as followers");
});
