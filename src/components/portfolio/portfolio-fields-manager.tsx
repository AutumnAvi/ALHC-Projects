"use client";

import { ColorPicker } from "@/components/color-picker";
import { useConfirm } from "@/components/confirm";
import { useState } from "react";
import { ListPlus, Plus, Trash2, X } from "lucide-react";
import { EmptyState } from "@/components/ui";
import { SmartPicker } from "@/components/smart-picker";
import { useServerAction } from "@/components/toast";
import { createPortfolioField, deletePortfolioField, updatePortfolioField } from "@/lib/actions";
import type { PortfolioField } from "@/lib/data";
import {
  OPTION_COLORS,
  OPTION_COLOR_CLASSES,
  formatNumberValue,
  normalizeNumberPrefix,
  numberPrefixProblem,
  selectOptionsProblem,
  type FieldOption,
} from "@/lib/fields";
import { PORTFOLIO_FIELD_TYPES, isPortfolioFieldType, type PortfolioFieldType } from "@/lib/portfolios";

// Why the last option of a single-select can't be removed.
export const LAST_OPTION_NOTE = "A single-select field needs at least one option. Add another option first.";

const typeLabel = (type: PortfolioFieldType) => PORTFOLIO_FIELD_TYPES.find((t) => t.value === type)?.label ?? type;

