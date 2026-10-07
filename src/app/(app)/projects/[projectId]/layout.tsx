import { notFound } from "next/navigation";
import { ArchivedProjectBanner } from "@/components/project/archived-banner";
import { ProjectAccessProvider } from "@/components/project/project-access";
import { ProjectHeader } from "@/components/project/project-header";
import { TaskTemplatesProvider } from "@/components/project/task-templates-context";
import { getProject, getProjectRole, listOwnProjectRoles, listProjectViews, listTaskTemplates } from "@/lib/data";
import { isUuid } from "@/lib/ids";
import { hasRole } from "@/lib/roles";

// Non-members get a plain 404: RLS hides the project row, so nothing about it is revealed.
export default async function ProjectLayout({
  children,
  params,
}: LayoutProps<"/projects/[projectId]">) {
  const { projectId } = await params;
  if (!isUuid(projectId)) notFound();
  const [project, views, role, taskTemplates, ownRoles] = await Promise.all([
    getProject(projectId),
    listProjectViews(projectId),
    getProjectRole(projectId),
    listTaskTemplates(projectId),
    listOwnProjectRoles(),
  ]);
  if (!project || !role) notFound();
  // An archived project caps every role at Viewer (role); archiving is decided by the member's own role.
  const canArchive = hasRole(ownRoles.get(projectId), "admin");

  return (
    <ProjectAccessProvider role={role}>
      <TaskTemplatesProvider templates={taskTemplates.map(({ id, name, title }) => ({ id, name, title }))}>
        <div className="flex min-h-0 flex-1 flex-col">
          <ProjectHeader project={project} views={views} canArchive={canArchive} />
          {project.archived_at ? <ArchivedProjectBanner projectId={project.id} canUnarchive={canArchive} /> : null}
          {children}
        </div>
      </TaskTemplatesProvider>
    </ProjectAccessProvider>
  );
}
