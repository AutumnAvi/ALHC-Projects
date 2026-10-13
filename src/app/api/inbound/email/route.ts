import { after } from "next/server";
import { drainOutbox } from "@/lib/email";
import { copyForwardedAttachments } from "@/lib/email-forward";
import {
  bareAddress,
  forwardTokenFrom,
  forwardedText,
  htmlToText,
  isInboundEmailConfigured,
  replyTokenFrom,
  stripQuotedReply,
  verifyResendWebhook,
} from "@/lib/email-reply";
import { drainIntegrationOutbox } from "@/lib/integrations";
import { createAdminClient } from "@/lib/supabase/admin";

// Reply by email. Resend receives mail for r-<token>@<reply domain> and POSTs an `email.received`
// webhook here. This is a machine-to-machine background route, not a user's request: it does nothing
// until the Resend webhook signature (RESEND_WEBHOOK_SECRET, Svix scheme) checks out, then fetches the
// message from Resend's Receiving API (the webhook carries no body), keeps only the text above the
// quoted part, and calls post_email_reply() with the service role — the only role that can run it. The
// database posts the comment only when the sender is the token's person, who must still be allowlisted
// and a Commenter+ on the task. Without RESEND_WEBHOOK_SECRET the route answers 503 (and comment emails
// carry no Reply-To). Nothing logs a body, an address, or a secret.
//
// Forwarding (Real features 1) uses the same verified webhook: mail to f-<token>@<reply domain> (a
// person's forwarding address, Settings → Email forwarding) becomes a task through post_email_forward()
// — only when the sender is the token's person and Resend reports DMARC passing for it; the token is the
// secret, never the From header alone. Unknown and rotated tokens are logged (email_forwards) and
// dropped. The email's attachments are copied into the task after the response.

export const dynamic = "force-dynamic";
// Copying a forwarded email's attachments (up to 10 × 25 MB) runs after the response.
export const maxDuration = 60;

const MAX_WEBHOOK_BYTES = 256 * 1024;

function json(body: unknown, status: number) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

type Received = {
  from?: unknown;
  subject?: unknown;
  text?: unknown;
  html?: unknown;
  attachments?: unknown;
  authentication?: { spf?: unknown; dkim?: unknown; dmarc?: unknown } | null;
};

// Defence in depth on top of the secret token and the sender match: when Resend reports the sender's
// authentication, DMARC must not fail and SPF or DKIM must pass.
function senderAuthenticated(message: Received): boolean {
  const auth = message.authentication;
  if (!auth || typeof auth !== "object") return true;
  if (auth.dmarc === "fail") return false;
  if (auth.spf === undefined && auth.dkim === undefined) return true;
  return auth.spf === "pass" || auth.dkim === "pass";
}

// A forward creates a task as the person, so its From must be proven theirs: Resend must report DMARC
// passing (SPF or DKIM aligned with the From domain). No report, or anything else, is refused and logged
// for the person ("didn't pass sender checks").
function forwardSenderVerified(message: Received): boolean {
  const auth = message.authentication;
  return Boolean(auth && typeof auth === "object" && auth.dmarc === "pass");
}

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

  let event: { type?: unknown; data?: { email_id?: unknown; to?: unknown; received_for?: unknown } };
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
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
    return forwardedEmail(admin, apiKey, { forwardToken, sender, verified: forwardSenderVerified(message), emailId, message });
  }
  if (!sender || !senderAuthenticated(message)) {
    console.info("Reply by email: rejected (sender not authenticated)");
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

  const { data, error } = await admin.rpc("post_email_reply", {
    reply_token: token,
    sender_email: sender,
    reply_body: body,
    provider_email_id: emailId,
  });
  if (error) {
    console.error("Reply by email failed", error.code);
    return json({ ok: false, error: "Something went wrong" }, 500);
  }
  const result = (data ?? {}) as { ok?: boolean; status?: string; reason?: string };
  if (result.status !== "posted") {
    console.info(`Reply by email: ${result.status ?? "rejected"}${result.reason ? ` (${result.reason})` : ""}`);
    return json({ ok: true, status: result.status ?? "rejected" }, 200);
  }

  // The new comment queued emails for the other followers; send them now.
  after(async () => {
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

export async function GET() {
  return json({ ok: false, error: "Method not allowed" }, 405);
}
