import { after } from "next/server";
import { drainOutbox } from "@/lib/email";
import { copyForwardedAttachments, copyReplyAttachments } from "@/lib/email-forward";
import {
  bareAddress,
  forwardSenderVerified,
  forwardTokenFrom,
  forwardedText,
  htmlToText,
  isInboundEmailConfigured,
  replyTokenFrom,
  type SenderAuthentication,
  stripQuotedReply,
  submitterReplyVerified,
  verifyResendWebhook,
} from "@/lib/email-reply";
import { isResendDeliveryEvent, RESEND_DELIVERY_EVENTS } from "@/lib/email-schedules";
import { drainIntegrationOutbox } from "@/lib/integrations";
import { createAdminClient } from "@/lib/supabase/admin";

// Reply by email — since Comments and reply by email, only for form submitters. A response someone sends
// to a form task's submitter ("Send response to submitter") carries Reply-To r-<token>@<reply domain>;
// Resend receives the submitter's reply and POSTs an `email.received` webhook here. This is a
// machine-to-machine background route, not a user's request: it does nothing until the Resend webhook
// signature (RESEND_WEBHOOK_SECRET, Svix scheme) checks out, then fetches the message from Resend's
// Receiving API (the webhook carries no body), keeps only the text above the quoted part, and calls
// post_submitter_reply() with the service role — the only role that can run it. The database posts the
// reply as an authorless "Replied via <email>" comment only when the token is a live submitter thread
// and the sender is that thread's submitter; anything else (an unknown or revoked token, an old follower
// token from before the redesign, another sender) is refused and logged, never posted. Follower emails are
// no-reply. Without RESEND_WEBHOOK_SECRET the route answers 503 (and responses carry no Reply-To).
// Nothing logs a body, an address, a token, or a secret.
//
// Forwarding (Real features 1) uses the same verified webhook: mail to f-<token>@<reply domain> (a
// person's forwarding address, Settings → Email forwarding) becomes a task through post_email_forward()
// — only when the sender is the token's person and Resend reports DMARC passing for it; the token is the
// secret, never the From header alone. Unknown and rotated tokens are logged (email_forwards) and
// dropped. The email's attachments are copied into the task after the response.
//
// Delivery tracking (Real features 3) uses the same verified webhook too: email.delivered,
// email.delivery_delayed, email.bounced, email.complained, and email.suppressed events are stored on the
// outbox row they belong to (record_email_event, service role), and a permanent bounce, a spam complaint,
// or Resend's own suppression puts the address on the suppression list (Admin console → Email).

export const dynamic = "force-dynamic";
// Copying a forwarded email's attachments (up to 10 × 25 MB) runs after the response.
export const maxDuration = 60;

const MAX_WEBHOOK_BYTES = 256 * 1024;
// How long a delivery event for an email id we don't know yet is worth a retry (see deliveryEvent).
const RETRY_UNKNOWN_FOR_MS = 90_000;

function json(body: unknown, status: number) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

type Received = {
  from?: unknown;
  subject?: unknown;
  text?: unknown;
  html?: unknown;
  attachments?: unknown;
  authentication?: SenderAuthentication;
};

