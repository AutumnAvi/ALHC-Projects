"use client";

import { useOptimistic, useState } from "react";
import { CalendarDays, Check, ChevronDown, Plus, X } from "lucide-react";
import { displayName } from "@/components/avatar";
import { useServerAction } from "@/components/toast";
import { moveTask, setFieldValue } from "@/lib/actions";
import type { Profile, TaskDetail } from "@/lib/data";
import { MenuItem, Popover } from "@/components/popover";
import { PILL, isChoiceField } from "@/components/project/field-chips";
import { OPTION_COLOR_CLASSES, fieldChips, type FieldDef, type FieldOption } from "@/lib/fields";
import type { Json } from "@/lib/supabase/database.types";
import { formatDueDate } from "@/lib/dates";
import { SingleDatePicker } from "./date-picker";
import { PersonPicker } from "./person-picker";
import { useDateText } from "./task-dates";
import { PANE_CONTROL, PANE_FIELDS, PANE_LABEL } from "./pane-styles";

const INPUT = `${PANE_CONTROL} w-full max-w-64`;

// Custom fields in the pane's field grid (Asana parity, batch 3): the first FIELDS_SHOWN are always
// shown, the rest behind "Show N more fields". Grouped by project when the task is in several projects
// with fields.
const FIELDS_SHOWN = 5;

