// Comments and reply by email (mirrors 20261014030000_comments_email.sql). Only a form task's submitter
// ever gets a replyable email: someone ticks "Send response to submitter" under the comment box, the
// comment is emailed to them (an "email comment", direction "sent"), and their reply comes back as a
// comment with no author (direction "received"). Every other email the app sends is no-reply.
// No "server-only" here: the pane and the unit tests use it too.

export type CommentEmailDirection = "sent" | "received";

// What Resend / the outbox say about a sent response (null for received replies, or when unknown).
export type CommentEmailStatus = "sending" | "sent" | "delivered" | "bounced" | "failed" | "not_sent";

export type CommentEmail = {
  direction: CommentEmailDirection;
  // The submitter's address: who it was sent to, or who replied.
  address: string;
  subject: string;
  status: CommentEmailStatus | null;
  // Why it wasn't sent (the outbox's reason), for a failed one.
  error: string | null;
};

// The subject Asana uses for responses: Re: "<form name>" submission received. The database stores the
// real one (submitter_response_subject(): the conversation's subject, else the requester design's subject
// template, else this); this is for the composer's optimistic row and the email designer's preview.
export function submitterResponseSubject(formTitle: string | null | undefined): string {
  const name = formTitle?.trim() || "Your request";
  return `Re: "${name}" submission received`.slice(0, 300);
}

export function parseCommentEmail(row: {
  email_direction?: string | null;
  email_address?: string | null;
  email_subject?: string | null;
}): Omit<CommentEmail, "status" | "error"> | null {
  const direction = row.email_direction;
  if (direction !== "sent" && direction !== "received") return null;
  if (!row.email_address || !row.email_subject) return null;
  return { direction, address: row.email_address, subject: row.email_subject };
}

// The outbox row's state as one word for the card ("Sending…", "Delivered", "Not sent").
export function commentEmailStatus(row: {
  status: string;
  delivery_status?: string | null;
}): CommentEmailStatus {
  if (row.status === "failed") return "failed";
  if (row.status === "mocked") return "not_sent";
  if (row.status === "sent") {
    if (row.delivery_status === "delivered") return "delivered";
    if (row.delivery_status === "bounced" || row.delivery_status === "complained" || row.delivery_status === "suppressed") {
      return "bounced";
    }
    return "sent";
  }
  return "sending";
}

export const COMMENT_EMAIL_STATUS_LABELS: Record<CommentEmailStatus, string> = {
  sending: "Sending…",
  sent: "Sent",
  delivered: "Delivered",
  bounced: "Bounced",
  failed: "Not sent",
  not_sent: "Not sent (no email provider)",
};

// The task can offer "Send response to submitter": a task a form created — or a subtask of one, which
// answers the request's submitter — with the submitter's address, for Editors and above (the database
// refuses anyone else), while the database has this release's update.
export function canRespondToSubmitter(task: {
  source: string;
  isSubtask: boolean;
  submission: { email: string } | null;
  submitterResponses: boolean;
  viewerRole?: string | null;
}): boolean {
  const editor = task.viewerRole === undefined || ["editor", "admin", "owner"].includes(task.viewerRole ?? "");
  return (
    editor && task.submitterResponses && (task.source === "form" || task.isSubtask) && Boolean(task.submission?.email)
  );
}
