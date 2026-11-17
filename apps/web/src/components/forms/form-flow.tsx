"use client";

// Batch 43 (note 143): the form editor's question list as a flow. A choice question that splits into paths
// shows its paths under it as colored blocks on a branch line (a header with the path's name and answers,
// its questions, "+ Add question to this path"), then "Paths meet here" before the next main question.
// The rules live in @alhc/core/form-paths; this file only draws them and turns clicks into those edits.
// The question cards themselves are the editor's (renderCard), so a question looks the same in or out of a
// path.

import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, CircleAlert, CornerDownRight, Ellipsis, GitFork, Pencil, Plus, Split, Trash2 } from "lucide-react";
import { Popover } from "@/components/popover";
import {
  MAX_PATHS,
  MAX_PATH_NAME,
  PATH_NAME_NOTE,
  addPath,
  answerChoices,
  blockKey,
  blockQuestionIds,
  leftoverOptionIds,
  movePath,
  otherwisePath,
  pathAnswersText,
  pathLabel,
  renamePath,
  setPathAnswers,
  splitIntoPaths,
  splitUnavailableReason,
  type FlowBlock,
  type FlowContainer,
  type FlowNode,
  type FormProblem,
} from "@alhc/core/form-paths";
import type { FormPath, FormQuestion } from "@alhc/core/forms";

// One color per path (by its place among its question's paths, shifted by nesting so a nested path never
// takes its outer path's color). Otherwise is always gray. Literal classes, so Tailwind keeps them.
export type PathColor = { dot: string; block: string; edge: string; text: string; chip: string };
const PATH_COLORS: PathColor[] = [
  { dot: "bg-violet-500", block: "border-violet-200 bg-violet-50/50", edge: "border-l-violet-400", text: "text-violet-800", chip: "bg-violet-100 text-violet-800" },
  { dot: "bg-sky-500", block: "border-sky-200 bg-sky-50/50", edge: "border-l-sky-400", text: "text-sky-800", chip: "bg-sky-100 text-sky-800" },
  { dot: "bg-amber-500", block: "border-amber-200 bg-amber-50/50", edge: "border-l-amber-400", text: "text-amber-800", chip: "bg-amber-100 text-amber-900" },
  { dot: "bg-emerald-500", block: "border-emerald-200 bg-emerald-50/50", edge: "border-l-emerald-400", text: "text-emerald-800", chip: "bg-emerald-100 text-emerald-800" },
  { dot: "bg-rose-500", block: "border-rose-200 bg-rose-50/50", edge: "border-l-rose-400", text: "text-rose-800", chip: "bg-rose-100 text-rose-800" },
  { dot: "bg-teal-500", block: "border-teal-200 bg-teal-50/50", edge: "border-l-teal-400", text: "text-teal-800", chip: "bg-teal-100 text-teal-800" },
];
const OTHERWISE_COLOR: PathColor = {
  dot: "bg-zinc-400",
  block: "border-zinc-200 bg-zinc-50",
  edge: "border-l-zinc-400",
  text: "text-zinc-700",
  chip: "bg-zinc-100 text-zinc-700",
};

export function pathColor(path: FormPath, position: number, depth: number): PathColor {
  return path.otherwise ? OTHERWISE_COLOR : PATH_COLORS[(position + depth * 2) % PATH_COLORS.length];
}

// The innermost path each question is in (its color and name), for the cards and the preview.
export type PathTag = { label: string; answers: string; sourceLabel: string; color: PathColor; pathId: string; sourceId: string };

export function pathTags(nodes: FlowNode[]): Map<string, PathTag> {
  const tags = new Map<string, PathTag>();
  const byBlock = new Map<string, PathTag>();
  const misplaced: FlowNode[] = [];
  const visit = (list: FlowNode[], tag: PathTag | null) => {
    for (const node of list) {
      if (node.misplaced) misplaced.push(node);
      else if (tag) tags.set(node.question.id, tag);
      for (const block of node.blocks ?? []) {
        const blockTag: PathTag = {
          label: pathLabel(node.question, block.path),
          answers: pathAnswersText(node.question, block.path),
          sourceLabel: node.question.label.trim() || "the question above",
          color: pathColor(block.path, block.position, node.depth),
          pathId: block.path.id,
          sourceId: node.question.id,
        };
        byBlock.set(blockKey(node.question.id, block.path.id), blockTag);
        visit(block.nodes, blockTag);
      }
    }
  };
  visit(nodes, null);
  // A question outside its path's block still carries its own path (not the block it sits in).
  for (const node of misplaced) {
    const tag = node.misplaced ? byBlock.get(blockKey(node.misplaced.sourceId, node.misplaced.pathId)) : undefined;
    if (tag) tags.set(node.question.id, tag);
  }
  return tags;
}

