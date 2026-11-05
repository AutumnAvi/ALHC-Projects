// Nov 4 notes (batch 25): 158 "#" suggests before anything is typed (recents sent as ids), 159 approvals
// are decided only on the review page (the Inbox and emails open it), 160 the approval request email shows
// the round's files (stored thumbnails, else file cards), each opening the review page.
import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalNotificationParts, renderEmail } from "@/lib/email";
import type { OutboxRow } from "@/lib/email-layout";
import { EMAIL_GRID_FILES, emailFileList } from "@/lib/review-email";
import { thumbnailPath } from "@alhc/core/review-thumbnail-shared";
import { MAX_RECENTS, parseRecentRefs, recentRefsParam } from "@alhc/core/shell";

process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";

const TASK = "00000000-0000-4000-8000-0000000000a1";
const T2 = "00000000-0000-4000-8000-0000000000a2";
const P1 = "00000000-0000-4000-8000-0000000000b1";

function notification(payload: Record<string, unknown>): OutboxRow {
  return {
    id: "00000000-0000-4000-8000-0000000000e1",
    task_id: null,
    rule_id: null,
    to_email: "approver@example.net",
    template: "custom",
    subject: null,
    payload: { kind: "notification", ...payload },
    status: "sending",
    attempts: 1,
    last_error: null,
    provider_message_id: null,
    send_after: "2026-11-04T00:00:00Z",
    sent_at: null,
    created_at: "2026-11-04T00:00:00Z",
    updated_at: "2026-11-04T00:00:00Z",
    deleted_at: null,
    to_profile_id: null,
    comment_id: null,
    max_attempts: 5,
    delivery_status: null,
    delivery_event_at: null,
    delivery_detail: null,
  } as OutboxRow;
}

test("158: recents go to the link search as ids only, and come back checked", () => {
  const param = recentRefsParam([
    { kind: "task", id: TASK },
    { kind: "project", id: P1 },
  ]);
  assert.equal(param, `task:${TASK},project:${P1}`);
  assert.deepEqual(parseRecentRefs(param), [
    { kind: "task", id: TASK },
    { kind: "project", id: P1 },
  ]);
  assert.deepEqual(parseRecentRefs(`task:not-a-uuid,person:${T2},task:${T2}`), [{ kind: "task", id: T2 }], "junk is dropped");
  assert.deepEqual(parseRecentRefs(null), []);
  const many = Array.from({ length: 40 }, () => `task:${TASK}`).join(",");
  assert.equal(parseRecentRefs(many).length, MAX_RECENTS, "capped");
});

test("159: an approval request email opens the review page, never decides", () => {
  const email = renderEmail(
    notification({
      item_kind: "approval_requested",
      actor_name: "Avi Weinreb",
      title: "Bananas",
      context: "Test Project",
      detail: "Files attached for approval",
      task_id: TASK,
      path: `/projects/${P1}?task=${TASK}`,
      data: { approval_id: T2 },
    }),
  );
  assert.match(email.html, new RegExp(`href="https://app\\.example\\.com/approve/${TASK}"[^>]*>Open review<`));
  assert.ok(email.text.includes(`Open review: https://app.example.com/approve/${TASK}`));
  assert.ok(!/>Approve<|>Reject<|Request changes/.test(email.html), "no decision links");

  const reminder = approvalNotificationParts({ reminder: "overdue" }, "Avi", "“Bananas”");
  assert.equal(reminder.heading, "Reminder: approval overdue · “Bananas”");
  assert.equal(reminder.action, "Open review");
  assert.equal(approvalNotificationParts({ resubmitted: true }, "Avi", "“B”").heading, "Avi resubmitted “B” for your approval");
});

test("160: the approval email shows each file: a thumbnail when one is stored, else a file card", () => {
  const email = renderEmail(
    notification({
      item_kind: "approval_requested",
      actor_name: "Avi Weinreb",
      title: "Bananas",
      task_id: TASK,
      data: { approval_id: T2 },
    }),
    {
      approvalFiles: [
        { assetId: "f1", name: "flyer.pdf", contentType: "application/pdf", thumbnailUrl: "https://x.supabase.co/sign/thumb.jpg?token=t", thumbnailWidth: null },
        { assetId: "f2", name: "brief.docx", contentType: null, thumbnailUrl: null, thumbnailWidth: null },
      ],
    },
  );
  assert.match(email.html, /<img src="https:\/\/x\.supabase\.co\/sign\/thumb\.jpg\?token=t" alt="flyer\.pdf"/);
  assert.match(email.html, />DOCX<\/span>/, "a file card for a file without a preview");
  const reviewLinks = email.html.split(`href="https://app.example.com/approve/${TASK}"`).length - 1;
  assert.ok(reviewLinks >= 5, "each preview and name links to the review page, plus the button");
  assert.ok(email.text.includes("Files to review:\n- flyer.pdf\n- brief.docx"));

  const other = renderEmail(
    notification({ item_kind: "assigned", title: "Bananas", task_id: TASK, path: `/projects/${P1}?task=${TASK}` }),
    { approvalFiles: [{ assetId: "f1", name: "a.png", contentType: "image/png", thumbnailUrl: null, thumbnailWidth: null }] },
  );
  assert.ok(!other.html.includes("a.png"), "only approval requests show files");
  assert.match(other.html, />Open task</);
});

test("160: the file list caps what it shows and counts the rest; thumbnails live next to the file", () => {
  const files = Array.from({ length: EMAIL_GRID_FILES + 2 }, (_, i) => ({ assetId: `a${i}`, name: `f${i}.png`, contentType: "image/png" }));
  const html = emailFileList(files, () => "https://app.example.com/approve/x", "to review");
  assert.match(html, /And 2 more files to review\./);
  assert.equal(thumbnailPath(TASK, T2), `${TASK}/thumb-${T2}.jpg`);
});
