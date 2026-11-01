// Oct 27 notes (batch 5): the public review page's rules, kept pure so they're easy to test. Which file
// opens first, what "File 2 of 5" says, what the reviewer's saved progress looks like on the page and on
// the way back to the database (review_check_save), when the "How it works" walkthrough shows, what has to
// be true before an answer can be sent, and how the video timeline is marked. Browser + server.
//
// Nov 1 notes (batch 8), item 63: each file is reviewed on its own. A file is Approved (the reviewer said
// so), Has feedback (a pin on it, or a note on that file), or not reviewed yet. The two are exclusive:
// feedback wins (adding a pin or a note to an approved file takes the approval back), and approving a file
// with feedback removes that feedback (the page asks first). The answer is derived: every file approved →
// Approve; any feedback → Request changes; and it can't be sent while a file is unreviewed.
import type { ReviewDecision, ReviewDraft, ReviewFile, ReviewFileResult, ReviewPin, ReviewStatus } from "@/lib/review-checks";

// A pin on the page: a stable key (React and the list ↔ file highlight) plus what's saved.
export type KeyedPin = {
  key: string;
  assetId: string;
  page: number | null;
  x: number | null;
  y: number | null;
  time: number | null;
  body: string;
};

// One file's own review: approved, and the note on that file.
export type FileReview = { approved: boolean; note: string };
export type FileReviews = Record<string, FileReview>;

export type PortalState = {
  pins: KeyedPin[];
  // The overall note (optional either way).
  note: string;
  files: FileReviews;
  activeAsset: string | null;
};

// What review_check_save takes (ReviewProgress in review-public-actions.ts). The decision is the derived
// one (the release before this one read it back; now it's informative), and perFile tells the database the
// answer must cover every file.
export type PortalProgress = {
  pins: { assetId: string; page: number | null; x: number | null; y: number | null; time: number | null; body: string }[];
  note: string;
  decision: ReviewDecision | null;
  activeAsset: string | null;
  perFile: true;
  files: { assetId: string; approved: boolean; note: string }[];
};

// The page's starting state: what the reviewer saved (pins and file states on files still in this round,
// pins with stable keys). A draft saved before files were reviewed one by one has no file states: every
// file starts unreviewed (its pins still count as feedback).
export function draftToState(draft: ReviewDraft | null, assets: ReviewFile[]): PortalState {
  const known = new Set(assets.map((a) => a.id));
  const pins = (draft?.pins ?? [])
    .filter((p) => known.has(p.assetId))
    .map((p, i) => ({ key: `saved-${i}`, assetId: p.assetId, page: p.page, x: p.x, y: p.y, time: p.time, body: p.body }));
  const files: FileReviews = {};
  for (const f of draft?.files ?? []) {
    if (!known.has(f.assetId) || (!f.approved && !f.note)) continue;
    files[f.assetId] = { approved: f.approved, note: f.note };
  }
  const activeAsset = draft?.activeAsset && known.has(draft.activeAsset) ? draft.activeAsset : null;
  return { pins, note: draft?.note ?? "", files, activeAsset };
}

export function stateToProgress(state: PortalState, assets: ReviewFile[]): PortalProgress {
  return {
    pins: state.pins.map(({ assetId, page, x, y, time, body }) => ({ assetId, page, x, y, time, body })),
    note: state.note,
    decision: derivedDecision(assets, state),
    activeAsset: state.activeAsset,
    perFile: true,
    // In the round's order, only files with something to keep (so the same work always saves the same way).
    files: assets.flatMap((a) => {
      const f = state.files[a.id];
      return f && (f.approved || f.note) ? [{ assetId: a.id, approved: f.approved, note: f.note }] : [];
    }),
  };
}

// ---- Each file's state --------------------------------------------------------------------------------

export type FileStatus = "approved" | "feedback" | "unreviewed";
type FileStateInput = Pick<PortalState, "pins" | "files">;

// Feedback (a pin, even one still without text, or a note on the file) wins over an approval.
export function fileStatus(assetId: string, state: FileStateInput): FileStatus {
  if (state.pins.some((p) => p.assetId === assetId) || state.files[assetId]?.note.trim()) return "feedback";
  return state.files[assetId]?.approved ? "approved" : "unreviewed";
}

export type ReviewTally = { total: number; approved: number; feedback: number; reviewed: number; left: number };
export function reviewTally(assets: ReviewFile[], state: FileStateInput): ReviewTally {
  let approved = 0;
  let feedback = 0;
  for (const a of assets) {
    const s = fileStatus(a.id, state);
    if (s === "approved") approved++;
    else if (s === "feedback") feedback++;
  }
  const reviewed = approved + feedback;
  return { total: assets.length, approved, feedback, reviewed, left: assets.length - reviewed };
}

