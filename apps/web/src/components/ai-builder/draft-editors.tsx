"use client";

// AI builder round 2 (note 168): what opens when a draft's task, field, or project name is clicked. The
// List and Board edit names, sections, order, assignees, dates, and values in place; these editors add
// what a row can't show (notes, subtasks, placeholders, a field's options, removing things). Every change
// goes through the draft's reducers (@alhc/core/ai-builder-draft) and shows its problem right there.
import { useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import {
  AI_BUILDER_LIMITS,
  AI_FIELD_TYPES,
  AI_FIELD_TYPE_LABELS,
  type AiFieldType,
} from "@alhc/core/ai-builder";
import {
  addDays,
  addField,
  addSubtask,
  dayOffset,
  deleteField,
  deleteSubtask,
  deleteTask,
  placeTask,
  renameSubtask,
  setTaskValue,
  updateField,
  updateTask,
  type AiDraft,
  type DraftEdit,
  type DraftPerson,
} from "@alhc/core/ai-builder-draft";
import type { Json } from "@alhc/core/supabase/database.types";
import { Dialog } from "@/components/dialog";
import { SmartPicker } from "@/components/smart-picker";
import { newDraftId } from "./draft-data-source";

type Change = (edit: (d: AiDraft) => DraftEdit) => string | null;

const NEW_PLACEHOLDER = "__new_placeholder__";

export function DraftTaskDialog({
  draft,
  taskId,
  today,
  members,
  change,
  onClose,
}: {
  draft: AiDraft;
  taskId: string;
  today: string;
  members: readonly DraftPerson[];
  change: Change;
  onClose: () => void;
}) {
  const task = draft.tasks.find((t) => t.id === taskId);
  const [error, setError] = useState<string | null>(null);
  const [placeholder, setPlaceholder] = useState<string | null>(null);
  const [newSubtask, setNewSubtask] = useState("");
  if (!task) return null;
  const apply = (edit: (d: AiDraft) => DraftEdit) => setError(change(edit));
  const placeholders = [...new Set(draft.tasks.flatMap((t) => (t.assignee && "placeholder" in t.assignee ? [t.assignee.placeholder] : [])))];
  const assigneeValue = !task.assignee ? "" : "member" in task.assignee ? `m:${task.assignee.member}` : `p:${task.assignee.placeholder}`;
  const dateOf = (days: number | null) => (days === null ? "" : addDays(today, days));
  const daysOf = (value: string) => (value ? dayOffset(today, value) : null);

  return (
    <Dialog title="Edit draft task" description="Nothing is created until you click Create project." onClose={onClose} width="max-w-xl">
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-zinc-700">Name</span>
          <input
            data-autofocus
            className="field w-full"
            defaultValue={task.title}
            maxLength={AI_BUILDER_LIMITS.taskTitleMax}
            onBlur={(e) => e.currentTarget.value !== task.title && apply((d) => updateTask(d, task.id, { title: e.currentTarget.value }))}
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <span className="mb-1 block text-xs font-medium text-zinc-700">Section</span>
            <SmartPicker
              label="Section"
              value={task.sectionId}
              onChange={(sectionId) => apply((d) => placeTask(d, task.id, sectionId, null))}
              options={draft.sections.map((s) => ({ value: s.id, label: s.name }))}
            />
          </div>
          <div>
            <span className="mb-1 block text-xs font-medium text-zinc-700">Assignee</span>
            {placeholder === null ? (
              <SmartPicker
                label="Assignee"
                value={assigneeValue}
                onChange={(value) => {
                  if (value === NEW_PLACEHOLDER) return setPlaceholder("");
                  const assignee = !value ? null : value.startsWith("m:") ? { member: value.slice(2) } : { placeholder: value.slice(2) };
                  apply((d) => updateTask(d, task.id, { assignee }));
                }}
                options={[
                  { value: "", label: "Nobody" },
                  ...members.map((m) => ({ value: `m:${m.id}`, label: m.name || m.email, description: "Testing data member" })),
                  ...placeholders.map((p) => ({ value: `p:${p}`, label: p, description: "Placeholder (becomes a project role)" })),
                  { value: NEW_PLACEHOLDER, label: "New placeholder…", description: "A role like “Designer”, filled in later" },
                ]}
              />
            ) : (
              <form
                className="flex gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = placeholder.trim();
                  const problem = change((d) => updateTask(d, task.id, { assignee: { placeholder: name } }));
                  setError(problem);
                  if (!problem) setPlaceholder(null);
                }}
              >
                <input
                  autoFocus
                  aria-label="Placeholder name"
                  className="control min-w-0 flex-1"
                  placeholder="Designer"
                  maxLength={AI_BUILDER_LIMITS.placeholderMax}
                  value={placeholder}
                  onChange={(e) => setPlaceholder(e.currentTarget.value)}
                />
                <button type="submit" className="btn-secondary h-7 px-2">
                  Set
                </button>
                <button type="button" className="btn-ghost h-7 px-2" onClick={() => setPlaceholder(null)}>
                  Cancel
                </button>
              </form>
            )}
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-zinc-700">Start date</span>
            <input
              type="date"
              className="control w-full"
              min={today}
              value={dateOf(task.startInDays)}
              onChange={(e) => apply((d) => updateTask(d, task.id, { startInDays: daysOf(e.currentTarget.value) }))}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-zinc-700">Due date</span>
            <input
              type="date"
              className="control w-full"
              min={today}
              value={dateOf(task.dueInDays)}
              onChange={(e) => apply((d) => updateTask(d, task.id, { dueInDays: daysOf(e.currentTarget.value) }))}
            />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-zinc-700">Notes</span>
          <textarea
            className="field h-auto w-full py-2"
            rows={3}
            defaultValue={task.notes}
            maxLength={AI_BUILDER_LIMITS.notesMax}
            onBlur={(e) => e.currentTarget.value !== task.notes && apply((d) => updateTask(d, task.id, { notes: e.currentTarget.value }))}
          />
        </label>
        {draft.fields.length ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {draft.fields.map((f) => {
              const value = task.values[f.id];
              const set = (v: Json) => apply((d) => setTaskValue(d, task.id, f.id, v));
              return (
                <div key={f.id}>
                  <span className="mb-1 block text-xs font-medium text-zinc-700">{f.name}</span>
                  {f.type === "single_select" || f.type === "multi_select" ? (
                    <SmartPicker
                      label={f.name}
                      multiple={f.type === "multi_select" ? true : undefined}
                      value={(f.type === "multi_select" ? (Array.isArray(value) ? value : []) : typeof value === "string" ? value : "") as never}
                      onChange={(v: string | string[]) => set(v)}
                      options={[...(f.type === "single_select" ? [{ value: "", label: "None" }] : []), ...f.options.map((o) => ({ value: o.id, label: o.name }))]}
                    />
                  ) : (
                    <input
                      type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
                      aria-label={f.name}
                      className="control w-full"
                      defaultValue={value === undefined ? "" : String(value)}
                      onBlur={(e) => {
                        const raw = e.currentTarget.value;
                        set(raw === "" ? null : f.type === "number" ? Number(raw) : raw);
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        ) : null}
        <div>
          <span className="mb-1 block text-xs font-medium text-zinc-700">
            Subtasks ({task.subtasks.length}/{AI_BUILDER_LIMITS.subtasksMax})
          </span>
          <ul className="space-y-1">
            {task.subtasks.map((s) => (
              <li key={s.id} className="flex items-center gap-1">
                <input
                  aria-label={`Subtask ${s.title}`}
                  className="control min-w-0 flex-1"
                  defaultValue={s.title}
                  onBlur={(e) => e.currentTarget.value !== s.title && apply((d) => renameSubtask(d, s.id, e.currentTarget.value))}
                />
                <button type="button" aria-label={`Remove subtask ${s.title}`} data-tooltip="Remove" className="btn-icon" onClick={() => apply((d) => deleteSubtask(d, s.id))}>
                  <X className="size-4" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
          {task.subtasks.length < AI_BUILDER_LIMITS.subtasksMax ? (
            <form
              className="mt-1 flex gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                const problem = change((d) => addSubtask(d, task.id, newSubtask, newDraftId));
                setError(problem);
                if (!problem) setNewSubtask("");
              }}
            >
              <input aria-label="New subtask" placeholder="Add a subtask" className="control min-w-0 flex-1" value={newSubtask} onChange={(e) => setNewSubtask(e.currentTarget.value)} />
              <button type="submit" className="btn-secondary h-7 px-2" disabled={!newSubtask.trim()}>
                <Plus className="size-4" aria-hidden />
                Add
              </button>
            </form>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        ) : null}
        <div className="flex items-center justify-between pt-1">
          <button
            type="button"
            className="btn-ghost h-8 px-2 text-red-700 hover:bg-red-50"
            onClick={() => {
              change((d) => deleteTask(d, task.id));
              onClose();
            }}
          >
            <Trash2 className="size-4" aria-hidden />
            Remove task
          </button>
          <button type="button" className="btn-primary h-8 px-3" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// A new field (fieldId null) or an existing one: name, type (new only), options for choice fields.
export function DraftFieldDialog({
  draft,
  fieldId,
  change,
  onClose,
}: {
  draft: AiDraft;
  fieldId: string | null;
  change: (edit: (d: AiDraft) => DraftEdit) => string | null;
  onClose: () => void;
}) {
  const field = fieldId ? draft.fields.find((f) => f.id === fieldId) : null;
  const [name, setName] = useState(field?.name ?? "");
  const [type, setType] = useState<AiFieldType>(field?.type ?? "single_select");
  const [options, setOptions] = useState<{ id?: string; name: string }[]>(field?.options ?? [{ name: "" }]);
  const [error, setError] = useState<string | null>(null);
  const choice = type === "single_select" || type === "multi_select";

  function save() {
    const opts = choice ? options.filter((o) => o.name.trim()) : [];
    const problem = field
      ? change((d) => updateField(d, field.id, { name, options: opts }, newDraftId))
      : change((d) => addField(d, { name, type, options: opts }, newDraftId));
    setError(problem);
    if (!problem) onClose();
  }

  return (
    <Dialog title={field ? "Edit draft field" : "Add a field to the draft"} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-zinc-700">Name</span>
          <input data-autofocus className="field w-full" value={name} maxLength={AI_BUILDER_LIMITS.fieldNameMax} onChange={(e) => setName(e.currentTarget.value)} />
        </label>
        <div>
          <span className="mb-1 block text-xs font-medium text-zinc-700">Type</span>
          {field ? (
            <span className="chip">{AI_FIELD_TYPE_LABELS[field.type]}</span>
          ) : (
            <SmartPicker
              label="Type"
              value={type}
              onChange={(v) => setType(v as AiFieldType)}
              options={AI_FIELD_TYPES.map((t) => ({ value: t, label: AI_FIELD_TYPE_LABELS[t] }))}
            />
          )}
        </div>
        {choice ? (
          <div>
            <span className="mb-1 block text-xs font-medium text-zinc-700">Options</span>
            <ul className="space-y-1">
              {options.map((o, i) => (
                <li key={o.id ?? `new-${i}`} className="flex items-center gap-1">
                  <input
                    aria-label={`Option ${i + 1}`}
                    className="control min-w-0 flex-1"
                    value={o.name}
                    maxLength={AI_BUILDER_LIMITS.optionNameMax}
                    onChange={(e) => {
                      const v = e.currentTarget.value;
                      setOptions((list) => list.map((x, j) => (j === i ? { ...x, name: v } : x)));
                    }}
                  />
                  <button
                    type="button"
                    aria-label={`Remove option ${o.name}`}
                    data-tooltip="Remove"
                    className="btn-icon"
                    disabled={options.length <= 1}
                    onClick={() => setOptions((list) => list.filter((_, j) => j !== i))}
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
            {options.length < AI_BUILDER_LIMITS.optionsMax ? (
              <button type="button" className="btn-ghost mt-1 h-7 px-2" onClick={() => setOptions((list) => [...list, { name: "" }])}>
                <Plus className="size-4" aria-hidden />
                Add an option
              </button>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        ) : null}
        <div className="flex items-center justify-between pt-1">
          {field ? (
            <button
              type="button"
              className="btn-ghost h-8 px-2 text-red-700 hover:bg-red-50"
              onClick={() => {
                change((d) => deleteField(d, field.id));
                onClose();
              }}
            >
              <Trash2 className="size-4" aria-hidden />
              Remove field
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button type="button" className="btn-secondary h-8 px-3" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary h-8 px-3">
              {field ? "Save" : "Add field"}
            </button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
