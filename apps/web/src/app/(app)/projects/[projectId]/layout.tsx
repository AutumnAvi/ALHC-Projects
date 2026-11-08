import { notFound, redirect } from "next/navigation";
import { ArchivedProjectBanner } from "@/components/project/archived-banner";
import { ProjectAccessProvider } from "@/components/project/project-access";
import { ProjectHeader } from "@/components/project/project-header";
import { ProjectPageProvider } from "@/components/project/project-page-context";
import { RecordRecent } from "@/components/shell/shell-context";
import { TaskTemplatesProvider } from "@/components/project/task-templates-context";
import { getProjectAccessStatus } from "@/lib/data";
import { loadAppShell, loadProjectFrame } from "@/lib/screen-loaders";
import { isUuid } from "@alhc/core/ids";
import { projectTabList } from "@alhc/core/views";
import { permissionsFor } from "@alhc/core/permissions";
import { compareMembers, hasRole } from "@alhc/core/roles";
import { ruleBranchCount, triggerLabel } from "@alhc/core/rules";

// Non-members (Oct 26 notes, batch 3) get "You're not part of this project" with Request to be added;
// a deleted or unknown project is still a plain 404 (project_access_status says only which).
export default async function ProjectLayout({
  children,
  params,
}: LayoutProps<"/projects/[projectId]">) {
  const { projectId } = await params;
  if (!isUuid(projectId)) notFound();
  // Nov 4 notes (batch 22, M1): the whole project frame in one call (project_frame), next to the app
  // shell the app layout reads anyway (stars, the person's own roles).
  const [frame, shell] = await Promise.all([loadProjectFrame(projectId), loadAppShell()]);
  const {
    project,
    views,
    role,
    taskTemplates,
    fields,
    forms,
    rules,
    members,
    sections,
    statusTemplates,
    numbering,
    viewSettings,
    sectionsLocked,
    fieldSharing,
  } = frame;
  const ownRoles = shell.ownRoles;
  const starredIds = shell.starIds;
  if (!project || !role) {
    // A layout doesn't stop its pages from rendering, so the request page is a route of its own.
    const access = frame.accessStatus ?? (await getProjectAccessStatus(projectId));
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
    statusTemplates,
    statusTemplatesAvailable: true,
    numbering,
    sections: sections.map((section) => ({ id: section.id, name: section.name })),
    // Oct 27 notes (batch 5): Owner settings (Owners only).
    owner: permissionsFor(role).isOwner ? { sectionsLocked } : null,
    // Nov 2 notes (batch 15, 117): every tab, to hide or show (Editors+; batch 4's settings table).
    tabs: projectTabList(views, viewSettings),
  };
  // The header's avatars (owners first, then by role and name); Share lists everyone.
  const headerMembers = members.map(({ profileId, name, role }) => ({ profileId, name, role })).sort(compareMembers);

  return (
    <ProjectAccessProvider role={role} sectionsLocked={sectionsLocked}>
      <TaskTemplatesProvider templates={taskTemplates.map(({ id, name, title }) => ({ id, name, title }))}>
        <ProjectPageProvider
          project={{ id: project.id, name: project.name }}
          batch4
          archived={project.archived_at !== null}
          statusTemplates={statusTemplates}
          fieldSharing={fieldSharing}
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
              hiddenViewIds={viewSettings.hiddenViewIds ?? []}
              defaultViewId={viewSettings.defaultViewId}
              personalViews
            />
            <ArchivedProjectBanner canUnarchive={canArchive} />
            {children}
          </div>
        </ProjectPageProvider>
      </TaskTemplatesProvider>
    </ProjectAccessProvider>
  );
}
