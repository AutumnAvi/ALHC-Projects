"use client";

import { Braces } from "lucide-react";
import { useMemo, useRef, type KeyboardEvent } from "react";
import { NotAParam, useParamSlot } from "@/components/param-slot";
import { SmartPicker, type SmartOption } from "@/components/smart-picker";
import {
  PLACEHOLDERS,
  fieldPlaceholder,
  formAnswerPlaceholder,
  renderPlaceholders,
  samplePlaceholderValues,
  unknownPlaceholders,
} from "@/lib/rule-placeholders";
import { MISSING_INPUT, inputClass, type RuleContext } from "./rule-shared";

const KNOWN = new Set(PLACEHOLDERS.map((p) => p.key));

// What the "{ }" picker lists: the fixed placeholders, this project's fields, and its forms' questions.
function placeholderOptions(ctx: RuleContext): SmartOption[] {
  return [
    ...PLACEHOLDERS.map((p) => ({
      value: `{{${p.key}}}`,
      label: p.label,
      group: p.group,
      description: `${p.description} · {{${p.key}}}`,
      keywords: [p.key, ...(p.keywords ?? [])],
    })),
    ...ctx.fields.map((f) => ({
        value: fieldPlaceholder(f.name),
        label: f.name,
        group: "Fields",
        description: `The task’s ${f.name} · ${fieldPlaceholder(f.name)}`,
        keywords: ["field", "custom"],
    })),
    ...ctx.forms.flatMap((form) =>
      (form.questions ?? []).map((q) => ({
        value: formAnswerPlaceholder(q.label),
        label: q.label,
        group: `Form: ${form.title}`,
        description: `The submitter’s answer · ${formAnswerPlaceholder(q.label)}`,
        keywords: ["form", "answer", "question", form.title],
      })),
    ),
  ].filter((option, i, all) => all.findIndex((o) => o.value === option.value) === i);
}

// A rule text box (comment, message, subject, name…) with an "Insert placeholder" picker that drops
// {{…}} at the cursor, and a live preview filled in with sample values. Unknown placeholders are
// called out (the database renders them empty).
export function PlaceholderInput({
  id,
  label,
  value,
  onChange,
  ctx,
  multiline = false,
  placeholder,
  maxLength,
  className = "",
  onKeyDown,
  preview = true,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  ctx: RuleContext;
  multiline?: boolean;
  placeholder?: string;
  maxLength?: number;
  className?: string;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  preview?: boolean;
}) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  // Where the cursor was when the box lost focus to the picker.
  const caret = useRef<{ start: number; end: number } | null>(null);
  const options = useMemo(() => placeholderOptions(ctx), [ctx]);
  const samples = useMemo(
    () =>
      samplePlaceholderValues({
        projectName: ctx.projectName,
        fields: ctx.fields.map((f) => ({ name: f.name, fieldType: f.fieldType, options: f.options })),
        questions: ctx.forms.flatMap((f) => f.questions ?? []),
      }),
    [ctx],
  );
  // Inside a rule step's ParamSlot: highlighted while the text is still missing (rule-params.ts).
  const slot = useParamSlot<string>(onChange);
  const missing = slot.missing && value.trim() === "";
  const hasTokens = /\{\{[^{}]+\}\}|\{[a-z_]+\}/.test(value);
  const unknown = hasTokens ? unknownPlaceholders(value, KNOWN) : [];

  function remember() {
    const el = ref.current;
    if (el) caret.current = { start: el.selectionStart ?? el.value.length, end: el.selectionEnd ?? el.value.length };
  }

  function insert(token: string) {
    const at = caret.current ?? { start: value.length, end: value.length };
    const next = value.slice(0, at.start) + token + value.slice(at.end);
    if (maxLength && next.length > maxLength) return;
    onChange(next);
    const cursor = at.start + token.length;
    caret.current = { start: cursor, end: cursor };
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(cursor, cursor);
    });
  }

  const common = {
    id,
    ref,
    "aria-label": label,
    placeholder: placeholder ?? label,
    value,
    maxLength,
    onBlur: remember,
    onSelect: remember,
    "aria-invalid": missing || undefined,
    className: `${inputClass} min-w-0 flex-1 ${multiline ? "py-1.5" : ""} ${missing ? MISSING_INPUT : ""}`,
  };

  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <div className="flex min-w-0 items-start gap-1">
        {multiline ? (
          <textarea {...common} rows={2} onChange={(e) => onChange(e.currentTarget.value)} />
        ) : (
          <input {...common} onKeyDown={onKeyDown} onChange={(e) => onChange(e.currentTarget.value)} />
        )}
        <NotAParam>
        <SmartPicker
          label={`Insert a placeholder into ${label.toLowerCase()}`}
          value={null}
          options={options}
          onChange={insert}
          variant="ghost"
          searchable
          panelWidth={340}
          className="h-7 px-1.5"
          renderValue={() => (
            <span data-tooltip="Insert placeholder" className="inline-flex items-center">
              <Braces className="size-4" aria-hidden />
            </span>
          )}
        />
        </NotAParam>
      </div>
      {preview && hasTokens ? (
        <p className="text-xs text-zinc-500">
          <span className="font-medium text-zinc-600">Preview:</span> {renderPlaceholders(value, samples) || <em>(empty)</em>}
        </p>
      ) : null}
      {unknown.length ? (
        <p className="text-xs text-amber-800">
          Not a placeholder: {unknown.map((u) => `{{${u}}}`).join(", ")} (it will be left empty).
        </p>
      ) : null}
    </div>
  );
}
