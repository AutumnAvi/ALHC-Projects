"use server";

// Reads the project page loads on demand (Asana parity, batch 2): the Share dialog's people, teams, and
// access list. Runs with the signed-in person's own Supabase client, never the service role, so RLS
// decides: a non-member gets null (the project row is hidden from them), and workspace admins get
// nothing extra. Changes go through the existing actions (inviteProjectMember, addTeamToProject,
// changeProjectMemberRole, updateProjectTeam, …), which the database checks again.

import { getViewer } from "@/lib/auth";
import {
  getProject,
  getProjectRole,
  listActivePeople,
  listPendingInvites,
  listProjectMembers,
  listProjectTeamAccess,
  listTeams,
} from "@/lib/data";
import { isUuid } from "@/lib/ids";
import { compareMembers } from "@/lib/roles";
import type { ShareData } from "@/lib/project-page";
import { isProjectVisibility } from "@/lib/workspace";

export async function loadProjectShare(projectId: string): Promise<ShareData | null> {
  if (!isUuid(projectId)) return null;
  const { user, allowlisted } = await getViewer();
  if (!user || !allowlisted) return null;
  const [project, role, members, invites, teamAccess, teams, people] = await Promise.all([
    getProject(projectId),
    getProjectRole(projectId),
    listProjectMembers(projectId),
    listPendingInvites("project", projectId),
    listProjectTeamAccess(projectId),
    listTeams(),
    listActivePeople(),
  ]);
  if (!project || !role) return null;
  const teamsById = new Map(teams.map((t) => [t.id, { id: t.id, name: t.name, memberCount: t.members.length }] as const));
  return {
    viewerId: user.id,
    viewerRole: role,
    team: teamsById.get(project.team_id) ?? null,
    visibility: isProjectVisibility(project.visibility) ? project.visibility : "private",
    members: members.map(({ profileId, name, email, role }) => ({ profileId, name, email, role })).sort(compareMembers),
    invites,
    addedTeams: teamAccess.map((t) => ({
      id: t.teamId,
      name: t.name,
      memberCount: teamsById.get(t.teamId)?.memberCount ?? 0,
      role: t.role,
    })),
    people,
    teams: [...teamsById.values()],
  };
}
