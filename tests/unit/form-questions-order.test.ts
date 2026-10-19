import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  brokenBranches,
  clearedBranchesMessage,
  moveQuestionBefore,
  moveQuestionBy,
  normalizeQuestions,
  type FormQuestion,
} from "@/lib/forms";

// The form editor's reordering (drag and drop, Move up / Move down, Alt+↑ / Alt+↓) and the branches a
// move clears: a question can only be shown by an earlier choice or checkbox question.

const p: FormQuestion = { id: "p", type: "single_select", label: "Kind of request", options: [{ id: "o1", label: "Print" }] };
const c: FormQuestion = { id: "c", type: "short_text", label: "Paper size", show_if: { question_id: "p", option_ids: ["o1"] } };
const x: FormQuestion = { id: "x", type: "long_text", label: "Anything else?" };
const k: FormQuestion = { id: "k", type: "checkbox", label: "Rush job" };
const kc: FormQuestion = { id: "kc", type: "date", label: "Needed by", show_if: { question_id: "k", option_ids: ["true"] } };
// A chain: p shows c2, which shows g.
const c2: FormQuestion = {
  id: "c2",
  type: "single_select",
  label: "Finish",
  options: [{ id: "o2", label: "Glossy" }],
  show_if: { question_id: "p", option_ids: ["o1"] },
};
const g: FormQuestion = { id: "g", type: "short_text", label: "Coating notes", show_if: { question_id: "c2", option_ids: ["o2"] } };

const base = [p, c, x];
const ids = (questions: FormQuestion[]) => questions.map((q) => q.id);

describe("moveQuestionBefore", () => {
  it("moves a question to the start, the end, or between two others", () => {
    assert.deepEqual(ids(moveQuestionBefore(base, "x", "p")), ["x", "p", "c"]);
    assert.deepEqual(ids(moveQuestionBefore(base, "p", null)), ["c", "x", "p"]);
    assert.deepEqual(ids(moveQuestionBefore([p, c, x, k], "k", "c")), ["p", "k", "c", "x"]);
    assert.deepEqual(ids(moveQuestionBefore([p, c, x, k], "p", "x")), ["c", "p", "x", "k"]);
  });

  it("returns the same array when nothing moves", () => {
    assert.equal(moveQuestionBefore(base, "c", "c"), base, "onto itself");
    assert.equal(moveQuestionBefore(base, "p", "c"), base, "already right before it");
    assert.equal(moveQuestionBefore(base, "x", null), base, "already last");
    assert.equal(moveQuestionBefore(base, "nope", "p"), base, "unknown question");
    assert.equal(moveQuestionBefore(base, "p", "nope"), base, "unknown target");
  });

  it("leaves the original array alone", () => {
    const before = [...base];
    moveQuestionBefore(base, "x", "p");
    assert.deepEqual(base, before);
  });
});

describe("moveQuestionBy", () => {
  it("returns the same array at the ends", () => {
    assert.equal(moveQuestionBy(base, "p", -1), base);
    assert.equal(moveQuestionBy(base, "x", 1), base);
    assert.equal(moveQuestionBy(base, "nope", 1), base);
  });

  it("swaps with the neighbor otherwise", () => {
    const list = [p, c, x, k, kc];
    for (let i = 0; i < list.length; i++) {
      for (const delta of [-1, 1] as const) {
        const j = i + delta;
        if (j < 0 || j >= list.length) continue;
        const swapped = [...list];
        [swapped[i], swapped[j]] = [swapped[j], swapped[i]];
        assert.deepEqual(ids(moveQuestionBy(list, list[i].id, delta)), ids(swapped), `${list[i].id} by ${delta}`);
      }
    }
  });
});

describe("brokenBranches", () => {
  it("finds nothing in a valid order, or when an unrelated question moves anywhere", () => {
    assert.deepEqual(brokenBranches(base), []);
    assert.deepEqual(brokenBranches([k, kc]), []);
    assert.deepEqual(brokenBranches([p, c2, g]), []);
    for (const before of ["p", "c", null]) {
      assert.deepEqual(brokenBranches(moveQuestionBefore(base, "x", before)), [], `x before ${before}`);
    }
  });

  it("reports a question moved above its branch question", () => {
    assert.deepEqual(ids(brokenBranches(moveQuestionBefore(base, "c", "p"))), ["c"]);
    assert.deepEqual(ids(brokenBranches(moveQuestionBy([k, kc], "kc", -1))), ["kc"]);
  });

  it("reports the question when its branch question moves below it", () => {
    assert.deepEqual(ids(brokenBranches(moveQuestionBefore(base, "p", null))), ["c"]);
    assert.deepEqual(ids(brokenBranches(moveQuestionBy(base, "p", 1))), ["c"]);
  });

  it("breaks only the moved link of a chain", () => {
    assert.deepEqual(ids(brokenBranches(moveQuestionBefore([p, c2, g], "c2", "p"))), ["c2"]);
  });

  it("reports every child left above its branch question", () => {
    const d: FormQuestion = { id: "d", type: "number", label: "Copies", show_if: { question_id: "p", option_ids: ["o1"] } };
    assert.deepEqual(ids(brokenBranches(moveQuestionBefore([p, c, d, x], "p", null))), ["c", "d"]);
  });

  it("matches what normalizeQuestions drops", () => {
    const cases = [
      moveQuestionBefore(base, "c", "p"),
      moveQuestionBefore(base, "p", null),
      moveQuestionBefore([p, c2, g], "c2", "p"),
      moveQuestionBefore([p, c2, g, k, kc], "k", null),
      moveQuestionBefore([p, c2, g, k, kc], "kc", "c2"),
    ];
    for (const moved of cases) {
      const broken = new Set(ids(brokenBranches(moved)));
      const normalized = normalizeQuestions(moved, []);
      for (const [i, question] of normalized.entries()) {
        if (broken.has(question.id)) assert.equal(question.show_if, undefined, `${question.id} loses its branch`);
        else assert.deepEqual(question.show_if, moved[i].show_if, `${question.id} keeps its branch`);
      }
    }
  });
});

describe("clearedBranchesMessage", () => {
  it("names one question", () => {
    assert.equal(
      clearedBranchesMessage([c]),
      "“Paper size” now always shows: its branch question is no longer above it.",
    );
    assert.equal(
      clearedBranchesMessage([{ ...c, label: "  " }]),
      "“Untitled question” now always shows: its branch question is no longer above it.",
    );
  });

  it("counts several", () => {
    assert.equal(
      clearedBranchesMessage([c, kc]),
      "2 questions now always show: their branch questions are no longer above them.",
    );
  });
});
