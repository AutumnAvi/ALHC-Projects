// Oct 29 notes, batch 7, item 47 (the app's side; the database's is the T2 part of suite zz36): single-
// and multi-select fields need at least one option — the Add / Edit field modal (also the List's "+"
// column) and the portfolio fields manager disable Create / Save with "Add at least one option", a typed
// but not yet added option counts, and a field that never had options can still be renamed.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { LAST_OPTION_NOTE, PortfolioFieldsManager } from "@/components/portfolio/portfolio-fields-manager";
import { FieldEditorDialog } from "@/components/project/field-editor";
import { ProjectAccessProvider } from "@/components/project/project-access";
import { ShellProvider } from "@/components/shell/shell-context";
import { ToastProvider } from "@/components/toast";
import type { PortfolioField } from "@/lib/data";
import { SELECT_NEEDS_OPTION, selectOptionsProblem, type FieldDef, type FieldOption } from "@/lib/fields";
import { DEFAULT_SIDEBAR_PREFS } from "@/lib/sidebar-prefs";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const member = { id: "me", email: "me@example.com", name: "Me", avatarUrl: null };

function render(node: ReactNode) {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value="/projects/p1/fields">
        <SearchParamsContext.Provider value={new URLSearchParams() as never}>
          <ShellProvider member={member as never} isWorkspaceAdmin={false} workspace={{ name: "ALHC", logoUrl: null }} initialSidebar={DEFAULT_SIDEBAR_PREFS}>
            <ToastProvider>
              <ProjectAccessProvider role="editor">{node}</ProjectAccessProvider>
            </ToastProvider>
          </ShellProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

// The opening tag of the button whose text is `label`.
function buttonTag(html: string, label: string) {
  const end = html.indexOf(`>${label}</button>`);
  assert.ok(end > 0, `a “${label}” button`);
  return html.slice(html.lastIndexOf("<button", end), end + 1);
}
const isDisabled = (tag: string) => / disabled=""/.test(tag);

const high: FieldOption = { id: "o1", name: "High", color: "red" };
const low: FieldOption = { id: "o2", name: "Low", color: "zinc" };

function field(overrides: Partial<FieldDef> = {}): FieldDef {
  return {
    id: "f1",
    projectId: "p1",
    name: "Priority",
    fieldType: "single_select",
    options: [high, low],
    boundToSections: false,
    showInViews: true,
    sortOrder: 1024,
    description: null,
    notifyOnChange: false,
    inLibrary: false,
    ...overrides,
  };
}

test("selectOptionsProblem: select fields need an option; a typed one counts; others never do", () => {
  assert.equal(SELECT_NEEDS_OPTION, "Add at least one option");
  assert.equal(selectOptionsProblem({ fieldType: "single_select", optionCount: 0 }), SELECT_NEEDS_OPTION);
  assert.equal(selectOptionsProblem({ fieldType: "multi_select", optionCount: 0 }), SELECT_NEEDS_OPTION);
  assert.equal(selectOptionsProblem({ fieldType: "single_select", optionCount: 1 }), null);
  // A name typed in "Add an option" is added on save, so it counts — blank space doesn't.
  assert.equal(selectOptionsProblem({ fieldType: "single_select", optionCount: 0, pendingOption: "High" }), null);
  assert.equal(selectOptionsProblem({ fieldType: "single_select", optionCount: 0, pendingOption: "   " }), SELECT_NEEDS_OPTION);
  // The section-bound Status's options are the sections; other types have none.
  assert.equal(selectOptionsProblem({ fieldType: "single_select", boundToSections: true, optionCount: 0 }), null);
  for (const fieldType of ["text", "number", "date", "boolean", "people"]) {
    assert.equal(selectOptionsProblem({ fieldType, optionCount: 0 }), null, fieldType);
  }
  // Editing: a field that had options can't be emptied; one that never had any can still be saved.
  assert.equal(selectOptionsProblem({ fieldType: "single_select", optionCount: 0, previousCount: 2 }), SELECT_NEEDS_OPTION);
  assert.equal(selectOptionsProblem({ fieldType: "single_select", optionCount: 0, previousCount: 0 }), null);
  assert.equal(selectOptionsProblem({ fieldType: "single_select", optionCount: 0, previousCount: null }), SELECT_NEEDS_OPTION);
});

test("Add field (and the List's “+” column): Create field is disabled until there's an option", () => {
  // A new field starts as a single-select with no options.
  const html = render(<FieldEditorDialog projectId="p1" field={null} sectionNames={[]} batch4 onClose={() => {}} />);
  const create = buttonTag(html, "Create field");
  assert.ok(isDisabled(create), "Create field is disabled");
  assert.match(html, /Add at least one option so people can pick a value\./);
  assert.match(create, /aria-describedby="field-new-options-hint"/, "the button points at the hint");
  assert.match(html, /id="field-new-options-hint"/);
});

test("Edit field: a select with options saves normally", () => {
  const html = render(<FieldEditorDialog projectId="p1" field={field()} sectionNames={[]} batch4 onClose={() => {}} />);
  const save = buttonTag(html, "Save");
  assert.ok(!isDisabled(save), "Save is enabled");
  assert.doesNotMatch(html, /Add at least one option/);
});

test("Edit field: an older select with no options can still be renamed (a gentle note, Save enabled)", () => {
  const html = render(
    <FieldEditorDialog projectId="p1" field={field({ options: [] })} sectionNames={[]} batch4 onClose={() => {}} />,
  );
  assert.ok(!isDisabled(buttonTag(html, "Save")), "Save is enabled");
  assert.match(html, /This field has no options yet\. Add at least one so people can pick a value\./);
});

test("Edit field: other types and the section-bound Status show no option hint", () => {
  for (const f of [
    field({ fieldType: "text", options: [] }),
    field({ name: "Status", options: [], boundToSections: true }),
  ]) {
    const html = render(<FieldEditorDialog projectId="p1" field={f} sectionNames={["Intake"]} batch4 onClose={() => {}} />);
    assert.ok(!isDisabled(buttonTag(html, "Save")), `${f.name}: Save is enabled`);
    assert.doesNotMatch(html, /Add at least one option/, f.name);
  }
});

function portfolioField(overrides: Partial<PortfolioField> = {}): PortfolioField {
  return { id: "pf1", name: "Phase", fieldType: "single_select", options: [high, low], sortOrder: 1024, ...overrides };
}

test("Portfolio fields: the last option of a single-select can't be removed", () => {
  const one = render(<PortfolioFieldsManager portfolioId="pt1" fields={[portfolioField({ options: [high] })]} canEdit />);
  const remove = one.match(/<button[^>]*aria-label="Remove option High"[^>]*>/)?.[0] ?? "";
  assert.match(remove, /aria-disabled="true"/, "the only option's remove is unavailable");
  assert.ok(remove.includes(`data-tooltip="${LAST_OPTION_NOTE}"`), "and says why");

  const two = render(<PortfolioFieldsManager portfolioId="pt1" fields={[portfolioField()]} canEdit />);
  for (const name of ["High", "Low"]) {
    const tag = two.match(new RegExp(`<button[^>]*aria-label="Remove option ${name}"[^>]*>`))?.[0] ?? "";
    assert.ok(tag, `${name} has a remove button`);
    assert.doesNotMatch(tag, /aria-disabled/, `${name} can be removed while another is left`);
  }
});

test("Portfolio fields: the new-field form starts as Text (no options asked); read-only for viewers", () => {
  const html = render(<PortfolioFieldsManager portfolioId="pt1" fields={[]} canEdit />);
  assert.doesNotMatch(html, /Add an option/, "a text field asks for no options");
  assert.doesNotMatch(html, /Add at least one option/);
  const viewer = render(<PortfolioFieldsManager portfolioId="pt1" fields={[portfolioField({ options: [high] })]} canEdit={false} />);
  assert.doesNotMatch(viewer, /Remove option/, "viewers get no remove buttons");
});
