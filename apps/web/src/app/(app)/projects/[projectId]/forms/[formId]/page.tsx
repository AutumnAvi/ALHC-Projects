import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FormEditor } from "@/components/forms/form-editor";
import { FormsList } from "@/components/forms/forms-list";
import { getForm, getProjectRole, listProjectFields, listProjectForms, listSections } from "@/lib/data";
import { isUuid } from "@alhc/core/ids";
import { requestOrigin } from "@/lib/origin";
import { permissionsFor } from "@alhc/core/permissions";

export async function generateMetadata({
  params,
}: PageProps<"/projects/[projectId]/forms/[formId]">): Promise<Metadata> {
  const { formId } = await params;
  const form = isUuid(formId) ? await getForm(formId) : null;
  return { title: form ? `${form.title} · Form` : "Form" };
}

// ?back= (a page of this project, e.g. where Customize was open) is where closing goes; else the forms list.
function formBackHref(projectId: string, back: string | string[] | undefined): string {
  const base = `/projects/${projectId}`;
  return typeof back === "string" && (back === base || back.startsWith(`${base}/`)) && !back.startsWith(`${base}/forms/`)
    ? back
    : `${base}/forms`;
}

// The form editor (Asana parity, batch 4): a large modal over the project's forms list. Closing it goes
// back to the list.
export default async function FormEditorPage({ params, searchParams }: PageProps<"/projects/[projectId]/forms/[formId]">) {
  const [{ projectId, formId }, { back }] = await Promise.all([params, searchParams]);
  if (!isUuid(formId)) notFound();
  const [form, forms, sections, fields, origin, role] = await Promise.all([
    getForm(formId),
    listProjectForms(projectId),
    listSections(projectId),
    listProjectFields(projectId),
    requestOrigin(),
    getProjectRole(projectId),
  ]);
  if (!form || form.projectId !== projectId) notFound();

  return (
    <main className="min-h-0 flex-1 overflow-auto">
      <FormsList projectId={projectId} forms={forms} origin={origin} />
      <FormEditor
        key={form.id}
        form={form}
        sections={sections.map((s) => ({ id: s.id, name: s.name }))}
        fields={fields}
        origin={origin}
        batch4
        real1
        canEdit={permissionsFor(role).canBuild}
        closeHref={formBackHref(projectId, back)}
      />
    </main>
  );
}
