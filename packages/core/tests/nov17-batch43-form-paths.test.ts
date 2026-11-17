import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApiContext } from "@alhc/core/api/core/context";
import { cleanQuestions, duplicateForm, setFormLive, updateForm } from "@alhc/core/api/forms/mutations";
import { FORM_CHANGED_ELSEWHERE } from "@alhc/core/api/forms/model";
import {
  addPath,
  applyPaths,
  buildFlow,
  canPlaceIn,
  canShowTogether,
  checkboxToYesNo,
  clearBranch,
  deletePath,
  driftedPathQuestions,
  fieldAskInContainer,
  formProblems,
  groupIntoPaths,
  insertAfter,
  insertIntoContainer,
  mappingConflicts,
  moveInFlow,
  moveOutOfPath,
  movePath,
  pathAnswersText,
  pathLabel,
  placeQuestion,
  putPathsTogether,
  setPathAnswers,
  splitIntoPaths,
  splitUnavailableReason,
  withoutPathMetadata,
} from "@alhc/core/form-paths";
import {
  ensureNameQuestion,
  insertBranchQuestion,
  narrowedBranches,
  narrowedBranchesMessage,
  normalizeQuestions,
  parseQuestions,
  showInBranch,
  visibleQuestionIds,
  type FormQuestion,
} from "@alhc/core/forms";
import { toFormDef } from "@alhc/core/row-mappers";
import type { Json, Tables } from "@alhc/core/supabase/database.types";

// Batch 43 (note 143): paths that split and meet again, on top of the flat show_if list.

type Db = Parameters<typeof createApiContext>[0];
type Call = { target: string; steps: [string, unknown[]][] };
type Answer = { data: unknown; error: { code?: string; message?: string } | null };

function fakeDb(answer: (call: Call) => Answer): { db: Db; calls: Call[] } {
  const calls: Call[] = [];
  const chain = (call: Call): unknown =>
    new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === "then") {
            const result = answer(call);
            return (resolve: (value: Answer) => unknown) => resolve(result);
          }
          return (...args: unknown[]) => {
            call.steps.push([String(prop), args]);
            return chain(call);
          };
        },
      },
    );
  const start = (target: string) => {
    const call: Call = { target, steps: [] };
    calls.push(call);
    return call;
  };
  const db = { from: (table: string) => chain(start(`table:${table}`)), rpc: (fn: string) => chain(start(`rpc:${fn}`)) };
  return { db: db as unknown as Db, calls };
}

const step = (call: Call | undefined, name: string) => call?.steps.find(([s]) => s === name)?.[1];
const FORM = "44444444-4444-4444-8444-444444444444";
let counter = 0;
const nextId = () => `id-${++counter}`;

const kind: FormQuestion = {
  id: "kind",
  type: "single_select",
  label: "What do you need?",
  required: true,
  options: [
    { id: "print", label: "Print" },
    { id: "web", label: "Web" },
    { id: "video", label: "Video" },
  ],
  paths: [
    { id: "p-print", name: "Print work", option_ids: ["print"] },
    { id: "p-web", option_ids: ["web"] },
    { id: "p-other", otherwise: true },
  ],
};
const size: FormQuestion = {
  id: "size",
  type: "single_select",
  label: "Print size",
  options: [
    { id: "a4", label: "A4" },
    { id: "a3", label: "A3" },
  ],
  show_if: { question_id: "kind", option_ids: ["print"], path_id: "p-print" },
  paths: [
    { id: "p-a4", option_ids: ["a4"] },
    { id: "p-a3", option_ids: ["a3"] },
  ],
};
const a4Notes: FormQuestion = { id: "a4n", type: "short_text", label: "A4 notes", show_if: { question_id: "size", option_ids: ["a4"], path_id: "p-a4" } };
const copies: FormQuestion = { id: "copies", type: "number", label: "Copies", show_if: { question_id: "kind", option_ids: ["print"], path_id: "p-print" } };
const url: FormQuestion = { id: "url", type: "short_text", label: "Page URL", show_if: { question_id: "kind", option_ids: ["web"], path_id: "p-web" } };
// Stored with stale answers on purpose: Otherwise's answers come from the paths.
const more: FormQuestion = { id: "more", type: "long_text", label: "Tell us more", show_if: { question_id: "kind", option_ids: [], path_id: "p-other" } };
const when: FormQuestion = { id: "when", type: "date", label: "When do you need it?", maps_to: { target: "due_on" } };

