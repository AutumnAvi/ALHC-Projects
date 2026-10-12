import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FormEditor } from "@/components/forms/form-editor";
import { FormsList } from "@/components/forms/forms-list";
import { RoleGate } from "@/components/project/project-access";
import { getForm, getProjectRole, hasBatch4Schema, listProjectFields, listProjectForms, listSections } from "@/lib/data";
import { isUuid } from "@/lib/ids";
import { requestOrigin } from "@/lib/origin";
import { hasRole } from "@/lib/roles";

export async function generateMetadata({
  params,
}: PageProps<"/projects/[projectId]/forms/[formId]">): Promise<Metadata> {
  const { formId } = await params;
  const form = isUuid(formId) ? await getForm(formId) : null;
  return { title: form ? `${form.title} · Form` : "Form" };
}

// The form editor (Asana parity, batch 4): a large modal over the project's forms list. Closing it goes
// back to the list.
export default async function FormEditorPage({ params }: PageProps<"/projects/[projectId]/forms/[formId]">) {
  const { projectId, formId } = await params;
  if (!isUuid(formId)) notFound();
  const [form, forms, sections, fields, origin, role, batch4] = await Promise.all([
    getForm(formId),
    listProjectForms(projectId),
    listSections(projectId),
    listProjectFields(projectId),
    requestOrigin(),
    getProjectRole(projectId),
    hasBatch4Schema(),
  ]);
  if (!form || form.projectId !== projectId) notFound();

  return (
    <main className="min-h-0 flex-1 overflow-auto">
      <RoleGate need="admin" what="forms">
        <FormsList projectId={projectId} forms={forms} origin={origin} />
      </RoleGate>
      <FormEditor
        key={form.id}
        form={form}
        sections={sections.map((s) => ({ id: s.id, name: s.name }))}
        fields={fields}
        origin={origin}
        batch4={batch4}
        canEdit={hasRole(role, "admin")}
        closeHref={`/projects/${projectId}/forms`}
      />
    </main>
  );
}
