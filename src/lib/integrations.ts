import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json, Tables } from "@/lib/supabase/database.types";
import { WEBHOOK_USER_AGENT, isAllowedHeaderName, isAllowedWebhookUrl } from "@/lib/integrations-shared";

// Delivery for integration_outbox (send_slack / call_webhook rule actions), the twin of
// drainOutbox() in email.ts. The database only queues rows; this POSTs them with the service role.
// INTEGRATIONS_MOCK=true marks rows "mocked" and logs them instead of POSTing (local/preview use).

type OutboxRow = Tables<"integration_outbox">;
type Result = { outcome: "sent" | "mocked" | "error"; response?: Json; error?: string };

const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 5;

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

function body(row: OutboxRow): Json {
  const payload = record(row.payload);
  if (row.channel !== "webhook") return payload;
  const task = record(payload.task ?? null);
  const origin = appOrigin();
  if (!origin || typeof task.id !== "string") return payload;
  return { ...payload, task: { ...task, url: `${origin}/projects/${row.project_id}?task=${task.id}` } };
}

function headers(row: OutboxRow): Record<string, string> {
  const out: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": WEBHOOK_USER_AGENT,
  };
  if (row.channel === "webhook") {
    out["Idempotency-Key"] = `integration-outbox-${row.id}`;
    for (const [name, value] of Object.entries(record(row.headers))) {
      if (isAllowedHeaderName(name) && typeof value === "string") out[name] = value;
    }
  }
  return out;
}

async function deliver(row: OutboxRow): Promise<Result> {
  // Re-checked here as well as in the database: HTTPS only, no local/private hosts.
  if (!isAllowedWebhookUrl(row.target_url)) return { outcome: "error", error: "Target is not a public https:// URL" };
  if (isIntegrationsMocked()) {
    console.info(`[integration:mocked] channel=${row.channel} target=${row.target_hint}`);
    return { outcome: "mocked" };
  }
  const response = await fetch(row.target_url, {
    method: "POST",
    headers: headers(row),
    body: JSON.stringify(body(row)),
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
// nothing is claimed and rows stay pending for a later run. Errors return rows to pending (retried
// after 5 minutes) until the fifth attempt, then they are marked failed.
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
        if (row.attempts >= MAX_ATTEMPTS) counts.gaveUp += 1;
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
