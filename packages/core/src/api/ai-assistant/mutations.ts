// AI builder rounds 3–5 (experimental, feat/ai-builder-p5): the global assistant's writes. Every one runs as
// the signed-in person (their own client), re-checks the pilot access first, and logs to ai_assistant_runs.
//
//   proposeChanges  access → the page's context (loaded here from ids) → the run row (rate limits) → a tool
//                   conversation (Anthropic tool use; Haiku 5.5 first, note 179): read tools run at once,
//                   write tools only STAGE changes through the capability registry (resolved, checked
//                   against the person's role as by hand, previewed). Nothing in the workspace changes.
//   applyAssistantRun  the person's Confirm with the changes they kept (and, for each change that messages
//                   people, their own tick naming who): one apply key, every change checked again against
//                   the database (role, pilot, target, blocked tasks) and against what was previewed
//                   (anything changed → nothing is written), then written in order through the typed API;
//                   a refusal part way rolls back what was written. Recorded (before / after) for Undo.
//   undoAssistantRun  refuses (and lists them) when anything it changed has changed since; else puts every
//                   change back in reverse order. Changes that can't be undone were said so before Confirm.
// MCP's write tools (api/mcp/) stage and apply through the same engine and log the same runs.
import {
  ASSISTANT_ANSWER_SCHEMA,
  ASSISTANT_ANSWER_SYSTEM_PROMPT,
  ASSISTANT_ERROR_MESSAGES,
  ASSISTANT_LIMITS,
  ASSISTANT_LIMIT_REACHED,
  FINISH_TOOL,
  assistantAnswerPrompt,
  assistantMode,
  assistantSystemPrompt,
  assistantUserPrompt,
  cleanAnswer,
  escalationReason,
  isHowToQuestion,
  matchesExpect,
  opsSummary,
  parseAssistantPage,
  parseStoredPlan,
  routeAssistant,
  sameState,
  type AssistantContext,
  type AssistantPlan,
  type Question,
  type StagedOp,
} from "../../ai-assistant";
import { rulesVocabularyText } from "../../ai-rule-steps";
import { ANSWER_ONLY_NOTE, canChangeIn, findTools, isToolName, startingGroups, toolInputSchema, toolMeta, toolsFor, type ToolName } from "../../ai-tools";
import { AI_ERROR_MESSAGES, isRequestKey, scrubProviderDetail } from "../../ai-builder";
import type { Json } from "../../supabase/database.types";
import { isIsoDate } from "../../views";
import type { ApiContext } from "../core/context";
import { check } from "../core/db";
import { ApiError, isApiError, writeError } from "../core/errors";
import { id, text } from "../core/validate";
import type { AiContentBlock, AiConverseResult, AiMessage, AiProposalProvider, AiProviderResult, AiToolSpec } from "../ai-builder/model";
import { requirePilot } from "../ai-builder/mutations";
import { listPilotMembers } from "../ai-builder/queries";
import { setRuleEnabled } from "../automations/mutations";
import { checkOp, InputError, readOp, runReadTool, selectionProblem, stageCall, undoOp, writeOp } from "../capabilities/engine";
import { ruleForModel } from "../capabilities/tools-rules";
import { ToolQuestion, ToolRefusal, type ToolEnv } from "../capabilities/types";
import type { AppliedRecord, AssistantApplyInput, AssistantApplyResult, AssistantProposal, AssistantTurnOnResult, AssistantUndoResult, ProposeInput } from "./model";
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

async function converse(provider: AiProposalProvider, request: Parameters<NonNullable<AiProposalProvider["converse"]>>[0]): Promise<AiConverseResult> {
  if (!provider.converse) return { ok: false, code: "not_configured", model: "", inputTokens: null, outputTokens: null };
  try {
    return await provider.converse(request);
  } catch {
    return { ok: false, code: "provider_error", model: "", inputTokens: null, outputTokens: null };
  }
}

const sum = (a: number | null, b: number | null) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));

