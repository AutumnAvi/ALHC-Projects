import type { ReactNode } from "react";
import { connection } from "next/server";
import { MobileBar } from "@/components/shell/mobile-bar";
import { KeyboardShortcuts } from "@/components/shortcuts/keyboard-shortcuts";
import { Sidebar } from "@/components/shell/sidebar";
import { TimeZoneCookie } from "@/components/shell/time-zone-cookie";
import { SetupRequired } from "@/components/setup-required";
import { ToastProvider } from "@/components/toast";
import { requireMember } from "@/lib/auth";
import { countUnreadInbox, listPortfolioProgress, listPortfolios, listProjects } from "@/lib/data";
import { isSupabaseConfigured } from "@/lib/env";
import { progressPercent } from "@/lib/portfolios";

export default async function AppLayout({ children }: { children: ReactNode }) {
  await connection();
  if (!isSupabaseConfigured()) return <SetupRequired />;

  const member = await requireMember();
  const [projects, portfolios, progress, unreadCount] = await Promise.all([
    listProjects(),
    listPortfolios(),
    listPortfolioProgress(),
    countUnreadInbox(),
  ]);

  return (
    <ToastProvider>
      <TimeZoneCookie />
      <KeyboardShortcuts />
      {/* app-shell / app-main: the print stylesheet (globals.css) lets these flow onto paper. */}
      <div className="app-shell flex h-full">
        <Sidebar
          member={member}
          projects={projects.map(({ id, name }) => ({ id, name }))}
          portfolios={portfolios.map(({ id, name }) => {
            const counts = progress.get(id);
            return { id, name, percent: counts ? progressPercent(counts.completed, counts.total) : null };
          })}
          unreadCount={unreadCount}
        />
        <div className="app-main flex min-w-0 flex-1 flex-col">
          <MobileBar memberId={member.id} unreadCount={unreadCount} />
          {children}
        </div>
      </div>
    </ToastProvider>
  );
}
