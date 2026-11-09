// AI builder round 2 (experimental, feat/ai-builder-p2): the preview draws a draft with the app's real List
// and Board over an in-memory data source (note 168); the edit / automation calls use Haiku with a smaller,
// faster budget (note 169); the AI routes keep phase 1's guards; the preview auto-login is unchanged.
// Synthetic fixtures, a fake Anthropic client: no network, no database writes, nothing billable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { AI_BUILDER_CALLS, AI_MODEL_EFFORTS, PROPOSAL_JSON_SCHEMA, structuredOutputIssues, type AiProposal } from "@alhc/core/ai-builder";
import { EDIT_OPS_JSON_SCHEMA } from "@alhc/core/ai-builder-ops";
import { RULE_DRAFT_JSON_SCHEMA } from "@alhc/core/ai-automation";
import { counterIds, draftToProposal, draftView, proposalToDraft, type AiDraft } from "@alhc/core/ai-builder-draft";
import { fieldRef } from "@alhc/core/views";
import { DraftPreview } from "@/components/ai-builder/draft-preview";
import { DRAFT_COMPLETE_NOTE, useDraftSource } from "@/components/ai-builder/draft-data-source";
import { BoardView } from "@/components/project/board-view";
import { ProjectAccessProvider } from "@/components/project/project-access";
import { ProjectDataSourceProvider, type ProjectDataSource } from "@/components/project/project-data-source";
import { ShellProvider } from "@/components/shell/shell-context";
import { ToastProvider } from "@/components/toast";
import { DEFAULT_SIDEBAR_PREFS } from "@/lib/sidebar-prefs";
import { anthropicMessageCreate, callConfig, createAnthropicProvider } from "@/lib/ai-builder/anthropic";
import { POST as editPost } from "@/app/api/ai-builder/edit/route";
import { POST as automationPost } from "@/app/api/ai-builder/automation/route";

