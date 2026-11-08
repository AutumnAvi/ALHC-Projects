import "server-only";
// AI builder pilot (experimental, feat/ai-builder): the one model call, server only. The key is read from
// ANTHROPIC_API_KEY at call time and never logged, returned, or sent anywhere but Anthropic. Errors become
// codes (AiProviderErrorCode). A failed call also returns the provider's HTTP status, error.type, and
// message (formatProviderError: no key, no headers, no prompt) for the run log. The model's raw output
// never leaves this file except as the parsed JSON the layer then validates.
//
// Round 2 (note 169): each call has a kind — build (the first proposal), edit (an AI change to a draft),
// automation (an automation draft) — and its own model, effort, output ceiling, and timeout
// (AI_BUILDER_CALLS in @alhc/core/ai-builder). A deployment may override a kind's model or effort with
// AI_BUILDER_<KIND>_MODEL / AI_BUILDER_<KIND>_EFFORT (server-side only); a value off the allowlists is
// ignored (aiCallConfig).
import Anthropic from "@anthropic-ai/sdk";
import { aiCallConfig, formatProviderError, type AiCallConfig, type AiCallKind } from "@alhc/core/ai-builder";
import type { AiProposalProvider, AiProviderErrorCode, AiProviderResult } from "@alhc/core/api/ai-builder/model";

export function aiBuilderConfigured(): boolean {
  return typeof process.env.ANTHROPIC_API_KEY === "string" && process.env.ANTHROPIC_API_KEY.trim().length > 0;
}

// The config for a kind of call, with this deployment's (allowlisted) overrides.
export function callConfig(kind: AiCallKind, env: Record<string, string | undefined> = process.env): AiCallConfig {
  const prefix = `AI_BUILDER_${kind.toUpperCase()}`;
  return aiCallConfig(kind, { model: env[`${prefix}_MODEL`] ?? null, effort: env[`${prefix}_EFFORT`] ?? null });
}

// The Messages request for one kind of call. No tools, and thinking left adaptive (omitted): Haiku 5.5
// rejects thinking disabled at its highest efforts, and with JSON output it can then skip the answer.
export function anthropicMessageCreate(
  kind: AiCallKind,
  request: { system: string; prompt: string; schema: Record<string, unknown> },
  env?: Record<string, string | undefined>,
) {
  const config = callConfig(kind, env);
  return {
    config,
    params: {
      model: config.model,
      max_tokens: config.maxTokens,
      system: request.system,
      messages: [{ role: "user" as const, content: request.prompt }],
      output_config: { effort: config.effort, format: { type: "json_schema" as const, schema: request.schema } },
    },
    options: { timeout: config.timeoutMs, maxRetries: config.maxRetries },
  };
}

// HTTP status, error.type, and error message from an SDK failure. Nothing else (no headers, no request).
export function providerErrorDetail(error: unknown): string | null {
  if (!(error instanceof Anthropic.APIError)) return null;
  const status = typeof error.status === "number" ? error.status : null;
  return formatProviderError(status, error.type, error.apiMessage);
}

type MessagesClient = Pick<Anthropic, "messages">;

// Maps an SDK failure to a code (most specific first; APIConnectionTimeoutError is an APIConnectionError,
// which is an APIError in the TypeScript SDK).
export function providerErrorCode(error: unknown): AiProviderErrorCode {
  if (error instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (error instanceof Anthropic.APIConnectionError) return "provider_error";
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return "auth";
  if (error instanceof Anthropic.RateLimitError) return "rate_limited";
  if (error instanceof Anthropic.APIError) return error.status === 529 ? "overloaded" : "provider_error";
  return "provider_error";
}

export function createAnthropicProvider(client?: MessagesClient, env?: Record<string, string | undefined>): AiProposalProvider {
  return {
    configured: Boolean(client) || aiBuilderConfigured(),
    async generate({ kind = "build", system, prompt, schema }): Promise<AiProviderResult> {
      const { config, params, options } = anthropicMessageCreate(kind, { system, prompt, schema }, env);
      const base = { model: config.model, effort: config.effort, inputTokens: null, outputTokens: null };
      if (!client && !aiBuilderConfigured()) return { ok: false, code: "not_configured", ...base };
      const api =
        client ?? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: config.timeoutMs, maxRetries: config.maxRetries });
      let message: Anthropic.Message;
      try {
        message = await api.messages.create(
          params,
          // Per call: an edit or an automation draft waits less than a first build.
          options,
        );
      } catch (error) {
        const code = providerErrorCode(error);
        const detail = providerErrorDetail(error);
        // The run log stores this same line (status, type, message). Never the key or the prompt.
        console.error(`[ai-builder] provider call failed: ${kind} ${code}${detail ? ` ${detail}` : ""}`);
        return { ok: false, code, detail, ...base };
      }
      const usage = {
        model: message.model ?? config.model,
        effort: config.effort,
        inputTokens: message.usage?.input_tokens ?? null,
        outputTokens: message.usage?.output_tokens ?? null,
      };
      if (message.stop_reason === "refusal") return { ok: false, code: "refused", ...usage };
      if (message.stop_reason === "max_tokens") return { ok: false, code: "truncated", ...usage };
      const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      try {
        return { ok: true, output: JSON.parse(text), ...usage };
      } catch {
        return { ok: false, code: "invalid_output", ...usage };
      }
    },
  };
}
