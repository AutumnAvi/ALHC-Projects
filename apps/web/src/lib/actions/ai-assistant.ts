"use server";
// AI builder round 3 (experimental, feat/ai-builder-p3): thin wrappers around
// packages/core/src/api/ai-assistant/mutations.ts. The model call is a route (api/ai-assistant/propose:
// its own time limit). Applying and undoing run as the signed-in person through the typed API; they
// queue no email, Slack, or webhook delivery of their own (deliver: false).
import type { AssistantAccess, AssistantApplyResult, AssistantTurnOnResult, AssistantUndoResult } from "@alhc/core/api/ai-assistant/model";
import * as assistantApi from "@alhc/core/api/ai-assistant/mutations";
import { getAiBuilderAccess } from "@alhc/core/api/ai-builder/queries";
import type { ActionResult } from "@alhc/core/api/core/result";
import { aiBuilderConfigured } from "@/lib/ai-builder/anthropic";
import { readAction, run, runWith } from "@/lib/server/action";

// Whether the assistant shows here (the route and every write check again).
export async function loadAssistantAccess(): Promise<ActionResult & { data?: AssistantAccess }> {
  return readAction(async (ctx) => {
    const access = await getAiBuilderAccess(ctx);
    if (access.status !== "ready") return { ready: false, configured: false, workspaceName: null };
    return { ready: true, configured: aiBuilderConfigured(), workspaceName: access.workspaceName };
  });
}

// Round 5: `acknowledged` = the chosen changes that message people, each ticked by the person.
export async function applyAssistantChanges(input: { runId: string; applyKey: string; selected: number[]; acknowledged?: number[]; timeZone?: string }) {
  return runWith<AssistantApplyResult>((ctx) => assistantApi.applyAssistantRun(ctx, input), { deliver: false, revalidate: [["/", "layout"]] });
}

export async function undoAssistantChanges(runId: string) {
  return runWith<{ undo: AssistantUndoResult }>(async (ctx) => ({ undo: await assistantApi.undoAssistantRun(ctx, runId) }), {
    deliver: false,
    revalidate: [["/", "layout"]],
  });
}

// Round 4 (note 173): Turn on & Finish — turns on automations this run made (Owner / Admin, checked again).
// Round 5: an automation whose steps message people needs `acknowledge` (the person's tick naming who).
export async function turnOnAssistantRules(runId: string, ruleIds?: string[], acknowledge?: boolean) {
  return runWith<{ result: AssistantTurnOnResult }>(async (ctx) => ({ result: await assistantApi.turnOnAssistantRules(ctx, runId, ruleIds, acknowledge) }), {
    deliver: false,
    revalidate: [["/", "layout"]],
  });
}

export async function cancelAssistantRun(runId: string): Promise<ActionResult> {
  return run((ctx) => assistantApi.cancelAssistantRun(ctx, runId), { deliver: false, refresh: false });
}
