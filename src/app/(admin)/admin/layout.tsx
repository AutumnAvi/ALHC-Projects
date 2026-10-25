import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { AvatarDirectoryProvider } from "@/components/avatar-face";
import { AdminTopBar } from "@/components/admin/admin-chrome";
import { AdminNav } from "@/components/admin/admin-nav";
import { SetupRequired } from "@/components/setup-required";
import { ShellDialogs } from "@/components/shell/shell-dialogs";
import { ShellProvider } from "@/components/shell/shell-context";
import { TimeZoneCookie } from "@/components/shell/time-zone-cookie";
import { ToastProvider } from "@/components/toast";
import { TooltipLayer } from "@/components/tooltip-layer";
import { requireWorkspaceAdmin } from "@/lib/admin-guard";
import { getWorkspace, listProfileAvatars } from "@/lib/data";
import { isSupabaseConfigured } from "@/lib/env";
import { SIDEBAR_COOKIE, parseSidebarPrefs } from "@/lib/sidebar-prefs";

// The Admin console (Asana parity, batch 5): a separate full page for workspace admins, outside the app
// shell — a dark bar with the way back, a left nav of sections, and the section on the right. Everyone
// else gets a 404. It manages the workspace (people, teams, settings) and never opens a private project:
// every read goes through the admin's own client and RLS, like everywhere else.
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await connection();
  if (!isSupabaseConfigured()) return <SetupRequired />;

  const member = await requireWorkspaceAdmin();
  const [workspace, cookieStore, avatars] = await Promise.all([getWorkspace(), cookies(), listProfileAvatars()]);
  const shownWorkspace = { name: workspace?.name ?? "ALHC Projects", logoUrl: workspace?.logoUrl ?? null };

  return (
    <ToastProvider>
      <AvatarDirectoryProvider avatars={avatars}>
        {/* The shell's dialogs (Create team, Invite, Settings) work here too. */}
        <ShellProvider
          member={{ id: member.id, name: member.name, email: member.email }}
          isWorkspaceAdmin
          workspace={shownWorkspace}
          initialSidebar={parseSidebarPrefs(cookieStore.get(SIDEBAR_COOKIE)?.value)}
        >
          <TimeZoneCookie />
          <div className="flex h-full flex-col">
            <AdminTopBar workspace={shownWorkspace} />
            <div className="flex min-h-0 flex-1 flex-col md:flex-row">
              <AdminNav />
              <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-white">{children}</main>
            </div>
          </div>
          <ShellDialogs />
          <TooltipLayer />
        </ShellProvider>
      </AvatarDirectoryProvider>
    </ToastProvider>
  );
}
