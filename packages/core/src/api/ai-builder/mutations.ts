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
  scrubProviderDetail,
  PROPOSAL_JSON_SCHEMA,
  aiPeople,
  buildProposalPrompt,
  isRequestKey,
  parseProposal,
  proposalFromModel,
  sameProposal,
  type AiPerson,
  type AiProposal,
  type AiRunKind,
} from "../../ai-builder";
import { AI_RULE_SYSTEM_PROMPT, RULE_DRAFT_JSON_SCHEMA, automationPrompt, ruleFromModel } from "../../ai-automation";
import { counterIds, draftToProposal } from "../../ai-builder-draft";
import { AI_EDIT_SYSTEM_PROMPT, EDIT_OPS_JSON_SCHEMA, applyDraftOps, editPrompt } from "../../ai-builder-ops";
import { hasRole, type ProjectRole } from "../../roles";
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
  AutomationInput,
  AutomationResult,
  EditInput,
  EditResult,
  GenerateInput,
  GenerateResult,
  UndoResult,
} from "./model";
import { getAiBuilderAccess, getAiRunRow, getPilotProject, getPilotTemplateOutline, listPilotMembers } from "./queries";

export const NOT_PILOT_ADMIN = "The AI builder is only for workspace admins of the Testing data pilot";
export const LIMIT_REACHED = `AI builder limit reached (${AI_BUILDER_LIMITS.runsPerHour} an hour, ${AI_BUILDER_LIMITS.runsPerDay} a day per person). Try again later.`;
export const EDIT_LIMIT_REACHED = `AI change limit reached (${AI_BUILDER_LIMITS.editRunsPerHour} an hour, ${AI_BUILDER_LIMITS.editRunsPerDay} a day per person). Edit by hand, or try again later.`;
export const AUTOMATION_LIMIT_REACHED = `AI automation limit reached (${AI_BUILDER_LIMITS.automationRunsPerHour} an hour, ${AI_BUILDER_LIMITS.automationRunsPerDay} a day per person). Try again later.`;
const LIMIT_FOR: Record<AiRunKind, string> = { build: LIMIT_REACHED, edit: EDIT_LIMIT_REACHED, automation: AUTOMATION_LIMIT_REACHED };

export async function requirePilot(ctx: ApiContext): Promise<Extract<AiBuilderAccess, { status: "ready" }>> {
  const access = await getAiBuilderAccess(ctx);
  if (access.status === "ready") return access;
  if (access.status === "not_deployed") throw new ApiError("not_deployed", "The AI builder needs its database update, which isn’t applied yet");
  throw new ApiError("forbidden", NOT_PILOT_ADMIN);
}

async function startRun(
  ctx: ApiContext,
  input: {
    workspaceId: string;
    requestKey: string;
    briefChars: number;
    templateId: string | null;
    kind?: AiRunKind;
    parentRunId?: string | null;
    targetProjectId?: string | null;
  },
) {
  const kind = input.kind ?? "build";
  const row = {
    workspace_id: input.workspaceId,
    request_key: input.requestKey,
    brief_chars: input.briefChars,
    template_id: input.templateId,
    kind,
    ...(input.parentRunId ? { parent_run_id: input.parentRunId } : {}),
    ...(input.targetProjectId ? { target_project_id: input.targetProjectId } : {}),
  };
  const inserted = await ctx.db.from("ai_builder_runs").insert(row).select("id").single();
  if (inserted.error) {
    if (inserted.error.code === "54000") throw new ApiError("unavailable", LIMIT_FOR[kind], inserted.error);
    if (inserted.error.code === "23505") throw new ApiError("conflict", "That request is already running", inserted.error);
    if (inserted.error.code === "42501") throw new ApiError("forbidden", NOT_PILOT_ADMIN, inserted.error);
    throw writeError(inserted.error);
  }
  return inserted.data.id;
}

