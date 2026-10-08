import type { Json } from "@/lib/supabase/database.types";

// Integration rules shared by the browser (form validation, redacted display) and the server
// (Server Actions, outbox drain). Mirrors integration_url_ok() / integration_header_ok() /
// integration_url_hint() in the integrations migration; the database stays the trust boundary.

export const DEFAULT_SECRET_HEADER = "X-ALHC-Webhook-Secret";
export const WEBHOOK_USER_AGENT = "ALHC-Projects-Webhook/1.0";
export const MAX_SECRET_LENGTH = 500;

// HMAC body signing (Integration depth). The drain signs every webhook that has a signing secret:
//   X-ALHC-Timestamp: <unix seconds at send time>
//   X-ALHC-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw request body>")>
// Receivers recompute it over the raw body bytes, compare in constant time, and reject timestamps more
// than SIGNATURE_TOLERANCE_SECONDS away from their clock (AGENTS.md → "Integration depth model").
export const SIGNATURE_HEADER = "X-ALHC-Signature";
export const TIMESTAMP_HEADER = "X-ALHC-Timestamp";
export const SIGNATURE_TOLERANCE_SECONDS = 300;

// Mirrors the outbox: 5 automatic attempts (backing off 5, 10, 20, then 30 minutes); each manual retry
// allows one more, up to 10 in total (integration_retry_delay / retry_integration_delivery).
export const MAX_AUTO_ATTEMPTS = 5;
export const MAX_TOTAL_ATTEMPTS = 10;

// send_slack { format }: plain text (default) or Block Kit with the plain text as fallback.
export const SLACK_FORMATS = [
  { value: "text", label: "Plain text" },
  { value: "blocks", label: "Block Kit (task card)" },
] as const;

const URL_SHAPE = /^https:\/\/([A-Za-z0-9.-]+)(:[0-9]{1,5})?([/?#][^\s]*)?$/;
const PRIVATE_HOST = [
  /(^|\.)(localhost|local|internal)$/,
  /^(0|10|127)\./,
  /^(169\.254|192\.168)\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
];
// A numeric host must be a canonical dotted quad: integer, hex, and zero-padded (octal) spellings of
// private addresses would slip past the checks above.
const NUMERIC_HOST = /^(0x[0-9a-f]+|[0-9]+)(\.(0x[0-9a-f]+|[0-9]+)){0,3}$/;
const OCTET = "(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
const DOTTED_QUAD = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`);
const RESERVED_HEADERS = new Set([
  "content-type",
  "content-length",
  "host",
  "user-agent",
  "idempotency-key",
  "transfer-encoding",
  "connection",
  "accept-encoding",
  "x-alhc-signature",
  "x-alhc-timestamp",
]);

export function webhookHost(url: string): string | null {
  return URL_SHAPE.exec(url)?.[1]?.toLowerCase() ?? null;
}

// HTTPS only, a plain host (no user:password@), not a local or private address.
export function isAllowedWebhookUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2000) return false;
  const host = webhookHost(value);
  if (!host || PRIVATE_HOST.some((pattern) => pattern.test(host))) return false;
  return !NUMERIC_HOST.test(host) || DOTTED_QUAD.test(host);
}

export const WEBHOOK_URL_ERROR = "Webhook URLs must be public https:// addresses";

export function isAllowedHeaderName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(value) &&
    !RESERVED_HEADERS.has(value.toLowerCase())
  );
}

// "hooks.slack.com …x7Yz": the only form of a webhook URL shown anywhere.
export function webhookHint(url: string): string {
  return `${webhookHost(url) ?? "invalid URL"} …${url.slice(-4)}`;
}

// Redacted project defaults, as returned by get_project_integrations().
export type ProjectIntegrations = {
  slackWebhook: string | null;
  webhook: string | null;
  webhookSecretSet: boolean;
  webhookSecretHeader: string | null;
  signingSecretSet: boolean;
  signingSecretCreatedAt: string | null;
};

export function toProjectIntegrations(value: Json): ProjectIntegrations {
  const r = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    slackWebhook: typeof r.slack_webhook === "string" ? r.slack_webhook : null,
    webhook: typeof r.webhook === "string" ? r.webhook : null,
    webhookSecretSet: r.webhook_secret_set === true,
    webhookSecretHeader: typeof r.webhook_secret_header === "string" ? r.webhook_secret_header : null,
    signingSecretSet: r.signing_secret_set === true,
    signingSecretCreatedAt: typeof r.signing_secret_created_at === "string" ? r.signing_secret_created_at : null,
  };
}

export const INTEGRATION_SETTINGS = [
  "slack_webhook_url",
  "webhook_url",
  "webhook_secret",
  "webhook_secret_header",
] as const;

export type IntegrationSetting = (typeof INTEGRATION_SETTINGS)[number];

export function isIntegrationSetting(value: unknown): value is IntegrationSetting {
  return INTEGRATION_SETTINGS.includes(value as IntegrationSetting);
}

// One row of the delivery log (list_integration_deliveries): hints only, never a URL, secret, or signature.
export type DeliveryStatus = "pending" | "sending" | "sent" | "mocked" | "failed" | "cancelled";

export type IntegrationDelivery = {
  id: string;
  channel: "slack" | "webhook";
  taskId: string | null;
  taskTitle: string | null;
  ruleId: string | null;
  ruleName: string | null;
  targetHint: string;
  status: DeliveryStatus;
  attempts: number;
  maxAttempts: number;
  responseStatus: number | null;
  lastError: string | null;
  signed: boolean;
  nextAttemptAt: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  pending: "Waiting",
  sending: "Sending",
  sent: "Sent",
  mocked: "Mocked",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function isDeliveryStatus(value: unknown): value is DeliveryStatus {
  return typeof value === "string" && value in DELIVERY_STATUS_LABELS;
}

// Admin+ actions the log offers (the RPCs re-check): retry a waiting or failed delivery that still has
// attempts left, cancel one that is waiting.
export function canRetryDelivery(d: Pick<IntegrationDelivery, "status" | "attempts">) {
  return (d.status === "pending" || d.status === "failed") && d.attempts < MAX_TOTAL_ATTEMPTS;
}

export function canCancelDelivery(d: Pick<IntegrationDelivery, "status">) {
  return d.status === "pending";
}

// One email in the delivery log (list_email_deliveries): never the body or payload. `kind` is the
// template, or "comment" for a follower's comment email.
export type EmailDelivery = {
  id: string;
  kind: string;
  recipient: string;
  taskId: string;
  taskTitle: string | null;
  ruleName: string | null;
  status: Exclude<DeliveryStatus, "cancelled">;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export const EMAIL_KIND_LABELS: Record<string, string> = {
  comment: "Comment email",
  form_confirmation: "Form confirmation",
  requester_update: "Requester update",
  due_tomorrow: "Due tomorrow reminder",
  custom: "Rule email",
};

export function emailKindLabel(kind: string): string {
  return EMAIL_KIND_LABELS[kind] ?? "Email";
}
