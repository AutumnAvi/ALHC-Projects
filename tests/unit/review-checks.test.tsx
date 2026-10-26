// Oct 26 notes (batch 3), part 7: review checks. The database checks every token (suite zz32: hashed,
// expiring, replaced links dead, one decision, only the round's own files, 600 requests an hour); here the
// app's side of the same rules: the token shape is checked before anything reaches the database, the public
// actions refuse a bad link outright, the email has exactly two buttons, and the page and the viewer show
// what they should.
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ReviewClosedNotice, ReviewPortal } from "@/components/review/review-portal";
import { ReviewViewer } from "@/components/review/review-viewer";
import {
  REVIEW_REFUSALS,
  isReviewToken,
  parsePublicReview,
  pinPlace,
  reviewMediaKind,
  reviewUploadProblem,
  timeLabel,
  type PublicReview,
} from "@/lib/review-checks";
import { renderReviewEmail, reviewUrls } from "@/lib/review-email";
import { finishReviewUpload, startReviewUpload, submitReviewDecision } from "@/lib/review-public-actions";

const TOKEN = `alhc_rev_${"a1".repeat(32)}`;

test("token shape: alhc_rev_ + 64 lowercase hex, nothing else", () => {
  assert.ok(isReviewToken(TOKEN));
  for (const bad of [
    "",
    "alhc_rev_",
    `alhc_rev_${"a".repeat(63)}`,
    `alhc_rev_${"a".repeat(65)}`,
    `alhc_rev_${"A".repeat(64)}`,
    `alhc_cal_${"a".repeat(64)}`,
    `${TOKEN}/../x`,
    ` ${TOKEN}`,
    null,
    42,
  ]) {
    assert.ok(!isReviewToken(bad), String(bad));
  }
});

test("the public actions refuse a malformed link before touching the database", async () => {
  assert.equal((await submitReviewDecision("nope", "approved", "", [])).error, REVIEW_REFUSALS.unknown);
  assert.equal((await startReviewUpload("nope", { name: "a.png", type: "image/png", size: 10 })).error, REVIEW_REFUSALS.unknown);
  assert.equal((await finishReviewUpload(TOKEN, "not-a-uuid")).error, REVIEW_REFUSALS.unknown);
  assert.equal(
    (await submitReviewDecision(TOKEN, "maybe" as never, "", [])).error,
    REVIEW_REFUSALS.invalid,
    "two answers only",
  );
  assert.match(
    (await startReviewUpload(TOKEN, { name: "setup.exe", type: "application/octet-stream", size: 10 })).error ?? "",
    /can’t be sent/,
    "programs never start an upload",
  );
});

test("parsing what review_check_view returns", () => {
  assert.deepEqual(parsePublicReview({ status: "expired" }), { status: "expired" });
  assert.deepEqual(parsePublicReview({ status: "rate_limited" }), { status: "rate_limited" });
  assert.deepEqual(parsePublicReview({ status: "weird" }), { status: "unknown" });
  assert.deepEqual(parsePublicReview(null), { status: "unknown" });
  const parsed = parsePublicReview({
    status: "ok",
    review: { id: "r1", round: 2, status: "pending", recipient_email: "c@example.org", task_title: "Poster", expires_at: "2026-11-25T00:00:00Z" },
    assets: [{ id: "a1", name: "poster.png", content_type: "image/png", size: 100 }, { id: 5 }],
    pins: [{ number: 1, asset_id: "a1", x: 0.5, y: 0.25, page: null, time: null, body: "Bigger" }, { number: 2 }],
    files: [],
  });
  assert.equal(parsed.status, "ok");
  if (parsed.status === "ok") {
    assert.equal(parsed.review.round, 2);
    assert.deepEqual(parsed.review.assets.map((a) => a.id), ["a1"], "malformed entries dropped");
    assert.deepEqual(parsed.review.pins.map((p) => p.body), ["Bigger"]);
  }
});

test("what shows in the browser: images, PDFs, and videos (never SVG or HTML)", () => {
  assert.equal(reviewMediaKind("poster.png", "image/png"), "image");
  assert.equal(reviewMediaKind("proof.pdf", null), "pdf");
  assert.equal(reviewMediaKind("cut.mp4", "video/mp4"), "video");
  assert.equal(reviewMediaKind("cut.mov", "video/quicktime"), "video");
  assert.equal(reviewMediaKind("cut.webm", "video/webm"), "video");
  assert.equal(reviewMediaKind("cut.mp4", "text/html"), null, "a type that disagrees downloads");
  assert.equal(reviewMediaKind("logo.svg", "image/svg+xml"), null);
  assert.equal(reviewMediaKind("page.html", "text/html"), null);
  assert.equal(reviewMediaKind("notes.docx", null), null);
});

