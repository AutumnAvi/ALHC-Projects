// Oct 27 notes (batch 5): the public review page's rules, kept pure so they're easy to test. Which file
// opens first, what "File 2 of 5" says, what the reviewer's saved progress looks like on the page and on
// the way back to the database (review_check_save), when the "How it works" walkthrough shows, what has to
// be true before an answer can be sent, and how the video timeline is marked. Browser + server.
import type { ReviewDecision, ReviewDraft, ReviewFile, ReviewPin, ReviewStatus } from "@/lib/review-checks";

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

export type PortalState = {
  pins: KeyedPin[];
  note: string;
  decision: ReviewDecision | null;
  activeAsset: string | null;
};

// What review_check_save takes (ReviewProgress in review-public-actions.ts).
export type PortalProgress = {
  pins: { assetId: string; page: number | null; x: number | null; y: number | null; time: number | null; body: string }[];
  note: string;
  decision: ReviewDecision | null;
  activeAsset: string | null;
};

// The page's starting state: what the reviewer saved (pins on files still in this round, with stable
// keys), and the answer the email's button asked for (Approve / Leave feedback) over the saved one.
export function draftToState(
  draft: ReviewDraft | null,
  assets: ReviewFile[],
  action: "approve" | "feedback" | null = null,
): PortalState {
  const known = new Set(assets.map((a) => a.id));
  const pins = (draft?.pins ?? [])
    .filter((p) => known.has(p.assetId))
    .map((p, i) => ({ key: `saved-${i}`, assetId: p.assetId, page: p.page, x: p.x, y: p.y, time: p.time, body: p.body }));
  const decision: ReviewDecision | null =
    action === "approve" ? "approved" : action === "feedback" ? "changes_requested" : (draft?.decision ?? null);
  const activeAsset = draft?.activeAsset && known.has(draft.activeAsset) ? draft.activeAsset : null;
  return { pins, note: draft?.note ?? "", decision, activeAsset };
}

export function stateToProgress(state: PortalState): PortalProgress {
  return {
    pins: state.pins.map(({ assetId, page, x, y, time, body }) => ({ assetId, page, x, y, time, body })),
    note: state.note,
    decision: state.decision,
    activeAsset: state.activeAsset,
  };
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

// Why the answer can't be sent yet (null: it can).
export function answerProblem(state: Pick<PortalState, "decision" | "note" | "pins">): string | null {
  if (!state.decision) return "Pick Approve or Request changes first.";
  if (state.pins.some((p) => !p.body.trim())) return "Some pins have no comment yet. Write one, or remove the pin.";
  if (state.decision === "changes_requested" && !state.note.trim() && !state.pins.length) {
    return "Add a note or pin at least one comment so they know what to change.";
  }
  return null;
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
  if (decision === "approved") return "Send approval";
  if (decision === "changes_requested") return "Send feedback";
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
