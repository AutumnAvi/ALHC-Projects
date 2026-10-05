import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { IntegrationsSettings } from "@/components/project/integrations-settings";
import { ReadOnlyNotice } from "@/components/project/project-access";
import { getProject, getProjectIntegrations, getProjectRole } from "@/lib/data";
import { hasRole } from "@/lib/roles";

export async function generateMetadata({
  params,
}: PageProps<"/projects/[projectId]/settings/integrations">): Promise<Metadata> {
  const { projectId } = await params;
  const project = await getProject(projectId);
  return { title: project ? `${project.name} · Integrations` : "Integrations" };
}

// Slack and outbound webhook defaults for rule actions. Admin+ only: the settings RPC refuses anyone
// else, so the page doesn't ask below Admin.
export default async function ProjectIntegrationsPage({
  params,
}: PageProps<"/projects/[projectId]/settings/integrations">) {
  const { projectId } = await params;
  const [project, role] = await Promise.all([getProject(projectId), getProjectRole(projectId)]);
  if (!project || !role) notFound();

  if (!hasRole(role, "admin")) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-6">
        <ReadOnlyNotice need="admin" what="integrations (Slack and webhook settings)" />
      </div>
    );
  }

  const settings = await getProjectIntegrations(projectId);
  if (!settings) notFound();
  return <IntegrationsSettings projectId={projectId} initial={settings} />;
}
