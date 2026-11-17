"use client";

import { useClosesPopovers } from "@/components/overlay-registry";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import {
  AlignLeft,
  ArrowDown,
  ArrowUp,
  AtSign,
  Calendar,
  CircleAlert,
  CircleChevronDown,
  Copy,
  CopyPlus,
  ExternalLink,
  Eye,
  FileInput,
  GitBranch,
  GitFork,
  Globe,
  GripVertical,
  Hash,
  Heading,
  Link2,
  ListChecks,
  Paperclip,
  Plus,
  RotateCcw,
  Share2,
  SquareCheck,
  Trash2,
  Type,
  X,
  type LucideIcon,
} from "lucide-react";
import { useConfirm } from "@/components/confirm";
import { FormQuestionField } from "@/components/forms/public-form";
import {
  PathChoiceDialog,
  PathsPanel,
  QuestionFlow,
  SplitIntoPathsButton,
  pathQuestionCount,
  pathTags,
  type FlowContext,
  type PathTag,
} from "@/components/forms/form-flow";
import { OptionsEditor } from "@/components/forms/form-options";
import { FieldTypeIcon } from "@/components/project/field-editor";
import { Popover } from "@/components/popover";
import { SmartPicker } from "@/components/smart-picker";
import { useNotify, useServerAction } from "@/components/toast";
import { FormLiveSwitch, FormStatusBadge } from "@/components/forms/form-status";
import { deleteForm, duplicateForm, setFormLive, updateForm } from "@/lib/actions/forms";
import { EMBED_NOTE, formEmbedSnippet } from "@/lib/form-embed";
import type { ActionResult } from "@alhc/core/api/core/result";
import { MAX_ATTACHMENT_LABEL } from "@alhc/core/attachments";
import { FORM_LOCKED_FIELD_NOTE, type FieldDef } from "@alhc/core/fields";
import { FieldLockIcon } from "@/components/project/field-lock";
import {
  applyPaths,
  blockQuestionIds,
  buildFlow,
  canPlaceIn,
  checkboxToYesNo,
  clearBranch,
  containerKey,
  containerOf,
  deletePath,
  driftedPathQuestions,
  fieldAskInContainer,
  formProblems,
  insertAfter,
  insertIntoContainer,
  keepBrokenBranchesInPath,
  mappingConflicts,
  moveInFlow,
  moveOutOfPath,
  moveOutWords,
  movingGroup,
  pathAnswersText,
  pathLabel,
  pathProblems,
  placeQuestion,
  problemSummary,
  putPathsTogether,
  questionOwners,
  stopSplitting,
  type FlowContainer,
  type FlowNode,
  type FormProblem,
} from "@alhc/core/form-paths";
import {
  BATCH4_QUESTION_TYPES,
  MAX_FILES_PER_QUESTION,
  QUESTION_TYPES,
  REAL1_QUESTION_TYPES,
  branchOptions,
  brokenBranches,
  clearedBranchesMessage,
  lostBranches,
  lostBranchesMessage,
  narrowedBranches,
  narrowedBranchesMessage,
  fieldAccepts,
  isAnswerable,
  isBranchSource,
  isChoice,
  mapTargetLabel,
  moveQuestionBy,
  normalizeQuestions,
  isNameQuestion,
  ensureNameQuestion,
  questionForField,
  visibleQuestionIds,
  type FormAnswers,
  type FormDef,
  type FormPath,
  type FormQuestion,
  type MapTarget,
  type QuestionType,
  EMAIL_QUESTION_NOTE,
  branchUnavailableReason,
  insertBranchQuestion,
  showInBranch,
} from "@alhc/core/forms";
import { projectColorClass } from "@/lib/project-colors";

type SectionRef = { id: string; name: string };

const TYPE_ICONS: Record<QuestionType, LucideIcon> = {
  short_text: Type,
  long_text: AlignLeft,
  single_select: CircleChevronDown,
  multi_select: ListChecks,
  checkbox: SquareCheck,
  date: Calendar,
  number: Hash,
  email: AtSign,
  heading: Heading,
  attachment: Paperclip,
};

// Question types this database supports: Email / Heading need Asana parity, batch 4's update, Attachment
// Real features 1's (a type a form already uses always stays listed).
function typeAvailable(type: QuestionType, batch4: boolean, real1: boolean) {
  return (batch4 || !BATCH4_QUESTION_TYPES.includes(type)) && (real1 || !REAL1_QUESTION_TYPES.includes(type));
}

const LABEL = "block text-xs font-medium text-zinc-600";
const INPUT = "field h-8 w-full";
const PICKER = "mt-1 h-8 w-full";
// The drag data type of a question card's handle (native drag and drop, like the pane's subtasks).
const QUESTION_DRAG = "application/x-alhc-form-question";

function newId() {
  return crypto.randomUUID();
}