// "2 of 3 reviewed".
export function reviewedLabel(tally: ReviewTally): string {
  return `${tally.reviewed} of ${tally.total} reviewed`;
}

// The next file nobody reviewed yet after this one, wrapping around (null: every other file is reviewed).
export function nextUnreviewedIndex(assets: ReviewFile[], state: FileStateInput, from: number): number | null {
  const n = assets.length;
  for (let step = 1; step < n; step++) {
    const i = (((from + step) % n) + n) % n;
    if (fileStatus(assets[i].id, state) === "unreviewed") return i;
  }
  return null;
}

// The answer the files add up to: null until every file is reviewed (and with no files at all).
export function derivedDecision(assets: ReviewFile[], state: FileStateInput): ReviewDecision | null {
  const tally = reviewTally(assets, state);
  if (!tally.total || tally.left > 0) return null;
  return tally.feedback > 0 ? "changes_requested" : "approved";
}

// Approve a file: its own feedback (pins on it, its note) goes, so the two never disagree. The page asks
// before removing any.
export function approveFile<T extends FileStateInput>(state: T, assetId: string): T {
  return {
    ...state,
    pins: state.pins.filter((p) => p.assetId !== assetId),
    files: { ...state.files, [assetId]: { approved: true, note: "" } },
  };
}

// Take a file's approval back (the toggle, or feedback added to it). Its note stays.
export function unapproveFile(files: FileReviews, assetId: string): FileReviews {
  const current = files[assetId];
  if (!current?.approved) return files;
  if (!current.note) {
    const rest = { ...files };
    delete rest[assetId];
    return rest;
  }
  return { ...files, [assetId]: { ...current, approved: false } };
}

// A file's note: typing feedback on an approved file takes the approval back.
export function setFileNote(files: FileReviews, assetId: string, note: string): FileReviews {
  const current = files[assetId] ?? { approved: false, note: "" };
  return { ...files, [assetId]: { approved: note.trim() ? false : current.approved, note } };
}

// How much feedback approving a file would remove (the page's question), null when none.
export function feedbackOnFile(assetId: string, state: FileStateInput): { pins: number; note: boolean } | null {
  const pins = state.pins.filter((p) => p.assetId === assetId).length;
  const note = Boolean(state.files[assetId]?.note.trim());
  return pins || note ? { pins, note } : null;
}

// Each file's outcome, as the database keeps it (review_check_file_outcomes): the confirmation page shows
// it right after sending.
export function fileOutcomes(assets: ReviewFile[], state: FileStateInput): ReviewFileResult[] {
  return assets.map((a) => {
    const note = state.files[a.id]?.note.trim() || null;
    return {
      assetId: a.id,
      name: a.name,
      approved: Boolean(state.files[a.id]?.approved) && !note && !state.pins.some((p) => p.assetId === a.id),
      note,
      pins: state.pins.filter((p) => p.assetId === a.id).length,
    };
  });
}

// "Approved", "Changes requested: 2 comments", "Changes requested: 1 comment and a note", the same rule as
// the comment on the task (feedback means changes, whatever was ticked).
export function outcomeLabel(result: Pick<ReviewFileResult, "pins" | "note">): string {
  if (!result.pins && !result.note) return "Approved";
  const parts = [result.pins ? `${result.pins} comment${result.pins === 1 ? "" : "s"}` : null, result.note ? "a note" : null].filter(Boolean);
  return `Changes requested: ${parts.join(" and ")}`;
}

// The file to open first: the one an email thumbnail linked to (?file=<asset id>), else the one the
// reviewer was on, else the first.
export function initialAssetIndex(assets: ReviewFile[], fileParam: string | null | undefined, draftActive: string | null | undefined): number {
  for (const wanted of [fileParam, draftActive]) {
    if (!wanted) continue;
    const index = assets.findIndex((a) => a.id === wanted);
    if (index >= 0) return index;
  }
  return 0;
}

export function fileProgressLabel(index: number, total: number): string {
  if (total <= 0) return "No files";
  const n = Math.min(Math.max(index, 0), total - 1) + 1;
  return `${n} of ${total}`;
}

export function pinCountByAsset(pins: { assetId: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of pins) counts.set(p.assetId, (counts.get(p.assetId) ?? 0) + 1);
  return counts;
}

