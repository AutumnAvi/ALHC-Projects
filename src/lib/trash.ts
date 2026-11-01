// Nov 1 notes, item 66: anything moved to the Trash (tasks, projects, comments, attachments and their
// files) is removed permanently this many days later by the daily purge (alhc_purge_trash, pg_cron
// alhc-trash-purge). Mirrors trash_retention_days() in 20261101020000_nov1_batch9a_a.sql. Pure and
// server-safe: the Trash page and the pane's "This task is in the Trash" share it.
export const TRASH_RETENTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

// Whole days left before the purge removes something deleted at `deletedAt` (0 = it goes at the next
// daily run). The purge takes rows deleted more than 90 days before it runs, so a row deleted 89.5 days
// ago has 1 day left.
export function trashDaysLeft(deletedAt: string, now: number = Date.now()): number {
  const deleted = Date.parse(deletedAt);
  if (Number.isNaN(deleted)) return TRASH_RETENTION_DAYS;
  const left = (deleted + TRASH_RETENTION_DAYS * DAY_MS - now) / DAY_MS;
  return Math.max(0, Math.ceil(left));
}

// "Deletes in 12 days" / "Deletes in 1 day" / "Deletes today".
export function trashDeletesInLabel(deletedAt: string, now: number = Date.now()): string {
  const days = trashDaysLeft(deletedAt, now);
  if (days <= 0) return "Deletes today";
  return `Deletes in ${days} ${days === 1 ? "day" : "days"}`;
}

export const TRASH_RETENTION_NOTE = `Items in the Trash are deleted permanently ${TRASH_RETENTION_DAYS} days after they were deleted, with their files.`;
