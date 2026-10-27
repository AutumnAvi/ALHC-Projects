// Oct 27 notes (batch 5), items 7 and 8: the reviewer's page. The rules (src/lib/review-portal.ts): which
// file opens first, "File 2 of 3", saved progress ↔ the page, when "How it works" shows, what an answer
// needs, the video timeline's ticks. And what the page draws: one file at a time with the answer choice,
// restored work, the previous round collapsed with its pins, the confirmation, plain words.
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ReviewPortal } from "@/components/review/review-portal";
import { ReviewWalkthrough, WALKTHROUGH_SLIDE_COUNT } from "@/components/review/review-walkthrough";
import { parseReviewDraft, type PublicReview, type ReviewFile } from "@/lib/review-checks";
import {
  answerProblem,
  confirmationTitle,
  draftToState,
  fileProgressLabel,
  initialAssetIndex,
  numberedPins,
  pinCountByAsset,
  pinsByFile,
  retryDelay,
  savingStops,
  shortDate,
  shouldShowWalkthrough,
  stateToProgress,
  submitLabel,
  timeScaleTicks,
  walkthroughKey,
} from "@/lib/review-portal";

const TOKEN = `alhc_rev_${"b2".repeat(32)}`;
const A1 = "11111111-1111-4111-8111-111111111111";
const A2 = "22222222-2222-4222-8222-222222222222";
const A3 = "33333333-3333-4333-8333-333333333333";
const assets: ReviewFile[] = [
  { id: A1, name: "poster.png", contentType: "image/png", size: 2048 },
  { id: A2, name: "proof.pdf", contentType: "application/pdf", size: 4096 },
];

test("the first file: the email's ?file=, else where they left off, else the first", () => {
  assert.equal(initialAssetIndex(assets, A2, null), 1);
  assert.equal(initialAssetIndex(assets, null, A2), 1);
  assert.equal(initialAssetIndex(assets, A1, A2), 0, "the link wins over the saved file");
  assert.equal(initialAssetIndex(assets, A3, null), 0, "a file of another round falls back");
  assert.equal(initialAssetIndex(assets, "not-a-file", "nope"), 0);
  assert.equal(initialAssetIndex([], A1, null), 0);
});

test("N of M", () => {
  assert.equal(fileProgressLabel(0, 2), "1 of 2");
  assert.equal(fileProgressLabel(1, 2), "2 of 2");
  assert.equal(fileProgressLabel(9, 3), "3 of 3", "clamped");
  assert.equal(fileProgressLabel(0, 0), "No files");
});

test("saved progress ↔ the page", () => {
  const draft = parseReviewDraft({
    pins: [
      { asset_id: A1, x: 0.2, y: 0.3, page: null, time: null, body: "Bigger" },
      { asset_id: A3, x: 0.1, y: 0.1, body: "another round's file" },
      { asset_id: A2, page: 2, x: 0.5, y: 0.5, body: "" },
    ],
    note: "Close",
    decision: "changes_requested",
    active_asset: A2,
  });
  const state = draftToState(draft, assets);
  assert.equal(state.pins.length, 2, "pins on files of this round only");
  assert.deepEqual(state.pins.map((p) => p.key), ["saved-0", "saved-1"], "stable keys");
  assert.equal(state.pins[1].body, "", "a pin may have no text yet");
  assert.equal(state.note, "Close");
  assert.equal(state.decision, "changes_requested");
  assert.equal(state.activeAsset, A2);
  assert.equal(draftToState(draft, assets, "approve").decision, "approved", "the email's Approve picks Approve");
  assert.equal(draftToState(null, assets, "feedback").decision, "changes_requested");
  assert.deepEqual(draftToState(null, assets), { pins: [], note: "", decision: null, activeAsset: null });

  const progress = stateToProgress(state);
  assert.deepEqual(Object.keys(progress).sort(), ["activeAsset", "decision", "note", "pins"]);
  assert.ok(progress.pins.every((p) => !("key" in p)), "keys stay on the page");
  assert.equal(progress.pins[0].assetId, A1);
});

