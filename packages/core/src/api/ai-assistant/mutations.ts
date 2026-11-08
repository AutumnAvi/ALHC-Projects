// AI builder round 3 (experimental, feat/ai-builder-p3), "AI everywhere" (note 171): the global
// assistant's writes. Every one runs as the signed-in person (their own client), re-checks the pilot
// access first, and logs to ai_assistant_runs.
//
//   proposeChanges  access → the page's context (loaded here from ids) → the run row (rate limits) → the
//                   routed model (Haiku for a small edit, Sonnet for automations or several steps; a small
//                   answer with automations or many changes is asked again of Sonnet) → resolved and
//                   checked operations stored as the proposal. Nothing is changed in the workspace.
//   applyAssistantRun  the person's Confirm with the changes they kept: one apply key (a repeat answers the
//                   first result), every operation checked again against the database (role, pilot,
//                   target, blocked tasks) and against the data the AI saw (anything changed → nothing is
//                   written), then written in order through the typed API; a refusal part way rolls back
//                   what was written. What changed is recorded (before / after) for Undo.
//   undoAssistantRun  refuses (and lists them) when anything it changed has changed since; else puts every
//                   change back in reverse order, removing only what it made. Repeating it is safe.
import {
  ASSISTANT_ERROR_MESSAGES,
  ASSISTANT_JSON_SCHEMA,
  ASSISTANT_LIMITS,
  ASSISTANT_LIMIT_REACHED,
  ASSISTANT_SYSTEM_PROMPT,
  assistantPrompt,
  escalationReason,
  matchesExpect,
  opsSummary,
  parseAssistantPage,
  parseStoredPlan,
  resolveAssistantPlan,
  routeAssistant,
  sameState,
  selectionProblem,
  type AssistantOp,
} from "../../ai-assistant";
import { AI_ERROR_MESSAGES, isRequestKey, scrubProviderDetail } from "../../ai-builder";
import type { Json } from "../../supabase/database.types";
import { isIsoDate } from "../../views";
import type { ApiContext } from "../core/context";
import { check } from "../core/db";
import { ApiError, isApiError, writeError } from "../core/errors";
import { id, text } from "../core/validate";
import type { AiProposalProvider, AiProviderResult } from "../ai-builder/model";
import { requirePilot } from "../ai-builder/mutations";
import { listPilotMembers } from "../ai-builder/queries";
import type { AppliedRecord, AssistantApplyInput, AssistantApplyResult, AssistantProposal, AssistantUndoResult, ProposeInput } from "./model";
import { checkOpAccess, readOpState, undoOp, writeOp } from "./ops";
import { getAssistantRunRow, loadAssistantContext } from "./queries";

export { ASSISTANT_LIMIT_REACHED };

async function callProvider(provider: AiProposalProvider, request: Parameters<AiProposalProvider["generate"]>[0]): Promise<AiProviderResult> {
  try {
    return await provider.generate(request);
  } catch {
    // Never the thrown message (it could carry a header or a key).
    return { ok: false, code: "provider_error", model: "", inputTokens: null, outputTokens: null };
  }
}

const sum = (a: number | null, b: number | null) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));

async function failRun(ctx: ApiContext, runId: string, code: string, extra: { detail?: string | null; result?: AiProviderResult; reason?: string; escalated?: boolean } = {}) {
  const r = extra.result;
  await ctx.db
    .from("ai_assistant_runs")
    .update({
      status: "failed",
      error_code: code,
      error_detail: extra.detail ? scrubProviderDetail(extra.detail) : null,
      ...(r ? { model: r.model || null, effort: r.effort ?? null, input_tokens: r.inputTokens, output_tokens: r.outputTokens, generated_at: new Date().toISOString() } : {}),
      ...(extra.reason ? { route_reason: extra.reason } : {}),
      ...(extra.escalated ? { escalated: true } : {}),
    })
    .eq("id", runId)
    .in("status", ["generating", "proposed", "applying"]);
}

async function viewerId(ctx: ApiContext, workspaceId: string): Promise<string> {
  const me = (await listPilotMembers(ctx, workspaceId)).find((m) => m.me)?.id;
  if (!me) throw new ApiError("forbidden", "The AI assistant is only for workspace admins of the Testing data pilot");
  return me.toLowerCase();
}

