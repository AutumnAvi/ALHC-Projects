"use client";

import { useState } from "react";
import { Dialog, DIALOG_HINT, DIALOG_LABEL } from "@/components/dialog";
import { FieldRow, OptionsEditor } from "@/components/project/fields-manager";
import { useServerAction } from "@/components/toast";
import { createField } from "@/lib/actions";
import { FIELD_TYPES, type FieldDef, type FieldOption } from "@/lib/fields";

// The List header's "+": a new field for this project (Editors and above, like the Fields page), shown
// as a column right away. Select fields can get their options here too.
export function NewFieldDialog({
  projectId,
  onCreated,
  onClose,
}: {
  projectId: string;
  onCreated: (fieldId: string) => void;
  onClose: () => void;
}) {
  const [pending, run] = useServerAction();
  const [name, setName] = useState("");
  const [fieldType, setFieldType] = useState<string>("single_select");
  const [options, setOptions] = useState<FieldOption[]>([]);
  const hasOptions = fieldType === "single_select" || fieldType === "multi_select";

  function submit() {
    const trimmed = name.trim();
    if (!trimmed || pending) return;
    run(async () => {
      const result = await createField(projectId, {
        name: trimmed,
        fieldType,
        showInViews: true,
        options: hasOptions ? options : undefined,
      });
      if (!result.error && result.fieldId) {
        onCreated(result.fieldId);
        onClose();
      }
      return result;
    });
  }

  // Not a <form>: the options editor has its own little form for adding an option.
  return (
    <Dialog title="Add field" description="A field adds the same detail to every task in this project." onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div>
          <label htmlFor="new-field-dialog-name" className={DIALOG_LABEL}>
            Field name
          </label>
          <input
            id="new-field-dialog-name"
            data-autofocus
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="e.g. Priority"
            className="field mt-1 w-full"
          />
        </div>
        <div>
          <label htmlFor="new-field-dialog-type" className={DIALOG_LABEL}>
            Type
          </label>
          <select
            id="new-field-dialog-type"
            value={fieldType}
            onChange={(e) => setFieldType(e.currentTarget.value)}
            className="field mt-1 w-full"
          >
            {FIELD_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        {hasOptions ? (
          <div>
            <p className={DIALOG_LABEL}>Options</p>
            <OptionsEditor options={options} onChange={setOptions} fieldName={name.trim() || "the new field"} />
            <p className={DIALOG_HINT}>You can add, rename, and recolor options later too.</p>
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button type="button" onClick={submit} disabled={pending || !name.trim()} className="btn-primary">
            {pending ? "Adding…" : "Add field"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// A column's menu → Edit field: the Fields page's editor for one field, saved as you go.
export function EditFieldDialog({
  field,
  sectionNames,
  onClose,
}: {
  field: FieldDef;
  sectionNames: string[];
  onClose: () => void;
}) {
  const [, run] = useServerAction();
  return (
    <Dialog title={`Edit “${field.name}”`} description="Changes apply to every task in this project." onClose={onClose} width="max-w-lg">
      <ul aria-label="Field">
        <FieldRow field={field} sectionNames={sectionNames} run={run} />
      </ul>
      <div className="mt-4 flex justify-end">
        <button type="button" onClick={onClose} className="btn-primary">
          Done
        </button>
      </div>
    </Dialog>
  );
}
