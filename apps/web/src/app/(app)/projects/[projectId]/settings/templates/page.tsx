import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TemplatesSettings } from "@/components/project/templates-settings";
import { getProject, listProfiles, listProjectTemplates, listTaskTemplates } from "@/lib/data";

export async function generateMetadata({
  params,
}: PageProps<"/projects/[projectId]/settings/templates">): Promise<Metadata> {
  const { projectId } = await params;
  const project = await getProject(projectId);
  return { title: project ? `${project.name} · Templates` : "Templates" };
}

// Save this project as a workspace template (Admin+) and manage its task templates (Editor+; delete is
// Admin+). The SQL RPCs and RLS enforce every rule; the page only hides what the role can't do.
export default async function ProjectTemplatesPage({
  params,
}: PageProps<"/projects/[projectId]/settings/templates">) {
  const { projectId } = await params;
  const [project, templates, taskTemplates, profiles] = await Promise.all([
    getProject(projectId),
    listProjectTemplates(),
    listTaskTemplates(projectId),
    listProfiles(),
  ]);
  if (!project) notFound();

  return (
    <TemplatesSettings
      project={{ id: project.id, name: project.name }}
      replaceable={templates.filter((t) => t.canManage).map((t) => ({ id: t.id, name: t.name, isExample: t.isExample }))}
      taskTemplates={taskTemplates}
      profiles={profiles}
    />
  );
}
