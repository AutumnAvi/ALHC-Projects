// Nov 1 notes, batch 10 (automations UX): live feedback notes (77), automatic names (76), the large
// When / If / Then picker (79, 80), and "Automations" wording (81).
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VocabPicker } from "@/components/rules/vocab-picker";
import { vocabOptions } from "@/components/rules/rule-icons";
import { AUTO_NAME_MAX, autoRuleName, effectiveRuleName, withTarget } from "@/lib/rule-autoname";
import {
  automationHref,
  feedbackNotes,
  feedbackSince,
  ranText,
  stopText,
  type FeedbackRun,
  type StopNote,
} from "@/lib/rule-feedback";
import { ACTIONS, CONDITIONS, TRIGGERS, runReason } from "@/lib/rules";
import { filterOptions } from "@/lib/smart-picker";
import { groupStep } from "@/lib/vocab-picker";

const run = (over: Partial<FeedbackRun>): FeedbackRun => ({
  id: Math.random().toString(36).slice(2),
  ruleId: "r1",
  ruleName: "Move to review",
  projectId: "p1",
  taskId: "t1",
  taskTitle: "Flyer",
  status: "succeeded",
  reason: null,
  createdAt: "2026-11-01T10:00:00Z",
  ...over,
});

test("77: runs of one automation become one note with a task count", () => {
  const notes = feedbackNotes([run({ taskId: "t1" }), run({ taskId: "t2", taskTitle: "Banner" }), run({ taskId: "t3" }), run({ taskId: "t1" })]);
  assert.equal(notes.length, 1);
  const [note] = notes;
  assert.equal(note.kind, "ran");
  if (note.kind !== "ran") return;
  assert.equal(note.taskCount, 3, "a task counts once");
  assert.equal(ranText(note), "Automation “Move to review” ran on 3 tasks");
  const one = feedbackNotes([run({})])[0];
  assert.ok(one.kind === "ran");
  assert.equal(ranText(one as never), "Automation “Move to review” ran on “Flyer”", "one readable task is named");
  const hidden = feedbackNotes([run({ taskTitle: null })])[0];
  assert.equal(ranText(hidden as never), "Automation “Move to review” ran on 1 task", "an unreadable task is never named");
});

test("77: loop protection, limits, and failures become warnings; other skips say nothing", () => {
  const notes = feedbackNotes([
    run({ ruleId: "r2", ruleName: "A to B", status: "skipped", reason: "loop" }),
    run({ ruleId: "r2", ruleName: "A to B", status: "skipped", reason: "loop" }),
    run({ ruleId: "r3", ruleName: "Long", status: "skipped", reason: "depth_limit", taskTitle: null }),
    run({ ruleId: "r4", ruleName: "Broken", status: "failed", reason: "Add to project: no access" }),
    run({ ruleId: "r5", status: "skipped", reason: "paused" }),
    run({ ruleId: "r6", ruleName: "Ran", status: "scheduled" }),
  ]);
  const stops = notes.filter((n): n is StopNote => n.kind === "stopped");
  assert.deepEqual(stops.map((s) => s.stop), ["loop", "depth_limit", "failed"], "one warning per automation, kind, and task");
  assert.equal(notes.filter((n) => n.kind === "ran").length, 1, "scheduled (waiting) runs count as ran");
  const loop = stops[0];
  assert.match(stopText(loop), /^Loop protection stopped an automation: “A to B” on “Flyer”\./);
  assert.equal(stops[1].taskId, null, "an unreadable task has no link");
  assert.match(stopText(stops[2]), /Add to project: no access/);
  assert.equal(automationHref("p1", "r2", "/projects/p1/list"), "/projects/p1/rules/r2?back=%2Fprojects%2Fp1%2Flist");
});

test("77: the first check reads back from the change's start; later ones from the cursor", () => {
  assert.deepEqual(feedbackSince(null, 1_000, 3_500), { within: 8 }, "2.5 s ago + 5 s slack, rounded up");
  assert.deepEqual(feedbackSince("2026-11-01T10:00:00.000Z", 0, 0), { since: "2026-11-01T10:00:00.000Z" });
  assert.equal(feedbackSince(null, 0, 10_000_000).within, 600, "never more than ten minutes");
  assert.match(runReason({ reason: "loop" }) ?? "", /changed it back/);
  assert.match(runReason({ reason: "depth_limit" }) ?? "", /ten/);
});

