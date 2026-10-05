"use client";

import { useOptimistic } from "react";
import { X } from "lucide-react";
import { displayName } from "@/components/avatar";
import { useServerAction } from "@/components/toast";
import { moveTask, setFieldValue } from "@/lib/actions";
import type { Profile, TaskDetail } from "@/lib/data";
import { OPTION_COLOR_CLASSES, type FieldDef } from "@/lib/fields";
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
  const inputId = `field-${field.id}`;
  const save = (next: Json) =>
    run(
      () => setFieldValue(task.id, field.id, next),
      () => setValue(next),
    );

  let control: React.ReactNode;
  if (field.boundToSections) {
    control = (
      <select
        id={inputId}
        key={sectionId ?? "none"}
        defaultValue={sectionId ?? ""}
        onChange={(e) => run(() => moveTask(task.id, field.projectId, e.target.value || null))}
        className={INPUT}
      >
        <option value="">No section</option>
        {sections.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
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
          <select
            id={inputId}
            key={String(value ?? "")}
            defaultValue={typeof value === "string" ? value : ""}
            onChange={(e) => save(e.target.value || null)}
            className={INPUT}
          >
            <option value="">—</option>
            {field.options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
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
                className="rounded border border-transparent bg-transparent py-0.5 text-xs text-zinc-500 hover:border-zinc-200"
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
        {field.fieldType === "multi_select" || field.fieldType === "people" ? (
          field.name
        ) : (
          <label htmlFor={inputId}>{field.name}</label>
        )}
      </dt>
      <dd className="min-w-0">{control}</dd>
    </>
  );
}
