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
