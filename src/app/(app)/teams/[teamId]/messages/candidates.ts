import type { Profile, Team } from "@/lib/data";

// People an @mention can reach in a team message: everyone in the workspace (everyone can read team
// messages; the database only notifies people still on the allowlist), the team's members first, never
// the viewer.
export function teamMessageCandidates(
  profiles: Profile[],
  activeIds: Set<string>,
  team: Pick<Team, "members">,
  viewerId: string,
): Profile[] {
  const members = new Set(team.members.map((m) => m.profileId));
  const name = (p: Profile) => p.full_name?.trim() || p.email;
  return profiles
    .filter((p) => p.id !== viewerId && activeIds.has(p.id))
    .sort((a, b) => Number(members.has(b.id)) - Number(members.has(a.id)) || name(a).localeCompare(name(b)));
}