export async function failRun(ctx: ApiContext, runId: string, code: string, extra: { detail?: string | null; result?: { model: string; effort?: string | null; inputTokens: number | null; outputTokens: number | null }; reason?: string; escalated?: boolean } = {}) {
  const r = extra.result;
  await ctx.db
    .from("ai_assistant_runs")
    .update({
      status: "failed",
      error_code: code,
      error_detail: extra.detail ? scrubProviderDetail(extra.detail) : null,
      ...(r ? { model: r.model || null, effort: (r.effort as "low" | null | undefined) ?? null, input_tokens: r.inputTokens, output_tokens: r.outputTokens, generated_at: new Date().toISOString() } : {}),
      ...(extra.reason ? { route_reason: extra.reason } : {}),
      ...(extra.escalated ? { escalated: true } : {}),
    })
    .eq("id", runId)
    .in("status", ["generating", "proposed", "applying"]);
}

export async function viewerId(ctx: ApiContext, workspaceId: string): Promise<string> {
  const me = (await listPilotMembers(ctx, workspaceId)).find((m) => m.me)?.id;
  if (!me) throw new ApiError("forbidden", "The AI assistant is only for workspace admins of the Testing data pilot");
  return me.toLowerCase();
}

// A tool environment over a context (the assistant's page, or an empty one for MCP).
export function toolEnv(ctx: ApiContext, workspaceId: string, me: string, audience: "assistant" | "mcp", context: AssistantContext, today: string): ToolEnv {
  return { ctx, workspaceId, me, audience, today, context, refs: new Map(), provisional: new Map(), staged: [], people: context.people };
}

// The model's tools: the registry's tools in the given groups (assistant audience), and finish.
function toolSpecs(names: Iterable<ToolName>): AiToolSpec[] {
  const out: AiToolSpec[] = [];
  for (const n of names) {
    const m = toolMeta(n);
    out.push({ name: n, description: `${m.description} (${m.label}; where by hand: ${m.where})`, input_schema: toolInputSchema(n, "assistant") });
  }
  out.push({ ...FINISH_TOOL, input_schema: FINISH_TOOL.input_schema as unknown as Record<string, unknown> });
  return out;
}

export function startingTools(page: string): ToolName[] {
  const groups = new Set(startingGroups(page));
  return toolsFor("assistant").filter((n) => groups.has(toolMeta(n).group));
}

