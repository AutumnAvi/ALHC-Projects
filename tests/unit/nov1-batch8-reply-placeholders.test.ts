// Nov 1 notes (batch 8, item 59): a requester's emailed reply with a macOS screenshot kept
// "[Screenshot 2026-10-27 at 12.18.36 PM.png]" in the comment. The text part has a narrow no-break space
// (U+202F) before PM; the attachment's name has none. Placeholders now match names loosely.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  looseName,
  planReceivedFiles,
  stripAttachmentPlaceholders,
  type ReceivedFile,
} from "@/lib/reply-attachments";

const SAVED = "Screenshot 2026-10-27 at 12.18.36PM.png";
const IN_TEXT = "Screenshot 2026-10-27 at 12.18.36 PM.png";

const file = (filename: string, extra: Partial<ReceivedFile> = {}): ReceivedFile => ({
  id: filename,
  filename,
  contentType: "image/png",
  inline: true,
  contentId: null,
  size: 120_000,
  ...extra,
});

test("looseName ignores case, NFKC differences, and every kind of space", () => {
  assert.equal(looseName(IN_TEXT), looseName(SAVED));
  assert.equal(looseName("A B C D​E.PNG"), "abcde.png");
  assert.equal(looseName("ｆｉｌｅ.png"), "file.png"); // full-width letters (NFKC)
  assert.notEqual(looseName("other.png"), looseName(SAVED));
});

test("the confirmed reply: the screenshot's bracket text comes out", () => {
  const body = `Here is the updated logo.\n\n[${IN_TEXT}]\n\nThanks!`;
  assert.equal(stripAttachmentPlaceholders(body, [file(SAVED)]), "Here is the updated logo.\n\nThanks!");
});

test("the other direction too (text without the space, file with a regular or no-break space)", () => {
  assert.equal(stripAttachmentPlaceholders(`See [${SAVED}]`, [file("Screenshot 2026-10-27 at 12.18.36 PM.png")]), "See");
  assert.equal(stripAttachmentPlaceholders(`See [${SAVED}]`, [file("Screenshot 2026-10-27 at 12.18.36 PM.png")]), "See");
});

test("Gmail, angle-bracket, and Outlook cid forms match loosely; a narrow space before the bracket goes too", () => {
  const files = [file(SAVED, { contentId: "ii_abc 123" })];
  assert.equal(stripAttachmentPlaceholders(`A [image: ${IN_TEXT}] B`, files), "A B");
  assert.equal(stripAttachmentPlaceholders(`A <${IN_TEXT}> B`, files), "A B");
  assert.equal(stripAttachmentPlaceholders("A [cid:ii_abc123] B", files), "A B");
  assert.equal(stripAttachmentPlaceholders(`A [${IN_TEXT}]`, files), "A");
});

test("brackets that name no saved or noted file stay", () => {
  const body = `Keep [other.png] and [note] and [${IN_TEXT}]`;
  assert.equal(stripAttachmentPlaceholders(body, [file(SAVED)]), "Keep [other.png] and [note] and");
  assert.equal(stripAttachmentPlaceholders("Nested [note [x.png]", [file("x.png")]), "Nested [note");
  assert.equal(stripAttachmentPlaceholders("a < b [x.png]", [file("x.png")]), "a < b");
});

test("the planner sees the loosely written placeholder as being in what the person wrote", () => {
  const text = `Here it is\n[${IN_TEXT}]`;
  const plan = planReceivedFiles([file(SAVED)], { rawText: text, keptText: text });
  assert.equal(plan.copy.length, 1);
  assert.equal(plan.ignored.length, 0);
  // Referenced only in the quoted part → left out, as before.
  const quoted = planReceivedFiles([file(SAVED)], { rawText: `Thanks\n> [${IN_TEXT}]`, keptText: "Thanks" });
  assert.equal(quoted.ignored.length, 1);
});