// "How it works": the first time an open round is opened, unless the reviewer closed it before here (this
// browser) or anywhere (the server remembers).
export const WALKTHROUGH_KEY_PREFIX = "alhc.review.walkthrough.";
export function walkthroughKey(reviewId: string): string {
  return `${WALKTHROUGH_KEY_PREFIX}${reviewId}`;
}
export function shouldShowWalkthrough({
  open,
  seenOnServer,
  seenHere,
}: {
  open: boolean;
  seenOnServer: boolean;
  seenHere: boolean;
}): boolean {
  return open && !seenOnServer && !seenHere;
}

// Why the answer can't be sent yet (null: it can). Shown under the disabled Submit button.
export function answerProblem(assets: ReviewFile[], state: FileStateInput): string | null {
  if (!assets.length) return "The files of this review aren’t available any more.";
  const { left } = reviewTally(assets, state);
  if (left > 0) {
    return `Approve or add feedback to ${left === 1 ? "1 more file" : `${left} more files`} to submit.`;
  }
  const blank = state.pins.filter((p) => !p.body.trim()).length;
  if (blank) return blank === 1 ? "One pin has no comment yet. Write one, or remove the pin." : `${blank} pins have no comment yet. Write one, or remove them.`;
  return null;
}

// The in-page question before sending: the derived answer, plainly.
export function confirmQuestion(assets: ReviewFile[], state: FileStateInput): string {
  const tally = reviewTally(assets, state);
  if (derivedDecision(assets, state) === "approved") {
    return tally.total === 1 ? "Approve this file?" : `Approve all ${tally.total} files?`;
  }
  const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
  return `Request changes: ${files(tally.feedback)} ${tally.feedback === 1 ? "has" : "have"} feedback${
    tally.approved ? `, ${files(tally.approved)} approved` : ""
  }. Send it?`;
}

// The words on the page after an answer (and on a link opened again later).
export function confirmationTitle(status: ReviewStatus, pinCount: number): string {
  if (status === "approved") return "Thanks — your approval was sent";
  if (status === "changes_requested") {
    return pinCount > 0 ? `Thanks — your feedback was sent (${pinCount} comment${pinCount === 1 ? "" : "s"})` : "Thanks — your feedback was sent";
  }
  return "This review is closed";
}

export function submitLabel(decision: ReviewDecision | null): string {
  if (decision === "approved") return "Submit approval";
  if (decision === "changes_requested") return "Submit feedback";
  return "Submit review";
}

// The pins an answer sends, numbered the way the database numbers them (in order).
export function numberedPins(pins: KeyedPin[]): ReviewPin[] {
  return pins.map((p, i) => ({ number: i + 1, assetId: p.assetId, page: p.page, x: p.x, y: p.y, time: p.time, body: p.body.trim() }));
}

// Pins grouped by file, in the round's file order (the confirmation's summary).
export function pinsByFile<T extends { assetId: string }>(pins: T[], assets: ReviewFile[]): { file: ReviewFile; pins: T[] }[] {
  return assets.flatMap((file) => {
    const mine = pins.filter((p) => p.assetId === file.id);
    return mine.length ? [{ file, pins: mine }] : [];
  });
}

// Light time-scale ticks for a video's timeline: a round step giving at most 8 ticks (not at 0 or the end).
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
export function timeScaleTicks(duration: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const step = TICK_STEPS.find((s) => duration / s <= 8) ?? Math.ceil(duration / 8);
  const ticks: number[] = [];
  for (let t = step; t < duration; t += step) ticks.push(t);
  return ticks;
}

// Autosave: shortly after the last change, then (when it fails) again after a growing wait.
export const SAVE_DELAY_MS = 1500;
export function retryDelay(attempt: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, attempt));
}

// Refusals after which saving stops for good (the round was answered, replaced, withdrawn, or the link
// died). Anything else (a network error, too many saves just now) is retried.
const STOP_STATUSES = new Set(["closed", "superseded", "withdrawn", "expired", "unknown", "invalid"]);
export function savingStops(status: string | undefined): boolean {
  return Boolean(status && STOP_STATUSES.has(status));
}

export type SaveState = "idle" | "saving" | "saved" | "error" | "stopped";
export function saveStateText(state: SaveState): string {
  switch (state) {
    case "saving":
      return "Saving…";
    case "saved":
      return "Saved";
    case "error":
      return "Couldn’t save — we’ll keep trying";
    case "stopped":
      return "Not saved";
    default:
      return "Your progress saves as you go";
  }
}

// "Nov 25, 2026": the same on the server and in the browser (no locale or time zone surprises).
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : DAY.format(date);
}