const form = () => ensureNameQuestion([kind, size, a4Notes, copies, url, more, when]);
const ids = (questions: FormQuestion[]) => questions.map((q) => q.id);
const byId = (questions: FormQuestion[], id: string) => questions.find((q) => q.id === id)!;

describe("keys survive every rebuild", () => {
  it("parseQuestions keeps paths and show_if.path_id", () => {
    const parsed = parseQuestions(JSON.parse(JSON.stringify(form())) as Json);
    assert.deepEqual(byId(parsed, "kind").paths, kind.paths);
    assert.equal(byId(parsed, "url").show_if?.path_id, "p-web");
    assert.equal(byId(parsed, "a4n").show_if?.path_id, "p-a4");
  });

  it("normalizeQuestions keeps them and recomputes path answers from the paths", () => {
    const out = normalizeQuestions(form(), []);
    assert.deepEqual(byId(out, "more").show_if, { question_id: "kind", option_ids: ["video"], path_id: "p-other" });
    assert.deepEqual(byId(out, "url").show_if, { question_id: "kind", option_ids: ["web"], path_id: "p-web" });
    assert.equal(byId(out, "kind").paths?.length, 3);
  });

  it("round-trips through the editor's real save path: normalize → updateForm (cleanQuestions) → stored JSON → load", async () => {
    const edited = normalizeQuestions(form(), [], true);
    const { db, calls } = fakeDb((call) => {
      if (call.target === "table:forms") return { data: [{ id: FORM, updated_at: "2026-11-17T10:00:01.000001+00:00" }], error: null };
      return { data: null, error: null };
    });
    const saved = await updateForm(createApiContext(db), FORM, { questions: edited, expectedUpdatedAt: "2026-11-17T10:00:00+00:00" });
    assert.equal(saved.updatedAt, "2026-11-17T10:00:01.000001+00:00");
    const write = calls.find((c) => c.target === "table:forms");
    const update = step(write, "update")?.[0] as { questions: Json; accepting_responses?: boolean };
    assert.ok(!("accepting_responses" in update), "a questions save never sends Live / Off");
    assert.deepEqual(
      write?.steps.filter(([s]) => s === "eq").map(([, args]) => args),
      [
        ["id", FORM],
        ["updated_at", "2026-11-17T10:00:00+00:00"],
      ],
      "only while nobody changed it since",
    );
    // What the database keeps, read back the way the editor loads it.
    const row = { id: FORM, project_id: "p", title: "T", description: null, questions: JSON.parse(JSON.stringify(update.questions)), destination_section_id: null, accepting_responses: true, send_confirmation: true, confirmation_message: null, created_by: null, created_at: "", updated_at: "", deleted_at: null } as Tables<"forms">;
    const loaded = normalizeQuestions(ensureNameQuestion(toFormDef(row).questions), []);
    assert.deepEqual(loaded, edited);
  });
});

