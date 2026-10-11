import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { AppShell } from "@/components/shell/app-shell";
import { ShellProvider } from "@/components/shell/shell-context";
import { KeyboardShortcuts } from "@/components/shortcuts/keyboard-shortcuts";
import { TimeZoneCookie } from "@/components/shell/time-zone-cookie";
import { SetupRequired } from "@/components/setup-required";
import { ToastProvider } from "@/components/toast";
import { requireMember } from "@/lib/auth";
import { countUnreadInbox, getWorkspace, isWorkspaceAdmin, listProjects, listStarredProjectIds } from "@/lib/data";
import { isSupabaseConfigured } from "@/lib/env";
import { SIDEBAR_COOKIE, parseSidebarPrefs } from "@/lib/sidebar-prefs";

export default async function AppLayout({ children }: { children: ReactNode }) {
  await connection();
  if (!isSupabaseConfigured()) return <SetupRequired />;

  const member = await requireMember();
  const [workspace, projects, starredIds, unreadCount, admin, cookieStore] = await Promise.all([
    getWorkspace(),
    listProjects(),
    listStarredProjectIds(),
    countUnreadInbox(),
    isWorkspaceAdmin(),
    cookies(),
  ]);

  return (
    <ToastProvider>
      <ShellProvider
        member={{ id: member.id, name: member.name, email: member.email }}
        isWorkspaceAdmin={admin}
        workspace={{ name: workspace?.name ?? "ALHC Projects", logoUrl: workspace?.logoUrl ?? null }}
        initialSidebar={parseSidebarPrefs(cookieStore.get(SIDEBAR_COOKIE)?.value)}
      >
        <TimeZoneCookie />
        <KeyboardShortcuts />
        <AppShell
          projects={projects.map(({ id, name }) => ({ id, name }))}
          starredIds={starredIds}
          unreadCount={unreadCount}
        >
          {children}
        </AppShell>
      </ShellProvider>
    </ToastProvider>
  );
}
