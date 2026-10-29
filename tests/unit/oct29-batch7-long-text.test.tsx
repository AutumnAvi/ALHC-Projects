// Oct 29 notes, batch 7, item 48 (the app's side; suite zz36's T2 part pins the database's 10,000-
// character limit): editing a text custom field opens a pop-out editor — a large box with a character
// count, Save / Cancel, ⌘/Ctrl+Enter saves, Escape cancels (asking first when something was typed) — from
// the List cell and the task pane's field row. Long values read as one line in List (a few lines in the
// pane) with the whole text on hover when cut off, and on click (read-only for people who can't edit).
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LongTextEditorView } from "@/components/long-text-editor";
import { FieldValueChips } from "@/components/project/field-chips";
import { InlineFieldCell } from "@/components/project/inline-cells";
import { PaneTextValue } from "@/components/task/task-fields";
import { isCutOff } from "@/components/tooltip-layer";
import { FOCUSABLE_SELECTOR, trappedTabTarget } from "@/lib/focus-trap";
import type { ProjectTask } from "@/lib/data";
import type { FieldDef } from "@/lib/fields";
import {
  MAX_TEXT_FIELD_LENGTH,
  TEXT_LABEL_LENGTH,
  TEXT_TOOLTIP_LENGTH,
  LONG_TEXT_SAVE_FAILED,
  initialDraft,
  isSaveShortcut,
  lengthCounter,
  longTextDraft,
  saveLongText,
  normalizeLineBreaks,
  textLabel,
  textLength,
  textPreview,
  textValueLabel,
} from "@/lib/long-text";

const render = (node: ReactNode) => renderToStaticMarkup(<>{node}</>);
// Text without tags or React's comment markers.
const textOf = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "");
const unescape = (html: string) =>
  html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function buttonTag(html: string, label: string) {
  const end = html.indexOf(`>${label}</button>`);
  assert.ok(end > 0, `a “${label}” button`);
  return html.slice(html.lastIndexOf("<button", end), end + 1);
}
const isDisabled = (tag: string) => / disabled=""/.test(tag);

function field(overrides: Partial<FieldDef> = {}): FieldDef {
  return {
    id: "f1",
    projectId: "p1",
    name: "Brief",
    fieldType: "text",
    options: [],
    boundToSections: false,
    showInViews: true,
    sortOrder: 1024,
    description: null,
    notifyOnChange: false,
    inLibrary: false,
    ...overrides,
  };
}

const EMOJI = "\u{1F600}";

