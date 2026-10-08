"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, Check, Copy, ExternalLink, Plus, Trash2, X } from "lucide-react";
import { useServerAction } from "@/components/toast";
import { deleteForm, updateForm } from "@/lib/actions";
import type { FieldDef } from "@/lib/fields";
import {
  QUESTION_TYPES,
  branchOptions,
  isBranchSource,
  isChoice,
  type FormDef,
  type FormQuestion,
  type QuestionOption,
  type QuestionType,
} from "@/lib/forms";

const inputClass =
  "control h-auto min-h-8 w-full py-1";
const labelClass = "text-xs font-medium text-zinc-600";

type SectionRef = { id: string; name: string };

function newId() {
  return crypto.randomUUID();
}

// Mirrors the conversions submit_form performs when writing a mapped answer into a field.
function fieldAccepts(field: FieldDef, type: QuestionType) {
  if (field.boundToSections) return type === "single_select";
  switch (field.fieldType) {
    case "text":
      return true;
    case "number":
      return type === "number";
    case "date":
      return type === "date";
    case "boolean":
      return type === "checkbox";
    case "single_select":
    case "multi_select":
      return isChoice(type);
    default:
      return false;
  }
}

function mappingAllowed(question: FormQuestion, fields: FieldDef[]) {
  const target = question.maps_to?.target;
  if (!target) return true;
  if (target === "due_on") return question.type === "date";
  if (target === "section") return question.type === "single_select";
  if (target === "field") {
    const field = fields.find((f) => f.id === question.maps_to?.field_id);
    return Boolean(field && fieldAccepts(field, question.type));
  }
  return true;
}

// Drops anything the database would reject after edits: branching on a later or removed question,
// branching on options that no longer exist, and mappings the question type can't satisfy. While
// editing, a branch with no options picked yet is kept so the parent choice isn't lost.
function normalize(questions: FormQuestion[], fields: FieldDef[], forSave = false): FormQuestion[] {
  const earlier = new Map<string, FormQuestion>();
  return questions.map((q) => {
    const next: FormQuestion = { ...q };
    if (!isChoice(next.type)) delete next.options;
    if (!mappingAllowed(next, fields)) delete next.maps_to;
    if (next.show_if) {
      const parent = earlier.get(next.show_if.question_id);
      const valid = parent && isBranchSource(parent) ? branchOptions(parent).map((o) => o.id) : null;
      const optionIds = next.show_if.option_ids.filter((id) => valid?.includes(id));
      if (valid && (optionIds.length || !forSave)) {
        next.show_if = { question_id: next.show_if.question_id, option_ids: optionIds };
      } else {
        delete next.show_if;
      }
    }
    earlier.set(next.id, next);
    return next;
  });
}

