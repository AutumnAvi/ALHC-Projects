import { redirect } from "next/navigation";
import { queryString } from "@/components/project/project-view-page";
import { listProjectViews } from "@/lib/data";

export default async function ProjectIndex({ params, searchParams }: PageProps<"/projects/[projectId]">) {
  const { projectId } = await params;
  const [first] = await listProjectViews(projectId);
  const query = queryString(await searchParams);
  redirect(first ? `/projects/${projectId}/views/${first.id}${query}` : `/projects/${projectId}/list${query}`);
}
