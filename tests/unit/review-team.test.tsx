// Oct 27 notes (batch 5): the team's side of review checks — the Send review check dialog's uploads (new
// files join the list and are picked, within the 20-file limit), the Reviews tab's folded rounds (a
// one-line preview; the newest open; Withdrawn in soft red; "Round 2", never "v2"), and the server's
// thumbnails (an image and a PDF's first page drawn as a JPEG).
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { pickWithLimit, reviewFileList } from "@/components/task/send-review-dialog";
import { RoundCard, reviewStatusClass, roundCounts } from "@/components/task/task-reviews";
import { MAX_REVIEW_ASSETS, type TaskReviewRound } from "@/lib/review-checks";
import { THUMB_WIDTH, renderThumbnail } from "@/lib/review-thumbnails";

test("the dialog lists files uploaded from it until the task lists them itself", () => {
  const attachments = [{ id: "a1", fileName: "poster.png", contentType: "image/png" }];
  const uploaded = [
    { id: "a1", fileName: "poster.png", contentType: "image/png" },
    { id: "a2", fileName: "proof.pdf", contentType: "application/pdf" },
  ];
  assert.deepEqual(
    reviewFileList(attachments, uploaded).map((f) => f.id),
    ["a1", "a2"],
    "no duplicates once the refreshed task has the upload",
  );
  const full = new Set(Array.from({ length: MAX_REVIEW_ASSETS }, (_, i) => `f${i}`));
  assert.equal(pickWithLimit(full, "new").has("new"), false, "a full review takes no more files");
  assert.equal(pickWithLimit(new Set(["x"]), "new").has("new"), true, "an upload is picked");
});

const round: TaskReviewRound = {
  id: "r2",
  round: 2,
  status: "changes_requested",
  recipientEmail: "cara@example.org",
  recipientName: "Cara Client",
  message: "Second try",
  senderId: "p1",
  createdAt: "2026-10-20T10:00:00Z",
  expiresAt: "2026-11-19T10:00:00Z",
  decidedAt: "2026-10-21T10:00:00Z",
  decisionNote: "Bigger logo",
  lastViewedAt: null,
  draftSavedAt: null,
  assets: [
    { id: "as1", attachmentId: "att1", name: "poster.png", contentType: "image/png", size: 10 },
    { id: "as2", attachmentId: "att2", name: "proof.pdf", contentType: "application/pdf", size: 10 },
  ],
  pins: [{ number: 1, assetId: "as1", page: null, x: 0.5, y: 0.5, time: null, body: "Here" }],
  files: [],
};

test("a folded round is one line: round, status, reviewer, when, files and pins", () => {
  assert.equal(roundCounts(round), "2 files · 1 pin");
  assert.equal(roundCounts({ ...round, assets: [round.assets[0]], pins: [], files: [{ id: "f", name: "x.png", contentType: null, size: 1 }] }), "1 file · 1 file sent back");
  const html = renderToStaticMarkup(
    <RoundCard round={round} senderName="Avi" canEdit defaultOpen={false} onChanged={() => undefined} />,
  );
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, />Round 2</);
  assert.match(html, /Changes requested/);
  assert.match(html, /Cara Client/);
  assert.match(html, /2 files · 1 pin/);
  assert.doesNotMatch(html, /Bigger logo/, "folded: the body isn't drawn");
  assert.doesNotMatch(html, /\bv2\b|version/i, "plain words");
});

test("the newest round starts open, with its note, files, and pins", () => {
  const html = renderToStaticMarkup(
    <RoundCard round={round} senderName="Avi" canEdit defaultOpen onChanged={() => undefined} />,
  );
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /Bigger logo/);
  assert.match(html, /sent by Avi/);
  assert.match(html, /Pinned comments/);
});

test("open rounds: Send again / Withdraw for editors, and when the reviewer last saved progress", () => {
  const open = { ...round, status: "pending" as const, decidedAt: null, decisionNote: null, draftSavedAt: "2026-10-21T09:00:00Z" };
  const html = renderToStaticMarkup(<RoundCard round={open} senderName="Avi" canEdit defaultOpen onChanged={() => undefined} />);
  assert.match(html, /Send again/);
  assert.match(html, /Withdraw/);
  assert.match(html, /reviewer saved progress/);
  const viewer = renderToStaticMarkup(<RoundCard round={open} senderName="Avi" canEdit={false} defaultOpen onChanged={() => undefined} />);
  assert.doesNotMatch(viewer, /Send again/, "read-only below Editor");
});

test("Withdrawn is a soft red tag; a replaced round stays neutral", () => {
  assert.match(reviewStatusClass("cancelled"), /bg-red-50/);
  assert.match(reviewStatusClass("cancelled"), /text-red-700/);
  assert.doesNotMatch(reviewStatusClass("superseded"), /red/);
  const html = renderToStaticMarkup(
    <RoundCard round={{ ...round, status: "cancelled", decidedAt: null }} senderName="Avi" canEdit defaultOpen={false} onChanged={() => undefined} />,
  );
  assert.match(html, /bg-red-50[^"]*"[^>]*>Withdrawn</);
});

// A one-page PDF with a filled rectangle and Helvetica text (not embedded: pdf.js's standard fonts).
function tinyPdf() {
  const content = "0.27 0.45 0.82 rg 72 600 468 120 re f BT /F1 36 Tf 0 0 0 rg 90 520 Td (Proof) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

function jpegWidth(bytes: Buffer): number {
  // Walk the JPEG markers to the frame header (SOF0 / SOF2): height, then width.
  let i = 2;
  while (i < bytes.length) {
    const marker = bytes[i + 1];
    const length = bytes.readUInt16BE(i + 2);
    if (marker === 0xc0 || marker === 0xc2) return bytes.readUInt16BE(i + 7);
    i += 2 + length;
  }
  return -1;
}

test("thumbnails are drawn on the server: an image, and a PDF's first page", async () => {
  const { createCanvas } = await import("@napi-rs/canvas");
  const canvas = createCanvas(1600, 1200);
  const context = canvas.getContext("2d");
  context.fillStyle = "#4573d2";
  context.fillRect(0, 0, 1600, 1200);
  const image = await renderThumbnail("image", new Uint8Array(canvas.toBuffer("image/png")));
  assert.equal(image[0], 0xff, "a JPEG");
  assert.equal(image[1], 0xd8);
  assert.equal(jpegWidth(image), THUMB_WIDTH);
  const pdf = await renderThumbnail("pdf", tinyPdf());
  assert.equal(pdf[0], 0xff, "the PDF's first page as a JPEG");
  assert.equal(jpegWidth(pdf), THUMB_WIDTH);
  await assert.rejects(renderThumbnail("pdf", new TextEncoder().encode("not a pdf")), "a broken file fails (the email shows a tile)");
});
