// Nov 4 notes, batch 27 — 161 (the approval as one compact row, feedback as pills next to the files) and
// 162 (an @person in a task's name stays there, as a chip linking to them).
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PeopleDirectoryProvider, TaskTitleText } from "@/components/task/title-text";
import { approvalPillText } from "@/components/task/task-approval-banner";
import { feedbackSnippet, feedbackSubtaskText, parseDecisionNote, roundFeedback, shortFileName } from "@alhc/core/approval-feedback";
import { approverDecisionNote } from "@alhc/core/approver-review";
import type { ApprovalRound, TaskApproval } from "@alhc/core/api/task-pane/model";
import { parseQuickAdd } from "@alhc/core/quick-add";
import { titleHasMentions, titleMentionHandle, titleMentionSegments } from "@alhc/core/title-mentions";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const render = (node: ReactNode) =>
  renderToStaticMarkup(<AppRouterContext.Provider value={router as never}>{node}</AppRouterContext.Provider>);

// ---------------------------------------------------------------------------------------------
// 161: feedback pills
// ---------------------------------------------------------------------------------------------

const files = [
  { id: "f1", fileName: "logo_autumn_lake_healthcare_at_arcola .pdf" },
  { id: "f2", fileName: "logo_autumn_lake_healthcare_at_alice_manor.pdf" },
  { id: "f3", fileName: "flyer: spring.png" },
];

function request(overrides: Partial<TaskApproval> = {}): TaskApproval {
  return {
    id: "q1",
    subtaskId: null,
    approverId: "sam",
    requestedBy: "ann",
    ruleName: null,
    note: null,
    status: "changes_requested",
    decidedAt: "2026-11-04T10:00:00Z",
    decisionNote: null,
    createdAt: "2026-11-04T09:00:00Z",
    ...overrides,
  };
}

function round(overrides: Partial<ApprovalRound> = {}): ApprovalRound {
  return {
    id: "r3",
    number: 3,
    status: "changes_requested",
    mode: "any",
    finalText: null,
    attachmentIds: ["f1", "f2", "f3"],
    moreSteps: false,
    afterApproval: "complete",
    moveSectionId: null,
    moveSectionName: null,
    dueOn: null,
    sentBy: "ann",
    sentAt: "2026-11-04T09:00:00Z",
    decidedBy: "sam",
    decidedAt: "2026-11-04T10:00:00Z",
    acknowledgedAt: null,
    withdrawnAt: null,
    requests: [],
    ...overrides,
  };
}

test("161: a decision note splits into its files' lines and the overall note (what the in-task review writes)", () => {
  const assets = files.map((f) => ({ id: f.id, name: f.fileName, contentType: "application/pdf", size: 1 }));
  const note = approverDecisionNote(
    assets,
    { f1: { approved: false, note: "Do better" }, f2: { approved: false, note: "Pools\nand the sky" }, f3: { approved: true, note: "" } },
    "Close!",
  );
  const parsed = parseDecisionNote(note, files.map((f) => f.fileName));
  assert.deepEqual(parsed.files, [
    { name: "logo_autumn_lake_healthcare_at_arcola .pdf", approved: false, text: "Do better" },
    { name: "logo_autumn_lake_healthcare_at_alice_manor.pdf", approved: false, text: "Pools\nand the sky" },
    { name: "flyer: spring.png", approved: true, text: "approved" },
  ]);
  assert.equal(parsed.overall, "Close!");
  // A plain note (no per-file lines) is the overall note; "✕" marks (as some fonts draw ✗) are read too.
  assert.deepEqual(parseDecisionNote("Make the logo bigger"), { files: [], overall: "Make the logo bigger" });
  assert.equal(parseDecisionNote("✕ a.pdf: Bigger").files[0].text, "Bigger");
});

test("161: the latest round's feedback as pills — amber for changes, red for rejected, green for approved files", () => {
  const changes = round({
    requests: [request({ decisionNote: "✗ logo_autumn_lake_healthcare_at_arcola .pdf: Do better\n✓ flyer: spring.png: approved\n\nThanks!" })],
  });
  const items = roundFeedback(changes, files);
  assert.deepEqual(
    items.map((i) => [i.kind, i.fileId, i.tone, i.text]),
    [
      ["file", "f1", "changes_requested", "Do better"],
      ["note", null, "changes_requested", "Thanks!"],
      ["file", "f3", "approved", ""],
    ],
    "feedback first; an approved file's bare “approved” has no text",
  );
  const rejected = roundFeedback(round({ status: "rejected", requests: [request({ status: "rejected", decisionNote: "Off brand" })] }), files);
  assert.equal(rejected[0].tone, "rejected");
  assert.deepEqual(roundFeedback(round({ status: "pending", requests: [request({ status: "pending" })] }), files), [], "nothing while it's pending");
  assert.deepEqual(roundFeedback(null, files), []);
});

test("161: short names and snippets for the pills, and the subtask text keeps the file", () => {
  const short = shortFileName("logo_autumn_lake_healthcare_at_alice_manor.pdf");
  assert.ok(short.length <= 24 && short.includes("…") && short.endsWith(".pdf"), short);
  assert.equal(shortFileName("flyer.png"), "flyer.png");
  assert.equal(feedbackSnippet("Pools\n  and   the sky"), "Pools and the sky");
  assert.ok(feedbackSnippet("x".repeat(100)).endsWith("…"));
  assert.equal(feedbackSubtaskText({ fileName: "a.pdf", text: "Bigger" }), "a.pdf: Bigger");
  assert.equal(feedbackSubtaskText({ fileName: null, text: "Bigger" }), "Bigger");
});

