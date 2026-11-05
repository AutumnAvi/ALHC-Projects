import "server-only";
import { displayName } from "@/lib/people";
import { requireMember } from "@/lib/auth";
import { listMyProjectRoles, listProfiles, listProjectMembers, listProjects, listVisibleTags } from "@/lib/data";
import { hasRole } from "@/lib/roles";
import type { AppShell } from "@/lib/screen-shapes";
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
    listVisibleTags(),
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

// Nov 4 notes (batch 22, M1): the same choices from the app shell and the project frame a page already
// has (no reads of its own).
export function bulkContextFrom(
  shell: Pick<AppShell, "profiles" | "projects" | "myRoles" | "visibleTags">,
  members: { profileId: string }[] | null,
  projectId: string | null,
  viewerId: string,
): Omit<BulkContext, "project"> {
  const people = shell.profiles.map((p) => ({ id: p.id, name: displayName(p) }));
  return {
    viewerId,
    people: people.sort((a, b) => a.name.localeCompare(b.name)),
    memberIds: members ? members.map((m) => m.profileId) : undefined,
    canAddMembers: projectId ? hasRole(shell.myRoles.get(projectId), "admin") : false,
    projects: shell.projects.filter((p) => hasRole(shell.myRoles.get(p.id), "editor")).map(({ id, name }) => ({ id, name })),
    tags: shell.visibleTags,
  };
}