// What the flow needs from the editor.
export type FlowContext = {
  questions: FormQuestion[];
  // Problems by question (the card) and by path (the path's header).
  problemsByPath: Map<string, FormProblem>;
  // The editor's question card for a node; `place` = its container and the sibling after it (drag targets).
  renderCard: (node: FlowNode, place: { container: FlowContainer; nextSiblingId: string | null }) => ReactNode;
  // "+ Add question to this path" (the editor's New question menu, adding to that container).
  renderAdd: (container: FlowContainer, label: string) => ReactNode;
  // Drag and drop onto a block's end (the add row).
  dragActive: boolean;
  dropAtEnd: (container: FlowContainer) => boolean;
  onDragOverEnd: (container: FlowContainer) => void;
  // A change with an Undo toast (message = what happened), or a quiet one (renaming as you type).
  commit: (next: FormQuestion[], message: string | null, moved?: string[]) => void;
  // "Delete path" asks where its questions go first.
  askDeletePath: (source: FormQuestion, path: FormPath) => void;
  // The question being dragged and what moves with it (drawn faded).
  isMoving: (questionId: string) => boolean;
};

const Ctx = createContext<FlowContext | null>(null);

function useFlow(): FlowContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useFlow outside QuestionFlow");
  return ctx;
}

export function QuestionFlow({ nodes, ctx }: { nodes: FlowNode[]; ctx: FlowContext }) {
  return (
    <Ctx.Provider value={ctx}>
      <FlowList nodes={nodes} container={null} label="Questions" />
    </Ctx.Provider>
  );
}

function FlowList({ nodes, container, label }: { nodes: FlowNode[]; container: FlowContainer; label: string }) {
  return (
    <ol className="flex flex-col gap-2" aria-label={label}>
      {nodes.map((node, i) => (
        <FlowItem key={node.question.id} node={node} container={container} nextSiblingId={nodes[i + 1]?.question.id ?? null} />
      ))}
    </ol>
  );
}

function FlowItem({ node, container, nextSiblingId }: { node: FlowNode; container: FlowContainer; nextSiblingId: string | null }) {
  const ctx = useFlow();
  return (
    <li className={`flex flex-col transition-opacity ${ctx.isMoving(node.question.id) ? "opacity-40" : ""}`} data-flow-item={node.question.id}>
      {ctx.renderCard(node, { container, nextSiblingId })}
      {node.blocks ? <PathBlocks node={node} /> : null}
    </li>
  );
}

// The branch line: the split question's paths, "+ Add path", and where they meet.
function PathBlocks({ node }: { node: FlowNode }) {
  const source = node.question;
  const blocks = node.blocks ?? [];
  const leftover = leftoverOptionIds(source);
  const unassigned = leftover.length && !otherwisePath(source) ? leftover : [];
  return (
    <div className="ml-3" data-paths-of={source.id}>
      <div className="relative flex flex-col gap-2 border-l-2 border-zinc-300 pb-1 pl-4 pt-2">
        {blocks.map((block) => (
          <PathBlock key={block.path.id} block={block} source={source} depth={node.depth} count={blocks.length} />
        ))}
        {unassigned.length ? (
          <p className="text-xs text-zinc-500">
            {answerList(source, unassigned)} {unassigned.length === 1 ? "isn’t" : "aren’t"} on a path: picking{" "}
            {unassigned.length === 1 ? "it" : "one"} shows none of them.
          </p>
        ) : null}
        <AddPathButton source={source} />
      </div>
      <p className="flex items-center gap-1.5 pl-0.5 pt-1 text-2xs font-medium text-zinc-500" data-paths-meet="">
        <CornerDownRight className="size-3.5 text-zinc-400" aria-hidden />
        Paths meet here
        <span className="sr-only">: the questions below show whichever path was taken</span>
      </p>
    </div>
  );
}