export function FormBuilder({
  form,
  sections,
  fields,
  origin,
}: {
  form: FormDef;
  sections: SectionRef[];
  fields: FieldDef[];
  origin: string;
}) {
  const [pending, run] = useServerAction();
  const [title, setTitle] = useState(form.title);
  const [description, setDescription] = useState(form.description ?? "");
  const [destination, setDestination] = useState(form.destinationSectionId ?? "");
  const [accepting, setAccepting] = useState(form.acceptingResponses);
  const [sendConfirmation, setSendConfirmation] = useState(form.sendConfirmation);
  const [confirmationMessage, setConfirmationMessage] = useState(form.confirmationMessage ?? "");
  const [questions, setQuestions] = useState<FormQuestion[]>(form.questions);
  const [dirty, setDirty] = useState(false);
  const [newType, setNewType] = useState<QuestionType>("short_text");

  const publicUrl = `${origin}/forms/${form.id}`;
  const embedSnippet = `<iframe src="${origin}/forms/${form.id}/embed" title="${title.replace(/"/g, "&quot;")}" width="100%" height="900" style="border:0" loading="lazy"></iframe>`;

  function touch<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setDirty(true);
    };
  }

  function updateQuestion(index: number, next: FormQuestion) {
    setQuestions((current) => normalize(current.map((q, i) => (i === index ? next : q)), fields));
    setDirty(true);
  }

  function moveQuestion(index: number, delta: number) {
    setQuestions((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const copy = [...current];
      [copy[index], copy[target]] = [copy[target], copy[index]];
      return normalize(copy, fields);
    });
    setDirty(true);
  }

  function removeQuestion(index: number) {
    setQuestions((current) => normalize(current.filter((_, i) => i !== index), fields));
    setDirty(true);
  }

  function addQuestion() {
    const question: FormQuestion = {
      id: newId(),
      type: newType,
      label: "",
      ...(isChoice(newType) ? { options: [{ id: newId(), label: "Option 1" }] } : {}),
    };
    setQuestions((current) => [...current, question]);
    setDirty(true);
  }

  function save() {
    run(async () => {
      const result = await updateForm(form.id, {
        title,
        description: description || null,
        questions: normalize(questions, fields, true),
        destinationSectionId: destination || null,
        acceptingResponses: accepting,
        sendConfirmation,
        confirmationMessage: confirmationMessage || null,
      });
      if (!result.error) setDirty(false);
      return result;
    });
  }

  return (
    <div className="mx-auto max-w-3xl px-gutter py-5">
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href={`/projects/${form.projectId}/forms`}
          className="inline-flex items-center gap-1 text-sm text-zinc-600 hover:text-zinc-900"
        >
          <ArrowLeft className="size-4" aria-hidden />
          All forms
        </Link>
        <span className="flex-1" />
        <a
          href={publicUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
        >
          <ExternalLink className="size-4" aria-hidden />
          Preview
        </a>
        <button
          type="button"
          onClick={save}
          disabled={pending || !dirty || !title.trim()}
          className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          <Check className="size-4" aria-hidden />
          {dirty ? "Save changes" : "Saved"}
        </button>
      </div>

      <section aria-labelledby="form-settings" className="mt-6 space-y-4 rounded-lg border border-zinc-200 p-4">
        <h2 id="form-settings" className="text-sm font-semibold text-zinc-900">
          Form
        </h2>
        <div className="flex flex-col gap-1">
          <label htmlFor="form-title" className={labelClass}>
            Name
          </label>
          <input
            id="form-title"
            value={title}
            maxLength={200}
            onChange={(e) => touch(setTitle)(e.currentTarget.value)}
            className={inputClass}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="form-description" className={labelClass}>
            Intro shown above the questions
          </label>
          <textarea
            id="form-description"
            value={description}
            maxLength={5000}
            rows={3}
            onChange={(e) => touch(setDescription)(e.currentTarget.value)}
            className={inputClass}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="form-destination" className={labelClass}>
              New tasks land in
            </label>
            <select
              id="form-destination"
              value={destination}
              onChange={(e) => touch(setDestination)(e.currentTarget.value)}
              className={inputClass}
            >
              <option value="">No section</option>
              {sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-zinc-500">A question mapped to Section (or a Status field) overrides this.</p>
          </div>
          <div className="flex flex-col gap-2 pt-5">
            <label className="flex items-center gap-2 text-sm text-zinc-700">
              <input
                type="checkbox"
                checked={accepting}
                onChange={(e) => touch(setAccepting)(e.currentTarget.checked)}
              />
              Accepting responses
            </label>
            <label className="flex items-center gap-2 text-sm text-zinc-700">
              <input
                type="checkbox"
                checked={sendConfirmation}
                onChange={(e) => touch(setSendConfirmation)(e.currentTarget.checked)}
              />
              Email a confirmation to the submitter
            </label>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="form-confirmation" className={labelClass}>
            Thank-you message (shown after submitting and in the confirmation email)
          </label>
          <textarea
            id="form-confirmation"
            value={confirmationMessage}
            maxLength={2000}
            rows={2}
            placeholder="Thanks! We'll be in touch."
            onChange={(e) => touch(setConfirmationMessage)(e.currentTarget.value)}
            className={inputClass}
          />
        </div>
      </section>

      <section aria-labelledby="form-questions" className="mt-6">
        <h2 id="form-questions" className="text-sm font-semibold text-zinc-900">
          Questions
        </h2>
        <p className="mt-1 text-xs text-zinc-500">
          Every submission also asks for the submitter&apos;s email. Unmapped answers are summarized in the task
          description.
        </p>
        <ol className="mt-3 space-y-3">
          {questions.map((question, index) => (
            <QuestionEditor
              key={question.id}
              index={index}
              count={questions.length}
              question={question}
              earlier={questions.slice(0, index)}
              sections={sections}
              fields={fields}
              onChange={(next) => updateQuestion(index, next)}
              onMove={(delta) => moveQuestion(index, delta)}
              onRemove={() => removeQuestion(index)}
            />
          ))}
        </ol>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="new-question-type" className={labelClass}>
              Question type
            </label>
            <select
              id="new-question-type"
              value={newType}
              onChange={(e) => setNewType(e.currentTarget.value as QuestionType)}
              className={inputClass}
            >
              {QUESTION_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={addQuestion}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50"
          >
            <Plus className="size-4" aria-hidden />
            Add question
          </button>
        </div>
      </section>

      <section aria-labelledby="form-share" className="mt-8 space-y-3 rounded-lg border border-zinc-200 p-4">
        <h2 id="form-share" className="text-sm font-semibold text-zinc-900">
          Share
        </h2>
        <CopyField id="form-public-url" label="Public link" value={publicUrl} />
        <CopyField id="form-embed" label="Embed (iframe)" value={embedSnippet} multiline />
        <p className="text-xs text-zinc-500">
          Anyone with the link can submit while the form is accepting responses; no sign-in needed. Link these from a
          request hub page to offer several request types.
        </p>
      </section>

      <div className="mt-8 border-t border-zinc-100 pt-4">
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            if (!window.confirm(`Delete “${form.title}”? Existing tasks stay; the public link stops working.`)) return;
            run(() => deleteForm(form.id, form.projectId));
          }}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
        >
          <Trash2 className="size-4" aria-hidden />
          Delete form
        </button>
      </div>
    </div>
  );
}

