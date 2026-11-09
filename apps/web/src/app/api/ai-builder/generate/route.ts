import type { NextRequest } from "next/server";
import { generateProposal } from "@alhc/core/api/ai-builder/mutations";
import { createAnthropicProvider } from "@/lib/ai-builder/anthropic";
import { aiRoute } from "@/lib/ai-builder/route";

// AI builder pilot (experimental, feat/ai-builder): one generation. A route rather than a Server Action so
// it gets its own time limit (a model call can take most of a minute). The signed-in person's own client;
// the layer checks the pilot access and the limits in the database before the model is called, and stores
// only the validated proposal. Nothing is created in the workspace here.
//   POST /api/ai-builder/generate  { requestKey, brief, templateId? } → { runId, proposal, version }
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  return aiRoute(request, { maxBody: 16_000, label: "generation" }, (ctx, body) =>
    generateProposal(ctx, { requestKey: body.requestKey, brief: body.brief, templateId: body.templateId }, createAnthropicProvider()),
  );
}
