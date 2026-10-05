import { notFound } from "next/navigation";
import { ProjectHeader } from "@/components/project/project-header";
import { getProject, listProjectViews } from "@/lib/data";
import { isUuid } from "@/lib/ids";

export default async function ProjectLayout({
  children,
  params,
}: LayoutProps<"/projects/[projectId]">) {
  const { projectId } = await params;
  if (!isUuid(projectId)) notFound();
  const [project, views] = await Promise.all([getProject(projectId), listProjectViews(projectId)]);
  if (!project) notFound();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ProjectHeader project={project} views={views} />
      {children}
    </div>
  );
}
