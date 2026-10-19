"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { ImageUp, RotateCcw, Send } from "lucide-react";
import { useNotify, useServerAction } from "@/components/toast";
import {
  DESIGN_DEFAULTS,
  DESIGN_FIELDS,
  DESIGN_LIMITS,
  EMPTY_SETTINGS,
  FILL_IN_LABELS,
  designProblem,
  fillInFieldsFor,
  isHexColor,
  type DesignField,
  type DesignSource,
  type EmailDesignKind,
  type EmailDesignSettings,
  type ResolvedDesign,
} from "@/lib/email-design";
import {
  previewEmailDesign,
  resetEmailDesign,
  saveEmailDesign,
  sendEmailDesignTest,
  type EmailDesignScope,
} from "@/lib/email-design-actions";
import { createClient } from "@/lib/supabase/client";
import { LOGO_MAX_BYTES, LOGO_TYPES, WORKSPACE_ASSETS_BUCKET } from "@/lib/workspace";

// One email design: a scope's settings (the workspace default of a kind, a project override, or a
// form override), a live preview rendered by the server exactly as the drain would, "Send me a test",
// Save, and — for overrides — Reset. In an override every setting either inherits (shown greyed with
// where it comes from) or is overridden here. The database decides who may save (RLS).

const LABEL = "text-xs font-medium text-zinc-600";
const SOURCE_LABELS: Record<DesignSource, string> = {
  form: "this form",
  project: "this project",
  workspace: "the workspace",
  default: "the built-in default",
};

type TextField = "headerText" | "introMessage" | "footerText" | "buttonLabel";
const TEXT_FIELDS: { field: TextField; label: string; multiline: boolean; hint?: (kind: EmailDesignKind) => string }[] = [
  { field: "headerText", label: "Header text", multiline: false },
  { field: "introMessage", label: "Intro message", multiline: true },
  { field: "footerText", label: "Sign-off / footer", multiline: true },
  {
    field: "buttonLabel",
    label: "Button label",
    multiline: false,
    hint: (kind) =>
      kind === "internal"
        ? "Leave empty to keep each email’s own label (“Open task”, “Open Inbox”, …)."
        : "Requester emails have no button unless you name one; it links to the request’s form.",
  },
];

