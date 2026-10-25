"use server";

// Reads the project page loads on demand (Asana parity, batch 2): the Share dialog's people, teams, and
// access list. Runs with the signed-in person's own Supabase client, never the service role, so RLS
// decides: a non-member gets null (the project row is hidden from them), and workspace admins get
// nothing extra. Changes go through the existing actions (inviteProjectMember, addTeamToProject,
// changeProjectMemberRole, updateProjectTeam, …), which the database checks again.

import { getViewer } from "@/lib/auth";
import {
  getProject,
  getProjectIntegrations,
  getProjectRole,
  hasOct25Schema,
  hasReal1Schema,
  listActivePeople,
  listEmailDeliveries,
  listInboundEndpoints,
  listIntegrationDeliveries,
  listPendingInvites,
  listProjectMembers,
  listProjectTeamAccess,
  listTeams,
  commenterRoleAllowed,
} from "@/lib/data";
import { isEmailConfigured } from "@/lib/email";
import { isUuid } from "@/lib/ids";
import { compareMembers, hasRole } from "@/lib/roles";
import type { CustomizeDetails, ShareData } from "@/lib/project-page";
import { isProjectVisibility } from "@/lib/workspace";

export async function loadProjectShare(projectId: string): Promise<ShareData | null> {
  if (!isUuid(projectId)) return null;
  const { user, allowlisted } = await getViewer();
  if (!user || !allowlisted) return null;
  const [project, role, members, invites, teamAccess, teams, people, resendable, allowCommenter, defaultRoles] = await Promise.all([
    getProject(projectId),
    getProjectRole(projectId),
    listProjectMembers(projectId),
    listPendingInvites("project", projectId),
    listProjectTeamAccess(projectId),
    listTeams(),
    listActivePeople(),
    hasReal1Schema(),
    commenterRoleAllowed(),
    hasOct25Schema(),
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
    resendable: resendable && isEmailConfigured(),
    addedTeams: teamAccess.map((t) => ({
      id: t.teamId,
      name: t.name,
      memberCount: teamsById.get(t.teamId)?.memberCount ?? 0,
      role: t.role,
      usesDefaultRoles: t.usesDefaultRoles,
    })),
    people,
    teams: [...teamsById.values()],
    allowCommenter,
    defaultRoles,
  };
}

// Customize → Emails and Apps (Asana parity, batch 4): the project's Slack / webhook defaults (hints
// only), its inbound webhooks, and how many deliveries failed or wait. Admin+ by the person's own role
// (every loader below checks it again and returns null otherwise); everyone else gets admin: false.
export async function loadCustomizeDetails(projectId: string): Promise<CustomizeDetails | null> {
  if (!isUuid(projectId)) return null;
  const { user, allowlisted } = await getViewer();
  if (!user || !allowlisted) return null;
  const role = await getProjectRole(projectId);
  if (!role) return null;
  if (!hasRole(role, "admin")) return { admin: false, integrations: null, inbound: null, deliveries: null };
  const [integrations, inbound, outbound, emails] = await Promise.all([
    getProjectIntegrations(projectId),
    listInboundEndpoints(projectId),
    listIntegrationDeliveries(projectId),
    listEmailDeliveries(projectId),
  ]);
  const all = [...(outbound ?? []), ...(emails ?? [])];
  return {
    admin: true,
    integrations,
    inbound: (inbound ?? []).map((e) => ({ id: e.id, name: e.name, enabled: e.enabled })),
    deliveries: {
      failed: all.filter((d) => d.status === "failed").length,
      waiting: all.filter((d) => d.status === "pending" || d.status === "sending").length,
      emailsSent: (emails ?? []).filter((d) => d.status === "sent" || d.status === "mocked").length,
    },
  };
}