const ME = "55555555-5555-4555-8555-555555555555";
const TODAY = "2026-11-08";
const proposal: AiProposal = {
  name: "Open house",
  description: "",
  sections: [{ name: "Plan" }, { name: "Do" }],
  fields: [{ name: "Priority", type: "single_select", options: ["High", "Low"] }],
  tasks: [
    {
      title: "Book venue",
      section: "Plan",
      notes: "",
      due_in_days: 7,
      start_in_days: 2,
      assignee: { member: ME },
      values: [{ field: "Priority", value: "High" }],
      subtasks: ["Get quotes"],
    },
    { title: "Design flyer", section: "Do", notes: "", due_in_days: null, start_in_days: null, assignee: { placeholder: "Designer" }, values: [], subtasks: [] },
  ],
};
const members = [{ id: ME, name: "Me (you)", email: "me@example.com" }];

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
function render(node: ReactNode) {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value="/projects/new">
        <SearchParamsContext.Provider value={new URLSearchParams() as never}>
          <ShellProvider member={{ id: ME, email: "me@example.com", name: "Me", avatarUrl: null } as never} isWorkspaceAdmin workspace={{ name: "Testing data", logoUrl: null }} initialSidebar={DEFAULT_SIDEBAR_PREFS}>
            <ToastProvider>{node}</ToastProvider>
          </ShellProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

// ---- The preview: the real List and Board ---------------------------------------------------------------

test("the draft renders in the app's real List view: sections, tasks, people, placeholders, dates, values, subtasks", () => {
  const draft = proposalToDraft(proposal, counterIds());
  const html = render(<DraftPreview draftKey="run-1" draft={draft} setDraft={() => undefined} today={TODAY} members={members} />);
  for (const text of ["Plan", "Do", "Book venue", "Design flyer", "Priority", "High", "Get quotes"]) assert.ok(html.includes(text), text);
  assert.match(html, /data-list-header/, "the List's own header row");
  assert.ok(html.includes("Assignee") && html.includes("Due date") && html.includes("Start"), "the List's columns");
  assert.ok(html.includes('aria-label="Preview layout"'), "a List / Board toggle");
  assert.ok(!html.includes("/api/task-pane"), "nothing points at the task pane's data");
});

test("the draft renders in the app's real Board view", () => {
  const draft = proposalToDraft(proposal, counterIds());
  const view = draftView(draft, { key: "run-1", today: TODAY, members });
  const source = { draft: { openTask() {}, changeDates: async () => ({}), moveSection: async () => ({}), addField() {}, editField() {} } } as unknown as ProjectDataSource;
  const html = render(
    <ProjectAccessProvider role="editor">
      <ProjectDataSourceProvider value={source}>
        <BoardView
          projectId={view.projectId}
          sections={view.sections}
          tasks={view.tasks}
          profiles={view.profiles}
          fields={view.fields}
          config={{ columns: ["assignee", "due", fieldRef(view.fields[0].id)] }}
          tags={[]}
          sectionTaskCounts={view.sectionTaskCounts}
        />
      </ProjectDataSourceProvider>
    </ProjectAccessProvider>,
  );
  for (const text of ["Plan", "Do", "Book venue", "Design flyer", "High"]) assert.ok(html.includes(text), text);
});

// ---- The in-memory data source --------------------------------------------------------------------------

function captureSource(draft: AiDraft, setDraft: (d: AiDraft) => void) {
  let source: ProjectDataSource | null = null;
  function Probe() {
    source = useDraftSource({ draft, setDraft, today: TODAY, hooks: { openTask() {}, addField() {}, editField() {} }, newId: () => crypto.randomUUID() });
    return null;
  }
  render(<Probe />);
  return source as unknown as ProjectDataSource;
}

test("the views' writes change only the draft, are checked by its rules, and never reach the server", async () => {
  const originalFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched += 1;
    throw new Error("no network in a draft");
  }) as typeof fetch;
  try {
    let current = proposalToDraft(proposal, counterIds());
    const source = captureSource(current, (d) => (current = d));
    const venue = current.tasks[0];
    assert.deepEqual(await source.updateTask(venue.id, { title: "Book the venue" }), {});
    assert.equal(current.tasks[0].title, "Book the venue");
    assert.ok((await source.updateTask(venue.id, { dueOn: "2026-11-01" })).error, "a due date before today is refused");
    assert.ok((await source.updateTask(venue.id, { startOn: "2026-12-31" })).error, "a start after the due date is refused");
    assert.deepEqual(await source.updateTask(venue.id, { assigneeId: "placeholder:designer" }), {});
    assert.deepEqual(current.tasks[0].assignee, { placeholder: "Designer" });
    const made = await source.createTask("ai-draft:x", current.sections[1].id, "Print signs");
    assert.ok("taskId" in made && made.taskId);
    assert.equal(current.tasks.filter((t) => t.sectionId === current.sections[1].id).length, 2);
    assert.deepEqual(await source.setFieldValue(venue.id, current.fields[0].id, current.fields[0].options[1].id), {});
    assert.ok((await source.setFieldValue(venue.id, current.fields[0].id, "nope")).error);
    assert.deepEqual(await source.setTaskCompleted(venue.id, true), { error: DRAFT_COMPLETE_NOTE });
    const section = await source.createSection("ai-draft:x", "Review", current.sections[1].id);
    assert.ok(!section.error && "id" in section);
    assert.deepEqual(current.sections.map((s) => s.name), ["Plan", "Review", "Do"]);
    assert.ok((await source.deleteSection(current.sections[0].id)).error, "a section with tasks stays");
    assert.ok((await source.moveTaskTag(venue.id, null, "t")).error);
    assert.deepEqual(await source.saveListColumnWidths("ai-draft:x", {}), {});
    const after = draftToProposal(current);
    assert.equal(after.tasks.length, 3);
    assert.equal(fetched, 0, "no request until Create");
  } finally {
    globalThis.fetch = originalFetch;
  }
  // The draft's source imports no Server Action: nothing it does can write.
  const src = fs.readFileSync(path.resolve(import.meta.dirname, "../../src/components/ai-builder/draft-data-source.ts"), "utf8");
  assert.ok(!src.includes("@/lib/actions"), "no Server Action in the draft's data source");
});

test("normal projects keep their Server Actions: the default data source is exactly them", async () => {
  const mod = await import("@/components/project/project-data-source");
  const tasks = await import("@/lib/actions/tasks");
  let seen: ProjectDataSource | null = null;
  function Probe() {
    seen = mod.useProjectData();
    return null;
  }
  render(<Probe />);
  const source = seen as unknown as ProjectDataSource;
  assert.equal(source.draft, null);
  assert.equal(source.updateTask, tasks.updateTask);
  assert.equal(source.placeTask, tasks.placeTask);
  assert.equal(source.setTaskCompleted, tasks.setTaskCompleted);
});

// ---- Models (note 169) ----------------------------------------------------------------------------------

type Create = (params: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>;
const client = (create: Create) => ({ messages: { create } }) as unknown as Pick<Anthropic, "messages">;
const reply = (model: string) => ({ model, stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: "{}" }] });

test("edits and automation drafts call Haiku with a smaller output, low effort, and a tighter timeout; the model and effort come back for the log", async () => {
  for (const kind of ["edit", "automation"] as const) {
    let params: Record<string, unknown> = {};
    let options: Record<string, unknown> = {};
    const p = createAnthropicProvider(
      client(async (pa, op) => {
        params = pa;
        options = op ?? {};
        return reply("claude-haiku-5-5");
      }),
      {},
    );
    const res = await p.generate({ kind, system: "s", prompt: "p", schema: { type: "object" } });
    assert.equal(params.model, "claude-haiku-5-5");
    assert.equal(params.max_tokens, AI_BUILDER_CALLS[kind].maxTokens);
    assert.equal((params.output_config as { effort: string }).effort, "low");
    assert.equal(options.timeout, AI_BUILDER_CALLS[kind].timeoutMs);
    assert.ok(res.ok && res.model === "claude-haiku-5-5" && res.effort === "low");
  }
  // Server-side overrides only within the allowlist.
  assert.equal(callConfig("edit", { AI_BUILDER_EDIT_MODEL: "claude-sonnet-5-5" }).model, "claude-sonnet-5-5");
  assert.equal(callConfig("edit", { AI_BUILDER_EDIT_MODEL: "some-other-model" }).model, "claude-haiku-5-5");
  assert.equal(callConfig("build", { AI_BUILDER_BUILD_EFFORT: "max" }).effort, "low");
  assert.equal(callConfig("build", {}).model, "claude-sonnet-5-5");
});

