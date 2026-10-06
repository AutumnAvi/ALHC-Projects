"use client";

import { useState } from "react";
import { ListPlus, Plus, Trash2, X } from "lucide-react";
import { EmptyState } from "@/components/ui";
import { useServerAction } from "@/components/toast";
import { createPortfolioField, deletePortfolioField, updatePortfolioField } from "@/lib/actions";
import type { PortfolioField } from "@/lib/data";
import { OPTION_COLORS, OPTION_COLOR_CLASSES, type FieldOption, type OptionColor } from "@/lib/fields";
import { PORTFOLIO_FIELD_TYPES, isPortfolioFieldType, type PortfolioFieldType } from "@/lib/portfolios";

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
              if (!name.trim()) return;
              run(async () => {
                const result = await createPortfolioField(portfolioId, { name, fieldType, options: [] });
                if (!result.error) setName("");
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
              <select
                id="new-portfolio-field-type"
                value={fieldType}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  if (isPortfolioFieldType(value)) setFieldType(value);
                }}
                className="control"
              >
                {PORTFOLIO_FIELD_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" disabled={pending || !name.trim()} className="btn-primary">
              <Plus className="size-4" aria-hidden />
              Add field
            </button>
          </form>
        ) : null}
      </section>
    </div>
  );
}

function FieldRow({ field, canEdit }: { field: PortfolioField; canEdit: boolean }) {
  const [pending, run] = useServerAction();
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
            onClick={() => {
              if (window.confirm(`Delete the field “${field.name}”? Its values are hidden everywhere.`)) {
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

      {field.fieldType === "single_select" ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {field.options.length === 0 ? <span className="text-xs text-zinc-400">No options yet.</span> : null}
          {field.options.map((option) => (
            <span
              key={option.id}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${OPTION_COLOR_CLASSES[option.color]}`}
            >
              {option.name}
              {canEdit ? (
                <>
                  <select
                    aria-label={`Colour of ${option.name}`}
                    value={option.color}
                    disabled={pending}
                    onChange={(e) =>
                      saveOptions(
                        field.options.map((o) =>
                          o.id === option.id ? { ...o, color: e.currentTarget.value as OptionColor } : o,
                        ),
                      )
                    }
                    className="cursor-pointer bg-transparent text-2xs opacity-70"
                  >
                    {OPTION_COLORS.map((c) => (
                      <option key={c} value={c} className="text-zinc-900">
                        {c}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => saveOptions(field.options.filter((o) => o.id !== option.id))}
                    aria-label={`Remove option ${option.name}`}
                    className="rounded hover:bg-black/10"
                  >
                    <X className="size-3" />
                  </button>
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
