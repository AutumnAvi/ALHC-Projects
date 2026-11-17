// Batch 43 (Nov 17, note 143; docs/design/form-branching.md Phase 1, docs/design/form-builder-review.md §4–5):
// form paths that split and meet again. A path is builder metadata on top of the flat question list the
// database already walks: a choice question carries `paths`, and each question of a path carries
// `show_if = { question_id: <the split question>, option_ids, path_id }`. `paths` is the source: every
// path question's `option_ids` is recomputed from its path on each edit and on each save (applyPaths), so
// the stored rules submit_form walks never drift from the blocks the builder draws.
//
// Rules (checked here and again by the save layer, cleanQuestions; the database ignores the extra keys):
// - only Single and Multiple choice questions split (a checkbox can't: "not checked" is stored as no answer);
// - 2–6 paths, counting Otherwise; an answer is on one path at most; Otherwise holds the answers no other
//   path has (it exists only while some are left, and an Otherwise that holds questions but no answers is an
//   error, never dropped);
// - a path's questions sit together, right after their split question, in path order (nested paths inside
//   their path), so "where the paths meet" is the first question after the last block;
// - paths nest at most 3 levels; the requester's name question is never in a path.
//
// Pure helpers only (no React, no database): the form editor (components/forms/form-flow.tsx) draws and
// edits with them, and the tests run the same functions.

import type { Json } from "./supabase/database.types";
import type { BranchRule, FormPath, FormQuestion, MapTarget, QuestionOption } from "./forms";

export const MIN_PATHS = 2;
export const MAX_PATHS = 6;
export const MAX_PATH_DEPTH = 3;
export const MAX_PATH_NAME = 60;
export const OTHERWISE_LABEL = "Otherwise";
// Path names aren't drawn on the form, but get_public_form returns every question key to anyone with the
// link while the form is live, so they aren't private (the builder says so next to the name box).
export const PATH_NAME_NOTE = "Path names aren’t shown on the form, but they aren’t private either. Don’t put internal notes here.";

const CHECKBOX_ANSWER = "true";

function isChoiceType(type: FormQuestion["type"]): boolean {
  return type === "single_select" || type === "multi_select";
}

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

// The one way a branch rule is built, so path_id is never dropped by accident.
export function branchRule(questionId: string, optionIds: readonly string[], pathId?: string | null): BranchRule {
  return pathId
    ? { question_id: questionId, option_ids: [...optionIds], path_id: pathId }
    : { question_id: questionId, option_ids: [...optionIds] };
}

function record(value: Json | undefined): Record<string, Json | undefined> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

// A question's stored `paths`, keeping only well-formed entries (parseQuestions calls this).
export function parsePaths(value: Json | undefined): FormPath[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const paths = value.flatMap((raw): FormPath[] => {
    const p = record(raw);
    if (!p || typeof p.id !== "string" || !p.id) return [];
    const path: FormPath = { id: p.id };
    if (typeof p.name === "string" && p.name) path.name = p.name;
    if (p.otherwise === true) path.otherwise = true;
    else path.option_ids = Array.isArray(p.option_ids) ? p.option_ids.filter((id): id is string => typeof id === "string") : [];
    return [path];
  });
  return paths.length ? paths : undefined;
}

export function sourceOptions(source: FormQuestion): QuestionOption[] {
  return isChoiceType(source.type) ? (source.options ?? []) : [];
}

export function isSplit(question: FormQuestion): boolean {
  return isChoiceType(question.type) && Boolean(question.paths?.length);
}

export function findPath(source: FormQuestion, pathId: string | undefined | null): FormPath | undefined {
  return pathId ? source.paths?.find((p) => p.id === pathId) : undefined;
}

// The answers no regular path has (Otherwise's answers).
export function leftoverOptionIds(source: FormQuestion): string[] {
  const claimed = new Set((source.paths ?? []).flatMap((p) => (p.otherwise ? [] : (p.option_ids ?? []))));
  return sourceOptions(source)
    .map((o) => o.id)
    .filter((id) => !claimed.has(id));
}

// The answers that lead to a path, in the question's option order.
export function pathOptionIds(source: FormQuestion, path: FormPath): string[] {
  if (path.otherwise) return leftoverOptionIds(source);
  const mine = new Set(path.option_ids ?? []);
  return sourceOptions(source)
    .map((o) => o.id)
    .filter((id) => mine.has(id));
}

export function otherwisePath(source: FormQuestion): FormPath | undefined {
  return source.paths?.find((p) => p.otherwise);
}

function optionLabels(source: FormQuestion, ids: readonly string[]): string[] {
  const labels = new Map(sourceOptions(source).map((o) => [o.id, o.label.trim() || "Untitled answer"] as const));
  return ids.flatMap((id) => (labels.has(id) ? [labels.get(id)!] : []));
}