describe("the flow", () => {
  it("draws blocks in path order with nested paths inside, and where the paths meet", () => {
    const flow = buildFlow(normalizeQuestions(form(), []));
    assert.equal(flow.inOrder, true);
    assert.deepEqual(flow.nodes.map((n) => n.question.id), ["requester_name", "kind", "when"]);
    const blocks = flow.nodes[1].blocks!;
    assert.deepEqual(blocks.map((b) => b.nodes.map((n) => n.question.id)), [["size", "copies"], ["url"], ["more"]]);
    assert.deepEqual(blocks[0].nodes[0].blocks?.map((b) => b.nodes.map((n) => n.question.id)), [["a4n"], []]);
    assert.equal(blocks[0].nodes[0].depth, 1);
  });

  it("labels paths by name, else by answers", () => {
    const q = normalizeQuestions(form(), []);
    const source = byId(q, "kind");
    assert.deepEqual(source.paths!.map((p) => pathLabel(source, p)), ["Print work", "Web", "Otherwise"]);
    assert.equal(pathAnswersText(source, source.paths![2]), "any other answer: Video");
    assert.equal(pathAnswersText(source, source.paths![0]), "answer is Print");
  });

  it("marks a path question outside its block and puts paths together", () => {
    const q = normalizeQuestions(form(), []);
    const shuffled = [...q.filter((x) => x.id !== "copies"), byId(q, "copies")];
    const flow = buildFlow(shuffled);
    assert.equal(flow.inOrder, false);
    assert.equal(flow.nodes.at(-1)?.misplaced?.pathId, "p-print");
    assert.ok(formProblems(shuffled).some((p) => p.kind === "out_of_order" && p.questionId === "kind"));
    assert.deepEqual(ids(putPathsTogether(shuffled)), ids(q));
  });

  it("walks the same way the database does: one path for a single choice, all paths meet again", () => {
    const q = normalizeQuestions(form(), []);
    assert.deepEqual([...visibleQuestionIds(q, { kind: "web" })], ["requester_name", "kind", "url", "when"]);
    assert.deepEqual([...visibleQuestionIds(q, { kind: "video" })], ["requester_name", "kind", "more", "when"]);
    assert.deepEqual([...visibleQuestionIds(q, { kind: "print", size: "a4" })], ["requester_name", "kind", "size", "a4n", "copies", "when"]);
    assert.deepEqual([...visibleQuestionIds(q, {})], ["requester_name", "kind", "when"], "a skipped split shows no path");
  });
});

describe("Otherwise and empty paths", () => {
  it("a new answer goes to Otherwise; Otherwise with no answers and no questions goes away", () => {
    const q = normalizeQuestions(form(), []);
    const added = normalizeQuestions(q.map((x) => (x.id === "kind" ? { ...x, options: [...x.options!, { id: "audio", label: "Audio" }] } : x)), []);
    assert.deepEqual(byId(added, "more").show_if?.option_ids, ["video", "audio"]);
    const noMore = q.filter((x) => x.id !== "more");
    const allClaimed = normalizeQuestions(setPathAnswers(noMore, "kind", "p-web", ["web", "video"]), []);
    assert.deepEqual(byId(allClaimed, "kind").paths?.map((p) => p.id), ["p-print", "p-web"]);
  });

  it("an Otherwise that holds questions but no answers is an error, never dropped", () => {
    const q = normalizeQuestions(setPathAnswers(normalizeQuestions(form(), []), "kind", "p-web", ["web", "video"]), []);
    assert.equal(byId(q, "more").show_if?.path_id, "p-other");
    assert.deepEqual(byId(q, "more").show_if?.option_ids, []);
    const problem = formProblems(q).find((p) => p.kind === "otherwise_empty");
    assert.equal(problem?.questionId, "kind");
    assert.throws(() => cleanQuestions(q), /Question 2 \(“What do you need\?”\): Otherwise has no answers left/);
  });

  it("a branch whose answers are all gone stays, as an error on its card (the preview and the saved form agree)", () => {
    const parent: FormQuestion = { id: "p", type: "single_select", label: "Kind", options: [{ id: "o1", label: "Print" }, { id: "o2", label: "Web" }] };
    const child: FormQuestion = { id: "c", type: "short_text", label: "Paper", show_if: { question_id: "p", option_ids: ["o1"] } };
    const before = normalizeQuestions([parent, child], []);
    const after = normalizeQuestions([{ ...parent, options: [{ id: "o2", label: "Web" }] }, child], [], true);
    assert.deepEqual(byId(after, "c").show_if, { question_id: "p", option_ids: [] }, "kept, even for save");
    assert.deepEqual([...visibleQuestionIds(after, { p: "o2" })].includes("c"), false);
    assert.equal(formProblems(after)[0]?.kind, "branch_empty");
    assert.throws(() => cleanQuestions(after), /Question 3 \(“Paper”\): This question never shows/);
    const change = narrowedBranches(before, after);
    assert.deepEqual(ids(change.emptied), ["c"]);
    assert.match(narrowedBranchesMessage(change) ?? "", /“Paper” now never shows/);
  });

  it("names the card for a question with no text", () => {
    const blank: FormQuestion = { id: "b", type: "short_text", label: "  " };
    assert.throws(() => cleanQuestions([blank]), /Question 2: Add the question’s text/);
  });

  it("finds path questions whose stored answers disagree with their path (the editor flags them on open)", () => {
    assert.deepEqual(driftedPathQuestions(form()), ["more"], "Otherwise was stored with no answers");
    assert.deepEqual(driftedPathQuestions(normalizeQuestions(form(), [])), []);
  });

  it("cleanQuestions recomputes path answers even when a writer sends stale ones", () => {
    const stale = form().map((q) => (q.id === "url" ? { ...q, show_if: { question_id: "kind", option_ids: ["print", "video"], path_id: "p-web" } } : q));
    assert.deepEqual(byId(cleanQuestions(stale), "url").show_if?.option_ids, ["web"]);
  });
});

