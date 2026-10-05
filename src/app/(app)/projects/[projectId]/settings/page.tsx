import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RoleGate } from "@/components/project/project-access";
import { ProjectSettings } from "@/components/project/project-settings";
import { ProjectStatusForm } from "@/components/project/project-status-form";
import { getProject, getRequestSequence } from "@/lib/data";

export async function generateMetadata({
  params,
}: PageProps<"/projects/[projectId]/settings">): Promise<Metadata> {
  const { projectId } = await params;
  const project = await getProject(projectId);
  return { title: project ? `${project.name} · Settings` : "Settings" };
}

export default async function ProjectSettingsPage({
  params,
}: PageProps<"/projects/[projectId]/settings">) {
  const { projectId } = await params;
  const [project, sequence] = await Promise.all([getProject(projectId), getRequestSequence(projectId)]);
  if (!project) notFound();

  // Status is Editor+, so it sits outside the admin-only gate below.
  return (
    <>
      <ProjectStatusForm project={project} />
      <RoleGate need="admin" what="project settings">
        <ProjectSettings project={project} sequence={sequence} />
      </RoleGate>
    </>
  );
}
