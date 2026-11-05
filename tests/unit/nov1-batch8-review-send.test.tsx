// Nov 1 notes (batch 8), items 60 and 61: forms require the requester's name (mirrors
// ensure_form_requester_name()), and the Send review check dialog puts Upload files first, lists "Files
// attached to this task" as thumbnails, shows the requester's email read-only, and fills in their name.
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SendReviewDialog } from "@/components/task/send-review-dialog";
import type { TaskDetail } from "@/lib/api/task-pane/model";
import {
  NAME_QUESTION_ID,
  ensureNameQuestion,
  normalizeQuestions,
  requesterNameFrom,
  submissionRequesterName,
  validateSubmission,
  type FormQuestion,
} from "@/lib/forms";

const what: FormQuestion = { id: "what", type: "short_text", label: "What do you need?", required: true, maps_to: { target: "title" } };

test("a form without a name question gets “Your name” first, required", () => {
  const out = ensureNameQuestion([what]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { id: NAME_QUESTION_ID, type: "short_text", role: "name", label: "Your name", required: true });
  assert.deepEqual(out[1], what);
});

test("the requester_name question gets its role back and stays required, unmapped, and unbranched", () => {
  const out = ensureNameQuestion([
    what,
    { id: NAME_QUESTION_ID, type: "long_text", label: "Full name", maps_to: { target: "notes" }, show_if: { question_id: "x", option_ids: ["y"] } },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[1], { id: NAME_QUESTION_ID, type: "short_text", role: "name", label: "Full name", required: true });
});

test("only the first marked question is the name question; an empty label reads “Your name”", () => {
  const out = ensureNameQuestion([
    { id: "a", type: "short_text", label: " ", role: "name" },
    { id: "b", type: "short_text", label: "Other", role: "name" },
  ]);
  assert.equal(out[0].label, "Your name");
  assert.equal(out[0].role, "name");
  assert.equal(out[1].role, undefined);
});

test("normalizing for save keeps the name question as it is and the rest as before", () => {
  const out = normalizeQuestions([what], [], true);
  assert.equal(out[0].role, "name");
  assert.equal(out[1].id, "what");
});

test("the public form requires the name like any required question", () => {
  const questions = ensureNameQuestion([what]);
  const { errors } = validateSubmission(questions, "r@example.org", { what: "Poster" });
  assert.equal(errors[NAME_QUESTION_ID], "This question is required");
  assert.deepEqual(validateSubmission(questions, "r@example.org", { what: "Poster", [NAME_QUESTION_ID]: "Robin" }).errors, {});
});

test("the requester's name from a submission: the name question, else a name-like label", () => {
  const questions = ensureNameQuestion([what]);
  assert.equal(requesterNameFrom(questions, { [NAME_QUESTION_ID]: "  Robin  " }), "Robin");
  assert.equal(submissionRequesterName(questions as never, { [NAME_QUESTION_ID]: "Robin" }), "Robin");
  assert.equal(
    submissionRequesterName([{ id: "n", type: "short_text", label: "Full name" }] as never, { n: "Old Form Person" }),
    "Old Form Person",
  );
  assert.equal(submissionRequesterName([] as never, {}), null);
});

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "00000000-0000-4000-8000-0000000000a1",
    attachments: [
      { id: "img1", fileName: "poster.png", contentType: "image/png", sizeBytes: 10, uploadedBy: "p", createdAt: "2026-11-01T00:00:00Z" },
      { id: "pdf1", fileName: "proof.pdf", contentType: "application/pdf", sizeBytes: 10, uploadedBy: "p", createdAt: "2026-11-01T00:00:00Z" },
      { id: "doc1", fileName: "notes.docx", contentType: null, sizeBytes: 10, uploadedBy: "p", createdAt: "2026-11-01T00:00:00Z" },
    ],
    submission: { email: "robin@example.org", name: "Robin Requester", formId: "f", formTitle: "Design request", createdAt: "2026-11-01T00:00:00Z" },
    ...overrides,
  } as unknown as TaskDetail;
}

test("the dialog: Upload files first, the task's files as previews, the requester read-only with their name", () => {
  const html = renderToStaticMarkup(<SendReviewDialog task={task()} onClose={() => {}} initialMessage="Here's draft 1" />);
  const upload = html.indexOf(">Upload files<");
  const list = html.indexOf("Files attached to this task");
  assert.ok(upload > 0 && list > upload, "Upload files comes before the list");
  assert.match(html, /src="\/attachments\/img1\?preview=1"/, "an image shows its thumbnail");
  assert.match(html, /aria-label="Preview poster\.png"/, "an image previews in the lightbox");
  assert.match(html, /href="\/attachments\/pdf1\?preview=1"[^>]*target="_blank"/, "a PDF opens in the browser's viewer");
  assert.match(html, /No preview for this file type/, "other files have no preview");
  assert.match(html, /<input[^>]*readOnly=""[^>]*value="robin@example\.org"/, "the requester's email, read-only");
  assert.match(html, /value="Robin Requester"/, "their name from the form");
  assert.match(html, />Here&#x27;s draft 1<\/textarea>/, "the comment box's text is the message");
});

test("a task that didn't come from a form takes a typed email", () => {
  const html = renderToStaticMarkup(<SendReviewDialog task={task({ submission: null })} onClose={() => {}} />);
  assert.doesNotMatch(html, /readOnly=""/);
  assert.match(html, /didn’t come from a form/);
  assert.match(html, /No files on this task yet|poster\.png/);
});