// Asana's form editor (Asana parity, batch 4): a large modal over the project's forms. On the left, a
// live preview of the form (banner, title, description, questions — answer choice questions to see the
// branches open); on the right, Questions and Settings tabs, "+ New question" (a project field, or a
// question type), and per-question branching ("If the answer is X, show …"). The header says who can
// submit and has View form, Share form, and Copy link. Saving goes through updateForm, which the
// database validates again (validate_form), so submissions keep working exactly as before.
// Batch 43 (note 143): the questions are a flow (form-flow.tsx): a choice question can split into paths
// that meet again; problems sit on the card at fault; Save never sends Live / Off and both are checked
// against the form's last-read version.
export function FormEditor({
  form,
  sections,
  fields,
  origin,
  batch4,
  real1,
  canEdit,
  closeHref,
}: {
  form: FormDef;
  sections: SectionRef[];
  fields: FieldDef[];
  origin: string;
  // Asana parity, batch 4's database update: Email and Heading questions.
  batch4: boolean;
  // Real features 1's database update: Attachment questions.
  real1: boolean;
  // Owners and Editors build forms (Nov 10); everyone else gets a read-only editor.
  canEdit: boolean;
  closeHref: string;
}) {
  const router = useRouter();
  const notify = useNotify();
  const titleId = useId();
  const [pending, run] = useServerAction();
  const confirm = useConfirm();
  const [title, setTitle] = useState(form.title);
  const [description, setDescription] = useState(form.description ?? "");
  const [destination, setDestination] = useState(form.destinationSectionId ?? "");
  const [accepting, setAccepting] = useState(form.acceptingResponses);
  const [sendConfirmation, setSendConfirmation] = useState(form.sendConfirmation);
  const [verifiedOnly, setVerifiedOnly] = useState(Boolean(form.verifiedDomainsOnly));
  const [confirmationMessage, setConfirmationMessage] = useState(form.confirmationMessage ?? "");
  // Batch 43: path questions whose stored answers disagree with their paths (written outside this editor)
  // are drawn, previewed, and saved by their paths; the editor says so (to people who can save it).
  const [drifted, setDrifted] = useState(() => (canEdit ? driftedPathQuestions(ensureNameQuestion(form.questions)) : []));
  const [questions, setQuestions] = useState<FormQuestion[]>(() => {
    const loaded = ensureNameQuestion(form.questions);
    return drifted.length ? applyPaths(loaded) : loaded;
  });
  const [dirty, setDirty] = useState(drifted.length > 0);
  const [tab, setTab] = useState<"questions" | "settings">("questions");
  const [selectedId, setSelectedId] = useState<string | null>(form.questions[0]?.id ?? null);
  const [answers, setAnswers] = useState<FormAnswers>({});
  // Dragging a question card by its handle: the card being dragged, and where it would land (a container
  // and the question it would sit before; null = the container's end).
  const [dragging, setDragging] = useState<string | null>(null);
  // The dragged unit fades a frame after the drag starts (the browser takes its drag image first).
  const [faded, setFaded] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  // C107 (Nov 10): below 1024 px the preview and the editing side take turns (the header's Preview button).
  const [narrowPreview, setNarrowPreview] = useState(false);
  // Batch 43: problems on the cards. Ones that make a question never show are on from the start; empty
  // labels and answers only once a save was tried (a new card isn't an error while you type into it).
  const [showAllProblems, setShowAllProblems] = useState(false);
  // "Delete path" (and an Otherwise left with no answers) asks where the path's questions go.
  const [pathChoice, setPathChoice] = useState<PathChoice | null>(null);
  // Read by the Escape handler: set as soon as a drag starts (the faded card waits a frame).
  const dragRef = useRef<string | null>(null);
  // The last drop target worked out during a drag (dragover fires many times a second on one spot).
  const lastTarget = useRef<string | null>(null);
  // Screen readers hear where a moved question went.
  const [announcement, setAnnouncement] = useState("");
  const dirtyRef = useRef(dirty);
  // The latest questions, for the Undo toasts and the steps that ask first (they run after later renders).
  const questionsRef = useRef(questions);
  useEffect(() => {
    questionsRef.current = questions;
  }, [questions]);
  // Batch 43 (item 8): the form's updated_at this editor last read or wrote. Save and Live / Off write only
  // while it still matches; only this editor's own successful writes move it on.
  const versionRef = useRef(form.updatedAt);
  // A new question's label takes the focus once its card is open.
  const focusLabelRef = useRef<string | null>(null);
  // An element to focus after the next render: a card that moved into another list is a new element, so
  // the control that moved it gets the focus back this way.
  const focusAfterRef = useRef<string | null>(null);
  // Field mappings a Duplicate dropped (a copy never fills in a field twice), offered back if the copy moves
  // to a path that can't show with its original.
  const droppedMappings = useRef(new Map<string, NonNullable<FormQuestion["maps_to"]>>());
  const panelRef = useRef<HTMLDivElement>(null);

  const publicUrl = `${origin}/forms/${form.id}`;
  const embedSnippet = formEmbedSnippet(origin, form.id, title);
  const visible = useMemo(() => visibleQuestionIds(questions, answers), [questions, answers]);
  const flow = useMemo(() => buildFlow(questions), [questions]);
  const tags = useMemo(() => pathTags(flow.nodes), [flow]);
  const problems = useMemo(() => formProblems(questions), [questions]);
  const shownProblems = useMemo(
    () => problems.filter((p) => showAllProblems || !LATE_PROBLEMS.has(p.kind)),
    [problems, showAllProblems],
  );
  const problemsByPath = useMemo(
    () => new Map(shownProblems.flatMap((p) => (p.pathId ? [[p.pathId, p] as const] : []))),
    [shownProblems],
  );
  const sectionFieldIds = useMemo(() => new Set(fields.filter((f) => f.boundToSections).map((f) => f.id)), [fields]);
  const conflicts = useMemo(() => mappingConflicts(questions, sectionFieldIds), [questions, sectionFieldIds]);
  const movingIds = useMemo(() => new Set(faded ? movingGroup(questions, faded) : []), [questions, faded]);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  // A new question opens with its label focused.
  useEffect(() => {
    const id = focusLabelRef.current;
    if (!id || selectedId !== id) return;
    const input = document.getElementById(`fq-${id}-label`);
    if (input instanceof HTMLInputElement) {
      focusLabelRef.current = null;
      input.focus();
    }
  }, [selectedId, questions]);

  useEffect(() => {
    const id = focusAfterRef.current;
    if (!id) return;
    focusAfterRef.current = null;
    document.getElementById(id)?.focus();
  }, [questions]);

  async function close() {
    if (dirtyRef.current && !(await confirm({ title: "Discard your unsaved changes to this form?", confirmLabel: "Discard", tone: "danger" }))) {
      return;
    }
    router.push(closeHref);
  }
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });

  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      // Escape during a drag only cancels the drag.
      if (e.key !== "Escape" || e.defaultPrevented || dragRef.current) return;
      e.preventDefault();
      closeRef.current();
    };
    // Leaving the page with unsaved changes asks first.
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, []);

  function touch<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setDirty(true);
    };
  }

  // A quiet change (typing a label, ticking Required).
  function changeQuestions(next: (current: FormQuestion[]) => FormQuestion[]) {
    setQuestions((current) => normalizeQuestions(next(current), fields));
    setDirty(true);
  }

  function announce(message: string) {
    // The same words twice in a row still get read out (a live region ignores an unchanged text).
    setAnnouncement((prev) => (prev === message ? `${message}\u200b` : message));
  }

  // A change that says what it did, with Undo while nothing else changed since. It also says when branches
  // lost answers or disappeared (C36, batch 43: a removed answer, a replaced answer list, a path given fewer
  // answers), and asks where an Otherwise's questions go when a change leaves it no answers.
  // `moved` = questions the change moves on purpose (their new place is the message; they aren't reported
  // as having lost a branch).
  function commit(next: FormQuestion[], message: string | null, moved: string[] = []) {
    const previous = questionsRef.current;
    if (next === previous) return;
    const result = normalizeQuestions(next, fields);
    questionsRef.current = result;
    setQuestions(result);
    setDirty(true);
    const before = new Set(pathProblems(previous).map((p) => `${p.kind}:${p.pathId}`));
    const fresh = pathProblems(result).filter(
      (p) => (p.kind === "otherwise_empty" || p.kind === "path_empty") && !before.has(`${p.kind}:${p.pathId}`),
    );
    const emptied = fresh.find((p) => p.kind === "otherwise_empty");
    if (emptied?.pathId) setPathChoice({ sourceId: emptied.questionId, pathId: emptied.pathId, reason: "otherwise" });
    // Questions the change moves on purpose, and an emptied Otherwise's (the dialog asks about them), aren't
    // reported as losing their branch.
    const quiet = new Set([...moved, ...(emptied?.pathId ? blockQuestionIds(result, emptied.questionId, emptied.pathId) : [])]);
    const lost = lostBranches(previous, result).filter((q) => !quiet.has(q.id));
    const narrowed = narrowedBranches(previous, result);
    const hadPaths = new Set(previous.filter((q) => q.paths?.length).map((q) => q.id));
    const unsplit = message ? [] : result.filter((q) => hadPaths.has(q.id) && !q.paths?.length);
    const text = [
      message,
      ...unsplit.map((q) => `“${q.label.trim() || "The question"}” no longer splits into paths.`),
      ...fresh.map((p) => {
        const source = result.find((q) => q.id === p.questionId);
        const path = source?.paths?.find((x) => x.id === p.pathId);
        return source && path ? `The path “${pathLabel(source, path)}” has no answers left.` : null;
      }),
      lost.length ? lostBranchesMessage(lost) : null,
      narrowedBranchesMessage({
        narrowed: narrowed.narrowed.filter((q) => !quiet.has(q.id)),
        emptied: narrowed.emptied.filter((q) => !quiet.has(q.id)),
      }),
    ]
      .filter(Boolean)
      .join(" ");
    if (!text) return;
    notify(text, {
      label: "Undo",
      onClick: () => {
        if (questionsRef.current !== result) return;
        questionsRef.current = previous;
        setQuestions(previous);
        setPathChoice(null);
        setDirty(true);
      },
    });
  }

  function updateQuestion(id: string, next: FormQuestion) {
    const before = questions.find((q) => q.id === id);
    // A type change, or answers that change what a branch or path shows, says so with Undo (commit only
    // speaks when something did change).
    if (before && (before.type !== next.type || before.options !== next.options)) {
      commit(
        questions.map((q) => (q.id === id ? next : q)),
        null,
      );
      return;
    }
    changeQuestions((current) => current.map((q) => (q.id === id ? next : q)));
  }

  function opened(question: FormQuestion) {
    setSelectedId(question.id);
    setTab("questions");
    focusLabelRef.current = question.id;
  }

  // Batch 43: "+ New question" adds to the end of the main flow (never into a path by accident);
  // "+ Add question to this path" to that path's end; a card's "Add a question below" right after it, in
  // the same path.
  function addQuestion(question: FormQuestion, where: { container: FlowContainer } | { after: string }) {
    const next = "after" in where ? insertAfter(questions, where.after, question) : insertIntoContainer(questions, where.container, question);
    commit(next, null);
    opened(question);
  }

  // The one reorder path within a flow (buttons, Alt+↑ / Alt+↓, and drops). Worked out from this render's
  // questions in the event handler, not in a state updater (StrictMode runs updaters twice, which would
  // toast twice). A move that puts a branch question below the questions it shows clears those branches
  // (the database only accepts a branch on an earlier question), with Undo. The order saves with the form.
  function applyOrder(movedId: string, moved: FormQuestion[]) {
    if (moved === questions) return;
    // Inside a path, a question moved above the question it depends on keeps showing on its path.
    const { questions: repaired, kept } = keepBrokenBranchesInPath(moved, questions);
    const broken = brokenBranches(repaired);
    const previous = questions;
    const next = normalizeQuestions(repaired, fields);
    questionsRef.current = next;
    setQuestions(next);
    setDirty(true);
    const position = next.findIndex((q) => q.id === movedId);
    const label = next[position]?.label.trim() || "Untitled question";
    announce(`Moved “${label}” to position ${position + 1} of ${next.length}`);
    const keptText = kept.length
      ? kept.length === 1
        ? `“${labelOf(next, kept[0])}” now shows on its whole path: the question it depended on is no longer above it.`
        : `${kept.length} questions now show on their whole path: the questions they depended on are no longer above them.`
      : null;
    const text = [broken.length ? clearedBranchesMessage(broken) : null, keptText].filter(Boolean).join(" ");
    if (text) {
      notify(text, {
        label: "Undo",
        // Only while nothing else changed since (an Undo never throws away later edits), and the form
        // is unsaved again afterwards, so the restored branch gets saved too.
        onClick: () => {
          if (questionsRef.current !== next) return;
          questionsRef.current = previous;
          setQuestions(previous);
          setDirty(true);
        },
      });
    }
  }

  // Move up / down and Alt+↑ / Alt+↓: past the question next to it in the same flow, carrying its paths. At
  // a path's first or last place it asks "Move it to the main flow?" instead of clearing its branch.
  async function moveQuestion(id: string, delta: -1 | 1) {
    const result = moveInFlow(questions, id, delta);
    if (result === null) {
      if (!flow.inOrder) applyOrder(id, moveQuestionBy(questions, id, delta));
      return;
    }
    if ("questions" in result) {
      applyOrder(id, result.questions);
      return;
    }
    const words = moveOutWords(questions, id);
    if (!(await confirm({ title: words.title, message: words.message, confirmLabel: "Move it out" }))) return;
    const label = labelOf(questionsRef.current, id);
    focusAfterRef.current = `fq-${id}-toggle`;
    commit(moveOutOfPath(questionsRef.current, id, result.edge), `Moved “${label}” out of its path.`, [id]);
    announce(`Moved “${label}” out of its path`);
  }

  function startDrag(id: string) {
    dragRef.current = id;
    lastTarget.current = null;
    setDragging(id);
    // Fade the card a frame later: the browser takes its drag image from the card as the drag starts.
    requestAnimationFrame(() => {
      if (dragRef.current === id) setFaded(id);
    });
  }

  function endDrag() {
    dragRef.current = null;
    setDragging(null);
    setFaded(null);
    setDrop(null);
  }

  // Where a drop would land, kept only when it would move something (no line where nothing would change,
  // inside the question's own paths, or in a path the requester's name can't join).
  function dragOver(target: DropTarget) {
    const id = dragRef.current;
    if (!id) return;
    const key = `${containerKey(target.container)}|${target.beforeId ?? ""}`;
    if (key === lastTarget.current) return;
    lastTarget.current = key;
    const valid = canPlaceIn(questions, id, target.container) && placeQuestion(questions, id, target.container, target.beforeId) !== questions;
    setDrop(valid ? target : null);
  }

  async function dropQuestion(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    const id = e.dataTransfer.getData(QUESTION_DRAG) || dragRef.current;
    const target = drop;
    lastTarget.current = null;
    endDrag();
    if (!id || !target) return;
    const from = containerOf(id, flow.owner);
    if (containerKey(from) === containerKey(target.container)) {
      applyOrder(id, placeQuestion(questions, id, target.container, target.beforeId));
      return;
    }
    const label = labelOf(questions, id);
    if (from && !target.container) {
      // Out of a path onto the main flow: one level out (below the question it names) it keeps the split
      // question's own rule, like Move out of the path; otherwise it shows to everyone. The confirm says
      // which, from the rule the move actually leaves it.
      const kept = placeQuestion(questions, id, null, target.beforeId).find((q) => q.id === id)?.show_if;
      const words = kept ? moveOutWords(questions, id) : null;
      const ok = await confirm({
        title: words?.title ?? `Move “${label}” to the main flow?`,
        message: words?.message ?? "It leaves its path and shows to everyone, whatever the answer.",
        confirmLabel: "Move it",
      });
      if (!ok) return;
    }
    const next = placeQuestion(questionsRef.current, id, target.container, target.beforeId);
    const into = target.container ? pathNameOf(next, target.container) : null;
    commit(next, into ? `Moved “${label}” into the path “${into}”.` : `Moved “${label}” to the main flow.`, [id]);
    announce(into ? `Moved “${label}” into the path ${into}` : `Moved “${label}” to the main flow`);
    if (target.container) offerMappingBack(id, target.container, next);
  }

  // The Paths menu on a split question: an existing question joins one of its paths.
  function placeInPath(id: string, container: NonNullable<FlowContainer>) {
    const next = placeQuestion(questionsRef.current, id, container, null);
    commit(next, `Moved “${labelOf(next, id)}” into the path “${pathNameOf(next, container)}”.`, [id]);
    offerMappingBack(id, container, next);
  }

  // Item 5: a Duplicate dropped the copy's field mapping; once it's in a path that can't show with the
  // field's other questions, offer it back.
  function offerMappingBack(id: string, container: FlowContainer, next: FormQuestion[]) {
    const mapping = droppedMappings.current.get(id);
    const fieldId = mapping?.target === "field" ? mapping.field_id : undefined;
    if (!mapping || !fieldId || !fieldAskInContainer(next.filter((q) => q.id !== id), fieldId, container).allowed) return;
    const field = fields.find((f) => f.id === fieldId);
    notify(`“${labelOf(next, id)}” can’t show with the other questions that fill in ${field?.name ?? "that field"}. Fill it in from here too?`, {
      label: `Fill in ${field?.name ?? "the field"}`,
      onClick: () => {
        droppedMappings.current.delete(id);
        changeQuestions((current) => current.map((q) => (q.id === id && !q.maps_to ? { ...q, maps_to: mapping } : q)));
      },
    });
  }

  // Item 68: "Create new question" from a branch: a short answer right after the source's branch (in the
  // answer's path when the question splits), shown only for that answer, opened with its label focused.
  function createBranchQuestion(sourceId: string, optionId: string) {
    const question: FormQuestion = { id: newId(), type: "short_text", label: "" };
    commit(insertBranchQuestion(questions, sourceId, optionId, question), null);
    opened(question);
  }

  function removeQuestion(id: string) {
    commit(
      questions.filter((q) => q.id !== id),
      `Deleted “${labelOf(questions, id)}”.`,
    );
    if (selectedId === id) setSelectedId(null);
  }

  function duplicateQuestion(question: FormQuestion) {
    const copy: FormQuestion = {
      ...question,
      id: newId(),
      label: `${question.label} (copy)`.slice(0, 500),
      ...(question.options ? { options: question.options.map((o) => ({ ...o, id: newId() })) } : {}),
    };
    // A copy has new answer ids, so it doesn't split (its original's paths stay with the original).
    delete copy.paths;
    // A copy never fills in the same field twice (offered back if it moves to a sibling path).
    if (copy.maps_to?.target === "field") {
      droppedMappings.current.set(copy.id, copy.maps_to);
      delete copy.maps_to;
    }
    commit(insertAfter(questions, question.id, copy, true), null);
    setSelectedId(copy.id);
  }

  // Opens the card at fault (its label focused when that's what's missing) and says what to fix.
  function revealProblem(problem: FormProblem) {
    setShowAllProblems(true);
    setTab("questions");
    setNarrowPreview(false);
    setSelectedId(problem.questionId);
    if (problem.kind === "label") focusLabelRef.current = problem.questionId;
    requestAnimationFrame(() => {
      const target = problem.pathId
        ? document.querySelector<HTMLElement>(`[data-path="${problem.pathId}"]`)
        : document.getElementById(`fq-${problem.questionId}-toggle`);
      target?.scrollIntoView({ block: "center" });
      if (!problem.pathId && problem.kind !== "label") target?.focus();
    });
  }

  function reportProblems() {
    const first = problems[0];
    if (!first) return false;
    revealProblem(first);
    notify(problems.length === 1 ? `Fix this before saving. ${problemSummary(first, questions)}` : `Fix ${problems.length} things before saving. First: ${problemSummary(first, questions)}`);
    return true;
  }

  async function reload() {
    if (
      dirtyRef.current &&
      !(await confirm({ title: "Load the latest version?", message: "Your unsaved changes in this editor will be lost.", confirmLabel: "Reload", tone: "danger" }))
    ) {
      return;
    }
    dirtyRef.current = false;
    window.location.reload();
  }

  // A refused write that says someone else changed the form gets a Reload button instead of a plain toast.
  function conflictAware(result: ActionResult & { updatedAt?: string }) {
    if (result.code !== "conflict") return result;
    notify(result.error ?? "Someone else changed this form.", { label: "Reload", onClick: () => void reload() });
    return {};
  }

  // Item 4: Save sends the questions and settings, never Live / Off (that switch saves itself), so a Save
  // can't undo a Live / Off change made in another tab.
  function save(after?: () => void) {
    if (reportProblems()) return;
    run(async () => {
      const result = await updateForm(form.id, {
        title,
        description: description || null,
        questions: normalizeQuestions(questions, fields, true),
        destinationSectionId: destination || null,
        sendConfirmation,
        confirmationMessage: confirmationMessage || null,
        ...(verifiedOnly !== Boolean(form.verifiedDomainsOnly) ? { verifiedDomainsOnly: verifiedOnly } : {}),
        expectedUpdatedAt: versionRef.current,
      });
      if (result.updatedAt) versionRef.current = result.updatedAt;
      if (!result.error) {
        setDirty(false);
        setDrifted([]);
        notify("Form saved");
        after?.();
      }
      return conflictAware(result);
    });
  }

  // The header's Live / Off switch (and the Settings tab's) saves at once, apart from the editor's Save.
  // Item 4: going live with unsaved edits asks "Save and go live?" (the live form shows the saved version).
  const [livePending, runLive] = useServerAction();
  function writeLive(next: boolean) {
    const previous = accepting;
    setAccepting(next);
    runLive(async () => {
      const result = await setFormLive(form.id, next, versionRef.current);
      if (result.updatedAt) versionRef.current = result.updatedAt;
      if (result.error) setAccepting(previous);
      else notify(next ? "Form is live: it takes responses" : "Form is off: it no longer takes responses");
      return conflictAware(result);
    });
  }
  async function changeLive(next: boolean) {
    // One write at a time: each carries the version the one before it returned.
    if (pending || livePending) return;
    if (next && dirtyRef.current) {
      const ok = await confirm({
        title: "Save your changes and go live?",
        message: "The live form shows what’s saved. Save now so people get the version you’re looking at.",
        confirmLabel: "Save and go live",
      });
      if (ok) save(() => writeLive(true));
      return;
    }
    writeLive(next);
  }

  function askDeletePath(source: FormQuestion, path: FormPath) {
    if (!pathQuestionCount(questions, source.id, path.id)) {
      finishDeletePath(source.id, path.id, "delete");
      return;
    }
    setPathChoice({ sourceId: source.id, pathId: path.id, reason: "delete" });
  }

  function finishDeletePath(sourceId: string, pathId: string, mode: "keep" | "delete") {
    const base = questionsRef.current;
    const source = base.find((q) => q.id === sourceId);
    const path = source?.paths?.find((p) => p.id === pathId);
    if (!source || !path) return;
    const next = deletePath(base, sourceId, pathId, mode);
    const stillSplits = Boolean(next.find((q) => q.id === sourceId)?.paths?.length);
    const kept = source.show_if
      ? `; its questions now show whenever “${source.label.trim() || "the question"}” shows`
      : "; its questions are on the main flow";
    commit(
      next,
      `Deleted the path “${pathLabel(source, path)}”${mode === "keep" ? kept : ""}.${
        stillSplits ? "" : ` “${source.label.trim() || "The question"}” no longer splits: its last path’s questions stay, as a plain branch on it.`
      }`,
      mode === "keep" ? blockQuestionIds(base, sourceId, pathId) : [],
    );
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify(`${what} copied`);
    } catch {
      notify("Couldn’t copy. Select the text and copy it instead.");
    }
  }

  useClosesPopovers();

  // Where each card sits among its siblings (Move up / down: in a path, the edges ask to move it out).
  const siblingInfo = useMemo(() => {
    const info = new Map<string, { first: boolean; last: boolean; inPath: boolean }>();
    const visit = (nodes: FlowNode[], inPath: boolean) =>
      nodes.forEach((node, i) => {
        info.set(node.question.id, { first: i === 0, last: i === nodes.length - 1, inPath });
        for (const block of node.blocks ?? []) visit(block.nodes, true);
      });
    visit(flow.nodes, false);
    return info;
  }, [flow]);

  const flowCtx: FlowContext = {
    questions,
    problemsByPath,
    dragActive: Boolean(dragging),
    dropAtEnd: (container) => Boolean(drop && drop.beforeId === null && containerKey(drop.container) === containerKey(container)),
    onDragOverEnd: (container) => dragOver({ container, beforeId: null }),
    commit,
    askDeletePath,
    isMoving: (id) => movingIds.has(id),
    renderAdd: (container, label) => (
      <NewQuestionMenu
        variant="path"
        label={label}
        container={container}
        fields={fields}
        sections={sections}
        questions={questions}
        batch4={batch4}
        real1={real1}
        onAdd={(question) => addQuestion(question, { container })}
      />
    ),
    renderCard: (node, place) => {
      const question = node.question;
      const where = siblingInfo.get(question.id);
      const conflict = conflicts.find((c) => c.questionId === question.id);
      return (
        <QuestionCard
          index={node.index}
          question={question}
          questions={questions}
          sections={sections}
          fields={fields}
          batch4={batch4}
          real1={real1}
          tag={tags.get(question.id) ?? null}
          misplaced={Boolean(node.misplaced)}
          problems={shownProblems.filter((p) => p.questionId === question.id && !p.pathId)}
          conflict={conflict ? { label: labelOf(questions, conflict.otherId), target: conflict.target } : null}
          open={selectedId === question.id}
          draggable={canEdit && questions.length > 1}
          dropLine={Boolean(drop && drop.beforeId === question.id && containerKey(drop.container) === containerKey(place.container))}
          canMoveUp={flow.inOrder ? Boolean(where && (!where.first || where.inPath)) : node.index > 0}
          canMoveDown={flow.inOrder ? Boolean(where && (!where.last || where.inPath)) : node.index < questions.length - 1}
          onDragStart={() => startDrag(question.id)}
          onDragEnd={endDrag}
          onDragOverCard={
            dragging
              ? (after) =>
                  dragOver({
                    container: place.container,
                    // A card's lower half: after it. A split question's whole card means "before it": its
                    // paths follow it, so "after" is the "+ Add question" row or the card after "Paths meet here".
                    beforeId: after && !question.paths?.length ? place.nextSiblingId : question.id,
                  })
              : undefined
          }
          onToggle={() => setSelectedId(selectedId === question.id ? null : question.id)}
          onChange={(next) => updateQuestion(question.id, next)}
          onCommit={commit}
          onCreateBranch={(optionId) => createBranchQuestion(question.id, optionId)}
          onAddTo={(container, added) => addQuestion(added, { container })}
          onPlaceIn={(childId, container) => placeInPath(childId, container)}
          onMove={(delta) => void moveQuestion(question.id, delta)}
          onDuplicate={() => duplicateQuestion(question)}
          onRemove={() => removeQuestion(question.id)}
          onAnnounce={announce}
          addBelow={
            <NewQuestionMenu
              variant="icon"
              label={tags.get(question.id) ? `Add a question below, in the path “${tags.get(question.id)?.label}”` : "Add a question below"}
              container={containerOf(question.id, flow.owner)}
              fields={fields}
              sections={sections}
              questions={questions}
              batch4={batch4}
              real1={real1}
              onAdd={(added) => addQuestion(added, { after: question.id })}
            />
          }
        />
      );
    },
  };

  const choice = pathChoice ? describePathChoice(questions, pathChoice) : null;

  return (
    <div className="fixed inset-0 z-50 flex bg-zinc-900/40 p-2 sm:p-4" onMouseDown={close}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
        className="mx-auto flex h-full w-full max-w-[90rem] flex-col overflow-hidden rounded-xl bg-white text-sm shadow-2xl"
      >
        <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-zinc-200 px-4 py-2">
          <span aria-hidden className={`flex size-8 shrink-0 items-center justify-center rounded-lg text-white ${projectColorClass(form.projectId)}`}>
            <FileInput className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="flex min-w-0 items-center gap-2 text-base font-semibold text-zinc-900">
              <span className="truncate">{title.trim() || "Untitled form"}</span>
              <FormStatusBadge live={accepting} />
            </h2>
            <p className="flex flex-wrap items-center gap-x-2 text-xs text-zinc-500">
              <span className="inline-flex items-center gap-1" data-tooltip="No sign-in needed. Signed-in people see their email filled in.">
                <Globe className="size-3.5" aria-hidden />
                Who can submit: {verifiedOnly ? "Verified-domain emails with the link" : "Anyone with the link"}
              </span>
              <span>{accepting ? "Taking responses" : "Not taking responses: visitors see a closed notice"}</span>
              {dirty ? (
                <span className="text-amber-700" data-tooltip={accepting ? "The live form shows the saved version until you save." : undefined}>
                  {accepting ? "Unsaved changes: not live yet" : "Unsaved changes"}
                </span>
              ) : null}
            </p>
          </div>
          {canEdit && shownProblems.length ? (
            <button
              type="button"
              onClick={() => revealProblem(shownProblems[0])}
              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-red-50 px-2.5 text-xs font-medium text-red-800 hover:bg-red-100"
              data-form-problems={shownProblems.length}
            >
              <CircleAlert className="size-3.5" aria-hidden />
              {shownProblems.length === 1 ? "1 thing to fix" : `${shownProblems.length} things to fix`}
            </button>
          ) : null}
          {canEdit ? <FormLiveSwitch live={accepting} disabled={livePending || pending} onChange={(next) => void changeLive(next)} /> : null}
          {canEdit ? (
            <button
              type="button"
              aria-pressed={narrowPreview}
              onClick={() => setNarrowPreview((on) => !on)}
              className="btn-ghost h-8 lg:hidden"
            >
              <Eye className="size-4" aria-hidden />
              {narrowPreview ? "Edit" : "Preview"}
            </button>
          ) : null}
          <a
            href={publicUrl}
            target="_blank"
            rel="noreferrer"
            className="btn-ghost h-8"
            data-tooltip={dirty ? "Opens the saved version: your unsaved changes aren’t in it" : undefined}
          >
            <ExternalLink className="size-4" aria-hidden />
            {dirty ? "View saved form" : "View form"}
          </a>
          <Popover
            label="Share form"
            align="end"
            panelClassName="w-96 p-3"
            buttonClassName="btn-secondary h-8 px-3"
            button={
              <>
                <Share2 className="size-4" aria-hidden />
                Share form
              </>
            }
          >
            {() => (
              <div className="flex flex-col gap-3">
                <p className="text-xs text-zinc-500">
                  {verifiedOnly
                    ? "Anyone with the link whose email is on a verified domain can submit while the form accepts responses."
                    : "Anyone with the link can submit while the form accepts responses."}{" "}
                  Link it from a request hub page, or embed it.
                </p>
                <CopyRow label="Form link" value={publicUrl} onCopy={() => copy(publicUrl, "Form link")} />
                <CopyRow label="Embed code" value={embedSnippet} multiline onCopy={() => copy(embedSnippet, "Embed code")} />
                <p className="text-2xs text-zinc-500">{EMBED_NOTE}</p>
                {!accepting ? (
                  <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
                    {canEdit
                      ? "The form is off: turn it on with the Live switch at the top before sharing it."
                      : "The form is off: visitors see a closed notice until one of the project’s Owners or Editors turns it on."}
                  </p>
                ) : null}
              </div>
            )}
          </Popover>
          <button
            type="button"
            onClick={() => copy(publicUrl, "Form link")}
            aria-label="Copy form link"
            data-tooltip="Copy link"
            className="btn-icon size-8"
          >
            <Link2 className="size-4" />
          </button>
          {canEdit ? (
            <button type="button" onClick={() => save()} disabled={pending || livePending || !dirty || !title.trim()} className="btn-primary h-8 px-3">
              {pending ? "Saving…" : dirty ? "Save" : "Saved"}
            </button>
          ) : null}
          <button type="button" onClick={close} aria-label="Close the form editor" data-tooltip="Close" className="btn-icon size-8">
            <X className="size-4" />
          </button>
        </header>

        <p aria-live="polite" className="sr-only">
          {announcement}
        </p>
        <div className={`grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] ${canEdit ? "lg:grid-cols-[minmax(0,1fr)_30rem]" : ""}`}>
          <section
            aria-label="Preview"
            className={`min-h-0 overflow-y-auto bg-zinc-100 px-4 py-6 sm:px-6 sm:py-8 ${canEdit ? (narrowPreview ? "block" : "hidden lg:block") : "block"}`}
          >
            <Preview
              projectId={form.projectId}
              title={title}
              description={description}
              accepting={accepting}
              sendConfirmation={sendConfirmation}
              questions={questions}
              visible={visible}
              answers={answers}
              tags={tags}
              selectedId={selectedId}
              onAnswer={(id, value) => setAnswers((current) => ({ ...current, [id]: value }))}
              onReset={() => setAnswers({})}
              // Nov 2 notes (batch 15, 108): below Admin there's nothing to edit, so the preview has no
              // per-question Edit button or selection.
              onSelect={
                canEdit
                  ? (id) => {
                      setSelectedId(id);
                      setTab("questions");
                    }
                  : null
              }
            />
          </section>
          {/* Nov 1 notes (batch 11): below Admin the editing side isn't shown at all: the form reads as its preview. */}
          {canEdit ? (
            <section
              aria-label="Edit the form"
              className={`min-h-0 min-w-0 flex-col border-l border-zinc-200 ${narrowPreview ? "hidden lg:flex" : "flex"}`}
            >
              <div role="tablist" aria-label="Form editor" className="tab-strip shrink-0 gap-1 px-4">
                {(
                  [
                    { key: "questions", label: `Questions (${questions.length})` },
                    { key: "settings", label: "Settings" },
                  ] as const
                ).map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={tab === t.key}
                    data-autofocus={t.key === "questions" ? true : undefined}
                    onClick={() => setTab(t.key)}
                    className="inline-flex h-10 shrink-0 items-center border-b-2 border-transparent px-2 text-sm text-zinc-500 hover:text-zinc-900 aria-selected:border-accent-500 aria-selected:font-medium aria-selected:text-zinc-900"
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <fieldset role="tabpanel" className="m-0 min-h-0 min-w-0 flex-1 overflow-y-auto border-0 px-3 py-4 sm:px-4">
                {tab === "questions" ? (
                  // The whole Questions tab takes drops (on the line the pointer last drew), and the line
                  // goes away when a drag leaves it.
                  <div
                    className="flex flex-col gap-2"
                    onDragOver={(e) => {
                      if (!dragging) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = drop ? "move" : "none";
                    }}
                    onDragLeave={(e) => {
                      if (dragging && !e.currentTarget.contains(e.relatedTarget as Node | null)) {
                        lastTarget.current = null;
                        setDrop(null);
                      }
                    }}
                    onDrop={dragging ? (e) => void dropQuestion(e) : undefined}
                  >
                    <div className="flex items-start gap-2">
                      <p className="min-w-0 flex-1 text-xs text-zinc-500">
                        Every submission also asks for the submitter’s email. Answers that don’t fill in a task detail are
                        listed in the task description.
                      </p>
                      <NewQuestionMenu
                        variant="bar"
                        label="New question"
                        container={null}
                        fields={fields}
                        sections={sections}
                        questions={questions}
                        batch4={batch4}
                        real1={real1}
                        onAdd={(question) => addQuestion(question, { container: null })}
                      />
                    </div>
                    {drifted.length ? (
                      <div role="status" className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-path-drift="">
                        <CircleAlert className="mt-px size-4 shrink-0" aria-hidden />
                        <span>
                          {drifted.length === 1 ? "A question’s saved rule didn’t match its path" : `${drifted.length} questions’ saved rules didn’t match their paths`}{" "}
                          (changed outside this editor). They follow their paths here; save to put the live form back in step.
                        </span>
                      </div>
                    ) : null}
                    {!flow.inOrder ? (
                      <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                        <CircleAlert className="size-4 shrink-0" aria-hidden />
                        <span className="min-w-0 flex-1">Some questions sit outside their path, so it isn’t clear where the paths meet.</span>
                        <button
                          type="button"
                          onClick={() => commit(putPathsTogether(questions), "Put the paths together.")}
                          className="btn-secondary h-7 px-2 text-xs"
                        >
                          Put paths together
                        </button>
                      </div>
                    ) : null}
                    {questions.length === 0 ? (
                      <p className="rounded-lg border border-dashed border-zinc-200 px-3 py-6 text-center text-xs text-zinc-500">
                        No questions yet. Add one, or ask about one of this project’s fields.
                      </p>
                    ) : (
                      <QuestionFlow nodes={flow.nodes} ctx={flowCtx} />
                    )}
                    <div
                      className="relative mt-1"
                      onDragOver={
                        dragging
                          ? (e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              dragOver({ container: null, beforeId: null });
                            }
                          : undefined
                      }
                    >
                      {drop && drop.container === null && drop.beforeId === null ? (
                        <span aria-hidden className="pointer-events-none absolute inset-x-1 -top-[5px] h-0.5 rounded-full bg-accent-500" />
                      ) : null}
                      <NewQuestionMenu
                        variant="end"
                        label="New question"
                        container={null}
                        fields={fields}
                        sections={sections}
                        questions={questions}
                        batch4={batch4}
                        real1={real1}
                        onAdd={(question) => addQuestion(question, { container: null })}
                      />
                    </div>
                  </div>
                ) : (
                  <SettingsTab
                    formId={form.id}
                    projectId={form.projectId}
                    title={title}
                    setTitle={touch(setTitle)}
                    description={description}
                    setDescription={touch(setDescription)}
                    destination={destination}
                    setDestination={touch(setDestination)}
                    accepting={accepting}
                    setAccepting={(next) => void changeLive(next)}
                    livePending={livePending || pending}
                    sendConfirmation={sendConfirmation}
                    setSendConfirmation={touch(setSendConfirmation)}
                    verifiedOnly={verifiedOnly}
                    setVerifiedOnly={touch(setVerifiedOnly)}
                    confirmationMessage={confirmationMessage}
                    setConfirmationMessage={touch(setConfirmationMessage)}
                    sections={sections}
                    publicUrl={publicUrl}
                    embedSnippet={embedSnippet}
                    dirty={dirty}
                    onCopy={copy}
                    onLeave={() => setDirty(false)}
                  />
                )}
              </fieldset>
            </section>
          ) : null}
        </div>
      </div>
      {choice && pathChoice ? (
        <PathChoiceDialog
          title={choice.title}
          message={choice.message}
          onKeep={() => {
            setPathChoice(null);
            finishDeletePath(pathChoice.sourceId, pathChoice.pathId, "keep");
          }}
          onDelete={() => {
            setPathChoice(null);
            finishDeletePath(pathChoice.sourceId, pathChoice.pathId, "delete");
          }}
          onCancel={() => setPathChoice(null)}
          cancelLabel={pathChoice.reason === "otherwise" ? "Decide later" : "Cancel"}
          single={choice.count === 1}
          keepLabel={choice.keepLabel}
        />
      ) : null}
    </div>
  );
}

