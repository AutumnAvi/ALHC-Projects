// Nov 11 notes (189): a comment's author may change its text for 15 minutes after posting it (counted from
// `created_at`, never `edited_at`, so editing doesn't extend the window). Removing it has no time limit.
// The database refuses later edits too (`guard_comment_update`, 20261111010000_nov11_batch38_a.sql); this
// is the same rule for the pane, the API, and the AI tools.

export const COMMENT_EDIT_WINDOW_MINUTES = 15;
export const COMMENT_EDIT_WINDOW_MS = COMMENT_EDIT_WINDOW_MINUTES * 60 * 1000;

// What people read when the window has passed (the database's own message is the same).
export const COMMENT_EDIT_EXPIRED = "Comments can only be edited for 15 minutes";

// When the comment stops being editable, in ms since the epoch (NaN for a time that doesn't parse).
export function commentEditableUntil(createdAt: string): number {
  return Date.parse(createdAt) + COMMENT_EDIT_WINDOW_MS;
}

// Whether a comment posted at `createdAt` may still be edited at `now` (ms since the epoch). A time that
// doesn't parse is never editable.
export function commentEditWindowOpen(createdAt: string, now: number = Date.now()): boolean {
  const until = commentEditableUntil(createdAt);
  return Number.isFinite(until) && now <= until;
}

// How long until the window closes (0 once it has), for a timer that hides Edit on time.
export function commentEditMsLeft(createdAt: string, now: number = Date.now()): number {
  const until = commentEditableUntil(createdAt);
  return Number.isFinite(until) ? Math.max(0, until - now) : 0;
}
