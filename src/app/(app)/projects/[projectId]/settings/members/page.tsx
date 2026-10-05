import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MembersManager } from "@/components/project/members-manager";
import { requireMember } from "@/lib/auth";
import { getProject, getProjectRole, listProjectMembers } from "@/lib/data";

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
  const [viewer, project, role, members] = await Promise.all([
    requireMember(),
    getProject(projectId),
    getProjectRole(projectId),
    listProjectMembers(projectId),
  ]);
  if (!project || !role) notFound();

  return <MembersManager projectId={projectId} members={members} viewerId={viewer.id} viewerRole={role} />;
}
