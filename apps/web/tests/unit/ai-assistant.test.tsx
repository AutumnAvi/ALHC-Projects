// AI builder round 3 (experimental, note 171): the global assistant's web side — the panel opens from
// every kind of page (and the shortcut), the page goes to the server as kinds and ids only, the provider
// call for the assistant's two kinds, the route's guards, and the preview auto-login is unchanged.
// Synthetic fixtures: no network, no database, nothing billable.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { ASSISTANT_JSON_SCHEMA } from "@alhc/core/ai-assistant";
import { AI_BUILDER_CALLS, structuredOutputIssues } from "@alhc/core/ai-builder";
import { AssistantDock } from "@/components/ai-assistant/ai-assistant";
import { ShellProvider } from "@/components/shell/shell-context";
import { ToastProvider } from "@/components/toast";
import { DEFAULT_SIDEBAR_PREFS } from "@/lib/sidebar-prefs";
import { anthropicMessageCreate } from "@/lib/ai-builder/anthropic";
import { POST as proposePost } from "@/app/api/ai-assistant/propose/route";

const P = "33333333-3333-4333-8333-333333333331";
const T = "55555555-5555-4555-8555-555555555551";
const R = "77777777-7777-4777-8777-777777777771";
const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const read = (rel: string) => fs.readFileSync(path.resolve(import.meta.dirname, "../..", rel), "utf8");

