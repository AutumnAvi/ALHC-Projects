import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fieldGroupId, projectHasLibraryField, SHARED_FIELD_READ_ONLY } from "@/lib/fields";

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
