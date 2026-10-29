// Oct 29 notes, batch 7 (item 51, the app's side; the database's is the "51. Field lock" part of the zz36
// shared-fields suite): who may change a locked field, and how every place that edits a value shows it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { BoardView } from "@/components/project/board-view";
import { FieldEditorDialog, FieldList } from "@/components/project/field-editor";
import { ListView } from "@/components/project/list-view";
import { ProjectAccessProvider } from "@/components/project/project-access";
import { ProjectPageProvider } from "@/components/project/project-page-context";
import { fieldOptions } from "@/components/rules/rule-shared";
import { ShellProvider } from "@/components/shell/shell-context";
import { TaskFields } from "@/components/task/task-fields";
import { ToastProvider } from "@/components/toast";
import type { ProjectTask, Section, TaskDetail } from "@/lib/data";
import { FieldLockIcon } from "@/components/project/field-lock";
import {
  LOCKED_FIELD_NOTE,
  LOCKED_SHARED_VALUE_NOTE,
  LOCK_FIELD_HINT,
  fieldLockManageable,
  lockedFieldNote,
  lockedValueEditableAcross,
  fieldLockedFor,
  fieldValueEditable,
  lockFieldUnavailable,
  repeatedSharedFieldIds,
  type FieldDef,
  type FieldSharing,
} from "@/lib/fields";
import { permissionsFor } from "@/lib/permissions";
import type { ProjectRole } from "@/lib/roles";
import { stepOutcomeLabel } from "@/lib/rule-steps";
import { DEFAULT_SIDEBAR_PREFS } from "@/lib/sidebar-prefs";
import { parseViewConfig } from "@/lib/views";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const member = { id: "me", email: "me@example.com", name: "Me", avatarUrl: null };

function render(node: ReactNode, role: ProjectRole | null, fieldSharing: Record<string, FieldSharing> = {}) {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value="/projects/p1/list">
        <SearchParamsContext.Provider value={new URLSearchParams() as never}>
          <ShellProvider member={member as never} isWorkspaceAdmin={false} workspace={{ name: "ALHC", logoUrl: null }} initialSidebar={DEFAULT_SIDEBAR_PREFS}>
            <ToastProvider>
              <ProjectAccessProvider role={role}>
                <ProjectPageProvider project={{ id: "p1", name: "Alpha" }} batch4 fieldSharing={fieldSharing}>
                  {node}
                </ProjectPageProvider>
              </ProjectAccessProvider>
            </ToastProvider>
          </ShellProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

const F1 = "00000000-0000-4000-8000-0000000000f1";

function field(overrides: Partial<FieldDef> = {}): FieldDef {
  return {
    id: F1,
    projectId: "p1",
    name: "Stage",
    fieldType: "single_select",
    options: [
      { id: "o1", name: "Draft", color: "zinc" },
      { id: "o2", name: "Final", color: "green" },
    ],
    boundToSections: false,
    showInViews: true,
    sortOrder: 1024,
    description: "Where it is",
    notifyOnChange: false,
    inLibrary: false,
    libraryFieldId: null,
    locked: true,
    lockedBy: "olive",
    lockedAt: "2026-10-29T12:00:00Z",
    ...overrides,
  };
}

function sharing(overrides: Partial<FieldSharing> = {}): FieldSharing {
  return {
    fieldId: F1,
    libraryFieldId: null,
    isSource: false,
    isShared: false,
    placementCount: 1,
    definitionEditable: true,
    definitionManageable: false,
    ...overrides,
  };
}

const section: Section = { id: "s1", project_id: "p1", name: "To do", sort_order: 1024 };

function task(over: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: "t1",
    title: "Write the brief",
    completedAt: null,
    startOn: null,
    dueOn: null,
    assigneeId: null,
    homeProjectId: "p1",
    createdAt: "2026-10-01T00:00:00Z",
    sectionId: "s1",
    sortOrder: 1024,
    subtaskCount: 0,
    subtaskDoneCount: 0,
    projectCount: 1,
    fieldValues: { [F1]: "o2" },
    recurring: false,
    blockedBy: 0,
    kind: "task",
    approvalStatus: null,
    tagIds: [],
    commentCount: 0,
    ...over,
  };
}

