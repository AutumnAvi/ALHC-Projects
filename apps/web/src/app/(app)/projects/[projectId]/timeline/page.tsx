import type { Metadata } from "next";
import { LayoutRoute } from "@/components/project/project-view-page";
import { getProject } from "@/lib/data";

export async function generateMetadata({
  params,
}: PageProps<"/projects/[projectId]/timeline">): Promise<Metadata> {
  const { projectId } = await params;
  const project = await getProject(projectId);
  return { title: project ? `${project.name} · Timeline` : "Timeline" };
}

export default async function ProjectTimelinePage({
  params,
  searchParams,
}: PageProps<"/projects/[projectId]/timeline">) {
  const { projectId } = await params;
  return <LayoutRoute projectId={projectId} layout="timeline" searchParams={await searchParams} />;
}
