import type { NextRequest } from "next/server";
import { editDraft } from "@alhc/core/api/ai-builder/mutations";
import { createAnthropicProvider } from "@/lib/ai-builder/anthropic";
import { aiRoute } from "@/lib/ai-builder/route";

// AI builder round 2 (experimental): an AI change to a draft (note 168). The latest draft (checked first)
// and the instruction go to the small model; its bounded edits are applied and checked on the server, and
// the new draft comes back. Logged as a child run of the build. Nothing is created in the workspace.
//   POST /api/ai-builder/edit  { requestKey, runId, proposal, instruction } → { editRunId, proposal }
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  return aiRoute(request, { maxBody: 200_000, label: "AI change" }, (ctx, body) =>
    editDraft(ctx, { requestKey: body.requestKey, runId: body.runId, proposal: body.proposal, instruction: body.instruction }, createAnthropicProvider()),
  );
}
