import "server-only";
// AI builder pilot (experimental, feat/ai-builder): what every AI builder route does before the layer runs —
// same-origin JSON only (a cross-site page can't start a billable call with someone's cookies), a body
// size cap, a parsed object — and how the layer's errors become HTTP answers. Errors carry the layer's
// plain message only; nothing else (no provider message, prompt, or key) is ever returned or logged.
import { NextResponse, type NextRequest } from "next/server";
import { AUTOMATION_LIMIT_REACHED, EDIT_LIMIT_REACHED, LIMIT_REACHED } from "@alhc/core/api/ai-builder/mutations";
import { ASSISTANT_LIMIT_REACHED } from "@alhc/core/ai-assistant";
import { isApiError, type ApiErrorCode } from "@alhc/core/api/core/errors";
import type { ApiContext } from "@alhc/core/api/core/context";
import { routeContext } from "@/lib/server/context";

const STATUS: Record<ApiErrorCode, number> = {
  invalid: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
  not_deployed: 503,
  failed: 502,
};

const LIMITS = new Set([LIMIT_REACHED, EDIT_LIMIT_REACHED, AUTOMATION_LIMIT_REACHED, ASSISTANT_LIMIT_REACHED]);

export async function aiRoute(
  request: NextRequest,
  opts: { maxBody: number; label: string },
  handle: (ctx: ApiContext, body: Record<string, unknown>) => Promise<unknown>,
) {
  const headers = { "Cache-Control": "private, no-store" };
  const origin = request.headers.get("origin");
  if (!origin || origin !== request.nextUrl.origin) return NextResponse.json({ error: "Forbidden" }, { status: 403, headers });
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
    return NextResponse.json({ error: "Send JSON" }, { status: 415, headers });
  }
  const raw = await request.text();
  if (raw.length > opts.maxBody) return NextResponse.json({ error: "The request is too long" }, { status: 413, headers });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400, headers });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid request" }, { status: 400, headers });
  try {
    const ctx = await routeContext();
    return NextResponse.json(await handle(ctx, body as Record<string, unknown>), { headers });
  } catch (error) {
    if (isApiError(error)) {
      const status = LIMITS.has(error.message) ? 429 : STATUS[error.code];
      return NextResponse.json({ error: error.message, code: error.code }, { status, headers });
    }
    console.error(`[ai-builder] ${opts.label} failed`);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500, headers });
  }
}
