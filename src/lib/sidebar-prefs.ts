// The sidebar's remembered state (Asana parity, batch 1): hidden or shown on wide screens, and which
// groups (More, Starred, Projects) are open. Kept in one cookie so the server draws the shell exactly as
// the person left it (no flash), and written by the browser when they toggle something. Browser + server.

export const SIDEBAR_COOKIE = "alhc_sidebar";

export const SIDEBAR_GROUPS = ["more", "starred", "projects"] as const;
export type SidebarGroup = (typeof SIDEBAR_GROUPS)[number];

export type SidebarPrefs = { collapsed: boolean; groups: Record<SidebarGroup, boolean> };

export const DEFAULT_SIDEBAR_PREFS: SidebarPrefs = {
  collapsed: false,
  groups: { more: false, starred: true, projects: true },
};

// "c1.more0.starred1.projects1": short, cookie-safe, and tolerant of anything unexpected.
export function parseSidebarPrefs(value: string | undefined | null): SidebarPrefs {
  const prefs: SidebarPrefs = { collapsed: false, groups: { ...DEFAULT_SIDEBAR_PREFS.groups } };
  if (!value) return prefs;
  for (const part of value.split(".")) {
    const flag = part.slice(-1);
    const key = part.slice(0, -1);
    if (flag !== "0" && flag !== "1") continue;
    if (key === "c") prefs.collapsed = flag === "1";
    else if ((SIDEBAR_GROUPS as readonly string[]).includes(key)) prefs.groups[key as SidebarGroup] = flag === "1";
  }
  return prefs;
}

export function serializeSidebarPrefs(prefs: SidebarPrefs): string {
  return [`c${prefs.collapsed ? 1 : 0}`, ...SIDEBAR_GROUPS.map((g) => `${g}${prefs.groups[g] ? 1 : 0}`)].join(".");
}
