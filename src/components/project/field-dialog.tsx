"use client";

import { FieldEditorDialog } from "@/components/project/field-editor";
import { useProjectPage } from "@/components/project/project-page-context";
import type { FieldDef } from "@/lib/fields";

// The List header's "+": Add field (create one, or copy one from the workspace field library), shown as
// a column right away. Editors and above, like the Fields page.
export function NewFieldDialog({
  projectId,
  existingFieldIds = [],
  onCreated,
  onClose,
}: {
  projectId: string;
  existingFieldIds?: string[];
  onCreated: (fieldId: string) => void;
  onClose: () => void;
}) {
  const { batch4 } = useProjectPage();
  return (
    <FieldEditorDialog
      projectId={projectId}
      field={null}
      sectionNames={[]}
      batch4={batch4}
      existingFieldIds={existingFieldIds}
      onCreated={onCreated}
      onClose={onClose}
    />
  );
}

// A column's menu → Edit field: the same Edit field modal as the Fields page.
export function EditFieldDialog({
  field,
  sectionNames,
  onClose,
}: {
  field: FieldDef;
  sectionNames: string[];
  onClose: () => void;
}) {
  const { batch4 } = useProjectPage();
  return (
    <FieldEditorDialog
      projectId={field.projectId}
      field={field}
      sectionNames={sectionNames}
      batch4={batch4}
      onClose={onClose}
    />
  );
}
