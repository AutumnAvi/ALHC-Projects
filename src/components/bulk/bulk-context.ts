import "server-only";
import { displayName } from "@/components/avatar";
import { requireMember } from "@/lib/auth";
import { listMyProjectRoles, listProfiles, listProjectMembers, listProjects, listTags } from "@/lib/data";
import { hasRole } from "@/lib/roles";
import type { BulkContext } from "./bulk-bar";

// Bulk bar choices: people (everyone in the workspace; in a project, `memberIds` says who is already a
// member, so picking anyone else first asks to add them), the projects the viewer can add tasks to
// (Editor+), and the workspace's tags.
export async function listBulkContext(projectId: string | null): Promise<Omit<BulkContext, "project">> {
  const [member, members, profiles, projects, roles, tags] = await Promise.all([
    requireMember(),
    projectId ? listProjectMembers(projectId) : Promise.resolve(null),
    listProfiles(),
    listProjects(),
    listMyProjectRoles(),
    listTags(),
  ]);
  const people = profiles.map((p) => ({ id: p.id, name: displayName(p) }));
  return {
    viewerId: member.id,
    people: people.sort((a, b) => a.name.localeCompare(b.name)),
    memberIds: members ? members.map((m) => m.profileId) : undefined,
    canAddMembers: projectId ? hasRole(roles.get(projectId), "admin") : false,
    projects: projects.filter((p) => hasRole(roles.get(p.id), "editor")).map(({ id, name }) => ({ id, name })),
    tags,
  };
}
