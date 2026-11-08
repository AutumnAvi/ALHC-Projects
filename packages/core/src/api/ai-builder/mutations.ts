// AI builder phase 1 (experimental pilot): writes. Every one runs as the signed-in person (their own
// client: RLS and the guards decide), re-checks the pilot access first, and touches only the pilot
// workspace the database says the caller administers.
//
//   generateProposal: access → limits (ai_builder_runs insert guard) → the injected provider → the
//     proposal validated here → stored as version 1. Nothing is created in the workspace.
//   applyProposal: access → validate the latest (possibly edited) proposal → store it as a new version
//     when it changed → ai_builder_apply (one transaction, idempotent, re-validated in SQL).
//   cancelRun / undoRun: the run's own transitions; undo refuses on any change (ai_builder_undo).
import {
  AI_BUILDER_LIMITS,
  AI_BUILDER_SYSTEM_PROMPT,
  AI_ERROR_MESSAGES,
  PROPOSAL_JSON_SCHEMA,
  buildProposalPrompt,
  isRequestKey,
  parseProposal,
  sameProposal,
} from "../../ai-builder";
import type { Json } from "../../supabase/database.types";
import { isIsoDate } from "../../views";
import type { ApiContext } from "../core/context";
import { check, maybe } from "../core/db";
import { ApiError, writeError } from "../core/errors";
import { id, optionalId, text } from "../core/validate";
import type {
  AiBuilderAccess,
  AiProposalProvider,
  AiProviderErrorCode,
  AiProviderResult,
  ApplyInput,
  ApplyResult,
  GenerateInput,
  GenerateResult,
  UndoResult,
} from "./model";
import { getAiBuilderAccess, getAiRunRow, getPilotTemplateOutline } from "./queries";

export const NOT_PILOT_ADMIN = "The AI builder is only for workspace admins of the Testing data pilot";
export const LIMIT_REACHED = `AI builder limit reached (${AI_BUILDER_LIMITS.runsPerHour} an hour, ${AI_BUILDER_LIMITS.runsPerDay} a day per person). Try again later.`;

export async function requirePilot(ctx: ApiContext): Promise<Extract<AiBuilderAccess, { status: "ready" }>> {
  const access = await getAiBuilderAccess(ctx);
  if (access.status === "ready") return access;
  if (access.status === "not_deployed") throw new ApiError("not_deployed", "The AI builder needs its database update, which isn’t applied yet");
  throw new ApiError("forbidden", NOT_PILOT_ADMIN);
}

async function startRun(ctx: ApiContext, input: { workspaceId: string; requestKey: string; briefChars: number; templateId: string | null }) {
  const inserted = await ctx.db
    .from("ai_builder_runs")
    .insert({ workspace_id: input.workspaceId, request_key: input.requestKey, brief_chars: input.briefChars, template_id: input.templateId })
    .select("id")
    .single();
  if (inserted.error) {
    if (inserted.error.code === "54000") throw new ApiError("unavailable", LIMIT_REACHED, inserted.error);
    if (inserted.error.code === "23505") throw new ApiError("conflict", "That request is already running", inserted.error);
    if (inserted.error.code === "42501") throw new ApiError("forbidden", NOT_PILOT_ADMIN, inserted.error);
    throw writeError(inserted.error);
  }
  return inserted.data.id;
}

