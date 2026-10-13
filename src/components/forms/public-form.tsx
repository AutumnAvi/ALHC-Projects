"use client";

import { useId, useRef, useState, useTransition, type ReactNode } from "react";
import { CheckCircle2, FileText, Loader2, Paperclip, X } from "lucide-react";
import { submitForm } from "@/lib/actions";
import { ATTACHMENTS_BUCKET, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_LABEL } from "@/lib/attachments";
import {
  FORM_UPLOAD_EXTENSIONS,
  MAX_FILES_PER_QUESTION,
  MAX_FILES_PER_RESPONSE,
  formFileExtensionOk,
  formUploadPath,
  isFormFile,
  visibleQuestionIds,
  validateSubmission,
  type FormAnswers,
  type FormFile,
  type FormQuestion,
  type PublicForm as PublicFormDef,
} from "@/lib/forms";
import { createAnonBrowserClient } from "@/lib/supabase/anon-browser";

const inputClass =
  "field h-auto w-full py-2";

// crypto.randomUUID only exists in secure contexts; an embed on an http:// page isn't one.
function randomId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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
  // Attachment questions (Real features 1): one random key per response, the folder its files go to and
  // the id its task gets; a new one after each submission.
  const uploadKey = useRef<string | null>(null);
  // Files uploaded under the key so far, removed ones included (they stay in Storage until the cleanup,
  // and the upload check counts them).
  const uploadedCount = useRef(0);
  const [uploading, setUploading] = useState(0);

  const visible = visibleQuestionIds(form.questions, answers);

  // Uploads one file straight to private Storage as anon (the form-upload policy decides) and returns
  // its { path, name }, or a reason it can't go in.
  async function upload(file: File): Promise<FormFile | { error: string }> {
    if (!formFileExtensionOk(file.name)) return { error: `${file.name}: this kind of file can’t be attached` };
    if (file.size > MAX_ATTACHMENT_BYTES) return { error: `${file.name} is over ${MAX_ATTACHMENT_LABEL}` };
    if (uploadedCount.current >= MAX_FILES_PER_RESPONSE) {
      return {
        error: `A response can take ${MAX_FILES_PER_RESPONSE} files in all, including ones you removed. Reload the form to start over.`,
      };
    }
    setUploading((n) => n + 1);
    try {
      uploadKey.current ??= randomId();
      const path = formUploadPath(uploadKey.current, form.id, file.name, randomId());
      const { error } = await createAnonBrowserClient()
        .storage.from(ATTACHMENTS_BUCKET)
        .upload(path, file, { contentType: file.type || undefined, upsert: false });
      if (error) return { error: `${file.name} couldn’t be uploaded. Try again in a few minutes.` };
      uploadedCount.current += 1;
      return { path, name: file.name.slice(0, 255) };
    } catch {
      return { error: `${file.name} couldn’t be uploaded. Check your connection and try again.` };
    } finally {
      setUploading((n) => n - 1);
    }
  }

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
            uploadKey.current = null;
            uploadedCount.current = 0;
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
        if (uploading > 0) {
          setFormError("Wait for your files to finish uploading");
          return;
        }
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
          <FormQuestionField
            key={question.id}
            question={question}
            value={answers[question.id]}
            error={errors[question.id]}
            onChange={(value) => setAnswer(question.id, value)}
            // A closed form only shows to project members as a preview: nothing can be uploaded to it.
            upload={form.acceptingResponses ? upload : undefined}
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
        disabled={pending || uploading > 0 || !form.acceptingResponses}
        className="inline-flex items-center rounded-md bg-accent-500 px-4 py-2 text-sm font-medium text-white hover:bg-accent-600 disabled:opacity-50"
      >
        {pending ? "Submitting…" : uploading > 0 ? "Uploading files…" : "Submit"}
      </button>
    </form>
  );
}

// One question as people see it (the public form and the form editor's live preview).
export function FormQuestionField({
  question,
  value,
  error,
  onChange,
  idPrefix = "q",
  upload,
}: {
  question: FormQuestion;
  value: FormAnswers[string] | undefined;
  error?: string;
  onChange: (value: FormAnswers[string]) => void;
  // The editor's preview renders next to its own inputs, so its ids get another prefix.
  idPrefix?: string;
  // The live form's file uploader (attachment questions); the editor's preview has none.
  upload?: (file: File) => Promise<FormFile | { error: string }>;
}) {
  const id = `${idPrefix}-${question.id}`;
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

  if (question.type === "heading") {
    return (
      <div className="flex flex-col gap-1 border-b border-zinc-200 pb-2 pt-2">
        <h2 className="text-base font-semibold text-zinc-900">{question.label}</h2>
        {question.help ? <p className="whitespace-pre-wrap text-sm text-zinc-600">{question.help}</p> : null}
      </div>
    );
  }

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

  if (question.type === "attachment") {
    return (
      <AttachmentField
        id={id}
        question={question}
        files={Array.isArray(value) ? value.filter(isFormFile) : []}
        required={required}
        help={help}
        errorText={errorText}
        describedBy={describedBy}
        onChange={onChange}
        upload={upload}
      />
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
          type={question.type === "date" ? "date" : question.type === "number" ? "number" : question.type === "email" ? "email" : "text"}
          inputMode={question.type === "number" ? "decimal" : undefined}
          autoComplete={question.type === "email" ? "off" : undefined}
          maxLength={question.type === "short_text" ? 500 : question.type === "email" ? 320 : undefined}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      )}
      {help}
      {errorText}
    </div>
  );
}