function CopyField({
  id,
  label,
  value,
  multiline,
}: {
  id: string;
  label: string;
  value: string;
  multiline?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <div className="flex items-start gap-2">
        {multiline ? (
          <textarea id={id} readOnly value={value} rows={3} className={`${inputClass} font-mono text-xs`} />
        ) : (
          <input id={id} readOnly value={value} className={`${inputClass} font-mono text-xs`} />
        )}
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
          aria-label={`Copy ${label.toLowerCase()}`}
          className="rounded-md border border-zinc-200 p-1.5 text-zinc-600 hover:bg-zinc-50"
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </button>
      </div>
    </div>
  );
}

function QuestionEditor({
  index,
  count,
  question,
  earlier,
  sections,
  fields,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  question: FormQuestion;
  earlier: FormQuestion[];
  sections: SectionRef[];
  fields: FieldDef[];
  onChange: (next: FormQuestion) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const prefix = `q-${question.id}`;
  const mappableFields = fields.filter((f) => fieldAccepts(f, question.type));
  const parents = earlier.filter(isBranchSource);
  const parent = parents.find((p) => p.id === question.show_if?.question_id);
  const mapValue =
    question.maps_to?.target === "field" ? `field:${question.maps_to.field_id}` : (question.maps_to?.target ?? "");

  const optionSources = useMemo(() => {
    const sources: { key: string; label: string; options: QuestionOption[] }[] = [];
    if (sections.length) {
      sources.push({ key: "sections", label: "Sections", options: sections.map((s) => ({ id: s.id, label: s.name })) });
    }
    for (const field of fields) {
      if (field.boundToSections || !field.options.length) continue;
      sources.push({
        key: field.id,
        label: field.name,
        options: field.options.map((o) => ({ id: o.id, label: o.name })),
      });
    }
    return sources;
  }, [sections, fields]);

  function setType(type: QuestionType) {
    const next: FormQuestion = { ...question, type };
    if (isChoice(type) && !next.options?.length) next.options = [{ id: newId(), label: "Option 1" }];
    onChange(next);
  }

  function setMapping(value: string) {
    const next = { ...question };
    if (!value) delete next.maps_to;
    else if (value.startsWith("field:")) next.maps_to = { target: "field", field_id: value.slice(6) };
    else next.maps_to = { target: value as "title" | "notes" | "due_on" | "section" };
    onChange(next);
  }

  function setOptions(options: QuestionOption[]) {
    onChange({ ...question, options });
  }

  function setShowIf(questionId: string, optionIds: string[]) {
    const next = { ...question };
    if (!questionId) delete next.show_if;
    else next.show_if = { question_id: questionId, option_ids: optionIds };
    onChange(next);
  }

  return (
    <li className="rounded-lg border border-zinc-200 p-4">
      <div className="flex items-start gap-2">
        <span className="mt-1.5 text-xs font-medium text-zinc-400">{index + 1}.</span>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
            <div className="flex flex-col gap-1">
              <label htmlFor={`${prefix}-label`} className={labelClass}>
                Question
              </label>
              <input
                id={`${prefix}-label`}
                value={question.label}
                maxLength={500}
                placeholder="Ask something"
                onChange={(e) => onChange({ ...question, label: e.currentTarget.value })}
                className={inputClass}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={`${prefix}-type`} className={labelClass}>
                Type
              </label>
              <select
                id={`${prefix}-type`}
                value={question.type}
                onChange={(e) => setType(e.currentTarget.value as QuestionType)}
                className={inputClass}
              >
                {QUESTION_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor={`${prefix}-help`} className={labelClass}>
              Help text
            </label>
            <input
              id={`${prefix}-help`}
              value={question.help ?? ""}
              maxLength={1000}
              onChange={(e) => onChange({ ...question, help: e.currentTarget.value })}
              className={inputClass}
            />
          </div>

          {isChoice(question.type) ? (
            <fieldset className="space-y-2">
              <legend className={labelClass}>Options</legend>
              {(question.options ?? []).map((option, i) => (
                <div key={option.id} className="flex items-center gap-2">
                  <input
                    aria-label={`Option ${i + 1}`}
                    value={option.label}
                    maxLength={200}
                    onChange={(e) =>
                      setOptions(
                        (question.options ?? []).map((o) =>
                          o.id === option.id ? { ...o, label: e.currentTarget.value } : o,
                        ),
                      )
                    }
                    className={inputClass}
                  />
                  <button
                    type="button"
                    aria-label={`Remove option ${option.label || i + 1}`}
                    disabled={(question.options ?? []).length <= 1}
                    onClick={() => setOptions((question.options ?? []).filter((o) => o.id !== option.id))}
                    className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-30"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setOptions([
                      ...(question.options ?? []),
                      { id: newId(), label: `Option ${(question.options ?? []).length + 1}` },
                    ])
                  }
                  className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-zinc-600 hover:bg-zinc-100"
                >
                  <Plus className="size-3.5" aria-hidden />
                  Add option
                </button>
                {optionSources.length ? (
                  <select
                    aria-label="Copy options from"
                    value=""
                    onChange={(e) => {
                      const source = optionSources.find((s) => s.key === e.currentTarget.value);
                      if (source) setOptions(source.options);
                    }}
                    className="rounded-md border border-zinc-200 bg-white px-1.5 py-1 text-xs text-zinc-600"
                  >
                    <option value="">Copy options from…</option>
                    {optionSources.map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
            </fieldset>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label htmlFor={`${prefix}-map`} className={labelClass}>
                Fills in
              </label>
              <select
                id={`${prefix}-map`}
                value={mapValue}
                onChange={(e) => setMapping(e.currentTarget.value)}
                className={inputClass}
              >
                <option value="">Description summary only</option>
                <option value="title">Task name</option>
                <option value="notes">Description</option>
                {question.type === "date" ? <option value="due_on">Due date</option> : null}
                {question.type === "single_select" ? <option value="section">Section</option> : null}
                {mappableFields.map((f) => (
                  <option key={f.id} value={`field:${f.id}`}>
                    Field: {f.name}
                    {f.boundToSections ? " (moves section)" : ""}
                  </option>
                ))}
              </select>
              {question.maps_to?.target === "section" || question.maps_to?.target === "field" ? (
                <p className="text-xs text-zinc-500">Options match by id first, then by name.</p>
              ) : null}
            </div>
            <label className="flex items-center gap-2 pt-5 text-sm text-zinc-700">
              <input
                type="checkbox"
                checked={Boolean(question.required)}
                onChange={(e) => onChange({ ...question, required: e.currentTarget.checked || undefined })}
              />
              Required
            </label>
          </div>

          {parents.length ? (
            <fieldset className="space-y-2 rounded-md bg-zinc-50 p-3">
              <legend className="sr-only">Branching</legend>
              <div className="flex flex-col gap-1">
                <label htmlFor={`${prefix}-show-if`} className={labelClass}>
                  Only show when
                </label>
                <select
                  id={`${prefix}-show-if`}
                  value={question.show_if?.question_id ?? ""}
                  onChange={(e) => setShowIf(e.currentTarget.value, [])}
                  className={inputClass}
                >
                  <option value="">Always show</option>
                  {parents.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label || "Untitled question"}
                    </option>
                  ))}
                </select>
              </div>
              {parent ? (
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <span className="w-full text-xs text-zinc-500">…is answered with any of:</span>
                  {branchOptions(parent).map((option) => {
                    const checked = question.show_if?.option_ids.includes(option.id) ?? false;
                    return (
                      <label key={option.id} className="flex items-center gap-1.5 text-sm text-zinc-700">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const current = question.show_if?.option_ids ?? [];
                            setShowIf(
                              parent.id,
                              e.currentTarget.checked
                                ? [...current, option.id]
                                : current.filter((id) => id !== option.id),
                            );
                          }}
                        />
                        {option.label}
                      </label>
                    );
                  })}
                  {!question.show_if?.option_ids.length ? (
                    <span className="w-full text-xs text-amber-700">Pick at least one option, or it always shows.</span>
                  ) : null}
                </div>
              ) : null}
            </fieldset>
          ) : null}
        </div>
        <div className="flex flex-col gap-1">
          <button
            type="button"
            aria-label="Move question up"
            disabled={index === 0}
            onClick={() => onMove(-1)}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-30"
          >
            <ArrowUp className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Move question down"
            disabled={index === count - 1}
            onClick={() => onMove(1)}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-30"
          >
            <ArrowDown className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Delete question"
            onClick={onRemove}
            className="rounded p-1 text-zinc-400 hover:bg-red-50 hover:text-red-700"
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      </div>
    </li>
  );
}
