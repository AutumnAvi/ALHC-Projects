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

// Roles a member with `role` may hand out: admins up to admin, owners anything.
export function assignableRoles(role: ProjectRole | null | undefined): ProjectRole[] {
  if (role === "owner") return [...PROJECT_ROLES];
  if (role === "admin") return PROJECT_ROLES.filter((r) => r !== "owner");
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