// "Print", "Print or Web", "Print, Web, or Video".
export function orList(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}`;
}

// What the builder calls a path: its name, else its answers ("Print or Web"), else Otherwise.
export function pathLabel(source: FormQuestion, path: FormPath): string {
  const name = path.name?.trim();
  if (name) return name;
  if (path.otherwise) return OTHERWISE_LABEL;
  return orList(optionLabels(source, pathOptionIds(source, path))) || "Untitled path";
}

// The path header's second half: "answer is Print", "any other answer: Video", "no answers left".
export function pathAnswersText(source: FormQuestion, path: FormPath): string {
  const labels = optionLabels(source, pathOptionIds(source, path));
  if (path.otherwise) return labels.length ? `any other answer: ${labels.join(", ")}` : "no answers left";
  if (!labels.length) return "no answers left";
  return `answer is ${orList(labels)}`;
}

// ---------------------------------------------------------------------------------------------
// Where each question sits: the main flow, or a path block (by its show_if chain)
// ---------------------------------------------------------------------------------------------

export const MAIN_FLOW = "main";

// A container is the main flow or one path block of one split question.
export type FlowContainer = { sourceId: string; pathId: string } | null;

const SEP = "\u0000";
export function blockKey(sourceId: string, pathId: string): string {
  return `${sourceId}${SEP}${pathId}`;
}
function decodeKey(key: string): { sourceId: string; pathId: string } | null {
  if (key === MAIN_FLOW) return null;
  const at = key.indexOf(SEP);
  return { sourceId: key.slice(0, at), pathId: key.slice(at + 1) };
}
export function containerKey(container: FlowContainer): string {
  return container ? blockKey(container.sourceId, container.pathId) : MAIN_FLOW;
}

// question id → the container it belongs to. A path question belongs to its path's block; a question shown
// by a plain branch belongs wherever its parent does; everything else is on the main flow. A parent must
// come earlier (the database's rule); a rule on a later or missing question counts as no rule.
export function questionOwners(questions: readonly FormQuestion[]): Map<string, string> {
  const index = new Map(questions.map((q, i) => [q.id, i] as const));
  const owner = new Map<string, string>();
  questions.forEach((q, i) => {
    const rule = q.show_if;
    let key = MAIN_FLOW;
    const at = rule ? index.get(rule.question_id) : undefined;
    if (rule && at !== undefined && at < i) {
      const parent = questions[at];
      key = isSplit(parent) && findPath(parent, rule.path_id) ? blockKey(parent.id, rule.path_id!) : (owner.get(parent.id) ?? MAIN_FLOW);
    }
    owner.set(q.id, key);
  });
  return owner;
}

function parentKey(key: string, owner: Map<string, string>): string | null {
  const decoded = decodeKey(key);
  return decoded ? (owner.get(decoded.sourceId) ?? MAIN_FLOW) : null;
}

// Whether `key` is `container` or sits inside it.
function within(key: string, container: string, owner: Map<string, string>): boolean {
  for (let k: string | null = key; k !== null; k = parentKey(k, owner)) {
    if (k === container) return true;
  }
  return false;
}

// How many path blocks enclose a container (the main flow is 0).
function keyDepth(key: string, owner: Map<string, string>): number {
  let depth = 0;
  for (let k = parentKey(key, owner); k !== null; k = parentKey(k, owner)) depth++;
  return key === MAIN_FLOW ? 0 : depth;
}

export function containerOf(questionId: string, owner: Map<string, string>): FlowContainer {
  return decodeKey(owner.get(questionId) ?? MAIN_FLOW);
}

// The rule a question gets when it joins a container (null = the main flow: always shown).
export function containerRule(questions: readonly FormQuestion[], container: FlowContainer): BranchRule | null {
  if (!container) return null;
  const source = questions.find((q) => q.id === container.sourceId);
  const path = source ? findPath(source, container.pathId) : undefined;
  return source && path ? branchRule(source.id, pathOptionIds(source, path), path.id) : null;
}

// ---------------------------------------------------------------------------------------------
// The flow the builder draws
// ---------------------------------------------------------------------------------------------

export type FlowNode = {
  question: FormQuestion;
  // Position in the flat list (the number the builder and the form show).
  index: number;
  // Path blocks around it.
  depth: number;
  // A split question's blocks, in path order.
  blocks: FlowBlock[] | null;
  // It belongs to a path but sits outside that path's block (old data; "Put paths together" fixes it).
  misplaced: { sourceId: string; pathId: string } | null;
};

export type FlowBlock = {
  sourceId: string;
  path: FormPath;
  // The path's place among its question's paths (its color).
  position: number;
  optionIds: string[];
  nodes: FlowNode[];
};

export type Flow = { nodes: FlowNode[]; inOrder: boolean; owner: Map<string, string> };

// Walks the flat list in order. A split question's blocks follow it, each taking the questions of its path
// while they come one after another; a question of a path that already closed is drawn where it is, marked
// misplaced (and the form is "out of order").
export function buildFlow(questions: readonly FormQuestion[]): Flow {
  const owner = questionOwners(questions);
  let i = 0;
  let inOrder = true;
  const parse = (container: string, depth: number): FlowNode[] => {
    const nodes: FlowNode[] = [];
    while (i < questions.length) {
      const question = questions[i];
      const key = owner.get(question.id) ?? MAIN_FLOW;
      if (!within(key, container, owner)) break;
      const node: FlowNode = { question, index: i, depth, blocks: null, misplaced: null };
      if (key !== container) {
        node.misplaced = decodeKey(key);
        inOrder = false;
      }
      i++;
      if (isSplit(question)) {
        node.blocks = (question.paths ?? []).map((path, position) => ({
          sourceId: question.id,
          path,
          position,
          optionIds: pathOptionIds(question, path),
          nodes: parse(blockKey(question.id, path.id), depth + 1),
        }));
      }
      nodes.push(node);
    }
    return nodes;
  };
  const nodes = parse(MAIN_FLOW, 0);
  return { nodes, inOrder, owner };
}

// The same questions with every path's questions together, right after their split question, in path order
// (questions keep their order within each container). Moving a question earlier past questions that don't
// depend on it, or later past ones it doesn't depend on, never breaks a branch, so this changes only the
// order people see.
export function canonicalOrder(questions: readonly FormQuestion[]): FormQuestion[] {
  const owner = questionOwners(questions);
  const children = new Map<string, FormQuestion[]>();
  for (const q of questions) {
    const key = owner.get(q.id) ?? MAIN_FLOW;
    children.set(key, [...(children.get(key) ?? []), q]);
  }
  const out: FormQuestion[] = [];
  const emit = (key: string) => {
    for (const q of children.get(key) ?? []) {
      out.push(q);
      if (isSplit(q)) for (const path of q.paths ?? []) emit(blockKey(q.id, path.id));
    }
  };
  emit(MAIN_FLOW);
  return out.length === questions.length ? out : [...questions];
}

// "Put paths together": the canonical order (the same array when it's already in order).
export function putPathsTogether(questions: FormQuestion[]): FormQuestion[] {
  const next = canonicalOrder(questions);
  return next.every((q, i) => q === questions[i]) ? questions : next;
}

// The last index of a question's unit (itself and its path blocks), for callers outside this module.
export function questionUnitEnd(questions: readonly FormQuestion[], index: number): number {
  return index < 0 ? index : unitEnd(questions, index, questionOwners(questions));
}

// The last index of a question's unit: the question and its path blocks (nested ones included).
function unitEnd(questions: readonly FormQuestion[], index: number, owner: Map<string, string>): number {
  const q = questions[index];
  if (!isSplit(q)) return index;
  let end = index;
  for (let j = index + 1; j < questions.length; j++) {
    if (insideSource(owner.get(questions[j].id) ?? MAIN_FLOW, q.id, owner)) end = j;
    else break;
  }
  return end;
}

function insideSource(key: string, sourceId: string, owner: Map<string, string>): boolean {
  for (let k: string | null = key; k !== null && k !== MAIN_FLOW; k = parentKey(k, owner)) {
    if (decodeKey(k)?.sourceId === sourceId) return true;
  }
  return false;
}

// The deepest path nesting inside a question's unit, counted in paths (empty ones too), relative to the
// question: 0 for a question that doesn't split, 1 for one whose paths hold no further split, and so on.
function unitPathDepth(questions: readonly FormQuestion[], index: number, owner: Map<string, string>): number {
  const end = unitEnd(questions, index, owner);
  const base = keyDepth(owner.get(questions[index].id) ?? MAIN_FLOW, owner);
  let deepest = 0;
  for (let j = index; j <= end; j++) {
    if (isSplit(questions[j])) deepest = Math.max(deepest, keyDepth(owner.get(questions[j].id) ?? MAIN_FLOW, owner) - base + 1);
  }
  return deepest;
}

// The deepest path nesting a question carries with it when it changes container: its own paths and those of
// the questions that move along (movingGroup), relative to its current container.
function groupPathDepth(questions: readonly FormQuestion[], id: string, owner: Map<string, string>): number {
  const base = keyDepth(owner.get(id) ?? MAIN_FLOW, owner);
  let deepest = 0;
  for (const gid of movingGroup(questions, id)) {
    const at = questions.findIndex((q) => q.id === gid);
    deepest = Math.max(deepest, keyDepth(owner.get(gid) ?? MAIN_FLOW, owner) - base + unitPathDepth(questions, at, owner));
  }
  return deepest;
}

// How deep a split question's paths would be (1 = top-level paths).
export function splitDepth(questions: readonly FormQuestion[], sourceId: string): number {
  const owner = questionOwners(questions);
  return keyDepth(owner.get(sourceId) ?? MAIN_FLOW, owner) + 1;
}

// ---------------------------------------------------------------------------------------------
// Keeping paths and their rules in step (normalizeQuestions and cleanQuestions run this)
// ---------------------------------------------------------------------------------------------

// Cleans every question's paths and recomputes every path question's show_if.option_ids from its path:
// - paths only on choice questions (never the name question); one Otherwise at most; ids unique on the form;
// - a regular path keeps only its question's answers, and an answer stays on the first path that has it;
// - an Otherwise with no answers left goes away unless questions are in it (then it's an error to fix);
// - fewer than 2 paths dissolve: their questions keep showing for the same answers, as plain branches;
// - a show_if.path_id naming a path that isn't there is dropped (the rule itself stays).
// `trimNames` (saving) trims path names and drops blank ones; while typing they're kept as typed.
export function applyPaths(questions: FormQuestion[], options: { trimNames?: boolean } = {}): FormQuestion[] {
  const used = new Set<string>();
  const referenced = new Set<string>();
  for (const q of questions) {
    if (q.show_if?.path_id) referenced.add(blockKey(q.show_if.question_id, q.show_if.path_id));
  }
  // source id → what its path questions' rules become.
  const rules = new Map<string, { paths: Map<string, string[]>; dissolved: boolean }>();
  const cleaned = questions.map((q) => {
    if (!q.paths) return q;
    const next: FormQuestion = { ...q };
    if (!isChoiceType(q.type) || q.role === "name") {
      delete next.paths;
      return next;
    }
    const ids = new Set(sourceOptions(q).map((o) => o.id));
    const claimed = new Set<string>();
    let otherwise = false;
    const paths: FormPath[] = [];
    for (const path of q.paths) {
      if (!path.id || used.has(path.id)) continue;
      const kept: FormPath = { id: path.id };
      const name = options.trimNames ? path.name?.trim().slice(0, MAX_PATH_NAME) : path.name;
      if (name) kept.name = name;
      if (path.otherwise) {
        if (otherwise) continue;
        otherwise = true;
        kept.otherwise = true;
      } else {
        kept.option_ids = [...new Set(path.option_ids ?? [])].filter((id) => ids.has(id) && !claimed.has(id));
        for (const id of kept.option_ids) claimed.add(id);
      }
      used.add(path.id);
      paths.push(kept);
    }
    const leftovers = [...ids].filter((id) => !claimed.has(id));
    const finalPaths = paths.filter((p) => !p.otherwise || leftovers.length > 0 || referenced.has(blockKey(q.id, p.id)));
    const optionOrder = sourceOptions(q).map((o) => o.id);
    const byPath = new Map(
      finalPaths.map((p) => [p.id, p.otherwise ? leftovers : optionOrder.filter((id) => p.option_ids?.includes(id))] as const),
    );
    const dissolved = finalPaths.length < MIN_PATHS;
    rules.set(q.id, { paths: byPath, dissolved });
    if (dissolved) delete next.paths;
    else next.paths = finalPaths;
    return next;
  });
  return cleaned.map((q) => {
    const rule = q.show_if;
    if (!rule?.path_id) return q;
    const split = rules.get(rule.question_id);
    const optionIds = split?.paths.get(rule.path_id);
    if (!split || !optionIds) return { ...q, show_if: branchRule(rule.question_id, rule.option_ids) };
    return { ...q, show_if: branchRule(rule.question_id, optionIds, split.dissolved ? null : rule.path_id) };
  });
}

// Path questions whose stored answers don't match their path (a writer that skipped the save layer, or an
// older release that dropped the paths): the walk follows the stored rules, the builder draws the paths.
// The editor says so when the form opens and saves the paths' answers.
export function driftedPathQuestions(questions: FormQuestion[]): string[] {
  const fixed = new Map(applyPaths(questions).map((q) => [q.id, q] as const));
  return questions.flatMap((q) => {
    const want = fixed.get(q.id)?.show_if;
    if (!q.show_if?.path_id || !want) return [];
    const same = want.option_ids.length === q.show_if.option_ids.length && want.option_ids.every((id) => q.show_if!.option_ids.includes(id));
    return same ? [] : [q.id];
  });
}

// ---------------------------------------------------------------------------------------------
// Problems the builder shows on the card at fault (and cleanQuestions refuses)
// ---------------------------------------------------------------------------------------------

export type FormProblemKind =
  | "label"
  | "options"
  | "option_label"
  | "branch_empty"
  | "path_empty"
  | "otherwise_empty"
  | "too_many_paths"
  | "too_deep"
  | "out_of_order";

export type FormProblem = {
  questionId: string;
  kind: FormProblemKind;
  message: string;
  pathId?: string;
};

// Problems in the paths and branches (what can make a question never show, or the blocks unreadable).
export function pathProblems(questions: readonly FormQuestion[]): FormProblem[] {
  const problems: FormProblem[] = [];
  const flow = buildFlow(questions);
  const byId = new Map(questions.map((q) => [q.id, q] as const));
  for (const q of questions) {
    const rule = q.show_if;
    if (rule && !rule.path_id && rule.option_ids.length === 0) {
      const parent = byId.get(rule.question_id);
      problems.push({
        questionId: q.id,
        kind: "branch_empty",
        message: `This question never shows: none of the answers to “${parent?.label.trim() || "the question above"}” it was shown for are left. Pick an answer, or make it always show.`,
      });
    }
    if (!isSplit(q)) continue;
    const paths = q.paths ?? [];
    if (paths.length > MAX_PATHS) {
      problems.push({ questionId: q.id, kind: "too_many_paths", message: `A question splits into ${MAX_PATHS} paths at most (counting Otherwise). Delete ${paths.length - MAX_PATHS}.` });
    }
    const depth = keyDepth(flow.owner.get(q.id) ?? MAIN_FLOW, flow.owner) + 1;
    if (depth > MAX_PATH_DEPTH) {
      problems.push({ questionId: q.id, kind: "too_deep", message: `Paths nest ${MAX_PATH_DEPTH} levels deep at most. Move this question out of its path, or turn its paths back into one flow.` });
    }
    for (const path of paths) {
      if (pathOptionIds(q, path).length) continue;
      const hasQuestions = questions.some((x) => x.show_if?.question_id === q.id && x.show_if.path_id === path.id);
      if (path.otherwise) {
        if (hasQuestions) {
          problems.push({
            questionId: q.id,
            pathId: path.id,
            kind: "otherwise_empty",
            message: "Otherwise has no answers left, so its questions never show. Move them to another path or the main flow, or delete them.",
          });
        }
      } else {
        problems.push({
          questionId: q.id,
          pathId: path.id,
          kind: "path_empty",
          message: `${path.name?.trim() ? `The path “${path.name.trim()}”` : "This path"} has no answers, so ${hasQuestions ? "its questions never show" : "it never shows"}. Give it an answer (⋯ → Change answers), or delete it.`,
        });
      }
    }
  }
  if (!flow.inOrder) {
    const sources = new Set<string>();
    const visit = (nodes: FlowNode[]) => {
      for (const node of nodes) {
        if (node.misplaced) sources.add(node.misplaced.sourceId);
        for (const block of node.blocks ?? []) visit(block.nodes);
      }
    };
    visit(flow.nodes);
    for (const sourceId of sources) {
      problems.push({
        questionId: sourceId,
        kind: "out_of_order",
        message: "Some questions of these paths sit outside their path. Put the paths together to keep where they meet clear.",
      });
    }
  }
  return problems;
}

// Everything that stops a save, in form order (the builder opens the first one's card).
export function formProblems(questions: readonly FormQuestion[]): FormProblem[] {
  const problems: FormProblem[] = [];
  for (const q of questions) {
    if (!q.label.trim()) {
      problems.push({ questionId: q.id, kind: "label", message: q.type === "heading" ? "Add the heading’s text." : "Add the question’s text." });
    }
    if (isChoiceType(q.type)) {
      const options = q.options ?? [];
      if (!options.length) problems.push({ questionId: q.id, kind: "options", message: "Add at least one answer." });
      const blank = options.findIndex((o) => !o.label.trim());
      if (blank >= 0) problems.push({ questionId: q.id, kind: "option_label", message: `Answer ${blank + 1} needs a label.` });
    }
  }
  const order = new Map(questions.map((q, i) => [q.id, i] as const));
  return [...problems, ...pathProblems(questions)].sort((a, b) => (order.get(a.questionId) ?? 0) - (order.get(b.questionId) ?? 0));
}

// How a problem reads where the card isn't on screen (a toast, the save layer's refusal).
export function problemSummary(problem: FormProblem, questions: readonly FormQuestion[]): string {
  const at = questions.findIndex((q) => q.id === problem.questionId);
  const label = questions[at]?.label.trim();
  return `Question ${at + 1}${label ? ` (“${label}”)` : ""}: ${problem.message}`;
}

// ---------------------------------------------------------------------------------------------
// Editing paths (each returns a new list; the editor then runs normalizeQuestions)
// ---------------------------------------------------------------------------------------------

type IdFactory = () => string;
const defaultId: IdFactory = () => crypto.randomUUID();

// Why a question can't split into paths (null = it can).
export function splitUnavailableReason(questions: readonly FormQuestion[], question: FormQuestion): string | null {
  if (question.role === "name") return "The requester’s name is on every form.";
  if (question.type === "checkbox") return "A checkbox can’t split into paths (“not checked” isn’t an answer). Use a Yes / No single choice instead.";
  if (!isChoiceType(question.type)) return "Only Single choice and Multiple choice questions split into paths.";
  if (sourceOptions(question).length < MIN_PATHS) return "Add a second answer first: each path starts from an answer.";
  if (splitDepth(questions, question.id) > MAX_PATH_DEPTH) return `Paths nest ${MAX_PATH_DEPTH} levels deep at most.`;
  return null;
}

// Existing branches on a question that can become paths: questions shown for exactly the same answers make
// one path, as long as their answers don't overlap another group's (questions whose answers overlap stay
// plain branches: separate paths would change who sees them). Answers in group order.
export function groupIntoPaths(questions: readonly FormQuestion[], sourceId: string, limit = MAX_PATHS - 1): { optionIds: string[]; questionIds: string[] }[] {
  const source = questions.find((q) => q.id === sourceId);
  if (!source) return [];
  const owner = questionOwners(questions);
  const sourceKey = owner.get(sourceId) ?? MAIN_FLOW;
  const order = sourceOptions(source).map((o) => o.id);
  const groups: { optionIds: string[]; questionIds: string[] }[] = [];
  const at = questions.indexOf(source);
  const depth = keyDepth(sourceKey, owner) + 1;
  questions.forEach((q, i) => {
    const rule = q.show_if;
    if (i <= at || !rule || rule.question_id !== sourceId || (rule.path_id && findPath(source, rule.path_id))) return;
    if (owner.get(q.id) !== sourceKey || q.role === "name") return;
    // A question moving into a path (with what depends on it) must stay within the nesting limit.
    if (depth + groupPathDepth(questions, q.id, owner) > MAX_PATH_DEPTH) return;
    const set = order.filter((id) => rule.option_ids.includes(id));
    // Shown for every answer: not a path (one path would dissolve at once); it stays a plain branch.
    if (!set.length || set.length === order.length) return;
    const same = groups.find((g) => g.optionIds.length === set.length && g.optionIds.every((id, k) => id === set[k]));
    if (same) {
      same.questionIds.push(q.id);
      return;
    }
    if (groups.length >= limit || groups.some((g) => g.optionIds.some((id) => set.includes(id)))) return;
    groups.push({ optionIds: set, questionIds: [q.id] });
  });
  return groups;
}

// "Split into paths". Existing branches that fit become paths (groupIntoPaths), then each answer not on one
// gets its own path while there's room (6 in all); past that, the answers in `ownAnswers` (up to 5 paths in
// all, the person's pick) get their own and the rest go to Otherwise. Never starts in an error state.
export function splitIntoPaths(
  questions: FormQuestion[],
  sourceId: string,
  ownAnswers?: readonly string[],
  newId: IdFactory = defaultId,
): { questions: FormQuestion[]; paths: number; adopted: number } {
  const source = questions.find((q) => q.id === sourceId);
  if (!source || splitUnavailableReason(questions, source) || isSplit(source)) return { questions, paths: 0, adopted: 0 };
  const order = sourceOptions(source).map((o) => o.id);
  const groups = groupIntoPaths(questions, sourceId);
  const taken = new Set(groups.flatMap((g) => g.optionIds));
  const leftovers = order.filter((id) => !taken.has(id));
  const paths: FormPath[] = groups.map((g) => ({ id: newId(), option_ids: g.optionIds }));
  const adopt = new Map<string, string>();
  groups.forEach((g, k) => g.questionIds.forEach((id) => adopt.set(id, paths[k].id)));
  if (!ownAnswers && groups.length + leftovers.length <= MAX_PATHS) {
    for (const id of leftovers) paths.push({ id: newId(), option_ids: [id] });
  } else {
    const room = MAX_PATHS - 1 - groups.length;
    const own = leftovers.filter((id) => !ownAnswers || ownAnswers.includes(id)).slice(0, Math.max(room, 0));
    for (const id of own) paths.push({ id: newId(), option_ids: [id] });
    if (leftovers.length > own.length) paths.push({ id: newId(), otherwise: true });
  }
  // Paths follow the answers' order; Otherwise last.
  const first = (p: FormPath) => (p.otherwise ? Infinity : order.indexOf(p.option_ids?.[0] ?? ""));
  paths.sort((a, b) => first(a) - first(b));
  const next = questions.map((q) => {
    if (q.id === sourceId) return { ...q, paths };
    const pathId = adopt.get(q.id);
    return pathId && q.show_if ? { ...q, show_if: branchRule(sourceId, q.show_if.option_ids, pathId) } : q;
  });
  return { questions: canonicalOrder(applyPaths(next)), paths: paths.length, adopted: adopt.size };
}

// Answers a path can take in Add path / Change answers: every answer, with the path it's on now.
export function answerChoices(source: FormQuestion): { id: string; label: string; pathId: string | null; pathLabel: string | null }[] {
  const owner = new Map<string, FormPath>();
  for (const path of source.paths ?? []) for (const id of path.otherwise ? [] : (path.option_ids ?? [])) owner.set(id, path);
  return sourceOptions(source).map((o) => {
    const path = owner.get(o.id);
    return { id: o.id, label: o.label.trim() || "Untitled answer", pathId: path?.id ?? null, pathLabel: path ? pathLabel(source, path) : null };
  });
}

function withPaths(questions: FormQuestion[], sourceId: string, paths: FormPath[]): FormQuestion[] {
  return questions.map((q) => (q.id === sourceId ? { ...q, paths } : q));
}

function takeAnswers(paths: readonly FormPath[], optionIds: readonly string[], except?: string): FormPath[] {
  return paths.map((p) =>
    p.otherwise || p.id === except ? p : { ...p, option_ids: (p.option_ids ?? []).filter((id) => !optionIds.includes(id)) },
  );
}

// How many paths a question would have after a change (Otherwise counts while answers are left for it, or
// while it holds questions).
export function pathCountAfter(questions: readonly FormQuestion[], sourceId: string, paths: readonly FormPath[]): number {
  const source = questions.find((q) => q.id === sourceId);
  if (!source) return paths.length;
  const preview = { ...source, paths: [...paths] };
  const leftovers = leftoverOptionIds(preview).length;
  return paths.filter(
    (p) => !p.otherwise || leftovers > 0 || questions.some((q) => q.show_if?.question_id === sourceId && q.show_if.path_id === p.id),
  ).length;
}

export function canAddPath(questions: readonly FormQuestion[], sourceId: string): boolean {
  const source = questions.find((q) => q.id === sourceId);
  return Boolean(source && isSplit(source) && (source.paths?.length ?? 0) < MAX_PATHS);
}

// "Add path": a new path for these answers (taken off the paths that had them), before Otherwise. With
// `otherwise`, the Otherwise path instead ("any other answer").
export function addPath(
  questions: FormQuestion[],
  sourceId: string,
  optionIds: readonly string[],
  newId: IdFactory = defaultId,
  otherwise = false,
): { questions: FormQuestion[]; pathId: string | null } {
  const source = questions.find((q) => q.id === sourceId);
  if (!source || !isSplit(source) || !canAddPath(questions, sourceId)) return { questions, pathId: null };
  const paths = source.paths ?? [];
  if (otherwise) {
    if (otherwisePath(source)) return { questions, pathId: null };
    const path: FormPath = { id: newId(), otherwise: true };
    return { questions: withPaths(questions, sourceId, [...paths, path]), pathId: path.id };
  }
  if (!optionIds.length) return { questions, pathId: null };
  const path: FormPath = { id: newId(), option_ids: [...optionIds] };
  const rest = takeAnswers(paths, optionIds);
  const at = rest.findIndex((p) => p.otherwise);
  const next = at < 0 ? [...rest, path] : [...rest.slice(0, at), path, ...rest.slice(at)];
  return { questions: withPaths(questions, sourceId, next), pathId: path.id };
}

// "Change answers" of a regular path (answers move off the paths that had them).
export function setPathAnswers(questions: FormQuestion[], sourceId: string, pathId: string, optionIds: readonly string[]): FormQuestion[] {
  const source = questions.find((q) => q.id === sourceId);
  const path = source ? findPath(source, pathId) : undefined;
  if (!source || !path || path.otherwise) return questions;
  const paths = takeAnswers(source.paths ?? [], optionIds, pathId).map((p) => (p.id === pathId ? { ...p, option_ids: [...optionIds] } : p));
  return withPaths(questions, sourceId, paths);
}

export function renamePath(questions: FormQuestion[], sourceId: string, pathId: string, name: string): FormQuestion[] {
  const source = questions.find((q) => q.id === sourceId);
  if (!source || !findPath(source, pathId)) return questions;
  const paths = (source.paths ?? []).map((p): FormPath => {
    if (p.id !== pathId) return p;
    const next: FormPath = { ...p };
    const trimmed = name.slice(0, MAX_PATH_NAME);
    if (trimmed) next.name = trimmed;
    else delete next.name;
    return next;
  });
  return withPaths(questions, sourceId, paths);
}

// Move up / down among the paths (Otherwise stays last); the blocks move with their paths.
export function movePath(questions: FormQuestion[], sourceId: string, pathId: string, delta: -1 | 1): FormQuestion[] {
  const source = questions.find((q) => q.id === sourceId);
  const paths = source?.paths ?? [];
  const at = paths.findIndex((p) => p.id === pathId);
  const to = at + delta;
  if (!source || at < 0 || paths[at].otherwise || to < 0 || to >= paths.length || paths[to].otherwise) return questions;
  const next = [...paths];
  [next[at], next[to]] = [next[to], next[at]];
  return canonicalOrder(withPaths(questions, sourceId, next));
}

// The questions of a block (its own questions and everything nested inside them), in order.
export function blockQuestionIds(questions: readonly FormQuestion[], sourceId: string, pathId: string): string[] {
  const owner = questionOwners(questions);
  const key = blockKey(sourceId, pathId);
  return questions.filter((q) => within(owner.get(q.id) ?? MAIN_FLOW, key, owner)).map((q) => q.id);
}

// "Delete path": its questions move out of the path (`keep`: they show whenever the split question shows,
// right after its paths) or are deleted with it. Fewer than 2 paths left dissolves the split: the last
// path's questions stay, as a plain branch on the same answers.
export function deletePath(questions: FormQuestion[], sourceId: string, pathId: string, mode: "keep" | "delete"): FormQuestion[] {
  const source = questions.find((q) => q.id === sourceId);
  if (!source || !findPath(source, pathId)) return questions;
  const inBlock = new Set(blockQuestionIds(questions, sourceId, pathId));
  const paths = (source.paths ?? []).filter((p) => p.id !== pathId);
  // The answers each remaining path had: if the split dissolves, its questions keep showing for exactly those
  // (an Otherwise would otherwise take the deleted path's answers too).
  const answersBefore = new Map((source.paths ?? []).map((p) => [p.id, pathOptionIds(source, p)] as const));
  const dissolves = pathCountAfter(questions, sourceId, paths) < MIN_PATHS;
  let next = dissolves
    ? questions.map((q) => {
        if (q.id === sourceId) {
          const copy = { ...q };
          delete copy.paths;
          return copy;
        }
        const rule = q.show_if;
        if (rule?.question_id !== sourceId || !rule.path_id || rule.path_id === pathId) return q;
        const had = answersBefore.get(rule.path_id) ?? rule.option_ids;
        // An Otherwise that had no answers left takes the ones no path has once this path is gone.
        const remaining = (source.paths ?? []).find((p) => p.id === rule.path_id);
        const answers = had.length || !remaining?.otherwise ? had : leftoverOptionIds({ ...source, paths });
        return { ...q, show_if: branchRule(sourceId, answers) };
      })
    : withPaths(questions, sourceId, paths);
  if (mode === "delete") {
    next = next.filter((q) => !inBlock.has(q.id));
  } else {
    // The path's own questions take the split question's rule (or none) and move after the region.
    const moved = next
      .filter((q) => inBlock.has(q.id))
      .map((q) => (q.show_if?.question_id === sourceId && q.show_if.path_id === pathId ? withRule(q, source.show_if ?? null) : q));
    const rest = next.filter((q) => !inBlock.has(q.id));
    const owner = questionOwners(rest);
    const end = unitEnd(rest, rest.findIndex((q) => q.id === sourceId), owner);
    next = [...rest.slice(0, end + 1), ...moved, ...rest.slice(end + 1)];
  }
  return canonicalOrder(applyPaths(next));
}

function withRule(question: FormQuestion, rule: BranchRule | null): FormQuestion {
  const copy = { ...question };
  if (rule) copy.show_if = branchRule(rule.question_id, rule.option_ids, rule.path_id);
  else delete copy.show_if;
  return copy;
}

// ---------------------------------------------------------------------------------------------
// Block-aware moves and inserts
// ---------------------------------------------------------------------------------------------

function findNode(nodes: FlowNode[], id: string): { siblings: FlowNode[]; at: number } | null {
  for (const [at, node] of nodes.entries()) {
    if (node.question.id === id) return { siblings: nodes, at };
    for (const block of node.blocks ?? []) {
      const found = findNode(block.nodes, id);
      if (found) return found;
    }
  }
  return null;
}

// Alt+↑ / Alt+↓ and Move up / down: a question moves past the question (and its paths) next to it in the
// same flow, carrying its own paths along. At a path's first or last place it reports the edge instead, so
// the editor can ask "Move it to the main flow?" rather than clear its branch.
export function moveInFlow(
  questions: FormQuestion[],
  id: string,
  delta: -1 | 1,
): { questions: FormQuestion[] } | { edge: "start" | "end"; container: FlowContainer } | null {
  const flow = buildFlow(questions);
  if (!flow.inOrder) return null;
  const found = findNode(flow.nodes, id);
  if (!found) return null;
  const { siblings, at } = found;
  const neighbor = siblings[at + delta];
  if (!neighbor) {
    const container = containerOf(id, flow.owner);
    return container ? { edge: delta < 0 ? "start" : "end", container } : null;
  }
  const mine = [found.siblings[at].index, unitEnd(questions, found.siblings[at].index, flow.owner)] as const;
  const theirs = [neighbor.index, unitEnd(questions, neighbor.index, flow.owner)] as const;
  const [a, b] = delta < 0 ? [theirs, mine] : [mine, theirs];
  return {
    questions: [
      ...questions.slice(0, a[0]),
      ...questions.slice(b[0], b[1] + 1),
      ...questions.slice(a[0], a[1] + 1),
      ...questions.slice(b[1] + 1),
    ],
  };
}

// What moves with a question when it changes container: its unit (its own paths) and the questions in the
// same container that depend on it through plain branches (with their units), in order.
export function movingGroup(questions: readonly FormQuestion[], id: string): string[] {
  const owner = questionOwners(questions);
  const home = owner.get(id);
  const start = questions.findIndex((q) => q.id === id);
  if (start < 0) return [];
  const group = new Set<string>();
  const end = unitEnd(questions, start, owner);
  for (let j = start; j <= end; j++) group.add(questions[j].id);
  for (let j = end + 1; j < questions.length; j++) {
    const q = questions[j];
    if (owner.get(q.id) === home && q.show_if && !q.show_if.path_id && group.has(q.show_if.question_id)) {
      const last = unitEnd(questions, j, owner);
      for (let k = j; k <= last; k++) group.add(questions[k].id);
      j = last;
    }
  }
  return questions.filter((q) => group.has(q.id)).map((q) => q.id);
}

// Whether a question (and what moves with it) can go into a container: never into its own paths, never past
// the nesting limit, and the requester's name stays on the main flow.
export function canPlaceIn(questions: readonly FormQuestion[], id: string, container: FlowContainer): boolean {
  const question = questions.find((q) => q.id === id);
  if (!question) return false;
  if (!container) return true;
  if (question.role === "name") return false;
  if (movingGroup(questions, id).includes(container.sourceId)) return false;
  const owner = questionOwners(questions);
  // Every question that moves along keeps its own paths within the limit.
  return keyDepth(blockKey(container.sourceId, container.pathId), owner) + groupPathDepth(questions, id, owner) <= MAX_PATH_DEPTH;
}

// The rule a question gets when it moves to another container. Stepping out of a path into the container
// its split question sits in, it takes that question's own rule (it shows whenever the split question
// shows, like Move out of the path); anywhere else, the container's rule (none on the main flow).
export function ruleWhenPlaced(questions: readonly FormQuestion[], id: string, container: FlowContainer): BranchRule | null {
  const owner = questionOwners(questions);
  const from = containerOf(id, owner);
  if (from) {
    const source = questions.find((q) => q.id === from.sourceId);
    if (source && containerKey(containerOf(source.id, owner)) === containerKey(container)) return source.show_if ?? null;
  }
  return containerRule(questions, container);
}

// Puts a question (with what moves with it) into a container, before `beforeId` (a question of that
// container; null = its end). Joining a path gives it the path's rule; the main flow clears its rule. Within
// its own container it's a plain reorder of its unit. Returns the same array when nothing moves.
export function placeQuestion(questions: FormQuestion[], id: string, container: FlowContainer, beforeId: string | null): FormQuestion[] {
  if (!canPlaceIn(questions, id, container)) return questions;
  const owner = questionOwners(questions);
  const sameHome = (owner.get(id) ?? MAIN_FLOW) === containerKey(container);
  const groupIds = sameHome
    ? (() => {
        const start = questions.findIndex((q) => q.id === id);
        return questions.slice(start, unitEnd(questions, start, owner) + 1).map((q) => q.id);
      })()
    : movingGroup(questions, id);
  if (beforeId !== null && groupIds.includes(beforeId)) return questions;
  const group = new Set(groupIds);
  const rest = questions.filter((q) => !group.has(q.id));
  // The end of a container is found on the full list (taking the moving question out first would cut off a
  // question below it whose rule names it), then counted without the questions that move.
  const end = beforeId === null ? insertionIndex(questions, container, null) : -1;
  const at = beforeId !== null ? rest.findIndex((q) => q.id === beforeId) : end < 0 ? -1 : questions.slice(0, end).filter((q) => !group.has(q.id)).length;
  if (at < 0) return questions;
  let rule = sameHome ? null : ruleWhenPlaced(questions, id, container);
  // A rule can only name a question above it: landing above the one the split question's rule names, it
  // takes the container's own rule instead (none on the main flow).
  const parentAt = rule ? rest.findIndex((q) => q.id === rule!.question_id) : -1;
  if (rule && (parentAt < 0 || parentAt >= at)) rule = containerRule(questions, container);
  const moving = questions
    .filter((q) => group.has(q.id))
    .map((q) => (q.id === id && !sameHome ? withRule(q, rule) : q));
  const next = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  return next.every((q, i) => q.id === questions[i].id && q === questions[i]) ? questions : next;
}

// Where a new question of a container goes: before `beforeId` (a question of that container), or after the
// container's last unit (a block with nothing yet: right after the blocks before it).
function insertionIndex(questions: readonly FormQuestion[], container: FlowContainer, beforeId: string | null): number {
  if (beforeId !== null) return questions.findIndex((q) => q.id === beforeId);
  if (!container) return questions.length;
  const owner = questionOwners(questions);
  const target = blockKey(container.sourceId, container.pathId);
  const sourceAt = questions.findIndex((q) => q.id === container.sourceId);
  const source = questions[sourceAt];
  if (!source || !findPath(source, container.pathId)) return -1;
  let end = sourceAt;
  for (const path of source.paths ?? []) {
    const key = blockKey(source.id, path.id);
    for (let j = end + 1; j < questions.length; j++) {
      if (within(owner.get(questions[j].id) ?? MAIN_FLOW, key, owner)) end = j;
      else break;
    }
    if (key === target) return end + 1;
  }
  return -1;
}

// A new question at the end of a container ("+ Add question to this path", or the main flow's + New
// question), with the container's rule.
export function insertIntoContainer(questions: FormQuestion[], container: FlowContainer, question: FormQuestion): FormQuestion[] {
  const at = insertionIndex(questions, container, null);
  if (at < 0) return questions;
  const added = withRule(question, containerRule(questions, container));
  return [...questions.slice(0, at), added, ...questions.slice(at)];
}

// "Add question below": right after a question's unit, in the same container (same rule as a path question,
// none on the main flow). `keepRule` (Duplicate) keeps the new question's own rule: a copy shows for the same
// answers as its original, a plain branch included.
export function insertAfter(questions: FormQuestion[], afterId: string, question: FormQuestion, keepRule = false): FormQuestion[] {
  const owner = questionOwners(questions);
  const at = questions.findIndex((q) => q.id === afterId);
  if (at < 0) return [...questions, question];
  const end = unitEnd(questions, at, owner);
  const added = keepRule ? question : withRule(question, containerRule(questions, containerOf(afterId, owner)));
  return [...questions.slice(0, end + 1), added, ...questions.slice(end + 1)];
}

// "Stop splitting": the question keeps its answers and its path questions keep showing for the same
// answers, as plain branches (applyPaths drops the path ids).
export function stopSplitting(questions: FormQuestion[], sourceId: string): FormQuestion[] {
  return applyPaths(
    questions.map((q) => {
      if (q.id !== sourceId || !q.paths) return q;
      const copy = { ...q };
      delete copy.paths;
      return copy;
    }),
  );
}

// Out of its path, keeping what depends on it: it takes the split question's own rule and goes right before
// the split question (`start`) or right after its paths (`end`).
export function moveOutOfPath(questions: FormQuestion[], id: string, where: "start" | "end"): FormQuestion[] {
  const owner = questionOwners(questions);
  const container = containerOf(id, owner);
  if (!container) return questions;
  const source = questions.find((q) => q.id === container.sourceId);
  if (!source) return questions;
  const group = new Set(movingGroup(questions, id));
  const moving = questions.filter((q) => group.has(q.id)).map((q) => (q.id === id ? withRule(q, source.show_if ?? null) : q));
  const rest = questions.filter((q) => !group.has(q.id));
  const restOwner = questionOwners(rest);
  const sourceAt = rest.findIndex((q) => q.id === source.id);
  const at = where === "start" ? sourceAt : unitEnd(rest, sourceAt, restOwner) + 1;
  return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
}

// A reorder inside a path that puts a question above the question its plain rule names would break that rule
// (normalizeQuestions drops a rule on a question below it), and the question would leave its path. Instead it
// keeps showing only on its path: it takes the path's rule, like "Show on the whole path". On the main flow
// there's no outer rule to keep (the editor clears it there, with Undo, as before).
export function keepBrokenBranchesInPath(moved: FormQuestion[], before: readonly FormQuestion[]): { questions: FormQuestion[]; kept: string[] } {
  const owner = questionOwners(before);
  const index = new Map(moved.map((q, i) => [q.id, i] as const));
  const kept: string[] = [];
  const next = moved.map((q, i) => {
    const rule = q.show_if;
    const parentAt = rule ? index.get(rule.question_id) : undefined;
    if (!rule || (parentAt !== undefined && parentAt < i)) return q;
    const fallback = containerRule(before, containerOf(q.id, owner));
    const sourceAt = fallback ? index.get(fallback.question_id) : undefined;
    if (!fallback || sourceAt === undefined || sourceAt >= i) return q;
    kept.push(q.id);
    return withRule(q, fallback);
  });
  return { questions: kept.length ? next : moved, kept };
}

// "Always show" on a plain branch: the question stops depending on that answer but stays where it is, so
// inside a path it takes the path's rule (it still shows only on that path), on the main flow none.
export function clearBranch(questions: FormQuestion[], id: string): FormQuestion[] {
  const owner = questionOwners(questions);
  const rule = containerRule(questions, containerOf(id, owner));
  return questions.map((q) => (q.id === id ? withRule(q, rule) : q));
}

// Where a question that leaves its path would show, in words ("to everyone", "whenever “Size” shows").
export function moveOutWords(questions: readonly FormQuestion[], id: string): { title: string; message: string } {
  const owner = questionOwners(questions);
  const container = containerOf(id, owner);
  const source = container ? questions.find((q) => q.id === container.sourceId) : undefined;
  const question = questions.find((q) => q.id === id);
  const name = question?.label.trim() || "this question";
  const outer = source ? containerOf(source.id, owner) : null;
  const outerSource = outer ? questions.find((q) => q.id === outer.sourceId) : undefined;
  const outerPath = outerSource && outer ? findPath(outerSource, outer.pathId) : undefined;
  if (outerSource && outerPath) {
    return {
      title: `Move “${name}” out of this path?`,
      message: `It joins the path “${pathLabel(outerSource, outerPath)}” and shows whenever “${source?.label.trim() || "the question above"}” shows.`,
    };
  }
  return {
    title: `Move “${name}” to the main flow?`,
    message: source?.show_if
      ? `It shows whenever “${source.label.trim() || "the question above"}” shows, whatever the answer.`
      : "It shows to everyone, whatever the answer.",
  };
}

// The path a question was shown for by `optionId` of a split question (Otherwise for answers no path has).
export function pathForAnswer(source: FormQuestion, optionId: string): FormPath | undefined {
  const paths = source.paths ?? [];
  return paths.find((p) => !p.otherwise && p.option_ids?.includes(optionId)) ?? (leftoverOptionIds(source).includes(optionId) ? otherwisePath(source) : undefined);
}

// "Turn into a Yes / No choice" for a checkbox that branches: Yes takes the checkbox's branches.
export function checkboxToYesNo(questions: FormQuestion[], id: string, newId: IdFactory = defaultId): FormQuestion[] {
  const question = questions.find((q) => q.id === id);
  if (!question || question.type !== "checkbox") return questions;
  const yes = newId();
  const no = newId();
  return questions.map((q) => {
    if (q.id === id) {
      const next: FormQuestion = { ...q, type: "single_select", options: [{ id: yes, label: "Yes" }, { id: no, label: "No" }] };
      // A Yes / No choice can't fill in a checkbox field (normalizeQuestions drops a mapping that no longer fits).
      return next;
    }
    if (q.show_if?.question_id === id) return { ...q, show_if: branchRule(id, q.show_if.option_ids.map((o) => (o === CHECKBOX_ANSWER ? yes : o))) };
    return q;
  });
}

// What the public form gets: the walk's rules without the builder's path metadata (path names are for the
// people building the form; get_public_form still returns them to anyone with the link, see PATH_NAME_NOTE).
export function withoutPathMetadata(questions: readonly FormQuestion[]): FormQuestion[] {
  return questions.map((q) => {
    if (!q.paths && !q.show_if?.path_id) return q;
    const copy: FormQuestion = { ...q };
    delete copy.paths;
    if (copy.show_if) copy.show_if = branchRule(copy.show_if.question_id, copy.show_if.option_ids);
    return copy;
  });
}

// ---------------------------------------------------------------------------------------------
// Which questions can show together (mapping guards)
// ---------------------------------------------------------------------------------------------

// The answers a question needs before it can show: split / branch question id → the answers allowed.
function requirements(questions: readonly FormQuestion[], rule: BranchRule | null | undefined): Map<string, Set<string>> {
  const byId = new Map(questions.map((q) => [q.id, q] as const));
  const out = new Map<string, Set<string>>();
  const seen = new Set<string>();
  for (let r = rule; r && !seen.has(r.question_id); r = byId.get(r.question_id)?.show_if) {
    seen.add(r.question_id);
    out.set(r.question_id, new Set(r.option_ids));
  }
  return out;
}

// Two questions can't both show only when they need different answers to the same single-choice question
// (two paths of a single-choice split, say). Paths of a multiple-choice split can show together.
function exclusive(questions: readonly FormQuestion[], a: Map<string, Set<string>>, b: Map<string, Set<string>>): boolean {
  for (const [sourceId, answers] of a) {
    const other = b.get(sourceId);
    if (!other) continue;
    const source = questions.find((q) => q.id === sourceId);
    if (source?.type !== "single_select") continue;
    if (![...answers].some((id) => other.has(id))) return true;
  }
  return false;
}

export function canShowTogether(questions: readonly FormQuestion[], aId: string, bId: string): boolean {
  const a = questions.find((q) => q.id === aId);
  const b = questions.find((q) => q.id === bId);
  if (!a || !b) return false;
  return !exclusive(questions, requirements(questions, a.show_if), requirements(questions, b.show_if));
}

// What a mapping writes, for comparing: the task name, due date, section (a section-bound field moves the
// section too), or one field. The description isn't compared: its answers are listed one after another.
export function mappingKey(question: FormQuestion, sectionFieldIds: ReadonlySet<string> = new Set()): string | null {
  const target = question.maps_to?.target;
  if (!target || target === "notes") return null;
  if (target === "field") {
    const fieldId = question.maps_to?.field_id;
    if (!fieldId) return null;
    return sectionFieldIds.has(fieldId) ? "section" : `field:${fieldId}`;
  }
  return target;
}

export type MappingConflict = { questionId: string; otherId: string; target: MapTarget };

// Questions that can both show and fill in the same detail: the last answer wins (a field, the due date,
// the section) or the answers are joined (the task name). One entry per question, naming the first other.
export function mappingConflicts(questions: readonly FormQuestion[], sectionFieldIds: ReadonlySet<string> = new Set()): MappingConflict[] {
  const out: MappingConflict[] = [];
  const keyed = questions.flatMap((q) => {
    const key = mappingKey(q, sectionFieldIds);
    return key ? [{ q, key, needs: requirements(questions, q.show_if) }] : [];
  });
  for (const item of keyed) {
    const other = keyed.find((x) => x !== item && x.key === item.key && !exclusive(questions, item.needs, x.needs));
    if (other) out.push({ questionId: item.q.id, otherId: other.q.id, target: item.q.maps_to!.target });
  }
  return out;
}

// "From a field" when adding a question to a container: a field already asked is fine when every question
// asking it can never show with the new one (another path of a single-choice split: "Asked in Print").
export function fieldAskInContainer(
  questions: readonly FormQuestion[],
  fieldId: string,
  container: FlowContainer,
): { asked: boolean; allowed: boolean; askedIn: string | null } {
  const asking = questions.filter((q) => q.maps_to?.target === "field" && q.maps_to.field_id === fieldId);
  if (!asking.length) return { asked: false, allowed: true, askedIn: null };
  const mine = requirements(questions, containerRule(questions, container));
  const allowed = asking.every((q) => exclusive(questions, mine, requirements(questions, q.show_if)));
  if (!allowed) return { asked: true, allowed: false, askedIn: null };
  const owner = questionOwners(questions);
  const places = asking.flatMap((q) => {
    const c = containerOf(q.id, owner);
    const source = c ? questions.find((x) => x.id === c.sourceId) : undefined;
    const path = source && c ? findPath(source, c.pathId) : undefined;
    return source && path ? [pathLabel(source, path)] : [];
  });
  return { asked: true, allowed: true, askedIn: places.length ? places.join(", ") : null };
}
