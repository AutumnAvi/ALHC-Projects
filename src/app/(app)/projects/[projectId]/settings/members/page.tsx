import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MembersManager } from "@/components/project/members-manager";
import { requireMember } from "@/lib/auth";
import { isEmailConfigured } from "@/lib/email";
import {
  commenterRoleAllowed,
  getProject,
  getProjectRole,
  hasOct25Schema,
  hasReal1Schema,
  listPendingInvites,
  listProjectMembers,
  listTeams,
  listViewableTeamIds,
} from "@/lib/data";
import { hasRole } from "@/lib/roles";

export async function generateMetadata({
  params,
}: PageProps<"/projects/[projectId]/settings/members">): Promise<Metadata> {
  const { projectId } = await params;
  const project = await getProject(projectId);
  return { title: project ? `${project.name} · Members` : "Members" };
}

export default async function ProjectMembersPage({
  params,
}: PageProps<"/projects/[projectId]/settings/members">) {
  const { projectId } = await params;
  const [viewer, project, role, members, invites, resendable, allowCommenter, defaultRoles] = await Promise.all([
    requireMember(),
    getProject(projectId),
    getProjectRole(projectId),
    listProjectMembers(projectId),
    listPendingInvites("project", projectId),
    hasReal1Schema(),
    commenterRoleAllowed(),
    hasOct25Schema(),
  ]);
  if (!project || !role) notFound();
  // Group invite (Admin+): only teams the viewer can see inside (their own; every team for a workspace
  // admin) — add_team_to_project refuses the rest since Oct 26 notes (batch 4).
  const admin = hasRole(role, "admin");
  const [teams, viewable] = await Promise.all([
    admin ? listTeams() : Promise.resolve([]),
    admin ? listViewableTeamIds() : Promise.resolve(new Set<string>()),
  ]);

  return (
    <MembersManager
      projectId={projectId}
      members={members}
      viewerId={viewer.id}
      viewerRole={role}
      teams={teams
        .filter((t) => viewable.has(t.id))
        .map((t) => ({ id: t.id, name: t.name, memberCount: t.members.length }))}
      invites={invites}
      resendable={resendable && isEmailConfigured()}
      allowCommenter={allowCommenter}
      defaultRoles={defaultRoles}
    />
  );
}
