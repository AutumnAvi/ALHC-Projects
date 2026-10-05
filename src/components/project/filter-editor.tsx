"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { displayName } from "@/components/avatar";
import { formatDueDate } from "@/lib/dates";
import type { Profile, Section } from "@/lib/data";
import type { FieldDef } from "@/lib/fields";
import {
  DUE_KINDS,
  completionOf,
  type Completion,
  type DueFilter,
  type DueKind,
  type FieldFilter,
  type FieldOp,
  type ViewFilters,
} from "@/lib/views";

export type FilterContext = {
  sections: Pick<Section, "id" | "name">[];
  profiles: Profile[];
  fields: FieldDef[];
};

const selectClass =
  "w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm focus:border-accent-500 focus:outline-none";
const inputClass = selectClass;

// ---------------------------------------------------------------------------------------------
// Chips: one removable chip per active filter
// ---------------------------------------------------------------------------------------------

type Chip = { key: string; label: string; remove: () => ViewFilters };

function without<K extends keyof ViewFilters>(filters: ViewFilters, ...keys: K[]): ViewFilters {
  const next = { ...filters };
  for (const key of keys) delete next[key];
  return next;
}

function personLabel(id: string | null, profiles: Map<string, Profile>) {
  if (id === null) return "Unassigned";
  if (id === "me") return "Me";
  const p = profiles.get(id);
  return p ? displayName(p) : "Former member";
}

export function dueLabel(due: DueFilter) {
  switch (due.kind) {
    case "upcoming":
      return `Due in the next ${due.days ?? 7} days`;
    case "range":
      if (due.from && due.to) return `Due ${formatDueDate(due.from)} – ${formatDueDate(due.to)}`;
      return due.from ? `Due on or after ${formatDueDate(due.from)}` : `Due on or before ${formatDueDate(due.to!)}`;
    default:
      return DUE_KINDS.find((k) => k.value === due.kind)?.label ?? "Due";
  }
}

function fieldFilterLabel(filter: FieldFilter, field: FieldDef, context: FilterContext, profiles: Map<string, Profile>) {
  if (filter.op === "empty") return `${field.name} is empty`;
  if (filter.op === "not_empty") return `${field.name} is set`;
  if (filter.op === "equals") {
    if (field.fieldType === "boolean") return `${field.name}: ${filter.value === false ? "unchecked" : "checked"}`;
    return `${field.name} = ${String(filter.value)}`;
  }
  const names = (filter.values ?? []).map((v) => {
    if (field.boundToSections) return context.sections.find((s) => s.id === v)?.name ?? "Deleted section";
    if (field.fieldType === "people") return personLabel(v, profiles);
    return field.options.find((o) => o.id === v)?.name ?? "Deleted option";
  });
  return `${field.name}: ${names.join(", ")}`;
}

export function filterChips(filters: ViewFilters, context: FilterContext): Chip[] {
  const profiles = new Map(context.profiles.map((p) => [p.id, p]));
  const chips: Chip[] = [];
  const completion = completionOf(filters);
  if (completion !== "incomplete") {
    chips.push({
      key: "completion",
      label:
        completion === "all"
          ? "Incomplete and completed"
          : filters.completed_within_days
            ? `Completed in the last ${filters.completed_within_days} days`
            : "Completed",
      remove: () => without(filters, "completion", "completed_within_days"),
    });
  }
  if (filters.due) chips.push({ key: "due", label: dueLabel(filters.due), remove: () => without(filters, "due") });
  if (filters.sections?.length) {
    const names = filters.sections.map((id) =>
      id === null ? "No section" : (context.sections.find((s) => s.id === id)?.name ?? "Deleted section"),
    );
    chips.push({ key: "sections", label: `Section: ${names.join(", ")}`, remove: () => without(filters, "sections") });
  }
  if (filters.assignees?.length) {
    chips.push({
      key: "assignees",
      label: `Assignee: ${filters.assignees.map((id) => personLabel(id, profiles)).join(", ")}`,
      remove: () => without(filters, "assignees"),
    });
  }
  filters.fields?.forEach((filter, index) => {
    const field = context.fields.find((f) => f.id === filter.field_id);
    if (!field) return;
    chips.push({
      key: `field-${index}`,
      label: fieldFilterLabel(filter, field, context, profiles),
      remove: () => {
        const fields = filters.fields!.filter((_, i) => i !== index);
        return fields.length ? { ...filters, fields } : without(filters, "fields");
      },
    });
  });
  if (filters.text) chips.push({ key: "text", label: `Contains “${filters.text}”`, remove: () => without(filters, "text") });
  return chips;
}

