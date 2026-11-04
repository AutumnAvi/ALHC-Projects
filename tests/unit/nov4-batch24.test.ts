// Nov 4 notes, batch 24 (155–157): honest automation outcomes. A run whose steps didn't all do their job
// reads "Partly ran · 1 of 4 actions skipped" everywhere — the run history, the task's activity, the
// bottom-left notices (single and bulk) — never a green "Ran". Pure rules.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { runIsProblem, runVerb } from "@/lib/automation-activity";
import { bulkRuleRunMessage, bulkRuleRunTone } from "@/lib/bulk";
import { feedbackNotes, finishedRunsFromNotes, partialNoteSummary, ranText, type FeedbackRun } from "@/lib/rule-feedback";
import { entryNeedsAttention, entryStatus, indicatorLabel, type RunningEntry } from "@/lib/rule-running";
import { stepOutcomeLabel, stepTone } from "@/lib/rule-steps";
import {
  filterRuns,
  partialOf,
  runFilterLabel,
  runOutcome,
  runOutcomeText,
  stepWasMissed,
} from "@/lib/run-outcome";
import type { Json } from "@/lib/supabase/database.types";

// The run in the screenshot: three steps done, Send email to the form submitter with nobody to send to.
const screenshotRun: Json = {
  actions: [
    { step: 1, type: "add_comment", outcome: "done", result: "Commented: “OK cool”" },
    { step: 2, type: "create_subtasks", outcome: "done", result: "Created 1 subtask: “SUBBY!”" },
    { step: 3, type: "notify", outcome: "done", result: "Notified Avi Weinreb" },
    { step: 4, type: "send_email", outcome: "no_recipient", result: "No email address for the form submitter" },
  ],
};

const approvalRun: Json = {
  actions: [{ step: 1, type: "complete_task", outcome: "skipped", result: "Approval tasks are completed by their approvers" }],
};

test("157: a run with a skipped step is Partly ran, with the count and the first reason", () => {
  const outcome = runOutcome("succeeded", screenshotRun);
  assert.equal(outcome.tone, "partial");
  assert.equal(outcome.label, "Partly ran");
  assert.equal(outcome.summary, "1 of 4 actions skipped");
  assert.equal(runOutcomeText(outcome), "Partly ran · 1 of 4 actions skipped");
  assert.equal(outcome.reason, "No email address for the form submitter");
  assert.equal(outcome.attention, true);
  assert.equal(runOutcomeText(runOutcome("succeeded", approvalRun)), "Partly ran · 1 of 1 action skipped");
});

test("157: clean, waiting, skipped, and failed runs keep their own status", () => {
  const clean: Json = { actions: [{ type: "add_comment", outcome: "done" }, { type: "add_tag", outcome: "unchanged" }, { type: "request_approval", outcome: "already_open" }] };
  assert.equal(runOutcomeText(runOutcome("succeeded", clean)), "Ran", "already in that state isn't skipped");
  assert.equal(runOutcome("succeeded", clean).attention, false);
  assert.equal(runOutcome("succeeded", {}).tone, "ran", "no steps logged");
  assert.equal(runOutcome("scheduled", { actions: [{ type: "delay", outcome: "scheduled" }] }).label, "Waiting");
  assert.equal(runOutcome("scheduled", { actions: [{ type: "send_email", outcome: "no_recipient" }, { type: "delay", outcome: "scheduled" }] }).tone, "partial");
  assert.equal(runOutcome("skipped", { reason: "loop" }).label, "Skipped");
  assert.equal(runOutcome("failed", { actions: { error: "boom" } }).label, "Failed");
  assert.equal(runOutcome("failed", { actions: { error: "boom" } }).attention, true);
});

test("157: which step outcomes count as skipped", () => {
  for (const o of ["skipped", "blocked", "no_recipient", "no_approver", "no_person", "no_candidate", "locked", "missing_field", "missing_tag", "missing_template", "archived", "empty", "error"]) {
    assert.equal(stepWasMissed(o), true, o);
  }
  for (const o of ["done", "queued", "scheduled", "unchanged", "already_open", "would_send", "would_wait"]) {
    assert.equal(stepWasMissed(o), false, o);
  }
  // The step timeline draws them amber, not as "nothing to change".
  assert.equal(stepTone("no_recipient"), "attention");
  assert.equal(stepTone("skipped"), "attention");
  assert.equal(stepTone("unchanged"), "unchanged");
  assert.equal(stepTone("error"), "error");
  assert.equal(stepOutcomeLabel("blocked"), "Blocked");
});

test("157: Needs attention replaces Failed only and includes partly ran runs", () => {
  const runs = [
    { id: "a", status: "succeeded", detail: screenshotRun },
    { id: "b", status: "succeeded", detail: { actions: [{ type: "add_comment", outcome: "done" }] } as Json },
    { id: "c", status: "failed", detail: { actions: { error: "x" } } as Json },
    { id: "d", status: "skipped", detail: { reason: "loop" } as Json },
  ];
  assert.deepEqual(filterRuns(runs, "attention").map((r) => r.id), ["a", "c", "d"]);
  assert.equal(filterRuns(runs, "all").length, 4);
  assert.equal(runFilterLabel("attention", 3), "Needs attention (3)");
  assert.equal(runFilterLabel("attention", 0), "Needs attention");
  for (const file of ["src/components/rules/rule-canvas.tsx", "src/components/rules/rules-view.tsx"]) {
    const source = fs.readFileSync(file, "utf8");
    assert.ok(!source.includes("Failed only"), `${file} no longer says Failed only`);
    assert.ok(source.includes("runOutcome("), `${file} uses the shared helper`);
  }
  assert.ok(fs.readFileSync("src/components/portfolio/portfolio-rules.tsx", "utf8").includes("runOutcome("));
});