test("161: the summary pill says the status and the round; the block moved from the top to the fields", () => {
  assert.equal(approvalPillText("changes_requested", 3), "Changes requested · Round 3");
  assert.equal(approvalPillText("not_sent", null), "Not sent");
  assert.equal(approvalPillText("not_sent", 2), "Not sent", "a withdrawn round isn't a round in progress");
  const pane = fs.readFileSync("src/components/task/task-detail-panel.tsx", "utf8");
  assert.ok(pane.indexOf("<ApprovalTaskBanner") > pane.indexOf("</dl>"), "under the field rows, not at the top");
  assert.ok(pane.indexOf("<ApprovalFeedback") < pane.indexOf("<TaskAttachments"), "the feedback sits by the files");
});

// ---------------------------------------------------------------------------------------------
// 162: @mentions in task names
// ---------------------------------------------------------------------------------------------

const people = [
  { id: "u1", name: "Dana Diaz", email: "dana@example.com" },
  { id: "u2", name: "Sam Lee", email: "sam.lee@example.com" },
  { id: "u3", name: "Sam Ortiz", email: "ortiz@example.com" },
  { id: "u4", name: "ops@example.com", email: "ops@example.com" },
];

test("162: a title's @mentions are found by full name, email name, or a first name only one person has", () => {
  const segs = titleMentionSegments("Remember to message @Dana Diaz about @sam.lee's form", people);
  assert.deepEqual(
    segs.map((s) => (s.kind === "person" ? `[${s.person.id}:${s.text}]` : s.text)),
    ["Remember to message ", "[u1:@Dana Diaz]", " about ", "[u2:@sam.lee]", "'s form"],
  );
  assert.equal(titleMentionSegments("Call @dana", people)[1].kind, "person", "a unique first name, any case");
  assert.equal(titleMentionSegments("Call @Sam", people).length, 1, "two Sams: not a mention");
  assert.equal(titleMentionSegments("Call @Danaher", people).length, 1, "a name must end on a word boundary");
  assert.equal(titleMentionSegments("Email ann@dana.com", people).length, 1, "an email address isn't a mention");
  assert.equal(titleMentionSegments("(@Sam Lee)", people)[1].kind, "person");
  assert.ok(!titleHasMentions("No mentions here", people));
  assert.equal(titleMentionHandle(people[3]), "ops", "a person without a name is mentioned by their email name");
});

test("162: quick add keeps the @person in the name (under their full name) and never makes them the assignee", () => {
  const ctx = { today: "2026-11-04", projects: [], people };
  const parsed = parseQuickAdd("remember to message @dana tomorrow", ctx);
  assert.equal(parsed.title, "remember to message @Dana Diaz");
  assert.equal(parsed.person?.id, "u1");
  assert.equal(parsed.dueOn, "2026-11-05");
  // Big move 1: quick add's write lives in the layer (packages/core/src/api/my-tasks/mutations.ts).
  const actions = fs.readFileSync("../../packages/core/src/api/my-tasks/mutations.ts", "utf8");
  const at = actions.indexOf("export async function quickAddTask");
  const quick = actions.slice(at, actions.indexOf("\n}\n", at));
  assert.ok(!/assignee_id: mentionId/.test(quick), "the mention never becomes the assignee");
});

test("162: names draw mentions as chips — links in the pane, spans inside a row's link", () => {
  const plain = render(
    <PeopleDirectoryProvider people={people}>
      <TaskTitleText title="Remember to message @Dana Diaz" />
    </PeopleDirectoryProvider>,
  );
  assert.match(plain, /<a [^>]*href="\/people\/u1"[^>]*data-title-mention="u1"|<a [^>]*data-title-mention="u1"[^>]*href="\/people\/u1"/);
  assert.match(plain, />@Dana Diaz<\/a>/, "the chip shows the text as typed");
  const nested = render(
    <PeopleDirectoryProvider people={people}>
      <a href="/task">
        <TaskTitleText title="Remember to message @Dana Diaz" nested />
      </a>
    </PeopleDirectoryProvider>,
  );
  assert.ok(!/<a [^>]*>[^<]*<span[^>]*><a /.test(nested) && (nested.match(/<a /g) ?? []).length === 1, "no link inside the row's link");
  assert.match(nested, /<span [^>]*data-title-mention="u1"[^>]*>@Dana Diaz<\/span>/);
  assert.equal(render(<TaskTitleText title="No one here" />), "No one here");
});

test("162: List, Board, My tasks, and the pane draw names with TaskTitleText", () => {
  for (const file of [
    "src/components/project/list-view.tsx",
    "src/components/project/board-view.tsx",
    "src/components/my-tasks/checklist.tsx",
    "src/components/my-tasks/my-tasks-view.tsx",
    "src/components/task/task-detail-panel.tsx",
  ]) {
    assert.match(fs.readFileSync(file, "utf8"), /<TaskTitleText /, file);
  }
  const layout = fs.readFileSync("src/app/(app)/layout.tsx", "utf8");
  assert.match(layout, /<PeopleDirectoryProvider people=\{people\}>/);
});
