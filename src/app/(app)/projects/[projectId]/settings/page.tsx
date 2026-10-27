import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { History } from "lucide-react";
import { RoleGate } from "@/components/project/project-access";
import { DependencyShiftSettings, ProjectSettings } from "@/components/project/project-settings";
import { TaskNumberingForm } from "@/components/project/task-numbering";
import { ProjectStatusForm } from "@/components/project/project-status-form";
import { ProjectStatusHistory } from "@/components/project/project-status-history";
import { ProjectTeamSettings } from "@/components/project/project-team-settings";
import {
  getDependencyShiftMode,
  getProject,
  getProjectOrigin,
  getProjectRole,
  getRequestSequence,
  listProjectFields,
  listSections,
  getWorkspace,
  listMyTeamIds,
  listProjectStatusUpdates,
  listTeams,
  type ProjectOrigin,
} from "@/lib/data";
import { hasRole } from "@/lib/roles";
import { isProjectVisibility } from "@/lib/workspace";
import { getViewerTimeZone } from "@/lib/timezone";

export async function generateMetadata({
  params,
}: PageProps<"/projects/[projectId]/settings">): Promise<Metadata> {
  const { projectId } = await params;
  const project = await getProject(projectId);
  return { title: project ? `${project.name} · Settings` : "Settings" };
}

export default async function ProjectSettingsPage({
  params,
}: PageProps<"/projects/[projectId]/settings">) {
  const { projectId } = await params;
  const [project, sequence, sections, fields, origin, timeZone, statusUpdates, workspace, teams, myTeams, shiftMode, role] = await Promise.all([
    getProject(projectId),
    getRequestSequence(projectId),
    listSections(projectId),
    listProjectFields(projectId),
    getProjectOrigin(projectId),
    getViewerTimeZone(),
    listProjectStatusUpdates(projectId),
    getWorkspace(),
    listTeams(),
    listMyTeamIds(),
    getDependencyShiftMode(projectId),
    getProjectRole(projectId),
  ]);
  if (!project) notFound();
  // The project's own team, the default team, and teams the viewer is on.
  const teamChoices = teams
    .filter((t) => t.id === project.team_id || t.id === workspace?.defaultTeamId || myTeams.has(t.id))
    .map((t) => ({ id: t.id, name: t.name, isDefault: t.id === workspace?.defaultTeamId }));

  // Status is Editor+, so it sits outside the admin-only gate below.
  return (
    <>
      {origin ? <OriginNote origin={origin} timeZone={timeZone} /> : null}
      <ProjectStatusForm project={project} />
      <ProjectStatusHistory updates={statusUpdates} />
      <div className="mx-auto max-w-3xl px-gutter pt-5">
        <TaskNumberingForm
          projectId={project.id}
          sequence={sequence}
          sections={sections.map((section) => ({ id: section.id, name: section.name }))}
          fields={fields}
        />
      </div>
      {/* Oct 27 notes (batch 6): Admin+ by their own role (archived projects cap everyone at Viewer). */}
      <div className="mx-auto max-w-3xl px-gutter pt-5">
        <DependencyShiftSettings projectId={project.id} mode={shiftMode} canEdit={hasRole(role, "admin")} />
      </div>
      <RoleGate need="admin" what="project settings">
        <ProjectTeamSettings
          projectId={project.id}
          teamId={project.team_id}
          visibility={isProjectVisibility(project.visibility) ? project.visibility : "private"}
          teams={teamChoices}
        />
        <ProjectSettings project={project} />
      </RoleGate>
    </>
  );
}

// The project story written by the copy engine (Duplicate project / Use template).
function OriginNote({ origin, timeZone }: { origin: ProjectOrigin; timeZone: string }) {
  const when = new Date(origin.createdAt).toLocaleDateString("en-US", { timeZone, dateStyle: "medium" });
  const from = origin.fromName ?? (origin.kind === "duplicated" ? "another project" : "a template");
  return (
    <div className="mx-auto max-w-3xl px-gutter pt-5">
      <p className="flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
        <History className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
        <span>
          {origin.kind === "duplicated" ? "Duplicated from " : "Created from the template "}
          {origin.kind === "duplicated" && origin.fromProjectId ? (
            <Link href={`/projects/${origin.fromProjectId}`} className="font-medium text-zinc-800 hover:underline">
              {from}
            </Link>
          ) : (
            <span className="font-medium text-zinc-800">{from}</span>
          )}
          {origin.actorName ? ` by ${origin.actorName}` : ""} on {when}. Copied rules started turned off.
        </span>
      </p>
    </div>
  );
}
