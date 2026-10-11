"use client";

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { MAX_RECENTS, type RecentRef, type ShellDialog } from "@/lib/shell";
import { SIDEBAR_COOKIE, serializeSidebarPrefs, type SidebarGroup, type SidebarPrefs } from "@/lib/sidebar-prefs";

export type ShellMember = { id: string; name: string; email: string };

type Shell = {
  member: ShellMember;
  isWorkspaceAdmin: boolean;
  workspace: { name: string; logoUrl: string | null };
  // Sidebar: hidden or shown on wide screens, open groups (remembered in a cookie), and the drawer on
  // narrow screens (open only on the page it was opened from, so following a link closes it).
  sidebar: SidebarPrefs;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setGroupOpen: (group: SidebarGroup, open: boolean) => void;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  // The Create menu's dialogs, the Invite dialog, and Settings. Like the drawer, a dialog belongs to the
  // page it was opened on, so the redirect after a create closes it.
  dialog: ShellDialog | null;
  openDialog: (dialog: ShellDialog) => void;
  closeDialog: () => void;
};

const ShellContext = createContext<Shell | null>(null);

export function ShellProvider({
  member,
  isWorkspaceAdmin,
  workspace,
  initialSidebar,
  children,
}: {
  member: ShellMember;
  isWorkspaceAdmin: boolean;
  workspace: { name: string; logoUrl: string | null };
  initialSidebar: SidebarPrefs;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [sidebar, setSidebar] = useState(initialSidebar);
  const [drawerOn, setDrawerOn] = useState<string | null>(null);
  const [dialogOn, setDialogOn] = useState<{ dialog: ShellDialog; pathname: string } | null>(null);

  const save = useCallback((next: SidebarPrefs) => {
    setSidebar(next);
    document.cookie = `${SIDEBAR_COOKIE}=${serializeSidebarPrefs(next)}; path=/; max-age=31536000; samesite=lax`;
  }, []);

  const value = useMemo<Shell>(
    () => ({
      member,
      isWorkspaceAdmin,
      workspace,
      sidebar,
      setSidebarCollapsed: (collapsed) => save({ ...sidebar, collapsed }),
      setGroupOpen: (group, open) => save({ ...sidebar, groups: { ...sidebar.groups, [group]: open } }),
      drawerOpen: drawerOn === pathname,
      setDrawerOpen: (open) => setDrawerOn(open ? pathname : null),
      dialog: dialogOn && dialogOn.pathname === pathname ? dialogOn.dialog : null,
      openDialog: (dialog) => {
        setDrawerOn(null);
        setDialogOn({ dialog, pathname });
      },
      closeDialog: () => setDialogOn(null),
    }),
    [member, isWorkspaceAdmin, workspace, sidebar, save, drawerOn, dialogOn, pathname],
  );

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell(): Shell {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("useShell() needs the app shell (ShellProvider)");
  return shell;
}

// Recently opened tasks and projects for the search palette: ids only, per person, in this browser.
// Names are looked up on the server each time (resolveRecents), so nothing stale or unreadable shows.
const recentsKey = (memberId: string) => `alhc.recents.${memberId}`;

export function readRecents(memberId: string): RecentRef[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(recentsKey(memberId)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (r): r is RecentRef =>
          !!r && typeof r === "object" && (r.kind === "task" || r.kind === "project") && typeof r.id === "string",
      )
      .slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

export function recordRecent(memberId: string, ref: RecentRef) {
  try {
    const next = [ref, ...readRecents(memberId).filter((r) => !(r.kind === ref.kind && r.id === ref.id))];
    window.localStorage.setItem(recentsKey(memberId), JSON.stringify(next.slice(0, MAX_RECENTS)));
  } catch {
    // Storage can be unavailable (private windows); recents are a convenience only.
  }
}

// Drop into a page or pane to remember that the person opened this task or project.
export function RecordRecent({ kind, id }: RecentRef) {
  const { member } = useShell();
  useEffect(() => {
    recordRecent(member.id, { kind, id });
  }, [member.id, kind, id]);
  return null;
}