const short = (v: unknown, max = 6000) => {
  const s = JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…(cut)` : s;
};

type Conversation = {
  ok: boolean;
  code?: string;
  detail?: string | null;
  summary: string;
  unsupported: string;
  rejected: { op: string; reason: string }[];
  question: Question | null;
  model: string;
  effort: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  toolCalls: number;
  escalatedInvalid: boolean;
};

// One tool conversation: the model calls tools until it calls finish (or stops, or runs out of rounds).
async function runConversation(provider: AiProposalProvider, env: ToolEnv, instruction: string, startCall: "assistant_small" | "assistant_large", automationSteps: Map<string, Record<string, Json> | null>): Promise<Conversation> {
  let call = startCall;
  const offered = new Set<ToolName>(startingTools(env.context.page));
  const vocab = () =>
    [
      offered.has("create_automation") ? `Project automations:\n${rulesVocabularyText("project")}` : "",
      offered.has("create_my_automation") ? `My Tasks automations:\n${rulesVocabularyText("my_tasks")}` : "",
      offered.has("create_portfolio_automation") ? `Portfolio automations:\n${rulesVocabularyText("portfolio")}` : "",
    ]
      .filter(Boolean)
      .join("\n") || null;
  const messages: AiMessage[] = [{ role: "user", content: assistantUserPrompt(instruction, env.context, automationSteps) }];
  const out: Conversation = { ok: true, summary: "", unsupported: "", rejected: [], question: null, model: "", effort: null, inputTokens: null, outputTokens: null, toolCalls: 0, escalatedInvalid: false };
  let invalid = 0;
  for (let round = 0; round < ASSISTANT_LIMITS.toolRounds; round += 1) {
    const res = await converse(provider, { kind: call, system: assistantSystemPrompt(vocab()), messages, tools: toolSpecs(offered) });
    out.model = res.model || out.model;
    out.effort = res.effort ?? out.effort;
    out.inputTokens = sum(out.inputTokens, res.inputTokens);
    out.outputTokens = sum(out.outputTokens, res.outputTokens);
    if (!res.ok) return { ...out, ok: false, code: res.code, detail: res.detail ?? null };
    messages.push({ role: "assistant", content: res.content });
    const uses = res.content.filter((b): b is Extract<AiContentBlock, { type: "tool_use" }> => b.type === "tool_use");
    if (!uses.length) {
      if (!out.summary) out.summary = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ").trim().slice(0, 300);
      return out;
    }
    const results: AiContentBlock[] = [];
    let finished = false;
    for (const use of uses) {
      out.toolCalls += 1;
      const input = use.input && typeof use.input === "object" && !Array.isArray(use.input) ? (use.input as Record<string, unknown>) : {};
      const reply = (content: unknown, isError = false) => results.push({ type: "tool_result", tool_use_id: use.id, content: typeof content === "string" ? content : short(content), ...(isError ? { is_error: true } : {}) });
      if (out.toolCalls > ASSISTANT_LIMITS.toolCallsMax) {
        reply("Too many tool calls; call finish now.", true);
        continue;
      }
      if (use.name === "finish") {
        out.summary = String(input.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
        out.unsupported = String(input.unsupported ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
        finished = true;
        reply("ok");
        continue;
      }
      if (use.name === "find_tools") {
        const found = findTools(String(input.query ?? "")).filter((n) => n !== "find_tools");
        for (const n of found) offered.add(n);
        reply({ tools_now_available: found.map((n) => ({ name: n, does: toolMeta(n).label })) });
        continue;
      }
      if (!isToolName(use.name) || !offered.has(use.name)) {
        invalid += 1;
        reply(`“${use.name}” isn’t an available tool (find_tools lists more).`, true);
        continue;
      }
      try {
        if (toolMeta(use.name).kind === "read") {
          reply(await runReadTool(env, use.name, input));
          continue;
        }
        const before = env.staged.length;
        if (before >= ASSISTANT_LIMITS.opsMax) {
          reply(`A change set has at most ${ASSISTANT_LIMITS.opsMax} changes; call finish.`, true);
          continue;
        }
        const ops = await stageCall(env, use.name, input, `Change ${before + 1}`);
        reply({ staged: ops.map((o, i) => ({ change: before + i + 1, what: o.label, before: o.before, after: o.after, ...(o.destructive ? { destructive: true } : {}), ...(o.notifies ? { will_message: "yes (the user confirms it separately)" } : {}) })) });
      } catch (error) {
        if (error instanceof InputError) {
          invalid += 1;
          reply(`Invalid input: ${error.message}. Fix it and call again.`, true);
        } else if (error instanceof ToolQuestion) {
          out.question ??= error.question;
          reply(error.modelNote, true);
        } else if (error instanceof ToolRefusal) {
          out.rejected.push({ op: use.name, reason: error.message });
          reply(`Refused: ${error.message}`, true);
        } else if (isApiError(error)) {
          out.rejected.push({ op: use.name, reason: error.message });
          reply(`Refused: ${error.message}`, true);
        } else throw error;
      }
      // Note 179: Haiku's calls failing validation twice → the rest of the conversation is Sonnet's.
      if (call === "assistant_small" && invalid >= ASSISTANT_LIMITS.validationFailuresBeforeEscalation) {
        call = "assistant_large";
        out.escalatedInvalid = true;
      }
    }
    messages.push({ role: "user", content: results });
    if (finished) return out;
  }
  if (!out.summary) out.summary = env.staged.length ? `${env.staged.length} change${env.staged.length === 1 ? "" : "s"}` : "";
  return out;
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
  const me = context.people[0]?.id ?? (await viewerId(ctx, access.workspaceId));

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
  const focus = context.projects.find((p) => p.id === context.currentProjectId);
  const ruleContext = {
    sections: focus?.sections.map((s) => ({ id: s.id, name: s.name })) ?? [],
    fields: fieldDefs.filter((f) => f.projectId === context.currentProjectId),
    people: context.people.map((p) => ({ id: p.id, name: p.name })),
  };
  const base = { runId, pageKind: page.kind, contextLabel: label, ruleContext };

  // Notes 172 / 176: below Editor here (or with nothing the person may change on this page), and for
  // how-to questions, the assistant answers in plain words — no tools, nothing to confirm.
  const mode = assistantMode(instruction, canChangeHere(context));
  if (mode.mode === "answer") return { ...base, ...(await answerRun(ctx, runId, provider, instruction, context, mode.reason)) };

  // Each automation of the page in the full vocabulary (so an existing one with any steps can be edited).
  const pristine = structuredClone(context);
  const steps = new Map<string, Record<string, Json> | null>();
  {
    const env = toolEnv(ctx, access.workspaceId, me, "assistant", structuredClone(pristine), input.localToday);
    for (const r of env.context.rules) steps.set(r.id, await ruleForModel(env, { name: r.name, triggerType: r.triggerType, triggerConfig: r.triggerConfig, conditions: r.conditions, actions: r.actions }, "project", r.projectId));
  }

  const route = routeAssistant(instruction);
  let reason = route.reason;
  let escalated = false;
  let env = toolEnv(ctx, access.workspaceId, me, "assistant", structuredClone(pristine), input.localToday);
  let conv = await runConversation(provider, env, instruction, route.call, steps);
  if (conv.escalatedInvalid) {
    escalated = true;
    reason = "escalated_invalid";
  }
  // Note 179: a long or wide plan from Haiku is planned again by Sonnet (both calls' usage is logged).
  const wide = conv.ok && route.call === "assistant_small" && !conv.escalatedInvalid ? escalationReason(env.staged) : null;
  if (wide) {
    const first = conv;
    const env2 = toolEnv(ctx, access.workspaceId, me, "assistant", structuredClone(pristine), input.localToday);
    const second = await runConversation(provider, env2, instruction, "assistant_large", steps);
    if (second.ok) {
      env = env2;
      conv = { ...second, inputTokens: sum(first.inputTokens, second.inputTokens), outputTokens: sum(first.outputTokens, second.outputTokens), toolCalls: first.toolCalls + second.toolCalls };
      escalated = true;
      reason = wide;
    }
  }
  if (!conv.ok) {
    await failRun(ctx, runId, conv.code ?? "provider_error", { detail: conv.detail ?? null, result: conv, reason, escalated });
    throw new ApiError("unavailable", AI_ERROR_MESSAGES[conv.code ?? "provider_error"] ?? AI_ERROR_MESSAGES.provider_error);
  }
  const ops = env.staged;
  if (!ops.length && !conv.question) {
    const why = conv.unsupported || conv.rejected[0]?.reason || "";
    const message = why ? `Nothing to change: ${why}` : "The AI didn’t find anything to change. Try saying it differently.";
    await failRun(ctx, runId, "unsupported", { detail: message, result: conv, reason, escalated });
    throw new ApiError("invalid", message);
  }
  const plan: AssistantPlan = {
    summary: conv.summary || `${ops.length} change${ops.length === 1 ? "" : "s"}`,
    unsupported: conv.unsupported,
    ops,
    rejected: conv.rejected,
    question: conv.question,
  };
  const saved = await ctx.db
    .from("ai_assistant_runs")
    .update({
      status: "proposed",
      proposal: plan as unknown as Json,
      model: conv.model || null,
      effort: (conv.effort as "low" | null) ?? null,
      route_reason: reason,
      escalated,
      input_tokens: conv.inputTokens,
      output_tokens: conv.outputTokens,
      op_count: Math.min(ops.length, 100),
      ops_summary: opsSummary(ops) as unknown as Json,
      generated_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .eq("status", "generating")
    .select("id");
  check(saved);
  if (!saved.data?.length) throw new ApiError("conflict", "This request was cancelled");

  return {
    ...base,
    mode: "change",
    answer: null,
    answerOnly: false,
    summary: plan.summary,
    unsupported: plan.unsupported,
    ops,
    rejected: plan.rejected,
    question: plan.question,
    model: conv.model,
    routeReason: reason,
    escalated,
    inputTokens: conv.inputTokens,
    outputTokens: conv.outputTokens,
    toolCalls: conv.toolCalls,
  };
}

// Whether the person may change anything on this page: the page's project (Editor+, not archived), or —
// on My tasks and other pages — any project of the context.
export function canChangeHere(context: AssistantContext): boolean {
  const focus = context.projects.find((p) => p.id === context.currentProjectId);
  if (focus) return canChangeIn(focus.role, focus.archived);
  return context.projects.some((p) => canChangeIn(p.role, p.archived)) || context.page === "my_tasks" || context.page === "other";
}

type AnswerPart = Pick<AssistantProposal, "mode" | "answer" | "answerOnly" | "summary" | "unsupported" | "ops" | "rejected" | "question" | "model" | "routeReason" | "escalated" | "inputTokens" | "outputTokens" | "toolCalls">;

// Answer mode (round 4, note 176): Haiku answers from the help (generated from the registry) and the page's
// context. A change request from someone who may change nothing here gets the plain answer without a call.
async function answerRun(ctx: ApiContext, runId: string, provider: AiProposalProvider, instruction: string, context: AssistantContext, reason: "question" | "answer_only_role"): Promise<AnswerPart> {
  const answerOnly = reason === "answer_only_role";
  const routeReason = answerOnly ? "answer_only_role" : "answer_question";
  let answer: string;
  let result: AiProviderResult | null = null;
  if (answerOnly && !isHowToQuestion(instruction)) {
    answer = `${ANSWER_ONLY_NOTE.replace(", so the assistant only answers questions", "")} You can still ask how something works.`;
  } else {
    result = await callProvider(provider, {
      kind: "assistant_answer",
      system: ASSISTANT_ANSWER_SYSTEM_PROMPT,
      prompt: assistantAnswerPrompt(instruction, context, answerOnly ? ANSWER_ONLY_NOTE : null),
      schema: ASSISTANT_ANSWER_SCHEMA as Record<string, unknown>,
    });
    if (!result.ok) {
      await failRun(ctx, runId, result.code, { detail: result.detail ?? null, result, reason: routeReason });
      throw new ApiError("unavailable", AI_ERROR_MESSAGES[result.code] ?? AI_ERROR_MESSAGES.provider_error);
    }
    const cleaned = cleanAnswer(result.output);
    if (!cleaned) {
      await failRun(ctx, runId, "invalid_output", { result, reason: routeReason });
      throw new ApiError("unavailable", AI_ERROR_MESSAGES.invalid_output ?? AI_ERROR_MESSAGES.provider_error);
    }
    answer = cleaned;
  }
  const stored: AssistantPlan & { mode: "answer" } = { summary: "", unsupported: "", ops: [], rejected: [], question: null, mode: "answer" };
  const saved = await ctx.db
    .from("ai_assistant_runs")
    .update({
      status: "proposed",
      proposal: stored as unknown as Json,
      model: result?.model || null,
      effort: result?.effort ?? null,
      route_reason: routeReason,
      input_tokens: result?.inputTokens ?? null,
      output_tokens: result?.outputTokens ?? null,
      op_count: 0,
      ops_summary: {} as Json,
      generated_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .eq("status", "generating")
    .select("id");
  check(saved);
  return { mode: "answer", answer, answerOnly, summary: "", unsupported: "", ops: [], rejected: [], question: null, model: result?.model ?? "", routeReason, escalated: false, inputTokens: result?.inputTokens ?? null, outputTokens: result?.outputTokens ?? null, toolCalls: 0 };
}

// ---- Confirm --------------------------------------------------------------------------------------------

type StoredApplied = { selected: number[]; records: AppliedRecord[]; rollbackFailed?: number[] };

export function parseApplied(raw: unknown): StoredApplied | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as { selected?: unknown; records?: unknown };
  if (!Array.isArray(v.records) || !Array.isArray(v.selected)) return null;
  return raw as StoredApplied;
}

const idsOf = (records: AppliedRecord[]) => [
  ...new Set(
    records
      .flatMap((r) => [r.created, ...Object.entries(r.op.args).filter(([k, v]) => k.endsWith("_id") && typeof v === "string" && !v.startsWith("$op:")).map(([, v]) => v as string)])
      .filter((x): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)),
  ),
];

const refusal = (error: unknown) => (isApiError(error) ? error.message : "it was refused");
export const createdRulesOf = (records: AppliedRecord[]) =>
  records.flatMap((r) => (r.op.op === "create_automation" && r.created && !r.undone && r.op.rule ? [{ index: r.index, ruleId: r.created, projectId: r.op.projectId!, name: r.op.rule.name, notifies: r.op.after.includes("once on, it messages") ? r.op.after.split("once on, it messages ")[1] ?? null : null }] : []));

// Checks, then writes the chosen changes of a stored plan in order (the run must be "applying" with this
// key). Answers what it did; throws (after marking the run) when something is refused.
export async function applyPlan(ctx: ApiContext, workspaceId: string, runId: string, ops: StagedOp[], order: number[], timeZone: string | undefined): Promise<AppliedRecord[]> {
  // Check everything before writing anything: the person's access now, and that the data is still what
  // was previewed (a stale change set is refused, never written over newer data).
  const stale: string[] = [];
  for (const index of order) {
    const op = ops[index];
    try {
      await checkOp(ctx, workspaceId, op);
    } catch (error) {
      await failRun(ctx, runId, isApiError(error) && error.code === "forbidden" ? "forbidden" : "refused", { detail: `Change ${index + 1}: ${refusal(error)}` });
      throw new ApiError(isApiError(error) ? error.code : "failed", `Change ${index + 1} (${op.label}): ${refusal(error)}. Nothing was changed.`);
    }
    if (op.expect) {
      const current = await readOp(ctx, op, null);
      if (!matchesExpect(op.expect, current) || current.missing === true) stale.push(op.label);
    }
  }
  if (stale.length) {
    await failRun(ctx, runId, "stale", { detail: `Changed since the AI looked: ${stale.join("; ")}`.slice(0, 400) });
    throw new ApiError("conflict", `${ASSISTANT_ERROR_MESSAGES.stale} Changed: ${stale.slice(0, 3).join("; ")}.`);
  }

  const records: AppliedRecord[] = [];
  const createdBy = new Map<number, string>();
  for (const index of order) {
    const op = ops[index];
    try {
      const before = await readOp(ctx, op, null);
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
      for (const r of records) r.after = await readOp(ctx, r.op, r.created);
      await ctx.db
        .from("ai_assistant_runs")
        .update({ status: "applied", error_code: "apply_failed", error_detail: scrubProviderDetail(message), applied: { selected: order, records, rollbackFailed: failed } as unknown as Json, touched_ids: idsOf(records) })
        .eq("id", runId);
      throw new ApiError(isApiError(error) ? error.code : "failed", `${message} Some changes couldn’t be put back; use Undo to finish.`);
    }
  }
  for (const r of records) r.after = await readOp(ctx, r.op, r.created);
  const done = await ctx.db
    .from("ai_assistant_runs")
    .update({ status: "applied", applied: { selected: order, records } as unknown as Json, touched_ids: idsOf(records) })
    .eq("id", runId)
    .eq("status", "applying")
    .select("id");
  check(done);
  return records;
}

export async function applyAssistantRun(ctx: ApiContext, input: AssistantApplyInput): Promise<AssistantApplyResult> {
  const access = await requirePilot(ctx);
  const runId = id(input.runId, "run");
  if (!isRequestKey(input.applyKey)) throw new ApiError("invalid", "Invalid request");
  const applyKey = input.applyKey;
  const selected = Array.isArray(input.selected) ? input.selected : null;
  if (!selected || !selected.every((i) => typeof i === "number")) throw new ApiError("invalid", "Invalid selection");
  const acknowledged = new Set(Array.isArray(input.acknowledged) ? input.acknowledged.filter((i): i is number => typeof i === "number") : []);
  const timeZone = typeof input.timeZone === "string" && input.timeZone.length <= 64 && /^[A-Za-z0-9_+\-/]+$/.test(input.timeZone) ? input.timeZone : undefined;
  const me = await viewerId(ctx, access.workspaceId);

  const run = await getAssistantRunRow(ctx, runId);
  if (!run || run.workspace_id !== access.workspaceId || run.actor_id.toLowerCase() !== me) throw new ApiError("not_found", "Run not found");
  if (run.apply_key === applyKey && (run.status === "applied" || run.status === "undone")) {
    const records = parseApplied(run.applied)?.records ?? [];
    return { runId, applied: records.length, repeated: true, createdRules: createdRulesOf(records) };
  }
  if (run.status === "applying") throw new ApiError("conflict", "These changes are being applied already");
  if (run.status !== "proposed") throw new ApiError("conflict", "These changes can’t be applied any more");
  const plan = parseStoredPlan(run.proposal, isToolName);
  if (!plan) throw new ApiError("failed", "The stored change set isn’t valid");
  const order = [...(selected as number[])].sort((a, b) => a - b);
  const problem = selectionProblem(plan.ops, order);
  if (problem) throw new ApiError("invalid", problem);
  // A change that messages people needs its own tick, naming who (never only the general Confirm).
  const unacked = order.filter((i) => plan.ops[i].notifies && !acknowledged.has(i));
  if (unacked.length) throw new ApiError("invalid", `Tick “I know this messages ${plan.ops[unacked[0]].notifies}” for change ${unacked[0] + 1} first`);

  const claimed = await ctx.db.from("ai_assistant_runs").update({ status: "applying", apply_key: applyKey }).eq("id", runId).eq("status", "proposed").select("id");
  check(claimed);
  if (!claimed.data?.length) {
    const now = await getAssistantRunRow(ctx, runId);
    if (now?.apply_key === applyKey && now.status === "applied") {
      const records = parseApplied(now.applied)?.records ?? [];
      return { runId, applied: records.length, repeated: true, createdRules: createdRulesOf(records) };
    }
    throw new ApiError("conflict", "These changes are being applied already");
  }
  const records = await applyPlan(ctx, access.workspaceId, runId, plan.ops, order, timeZone);
  return { runId, applied: records.length, repeated: false, createdRules: createdRulesOf(records) };
}

// Round 4 (note 173): Turn on & Finish — turns on automations THIS run made (never another), after checking
// the role again and that the automation is still as the run left it. One whose steps message people when
// it runs needs `acknowledge: true` (the panel's tick naming who). Recorded, so Undo turns it off first.
export async function turnOnAssistantRules(ctx: ApiContext, runIdInput: unknown, ruleIdsInput?: unknown, acknowledge?: unknown): Promise<AssistantTurnOnResult> {
  const access = await requirePilot(ctx);
  const runId = id(runIdInput, "run");
  const me = await viewerId(ctx, access.workspaceId);
  const run = await getAssistantRunRow(ctx, runId);
  if (!run || run.workspace_id !== access.workspaceId || run.actor_id.toLowerCase() !== me) throw new ApiError("not_found", "Run not found");
  if (run.status !== "applied") throw new ApiError("conflict", "Only automations of applied changes can be turned on here");
  const applied = parseApplied(run.applied);
  if (!applied) throw new ApiError("failed", "The run’s record of its changes isn’t valid");
  const made = applied.records.filter((r) => r.op.op === "create_automation" && r.created && !r.undone);
  let wanted = made;
  if (ruleIdsInput !== undefined) {
    if (!Array.isArray(ruleIdsInput) || ruleIdsInput.length > made.length || !ruleIdsInput.every((x) => typeof x === "string")) throw new ApiError("invalid", "Invalid selection");
    const ids = new Set((ruleIdsInput as string[]).map((x) => x.toLowerCase()));
    wanted = made.filter((r) => ids.has(r.created!.toLowerCase()));
    if (wanted.length !== ids.size) throw new ApiError("invalid", "Only automations these changes made can be turned on here");
  }
  if (!wanted.length) return { turnedOn: [], alreadyOn: [] };
  const outward = createdRulesOf(wanted).filter((c) => c.notifies);
  if (outward.length && acknowledge !== true) throw new ApiError("invalid", `“${outward[0].name}” messages ${outward[0].notifies} when it runs; tick that you know before turning it on`);

  for (const r of wanted) {
    await checkOp(ctx, access.workspaceId, { ...r.op, op: "enable_automation", args: { rule_id: r.created! } });
    const now = await readOp(ctx, r.op, r.created);
    const expected = r.after ? { ...r.after, enabled: Boolean(r.turnedOn) } : null;
    if (!expected || !sameState({ ...now, enabled: Boolean(now.enabled) }, expected)) throw new ApiError("conflict", `“${r.op.label}” changed since; turn it on in the automation builder`);
  }
  const turnedOn: string[] = [];
  const alreadyOn: string[] = [];
  for (const r of wanted) {
    if (r.turnedOn) {
      alreadyOn.push(r.created!);
      continue;
    }
    await setRuleEnabled(ctx, r.created!, true);
    r.turnedOn = true;
    r.after = await readOp(ctx, r.op, r.created);
    turnedOn.push(r.created!);
  }
  const saved = await ctx.db.from("ai_assistant_runs").update({ applied: { ...applied, turnedOnAt: new Date().toISOString() } as unknown as Json }).eq("id", runId).eq("status", "applied").select("id");
  check(saved);
  return { turnedOn, alreadyOn };
}

// Undoes `records` in reverse (marking each), answering the indexes that couldn't be put back.
async function rollBack(ctx: ApiContext, records: AppliedRecord[]): Promise<number[]> {
  const failed: number[] = [];
  for (const r of [...records].reverse()) {
    if (r.op.noUndo) {
      failed.push(r.index);
      continue;
    }
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
  if (run.status === "undone") return { status: "already_undone", undone: 0, notUndone: [] };
  if (run.status !== "applied") throw new ApiError("conflict", "Only applied changes can be undone");
  const applied = parseApplied(run.applied);
  if (!applied) throw new ApiError("failed", "The run’s record of its changes isn’t valid");
  const pending = applied.records.filter((r) => !r.undone && !r.op.noUndo);
  const notUndone = applied.records.filter((r) => !r.undone && r.op.noUndo).map((r) => r.op.label);

  const conflicts: string[] = [];
  for (const r of pending) {
    try {
      await checkOp(ctx, access.workspaceId, r.op, { undoing: true });
    } catch (error) {
      conflicts.push(`${r.op.label}: ${refusal(error)}`);
      continue;
    }
    const current = await readOp(ctx, r.op, r.created);
    if (!r.after || !sameState(current, r.after)) conflicts.push(`${r.op.label}: changed since`);
  }
  if (conflicts.length) {
    await ctx.db.from("ai_assistant_runs").update({ undo_conflicts: { changed: conflicts } as unknown as Json }).eq("id", runId).eq("status", "applied");
    return { status: "conflict", conflicts };
  }
  let undone = 0;
  for (const r of [...applied.records].reverse()) {
    if (r.undone || r.op.noUndo) continue;
    try {
      await undoOp(ctx, r.op, r.before, r.created, { turnedOn: r.turnedOn });
      r.undone = true;
      undone += 1;
    } catch (error) {
      await ctx.db.from("ai_assistant_runs").update({ applied: applied as unknown as Json }).eq("id", runId).eq("status", "applied");
      throw new ApiError(isApiError(error) ? error.code : "failed", `Undo stopped at “${r.op.label}”: ${refusal(error)}. Try Undo again.`);
    }
  }
  const saved = await ctx.db.from("ai_assistant_runs").update({ status: "undone", applied: applied as unknown as Json, undo_conflicts: null }).eq("id", runId).eq("status", "applied").select("id");
  check(saved);
  return { status: "undone", undone, notUndone };
}

export async function cancelAssistantRun(ctx: ApiContext, runIdInput: unknown): Promise<void> {
  await requirePilot(ctx);
  const runId = id(runIdInput, "run");
  check(await ctx.db.from("ai_assistant_runs").update({ status: "cancelled" }).eq("id", runId).in("status", ["generating", "proposed"]));
}

export type { StagedOp };
