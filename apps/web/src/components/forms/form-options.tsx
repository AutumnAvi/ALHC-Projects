"use client";

// A choice question's answers in the form editor (batch 43, item 7: moved out of form-editor.tsx and given
// reordering and pasting). Answers reorder by their handle or Alt+↑ / Alt+↓ in their box; pasting several
// lines into a box adds one answer per line. Removing or replacing answers goes through the editor's
// onChange, which says (with Undo) when a branch or path loses answers because of it.

import { useMemo, useState, type DragEvent } from "react";
import { GripVertical, Plus, X } from "lucide-react";
import { SmartPicker } from "@/components/smart-picker";
import type { FieldDef } from "@alhc/core/fields";
import type { FormQuestion, QuestionOption } from "@alhc/core/forms";

const LABEL = "block text-xs font-medium text-zinc-600";
const OPTION_DRAG = "application/x-alhc-form-option";
export const MAX_OPTIONS = 200;

// Lines of pasted text as answers: trimmed, blank lines and bullets dropped.
export function pastedAnswers(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, "").trim())
    .filter(Boolean)
    .map((line) => line.slice(0, 200));
}

// Moves one answer before another (null = the end); the same array when nothing moves.
export function moveOptionBefore(options: QuestionOption[], id: string, beforeId: string | null): QuestionOption[] {
  const from = options.findIndex((o) => o.id === id);
  if (from < 0 || beforeId === id || (options[from + 1]?.id ?? null) === beforeId) return options;
  const rest = options.filter((o) => o.id !== id);
  const at = beforeId === null ? rest.length : rest.findIndex((o) => o.id === beforeId);
  if (at < 0) return options;
  return [...rest.slice(0, at), options[from], ...rest.slice(at)];
}

