import type { Profile } from "@alhc/core/api/people/model";
import type { ProjectMember } from "@alhc/core/api/projects/model";

// People an @mention can reach in a project message: its members (the database only notifies people who
// can read the project), without the viewer, by name.
export function messageCandidates(members: ProjectMember[], viewerId: string): Profile[] {
  return members
    .filter((m) => m.profileId !== viewerId)
    .map((m) => ({ id: m.profileId, email: m.email, full_name: m.fullName, avatar_url: m.avatarUrl }))
    .sort((a, b) => (a.full_name ?? a.email).localeCompare(b.full_name ?? b.email));
}
