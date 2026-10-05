import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ImportSettings } from "@/components/project/import-settings";
import { ReadOnlyNotice } from "@/components/project/project-access";
import { requireMember } from "@/lib/auth";
import { getProject, getProjectRole, listImportRuns } from "@/lib/data";
import { hasRole } from "@/lib/roles";

// Import Server Actions parse the export and work through batches for up to ~20 s per call.
export const maxDuration = 60;

export async function generateMetadata({
  params,
}: PageProps<"/projects/[projectId]/settings/import">): Promise<Metadata> {
  const { projectId } = await params;
  const project = await getProject(projectId);
  return { title: project ? `${project.name} · Import` : "Import" };
}

// Asana import (Admin+). Upload, Storage access, and every import RPC refuse anyone below Admin, so
// the page doesn't offer it below Admin either.
export default async function ProjectImportPage({ params }: PageProps<"/projects/[projectId]/settings/import">) {
  const { projectId } = await params;
  const [project, role, me] = await Promise.all([getProject(projectId), getProjectRole(projectId), requireMember()]);
  if (!project || !role) notFound();

  if (!hasRole(role, "admin")) {
    return (
      <div className="mx-auto max-w-3xl px-gutter py-5">
        <ReadOnlyNotice need="admin" what="imports (bring an Asana project into this one)" />
      </div>
    );
  }

  const runs = await listImportRuns(projectId);
  return <ImportSettings projectId={projectId} userId={me.id} runs={runs} />;
}