test("the limit mirrors validate_task_field_value() (10,000 characters, counted as code points)", () => {
  assert.equal(MAX_TEXT_FIELD_LENGTH, 10000);
  assert.equal(textLength("Hello"), 5);
  assert.equal(textLength(EMOJI.repeat(3)), 3, "an emoji is one character, as Postgres counts it");
  assert.equal(textLength("é\n"), 2);
  // Every migration that writes the text rule uses the same number.
  const dir = "supabase/migrations";
  const limits = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .flatMap((name) =>
      [...readFileSync(`${dir}/${name}`, "utf8").matchAll(/when 'text' then jsonb_typeof\(new\.value\) = 'string' and length\(new\.value #>> '\{\}'\) <= (\d+)/g)].map(
        (m) => Number(m[1]),
      ),
    );
  assert.ok(limits.length > 0, "the rule is in the migrations");
  for (const limit of limits) assert.equal(limit, MAX_TEXT_FIELD_LENGTH);
});

test("the draft: trimmed on save, empty clears, dirty vs changed, over the limit can't save", () => {
  const same = longTextDraft("Kickoff notes", "Kickoff notes");
  assert.deepEqual(same, { count: 13, over: 0, dirty: false, next: "Kickoff notes", changed: false, canSave: true });

  const typed = longTextDraft("Kickoff notes\nand more  ", "Kickoff notes");
  assert.equal(typed.dirty, true);
  assert.equal(typed.changed, true);
  assert.equal(typed.next, "Kickoff notes\nand more", "only the ends are trimmed; line breaks stay");
  assert.equal(typed.count, textLength("Kickoff notes\nand more"));

  // Only spaces added at the end: something was typed, but the saved value wouldn't change.
  const spaces = longTextDraft("Kickoff notes   ", "Kickoff notes");
  assert.equal(spaces.dirty, true);
  assert.equal(spaces.changed, false);

  const cleared = longTextDraft("   ", "Kickoff notes");
  assert.equal(cleared.next, null, "an emptied box clears the field");
  assert.equal(cleared.changed, true);
  assert.equal(longTextDraft("", null).changed, false, "empty stays empty");
  assert.equal(longTextDraft("", "").changed, false);
  assert.equal(longTextDraft("Hi", 42).changed, true, "a non-text value is replaced");

  const atLimit = longTextDraft("a".repeat(MAX_TEXT_FIELD_LENGTH), null);
  assert.equal(atLimit.over, 0);
  assert.equal(atLimit.canSave, true);
  const over = longTextDraft("a".repeat(MAX_TEXT_FIELD_LENGTH + 3), null);
  assert.equal(over.over, 3);
  assert.equal(over.canSave, false);
  const emoji = longTextDraft(EMOJI.repeat(MAX_TEXT_FIELD_LENGTH), null);
  assert.equal(emoji.over, 0, "10,000 emoji fit (20,000 UTF-16 units)");
  assert.equal(longTextDraft(` ${"a".repeat(MAX_TEXT_FIELD_LENGTH)}\n`, null).canSave, true, "the ends don't count");
});

test("stored line breaks: \\r\\n reads as \\n, so an untouched value isn't 'changed'", () => {
  assert.equal(normalizeLineBreaks("a\r\nb\rc\n"), "a\nb\nc\n");
  assert.equal(initialDraft("one\r\ntwo"), "one\ntwo");
  assert.equal(initialDraft(null), "");
  assert.equal(initialDraft(12), "");
  assert.equal(longTextDraft(initialDraft("one\r\ntwo"), "one\r\ntwo").dirty, false);
});

test("counter, previews, labels, and the save shortcut", () => {
  assert.equal(lengthCounter(0), "0 / 10,000");
  assert.equal(lengthCounter(1234), "1,234 / 10,000");
  assert.equal(textPreview("short", 10), "short");
  assert.equal(textPreview("abcdefghij", 10), "abcdefghij");
  assert.equal(textPreview("abcde fghijk", 6), "abcde…", "cut, trailing space dropped");
  assert.equal(textPreview(EMOJI.repeat(5), 2), `${EMOJI}${EMOJI}…`, "never half an emoji");
  assert.equal(TEXT_TOOLTIP_LENGTH, 500);
  assert.equal(textLabel("Line one\n\nLine two"), "Line one Line two", "labels are one line");
  const long = textLabel("word ".repeat(100));
  assert.ok(long.endsWith("…"));
  assert.ok(textLength(long) <= TEXT_LABEL_LENGTH + 1);

  const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...mods,
  });
  assert.equal(isSaveShortcut(key("Enter", { metaKey: true })), true, "⌘+Enter");
  assert.equal(isSaveShortcut(key("Enter", { ctrlKey: true })), true, "Ctrl+Enter");
  assert.equal(isSaveShortcut(key("Enter")), false, "Enter is a new line");
  assert.equal(isSaveShortcut(key("Enter", { ctrlKey: true, altKey: true })), false);
  assert.equal(isSaveShortcut(key("s", { metaKey: true })), false);

  assert.equal(textValueLabel("Brief", "Kickoff", "Change"), "Brief: Kickoff. Change");
  assert.equal(textValueLabel("Brief", "Kickoff on Monday.", "Change"), "Brief: Kickoff on Monday. Change", "no double period");
  assert.equal(textValueLabel("Brief", "Ready?", "Edit"), "Brief: Ready? Edit");
  assert.equal(textValueLabel("Brief", "", "Edit"), "Brief: empty. Edit");
  assert.equal(textValueLabel("Brief", null, "Edit"), "Brief: empty. Edit");
});

const noop = () => {};
function editorView(draft: string, saved: unknown, readOnly = false) {
  return render(
    <LongTextEditorView
      fieldName="Brief"
      taskTitle="Spring flyer"
      readOnly={readOnly}
      draft={draft}
      state={longTextDraft(draft, saved)}
      onDraftChange={noop}
      onSave={noop}
      onCancel={noop}
      onDismiss={noop}
      onCloseButton={noop}
    />,
  );
}

