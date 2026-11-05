// Big move 1: the reviews area's types (no database; safe in the browser). Review checks: a round of files
// sent from a task to a reviewer, answered on the public review page (Oct 26 notes, batch 3).
import type { AttachmentFileRow } from "../attachments/model";
import type { ActionResult } from "../core/result";
import type { ReviewDecision, RoundProject } from "../../review-checks";

export type SendReviewResult = ActionResult & {
  round?: number;
  // The email went out (false: no email provider here, sending failed, or the address is suppressed).
  emailed?: boolean;
  // The address bounced or marked an earlier email as spam (Admin console → Email): no email was sent.
  suppressed?: boolean;
  // Only when the email didn't go out: the link, shown once so the sender can pass it on themselves.
  link?: string;
};

// A round the database just made (create_review_check) or gave a new link (rotate_review_check_token):
// what the sender's email needs. The token is the link's key, handed back once (the database keeps only
// its hash).
export type ReviewRoundLink = {
  reviewId: string;
  taskId: string;
  // As the database answered it.
  round: number | undefined;
  token: string;
  // The address is on the suppression list: no email goes out.
  suppressed: boolean;
  recipientEmail: string;
  recipientName: string | null;
  message: string | null;
  expiresAt: Date;
  // The round's project as the database chose it (create_review_check / rotate_review_check_token: its
  // form's project, else the first of the task's projects, each only when the sender can read it). The
  // review page names the same one.
  project: RoundProject | null;
};

// A round's files, in order: the review asset and the task attachment it shows.
export type RoundAsset = { assetId: string; attachmentId: string };

// What the review email reads about the task, the sender, and the round's files (read with the sender's
// own client; anything unreadable is null / left out).
export type ReviewEmailDetails = {
  task: { title: string; root_task_id: string | null } | null;
  sender: { full_name: string | null; email: string } | null;
  attachments: AttachmentFileRow[];
};

// ---------------------------------------------------------------------------------------------
// The public review page
// ---------------------------------------------------------------------------------------------

export type DraftPin = { assetId: string; page?: number | null; x?: number | null; y?: number | null; time?: number | null; body: string };
export type DraftFile = { assetId: string; approved: boolean; note: string };

// Oct 27 notes (batch 5): the reviewer's progress, saved as they go (pins, the note, the answer they picked,
// the file they're on), so leaving the page loses nothing; and / or "they closed the walkthrough". Only the
// token decides (review_check_save: open rounds only, pins on this round's files only, its own rate limit).
export type ReviewProgress = {
  pins: DraftPin[];
  note: string;
  decision: ReviewDecision | null;
  activeAsset: string | null;
  // Nov 1 notes (batch 8): each file's own review (see submitReviewDecision).
  perFile?: boolean;
  files?: DraftFile[];
};

// One file of a round for the public page (review_check_file, then a signed link): the link, or why not.
export type ReviewFileLink =
  | { status: "ok"; url: string }
  // The database call failed.
  | { status: "error" }
  | { status: "rate_limited" }
  | { status: "expired" }
  // Not a file of this link's round (or no such link).
  | { status: "missing" }
  // Storage wouldn't sign it.
  | { status: "unsigned" };

// A file a reviewer sent back, for the task's Reviews tab.
export type ReturnedReviewFile = { storage_path: string; file_name: string; content_type: string | null };