export function EmailDesignEditor({
  scope,
  workspaceId,
  own,
  inherited,
  canEdit,
  title,
  description,
}: {
  scope: EmailDesignScope;
  workspaceId: string;
  // This scope's own settings (null = no row yet).
  own: EmailDesignSettings | null;
  // What this scope inherits (the parent scopes resolved) and from where; null at the workspace level.
  inherited: { design: ResolvedDesign; sources: Record<DesignField, DesignSource> } | null;
  canEdit: boolean;
  title: string;
  description?: string;
}) {
  const kind = scope.kind;
  const isOverride = inherited !== null;
  // At the workspace level every setting is set here (starting from the built-in defaults); in an
  // override a null setting inherits.
  const initial = useMemo<EmailDesignSettings>(() => {
    if (isOverride) return own ?? EMPTY_SETTINGS;
    const base = { ...DESIGN_DEFAULTS[kind] } as EmailDesignSettings;
    for (const key of Object.keys(base) as DesignField[]) if (own && own[key] !== null) base[key] = own[key];
    return base;
  }, [own, kind, isOverride]);
  const [draft, setDraft] = useState<EmailDesignSettings>(initial);
  const [saved, setSaved] = useState<EmailDesignSettings>(initial);
  const dirty = DESIGN_FIELDS.some((f) => draft[f] !== saved[f]);
  const [pending, run] = useServerAction();
  const notify = useNotify();
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [sending, startSending] = useTransition();
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastFocused = useRef<{ field: TextField; el: HTMLInputElement | HTMLTextAreaElement } | null>(null);
  const problem = designProblem(draft);

  // Reset the form when the server's copy changes (after a save or a reset elsewhere).
  const [initialSeen, setInitialSeen] = useState(initial);
  if (initialSeen !== initial) {
    setInitialSeen(initial);
    setDraft(initial);
    setSaved(initial);
  }

  // Live preview, debounced; stale answers are dropped.
  const requestId = useRef(0);
  const { projectId, formId } = scope;
  useEffect(() => {
    const id = ++requestId.current;
    const timer = window.setTimeout(async () => {
      const result = await previewEmailDesign({ kind, projectId, formId, settings: draft }).catch(() => ({
        error: "Couldn’t reach the server",
      }));
      if (id !== requestId.current) return;
      if ("html" in result && result.html) {
        setPreview({ subject: result.subject ?? "", html: result.html });
        setPreviewError(null);
      } else setPreviewError(result.error ?? "Couldn’t render the preview");
    }, 300);
    return () => window.clearTimeout(timer);
  }, [draft, kind, projectId, formId]);

  function set(field: DesignField, value: string | null) {
    setDraft((d) => ({ ...d, [field]: value }));
  }

  function insertFillIn(token: string) {
    const target = lastFocused.current;
    if (!target || draft[target.field] === null) return;
    const el = target.el;
    const value = draft[target.field] ?? "";
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = `${value.slice(0, start)}{${token}}${value.slice(end)}`;
    set(target.field, next);
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + token.length + 2;
      el.setSelectionRange(caret, caret);
    });
  }

  async function uploadLogo(file: File) {
    if (!(LOGO_TYPES as readonly string[]).includes(file.type)) return notify("Use a PNG, JPEG, WebP, or GIF image.");
    if (file.size > LOGO_MAX_BYTES) return notify("The logo must be 2 MB or smaller.");
    setUploading(true);
    const ext = file.name.toLowerCase().match(/\.(png|jpe?g|webp|gif)$/)?.[1]?.replace("jpeg", "jpg") ?? "png";
    const folder = scope.projectId ? `${workspaceId}/email/${scope.projectId}` : `${workspaceId}/email`;
    const path = `${folder}/logo-${crypto.randomUUID()}.${ext}`;
    const { error } = await createClient()
      .storage.from(WORKSPACE_ASSETS_BUCKET)
      .upload(path, file, { contentType: file.type, upsert: false });
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
    if (error) return notify(`Couldn’t upload the logo: ${error.message}`);
    set("logoPath", path);
  }

  function save() {
    if (problem) return notify(problem);
    run(async () => {
      const result = await saveEmailDesign({ ...scope, settings: draft });
      if (!result.error) {
        setSaved(draft);
        notify("Email design saved");
      }
      return result;
    });
  }

  function reset() {
    run(async () => {
      const result = await resetEmailDesign(scope);
      if (!result.error) {
        setDraft(EMPTY_SETTINGS);
        setSaved(EMPTY_SETTINGS);
        notify("Now using the inherited design");
      }
      return result;
    });
  }

  function sendTest() {
    if (problem) return notify(problem);
    startSending(async () => {
      const result = await sendEmailDesignTest({ ...scope, settings: draft }).catch(() => ({ error: "Couldn’t reach the server" }));
      if ("outcome" in result && result.outcome) {
        notify(
          result.outcome === "sent"
            ? `Test email sent to ${result.to}`
            : "No email provider is set up here, so nothing was sent. The preview shows what it would look like.",
        );
      } else notify(result.error ?? "Couldn’t send the test");
    });
  }

  const effective = (field: DesignField): string =>
    draft[field] ?? (inherited ? inherited.design[field] : DESIGN_DEFAULTS[kind][field]) ?? "";

  // An override's "Set here" toggle for one setting.
  function overrideToggle(field: DesignField) {
    if (!isOverride) return null;
    const on = draft[field] !== null;
    return (
      <label className="flex items-center gap-1.5 text-xs text-zinc-600">
        <input
          type="checkbox"
          checked={on}
          disabled={!canEdit}
          onChange={(e) => set(field, e.target.checked ? (inherited?.design[field] ?? "") : null)}
        />
        {on ? "Set here" : `From ${SOURCE_LABELS[inherited!.sources[field]]}`}
      </label>
    );
  }

  return (
    <section className="rounded-lg border border-zinc-200" aria-labelledby={`design-${scope.kind}-${scope.formId ?? scope.projectId ?? "ws"}`}>
      <div className="flex flex-wrap items-start gap-3 border-b border-zinc-200 px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 id={`design-${scope.kind}-${scope.formId ?? scope.projectId ?? "ws"}`} className="text-sm font-semibold text-zinc-900">
            {title}
          </h2>
          {description ? <p className="mt-1 text-sm text-zinc-600">{description}</p> : null}
        </div>
        {canEdit ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {isOverride && own ? (
              <button type="button" className="btn-ghost" onClick={reset} disabled={pending}>
                <RotateCcw className="size-4" aria-hidden />
                Reset
              </button>
            ) : null}
            <button type="button" className="btn-secondary" onClick={sendTest} disabled={sending || Boolean(problem)}>
              <Send className="size-4" aria-hidden />
              {sending ? "Sending…" : "Send me a test"}
            </button>
            <button type="button" className="btn-primary" onClick={save} disabled={pending || !dirty || Boolean(problem)}>
              {pending ? "Saving…" : "Save"}
            </button>
          </div>
        ) : null}
      </div>

      <div className="grid gap-6 p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <fieldset disabled={!canEdit} className="min-w-0 space-y-4">
          {/* Logo */}
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className={LABEL}>Logo</span>
              {overrideToggle("logoPath")}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {effective("logoPath") ? (
                // eslint-disable-next-line @next/next/no-img-element -- a public Storage URL, shown as is
                <img
                  src={createClient().storage.from(WORKSPACE_ASSETS_BUCKET).getPublicUrl(effective("logoPath")).data.publicUrl}
                  alt="Email logo"
                  className="h-10 max-w-48 rounded-md border border-zinc-200 bg-white object-contain p-1"
                />
              ) : (
                <span className="text-sm text-zinc-500">No logo</span>
              )}
              {draft.logoPath !== null ? (
                <>
                  <input
                    ref={fileRef}
                    type="file"
                    accept={LOGO_TYPES.join(",")}
                    className="sr-only"
                    id={`logo-${scope.kind}-${scope.formId ?? scope.projectId ?? "ws"}`}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void uploadLogo(file);
                    }}
                  />
                  <label
                    htmlFor={`logo-${scope.kind}-${scope.formId ?? scope.projectId ?? "ws"}`}
                    className={`btn-secondary ${!canEdit || uploading ? "pointer-events-none opacity-50" : "cursor-pointer"}`}
                  >
                    <ImageUp className="size-4" aria-hidden />
                    {uploading ? "Uploading…" : "Upload"}
                  </label>
                  {draft.logoPath ? (
                    <button type="button" className="btn-ghost" onClick={() => set("logoPath", "")}>
                      Remove
                    </button>
                  ) : null}
                </>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-zinc-500">PNG, JPEG, WebP, or GIF up to 2 MB, shown 32 px tall.</p>
          </div>

          {/* Colors */}
          <div className="grid gap-4 sm:grid-cols-2">
            {(
              [
                ["accentColor", "Accent color"],
                ["buttonColor", "Button color"],
              ] as const
            ).map(([field, label]) => (
              <div key={field}>
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor={`${field}-${scope.kind}-${scope.formId ?? scope.projectId ?? "ws"}`} className={LABEL}>
                    {label}
                  </label>
                  {overrideToggle(field)}
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <input
                    type="color"
                    aria-label={`${label} swatch`}
                    value={isHexColor(effective(field)) ? effective(field) : "#4573d2"}
                    disabled={draft[field] === null}
                    onChange={(e) => set(field, e.target.value)}
                    className="h-8 w-10 shrink-0 cursor-pointer rounded border border-zinc-200 bg-white p-0.5 disabled:cursor-default disabled:opacity-60"
                  />
                  <input
                    id={`${field}-${scope.kind}-${scope.formId ?? scope.projectId ?? "ws"}`}
                    className="control w-28 font-mono"
                    value={draft[field] ?? effective(field)}
                    disabled={draft[field] === null}
                    maxLength={7}
                    onChange={(e) => set(field, e.target.value)}
                  />
                </div>
              </div>
            ))}
          </div>

          {/* Texts */}
          {TEXT_FIELDS.map(({ field, label, multiline, hint }) => {
            const id = `${field}-${scope.kind}-${scope.formId ?? scope.projectId ?? "ws"}`;
            const value = draft[field] ?? effective(field);
            const props = {
              id,
              value,
              disabled: draft[field] === null,
              maxLength: DESIGN_LIMITS[field],
              onFocus: (e: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
                lastFocused.current = { field, el: e.currentTarget };
              },
              onChange: (e: { target: { value: string } }) => set(field, e.target.value),
            };
            return (
              <div key={field}>
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor={id} className={LABEL}>
                    {label}
                  </label>
                  {overrideToggle(field)}
                </div>
                {multiline ? (
                  <textarea {...props} rows={3} className="field mt-1.5 h-auto py-2" />
                ) : (
                  <input {...props} className="field mt-1.5" />
                )}
                {hint ? <p className="mt-1 text-xs text-zinc-500">{hint(kind)}</p> : null}
              </div>
            );
          })}

          <div>
            <p className={LABEL}>Fill-in fields</p>
            <p className="mt-0.5 text-xs text-zinc-500">
              Click one to add it where your cursor is. Fields an email doesn’t have are left blank.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {fillInFieldsFor(kind).map((f) => (
                <button
                  key={f}
                  type="button"
                  className="chip cursor-pointer font-mono hover:bg-zinc-200"
                  data-tooltip={FILL_IN_LABELS[f]}
                  aria-label={`Insert ${FILL_IN_LABELS[f]}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insertFillIn(f)}
                >
                  {`{${f}}`}
                </button>
              ))}
            </div>
          </div>
          {problem ? (
            <p role="alert" className="text-sm text-red-700">
              {problem}
            </p>
          ) : null}
        </fieldset>

        <div className="min-w-0">
          <p className={LABEL}>Preview</p>
          <div className="mt-1.5 overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50">
            <div className="border-b border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-600">
              <span className="text-zinc-400">Subject: </span>
              {preview?.subject ?? "…"}
            </div>
            {preview ? (
              <iframe
                title={`${title} preview`}
                sandbox=""
                srcDoc={preview.html}
                className="block h-[30rem] w-full bg-[#f4f4f5]"
              />
            ) : (
              <div className="flex h-[30rem] items-center justify-center text-sm text-zinc-500">
                {previewError ?? "Rendering preview…"}
              </div>
            )}
          </div>
          <p className="mt-1 text-xs text-zinc-500">Sample content; real emails fill in their own details.</p>
        </div>
      </div>
    </section>
  );
}

