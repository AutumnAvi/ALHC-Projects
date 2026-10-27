// Oct 26 notes (batch 3): review checks. An Editor sends some of a task's files to someone (by default the
// form's submitter) for review; they open a public, tokenized page (no sign-in), pin comments on the files
// (a point on an image or PDF page, a moment in a video), send files back, and Approve or send feedback.
// Mirrors 20261026010000_oct26_batch3_a.sql (part 7). Browser + server.
import { previewKind } from "@/lib/attachment-preview";
import { unsafeReceivedFile } from "@/lib/reply-attachments";

export const REVIEW_TOKEN_PATTERN = /^alhc_rev_[0-9a-f]{64}$/;
export const MAX_REVIEW_ASSETS = 20;
export const MAX_REVIEW_UPLOADS = 20;
export const MAX_REVIEW_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_REVIEW_PINS = 200;
export const MAX_PIN_TEXT = 2000;
export const MAX_REVIEW_NOTE = 5000;
export const MAX_REVIEW_MESSAGE = 2000;
export const REVIEW_LINK_DAYS = 30;

export function isReviewToken(value: unknown): value is string {
  return typeof value === "string" && REVIEW_TOKEN_PATTERN.test(value);
}

export type ReviewStatus = "pending" | "approved" | "changes_requested" | "superseded" | "cancelled";
export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  pending: "Waiting for review",
  approved: "Approved",
  changes_requested: "Changes requested",
  superseded: "Replaced by a newer round",
  cancelled: "Withdrawn",
};

// Plain words for a round (Oct 27 notes, batch 5): "Round 2", never "v2" or "version 2".
export function roundLabel(round: number): string {
  return `Round ${round}`;
}
export function isReviewStatus(value: unknown): value is ReviewStatus {
  return typeof value === "string" && value in REVIEW_STATUS_LABELS;
}

// How a file shows: images and PDFs as in the pane (previewKind), videos in a player, anything else as a
// download. SVG and HTML never show inline.
export type ReviewMediaKind = "image" | "pdf" | "video";
const VIDEO_TYPES: Record<string, string[]> = {
  mp4: ["video/mp4"],
  m4v: ["video/mp4", "video/x-m4v"],
  webm: ["video/webm"],
  mov: ["video/quicktime", "video/mp4"],
};
export function reviewMediaKind(fileName: string, contentType: string | null | undefined): ReviewMediaKind | null {
  const preview = previewKind(fileName, contentType);
  if (preview) return preview;
  const ext = fileName.match(/\.([A-Za-z0-9]{1,8})$/)?.[1]?.toLowerCase();
  const allowed = ext ? VIDEO_TYPES[ext] : undefined;
  if (!allowed) return null;
  const type = contentType?.split(";")[0].trim().toLowerCase();
  return !type || allowed.includes(type) ? "video" : null;
}

// A pin: a numbered comment on one file — a point (x, y from 0 to 1, on a PDF's page) or a moment of a
// video (time, seconds).
export type ReviewPin = {
  number: number;
  assetId: string;
  page: number | null;
  x: number | null;
  y: number | null;
  time: number | null;
  body: string;
};
export type ReviewFile = { id: string; name: string; contentType: string | null; size: number | null };

export function timeLabel(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
}

// Where a pin is, in words ("page 2", "at 0:12").
export function pinPlace(pin: Pick<ReviewPin, "page" | "time">): string {
  if (pin.time !== null) return `at ${timeLabel(pin.time)}`;
  if (pin.page !== null) return `page ${pin.page}`;
  return "";
}

// What a reviewer may send back (25 MB, never programs, scripts, web pages, or SVG).
export function reviewUploadProblem(file: { name: string; type: string; size: number }): string | null {
  if (unsafeReceivedFile({ filename: file.name, contentType: file.type || null })) return `${file.name}: this kind of file can’t be sent`;
  if (file.size <= 0) return `${file.name} is empty`;
  if (file.size > MAX_REVIEW_UPLOAD_BYTES) return `${file.name} is over 25 MB`;
  return null;
}

// What the public page shows (review_check_view): the round, who asked, the files, the pins.
export type PublicReview = {
  id: string;
  round: number;
  status: ReviewStatus;
  recipientName: string | null;
  recipientEmail: string;
  message: string | null;
  senderName: string | null;
  taskTitle: string;
  projectName: string | null;
  workspaceName: string | null;
  workspaceLogoPath: string | null;
  expiresAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  assets: ReviewFile[];
  pins: ReviewPin[];
  files: ReviewFile[];
  // Oct 27 notes (batch 5): what the reviewer saved as they went (open rounds only), whether they closed
  // the "How it works" walkthrough before, and the previous answered round sent to them (with its pins).
  draft: ReviewDraft | null;
  walkthroughSeen: boolean;
  previous: PreviousRound | null;
};

// The reviewer's saved progress (review_check_save): pins (a pin may have no text yet), the overall
// note, the answer they picked, and the file they were on.
export type ReviewDraftPin = {
  assetId: string;
  page: number | null;
  x: number | null;
  y: number | null;
  time: number | null;
  body: string;
};
export type ReviewDecision = "approved" | "changes_requested";
export type ReviewDraft = {
  pins: ReviewDraftPin[];
  note: string;
  decision: ReviewDecision | null;
  activeAsset: string | null;
};

// The round before, to the same reviewer, that they answered: shown collapsed with its pins.
export type PreviousRound = {
  id: string;
  round: number;
  status: ReviewStatus;
  decidedAt: string | null;
  decisionNote: string | null;
  assets: ReviewFile[];
  pins: ReviewPin[];
};

