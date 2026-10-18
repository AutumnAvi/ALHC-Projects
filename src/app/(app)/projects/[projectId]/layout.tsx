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
  hasBatch4Schema,
  hasReal4Schema,
  listOwnProjectRoles,
  listProjectFields,
  listProjectForms,
  listProjectMembers,
  listProjectRules,
  listProjectViews,
  listSections,
  listStarredProjectIds,
  getRequestSequence,
  listStatusTemplates,
  listTaskTemplates,
} from "@/lib/data";
import { isUuid } from "@/lib/ids";
import { compareMembers, hasRole } from "@/lib/roles";
import { ruleBranchCount, triggerLabel } from "@/lib/rules";

// Non-members get a plain 404: RLS hides the project row, so nothing about it is revealed.
export default async function ProjectLayout({
  children,
  params,
}: LayoutProps<"/projects/[projectId]">) {
  const { projectId } = await params;
  if (!isUuid(projectId)) notFound();
  const [
    project,
    views,
    role,
    taskTemplates,
    ownRoles,
    fields,
    forms,
    rules,
    starredIds,
    members,
    sections,
    batch4,
    real4,
    statusTemplates,
    numbering,
  ] = await Promise.all([
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
      listSections(projectId),
      hasBatch4Schema(),
      hasReal4Schema(),
      listStatusTemplates(projectId),
      getRequestSequence(projectId),
    ]);
  if (!project || !role) notFound();
  // An archived project caps every role at Viewer (role); archiving is decided by the member's own role.
  const canArchive = hasRole(ownRoles.get(projectId), "admin");
  // What the Customize panel shows (its views edit through the usual actions and pages).
  const customize = {
    fields,
    sectionNames: sections.map((s) => s.name),
    forms: forms.map((f) => ({ id: f.id, title: f.title, open: f.acceptingResponses, sendsConfirmation: f.sendConfirmation })),
    rules: rules.map((r) => ({
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      trigger: triggerLabel(r.triggerType),
      actionTypes: [...new Set(r.actions.map((a) => a.type))],
      branches: ruleBranchCount(r),
    })),
    taskTemplates: taskTemplates.map(({ id, name, title }) => ({ id, name, title })),
    statusTemplates,
    statusTemplatesAvailable: real4,
    numbering,
    sections: sections.map((section) => ({ id: section.id, name: section.name })),
  };
  // The header's avatars (owners first, then by role and name); Share lists everyone.
  const headerMembers = members.map(({ profileId, name, role }) => ({ profileId, name, role })).sort(compareMembers);

  return (
    <ProjectAccessProvider role={role}>
      <TaskTemplatesProvider templates={taskTemplates.map(({ id, name, title }) => ({ id, name, title }))}>
        <ProjectPageProvider project={{ id: project.id, name: project.name }} batch4={batch4} statusTemplates={statusTemplates}>
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
