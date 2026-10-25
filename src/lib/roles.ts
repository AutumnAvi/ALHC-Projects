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

export const ROLE_DESCRIPTIONS: Record<ProjectRole, string> = {
  owner: "Everything, including ownership and deleting the project",
  admin: "Manage members, rules, forms, and settings",
  editor: "Create and edit tasks, fields, sections, and views",
  commenter: "Read, comment, follow, and decide approvals",
  viewer: "Read only",
};

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

// Roles a member with `role` may hand out: admins up to admin, owners anything. Commenter only while the
// workspace allows it (Admin console → Security; people who already have it keep it — menus show a
// member's current role either way).
export function assignableRoles(role: ProjectRole | null | undefined, allowCommenter = true): ProjectRole[] {
  const offered = allowCommenter ? [...PROJECT_ROLES] : PROJECT_ROLES.filter((r) => r !== "commenter");
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

export const PORTFOLIO_ROLE_DESCRIPTIONS: Record<PortfolioRole, string> = {
  owner: "Everything, including ownership and deleting the portfolio",
  admin: "Invite people and change their roles",
  editor: "Rename, edit notes, and add, remove, or reorder projects",
  viewer: "Read only",
};

const PORTFOLIO_RANK: Record<PortfolioRole, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };

export function isPortfolioRole(value: unknown): value is PortfolioRole {
  return typeof value === "string" && (PORTFOLIO_ROLES as readonly string[]).includes(value);
}

export function hasPortfolioRole(role: PortfolioRole | null | undefined, min: PortfolioRole): boolean {
  return Boolean(role) && PORTFOLIO_RANK[role!] >= PORTFOLIO_RANK[min];
}

// Roles a portfolio member with `role` may hand out: admins up to admin, owners anything.
export function assignablePortfolioRoles(role: PortfolioRole | null | undefined): PortfolioRole[] {
  if (role === "owner") return [...PORTFOLIO_ROLES];
  if (role === "admin") return PORTFOLIO_ROLES.filter((r) => r !== "owner");
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
export const COMMENTER_OFF_REASON = "Turned off in this workspace. Turn on in Admin console → Security.";

// Team roles (lead / member), for the same picker on team member lists.
export const TEAM_ROLE_DESCRIPTIONS: Record<"lead" | "member", string> = {
  lead: "Manages the team: its name, members, and curated work",
  member: "Belongs to the team and sees its messages and work",
};
