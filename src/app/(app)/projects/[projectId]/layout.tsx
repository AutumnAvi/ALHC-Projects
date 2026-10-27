import { notFound, redirect } from "next/navigation";
import { ArchivedProjectBanner } from "@/components/project/archived-banner";
import { ProjectAccessProvider } from "@/components/project/project-access";
import { ProjectHeader } from "@/components/project/project-header";
import { ProjectPageProvider } from "@/components/project/project-page-context";
import { RecordRecent } from "@/components/shell/shell-context";
import { TaskTemplatesProvider } from "@/components/project/task-templates-context";
import {
  getProject,
  getProjectAccessStatus,
  getProjectSectionsLocked,
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
  getProjectViewSettings,
  hasOct26Batch4Schema,
  listStatusTemplates,
  listTaskTemplates,
} from "@/lib/data";
import { isUuid } from "@/lib/ids";
import { permissionsFor } from "@/lib/permissions";
import { compareMembers, hasRole } from "@/lib/roles";
import { ruleBranchCount, triggerLabel } from "@/lib/rules";

// Non-members (Oct 26 notes, batch 3) get "You're not part of this project" with Request to be added;
// a deleted or unknown project is still a plain 404 (project_access_status says only which).
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
    viewSettings,
    batch4Schema,
    sectionsLocked,
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
      getProjectViewSettings(projectId),
      hasOct26Batch4Schema(),
      getProjectSectionsLocked(projectId),
    ]);
  if (!project || !role) {
    // A layout doesn't stop its pages from rendering, so the request page is a route of its own.
    const access = await getProjectAccessStatus(projectId);
    if (access === "missing" || access === "member") notFound();
    redirect(`/project-access/${projectId}`);
  }
  // An archived project caps every role at Viewer (role); archiving is decided by the member's own role.
  const canArchive = hasRole(ownRoles.get(projectId), "admin");
  // What the Customize panel shows (its views edit through the usual actions and pages). Oct 26 notes
  // (batch 3): below Editor there is no Customize at all (nothing in it is theirs to change), so its
  // summary isn't even sent to the browser.
  const customize = !permissionsFor(role).canEdit ? null : {
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
    // Oct 27 notes (batch 5): Owner settings (Owners only).
    owner: permissionsFor(role).isOwner ? { sectionsLocked } : null,
  };
  // The header's avatars (owners first, then by role and name); Share lists everyone.
  const headerMembers = members.map(({ profileId, name, role }) => ({ profileId, name, role })).sort(compareMembers);

  return (
    <ProjectAccessProvider role={role} sectionsLocked={sectionsLocked}>
      <TaskTemplatesProvider templates={taskTemplates.map(({ id, name, title }) => ({ id, name, title }))}>
        <ProjectPageProvider
          project={{ id: project.id, name: project.name }}
          batch4={batch4}
          archived={project.archived_at !== null}
          statusTemplates={statusTemplates}
        >
          <div className="flex min-h-0 flex-1 flex-col">
            <RecordRecent kind="project" id={project.id} />
            <ProjectHeader
              project={project}
              views={views}
              canArchive={canArchive}
              customize={customize}
              starred={starredIds.includes(project.id)}
              members={headerMembers}
              hiddenTabs={viewSettings.hiddenTabs}
              defaultViewId={viewSettings.defaultViewId}
              personalViews={batch4Schema}
            />
            <ArchivedProjectBanner canUnarchive={canArchive} />
            {children}
          </div>
        </ProjectPageProvider>
      </TaskTemplatesProvider>
    </ProjectAccessProvider>
  );
}
