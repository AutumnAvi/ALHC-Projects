import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MembersManager } from "@/components/project/members-manager";
import { requireMember } from "@/lib/auth";
import { getProject, getProjectRole, listPendingInvites, listProjectMembers, listTeams } from "@/lib/data";
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
  const [viewer, project, role, members, invites] = await Promise.all([
    requireMember(),
    getProject(projectId),
    getProjectRole(projectId),
    listProjectMembers(projectId),
    listPendingInvites("project", projectId),
  ]);
  if (!project || !role) notFound();
  // Group invite (Admin+): the team directory is workspace-wide, so any team can be added.
  const teams = hasRole(role, "admin") ? await listTeams() : [];

  return (
    <MembersManager
      projectId={projectId}
      members={members}
      viewerId={viewer.id}
      viewerRole={role}
      teams={teams.map((t) => ({ id: t.id, name: t.name, memberCount: t.members.length }))}
      invites={invites}
    />
  );
}