test("76: an unnamed automation is named from its steps", () => {
  assert.equal(autoRuleName("Task moves into “Review”", ["Move to “Done”"]), "When task moves into “Review” → Move to “Done”");
  assert.equal(autoRuleName("Task is completed", ["Add comment", "Notify", "Set field"]), "When task is completed → Add comment +2 more");
  assert.equal(autoRuleName("A field changes", []), "When a field changes");
  assert.equal(autoRuleName("", ["Notify"]), "When something happens → Notify");
  const long = autoRuleName("Task moves into “A really very long section name that goes on and on forever”", ["Move to “Another long section name”"]);
  assert.ok(long.length <= AUTO_NAME_MAX, `≤ ${AUTO_NAME_MAX}: ${long}`);
  assert.match(long, /…/);
  assert.equal(withTarget("Task moves into a section", "Review"), "Task moves into “Review”");
  assert.equal(withTarget("Move to section", "Done"), "Move to “Done”");
  assert.equal(withTarget("Move to my section", "Do today", /\bmy section\b/), "Move to “Do today”");
  assert.equal(withTarget("Set field", null), "Set field");
  assert.equal(effectiveRuleName("  Mine ", true, "When x"), "Mine", "a typed name wins");
  assert.equal(effectiveRuleName("", false, "When x"), "When x");
  assert.equal(effectiveRuleName("   ", true, "When x"), "When x", "an emptied box goes back to the automatic name");
});

test("79: every trigger, condition, and action is a tile in a group; ← → step through groups", () => {
  for (const list of [TRIGGERS, CONDITIONS, ACTIONS]) {
    const groups = filterOptions(vocabOptions(list), "");
    assert.ok(groups.every((g) => g.name), "every option has a group");
    assert.equal(groups.reduce((n, g) => n + g.options.length, 0), list.length, "nothing is left out");
    const first = groups[0].options[0].value;
    assert.equal(groupStep(groups, first, 1), groups[1].options[0].value);
    assert.equal(groupStep(groups, first, -1), groups[groups.length - 1].options[0].value, "wraps around");
    assert.equal(groupStep(groups, null, 1), first);
  }
  const groups = filterOptions(
    [
      { value: "a", label: "A", group: "One" },
      { value: "b", label: "B", group: "Two", disabled: true },
      { value: "c", label: "C", group: "Three" },
    ],
    "",
  );
  assert.equal(groupStep(groups, "a", 1), "c", "a group with nothing to pick is skipped");
});

test("80: the closed block reads as clickable and says how to change it", () => {
  const html = renderToStaticMarkup(
    <VocabPicker kind="trigger" label="Trigger" value="section_changed" options={vocabOptions(TRIGGERS)} onChange={() => {}} />,
  );
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /aria-label="Trigger: Task moves into a section\. Click to change"/);
  assert.match(html, /data-tooltip="Click to change the trigger"/);
  assert.match(html, /border-accent-300/, "a visible border");
  assert.match(html, /hover:bg-accent-100/, "a hover state");
  const add = renderToStaticMarkup(
    <VocabPicker kind="action" label="Add action" value={null} options={vocabOptions(ACTIONS)} onChange={() => {}} variant="ghost" renderValue={() => "Then…"} />,
  );
  assert.match(add, /btn-ghost/);
  assert.doesNotMatch(add, /Click to change/);
});

test("81: the builders say Automation, not Rule", () => {
  for (const file of [
    "src/components/rules/rule-canvas.tsx",
    "src/components/rules/rules-view.tsx",
    "src/components/project/customize-panel.tsx",
    "src/components/portfolio/portfolio-rules.tsx",
    "src/components/my-tasks/my-task-rules.tsx",
    "src/components/task/run-rule-dialog.tsx",
  ]) {
    const text = fs.readFileSync(file, "utf8");
    for (const phrase of ["\"Add rule", "Create rule", "Rule saved", "No rules yet", "\"Rules\"", "Delete rule", "Run a rule"]) {
      assert.ok(!text.includes(phrase), `${file} still says ${phrase}`);
    }
  }
});
