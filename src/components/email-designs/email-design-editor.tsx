"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { ImageUp, RotateCcw, Send } from "lucide-react";
import { Segmented } from "@/components/project/view-chrome";
import { useNotify, useServerAction } from "@/components/toast";
import {
  DESIGN_DEFAULTS,
  DESIGN_FIELDS,
  DESIGN_LIMITS,
  DESIGN_SAMPLES,
  EMPTY_SETTINGS,
  FILL_IN_LABELS,
  OWN_TEXT_LABELS,
  designProblem,
  fillInFieldsFor,
  isHexColor,
  type BlockDesignField,
  type DesignField,
  type DesignSample,
  type DesignSource,
  type EmailDesignSettings,
  type OwnTextField,
  type ResolvedDesign,
  type TextDesignField,
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
// Save, and — for overrides — Reset. The settings follow the email from top to bottom (subject, logo,
// header label, heading, intro, message, details, button, small print, sign-off); every block has a
// Shown / Hidden switch, and the texts take fill-in fields. In an override every setting either
// inherits (shown greyed with where it comes from) or is set here. The database decides who may save
// (RLS).

const LABEL = "text-xs font-medium text-zinc-600";
const HINT = "mt-1 text-xs text-zinc-500";
const SOURCE_LABELS: Record<DesignSource, string> = {
  form: "this form",
  project: "this project",
  workspace: "the workspace",
  default: "the built-in default",
};

// The text fields fill-in chips can be inserted into.
type FillTarget = "subjectTemplate" | "headerText" | "headingText" | "introMessage" | "buttonLabel" | "noticeText" | "footerText";

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
  const idSuffix = `${scope.kind}-${scope.formId ?? scope.projectId ?? "ws"}`;
  // At the workspace level every setting is set here (starting from the built-in defaults); in an
  // override a null setting inherits.
  const initial = useMemo<EmailDesignSettings>(() => {
    if (isOverride) return own ?? EMPTY_SETTINGS;
    const base: Record<DesignField, string | boolean | null> = { ...DESIGN_DEFAULTS[kind] };
    for (const key of DESIGN_FIELDS) if (own && own[key] !== null) base[key] = own[key];
    return base as EmailDesignSettings;
  }, [own, kind, isOverride]);
  const [draft, setDraft] = useState<EmailDesignSettings>(initial);
  const [saved, setSaved] = useState<EmailDesignSettings>(initial);
  const dirty = DESIGN_FIELDS.some((f) => draft[f] !== saved[f]);
  const [pending, run] = useServerAction();
  const notify = useNotify();
  const [sample, setSample] = useState<DesignSample>(DESIGN_SAMPLES[kind][0].key);
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [sending, startSending] = useTransition();
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // The text field fill-ins go into (the one last focused).
  const [lastFocused, setLastFocused] = useState<{ field: FillTarget; el: HTMLInputElement | HTMLTextAreaElement } | null>(null);
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
      const result = await previewEmailDesign({ kind, projectId, formId, settings: draft, sample }).catch(() => ({
        error: "Couldn’t reach the server",
      }));
      if (id !== requestId.current) return;
      if ("html" in result && result.html) {
        setPreview({ subject: result.subject ?? "", html: result.html });
        setPreviewError(null);
      } else setPreviewError(result.error ?? "Couldn’t render the preview");
    }, 300);
    return () => window.clearTimeout(timer);
  }, [draft, kind, projectId, formId, sample]);

  function set<F extends DesignField>(field: F, value: EmailDesignSettings[F]) {
    setDraft((d) => ({ ...d, [field]: value }));
  }

  const effective = <F extends DesignField>(field: F): ResolvedDesign[F] =>
    (draft[field] ?? (inherited ? inherited.design[field] : DESIGN_DEFAULTS[kind][field])) as ResolvedDesign[F];

  function insertFillIn(token: string) {
    const target = lastFocused;
    if (!target || draft[target.field] === null) return;
    const el = target.el;
    const value = draft[target.field] ?? "";
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    set(target.field, `${value.slice(0, start)}{${token}}${value.slice(end)}`);
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
      const result = await sendEmailDesignTest({ ...scope, settings: draft, sample }).catch(() => ({
        error: "Couldn’t reach the server",
      }));
      if ("outcome" in result && result.outcome) {
        notify(
          result.outcome === "sent"
            ? `Test email sent to ${result.to}`
            : "No email provider is set up here, so nothing was sent. The preview shows what it would look like.",
        );
      } else notify(result.error ?? "Couldn’t send the test");
    });
  }

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
          onChange={(e) => set(field, e.target.checked ? inherited!.design[field] : null)}
        />
        {on ? "Set here" : `From ${SOURCE_LABELS[inherited!.sources[field]]}`}
      </label>
    );
  }

  // A block of the email: its name, the Shown / Hidden switch (and, in an override, whether the switch
  // is set here), then its settings — dimmed while the block is hidden.
  function block(field: BlockDesignField, label: string, { note, children }: { note?: ReactNode; children?: ReactNode } = {}) {
    const shown = effective(field);
    const inheritedSwitch = draft[field] === null;
    return (
      <div key={field} className="rounded-md border border-zinc-200 px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-zinc-800">{label}</span>
          <div className="flex items-center gap-3">
            {overrideToggle(field)}
            <button
              type="button"
              role="switch"
              aria-checked={shown}
              aria-label={`Show ${label.toLowerCase()}`}
              disabled={!canEdit || inheritedSwitch}
              onClick={() => set(field, !shown)}
              className="flex items-center gap-1.5 text-xs text-zinc-600 disabled:opacity-60"
            >
              <span className={`relative h-5 w-8 shrink-0 rounded-full transition-colors ${shown ? "bg-accent-500" : "bg-zinc-300"}`}>
                <span
                  className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform ${shown ? "translate-x-3" : ""}`}
                />
              </span>
              {shown ? "Shown" : "Hidden"}
            </button>
          </div>
        </div>
        {note ? <p className={HINT}>{note}</p> : null}
        {children ? <div className={`mt-2 space-y-3 ${shown ? "" : "opacity-60"}`}>{children}</div> : null}
      </div>
    );
  }

  function textSetting({
    field,
    label,
    multiline = false,
    placeholder,
    hint,
  }: {
    field: TextDesignField & FillTarget;
    label: string;
    multiline?: boolean;
    placeholder?: string;
    hint?: ReactNode;
  }) {
    const id = `${field}-${idSuffix}`;
    const props = {
      id,
      value: draft[field] ?? effective(field),
      disabled: draft[field] === null,
      maxLength: DESIGN_LIMITS[field],
      placeholder,
      onFocus: (e: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
        setLastFocused({ field, el: e.currentTarget });
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
        {multiline ? <textarea {...props} rows={3} className="field mt-1.5 h-auto w-full py-2" /> : <input {...props} className="field mt-1.5 w-full" />}
        {hint ? <p className={HINT}>{hint}</p> : null}
      </div>
    );
  }

  function colorSetting(field: "accentColor" | "buttonColor", label: string) {
    const id = `${field}-${idSuffix}`;
    return (
      <div key={field}>
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={id} className={LABEL}>
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
            id={id}
            className="control w-28 font-mono"
            value={draft[field] ?? effective(field)}
            disabled={draft[field] === null}
            maxLength={7}
            onChange={(e) => set(field, e.target.value)}
          />
        </div>
      </div>
    );
  }

  // The fill-ins offered for the field being edited: the subject and heading also take the email's own.
  const ownTokens: OwnTextField[] =
    lastFocused?.field === "subjectTemplate"
      ? ["email_subject"]
      : lastFocused?.field === "headingText"
        ? ["email_heading", "email_subject"]
        : [];
  const logoId = `logo-${idSuffix}`;

  return (
    <section className="rounded-lg border border-zinc-200" aria-labelledby={`design-${idSuffix}`}>
      <div className="flex flex-wrap items-start gap-3 border-b border-zinc-200 px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 id={`design-${idSuffix}`} className="text-sm font-semibold text-zinc-900">
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
        <fieldset disabled={!canEdit} className="min-w-0 space-y-3">
          <legend className="sr-only">{title} settings, from the top of the email to the bottom</legend>

          <div className="rounded-md border border-zinc-200 px-3 py-2.5">
            {textSetting({
              field: "subjectTemplate",
              label: "Subject",
              placeholder: "Each email’s own subject",
              hint:
                kind === "requester" ? (
                  <>
                    Empty = each email’s own (responses: Re: “{"{form_name}"}” submission received). Use{" "}
                    <code className="font-mono">{"{email_subject}"}</code> to keep it inside yours. A conversation keeps the
                    subject of its first response, so the submitter’s replies stay together.
                  </>
                ) : (
                  <>
                    Empty = each email’s own. Use <code className="font-mono">{"{email_subject}"}</code> to keep it, for
                    example “[Creative] {"{email_subject}"}”.
                  </>
                ),
            })}
          </div>

          {block("showLogo", "Logo", {
            children: (
            <div>
              <div className="flex items-center justify-between gap-2">
                <span className={LABEL}>Image</span>
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
                      id={logoId}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void uploadLogo(file);
                      }}
                    />
                    <label
                      htmlFor={logoId}
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
              <p className={HINT}>PNG, JPEG, WebP, or GIF up to 2 MB, shown 32 px tall.</p>
            </div>
            ),
          })}

          {block("showHeader", "Header label", {
            children: textSetting({ field: "headerText", label: "Text", hint: "Small colored text at the top, under the logo." }),
          })}

          {block("showHeading", "Heading", {
            children: textSetting({
              field: "headingText",
              label: "Text",
              placeholder: "Each email’s own heading",
              hint: (
                <>
                  Empty = each email’s own (a response says “Update on your request”). Use{" "}
                  <code className="font-mono">{"{email_heading}"}</code> to keep it inside yours.
                </>
              ),
            }),
          })}

          {block("showIntro", "Intro", {
            children: textSetting({ field: "introMessage", label: "Text", multiline: true, hint: "A paragraph above the message." }),
          })}

          {block("showBody", "Message", {
            note:
              kind === "requester"
                ? "The comment you send, the form’s confirmation message, or the rule’s text. A response to a submitter always includes it."
                : "The comment, the notification’s detail, or the invite’s text.",
          })}

          {block("showDetails", "Details", {
            note:
              kind === "requester"
                ? "The From and Request lines, and a confirmation’s answers."
                : "The Task and Project lines, and other label / value lines.",
          })}

          {block("showButton", "Button", {
            children: (
              <>
                {textSetting({
                  field: "buttonLabel",
                  label: "Label",
                  hint:
                    kind === "internal"
                      ? "Leave empty to keep each email’s own label (“Open task”, “Open Inbox”, …)."
                      : "Requester emails have no button unless you name one; it links to the request’s form.",
                })}
                {colorSetting("buttonColor", "Color")}
              </>
            ),
          })}

          {block("showNotice", "Small print", {
            note: "The reply line and “Turn off” links always stay, so replies and unsubscribing keep working.",
            children: textSetting({
              field: "noticeText",
              label: "Text",
              multiline: true,
              placeholder: "Each email’s own small print",
              hint: "Empty = each email’s own (how to reply, why they got it).",
            }),
          })}

          {block("showFooter", "Sign-off", { children: textSetting({ field: "footerText", label: "Text", multiline: true }) })}

          <div className="rounded-md border border-zinc-200 px-3 py-2.5">{colorSetting("accentColor", "Accent color")}</div>

          <div>
            <p className={LABEL}>Fill-in fields</p>
            <p className="mt-0.5 text-xs text-zinc-500">
              Click one to add it where your cursor is. Fields an email doesn’t have are left blank.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {[...ownTokens, ...fillInFieldsFor(kind)].map((f) => {
                const label = f in OWN_TEXT_LABELS ? OWN_TEXT_LABELS[f as OwnTextField] : FILL_IN_LABELS[f as keyof typeof FILL_IN_LABELS];
                return (
                  <button
                    key={f}
                    type="button"
                    className="chip cursor-pointer font-mono hover:bg-zinc-200"
                    data-tooltip={label}
                    aria-label={`Insert ${label}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insertFillIn(f)}
                  >
                    {`{${f}}`}
                  </button>
                );
              })}
            </div>
          </div>
          {problem ? (
            <p role="alert" className="text-sm text-red-700">
              {problem}
            </p>
          ) : null}
        </fieldset>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className={LABEL}>Preview</p>
            <Segmented
              label="Preview as"
              options={DESIGN_SAMPLES[kind].map((x) => ({ value: x.key, label: x.label }))}
              value={sample}
              onChange={setSample}
            />
          </div>
          <div className="mt-1.5 overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50">
            <div className="border-b border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-600">
              <span className="text-zinc-400">Subject: </span>
              {preview?.subject ?? "…"}
            </div>
            {preview ? (
              <iframe title={`${title} preview`} sandbox="" srcDoc={preview.html} className="block h-[34rem] w-full bg-[#f4f4f5]" />
            ) : (
              <div className="flex h-[34rem] items-center justify-center text-sm text-zinc-500">
                {previewError ?? "Rendering preview…"}
              </div>
            )}
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            Rendered the way the email is sent, with sample content; real emails fill in their own details.
          </p>
        </div>
      </div>
    </section>
  );
}
