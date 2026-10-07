import { createClient } from "@supabase/supabase-js";
import { after } from "next/server";
import { drainOutbox } from "@/lib/email";
import { INBOUND_MAX_BODY_BYTES, INBOUND_TOKEN_PATTERN } from "@/lib/inbound-shared";
import { drainIntegrationOutbox } from "@/lib/integrations";
import { readSupabaseEnv } from "@/lib/env";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER } from "@/lib/integrations-shared";
import type { Database } from "@/lib/supabase/database.types";

// Inbound webhook: POST JSON here to create a task in the endpoint's project (Settings → Inbound). The
// public form pattern: no session and never the service role for the write — a cookie-less anon client
// calls receive_inbound_webhook, which checks the hashed token, the optional X-ALHC-Signature, size,
// rate limit, and Idempotency-Key, then writes the task as the endpoint's creator. Every
// authentication failure gets the same 401 so no response confirms that a token exists. Rules the new
// task fires may queue email / Slack / webhooks; like a form submission, those are delivered by the
// usual background drain after the response.

export const dynamic = "force-dynamic";

const UNAUTHORIZED = { ok: false, error: "Unauthorized" };

function json(body: unknown, status: number) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function readBody(request: Request): Promise<string | "too_large" | "not_utf8"> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > INBOUND_MAX_BODY_BYTES) return "too_large";
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > INBOUND_MAX_BODY_BYTES) {
      await reader.cancel();
      return "too_large";
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    // The signature covers the raw bytes; the database re-encodes this text as UTF-8, so only accept
    // bodies that round-trip exactly.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return "not_utf8";
  }
}

export async function POST(request: Request, ctx: RouteContext<"/api/inbound/[token]">) {
  const { token } = await ctx.params;
  if (!INBOUND_TOKEN_PATTERN.test(token)) return json(UNAUTHORIZED, 401);

  const env = readSupabaseEnv();
  if (!env) return json({ ok: false, error: "Service unavailable" }, 503);

  const body = await readBody(request);
  if (body === "too_large") return json({ ok: false, error: "The body is limited to 64 KB" }, 413);
  if (body === "not_utf8") return json({ ok: false, error: "The body must be UTF-8 JSON" }, 400);

  const supabase = createClient<Database>(env.url, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const result = await supabase.rpc("receive_inbound_webhook", {
    endpoint_token: token,
    raw_body: body,
    request_timestamp: request.headers.get(TIMESTAMP_HEADER),
    request_signature: request.headers.get(SIGNATURE_HEADER),
    idempotency_key: request.headers.get("idempotency-key"),
  });
  if (result.error) {
    console.error("Inbound webhook failed", result.error.code);
    return json({ ok: false, error: "Something went wrong" }, 500);
  }

  const data = (result.data ?? {}) as {
    ok?: boolean;
    status?: number;
    error?: string;
    task_id?: string;
    duplicate?: boolean;
    request_label?: string | null;
    warnings?: string[];
  };
  const status = typeof data.status === "number" && data.status >= 200 && data.status <= 599 ? data.status : 500;
  if (!data.ok) {
    return json(status === 401 ? UNAUTHORIZED : { ok: false, error: data.error ?? "Something went wrong" }, status);
  }

  if (status === 201) {
    after(async () => {
      try {
        await drainOutbox();
      } catch (error) {
        console.error("Email delivery failed", error);
      }
      try {
        await drainIntegrationOutbox({ max: 10 });
      } catch (error) {
        console.error("Integration delivery failed", error);
      }
    });
  }
  return json(
    {
      ok: true,
      task_id: data.task_id,
      ...(data.duplicate ? { duplicate: true } : {}),
      ...(data.request_label ? { request_label: data.request_label } : {}),
      ...(data.warnings && data.warnings.length ? { warnings: data.warnings } : {}),
    },
    status,
  );
}

// Anything but POST gets the same answer as a wrong token.
export async function GET() {
  return json(UNAUTHORIZED, 401);
}
