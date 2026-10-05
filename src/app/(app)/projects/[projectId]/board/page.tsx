import type { Metadata } from "next";
import { LayoutRoute } from "@/components/project/project-view-page";
import { getProject } from "@/lib/data";

export async function generateMetadata({
  params,
}: PageProps<"/projects/[projectId]/board">): Promise<Metadata> {
  const { projectId } = await params;
  const project = await getProject(projectId);
  return { title: project ? `${project.name} · Board` : "Board" };
}

export default async function ProjectBoardPage({
  params,
  searchParams,
}: PageProps<"/projects/[projectId]/board">) {
  const { projectId } = await params;
  return <LayoutRoute projectId={projectId} layout="board" searchParams={await searchParams} />;
}