test("the editor: a modal over everything with the field and task, a large box, count, Save / Cancel", () => {
  const html = editorView("Print run of 500", "Print run of 500");
  assert.match(html, /data-long-text-editor=""/);
  assert.match(html, /z-\[70\]/, "above the full-screen pane (z-50) and popovers (z-60)");
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="([^"]+)"/);
  const titleId = /aria-labelledby="([^"]+)"/.exec(html)![1];
  assert.match(html, new RegExp(`<h2 id="${titleId}"[^>]*>Brief</h2>`));
  assert.ok(textOf(html).includes("“Spring flyer”"));
  const textarea = /<textarea[^>]*>/.exec(html)![0];
  assert.match(textarea, new RegExp(`aria-labelledby="${titleId}"`), "the box is named by the field");
  assert.match(textarea, /field-sizing-content/, "it grows with the text");
  assert.match(textarea, /max-h-\[60vh\]/, "then scrolls");
  assert.doesNotMatch(textarea, /maxLength|maxlength/, "no silent cut on paste: the count says what's over");
  assert.ok(html.includes(">Print run of 500</textarea>"));
  assert.ok(textOf(html).includes("16 / 10,000 characters"));
  assert.ok(textOf(html).includes("⌘/Ctrl+Enter to save"));
  assert.equal(isDisabled(buttonTag(html, "Save")), false);
  assert.equal(isDisabled(buttonTag(html, "Cancel")), false);
  assert.match(html, /aria-label="Close" data-tooltip="Close"/);
  assert.doesNotMatch(html, /aria-invalid/);
});

test("the editor over the limit: Save is off and it says by how much", () => {
  const html = editorView("a".repeat(MAX_TEXT_FIELD_LENGTH + 25), null);
  assert.equal(isDisabled(buttonTag(html, "Save")), true);
  assert.ok(textOf(html).includes("10,025 / 10,000 characters"));
  assert.ok(textOf(html).includes("Shorten it by 25 characters to save."));
  assert.match(/<textarea[^>]*>/.exec(html)![0], /aria-invalid="true"/);
  assert.match(html, /data-over=""/);
  const one = editorView("a".repeat(MAX_TEXT_FIELD_LENGTH + 1), null);
  assert.ok(textOf(one).includes("Shorten it by 1 character to save."));
});

test("read-only: the whole text to read (line breaks kept), a Close button, nothing to edit", () => {
  const text = "Line one\nLine two\n\nLine four";
  const html = editorView(text, text, true);
  assert.doesNotMatch(html, /<textarea/);
  assert.match(html, /role="region" aria-label="Brief text" tabindex="0"/);
  assert.match(html, /whitespace-pre-wrap/);
  assert.ok(html.includes(text), "the whole value");
  assert.ok(textOf(html).includes("View only · “Spring flyer”"));
  assert.ok(textOf(html).includes("28 characters"));
  buttonTag(html, "Close");
  assert.ok(!html.includes(">Save</button>"));
  assert.ok(!html.includes(">Cancel</button>"));
});

const cell = (value: unknown, canEdit: boolean, display: ReactNode = "shown") =>
  render(
    <InlineFieldCell
      field={field()}
      value={value as never}
      sectionId={null}
      sections={[]}
      people={[]}
      taskTitle="Launch"
      canEdit={canEdit}
      display={display}
      onChange={noop}
      onSectionChange={noop}
    />,
  );

test("List cell: a click opens the editor (Editors) or the whole text (everyone else)", () => {
  const long = `Kickoff on Monday.\n${"Details ".repeat(40)}`;
  const editor = cell(long, true);
  const tag = /<button[^>]*>/.exec(editor)![0];
  assert.match(tag, /aria-haspopup="dialog"/);
  assert.match(tag, /aria-expanded="false"/);
  const label = unescape(/aria-label="([^"]*)"/.exec(tag)![1]);
  assert.ok(label.startsWith("Brief of “Launch”: Kickoff on Monday. Details Details"), label);
  assert.ok(label.endsWith("… Change"), "a long value is cut in the label");
  assert.doesNotMatch(editor, /<input/, "no one-line box any more");
  assert.doesNotMatch(editor, /data-long-text-editor/, "closed until clicked");

  const empty = cell(null, true);
  assert.match(empty, /aria-label="Brief of “Launch”: empty\. Change"/);

  const reader = cell("Kickoff on Monday.", false);
  assert.match(reader, /aria-label="Brief of “Launch”: Kickoff on Monday\. Show full text"/);
  assert.equal(cell(null, false), "shown", "below Editor an empty value stays plain");
  assert.equal(cell("", false), "shown");
});

test("List cell: number fields keep their own box (item 49)", () => {
  const html = render(
    <InlineFieldCell
      field={field({ name: "Budget", fieldType: "number", numberPrefix: "$" })}
      value={1250}
      sectionId={null}
      sections={[]}
      people={[]}
      taskTitle="Launch"
      canEdit
      display="$1,250"
      onChange={noop}
      onSectionChange={noop}
    />,
  );
  assert.match(html, /aria-label="Budget of “Launch”: \$1,250\. Change"/);
  assert.doesNotMatch(html, /aria-haspopup/);
});

