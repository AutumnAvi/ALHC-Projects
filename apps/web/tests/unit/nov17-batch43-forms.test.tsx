import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { ConfirmProvider } from "@/components/confirm";
import { FormEditor } from "@/components/forms/form-editor";
import { moveOptionBefore, pastedAnswers } from "@/components/forms/form-options";
import { ToastProvider } from "@/components/toast";
import { EMBED_HEIGHT_MESSAGE, EMBED_MAX_HEIGHT, EMBED_MIN_HEIGHT, clampEmbedHeight, formEmbedSnippet } from "@/lib/form-embed";
import type { FormDef, FormQuestion } from "@alhc/core/forms";

// Batch 43 (Nov 17): the form builder's paths and polish, as the editor draws them.

const questions: FormQuestion[] = [
  { id: "requester_name", type: "short_text", role: "name", label: "Your name", required: true },
  {
    id: "kind",
    type: "single_select",
    label: "What do you need?",
    options: [
      { id: "print", label: "Print" },
      { id: "web", label: "Web" },
      { id: "video", label: "Video" },
    ],
    paths: [
      { id: "p-print", option_ids: ["print"] },
      { id: "p-web", name: "Websites", option_ids: ["web"] },
      { id: "p-other", otherwise: true },
    ],
  },
  { id: "size", type: "short_text", label: "Print size", show_if: { question_id: "kind", option_ids: ["print"], path_id: "p-print" } },
  { id: "url", type: "short_text", label: "Page URL", show_if: { question_id: "kind", option_ids: ["web"], path_id: "p-web" } },
  { id: "when", type: "date", label: "When?" },
];

function form(over: Partial<FormDef> = {}): FormDef {
  return {
    id: "f1",
    projectId: "p1",
    title: "Requests",
    description: null,
    questions,
    destinationSectionId: null,
    acceptingResponses: true,
    sendConfirmation: false,
    confirmationMessage: null,
    updatedAt: "2026-11-17T10:00:00+00:00",
    ...over,
  };
}

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };

const render = (def: FormDef, canEdit = true) =>
  renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <ConfirmProvider>
        <ToastProvider>
          <FormEditor form={def} sections={[]} fields={[]} origin="https://app.example" batch4 real1 canEdit={canEdit} closeHref="/projects/p1/forms" />
        </ToastProvider>
      </ConfirmProvider>
    </AppRouterContext.Provider>,
  );

test("paths draw as blocks under their question, in path order, then where they meet", () => {
  const html = render(form());
  const blocks = [...html.matchAll(/data-path="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(blocks, ["p-print", "p-web", "p-other"]);
  assert.match(html, />Websites</, "a named path shows its name");
  assert.match(html, /answer is Print/);
  assert.match(html, /any other answer: Video/);
  assert.match(html, /Paths meet here/);
  assert.equal((html.match(/aria-label="Add (the first )?question to this path"/g) ?? []).length, 3);
  assert.ok(html.indexOf('data-question-card="size"') < html.indexOf('data-path="p-web"'), "Print's question inside Print's block");
  assert.ok(html.indexOf("Paths meet here") < html.indexOf('data-question-card="when"'), "the main flow continues after the paths");
  // The preview tags path questions with their path.
  assert.match(html, /data-preview-question="url"[^>]*border-l-4/);
});

test("a path with no answers is an error on its block, never dropped", () => {
  const broken = questions.map((q) => (q.id === "kind" ? { ...q, options: q.options!.filter((o) => o.id !== "web") } : q));
  const html = render(form({ questions: broken }));
  assert.match(html, /data-path-problem=""[^>]*>[\s\S]*has no answers/);
  assert.match(html, /1 thing to fix/);
});

test("Save never sends Live / Off, and both writes carry the version they expect", () => {
  const source = fs.readFileSync("src/components/forms/form-editor.tsx", "utf8");
  const save = source.slice(source.indexOf("function save("), source.indexOf("// The header's Live / Off switch"));
  assert.ok(!/acceptingResponses/.test(save), "Save leaves Live / Off alone");
  assert.match(save, /expectedUpdatedAt: versionRef\.current/);
  assert.match(source, /setFormLive\(form\.id, next, versionRef\.current\)/);
  assert.match(source, /Save your changes and go live\?/);
  assert.match(source, /View saved form/);
});

test("the read-only editor draws the paths in the preview but no editing side", () => {
  const html = render(form(), false);
  assert.ok(!/Add question to this path/.test(html));
  assert.match(html, /data-preview-question="size"/);
});

test("the embed snippet sizes its own frame: this app's origin, its own frame, a clamped height", () => {
  const snippet = formEmbedSnippet("https://app.example", "f1", 'Design <requests> & "more"');
  assert.match(snippet, /^<iframe data-alhc-form="f1" src="https:\/\/app\.example\/forms\/f1\/embed" title="Design &lt;requests&gt; &amp; &quot;more&quot;" width="100%" height="900"/);
  assert.match(snippet, /e\.origin!=="https:\/\/app\.example"/);
  assert.match(snippet, /fs\[i\]\.contentWindow===e\.source/, "only the frame that sent it");
  assert.match(snippet, /querySelectorAll\("iframe\[data-alhc-form=\\"f1\\"\]"\)/, "every frame of this form (it can be embedded twice)");
  assert.match(snippet, new RegExp(`d\\.type!=="${EMBED_HEIGHT_MESSAGE}"`));
  assert.match(snippet, /d\.formId!=="f1"/);
  assert.match(snippet, new RegExp(`Math\\.min\\(Math\\.max\\(h,${EMBED_MIN_HEIGHT}\\),${EMBED_MAX_HEIGHT}\\)`));
  assert.equal((snippet.match(/<\/script>/g) ?? []).length, 1, "nothing in the values closes the script early");
  assert.equal(clampEmbedHeight(50), EMBED_MIN_HEIGHT);
  assert.equal(clampEmbedHeight(1e9), EMBED_MAX_HEIGHT);
  assert.equal(clampEmbedHeight("nope"), null);
  assert.equal(clampEmbedHeight(640.4), 640);
});

test("the embed page reports its height; old snippets are just the iframe", () => {
  const page = fs.readFileSync("src/components/forms/public-form-page.tsx", "utf8");
  assert.match(page, /<EmbedHeightReporter formId=\{form\.id\}>/);
  const reporter = fs.readFileSync("src/components/forms/embed-height.tsx", "utf8");
  assert.match(reporter, /new ResizeObserver/);
  assert.match(reporter, /window\.parent\.postMessage\(message, "\*"\)/);
});

test("answers: paste a list (one per line), reorder", () => {
  assert.deepEqual(pastedAnswers("- Print\n  * Web\n\n1. Video\r\nOther  "), ["Print", "Web", "Video", "Other"]);
  const options = [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
    { id: "c", label: "C" },
  ];
  assert.deepEqual(moveOptionBefore(options, "c", "a").map((o) => o.id), ["c", "a", "b"]);
  assert.deepEqual(moveOptionBefore(options, "a", null).map((o) => o.id), ["b", "c", "a"]);
  assert.equal(moveOptionBefore(options, "a", "b"), options, "already there");
});

test("the forms list offers Duplicate to people who build forms", () => {
  const list = fs.readFileSync("src/components/forms/forms-list.tsx", "utf8");
  assert.match(list, /canEdit \? \(\s*<button[\s\S]*duplicateForm\(form\.id, projectId\)/);
});
