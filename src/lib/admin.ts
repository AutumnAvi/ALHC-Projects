// The Admin console's vocabulary (Asana parity, batch 5): its sections, the Users tabs, and where the
// old Settings → Workspace pages went for workspace admins. Browser + server.

import type { MemberStatus } from "@/lib/workspace";

export const ADMIN_SECTIONS = [
  { key: "users", href: "/admin/users", label: "Users", description: "Everyone on the workspace's allowlist" },
  { key: "teams", href: "/admin/teams", label: "Teams", description: "Every team and the default team" },
  { key: "security", href: "/admin/security", label: "Security", description: "Sign-in methods and who can get in" },
  { key: "organization", href: "/admin/organization", label: "Organization", description: "Name, logo, and default team" },
  { key: "emails", href: "/admin/emails", label: "Emails", description: "How emails look" },
  { key: "email", href: "/admin/email", label: "Email delivery", description: "Sender name and deliveries" },
  { key: "tags", href: "/admin/tags", label: "Tags", description: "Workspace tags" },
] as const;
export type AdminSection = (typeof ADMIN_SECTIONS)[number]["key"];

export const ADMIN_HOME = "/admin/users";

// Users tabs: All, then each status. "Members" = signed in (active).
export const USER_TABS: { key: "all" | MemberStatus; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Members" },
  { key: "invited", label: "Invited" },
  { key: "removed", label: "Removed" },
];
export type UserTab = (typeof USER_TABS)[number]["key"];
export const isUserTab = (value: unknown): value is UserTab => USER_TABS.some((t) => t.key === value);

export const MEMBER_STATUS_LABELS: Record<MemberStatus, string> = {
  active: "Active",
  invited: "Invited",
  removed: "Removed",
};

// Settings → Workspace pages a workspace admin is sent to the Admin console from (members keep the
// read-only Settings → Workspace pages).
export const ADMIN_PATH_FOR_SETTINGS: Record<string, string> = {
  "/settings/workspace": "/admin/organization",
  "/settings/workspace/members": "/admin/users",
  "/settings/workspace/teams": "/admin/teams",
  "/settings/workspace/tags": "/admin/tags",
  "/settings/workspace/email": "/admin/email",
  "/settings/workspace/security": "/admin/security",
};
