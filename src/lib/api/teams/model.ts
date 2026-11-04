// Big move 1: the teams area's types and pure mappers (no database access; safe to import anywhere,
// the browser included).
import type { TeamRole } from "@/lib/teams";

// ---------------------------------------------------------------------------------------------
// Teams directory (see 20261006050000_goals_teams.sql). Team names and descriptions are workspace-level:
// everyone allowlisted reads them. Since Oct 26 notes (batch 4) who is in a team is visible only inside
// it (its members and workspace admins), so other teams come back with no members. A team never grants
// project access; team_projects rows are only visible to people who can already read the project.
// ---------------------------------------------------------------------------------------------

export type TeamPerson = { profileId: string; role: TeamRole; name: string; email: string; addedAt: string };

export type Team = {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  members: TeamPerson[];
};

export type TeamRow = {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  team_members: {
    profile_id: string;
    role: string;
    created_at: string;
    deleted_at: string | null;
    profile: { email: string; full_name: string | null } | null;
  }[];
};
