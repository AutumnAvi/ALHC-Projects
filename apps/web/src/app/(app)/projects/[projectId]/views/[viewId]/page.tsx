import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProjectViewPage } from "@/components/project/project-view-page";
import { isUuid } from "@alhc/core/ids";
import { loadProjectFrame } from "@/lib/screen-loaders";

// Nov 4 notes (batch 22, M1): the project and its views come from the project frame the layout reads
// (one call, shared within the request).
async function frameView(projectId: string, viewId: string) {
  if (!isUuid(projectId) || !isUuid(viewId)) return { project: null, view: null };
  const frame = await loadProjectFrame(projectId);
  return { project: frame.project, view: frame.views.find((v) => v.id === viewId) ?? null };
}

export async function generateMetadata({
  params,
}: PageProps<"/projects/[projectId]/views/[viewId]">): Promise<Metadata> {
  const { projectId, viewId } = await params;
  const { project, view } = await frameView(projectId, viewId);
  return { title: project && view ? `${project.name} · ${view.name}` : "View" };
}

export default async function ProjectSavedViewPage({
  params,
  searchParams,
}: PageProps<"/projects/[projectId]/views/[viewId]">) {
  const { projectId, viewId } = await params;
  const { view } = await frameView(projectId, viewId);
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
