// Nov 5 notes, batch 29 — 164 (an Inbox approval opens its review page), 165 (compact Attachments), and
// 166 (feedback subtasks named feedback first, the file as an id-based chip).
import assert from "node:assert/strict";
import { test } from "node:test";
import { approverReviewHref, inboxReviewHref } from "../src/approver-review";
import { COMPACT_ATTACHMENT_LIMIT, attachmentRows, fileTypeKind } from "../src/attachment-list";
import { FEEDBACK_TITLE_MAX, feedbackAssetTitle, feedbackSubtaskNotes, feedbackSubtaskTitle } from "../src/feedback-subtask";
import { assetRefLine, parseAssetRefs, titleAssetSegments, titleAssetsFor } from "../src/title-assets";

const FILE = "0f1e2d3c-4b5a-4968-8776-655443322110";
const OTHER = "11111111-2222-4333-8444-555555555555";

// ---------------------------------------------------------------------------------------------
// 164
// ---------------------------------------------------------------------------------------------

test("164: an approval the viewer still decides opens its review page — requests, resubmissions, reminders", () => {
  const pending = { kind: "approval_requested", taskId: "t1", approval: { status: "pending", approverId: "me" } };
  assert.equal(inboxReviewHref(pending, "me"), approverReviewHref("t1"));
  assert.equal(inboxReviewHref(pending, "me"), "/approve/t1");
  // A reminder is the same kind of item (data.reminder), so it goes there too.
  assert.equal(inboxReviewHref({ ...pending }, "me"), "/approve/t1");
  // An item whose request couldn't be read still goes to the review page (it sends older requests on).
  assert.equal(inboxReviewHref({ kind: "approval_requested", taskId: "t1", approval: null }, "me"), "/approve/t1");
});

test("164: decided, cancelled, someone else's, or not an approval request → the task as before", () => {
  const base = { kind: "approval_requested", taskId: "t1" };
  for (const status of ["approved", "changes_requested", "rejected", "cancelled"]) {
    assert.equal(inboxReviewHref({ ...base, approval: { status, approverId: "me" } }, "me"), null, status);
  }
  assert.equal(inboxReviewHref({ ...base, approval: { status: "pending", approverId: "sam" } }, "me"), null);
  assert.equal(inboxReviewHref({ kind: "approval_decided", taskId: "t1", approval: null }, "me"), null);
  assert.equal(inboxReviewHref({ kind: "comment", taskId: "t1", approval: null }, "me"), null);
  assert.equal(inboxReviewHref({ kind: "approval_requested", taskId: null, approval: null }, "me"), null);
});

// ---------------------------------------------------------------------------------------------
// 165
// ---------------------------------------------------------------------------------------------

test("165: the compact list shows the first few names; Show all and Previews show everything", () => {
  assert.equal(COMPACT_ATTACHMENT_LIMIT, 4);
  assert.deepEqual(attachmentRows(0, "compact"), { shown: 0, hidden: 0 });
  assert.deepEqual(attachmentRows(3, "compact"), { shown: 3, hidden: 0 });
  assert.deepEqual(attachmentRows(4, "compact"), { shown: 4, hidden: 0 });
  // One more than the limit: just show it rather than "Show 1 more".
  assert.deepEqual(attachmentRows(5, "compact"), { shown: 5, hidden: 0 });
  assert.deepEqual(attachmentRows(9, "compact"), { shown: 4, hidden: 5 });
  assert.deepEqual(attachmentRows(9, "all"), { shown: 9, hidden: 0 });
  assert.deepEqual(attachmentRows(9, "previews"), { shown: 9, hidden: 0 });
  assert.deepEqual(attachmentRows(9, "compact", 2), { shown: 2, hidden: 7 });
});

test("165: a file's small icon comes from its extension, else its content type", () => {
  assert.equal(fileTypeKind("logo.PNG"), "image");
  assert.equal(fileTypeKind("brief.pdf"), "pdf");
  assert.equal(fileTypeKind("clip.mov"), "video");
  assert.equal(fileTypeKind("budget.xlsx"), "sheet");
  assert.equal(fileTypeKind("deck.pptx"), "slides");
  assert.equal(fileTypeKind("notes.docx"), "doc");
  assert.equal(fileTypeKind("assets.zip"), "archive");
  assert.equal(fileTypeKind("cover.psd"), "design");
  assert.equal(fileTypeKind("voice.m4a"), "audio");
  assert.equal(fileTypeKind("scan", "image/jpeg"), "image");
  assert.equal(fileTypeKind("download", "application/pdf; charset=binary"), "pdf");
  assert.equal(fileTypeKind("mystery.bin", "application/octet-stream"), "file");
  assert.equal(fileTypeKind("README"), "file");
});

// ---------------------------------------------------------------------------------------------
// 166
// ---------------------------------------------------------------------------------------------

test("166: a feedback subtask is named feedback first, then the file", () => {
  assert.equal(feedbackAssetTitle("Do better", "logo_autumn_lake_healthcare_at_arcola .pdf"), "Do better — logo_autumn_lake_healthcare_at_arcola .pdf");
  assert.equal(feedbackAssetTitle("  Make the logo   bigger\nand bluer ", "logo.pdf"), "Make the logo bigger — logo.pdf");
  // No feedback text → still about the file; no file → the feedback alone (as before).
  assert.equal(feedbackAssetTitle("   ", "logo.pdf"), "Follow up on logo.pdf");
  assert.equal(feedbackAssetTitle("Do better", null), feedbackSubtaskTitle("Do better"));
  // Long feedback is cut so the file's whole name stays (the chip needs all of it).
  const long = feedbackAssetTitle("word ".repeat(60), "a_long_file_name_for_the_flyer.pdf");
  assert.ok(long.endsWith(" — a_long_file_name_for_the_flyer.pdf"), long);
  assert.ok(long.includes("…"));
  assert.ok(long.length <= FEEDBACK_TITLE_MAX + 2, `${long.length}`);
});

