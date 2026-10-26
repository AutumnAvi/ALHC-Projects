"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import {
  Briefcase,
  ChartColumn,
  CircleCheck,
  FolderKanban,
  House,
  Inbox,
  LayoutTemplate,
  MoreHorizontal,
  Target,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useShell } from "@/components/shell/shell-context";
import { UnreadBadge, useUnreadCount } from "@/components/shell/unread-count";
import { Group, NAV_ICON, NAV_LINK } from "@/components/shell/sidebar-group";
import { SidebarProjects, type SidebarProject } from "@/components/shell/sidebar-projects";
import type { SidebarFolderState } from "@/lib/sidebar-folders";

export type { SidebarProject };

// Sentence case everywhere, like Asana ("My tasks").
const TOP_LINKS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/", label: "Home", icon: House },
  { href: "/my-tasks", label: "My tasks", icon: CircleCheck },
  { href: "/inbox", label: "Inbox", icon: Inbox },
];
const WORK_LINKS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/projects/browse", label: "Projects", icon: FolderKanban },
  { href: "/portfolios", label: "Portfolios", icon: Briefcase },
  { href: "/goals", label: "Goals", icon: Target },
];
const MORE_LINKS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/reports", label: "Reports", icon: ChartColumn },
  { href: "/teams", label: "Teams", icon: Users },
  { href: "/templates", label: "Templates", icon: LayoutTemplate },
];

function isCurrent(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  if (href === "/projects/browse") return pathname === "/projects/browse" || pathname === "/projects/archived";
  return pathname === href || pathname.startsWith(`${href}/`);
}

// The sidebar's contents, drawn in the wide-screen column and in the narrow-screen drawer.
export function SidebarContent({
  projects,
  starredIds,
  folders,
  unreadCount,
}: {
  projects: SidebarProject[];
  starredIds: string[];
  // Oct 26 notes (batch 3): the person's own sidebar folders.
  folders: SidebarFolderState;
  unreadCount: number;
}) {
  const pathname = usePathname();
  const { member, openDialog } = useShell();
  const unread = useUnreadCount(unreadCount, member.id, "sidebar");
  const moreActive = MORE_LINKS.some((l) => isCurrent(pathname, l.href));

  return (
    <>
      <nav aria-label="Primary" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 py-3">
        <ul className="flex flex-col gap-px">
          {TOP_LINKS.map((link) => (
            <li key={link.href}>
              <NavLink {...link} current={isCurrent(pathname, link.href)}>
                {link.href === "/inbox" ? <UnreadBadge count={unread} /> : null}
              </NavLink>
            </li>
          ))}
        </ul>

        <ul className="flex flex-col gap-px">
          {WORK_LINKS.map((link) => (
            <li key={link.href}>
              <NavLink {...link} current={isCurrent(pathname, link.href)} />
            </li>
          ))}
          <li>
            <Group group="more" title="More" icon={MoreHorizontal} forceOpen={moreActive} indent>
              {MORE_LINKS.map((link) => (
                <li key={link.href}>
                  <NavLink {...link} current={isCurrent(pathname, link.href)} />
                </li>
              ))}
            </Group>
          </li>
        </ul>

        <SidebarProjects projects={projects} starredIds={starredIds} folders={folders} pathname={pathname} />
      </nav>

      <div className="shrink-0 border-t border-shell-line px-3 py-3">
        <button
          type="button"
          onClick={() => openDialog({ kind: "invite" })}
          aria-haspopup="dialog"
          className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-shell-line text-sm text-shell-text hover:bg-shell-hover hover:text-white"
        >
          <UserPlus className="size-4" aria-hidden />
          Invite
        </button>
      </div>
    </>
  );
}

function NavLink({
  href,
  label,
  icon: Icon,
  current,
  children,
}: {
  href: string;
  label: string;
  icon: LucideIcon;
  current: boolean;
  children?: ReactNode;
}) {
  return (
    <Link href={href} aria-current={current ? "page" : undefined} className={NAV_LINK}>
      <Icon className={NAV_ICON} aria-hidden />
      <span className="truncate">{label}</span>
      {children}
    </Link>
  );
}