export async function POST(request: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!isInboundEmailConfigured() || !secret) {
    return json({ ok: false, error: "Reply by email is not configured" }, 503);
  }

  if (Number(request.headers.get("content-length") ?? "0") > MAX_WEBHOOK_BYTES) {
    return json({ ok: false, error: "Too large" }, 413);
  }
  const raw = await request.text();
  if (raw.length > MAX_WEBHOOK_BYTES) return json({ ok: false, error: "Too large" }, 413);

  const verified = verifyResendWebhook(
    secret,
    {
      id: request.headers.get("svix-id"),
      timestamp: request.headers.get("svix-timestamp"),
      signature: request.headers.get("svix-signature"),
    },
    raw,
  );
  if (!verified) return json({ ok: false, error: "Unauthorized" }, 401);

  let event: {
    type?: unknown;
    created_at?: unknown;
    data?: {
      email_id?: unknown;
      to?: unknown;
      received_for?: unknown;
      bounce?: { type?: unknown; subType?: unknown } | null;
      suppressed?: { type?: unknown } | null;
    };
  };
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  // Delivery events for emails we sent (Real features 3): delivered, delayed, bounced, complained, or
  // suppressed by Resend, stored on the outbox row; permanent bounces and complaints stop further email.
  if (isResendDeliveryEvent(event.type) && event.data) return deliveryEvent(event.type, event.created_at, event.data);
  // Acknowledge anything that isn't a received email (or isn't for a reply address) so Resend stops.
  if (event.type !== "email.received" || !event.data) return json({ ok: true, ignored: true }, 200);
  const recipients = [
    ...(Array.isArray(event.data.to) ? event.data.to : []),
    ...(Array.isArray(event.data.received_for) ? event.data.received_for : []),
  ];
  const token = replyTokenFrom(recipients);
  const forwardToken = token ? null : forwardTokenFrom(recipients);
  const emailId = typeof event.data.email_id === "string" ? event.data.email_id : null;
  if ((!token && !forwardToken) || !emailId || !/^[\w-]{1,100}$/.test(emailId)) {
    return json({ ok: true, ignored: true }, 200);
  }

  const admin = createAdminClient();
  const apiKey = process.env.RESEND_API_KEY;
  if (!admin || !apiKey) return json({ ok: false, error: "Service unavailable" }, 503);

  // The webhook has metadata only; the text comes from the Receiving API.
  let message: Received;
  try {
    const response = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (!response.ok) {
      console.error("Reply by email: Resend returned", response.status);
      // 5xx lets Resend retry the webhook; the reply posts once (email id dedupe in the database).
      return json({ ok: false, error: "Couldn’t fetch the email" }, 502);
    }
    message = (await response.json()) as Received;
  } catch {
    console.error("Reply by email: couldn’t reach Resend");
    return json({ ok: false, error: "Couldn’t fetch the email" }, 502);
  }

  const sender = bareAddress(message.from);
  if (forwardToken) {
    if (!sender) {
      console.info("Forwarded email: rejected (no sender address)");
      return json({ ok: true, status: "rejected" }, 200);
    }
    return forwardedEmail(admin, apiKey, { forwardToken, sender, verified: forwardSenderVerified(message.authentication), emailId, message });
  }
  // Fails closed: no authentication result from Resend counts as unverified, and an unverified reply is
  // never posted under the submitter's address.
  if (!sender || !submitterReplyVerified(message.authentication)) {
    console.info(`Reply by email: rejected (${sender ? "unverified_sender" : "no sender address"})`);
    return json({ ok: true, status: "rejected" }, 200);
  }
  if (!token) return json({ ok: true, ignored: true }, 200);
  const text =
    typeof message.text === "string" && message.text.trim()
      ? message.text
      : typeof message.html === "string"
        ? htmlToText(message.html)
        : "";
  const body = stripQuotedReply(text);

  const { data, error } = await admin.rpc("post_submitter_reply", {
    reply_token: token,
    sender_email: sender,
    reply_body: body,
    provider_email_id: emailId,
  });
  if (error) {
    // A database without 20261014030000_comments_email.sql has no submitter threads: nothing to post.
    if (error.code === "PGRST202") return json({ ok: true, ignored: true }, 200);
    console.error("Reply by email failed", error.code);
    return json({ ok: false, error: "Something went wrong" }, 500);
  }
  const result = (data ?? {}) as { ok?: boolean; status?: string; reason?: string; comment_id?: string; task_id?: string };
  if (result.status !== "posted") {
    console.info(`Reply by email: ${result.status ?? "rejected"}${result.reason ? ` (${result.reason})` : ""}`);
    return json({ ok: true, status: result.status ?? "rejected" }, 200);
  }

  // The reply's attachments go to the task, linked on the new comment (too-large ones are noted on
  // it); then the emails the comment queued for the followers go out.
  const hasAttachments = Array.isArray(message.attachments) && message.attachments.length > 0;
  const { comment_id: commentId, task_id: replyTaskId } = result;
  after(async () => {
    if (hasAttachments && commentId && replyTaskId) {
      try {
        const copied = await copyReplyAttachments(admin, apiKey, { emailId, commentId, taskId: replyTaskId });
        console.info(`Reply by email: ${copied.added} attachment(s) added, ${copied.skipped} skipped`);
      } catch (e) {
        console.error("Reply by email: attachments failed", e instanceof Error ? e.name : "error");
      }
    }
    try {
      await drainOutbox();
    } catch (e) {
      console.error("Email delivery failed", e instanceof Error ? e.name : "error");
    }
    try {
      await drainIntegrationOutbox({ max: 10 });
    } catch (e) {
      console.error("Integration delivery failed", e instanceof Error ? e.name : "error");
    }
  });
  return json({ ok: true, status: "posted" }, 200);
}

