// Team roles and the group-invite result, mirrored from 20261006050000_goals_teams.sql. A team never
// grants project access; the group invite adds ordinary project members.
import type { RequestLabel, TaskNumber } from "@/lib/request-numbers";

import { hasRole, type ProjectRole } from "@/lib/roles";

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

// ---------------------------------------------------------------------------------------------
// The team page (Asana parity, batch 5): Overview, Members, All work, Calendar. Oct 26 notes (batch 4)
// took Messages out (its threads stay in the database; old links go to the Overview).
// ---------------------------------------------------------------------------------------------

export const TEAM_TABS = [
  { key: "overview", label: "Overview", segment: "" },
  { key: "members", label: "Members", segment: "members" },
  { key: "work", label: "All work", segment: "work" },
  { key: "calendar", label: "Calendar", segment: "calendar" },
] as const;
export type TeamTab = (typeof TEAM_TABS)[number]["key"];

export function teamTabHref(teamId: string, tab: TeamTab): string {
  const segment = TEAM_TABS.find((t) => t.key === tab)?.segment ?? "";
  return segment ? `/teams/${teamId}/${segment}` : `/teams/${teamId}`;
}

// One item of a team's Curated work (team_curated_work): a project or portfolio the viewer can open.
export type CuratedWorkItem = {
  id: string;
  kind: "project" | "portfolio";
  targetId: string;
  name: string;
  // A project's description or a portfolio's notes.
  description: string | null;
  // Projects only: their status (on_track, …) and whether they're archived.
  status: string | null;
  archived: boolean;
  sortOrder: number;
};

export const CURATED_ORDER_STEP = 1024;

// A task on the team Calendar: due in one of the team's projects the viewer is a member of.
export type TeamCalendarTask = {
  id: string;
  title: string;
  // Real features 4: the start date (on or before the due date), so a task spans its days on the
  // Calendar, and whether the viewer may drag it (Editor+ by their own role in its project).
  startOn: string | null;
  dueOn: string;
  completedAt: string | null;
  assigneeId: string | null;
  kind: string;
  projectId: string;
  projectName: string;
  canEdit: boolean;
  // Oct 26 notes (batch 4): the task's number (when its project numbers tasks), drawn as a tiny badge
  // after the name; `title` is the bare name. Since Oct 29 notes (55b) the first number the viewer can
  // read (stable order), with every number in taskNumbers for the "+N".
  requestLabel: RequestLabel | null;
  taskNumbers?: TaskNumber[];
};

// The most tasks the team Calendar loads for one period.
export const TEAM_CALENDAR_LIMIT = 1000;

// Where a curated item lands when it moves one place up (-1) or down (+1) among the items the viewer
// sees: the midpoint between its new neighbors, or a step past the end at either edge, so items hidden
// from the viewer keep their places. Null when it can't move that way.
export function curatedMoveOrder(
  items: readonly Pick<CuratedWorkItem, "sortOrder">[],
  index: number,
  delta: -1 | 1,
): number | null {
  const target = index + delta;
  if (index < 0 || target < 0 || target >= items.length) return null;
  const others = items.filter((_, i) => i !== index);
  const before = others[target - 1]?.sortOrder;
  const after = others[target]?.sortOrder;
  if (before === undefined) return after === undefined ? null : after - CURATED_ORDER_STEP;
  if (after === undefined) return before + CURATED_ORDER_STEP;
  return (before + after) / 2;
}

// The days the team Calendar shows for a month ("YYYY-MM"): whole weeks, Sunday through Saturday, from
// the week of the 1st to the week of the last day (4 to 6 weeks). Plain UTC day math, server-safe.
export function teamCalendarDays(month: string): string[] {
  const [year, m] = month.split("-").map(Number);
  const first = new Date(Date.UTC(year, m - 1, 1));
  const last = new Date(Date.UTC(year, m, 0));
  const start = Date.UTC(year, m - 1, 1 - first.getUTCDay());
  const end = Date.UTC(year, m - 1, last.getUTCDate() + 6 - last.getUTCDay());
  const days: string[] = [];
  for (let time = start; time <= end; time += 86_400_000) days.push(new Date(time).toISOString().slice(0, 10));
  return days;
}

// ---------------------------------------------------------------------------------------------
// Oct 26 notes (batch 4): teams are for their members. Mirrors 20261026020000_oct26_batch4_a.sql:
// team_access_status() says what someone outside a team sees on its link, request_team_join() asks (or
// joins the workspace's default team at once), and the team's leads and workspace admins decide on its
// Members tab (decide_team_join_request()).
// ---------------------------------------------------------------------------------------------

// "member" = can see inside (a member, or a workspace admin); "missing" = deleted or never existed (a
// real Not found). Everything else is the not-part-of-this-team page.
export const TEAM_ACCESS_STATUSES = ["member", "can_join", "can_request", "requested", "missing"] as const;
export type TeamAccessStatus = (typeof TEAM_ACCESS_STATUSES)[number];

export function parseTeamAccessStatus(value: unknown): TeamAccessStatus {
  return typeof value === "string" && (TEAM_ACCESS_STATUSES as readonly string[]).includes(value)
    ? (value as TeamAccessStatus)
    : "missing";
}

// An open request to join a team, as its Members tab lists it for the leads and workspace admins.
export type TeamJoinRequest = {
  id: string;
  profileId: string;
  name: string;
  email: string;
  requestedAt: string;
};

export type TeamJoinDecision = "approve" | "decline";

// The Members tab's add-member picker (the header's and Overview's "Add members" move focus there).
export const ADD_TEAM_MEMBER_ID = "team-member-person";

// Who the Members tab offers to add: people in the workspace who have signed in and aren't on the team
// yet, by name.
export function teamMemberCandidates<P extends { id: string; name: string }>(
  people: readonly P[],
  memberIds: Iterable<string>,
): P[] {
  const taken = new Set(memberIds);
  return people.filter((p) => !taken.has(p.id)).sort((a, b) => a.name.localeCompare(b.name));
}

// Projects someone can move into a team from its All work tab: live ones they run (Admin+ by their own
// role; an archived project is read-only for everyone) that sit in another team.
export function projectsToAddToTeam<P extends { id: string; archived_at: string | null; team_id: string }>(
  projects: readonly P[],
  ownRoles: ReadonlyMap<string, ProjectRole>,
  teamId: string,
): P[] {
  return projects.filter((p) => p.archived_at === null && p.team_id !== teamId && hasRole(ownRoles.get(p.id), "admin"));
}
