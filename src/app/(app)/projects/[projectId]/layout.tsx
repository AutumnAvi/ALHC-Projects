import { notFound } from "next/navigation";
import { ProjectAccessProvider } from "@/components/project/project-access";
import { ProjectHeader } from "@/components/project/project-header";
import { TaskTemplatesProvider } from "@/components/project/task-templates-context";
import { getProject, getProjectRole, listProjectViews, listTaskTemplates } from "@/lib/data";
import { isUuid } from "@/lib/ids";

// Non-members get a plain 404: RLS hides the project row, so nothing about it is revealed.
export default async function ProjectLayout({
  children,
  params,
}: LayoutProps<"/projects/[projectId]">) {
  const { projectId } = await params;
  if (!isUuid(projectId)) notFound();
  const [project, views, role, taskTemplates] = await Promise.all([
    getProject(projectId),
    listProjectViews(projectId),
    getProjectRole(projectId),
    listTaskTemplates(projectId),
  ]);
  if (!project || !role) notFound();

  return (
    <ProjectAccessProvider role={role}>
      <TaskTemplatesProvider templates={taskTemplates.map(({ id, name, title }) => ({ id, name, title }))}>
        <div className="flex min-h-0 flex-1 flex-col">
          <ProjectHeader project={project} views={views} />
          {children}
        </div>
      </TaskTemplatesProvider>
    </ProjectAccessProvider>
  );
}