function renderAt(pathname: string, search = "") {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value={pathname}>
        <SearchParamsContext.Provider value={new URLSearchParams(search) as never}>
          <ShellProvider member={{ id: "me", email: "me@example.com", name: "Me", avatarUrl: null } as never} isWorkspaceAdmin workspace={{ name: "Testing data", logoUrl: null }} initialSidebar={DEFAULT_SIDEBAR_PREFS}>
            <ToastProvider>
              <AssistantDock configured />
            </ToastProvider>
          </ShellProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

test("the panel opens on every kind of page and says what it's working on", () => {
  const cases: [string, string, string][] = [
    [`/projects/${P}/views/v1`, "", "this project"],
    [`/projects/${P}/views/v1`, `task=${T}`, "this task"],
    ["/my-tasks", "", "My tasks"],
    ["/my-tasks", `task=${T}`, "this task"],
    [`/projects/${P}/rules`, "", "this project’s automations"],
    [`/projects/${P}/rules/${R}`, "", "this automation"],
    ["/inbox", "", "your Testing data projects"],
  ];
  for (const [pathname, search, label] of cases) {
    const html = renderAt(pathname, search);
    assert.match(html, /role="dialog"/, pathname);
    assert.ok(html.includes(label), `${pathname}?${search}: ${label}`);
    assert.ok(html.includes("nothing changes until you confirm"), "it asks before applying");
    assert.ok(html.includes('aria-label="Ask the AI to change something"'), "a text box");
    assert.ok(!html.includes(P) && !html.includes(T), "ids stay out of the markup");
  }
});

test("the assistant is mounted once by the app shell (round 4: a floating bubble, no top bar button)", () => {
  assert.ok(!read("src/components/shell/top-bar.tsx").includes("AssistantButton"), "the top bar's button is gone (note 176)");
  assert.ok(read("src/components/shell/app-shell.tsx").includes("<AiAssistant />"), "mounted once by the app shell");
});

test("the shortcut is Tab then A, registered and listed in the shortcuts help", () => {
  assert.ok(read("src/components/ai-assistant/ai-assistant.tsx").includes('useTabChord("a", () => toggleAssistant(), { allowOver: ASSISTANT_ALLOWED })'));
  const help = read("src/components/shortcuts/keyboard-shortcuts.tsx");
  assert.ok(help.includes('{ keys: ["Tab", "then", "A"], label: "Open or close the AI assistant'));
  for (const taken of ['"Tab", "then", "Q"', '"Tab", "then", "M"']) assert.ok(help.includes(taken), "the existing chords stay");
  assert.equal((help.match(/"Tab", "then", "A"/g) ?? []).length, 1, "no other Tab then A");
});

test("the assistant's provider calls: Haiku for small edits, Sonnet for automations, the flat schema, no thinking", () => {
  for (const kind of ["assistant_small", "assistant_large"] as const) {
    const { params, options } = anthropicMessageCreate(kind, { system: "s", prompt: "p", schema: ASSISTANT_JSON_SCHEMA as Record<string, unknown> }, {});
    assert.equal(params.model, AI_BUILDER_CALLS[kind].model);
    assert.equal(params.output_config.effort, AI_BUILDER_CALLS[kind].effort);
    assert.equal(params.output_config.format.schema, ASSISTANT_JSON_SCHEMA);
    assert.equal(options.timeout, AI_BUILDER_CALLS[kind].timeoutMs);
    assert.ok(!("thinking" in params));
  }
  assert.equal(anthropicMessageCreate("assistant_small", { system: "s", prompt: "p", schema: {} }, {}).params.model, "claude-haiku-5-5");
  assert.equal(anthropicMessageCreate("assistant_large", { system: "s", prompt: "p", schema: {} }, {}).params.model, "claude-sonnet-5-5");
  // A deployment override is used only when it's on the allowlist.
  assert.equal(anthropicMessageCreate("assistant_small", { system: "s", prompt: "p", schema: {} }, { AI_BUILDER_ASSISTANT_SMALL_MODEL: "gpt-x" }).params.model, "claude-haiku-5-5");
  assert.deepEqual(structuredOutputIssues(ASSISTANT_JSON_SCHEMA), []);
});

test("the propose route refuses cross-site and non-JSON requests before anything runs", async () => {
  const url = "https://app.example/api/ai-assistant/propose";
  const body = JSON.stringify({ requestKey: "req-key-0001", page: { kind: "other" }, instruction: "x", localToday: "2026-11-08" });
  assert.equal((await proposePost(new NextRequest(url, { method: "POST", body, headers: { origin: "https://evil.example", "content-type": "application/json" } }))).status, 403);
  assert.equal((await proposePost(new NextRequest(url, { method: "POST", body, headers: { "content-type": "application/json" } }))).status, 403);
  assert.equal((await proposePost(new NextRequest(url, { method: "POST", body, headers: { origin: "https://app.example", "content-type": "text/plain" } }))).status, 415);
  assert.equal((await proposePost(new NextRequest(url, { method: "POST", body: "x".repeat(9000), headers: { origin: "https://app.example", "content-type": "application/json" } }))).status, 413);
});

test("the key stays on the server: no client file reads ANTHROPIC_API_KEY, nothing logs a prompt", () => {
  const dir = path.resolve(import.meta.dirname, "../../src/components/ai-assistant");
  for (const file of fs.readdirSync(dir)) assert.ok(!fs.readFileSync(path.join(dir, file), "utf8").includes("ANTHROPIC_API_KEY"), file);
  const anthropic = read("src/lib/ai-builder/anthropic.ts");
  assert.ok(anthropic.startsWith('import "server-only";'));
  assert.ok(!/console\.\w+\([^)]*(prompt|system|params)/.test(anthropic), "never logs the prompt");
});

test("the preview auto-login is unchanged: Vercel Preview AND ALHC_PREVIEW_AUTOLOGIN=1, never on API routes", () => {
  const proxy = read("src/lib/supabase/proxy.ts");
  assert.ok(
    proxy.includes(`function previewAutoLogin(): { email: string; password: string } | null {
  if (process.env.VERCEL_ENV !== "preview") return null;
  if (process.env.ALHC_PREVIEW_AUTOLOGIN !== "1") return null;`),
  );
  assert.ok(proxy.includes(`if (auto && !signedIn && !request.nextUrl.pathname.startsWith("/api/")) {`));
});