export function TaskFields({ task, profiles, canEdit }: { task: TaskDetail; profiles: Profile[]; canEdit: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (task.fields.length === 0) return null;
  const byProject = task.memberships
    .map((m) => ({ membership: m, fields: task.fields.filter((f) => f.projectId === m.projectId) }))
    .filter((group) => group.fields.length > 0);
  const showProjectNames = byProject.length > 1;
  const total = byProject.reduce((n, g) => n + g.fields.length, 0);
  const hidden = expanded ? 0 : Math.max(total - FIELDS_SHOWN, 0);
  // How many fields of each group fit in the first FIELDS_SHOWN (in order).
  const shownCounts = byProject.map((_, index) => {
    const before = byProject.slice(0, index).reduce((n, g) => n + g.fields.length, 0);
    return expanded ? byProject[index].fields.length : Math.max(Math.min(byProject[index].fields.length, FIELDS_SHOWN - before), 0);
  });

  return (
    <section aria-label="Custom fields">
      {byProject.map(({ membership, fields }, index) =>
        shownCounts[index] > 0 ? (
          <div key={membership.projectId}>
            {showProjectNames ? (
              <h3 className="mb-0.5 mt-2 text-2xs font-semibold uppercase tracking-wider text-zinc-500">
                {membership.projectName}
              </h3>
            ) : null}
            <dl className={PANE_FIELDS}>
              {fields.slice(0, shownCounts[index]).map((field) => (
                <FieldRow
                  key={field.id}
                  field={field}
                  task={task}
                  profiles={profiles}
                  canEdit={canEdit}
                  value={task.fieldValues[field.id] ?? null}
                  sectionId={membership.sectionId}
                  sections={membership.sections}
                />
              ))}
            </dl>
          </div>
        ) : null,
      )}
      {total > FIELDS_SHOWN ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}
          className="btn-ghost -ml-2 mt-0.5 h-7 px-2 text-xs text-zinc-600 print:hidden"
        >
          <ChevronDown className={`size-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden />
          {expanded ? "Show fewer fields" : `Show ${hidden} more field${hidden === 1 ? "" : "s"}`}
        </button>
      ) : null}
    </section>
  );
}

function FieldRow({
  field,
  task,
  profiles,
  canEdit,
  value: savedValue,
  sectionId,
  sections,
}: {
  field: FieldDef;
  task: TaskDetail;
  profiles: Profile[];
  canEdit: boolean;
  value: Json;
  sectionId: string | null;
  sections: { id: string; name: string }[];
}) {
  const [, run] = useServerAction();
  const dateText = useDateText();
  // Toggle-style editors build on this value, so quick successive clicks don't overwrite each other.
  const [value, setValue] = useOptimistic(savedValue);
  const [section, setSection] = useOptimistic(sectionId);
  const inputId = `field-${field.id}`;
  const save = (next: Json) =>
    run(
      () => setFieldValue(task.id, field.id, next),
      () => setValue(next),
    );

  let control: React.ReactNode;
  if (!canEdit) {
    // Below Editor: the value as it reads in List and Board (pills for choices, plain text otherwise).
    const chips = fieldChips(field, field.boundToSections ? null : value, {
      personName: (personId) => {
        const p = profiles.find((profile) => profile.id === personId);
        return p ? displayName(p) : null;
      },
      sectionName: field.boundToSections ? (sections.find((s) => s.id === section)?.name ?? null) : null,
    });
    control =
      chips.length === 0 ? (
        <span className="px-1 text-sm text-zinc-500">—</span>
      ) : isChoiceField(field) ? (
        <span className="flex min-h-8 flex-wrap items-center gap-1 px-1">
          {chips.map((chip, i) => (
            <span key={`${chip.label}-${i}`} className={`${PILL} ${OPTION_COLOR_CLASSES[chip.color]}`}>
              {chip.label}
            </span>
          ))}
        </span>
      ) : (
        <span className="flex min-h-8 items-center px-1 text-sm text-zinc-800">
          {field.fieldType === "date" && typeof value === "string" ? dateText(value) : chips.map((chip) => chip.label).join(", ")}
        </span>
      );
  } else if (field.boundToSections) {
    control = (
      <ChoicePill
        fieldName={field.name}
        value={section}
        options={sections.map((s) => ({ id: s.id, name: s.name, color: "zinc" as const }))}
        emptyLabel="No section"
        onChange={(next) =>
          run(
            () => moveTask(task.id, field.projectId, next),
            () => setSection(next),
          )
        }
      />
    );
  } else {
    switch (field.fieldType) {
      case "text":
        control = (
          <input
            id={inputId}
            key={String(value ?? "")}
            defaultValue={typeof value === "string" ? value : ""}
            onBlur={(e) => {
              const next = e.currentTarget.value.trim();
              if (next !== (value ?? "")) save(next || null);
            }}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            className={INPUT}
          />
        );
        break;
      case "number":
        control = (
          <input
            id={inputId}
            type="number"
            step="any"
            key={String(value ?? "")}
            defaultValue={typeof value === "number" ? value : ""}
            onBlur={(e) => {
              const raw = e.currentTarget.value;
              const next = raw === "" ? null : Number(raw);
              if (next !== null && !Number.isFinite(next)) return;
              if (next !== value) save(next);
            }}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            className={INPUT}
          />
        );
        break;
      case "date": {
        const day = typeof value === "string" ? value : null;
        control = (
          <Popover
            label={`${field.name}: ${day ? formatDueDate(day) : "empty"}. Change`}
            panelClassName="w-[19rem] p-0"
            buttonClassName="inline-flex h-8 max-w-full items-center gap-1.5 rounded-md px-1 text-sm hover:bg-zinc-100 aria-expanded:bg-zinc-100"
            button={
              <>
                <span
                  aria-hidden
                  className={`inline-flex size-6 shrink-0 items-center justify-center rounded-full ${
                    day ? "text-zinc-500" : "border border-dashed border-zinc-300 text-zinc-400"
                  }`}
                >
                  <CalendarDays className="size-3.5" />
                </span>
                <span className={day ? "text-zinc-800" : "text-zinc-500"}>{day ? dateText(day) : "No date"}</span>
              </>
            }
          >
            {(close) => (
              <SingleDatePicker
                label={field.name}
                value={day}
                onChange={(next) => {
                  close();
                  if (next !== day) save(next);
                }}
              />
            )}
          </Popover>
        );
        break;
      }
      case "boolean":
        control = (
          <input
            id={inputId}
            type="checkbox"
            key={String(value)}
            defaultChecked={value === true}
            onChange={(e) => save(e.target.checked)}
            className="size-4 rounded border-zinc-300 accent-accent-600"
          />
        );
        break;
      case "single_select":
        control = (
          <ChoicePill
            fieldName={field.name}
            value={typeof value === "string" ? value : null}
            options={field.options}
            onChange={(next) => save(next)}
          />
        );
        break;
      case "multi_select": {
        const selected = Array.isArray(value) ? (value as string[]) : [];
        control = (
          <div id={inputId} role="group" aria-label={field.name} className="flex flex-wrap gap-1.5">
            {field.options.length === 0 ? (
              <span className="text-xs text-zinc-400">No options yet — add them under Fields.</span>
            ) : null}
            {field.options.map((o) => {
              const on = selected.includes(o.id);
              return (
                <button
                  key={o.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    save(on ? selected.filter((idValue) => idValue !== o.id) : [...selected, o.id])
                  }
                  className={`rounded-full px-2 py-0.5 text-xs font-medium transition ${
                    on
                      ? OPTION_COLOR_CLASSES[o.color]
                      : "border border-dashed border-zinc-300 text-zinc-500 hover:border-zinc-400"
                  }`}
                >
                  {o.name}
                </button>
              );
            })}
          </div>
        );
        break;
      }
      case "people": {
        const selected = Array.isArray(value) ? (value as string[]) : [];
        const remaining = profiles.filter((p) => !selected.includes(p.id));
        control = (
          <div className="flex flex-wrap items-center gap-1.5">
            {selected.map((personId) => {
              const person = profiles.find((p) => p.id === personId);
              if (!person) return null;
              return (
                <span
                  key={personId}
                  className="inline-flex items-center gap-1 rounded-full bg-zinc-100 py-0.5 pl-2 pr-1 text-xs text-zinc-700"
                >
                  {displayName(person)}
                  <button
                    type="button"
                    aria-label={`Remove ${displayName(person)} from ${field.name}`}
                    onClick={() => save(selected.filter((p) => p !== personId))}
                    className="rounded-full p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              );
            })}
            {remaining.length > 0 ? (
              <PersonPicker
                label={`Add a person to ${field.name}`}
                people={remaining}
                value={null}
                onPick={(personId) => save([...selected, personId])}
                buttonClassName="inline-flex h-7 items-center gap-1 rounded-md px-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 aria-expanded:bg-zinc-100 print:hidden"
                button={
                  <>
                    <Plus className="size-3.5" aria-hidden />
                    {selected.length ? <span className="sr-only">Add person</span> : "Add person"}
                  </>
                }
              />
            ) : null}
          </div>
        );
        break;
      }
    }
  }

  return (
    <>
      <dt className={PANE_LABEL}>
        {!canEdit ||
        field.boundToSections ||
        field.fieldType === "single_select" ||
        field.fieldType === "multi_select" ||
        field.fieldType === "date" ||
        field.fieldType === "people" ? (
          field.name
        ) : (
          <label htmlFor={inputId}>{field.name}</label>
        )}
      </dt>
      <dd className="min-w-0">{control}</dd>
    </>
  );
}

// A single choice shown as Asana's colored pill; clicking it lists the options (and Clear).
function ChoicePill({
  fieldName,
  value,
  options,
  emptyLabel = "—",
  onChange,
}: {
  fieldName: string;
  value: string | null;
  options: FieldOption[];
  emptyLabel?: string;
  onChange: (next: string | null) => void;
}) {
  const selected = options.find((o) => o.id === value) ?? null;
  return (
    <Popover
      label={`${fieldName}: ${selected ? selected.name : "empty"}. Change`}
      panelClassName="w-60 p-1.5"
      buttonClassName="-mx-1 inline-flex min-h-7 max-w-full items-center rounded-md px-1 hover:bg-zinc-100 aria-expanded:bg-zinc-100"
      button={
        selected ? (
          <span className={`${PILL} ${OPTION_COLOR_CLASSES[selected.color]}`}>{selected.name}</span>
        ) : (
          <span className="text-sm text-zinc-400">{emptyLabel}</span>
        )
      }
    >
      {(close) => (
        <>
          {options.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-zinc-500">No options yet — add them under Fields.</p>
          ) : null}
          {options.map((o) => (
            <MenuItem
              key={o.id}
              onClick={() => {
                close();
                if (o.id !== value) onChange(o.id);
              }}
            >
              <span className={`${PILL} ${OPTION_COLOR_CLASSES[o.color]}`}>{o.name}</span>
              {o.id === value ? <Check className="ml-auto size-4 text-accent-600" aria-label="Selected" /> : null}
            </MenuItem>
          ))}
          {value ? (
            <>
              <hr className="my-1 border-zinc-100" />
              <MenuItem
                onClick={() => {
                  close();
                  onChange(null);
                }}
              >
                <span className="text-zinc-500">{emptyLabel === "—" ? "Clear" : emptyLabel}</span>
              </MenuItem>
            </>
          ) : null}
        </>
      )}
    </Popover>
  );
}