test("values on one line show the whole value on hover only when cut off (FieldValueChips: List, Board)", () => {
  const text = "x".repeat(TEXT_TOOLTIP_LENGTH + 50);
  const task = { fieldValues: { f1: text }, sectionId: null } as unknown as ProjectTask;
  const context = { profilesById: new Map(), sectionNames: new Map() };
  const html = render(<FieldValueChips field={field()} task={task} context={context} showName />);
  assert.match(html, /class="min-w-0 truncate/);
  assert.match(html, /data-tooltip-truncated=""/);
  const tip = /data-tooltip="([^"]*)"/.exec(html)![1];
  assert.equal(tip, `${"x".repeat(TEXT_TOOLTIP_LENGTH)}…`, "a very long value's tooltip is cut; the editor has it all");
  const short = render(
    <FieldValueChips field={field()} task={{ fieldValues: { f1: "Two\nlines" } } as unknown as ProjectTask} context={context} />,
  );
  assert.match(short, /data-tooltip="Two\nlines"/, "line breaks reach the tooltip (it keeps them)");
  const choice = render(
    <FieldValueChips
      field={field({ fieldType: "single_select", options: [{ id: "o1", name: "High", color: "red" }] })}
      task={{ fieldValues: { f1: "o1" } } as unknown as ProjectTask}
      context={context}
    />,
  );
  assert.doesNotMatch(choice, /data-tooltip/, "pills are untouched");
});

test("the tooltip layer's cut-off check", () => {
  assert.equal(isCutOff({ scrollWidth: 300, clientWidth: 120, scrollHeight: 16, clientHeight: 16 }), true, "truncate");
  assert.equal(isCutOff({ scrollWidth: 120, clientWidth: 120, scrollHeight: 80, clientHeight: 60 }), true, "line-clamp");
  assert.equal(isCutOff({ scrollWidth: 121, clientWidth: 120, scrollHeight: 16, clientHeight: 16 }), false, "rounding");
  assert.equal(isCutOff({ scrollWidth: 80, clientWidth: 120, scrollHeight: 16, clientHeight: 16 }), false, "fits");
});

test("pane row: a few lines with the full text on hover; a click opens the editor or the reader", () => {
  const text = "Line one\nLine two\nLine three\nLine four";
  const editor = render(
    <PaneTextValue id="field-f1" fieldName="Brief" taskTitle="Launch" value={text} canEdit onSave={noop} />,
  );
  const tag = /<button[^>]*>/.exec(editor)![0];
  assert.match(tag, /id="field-f1"/);
  assert.match(tag, /aria-haspopup="dialog"/);
  assert.match(tag, /aria-label="Brief: Line one Line two Line three Line four\. Edit"/);
  assert.match(editor, /class="line-clamp-3 [^"]*whitespace-pre-wrap/);
  assert.match(editor, /data-tooltip-truncated=""/);
  assert.ok(editor.includes(`data-tooltip="${text}"`));

  const empty = render(<PaneTextValue fieldName="Brief" taskTitle="Launch" value={null} canEdit onSave={noop} />);
  assert.ok(textOf(empty).includes("Add text"));
  assert.match(empty, /aria-label="Brief: empty\. Edit"/);

  const reader = render(<PaneTextValue fieldName="Brief" taskTitle="Launch" value={text} canEdit={false} onSave={noop} />);
  assert.match(reader, /aria-label="Brief: Line one Line two Line three Line four\. Show full text"/);
  assert.match(reader, /line-clamp-3/);

  const none = render(<PaneTextValue fieldName="Brief" taskTitle="Launch" value={null} canEdit={false} onSave={noop} />);
  assert.doesNotMatch(none, /<button/);
  assert.equal(textOf(none), "—");
});

// Review fixes: a refused or failed save keeps what was typed; Tab stays inside the window.
test("Save waits for the server: closes once stored, keeps the draft (with the reason) when refused or failed", async () => {
  const saved: (string | null)[] = [];
  const typed = longTextDraft("A brief of many lines", "Old brief");
  assert.deepEqual(
    await saveLongText(typed, async (next) => {
      saved.push(next);
      return {};
    }),
    { close: true },
    "stored: the window closes",
  );
  assert.deepEqual(saved, ["A brief of many lines"]);

  const locked = "Locked — only project Owners and Admins can change this field";
  assert.deepEqual(await saveLongText(typed, async () => ({ error: locked })), { close: false, error: locked }, "refused: stays open");
  assert.deepEqual(
    await saveLongText(typed, async () => {
      throw new Error("Failed to fetch");
    }),
    { close: false, error: LONG_TEXT_SAVE_FAILED },
    "a dropped connection: stays open",
  );
  assert.deepEqual(await saveLongText(typed, () => undefined), { close: true }, "a plain callback");

  let called = false;
  const untouched = longTextDraft("Same", "Same");
  assert.deepEqual(
    await saveLongText(untouched, async () => {
      called = true;
    }),
    { close: true },
  );
  assert.equal(called, false, "nothing changed: nothing is saved");
});