function viewProps(fields: FieldDef[], config = parseViewConfig({})) {
  return {
    projectId: "p1",
    sections: [section],
    profiles: [],
    fields,
    config,
    tags: [],
    sectionTaskCounts: { s1: 1 },
    tasks: [task()],
  };
}

// The <input> / <button> markup carrying `marker` (attribute order is React's).
function tagWith(html: string, marker: string): string {
  const at = html.indexOf(marker);
  assert.ok(at >= 0, `missing ${marker}`);
  const start = html.lastIndexOf("<", at);
  return html.slice(start, html.indexOf(">", at) + 1);
}

const lockIcon = new RegExp(`role="img" aria-label="${LOCKED_FIELD_NOTE}" data-tooltip="${LOCKED_FIELD_NOTE}"`, "g");
// The focusable lock (a column header, the pane's label): a button that shows the tooltip on focus and the
// note on Enter / a tap.
const lockButtonFor = (label: string) =>
  new RegExp(`<button type="button" aria-label="${label}" aria-haspopup="dialog" aria-expanded="false" data-tooltip="${label}"`, "g");
const lockButton = lockButtonFor(LOCKED_FIELD_NOTE);

// ---------------------------------------------------------------------------------------------
// Who may do what
// ---------------------------------------------------------------------------------------------

describe("the field lock's rules", () => {
  it("values: Editors+ of an unlocked field, only Owners and Admins of a locked one", () => {
    const open = { locked: false };
    const locked = { locked: true };
    assert.equal(fieldValueEditable(open, permissionsFor("editor")), true);
    assert.equal(fieldValueEditable(locked, permissionsFor("editor")), false);
    assert.equal(fieldValueEditable(locked, permissionsFor("admin")), true);
    assert.equal(fieldValueEditable(locked, permissionsFor("owner")), true);
    assert.equal(fieldValueEditable(open, permissionsFor("commenter")), false, "below Editor nothing changes");
    assert.equal(fieldValueEditable({}, permissionsFor("editor")), true, "a field without the lock column is unlocked");
    assert.equal(fieldLockedFor(locked, permissionsFor("editor")), true);
    assert.equal(fieldLockedFor(locked, permissionsFor("viewer")), true, "Viewers see the lock too");
    assert.equal(fieldLockedFor(locked, permissionsFor("admin")), false);
    assert.equal(fieldLockedFor(open, permissionsFor("viewer")), false);
  });

  it("locking: Owners / Admins of the project whose Editors change the definition; never Status", () => {
    const plain = { boundToSections: false };
    assert.equal(fieldLockManageable(plain, null, permissionsFor("admin")), true, "no sharing data: this project's role");
    assert.equal(fieldLockManageable(plain, null, permissionsFor("editor")), false);
    assert.equal(
      fieldLockManageable(plain, sharing({ definitionManageable: false }), permissionsFor("admin")),
      false,
      "an Admin here, but the field was published by a project they don't run",
    );
    assert.equal(fieldLockManageable(plain, sharing({ definitionManageable: true }), permissionsFor("editor")), true);
    assert.equal(fieldLockManageable({ boundToSections: true }, sharing({ definitionManageable: true }), permissionsFor("owner")), false);
    assert.match(lockFieldUnavailable({ libraryFieldId: "src" }), /project that published this shared field/);
    assert.equal(lockFieldUnavailable({ libraryFieldId: null }), "Only project Owners and Admins can lock or unlock a field.");
  });

  it("the pane keeps the copy of a shared field the viewer can change", () => {
    const fields = [
      { id: "a", libraryFieldId: null, projectId: "pa" },
      { id: "b", libraryFieldId: "a", projectId: "pb" },
    ];
    const values = { a: 5, b: 5 };
    assert.deepEqual([...repeatedSharedFieldIds(fields, values)], ["b"], "no preference: the first project's");
    assert.deepEqual([...repeatedSharedFieldIds(fields, values, (f) => (f.projectId === "pb" ? 0 : 1))], ["a"]);
  });

  it("rules: the field picker says Locked, and a skipped step reads Field locked", () => {
    const [option] = fieldOptions([field()]);
    assert.equal(option.description, "Locked · Single choice");
    assert.ok(option.keywords?.includes("locked"));
    const [plain] = fieldOptions([field({ locked: false })]);
    assert.equal(plain.description, "Single choice");
    assert.equal(stepOutcomeLabel("locked"), "Field locked");
  });
});

