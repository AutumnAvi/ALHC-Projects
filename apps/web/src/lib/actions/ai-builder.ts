"use server";
// AI builder pilot (experimental, feat/ai-builder): thin wrappers around
// packages/core/src/api/ai-builder/{queries,mutations}.ts. Model calls are routes
// (src/app/api/ai-builder/{generate,edit,automation}/route.ts: their own time limits). AI builder writes
// queue no email, Slack, or webhook (deliver: false); the database refuses anything outside the Testing
// data pilot.
import type { AiBuilderAccess, AiPilotMember, AiPilotTemplate, ApplyResult, UndoResult } from "@alhc/core/api/ai-builder/model";
import * as aiApi from "@alhc/core/api/ai-builder/mutations";
import { getAiBuilderAccess, getPilotProject, listPilotMembers, listPilotTemplates } from "@alhc/core/api/ai-builder/queries";
import type { ActionResult } from "@alhc/core/api/core/result";
import { hasRole, type ProjectRole } from "@alhc/core/roles";
import { aiBuilderConfigured } from "@/lib/ai-builder/anthropic";
import { readAction, run, runWith } from "@/lib/server/action";

export type AiBuilderSetup = {
  access: AiBuilderAccess["status"];
  workspaceName: string | null;
  configured: boolean;
  templates: AiPilotTemplate[];
  // Round 2: who a draft task may be assigned to (the Testing data workspace's people).
  members: AiPilotMember[];
};

export async function loadAiBuilder(): Promise<ActionResult & { data?: AiBuilderSetup }> {
  return readAction(async (ctx) => {
    const access = await getAiBuilderAccess(ctx);
    if (access.status !== "ready") return { access: access.status, workspaceName: null, configured: false, templates: [], members: [] };
    const [templates, members] = await Promise.all([listPilotTemplates(ctx, access.workspaceId), listPilotMembers(ctx, access.workspaceId)]);
    return { access: "ready", workspaceName: access.workspaceName, configured: aiBuilderConfigured(), templates, members };
  });
}

// Round 2: may "Ask AI for an automation" show on this project? Only for a pilot admin who is Admin+ of a
// live project of the Testing data workspace (the route and the database check again).
export async function loadAiAutomationAccess(projectId: string): Promise<ActionResult & { data?: { ready: boolean; configured: boolean } }> {
  return readAction(async (ctx) => {
    const access = await getAiBuilderAccess(ctx);
    if (access.status !== "ready") return { ready: false, configured: false };
    const project = await getPilotProject(ctx, access.workspaceId, projectId);
    const ready = Boolean(project && !project.archived && hasRole(project.role as ProjectRole | null, "admin"));
    return { ready, configured: ready && aiBuilderConfigured() };
  });
}

// Round 2: the server-side check of an edited draft (the same check Create runs). Nothing is stored.
export async function checkAiDraft(proposal: unknown): Promise<ActionResult & { data?: { problems: string[] } }> {
  return readAction((ctx) => aiApi.checkProposal(ctx, proposal));
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

// Round 2: the rule canvas saved an AI automation draft through the normal rule-save path.
export async function recordAiAutomationSaved(runId: string, ruleId: string): Promise<ActionResult> {
  return run((ctx) => aiApi.recordAutomationSaved(ctx, runId, ruleId), { deliver: false, refresh: false });
}
