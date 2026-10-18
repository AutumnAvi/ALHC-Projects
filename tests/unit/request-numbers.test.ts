import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { displayTaskTitle, previewRequestLabels, renderRequestTemplate, templateProblem } from "@/lib/request-numbers";

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
    assert.equal(displayTaskTitle("business cards", "Req #484"), "[Req #484] business cards");
    assert.equal(displayTaskTitle("[Req #484] business cards", "Req #484"), "[Req #484] business cards");
    assert.equal(displayTaskTitle("[Req #484] business cards", "Req #484", { show: false }), "business cards");
  });

  it("requires a date token when the counter resets", () => {
    assert.equal(templateProblem("Req #{n}", "yearly"), "A yearly or monthly reset needs {yyyy}, {yy}, or {mm} so labels stay unique.");
    assert.equal(templateProblem("Req #{yyyy}-{n}", "yearly"), null);
  });
});
