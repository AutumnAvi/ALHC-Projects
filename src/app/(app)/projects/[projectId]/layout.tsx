import { notFound } from "next/navigation";
import { ArchivedProjectBanner } from "@/components/project/archived-banner";
import { ProjectAccessProvider } from "@/components/project/project-access";
import { ProjectHeader } from "@/components/project/project-header";
import { ProjectPageProvider } from "@/components/project/project-page-context";
import { RecordRecent } from "@/components/shell/shell-context";
import { TaskTemplatesProvider } from "@/components/project/task-templates-context";
import {
  getProject,
  getProjectRole,
  listOwnProjectRoles,
  listProjectFields,
  listProjectForms,
  listProjectMembers,
  listProjectRules,
  listProjectViews,
  listStarredProjectIds,
  listTaskTemplates,
} from "@/lib/data";
import { fieldTypeLabel } from "@/lib/fields";
import { isUuid } from "@/lib/ids";
import { compareMembers, hasRole } from "@/lib/roles";

// Non-members get a plain 404: RLS hides the project row, so nothing about it is revealed.
export default async function ProjectLayout({
  children,
  params,
}: LayoutProps<"/projects/[projectId]">) {
  const { projectId } = await params;
  if (!isUuid(projectId)) notFound();
  const [project, views, role, taskTemplates, ownRoles, fields, forms, rules, starredIds, members] = await Promise.all([
    getProject(projectId),
    listProjectViews(projectId),
    getProjectRole(projectId),
    listTaskTemplates(projectId),
    listOwnProjectRoles(),
    listProjectFields(projectId),
    listProjectForms(projectId),
    listProjectRules(projectId),
    listStarredProjectIds(),
    listProjectMembers(projectId),
  ]);
  if (!project || !role) notFound();
  // An archived project caps every role at Viewer (role); archiving is decided by the member's own role.
  const canArchive = hasRole(ownRoles.get(projectId), "admin");
  // What the Customize panel lists (names only; each links to the page that edits it).
  const customize = {
    fields: fields.map((f) => ({ id: f.id, name: f.name, type: fieldTypeLabel(f) })),
    forms: forms.map((f) => ({ id: f.id, title: f.title, open: f.acceptingResponses })),
    rules: rules.map((r) => ({ id: r.id, name: r.name, enabled: r.enabled })),
    taskTemplates: taskTemplates.map(({ id, name }) => ({ id, name })),
  };
  // The header's avatars (owners first, then by role and name); Share lists everyone.
  const headerMembers = members.map(({ profileId, name, role }) => ({ profileId, name, role })).sort(compareMembers);

  return (
    <ProjectAccessProvider role={role}>
      <TaskTemplatesProvider templates={taskTemplates.map(({ id, name, title }) => ({ id, name, title }))}>
        <ProjectPageProvider project={{ id: project.id, name: project.name }}>
          <div className="flex min-h-0 flex-1 flex-col">
            <RecordRecent kind="project" id={project.id} />
            <ProjectHeader
              project={project}
              views={views}
              canArchive={canArchive}
              customize={customize}
              starred={starredIds.includes(project.id)}
              members={headerMembers}
            />
            {project.archived_at ? <ArchivedProjectBanner projectId={project.id} canUnarchive={canArchive} /> : null}
            {children}
          </div>
        </ProjectPageProvider>
      </TaskTemplatesProvider>
    </ProjectAccessProvider>
  );
}