describe("splitting", () => {
  const plain: FormQuestion = {
    id: "k",
    type: "single_select",
    label: "Kind",
    options: ["a", "b", "c"].map((id) => ({ id, label: id.toUpperCase() })),
  };
  it("gives each answer its own path when there are 6 or fewer, adopting branches that fit", () => {
    const shown: FormQuestion = { id: "x", type: "short_text", label: "For B", show_if: { question_id: "k", option_ids: ["b"] } };
    const overlap: FormQuestion = { id: "y", type: "short_text", label: "For B or C", show_if: { question_id: "k", option_ids: ["b", "c"] } };
    const after: FormQuestion = { id: "z", type: "short_text", label: "Last" };
    counter = 0;
    const { questions, paths, adopted } = splitIntoPaths([plain, after, shown, overlap], "k", undefined, nextId);
    assert.equal(paths, 3);
    assert.equal(adopted, 1);
    const k = byId(questions, "k");
    assert.deepEqual(k.paths?.map((p) => p.option_ids), [["a"], ["b"], ["c"]]);
    assert.equal(byId(questions, "x").show_if?.path_id, k.paths![1].id);
    assert.equal(byId(questions, "y").show_if?.path_id, undefined, "overlapping answers stay a plain branch");
    assert.deepEqual(ids(questions), ["k", "x", "z", "y"], "the adopted question moves into its block");
    assert.equal(buildFlow(questions).inOrder, true);
    assert.deepEqual(formProblems(questions), []);
  });

  it("past 6 answers, the picked ones get paths and the rest go to Otherwise", () => {
    const many: FormQuestion = { ...plain, options: Array.from({ length: 8 }, (_, i) => ({ id: `o${i}`, label: `O${i}` })) };
    const { questions } = splitIntoPaths([many], "k", ["o1", "o3"], nextId);
    const k = byId(questions, "k");
    assert.deepEqual(k.paths?.map((p) => (p.otherwise ? "otherwise" : p.option_ids)), [["o1"], ["o3"], "otherwise"]);
  });

  it("groupIntoPaths only groups identical, non-overlapping answer sets", () => {
    const q: FormQuestion[] = [
      plain,
      { id: "1", type: "short_text", label: "1", show_if: { question_id: "k", option_ids: ["a"] } },
      { id: "2", type: "short_text", label: "2", show_if: { question_id: "k", option_ids: ["a"] } },
      { id: "3", type: "short_text", label: "3", show_if: { question_id: "k", option_ids: ["a", "b"] } },
      { id: "4", type: "short_text", label: "4", show_if: { question_id: "k", option_ids: ["c"] } },
    ];
    assert.deepEqual(groupIntoPaths(q, "k"), [
      { optionIds: ["a"], questionIds: ["1", "2"] },
      { optionIds: ["c"], questionIds: ["4"] },
    ]);
  });

  it("checkboxes and the name question don't split; paths stop at 3 levels", () => {
    assert.match(splitUnavailableReason([], { id: "c", type: "checkbox", label: "Rush" }) ?? "", /Yes \/ No/);
    assert.match(splitUnavailableReason([], { ...plain, options: [{ id: "a", label: "A" }] }) ?? "", /second answer/);
    const q = normalizeQuestions(form(), []);
    // size's paths are level 2; a split inside them would be level 3 (allowed), one more would not.
    const lvl3: FormQuestion = { ...plain, id: "l3", show_if: { question_id: "size", option_ids: ["a4"], path_id: "p-a4" } };
    const withLvl3 = normalizeQuestions(insertIntoContainer(q, { sourceId: "size", pathId: "p-a4" }, lvl3), []);
    assert.equal(splitUnavailableReason(withLvl3, byId(withLvl3, "l3")), null);
    const split3 = splitIntoPaths(withLvl3, "l3", undefined, nextId).questions;
    const lvl4: FormQuestion = { ...plain, id: "l4" };
    const pathOfL3 = byId(split3, "l3").paths![0].id;
    const withLvl4 = normalizeQuestions(insertIntoContainer(split3, { sourceId: "l3", pathId: pathOfL3 }, lvl4), []);
    assert.match(splitUnavailableReason(withLvl4, byId(withLvl4, "l4")) ?? "", /3 levels/);
  });

  it("turns a checkbox into Yes / No, keeping its branches on Yes", () => {
    const rush: FormQuestion = { id: "r", type: "checkbox", label: "Rush" };
    const by: FormQuestion = { id: "by", type: "date", label: "Needed by", show_if: { question_id: "r", option_ids: ["true"] } };
    counter = 0;
    const out = checkboxToYesNo([rush, by], "r", nextId);
    assert.equal(byId(out, "r").type, "single_select");
    assert.deepEqual(byId(out, "by").show_if?.option_ids, ["id-1"]);
  });
});

