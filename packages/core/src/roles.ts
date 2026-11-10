// Project roles, mirrored from public.project_role_rank() in 20261005050000_teams_permissions.sql.
// The database is the trust boundary; the app uses these only to hide controls a role can't use.

export const PROJECT_ROLES = ["owner", "admin", "editor", "commenter", "viewer"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const ROLE_LABELS: Record<ProjectRole, string> = {
  owner: "Owner",
  admin: "Admin",
  editor: "Editor",
  commenter: "Commenter",
  viewer: "Viewer",
};

// "an Owner", "an Editor", "a Viewer" (Nov 3 notes, batch 19: the cards read "You’re a Owner"). The
// article follows the label's first sound: every role label starting with a vowel takes "an".
export function roleWithArticle(label: string): string {
  return `${/^[aeiou]/i.test(label) ? "an" : "a"} ${label}`;
}

// One plain line per role, shown under each option of the role picker (Oct 26 notes).
export const ROLE_DESCRIPTIONS: Record<ProjectRole, string> = {
  owner: "Runs the project: people, settings, automations, and every task",
  admin: "Older role: runs the project like an owner, but can’t change owners",
  editor: "Adds, changes, and completes tasks",
  commenter: "Reads and comments, but can’t change tasks",
  viewer: "Can look, but can’t change or comment",
};

// The roles the app hands out (Oct 26 notes: simpler roles): Owner, Editor, Commenter, Viewer. Admin is
// still a stored role — older memberships keep it and the database treats it as before — but nobody is
// given it any more (Owner is whoever runs the project; a project can have several).
export const OFFERED_PROJECT_ROLES = ["owner", "editor", "commenter", "viewer"] as const satisfies readonly ProjectRole[];

const RANK: Record<ProjectRole, number> = { viewer: 1, commenter: 2, editor: 3, admin: 4, owner: 5 };

export function isProjectRole(value: unknown): value is ProjectRole {
  return typeof value === "string" && (PROJECT_ROLES as readonly string[]).includes(value);
}

export function hasRole(role: ProjectRole | null | undefined, min: ProjectRole): boolean {
  return Boolean(role) && RANK[role!] >= RANK[min];
}

// Asana's member order (header avatars, Overview, Share, Members page): owners first, then admins,
// editors, commenters, viewers; by name within a role.
export function compareMembers(a: { role: ProjectRole; name: string }, b: { role: ProjectRole; name: string }) {
  return RANK[b.role] - RANK[a.role] || a.name.localeCompare(b.name);
}

// Roles a member with `role` may hand out: owners any offered role, admins any but owner. Commenter only
// while the workspace allows it (Admin console → Security; people who already have it keep it — menus
// show a member's current role either way).
export function assignableRoles(role: ProjectRole | null | undefined, allowCommenter = true): ProjectRole[] {
  const offered: ProjectRole[] = OFFERED_PROJECT_ROLES.filter((r) => allowCommenter || r !== "commenter");
  if (role === "owner") return offered;
  if (role === "admin") return offered.filter((r) => r !== "owner");
  return [];
}

// Portfolio roles, mirrored from public.portfolio_role_rank() in 20261005070000_portfolios.sql.
// Thinner than project roles (no commenter). A portfolio role never grants access to its projects.

export const PORTFOLIO_ROLES = ["owner", "admin", "editor", "viewer"] as const;
export type PortfolioRole = (typeof PORTFOLIO_ROLES)[number];

export const PORTFOLIO_ROLE_LABELS: Record<PortfolioRole, string> = {
  owner: "Owner",
  admin: "Admin",
  editor: "Editor",
  viewer: "Viewer",
};

// Nov 10 audit (C78): portfolios offer the project role set — Owner, Editor, Viewer. Admin is no longer
// given out; an existing Admin membership still shows as its current role.
export const OFFERED_PORTFOLIO_ROLES: readonly PortfolioRole[] = ["owner", "editor", "viewer"];

export const PORTFOLIO_ROLE_DESCRIPTIONS: Record<PortfolioRole, string> = {
  owner: "Everything, including members, ownership, and deleting the portfolio",
  admin: "Invites people, changes their roles, and does everything an Editor does (no longer given out)",
  editor: "Renames, edits notes, adds, removes, or reorders projects, and sets up automations",
  viewer: "Can see the portfolio, but not change it",
};

const PORTFOLIO_RANK: Record<PortfolioRole, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };

export function isPortfolioRole(value: unknown): value is PortfolioRole {
  return typeof value === "string" && (PORTFOLIO_ROLES as readonly string[]).includes(value);
}

export function hasPortfolioRole(role: PortfolioRole | null | undefined, min: PortfolioRole): boolean {
  return Boolean(role) && PORTFOLIO_RANK[role!] >= PORTFOLIO_RANK[min];
}

// Roles a portfolio member with `role` may hand out: owners any offered role, an existing Admin any but
// Owner. Admin itself is never offered (menus still show a member's current role).
export function assignablePortfolioRoles(role: PortfolioRole | null | undefined): PortfolioRole[] {
  if (role === "owner") return [...OFFERED_PORTFOLIO_ROLES];
  if (role === "admin") return OFFERED_PORTFOLIO_ROLES.filter((r) => r !== "owner");
  return [];
}

// Each person's default project role (Oct 25 notes; allowed_emails.default_project_role, null = Editor),
// used when they're added to a project with the role "default" (PERSON_DEFAULT_ROLE): directly, as a
// pending invite, or through a team. Mirrors set_default_project_role() / default_project_role_for().
export const DEFAULT_PROJECT_ROLES = ["editor", "commenter", "viewer"] as const;
export type DefaultProjectRole = (typeof DEFAULT_PROJECT_ROLES)[number];
export const PERSON_DEFAULT_ROLE = "default";

export function isDefaultProjectRole(value: unknown): value is DefaultProjectRole {
  return typeof value === "string" && (DEFAULT_PROJECT_ROLES as readonly string[]).includes(value);
}

// What "default" adds someone as: their default, Editor without one, Viewer for a Commenter default while
// the workspace's Commenter role is off.
export function effectiveDefaultRole(role: string | null | undefined, allowCommenter: boolean): DefaultProjectRole {
  const chosen = isDefaultProjectRole(role) ? role : "editor";
  return chosen === "commenter" && !allowCommenter ? "viewer" : chosen;
}

// Where the Commenter switch lives (Admin console → Security → Project roles).
export const COMMENTER_SWITCH_HREF = "/admin/security#admin-project-roles-heading";
export const COMMENTER_OFF_REASON = "Turn on in Admin console → Security";

// Team roles (lead / member), for the same picker on team member lists.
export const TEAM_ROLE_DESCRIPTIONS: Record<"lead" | "member", string> = {
  lead: "Manages the team: its name, members, and pinned projects",
  member: "Belongs to the team and can see its work",
};
