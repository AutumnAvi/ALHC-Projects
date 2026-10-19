import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  displayTaskTitle,
  formatRequestLabel,
  previewRequestLabels,
  renderRequestTemplate,
  requestLabelFrom,
  templateProblem,
} from "@/lib/request-numbers";

describe("task numbering labels", () => {
  it("renders the default template and brackets", () => {
    const [first, sub, later] = previewRequestLabels("Req #{n}", { wrapBrackets: true });
    assert.equal(first, "[Req #484]");
    assert.equal(sub, "[Req #484.1]");
    assert.equal(later, "[Req #485]");
  });

  it("pads, dates, and field tokens", () => {
    const label = renderRequestTemplate("JOB-{n:4}-{yyyy}-{field:Site}", {
      number: "7",
      at: "2026-03-14T12:00:00Z",
      field: "HQ",
    });
    assert.equal(label, "JOB-0007-2026-HQ");
  });

  it("shows the label in front of the name and does not double a baked prefix", () => {
    const wrapped = { text: "Req #484", wrap: true };
    assert.equal(displayTaskTitle("business cards", wrapped), "[Req #484] business cards");
    assert.equal(displayTaskTitle("[Req #484] business cards", wrapped), "[Req #484] business cards");
    assert.equal(displayTaskTitle("[Req #484] business cards", wrapped, { show: false }), "business cards");
  });

  it("follows the project's bracket setting (Oct 19: unchecking it had no effect)", () => {
    const bare = { text: "Task #3", wrap: false };
    assert.equal(formatRequestLabel(bare), "Task #3");
    assert.equal(formatRequestLabel({ text: "Task #3", wrap: true }), "[Task #3]");
    assert.equal(displayTaskTitle("Logo refresh", bare), "Task #3 Logo refresh");
    // A title that still has the label baked in, either way, is never prefixed twice.
    assert.equal(displayTaskTitle("[Task #3] Logo refresh", bare), "Task #3 Logo refresh");
    assert.equal(displayTaskTitle("Task #3 Logo refresh", bare), "Task #3 Logo refresh");
    assert.equal(displayTaskTitle("Task #3 Logo refresh", { text: "Task #3", wrap: true }), "[Task #3] Logo refresh");
    assert.equal(displayTaskTitle("Task #3 Logo refresh", bare, { show: false }), "Logo refresh");
    assert.equal(displayTaskTitle("Logo refresh", null), "Logo refresh");
    assert.deepEqual(previewRequestLabels("Req #{n}", { wrapBrackets: false }), ["Req #484", "Req #484.1", "Req #485"]);
  });

  it("reads task_request_labels() entries", () => {
    assert.deepEqual(requestLabelFrom({ label: "Task #3", wrap: false }), { text: "Task #3", wrap: false });
    assert.deepEqual(requestLabelFrom({ label: "Task #3", wrap: true }), { text: "Task #3", wrap: true });
    assert.deepEqual(requestLabelFrom({ label: "Task #3" }), { text: "Task #3", wrap: true });
    assert.equal(requestLabelFrom({ label: "" }), null);
    assert.equal(requestLabelFrom(null), null);
  });

  it("requires a date token when the counter resets", () => {
    assert.equal(templateProblem("Req #{n}", "yearly"), "A yearly or monthly reset needs {yyyy}, {yy}, or {mm} so labels stay unique.");
    assert.equal(templateProblem("Req #{yyyy}-{n}", "yearly"), null);
  });
});