describe("editing paths", () => {
  it("adds a path before Otherwise, taking its answers off other paths", () => {
    counter = 0;
    const q = normalizeQuestions(form(), []);
    const { questions, pathId } = addPath(q, "kind", ["video"], nextId);
    const paths = byId(normalizeQuestions(questions, []), "kind").paths!;
    assert.deepEqual(paths.map((p) => p.id), ["p-print", "p-web", pathId, "p-other"]);
  });

  it("moves paths with their blocks (Otherwise stays last)", () => {
    const q = normalizeQuestions(form(), []);
    const moved = movePath(q, "kind", "p-web", -1);
    assert.deepEqual(byId(moved, "kind").paths?.map((p) => p.id), ["p-web", "p-print", "p-other"]);
    assert.deepEqual(ids(moved).slice(2, 6), ["url", "size", "a4n", "copies"]);
    assert.equal(movePath(q, "kind", "p-other", -1), q);
  });

  it("deletes a path, keeping its questions on the main flow or deleting them", () => {
    const q = normalizeQuestions(form(), []);
    const kept = deletePath(q, "kind", "p-web", "keep");
    assert.equal(byId(kept, "url").show_if, undefined);
    assert.deepEqual(ids(kept), ["requester_name", "kind", "size", "a4n", "copies", "more", "url", "when"], "after the paths meet");
    assert.ok(!ids(deletePath(q, "kind", "p-print", "delete")).includes("a4n"), "nested questions go with it");
  });

  it("fewer than 2 paths dissolves the split into a plain branch on the same answers", () => {
    const q = normalizeQuestions(form().filter((x) => x.id !== "more"), []);
    const twoLeft = deletePath(q, "kind", "p-other", "delete");
    const one = deletePath(twoLeft, "kind", "p-web", "delete");
    assert.equal(byId(one, "kind").paths, undefined);
    assert.deepEqual(byId(one, "copies").show_if, { question_id: "kind", option_ids: ["print"] });
    assert.equal(byId(one, "a4n").show_if?.path_id, "p-a4", "nested paths stay");
  });
});

