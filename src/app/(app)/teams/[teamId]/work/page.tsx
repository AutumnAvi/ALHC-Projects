import { notFound } from "next/navigation";
import { FolderKanban, Plus } from "lucide-react";
import { displayName } from "@/components/avatar";
import { BrowseProjectsTable } from "@/components/projects/browse-projects-table";
import { OpenDialogButton } from "@/components/shell/open-dialog-button";
import { AddTeamProject } from "@/components/teams/add-team-project";
import { EmptyState } from "@/components/ui";
import { requireMember } from "@/lib/auth";
import {
  browseProjectPeople,
  browseProjects,
  getTeam,
  getWorkspace,
  listOwnProjectRoles,
  listProfiles,
  listReadableProjects,
  listTeams,
} from "@/lib/data";
import { projectsToAddToTeam } from "@/lib/teams";
import { requireTeamView } from "../require-team";
import { teamTitle } from "../team-title";

export async function generateMetadata({ params }: PageProps<"/teams/[teamId]/work">) {
  const { teamId } = await params;
  return teamTitle(teamId, "All work");
}

// All work: the team's projects the viewer may see, in the Browse projects table — their own, plus the
// team's public projects they can join (as an Editor). Private projects of others never show, workspace
// admins included. Create project starts in this team when the viewer can put projects in it (its
// members; anyone for the default team) — otherwise the dialog falls back to the default team. Add
// existing project (Oct 26 notes, batch 4) moves a project the viewer runs into this team.
export default async function TeamWorkPage({ params }: PageProps<"/teams/[teamId]/work">) {
  const { teamId } = await params;
  await requireTeamView(teamId);
  const [member, team, projects, people, profiles, workspace, readable, ownRoles, teams] = await Promise.all([
    requireMember(),
    getTeam(teamId),
    browseProjects(teamId),
    browseProjectPeople(teamId),
    listProfiles(),
    getWorkspace(),
    listReadableProjects(),
    listOwnProjectRoles(),
    listTeams(),
  ]);
  if (!team) notFound();
  const isMember = team.members.some((m) => m.profileId === member.id);
  const canPlace = workspace?.defaultTeamId === team.id || isMember;
  const rows = projects.map((p) => {
    const extra = people?.get(p.projectId);
    return {
      ...p,
      ownerIds: extra?.ownerIds ?? null,
      memberIds: extra?.memberIds ?? null,
      modifiedAt: extra?.modifiedAt ?? null,
    };
  });
  const joinable = projects.filter((p) => p.myRole === null && !p.archived).length;
  // The database lets a project into a team only from one of its members (or into the default team).
  const teamNames = new Map(teams.map((t) => [t.id, t.name] as const));
  const movable = canPlace
    ? projectsToAddToTeam(readable, ownRoles, team.id)
        .map((p) => ({ id: p.id, name: p.name, teamName: teamNames.get(p.team_id) ?? null, visibility: p.visibility }))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];
  const create = (
    <OpenDialogButton dialog={{ kind: "project", teamId: team.id }} className="btn-primary h-8 px-3">
      <Plus className="size-4" aria-hidden />
      Create project
    </OpenDialogButton>
  );
  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      {canPlace ? <AddTeamProject teamId={team.id} teamName={team.name} projects={movable} /> : null}
      {create}
    </div>
  );

  return (
    <div className="px-gutter py-5">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-zinc-900">All work</h2>
          <p className="text-xs text-zinc-500">
            {joinable
              ? `${team.name}’s projects you can see · ${joinable} you can join`
              : `${team.name}’s projects you can see`}
          </p>
        </div>
        {actions}
      </div>
      {rows.length === 0 ? (
        <EmptyState icon={FolderKanban} title="No projects to show" action={actions}>
          {team.name}’s projects you’re in show up here, and so do its projects shared as “Public to team”.{" "}
          {canPlace
            ? `Projects you create or add here go in ${team.name}.`
            : "Only its members can put projects in it, so one you create here goes in the default team."}
        </EmptyState>
      ) : (
        <BrowseProjectsTable
          projects={rows}
          people={profiles.map((p) => ({ id: p.id, name: displayName(p) }))}
          teams={[{ id: team.id, name: team.name }]}
          meId={member.id}
          initialTeamId={team.id}
          peopleKnown={people !== null}
        />
      )}
      <p className="mt-6 text-xs text-zinc-500">
        Private projects only appear for their members. Ask a project’s owner or admin to invite you.
      </p>
    </div>
  );
}
