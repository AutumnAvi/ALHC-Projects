// Oct 26 notes (batch 3) / Oct 27 notes (batch 5): the review check email (split out of
// review-checks.test.tsx so the email and the public page are tested on their own): the design, a grid of
// the files (signed thumbnails for images and PDFs, a file tile otherwise) that each open that file on the
// review page, Approve / Leave feedback, an "Open the review" link, and plain words ("Round 2").
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderReviewEmail, reviewUrls } from "@/lib/review-email";
import { THUMB_MAX_HEIGHT, THUMB_WIDTH, thumbnailCandidates, thumbnailPath, thumbnailSize } from "@/lib/review-thumbnails";

const TOKEN = `alhc_rev_${"a1".repeat(32)}`;
const SIGNED = "https://db.example.supabase.co/storage/v1/object/sign/task-attachments/t1/thumb-att-1.jpg?token=abc";

function email(overrides: Partial<Parameters<typeof renderReviewEmail>[0]> = {}) {
  return renderReviewEmail({
    origin: "https://projects.example.com",
    token: TOKEN,
    round: 2,
    recipientName: "Cara Client",
    senderName: "Avi",
    taskTitle: "Spring poster",
    projectName: "Creative requests",
    message: "Here's the second draft.",
    assets: [
      { assetId: "asset-1", name: "poster.png", contentType: "image/png", thumbnailUrl: SIGNED },
      { assetId: "asset-2", name: "proof.pdf", contentType: "application/pdf", thumbnailUrl: null },
      { assetId: "asset-3", name: "notes.docx", contentType: null },
    ],
    design: null,
    ...overrides,
  });
}

test("the email: the design, the files, Approve and Leave feedback, and an Open the review link", () => {
  const rendered = email();
  const urls = reviewUrls("https://projects.example.com", TOKEN);
  assert.equal(rendered.subject, "Review requested: Spring poster (Round 2)");
  assert.doesNotMatch(rendered.subject + rendered.html + rendered.text, /\bv2\b|version/i, "plain words: round, never version");
  assert.match(rendered.html, /\(round 2\)/);
  assert.ok(rendered.html.includes(`href="${urls.approve}"`) && rendered.html.includes(">Approve</a>"));
  assert.ok(rendered.html.includes(`href="${urls.feedback}"`) && rendered.html.includes(">Leave feedback</a>"));
  assert.equal(rendered.html.match(/<a [^>]*>(Approve|Leave feedback)<\/a>/g)?.length, 2, "two buttons");
  assert.equal(
    rendered.html.match(/<a [^>]*style="display:inline-block[^"]*"/g)?.length,
    2,
    "no other button (e.g. the design's form button)",
  );
  assert.ok(rendered.html.includes(`href="${urls.page}"`) && rendered.html.includes("Open the review"), "the deep link");
  assert.match(rendered.html, /Hi Cara,/);
  assert.match(rendered.text, /Approve: https:\/\/projects\.example\.com\/review\/alhc_rev_/);
  assert.match(rendered.text, /Open the review: https:\/\/projects\.example\.com\/review\/alhc_rev_/);
});

test("the email's files: a signed thumbnail, else a file tile; each opens that file on the review page", () => {
  const rendered = email();
  const urls = reviewUrls("https://projects.example.com", TOKEN);
  const signed = SIGNED.replace(/&/g, "&#38;");
  assert.ok(rendered.html.includes(`src="${signed}"`), "the image's thumbnail is the signed stored one");
  assert.ok(rendered.html.includes(`alt="poster.png"`), "alt text = the file name");
  assert.ok(!rendered.html.includes(`${urls.page}/file/`), "never the token route as an image address");
  assert.equal(rendered.html.match(/<img /g)?.length, 1, "files without a thumbnail get a tile, not an image");
  assert.match(rendered.html, />PDF</, "the PDF's tile");
  assert.match(rendered.html, />DOCX</, "and the document's");
  for (const id of ["asset-1", "asset-2", "asset-3"]) {
    assert.ok(rendered.html.includes(`href="${urls.file(id)}"`), `${id} links to its file`);
    assert.match(rendered.text, new RegExp(`\\?file=${id}`));
  }
  assert.equal(urls.file("a b"), `${urls.page}?file=a%20b`);
  // Three per row: the grid's first row holds three cells.
  assert.equal(rendered.html.match(/<tr><td width="33%"/g)?.length, 1, "one row for three files");
});

test("many files: the grid shows nine and counts the rest", () => {
  const assets = Array.from({ length: 11 }, (_, i) => ({ assetId: `a${i}`, name: `f${i}.png`, contentType: "image/png" }));
  const rendered = email({ assets, round: 1 });
  assert.match(rendered.html, /And 2 more files on the review page/);
  assert.equal(rendered.subject, "Review requested: Spring poster", "round 1 doesn't say its number");
  assert.match(rendered.html, /review of 11 files\./);
});

test("thumbnails: images and PDFs only, at most six, stored next to the file", () => {
  const files = [
    { name: "a.png", contentType: "image/png", size: 10 },
    { name: "b.pdf", contentType: "application/pdf", size: 10 },
    { name: "c.svg", contentType: "image/svg+xml", size: 10 },
    { name: "d.mp4", contentType: "video/mp4", size: 10 },
    { name: "e.png", contentType: "image/png", size: 30 * 1024 * 1024 },
    ...Array.from({ length: 8 }, (_, i) => ({ name: `g${i}.jpg`, contentType: "image/jpeg", size: null })),
  ];
  const picked = thumbnailCandidates(files).map((f) => f.name);
  assert.deepEqual(picked, ["a.png", "b.pdf", "g0.jpg", "g1.jpg", "g2.jpg", "g3.jpg"]);
  assert.equal(thumbnailPath("task-1", "att-1"), "task-1/thumb-att-1.jpg", "two path segments: the task's readers read it");
  assert.deepEqual(thumbnailSize(1600, 1200), { width: THUMB_WIDTH, height: 360, scale: THUMB_WIDTH / 1600 });
  assert.equal(thumbnailSize(1000, 5000).height, THUMB_MAX_HEIGHT, "tall files are cropped");
  assert.equal(thumbnailSize(200, 100).width, 200, "never upscaled");
});
