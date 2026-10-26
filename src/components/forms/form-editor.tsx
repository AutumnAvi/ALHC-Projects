"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import {
  AlignLeft,
  ArrowDown,
  ArrowUp,
  AtSign,
  Calendar,
  CircleChevronDown,
  Copy,
  CopyPlus,
  ExternalLink,
  FileInput,
  GitBranch,
  Globe,
  GripVertical,
  Hash,
  Heading,
  Link2,
  ListChecks,
  Paperclip,
  Plus,
  Share2,
  SquareCheck,
  Trash2,
  Type,
  X,
  type LucideIcon,
} from "lucide-react";
import { useConfirm } from "@/components/confirm";
import { FormQuestionField } from "@/components/forms/public-form";
import { FieldTypeIcon } from "@/components/project/field-editor";
import { Popover } from "@/components/popover";
import { SmartPicker } from "@/components/smart-picker";
import { useNotify, useServerAction } from "@/components/toast";
import { FormLiveSwitch, FormStatusBadge } from "@/components/forms/form-status";
import { deleteForm, setFormLive, updateForm } from "@/lib/actions";
import { MAX_ATTACHMENT_LABEL } from "@/lib/attachments";
import type { FieldDef } from "@/lib/fields";
import {
  BATCH4_QUESTION_TYPES,
  MAX_FILES_PER_QUESTION,
  QUESTION_TYPES,
  REAL1_QUESTION_TYPES,
  branchOptions,
  brokenBranches,
  clearedBranchesMessage,
  fieldAccepts,
  isAnswerable,
  isBranchSource,
  isChoice,
  mapTargetLabel,
  moveQuestionBefore,
  moveQuestionBy,
  normalizeQuestions,
  questionForField,
  visibleQuestionIds,
  type FormAnswers,
  type FormDef,
  type FormQuestion,
  type QuestionOption,
  type QuestionType,
} from "@/lib/forms";
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
  // Admin+ (forms are managed by project admins); everyone else gets a read-only editor.
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
  const [confirmationMessage, setConfirmationMessage] = useState(form.confirmationMessage ?? "");
  const [questions, setQuestions] = useState<FormQuestion[]>(form.questions);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<"questions" | "settings">("questions");
  const [selectedId, setSelectedId] = useState<string | null>(form.questions[0]?.id ?? null);
  const [answers, setAnswers] = useState<FormAnswers>({});
  // Dragging a question card by its handle: the card being dragged, and where it would land (the
  // question it would sit before; null = the end; undefined = nowhere yet).
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropBefore, setDropBefore] = useState<string | null | undefined>(undefined);
  // Read by the Escape handler: set as soon as a drag starts (the faded card waits a frame).
  const dragRef = useRef<string | null>(null);
  // Screen readers hear where a moved question went.
  const [announcement, setAnnouncement] = useState("");
  const dirtyRef = useRef(dirty);
  // The latest questions, for the branch Undo toast (it runs after later renders).
  const questionsRef = useRef(questions);
  useEffect(() => {
    questionsRef.current = questions;
  }, [questions]);
  const panelRef = useRef<HTMLDivElement>(null);

  const publicUrl = `${origin}/forms/${form.id}`;
  const embedSnippet = `<iframe src="${origin}/forms/${form.id}/embed" title="${title.replace(/"/g, "&quot;")}" width="100%" height="900" style="border:0" loading="lazy"></iframe>`;
  const visible = useMemo(() => visibleQuestionIds(questions, answers), [questions, answers]);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

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

  function changeQuestions(next: (current: FormQuestion[]) => FormQuestion[]) {
    setQuestions((current) => normalizeQuestions(next(current), fields));
    setDirty(true);
  }

  function updateQuestion(id: string, next: FormQuestion) {
    changeQuestions((current) => current.map((q) => (q.id === id ? next : q)));
  }

  function insertQuestion(question: FormQuestion) {
    changeQuestions((current) => {
      const at = selectedId ? current.findIndex((q) => q.id === selectedId) : -1;
      return at < 0 ? [...current, question] : [...current.slice(0, at + 1), question, ...current.slice(at + 1)];
    });
    setSelectedId(question.id);
    setTab("questions");
  }

  // The one reorder path (buttons, Alt+↑ / Alt+↓, and drops). Worked out from this render's questions in
  // the event handler, not in a state updater (StrictMode runs updaters twice, which would toast twice).
  // A move that puts a branch question below the questions it shows clears those branches (the database
  // only accepts a branch on an earlier question), with Undo. The order saves with the form.
  function applyOrder(movedId: string, moved: FormQuestion[]) {
    if (moved === questions) return;
    const broken = brokenBranches(moved);
    const previous = questions;
    const next = normalizeQuestions(moved, fields);
    setQuestions(next);
    setDirty(true);
    const position = next.findIndex((q) => q.id === movedId);
    const label = next[position]?.label.trim() || "Untitled question";
    const message = `Moved “${label}” to position ${position + 1} of ${next.length}`;
    // The same words twice in a row still get read out (a live region ignores an unchanged text).
    setAnnouncement((prev) => (prev === message ? `${message}\u200b` : message));
    if (broken.length) {
      notify(clearedBranchesMessage(broken), {
        label: "Undo",
        // Only while nothing else changed since (an Undo never throws away later edits), and the form
        // is unsaved again afterwards, so the restored branch gets saved too.
        onClick: () => {
          if (questionsRef.current !== next) return;
          setQuestions(previous);
          setDirty(true);
        },
      });
    }
  }

  function reorder(id: string, beforeId: string | null) {
    applyOrder(id, moveQuestionBefore(questions, id, beforeId));
  }

  function moveQuestion(id: string, delta: -1 | 1) {
    applyOrder(id, moveQuestionBy(questions, id, delta));
  }

  function startDrag(id: string) {
    dragRef.current = id;
    // Fade the card a frame later: the browser takes its drag image from the card as the drag starts.
    requestAnimationFrame(() => {
      if (dragRef.current === id) setDragging(id);
    });
  }

  function endDrag() {
    dragRef.current = null;
    setDragging(null);
    setDropBefore(undefined);
  }

  // Drops on a card bubble here; the card already set where it lands.
  function dropQuestion(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    const id = e.dataTransfer.getData(QUESTION_DRAG);
    const beforeId = dropBefore ?? null;
    endDrag();
    if (id) reorder(id, beforeId);
  }

  // The drop line: before the card a drop would land in front of, or after the last card for the end.
  // Targets that wouldn't move anything (right before the dragged card or the card after it) get none.
  function dropLineFor(index: number): "before" | "after" | null {
    if (!dragging || dropBefore === undefined) return null;
    const from = questions.findIndex((q) => q.id === dragging);
    if (from < 0 || dropBefore === dragging || dropBefore === (questions[from + 1]?.id ?? null)) return null;
    if (dropBefore === questions[index].id) return "before";
    return dropBefore === null && index === questions.length - 1 ? "after" : null;
  }

  function removeQuestion(id: string) {
    changeQuestions((current) => current.filter((q) => q.id !== id));
    if (selectedId === id) setSelectedId(null);
  }

  function duplicateQuestion(question: FormQuestion) {
    const copy: FormQuestion = {
      ...question,
      id: newId(),
      label: `${question.label} (copy)`.slice(0, 500),
      ...(question.options ? { options: question.options.map((o) => ({ ...o, id: newId() })) } : {}),
    };
    // A copy never fills in the same field twice.
    if (copy.maps_to?.target === "field") delete copy.maps_to;
    changeQuestions((current) => {
      const at = current.findIndex((q) => q.id === question.id);
      return [...current.slice(0, at + 1), copy, ...current.slice(at + 1)];
    });
    setSelectedId(copy.id);
  }

  function save() {
    run(async () => {
      const result = await updateForm(form.id, {
        title,
        description: description || null,
        questions: normalizeQuestions(questions, fields, true),
        destinationSectionId: destination || null,
        acceptingResponses: accepting,
        sendConfirmation,
        confirmationMessage: confirmationMessage || null,
      });
      if (!result.error) {
        setDirty(false);
        notify("Form saved");
      }
      return result;
    });
  }

  // The header's Live / Off switch (and the Settings tab's) saves at once, apart from the editor's Save.
  const [livePending, runLive] = useServerAction();
  function changeLive(next: boolean) {
    const previous = accepting;
    setAccepting(next);
    runLive(async () => {
      const result = await setFormLive(form.id, next);
      if (result.error) setAccepting(previous);
      else notify(next ? "Form is live: it takes responses" : "Form is off: it no longer takes responses");
      return result;
    });
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify(`${what} copied`);
    } catch {
      notify("Couldn’t copy. Select the text and copy it instead.");
    }
  }

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
                Who can submit: Anyone with the link
              </span>
              <span>{accepting ? "Taking responses" : "Not taking responses: visitors see a closed notice"}</span>
              {dirty ? <span className="text-amber-700">Unsaved changes</span> : null}
            </p>
          </div>
          {canEdit ? <FormLiveSwitch live={accepting} disabled={livePending} onChange={changeLive} /> : null}
          <a href={publicUrl} target="_blank" rel="noreferrer" className="btn-ghost h-8">
            <ExternalLink className="size-4" aria-hidden />
            View form
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
                  Anyone with the link can submit while the form accepts responses. Link it from a request hub page, or
                  embed it.
                </p>
                <CopyRow label="Form link" value={publicUrl} onCopy={() => copy(publicUrl, "Form link")} />
                <CopyRow label="Embed code" value={embedSnippet} multiline onCopy={() => copy(embedSnippet, "Embed code")} />
                {!accepting ? (
                  <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
                    The form is off: turn it on with the Live switch at the top before sharing it.
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
            <button type="button" onClick={save} disabled={pending || !dirty || !title.trim()} className="btn-primary h-8 px-3">
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
        <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_28rem]">
          <section aria-label="Preview" className="hidden min-h-0 overflow-y-auto bg-zinc-100 px-6 py-8 lg:block">
            <Preview
              projectId={form.projectId}
              title={title}
              description={description}
              accepting={accepting}
              questions={questions}
              visible={visible}
              answers={answers}
              selectedId={selectedId}
              onAnswer={(id, value) => setAnswers((current) => ({ ...current, [id]: value }))}
              onSelect={(id) => {
                setSelectedId(id);
                setTab("questions");
              }}
            />
          </section>
          <section aria-label="Edit the form" className="flex min-h-0 flex-col border-l border-zinc-200">
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
            <fieldset disabled={!canEdit} role="tabpanel" className="m-0 min-h-0 min-w-0 flex-1 overflow-y-auto border-0 px-4 py-4">
              {!canEdit ? (
                <p className="mb-3 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
                  View only: project admins and owners edit forms.
                </p>
              ) : null}
              {tab === "questions" ? (
                // The whole Questions tab takes drops (a release below the last card, or on a drop line
                // drawn just outside the list, lands at the end), and the line goes away when a drag
                // leaves it.
                <div
                  className="flex flex-col gap-2"
                  onDragOver={(e) => {
                    if (!dragging) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dropBefore === undefined) setDropBefore(null);
                  }}
                  onDragLeave={(e) => {
                    if (dragging && !e.currentTarget.contains(e.relatedTarget as Node | null)) setDropBefore(undefined);
                  }}
                  onDrop={dragging ? dropQuestion : undefined}
                >
                  <p className="text-xs text-zinc-500">
                    Every submission also asks for the submitter’s email. Answers that don’t fill in a task detail are
                    listed in the task description.
                  </p>
                  <NewQuestionMenu
                    fields={fields}
                    sections={sections}
                    questions={questions}
                    batch4={batch4}
                    real1={real1}
                    onAdd={insertQuestion}
                  />
                  {questions.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-zinc-200 px-3 py-6 text-center text-xs text-zinc-500">
                      No questions yet. Add one, or ask about one of this project’s fields.
                    </p>
                  ) : (
                    <ol className="flex flex-col gap-2" aria-label="Questions">
                      {questions.map((question, index) => (
                        <QuestionCard
                          key={question.id}
                          index={index}
                          count={questions.length}
                          question={question}
                          questions={questions}
                          sections={sections}
                          fields={fields}
                          batch4={batch4}
                          real1={real1}
                          open={selectedId === question.id}
                          draggable={canEdit && questions.length > 1}
                          dragging={dragging === question.id}
                          dropLine={dropLineFor(index)}
                          onDragStart={() => startDrag(question.id)}
                          onDragEnd={endDrag}
                          onDragOverCard={
                            dragging
                              ? (after) => setDropBefore(after ? (questions[index + 1]?.id ?? null) : question.id)
                              : undefined
                          }
                          onToggle={() => setSelectedId(selectedId === question.id ? null : question.id)}
                          onChange={(next) => updateQuestion(question.id, next)}
                          onChangeAll={changeQuestions}
                          onMove={(delta) => moveQuestion(question.id, delta)}
                          onDuplicate={() => duplicateQuestion(question)}
                          onRemove={() => removeQuestion(question.id)}
                        />
                      ))}
                    </ol>
                  )}
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
                  setAccepting={changeLive}
                  livePending={livePending}
                  sendConfirmation={sendConfirmation}
                  setSendConfirmation={touch(setSendConfirmation)}
                  confirmationMessage={confirmationMessage}
                  setConfirmationMessage={touch(setConfirmationMessage)}
                  sections={sections}
                  publicUrl={publicUrl}
                  embedSnippet={embedSnippet}
                  onCopy={copy}
                  onDeleted={() => setDirty(false)}
                />
              )}
            </fieldset>
          </section>
        </div>
      </div>
    </div>
  );
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