export type PublicReviewResult =
  | { status: "ok"; review: PublicReview }
  | { status: "unknown" | "expired" | "rate_limited" | "withdrawn" | "superseded" };

const VIEW_REFUSALS = ["expired", "rate_limited", "withdrawn", "superseded"] as const;

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function parseReviewFiles(value: unknown): ReviewFile[] {
  return (Array.isArray(value) ? value : []).flatMap((item) => {
    const o = obj(item);
    const id = str(o?.id);
    const name = str(o?.name);
    return o && id && name ? [{ id, name, contentType: str(o.content_type), size: num(o.size) }] : [];
  });
}

export function parseReviewPins(value: unknown): ReviewPin[] {
  return (Array.isArray(value) ? value : []).flatMap((item) => {
    const o = obj(item);
    const assetId = str(o?.asset_id);
    const number = num(o?.number);
    const body = str(o?.body);
    if (!o || !assetId || number === null || !body) return [];
    return [{ number, assetId, page: num(o.page), x: num(o.x), y: num(o.y), time: num(o.time), body }];
  });
}

export function parseReviewDraft(value: unknown): ReviewDraft | null {
  const o = obj(value);
  if (!o) return null;
  const pins = (Array.isArray(o.pins) ? o.pins : []).flatMap((item): ReviewDraftPin[] => {
    const p = obj(item);
    const assetId = str(p?.asset_id);
    if (!p || !assetId) return [];
    const x = num(p.x);
    const y = num(p.y);
    const time = num(p.time);
    // A pin needs a place: a point on the file, or a moment of a video.
    if ((x === null || y === null) && time === null) return [];
    return [{ assetId, page: num(p.page), x: x !== null && y !== null ? x : null, y: x !== null && y !== null ? y : null, time, body: typeof p.body === "string" ? p.body : "" }];
  });
  const decision = o.decision === "approved" || o.decision === "changes_requested" ? o.decision : null;
  return { pins, note: typeof o.note === "string" ? o.note : "", decision, activeAsset: str(o.active_asset) };
}

export function parsePreviousRound(value: unknown): PreviousRound | null {
  const o = obj(value);
  const id = str(o?.id);
  if (!o || !id || !isReviewStatus(o.status)) return null;
  return {
    id,
    round: num(o.round) ?? 1,
    status: o.status,
    decidedAt: str(o.decided_at),
    decisionNote: str(o.decision_note),
    assets: parseReviewFiles(o.assets),
    pins: parseReviewPins(o.pins),
  };
}

export function parsePublicReview(value: unknown): PublicReviewResult {
  const o = obj(value);
  const status = o?.status;
  if (status !== "ok") {
    return { status: (VIEW_REFUSALS as readonly unknown[]).includes(status) ? (status as (typeof VIEW_REFUSALS)[number]) : "unknown" };
  }
  const r = obj(o?.review);
  if (!r || !str(r.id) || !isReviewStatus(r.status)) return { status: "unknown" };
  return {
    status: "ok",
    review: {
      id: r.id as string,
      round: num(r.round) ?? 1,
      status: r.status,
      recipientName: str(r.recipient_name),
      recipientEmail: str(r.recipient_email) ?? "",
      message: str(r.message),
      senderName: str(r.sender_name),
      taskTitle: str(r.task_title) ?? "Task",
      projectName: str(r.project_name),
      workspaceName: str(r.workspace_name),
      workspaceLogoPath: str(r.workspace_logo_path),
      expiresAt: str(r.expires_at) ?? "",
      decidedAt: str(r.decided_at),
      decisionNote: str(r.decision_note),
      assets: parseReviewFiles(o?.assets),
      pins: parseReviewPins(o?.pins),
      files: parseReviewFiles(o?.files),
      draft: r.status === "pending" ? parseReviewDraft(o?.draft) : null,
      walkthroughSeen: o?.walkthrough_seen === true,
      previous: parsePreviousRound(o?.previous),
    },
  };
}

// The words for the public functions' refusals.
export const REVIEW_REFUSALS: Record<string, string> = {
  unknown: "This review link isn’t valid any more. Ask for a new one.",
  expired: "This review link has expired. Ask for a new one.",
  rate_limited: "Too many requests on this link just now. Wait a few minutes and try again.",
  withdrawn: "This review was withdrawn by the team that sent it.",
  superseded: "A newer round was sent for review. Use the link in the latest email.",
  closed: "This review is already closed.",
  invalid: "Something in the feedback wasn’t right. Check the pins and try again.",
  empty: "Add a note or at least one pin so they know what to change.",
  blocked_type: "This kind of file can’t be sent (programs, scripts, web pages, SVG).",
  too_large: "Files can be at most 25 MB.",
  too_many: "This review has as many files as it can take (20 files, 500 MB).",
  missing: "The upload didn’t finish. Try again.",
};

// One round as the task's Reviews tab shows it (read with the viewer's own client).
export type TaskReviewRound = {
  id: string;
  round: number;
  status: ReviewStatus;
  recipientEmail: string;
  recipientName: string | null;
  message: string | null;
  senderId: string;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  lastViewedAt: string | null;
  // When the reviewer last saved progress on the page (Oct 27 notes, batch 5; not what they wrote).
  draftSavedAt: string | null;
  // The round's files: asset id (pins point at it) + the task attachment it shows.
  assets: (ReviewFile & { attachmentId: string })[];
  pins: ReviewPin[];
  files: ReviewFile[];
};