async function failRun(ctx: ApiContext, runId: string, code: AiProviderErrorCode, result?: AiProviderResult) {
  // Best effort: the run is logged as failed with a code, never the provider's message.
  await ctx.db
    .from("ai_builder_runs")
    .update({
      status: "failed",
      error_code: code,
      model: result?.model ?? null,
      input_tokens: result?.inputTokens ?? null,
      output_tokens: result?.outputTokens ?? null,
      generated_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .eq("status", "generating");
}

export async function generateProposal(ctx: ApiContext, input: GenerateInput, provider: AiProposalProvider): Promise<GenerateResult> {
  const access = await requirePilot(ctx);
  if (!provider.configured) throw new ApiError("unavailable", AI_ERROR_MESSAGES.not_configured);
  if (!isRequestKey(input.requestKey)) throw new ApiError("invalid", "Invalid request");
  const brief = text(input.brief, "Brief", { max: AI_BUILDER_LIMITS.briefMaxChars });
  const templateId = optionalId(input.templateId, "template");
  const template = templateId ? await getPilotTemplateOutline(ctx, access.workspaceId, templateId) : null;
  if (templateId && !template) throw new ApiError("not_found", "Template not found in the Testing data workspace");

  const runId = await startRun(ctx, { workspaceId: access.workspaceId, requestKey: input.requestKey, briefChars: brief.length, templateId });

  let result: AiProviderResult;
  try {
    result = await provider.generate({ system: AI_BUILDER_SYSTEM_PROMPT, prompt: buildProposalPrompt(brief, template), schema: PROPOSAL_JSON_SCHEMA });
  } catch {
    result = { ok: false, code: "provider_error", model: "", inputTokens: null, outputTokens: null };
  }
  if (!result.ok) {
    await failRun(ctx, runId, result.code, result);
    throw new ApiError("unavailable", AI_ERROR_MESSAGES[result.code] ?? AI_ERROR_MESSAGES.provider_error);
  }
  const parsed = parseProposal(result.output);
  if (!parsed.ok) {
    await failRun(ctx, runId, "invalid_output", result);
    throw new ApiError("failed", AI_ERROR_MESSAGES.invalid_output);
  }
  const saved = await ctx.db
    .from("ai_builder_runs")
    .update({
      status: "proposed",
      proposal: parsed.proposal as unknown as Json,
      proposal_version: 1,
      model: result.model,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      generated_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .eq("status", "generating")
    .select("id");
  check(saved);
  if (!saved.data?.length) throw new ApiError("conflict", "This request was cancelled");
  return { runId, proposal: parsed.proposal, version: 1 };
}

export async function applyProposal(ctx: ApiContext, input: ApplyInput): Promise<ApplyResult> {
  const access = await requirePilot(ctx);
  const runId = id(input.runId, "run");
  if (typeof input.version !== "number" || !Number.isInteger(input.version) || input.version < 1) throw new ApiError("invalid", "Invalid version");
  if (!isIsoDate(input.localToday)) throw new ApiError("invalid", "Invalid date");
  const parsed = parseProposal(input.proposal);
  if (!parsed.ok) throw new ApiError("invalid", parsed.problems.slice(0, 3).join(". "));

  const run = await getAiRunRow(ctx, runId);
  if (!run) throw new ApiError("not_found", "Run not found");
  if (run.workspace_id !== access.workspaceId) throw new ApiError("forbidden", NOT_PILOT_ADMIN);

  let version = run.proposal_version;
  if (run.status === "proposed" && !sameProposal(run.proposal, parsed.proposal)) {
    if (input.version !== run.proposal_version) throw new ApiError("conflict", "The proposal changed in another window; review it again");
    const saved = await ctx.db
      .from("ai_builder_runs")
      .update({ proposal: parsed.proposal as unknown as Json, proposal_version: version + 1 })
      .eq("id", runId)
      .eq("status", "proposed")
      .eq("proposal_version", version)
      .select("proposal_version");
    check(saved);
    if (!saved.data?.length) {
      const now = await getAiRunRow(ctx, runId);
      if (now?.status !== "applied") throw new ApiError("conflict", "The proposal changed in another window; review it again");
    } else version = saved.data[0].proposal_version;
  }

  const applied = await ctx.db.rpc("ai_builder_apply", { target_run: runId, expected_version: version, local_today: input.localToday });
  if (applied.error) {
    if (applied.error.code === "40001") throw new ApiError("conflict", "The proposal changed; review it again before applying", applied.error);
    throw writeError(applied.error);
  }
  const res = (applied.data ?? {}) as { project_id?: string; repeated?: boolean; status?: string };
  if (!res.project_id) throw new ApiError("failed", "The project wasn’t created");
  return { runId, projectId: res.project_id, repeated: Boolean(res.repeated) };
}

export async function cancelRun(ctx: ApiContext, runId: unknown): Promise<void> {
  await requirePilot(ctx);
  const runIdValue = id(runId, "run");
  const run = await getAiRunRow(ctx, runIdValue);
  if (!run) throw new ApiError("not_found", "Run not found");
  if (run.status === "cancelled" || run.status === "failed") return;
  if (run.status !== "generating" && run.status !== "proposed") throw new ApiError("conflict", "This run can’t be cancelled any more");
  check(await ctx.db.from("ai_builder_runs").update({ status: "cancelled" }).eq("id", runIdValue).in("status", ["generating", "proposed"]));
}

export async function undoRun(ctx: ApiContext, runId: unknown): Promise<UndoResult> {
  await requirePilot(ctx);
  const result = await ctx.db.rpc("ai_builder_undo", { target_run: id(runId, "run") });
  if (result.error) throw writeError(result.error);
  const res = maybe(result, "undo") as { status?: string; project_id?: string | null; changed?: unknown } | null;
  const projectId = res?.project_id ?? null;
  if (res?.status === "conflict") {
    return { status: "conflict", projectId, changed: Array.isArray(res.changed) ? res.changed.filter((c): c is string => typeof c === "string") : [] };
  }
  if (res?.status === "undone" || res?.status === "already_undone" || res?.status === "already_removed") return { status: res.status, projectId };
  throw new ApiError("failed", "Undo didn’t answer as expected");
}