// The live preview: what people see on the form's page. Answers here are only for trying branches.
function Preview({
  projectId,
  title,
  description,
  accepting,
  questions,
  visible,
  answers,
  selectedId,
  onAnswer,
  onSelect,
}: {
  projectId: string;
  title: string;
  description: string;
  accepting: boolean;
  questions: FormQuestion[];
  visible: Set<string>;
  answers: FormAnswers;
  selectedId: string | null;
  onAnswer: (id: string, value: FormAnswers[string]) => void;
  onSelect: (id: string) => void;
}) {
  const labels = new Map(questions.map((q) => [q.id, q] as const));
  return (
    <div className="mx-auto w-full max-w-xl overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
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
          <p className="text-xs text-zinc-500">Asked on every form; confirmations and updates go here.</p>
        </div>
        <div className="mt-5 flex flex-col gap-2">
          {questions.map((question) => {
            const shown = visible.has(question.id);
            const parent = question.show_if ? labels.get(question.show_if.question_id) : null;
            const selected = selectedId === question.id;
            return (
              <div
                key={question.id}
                onClick={() => onSelect(question.id)}
                className={`group relative rounded-lg border px-3 py-3 transition-colors ${
                  selected ? "border-accent-400 bg-accent-50/30 ring-1 ring-accent-300" : "border-transparent hover:border-zinc-200"
                } ${shown ? "" : "opacity-60"}`}
              >
                {parent ? (
                  <p className="mb-1.5 flex items-center gap-1 text-2xs font-medium text-zinc-500">
                    <GitBranch className="size-3" aria-hidden />
                    Shown if “{parent.label || "an earlier question"}” is{" "}
                    {branchOptions(parent)
                      .filter((o) => question.show_if?.option_ids.includes(o.id))
                      .map((o) => o.label)
                      .join(" or ") || "…"}
                  </p>
                ) : null}
                <FormQuestionField
                  question={question.label.trim() ? question : { ...question, label: "Untitled question" }}
                  value={answers[question.id]}
                  onChange={(value) => onAnswer(question.id, value)}
                  idPrefix="preview"
                />
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
  );
}

// "+ New question": a project field (the question fills it in) or a question type.
function NewQuestionMenu({
  fields,
  sections,
  questions,
  batch4,
  real1,
  onAdd,
}: {
  fields: FieldDef[];
  sections: SectionRef[];
  questions: FormQuestion[];
  batch4: boolean;
  real1: boolean;
  onAdd: (question: FormQuestion) => void;
}) {
  const asked = new Set(questions.flatMap((q) => (q.maps_to?.target === "field" && q.maps_to.field_id ? [q.maps_to.field_id] : [])));
  const sectionOptions = sections.map((s) => ({ id: s.id, label: s.name }));
  const fieldQuestions = fields.flatMap((field) => {
    const question = questionForField(field, sectionOptions, newId);
    return question ? [{ field, question }] : [];
  });
  const types = QUESTION_TYPES.filter((t) => typeAvailable(t.value, batch4, real1));
  return (
    <Popover
      label="New question"
      panelClassName="w-72 p-1.5"
      buttonClassName="btn-secondary h-8 w-full justify-center border-dashed"
      button={
        <>
          <Plus className="size-4" aria-hidden />
          New question
        </>
      }
    >
      {(close) => (
        <div className="flex flex-col">
          {fieldQuestions.length ? (
            <>
              <p className="px-2 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-wide text-zinc-400">From a field</p>
              {fieldQuestions.map(({ field, question }) => {
                const already = asked.has(field.id);
                return (
                  <button
                    key={field.id}
                    type="button"
                    disabled={already}
                    onClick={() => {
                      close();
                      onAdd(question);
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 disabled:opacity-40"
                  >
                    <FieldTypeIcon field={field} />
                    <span className="min-w-0 flex-1 truncate">{field.name}</span>
                    {already ? <span className="text-2xs text-zinc-400">Asked</span> : null}
                  </button>
                );
              })}
              <div role="separator" className="my-1 border-t border-zinc-100" />
            </>
          ) : null}
          <p className="px-2 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-wide text-zinc-400">Question types</p>
          {types.map((t) => {
            const Icon = TYPE_ICONS[t.value];
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
  count,
  question,
  questions,
  sections,
  fields,
  batch4,
  real1,
  open,
  draggable,
  dragging,
  dropLine,
  onDragStart,
  onDragEnd,
  onDragOverCard,
  onToggle,
  onChange,
  onChangeAll,
  onMove,
  onDuplicate,
  onRemove,
}: {
  index: number;
  count: number;
  question: FormQuestion;
  questions: FormQuestion[];
  sections: SectionRef[];
  fields: FieldDef[];
  batch4: boolean;
  real1: boolean;
  open: boolean;
  // Editors with two or more questions get the drag handle and Alt+↑ / Alt+↓ (the disabled fieldset
  // doesn't stop a draggable element, so the handle is only drawn when allowed).
  draggable: boolean;
  // This card is the one being dragged.
  dragging: boolean;
  // Where the drop line shows on this card, if anywhere.
  dropLine: "before" | "after" | null;
  onDragStart: () => void;
  onDragEnd: () => void;
  // Set while a drag is on: the pointer is over this card's upper (false) or lower (true) half.
  onDragOverCard?: (after: boolean) => void;
  onToggle: () => void;
  onChange: (next: FormQuestion) => void;
  onChangeAll: (next: (current: FormQuestion[]) => FormQuestion[]) => void;
  onMove: (delta: -1 | 1) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const Icon = TYPE_ICONS[question.type];
  const prefix = `fq-${question.id}`;
  const mappedField = question.maps_to?.target === "field" ? fields.find((f) => f.id === question.maps_to?.field_id) : undefined;
  const cardRef = useRef<HTMLLIElement>(null);

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
    <li
      ref={cardRef}
      onDragOver={
        onDragOverCard
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = "move";
              // Over the dragged card itself a drop changes nothing (it lands right before itself).
              const rect = e.currentTarget.getBoundingClientRect();
              onDragOverCard(!dragging && e.clientY > rect.top + rect.height / 2);
            }
          : undefined
      }
      className={`group relative rounded-lg border bg-white ${open ? "border-accent-300 shadow-sm" : "border-zinc-200"} ${
        dragging ? "opacity-40" : ""
      }`}
    >
      {dropLine ? (
        <span
          aria-hidden
          className={`pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-accent-500 ${
            dropLine === "before" ? "-top-[5px]" : "-bottom-[5px]"
          }`}
        />
      ) : null}
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
            data-tooltip="Drag to reorder (or Alt+↑ / Alt+↓)"
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
            move(e.key === "ArrowUp" ? -1 : 1, [`${prefix}-toggle`]);
          }}
          aria-expanded={open}
          aria-controls={`${prefix}-body`}
          aria-keyshortcuts={draggable ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
          className={`flex min-w-0 flex-1 items-center gap-2 py-2 pr-3 text-left ${draggable ? "pl-1" : "pl-3"}`}
        >
          <span className="w-4 shrink-0 text-right text-2xs tabular-nums text-zinc-400">{index + 1}</span>
          <Icon className="size-4 shrink-0 text-zinc-500" aria-hidden />
          <span className={`min-w-0 flex-1 truncate ${question.label.trim() ? "text-zinc-900" : "text-zinc-400"}`}>
            {question.label.trim() || "Untitled question"}
            {question.required ? <span className="text-red-600"> *</span> : null}
          </span>
          {question.show_if ? <GitBranch className="size-3.5 shrink-0 text-zinc-400" aria-label="Shown by a branch" /> : null}
          {question.maps_to ? (
            <span className="max-w-28 shrink-0 truncate rounded bg-zinc-100 px-1.5 py-px text-2xs text-zinc-600">
              {mapTargetLabel(question.maps_to.target, mappedField?.name)}
            </span>
          ) : null}
        </button>
      </div>
      {open ? (
        <div id={`${prefix}-body`} className="flex flex-col gap-3 border-t border-zinc-100 px-3 pb-3 pt-3">
          <div>
            <label htmlFor={`${prefix}-label`} className={LABEL}>
              {question.type === "heading" ? "Heading" : "Question"}
            </label>
            <input
              id={`${prefix}-label`}
              value={question.label}
              maxLength={500}
              placeholder={question.type === "heading" ? "e.g. About the request" : "Ask something"}
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
          <div className="grid grid-cols-2 gap-2">
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
                  (t) => ({ value: t.value, label: t.label }),
                )}
              />
            </div>
            {isAnswerable(question) ? (
              <label className="mt-5 flex items-center gap-2 text-sm text-zinc-700">
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
            ) : null}
          </div>

          {isChoice(question.type) ? <OptionsEditor question={question} sections={sections} fields={fields} onChange={onChange} /> : null}

          {question.type === "attachment" ? (
            <p className="text-xs text-zinc-500">
              Submitters can attach up to {MAX_FILES_PER_QUESTION} files here ({MAX_ATTACHMENT_LABEL} each:
              documents, spreadsheets, slides, images, audio, video, design files, or a zip). The files are added to the
              new task, where everyone who can open the task can open them (the submitter can’t see them afterwards).
            </p>
          ) : isAnswerable(question) ? (
            <MappingSelect question={question} fields={fields} onChange={onChange} prefix={prefix} />
          ) : null}

          {isBranchSource(question) ? <BranchEditor question={question} questions={questions} onChangeAll={onChangeAll} /> : null}

          {question.show_if ? (
            <ShownIf question={question} questions={questions} onChange={onChange} />
          ) : null}

          <div className="flex items-center gap-1 border-t border-zinc-100 pt-2">
            <button
              id={`${prefix}-move-up`}
              type="button"
              aria-label="Move question up"
              data-tooltip="Move up"
              disabled={index === 0}
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
              disabled={index === count - 1}
              onClick={() => move(1, [`${prefix}-move-down`, `${prefix}-move-up`])}
              className="btn-icon"
            >
              <ArrowDown className="size-4" />
            </button>
            <button type="button" aria-label="Duplicate question" data-tooltip="Duplicate" onClick={onDuplicate} className="btn-icon">
              <CopyPlus className="size-4" />
            </button>
            <span className="flex-1" />
            <button type="button" onClick={onRemove} className="btn-ghost h-7 text-red-700 hover:bg-red-50 hover:text-red-800">
              <Trash2 className="size-4" aria-hidden />
              Delete
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function OptionsEditor({
  question,
  sections,
  fields,
  onChange,
}: {
  question: FormQuestion;
  sections: SectionRef[];
  fields: FieldDef[];
  onChange: (next: FormQuestion) => void;
}) {
  const options = question.options ?? [];
  const sources = useMemo(() => {
    const list: { key: string; label: string; options: QuestionOption[] }[] = [];
    if (sections.length) list.push({ key: "sections", label: "Sections", options: sections.map((s) => ({ id: s.id, label: s.name })) });
    for (const field of fields) {
      if (field.boundToSections || !field.options.length) continue;
      list.push({ key: field.id, label: field.name, options: field.options.map((o) => ({ id: o.id, label: o.name })) });
    }
    return list;
  }, [sections, fields]);
  const set = (next: QuestionOption[]) => onChange({ ...question, options: next });
  return (
    <fieldset>
      <legend className={LABEL}>Options</legend>
      <ul className="mt-1 flex flex-col gap-1">
        {options.map((option, i) => (
          <li key={option.id} className="flex items-center gap-1.5">
            <span aria-hidden className={`size-3 shrink-0 border border-zinc-300 ${question.type === "multi_select" ? "rounded-sm" : "rounded-full"}`} />
            <input
              aria-label={`Option ${i + 1}`}
              value={option.label}
              maxLength={200}
              onChange={(e) => {
                const label = e.currentTarget.value;
                set(options.map((o) => (o.id === option.id ? { ...o, label } : o)));
              }}
              className="field h-8 min-w-0 flex-1"
            />
            <button
              type="button"
              aria-label={`Remove option ${option.label || i + 1}`}
              data-tooltip="Remove option"
              disabled={options.length <= 1}
              onClick={() => set(options.filter((o) => o.id !== option.id))}
              className="btn-icon"
            >
              <X className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => set([...options, { id: newId(), label: `Option ${options.length + 1}` }])}
          className="btn-ghost h-7 text-xs"
        >
          <Plus className="size-3.5" aria-hidden />
          Add option
        </button>
        {sources.length ? (
          <SmartPicker
            label="Copy options from"
            placeholder="Copy options from…"
            value={null}
            onChange={(value) => {
              const source = sources.find((s) => s.key === value);
              if (source) set(source.options);
            }}
            className="h-7 text-xs"
            options={sources.map((s) => ({ value: s.key, label: s.label }))}
          />
        ) : null}
      </div>
    </fieldset>
  );
}

function MappingSelect({
  question,
  fields,
  onChange,
  prefix,
}: {
  question: FormQuestion;
  fields: FieldDef[];
  onChange: (next: FormQuestion) => void;
  prefix: string;
}) {
  const value = question.maps_to?.target === "field" ? `field:${question.maps_to.field_id}` : (question.maps_to?.target ?? "");
  const mappable = fields.filter((f) => fieldAccepts(f, question.type));
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
          })),
        ]}
      />
      {question.maps_to?.target === "section" || (question.maps_to?.target === "field" && isChoice(question.type)) ? (
        <p className="mt-1 text-xs text-zinc-500">Options match by id first, then by name.</p>
      ) : null}
    </div>
  );
}

// "If the answer is X, show …": the questions after this one that each answer opens. A question shown by
// a branch depends on one earlier question (the database's show_if), so picking it here moves it.
function BranchEditor({
  question,
  questions,
  onChangeAll,
}: {
  question: FormQuestion;
  questions: FormQuestion[];
  onChangeAll: (next: (current: FormQuestion[]) => FormQuestion[]) => void;
}) {
  const index = questions.findIndex((q) => q.id === question.id);
  const later = questions.slice(index + 1);
  const options = branchOptions(question);

  function show(childId: string, optionId: string, on: boolean) {
    onChangeAll((current) =>
      current.map((q) => {
        if (q.id !== childId) return q;
        const sameParent = q.show_if?.question_id === question.id;
        const ids = sameParent ? (q.show_if?.option_ids ?? []) : [];
        const next = on ? [...new Set([...ids, optionId])] : ids.filter((id) => id !== optionId);
        const copy = { ...q };
        if (next.length) copy.show_if = { question_id: question.id, option_ids: next };
        else if (sameParent) delete copy.show_if;
        return copy;
      }),
    );
  }

  return (
    <div className="rounded-md bg-zinc-50 p-2.5">
      <p className="flex items-center gap-1.5 text-xs font-medium text-zinc-700">
        <GitBranch className="size-3.5 text-zinc-500" aria-hidden />
        Branching
      </p>
      {later.length === 0 ? (
        <p className="mt-1 text-xs text-zinc-500">Add questions after this one to show them only for certain answers.</p>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-1.5">
          {options.map((option) => {
            const children = later.filter((q) => q.show_if?.question_id === question.id && q.show_if.option_ids.includes(option.id));
            const addable = later.filter((q) => !children.includes(q));
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
                {addable.length ? (
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
                      <ul className="flex flex-col">
                        {addable.map((q) => (
                          <li key={q.id}>
                            <button
                              type="button"
                              onClick={() => {
                                close();
                                show(q.id, option.id, true);
                              }}
                              className="flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100"
                            >
                              <span className="truncate">{q.label || "Untitled question"}</span>
                              {q.show_if && q.show_if.question_id !== question.id ? (
                                <span className="text-2xs text-amber-700">Moves it from its current branch</span>
                              ) : null}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Popover>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ShownIf({
  question,
  questions,
  onChange,
}: {
  question: FormQuestion;
  questions: FormQuestion[];
  onChange: (next: FormQuestion) => void;
}) {
  const parent = questions.find((q) => q.id === question.show_if?.question_id);
  if (!parent) return null;
  const labels = branchOptions(parent)
    .filter((o) => question.show_if?.option_ids.includes(o.id))
    .map((o) => o.label);
  return (
    <p className="flex flex-wrap items-center gap-1 rounded-md bg-accent-50/60 px-2.5 py-2 text-xs text-zinc-700">
      <GitBranch className="size-3.5 text-accent-700" aria-hidden />
      Shown only if “{parent.label || "an earlier question"}” is {labels.length ? labels.join(" or ") : "(pick an answer there)"}.
      <button
        type="button"
        onClick={() => {
          const next = { ...question };
          delete next.show_if;
          onChange(next);
        }}
        className="ml-auto rounded px-1.5 py-0.5 font-medium text-accent-700 hover:bg-accent-100"
      >
        Always show
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
  confirmationMessage,
  setConfirmationMessage,
  sections,
  publicUrl,
  embedSnippet,
  onCopy,
  onDeleted,
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
  confirmationMessage: string;
  setConfirmationMessage: (v: string) => void;
  sections: SectionRef[];
  publicUrl: string;
  embedSnippet: string;
  onCopy: (text: string, what: string) => void;
  onDeleted: () => void;
}) {
  const [pending, run] = useServerAction();
  const confirm = useConfirm();
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
          Anyone with the link, no sign-in needed (signed-in people see their email filled in). Up to 5 submissions a
          minute per email address.
        </p>
      </SettingsGroup>
      <SettingsGroup title="Share">
        <div className="flex flex-col gap-2">
          <CopyRow label="Form link" value={publicUrl} onCopy={() => onCopy(publicUrl, "Form link")} />
          <CopyRow label="Embed code" value={embedSnippet} multiline onCopy={() => onCopy(embedSnippet, "Embed code")} />
        </div>
      </SettingsGroup>
      <div className="border-t border-zinc-100 pt-3">
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
            onDeleted();
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
