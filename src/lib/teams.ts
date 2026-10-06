// Team roles and the group-invite result, mirrored from 20261006050000_goals_teams.sql. A team never
// grants project access; the group invite adds ordinary project members.

export const TEAM_ROLES = ["lead", "member"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export const TEAM_ROLE_LABELS: Record<TeamRole, string> = { lead: "Lead", member: "Member" };

export function isTeamRole(value: unknown): value is TeamRole {
  return typeof value === "string" && (TEAM_ROLES as readonly string[]).includes(value);
}

// Roles a team can be added to a project with (add_team_to_project): never Owner.
export const TEAM_PROJECT_ROLES = ["admin", "editor", "commenter", "viewer"] as const;
export type TeamProjectRole = (typeof TEAM_PROJECT_ROLES)[number];

export function isTeamProjectRole(value: unknown): value is TeamProjectRole {
  return typeof value === "string" && (TEAM_PROJECT_ROLES as readonly string[]).includes(value);
}

export type TeamInvitePerson = { profileId: string; name: string };
export type TeamInviteResult = {
  added: TeamInvitePerson[];
  unchanged: TeamInvitePerson[];
  skipped: (TeamInvitePerson & { reason: string })[];
};

function people(value: unknown): (TeamInvitePerson & { reason: string })[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.profile_id !== "string") return [];
    return [
      {
        profileId: row.profile_id,
        name: typeof row.name === "string" ? row.name : "Someone",
        reason: typeof row.reason === "string" ? row.reason : "",
      },
    ];
  });
}

export function parseTeamInviteResult(value: unknown): TeamInviteResult {
  const row = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    added: people(row.added).map(({ profileId, name }) => ({ profileId, name })),
    unchanged: people(row.unchanged).map(({ profileId, name }) => ({ profileId, name })),
    skipped: people(row.skipped),
  };
}

export function describeTeamInvite(teamName: string, result: TeamInviteResult): string {
  const bits = [
    result.added.length === 1 ? "Added 1 person" : `Added ${result.added.length} people`,
    result.unchanged.length ? `${result.unchanged.length} already in the project kept their role` : null,
    result.skipped.length
      ? `skipped ${result.skipped.map((s) => `${s.name} (${s.reason || "couldn’t be added"})`).join(", ")}`
      : null,
  ].filter(Boolean);
  return `${teamName}: ${bits.join(" · ")}`;
}
