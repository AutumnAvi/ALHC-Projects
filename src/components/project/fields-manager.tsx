"use client";

import { useState } from "react";
import { Columns3, Plus, SlidersHorizontal } from "lucide-react";
import { FieldEditorDialog, FieldList } from "@/components/project/field-editor";
import { useProjectPermissions } from "@/components/project/project-access";
import { useProjectPage } from "@/components/project/project-page-context";
import { useServerAction } from "@/components/toast";
import { EmptyState } from "@/components/ui";
import { createField } from "@/lib/actions";
import type { FieldDef } from "@/lib/fields";

// The Fields page (Asana parity, batch 4): Asana's fields list — type icon, name, option preview — with
// Add field (create one or copy one from the workspace field library) and the Edit field modal on a
// click. Editors and above change fields; everyone else reads.
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
  const { batch4 } = useProjectPage();
  const canEdit = useProjectPermissions().canEdit;
  const [adding, setAdding] = useState(false);
  const hasBound = fields.some((f) => f.boundToSections);

  return (
    <div className="mx-auto max-w-3xl px-gutter py-5">
      <div className="flex flex-wrap items-start gap-3">
        <p className="min-w-0 flex-1 text-sm text-zinc-600">
          Fields add the same detail to every task in this project. Fields shown in List and Board appear as columns
          and as pills on cards.
        </p>
        {canEdit ? (
          <button type="button" onClick={() => setAdding(true)} className="btn-primary h-8 px-3">
            <Plus className="size-4" aria-hidden />
            Add field
          </button>
        ) : null}
      </div>

      <div className="mt-5">
        {fields.length === 0 ? (
          <EmptyState
            icon={SlidersHorizontal}
            title="No fields yet"
            action={
              canEdit ? (
                <button type="button" onClick={() => setAdding(true)} className="btn-primary h-8 px-3">
                  <Plus className="size-4" aria-hidden />
                  Add field
                </button>
              ) : undefined
            }
          >
            Custom fields add structured details to every task here, like a priority, a channel, or a reviewer.
          </EmptyState>
        ) : (
          <FieldList projectId={projectId} fields={fields} sectionNames={sectionNames} canEdit={canEdit} batch4={batch4} />
        )}
      </div>

      {canEdit && !hasBound ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-200 px-4 py-3">
          <p className="flex min-w-0 flex-1 items-start gap-2 text-sm text-zinc-600">
            <Columns3 className="mt-0.5 size-4 shrink-0 text-zinc-500" aria-hidden />
            <span>
              <span className="font-medium text-zinc-900">Status from sections.</span> A single-select whose options are
              this project’s sections. Changing it moves the task.
            </span>
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
            className="btn-secondary h-8 px-3"
          >
            Add Status field
          </button>
        </div>
      ) : null}

      {adding ? (
        <FieldEditorDialog
          projectId={projectId}
          field={null}
          sectionNames={sectionNames}
          batch4={batch4}
          existingFieldIds={fields.map((f) => f.id)}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </div>
  );
}