function answerList(source: FormQuestion, ids: string[]): string {
  const labels = new Map((source.options ?? []).map((o) => [o.id, o.label.trim() || "Untitled answer"] as const));
  const names = ids.map((id) => `“${labels.get(id) ?? "?"}”`);
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

function PathBlock({ block, source, depth, count }: { block: FlowBlock; source: FormQuestion; depth: number; count: number }) {
  const ctx = useFlow();
  const color = pathColor(block.path, block.position, depth);
  const container = { sourceId: source.id, pathId: block.path.id };
  const label = pathLabel(source, block.path);
  const problem = ctx.problemsByPath.get(block.path.id);
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-path={block.path.id}
      className={`relative rounded-lg border border-l-4 ${color.block} ${color.edge} px-2 pb-2 pt-1.5 ${problem ? "ring-1 ring-red-300" : ""}`}
    >
      {/* The tick from the branch line to the block. */}
      <span aria-hidden className="pointer-events-none absolute -left-[1.15rem] top-4 h-0.5 w-4 bg-zinc-300" />
      <header className="flex min-h-7 items-center gap-2">
        <span aria-hidden className={`size-2.5 shrink-0 rounded-full ${color.dot}`} />
        <h4 id={headingId} className={`min-w-0 truncate text-xs font-semibold ${color.text}`}>
          {label}
        </h4>
        <span className={`min-w-0 flex-1 truncate text-2xs ${problem ? "font-medium text-red-700" : "text-zinc-500"}`}>
          {pathAnswersText(source, block.path)}
        </span>
        <PathMenu source={source} path={block.path} position={block.position} count={count} />
      </header>
      {problem ? (
        <p role="alert" className="mb-1.5 flex items-start gap-1.5 rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-800" data-path-problem="">
          <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          {problem.message}
        </p>
      ) : null}
      {block.nodes.length ? (
        <div className="mt-1">
          <FlowList nodes={block.nodes} container={container} label={`Questions in the path ${label}`} />
        </div>
      ) : null}
      <div
        className="relative mt-1.5"
        onDragOver={
          ctx.dragActive
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                ctx.onDragOverEnd(container);
              }
            : undefined
        }
      >
        {ctx.dropAtEnd(container) ? (
          <span aria-hidden className="pointer-events-none absolute inset-x-1 -top-[5px] h-0.5 rounded-full bg-accent-500" />
        ) : null}
        {ctx.renderAdd(container, block.nodes.length ? "Add question to this path" : "Add the first question to this path")}
      </div>
    </section>
  );
}

// A path's "⋯": Rename, Change answers, Move up / down, Delete.
function PathMenu({ source, path, position, count }: { source: FormQuestion; path: FormPath; position: number; count: number }) {
  const ctx = useFlow();
  const [view, setView] = useState<"menu" | "rename" | "answers">("menu");
  const label = pathLabel(source, path);
  const regular = !path.otherwise;
  const paths = source.paths ?? [];
  const lastRegular = paths.filter((p) => !p.otherwise).length - 1;
  const item = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent";
  return (
    <Popover
      label={`Path options: ${label}`}
      align="end"
      panelClassName="w-72 p-1.5"
      buttonClassName="btn-icon size-6 shrink-0"
      tooltip="Path options"
      onOpenChange={(open) => {
        if (!open) setView("menu");
      }}
      button={<Ellipsis className="size-4" aria-hidden />}
    >
      {(close) =>
        view === "rename" ? (
          <RenamePath
            source={source}
            path={path}
            onDone={(name) => {
              close();
              if (name !== (path.name ?? "")) ctx.commit(renamePath(ctx.questions, source.id, path.id, name), null);
            }}
          />
        ) : view === "answers" ? (
          <AnswerPicker
            source={source}
            initial={path.option_ids ?? []}
            pathId={path.id}
            title={`Answers that lead to “${label}”`}
            applyLabel="Apply"
            onCancel={() => setView("menu")}
            onApply={(ids) => {
              close();
              ctx.commit(setPathAnswers(ctx.questions, source.id, path.id, ids), `Changed the answers of “${label}”.`);
            }}
          />
        ) : (
          <ul className="flex flex-col">
            <li>
              <button type="button" className={item} onClick={() => setView("rename")}>
                <Pencil className="size-4 text-zinc-500" aria-hidden />
                Rename
              </button>
            </li>
            <li>
              <button
                type="button"
                className={item}
                disabled={!regular}
                title={regular ? undefined : "Otherwise takes every answer no other path has"}
                onClick={() => setView("answers")}
              >
                <Check className="size-4 text-zinc-500" aria-hidden />
                Change answers
              </button>
            </li>
            <li>
              <button
                type="button"
                className={item}
                disabled={!regular || position === 0}
                onClick={() => {
                  close();
                  ctx.commit(movePath(ctx.questions, source.id, path.id, -1), null);
                }}
              >
                <span aria-hidden className="w-4 text-center text-zinc-500">↑</span>
                Move up
              </button>
            </li>
            <li>
              <button
                type="button"
                className={item}
                disabled={!regular || position >= lastRegular}
                onClick={() => {
                  close();
                  ctx.commit(movePath(ctx.questions, source.id, path.id, 1), null);
                }}
              >
                <span aria-hidden className="w-4 text-center text-zinc-500">↓</span>
                Move down
              </button>
            </li>
            <li className="mt-1 border-t border-zinc-100 pt-1">
              <button
                type="button"
                className={`${item} text-red-700 hover:bg-red-50`}
                onClick={() => {
                  close();
                  ctx.askDeletePath(source, path);
                }}
              >
                <Trash2 className="size-4" aria-hidden />
                Delete path
              </button>
              {count <= 2 ? <p className="px-2 pb-1 text-2xs text-zinc-500">With one path left, the question stops splitting.</p> : null}
            </li>
          </ul>
        )
      }
    </Popover>
  );
}

