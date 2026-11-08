import { NextResponse, type NextRequest } from "next/server";
import { LIMIT_REACHED, generateProposal } from "@alhc/core/api/ai-builder/mutations";
import { isApiError, type ApiErrorCode } from "@alhc/core/api/core/errors";
import { createAnthropicProvider } from "@/lib/ai-builder/anthropic";
import { routeContext } from "@/lib/server/context";

// AI builder pilot (experimental, feat/ai-builder): one generation. A route rather than a Server Action so
// it gets its own time limit (a model call can take most of a minute). The signed-in person's own client;
// the layer checks the pilot access and the limits in the database before the model is called, and stores
// only the validated proposal. Nothing is created in the workspace here.
//   POST /api/ai-builder/generate  { requestKey, brief, templateId? } → { runId, proposal, version }
export const maxDuration = 120;

const MAX_BODY = 16_000;

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

export async function POST(request: NextRequest) {
  const headers = { "Cache-Control": "private, no-store" };
  // Same-origin JSON only: a cross-site page can't start a (billable) generation with someone's cookies.
  const origin = request.headers.get("origin");
  if (!origin || origin !== request.nextUrl.origin) return NextResponse.json({ error: "Forbidden" }, { status: 403, headers });
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
    return NextResponse.json({ error: "Send JSON" }, { status: 415, headers });
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY) return NextResponse.json({ error: "The brief is too long" }, { status: 413, headers });
  let body: { requestKey?: unknown; brief?: unknown; templateId?: unknown } = {};
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400, headers });
  }
  try {
    const ctx = await routeContext();
    const result = await generateProposal(ctx, { requestKey: body.requestKey, brief: body.brief, templateId: body.templateId }, createAnthropicProvider());
    return NextResponse.json(result, { headers });
  } catch (error) {
    if (isApiError(error)) {
      const status = error.message === LIMIT_REACHED ? 429 : STATUS[error.code];
      return NextResponse.json({ error: error.message, code: error.code }, { status, headers });
    }
    console.error("[ai-builder] generation failed");
    return NextResponse.json({ error: "Something went wrong" }, { status: 500, headers });
  }
}
