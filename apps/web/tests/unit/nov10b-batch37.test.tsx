// Nov 10 batch 37: the Nov 9 audits' leftovers (G19, C71, C72, C77, C79, C85, C100) and Avi's notes 182
// (a message to the external reviewer from the approval page) and 183 (a two-stage approval never
// completes its task by itself).
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { renderReviewEmail } from "@/lib/review-email";
import { filterChips } from "@/components/project/filter-editor";
import { completeModeOf, rowCompleteMode } from "@alhc/core/approval-complete";
import { approvalSetupSummary, defaultApprovalSetup } from "@alhc/core/approval-setup";
import { isTwoStageApproval } from "@alhc/core/external-review";
import type { FieldDef } from "@alhc/core/fields";

process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";

const TOKEN = `alhc_rev_${"a".repeat(64)}`;

function reviewEmail(message: string | null, reminder = false) {
  return renderReviewEmail({
    origin: "https://app.example.com",
    token: TOKEN,
    round: 1,
    recipientName: "Jordan Client",
    senderName: "Al Approver",
    taskTitle: "Spring brochure",
    projectName: "Creative requests",
    message,
    assets: [{ assetId: "00000000-0000-4000-8000-0000000000f1", name: "brochure.pdf", contentType: "application/pdf" }],
    reminder,
  });
}

test("182: the approver's message is in the first review email, and again in the reminder", () => {
  const note = "Please look at page 2 before Friday.";
  const first = reviewEmail(note);
  assert.ok(first.html.includes(note) && first.text.includes(note), "the first email carries it");
  const reminder = reviewEmail(note, true);
  assert.ok(reminder.html.includes(note) && reminder.text.includes(note), "so does the reminder");
  assert.ok(!reviewEmail(null).text.includes(note), "nothing when there's no message");
});

test("182: the approval page's card has a message box that goes to the Send review check screen", () => {
  const card = fs.readFileSync("src/components/task/external-review-steps.tsx", "utf8");
  assert.match(card, /data-external-message/);
  assert.match(card, /initialMessage=\{message\}/);
  const nudges = fs.readFileSync("src/lib/review-nudges.ts", "utf8");
  assert.match(nudges, /message: nudge\.message/, "the reminder reads the round's message");
});

test("183: two-stage = an approval task with approvers and an external reviewer", () => {
  const approval = { approverIds: ["al"], rounds: [] };
  const reviewer = { email: "client@example.org", name: null, source: "task" as const };
  assert.ok(isTwoStageApproval({ kind: "approval", approval, externalReview: { reviewer } }));
  assert.ok(!isTwoStageApproval({ kind: "approval", approval, externalReview: { reviewer: null } }), "internal only");
  assert.ok(!isTwoStageApproval({ kind: "approval", approval: { approverIds: [], rounds: [] }, externalReview: { reviewer } }));
  assert.ok(!isTwoStageApproval({ kind: "task", approval, externalReview: { reviewer } }));
});

test("183: after both approvals the assignee completes it; before, only approvers do", () => {
  const base = { kind: "approval" as const, completed: false, status: "approved" as const };
  assert.equal(completeModeOf({ ...base, isAssignee: true }), "approved", "not before the external approval");
  assert.equal(completeModeOf({ ...base, isAssignee: true, externallyApproved: true }), "complete");
  assert.equal(completeModeOf({ ...base, externallyApproved: true }), "approved", "not someone else");
  assert.equal(completeModeOf({ ...base, isApprover: true }), "complete", "approvers as before");
  const row = { kind: "approval" as const, completedAt: null, approvalStatus: "approved" as const, externalApproved: true };
  assert.equal(rowCompleteMode(row, false, true), "complete", "a row assigned to the viewer");
  assert.equal(rowCompleteMode(row, false, false), "approved");
});

test("183: the approval setup says a two-stage task stays open", () => {
  const draft = defaultApprovalSetup({ approverIds: ["al"] });
  assert.equal(approvalSetupSummary(draft, ["Al"]), "Al approves it, then the task is completed.", "single-stage unchanged");
  const two = approvalSetupSummary(draft, ["Al"], null, true);
  assert.match(two, /external reviewer/);
  assert.ok(!/completed\./.test(two), "never 'then the task is completed'");
  const dialog = fs.readFileSync("src/components/task/approval-setup-dialog.tsx", "utf8");
  assert.match(dialog, /TWO_STAGE_FOLLOW_UP_NOTE/);
  const migration = fs.readFileSync("../../supabase/migrations/20261110020000_nov10b_batch37_a.sql", "utf8");
  assert.ok(!/\b(drop|delete)\b/i.test(migration), "additive: no DROP / DELETE");
});

test("C71: a date field's filter chip reads like a date", () => {
  const field = { id: "f1", name: "Launch", fieldType: "date", options: [], boundToSections: false } as unknown as FieldDef;
  const chips = filterChips({ fields: [{ field_id: "f1", op: "equals", value: "2026-11-14" }] }, { sections: [], profiles: [], fields: [field] });
  assert.ok(chips.some((c) => /^Launch = Nov 14/.test(c.label)), chips.map((c) => c.label).join(" | "));
  assert.ok(!chips.some((c) => c.label.includes("2026-11-14")));
});

test("G19, C77, C79, C85, C100: routes and wording", () => {
  assert.ok(fs.existsSync("src/app/(app)/help/page.tsx") && fs.existsSync("src/app/(app)/settings/page.tsx"), "/help and /settings");
  const share = fs.readFileSync("src/components/project/share-dialog.tsx", "utf8");
  assert.ok(!share.includes("project admins"), "no 'project admins'");
  const messages = fs.readFileSync("src/components/messages/messages.tsx", "utf8");
  assert.ok(!messages.includes("Commenters and above can"), "no Commenter wording in Messages");
  const duplicate = fs.readFileSync("src/components/project/duplicate-project-dialog.tsx", "utf8");
  assert.ok(!duplicate.includes("request numbering"));
  const exportsSource = fs.readFileSync("src/lib/exports.ts", "utf8");
  assert.ok(!exportsSource.includes('"Task ID"'), "no Task ID column in any CSV");
});