// ---------------------------------------------------------------------------------------------
// Fields list and Edit field
// ---------------------------------------------------------------------------------------------

describe("Fields list and Edit field", () => {
  it("marks a locked field in the Fields list", () => {
    const html = render(
      <FieldList projectId="p1" fields={[field(), field({ id: "f2", name: "Notes", locked: false, fieldType: "text", options: [] })]} sectionNames={[]} canEdit batch4 />,
      "editor",
    );
    assert.equal(html.match(lockIcon)?.length, 1);
    assert.match(html, /aria-label="Edit field Stage \(locked\)"/);
    assert.match(html, /aria-label="Edit field Notes"/);
  });

  it("an Editor reads a locked field's definition; only Show in List and Board stays theirs", () => {
    const html = render(
      <FieldEditorDialog projectId="p1" field={field()} sectionNames={[]} batch4 sharing={sharing()} onClose={() => {}} />,
      "editor",
    );
    assert.ok(html.includes(`${LOCKED_FIELD_NOTE}.`), "the note");
    assert.match(tagWith(html, `id="field-${F1}-name"`), /readOnly=""/);
    assert.ok(!html.includes('aria-label="Add an option"'), "options are shown, not edited");
    const lockSwitch = tagWith(html, `id="field-${F1}-locked"`);
    assert.match(lockSwitch, /disabled=""/, "Lock field: greyed out");
    assert.match(lockSwitch, /checked=""/, "and on");
    assert.match(html, /Only project Owners and Admins can lock or unlock a field\. Locked since Oct 29, 2026\./);
    assert.doesNotMatch(tagWith(html, `id="field-${F1}-views"`), /disabled=""/, "Show in List and Board isn't greyed out");
    // Publishing a locked field would let an Editor share it into a project of their own and change its
    // values there (custom_fields_06_lock_guard refuses it too).
    assert.match(tagWith(html, `id="field-${F1}-library"`), /disabled=""/, "Add to field library: greyed out");
    assert.match(html, new RegExp(`<button type="button" disabled="" data-tooltip="${LOCKED_FIELD_NOTE}"`), "Delete is greyed out");
  });

  it("an Admin changes it and can unlock it", () => {
    const html = render(
      <FieldEditorDialog
        projectId="p1"
        field={field()}
        sectionNames={[]}
        batch4
        sharing={sharing({ definitionManageable: true })}
        onClose={() => {}}
      />,
      "admin",
    );
    assert.ok(!html.includes(`${LOCKED_FIELD_NOTE}.`));
    assert.match(html, /aria-label="Add an option"/);
    const lockSwitch = tagWith(html, `id="field-${F1}-locked"`);
    assert.doesNotMatch(lockSwitch, /disabled=""/, "Lock field: usable");
    assert.match(lockSwitch, /checked=""/, "and on");
    assert.ok(html.includes(LOCK_FIELD_HINT));
    assert.doesNotMatch(html, new RegExp(`disabled="" data-tooltip="${LOCKED_FIELD_NOTE}"`));
  });

  it("a shared field locks everywhere, from the project that published it", () => {
    const placement = field({ libraryFieldId: "src", locked: false, lockedAt: null });
    const publisher = render(
      <FieldEditorDialog
        projectId="p1"
        field={placement}
        sectionNames={[]}
        batch4
        sharing={sharing({ libraryFieldId: "src", isShared: true, placementCount: 2, definitionManageable: true })}
        onClose={() => {}}
      />,
      "editor",
    );
    assert.match(publisher, /Locks it in every project that uses it\./);
    const here = render(
      <FieldEditorDialog
        projectId="p1"
        field={placement}
        sectionNames={[]}
        batch4
        sharing={sharing({ libraryFieldId: "src", isShared: true, placementCount: 2, definitionEditable: false })}
        onClose={() => {}}
      />,
      "admin",
    );
    assert.match(tagWith(here, `id="field-${F1}-locked"`), /disabled=""/, "an Admin of this project only");
    assert.match(here, /Only Owners and Admins of the project that published this shared field can lock or unlock it\./);
  });

  it("never offers the lock on the section-bound Status, or when adding a field", () => {
    const status = render(
      <FieldEditorDialog projectId="p1" field={field({ boundToSections: true, locked: false })} sectionNames={["To do"]} batch4 onClose={() => {}} />,
      "owner",
    );
    assert.ok(!status.includes("Lock field"));
    const adding = render(<FieldEditorDialog projectId="p1" field={null} sectionNames={[]} batch4 onClose={() => {}} />, "owner");
    assert.ok(!adding.includes("Lock field"));
  });
});