test("while saving the window says so and can't be changed or closed; a refused save shows why", () => {
  const draft = "A brief";
  const saving = render(
    <LongTextEditorView
      fieldName="Brief"
      taskTitle="Spring flyer"
      readOnly={false}
      draft={draft}
      state={longTextDraft(draft, null)}
      saving
      onDraftChange={noop}
      onSave={noop}
      onCancel={noop}
      onDismiss={noop}
      onCloseButton={noop}
    />,
  );
  assert.equal(isDisabled(buttonTag(saving, "Saving…")), true);
  assert.equal(isDisabled(buttonTag(saving, "Cancel")), true);
  assert.match(saving, /<button[^>]*disabled=""[^>]*aria-label="Close"/);
  assert.match(/<textarea[^>]*>/.exec(saving)![0], /readOnly=""/, "the text stays as sent");
  assert.match(saving, /role="dialog"[^>]*aria-busy="true"/);

  const refused = render(
    <LongTextEditorView
      fieldName="Brief"
      taskTitle="Spring flyer"
      readOnly={false}
      draft={draft}
      state={longTextDraft(draft, null)}
      saveError="Your role in this project doesn’t allow that"
      onDraftChange={noop}
      onSave={noop}
      onCancel={noop}
      onDismiss={noop}
      onCloseButton={noop}
    />,
  );
  const alert = /<p id="([^"]+)" role="alert" data-save-error=""[^>]*>([^<]*)<\/p>/.exec(refused);
  assert.ok(alert, "the reason, announced");
  assert.equal(alert![2], "Your role in this project doesn’t allow that Your text is still here.");
  assert.ok(refused.includes(`>${draft}</textarea>`), "the draft is still in the box");
  assert.match(/<textarea[^>]*>/.exec(refused)![0], new RegExp(`aria-describedby="[^"]*${alert![1]}"`), "the box points at it");
  assert.equal(isDisabled(buttonTag(refused, "Save")), false, "try again");
  assert.doesNotMatch(editorView(draft, null), /data-save-error/);
});

test("the callers hand the save's result to the editor (List cell, pane row)", () => {
  const read = (path: string) => readFileSync(path, "utf8");
  assert.match(read("src/components/project/inline-cells.tsx"), /onSave=\{\(next\) => onChange\(next\)\}/);
  assert.match(read("src/components/project/list-view.tsx"), /setField: \(task: ProjectTask, field: FieldDef, value: Json\) => Promise<ActionResult \| void>/);
  assert.match(read("src/components/task/task-fields.tsx"), /onSave=\{\(next\) => save\(next\)\}/);
  assert.match(read("src/components/toast.tsx"), /new Promise\(\(resolve\) =>/, "useServerAction's run settles with the result");
});

test("Tab stays inside the editor: last → first, first ← last, and into it from behind", () => {
  assert.equal(trappedTabTarget(4, 3, false), 0, "Tab on the last control: back to the first");
  assert.equal(trappedTabTarget(4, 0, true), 3, "Shift+Tab on the first: to the last");
  assert.equal(trappedTabTarget(4, 1, false), null, "in between: the browser's order");
  assert.equal(trappedTabTarget(4, 2, true), null);
  assert.equal(trappedTabTarget(4, -1, false), 0, "focus behind the window: Tab brings it to the first");
  assert.equal(trappedTabTarget(4, -1, true), 3, "and Shift+Tab to the last");
  assert.equal(trappedTabTarget(1, 0, false), 0, "one control keeps the focus");
  assert.equal(trappedTabTarget(0, -1, false), null, "nothing to focus");
  assert.ok(FOCUSABLE_SELECTOR.includes("button:not([disabled])") && FOCUSABLE_SELECTOR.includes("textarea"));
  assert.ok(FOCUSABLE_SELECTOR.includes("[tabindex]:not([tabindex='-1'])"), "the read-only text region");
  const editor = readFileSync("src/components/long-text-editor.tsx", "utf8");
  assert.match(editor, /e\.key === "Tab"/, "the window's key listener handles Tab");
  assert.match(editor, /trappedTabTarget\(/);
});
