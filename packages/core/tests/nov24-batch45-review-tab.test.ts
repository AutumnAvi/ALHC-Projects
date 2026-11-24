// Nov 24 batch 45: the Review tab's pure data (packages/core/src/review-tab.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fileComments,
  mergeReviewRounds,
  outsideFileChip,
  reviewTabFiles,
  stepFile,
  teamFileChip,
} from "@alhc/core/review-tab";
import type { ApprovalRound, TaskApproval, TaskAttachment } from "@alhc/core/api/task-pane/model";
import type { TaskReviewRound } from "@alhc/core/review-checks";

const attachments: TaskAttachment[] = [
  { id: "a1", fileName: "flyer.png", contentType: "image/png", sizeBytes: 100, uploadedBy: "u", createdAt: "2026-12-01T00:00:00Z" },
  { id: "a2", fileName: "print.pdf", contentType: "application/pdf", sizeBytes: 200, uploadedBy: "u", createdAt: "2026-12-01T00:00:00Z" },
  { id: "a3", fileName: "photos.zip", contentType: "application/zip", sizeBytes: 300, uploadedBy: "u", createdAt: "2026-12-01T00:00:00Z" },
];

const request = (over: Partial<TaskApproval>): TaskApproval => ({
  id: "q1",
  subtaskId: null,
  approverId: "avi",
  requestedBy: "cg",
  ruleName: null,
  note: null,
  status: "pending",
  decidedAt: null,
  decisionNote: null,
  createdAt: "2026-12-05T10:00:00Z",
  ...over,
});

const teamRound = (over: Partial<ApprovalRound>): ApprovalRound => ({
  id: "r1",
  number: 1,
  status: "pending",
  mode: "any",
  finalText: null,
  attachmentIds: ["a1", "a2"],
  moreSteps: false,
  afterApproval: "complete",
  moveSectionId: null,
  moveSectionName: null,
  dueOn: null,
  sentBy: "cg",
  sentAt: "2026-12-05T10:00:00Z",
  decidedBy: null,
  decidedAt: null,
  acknowledgedAt: null,
  withdrawnAt: null,
  requests: [request({})],
  ...over,
});

const outsideRound = (over: Partial<TaskReviewRound>): TaskReviewRound => ({
  id: "o1",
  round: 1,
  status: "pending",
  recipientEmail: "sarah.k@glenoaks-al.com",
  recipientName: "Sarah K.",
  message: null,
  senderId: "avi",
  createdAt: "2026-12-06T10:00:00Z",
  expiresAt: "2027-01-05T10:00:00Z",
  decidedAt: null,
  decisionNote: null,
  lastViewedAt: null,
  draftSavedAt: null,
  assets: [
    { id: "x1", attachmentId: "a1", name: "flyer.png", contentType: "image/png", size: 100 },
    { id: "x2", attachmentId: "a2", name: "print.pdf", contentType: "application/pdf", size: 200 },
  ],
  pins: [],
  files: [],
  ...over,
});

const names: Record<string, string> = { avi: "Avi W.", isaiah: "Isaiah Rappaport", cg: "CA Green" };
const nameOf = (id: string) => names[id] ?? "Someone";
const roundFileNames = (r: Pick<ApprovalRound, "attachmentIds">) =>
  r.attachmentIds.flatMap((id) => attachments.filter((a) => a.id === id).map((a) => a.fileName));

test("the tab shows the latest team round's files, linked to the outside round that holds them", () => {
  const files = reviewTabFiles([teamRound({})], [outsideRound({})], attachments);
  assert.deepEqual(
    files.map((f) => [f.attachmentId, f.name, f.outsideAssetId]),
    [
      ["a1", "flyer.png", "x1"],
      ["a2", "print.pdf", "x2"],
    ],
  );
});

test("without a team round (an outside-only review) the tab shows the outside round's files", () => {
  const files = reviewTabFiles([], [outsideRound({})], attachments);
  assert.deepEqual(files.map((f) => f.outsideAssetId), ["x1", "x2"]);
  assert.deepEqual(reviewTabFiles([], [], attachments), []);
  // A team round whose files were all removed falls back to the outside round.
  assert.equal(reviewTabFiles([teamRound({ attachmentIds: ["gone"] })], [outsideRound({})], attachments).length, 2);
});

test("the team's chip reads each approver's per-file lines", () => {
  const file = { attachmentId: "a1", name: "flyer.png" };
  assert.equal(teamFileChip([teamRound({})], file, roundFileNames), "pending");
  assert.equal(teamFileChip([], file, roundFileNames), "waiting");
  const changes = teamRound({
    status: "changes_requested",
    requests: [request({ status: "changes_requested", decisionNote: "✗ flyer.png: Logo crowding the footer.\n✓ print.pdf: approved" })],
  });
  assert.equal(teamFileChip([changes], file, roundFileNames), "feedback");
  assert.equal(teamFileChip([changes], { attachmentId: "a2", name: "print.pdf" }, roundFileNames), "approved");
  const approved = teamRound({ status: "approved", requests: [request({ status: "approved", decisionNote: "Looks great" })] });
  assert.equal(teamFileChip([approved], file, roundFileNames), "approved");
  assert.equal(teamFileChip([teamRound({ status: "withdrawn" })], file, roundFileNames), "waiting");
});