test("166: the description ties the subtask to the file by id, and the line reads well as text", () => {
  const notes = feedbackSubtaskNotes({
    feedback: "Do better",
    from: "Sam Approver",
    link: "https://app.example/projects/p1?task=t1",
    asset: { id: FILE, name: "logo.pdf" },
    origin: "https://app.example",
  });
  assert.equal(notes, `Feedback from Sam Approver on https://app.example/projects/p1?task=t1\nFile: logo.pdf (https://app.example/attachments/${FILE})`);
  assert.deepEqual(parseAssetRefs(notes), [{ id: FILE, name: "logo.pdf" }]);
  // Without a file, as before.
  assert.equal(feedbackSubtaskNotes({ feedback: "Do better", from: "Sam", link: null }), "Feedback from Sam");
  // Without an origin the line still carries the id.
  assert.equal(assetRefLine({ id: FILE, name: "  logo   final.pdf " }), `File: logo final.pdf (/attachments/${FILE})`);
  assert.deepEqual(parseAssetRefs(assetRefLine({ id: FILE, name: "logo final.pdf" })), [{ id: FILE, name: "logo final.pdf" }]);
});

test("166: parseAssetRefs reads only whole File: lines with a real id, each id once", () => {
  assert.deepEqual(parseAssetRefs(null), []);
  assert.deepEqual(parseAssetRefs("No files here"), []);
  assert.deepEqual(parseAssetRefs(`See /attachments/${FILE}`), [], "a bare link isn't a ref");
  assert.deepEqual(parseAssetRefs("File: logo.pdf (/attachments/not-a-uuid)"), []);
  const two = [
    `File: logo (v2).pdf (https://x.test/attachments/${FILE}?preview=1)`,
    "some text",
    `File: flyer.png (/attachments/${OTHER.toUpperCase()})`,
    `File: again.pdf (/attachments/${FILE})`,
  ].join("\n");
  assert.deepEqual(parseAssetRefs(two), [
    { id: FILE, name: "logo (v2).pdf" },
    { id: OTHER, name: "flyer.png" },
  ]);
});

test("166: the file's name in a title is a chip; legacy 'name: feedback' titles chip too", () => {
  const assets = [{ id: FILE, name: "logo_autumn_lake_healthcare_at_arcola .pdf" }];
  assert.deepEqual(titleAssetSegments("Do better — logo_autumn_lake_healthcare_at_arcola .pdf", assets), [
    { kind: "text", text: "Do better — " },
    { kind: "asset", text: "logo_autumn_lake_healthcare_at_arcola .pdf", asset: assets[0] },
  ]);
  // Before note 166 the file came first: "logo.pdf: Do better".
  const logo = [{ id: FILE, name: "logo.pdf" }];
  assert.deepEqual(titleAssetSegments("logo.pdf: Do better", logo), [
    { kind: "asset", text: "logo.pdf", asset: logo[0] },
    { kind: "text", text: ": Do better" },
  ]);
  // Any case; a trailing period is fine; inside another word is not.
  assert.equal(titleAssetSegments("Fix LOGO.PDF.", logo)[1].kind, "asset");
  assert.deepEqual(titleAssetSegments("Fix mylogo.pdf now", logo), [{ kind: "text", text: "Fix mylogo.pdf now" }]);
  assert.deepEqual(titleAssetSegments("Fix logo.pdfx", logo), [{ kind: "text", text: "Fix logo.pdfx" }]);
  // The longest name wins; too-short names never match.
  const both = [
    { id: OTHER, name: "logo" },
    { id: FILE, name: "logo final.pdf" },
  ];
  const segs = titleAssetSegments("Use logo final.pdf", both);
  assert.equal(segs[1].kind === "asset" && segs[1].asset.id, FILE);
  assert.deepEqual(titleAssetSegments("a b", [{ id: FILE, name: "a" }]), [{ kind: "text", text: "a b" }]);
  assert.deepEqual(titleAssetSegments("Plain name", []), [{ kind: "text", text: "Plain name" }]);
});

test("166: a subtask's chip resolves by id from its description first, then by name from the files given", () => {
  const notes = `Feedback from Sam\n${assetRefLine({ id: FILE, name: "logo.pdf" })}`;
  const assets = titleAssetsFor(notes, [
    { id: FILE, name: "logo.pdf", contentType: "application/pdf" },
    { id: OTHER, name: "flyer.png", contentType: "image/png" },
  ]);
  assert.deepEqual(assets, [
    { id: FILE, name: "logo.pdf", contentType: "application/pdf" },
    { id: OTHER, name: "flyer.png", contentType: "image/png" },
  ]);
  // The ref keeps the name it was made with, so the chip still opens the same file by id.
  const kept = titleAssetsFor(`File: old name.pdf (/attachments/${FILE})`, []);
  assert.deepEqual(titleAssetSegments("Do better — old name.pdf", kept)[1], {
    kind: "asset",
    text: "old name.pdf",
    asset: { id: FILE, name: "old name.pdf", contentType: null },
  });
});
