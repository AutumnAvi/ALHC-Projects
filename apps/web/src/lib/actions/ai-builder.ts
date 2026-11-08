"use server";
// AI builder pilot (experimental, feat/ai-builder): thin wrappers around
// packages/core/src/api/ai-builder/{queries,mutations}.ts. Generation is a route
// (src/app/api/ai-builder/generate/route.ts: its own time limit). AI builder writes queue no email,
// Slack, or webhook (deliver: false); the database refuses anything outside the Testing data pilot.
import type { AiBuilderAccess, AiPilotTemplate, ApplyResult, UndoResult } from "@alhc/core/api/ai-builder/model";
import * as aiApi from "@alhc/core/api/ai-builder/mutations";
import { getAiBuilderAccess, listPilotTemplates } from "@alhc/core/api/ai-builder/queries";
import type { ActionResult } from "@alhc/core/api/core/result";
import { aiBuilderConfigured } from "@/lib/ai-builder/anthropic";
import { readAction, run, runWith } from "@/lib/server/action";

export type AiBuilderSetup = { access: AiBuilderAccess["status"]; workspaceName: string | null; configured: boolean; templates: AiPilotTemplate[] };

export async function loadAiBuilder(): Promise<ActionResult & { data?: AiBuilderSetup }> {
  return readAction(async (ctx) => {
    const access = await getAiBuilderAccess(ctx);
    if (access.status !== "ready") return { access: access.status, workspaceName: null, configured: false, templates: [] };
    return {
      access: "ready",
      workspaceName: access.workspaceName,
      configured: aiBuilderConfigured(),
      templates: await listPilotTemplates(ctx, access.workspaceId),
    };
  });
}

export async function applyAiProposal(input: { runId: string; proposal: unknown; version: number; localToday: string }) {
  return runWith<ApplyResult>((ctx) => aiApi.applyProposal(ctx, input), { deliver: false, revalidate: [["/", "layout"]] });
}

export async function undoAiRun(runId: string) {
  return runWith<{ undo: UndoResult }>(async (ctx) => ({ undo: await aiApi.undoRun(ctx, runId) }), {
    deliver: false,
    revalidate: [["/", "layout"]],
  });
}

export async function cancelAiRun(runId: string): Promise<ActionResult> {
  return run((ctx) => aiApi.cancelRun(ctx, runId), { deliver: false, refresh: false });
}
