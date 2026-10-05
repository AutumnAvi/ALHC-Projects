import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FormBuilder } from "@/components/forms/form-builder";
import { getForm, listProjectFields, listSections } from "@/lib/data";
import { isUuid } from "@/lib/ids";
import { requestOrigin } from "@/lib/origin";

export async function generateMetadata({
  params,
}: PageProps<"/projects/[projectId]/forms/[formId]">): Promise<Metadata> {
  const { formId } = await params;
  const form = isUuid(formId) ? await getForm(formId) : null;
  return { title: form ? `${form.title} · Form` : "Form" };
}

export default async function FormBuilderPage({ params }: PageProps<"/projects/[projectId]/forms/[formId]">) {
  const { projectId, formId } = await params;
  if (!isUuid(formId)) notFound();
  const [form, sections, fields, origin] = await Promise.all([
    getForm(formId),
    listSections(projectId),
    listProjectFields(projectId),
    requestOrigin(),
  ]);
  if (!form || form.projectId !== projectId) notFound();

  return (
    <main className="min-h-0 flex-1 overflow-auto">
      <FormBuilder
        key={form.id}
        form={form}
        sections={sections.map((s) => ({ id: s.id, name: s.name }))}
        fields={fields}
        origin={origin}
      />
    </main>
  );
}