describe("block-aware moves", () => {
  it("swaps a question with its neighbor in the same flow, carrying its paths", () => {
    const q = normalizeQuestions(form(), []);
    const down = moveInFlow(q, "size", 1);
    assert.ok(down && "questions" in down);
    assert.deepEqual(ids(down.questions).slice(2, 5), ["copies", "size", "a4n"]);
    const main = moveInFlow(q, "kind", 1);
    assert.ok(main && "questions" in main);
    assert.deepEqual(ids(main.questions), ["requester_name", "when", "kind", "size", "a4n", "copies", "url", "more"]);
  });

  it("reports a path's edge instead of leaving it", () => {
    const q = normalizeQuestions(form(), []);
    assert.deepEqual(moveInFlow(q, "url", 1), { edge: "end", container: { sourceId: "kind", pathId: "p-web" } });
    assert.deepEqual(moveInFlow(q, "size", -1), { edge: "start", container: { sourceId: "kind", pathId: "p-print" } });
    assert.equal(moveInFlow(q, "requester_name", -1), null);
  });

  it("moves a question out of its path, with what depends on it", () => {
    const q = normalizeQuestions(form(), []);
    const out = moveOutOfPath(q, "size", "end");
    assert.equal(byId(out, "size").show_if, undefined);
    assert.deepEqual(ids(out).slice(-3), ["size", "a4n", "when"]);
  });

  it("joins a path, and never into its own paths or past the limit; the name stays on the main flow", () => {
    const q = normalizeQuestions(form(), []);
    const joined = placeQuestion(q, "when", { sourceId: "kind", pathId: "p-web" }, null);
    assert.deepEqual(byId(normalizeQuestions(joined, []), "when").show_if, { question_id: "kind", option_ids: ["web"], path_id: "p-web" });
    assert.equal(canPlaceIn(q, "kind", { sourceId: "kind", pathId: "p-web" }), false);
    assert.equal(canPlaceIn(q, "requester_name", { sourceId: "kind", pathId: "p-web" }), false);
    assert.equal(placeQuestion(q, "requester_name", { sourceId: "kind", pathId: "p-web" }, null), q);
  });

  it("inserts into a path's end, after a question's unit, and through the Branch button", () => {
    const q = normalizeQuestions(form(), []);
    const blank: FormQuestion = { id: "new", type: "short_text", label: "" };
    assert.equal(ids(insertIntoContainer(q, { sourceId: "kind", pathId: "p-print" }, blank)).indexOf("new"), 5);
    const below = insertAfter(q, "size", blank);
    assert.equal(ids(below).indexOf("new"), 4, "after size's own paths");
    assert.equal(byId(below, "new").show_if?.path_id, "p-print");
    const viaBranch = insertBranchQuestion(q, "kind", "video", blank);
    assert.equal(byId(viaBranch, "new").show_if?.path_id, "p-other");
    const shown = showInBranch(q, "kind", "when", "web", true);
    assert.equal(byId(shown, "when").show_if?.path_id, "p-web");
  });
});

describe("mapping guards", () => {
  const priority = (id: string, rule?: FormQuestion["show_if"]): FormQuestion => ({
    id,
    type: "short_text",
    label: id,
    maps_to: { target: "field", field_id: "f-priority" },
    ...(rule ? { show_if: rule } : {}),
  });

  it("a field asked in one path of a single choice can be asked in a sibling path", () => {
    const q = applyPaths([...form(), priority("pp", { question_id: "kind", option_ids: ["print"], path_id: "p-print" })]);
    const placed = putPathsTogether(q);
    assert.deepEqual(fieldAskInContainer(placed, "f-priority", { sourceId: "kind", pathId: "p-web" }), { asked: true, allowed: true, askedIn: "Print work" });
    assert.equal(fieldAskInContainer(placed, "f-priority", null).allowed, false, "not on the main flow");
    assert.equal(fieldAskInContainer(placed, "f-priority", { sourceId: "kind", pathId: "p-print" }).allowed, false, "not twice in a path");
  });

  it("warns when two questions that can both show fill the same detail (multiple choice paths can)", () => {
    const multi = applyPaths(form().map((x) => (x.id === "kind" ? { ...x, type: "multi_select" as const } : x)));
    const both = putPathsTogether(
      applyPaths(
        [
          ...multi,
          priority("pp", { question_id: "kind", option_ids: ["print"], path_id: "p-print" }),
          priority("pw", { question_id: "kind", option_ids: ["web"], path_id: "p-web" }),
        ]
      ),
    );
    assert.equal(canShowTogether(both, "pp", "pw"), true);
    assert.deepEqual(mappingConflicts(both).map((c) => c.questionId).sort(), ["pp", "pw"]);
    const single = putPathsTogether(applyPaths([...form(), priority("pp", { question_id: "kind", option_ids: ["print"], path_id: "p-print" }), priority("pw", { question_id: "kind", option_ids: ["web"], path_id: "p-web" })]));
    assert.deepEqual(mappingConflicts(single), []);
  });
});

