import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SHARED_FIELD_EDITABLE,
  SHARED_FIELD_READ_ONLY,
  fieldGroupId,
  libraryChoices,
  projectHasLibraryField,
  removeFieldWording,
  repeatedSharedFieldIds,
  searchLibrary,
  sharedFieldNote,
  sharedFieldTooltip,
  sharedFieldView,
  type FieldSharing,
  type LibraryField,
} from "@/lib/fields";

// Oct 29 notes, batch 7 (item 55): library fields shared across projects as linked placements.
describe("shared library fields", () => {
  const source = { id: "src", libraryFieldId: null };
  const placement = { id: "plc", libraryFieldId: "src" };
  const local = { id: "loc" };

  it("groups a placement with its source", () => {
    assert.equal(fieldGroupId(source), "src");
    assert.equal(fieldGroupId(placement), "src");
    assert.equal(fieldGroupId(local), "loc", "a field without the link (or before the update) is its own group");
  });

  it("knows when a project already uses a library field", () => {
    assert.ok(projectHasLibraryField([local, placement], "src"), "through a placement");
    assert.ok(projectHasLibraryField([source], "src"), "as its source");
    assert.ok(!projectHasLibraryField([local], "src"), "not yet");
    assert.ok(!projectHasLibraryField([], "src"));
  });

  it("says who may change a shared definition", () => {
    assert.match(SHARED_FIELD_READ_ONLY, /^Shared from the field library\./);
    assert.match(SHARED_FIELD_READ_ONLY, /name, description, and options/);
  });
});

function sharing(overrides: Partial<FieldSharing> = {}): FieldSharing {
  return {
    fieldId: "f",
    libraryFieldId: null,
    isSource: false,
    isShared: false,
    placementCount: 1,
    definitionEditable: true,
    definitionManageable: false,
    ...overrides,
  };
}

describe("how a shared field reads in field settings", () => {
  it("leaves a project-only field alone", () => {
    const view = sharedFieldView({ id: "loc", libraryFieldId: null }, sharing({ fieldId: "loc" }));
    assert.deepEqual(view, { shared: false, placement: false, definitionReadOnly: false, otherProjects: null });
    assert.equal(sharedFieldTooltip(view), null, "no Shared marker");
    assert.equal(sharedFieldNote(view), null, "no note in Edit field");
    assert.equal(removeFieldWording("Priority", view).button, "Delete field");
  });

  it("marks a source other projects use, and lets its project's editors change it", () => {
    const view = sharedFieldView(
      { id: "src", libraryFieldId: null },
      sharing({ fieldId: "src", isSource: true, isShared: true, placementCount: 3 }),
    );
    assert.deepEqual(view, { shared: true, placement: false, definitionReadOnly: false, otherProjects: 2 });
    assert.equal(sharedFieldTooltip(view), "Shared through the field library with 2 other projects");
    assert.equal(sharedFieldNote(view), SHARED_FIELD_EDITABLE);
  });

  it("doesn't mark a published field nobody else uses yet", () => {
    const view = sharedFieldView(
      { id: "src", libraryFieldId: null },
      sharing({ fieldId: "src", isSource: true, isShared: false, placementCount: 1 }),
    );
    assert.equal(view.shared, false);
    assert.equal(sharedFieldTooltip(view), null);
  });

  it("makes a placement's definition read-only for people who can't change it", () => {
    const view = sharedFieldView(
      { id: "plc", libraryFieldId: "src" },
      sharing({ fieldId: "plc", libraryFieldId: "src", isShared: true, placementCount: 2, definitionEditable: false }),
    );
    assert.deepEqual(view, { shared: true, placement: true, definitionReadOnly: true, otherProjects: 1 });
    assert.equal(sharedFieldTooltip(view), "Shared through the field library with 1 other project");
    assert.equal(sharedFieldNote(view), SHARED_FIELD_READ_ONLY);
  });

  it("lets an editor of the publishing project change a placement", () => {
    const view = sharedFieldView(
      { id: "plc", libraryFieldId: "src" },
      sharing({ fieldId: "plc", libraryFieldId: "src", isShared: true, placementCount: 2, definitionEditable: true }),
    );
    assert.equal(view.definitionReadOnly, false);
    assert.equal(sharedFieldNote(view), SHARED_FIELD_EDITABLE);
  });

  it("still marks a placement without sharing data, and leaves the decision to the database", () => {
    const view = sharedFieldView({ id: "plc", libraryFieldId: "src" }, null);
    assert.deepEqual(view, { shared: true, placement: true, definitionReadOnly: false, otherProjects: null });
    assert.equal(sharedFieldTooltip(view), "Shared through the field library");
  });

  it("says removing a shared field only removes it from this project", () => {
    const view = sharedFieldView({ id: "plc", libraryFieldId: "src" }, null);
    const wording = removeFieldWording("Priority", view);
    assert.equal(wording.button, "Remove from this project");
    assert.equal(wording.title, "Remove “Priority” from this project?");
    assert.match(wording.message, /only removes the field from this project/);
    assert.match(wording.message, /Other projects that use this shared field keep it/);
    assert.equal(wording.confirmLabel, "Remove");
    const plain = removeFieldWording("Priority", sharedFieldView({ id: "loc", libraryFieldId: null }, null));
    assert.equal(plain.title, "Delete the “Priority” field?");
    assert.equal(plain.confirmLabel, "Delete");
  });
});

