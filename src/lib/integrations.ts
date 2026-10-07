import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json, Tables } from "@/lib/supabase/database.types";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  WEBHOOK_USER_AGENT,
  isAllowedHeaderName,
  isAllowedWebhookUrl,
} from "@/lib/integrations-shared";

// Delivery for integration_outbox (send_slack / call_webhook rule actions), the twin of
// drainOutbox() in email.ts. The database only queues rows; this POSTs them with the service role.
// INTEGRATIONS_MOCK=true marks rows "mocked" and logs them instead of POSTing (local/preview use).

type OutboxRow = Tables<"integration_outbox">;
type Result = { outcome: "sent" | "mocked" | "error"; response?: Json; error?: string };

const TIMEOUT_MS = 10_000;

export function isIntegrationsMocked() {
  return process.env.INTEGRATIONS_MOCK === "true";
}

// Absolute app origin for task deep links in webhook payloads; omitted when unknown.
function appOrigin(): string | null {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "");
  if (configured) return configured;
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return vercel ? `https://${vercel}` : null;
}

function record(value: Json): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

// A new signing secret (project or call_webhook action). Generated here, stored by the database, shown
// to the admin once, and never returned again.
export function generateSigningSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

// X-ALHC-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>.
export function webhookSignature(secret: string, timestamp: number, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

// {task_link} and the Block Kit title / button carry the task path behind an "alhc-link:" marker (the
// database doesn't know the app's origin). Only exact task paths are resolved. Without an origin a link
// becomes its plain title and the Open task button is dropped.
const TASK_PATH = "/projects/[0-9a-f-]{36}\\?task=[0-9a-f-]{36}";
const MRKDWN_LINK = new RegExp(`<alhc-link:(${TASK_PATH})\\|([^>]*)>`, "g");
const URL_MARKER = new RegExp(`^alhc-link:(${TASK_PATH})$`);

function isMarkerButton(value: Json): boolean {
  const item = record(value);
  return typeof item.url === "string" && URL_MARKER.test(item.url);
}

export function resolveSlackLinks(value: Json, origin: string | null): Json {
  if (typeof value === "string") {
    return value.replace(MRKDWN_LINK, (_, path: string, label: string) => (origin ? `<${origin}${path}|${label}>` : label));
  }
  if (Array.isArray(value)) {
    return value
      .filter((item) => origin || !isMarkerButton(item))
      .map((item) => resolveSlackLinks(item, origin))
      .filter((item) => {
        // An actions block left without elements is invalid Block Kit.
        const block = record(item);
        return !(block.type === "actions" && Array.isArray(block.elements) && block.elements.length === 0);
      });
  }
  if (value && typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      const marker = key === "url" && typeof item === "string" ? URL_MARKER.exec(item) : null;
      out[key] = marker && origin ? `${origin}${marker[1]}` : resolveSlackLinks(item, origin);
    }
    return out;
  }
  return value;
}

function body(row: OutboxRow): Json {
  const payload = record(row.payload);
  if (row.channel !== "webhook") return resolveSlackLinks(payload, appOrigin());
  const task = record(payload.task ?? null);
  const origin = appOrigin();
  if (!origin || typeof task.id !== "string") return payload;
  return { ...payload, task: { ...task, url: `${origin}/projects/${row.project_id}?task=${task.id}` } };
}

function headers(row: OutboxRow, rawBody: string): Record<string, string> {
  const out: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": WEBHOOK_USER_AGENT,
  };
  if (row.channel === "webhook") {
    out["Idempotency-Key"] = `integration-outbox-${row.id}`;
    for (const [name, value] of Object.entries(record(row.headers))) {
      if (isAllowedHeaderName(name) && typeof value === "string") out[name] = value;
    }
    // Signed at send time, so every attempt carries a fresh timestamp over the same stored body.
    if (row.signing_secret) {
      const timestamp = Math.floor(Date.now() / 1000);
      out[TIMESTAMP_HEADER] = String(timestamp);
      out[SIGNATURE_HEADER] = webhookSignature(row.signing_secret, timestamp, rawBody);
    }
  }
  return out;
}

async function deliver(row: OutboxRow): Promise<Result> {
  // Re-checked here as well as in the database: HTTPS only, no local/private hosts.
  if (!isAllowedWebhookUrl(row.target_url)) return { outcome: "error", error: "Target is not a public https:// URL" };
  if (isIntegrationsMocked()) {
    const signed = row.channel === "webhook" && row.signing_secret ? " signed" : "";
    console.info(`[integration:mocked] channel=${row.channel} target=${row.target_hint}${signed}`);
    return { outcome: "mocked" };
  }
  const rawBody = JSON.stringify(body(row));
  const response = await fetch(row.target_url, {
    method: "POST",
    headers: headers(row, rawBody),
    body: rawBody,
    // Never follow redirects: the secret header must only reach the configured host.
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  const text = (await response.text().catch(() => "")).slice(0, 500);
  const summary: Json = { status: response.status, body: text };
  if (!response.ok) {
    return { outcome: "error", response: summary, error: `${row.target_hint} responded ${response.status}` };
  }
  return { outcome: "sent", response: summary };
}

// Claims queued deliveries with the service role and POSTs them. Without SUPABASE_SERVICE_ROLE_KEY
// nothing is claimed and rows stay pending for a later run. Errors return rows to pending with a capped
// exponential backoff (5, 10, 20, then 30 minutes) until the row's attempt limit (5, plus one per manual
// retry), then they are marked failed. Retries send the same stored payload.
export async function drainIntegrationOutbox(options: { onlyId?: string | null; max?: number } = {}) {
  const admin = createAdminClient();
  if (!admin) return { claimed: 0, sent: 0, mocked: 0, failed: 0, skipped: "no service role key" as const };
  const { data, error } = await admin.rpc("claim_integration_outbox", {
    max_items: options.max ?? 20,
    only_id: options.onlyId ?? null,
  });
  if (error) throw new Error(`Failed to claim integration deliveries: ${error.message}`);
  const counts = { claimed: data?.length ?? 0, sent: 0, mocked: 0, failed: 0, gaveUp: 0 };
  // Rows go to independent receivers, so one slow endpoint doesn't hold up the rest of the batch.
  await Promise.all(
    (data ?? []).map(async (row) => {
      let result: Result;
      try {
        result = await deliver(row);
      } catch (e) {
        // Network errors and timeouts. Messages can include the URL, so keep only the error kind.
        result = { outcome: "error", error: `${row.target_hint}: ${e instanceof Error ? e.name : "request failed"}` };
      }
      if (result.outcome === "error") {
        counts.failed += 1;
        if (row.attempts >= row.max_attempts) counts.gaveUp += 1;
      } else counts[result.outcome] += 1;
      await admin.rpc("complete_integration_outbox", {
        target_item: row.id,
        outcome: result.outcome,
        response: result.response ?? null,
        error_message: result.error ?? null,
      });
    }),
  );
  return counts;
}
