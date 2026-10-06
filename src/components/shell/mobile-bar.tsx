"use client";

import Link from "next/link";
import { Briefcase, CircleCheck, Inbox, LayoutTemplate, LogOut, Search } from "lucide-react";
import { useUnreadCount } from "@/components/shell/unread-count";

export function MobileBar({ memberId, unreadCount }: { memberId: string; unreadCount: number }) {
  const unread = useUnreadCount(unreadCount, memberId, "mobile");
  const iconLink = "btn-icon relative";

  return (
    <header className="flex h-bar shrink-0 items-center justify-between border-b border-zinc-200 bg-zinc-50 px-4 md:hidden">
      <Link href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
        <span
          aria-hidden
          className="flex size-6 items-center justify-center rounded-md bg-zinc-900 text-2xs text-white"
        >
          A
        </span>
        ALHC Projects
      </Link>
      <nav aria-label="Shortcuts" className="flex items-center gap-1">
        <Link href="/search" aria-label="Search" className={iconLink}>
          <Search className="size-4" />
        </Link>
        <Link href="/my-tasks" aria-label="My Tasks" className={iconLink}>
          <CircleCheck className="size-4" />
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
        <form action="/auth/signout" method="post">
          <button type="submit" aria-label="Sign out" className={iconLink}>
            <LogOut className="size-4" />
          </button>
        </form>
      </nav>
    </header>
  );
}
