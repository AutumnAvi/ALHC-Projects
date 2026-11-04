import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { AvatarDirectoryProvider } from "@/components/avatar-face";
import { AppShell } from "@/components/shell/app-shell";
import { ShellProvider } from "@/components/shell/shell-context";
import { TagsEnabledProvider } from "@/components/tags/tags-enabled";
import { SubtaskPrefsProvider } from "@/components/task/subtask-prefs";
import { KeyboardShortcuts } from "@/components/shortcuts/keyboard-shortcuts";
import { TimeZoneCookie } from "@/components/shell/time-zone-cookie";
import { SetupRequired } from "@/components/setup-required";
import { ToastProvider } from "@/components/toast";
import { requireMember } from "@/lib/auth";
import { loadAppShell } from "@/lib/screen-loaders";
import { isSupabaseConfigured } from "@/lib/env";
import { SIDEBAR_COOKIE, parseSidebarPrefs } from "@/lib/sidebar-prefs";

export default async function AppLayout({ children }: { children: ReactNode }) {
  await connection();
  if (!isSupabaseConfigured()) return <SetupRequired />;

  // Nov 4 notes (batch 22, M1): the person (viewer_member) and the whole frame (app_shell) in two calls
  // side by side. The shell reads through RLS, so a request turned away below simply got nothing.
  // A signed-out or removed person is sent away by requireMember (the shell's error, if any, waits).
  const [member, shellOrError, cookieStore] = await Promise.all([
    requireMember(),
    loadAppShell().catch((error: unknown) => (error instanceof Error ? error : new Error(String(error)))),
    cookies(),
  ]);
  if (shellOrError instanceof Error) throw shellOrError;
  const shell = shellOrError;
  const { workspace, projects, starIds: starredIds, unreadCount, isWorkspaceAdmin: admin, avatars, tagsEnabled: tagsOn, folders, subtaskPrefs, goalsEnabled: goalsOn } = shell;

  return (
    <ToastProvider>
      <AvatarDirectoryProvider avatars={avatars}>
        <ShellProvider
          member={{ id: member.id, name: member.name, email: member.email }}
          isWorkspaceAdmin={admin}
          workspace={{ name: workspace?.name ?? "ALHC Projects", logoUrl: shell.logoUrl }}
          goalsEnabled={goalsOn}
          initialSidebar={parseSidebarPrefs(cookieStore.get(SIDEBAR_COOKIE)?.value)}
        >
          <TagsEnabledProvider enabled={tagsOn}>
            <SubtaskPrefsProvider initial={subtaskPrefs}>
              <TimeZoneCookie />
              <KeyboardShortcuts />
              <AppShell
                projects={projects.map(({ id, name }) => ({ id, name }))}
                starredIds={starredIds}
                folders={folders}
                unreadCount={unreadCount}
              >
                {children}
              </AppShell>
            </SubtaskPrefsProvider>
          </TagsEnabledProvider>
        </ShellProvider>
      </AvatarDirectoryProvider>
    </ToastProvider>
  );
}
