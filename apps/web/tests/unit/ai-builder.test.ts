// AI builder pilot (experimental, feat/ai-builder): the Anthropic adapter (a fake client: no network, no
// billable call) and the generation route's own guards. The layer's checks are in
// packages/core/tests/ai-builder.test.ts; the database's in supabase/tests/zz56_ai_builder_pilot_smoke.sql.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import { AI_BUILDER_MAX_OUTPUT_TOKENS, AI_BUILDER_MODEL } from "@alhc/core/ai-builder";
import { aiBuilderConfigured, createAnthropicProvider, providerErrorCode } from "@/lib/ai-builder/anthropic";
import { POST } from "@/app/api/ai-builder/generate/route";

type Create = (params: Record<string, unknown>) => Promise<unknown>;
const client = (create: Create) => ({ messages: { create } }) as unknown as Pick<Anthropic, "messages">;
const message = (over: Record<string, unknown>) => ({
  model: AI_BUILDER_MODEL,
  stop_reason: "end_turn",
  usage: { input_tokens: 812, output_tokens: 640 },
  content: [{ type: "text", text: '{"name":"X"}' }],
  ...over,
});
const request = { system: "s", prompt: "p", schema: { type: "object" } };

test("one request: the central model, a bounded output, structured output, the brief as the user turn", async () => {
  let seen: Record<string, unknown> = {};
  const p = createAnthropicProvider(
    client(async (params) => {
      seen = params;
      return message({});
    }),
  );
  const res = await p.generate(request);
  assert.deepEqual(res, { ok: true, output: { name: "X" }, model: AI_BUILDER_MODEL, inputTokens: 812, outputTokens: 640 });
  assert.equal(seen.model, AI_BUILDER_MODEL);
  assert.equal(seen.max_tokens, AI_BUILDER_MAX_OUTPUT_TOKENS);
  assert.deepEqual((seen.output_config as { format: unknown }).format, { type: "json_schema", schema: { type: "object" } });
  assert.deepEqual(seen.messages, [{ role: "user", content: "p" }]);
  assert.ok(!("tools" in seen), "the model gets no tools");
});

test("refusals, truncation, and malformed output are codes, never content", async () => {
  const run = (over: Record<string, unknown>) => createAnthropicProvider(client(async () => message(over))).generate(request);
  assert.equal(((await run({ stop_reason: "refusal" })) as { code: string }).code, "refused");
  assert.equal(((await run({ stop_reason: "max_tokens" })) as { code: string }).code, "truncated");
  assert.equal(((await run({ content: [{ type: "text", text: '{"name": "X"' }] })) as { code: string }).code, "invalid_output");
});

test("provider errors map to codes and the log never carries the provider's message", async () => {
  const headers = new Headers();
  assert.equal(providerErrorCode(new Anthropic.AuthenticationError(401, {}, "invalid x-api-key", headers)), "auth");
  assert.equal(providerErrorCode(new Anthropic.RateLimitError(429, {}, "rate limited", headers)), "rate_limited");
  assert.equal(providerErrorCode(new Anthropic.InternalServerError(529, {}, "overloaded", headers)), "overloaded");
  assert.equal(providerErrorCode(new Anthropic.APIConnectionTimeoutError({ message: "timed out" })), "timeout");
  assert.equal(providerErrorCode(new Error("anything")), "provider_error");

  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  try {
    const res = await createAnthropicProvider(
      client(async () => {
        throw new Anthropic.AuthenticationError(401, {}, "invalid x-api-key sk-ant-api03-SECRET", headers);
      }),
    ).generate(request);
    assert.equal((res as { code: string }).code, "auth");
  } finally {
    console.error = original;
  }
  assert.ok(logged.length > 0 && logged.every((l) => !l.includes("sk-ant") && !l.includes("x-api-key")), logged.join("\n"));
});

test("without ANTHROPIC_API_KEY the builder says it isn't configured and calls nothing", async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.equal(aiBuilderConfigured(), false);
    const p = createAnthropicProvider();
    assert.equal(p.configured, false);
    assert.equal(((await p.generate(request)) as { code: string }).code, "not_configured");
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test("the key is read on the server only, never from a public variable", () => {
  const root = path.resolve(import.meta.dirname, "../../src");
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const users = walk(root).filter((f) => /ANTHROPIC_API_KEY/.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(users.map((f) => path.relative(root, f)), ["lib/ai-builder/anthropic.ts"]);
  assert.match(fs.readFileSync(path.join(root, "lib/ai-builder/anthropic.ts"), "utf8"), /^import "server-only";/);
  assert.ok(!walk(root).some((f) => /NEXT_PUBLIC_ANTHROPIC/.test(fs.readFileSync(f, "utf8"))));
});

test("the generation route refuses cross-site and non-JSON requests before anything else", async () => {
  const url = "https://app.example/api/ai-builder/generate";
  const body = JSON.stringify({ requestKey: "req-key-0001", brief: "x" });
  const crossSite = await POST(new NextRequest(url, { method: "POST", body, headers: { origin: "https://evil.example", "content-type": "application/json" } }));
  assert.equal(crossSite.status, 403);
  const noOrigin = await POST(new NextRequest(url, { method: "POST", body, headers: { "content-type": "application/json" } }));
  assert.equal(noOrigin.status, 403);
  const form = await POST(new NextRequest(url, { method: "POST", body, headers: { origin: "https://app.example", "content-type": "text/plain" } }));
  assert.equal(form.status, 415);
  const big = await POST(
    new NextRequest(url, { method: "POST", body: "x".repeat(20_000), headers: { origin: "https://app.example", "content-type": "application/json" } }),
  );
  assert.equal(big.status, 413);
});
