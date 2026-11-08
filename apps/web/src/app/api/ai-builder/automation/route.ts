import type { NextRequest } from "next/server";
import { draftAutomation } from "@alhc/core/api/ai-builder/mutations";
import { createAnthropicProvider } from "@/lib/ai-builder/anthropic";
import { aiRoute } from "@/lib/ai-builder/route";

// AI builder round 2 (experimental): "Ask AI for an automation" (note 170) for a project of the Testing data
// workspace. The draft is checked with the rules engine's own checks and stored for the normal rule canvas
// to open; nothing is saved, run, or sent here.
//   POST /api/ai-builder/automation  { requestKey, projectId, description } → { runId, projectId }
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  return aiRoute(request, { maxBody: 8_000, label: "automation draft" }, (ctx, body) =>
    draftAutomation(ctx, { requestKey: body.requestKey, projectId: body.projectId, description: body.description }, createAnthropicProvider()),
  );
}