// ---------------------------------------------------------------------------------------------
// List, Board, and the task pane
// ---------------------------------------------------------------------------------------------

describe("where values are edited", () => {
  const changeButton = /aria-label="Stage of “Write the brief”: Final\. Change"/;

  it("List: an Editor sees the value with the lock and no editor; the header has the lock", () => {
    const html = render(<ListView {...viewProps([field()])} />, "editor");
    assert.doesNotMatch(html, changeButton);
    assert.match(html, /data-locked-field="true"/);
    assert.equal(html.match(lockButton)?.length, 1, "the header's lock is focusable");
    assert.equal(html.match(lockIcon)?.length, 1, "the cell's isn't (no tab stop per row)");
  });

  it("List: an Admin edits it (the header still shows the lock)", () => {
    const html = render(<ListView {...viewProps([field()])} />, "admin");
    assert.match(html, changeButton);
    assert.doesNotMatch(html, /data-locked-field="true"/);
    assert.equal(html.match(lockButton)?.length, 1, "the column header");
    assert.doesNotMatch(html, lockIcon);
  });

  it("List: an unlocked field is unchanged", () => {
    const html = render(<ListView {...viewProps([field({ locked: false })])} />, "editor");
    assert.match(html, changeButton);
    assert.doesNotMatch(html, lockIcon);
    assert.doesNotMatch(html, lockButton);
  });

  it("Board: cards can't be dragged between a locked field's columns below Owner / Admin; chips show the lock", () => {
    const config = parseViewConfig({ group_by: `field:${F1}` });
    const editor = render(<BoardView {...viewProps([field()], config)} />, "editor");
    assert.match(editor, /<article draggable="false"/);
    const admin = render(<BoardView {...viewProps([field()], config)} />, "admin");
    assert.match(admin, /<article draggable="true"/);

    const columns = parseViewConfig({ columns: [`field:${F1}`] });
    const chips = render(<BoardView {...viewProps([field()], columns)} />, "editor");
    assert.match(chips, /data-locked-field="true"/);
    assert.match(chips, /<article draggable="true"/, "grouped by section, cards still move");
  });

  it("the task pane: read-only with the lock for an Editor of the field's project, editable for its Admin", () => {
    const detail = (role: ProjectRole) =>
      ({
        id: "t1",
        memberships: [{ projectId: "p1", projectName: "Alpha", sectionId: "s1", sections: [section] }],
        fields: [field()],
        fieldValues: { [F1]: "o2" },
        viewerProjectRoles: { p1: role },
      }) as unknown as TaskDetail;
    const editor = render(<TaskFields task={detail("editor")} profiles={[]} canEdit />, "editor");
    assert.doesNotMatch(editor, /aria-label="Stage: Final\. Change"/);
    assert.match(editor, />Final</);
    assert.equal(editor.match(lockButton)?.length, 1, "the label's lock (focusable)");
    const admin = render(<TaskFields task={detail("admin")} profiles={[]} canEdit />, "admin");
    assert.match(admin, /aria-label="Stage: Final\. Change"/);
    assert.equal(admin.match(lockButton)?.length, 1, "the label still says it's locked");
  });
});

// ---------------------------------------------------------------------------------------------
// Review fixes (55 × 51)
// ---------------------------------------------------------------------------------------------

