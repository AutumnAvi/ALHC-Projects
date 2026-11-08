import "server-only";
// AI builder pilot (experimental, feat/ai-builder): the one model call, server only. The key is read from
// ANTHROPIC_API_KEY at call time and never logged, returned, or sent anywhere but Anthropic. Errors become
// codes (AiProviderErrorCode); the provider's messages and the model's raw output never leave this file
// except as the parsed JSON the layer then validates.
import Anthropic from "@anthropic-ai/sdk";
import {
  AI_BUILDER_EFFORT,
  AI_BUILDER_MAX_OUTPUT_TOKENS,
  AI_BUILDER_MAX_RETRIES,
  AI_BUILDER_MODEL,
  AI_BUILDER_TIMEOUT_MS,
} from "@alhc/core/ai-builder";
import type { AiProposalProvider, AiProviderErrorCode, AiProviderResult } from "@alhc/core/api/ai-builder/model";

export function aiBuilderConfigured(): boolean {
  return typeof process.env.ANTHROPIC_API_KEY === "string" && process.env.ANTHROPIC_API_KEY.trim().length > 0;
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

export function createAnthropicProvider(client?: MessagesClient): AiProposalProvider {
  return {
    configured: Boolean(client) || aiBuilderConfigured(),
    async generate({ system, prompt, schema }): Promise<AiProviderResult> {
      const base = { model: AI_BUILDER_MODEL, inputTokens: null, outputTokens: null };
      if (!client && !aiBuilderConfigured()) return { ok: false, code: "not_configured", ...base };
      const api =
        client ?? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: AI_BUILDER_TIMEOUT_MS, maxRetries: AI_BUILDER_MAX_RETRIES });
      let message: Anthropic.Message;
      try {
        message = await api.messages.create({
          model: AI_BUILDER_MODEL,
          max_tokens: AI_BUILDER_MAX_OUTPUT_TOKENS,
          system,
          messages: [{ role: "user", content: prompt }],
          output_config: { effort: AI_BUILDER_EFFORT, format: { type: "json_schema", schema } },
        });
      } catch (error) {
        const code = providerErrorCode(error);
        console.error(`[ai-builder] provider call failed: ${code}`);
        return { ok: false, code, ...base };
      }
      const usage = { model: message.model ?? AI_BUILDER_MODEL, inputTokens: message.usage?.input_tokens ?? null, outputTokens: message.usage?.output_tokens ?? null };
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
