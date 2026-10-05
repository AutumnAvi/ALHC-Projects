import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProjectViewPage } from "@/components/project/project-view-page";
import { getProject, getProjectView } from "@/lib/data";
import { isUuid } from "@/lib/ids";

export async function generateMetadata({
  params,
}: PageProps<"/projects/[projectId]/views/[viewId]">): Promise<Metadata> {
  const { projectId, viewId } = await params;
  const [project, view] = await Promise.all([
    getProject(projectId),
    isUuid(viewId) ? getProjectView(viewId) : null,
  ]);
  return { title: project && view ? `${project.name} · ${view.name}` : "View" };
}

export default async function ProjectSavedViewPage({
  params,
  searchParams,
}: PageProps<"/projects/[projectId]/views/[viewId]">) {
  const { projectId, viewId } = await params;
  const view = isUuid(viewId) ? await getProjectView(viewId) : null;
  if (!view || view.projectId !== projectId) notFound();
  return (
    <ProjectViewPage
      projectId={projectId}
      view={view}
      layout={view.layout}
      searchParams={await searchParams}
    />
  );
}
