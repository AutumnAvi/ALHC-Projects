import "server-only";
// AI builder pilot (experimental, feat/ai-builder): the one model call, server only. The key is read from
// ANTHROPIC_API_KEY at call time and never logged, returned, or sent anywhere but Anthropic. Errors become
// codes (AiProviderErrorCode); the provider's messages and the model's raw output never leave this file
// except as the parsed JSON the layer then validates.
//
// Round 2 (note 169): each call has a kind — build (the first proposal), edit (an AI change to a draft),
// automation (an automation draft) — and its own model, effort, output ceiling, and timeout
// (AI_BUILDER_CALLS in @alhc/core/ai-builder). A deployment may override a kind's model or effort with
// AI_BUILDER_<KIND>_MODEL / AI_BUILDER_<KIND>_EFFORT (server-side only); a value off the allowlists is
// ignored (aiCallConfig).
import Anthropic from "@anthropic-ai/sdk";
import { aiCallConfig, type AiCallConfig, type AiCallKind } from "@alhc/core/ai-builder";
import type { AiProposalProvider, AiProviderErrorCode, AiProviderResult } from "@alhc/core/api/ai-builder/model";

export function aiBuilderConfigured(): boolean {
  return typeof process.env.ANTHROPIC_API_KEY === "string" && process.env.ANTHROPIC_API_KEY.trim().length > 0;
}

// The config for a kind of call, with this deployment's (allowlisted) overrides.
export function callConfig(kind: AiCallKind, env: Record<string, string | undefined> = process.env): AiCallConfig {
  const prefix = `AI_BUILDER_${kind.toUpperCase()}`;
  return aiCallConfig(kind, { model: env[`${prefix}_MODEL`] ?? null, effort: env[`${prefix}_EFFORT`] ?? null });
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
      const config = callConfig(kind, env);
      const base = { model: config.model, effort: config.effort, inputTokens: null, outputTokens: null };
      if (!client && !aiBuilderConfigured()) return { ok: false, code: "not_configured", ...base };
      const api =
        client ?? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: config.timeoutMs, maxRetries: config.maxRetries });
      let message: Anthropic.Message;
      try {
        message = await api.messages.create(
          {
            model: config.model,
            max_tokens: config.maxTokens,
            system,
            messages: [{ role: "user", content: prompt }],
            output_config: { effort: config.effort, format: { type: "json_schema", schema } },
          },
          // Per call: an edit or an automation draft waits less than a first build.
          { timeout: config.timeoutMs, maxRetries: config.maxRetries },
        );
      } catch (error) {
        const code = providerErrorCode(error);
        console.error(`[ai-builder] provider call failed: ${kind} ${code}`);
        return { ok: false, code, ...base };
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
