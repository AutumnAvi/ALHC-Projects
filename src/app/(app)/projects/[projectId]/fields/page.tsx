import type { Metadata } from "next";
import { RoleGate } from "@/components/project/project-access";
import { FieldsManager } from "@/components/project/fields-manager";
import { getProject, listProjectFields, listSections } from "@/lib/data";

export async function generateMetadata({
  params,
}: PageProps<"/projects/[projectId]/fields">): Promise<Metadata> {
  const { projectId } = await params;
  const project = await getProject(projectId);
  return { title: project ? `${project.name} · Fields` : "Fields" };
}

export default async function ProjectFieldsPage({
  params,
}: PageProps<"/projects/[projectId]/fields">) {
  const { projectId } = await params;
  const [fields, sections] = await Promise.all([
    listProjectFields(projectId),
    listSections(projectId),
  ]);

  return (
    <main className="min-h-0 flex-1 overflow-auto">
      <RoleGate need="editor" what="fields">
        <FieldsManager
          projectId={projectId}
          fields={fields}
          sectionNames={sections.map((s) => s.name)}
        />
      </RoleGate>
    </main>
  );
}
