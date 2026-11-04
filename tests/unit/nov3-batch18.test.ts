// Nov 3 notes, batch 18 (notes 133–139): the "#" link picker, the Automations page tabs, and the
// automation feedback wording. Pure rules.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { extendsDeadQuery, linkSearchText } from "@/lib/app-links";
import { feedbackNotes, firstChangingAction, ranText, type FeedbackRun } from "@/lib/rule-feedback";
import { rulesPageHref, rulesPageView } from "@/lib/rules-page";

test("133: # queries keep searching across spaces and stop once nothing matches", () => {
  assert.equal(linkSearchText("  facility   launch party "), "facility launch party");
  assert.equal(extendsDeadQuery("content calendar x", "content calendar"), true, "a longer name can't match more");
  assert.equal(extendsDeadQuery("content cal", "content calendar"), false, "backspacing searches again");
  assert.equal(extendsDeadQuery("12", "1"), false, "numbers match exactly");
  assert.equal(extendsDeadQuery("anything", null), false);
  const textarea = fs.readFileSync("src/components/task/mention-textarea.tsx", "utf8");
  assert.ok(textarea.includes("/api/link-search"), "the picker reads the GET route, not a Server Action");
  assert.ok(!textarea.includes("quickSearch"), "@ no longer searches tasks and projects");
});

test("134: the quick-add bar never assigns the @person", () => {
  const bar = fs.readFileSync("src/components/my-tasks/quick-add.tsx", "utf8");
  assert.ok(bar.includes("mentionId: what.person?.id"), "the @person goes as a follower");
  assert.ok(!bar.includes("assigneeId:"), "no assignee is sent");
});

test("137: the Automations page tabs", () => {
  assert.equal(rulesPageView("history"), "history");
  assert.equal(rulesPageView("templates"), "templates");
  assert.equal(rulesPageView("nope"), "automations");
  assert.equal(rulesPageHref("p1", "automations"), "/projects/p1/rules");
  assert.equal(rulesPageHref("p1", "history", "r1"), "/projects/p1/rules?view=history&rule=r1");
});

const run = (over: Partial<FeedbackRun>): FeedbackRun => ({
  id: Math.random().toString(36).slice(2),
  ruleId: "r1",
  ruleName: "Triage",
  projectId: "p1",
  taskId: "t1",
  taskTitle: "Flyer",
  status: "succeeded",
  reason: null,
  createdAt: "2026-11-03T10:00:00Z",
  action: "move_section",
  ...over,
});

test("138: a bulk run reads as what the automation did, once for all its tasks", () => {
  const [note] = feedbackNotes([run({ taskId: "t1" }), run({ taskId: "t2" }), run({ taskId: "t3" })]);
  assert.ok(note.kind === "ran");
  assert.equal(ranText(note as never), "Automation “Triage” moved 3 tasks");
  const [one] = feedbackNotes([run({ action: "add_comment" })]);
  assert.equal(ranText(one as never), "Automation “Triage” commented on “Flyer”");
  const [mixed] = feedbackNotes([run({ taskId: "t1" }), run({ taskId: "t2", action: "add_comment" })]);
  assert.equal(ranText(mixed as never), "Automation “Triage” ran on 2 tasks", "different steps: the plain wording");
  assert.equal(firstChangingAction({ actions: [{ type: "move_section", outcome: "unchanged" }, { type: "add_comment", outcome: "done" }] }), "add_comment");
  assert.equal(firstChangingAction(null), null);
});

test("138 / 139: every local write and every date change asks for automation feedback", () => {
  const session = fs.readFileSync("src/lib/optimistic-session.ts", "utf8");
  assert.ok(session.includes("requestRuleFeedback("), "ending a mutation asks (bulk bar included)");
  const shift = fs.readFileSync("src/components/task/dependency-shift.tsx", "utf8");
  assert.ok(shift.includes("requestRuleFeedback(startedAt)"), "date changes ask");
  const layer = fs.readFileSync("src/components/rules/rule-feedback.tsx", "utf8");
  assert.ok(layer.includes('message.table === "rule_runs"'), "a live update of the person's runs nudges a check");
});