// Portfolio custom fields: definitions here (Editor+), one value per project on the Overview cards, shown
// as Report columns. Values only ever show for projects the viewer can read.
export function PortfolioFieldsManager({
  portfolioId,
  fields,
  canEdit,
}: {
  portfolioId: string;
  fields: PortfolioField[];
  canEdit: boolean;
}) {
  const [pending, run] = useServerAction();
  const [name, setName] = useState("");
  const [fieldType, setFieldType] = useState<PortfolioFieldType>("text");
  // A new single-select starts with its options (item 47: at least one; a typed one counts).
  const [newOptions, setNewOptions] = useState<FieldOption[]>([]);
  const [optionName, setOptionName] = useState("");
  const optionsProblem = selectOptionsProblem({ fieldType, optionCount: newOptions.length, pendingOption: optionName });
  // Item 49: a number field's symbol ("$"), shown before its values.
  const [symbol, setSymbol] = useState("");
  const symbolProblem = fieldType === "number" ? numberPrefixProblem(symbol) : null;

  function addNewOption() {
    const label = optionName.trim();
    if (!label) return;
    setNewOptions((list) => [...list, { id: crypto.randomUUID(), name: label, color: OPTION_COLORS[list.length % OPTION_COLORS.length] }]);
    setOptionName("");
  }

  return (
    <div className="mx-auto max-w-3xl px-gutter pt-5">
      <section className="rounded-lg border border-zinc-200 p-5" aria-labelledby="portfolio-fields-heading">
        <h2 id="portfolio-fields-heading" className="text-sm font-semibold text-zinc-900">
          Fields
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          Track something per project, like budget, phase, or launch date. Editors set values on the Overview; they show
          as columns on the Report.
        </p>

        {fields.length === 0 ? (
          <EmptyState icon={ListPlus} title="No fields yet" size="inline">
            {canEdit ? "Add a field below to start tracking it for each project." : "Editors can add fields to this portfolio."}
          </EmptyState>
        ) : (
          <ul className="mt-4 divide-y divide-zinc-100 rounded-md border border-zinc-200">
            {fields.map((field) => (
              <FieldRow key={field.id} field={field} canEdit={canEdit} />
            ))}
          </ul>
        )}

        {canEdit ? (
          <form
            className="mt-4 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim() || optionsProblem || symbolProblem) return;
              const typed = optionName.trim();
              const options =
                fieldType !== "single_select"
                  ? []
                  : typed
                    ? [...newOptions, { id: crypto.randomUUID(), name: typed, color: OPTION_COLORS[newOptions.length % OPTION_COLORS.length] }]
                    : newOptions;
              const numberPrefix = fieldType === "number" ? normalizeNumberPrefix(symbol) : null;
              run(async () => {
                const result = await createPortfolioField(portfolioId, {
                  name,
                  fieldType,
                  options,
                  ...(numberPrefix ? { numberPrefix } : {}),
                });
                if (!result.error) {
                  setName("");
                  setNewOptions([]);
                  setOptionName("");
                  setSymbol("");
                }
                return result;
              });
            }}
          >
            <div className="flex min-w-48 flex-1 flex-col gap-1">
              <label htmlFor="new-portfolio-field" className="text-xs font-medium text-zinc-600">
                Field name
              </label>
              <input
                id="new-portfolio-field"
                value={name}
                maxLength={100}
                placeholder="Budget"
                onChange={(e) => setName(e.currentTarget.value)}
                className="control"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="new-portfolio-field-type" className="text-xs font-medium text-zinc-600">
                Type
              </label>
              <SmartPicker
                id="new-portfolio-field-type"
                label="Type"
                value={fieldType}
                onChange={(value) => {
                  if (isPortfolioFieldType(value)) setFieldType(value);
                }}
                options={PORTFOLIO_FIELD_TYPES.map((t) => ({ value: t.value, label: t.label }))}
              />
            </div>
            {fieldType === "number" ? (
              <div className="flex flex-col gap-1">
                <label htmlFor="new-portfolio-field-symbol" className="text-xs font-medium text-zinc-600">
                  Symbol <span className="font-normal text-zinc-400">(optional)</span>
                </label>
                <input
                  id="new-portfolio-field-symbol"
                  value={symbol}
                  maxLength={8}
                  placeholder="e.g. $"
                  aria-invalid={symbolProblem ? true : undefined}
                  aria-describedby="new-portfolio-field-symbol-hint"
                  onChange={(e) => setSymbol(e.currentTarget.value)}
                  className="control w-20"
                />
              </div>
            ) : null}
            <button
              type="submit"
              disabled={pending || !name.trim() || Boolean(optionsProblem) || Boolean(symbolProblem)}
              aria-describedby={
                optionsProblem
                  ? "new-portfolio-field-options-hint"
                  : symbolProblem
                    ? "new-portfolio-field-symbol-hint"
                    : undefined
              }
              className="btn-primary"
            >
              <Plus className="size-4" aria-hidden />
              Add field
            </button>
            {fieldType === "number" ? (
              <p
                id="new-portfolio-field-symbol-hint"
                className={`w-full text-xs ${symbolProblem ? "text-amber-700" : "text-zinc-500"}`}
              >
                {symbolProblem
                  ? `${symbolProblem}.`
                  : `Values show as ${formatNumberValue(1250, normalizeNumberPrefix(symbol))}; they stay numbers.`}
              </p>
            ) : null}
            {fieldType === "single_select" ? (
              <fieldset className="w-full">
                <legend className="text-xs font-medium text-zinc-600">Options</legend>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {newOptions.map((option) => (
                    <span
                      key={option.id}
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${OPTION_COLOR_CLASSES[option.color]}`}
                    >
                      {option.name}
                      <button
                        type="button"
                        onClick={() => setNewOptions((list) => list.filter((o) => o.id !== option.id))}
                        aria-label={`Remove option ${option.name}`}
                        data-tooltip="Remove option"
                        className="rounded hover:bg-black/10"
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                  <input
                    aria-label="Add an option"
                    value={optionName}
                    maxLength={100}
                    placeholder="Add an option"
                    onChange={(e) => setOptionName(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      // Enter adds the option; the field is created with the Add field button.
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addNewOption();
                      }
                    }}
                    className="control h-7 w-36 text-xs"
                  />
                  <button type="button" onClick={addNewOption} disabled={!optionName.trim()} className="btn-ghost h-7 px-1.5 text-xs">
                    Add
                  </button>
                </div>
                {optionsProblem ? (
                  <p id="new-portfolio-field-options-hint" className="mt-1 text-xs text-amber-700">
                    {optionsProblem} so editors can pick a value.
                  </p>
                ) : null}
              </fieldset>
            ) : null}
          </form>
        ) : null}
      </section>
    </div>
  );
}

function FieldRow({ field, canEdit }: { field: PortfolioField; canEdit: boolean }) {
  const [pending, run] = useServerAction();
  const confirm = useConfirm();
  const [optionName, setOptionName] = useState("");
  const saveOptions = (options: FieldOption[]) => run(() => updatePortfolioField(field.id, { options }));

  return (
    <li className="px-3 py-2.5">
      <div className="flex items-center gap-2">
        {canEdit ? (
          <input
            aria-label={`Name of ${field.name}`}
            key={field.name}
            defaultValue={field.name}
            maxLength={100}
            disabled={pending}
            onBlur={(e) => {
              const next = e.currentTarget.value.trim();
              if (next && next !== field.name) run(() => updatePortfolioField(field.id, { name: next }));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            className="control min-w-0 flex-1"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-900">{field.name}</span>
        )}
        <span className="chip">{typeLabel(field.fieldType)}</span>
        {canEdit ? (
          <button
            type="button"
            disabled={pending}
            onClick={async () => {
              if (
                await confirm({
                  title: `Delete the field “${field.name}”?`,
                  message: "Its values are hidden everywhere.",
                  confirmLabel: "Delete",
                  tone: "danger",
                })
              ) {
                run(() => deletePortfolioField(field.id));
              }
            }}
            aria-label={`Delete field ${field.name}`}
            title="Delete field"
            className="btn-icon hover:bg-red-50 hover:text-red-700"
          >
            <Trash2 className="size-4" />
          </button>
        ) : null}
      </div>

      {field.fieldType === "number" ? <SymbolRow field={field} canEdit={canEdit} /> : null}

      {field.fieldType === "single_select" ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {field.options.length === 0 ? <span className="text-xs text-zinc-400">No options yet.</span> : null}
          {field.options.map((option) => (
            <span
              key={option.id}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${OPTION_COLOR_CLASSES[option.color]}`}
            >
              {option.name}
              {canEdit ? (
                <>
                  <ColorPicker
                    compact
                    value={option.color}
                    disabled={pending}
                    label={`Color of ${option.name}`}
                    onChange={(color) =>
                      saveOptions(field.options.map((o) => (o.id === option.id ? { ...o, color } : o)))
                    }
                  />
                  {field.options.length > 1 ? (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => saveOptions(field.options.filter((o) => o.id !== option.id))}
                      aria-label={`Remove option ${option.name}`}
                      data-tooltip="Remove option"
                      className="rounded hover:bg-black/10"
                    >
                      <X className="size-3" />
                    </button>
                  ) : (
                    // The last option stays (item 47); add another first, then remove this one.
                    <button
                      type="button"
                      aria-disabled="true"
                      aria-label={`Remove option ${option.name}`}
                      data-tooltip={LAST_OPTION_NOTE}
                      onClick={(e) => e.preventDefault()}
                      className="cursor-not-allowed rounded opacity-40"
                    >
                      <X className="size-3" />
                    </button>
                  )}
                </>
              ) : null}
            </span>
          ))}
          {canEdit ? (
            <form
              className="inline-flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                const label = optionName.trim();
                if (!label) return;
                const color = OPTION_COLORS[field.options.length % OPTION_COLORS.length];
                run(async () => {
                  const result = await updatePortfolioField(field.id, {
                    options: [...field.options, { id: crypto.randomUUID(), name: label, color }],
                  });
                  if (!result.error) setOptionName("");
                  return result;
                });
              }}
            >
              <input
                aria-label={`New option for ${field.name}`}
                value={optionName}
                maxLength={100}
                placeholder="Add option"
                onChange={(e) => setOptionName(e.currentTarget.value)}
                className="control h-7 w-32 text-xs"
              />
              <button type="submit" disabled={pending || !optionName.trim()} className="btn-ghost h-7 px-1.5 text-xs">
                Add
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

// A number field's symbol (item 49): editors change it in place (saved when the box loses focus).
function SymbolRow({ field, canEdit }: { field: PortfolioField; canEdit: boolean }) {
  const [pending, run] = useServerAction();
  const saved = field.numberPrefix ?? "";
  const [draft, setDraft] = useState(saved);
  const [synced, setSynced] = useState(saved);
  if (synced !== saved) {
    setSynced(saved);
    setDraft(saved);
  }
  const problem = numberPrefixProblem(draft);
  const hintId = `portfolio-field-symbol-${field.id}-hint`;
  const preview = formatNumberValue(1250, normalizeNumberPrefix(problem ? saved : draft));
  if (!canEdit) {
    return saved ? <p className="mt-1.5 text-xs text-zinc-500">Shown as {preview}</p> : null;
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <label htmlFor={`portfolio-field-symbol-${field.id}`} className="text-xs text-zinc-600">
        Symbol
      </label>
      <input
        id={`portfolio-field-symbol-${field.id}`}
        value={draft}
        maxLength={8}
        placeholder="e.g. $"
        disabled={pending}
        aria-invalid={problem ? true : undefined}
        aria-describedby={hintId}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={() => {
          if (problem) return;
          const next = normalizeNumberPrefix(draft);
          if (next !== normalizeNumberPrefix(saved)) run(() => updatePortfolioField(field.id, { numberPrefix: next }));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setDraft(saved);
        }}
        className="control h-7 w-20 text-xs"
      />
      <span id={hintId} className={`text-xs ${problem ? "text-amber-700" : "text-zinc-500"}`}>
        {problem ? `${problem}.` : `Shown as ${preview}`}
      </span>
    </div>
  );
}