const ACCEPT = FORM_UPLOAD_EXTENSIONS.map((ext) => `.${ext}`).join(",");

// An attachment question: the files picked so far (remove one with ×) and "Add files", which uploads
// each chosen file right away. Up to 5 files here (10 per response), 25 MB each, listed types only.
function AttachmentField({
  id,
  question,
  files,
  required,
  help,
  errorText,
  describedBy,
  onChange,
  upload,
}: {
  id: string;
  question: FormQuestion;
  files: FormFile[];
  required: ReactNode;
  help: ReactNode;
  errorText: ReactNode;
  describedBy: string | undefined;
  onChange: (value: FormAnswers[string]) => void;
  upload?: (file: File) => Promise<FormFile | { error: string }>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const statusId = useId();
  const [busy, setBusy] = useState<string[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const full = files.length >= MAX_FILES_PER_QUESTION;
  // While files upload the list is locked (no adding or removing), so each finished file lands on top of
  // the ones before it.
  const locked = busy.length > 0;

  async function add(chosen: FileList | null) {
    if (!upload || !chosen?.length) return;
    const picked = Array.from(chosen);
    const accepted = picked.slice(0, Math.max(MAX_FILES_PER_QUESTION - files.length, 0));
    setProblems(picked.length > accepted.length ? [`Attach up to ${MAX_FILES_PER_QUESTION} files here`] : []);
    setBusy(accepted.map((file) => file.name));
    let current = files;
    for (const file of accepted) {
      let result: FormFile | { error: string };
      try {
        result = await upload(file);
      } catch {
        result = { error: `${file.name} couldn’t be uploaded. Try again.` };
      } finally {
        setBusy((names) => names.slice(1));
      }
      if ("error" in result) {
        const reason = result.error;
        setProblems((problems) => [...problems, reason]);
      } else {
        current = [...current, result];
        onChange(current);
      }
    }
  }

  return (
    <fieldset className="flex flex-col gap-1.5" aria-describedby={describedBy} aria-invalid={Boolean(errorText)}>
      <legend className="mb-1.5 text-sm font-medium text-zinc-900">
        {question.label}
        {required}
      </legend>
      {help}
      {files.length || busy.length ? (
        <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
          {files.map((file) => (
            <li key={file.path} className="flex items-center gap-2 px-3 py-2 text-sm text-zinc-800">
              <FileText className="size-4 shrink-0 text-zinc-400" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{file.name}</span>
              <button
                type="button"
                disabled={locked}
                onClick={() => onChange(files.filter((f) => f.path !== file.path))}
                aria-label={`Remove ${file.name}`}
                data-tooltip="Remove"
                className="btn-icon h-6 w-6"
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
          {busy.map((name, i) => (
            <li key={`${name}-${i}`} className="flex items-center gap-2 px-3 py-2 text-sm text-zinc-500">
              <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
              <span className="min-w-0 flex-1 truncate">Uploading {name}…</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            const chosen = e.currentTarget.files;
            void add(chosen).finally(() => {
              if (input.current) input.current.value = "";
            });
          }}
        />
        <button
          id={id}
          type="button"
          disabled={!upload || full || locked}
          onClick={() => input.current?.click()}
          aria-describedby={statusId}
          className="btn-secondary h-9 gap-1.5"
        >
          <Paperclip className="size-4" aria-hidden />
          {files.length ? "Add more files" : "Add files"}
        </button>
        <p id={statusId} className="mt-1 text-xs text-zinc-500">
          {upload
            ? `Up to ${MAX_FILES_PER_QUESTION} files, ${MAX_ATTACHMENT_LABEL} each: documents, spreadsheets, slides, images, audio, video, design files, or a zip.`
            : "People pick files here on the live form."}
        </p>
      </div>
      {problems.length ? (
        <ul role="alert" className="text-xs text-red-700">
          {problems.map((problem, i) => (
            <li key={i}>{problem}</li>
          ))}
        </ul>
      ) : null}
      {errorText}
    </fieldset>
  );
}