function RenamePath({ source, path, onDone }: { source: FormQuestion; path: FormPath; onDone: (name: string) => void }) {
  const [name, setName] = useState(path.name ?? "");
  const id = useId();
  return (
    <form
      className="flex flex-col gap-2 p-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        onDone(name.trim());
      }}
    >
      <label htmlFor={id} className="text-xs font-medium text-zinc-600">
        Path name
      </label>
      <input
        id={id}
        autoFocus
        value={name}
        maxLength={MAX_PATH_NAME}
        placeholder={pathLabel(source, { ...path, name: undefined })}
        onChange={(e) => setName(e.currentTarget.value)}
        className="field h-8 w-full"
      />
      <p className="text-2xs text-zinc-500">Leave it blank to name it after its answers. {PATH_NAME_NOTE}</p>
      <div className="flex justify-end gap-2">
        <button type="submit" className="btn-primary h-7 px-3 text-xs">
          Save
        </button>
      </div>
    </form>
  );
}

// Pick answers for a path (Add path, Change answers, Split into paths past 6 answers). Answers on another
// path say which; picking one moves it.
export function AnswerPicker({
  source,
  initial,
  pathId,
  title,
  hint,
  applyLabel,
  max,
  otherwiseChoice,
  onApply,
  onCancel,
}: {
  source: FormQuestion;
  initial: string[];
  // The path being changed (its own answers don't count as "on another path").
  pathId?: string;
  title: string;
  hint?: string;
  applyLabel: string;
  max?: number;
  // Add path: an "Any other answer" choice (adds Otherwise) when there's none yet.
  otherwiseChoice?: () => void;
  onApply: (ids: string[]) => void;
  onCancel?: () => void;
}) {
  const [picked, setPicked] = useState<string[]>(initial);
  const choices = answerChoices(source);
  const full = max !== undefined && picked.length >= max;
  return (
    <div className="flex flex-col gap-1 p-1">
      <p className="px-1 pt-0.5 text-xs font-medium text-zinc-700">{title}</p>
      {hint ? <p className="px-1 text-2xs text-zinc-500">{hint}</p> : null}
      <ul className="mt-1 flex max-h-64 flex-col overflow-y-auto">
        {choices.map((choice) => {
          const on = picked.includes(choice.id);
          const elsewhere = choice.pathId && choice.pathId !== pathId ? choice.pathLabel : null;
          return (
            <li key={choice.id}>
              <label className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${!on && full ? "text-zinc-400" : "text-zinc-800 hover:bg-zinc-50"}`}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!on && full}
                  onChange={(e) => {
                    const checked = e.currentTarget.checked;
                    setPicked((current) => (checked ? [...current, choice.id] : current.filter((id) => id !== choice.id)));
                  }}
                  className="size-4 accent-accent-600"
                />
                <span className="min-w-0 flex-1 truncate">{choice.label}</span>
                {elsewhere ? <span className="max-w-28 shrink-0 truncate text-2xs text-zinc-400">{on ? "moves here" : `on ${elsewhere}`}</span> : null}
              </label>
            </li>
          );
        })}
      </ul>
      {otherwiseChoice ? (
        <button type="button" onClick={otherwiseChoice} className="mx-1 mt-1 rounded-md border border-dashed border-zinc-300 px-2 py-1.5 text-left text-xs text-zinc-600 hover:bg-zinc-50">
          <span className="font-medium text-zinc-800">Any other answer (Otherwise)</span>
          <span className="block text-2xs text-zinc-500">Every answer no other path has</span>
        </button>
      ) : null}
      <div className="mt-1 flex justify-end gap-2 border-t border-zinc-100 px-1 pt-1.5">
        {onCancel ? (
          <button type="button" onClick={onCancel} className="btn-ghost h-7 text-xs">
            Back
          </button>
        ) : null}
        <button type="button" disabled={!picked.length} onClick={() => onApply(picked)} className="btn-primary h-7 px-3 text-xs">
          {applyLabel}
        </button>
      </div>
    </div>
  );
}

function AddPathButton({ source }: { source: FormQuestion }) {
  const ctx = useFlow();
  const paths = source.paths ?? [];
  if (paths.length >= MAX_PATHS) {
    return <p className="text-2xs text-zinc-400">{MAX_PATHS} paths is the most a question splits into (counting Otherwise).</p>;
  }
  // "Any other answer" only while some answer is on no path (an Otherwise with none would go away at once).
  const canAddOtherwise = !otherwisePath(source) && leftoverOptionIds(source).length > 0;
  return (
    <Popover
      label={`Add a path to ${source.label.trim() || "this question"}`}
      panelClassName="w-72 p-1"
      buttonClassName="inline-flex h-7 w-fit items-center gap-1 rounded-md px-1.5 text-xs font-medium text-accent-700 hover:bg-accent-50"
      button={
        <>
          <Plus className="size-3.5" aria-hidden />
          Add path
        </>
      }
    >
      {(close) => (
        <AnswerPicker
          source={source}
          initial={[]}
          title="Answers that lead to the new path"
          hint="An answer is on one path at a time: picking one from another path moves it here."
          applyLabel="Add path"
          otherwiseChoice={
            !canAddOtherwise
              ? undefined
              : () => {
                  close();
                  ctx.commit(addPath(ctx.questions, source.id, [], undefined, true).questions, "Added the path “Otherwise”.");
                }
          }
          onApply={(ids) => {
            close();
            ctx.commit(addPath(ctx.questions, source.id, ids).questions, "Added a path.");
          }}
        />
      )}
    </Popover>
  );
}

// Inside a split question's card: what its paths do, and the hints that keep them working.
export function PathsPanel({
  question,
  onMakeRequired,
  onStopSplitting,
}: {
  question: FormQuestion;
  onMakeRequired: () => void;
  onStopSplitting: () => void;
}) {
  const count = question.paths?.length ?? 0;
  const mapped = question.maps_to?.target === "field";
  return (
    <div className="rounded-md bg-zinc-50 p-2.5" data-paths-panel="">
      <p className="flex items-center gap-1.5 text-xs font-medium text-zinc-700">
        <GitFork className="size-3.5 text-zinc-500" aria-hidden />
        Splits into {count} paths
      </p>
      <p className="mt-1 text-xs text-zinc-500">
        Each answer shows its path’s questions below; the paths meet again after the last one.
        {question.type === "multi_select" ? " Picking several answers shows each of their paths, one after another." : ""}
      </p>
      {!question.required ? (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-amber-800">
          <span>Someone who skips this question sees none of the paths (Otherwise included).</span>
          <button type="button" onClick={onMakeRequired} className="font-medium text-accent-700 hover:underline">
            Make it required
          </button>
        </p>
      ) : null}
      {!mapped ? (
        <p className="mt-1.5 text-xs text-zinc-500">
          Tip: have this question fill in a field (Fills in) so automations and reports can tell which path was taken.
        </p>
      ) : null}
      <button type="button" onClick={onStopSplitting} className="btn-ghost mt-1.5 h-7 px-1.5 text-xs">
        Stop splitting
      </button>
    </div>
  );
}

// "Split into paths" on a choice question that doesn't split yet. Up to 6 answers: one click, one path
// each. More: pick the answers that get their own path (5 at most); the rest go to Otherwise.
export function SplitIntoPathsButton({
  questions,
  question,
  onSplit,
}: {
  questions: FormQuestion[];
  question: FormQuestion;
  onSplit: (next: FormQuestion[], message: string) => void;
}) {
  const reason = splitUnavailableReason(questions, question);
  const options = question.options ?? [];
  const split = (own?: string[]) => {
    const { questions: next, paths, adopted } = splitIntoPaths(questions, question.id, own);
    if (!paths) return;
    const moved = adopted ? ` ${adopted === 1 ? "1 question it already showed moved" : `${adopted} questions it already showed moved`} into ${adopted === 1 ? "its path" : "their paths"}.` : "";
    onSplit(next, `Split “${question.label.trim() || "the question"}” into ${paths} paths.${moved}`);
  };
  const className = "inline-flex h-7 items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 text-xs font-medium text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50";
  if (reason) {
    return (
      <span role="img" aria-label={`Split into paths: ${reason}`} data-tooltip={reason} tabIndex={0} className={`${className} cursor-default text-zinc-400 hover:bg-white`}>
        <Split className="size-3.5" aria-hidden />
        Split into paths
      </span>
    );
  }
  if (options.length <= MAX_PATHS) {
    return (
      <button type="button" onClick={() => split()} className={className} data-tooltip="One path per answer; they meet again after">
        <Split className="size-3.5" aria-hidden />
        Split into paths
      </button>
    );
  }
  return (
    <Popover
      label="Split into paths"
      align="end"
      panelClassName="w-72 p-1"
      buttonClassName={className}
      button={
        <>
          <Split className="size-3.5" aria-hidden />
          Split into paths
        </>
      }
    >
      {(close) => (
        <AnswerPicker
          source={question}
          initial={[]}
          title="Which answers get their own path?"
          hint={`Pick up to ${MAX_PATHS - 1}. Every other answer goes to Otherwise.`}
          applyLabel="Split"
          max={MAX_PATHS - 1}
          onApply={(ids) => {
            close();
            split(ids);
          }}
        />
      )}
    </Popover>
  );
}

// How many questions a path holds (Delete path asks only when it has some).
export function pathQuestionCount(questions: FormQuestion[], sourceId: string, pathId: string): number {
  return blockQuestionIds(questions, sourceId, pathId).length;
}

// "Delete path" (and an Otherwise left with no answers): where its questions go. A small alertdialog like
// the app's confirm, with three choices; Escape (caught first, so the form editor stays open) cancels.
export function PathChoiceDialog({
  title,
  message,
  cancelLabel,
  single,
  onKeep,
  onDelete,
  onCancel,
}: {
  title: string;
  message: string;
  cancelLabel: string;
  // One question: "Delete it".
  single: boolean;
  onKeep: () => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const messageId = useId();
  const cancelRef = useRef(onCancel);
  const keepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current = onCancel;
  }, [onCancel]);
  useEffect(() => {
    const returnFocus = document.activeElement as HTMLElement | null;
    keepRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      cancelRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      returnFocus?.focus?.();
    };
  }, []);
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-zinc-900/30 p-4" onMouseDown={(e) => e.stopPropagation()}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        className="ui-anim-pop-in w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5 text-sm shadow-xl"
      >
        <h2 id={titleId} className="text-base font-semibold text-zinc-900">
          {title}
        </h2>
        <p id={messageId} className="mt-1.5 text-sm text-zinc-600">
          {message}
        </p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onCancel} className="btn-secondary">
            {cancelLabel}
          </button>
          <button type="button" onClick={onDelete} className="btn-secondary text-red-700 hover:bg-red-50">
            {single ? "Delete it" : "Delete them"}
          </button>
          <button ref={keepRef} type="button" onClick={onKeep} className="btn-primary">
            Keep on the main flow
          </button>
        </div>
      </div>
    </div>
  );
}
