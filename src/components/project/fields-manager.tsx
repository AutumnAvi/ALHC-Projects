"use client";

import { useState } from "react";
import { Columns3, Plus, Trash2, X } from "lucide-react";
import { useServerAction } from "@/components/toast";
import { createField, deleteField, updateField } from "@/lib/actions";
import {
  FIELD_TYPES,
  OPTION_COLORS,
  OPTION_COLOR_CLASSES,
  fieldTypeLabel,
  type FieldDef,
  type FieldOption,
  type OptionColor,
} from "@/lib/fields";

const inputClass =
  "rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm focus:border-zinc-400 focus:outline-none";

export function FieldsManager({
  projectId,
  fields,
  sectionNames,
}: {
  projectId: string;
  fields: FieldDef[];
  sectionNames: string[];
}) {
  const [pending, run] = useServerAction();
  const [name, setName] = useState("");
  const [fieldType, setFieldType] = useState<string>("single_select");
  const hasBound = fields.some((f) => f.boundToSections);

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <p className="text-sm text-zinc-600">
        Fields add structured data to every task in this project. Pinned fields show as list columns
        and as chips on board cards.
      </p>

      {fields.length === 0 ? (
        <p className="mt-6 rounded-md border border-dashed border-zinc-300 px-4 py-6 text-center text-sm text-zinc-500">
          No fields yet.
        </p>
      ) : (
        <ul className="mt-6 space-y-3" aria-label="Fields">
          {fields.map((field) => (
            <FieldRow
              key={field.id}
              field={field}
              sectionNames={sectionNames}
              run={run}
            />
          ))}
        </ul>
      )}

      <form
        className="mt-6 flex flex-wrap items-end gap-2 rounded-lg border border-zinc-200 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = name.trim();
          if (!trimmed) return;
          run(async () => {
            const result = await createField(projectId, { name: trimmed, fieldType });
            if (!result.error) setName("");
            return result;
          });
        }}
      >
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs font-medium text-zinc-600">
          New field name
          <input
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            maxLength={100}
            placeholder="e.g. Priority"
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600">
          Type
          <select
            value={fieldType}
            onChange={(e) => setFieldType(e.currentTarget.value)}
            className={inputClass}
          >
            {FIELD_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={pending || !name.trim()}
          className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          <Plus className="size-4" />
          Add field
        </button>
      </form>

      {!hasBound ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 px-4 py-3">
          <p className="text-sm text-zinc-600">
            <span className="font-medium text-zinc-900">Status from sections.</span> A single-select
            whose options are this project’s sections. Changing it moves the task.
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              run(() =>
                createField(projectId, {
                  name: "Status",
                  fieldType: "single_select",
                  boundToSections: true,
                }),
              )
            }
            className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            Add Status field
          </button>
        </div>
      ) : null}
    </div>
  );
}

function FieldRow({
  field,
  sectionNames,
  run,
}: {
  field: FieldDef;
  sectionNames: string[];
  run: ReturnType<typeof useServerAction>[1];
}) {
  const hasOptions =
    !field.boundToSections && (field.fieldType === "single_select" || field.fieldType === "multi_select");

  function saveOptions(options: FieldOption[]) {
    run(() => updateField(field.id, { options }));
  }

  return (
    <li className="rounded-lg border border-zinc-200 p-4" data-field={field.name}>
      <div className="flex flex-wrap items-center gap-3">
        <label className="sr-only" htmlFor={`field-name-${field.id}`}>
          Field name
        </label>
        <input
          id={`field-name-${field.id}`}
          key={field.name}
          defaultValue={field.name}
          maxLength={100}
          onBlur={(e) => {
            const value = e.currentTarget.value.trim();
            if (value && value !== field.name) run(() => updateField(field.id, { name: value }));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          className="-mx-1.5 min-w-0 flex-1 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium hover:border-zinc-200 focus:border-zinc-300 focus:outline-none"
        />
        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600">
          {fieldTypeLabel(field)}
        </span>
        <label className="inline-flex items-center gap-1.5 text-xs text-zinc-600">
          <input
            type="checkbox"
            checked={field.showInViews}
            onChange={(e) => {
              const showInViews = e.currentTarget.checked;
              run(() => updateField(field.id, { showInViews }));
            }}
            className="size-3.5 accent-zinc-900"
          />
          <Columns3 className="size-3.5" aria-hidden />
          Show in list and board
        </label>
        <button
          type="button"
          aria-label={`Delete field ${field.name}`}
          onClick={() => {
            if (window.confirm(`Delete the “${field.name}” field? Existing values are kept in the database.`)) {
              run(() => deleteField(field.id));
            }
          }}
          className="rounded p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600"
        >
          <Trash2 className="size-4" />
        </button>
      </div>

      {field.boundToSections ? (
        <p className="mt-2 text-xs text-zinc-500">
          Options mirror sections:{" "}
          {sectionNames.length ? sectionNames.join(", ") : "this project has no sections yet"}.
        </p>
      ) : null}

      {hasOptions ? (
        <OptionsEditor options={field.options} onChange={saveOptions} fieldName={field.name} />
      ) : null}
    </li>
  );
}

function OptionsEditor({
  options,
  onChange,
  fieldName,
}: {
  options: FieldOption[];
  onChange: (options: FieldOption[]) => void;
  fieldName: string;
}) {
  const [draft, setDraft] = useState("");

  function patch(optionId: string, change: Partial<FieldOption>) {
    onChange(options.map((o) => (o.id === optionId ? { ...o, ...change } : o)));
  }

  return (
    <div className="mt-3 space-y-1.5">
      {options.map((option) => (
        <div key={option.id} className="flex items-center gap-2">
          <select
            aria-label={`Color for ${option.name}`}
            value={option.color}
            onChange={(e) => patch(option.id, { color: e.currentTarget.value as OptionColor })}
            className={`rounded px-1.5 py-0.5 text-xs ${OPTION_COLOR_CLASSES[option.color]}`}
          >
            {OPTION_COLORS.map((color) => (
              <option key={color} value={color}>
                {color}
              </option>
            ))}
          </select>
          <input
            aria-label={`Option name ${option.name}`}
            key={option.name}
            defaultValue={option.name}
            maxLength={100}
            onBlur={(e) => {
              const value = e.currentTarget.value.trim();
              if (value && value !== option.name) patch(option.id, { name: value });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            className="min-w-0 flex-1 rounded-md border border-transparent px-1.5 py-0.5 text-sm hover:border-zinc-200 focus:border-zinc-300 focus:outline-none"
          />
          <button
            type="button"
            aria-label={`Remove option ${option.name}`}
            onClick={() => onChange(options.filter((o) => o.id !== option.id))}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const value = draft.trim();
          if (!value) return;
          const color = OPTION_COLORS[(options.length + 1) % OPTION_COLORS.length];
          onChange([...options, { id: crypto.randomUUID(), name: value, color }]);
          setDraft("");
        }}
      >
        <input
          aria-label={`New option for ${fieldName}`}
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          maxLength={100}
          placeholder="Add an option"
          className={`${inputClass} flex-1`}
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          className="rounded-md px-2 py-1 text-sm text-zinc-600 hover:bg-zinc-100 disabled:opacity-50"
        >
          Add
        </button>
      </form>
    </div>
  );
}