export async function proposeChanges(ctx: ApiContext, input: ProposeInput, provider: AiProposalProvider): Promise<AssistantProposal> {
  const access = await requirePilot(ctx);
  if (!provider.configured) throw new ApiError("unavailable", AI_ERROR_MESSAGES.not_configured);
  if (!isRequestKey(input.requestKey)) throw new ApiError("invalid", "Invalid request");
  const instruction = text(input.instruction, "Request", { max: ASSISTANT_LIMITS.instructionMaxChars });
  const page = parseAssistantPage(input.page);
  if (!page) throw new ApiError("invalid", "Invalid page");
  if (!isIsoDate(input.localToday)) throw new ApiError("invalid", "Invalid date");
  const { context, fieldDefs, label } = await loadAssistantContext(ctx, access.workspaceId, page, input.localToday);

  const inserted = await ctx.db
    .from("ai_assistant_runs")
    .insert({
      workspace_id: access.workspaceId,
      request_key: input.requestKey,
      page_kind: page.kind,
      page_project_id: context.currentProjectId,
      page_task_id: context.openTaskId,
      page_rule_id: page.ruleId,
      instruction_chars: instruction.length,
    })
    .select("id")
    .single();
  if (inserted.error) {
    if (inserted.error.code === "54000") throw new ApiError("unavailable", ASSISTANT_LIMIT_REACHED, inserted.error);
    if (inserted.error.code === "23505") throw new ApiError("conflict", "That request is already running", inserted.error);
    if (inserted.error.code === "42501") throw new ApiError("forbidden", "The AI assistant is only for workspace admins of the Testing data pilot", inserted.error);
    throw writeError(inserted.error);
  }
  const runId = inserted.data.id;

  const request = { system: ASSISTANT_SYSTEM_PROMPT, prompt: assistantPrompt(instruction, context), schema: ASSISTANT_JSON_SCHEMA as Record<string, unknown> };
  const route = routeAssistant(instruction, page.kind);
  let reason = route.reason;
  let escalated = false;
  let result = await callProvider(provider, { kind: route.call, ...request });
  if (route.call === "assistant_small") {
    const why = result.ok ? escalationReason(result.output) : result.code === "invalid_output" || result.code === "truncated" ? "escalated_invalid" : null;
    if (why) {
      const first = result;
      result = await callProvider(provider, { kind: "assistant_large", ...request });
      reason = why;
      escalated = true;
      result = { ...result, inputTokens: sum(first.inputTokens, result.inputTokens), outputTokens: sum(first.outputTokens, result.outputTokens) };
    }
  }
  if (!result.ok) {
    await failRun(ctx, runId, result.code, { detail: result.detail ?? null, result, reason, escalated });
    throw new ApiError("unavailable", AI_ERROR_MESSAGES[result.code] ?? AI_ERROR_MESSAGES.provider_error);
  }
  const resolved = resolveAssistantPlan(result.output, context);
  if (!resolved.ok) {
    await failRun(ctx, runId, "unsupported", { detail: resolved.error, result, reason, escalated });
    throw new ApiError("invalid", resolved.error);
  }
  const plan = resolved.plan;
  const saved = await ctx.db
    .from("ai_assistant_runs")
    .update({
      status: "proposed",
      proposal: plan as unknown as Json,
      model: result.model,
      effort: result.effort ?? null,
      route_reason: reason,
      escalated,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      op_count: plan.ops.length,
      ops_summary: opsSummary(plan.ops) as unknown as Json,
      generated_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .eq("status", "generating")
    .select("id");
  check(saved);
  if (!saved.data?.length) throw new ApiError("conflict", "This request was cancelled");

  const focus = context.projects.find((p) => p.id === context.currentProjectId);
  return {
    runId,
    summary: plan.summary,
    unsupported: plan.unsupported,
    ops: plan.ops,
    rejected: plan.rejected,
    model: result.model,
    routeReason: reason,
    escalated,
    pageKind: page.kind,
    contextLabel: label,
    ruleContext: {
      sections: focus?.sections.map((s) => ({ id: s.id, name: s.name })) ?? [],
      fields: fieldDefs.filter((f) => f.projectId === context.currentProjectId),
      people: context.people.map((p) => ({ id: p.id, name: p.name })),
    },
  };
}

type StoredApplied = { selected: number[]; records: AppliedRecord[]; rollbackFailed?: number[] };

function parseApplied(raw: unknown): StoredApplied | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as { selected?: unknown; records?: unknown };
  if (!Array.isArray(v.records) || !Array.isArray(v.selected)) return null;
  return raw as StoredApplied;
}

const idsOf = (records: AppliedRecord[]) => [
  ...new Set(
    records.flatMap((r) => [
      r.created,
      "taskId" in r.op ? r.op.taskId : null,
      "sectionId" in r.op ? r.op.sectionId : null,
      "ruleId" in r.op ? r.op.ruleId : null,
    ]).filter((x): x is string => Boolean(x)),
  ),
];

const refusal = (error: unknown) => (isApiError(error) ? error.message : "it was refused");

export async function applyAssistantRun(ctx: ApiContext, input: AssistantApplyInput): Promise<AssistantApplyResult> {
  const access = await requirePilot(ctx);
  const runId = id(input.runId, "run");
  if (!isRequestKey(input.applyKey)) throw new ApiError("invalid", "Invalid request");
  const applyKey = input.applyKey;
  const selected = Array.isArray(input.selected) ? input.selected : null;
  if (!selected || !selected.every((i) => typeof i === "number")) throw new ApiError("invalid", "Invalid selection");
  const timeZone = typeof input.timeZone === "string" && input.timeZone.length <= 64 && /^[A-Za-z0-9_+\-/]+$/.test(input.timeZone) ? input.timeZone : undefined;
  const me = await viewerId(ctx, access.workspaceId);

  const run = await getAssistantRunRow(ctx, runId);
  if (!run || run.workspace_id !== access.workspaceId || run.actor_id.toLowerCase() !== me) throw new ApiError("not_found", "Run not found");
  // Idempotent: the same Confirm again answers what it did the first time.
  if (run.apply_key === applyKey && (run.status === "applied" || run.status === "undone")) {
    return { runId, applied: parseApplied(run.applied)?.records.length ?? 0, repeated: true };
  }
  if (run.status === "applying") throw new ApiError("conflict", "These changes are being applied already");
  if (run.status !== "proposed") throw new ApiError("conflict", "These changes can’t be applied any more");
  const plan = parseStoredPlan(run.proposal);
  if (!plan) throw new ApiError("failed", "The stored change set isn’t valid");
  const order = [...(selected as number[])].sort((a, b) => a - b);
  const problem = selectionProblem(plan.ops, order);
  if (problem) throw new ApiError("invalid", problem);

  const claimed = await ctx.db.from("ai_assistant_runs").update({ status: "applying", apply_key: applyKey }).eq("id", runId).eq("status", "proposed").select("id");
  check(claimed);
  if (!claimed.data?.length) {
    const now = await getAssistantRunRow(ctx, runId);
    if (now?.apply_key === applyKey && now.status === "applied") return { runId, applied: parseApplied(now.applied)?.records.length ?? 0, repeated: true };
    throw new ApiError("conflict", "These changes are being applied already");
  }

  // Check everything before writing anything: the person's access now, and that the data is still what
  // the AI saw (a stale change set is refused, never written over newer data).
  const stale: string[] = [];
  for (const index of order) {
    const op = plan.ops[index];
    try {
      await checkOpAccess(ctx, access.workspaceId, op);
    } catch (error) {
      await failRun(ctx, runId, isApiError(error) && error.code === "forbidden" ? "forbidden" : "refused", { detail: `Change ${index + 1}: ${refusal(error)}` });
      throw new ApiError(isApiError(error) ? error.code : "failed", `Change ${index + 1} (${op.label}): ${refusal(error)}. Nothing was changed.`);
    }
    const current = await readOpState(ctx, op, null);
    if (!matchesExpect(op.expect, current) || current.missing === true) stale.push(op.label);
  }
  if (stale.length) {
    await failRun(ctx, runId, "stale", { detail: `Changed since the AI looked: ${stale.join("; ")}`.slice(0, 400) });
    throw new ApiError("conflict", `${ASSISTANT_ERROR_MESSAGES.stale} Changed: ${stale.slice(0, 3).join("; ")}.`);
  }

  const records: AppliedRecord[] = [];
  const createdBy = new Map<number, string>();
  for (const index of order) {
    const op = plan.ops[index];
    try {
      // Read again right before the write: an earlier change in this set may have moved things.
      const before = await readOpState(ctx, op, null);
      const created = await writeOp(ctx, op, createdBy, timeZone);
      if (created) createdBy.set(index, created);
      records.push({ index, op, before, after: null, created, undone: false });
    } catch (error) {
      const message = `Change ${index + 1} (${op.label}) was refused: ${refusal(error)}.`;
      const failed = await rollBack(ctx, records);
      if (failed.length === 0) {
        await ctx.db
          .from("ai_assistant_runs")
          .update({ status: "rolled_back", error_code: "apply_failed", error_detail: scrubProviderDetail(message), applied: { selected: order, records } as unknown as Json, touched_ids: idsOf(records) })
          .eq("id", runId);
        throw new ApiError(isApiError(error) ? error.code : "failed", `${message} Nothing was kept.`);
      }
      // Something couldn't be put back: keep the run applied with what's left, so Undo can finish it.
      for (const r of records) r.after = await readOpState(ctx, r.op, r.created);
      await ctx.db
        .from("ai_assistant_runs")
        .update({ status: "applied", error_code: "apply_failed", error_detail: scrubProviderDetail(message), applied: { selected: order, records, rollbackFailed: failed } as unknown as Json, touched_ids: idsOf(records) })
        .eq("id", runId);
      throw new ApiError(isApiError(error) ? error.code : "failed", `${message} Some changes couldn’t be put back; use Undo to finish.`);
    }
  }
  // The state once everything is applied: Undo compares with it.
  for (const r of records) r.after = await readOpState(ctx, r.op, r.created);
  const done = await ctx.db
    .from("ai_assistant_runs")
    .update({ status: "applied", applied: { selected: order, records } as unknown as Json, touched_ids: idsOf(records) })
    .eq("id", runId)
    .eq("status", "applying")
    .select("id");
  check(done);
  return { runId, applied: records.length, repeated: false };
}

// Undoes `records` in reverse (marking each), answering the indexes that couldn't be put back.
async function rollBack(ctx: ApiContext, records: AppliedRecord[]): Promise<number[]> {
  const failed: number[] = [];
  for (const r of [...records].reverse()) {
    try {
      await undoOp(ctx, r.op, r.before, r.created);
      r.undone = true;
    } catch {
      failed.push(r.index);
    }
  }
  return failed;
}

export async function undoAssistantRun(ctx: ApiContext, runIdInput: unknown): Promise<AssistantUndoResult> {
  const access = await requirePilot(ctx);
  const runId = id(runIdInput, "run");
  const me = await viewerId(ctx, access.workspaceId);
  const run = await getAssistantRunRow(ctx, runId);
  if (!run || run.workspace_id !== access.workspaceId || run.actor_id.toLowerCase() !== me) throw new ApiError("not_found", "Run not found");
  if (run.status === "undone") return { status: "already_undone", undone: 0 };
  if (run.status !== "applied") throw new ApiError("conflict", "Only applied changes can be undone");
  const applied = parseApplied(run.applied);
  if (!applied) throw new ApiError("failed", "The run’s record of its changes isn’t valid");
  const pending = applied.records.filter((r) => !r.undone);

  // Refuse — and say what — when anything it changed has changed since (or the person can't change it).
  const conflicts: string[] = [];
  for (const r of pending) {
    try {
      // Undoing a reopen completes the task again: the blocked check applies.
      await checkOpAccess(ctx, access.workspaceId, r.op, { completing: r.op.op === "reopen_task", undoing: true });
    } catch (error) {
      conflicts.push(`${r.op.label}: ${refusal(error)}`);
      continue;
    }
    const current = await readOpState(ctx, r.op, r.created);
    if (!r.after || !sameState(current, r.after)) conflicts.push(`${r.op.label}: changed since`);
  }
  if (conflicts.length) {
    await ctx.db.from("ai_assistant_runs").update({ undo_conflicts: { changed: conflicts } as unknown as Json }).eq("id", runId).eq("status", "applied");
    return { status: "conflict", conflicts };
  }

  let undone = 0;
  for (const r of [...applied.records].reverse()) {
    if (r.undone) continue;
    try {
      await undoOp(ctx, r.op, r.before, r.created);
      r.undone = true;
      undone += 1;
    } catch (error) {
      // Keep the progress: Undo again picks up where this stopped.
      await ctx.db.from("ai_assistant_runs").update({ applied: applied as unknown as Json }).eq("id", runId).eq("status", "applied");
      throw new ApiError(isApiError(error) ? error.code : "failed", `Undo stopped at “${r.op.label}”: ${refusal(error)}. Try Undo again.`);
    }
  }
  const saved = await ctx.db
    .from("ai_assistant_runs")
    .update({ status: "undone", applied: applied as unknown as Json, undo_conflicts: null })
    .eq("id", runId)
    .eq("status", "applied")
    .select("id");
  check(saved);
  return { status: "undone", undone };
}

export async function cancelAssistantRun(ctx: ApiContext, runIdInput: unknown): Promise<void> {
  await requirePilot(ctx);
  const runId = id(runIdInput, "run");
  check(await ctx.db.from("ai_assistant_runs").update({ status: "cancelled" }).eq("id", runId).in("status", ["generating", "proposed"]));
}

export type { AssistantOp };