describe("round 1 review fixes", () => {
  const ab: FormQuestion = {
    id: "s",
    type: "single_select",
    label: "Kind",
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
    paths: [
      { id: "pa", option_ids: ["a"] },
      { id: "po", otherwise: true },
    ],
  };
  const inA: FormQuestion = { id: "qa", type: "short_text", label: "For A", show_if: { question_id: "s", option_ids: ["a"], path_id: "pa" } };
  const inO: FormQuestion = { id: "qo", type: "short_text", label: "For B", show_if: { question_id: "s", option_ids: ["b"], path_id: "po" } };

  it("deleting a path down to one keeps the last path's questions on exactly the answers they had", () => {
    const out = normalizeQuestions(deletePath(applyPaths([ab, inA, inO]), "s", "pa", "delete"), []);
    assert.equal(byId(out, "s").paths, undefined);
    assert.deepEqual(byId(out, "qo").show_if, { question_id: "s", option_ids: ["b"] }, "not A too");
  });

  it("a branch shown for every answer isn't adopted as a path, so splitting still makes two", () => {
    const plain: FormQuestion = { ...ab, paths: undefined };
    const every: FormQuestion = { id: "e", type: "short_text", label: "Any answer", show_if: { question_id: "s", option_ids: ["a", "b"] } };
    const { questions, paths, adopted } = splitIntoPaths([plain, every], "s", undefined, nextId);
    assert.equal(paths, 2);
    assert.equal(adopted, 0);
    assert.equal(byId(questions, "s").paths?.length, 2);
    assert.equal(byId(questions, "e").show_if?.path_id, undefined);
  });

  it("Branch → Create new question lands after a branched question's own paths", () => {
    const rush: FormQuestion = { id: "r", type: "checkbox", label: "Rush" };
    const size: FormQuestion = { ...ab, id: "s", show_if: { question_id: "r", option_ids: ["true"] }, paths: [{ id: "pa", option_ids: ["a"] }, { id: "pb", option_ids: ["b"] }] };
    const ia: FormQuestion = { id: "ia", type: "short_text", label: "A note", show_if: { question_id: "s", option_ids: ["a"], path_id: "pa" } };
    const next = insertBranchQuestion(applyPaths([rush, size, ia]), "r", "true", { id: "new", type: "short_text", label: "" });
    assert.deepEqual(ids(next), ["r", "s", "ia", "new"]);
    assert.equal(buildFlow(next).inOrder, true);
  });

  it("dragging a path question out to its split question's flow keeps the split question's own rule", () => {
    const color: FormQuestion = { id: "c", type: "single_select", label: "Color", options: [{ id: "red", label: "Red" }, { id: "blue", label: "Blue" }] };
    const size: FormQuestion = { ...ab, id: "s", show_if: { question_id: "c", option_ids: ["red"] }, paths: [{ id: "pa", option_ids: ["a"] }, { id: "pb", option_ids: ["b"] }] };
    const note: FormQuestion = { id: "n", type: "short_text", label: "Note", show_if: { question_id: "s", option_ids: ["a"], path_id: "pa" } };
    const q = applyPaths([color, size, note]);
    assert.deepEqual(byId(placeQuestion(q, "n", null, null), "n").show_if, { question_id: "c", option_ids: ["red"] }, "like Move out of the path");
    assert.deepEqual(byId(moveOutOfPath(q, "n", "end"), "n").show_if, { question_id: "c", option_ids: ["red"] });
  });

  it("joining a path counts the nesting of everything that moves with the question", () => {
    // x (main) has a plain dependent y that splits; y's paths are level 1. Moving x into a level-2 path would
    // put y's paths at level 3 (allowed); one level deeper would not.
    const x: FormQuestion = { id: "x", type: "checkbox", label: "X" };
    const y: FormQuestion = { ...ab, id: "y", show_if: { question_id: "x", option_ids: ["true"] }, paths: [{ id: "ya", option_ids: ["a"] }, { id: "yb", option_ids: ["b"] }] };
    const q = normalizeQuestions(form(), []);
    const withXY = applyPaths([...q, x, y]);
    assert.equal(canPlaceIn(withXY, "x", { sourceId: "size", pathId: "p-a4" }), true);
    const deeper: FormQuestion = { ...ab, id: "d", show_if: { question_id: "size", option_ids: ["a4"], path_id: "p-a4" }, paths: [{ id: "da", option_ids: ["a"] }, { id: "db", option_ids: ["b"] }] };
    const withDeeper = putPathsTogether(applyPaths([...withXY, deeper]));
    assert.equal(canPlaceIn(withDeeper, "x", { sourceId: "d", pathId: "da" }), false);
  });

  it("Always show inside a path keeps the question in its path", () => {
    const rush: FormQuestion = { id: "r", type: "checkbox", label: "Rush", show_if: { question_id: "kind", option_ids: ["web"], path_id: "p-web" } };
    const by: FormQuestion = { id: "by", type: "date", label: "Needed by", show_if: { question_id: "r", option_ids: ["true"] } };
    const q = putPathsTogether(applyPaths([...normalizeQuestions(form(), []), rush, by]));
    const cleared = clearBranch(q, "by");
    assert.deepEqual(byId(cleared, "by").show_if, { question_id: "kind", option_ids: ["web"], path_id: "p-web" });
    assert.equal(buildFlow(cleared).inOrder, true);
    assert.deepEqual(byId(showInBranch(q, "r", "by", "true", false), "by").show_if?.path_id, "p-web");
  });
});

