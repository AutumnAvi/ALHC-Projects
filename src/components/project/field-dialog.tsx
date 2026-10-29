"use client";

import { FieldEditorDialog } from "@/components/project/field-editor";
import { useProjectPage } from "@/components/project/project-page-context";
import type { FieldDef } from "@/lib/fields";

// The List header's "+": Add field (create one, or share one from the workspace field library), shown
// as a column right away. Editors and above, like the Fields page.
export function NewFieldDialog({
  projectId,
  existingFields,
  onCreated,
  onClose,
}: {
  projectId: string;
  // This project's fields (library fields it already uses aren't offered again).
  existingFields?: Pick<FieldDef, "id" | "libraryFieldId">[];
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
      existingFields={existingFields}
      onCreated={onCreated}
      onClose={onClose}
    />
  );
}

// A column's menu → Edit field: the same Edit field modal as the Fields page (a shared library field's
// definition read-only for people who can't change it).
export function EditFieldDialog({
  field,
  sectionNames,
  onClose,
}: {
  field: FieldDef;
  sectionNames: string[];
  onClose: () => void;
}) {
  const { batch4, fieldSharing } = useProjectPage();
  return (
    <FieldEditorDialog
      projectId={field.projectId}
      field={field}
      sectionNames={sectionNames}
      batch4={batch4}
      sharing={fieldSharing[field.id]}
      onClose={onClose}
    />
  );
}