test("how it works: the first time an open round is opened, unless they closed it here or anywhere", () => {
  assert.equal(shouldShowWalkthrough({ open: true, seenOnServer: false, seenHere: false }), true);
  assert.equal(shouldShowWalkthrough({ open: true, seenOnServer: true, seenHere: false }), false);
  assert.equal(shouldShowWalkthrough({ open: true, seenOnServer: false, seenHere: true }), false);
  assert.equal(shouldShowWalkthrough({ open: false, seenOnServer: false, seenHere: false }), false, "not on an answered round");
  assert.equal(walkthroughKey("r1"), "alhc.review.walkthrough.r1");
  assert.ok(!walkthroughKey("r1").includes("alhc_rev_"), "never the token");
});

test("the walkthrough: five slides, a close button, Next, dots", () => {
  const html = renderToStaticMarkup(<ReviewWalkthrough onClose={() => {}} />);
  assert.equal(WALKTHROUGH_SLIDE_COUNT, 5);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-label="Close how it works"/);
  assert.match(html, />Next/);
  assert.doesNotMatch(html, />Back</, "no Back on the first slide");
  assert.equal(html.match(/aria-label="Slide \d:/g)?.length, 5, "a dot per slide");
  assert.match(html, /aria-current="step"/);
  for (const words of ["Pin comments", "moment of a video", "full quality", "Send files back", "Approve or request changes"]) {
    assert.ok(html.includes(words), words);
  }
  assert.match(html, /motion-reduce:transition-none/, "no motion when asked");
});

test("what an answer needs", () => {
  const pin = (body: string) => ({ key: "k", assetId: A1, page: null, x: 0.1, y: 0.1, time: null, body });
  assert.match(answerProblem({ decision: null, note: "", pins: [] }) ?? "", /Pick Approve or Request changes/);
  assert.equal(answerProblem({ decision: "approved", note: "", pins: [] }), null, "approve needs nothing else");
  assert.match(answerProblem({ decision: "changes_requested", note: " ", pins: [] }) ?? "", /Add a note or pin/);
  assert.equal(answerProblem({ decision: "changes_requested", note: "Fix it", pins: [] }), null);
  assert.equal(answerProblem({ decision: "changes_requested", note: "", pins: [pin("Here")] }), null);
  assert.match(answerProblem({ decision: "approved", note: "", pins: [pin("  ")] }) ?? "", /no comment yet/);
  assert.equal(submitLabel("approved"), "Send approval");
  assert.equal(submitLabel("changes_requested"), "Send feedback");
  assert.equal(submitLabel(null), "Submit review");
});

test("the confirmation's words and summary", () => {
  assert.equal(confirmationTitle("approved", 0), "Thanks — your approval was sent");
  assert.equal(confirmationTitle("changes_requested", 3), "Thanks — your feedback was sent (3 comments)");
  assert.equal(confirmationTitle("changes_requested", 1), "Thanks — your feedback was sent (1 comment)");
  assert.equal(confirmationTitle("changes_requested", 0), "Thanks — your feedback was sent");
  const numbered = numberedPins([
    { key: "a", assetId: A2, page: 1, x: 0.1, y: 0.1, time: null, body: " One " },
    { key: "b", assetId: A1, page: null, x: 0.2, y: 0.2, time: null, body: "Two" },
  ]);
  assert.deepEqual(numbered.map((p) => [p.number, p.body]), [[1, "One"], [2, "Two"]], "numbered in order, like the database");
  assert.deepEqual(pinsByFile(numbered, assets).map((g) => g.file.name), ["poster.png", "proof.pdf"], "in the round's file order");
  assert.deepEqual([...pinCountByAsset(numbered).entries()], [[A2, 1], [A1, 1]]);
  assert.equal(shortDate("2026-11-25T23:30:00Z"), "Nov 25, 2026", "the same everywhere (UTC)");
  assert.equal(shortDate(null), "");
});

test("autosave: refusals that stop it, a growing wait for the rest", () => {
  for (const status of ["closed", "superseded", "withdrawn", "expired", "unknown"]) assert.ok(savingStops(status), status);
  assert.ok(!savingStops("rate_limited"), "too many just now: try again later");
  assert.ok(!savingStops(undefined), "a network error: try again");
  assert.deepEqual([0, 1, 2, 3].map(retryDelay), [2000, 4000, 8000, 16000]);
  assert.equal(retryDelay(20), 60_000, "capped");
});

test("the video timeline's ticks: at most 8, round steps, never at 0 or the end", () => {
  assert.deepEqual(timeScaleTicks(0), []);
  assert.deepEqual(timeScaleTicks(10), [2, 4, 6, 8]);
  assert.deepEqual(timeScaleTicks(60), [10, 20, 30, 40, 50]);
  const long = timeScaleTicks(3 * 3600);
  assert.ok(long.length <= 8 && long.every((t) => t > 0 && t < 3 * 3600));
});

const base: PublicReview = {
  id: "r2",
  round: 2,
  status: "pending",
  recipientName: "Cara Client",
  recipientEmail: "c@example.org",
  message: null,
  senderName: "Avi",
  taskTitle: "Spring poster",
  projectName: "Creative requests",
  workspaceName: "ALHC",
  workspaceLogoPath: null,
  expiresAt: "2026-11-25T00:00:00Z",
  decidedAt: null,
  decisionNote: null,
  assets,
  pins: [],
  files: [],
  draft: null,
  walkthroughSeen: false,
  previous: null,
};

test("an open round: one file at a time, 1 of 2, the file list with pin counts, the answer", () => {
  const html = renderToStaticMarkup(<ReviewPortal token={TOKEN} review={base} logoUrl={null} initialAction={null} />);
  assert.match(html, /File 1 of 2/);
  assert.match(html, /aria-label="Previous file"/);
  assert.match(html, /aria-label="Next file"/);
  assert.match(html, /role="tablist"/);
  assert.match(html, /role="radiogroup"/);
  assert.match(html, /Round 2/);
  assert.match(html, /How it works/);
  assert.ok(html.includes(`src="/review/${TOKEN}/file/${A1}"`), "the first file");
  assert.ok(!html.includes(`/file/${A2}"`) || !html.includes(`src="/review/${TOKEN}/file/${A2}"`), "only one file shows");
  assert.doesNotMatch(html, /role="dialog"/, "the walkthrough is decided in the browser, never on the server");
  assert.doesNotMatch(html, /[Vv]ersion|\bv2\b|[Rr]evise/, "plain words");
});

test("?file= opens that file first; saved work comes back", () => {
  const saved: PublicReview = {
    ...base,
    draft: {
      pins: [{ assetId: A2, page: 1, x: 0.4, y: 0.4, time: null, body: "Move the logo" }],
      note: "Almost there",
      decision: "changes_requested",
      activeAsset: A1,
    },
  };
  const html = renderToStaticMarkup(<ReviewPortal token={TOKEN} review={saved} logoUrl={null} initialAction={null} initialFile={A2} />);
  assert.match(html, /File 2 of 2/);
  assert.match(html, /Move the logo/, "the saved pin");
  assert.match(html, /Almost there/, "the saved note");
  assert.match(html, /Send feedback/, "the saved answer");
  assert.match(html, /aria-label="File 2: proof\.pdf, 1 comment"/, "pin counts in the file list");
});

test("a new round shows the previous one collapsed, with its pins counted", () => {
  const withPrevious: PublicReview = {
    ...base,
    previous: {
      id: "r1",
      round: 1,
      status: "changes_requested",
      decidedAt: "2026-10-20T10:00:00Z",
      decisionNote: "Bigger logo",
      assets: [{ id: A3, name: "poster-old.png", contentType: "image/png", size: 100 }],
      pins: [
        { number: 1, assetId: A3, page: null, x: 0.5, y: 0.5, time: null, body: "Logo" },
        { number: 2, assetId: A3, page: null, x: 0.2, y: 0.2, time: null, body: "Color" },
      ],
    },
  };
  const html = renderToStaticMarkup(<ReviewPortal token={TOKEN} review={withPrevious} logoUrl={null} initialAction={null} />);
  assert.match(html, /Round 1 — what you said last time/);
  assert.match(html, /Changes requested · 2 comments · Oct 20, 2026/);
  assert.match(html, /aria-expanded="false"/, "collapsed");
  assert.doesNotMatch(html, /poster-old\.png/, "its files show once it's opened");
});

test("an answered link opens on the confirmation", () => {
  const approved: PublicReview = { ...base, status: "approved", decidedAt: "2026-10-27T09:00:00Z" };
  const html = renderToStaticMarkup(<ReviewPortal token={TOKEN} review={approved} logoUrl={null} initialAction={null} />);
  assert.match(html, /Thanks — your approval was sent/);
  assert.match(html, /Avi has it on their task in Creative requests/);
  assert.match(html, /Look at the files again/);
  assert.doesNotMatch(html, /role="radiogroup"/);
  assert.doesNotMatch(html, /Upload files/);
});
