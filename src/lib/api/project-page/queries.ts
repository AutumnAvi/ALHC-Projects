// Big move 1: the project page's on-demand reads (Asana parity, batch 2): the Share dialog's people,
// teams, and access list, and Customize → Emails and Apps. They run with the caller's own context (the
// signed-in person's session, never the service role), so RLS decides: a non-member gets null (the project
// row is hidden from them), and workspace admins get nothing extra. Changes go through the existing writes
// (inviteProjectMember, addTeamToProject, changeProjectMemberRole, updateProjectTeam, …), which the database
// checks again. No Next.js here.
import { getViewer } from "@/lib/api/auth/queries";
import type { ApiContext } from "@/lib/api/core/context";
import {
  getProjectIntegrations,
  listEmailDeliveries,
  listInboundEndpoints,
  listIntegrationDeliveries,
} from "@/lib/api/integrations/queries";
import { listActivePeople } from "@/lib/api/people/queries";
import {
  getProject,
  getProjectRole,
  listProjectAccessRequests,
  listProjectMembers,
  listProjectTeamAccess,
} from "@/lib/api/projects/queries";
import { listTeams, listViewableTeamIds } from "@/lib/api/teams/queries";
import { commenterRoleAllowed, listPendingInvites } from "@/lib/api/workspace/queries";
import { isUuid } from "@/lib/ids";
import type { CustomizeDetails, ShareData } from "@/lib/project-page";
import { compareMembers, hasRole } from "@/lib/roles";
import { isProjectVisibility } from "@/lib/workspace";

// `resendable`: invites can be emailed again (an email provider is set up: the adapter's isEmailConfigured()).
export async function loadProjectShare(ctx: ApiContext, projectId: string, resendable: boolean): Promise<ShareData | null> {
  if (!isUuid(projectId)) return null;
  const { user, allowlisted } = await getViewer(ctx);
  if (!user || !allowlisted) return null;
  const [project, role, members, invites, teamAccess, teams, viewable, people, allowCommenter, accessRequests] = await Promise.all([
    getProject(ctx, projectId),
    getProjectRole(ctx, projectId),
    listProjectMembers(ctx, projectId),
    listPendingInvites(ctx, "project", projectId),
    listProjectTeamAccess(ctx, projectId),
    listTeams(ctx),
    listViewableTeamIds(ctx),
    listActivePeople(ctx),
    commenterRoleAllowed(ctx),
    listProjectAccessRequests(ctx, projectId),
  ]);
  if (!project || !role) return null;
  // Oct 26 notes (batch 4): who is in a team shows only to its members and workspace admins, so other
  // teams have no member count, can't be invited (add_team_to_project refuses them), and keep their role.
  const teamsById = new Map(
    teams.map((t) => [t.id, { id: t.id, name: t.name, memberCount: viewable.has(t.id) ? t.members.length : null }] as const),
  );
  return {
    viewerId: user.id,
    viewerRole: role,
    team: teamsById.get(project.team_id) ?? null,
    visibility: isProjectVisibility(project.visibility) ? project.visibility : "private",
    members: members.map(({ profileId, name, email, role }) => ({ profileId, name, email, role })).sort(compareMembers),
    invites,
    resendable,
    addedTeams: teamAccess.map((t) => ({
      id: t.teamId,
      name: t.name,
      memberCount: teamsById.get(t.teamId)?.memberCount ?? null,
      role: t.role,
      usesDefaultRoles: t.usesDefaultRoles,
    })),
    people,
    teams: [...teamsById.values()].filter((t) => t.memberCount !== null),
    allowCommenter,
    defaultRoles: true,
    accessRequests: hasRole(role, "admin") ? accessRequests : [],
  };
}

// Customize → Emails and Apps (Asana parity, batch 4): the project's Slack / webhook defaults (hints
// only), its inbound webhooks, and how many deliveries failed or wait. Admin+ by the person's own role
// (every loader below checks it again and returns null otherwise); everyone else gets admin: false.
export async function loadCustomizeDetails(ctx: ApiContext, projectId: string): Promise<CustomizeDetails | null> {
  if (!isUuid(projectId)) return null;
  const { user, allowlisted } = await getViewer(ctx);
  if (!user || !allowlisted) return null;
  const role = await getProjectRole(ctx, projectId);
  if (!role) return null;
  if (!hasRole(role, "admin")) return { admin: false, integrations: null, inbound: null, deliveries: null };
  const [integrations, inbound, outbound, emails] = await Promise.all([
    getProjectIntegrations(ctx, projectId),
    listInboundEndpoints(ctx, projectId),
    listIntegrationDeliveries(ctx, projectId),
    listEmailDeliveries(ctx, projectId),
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
