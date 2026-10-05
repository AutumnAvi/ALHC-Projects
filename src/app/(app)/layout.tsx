import type { ReactNode } from "react";
import { connection } from "next/server";
import { MobileBar } from "@/components/shell/mobile-bar";
import { Sidebar } from "@/components/shell/sidebar";
import { TimeZoneCookie } from "@/components/shell/time-zone-cookie";
import { SetupRequired } from "@/components/setup-required";
import { ToastProvider } from "@/components/toast";
import { requireMember } from "@/lib/auth";
import { countUnreadInbox, listProjects } from "@/lib/data";
import { isSupabaseConfigured } from "@/lib/env";

export default async function AppLayout({ children }: { children: ReactNode }) {
  await connection();
  if (!isSupabaseConfigured()) return <SetupRequired />;

  const member = await requireMember();
  const [projects, unreadCount] = await Promise.all([listProjects(), countUnreadInbox()]);

  return (
    <ToastProvider>
      <TimeZoneCookie />
      <div className="flex h-full">
        <Sidebar
          member={member}
          projects={projects.map(({ id, name }) => ({ id, name }))}
          unreadCount={unreadCount}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <MobileBar memberId={member.id} unreadCount={unreadCount} />
          {children}
        </div>
      </div>
    </ToastProvider>
  );
}