type DropTarget = { container: FlowContainer; beforeId: string | null };
type PathChoice = { sourceId: string; pathId: string; reason: "delete" | "otherwise" };

// Problems that only show once a save was tried (the rest show at once).
const LATE_PROBLEMS = new Set<FormProblem["kind"]>(["label", "options", "option_label"]);

function labelOf(questions: FormQuestion[], id: string): string {
  return questions.find((q) => q.id === id)?.label.trim() || "Untitled question";
}

function pathNameOf(questions: FormQuestion[], container: FlowContainer): string | null {
  if (!container) return null;
  const source = questions.find((q) => q.id === container.sourceId);
  const path = source?.paths?.find((p) => p.id === container.pathId);
  return source && path ? pathLabel(source, path) : null;
}

function describePathChoice(
  questions: FormQuestion[],
  choice: PathChoice,
): { title: string; message: string; count: number; keepLabel: string } | null {
  const source = questions.find((q) => q.id === choice.sourceId);
  const path = source?.paths?.find((p) => p.id === choice.pathId);
  if (!source || !path) return null;
  const count = pathQuestionCount(questions, source.id, path.id);
  const what = count === 1 ? "its question" : `its ${count} questions`;
  // A split inside a path keeps them in that path (they take the split question's own rule).
  const keepLabel = source.show_if ? (count === 1 ? "Keep it" : "Keep them") : "Keep on the main flow";
  return choice.reason === "otherwise"
    ? {
        count,
        keepLabel,
        title: "Otherwise has no answers left",
        message: `Every answer of “${source.label.trim() || "the question"}” is on a path now, so Otherwise’s questions would never show. Keep ${what} (after the paths meet), or delete ${count === 1 ? "it" : "them"}?`,
      }
    : {
        count,
        keepLabel,
        title: `Delete the path “${pathLabel(source, path)}”?`,
        message: `What happens to ${what}? Kept ones move to after the paths meet and show whenever “${source.label.trim() || "the question"}” shows.`,
      };
}

