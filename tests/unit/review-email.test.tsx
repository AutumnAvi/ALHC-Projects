// Oct 26 notes (batch 3) / Oct 27 notes (batch 5): the review check email (split out of
// review-checks.test.tsx so the email and the public page are tested on their own).
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderReviewEmail, reviewUrls } from "@/lib/review-email";

const TOKEN = `alhc_rev_${"a1".repeat(32)}`;

test("the email: the design, a thumbnail, and exactly two buttons (Approve, Leave feedback)", () => {
  const email = renderReviewEmail({
    origin: "https://projects.example.com",
    token: TOKEN,
    round: 2,
    recipientName: "Cara Client",
    senderName: "Avi",
    taskTitle: "Spring poster",
    projectName: "Creative requests",
    message: "Here's the second draft.",
    assets: [
      { assetId: "asset-1", name: "poster.png", contentType: "image/png" },
      { assetId: "asset-2", name: "proof.pdf", contentType: "application/pdf" },
    ],
    design: null,
  });
  const urls = reviewUrls("https://projects.example.com", TOKEN);
  assert.equal(email.subject, "Review requested: Spring poster (v2)");
  assert.ok(email.html.includes(`href="${urls.approve}"`) && email.html.includes(">Approve</a>"));
  assert.ok(email.html.includes(`href="${urls.feedback}"`) && email.html.includes(">Leave feedback</a>"));
  assert.equal(email.html.match(/<a [^>]*>(Approve|Leave feedback)<\/a>/g)?.length, 2, "two buttons");
  assert.equal(
    email.html.match(/<a [^>]*style="display:inline-block[^"]*"/g)?.length,
    2,
    "no other button (e.g. the design's form button)",
  );
  assert.ok(email.html.includes(`src="${urls.page}/file/asset-1"`), "the image is the thumbnail");
  assert.match(email.html, /Hi Cara,/);
  assert.match(email.text, /Approve: https:\/\/projects\.example\.com\/review\/alhc_rev_/);
});