test("the outside chip: locked until the team approves (sequential), then the round's answer", () => {
  const file = { attachmentId: "a1" };
  assert.equal(outsideFileChip([outsideRound({})], file, null), null);
  assert.equal(outsideFileChip([], file, "locked"), "locked");
  assert.equal(outsideFileChip([], file, "waiting"), "waiting");
  assert.equal(outsideFileChip([outsideRound({})], file, "current"), "pending");
  assert.equal(outsideFileChip([outsideRound({ status: "approved" })], file, "done"), "approved");
  const changes = outsideRound({
    status: "changes_requested",
    pins: [{ number: 1, assetId: "x1", page: null, x: 0.4, y: 0.5, time: null, body: "Brighter photo" }],
  });
  assert.equal(outsideFileChip([changes], file, "changes"), "feedback");
  assert.equal(outsideFileChip([changes], { attachmentId: "a2" }, "changes"), "answered");
  assert.equal(outsideFileChip([outsideRound({ status: "superseded" })], file, "waiting"), "waiting");
});

test("comments on a file: team notes numbered oldest first, outside pins keep their numbers", () => {
  const r1 = teamRound({
    status: "changes_requested",
    requests: [
      request({ id: "q1", status: "changes_requested", decidedAt: "2026-12-05T12:00:00Z", decisionNote: "✗ flyer.png: Logo crowding the footer." }),
    ],
  });
  const r2 = teamRound({
    id: "r2",
    number: 2,
    status: "changes_requested",
    requests: [
      request({
        id: "q2",
        status: "changes_requested",
        decidedAt: "2026-12-09T12:00:00Z",
        decisionNote: "✗ flyer.png: Brighter photo works. Crop in on the families?\n✓ print.pdf: approved",
      }),
    ],
  });
  const outside = outsideRound({
    status: "changes_requested",
    pins: [
      { number: 3, assetId: "x1", page: null, x: 0.2, y: 0.3, time: null, body: "Add families welcome" },
      { number: 4, assetId: "x2", page: 1, x: 0.5, y: 0.5, time: null, body: "Bleed" },
    ],
  });
  const list = fileComments({ attachmentId: "a1", name: "flyer.png" }, [r2, r1], [outside], { nameOf, roundFileNames });
  assert.deepEqual(
    list.map((c) => [c.role, c.number, c.authorName, c.round, c.text]),
    [
      ["team", 1, "Avi W.", 1, "Logo crowding the footer."],
      ["team", 2, "Avi W.", 2, "Brighter photo works. Crop in on the families?"],
      ["outside", 3, "Sarah K.", 1, "Add families welcome"],
    ],
  );
  assert.deepEqual(list[2].pin, { page: null, x: 0.2, y: 0.3, time: null });
  // An approved file has no comments.
  assert.deepEqual(fileComments({ attachmentId: "a2", name: "print.pdf" }, [r2], [], { nameOf, roundFileNames }), []);
});

test("rounds merge newest first with plain status words and role tones", () => {
  const merged = mergeReviewRounds(
    [
      teamRound({ id: "r2", number: 2, sentAt: "2026-12-09T10:00:00Z", requests: [request({ status: "pending" })] }),
      teamRound({
        id: "r1",
        number: 1,
        status: "changes_requested",
        sentAt: "2026-12-05T10:00:00Z",
        requests: [request({ status: "changes_requested" })],
      }),
    ],
    [outsideRound({ createdAt: "2026-12-06T10:00:00Z", status: "superseded" })],
    nameOf,
  );
  assert.deepEqual(
    merged.map((m) => [m.role, m.number, m.status, m.tone, m.open, m.fileCount]),
    [
      ["team", 2, "Waiting on Avi", "blue", true, 2],
      ["outside", 1, "Replaced by a newer round", "grey", false, 2],
      ["team", 1, "Changes requested by Avi", "amber", false, 2],
    ],
  );
  const everyone = mergeReviewRounds(
    [
      teamRound({
        mode: "all",
        requests: [request({ id: "a", approverId: "avi" }), request({ id: "b", approverId: "isaiah" })],
      }),
    ],
    [outsideRound({ status: "approved" })],
    nameOf,
  );
  assert.equal(everyone.find((m) => m.role === "team")?.status, "Waiting on Avi and Isaiah");
  assert.equal(everyone.find((m) => m.role === "outside")?.status, "Approved by Sarah");
  assert.equal(
    mergeReviewRounds([teamRound({ status: "withdrawn", closedReason: "outside_changes" })], [], nameOf)[0].status,
    "Ended: outside reviewer asked for changes",
  );
});

test("← / → wrap around the files", () => {
  assert.equal(stepFile(0, 3, 1), 1);
  assert.equal(stepFile(2, 3, 1), 0);
  assert.equal(stepFile(0, 3, -1), 2);
  assert.equal(stepFile(0, 0, 1), 0);
});
