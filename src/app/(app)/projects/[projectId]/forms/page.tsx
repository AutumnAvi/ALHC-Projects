import type { Metadata } from "next";
import { FormsList } from "@/components/forms/forms-list";
import { getProject, listProjectForms } from "@/lib/data";
import { requestOrigin } from "@/lib/origin";

export async function generateMetadata({
  params,
}: PageProps<"/projects/[projectId]/forms">): Promise<Metadata> {
  const { projectId } = await params;
  const project = await getProject(projectId);
  return { title: project ? `${project.name} · Forms` : "Forms" };
}

export default async function ProjectFormsPage({ params }: PageProps<"/projects/[projectId]/forms">) {
  const { projectId } = await params;
  const [forms, origin] = await Promise.all([listProjectForms(projectId), requestOrigin()]);

  return (
    <main className="min-h-0 flex-1 overflow-auto">
      <FormsList projectId={projectId} forms={forms} origin={origin} />
    </main>
  );
}