function CopyRow({ label, value, multiline, onCopy }: { label: string; value: string; multiline?: boolean; onCopy: () => void }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      <div className="flex items-start gap-1.5">
        {multiline ? (
          <textarea id={id} readOnly value={value} rows={3} className="field h-auto min-w-0 flex-1 py-1.5 font-mono text-xs" />
        ) : (
          <input id={id} readOnly value={value} className="field h-8 min-w-0 flex-1 font-mono text-xs" />
        )}
        <button type="button" onClick={onCopy} aria-label={`Copy ${label.toLowerCase()}`} data-tooltip="Copy" className="btn-icon size-8">
          <Copy className="size-4" />
        </button>
      </div>
    </div>
  );
}

// The live preview: what people see on the form's page. Answers here are only for trying branches and
// paths (Reset answers clears them); a path's questions carry its color on their left edge.
function Preview({
  projectId,
  title,
  description,
  accepting,
  sendConfirmation,
  questions,
  visible,
  answers,
  tags,
  selectedId,
  onAnswer,
  onReset,
  onSelect,
}: {
  projectId: string;
  title: string;
  description: string;
  accepting: boolean;
  sendConfirmation: boolean;
  questions: FormQuestion[];
  visible: Set<string>;
  answers: FormAnswers;
  tags: Map<string, PathTag>;
  selectedId: string | null;
  onAnswer: (id: string, value: FormAnswers[string]) => void;
  onReset: () => void;
  // null: read-only (no selecting, no Edit buttons).
  onSelect: ((id: string) => void) | null;
}) {
  const labels = new Map(questions.map((q) => [q.id, q] as const));
  const answered = Object.values(answers).some((v) => v !== undefined && v !== null && v !== "" && v !== false && !(Array.isArray(v) && !v.length));
  return (
    <div className="mx-auto w-full max-w-xl">
      <div className="mb-2 flex h-7 items-center justify-between gap-2 text-xs text-zinc-500">
        <span>Preview: answer the choice questions to walk their paths.</span>
        {answered ? (
          <button type="button" onClick={onReset} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 font-medium text-zinc-600 hover:bg-white hover:text-zinc-900">
            <RotateCcw className="size-3.5" aria-hidden />
            Reset answers
          </button>
        ) : null}
      </div>
      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
        <div aria-hidden className={`h-24 ${projectColorClass(projectId)}`} />
        <div className="px-6 pb-6 pt-5">
          <h3 className="text-xl font-semibold tracking-tight text-zinc-900">{title.trim() || "Untitled form"}</h3>
          {description.trim() ? <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-600">{description}</p> : null}
          {accepting ? null : (
            <p className="mt-4 rounded-lg bg-zinc-100 px-3 py-2 text-sm text-zinc-700">This form isn’t accepting responses right now.</p>
          )}
          <div className="mt-6 flex flex-col gap-1.5">
            <label htmlFor="preview-email" className="text-sm font-medium text-zinc-900">
              Your email <span className="text-red-600">*</span>
            </label>
            <input id="preview-email" type="email" disabled placeholder="name@example.com" className="field h-auto w-full py-2" />
            <p className="text-xs text-zinc-500">
              {sendConfirmation ? "Asked on every form; the confirmation email goes here." : "Asked on every form, so your team can follow up."}
            </p>
          </div>
          <div className="mt-5 flex flex-col gap-2">
            {questions.map((question) => {
              const shown = visible.has(question.id);
              const tag = tags.get(question.id);
              const parent = question.show_if ? labels.get(question.show_if.question_id) : null;
              const selected = selectedId === question.id;
              const answersText =
                parent &&
                (branchOptions(parent)
                  .filter((o) => question.show_if?.option_ids.includes(o.id))
                  .map((o) => o.label)
                  .join(" or ") ||
                  "…");
              return (
                <div
                  key={question.id}
                  onClick={onSelect ? () => onSelect(question.id) : undefined}
                  data-preview-question={question.id}
                  className={`group relative rounded-lg border px-3 py-3 transition-[opacity,border-color,background-color] duration-150 ${
                    selected ? "border-accent-400 bg-accent-50/30 ring-1 ring-accent-300" : onSelect ? "border-transparent hover:border-zinc-200" : "border-transparent"
                  } ${tag ? `border-l-4 ${tag.color.edge}` : ""} ${shown ? "" : "opacity-50"}`}
                >
                  {parent ? (
                    <p className="mb-1.5 flex flex-wrap items-center gap-1 text-2xs font-medium text-zinc-500">
                      {tag ? (
                        <span className={`inline-flex items-center gap-1 rounded px-1.5 py-px ${tag.color.chip}`}>
                          <span aria-hidden className={`size-1.5 rounded-full ${tag.color.dot}`} />
                          {tag.label}
                        </span>
                      ) : (
                        <GitBranch className="size-3" aria-hidden />
                      )}
                      Shown if “{parent.label || "an earlier question"}” is {answersText}
                    </p>
                  ) : null}
                  <FormQuestionField
                    question={question.label.trim() ? question : { ...question, label: "Untitled question" }}
                    value={answers[question.id]}
                    onChange={(value) => onAnswer(question.id, value)}
                    idPrefix="preview"
                  />
                  {onSelect ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(question.id);
                      }}
                      className="absolute right-2 top-2 rounded px-1.5 py-0.5 text-2xs font-medium text-accent-700 opacity-0 hover:bg-accent-50 focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      Edit
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="mt-6 flex items-center gap-3">
            <button type="button" disabled className="btn-primary h-9 px-4">
              Submit
            </button>
            <span className="text-xs text-zinc-400">Preview: people submit from the form’s link.</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// "+ New question": a project field (the question fills it in) or a question type. Batch 43: it adds to one
// place (`container`): the main flow, or a path. A field already asked is offered again only where it can
// never show with the question that asks it (another path of a single choice: "Asked in Print").
function NewQuestionMenu({
  variant,
  label,
  container,
  fields,
  sections,
  questions,
  batch4,
  real1,
  onAdd,
}: {
  // bar: the compact button at the top; end: the dashed row after the last question; path: a path's
  // "+ Add question to this path"; icon: a card's "Add a question below".
  variant: "bar" | "end" | "path" | "icon";
  label: string;
  container: FlowContainer;
  fields: FieldDef[];
  sections: SectionRef[];
  questions: FormQuestion[];
  batch4: boolean;
  real1: boolean;
  onAdd: (question: FormQuestion) => void;
}) {
  const sectionOptions = sections.map((s) => ({ id: s.id, label: s.name }));
  const fieldQuestions = fields.flatMap((field) => {
    const question = questionForField(field, sectionOptions, newId);
    return question ? [{ field, question, ask: fieldAskInContainer(questions, field.id, container) }] : [];
  });
  const types = QUESTION_TYPES.filter((t) => typeAvailable(t.value, batch4, real1));
  const button =
    variant === "icon" ? (
      <Plus className="size-4" aria-hidden />
    ) : (
      <>
        <Plus className={variant === "path" ? "size-3.5" : "size-4"} aria-hidden />
        {label}
      </>
    );
  const buttonClassName = {
    bar: "btn-secondary h-7 shrink-0 px-2 text-xs",
    end: "btn-secondary h-9 w-full justify-center border-dashed text-zinc-600",
    path: "inline-flex h-7 w-full items-center gap-1 rounded-md border border-dashed border-zinc-300 bg-white/60 px-2 text-xs font-medium text-zinc-600 hover:border-zinc-400 hover:bg-white hover:text-zinc-900",
    icon: "btn-icon",
  }[variant];
  return (
    <Popover
      label={label}
      align={variant === "bar" || variant === "icon" ? "end" : "start"}
      panelClassName="w-72 p-1.5"
      buttonClassName={buttonClassName}
      tooltip={variant === "icon" ? label : undefined}
      button={button}
    >
      {(close) => (
        <div className="flex max-h-[min(28rem,70vh)] flex-col overflow-y-auto">
          {fieldQuestions.length ? (
            <>
              <p className="px-2 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-wide text-zinc-400">From a field</p>
              {fieldQuestions.map(({ field, question, ask }) => (
                <button
                  key={field.id}
                  type="button"
                  disabled={!ask.allowed}
                  title={!ask.allowed ? "Already asked where it could show with this question" : undefined}
                  onClick={() => {
                    close();
                    onAdd({ ...question, id: newId() });
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 disabled:opacity-40"
                >
                  <FieldTypeIcon field={field} />
                  <span className="min-w-0 flex-1 truncate">{field.name}</span>
                  {field.locked ? <FieldLockIcon label={FORM_LOCKED_FIELD_NOTE} /> : null}
                  {!ask.allowed ? (
                    <span className="text-2xs text-zinc-400">Asked</span>
                  ) : ask.askedIn ? (
                    <span className="max-w-28 truncate text-2xs text-zinc-500">Asked in {ask.askedIn}</span>
                  ) : null}
                </button>
              ))}
              <div role="separator" className="my-1 border-t border-zinc-100" />
            </>
          ) : null}
          <p className="px-2 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-wide text-zinc-400">Question types</p>
          {types.map((t) => {
            const Icon = TYPE_ICONS[t.value];
            // Item 71: the form already collects the submitter's email.
            if (t.value === "email") {
              return (
                <span
                  key={t.value}
                  aria-disabled="true"
                  data-question-type-email=""
                  className="flex w-full cursor-default items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm text-zinc-400"
                >
                  <Icon className="mt-0.5 size-4" aria-hidden />
                  <span>
                    {t.label}
                    <span className="block text-2xs">{EMAIL_QUESTION_NOTE}</span>
                  </span>
                </span>
              );
            }
            return (
              <button
                key={t.value}
                type="button"
                onClick={() => {
                  close();
                  onAdd({
                    id: newId(),
                    type: t.value,
                    label: t.value === "heading" ? "Section heading" : t.value === "attachment" ? "Attach files" : "",
                    ...(isChoice(t.value) ? { options: [{ id: newId(), label: "Option 1" }, { id: newId(), label: "Option 2" }] } : {}),
                  });
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100"
              >
                <Icon className="size-4 text-zinc-500" aria-hidden />
                {t.label}
              </button>
            );
          })}
          {!batch4 ? (
            <p className="px-2 pb-1 pt-1.5 text-2xs text-zinc-400">Email and Heading questions arrive with this release’s database update.</p>
          ) : !real1 ? (
            <p className="px-2 pb-1 pt-1.5 text-2xs text-zinc-400">Attachment questions arrive with this release’s database update.</p>
          ) : null}
        </div>
      )}
    </Popover>
  );
}

function QuestionCard({
  index,
  question,
  questions,
  sections,
  fields,
  batch4,
  real1,
  tag,
  misplaced,
  problems,
  conflict,
  open,
  draggable,
  dropLine,
  canMoveUp,
  canMoveDown,
  addBelow,
  onDragStart,
  onDragEnd,
  onDragOverCard,
  onToggle,
  onChange,
  onCommit,
  onCreateBranch,
  onAddTo,
  onPlaceIn,
  onMove,
  onDuplicate,
  onRemove,
  onAnnounce,
}: {
  index: number;
  question: FormQuestion;
  questions: FormQuestion[];
  sections: SectionRef[];
  fields: FieldDef[];
  batch4: boolean;
  real1: boolean;
  // The path it's in (batch 43), if any.
  tag: PathTag | null;
  // In a path, but outside that path's block ("Put paths together" fixes it).
  misplaced: boolean;
  // What's wrong with it, said on the card (batch 43).
  problems: FormProblem[];
  // Another question that can show with it fills in the same detail.
  conflict: { label: string; target: MapTarget } | null;
  open: boolean;
  // Editors with two or more questions get the drag handle and Alt+↑ / Alt+↓ (the disabled fieldset
  // doesn't stop a draggable element, so the handle is only drawn when allowed).
  draggable: boolean;
  // A drop would land right before this card.
  dropLine: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  // The "Add a question below" menu (right after this question, in its path).
  addBelow: ReactNode;
  onDragStart: () => void;
  onDragEnd: () => void;
  // Set while a drag is on: the pointer is over this card's upper (false) or lower (true) half.
  onDragOverCard?: (after: boolean) => void;
  onToggle: () => void;
  onChange: (next: FormQuestion) => void;
  // A change to the whole list that says what it did (with Undo); `moved` = questions it moves on purpose.
  onCommit: (next: FormQuestion[], message: string | null, moved?: string[]) => void;
  // Item 68: a new question shown when this one's answer is `optionId` (opens it).
  onCreateBranch: (optionId: string) => void;
  // A new question at the end of one of this question's paths.
  onAddTo: (container: FlowContainer, question: FormQuestion) => void;
  // An existing question joins one of this question's paths.
  onPlaceIn: (questionId: string, container: NonNullable<FlowContainer>) => void;
  onMove: (delta: -1 | 1) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onAnnounce: (message: string) => void;
}) {
  const Icon = TYPE_ICONS[question.type];
  const prefix = `fq-${question.id}`;
  const mappedField = question.maps_to?.target === "field" ? fields.find((f) => f.id === question.maps_to?.field_id) : undefined;
  const cardRef = useRef<HTMLDivElement>(null);
  const split = Boolean(question.paths?.length);
  const hasProblem = problems.length > 0;

  useEffect(() => {
    if (open) cardRef.current?.scrollIntoView({ block: "nearest" });
  }, [open]);

  // Reordering moves the card in the page, which can drop the focus: put it back on the control that
  // moved it (or the nearest one still enabled, e.g. Move down once the card is first).
  function move(delta: -1 | 1, focusIds: string[]) {
    onMove(delta);
    requestAnimationFrame(() => {
      for (const id of focusIds) {
        const target = document.getElementById(id);
        if (target instanceof HTMLButtonElement && !target.disabled) {
          target.focus();
          return;
        }
      }
    });
  }

  return (
    <div
      ref={cardRef}
      data-question-card={question.id}
      onDragOver={
        onDragOverCard
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = "move";
              const rect = e.currentTarget.getBoundingClientRect();
              onDragOverCard(e.clientY > rect.top + rect.height / 2);
            }
          : undefined
      }
      className={`group relative rounded-lg border bg-white transition-shadow ${
        hasProblem ? "border-red-300" : open ? "border-accent-300 shadow-sm" : "border-zinc-200 hover:border-zinc-300"
      }`}
    >
      {dropLine ? <span aria-hidden className="pointer-events-none absolute inset-x-1 -top-[5px] h-0.5 rounded-full bg-accent-500" /> : null}
      <div className="flex items-center">
        {draggable ? (
          <span
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(QUESTION_DRAG, question.id);
              e.dataTransfer.effectAllowed = "move";
              if (cardRef.current) e.dataTransfer.setDragImage(cardRef.current, 12, 12);
              onDragStart();
            }}
            onDragEnd={onDragEnd}
            aria-hidden
            data-tooltip={split ? "Drag to move it with its paths (or Alt+↑ / Alt+↓)" : "Drag to move (or Alt+↑ / Alt+↓)"}
            className="flex w-6 shrink-0 cursor-grab items-center justify-center self-stretch pl-1 text-zinc-300 opacity-0 hover:text-zinc-500 active:cursor-grabbing group-hover:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <GripVertical className="size-4" />
          </span>
        ) : null}
        <button
          id={`${prefix}-toggle`}
          type="button"
          onClick={onToggle}
          onKeyDown={(e) => {
            if (!draggable || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
            e.preventDefault();
            if (e.key === "ArrowUp" ? !canMoveUp : !canMoveDown) return;
            move(e.key === "ArrowUp" ? -1 : 1, [`${prefix}-toggle`]);
          }}
          aria-expanded={open}
          aria-controls={`${prefix}-body`}
          aria-keyshortcuts={draggable ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
          aria-describedby={hasProblem ? `${prefix}-problems` : undefined}
          className={`flex min-w-0 flex-1 items-center gap-2 py-2 pr-2 text-left ${draggable ? "pl-1" : "pl-3"}`}
        >
          <span className="w-5 shrink-0 text-right text-2xs tabular-nums text-zinc-400">{index + 1}</span>
          <Icon className="size-4 shrink-0 text-zinc-500" aria-hidden />
          <span className={`min-w-0 flex-1 truncate ${question.label.trim() ? "text-zinc-900" : "text-zinc-400"}`}>
            {question.label.trim() || "Untitled question"}
            {question.required ? <span className="text-red-600"> *</span> : null}
          </span>
          {hasProblem ? (
            <CircleAlert className="size-3.5 shrink-0 text-red-600" aria-label="Needs a fix" />
          ) : conflict ? (
            <span role="img" aria-label={`Fills in the same detail as “${conflict.label}”`} data-tooltip={`Fills in the same detail as “${conflict.label}”, and both can show`}>
              <CircleAlert className="size-3.5 shrink-0 text-amber-600" aria-hidden />
            </span>
          ) : null}
          {isNameQuestion(question) ? (
            <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-px text-2xs text-zinc-600">Requester’s name</span>
          ) : null}
          {split ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded bg-zinc-100 px-1.5 py-px text-2xs font-medium text-zinc-700">
              <GitFork className="size-3" aria-hidden />
              {question.paths?.length} paths
            </span>
          ) : null}
          {misplaced && tag ? (
            <span className={`shrink-0 rounded px-1.5 py-px text-2xs ${tag.color.chip}`}>Belongs to {tag.label}</span>
          ) : question.show_if && !tag ? (
            <GitBranch className="size-3.5 shrink-0 text-zinc-400" aria-label="Shown by a branch" />
          ) : null}
          {question.maps_to ? (
            <span className="hidden max-w-28 shrink-0 truncate rounded bg-zinc-100 px-1.5 py-px text-2xs text-zinc-600 sm:inline">
              {mapTargetLabel(question.maps_to.target, mappedField?.name)}
            </span>
          ) : null}
        </button>
        {isNameQuestion(question) ? null : (
          <BranchButton
            question={question}
            questions={questions}
            onCommit={onCommit}
            onCreateBranch={onCreateBranch}
            onAddTo={onAddTo}
            onPlaceIn={onPlaceIn}
          />
        )}
      </div>
      {hasProblem ? (
        <ul id={`${prefix}-problems`} role="alert" className="mx-2 mb-2 flex flex-col gap-1 rounded-md bg-red-50 px-2.5 py-2 text-xs text-red-800" data-card-problems="">
          {problems.map((problem) => (
            <li key={problem.kind} className="flex items-start gap-1.5">
              <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1">{problem.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {open ? (
        <div id={`${prefix}-body`} className="flex flex-col gap-3 border-t border-zinc-100 px-3 pb-3 pt-3">
          {isNameQuestion(question) ? (
            <p className="rounded-md bg-zinc-50 px-2.5 py-2 text-xs text-zinc-600">
              Every form asks for the requester’s name: a required short answer, always shown and never in a path. You
              can rename the question, but not remove it or make it optional. The name is used in emails to the
              requester and in review checks.
            </p>
          ) : (
          // Item 67: the type and Required come first on the card.
          <div className="grid grid-cols-2 gap-2" data-question-top="">
            <div>
              <label htmlFor={`${prefix}-type`} className={LABEL}>
                Type
              </label>
              <SmartPicker
                id={`${prefix}-type`}
                label="Type"
                value={question.type}
                onChange={(value) => {
                  const type = value as QuestionType;
                  const next: FormQuestion = { ...question, type };
                  if (isChoice(type) && !next.options?.length) next.options = [{ id: newId(), label: "Option 1" }];
                  onChange(next);
                }}
                className={PICKER}
                options={QUESTION_TYPES.filter((t) => typeAvailable(t.value, batch4, real1) || t.value === question.type).map(
                  (t) =>
                    t.value === "email" && question.type !== "email"
                      ? { value: t.value, label: t.label, disabled: true, disabledReason: EMAIL_QUESTION_NOTE }
                      : { value: t.value, label: t.label },
                )}
              />
            </div>
            {isAnswerable(question) ? (
              <div className="mt-5">
                <label className="flex items-center gap-2 text-sm text-zinc-700">
                  <input
                    type="checkbox"
                    checked={Boolean(question.required)}
                    onChange={(e) => {
                      const next = { ...question };
                      if (e.currentTarget.checked) next.required = true;
                      else delete next.required;
                      onChange(next);
                    }}
                    className="size-4 accent-accent-600"
                  />
                  Required
                </label>
                {question.required && question.show_if ? (
                  <p className="ml-6 text-2xs text-zinc-500">{tag ? "Required when this path shows" : "Required when it shows"}</p>
                ) : null}
              </div>
            ) : null}
          </div>
          )}

          <div>
            <label htmlFor={`${prefix}-label`} className={LABEL}>
              {question.type === "heading" ? "Heading" : "Question"}
            </label>
            <input
              id={`${prefix}-label`}
              value={question.label}
              maxLength={500}
              placeholder={question.type === "heading" ? "e.g. About the request" : "Ask something"}
              aria-invalid={problems.some((p) => p.kind === "label") || undefined}
              onChange={(e) => onChange({ ...question, label: e.currentTarget.value })}
              className={`${INPUT} mt-1`}
            />
          </div>
          <div>
            <label htmlFor={`${prefix}-help`} className={LABEL}>
              {question.type === "heading" ? "Text under the heading" : "Description"}{" "}
              <span className="font-normal text-zinc-400">(optional)</span>
            </label>
            <textarea
              id={`${prefix}-help`}
              value={question.help ?? ""}
              maxLength={1000}
              rows={question.type === "heading" ? 3 : 2}
              onChange={(e) => onChange({ ...question, help: e.currentTarget.value })}
              className="field mt-1 h-auto w-full py-1.5"
            />
          </div>
          {isChoice(question.type) ? (
            <OptionsEditor question={question} sections={sections} fields={fields} newId={newId} onChange={onChange} onAnnounce={onAnnounce} />
          ) : null}

          {question.type === "attachment" ? (
            <p className="text-xs text-zinc-500">
              Submitters can attach up to {MAX_FILES_PER_QUESTION} files here ({MAX_ATTACHMENT_LABEL} each:
              documents, spreadsheets, slides, images, audio, video, design files, or a zip). The files are added to the
              new task, where everyone who can open the task can open them (the submitter can’t see them afterwards).
            </p>
          ) : isAnswerable(question) && !isNameQuestion(question) ? (
            <MappingSelect question={question} fields={fields} onChange={onChange} prefix={prefix} conflict={conflict} />
          ) : null}

          {split ? (
            <PathsPanel
              question={question}
              onMakeRequired={() => onChange({ ...question, required: true })}
              onStopSplitting={() =>
                onCommit(
                  stopSplitting(questions, question.id),
                  `“${question.label.trim() || "The question"}” no longer splits into paths. Its questions still show for the same answers.`,
                )
              }
            />
          ) : isBranchSource(question) ? (
            <BranchEditor question={question} questions={questions} fields={fields} onCommit={onCommit} onCreateBranch={onCreateBranch} />
          ) : null}

          {question.show_if ? <ShownIf question={question} questions={questions} tag={tag} onCommit={onCommit} /> : null}

          <div className="flex items-center gap-1 border-t border-zinc-100 pt-2">
            <button
              id={`${prefix}-move-up`}
              type="button"
              aria-label="Move question up"
              data-tooltip="Move up"
              disabled={!canMoveUp}
              onClick={() => move(-1, [`${prefix}-move-up`, `${prefix}-move-down`])}
              className="btn-icon"
            >
              <ArrowUp className="size-4" />
            </button>
            <button
              id={`${prefix}-move-down`}
              type="button"
              aria-label="Move question down"
              data-tooltip="Move down"
              disabled={!canMoveDown}
              onClick={() => move(1, [`${prefix}-move-down`, `${prefix}-move-up`])}
              className="btn-icon"
            >
              <ArrowDown className="size-4" />
            </button>
            {isNameQuestion(question) ? null : (
            <button type="button" aria-label="Duplicate question" data-tooltip="Duplicate" onClick={onDuplicate} className="btn-icon">
              <CopyPlus className="size-4" />
            </button>
            )}
            {addBelow}
            <span className="flex-1" />
            {isNameQuestion(question) ? null : (
            <button type="button" onClick={onRemove} className="btn-ghost h-7 text-red-700 hover:bg-red-50 hover:text-red-800">
              <Trash2 className="size-4" aria-hidden />
              Delete
            </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MappingSelect({
  question,
  fields,
  onChange,
  prefix,
  conflict,
}: {
  question: FormQuestion;
  fields: FieldDef[];
  onChange: (next: FormQuestion) => void;
  prefix: string;
  // Batch 43 (item 5): another question that can show with this one fills in the same detail.
  conflict: { label: string; target: MapTarget } | null;
}) {
  const value = question.maps_to?.target === "field" ? `field:${question.maps_to.field_id}` : (question.maps_to?.target ?? "");
  const mappable = fields.filter((f) => fieldAccepts(f, question.type));
  const mappedLocked =
    question.maps_to?.target === "field" && Boolean(fields.find((f) => f.id === question.maps_to?.field_id)?.locked);
  return (
    <div>
      <label htmlFor={`${prefix}-map`} className={LABEL}>
        Fills in
      </label>
      <SmartPicker
        id={`${prefix}-map`}
        label="Fills in"
        value={value}
        onChange={(v) => {
          const next = { ...question };
          if (!v) delete next.maps_to;
          else if (v.startsWith("field:")) next.maps_to = { target: "field", field_id: v.slice(6) };
          else next.maps_to = { target: v as "title" | "notes" | "due_on" | "section" };
          onChange(next);
        }}
        className={PICKER}
        searchable={mappable.length > 4}
        options={[
          { value: "", label: "Nothing (listed in the description)" },
          { value: "title", label: "Task name" },
          { value: "notes", label: "Description" },
          ...(question.type === "date" ? [{ value: "due_on", label: "Due date" }] : []),
          ...(question.type === "single_select" ? [{ value: "section", label: "Section" }] : []),
          ...mappable.map((f) => ({
            value: `field:${f.id}`,
            label: `Field: ${f.name}${f.boundToSections ? " (moves the section)" : ""}`,
            // Oct 29 notes (batch 7): a locked field — answers still fill it in.
            ...(f.locked ? { description: "Locked", icon: <FieldLockIcon label={FORM_LOCKED_FIELD_NOTE} /> } : {}),
          })),
        ]}
      />
      {mappedLocked ? (
        <p className="mt-1 flex items-start gap-1.5 text-xs text-zinc-500">
          <FieldLockIcon label={FORM_LOCKED_FIELD_NOTE} />
          <span>{FORM_LOCKED_FIELD_NOTE}</span>
        </p>
      ) : null}
      {question.maps_to?.target === "section" || (question.maps_to?.target === "field" && isChoice(question.type)) ? (
        <p className="mt-1 text-xs text-zinc-500">Each option fills in the {question.maps_to?.target === "section" ? "section" : "field option"} with the same name.</p>
      ) : null}
      {conflict ? (
        <p className="mt-1.5 flex items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900" data-mapping-conflict="">
          <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            “{conflict.label}” can show along with this question and fills in the same{" "}
            {conflict.target === "title" ? "task name: their answers are joined" : conflict.target === "field" ? "field: the last answer wins" : `${mapTargetLabel(conflict.target).toLowerCase()}: the last answer wins`}
            . Put them in different paths of a single choice, or fill in something else.
          </span>
        </p>
      ) : null}
    </div>
  );
}

// "If the answer is X, show …": the questions after this one that each answer opens. A question shown by
// a branch depends on one earlier question (the database's show_if), so picking it here moves it. Batch 43:
// a choice question can split into paths instead (one block per answer, meeting again after); a checkbox
// can't ("not checked" isn't an answer), so it offers a Yes / No choice.
function BranchEditor({
  question,
  questions,
  fields,
  onCommit,
  onCreateBranch,
}: {
  question: FormQuestion;
  questions: FormQuestion[];
  fields: FieldDef[];
  onCommit: (next: FormQuestion[], message: string | null) => void;
  onCreateBranch: (optionId: string) => void;
}) {
  const index = questions.findIndex((q) => q.id === question.id);
  const later = questions.slice(index + 1);
  // Only questions in the same flow (the main flow, or the same path): a question from another path would
  // end up shown only through this one's path, out of place.
  const owners = questionOwners(questions);
  const sameFlow = (q: FormQuestion) => owners.get(q.id) === owners.get(question.id);
  const options = branchOptions(question);

  function show(childId: string, optionId: string, on: boolean) {
    onCommit(showInBranch(questions, question.id, childId, optionId, on), null);
  }
  // Turning a checkbox into Yes / No keeps a field mapping only when the field takes a single choice.
  const mapped = question.maps_to?.target === "field" ? fields.find((f) => f.id === question.maps_to?.field_id) : undefined;
  const losesField = Boolean(mapped && !fieldAccepts(mapped, "single_select"));

  return (
    <div className="rounded-md bg-zinc-50 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex min-w-0 flex-1 items-center gap-1.5 text-xs font-medium text-zinc-700">
          <GitBranch className="size-3.5 text-zinc-500" aria-hidden />
          Branching
        </p>
        {isChoice(question.type) ? (
          <SplitIntoPathsButton questions={questions} question={question} onSplit={(next, message) => onCommit(next, message)} />
        ) : null}
      </div>
      {question.type === "checkbox" ? (
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
          <span>For paths, ask a Yes / No single choice instead (a checkbox can’t branch on “not checked”).</span>
          <button
            type="button"
            onClick={() =>
              onCommit(
                checkboxToYesNo(questions, question.id),
                `“${question.label.trim() || "The question"}” is now a Yes / No choice; what it showed shows for Yes.${losesField ? " It no longer fills in its checkbox field." : ""}`,
              )
            }
            className="font-medium text-accent-700 hover:underline"
          >
            Turn into Yes / No
          </button>
        </p>
      ) : null}
      <ul className="mt-1.5 flex flex-col gap-1.5">
        {options.map((option) => {
          const children = later.filter((q) => q.show_if?.question_id === question.id && q.show_if.option_ids.includes(option.id));
          const addable = later.filter((q) => !children.includes(q) && !isNameQuestion(q) && sameFlow(q));
          return (
            <li key={option.id} className="flex flex-wrap items-center gap-1 text-xs text-zinc-600">
              <span>
                If the answer is <span className="font-medium text-zinc-800">{option.label || "…"}</span>, show
              </span>
              {children.map((child) => (
                <span key={child.id} className="inline-flex max-w-full items-center gap-0.5 rounded bg-white px-1.5 py-0.5 ring-1 ring-zinc-200">
                  <span className="truncate">{child.label || "Untitled question"}</span>
                  <button
                    type="button"
                    aria-label={`Stop showing ${child.label || "the question"} for ${option.label}`}
                    onClick={() => show(child.id, option.id, false)}
                    className="rounded text-zinc-400 hover:text-zinc-700"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              <Popover
                label={`Show a question when the answer is ${option.label}`}
                panelClassName="w-64 p-1.5"
                buttonClassName="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-accent-700 hover:bg-accent-50"
                button={
                  <>
                    <Plus className="size-3" aria-hidden />
                    {children.length ? "Add" : "a question"}
                  </>
                }
              >
                {(close) => (
                  <BranchTargetList
                    source={question}
                    addable={addable}
                    onPick={(childId) => {
                      close();
                      show(childId, option.id, true);
                    }}
                    onCreate={() => {
                      close();
                      onCreateBranch(option.id);
                    }}
                  />
                )}
              </Popover>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Item 68: what a branch can show — a later question (picking one on another branch moves it), or a new
// question created right here, right after this question's branch.
function BranchTargetList({
  source,
  addable,
  onPick,
  onCreate,
}: {
  source: FormQuestion;
  addable: FormQuestion[];
  onPick: (questionId: string) => void;
  onCreate: () => void;
}) {
  return (
    <ul className="flex flex-col">
      {addable.length ? (
        <li className="px-2 pb-1 pt-1 text-2xs font-semibold uppercase tracking-wide text-zinc-400">Show a question below</li>
      ) : null}
      {addable.map((q) => (
        <li key={q.id}>
          <button
            type="button"
            onClick={() => onPick(q.id)}
            className="flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100"
          >
            <span className="truncate">{q.label || "Untitled question"}</span>
            {q.show_if && q.show_if.question_id !== source.id ? (
              <span className="text-2xs text-amber-700">Moves it from its current branch</span>
            ) : null}
          </button>
        </li>
      ))}
      <li className={addable.length ? "mt-1 border-t border-zinc-100 pt-1" : ""}>
        <button
          type="button"
          data-branch-create=""
          onClick={onCreate}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-accent-700 hover:bg-accent-50"
        >
          <Plus className="size-4" aria-hidden />
          Create new question
        </button>
      </li>
    </ul>
  );
}

// Item 68: a Branch button on every question card's header. Choice and checkbox questions pick an answer,
// then a later question or "Create new question"; other types say why they can't branch. Batch 43: on a
// question that splits, it picks a path instead (the question joins that path's block).
function BranchButton({
  question,
  questions,
  onCommit,
  onCreateBranch,
  onAddTo,
  onPlaceIn,
}: {
  question: FormQuestion;
  questions: FormQuestion[];
  onCommit: (next: FormQuestion[], message: string | null, moved?: string[]) => void;
  onCreateBranch: (optionId: string) => void;
  onAddTo: (container: FlowContainer, question: FormQuestion) => void;
  onPlaceIn: (questionId: string, container: NonNullable<FlowContainer>) => void;
}) {
  const [optionId, setOptionId] = useState<string | null>(null);
  const reason = branchUnavailableReason(question);
  const label = question.label.trim() || "this question";
  const buttonClassName =
    "mr-2 inline-flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-2xs font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 aria-expanded:bg-zinc-100";
  if (reason) {
    return (
      <span
        role="img"
        aria-label={`Branch: ${reason}`}
        data-tooltip={reason}
        tabIndex={0}
        className="mr-2 inline-flex h-6 shrink-0 cursor-default items-center gap-1 rounded px-1.5 text-2xs text-zinc-300"
      >
        <GitBranch className="size-3.5" aria-hidden />
        Branch
      </span>
    );
  }
  const index = questions.findIndex((q) => q.id === question.id);
  const later = questions.slice(index + 1).filter((q) => !isNameQuestion(q));
  if (question.paths?.length) {
    const paths = question.paths;
    const chosen = paths.find((p) => p.id === optionId) ?? null;
    const inBlock = chosen ? new Set(blockQuestionIds(questions, question.id, chosen.id)) : new Set<string>();
    return (
      <Popover
        label={`Add a question to a path of ${label}`}
        align="end"
        panelClassName="w-72 p-1.5"
        buttonClassName={buttonClassName}
        tooltip="Add a question to one of its paths"
        onOpenChange={(open) => {
          if (!open) setOptionId(null);
        }}
        button={
          <>
            <GitFork className="size-3.5" aria-hidden />
            Paths
          </>
        }
      >
        {(close) =>
          !chosen ? (
            <ul className="flex flex-col">
              <li className="px-2 pb-1 pt-1 text-2xs font-semibold uppercase tracking-wide text-zinc-400">Add to the path</li>
              {paths.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => setOptionId(p.id)}
                    className="flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100"
                  >
                    <span className="truncate font-medium">{pathLabel(question, p)}</span>
                    <span className="truncate text-2xs text-zinc-500">{pathAnswersText(question, p)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div>
              <p className="flex items-center gap-1 px-2 pb-1 pt-1 text-xs text-zinc-600">
                Add to <span className="font-medium text-zinc-900">{pathLabel(question, chosen)}</span>
                <button type="button" onClick={() => setOptionId(null)} className="ml-auto text-2xs text-accent-700 hover:underline">
                  Change
                </button>
              </p>
              <BranchTargetList
                source={question}
                addable={later.filter((q) => !inBlock.has(q.id) && canPlaceIn(questions, q.id, { sourceId: question.id, pathId: chosen.id }))}
                onPick={(childId) => {
                  close();
                  setOptionId(null);
                  onPlaceIn(childId, { sourceId: question.id, pathId: chosen.id });
                }}
                onCreate={() => {
                  close();
                  setOptionId(null);
                  onAddTo({ sourceId: question.id, pathId: chosen.id }, { id: newId(), type: "short_text", label: "" });
                }}
              />
            </div>
          )
        }
      </Popover>
    );
  }
  const options = branchOptions(question);
  const chosen = options.find((o) => o.id === optionId) ?? (options.length === 1 ? options[0] : null);
  const owners = questionOwners(questions);
  const sameFlow = (q: FormQuestion) => owners.get(q.id) === owners.get(question.id);
  return (
    <Popover
      label={`Branch from ${label}`}
      align="end"
      panelClassName="w-72 p-1.5"
      buttonClassName={buttonClassName}
      tooltip="Show another question only for one answer"
      onOpenChange={(open) => {
        if (!open) setOptionId(null);
      }}
      button={
        <>
          <GitBranch className="size-3.5" aria-hidden />
          Branch
        </>
      }
    >
      {(close) =>
        options.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-zinc-500">Add answer options first.</p>
        ) : !chosen ? (
          <ul className="flex flex-col">
            <li className="px-2 pb-1 pt-1 text-2xs font-semibold uppercase tracking-wide text-zinc-400">If the answer is</li>
            {options.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  onClick={() => setOptionId(o.id)}
                  className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100"
                >
                  {o.label || "…"}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div>
            <p className="flex items-center gap-1 px-2 pb-1 pt-1 text-xs text-zinc-600">
              If the answer is <span className="font-medium text-zinc-900">{chosen.label || "…"}</span>
              {options.length > 1 ? (
                <button type="button" onClick={() => setOptionId(null)} className="ml-auto text-2xs text-accent-700 hover:underline">
                  Change
                </button>
              ) : null}
            </p>
            <BranchTargetList
              source={question}
              addable={later.filter((q) => sameFlow(q) && !(q.show_if?.question_id === question.id && q.show_if.option_ids.includes(chosen.id)))}
              onPick={(childId) => {
                close();
                setOptionId(null);
                onCommit(showInBranch(questions, question.id, childId, chosen.id, true), null);
              }}
              onCreate={() => {
                close();
                setOptionId(null);
                onCreateBranch(chosen.id);
              }}
            />
          </div>
        )
      }
    </Popover>
  );
}

// Where a branched question shows: "Shown only if … is …" with Always show, or (batch 43) the path it's in,
// with "Move out of the path" (asks first: it would show to more people).
function ShownIf({
  question,
  questions,
  tag,
  onCommit,
}: {
  question: FormQuestion;
  questions: FormQuestion[];
  tag: PathTag | null;
  onCommit: (next: FormQuestion[], message: string | null, moved?: string[]) => void;
}) {
  const confirm = useConfirm();
  const parent = questions.find((q) => q.id === question.show_if?.question_id);
  if (!parent) return null;
  const labels = branchOptions(parent)
    .filter((o) => question.show_if?.option_ids.includes(o.id))
    .map((o) => o.label);
  if (tag && question.show_if?.path_id) {
    return (
      <p className={`flex flex-wrap items-center gap-1 rounded-md px-2.5 py-2 text-xs text-zinc-700 ${tag.color.chip}`}>
        <span aria-hidden className={`size-2 rounded-full ${tag.color.dot}`} />
        In the path “{tag.label}”: shows when “{tag.sourceLabel}” is {labels.length ? labels.join(" or ") : "(no answers left)"}.
        <button
          type="button"
          onClick={async () => {
            const words = moveOutWords(questions, question.id);
            if (!(await confirm({ title: words.title, message: words.message, confirmLabel: "Move it out" }))) return;
            onCommit(moveOutOfPath(questions, question.id, "end"), `Moved “${question.label.trim() || "the question"}” out of its path.`, [question.id]);
          }}
          className="ml-auto rounded px-1.5 py-0.5 font-medium text-accent-700 hover:bg-white/70"
        >
          Move out of the path
        </button>
      </p>
    );
  }
  return (
    <p className="flex flex-wrap items-center gap-1 rounded-md bg-accent-50/60 px-2.5 py-2 text-xs text-zinc-700">
      <GitBranch className="size-3.5 text-accent-700" aria-hidden />
      Shown only if “{parent.label || "an earlier question"}” is {labels.length ? labels.join(" or ") : "(pick an answer there)"}.
      <button
        type="button"
        onClick={() => onCommit(clearBranch(questions, question.id), null, [question.id])}
        className="ml-auto rounded px-1.5 py-0.5 font-medium text-accent-700 hover:bg-accent-100"
      >
        {tag ? "Show on the whole path" : "Always show"}
      </button>
    </p>
  );
}

function SettingsTab({
  formId,
  projectId,
  title,
  setTitle,
  description,
  setDescription,
  destination,
  setDestination,
  accepting,
  setAccepting,
  livePending,
  sendConfirmation,
  setSendConfirmation,
  verifiedOnly,
  setVerifiedOnly,
  confirmationMessage,
  setConfirmationMessage,
  sections,
  publicUrl,
  embedSnippet,
  dirty,
  onCopy,
  onLeave,
}: {
  formId: string;
  projectId: string;
  title: string;
  setTitle: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  destination: string;
  setDestination: (v: string) => void;
  accepting: boolean;
  setAccepting: (v: boolean) => void;
  livePending: boolean;
  sendConfirmation: boolean;
  setSendConfirmation: (v: boolean) => void;
  verifiedOnly: boolean;
  setVerifiedOnly: (v: boolean) => void;
  confirmationMessage: string;
  setConfirmationMessage: (v: string) => void;
  sections: SectionRef[];
  publicUrl: string;
  embedSnippet: string;
  dirty: boolean;
  onCopy: (text: string, what: string) => void;
  // Delete leaves this form: nothing should ask about unsaved changes on the way out.
  onLeave: () => void;
}) {
  const [pending, run] = useServerAction();
  const confirm = useConfirm();
  // Batch 43 (item 9): a copy of the saved form, off, opened right away.
  async function duplicate() {
    if (
      dirty &&
      !(await confirm({
        title: "Duplicate the saved version?",
        message: "The copy is made from what’s saved: your unsaved changes here aren’t in it, and leaving this form discards them.",
        confirmLabel: "Duplicate",
      }))
    ) {
      return;
    }
    // Unsaved edits stay marked unsaved: if the copy fails, nothing is lost (on success the copy opens).
    run(() => duplicateForm(formId, projectId));
  }
  return (
    <div className="flex flex-col gap-4">
      <div>
        <label htmlFor="form-title" className={LABEL}>
          Form name
        </label>
        <input id="form-title" value={title} maxLength={200} onChange={(e) => setTitle(e.currentTarget.value)} className={`${INPUT} mt-1`} />
      </div>
      <div>
        <label htmlFor="form-description" className={LABEL}>
          Description <span className="font-normal text-zinc-400">(shown above the questions)</span>
        </label>
        <textarea
          id="form-description"
          value={description}
          maxLength={5000}
          rows={3}
          onChange={(e) => setDescription(e.currentTarget.value)}
          className="field mt-1 h-auto w-full py-1.5"
        />
      </div>
      <div>
        <label htmlFor="form-destination" className={LABEL}>
          New tasks land in
        </label>
        <SmartPicker
          id="form-destination"
          label="New tasks land in"
          value={destination}
          onChange={setDestination}
          className={PICKER}
          options={[{ value: "", label: "No section" }, ...sections.map((s) => ({ value: s.id, label: s.name }))]}
        />
        <p className="mt-1 text-xs text-zinc-500">A question that fills in the section (or a Status field) wins over this.</p>
      </div>
      <Setting
        id="form-accepting"
        checked={accepting}
        onChange={(v) => {
          if (!livePending) setAccepting(v);
        }}
        label="Live (taking responses)"
        hint="Saves at once, like the switch at the top. A form that's off shows a notice instead of the questions. New forms start off."
      />
      <Setting
        id="form-confirmation-toggle"
        checked={sendConfirmation}
        onChange={setSendConfirmation}
        label="Email a confirmation to the submitter"
        hint="With the request number (when numbering is on) and the thank-you message."
      />
      <div>
        <label htmlFor="form-confirmation" className={LABEL}>
          Thank-you message
        </label>
        <textarea
          id="form-confirmation"
          value={confirmationMessage}
          maxLength={2000}
          rows={2}
          placeholder="Thanks! We’ll be in touch."
          onChange={(e) => setConfirmationMessage(e.currentTarget.value)}
          className="field mt-1 h-auto w-full py-1.5"
        />
        <p className="mt-1 text-xs text-zinc-500">Shown after submitting and in the confirmation email.</p>
      </div>
      <SettingsGroup title="Who can submit">
        <p className="flex items-start gap-2 text-xs text-zinc-600">
          <Globe className="mt-0.5 size-3.5 shrink-0 text-zinc-500" aria-hidden />
          {verifiedOnly
            ? "Anyone with the link whose email is on a verified domain (Admin console → Security), no sign-in needed."
            : "Anyone with the link, no sign-in needed (signed-in people see their email filled in)."}{" "}
          Up to 5 submissions a minute per email address.
        </p>
        <div className="mt-2">
          <Setting
            id="form-verified-only"
            checked={verifiedOnly}
            onChange={setVerifiedOnly}
            label="Only allow verified-domain emails to submit"
            hint="Other addresses are told to use their work email. The verified domains are set in Admin console → Security."
          />
        </div>
      </SettingsGroup>
      <SettingsGroup title="Share">
        <div className="flex flex-col gap-2">
          <CopyRow label="Form link" value={publicUrl} onCopy={() => onCopy(publicUrl, "Form link")} />
          <CopyRow label="Embed code" value={embedSnippet} multiline onCopy={() => onCopy(embedSnippet, "Embed code")} />
          <p className="text-2xs text-zinc-500">{EMBED_NOTE}</p>
        </div>
      </SettingsGroup>
      <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-3">
        <button type="button" disabled={pending} onClick={() => void duplicate()} className="btn-ghost h-8">
          <CopyPlus className="size-4" aria-hidden />
          Duplicate form
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={async () => {
            const ok = await confirm({
              title: `Delete “${title || "this form"}”?`,
              message: "Tasks it created stay; the link stops working.",
              confirmLabel: "Delete",
              tone: "danger",
            });
            if (!ok) return;
            onLeave();
            run(() => deleteForm(formId, projectId));
          }}
          className="btn-ghost h-8 text-red-700 hover:bg-red-50 hover:text-red-800"
        >
          <Trash2 className="size-4" aria-hidden />
          Delete form
        </button>
      </div>
    </div>
  );
}

function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-200 p-3">
      <h3 className="mb-2 text-xs font-semibold text-zinc-700">{title}</h3>
      {children}
    </section>
  );
}

function Setting({
  id,
  checked,
  onChange,
  label,
  hint,
}: {
  id: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
        aria-describedby={`${id}-hint`}
        className="peer sr-only"
      />
      <label
        htmlFor={id}
        aria-hidden
        className="relative mt-0.5 inline-block h-4 w-7 shrink-0 cursor-pointer rounded-full bg-zinc-300 transition-colors after:absolute after:left-0.5 after:top-0.5 after:size-3 after:rounded-full after:bg-white after:transition-transform peer-checked:bg-accent-500 peer-checked:after:translate-x-3 peer-focus-visible:ring-2 peer-focus-visible:ring-accent-500 peer-focus-visible:ring-offset-1"
      />
      <span className="min-w-0">
        <label htmlFor={id} className="block cursor-pointer text-sm text-zinc-800">
          {label}
        </label>
        <span id={`${id}-hint`} className="block text-xs text-zinc-500">
          {hint}
        </span>
      </span>
    </div>
  );
}
