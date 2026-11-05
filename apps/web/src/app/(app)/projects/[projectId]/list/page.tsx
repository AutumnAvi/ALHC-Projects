import type { Metadata } from "next";
import { LayoutRoute } from "@/components/project/project-view-page";
import { getProject } from "@/lib/data";

export async function generateMetadata({
  params,
}: PageProps<"/projects/[projectId]/list">): Promise<Metadata> {
  const { projectId } = await params;
  const project = await getProject(projectId);
  return { title: project ? `${project.name} · List` : "List" };
}

export default async function ProjectListPage({
  params,
  searchParams,
}: PageProps<"/projects/[projectId]/list">) {
  const { projectId } = await params;
  return <LayoutRoute projectId={projectId} layout="list" searchParams={await searchParams} />;
}
