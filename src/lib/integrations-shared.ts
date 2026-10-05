import type { Json } from "@/lib/supabase/database.types";

// Integration rules shared by the browser (form validation, redacted display) and the server
// (Server Actions, outbox drain). Mirrors integration_url_ok() / integration_header_ok() /
// integration_url_hint() in the integrations migration; the database stays the trust boundary.

export const DEFAULT_SECRET_HEADER = "X-ALHC-Webhook-Secret";
export const WEBHOOK_USER_AGENT = "ALHC-Projects-Webhook/1.0";
export const MAX_SECRET_LENGTH = 500;

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
};

export function toProjectIntegrations(value: Json): ProjectIntegrations {
  const r = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    slackWebhook: typeof r.slack_webhook === "string" ? r.slack_webhook : null,
    webhook: typeof r.webhook === "string" ? r.webhook : null,
    webhookSecretSet: r.webhook_secret_set === true,
    webhookSecretHeader: typeof r.webhook_secret_header === "string" ? r.webhook_secret_header : null,
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