describe("55 × 51 review fixes", () => {
  it("a locked shared value: Owner / Admin of every project of the task that uses it", () => {
    const fields = [
      { id: "a", projectId: "pa", libraryFieldId: null },
      { id: "b", projectId: "pb", libraryFieldId: "a" },
      { id: "c", projectId: "pc", libraryFieldId: null },
    ];
    const admins = (...ids: string[]) => (projectId: string) => ids.includes(projectId);
    const shared = { id: "b", projectId: "pb", libraryFieldId: "a", locked: true };
    assert.equal(lockedValueEditableAcross(shared, fields, admins("pa", "pb")), true);
    assert.equal(lockedValueEditableAcross(shared, fields, admins("pb")), false, "an Admin here only: the value would reach pa too");
    assert.equal(lockedValueEditableAcross(shared, fields, admins("pa")), false);
    assert.equal(
      lockedValueEditableAcross({ id: "c", projectId: "pc", libraryFieldId: null, locked: true }, fields, admins("pc")),
      true,
      "a project-only field: this project's Admins",
    );
    assert.equal(lockedValueEditableAcross({ ...shared, locked: false }, fields, admins()), true, "unlocked: the lock has no say");
  });

  it("Edit field tells a placement's Admin who changes a locked shared field's definition", () => {
    assert.equal(lockedFieldNote({ libraryFieldId: null }), LOCKED_FIELD_NOTE);
    assert.match(lockedFieldNote({ libraryFieldId: "src" }), /project that published this shared field/);
    const html = render(
      <FieldEditorDialog
        projectId="p1"
        field={field({ libraryFieldId: "src" })}
        sectionNames={[]}
        batch4
        sharing={sharing({ libraryFieldId: "src", isShared: true, placementCount: 2, definitionEditable: false, definitionManageable: false })}
        onClose={() => {}}
      />,
      "admin",
    );
    assert.ok(html.includes(`${lockedFieldNote({ libraryFieldId: "src" })}.`), "the publishing project's Owners and Admins");
    assert.ok(!html.includes(`${LOCKED_FIELD_NOTE}.`), "not 'only project Owners and Admins' (they are one here)");
  });

  it("the task pane: a locked shared field is read-only unless the viewer runs every project of the task that uses it", () => {
    const placement = field({ id: "f-b", projectId: "p2", libraryFieldId: F1 });
    const detail = (roles: Record<string, ProjectRole>) =>
      ({
        id: "t1",
        memberships: [
          { projectId: "p1", projectName: "Alpha", sectionId: "s1", sections: [section] },
          { projectId: "p2", projectName: "Beta", sectionId: null, sections: [] },
        ],
        fields: [field(), placement],
        fieldValues: { [F1]: "o2", "f-b": "o2" },
        viewerProjectRoles: roles,
      }) as unknown as TaskDetail;
    const partly = render(<TaskFields task={detail({ p1: "admin", p2: "editor" })} profiles={[]} canEdit />, "admin");
    assert.doesNotMatch(partly, /aria-label="Stage: Final\. Change"/, "an Admin of one of them can't change it");
    assert.equal(partly.match(lockButtonFor(LOCKED_SHARED_VALUE_NOTE))?.length, 1, "and the lock says why");
    const both = render(<TaskFields task={detail({ p1: "admin", p2: "owner" })} profiles={[]} canEdit />, "admin");
    assert.match(both, /aria-label="Stage: Final\. Change"/, "an Owner / Admin of both changes it");
  });

  it("the lock is reachable by keyboard and touch where it says why once (and plain in rows)", () => {
    const focusable = renderToStaticMarkup(<FieldLockIcon focusable />);
    assert.match(focusable, lockButtonFor(LOCKED_FIELD_NOTE));
    const plain = renderToStaticMarkup(<FieldLockIcon />);
    assert.match(plain, lockIcon);
    assert.doesNotMatch(plain, /<button|tabindex/i);
    // A Fields list row that isn't a button itself (below Editor) has the focusable lock; an Editor's row
    // is a button (no button inside a button).
    const readOnly = render(<FieldList projectId="p1" fields={[field()]} sectionNames={[]} canEdit={false} batch4 />, "viewer");
    assert.equal(readOnly.match(lockButton)?.length, 1);
    const editable = render(<FieldList projectId="p1" fields={[field()]} sectionNames={[]} canEdit batch4 />, "editor");
    assert.doesNotMatch(editable, lockButton);
  });
});