async function failRun(ctx: ApiContext, runId: string, code: AiProviderErrorCode | "unsupported", result?: AiProviderResult) {
  // The code is the closed error_code. A provider failure also keeps its HTTP status, error type, and
  // message (scrubbed: no key, no prompt) on the run, so the log says why it failed before any tokens.
  const detail = result && !result.ok && result.detail ? scrubProviderDetail(result.detail) : "";
  await ctx.db
    .from("ai_builder_runs")
    .update({
      status: "failed",
      error_code: code,
      ...(detail ? { proposal: { error: detail } } : {}),
      model: result?.model || null,
      effort: result?.effort ?? null,
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

  const { people, memberIds } = await pilotPeople(ctx, access.workspaceId);

  const runId = await startRun(ctx, { workspaceId: access.workspaceId, requestKey: input.requestKey, briefChars: brief.length, templateId });

  const result = await callProvider(provider, {
    kind: "build",
    system: AI_BUILDER_SYSTEM_PROMPT,
    prompt: buildProposalPrompt(brief, template, people),
    schema: PROPOSAL_JSON_SCHEMA,
  });
  if (!result.ok) {
    await failRun(ctx, runId, result.code, result);
    throw new ApiError("unavailable", AI_ERROR_MESSAGES[result.code] ?? AI_ERROR_MESSAGES.provider_error);
  }
  const parsed = parseProposal(proposalFromModel(result.output, people), { members: memberIds });
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
      effort: result.effort ?? null,
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
  const { memberIds } = await pilotPeople(ctx, access.workspaceId);
  const parsed = parseProposal(input.proposal, { members: memberIds });
  if (!parsed.ok) throw new ApiError("invalid", parsed.problems.slice(0, 3).join(". "));

  const run = await getAiRunRow(ctx, runId);
  if (!run) throw new ApiError("not_found", "Run not found");
  if (run.workspace_id !== access.workspaceId) throw new ApiError("forbidden", NOT_PILOT_ADMIN);
  if ((run.kind ?? "build") !== "build") throw new ApiError("invalid", "Only a project proposal can be created");

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

// ---- Round 2 ------------------------------------------------------------------------------------------

async function callProvider(provider: AiProposalProvider, request: Parameters<AiProposalProvider["generate"]>[0]): Promise<AiProviderResult> {
  try {
    return await provider.generate(request);
  } catch {
    // Never the thrown message (it could carry a header or a key).
    return { ok: false, code: "provider_error", model: "", inputTokens: null, outputTokens: null };
  }
}

// The pilot workspace's people as the model sees them (aliases; the caller is member:1) and their ids.
async function pilotPeople(ctx: ApiContext, workspaceId: string): Promise<{ people: AiPerson[]; memberIds: Set<string> }> {
  const members = await listPilotMembers(ctx, workspaceId);
  const me = members.find((m) => m.me)?.id ?? null;
  return { people: aiPeople(members.map((m) => m.id), me), memberIds: new Set(members.map((m) => m.id.toLowerCase())) };
}

async function finishRun(ctx: ApiContext, runId: string, result: Extract<AiProviderResult, { ok: true }>, proposal: unknown) {
  const saved = await ctx.db
    .from("ai_builder_runs")
    .update({
      status: "proposed",
      proposal: proposal as Json,
      proposal_version: 1,
      model: result.model,
      effort: result.effort ?? null,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      generated_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .eq("status", "generating")
    .select("id");
  check(saved);
  if (!saved.data?.length) throw new ApiError("conflict", "This request was cancelled");
}

// Checks a draft the way Create will (the preview asks after edits): problems, or none. Nothing is stored.
export async function checkProposal(ctx: ApiContext, proposal: unknown): Promise<{ problems: string[] }> {
  const access = await requirePilot(ctx);
  const { memberIds } = await pilotPeople(ctx, access.workspaceId);
  const parsed = parseProposal(proposal, { members: memberIds });
  return { problems: parsed.ok ? [] : parsed.problems.slice(0, 5) };
}

// An AI change to the draft (note 168): the latest draft (validated first) plus the instruction go to the
// edit model (AI_BUILDER_CALLS.edit); its bounded edits are applied here and the result validated again.
// Logged as a child run of the build (kind edit). Nothing is created in the workspace.
export async function editDraft(ctx: ApiContext, input: EditInput, provider: AiProposalProvider): Promise<EditResult> {
  const access = await requirePilot(ctx);
  if (!provider.configured) throw new ApiError("unavailable", AI_ERROR_MESSAGES.not_configured);
  if (!isRequestKey(input.requestKey)) throw new ApiError("invalid", "Invalid request");
  const parentId = id(input.runId, "run");
  const instruction = text(input.instruction, "Instruction", { max: AI_BUILDER_LIMITS.instructionMaxChars });
  const { people, memberIds } = await pilotPeople(ctx, access.workspaceId);
  const current = parseProposal(input.proposal, { members: memberIds });
  if (!current.ok) throw new ApiError("invalid", `Fix the draft first: ${current.problems.slice(0, 2).join(". ")}`);
  const parent = await getAiRunRow(ctx, parentId);
  if (!parent || parent.workspace_id !== access.workspaceId) throw new ApiError("not_found", "Run not found");
  if ((parent.kind ?? "build") !== "build" || parent.status !== "proposed") throw new ApiError("conflict", "This draft can’t be changed any more");

  const runId = await startRun(ctx, {
    workspaceId: access.workspaceId,
    requestKey: input.requestKey,
    briefChars: instruction.length,
    templateId: null,
    kind: "edit",
    parentRunId: parentId,
  });
  const result = await callProvider(provider, {
    kind: "edit",
    system: AI_EDIT_SYSTEM_PROMPT,
    prompt: editPrompt(current.proposal, instruction, people),
    schema: EDIT_OPS_JSON_SCHEMA,
  });
  if (!result.ok) {
    await failRun(ctx, runId, result.code, result);
    throw new ApiError("unavailable", AI_ERROR_MESSAGES[result.code] ?? AI_ERROR_MESSAGES.provider_error);
  }
  const applied = applyDraftOps(current.proposal, result.output, people, counterIds());
  if (!applied.ok) {
    await failRun(ctx, runId, applied.unsupported ? "unsupported" : "invalid_output", result);
    throw new ApiError("failed", applied.error);
  }
  const next = parseProposal(draftToProposal(applied.draft), { members: memberIds });
  if (!next.ok) {
    await failRun(ctx, runId, "invalid_output", result);
    throw new ApiError("failed", `The AI’s change didn’t pass the checks: ${next.problems[0]}`);
  }
  await finishRun(ctx, runId, result, next.proposal);
  return { editRunId: runId, proposal: next.proposal as AiProposal };
}

// "Ask AI for an automation" (note 170): a project of the pilot workspace where the caller may add
// automations (Editor+, like the rule canvas); the model's draft is translated to the project's own ids
// and checked by the rules engine's own checks, then stored for the normal rule canvas to open. Nothing is
// saved, run, or sent here.
export async function draftAutomation(ctx: ApiContext, input: AutomationInput, provider: AiProposalProvider): Promise<AutomationResult> {
  const access = await requirePilot(ctx);
  if (!provider.configured) throw new ApiError("unavailable", AI_ERROR_MESSAGES.not_configured);
  if (!isRequestKey(input.requestKey)) throw new ApiError("invalid", "Invalid request");
  const projectId = id(input.projectId, "project");
  const description = text(input.description, "Description", { max: AI_BUILDER_LIMITS.instructionMaxChars });
  const project = await getPilotProject(ctx, access.workspaceId, projectId);
  if (!project) throw new ApiError("forbidden", "AI automations are only for projects of the Testing data workspace");
  if (project.archived || !hasRole(project.role as ProjectRole | null, "editor")) {
    throw new ApiError("forbidden", "Only the project’s Owners and Editors can add automations");
  }
  const [sections, fields, members] = await Promise.all([
    ctx.db.from("sections").select("id, name").eq("project_id", projectId).is("deleted_at", null).order("sort_order"),
    ctx.db.from("custom_fields").select("id, name, field_type, bound_to_sections, options").eq("project_id", projectId).is("deleted_at", null).order("sort_order"),
    ctx.db.from("project_members").select("profile_id").eq("project_id", projectId).is("deleted_at", null),
  ]);
  check(sections);
  check(fields);
  check(members);
  const pilotMembers = await listPilotMembers(ctx, access.workspaceId);
  const me = pilotMembers.find((m) => m.me)?.id ?? null;
  const ruleCtx = {
    sections: (sections.data ?? []).map((s) => ({ id: s.id, name: s.name })),
    fields: (fields.data ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      fieldType: f.field_type,
      boundToSections: f.bound_to_sections,
      options: (Array.isArray(f.options) ? f.options : []).flatMap((o) =>
        o && typeof o === "object" && !Array.isArray(o) && typeof o.id === "string" && typeof o.name === "string" ? [{ id: o.id, name: o.name }] : [],
      ),
    })),
    people: aiPeople((members.data ?? []).map((m) => m.profile_id), me),
  };

  const runId = await startRun(ctx, {
    workspaceId: access.workspaceId,
    requestKey: input.requestKey,
    briefChars: description.length,
    templateId: null,
    kind: "automation",
    targetProjectId: projectId,
  });
  const result = await callProvider(provider, {
    kind: "automation",
    system: AI_RULE_SYSTEM_PROMPT,
    prompt: automationPrompt(description, ruleCtx),
    schema: RULE_DRAFT_JSON_SCHEMA,
  });
  if (!result.ok) {
    await failRun(ctx, runId, result.code, result);
    throw new ApiError("unavailable", AI_ERROR_MESSAGES[result.code] ?? AI_ERROR_MESSAGES.provider_error);
  }
  const rule = ruleFromModel(result.output, ruleCtx);
  if (!rule.ok) {
    await failRun(ctx, runId, "unsupported", result);
    throw new ApiError("failed", rule.error);
  }
  await finishRun(ctx, runId, result, rule.rule);
  return { runId, projectId };
}

// The rule canvas saved the AI draft through the normal rule-save path: record which rule it became.
// The database checks it's a live rule of the run's project that this person created.
export async function recordAutomationSaved(ctx: ApiContext, runId: unknown, ruleId: unknown): Promise<void> {
  await requirePilot(ctx);
  const runIdValue = id(runId, "run");
  const res = await ctx.db
    .from("ai_builder_runs")
    .update({ status: "applied", rule_id: id(ruleId, "rule") })
    .eq("id", runIdValue)
    .eq("kind", "automation")
    .eq("status", "proposed")
    .select("id");
  if (res.error) throw writeError(res.error);
}
