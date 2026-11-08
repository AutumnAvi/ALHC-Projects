import type { NextRequest } from "next/server";
import { proposeChanges } from "@alhc/core/api/ai-assistant/mutations";
import { createAnthropicProvider } from "@/lib/ai-builder/anthropic";
import { aiRoute } from "@/lib/ai-builder/route";

// AI builder round 3 (experimental, note 171): the global assistant's model call. The page is sent as kinds
// and ids only; the layer loads its context with the person's own access, checks the Testing data pilot,
// calls the routed model (Haiku or Sonnet), and stores the checked change set. Nothing is changed here:
// the person confirms it first (an action, applyAssistantChanges).
//   POST /api/ai-assistant/propose  { requestKey, page, instruction, localToday } → AssistantProposal
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  return aiRoute(request, { maxBody: 8_000, label: "assistant" }, (ctx, body) =>
    proposeChanges(
      ctx,
      { requestKey: body.requestKey, page: body.page, instruction: body.instruction, localToday: body.localToday },
      createAnthropicProvider(),
    ),
  );
}
