// Nov 2 notes, batch 17 (items 127–132): bulk automations, instant pins, the comment box, and feedback
// subtasks. Pure rules and server-renderable pieces (no migration in this batch).
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RequestConversationNotice } from "@/components/task/request-conversation";
import { settledPinOverrides, type PinOverride } from "@/components/task/pinned-comments-store";
import { bulkRuleRunMessage } from "@alhc/core/bulk";
import type { TaskDetail } from "@alhc/core/api/task-pane/model";
import { FEEDBACK_TITLE_MAX, feedbackSubtaskNotes, feedbackSubtaskTitle } from "@alhc/core/feedback-subtask";

test("127: the bulk run toast says what ran and what didn't", () => {
  assert.equal(bulkRuleRunMessage("Triage", { ran: 3, conditions: 0, skipped: 0, failed: 0, notInProject: 0 }), "Ran “Triage” on 3 tasks.");
  assert.equal(
    bulkRuleRunMessage("Triage", { ran: 1, conditions: 2, skipped: 1, failed: 1, notInProject: 1, firstError: "No section." }),
    "Ran “Triage” on 1 task · 2 tasks didn’t match its conditions · 1 task skipped (ran too often or would loop) · 1 task not in its project · 1 task failed: No section.",
  );
  assert.match(bulkRuleRunMessage("Triage", { ran: 0, conditions: 2, skipped: 0, failed: 0, notInProject: 0 }), /^“Triage” didn’t change any task/);
});

test("128: a pin override is forgotten only once this task's data agrees", () => {
  const overrides = new Map<string, PinOverride>([
    ["a", { taskId: "t1", pinnedAt: "2026-11-02T10:00:00Z" }],
    ["b", { taskId: "t1", pinnedAt: null }],
    ["c", { taskId: "t2", pinnedAt: null }],
  ]);
  // Still saving: the server has a unpinned and b pinned.
  assert.deepEqual(settledPinOverrides(overrides, "t1", (id) => (id === "b" ? "2026-11-01T00:00:00Z" : null)), []);
  // Saved: a pinned, b gone from the pinned ones. c belongs to another task and stays.
  assert.deepEqual(settledPinOverrides(overrides, "t1", (id) => (id === "a" ? "2026-11-02T10:00:01Z" : undefined)), ["a", "b"]);
  // The pin goes through no refresh (that was the 2 s wait).
  // Big move 1: the Server Action is a thin adapter (src/lib/actions/comments.ts).
  const actions = fs.readFileSync("src/lib/actions/comments.ts", "utf8");
  const at = actions.indexOf("export async function setCommentPinned");
  const pin = actions.slice(at, actions.indexOf("\n}\n", at));
  assert.match(pin, /refresh: false/, "setCommentPinned saves quietly");
});

test("129: posting reveals the new comment", () => {
  const source = fs.readFileSync("src/components/task/task-activity.tsx", "utf8");
  assert.match(source, /data-pending-comment=\{sending \? comment\.id : undefined\}/);
  assert.match(source, /revealPendingComment\(tempId\)/);
});

test("130: no 'Email conversation is on' banner and no Change", () => {
  const base = { email: "testmarketing@autumnhc.net", domain: "autumnhc.net", canOverride: true };
  const on = { submitterConversation: { ...base, allowed: true, reason: "verified" } } as unknown as TaskDetail;
  assert.equal(renderToStaticMarkup(<RequestConversationNotice task={on} />), "");
  const overridden = { submitterConversation: { ...base, allowed: true, reason: "override_request" } } as unknown as TaskDetail;
  assert.equal(renderToStaticMarkup(<RequestConversationNotice task={overridden} />), "");
  const off = { submitterConversation: { ...base, email: "x@gmail.com", domain: "gmail.com", allowed: false, reason: "unverified" } } as unknown as TaskDetail;
  const html = renderToStaticMarkup(<RequestConversationNotice task={off} />);
  assert.match(html, /Email conversation is off/);
  assert.doesNotMatch(html, /Change/);
});

test("131: feedback becomes a subtask name and a description with a link back", () => {
  assert.equal(feedbackSubtaskTitle("  Make the logo   bigger  \nand bluer"), "Make the logo bigger");
  assert.equal(feedbackSubtaskTitle("   \n "), "Follow up on feedback");
  const long = "word ".repeat(60).trim();
  const title = feedbackSubtaskTitle(long);
  assert.ok(title.length <= FEEDBACK_TITLE_MAX && title.endsWith("…"));
  const short = feedbackSubtaskNotes({ feedback: "Make the logo bigger", from: "Avi", link: "https://x/projects/p?task=t" });
  assert.equal(short, "Feedback from Avi on https://x/projects/p?task=t");
  const full = feedbackSubtaskNotes({ feedback: "Make the logo bigger\nand bluer", from: "Avi", link: null });
  assert.equal(full, "Feedback from Avi\n\nMake the logo bigger\nand bluer");
});

test("132: the submitter row stays on one line in a narrow comment box", () => {
  const source = fs.readFileSync("src/components/task/task-activity.tsx", "utf8");
  assert.match(source, /@container\/composer/);
  assert.match(source, /text-\[clamp\(0\.75rem,[^\]]+,0\.8125rem\)\]/);
  assert.match(source, /className="min-w-0 truncate text-accent-700 hover:underline"/);
  assert.doesNotMatch(source, /break-all text-accent-700/);
});
