// Oct 29 notes, batch 7: where the tracks meet (the database's side is the cross-track part of suite
// zz36). The number symbol (49) and the long text editor (48) follow the shared definition (55) and the
// field lock (51); the select-option rule (47) never blocks a read-only shared field.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { LongTextEditorView } from "@/components/long-text-editor";
import { FieldEditorDialog } from "@/components/project/field-editor";
import { InlineFieldCell } from "@/components/project/inline-cells";
import { ProjectAccessProvider } from "@/components/project/project-access";
import { ShellProvider } from "@/components/shell/shell-context";
import { PaneTextValue } from "@/components/task/task-fields";
import { ToastProvider } from "@/components/toast";
import { LOCKED_FIELD_NOTE, type FieldDef, type FieldSharing } from "@/lib/fields";
import { longTextDraft } from "@/lib/long-text";
import type { ProjectRole } from "@/lib/roles";
import { DEFAULT_SIDEBAR_PREFS } from "@/lib/sidebar-prefs";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const member = { id: "me", email: "me@example.com", name: "Me", avatarUrl: null };
const noop = () => {};

function render(node: ReactNode, role: ProjectRole | null = "editor") {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value="/projects/p1/list">
        <SearchParamsContext.Provider value={new URLSearchParams() as never}>
          <ShellProvider member={member as never} isWorkspaceAdmin={false} workspace={{ name: "ALHC", logoUrl: null }} initialSidebar={DEFAULT_SIDEBAR_PREFS}>
            <ToastProvider>
              <ProjectAccessProvider role={role}>{node}</ProjectAccessProvider>
            </ToastProvider>
          </ShellProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

const textOf = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "");

function field(overrides: Partial<FieldDef> = {}): FieldDef {
  return {
    id: "f1",
    projectId: "p1",
    name: "Budget",
    fieldType: "number",
    options: [],
    boundToSections: false,
    showInViews: true,
    sortOrder: 1024,
    description: null,
    notifyOnChange: false,
    inLibrary: false,
    numberPrefix: "$",
    libraryFieldId: null,
    locked: false,
    lockedBy: null,
    lockedAt: null,
    ...overrides,
  };
}

function sharing(overrides: Partial<FieldSharing> = {}): FieldSharing {
  return {
    fieldId: "f1",
    libraryFieldId: "src",
    isSource: false,
    isShared: true,
    placementCount: 2,
    definitionEditable: false,
    definitionManageable: false,
    ...overrides,
  };
}

const symbolInput = (html: string) => /<input id="field-f1-symbol"[^>]*>/.exec(html)?.[0] ?? "";
const disabled = (tag: string) => / disabled=""/.test(tag);
function buttonTag(html: string, label: string) {
  const end = html.indexOf(`>${label}</button>`);
  assert.ok(end > 0, `a “${label}” button`);
  return html.slice(html.lastIndexOf("<button", end), end + 1);
}

test("49 × 55: a shared number field's Symbol is read-only for people who can't change its definition", () => {
  const readOnly = render(
    <FieldEditorDialog projectId="p1" field={field({ libraryFieldId: "src" })} sharing={sharing()} sectionNames={[]} batch4 onClose={noop} />,
  );
  assert.ok(disabled(symbolInput(readOnly)), "the Symbol box is disabled");
  assert.ok(/aria-label="Use €"[^>]*disabled=""|disabled=""[^>]*aria-label="Use €"/.test(readOnly), "so are the quick picks");
  assert.match(textOf(readOnly), /Only editors of the project that published it can change/);
  assert.ok(!disabled(buttonTag(readOnly, "Save")), "Save still works for the per-project settings");

  const editable = render(
    <FieldEditorDialog
      projectId="p1"
      field={field({ libraryFieldId: "src" })}
      sharing={sharing({ definitionEditable: true })}
      sectionNames={[]}
      batch4
      onClose={noop}
    />,
  );
  assert.ok(symbolInput(editable) && !disabled(symbolInput(editable)), "editors of the publishing project change it");
});

test("49 × 51: a locked number field's Symbol is read-only below Owner / Admin", () => {
  const locked = field({ locked: true, lockedBy: "olive", lockedAt: "2026-10-29T12:00:00Z" });
  const editor = render(<FieldEditorDialog projectId="p1" field={locked} sectionNames={[]} batch4 onClose={noop} />, "editor");
  assert.ok(disabled(symbolInput(editor)), "an Editor can't change a locked field's symbol");
  assert.ok(textOf(editor).includes(`${LOCKED_FIELD_NOTE}.`), "and is told why");
  const owner = render(<FieldEditorDialog projectId="p1" field={locked} sectionNames={[]} batch4 onClose={noop} />, "owner");
  assert.ok(symbolInput(owner) && !disabled(symbolInput(owner)), "an Owner can");
});

test("47 × 55: a read-only shared select with no options shows no option hint and saves", () => {
  const select = field({ fieldType: "single_select", numberPrefix: null, options: [], libraryFieldId: "src" });
  const html = render(<FieldEditorDialog projectId="p1" field={select} sharing={sharing()} sectionNames={[]} batch4 onClose={noop} />);
  assert.doesNotMatch(textOf(html), /Add at least one option/);
  assert.match(textOf(html), /No options yet\./, "the options read as they are");
  assert.ok(!disabled(buttonTag(html, "Save")));
});

test("48 × 51: the long text reader says a locked field is locked", () => {
  const view = (locked: boolean) =>
    renderToStaticMarkup(
      <LongTextEditorView
        fieldName="Brief"
        taskTitle="Spring flyer"
        readOnly
        locked={locked}
        draft="Print run of 500"
        state={longTextDraft("Print run of 500", "Print run of 500")}
        onDraftChange={noop}
        onSave={noop}
        onCancel={noop}
        onDismiss={noop}
        onCloseButton={noop}
      />,
    );
  assert.ok(textOf(view(true)).includes(`${LOCKED_FIELD_NOTE}.`));
  assert.match(view(true), /data-locked-note=""/);
  assert.doesNotMatch(view(false), /data-locked-note/, "a plain read-only view doesn't mention a lock");
});

test("48/49 × 51: inline editors of a locked field don't open for people who can't change it", () => {
  const cell = (f: FieldDef, value: unknown, canEdit: boolean) =>
    renderToStaticMarkup(
      <InlineFieldCell
        field={f}
        value={value as never}
        sectionId={null}
        sections={[]}
        people={[]}
        taskTitle="Launch"
        canEdit={canEdit}
        display="shown"
        onChange={noop}
        onSectionChange={noop}
      />,
    );
  const lockedNumber = field({ locked: true });
  assert.equal(cell(lockedNumber, 1250, false), "shown", "a locked number reads as its value, no box");
  assert.match(cell(lockedNumber, 1250, true), /aria-label="Budget of “Launch”: \$1,250\. Change"/, "Owners / Admins edit it");

  const lockedText = field({ fieldType: "text", numberPrefix: null, name: "Brief", locked: true });
  const reader = cell(lockedText, "Kickoff on Monday.", false);
  assert.match(reader, /aria-label="Brief of “Launch”: Kickoff on Monday\. Show full text"/, "the whole text to read, not an editor");

  const pane = renderToStaticMarkup(
    <PaneTextValue fieldName="Brief" taskTitle="Launch" value="Kickoff on Monday." canEdit={false} locked onSave={noop} />,
  );
  assert.match(pane, /Show full text/, "the pane's row opens the reader too");
});