test("156 / 157: the task activity marker says partly ran and is amber", () => {
  const partial = partialOf("succeeded", approvalRun);
  assert.deepEqual(partial, { missed: 1, total: 1, reason: "Approval tasks are completed by their approvers" });
  assert.equal(partialOf("succeeded", { actions: [{ type: "add_comment", outcome: "done" }] }), null);
  assert.equal(partialOf("failed", screenshotRun), null, "a failed run isn't partial");
  const marker = { status: "succeeded" as const, reason: null, partial: partialOf("succeeded", screenshotRun) };
  assert.equal(runVerb(marker), "partly ran · 1 of 4 actions skipped");
  assert.equal(runIsProblem(marker), true);
  assert.equal(runVerb({ status: "succeeded", reason: null, partial: null }), "ran");
  assert.equal(runIsProblem({ status: "succeeded", reason: null }), false);
});

const feedbackRun = (over: Partial<FeedbackRun>): FeedbackRun => ({
  id: Math.random().toString(36).slice(2),
  ruleId: "r1",
  ruleName: "Triage",
  projectId: "p1",
  taskId: "t1",
  taskTitle: "Flyer",
  status: "succeeded",
  reason: null,
  createdAt: "2026-11-04T10:00:00Z",
  action: "add_comment",
  ...over,
});

test("156 / 157: the bottom-left notice says partly ran, never a clean ran", () => {
  const [note] = feedbackNotes([feedbackRun({ action: null, partial: partialOf("succeeded", approvalRun) })]);
  assert.equal(note.kind, "ran");
  if (note.kind !== "ran") return;
  assert.equal(ranText(note), "Automation “Triage” partly ran on “Flyer” · 1 of 1 action skipped");
  const [finished] = finishedRunsFromNotes([note]);
  assert.equal(finished.partial, true);
  assert.match(finished.detail ?? "", /Approval tasks are completed by their approvers/);

  const [many] = feedbackNotes([
    feedbackRun({ taskId: "t1", partial: { missed: 1, total: 4, reason: "No email address for the form submitter" } }),
    feedbackRun({ taskId: "t2", taskTitle: "Banner" }),
    feedbackRun({ taskId: "t3", taskTitle: "Poster", partial: { missed: 2, total: 4, reason: null } }),
  ]);
  if (many.kind !== "ran") throw new Error("expected a ran note");
  assert.equal(partialNoteSummary(many), "an action was skipped on 2 of 3 tasks");
  assert.equal(ranText(many), "Automation “Triage” partly ran on 3 tasks · an action was skipped on 2 of 3 tasks");

  const [clean] = feedbackNotes([feedbackRun({})]);
  if (clean.kind !== "ran") throw new Error("expected a ran note");
  assert.equal(clean.partial, null);
  assert.equal(ranText(clean), "Automation “Triage” commented on “Flyer”");
  assert.equal(finishedRunsFromNotes([clean])[0].partial, false);
});

const entry = (over: Partial<RunningEntry>): RunningEntry => ({
  key: "k",
  kind: "automation",
  ruleId: "r1",
  ruleName: "Triage",
  projectId: "p1",
  tasks: [],
  taskCount: 1,
  status: "ran",
  startedAt: 0,
  endedAt: 1,
  detail: null,
  ...over,
});

test("157: the running indicator shows Partly ran in amber", () => {
  assert.equal(entryStatus(entry({ status: "partial" })), "Partly ran");
  assert.equal(entryStatus(entry({ status: "skipped" })), "Skipped");
  assert.equal(entryNeedsAttention(entry({ status: "partial" })), true);
  assert.equal(entryNeedsAttention(entry({ status: "ran" })), false);
  assert.equal(indicatorLabel([entry({ status: "partial" }), entry({ status: "ran" })]), "An automation partly ran");
  assert.equal(indicatorLabel([entry({ status: "partial" }), entry({ status: "partial" })]), "2 automations partly ran");
  assert.equal(indicatorLabel([entry({ status: "ran" })]), "Ran 1 automation");
});

test("157: the bulk run counts partly ran tasks apart and goes amber", () => {
  const run = { ran: 2, conditions: 0, skipped: 0, failed: 0, notInProject: 0, partial: 1, firstSkipped: "No email address for the form submitter" };
  assert.equal(bulkRuleRunTone(run), "partial");
  assert.equal(
    bulkRuleRunMessage("Notify", run),
    "Ran “Notify” on 2 tasks · partly ran on 1 task (an action was skipped: No email address for the form submitter).",
  );
  const onlyPartial = { ran: 0, conditions: 0, skipped: 0, failed: 0, notInProject: 0, partial: 2 };
  assert.equal(bulkRuleRunMessage("Notify", onlyPartial), "“Notify” partly ran on 2 tasks (an action was skipped).");
  assert.equal(bulkRuleRunTone({ ran: 3, conditions: 0, skipped: 0, failed: 0, notInProject: 0 }), "ran");
  assert.equal(bulkRuleRunTone({ ran: 0, conditions: 0, skipped: 0, failed: 2, notInProject: 0 }), "failed");
  assert.equal(bulkRuleRunTone({ ran: 1, conditions: 0, skipped: 0, failed: 1, notInProject: 0 }), "partial");
  assert.equal(
    bulkRuleRunMessage("Notify", { ran: 0, conditions: 1, skipped: 0, failed: 0, notInProject: 0 }),
    "“Notify” didn’t change any task · 1 task didn’t match its conditions.",
  );
});
