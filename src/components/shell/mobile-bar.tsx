"use client";

import Link from "next/link";
import { Briefcase, ChartColumn, CircleCheck, Inbox, LayoutTemplate, LogOut, Search, Settings, Target, Users } from "lucide-react";
import { useUnreadCount } from "@/components/shell/unread-count";

export function MobileBar({ memberId, unreadCount }: { memberId: string; unreadCount: number }) {
  const unread = useUnreadCount(unreadCount, memberId, "mobile");
  const iconLink = "btn-icon relative";

  return (
    <header className="flex h-bar shrink-0 items-center justify-between gap-2 border-b border-zinc-200 bg-zinc-50 px-4 md:hidden print:hidden">
      <Link href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
        <span
          aria-hidden
          className="flex size-6 items-center justify-center rounded-md bg-zinc-900 text-2xs text-white"
        >
          A
        </span>
        {/* Ten shortcuts don't fit next to the name on a narrow phone; the logo still links home. */}
        <span className="max-[459px]:sr-only">ALHC Projects</span>
      </Link>
      <nav aria-label="Shortcuts" className="flex items-center gap-0.5">
        <Link href="/search" aria-label="Search" className={iconLink}>
          <Search className="size-4" />
        </Link>
        <Link href="/my-tasks" aria-label="My Tasks" className={iconLink}>
          <CircleCheck className="size-4" />
        </Link>
        <Link href="/reports" aria-label="Reports" className={iconLink}>
          <ChartColumn className="size-4" />
        </Link>
        <Link href="/goals" aria-label="Goals" className={iconLink}>
          <Target className="size-4" />
        </Link>
        <Link href="/teams" aria-label="Teams" className={iconLink}>
          <Users className="size-4" />
        </Link>
        <Link href="/portfolios" aria-label="Portfolios" className={iconLink}>
          <Briefcase className="size-4" />
        </Link>
        <Link href="/templates" aria-label="Templates" className={iconLink}>
          <LayoutTemplate className="size-4" />
        </Link>
        <Link
          href="/inbox"
          aria-label={unread > 0 ? `Inbox, ${unread} unread` : "Inbox"}
          className={iconLink}
        >
          <Inbox className="size-4" />
          {unread > 0 ? (
            <span
              aria-hidden
              className="absolute right-0.5 top-0.5 size-2 rounded-full bg-accent-600"
            />
          ) : null}
        </Link>
        <Link href="/settings/workspace" aria-label="Workspace settings" className={iconLink}>
          <Settings className="size-4" />
        </Link>
        <form action="/auth/signout" method="post">
          <button type="submit" aria-label="Sign out" className={iconLink}>
            <LogOut className="size-4" />
          </button>
        </form>
      </nav>
    </header>
  );
}