export function FilterChips({
  filters,
  context,
  onChange,
}: {
  filters: ViewFilters;
  context: FilterContext;
  onChange?: (filters: ViewFilters) => void;
}) {
  const chips = filterChips(filters, context);
  if (chips.length === 0) return null;
  return (
    <ul className="flex flex-wrap items-center gap-1.5" aria-label="Active filters">
      {chips.map((chip) => (
        <li
          key={chip.key}
          className="inline-flex max-w-full items-center gap-1 rounded-full border border-zinc-200 bg-zinc-50 py-0.5 pr-1 pl-2.5 text-xs text-zinc-700"
        >
          <span className="truncate">{chip.label}</span>
          {onChange ? (
            <button
              type="button"
              onClick={() => onChange(chip.remove())}
              aria-label={`Remove filter ${chip.label}`}
              className="rounded-full p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-800"
            >
              <X className="size-3" />
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------------------------

function toggleIn<T>(list: T[] | undefined, value: T): T[] {
  const current = list ?? [];
  return current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
}

function setList<K extends "sections" | "assignees">(filters: ViewFilters, key: K, list: (string | null)[]): ViewFilters {
  return list.length ? { ...filters, [key]: list } : without(filters, key);
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="border-t border-zinc-100 pt-3 first:border-t-0 first:pt-0">
      <legend className="mb-1.5 text-xs font-medium text-zinc-500">{title}</legend>
      {children}
    </fieldset>
  );
}

function Check({ checked, onChange, children }: { checked: boolean; onChange: () => void; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2 rounded px-1 py-0.5 text-sm text-zinc-800 hover:bg-zinc-50">
      <input type="checkbox" checked={checked} onChange={onChange} className="size-3.5 accent-zinc-900" />
      <span className="truncate">{children}</span>
    </label>
  );
}

// Commits on blur / Enter so typing doesn't re-run the view on every keystroke.
function LazyInput({
  value,
  onCommit,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    setDraft(value);
  }
  return (
    <input
      {...props}
      value={draft}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (draft !== value) onCommit(draft);
        }
      }}
      className={inputClass}
    />
  );
}

export function FilterEditor({
  filters,
  onChange,
  context,
  idPrefix,
  showText = false,
}: {
  filters: ViewFilters;
  onChange: (filters: ViewFilters) => void;
  context: FilterContext;
  idPrefix: string;
  showText?: boolean;
}) {
  const completion = completionOf(filters);

  function setCompletion(value: Completion) {
    const next = without(filters, "completion", "completed_within_days");
    onChange(value === "incomplete" ? next : { ...next, completion: value });
  }

  function setDueKind(kind: DueKind | "") {
    if (!kind) return onChange(without(filters, "due"));
    if (kind === "range") {
      const today = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const from = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-01`;
      return onChange({ ...filters, due: { kind, from } });
    }
    onChange({ ...filters, due: { kind } });
  }

  const usedFields = new Set(filters.fields?.map((f) => f.field_id));
  const addableFields = context.fields.filter((f) => !usedFields.has(f.id));

  function setFieldFilter(index: number, filter: FieldFilter | null) {
    const fields = [...(filters.fields ?? [])];
    if (filter) fields[index] = filter;
    else fields.splice(index, 1);
    onChange(fields.length ? { ...filters, fields } : without(filters, "fields"));
  }

  return (
    <div className="space-y-3">
      <Group title="Completion">
        <label htmlFor={`${idPrefix}-completion`} className="sr-only">
          Completion
        </label>
        <select
          id={`${idPrefix}-completion`}
          value={completion}
          onChange={(e) => setCompletion(e.currentTarget.value as Completion)}
          className={selectClass}
        >
          <option value="incomplete">Incomplete tasks</option>
          <option value="completed">Completed tasks</option>
          <option value="all">All tasks</option>
        </select>
        {completion === "completed" ? (
          <label className="mt-2 flex items-center gap-2 text-sm text-zinc-700">
            <span className="shrink-0">Completed in the last</span>
            <LazyInput
              type="number"
              min={1}
              max={3650}
              placeholder="any"
              aria-label="Completed in the last N days"
              value={filters.completed_within_days ? String(filters.completed_within_days) : ""}
              onCommit={(value) => {
                const days = Number.parseInt(value, 10);
                const next = without(filters, "completed_within_days");
                onChange(Number.isInteger(days) && days >= 1 && days <= 3650 ? { ...next, completed_within_days: days } : next);
              }}
            />
            <span className="shrink-0">days</span>
          </label>
        ) : null}
      </Group>

      <Group title="Due date">
        <label htmlFor={`${idPrefix}-due`} className="sr-only">
          Due date
        </label>
        <select
          id={`${idPrefix}-due`}
          value={filters.due?.kind ?? ""}
          onChange={(e) => setDueKind(e.currentTarget.value as DueKind | "")}
          className={selectClass}
        >
          <option value="">Any due date</option>
          {DUE_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        {filters.due?.kind === "upcoming" ? (
          <label className="mt-2 flex items-center gap-2 text-sm text-zinc-700">
            <span className="shrink-0">Next</span>
            <LazyInput
              type="number"
              min={1}
              max={365}
              aria-label="Upcoming days"
              value={String(filters.due.days ?? 7)}
              onCommit={(value) => {
                const days = Number.parseInt(value, 10);
                onChange({
                  ...filters,
                  due: Number.isInteger(days) && days >= 1 && days <= 365 && days !== 7 ? { kind: "upcoming", days } : { kind: "upcoming" },
                });
              }}
            />
            <span className="shrink-0">days</span>
          </label>
        ) : null}
        {filters.due?.kind === "range" ? (
          <div className="mt-2 grid grid-cols-2 gap-2">
            {(["from", "to"] as const).map((end) => (
              <label key={end} className="flex flex-col gap-1 text-xs text-zinc-500">
                {end === "from" ? "From" : "To"}
                <input
                  type="date"
                  value={filters.due?.[end] ?? ""}
                  onChange={(e) => {
                    const due: DueFilter = { ...filters.due!, [end]: e.currentTarget.value || undefined };
                    if (!due[end]) delete due[end];
                    onChange(due.from || due.to ? { ...filters, due } : without(filters, "due"));
                  }}
                  className={inputClass}
                />
              </label>
            ))}
          </div>
        ) : null}
      </Group>

      <Group title="Section">
        <div className="max-h-36 overflow-y-auto">
          <Check
            checked={filters.sections?.includes(null) ?? false}
            onChange={() => onChange(setList(filters, "sections", toggleIn(filters.sections, null)))}
          >
            No section
          </Check>
          {context.sections.map((s) => (
            <Check
              key={s.id}
              checked={filters.sections?.includes(s.id) ?? false}
              onChange={() => onChange(setList(filters, "sections", toggleIn(filters.sections, s.id)))}
            >
              {s.name}
            </Check>
          ))}
        </div>
      </Group>

      <Group title="Assignee">
        <div className="max-h-36 overflow-y-auto">
          {[{ id: "me" as string | null, name: "Me" }, { id: null, name: "Unassigned" }, ...context.profiles.map((p) => ({ id: p.id as string | null, name: displayName(p) }))].map(
            (option) => (
              <Check
                key={option.id ?? "none"}
                checked={filters.assignees?.includes(option.id) ?? false}
                onChange={() => onChange(setList(filters, "assignees", toggleIn(filters.assignees, option.id)))}
              >
                {option.name}
              </Check>
            ),
          )}
        </div>
      </Group>

      {context.fields.length > 0 ? (
        <Group title="Fields">
          <div className="space-y-2">
            {filters.fields?.map((filter, index) => {
              const field = context.fields.find((f) => f.id === filter.field_id);
              return field ? (
                <FieldFilterRow
                  key={filter.field_id}
                  field={field}
                  filter={filter}
                  context={context}
                  idPrefix={`${idPrefix}-field-${index}`}
                  onChange={(next) => setFieldFilter(index, next)}
                />
              ) : null;
            })}
            {addableFields.length > 0 && (filters.fields?.length ?? 0) < 20 ? (
              <label className="flex items-center gap-2">
                <Plus className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
                <span className="sr-only">Add a field filter</span>
                <select
                  value=""
                  onChange={(e) => {
                    const field = context.fields.find((f) => f.id === e.currentTarget.value);
                    if (field) onChange({ ...filters, fields: [...(filters.fields ?? []), initialFieldFilter(field, context)] });
                  }}
                  className={selectClass}
                >
                  <option value="">Add a field filter…</option>
                  {addableFields.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        </Group>
      ) : null}

      {showText ? (
        <Group title="Text">
          <LazyInput
            aria-label="Title or description contains"
            placeholder="Title or description contains…"
            maxLength={200}
            value={filters.text ?? ""}
            onCommit={(value) => onChange(value.trim() ? { ...filters, text: value.trim() } : without(filters, "text"))}
          />
        </Group>
      ) : null}
    </div>
  );
}

function choicesFor(field: FieldDef, context: FilterContext): { id: string; name: string }[] | null {
  if (field.boundToSections) return context.sections.map((s) => ({ id: s.id, name: s.name }));
  if (field.fieldType === "single_select" || field.fieldType === "multi_select") return field.options;
  if (field.fieldType === "people") return context.profiles.map((p) => ({ id: p.id, name: displayName(p) }));
  return null;
}

function initialFieldFilter(field: FieldDef, context: FilterContext): FieldFilter {
  const choices = choicesFor(field, context);
  if (choices?.length) return { field_id: field.id, op: "in", values: [choices[0].id] };
  if (field.fieldType === "boolean") return { field_id: field.id, op: "equals", value: true };
  return { field_id: field.id, op: "not_empty" };
}

function FieldFilterRow({
  field,
  filter,
  context,
  idPrefix,
  onChange,
}: {
  field: FieldDef;
  filter: FieldFilter;
  context: FilterContext;
  idPrefix: string;
  onChange: (filter: FieldFilter | null) => void;
}) {
  const choices = choicesFor(field, context);
  const ops: { value: FieldOp; label: string }[] = choices
    ? [
        { value: "in", label: "is any of" },
        { value: "empty", label: "is empty" },
        { value: "not_empty", label: "is set" },
      ]
    : field.fieldType === "boolean"
      ? [{ value: "equals", label: "is" }]
      : [
          { value: "equals", label: "is" },
          { value: "empty", label: "is empty" },
          { value: "not_empty", label: "is set" },
        ];

  function setOp(op: FieldOp) {
    if (op === "in") onChange(choices?.length ? { field_id: field.id, op, values: [choices[0].id] } : null);
    else if (op === "equals") onChange({ field_id: field.id, op, value: field.fieldType === "number" ? 0 : field.fieldType === "boolean" ? true : "" });
    else onChange({ field_id: field.id, op });
  }

  return (
    <div className="rounded-md border border-zinc-200 p-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-800">{field.name}</span>
        <label htmlFor={`${idPrefix}-op`} className="sr-only">
          {field.name} condition
        </label>
        <select
          id={`${idPrefix}-op`}
          value={filter.op}
          onChange={(e) => setOp(e.currentTarget.value as FieldOp)}
          className="rounded-md border border-zinc-200 bg-white px-1.5 py-0.5 text-xs focus:border-accent-500 focus:outline-none"
        >
          {ops.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => onChange(null)}
          aria-label={`Remove ${field.name} filter`}
          className="rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {filter.op === "in" && choices ? (
        <div className="mt-1.5 max-h-32 overflow-y-auto">
          {choices.map((choice) => (
            <Check
              key={choice.id}
              checked={filter.values?.includes(choice.id) ?? false}
              onChange={() => {
                const values = toggleIn(filter.values, choice.id);
                onChange(values.length ? { ...filter, values } : null);
              }}
            >
              {choice.name}
            </Check>
          ))}
        </div>
      ) : null}
      {filter.op === "equals" && field.fieldType === "boolean" ? (
        <select
          aria-label={`${field.name} value`}
          value={filter.value === false ? "false" : "true"}
          onChange={(e) => onChange({ ...filter, value: e.currentTarget.value === "true" })}
          className={`mt-1.5 ${selectClass}`}
        >
          <option value="true">Checked</option>
          <option value="false">Unchecked</option>
        </select>
      ) : null}
      {filter.op === "equals" && field.fieldType !== "boolean" ? (
        <div className="mt-1.5">
          <LazyInput
            type={field.fieldType === "number" ? "number" : field.fieldType === "date" ? "date" : "text"}
            aria-label={`${field.name} value`}
            value={filter.value === undefined ? "" : String(filter.value)}
            onCommit={(value) => {
              if (field.fieldType === "number") {
                const n = Number(value);
                if (value.trim() && Number.isFinite(n)) onChange({ ...filter, value: n });
              } else {
                onChange({ ...filter, value });
              }
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