describe("Add field → Choose from library", () => {
  const library: LibraryField[] = [
    { fieldId: "src-priority", name: "Priority", fieldType: "single_select", description: null, options: [] },
    { fieldId: "src-channel", name: "Channel", fieldType: "single_select", description: "Where it runs", options: [] },
    { fieldId: "src-budget", name: "Budget", fieldType: "number", description: null, options: [] },
  ];

  it("hides library fields the project already uses, by group", () => {
    const fields = [
      { id: "src-priority", libraryFieldId: null }, // this project published it
      { id: "plc-channel", libraryFieldId: "src-channel" }, // already added here
      { id: "local", libraryFieldId: null },
    ];
    assert.deepEqual(
      libraryChoices(library, fields).map((f) => f.fieldId),
      ["src-budget"],
    );
    assert.equal(libraryChoices(library, []).length, 3, "a project without fields sees them all");
  });

  it("searches names and descriptions", () => {
    assert.deepEqual(searchLibrary(library, "  PRIO ").map((f) => f.name), ["Priority"]);
    assert.deepEqual(searchLibrary(library, "runs").map((f) => f.name), ["Channel"]);
    assert.equal(searchLibrary(library, "").length, 3);
    assert.equal(searchLibrary(library, "nothing").length, 0);
  });
});

describe("the task pane shows a shared field once", () => {
  const fields = [
    { id: "a-priority", libraryFieldId: null }, // project A (the source)
    { id: "a-notes", libraryFieldId: null },
    { id: "b-priority", libraryFieldId: "a-priority" }, // project B's placement
    { id: "b-notes", libraryFieldId: null }, // B's own field of the same name: not the same field
  ];

  it("hides a later placement holding the same value", () => {
    const hidden = repeatedSharedFieldIds(fields, { "a-priority": "opt-high", "b-priority": "opt-high", "a-notes": "x", "b-notes": "x" });
    assert.deepEqual([...hidden], ["b-priority"]);
  });

  it("treats no value and a cleared value alike", () => {
    assert.deepEqual([...repeatedSharedFieldIds(fields, { "b-priority": null })], ["b-priority"]);
  });

  it("shows both when the values differ (copies linked with different values)", () => {
    assert.equal(repeatedSharedFieldIds(fields, { "a-priority": "opt-high", "b-priority": "opt-low" }).size, 0);
  });

  it("never hides a project-only field", () => {
    const local = [
      { id: "x", libraryFieldId: null },
      { id: "y", libraryFieldId: null },
    ];
    assert.equal(repeatedSharedFieldIds(local, { x: 1, y: 1 }).size, 0);
  });
});