test("pins read as places; uploads are checked like emailed files", () => {
  assert.equal(timeLabel(12.4), "0:12");
  assert.equal(timeLabel(3725), "1:02:05");
  assert.equal(pinPlace({ page: 2, time: null }), "page 2");
  assert.equal(pinPlace({ page: null, time: 75 }), "at 1:15");
  assert.equal(reviewUploadProblem({ name: "final.png", type: "image/png", size: 1000 }), null);
  assert.match(reviewUploadProblem({ name: "big.mov", type: "video/quicktime", size: 26 * 1024 * 1024 }) ?? "", /over 25 MB/);
  assert.match(reviewUploadProblem({ name: "run.sh", type: "", size: 10 }) ?? "", /can’t be sent/);
});

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

const review: PublicReview = {
  id: "r1",
  round: 1,
  status: "pending",
  recipientName: "Cara Client",
  recipientEmail: "c@example.org",
  message: "Please check the poster",
  senderName: "Avi",
  taskTitle: "Spring poster",
  projectName: "Creative requests",
  workspaceName: "ALHC",
  workspaceLogoPath: null,
  expiresAt: "2026-11-25T00:00:00Z",
  decidedAt: null,
  decisionNote: null,
  assets: [{ id: "a1", name: "poster.png", contentType: "image/png", size: 2048 }],
  pins: [],
  files: [],
};

test("the review page: open rounds offer Approve and Send feedback, files, and uploads", () => {
  const html = renderToStaticMarkup(<ReviewPortal token={TOKEN} review={review} logoUrl={null} initialAction={null} />);
  assert.match(html, /Spring poster/);
  assert.match(html, />Approve</);
  assert.match(html, /Send feedback/);
  assert.match(html, /Upload files/);
  assert.match(html, /Click the file to pin a comment/);
  assert.ok(html.includes(`src="/review/${TOKEN}/file/a1"`), "the file in full quality, through the token route");
  assert.match(html, /cursor-crosshair/, "clicking pins");
});

test("the review page after a decision: read-only, with the pins sent", () => {
  const decided: PublicReview = {
    ...review,
    status: "changes_requested",
    decisionNote: "Bigger logo",
    pins: [{ number: 1, assetId: "a1", page: null, x: 0.5, y: 0.5, time: null, body: "Here" }],
  };
  const html = renderToStaticMarkup(<ReviewPortal token={TOKEN} review={decided} logoUrl={null} initialAction="approve" />);
  assert.match(html, /your feedback was sent/);
  assert.doesNotMatch(html, />Approve</);
  assert.doesNotMatch(html, /Upload files/);
  assert.doesNotMatch(html, /cursor-crosshair/);
  assert.match(html, /Bigger logo/);
  assert.match(html, /aria-label="Comment 1: Here"/);
});

test("a dead link says so and nothing else", () => {
  const html = renderToStaticMarkup(<ReviewClosedNotice message={REVIEW_REFUSALS.expired} />);
  assert.match(html, /expired/);
  assert.doesNotMatch(html, /poster/i);
});

test("the viewer: pins on an image at their place; a video's moments on its timeline", () => {
  const image = renderToStaticMarkup(
    <ReviewViewer
      file={{ id: "a1", name: "poster.png", contentType: "image/png", src: "/x", downloadHref: "/x?download=1" }}
      pins={[{ key: "p1", number: 1, page: null, x: 0.25, y: 0.75, time: null, body: "Here" }]}
      activePin={null}
    />,
  );
  assert.match(image, /left:25%;top:75%/);
  const other = renderToStaticMarkup(
    <ReviewViewer file={{ id: "a2", name: "notes.docx", contentType: null, src: "/y", downloadHref: "/y?download=1" }} pins={[]} activePin={null} />,
  );
  assert.match(other, /can’t be shown here/);
  assert.match(other, /href="\/y\?download=1"/);
  const video = renderToStaticMarkup(
    <ReviewViewer
      file={{ id: "a3", name: "cut.mp4", contentType: "video/mp4", src: "/v", downloadHref: "/v?download=1" }}
      pins={[{ key: "p2", number: 2, page: null, x: null, y: null, time: 12, body: "Cut" }]}
      activePin={null}
      onPick={() => {}}
    />,
  );
  assert.match(video, /<video[^>]*src="\/v"/);
  assert.match(video, /Comment at 0:00/);
});
