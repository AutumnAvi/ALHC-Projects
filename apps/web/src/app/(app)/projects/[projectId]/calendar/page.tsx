import type { Metadata } from "next";
import { LayoutRoute } from "@/components/project/project-view-page";
import { getProject } from "@/lib/data";

export async function generateMetadata({
  params,
}: PageProps<"/projects/[projectId]/calendar">): Promise<Metadata> {
  const { projectId } = await params;
  const project = await getProject(projectId);
  return { title: project ? `${project.name} · Calendar` : "Calendar" };
}

export default async function ProjectCalendarPage({
  params,
  searchParams,
}: PageProps<"/projects/[projectId]/calendar">) {
  const { projectId } = await params;
  return <LayoutRoute projectId={projectId} layout="calendar" searchParams={await searchParams} />;
}
