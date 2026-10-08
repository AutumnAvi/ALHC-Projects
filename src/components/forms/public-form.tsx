"use client";

import { useState, useTransition } from "react";
import { CheckCircle2 } from "lucide-react";
import { submitForm } from "@/lib/actions";
import {
  visibleQuestionIds,
  validateSubmission,
  type FormAnswers,
  type FormQuestion,
  type PublicForm as PublicFormDef,
} from "@/lib/forms";

const inputClass =
  "field h-auto w-full py-2";

function omit(errors: Record<string, string>, key: string) {
  if (!(key in errors)) return errors;
  const next = { ...errors };
  delete next[key];
  return next;
}

export function PublicForm({ form }: { form: PublicFormDef }) {
  const [pending, startTransition] = useTransition();
  const [email, setEmail] = useState(form.viewerEmail ?? "");
  const [answers, setAnswers] = useState<FormAnswers>({});
  const [website, setWebsite] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState<{ requestLabel: string | null; message: string | null } | null>(null);

  const visible = visibleQuestionIds(form.questions, answers);

  function setAnswer(id: string, value: FormAnswers[string]) {
    setAnswers((current) => ({ ...current, [id]: value }));
    setErrors((current) => omit(current, id));
  }

  if (done) {
    return (
      <div role="status" className="mt-6 rounded-lg bg-green-50 p-4 text-sm text-green-900">
        <p className="flex items-center gap-2 font-medium">
          <CheckCircle2 className="size-5" aria-hidden />
          {done.requestLabel ? `Submitted as ${done.requestLabel}` : "Submitted"}
        </p>
        <p className="mt-2 whitespace-pre-wrap">{done.message || "Thanks! Your request was received."}</p>
        <button
          type="button"
          onClick={() => {
            setAnswers({});
            setDone(null);
          }}
          className="mt-3 text-sm font-medium text-green-900 underline"
        >
          Submit another response
        </button>
      </div>
    );
  }

  return (
    <form
      noValidate
      className="mt-6 space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        setFormError(null);
        const check = validateSubmission(form.questions, email, answers);
        setErrors(check.errors);
        if (Object.keys(check.errors).length) {
          setFormError("Check the highlighted answers");
          return;
        }
        startTransition(async () => {
          const result = await submitForm(form.id, { email, answers: check.clean, website });
          if (result.error) {
            setErrors(result.fieldErrors ?? {});
            setFormError(result.error);
            return;
          }
          setDone({ requestLabel: result.requestLabel ?? null, message: result.message ?? null });
        });
      }}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="form-email" className="text-sm font-medium text-zinc-900">
          Your email <span className="text-red-600">*</span>
        </label>
        <input
          id="form-email"
          type="email"
          autoComplete="email"
          value={email}
          maxLength={320}
          onChange={(e) => {
            setEmail(e.currentTarget.value);
            setErrors((current) => omit(current, "email"));
          }}
          aria-invalid={Boolean(errors.email)}
          aria-describedby={errors.email ? "form-email-error" : undefined}
          className={inputClass}
        />
        <p className="text-xs text-zinc-500">We&apos;ll send a confirmation and updates here.</p>
        {errors.email ? (
          <p id="form-email-error" className="text-xs text-red-700">
            {errors.email}
          </p>
        ) : null}
      </div>

      {form.questions
        .filter((q) => visible.has(q.id))
        .map((question) => (
          <Question
            key={question.id}
            question={question}
            value={answers[question.id]}
            error={errors[question.id]}
            onChange={(value) => setAnswer(question.id, value)}
          />
        ))}

      <div aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label htmlFor="form-website">Website</label>
        <input
          id="form-website"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(e) => setWebsite(e.currentTarget.value)}
        />
      </div>

      {formError ? (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {formError}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending || !form.acceptingResponses}
        className="inline-flex items-center rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {pending ? "Submitting…" : "Submit"}
      </button>
    </form>
  );
}

function Question({
  question,
  value,
  error,
  onChange,
}: {
  question: FormQuestion;
  value: FormAnswers[string] | undefined;
  error?: string;
  onChange: (value: FormAnswers[string]) => void;
}) {
  const id = `q-${question.id}`;
  const describedBy = [question.help ? `${id}-help` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ") || undefined;
  const required = question.required ? <span className="text-red-600"> *</span> : null;
  const help = question.help ? (
    <p id={`${id}-help`} className="text-xs text-zinc-500">
      {question.help}
    </p>
  ) : null;
  const errorText = error ? (
    <p id={`${id}-error`} className="text-xs text-red-700">
      {error}
    </p>
  ) : null;

  if (question.type === "single_select" || question.type === "multi_select") {
    const multi = question.type === "multi_select";
    const selected = multi ? (Array.isArray(value) ? value : []) : typeof value === "string" ? value : "";
    return (
      <fieldset className="flex flex-col gap-1.5" aria-describedby={describedBy} aria-invalid={Boolean(error)}>
        <legend className="mb-1.5 text-sm font-medium text-zinc-900">
          {question.label}
          {required}
        </legend>
        {help}
        <div className="space-y-1.5">
          {(question.options ?? []).map((option) => (
            <label key={option.id} className="flex items-center gap-2 text-sm text-zinc-800">
              <input
                type={multi ? "checkbox" : "radio"}
                name={id}
                value={option.id}
                checked={multi ? (selected as string[]).includes(option.id) : selected === option.id}
                onChange={(e) => {
                  if (!multi) return onChange(option.id);
                  const current = selected as string[];
                  onChange(
                    e.currentTarget.checked ? [...current, option.id] : current.filter((o) => o !== option.id),
                  );
                }}
              />
              {option.label}
            </label>
          ))}
        </div>
        {errorText}
      </fieldset>
    );
  }

  if (question.type === "checkbox") {
    return (
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-sm font-medium text-zinc-900">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.currentTarget.checked)}
            aria-describedby={describedBy}
          />
          {question.label}
          {required}
        </label>
        {help}
        {errorText}
      </div>
    );
  }

  const common = {
    id,
    value: typeof value === "string" || typeof value === "number" ? String(value) : "",
    "aria-invalid": Boolean(error),
    "aria-describedby": describedBy,
    className: inputClass,
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-zinc-900">
        {question.label}
        {required}
      </label>
      {question.type === "long_text" ? (
        <textarea {...common} rows={5} maxLength={10000} onChange={(e) => onChange(e.currentTarget.value)} />
      ) : (
        <input
          {...common}
          type={question.type === "date" ? "date" : question.type === "number" ? "number" : "text"}
          inputMode={question.type === "number" ? "decimal" : undefined}
          maxLength={question.type === "short_text" ? 500 : undefined}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      )}
      {help}
      {errorText}
    </div>
  );
}
