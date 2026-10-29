// Oct 29 notes, batch 7 (item 55, the app's side; the database's is the zz36 shared-fields suite):
// shared library fields in the Fields list, Customize → Fields, Edit field (List column menu too), and
// the task pane.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { EditFieldDialog, NewFieldDialog } from "@/components/project/field-dialog";
import { FieldEditorDialog, FieldList } from "@/components/project/field-editor";
import { ProjectAccessProvider } from "@/components/project/project-access";
import { ProjectPageProvider } from "@/components/project/project-page-context";
import { ToastProvider } from "@/components/toast";
import { TaskFields } from "@/components/task/task-fields";
import type { TaskDetail } from "@/lib/data";
import { SHARED_FIELD_EDITABLE, SHARED_FIELD_READ_ONLY, type FieldDef, type FieldSharing } from "@/lib/fields";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };

function render(node: ReactNode, fieldSharing: Record<string, FieldSharing> = {}) {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value="/projects/p1/fields">
        <SearchParamsContext.Provider value={new URLSearchParams() as never}>
          <ToastProvider>
            <ProjectAccessProvider role="editor">
              <ProjectPageProvider project={{ id: "p1", name: "Beta" }} batch4 fieldSharing={fieldSharing}>
                {node}
              </ProjectPageProvider>
            </ProjectAccessProvider>
          </ToastProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

function field(overrides: Partial<FieldDef> = {}): FieldDef {
  return {
    id: "plc",
    projectId: "p1",
    name: "Priority",
    fieldType: "single_select",
    options: [
      { id: "o1", name: "Low", color: "green" },
      { id: "o2", name: "High", color: "red" },
    ],
    boundToSections: false,
    showInViews: true,
    sortOrder: 1024,
    description: "How urgent",
    notifyOnChange: true,
    inLibrary: false,
    libraryFieldId: "src",
    ...overrides,
  };
}

function sharing(overrides: Partial<FieldSharing> = {}): FieldSharing {
  return {
    fieldId: "plc",
    libraryFieldId: "src",
    isSource: false,
    isShared: true,
    placementCount: 3,
    definitionEditable: false,
    definitionManageable: false,
    ...overrides,
  };
}

// The <input> / <textarea> / <button> markup carrying `marker` (attribute order is React's).
function tagWith(html: string, marker: string): string {
  const at = html.indexOf(marker);
  assert.ok(at >= 0, `missing ${marker}`);
  const start = html.lastIndexOf("<", at);
  return html.slice(start, html.indexOf(">", at) + 1);
}

describe("the Fields list marks shared fields", () => {
  const local = field({ id: "loc", name: "Channel", libraryFieldId: null, options: [], fieldType: "text" });

  it("shows Shared (with a count, never a project name) on a placement and a used source", () => {
    const source = field({ id: "src-here", name: "Budget", libraryFieldId: null, inLibrary: true, fieldType: "number", options: [] });
    const html = render(
      <FieldList
        projectId="p1"
        fields={[field(), source, local]}
        sectionNames={[]}
        canEdit
        batch4
        sharing={{
          plc: sharing(),
          "src-here": sharing({ fieldId: "src-here", libraryFieldId: null, isSource: true, placementCount: 2, definitionEditable: true }),
          loc: sharing({ fieldId: "loc", libraryFieldId: null, isShared: false, placementCount: 1, definitionEditable: true }),
        }}
      />,
    );
    assert.equal(html.match(/>Shared</g)?.length, 2, "the placement and the source other projects use");
    assert.match(html, /data-tooltip="Shared through the field library with 2 other projects"/);
    assert.match(html, /data-tooltip="Shared through the field library with 1 other project"/);
    assert.match(html, /aria-label="Edit field Priority \(shared through the field library with 2 other projects\)"/);
    assert.match(html, /aria-label="Edit field Channel"/, "a project-only field has no marker");
  });

  it("marks a placement even before the sharing data arrives (dense, in Customize → Fields)", () => {
    const html = render(<FieldList projectId="p1" fields={[field(), local]} sectionNames={[]} canEdit batch4 dense />);
    assert.equal(html.match(/>Shared</g)?.length, 1);
    assert.match(html, /data-tooltip="Shared through the field library"/);
  });
});

describe("Edit field on a shared field", () => {
  it("shows the definition read-only, with the note, to people who can't change it", () => {
    const html = render(
      <FieldEditorDialog projectId="p1" field={field()} sectionNames={[]} batch4 sharing={sharing()} onClose={() => {}} />,
    );
    assert.ok(html.includes(SHARED_FIELD_READ_ONLY), "the brief's note");
    assert.match(tagWith(html, 'id="field-plc-name"'), /readOnly=""/);
    assert.match(tagWith(html, 'id="field-plc-description"'), /readOnly=""/);
    assert.ok(!html.includes('aria-label="Add an option"'), "options are shown, not edited");
    assert.match(html, />Low</);
    assert.match(html, />High</);
    assert.match(tagWith(html, 'id="field-plc-notify"'), /disabled=""/, "notifications follow the definition");
    assert.doesNotMatch(tagWith(html, 'id="field-plc-views"'), /disabled=""/, "Show in List and Board stays per project");
    assert.ok(!html.includes('id="field-plc-library"'), "a placement is never listed in the library itself");
    assert.match(html, /Remove from this project/);
    assert.match(html, /A field shared with other projects through the field library\./);
  });

  it("stays editable for editors of the project that published it", () => {
    const html = render(
      <FieldEditorDialog
        projectId="p1"
        field={field()}
        sectionNames={[]}
        batch4
        sharing={sharing({ definitionEditable: true })}
        onClose={() => {}}
      />,
    );
    assert.ok(html.includes(SHARED_FIELD_EDITABLE));
    assert.doesNotMatch(tagWith(html, 'id="field-plc-name"'), /readOnly=""/);
    assert.match(html, /aria-label="Add an option"/);
    assert.doesNotMatch(tagWith(html, 'id="field-plc-notify"'), /disabled=""/);
    assert.ok(!html.includes('id="field-plc-library"'));
  });

  it("offers the library switch on the source, and plain Delete on a project-only field", () => {
    const source = field({ id: "src", libraryFieldId: null, inLibrary: true });
    const sourceHtml = render(
      <FieldEditorDialog
        projectId="p1"
        field={source}
        sectionNames={[]}
        batch4
        sharing={sharing({ fieldId: "src", libraryFieldId: null, isSource: true, definitionEditable: true })}
        onClose={() => {}}
      />,
    );
    assert.match(sourceHtml, /id="field-src-library"/);
    assert.match(sourceHtml, /Projects that already use it keep it either way\./);
    assert.match(sourceHtml, /Remove from this project/);

    const local = field({ id: "loc", libraryFieldId: null });
    const localHtml = render(
      <FieldEditorDialog
        projectId="p1"
        field={local}
        sectionNames={[]}
        batch4
        sharing={sharing({ fieldId: "loc", libraryFieldId: null, isShared: false, placementCount: 1, definitionEditable: true })}
        onClose={() => {}}
      />,
    );
    assert.ok(!localHtml.includes(SHARED_FIELD_EDITABLE) && !localHtml.includes("Shared from the field library"));
    assert.match(localHtml, />Delete field</);
    assert.match(localHtml, /Changes apply to every task in this project\./);
  });

  it("reads the List column menu's sharing from the project page (EditFieldDialog)", () => {
    const html = render(<EditFieldDialog field={field()} sectionNames={[]} onClose={() => {}} />, { plc: sharing() });
    assert.match(tagWith(html, 'id="field-plc-name"'), /readOnly=""/);
  });

  it("the List's + opens Add field with both tabs", () => {
    const html = render(<NewFieldDialog projectId="p1" existingFields={[field()]} onCreated={() => {}} onClose={() => {}} />);
    assert.match(html, />Create new field</);
    assert.match(html, />Choose from library</);
  });
});

describe("the task pane shows a shared field once", () => {
  function task(values: Record<string, unknown>): TaskDetail {
    const membership = (projectId: string, projectName: string) => ({
      projectId,
      projectName,
      sectionId: null,
      sections: [],
    });
    return {
      id: "t1",
      memberships: [membership("pa", "Alpha"), membership("pb", "Beta")],
      fields: [
        field({ id: "a-priority", projectId: "pa", libraryFieldId: null, inLibrary: true }),
        field({ id: "b-priority", projectId: "pb", libraryFieldId: "a-priority" }),
        field({ id: "b-budget", projectId: "pb", name: "Budget", fieldType: "number", options: [], libraryFieldId: null }),
      ],
      fieldValues: values,
    } as unknown as TaskDetail;
  }

  it("lists it under its first project only when the values agree", () => {
    const html = render(<TaskFields task={task({ "a-priority": "o2", "b-priority": "o2", "b-budget": 5 })} profiles={[]} canEdit={false} />);
    assert.equal(html.match(/>Priority</g)?.length, 1);
    assert.match(html, />Alpha</);
    assert.match(html, />Beta</, "Beta still lists its own field");
  });

  it("shows both when the values differ", () => {
    const html = render(<TaskFields task={task({ "a-priority": "o2", "b-priority": "o1" })} profiles={[]} canEdit={false} />);
    assert.equal(html.match(/>Priority</g)?.length, 2);
  });
});
