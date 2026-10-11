"use client";

import { useOptimistic } from "react";
import { Check, X } from "lucide-react";
import { displayName } from "@/components/avatar";
import { useServerAction } from "@/components/toast";
import { moveTask, setFieldValue } from "@/lib/actions";
import type { Profile, TaskDetail } from "@/lib/data";
import { MenuItem, Popover } from "@/components/popover";
import { PILL } from "@/components/project/field-chips";
import { OPTION_COLOR_CLASSES, type FieldDef, type FieldOption } from "@/lib/fields";
import type { Json } from "@/lib/supabase/database.types";
import { PANE_CONTROL, PANE_FIELDS, PANE_LABEL } from "./pane-styles";

const INPUT = `${PANE_CONTROL} w-full max-w-64`;

export function TaskFields({ task, profiles }: { task: TaskDetail; profiles: Profile[] }) {
  if (task.fields.length === 0) return null;
  const byProject = task.memberships
    .map((m) => ({ membership: m, fields: task.fields.filter((f) => f.projectId === m.projectId) }))
    .filter((group) => group.fields.length > 0);
  const showProjectNames = byProject.length > 1;

  return (
    <section aria-label="Custom fields" className="mt-1">
      {byProject.map(({ membership, fields }) => (
        <div key={membership.projectId} className="mt-1">
          {showProjectNames ? (
            <h3 className="mb-0.5 mt-3 text-2xs font-semibold uppercase tracking-wider text-zinc-400">
              {membership.projectName}
            </h3>
          ) : null}
          <dl className={PANE_FIELDS}>
            {fields.map((field) => (
              <FieldRow
                key={field.id}
                field={field}
                task={task}
                profiles={profiles}
                value={task.fieldValues[field.id] ?? null}
                sectionId={membership.sectionId}
                sections={membership.sections}
              />
            ))}
          </dl>
        </div>
      ))}
    </section>
  );
}

function FieldRow({
  field,
  task,
  profiles,
  value: savedValue,
  sectionId,
  sections,
}: {
  field: FieldDef;
  task: TaskDetail;
  profiles: Profile[];
  value: Json;
  sectionId: string | null;
  sections: { id: string; name: string }[];
}) {
  const [, run] = useServerAction();
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
  if (field.boundToSections) {
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
      case "date":
        control = (
          <input
            id={inputId}
            type="date"
            key={String(value ?? "")}
            defaultValue={typeof value === "string" ? value : ""}
            onChange={(e) => save(e.target.value || null)}
            className={`${INPUT} w-auto`}
          />
        );
        break;
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
              <select
                id={inputId}
                value=""
                onChange={(e) => e.target.value && save([...selected, e.target.value])}
                aria-label={`Add person to ${field.name}`}
                className="rounded-md border border-transparent bg-transparent py-0.5 text-xs text-zinc-500 hover:border-zinc-200"
              >
                <option value="">Add person…</option>
                {remaining.map((p) => (
                  <option key={p.id} value={p.id}>
                    {displayName(p)}
                  </option>
                ))}
              </select>
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
        {field.boundToSections ||
        field.fieldType === "single_select" ||
        field.fieldType === "multi_select" ||
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
