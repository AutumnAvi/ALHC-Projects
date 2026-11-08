// Nov 8 note 167: the approval review page's task details are a slice of the task the viewer can
// already read — name, projects, assignee, due date, key fields, description refs — and never comments.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REVIEW_DETAIL_FIELD_LIMIT,
  reviewDetailFields,
  reviewDetailProjectLabel,
  reviewTaskDetails,
} from "../src/approver-review";
import type { FieldDef } from "../src/fields";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function field(over: Partial<FieldDef> & Pick<FieldDef, "id" | "name" | "fieldType">): FieldDef {
  return {
    projectId: PROJECT,
    options: [],
    boundToSections: false,
    showInViews: false,
    sortOrder: 0,
    description: null,
    notifyOnChange: false,
    inLibrary: false,
    ...over,
  };
}

const base = {
  title: "Remember to message @Dana Lee",
  notes: "See the brief.",
  dueOn: "2026-11-02",
  completedAt: null,
  assigneeId: "dana",
  memberships: [
    {
      projectId: PROJECT,
      projectName: "Website",
      sectionId: "sec-1",
      sections: [{ id: "sec-1", name: "Review" }],
    },
  ],
  fields: [] as FieldDef[],
  fieldValues: {} as Record<string, string>,
  commentRefs: { tasks: {}, projects: { [PROJECT]: { name: "Website" } } },
  attachments: [{ id: "file-1", fileName: "logo.pdf", contentType: "application/pdf", sizeBytes: 10, uploadedBy: "me", createdAt: "2026-11-01" }],
};

test("167: the review details are the task facts, and comments are not among them", () => {
  const details = reviewTaskDetails(base);
  assert.deepEqual(Object.keys(details).sort(), [
    "assigneeId",
    "completed",
    "dueOn",
    "fieldValues",
    "fields",
    "files",
    "notes",
    "projects",
    "refs",
    "sections",
    "title",
  ]);
  assert.equal("comments" in details, false);
  assert.equal(details.title, base.title);
  assert.equal(details.notes, "See the brief.");
  assert.equal(details.assigneeId, "dana");
  assert.equal(details.completed, false);
  assert.deepEqual(details.projects, [{ id: PROJECT, name: "Website" }]);
  assert.deepEqual(details.files, [{ id: "file-1", name: "logo.pdf", contentType: "application/pdf" }]);
  assert.equal(details.refs.projects[PROJECT]?.name, "Website");
  // A task with no projects the viewer can open reads as private, not as a blank.
  assert.equal(reviewDetailProjectLabel([]), "Private");
  assert.equal(reviewDetailProjectLabel(["Website"]), "Website");
  assert.equal(reviewDetailProjectLabel(["Website", "Brand", "Events"]), "Website +2");
});

test("167: key fields are pinned ones first, a shared field once, and only when they have a value", () => {
  const priority = field({
    id: "priority",
    name: "Priority",
    fieldType: "single_select",
    showInViews: true,
    sortOrder: 50,
    options: [{ id: "high", name: "High", color: "red" }],
  });
  const budget = field({ id: "budget", name: "Budget", fieldType: "number", numberPrefix: "$", sortOrder: 1 });
  const empty = field({ id: "empty", name: "Notes field", fieldType: "text", showInViews: true, sortOrder: 0 });
  const status = field({
    id: "status",
    name: "Status",
    fieldType: "single_select",
    boundToSections: true,
    showInViews: true,
    sortOrder: 2,
    options: [],
  });
  const sharedPinned = field({
    id: "shared-b",
    name: "Channel",
    fieldType: "text",
    showInViews: true,
    sortOrder: 3,
    libraryFieldId: "lib-1",
  });
  const sharedOther = field({
    id: "shared-a",
    name: "Channel copy",
    fieldType: "text",
    sortOrder: 4,
    libraryFieldId: "lib-1",
    projectId: OTHER,
  });
  const person = field({ id: "who", name: "Reviewer", fieldType: "people", sortOrder: 5 });
  const details = reviewTaskDetails({
    ...base,
    fields: [sharedOther, budget, empty, priority, status, sharedPinned, person],
    fieldValues: {
      priority: "high",
      budget: 40,
      empty: "",
      "shared-a": "Email",
      "shared-b": "Email",
      who: ["secret-person"],
    },
  });
  const { shown, hidden } = reviewDetailFields(details, () => null);
  assert.deepEqual(
    shown.map((f) => f.name),
    ["Status", "Channel", "Priority", "Budget"],
  );
  assert.equal(hidden, 0);
  assert.equal(shown.find((f) => f.name === "Status")?.chips[0]?.label, "Review");
  assert.equal(shown.find((f) => f.name === "Priority")?.chips[0]?.label, "High");
  assert.equal(shown.find((f) => f.name === "Budget")?.chips[0]?.label, "$40");
  // A person this caller can't name never becomes an id on the page.
  assert.equal(shown.some((f) => f.name === "Reviewer"), false);
  assert.equal(shown.some((f) => JSON.stringify(f).includes("secret-person")), false);
});

test("167: fields past the cap are counted, not listed", () => {
  const fields = Array.from({ length: REVIEW_DETAIL_FIELD_LIMIT + 2 }, (_, i) =>
    field({ id: `f${i}`, name: `Field ${i}`, fieldType: "text", showInViews: i === 7, sortOrder: i }),
  );
  const fieldValues = Object.fromEntries(fields.map((f) => [f.id, f.name]));
  const { shown, hidden } = reviewDetailFields(
    reviewTaskDetails({ ...base, fields, fieldValues }),
    () => null,
  );
  assert.equal(shown.length, REVIEW_DETAIL_FIELD_LIMIT);
  assert.equal(hidden, 2);
  // The one pinned field leads, even though it sorts last.
  assert.equal(shown[0]?.name, "Field 7");
});
