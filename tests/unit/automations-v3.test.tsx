// Automations V3 (docs/AUTOMATIONS-GAP-CHECK.md §10): the builder's vocabulary and sentences. The
// database side (validation and the engine) runs in suite zz30.
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeAction, describeCondition, describeTrigger, needsUpdate, personName, personOptions, ruleSentence, scheduleLabel, scheduleWeekdays, type RuleContext } from "@/components/rules/rule-shared";
import { fieldOfSlot, fieldSlot, triggerOffset, type RuleAction, type RuleCondition } from "@/lib/rules";
import type { FieldDef } from "@/lib/fields";
import { dependencyConflict, earliestStart } from "@/lib/dependencies";

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

test("Compare people, a picked form, and the follower trigger", () => {
  assert.equal(describeCondition(condition({ type: "person_compare", left: "assignee", op: "is", people: ["creator"] }), ctx), "the assignee is the task creator");
  assert.equal(describeCondition(condition({ type: "person_compare", left: "assignee", op: "is_not", people: ["creator"] }), ctx), "the assignee isn’t the task creator");
  assert.equal(
    describeCondition(condition({ type: "person_compare", left: "field:f-designer", op: "is", people: ["p-sam"] }), ctx),
    "the “Designer” field includes Sam",
  );
  assert.equal(describeCondition(condition({ type: "person_compare", left: "followers", op: "is_not", people: ["p-dana"] }), ctx), "the followers don’t include Dana");
  assert.equal(describeCondition(condition({ type: "source_is", source: "form", form_id: "form-brief" }), ctx), "task came from “Brief”");
  assert.equal(describeCondition(condition({ type: "source_is", source: "form" }), ctx), "task came from a form");
  assert.equal(describeTrigger({ triggerType: "follower_added", triggerConfig: {} }, ctx), "A follower is added");
  assert.equal(describeTrigger({ triggerType: "follower_added", triggerConfig: { people: ["p-dana"] } }, ctx), "Dana starts following a task");
  assert.equal(
    ruleSentence({ triggerType: "follower_added", triggerConfig: {}, conditions: [], actions: [action({ type: "remove_followers", people: ["p-sam"] })] }, ctx),
    "When a follower is added, remove follower Sam.",
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

// ---------------------------------------------------------------------------------------------
// Batch B: dates
// ---------------------------------------------------------------------------------------------

test("date triggers read their offsets in hours, days, or weeks", () => {
  assert.deepEqual(triggerOffset({ days: 3 }), { amount: 3, unit: "days" });
  assert.deepEqual(triggerOffset({ amount: 4, unit: "hours" }), { amount: 4, unit: "hours" });
  assert.deepEqual(triggerOffset({}, 0), { amount: 0, unit: "days" });
  assert.equal(describeTrigger({ triggerType: "due_approaching", triggerConfig: { amount: 4, unit: "hours" } }, ctx), "A task is due in 4 hours");
  assert.equal(describeTrigger({ triggerType: "due_approaching", triggerConfig: { days: 0 } }, ctx), "A task is due today");
  assert.equal(describeTrigger({ triggerType: "start_approaching", triggerConfig: { amount: 1, unit: "weeks" } }, ctx), "A task starts in 1 week");
  assert.equal(describeTrigger({ triggerType: "start_reached", triggerConfig: {} }, ctx), "A task’s start date arrives");
  assert.equal(describeTrigger({ triggerType: "start_reached", triggerConfig: { amount: 2, unit: "days" } }, ctx), "A task started 2 days ago");
  assert.equal(describeTrigger({ triggerType: "task_overdue", triggerConfig: { days: 1 } }, ctx), "A task becomes overdue");
  assert.equal(describeTrigger({ triggerType: "task_overdue", triggerConfig: { amount: 6, unit: "hours" } }, ctx), "A task is 6 hours overdue");
  assert.equal(describeTrigger({ triggerType: "start_date_changed", triggerConfig: { change: "cleared" } }, ctx), "A start date is cleared");
  assert.equal(describeTrigger({ triggerType: "due_date_changed", triggerConfig: {} }, ctx), "A due date changes");
});

test("schedules read with minutes, every N, and several weekdays", () => {
  assert.equal(scheduleLabel({ frequency: "daily", hour: 9 }), "Every day at 9:00 AM");
  assert.equal(scheduleLabel({ frequency: "daily", hour: 14, minute: 30, interval: 3 }), "Every 3 days at 2:30 PM");
  assert.equal(scheduleLabel({ frequency: "weekly", weekdays: [4, 1], interval: 2, hour: 8 }), "Every 2 weeks on Monday and Thursday at 8:00 AM");
  assert.equal(scheduleLabel({ frequency: "weekly", weekday: 0 }), "Every week on Sunday at 9:00 AM");
  assert.deepEqual(scheduleWeekdays({ weekdays: [3, 1, 3] }), [1, 3]);
});

test("date conditions and actions read as sentences", () => {
  assert.equal(
    describeCondition(condition({ type: "date_compare", date: "start", op: "between", value: "2026-11-01", to: "2026-11-30" }), ctx),
    "the start date is between Nov 1, 2026 and Nov 30, 2026",
  );
  assert.equal(describeCondition(condition({ type: "date_compare", date: "due", op: "before", value: "2026-12-24" }), ctx), "the due date is before Dec 24, 2026");
  assert.equal(describeCondition(condition({ type: "has_started" }), ctx), "its start date has arrived");
  assert.equal(describeCondition(condition({ type: "start_within", days: 0 }), ctx), "starts today");
  assert.equal(describeAction(action({ type: "set_start_date", mode: "date", date: "2026-11-02" }), ctx), "set the start date to Nov 2, 2026");
  assert.equal(describeAction(action({ type: "set_start_date", days: 0, from: "today" }), ctx), "set the start date to today");
  assert.equal(describeAction(action({ type: "set_due_date", days: 2, unit: "weeks", from: "start_date" }), ctx), "set the due date to 2 weeks from the start date");
  assert.equal(describeAction(action({ type: "set_due_date", days: 4, unit: "hours" }), ctx), "set the due date to 4 hours from now");
  assert.equal(describeAction(action({ type: "set_due_date", days: 1, business_days: true }), ctx), "set the due date to 1 business day from today");
  assert.equal(describeAction(action({ type: "set_start_date", mode: "clear" }), ctx), "clear the start date");
});

// ---------------------------------------------------------------------------------------------
// Batch C: flow
// ---------------------------------------------------------------------------------------------

test("flow triggers, conditions, and actions read as sentences", () => {
  assert.equal(describeTrigger({ triggerType: "task_unblocked", triggerConfig: {} }, ctx), "A task is no longer blocked by any dependency");
  assert.equal(
    describeTrigger({ triggerType: "task_unblocked", triggerConfig: { kinds: ["start_to_start", "finish_to_finish"] } }, ctx),
    "A task is no longer blocked by a start → start or finish → finish dependency",
  );
  assert.equal(describeTrigger({ triggerType: "section_changed", triggerConfig: {} }, ctx), "A task moves to another section");
  assert.equal(describeTrigger({ triggerType: "section_left", triggerConfig: { section_id: "s-intake" } }, ctx), "A task moves out of Intake");
  assert.equal(describeTrigger({ triggerType: "task_type_changed", triggerConfig: { kind: "approval" } }, ctx), "A task becomes an approval");
  assert.equal(describeCondition(condition({ type: "section_is_none_of", section_ids: ["s-intake"] }), ctx), "section isn’t Intake");
  assert.equal(describeCondition(condition({ type: "approval_status_is", statuses: ["none", "rejected"] }), ctx), "approval status is no approval or rejected");
  assert.equal(describeCondition(condition({ type: "task_type_is_not", kind: "milestone" }), ctx), "task type isn’t Milestone");
  assert.equal(describeCondition(condition({ type: "is_blocked" }), ctx), "is blocked");
  assert.equal(
    describeAction(action({ type: "create_task", kind: "milestone", title: "Launch", assignee: "creator", link: "blocked_by" }), ctx),
    "create a milestone “Launch” for the task creator waiting on this one",
  );
  assert.equal(describeAction(action({ type: "set_task_type", kind: "approval" }), ctx), "make it an approval");
  assert.equal(describeAction(action({ type: "set_description", mode: "append", text: "x" }), ctx), "add “x” to the end of the description");
  assert.equal(describeAction(action({ type: "remove_from_project" }), ctx), "remove from this project");
});

test("all four dependency kinds", () => {
  const pred = { startOn: "2026-11-02", dueOn: "2026-11-06" };
  assert.equal(earliestStart(pred, "finish_to_finish", 1), "2026-11-07");
  assert.equal(earliestStart(pred, "start_to_finish", 0), "2026-11-02");
  assert.ok(dependencyConflict(pred, { startOn: "2026-11-01", dueOn: "2026-11-05" }, "finish_to_finish", 0), "finishes before");
  assert.ok(!dependencyConflict(pred, { startOn: "2026-11-01", dueOn: "2026-11-06" }, "finish_to_finish", 0), "finishes the same day");
  assert.ok(!dependencyConflict(pred, { startOn: "2026-10-20", dueOn: "2026-11-02" }, "start_to_finish", 0), "start → finish");
});
