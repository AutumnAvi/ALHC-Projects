import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

// Reply by email (since Comments and reply by email, only for form submitters): a response sent to a
// form task's submitter carries Reply-To r-<token>@<reply domain>; Resend receives the reply, POSTs an
// `email.received` webhook (signed the Svix way) to /api/inbound/email, and the route posts the reply as
// a comment through post_submitter_reply(). Every other email the app sends is no-reply. Forwarding (Real features 1): mail to a person's
// f-<token>@<reply domain> address becomes a task through post_email_forward(). Nothing here logs bodies,
// addresses, or secrets.

export const DEFAULT_REPLY_DOMAIN = "reply.mail.autumnlakemarketing.com";
const TOKEN = /^[0-9a-f]{40}$/;
// Svix: reject timestamps more than five minutes from our clock (replays).
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export function replyDomain(): string {
  return (process.env.EMAIL_REPLY_DOMAIN?.trim().toLowerCase() || DEFAULT_REPLY_DOMAIN).replace(/^@/, "");
}

// Inbound replies are on only when the Resend webhook secret is set; without it the route answers 503
// and responses to submitters carry no Reply-To.
export function isInboundEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_WEBHOOK_SECRET?.trim());
}

export function replyAddress(token: string): string {
  return `r-${token}@${replyDomain()}`;
}

// A person's forwarding address (Settings → Email forwarding): f-<their token>@<reply domain>.
export function forwardingAddress(token: string): string {
  return `f-${token}@${replyDomain()}`;
}

// The bare address from `Name <a@b>` or `a@b`, lowercased; null when there isn't exactly one. A quoted
// display name can hold anything (`"<victim@x>" <attacker@y>`), so quoted parts are dropped first and the
// one <addr-spec> must end the value.
export function bareAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const unquoted = value.replace(/"(?:[^"\\]|\\.)*"/g, " ").trim();
  const angles = unquoted.match(/<[^<>]*>/g) ?? [];
  let candidate: string;
  if (angles.length === 1 && /<[^<>]*>$/.test(unquoted)) candidate = angles[0].slice(1, -1);
  else if (angles.length === 0 && !/[<>]/.test(unquoted)) candidate = unquoted;
  else return null;
  candidate = candidate.trim().toLowerCase();
  return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(candidate) ? candidate : null;
}

// The token after `prefix` in any recipient address on our reply domain.
function tokenFrom(addresses: unknown[], prefix: "r-" | "f-"): string | null {
  const domain = replyDomain();
  for (const value of addresses) {
    const address = bareAddress(value);
    if (!address) continue;
    const [local, host] = address.split("@");
    if (host !== domain || !local.startsWith(prefix)) continue;
    const token = local.slice(2);
    if (TOKEN.test(token)) return token;
  }
  return null;
}

// The reply token from any recipient address on our reply domain.
export function replyTokenFrom(addresses: unknown[]): string | null {
  return tokenFrom(addresses, "r-");
}

// The forwarding token from any recipient address on our reply domain (f-<token>@…).
export function forwardTokenFrom(addresses: unknown[]): string | null {
  return tokenFrom(addresses, "f-");
}

// Svix signature check (what Resend signs webhooks with): base64 HMAC-SHA256 with the base64 key after
// "whsec_", over "<svix-id>.<svix-timestamp>.<raw body>". The header holds space-separated "v1,<sig>"
// entries; any match passes. Constant-time compare.
export function verifyResendWebhook(
  secret: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  rawBody: string,
  now = Math.floor(Date.now() / 1000),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(now - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) return false;
  const key = Buffer.from(secret.trim().replace(/^whsec_/, ""), "base64");
  if (key.length === 0) return false;
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest();
  return signature.split(" ").some((entry) => {
    const [version, value] = entry.split(",", 2);
    if (version !== "v1" || !value) return false;
    const given = Buffer.from(value, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

// Plain text from an HTML body: quoted blocks out (unless `keepQuoted`, for forwarded emails whose
// point is the quoted message), line breaks kept, tags and entities resolved.
export function htmlToText(html: string, { keepQuoted = false } = {}): string {
  const body = html.replace(/<(head|style|script)[\s\S]*?<\/\1>/gi, "");
  return (
    keepQuoted
      ? body
      : body
          .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "\n")
          .replace(/<div[^>]*class="[^"]*gmail_quote[\s\S]*$/i, "")
          .replace(/<div[^>]*id="(?:divRplyFwdMsg|appendonsend)"[\s\S]*$/i, "")
  )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
      if (entity[0] === "#") {
        const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
      }
      return ENTITIES[entity.toLowerCase()] ?? match;
    });
}

// The marker a response to a form's submitter prints above the quoted part; anything from it down is
// ours. (Comment emails to followers printed "—— Reply above this line to comment ——" before they became
// no-reply; the cut below still matches both.)
export const SUBMITTER_REPLY_MARKER = "—— Reply above this line ——";

const CUTS = [
  /^-{2,}\s*Reply above this line/i,
  /^—— Reply above this line/,
  /^On .{1,300}wrote:\s*$/, // Gmail / Apple Mail (also split over two lines, handled below)
  /^Le .{1,300}a écrit\s*:\s*$/,
  /^Am .{1,300}schrieb .{0,200}:\s*$/,
  /^-{3,}\s*Original Message\s*-{3,}/i, // Outlook
  /^_{10,}\s*$/, // Outlook's rule above the From: block
  /^Sent from my /i, // mobile signatures
  /^Get Outlook for /i,
  /^--\s*$/, // the standard signature delimiter
];

// Keeps only what the person wrote: everything from the first quote marker, signature delimiter, or
// quoted (">") line down is cut, trailing blank lines are trimmed, and the result is capped at the
// comment limit (10,000 characters).
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trimEnd();
    const trimmed = line.trim();
    if (CUTS.some((pattern) => pattern.test(trimmed))) break;
    // "On Mon, Oct 5, 2026 at 9:00 AM Name <a@b>\nwrote:" split across two lines.
    if (/^On .{1,300}$/.test(trimmed) && /^.{0,200}wrote:\s*$/.test(lines[i + 1]?.trim() ?? "") && /\d/.test(trimmed)) break;
    if (trimmed.startsWith(">")) break;
    // Outlook's header block: "From: …" followed by "Sent: …" or "Date: …".
    if (/^From:\s/i.test(trimmed) && lines.slice(i + 1, i + 4).some((next) => /^(Sent|Date):\s/i.test(next.trim()))) break;
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 10_000);
}

// A forwarded email's description: all of it (the forwarded message is the point), as plain text, with
// runs of blank lines squeezed and capped at the task description limit (20,000 characters).
export function forwardedText(text: unknown, html: unknown): string {
  const raw =
    typeof text === "string" && text.trim()
      ? text
      : typeof html === "string"
        ? htmlToText(html, { keepQuoted: true })
        : "";
  return raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 20_000);
}