describe("the public form", () => {
  it("gets the rules without path names", () => {
    const out = withoutPathMetadata(normalizeQuestions(form(), []));
    assert.ok(out.every((q) => !q.paths && !q.show_if?.path_id));
    assert.deepEqual(byId(out, "url").show_if, { question_id: "kind", option_ids: ["web"] });
  });
});

describe("conflict-checked writes and Duplicate form", () => {
  it("refuses a save when someone else changed the form, and says so", async () => {
    const { db } = fakeDb((call) => {
      const select = step(call, "select")?.[0];
      if (step(call, "update")) return { data: [], error: null };
      if (select === "updated_at") return { data: { updated_at: "2026-11-17T11:00:00+00:00" }, error: null };
      return { data: null, error: null };
    });
    await assert.rejects(() => setFormLive(createApiContext(db), FORM, true, "2026-11-17T10:00:00+00:00"), (e: Error & { code?: string }) => {
      assert.equal(e.code, "conflict");
      assert.equal(e.message, FORM_CHANGED_ELSEWHERE);
      return true;
    });
  });

  it("a zero-row update with the same version is a role refusal", async () => {
    const { db } = fakeDb((call) => {
      if (step(call, "update")) return { data: [], error: null };
      return { data: { updated_at: "2026-11-17T10:00:00+00:00" }, error: null };
    });
    await assert.rejects(() => updateForm(createApiContext(db), FORM, { title: "X", expectedUpdatedAt: "2026-11-17T10:00:00+00:00" }), { code: "forbidden" });
  });

  it("duplicates a form: off, with (copy) after its name, without mappings to removed fields", async () => {
    const stored = [
      { id: "a", type: "short_text", label: "Kept", maps_to: { target: "field", field_id: "f-live" } },
      { id: "b", type: "short_text", label: "Gone", maps_to: { target: "field", field_id: "f-removed" } },
      { id: "c", type: "short_text", label: "Title", maps_to: { target: "title" } },
    ];
    const { db, calls } = fakeDb((call) => {
      if (step(call, "insert")) return { data: { id: "copy" }, error: null };
      if (call.target === "table:custom_fields") return { data: [{ id: "f-live" }], error: null };
      return { data: { id: FORM, project_id: "p", title: "Design requests", description: "d", questions: stored, destination_section_id: null, accepting_responses: true, send_confirmation: true, confirmation_message: null, verified_domains_only: true }, error: null };
    });
    assert.equal(await duplicateForm(createApiContext(db), FORM), "copy");
    const insert = step(calls.find((c) => step(c, "insert")), "insert")?.[0] as Record<string, unknown>;
    assert.equal(insert.title, "Design requests (copy)");
    assert.equal(insert.accepting_responses, false);
    assert.equal(insert.verified_domains_only, true);
    assert.deepEqual(
      (insert.questions as { id: string; maps_to?: unknown }[]).map((q) => [q.id, Boolean(q.maps_to)]),
      [["a", true], ["b", false], ["c", true]],
    );
  });
});

describe("applyPaths", () => {
  it("is idempotent", () => {
    const once = applyPaths(normalizeQuestions(form(), []));
    assert.deepEqual(applyPaths(once), once);
  });
});
