import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { AvatarDirectoryProvider } from "@/components/avatar-face";
import { AppShell } from "@/components/shell/app-shell";
import { ShellProvider } from "@/components/shell/shell-context";
import { TagsEnabledProvider } from "@/components/tags/tags-enabled";
import { SubtaskPrefsProvider } from "@/components/task/subtask-prefs";
import { PeopleDirectoryProvider } from "@/components/task/title-text";
import { QuickSearchDirectoryProvider } from "@/components/shell/quick-search-directory";
import { KeyboardShortcuts } from "@/components/shortcuts/keyboard-shortcuts";
import { TimeZoneCookie } from "@/components/shell/time-zone-cookie";
import { SetupRequired } from "@/components/setup-required";
import { ToastProvider } from "@/components/toast";
import { QueryProvider } from "@/components/query-provider";
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
  // Nov 4 notes (batch 27, 162): names for "@person" chips in task names.
  // Nov 12 speed batch 39 (item 5): the search palette matches projects from this list in the browser.
  const searchProjects = shell.readableProjects.map(({ id, name, archived_at }) => ({ id, name, archived_at }));
  const people = shell.profiles.map((p) => ({ id: p.id, name: p.full_name?.trim() || p.email, email: p.email }));
  const { workspace, projects, starIds: starredIds, unreadCount, isWorkspaceAdmin: admin, avatars, tagsEnabled: tagsOn, folders, subtaskPrefs, goalsEnabled: goalsOn } = shell;

  // Nov 4 notes, batch 28 (M4): the client data cache, this person's own (packages/core/src/query/).
  return (
    <QueryProvider memberId={member.id}>
      <ToastProvider>
        <AvatarDirectoryProvider avatars={avatars}>
          <ShellProvider
            member={{ id: member.id, name: member.name, email: member.email }}
            isWorkspaceAdmin={admin}
            workspace={{ name: workspace?.name ?? "ALHC Projects", logoUrl: shell.logoUrl }}
            goalsEnabled={goalsOn}
            workWeek={shell.workWeek}
            initialSidebar={parseSidebarPrefs(cookieStore.get(SIDEBAR_COOKIE)?.value)}
          >
            <TagsEnabledProvider enabled={tagsOn}>
              <SubtaskPrefsProvider initial={subtaskPrefs}>
                <PeopleDirectoryProvider people={people}>
                <QuickSearchDirectoryProvider projects={searchProjects}>
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
                </QuickSearchDirectoryProvider>
                </PeopleDirectoryProvider>
              </SubtaskPrefsProvider>
            </TagsEnabledProvider>
          </ShellProvider>
        </AvatarDirectoryProvider>
      </ToastProvider>
    </QueryProvider>
  );
}