test("each call's request matches that model's params, and its schema is one structured output will compile", () => {
  const schemas = { build: PROPOSAL_JSON_SCHEMA, edit: EDIT_OPS_JSON_SCHEMA, automation: RULE_DRAFT_JSON_SCHEMA };
  for (const kind of ["build", "edit", "automation"] as const) {
    const { params } = anthropicMessageCreate(kind, { system: "s", prompt: "p", schema: schemas[kind] });
    assert.equal(params.model, AI_BUILDER_CALLS[kind].model);
    assert.equal(params.max_tokens, AI_BUILDER_CALLS[kind].maxTokens);
    assert.ok(AI_MODEL_EFFORTS[params.model].includes(params.output_config.effort), params.output_config.effort);
    assert.equal(params.output_config.format.type, "json_schema");
    assert.equal(structuredOutputIssues(params.output_config.format.schema).join("\n"), "");
    assert.ok(!("thinking" in params), "thinking stays adaptive; disabling it is not valid for every effort");
    assert.ok(!("tools" in params));
  }
  const require = createRequire(import.meta.url);
  const dts = fs.readFileSync(path.join(path.dirname(require.resolve("@anthropic-ai/sdk")), "resources/messages/messages.d.ts"), "utf8");
  const union = dts.slice(dts.indexOf("export type Model ="), dts.indexOf(";", dts.indexOf("export type Model =")));
  const literals = [...union.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  for (const model of [AI_BUILDER_CALLS.build.model, AI_BUILDER_CALLS.edit.model, AI_BUILDER_CALLS.automation.model]) {
    assert.ok(literals.includes(model), `${model} is not a literal in @anthropic-ai/sdk's Model union`);
  }
});

test("a 429 on an edit is a rate-limited code, never the provider's message", async () => {
  const res = await createAnthropicProvider(
    client(async () => {
      throw new Anthropic.RateLimitError(429, {}, "rate limited sk-ant-secret", new Headers());
    }),
    {},
  ).generate({ kind: "edit", system: "s", prompt: "p", schema: {} });
  assert.ok(!res.ok && res.code === "rate_limited" && res.model === "claude-haiku-5-5");
  assert.ok(!JSON.stringify(res).includes("sk-ant"));
});

// ---- Routes and the preview auto-login ------------------------------------------------------------------

test("the AI change and automation routes refuse cross-site, non-JSON, and oversized requests before anything else", async () => {
  for (const [post, url, size] of [
    [editPost, "https://app.example/api/ai-builder/edit", 200_001],
    [automationPost, "https://app.example/api/ai-builder/automation", 8_001],
  ] as const) {
    const body = JSON.stringify({ requestKey: "req-key-0001" });
    assert.equal((await post(new NextRequest(url, { method: "POST", body, headers: { origin: "https://evil.example", "content-type": "application/json" } }))).status, 403);
    assert.equal((await post(new NextRequest(url, { method: "POST", body, headers: { "content-type": "application/json" } }))).status, 403);
    assert.equal((await post(new NextRequest(url, { method: "POST", body, headers: { origin: "https://app.example", "content-type": "text/plain" } }))).status, 415);
    assert.equal(
      (await post(new NextRequest(url, { method: "POST", body: "x".repeat(size), headers: { origin: "https://app.example", "content-type": "application/json" } }))).status,
      413,
    );
  }
});

test("the preview auto-login is unchanged: Vercel Preview AND ALHC_PREVIEW_AUTOLOGIN=1, never on API routes", () => {
  const proxy = fs.readFileSync(path.resolve(import.meta.dirname, "../../src/lib/supabase/proxy.ts"), "utf8");
  assert.ok(
    proxy.includes(`function previewAutoLogin(): { email: string; password: string } | null {
  if (process.env.VERCEL_ENV !== "preview") return null;
  if (process.env.ALHC_PREVIEW_AUTOLOGIN !== "1") return null;
  const email = process.env.ALHC_PREVIEW_AUTOLOGIN_EMAIL;
  const password = process.env.ALHC_PREVIEW_AUTOLOGIN_PASSWORD;
  if (!email || !password) return null;
  return { email, password };
}`),
    "the gate is exactly phase 1's",
  );
  assert.ok(proxy.includes(`if (auto && !signedIn && !request.nextUrl.pathname.startsWith("/api/")) {`), "never on API routes");
});