export function OptionsEditor({
  question,
  sections,
  fields,
  newId,
  onChange,
  onAnnounce,
}: {
  question: FormQuestion;
  sections: { id: string; name: string }[];
  fields: FieldDef[];
  newId: () => string;
  onChange: (next: FormQuestion) => void;
  // Screen readers hear where a moved answer went.
  onAnnounce: (message: string) => void;
}) {
  const options = question.options ?? [];
  const prefix = `fq-${question.id}-opt`;
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropBefore, setDropBefore] = useState<string | null | undefined>(undefined);
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

  const focusOption = (id: string, select = false) =>
    requestAnimationFrame(() => {
      const input = document.getElementById(`${prefix}-${id}`);
      if (input instanceof HTMLInputElement) {
        input.focus();
        if (select) input.select();
      }
    });

  function move(id: string, beforeId: string | null) {
    const next = moveOptionBefore(options, id, beforeId);
    if (next === options) return;
    set(next);
    const at = next.findIndex((o) => o.id === id);
    onAnnounce(`Moved “${next[at].label || "the answer"}” to position ${at + 1} of ${next.length}`);
  }

  function add(after: number, labels: string[]) {
    const room = MAX_OPTIONS - options.length;
    const added = labels.slice(0, room).map((label) => ({ id: newId(), label }));
    if (!added.length) return null;
    set([...options.slice(0, after + 1), ...added, ...options.slice(after + 1)]);
    return added;
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const id = e.dataTransfer.getData(OPTION_DRAG);
    const before = dropBefore ?? null;
    setDragging(null);
    setDropBefore(undefined);
    if (id) move(id, before);
  };

  return (
    <fieldset>
      <legend className={LABEL}>Answers</legend>
      <ul
        className="mt-1 flex flex-col gap-1"
        onDragOver={(e) => {
          if (!dragging) return;
          e.preventDefault();
          e.stopPropagation();
        }}
        onDrop={dragging ? onDrop : undefined}
        onDragLeave={(e) => {
          if (dragging && !e.currentTarget.contains(e.relatedTarget as Node | null)) setDropBefore(undefined);
        }}
      >
        {options.map((option, i) => {
          const line = dragging && dragging !== option.id && dropBefore === option.id && options[i - 1]?.id !== dragging;
          return (
            <li
              key={option.id}
              className={`relative flex items-center gap-1.5 ${dragging === option.id ? "opacity-40" : ""}`}
              onDragOver={
                dragging
                  ? (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const rect = e.currentTarget.getBoundingClientRect();
                      const after = e.clientY > rect.top + rect.height / 2;
                      setDropBefore(after ? (options[i + 1]?.id ?? null) : option.id);
                    }
                  : undefined
              }
            >
              {line ? <span aria-hidden className="pointer-events-none absolute inset-x-5 -top-[3px] h-0.5 rounded-full bg-accent-500" /> : null}
              {options.length > 1 ? (
                <span
                  draggable
                  aria-hidden
                  onDragStart={(e) => {
                    e.dataTransfer.setData(OPTION_DRAG, option.id);
                    e.dataTransfer.effectAllowed = "move";
                    e.stopPropagation();
                    setDragging(option.id);
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setDropBefore(undefined);
                  }}
                  data-tooltip="Drag to reorder (or Alt+↑ / Alt+↓)"
                  className="flex w-4 shrink-0 cursor-grab items-center justify-center text-zinc-300 hover:text-zinc-500 active:cursor-grabbing"
                >
                  <GripVertical className="size-3.5" />
                </span>
              ) : (
                <span aria-hidden className="w-4 shrink-0" />
              )}
              <span aria-hidden className={`size-3 shrink-0 border border-zinc-300 ${question.type === "multi_select" ? "rounded-sm" : "rounded-full"}`} />
              <input
                id={`${prefix}-${option.id}`}
                aria-label={`Answer ${i + 1}`}
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                value={option.label}
                maxLength={200}
                onChange={(e) => {
                  const label = e.currentTarget.value;
                  set(options.map((o) => (o.id === option.id ? { ...o, label } : o)));
                }}
                onKeyDown={(e) => {
                  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
                    e.preventDefault();
                    e.stopPropagation();
                    const before = e.key === "ArrowUp" ? (options[i - 1]?.id ?? undefined) : (options[i + 2]?.id ?? null);
                    if (before === undefined || (e.key === "ArrowDown" && i === options.length - 1)) return;
                    move(option.id, before);
                    focusOption(option.id);
                    return;
                  }
                  // Enter adds the next answer right after this one.
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    const added = add(i, [`Option ${options.length + 1}`]);
                    if (added) focusOption(added[0].id, true);
                  }
                }}
                onPaste={(e) => {
                  const lines = pastedAnswers(e.clipboardData.getData("text"));
                  if (lines.length < 2) return;
                  e.preventDefault();
                  // An empty (or fully selected) box takes the first line; the rest become answers after it.
                  const box = e.currentTarget;
                  const replacing = !option.label.trim() || (box.selectionStart === 0 && box.selectionEnd === box.value.length);
                  const base = replacing ? options.map((o) => (o.id === option.id ? { ...o, label: lines[0] } : o)) : options;
                  const added = (replacing ? lines.slice(1) : lines)
                    .slice(0, MAX_OPTIONS - options.length)
                    .map((label) => ({ id: newId(), label }));
                  set([...base.slice(0, i + 1), ...added, ...base.slice(i + 1)]);
                  onAnnounce(`Added ${added.length + (replacing ? 1 : 0)} answers from the pasted list`);
                  focusOption(added.at(-1)?.id ?? option.id);
                }}
                className="field h-8 min-w-0 flex-1"
              />
              <button
                type="button"
                aria-label={`Remove answer ${option.label || i + 1}`}
                data-tooltip="Remove answer"
                disabled={options.length <= 1}
                onClick={() => set(options.filter((o) => o.id !== option.id))}
                className="btn-icon"
              >
                <X className="size-3.5" />
              </button>
            </li>
          );
        })}
        {dragging && dropBefore === null && options.at(-1)?.id !== dragging ? (
          <li aria-hidden className="pointer-events-none relative h-0">
            <span className="absolute inset-x-5 -top-[3px] h-0.5 rounded-full bg-accent-500" />
          </li>
        ) : null}
      </ul>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={options.length >= MAX_OPTIONS}
          onClick={() => {
            const added = add(options.length - 1, [`Option ${options.length + 1}`]);
            if (added) focusOption(added[0].id, true);
          }}
          className="btn-ghost h-7 text-xs"
        >
          <Plus className="size-3.5" aria-hidden />
          Add answer
        </button>
        {sources.length ? (
          <SmartPicker
            label="Copy answers from"
            placeholder="Copy answers from…"
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
      <p className="mt-1 text-2xs text-zinc-400">Paste a list to add one answer per line. Enter adds the next one.</p>
    </fieldset>
  );
}