// A forwarded email becomes the person's task (post_email_forward decides where, or refuses); its
// attachments and the queued emails follow after the response.
async function forwardedEmail(
  admin: NonNullable<ReturnType<typeof createAdminClient>>,
  apiKey: string,
  input: { forwardToken: string; sender: string; verified: boolean; emailId: string; message: Received },
) {
  const { data, error } = await admin.rpc("post_email_forward", {
    forward_token: input.forwardToken,
    sender_email: input.sender,
    sender_verified: input.verified,
    email_subject: typeof input.message.subject === "string" ? input.message.subject.slice(0, 2000) : "",
    email_body: forwardedText(input.message.text, input.message.html),
    provider_email_id: input.emailId,
  });
  if (error) {
    console.error("Forwarded email failed", error.code);
    return json({ ok: false, error: "Something went wrong" }, 500);
  }
  const result = (data ?? {}) as { status?: string; reason?: string; task_id?: string; forward_id?: string };
  if (result.status !== "created" || !result.task_id || !result.forward_id) {
    console.info(`Forwarded email: ${result.status ?? "rejected"}${result.reason ? ` (${result.reason})` : ""}`);
    return json({ ok: true, status: result.status ?? "rejected" }, 200);
  }
  const { task_id: taskId, forward_id: forwardId } = result;
  const hasAttachments = Array.isArray(input.message.attachments) && input.message.attachments.length > 0;
  after(async () => {
    if (hasAttachments) {
      try {
        const copied = await copyForwardedAttachments(admin, apiKey, { emailId: input.emailId, forwardId, taskId });
        console.info(`Forwarded email: ${copied.added} attachment(s) added, ${copied.skipped} skipped`);
      } catch (e) {
        console.error("Forwarded email: attachments failed", e instanceof Error ? e.name : "error");
      }
    }
    try {
      await drainOutbox();
    } catch (e) {
      console.error("Email delivery failed", e instanceof Error ? e.name : "error");
    }
    try {
      await drainIntegrationOutbox({ max: 10 });
    } catch (e) {
      console.error("Integration delivery failed", e instanceof Error ? e.name : "error");
    }
  });
  return json({ ok: true, status: "created" }, 200);
}

// Text fields of a bounce or suppression report, trimmed (never the free-text message: it can hold the
// address or the receiving server's details).
function shortText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 60) : null;
}

function eventTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

// A delivery event for one of our emails, recorded with the service role (record_email_event is
// service_role only). Events for emails we never sent (another app on the same Resend account, or rows
// the log purge removed) are acknowledged and ignored. 5xx lets Resend retry; a retry is harmless.
async function deliveryEvent(
  type: (typeof RESEND_DELIVERY_EVENTS)[number],
  createdAt: unknown,
  data: { email_id?: unknown; bounce?: { type?: unknown; subType?: unknown } | null; suppressed?: { type?: unknown } | null },
) {
  const emailId = typeof data.email_id === "string" ? data.email_id : null;
  if (!emailId || !/^[\w-]{1,100}$/.test(emailId)) return json({ ok: true, ignored: true }, 200);
  const admin = createAdminClient();
  if (!admin) return json({ ok: false, error: "Service unavailable" }, 503);
  const bounce = data.bounce && typeof data.bounce === "object" ? data.bounce : null;
  const suppressed = data.suppressed && typeof data.suppressed === "object" ? data.suppressed : null;
  const { data: result, error } = await admin.rpc("record_email_event", {
    provider_email_id: emailId,
    event_type: type,
    event_time: eventTime(createdAt),
    bounce_type: shortText(bounce?.type ?? suppressed?.type),
    bounce_subtype: shortText(bounce?.subType),
  });
  if (error) {
    // A database without this release's update can't store it; acknowledge so Resend doesn't retry forever.
    if (error.code === "PGRST202") return json({ ok: true, ignored: true }, 200);
    console.error("Email event failed", error.code);
    return json({ ok: false, error: "Something went wrong" }, 500);
  }
  const status = (result as { status?: string } | null)?.status ?? "ignored";
  console.info(`Email event: ${type} → ${status}`);
  // A very fresh event can beat the drain recording Resend's id on the email (the send and the event race);
  // a 503 makes Resend try again shortly. Older unknown ids (not our email) are acknowledged.
  const happened = eventTime(createdAt);
  if (status === "unknown" && happened && Date.now() - Date.parse(happened) < RETRY_UNKNOWN_FOR_MS) {
    return json({ ok: false, error: "Not recorded yet" }, 503);
  }
  return json({ ok: true, status }, 200);
}

export async function GET() {
  return json({ ok: false, error: "Method not allowed" }, 405);
}
