"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId, type ReactNode } from "react";
import {
  Briefcase,
  ChartColumn,
  ChevronRight,
  CircleCheck,
  FolderKanban,
  House,
  Inbox,
  LayoutTemplate,
  MoreHorizontal,
  Plus,
  Star,
  Target,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useShell } from "@/components/shell/shell-context";
import { UnreadBadge, useUnreadCount } from "@/components/shell/unread-count";
import { projectColorClass } from "@/lib/project-colors";
import type { SidebarGroup } from "@/lib/sidebar-prefs";

export type SidebarProject = { id: string; name: string };

// Dark sidebar (Asana parity, batch 1): light grey text, a lighter row for the current page.
const NAV_LINK =
  "group/nav flex h-8 items-center gap-2.5 rounded-md px-2 text-sm text-shell-text hover:bg-shell-hover hover:text-white aria-[current=page]:bg-shell-active aria-[current=page]:text-white";
const NAV_ICON = "size-4 shrink-0 text-shell-muted group-hover/nav:text-shell-text group-aria-[current=page]/nav:text-white";

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
  unreadCount,
}: {
  projects: SidebarProject[];
  starredIds: string[];
  unreadCount: number;
}) {
  const pathname = usePathname();
  const { member, openDialog } = useShell();
  const unread = useUnreadCount(unreadCount, member.id, "sidebar");
  const byId = new Map(projects.map((p) => [p.id, p] as const));
  const starred = starredIds.flatMap((id) => {
    const project = byId.get(id);
    return project ? [project] : [];
  });
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

        <Group group="starred" title="Starred">
          {starred.map((project) => (
            <li key={project.id}>
              <ProjectLink project={project} current={pathname.startsWith(`/projects/${project.id}`)} />
            </li>
          ))}
          {starred.length === 0 ? (
            <li className="flex items-start gap-2 px-2 py-1 text-xs text-shell-muted">
              <Star className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              Star a project from its header to keep it here.
            </li>
          ) : null}
        </Group>

        <Group
          group="projects"
          title="Projects"
          action={
            <button
              type="button"
              onClick={() => openDialog({ kind: "project" })}
              aria-label="New project"
              aria-haspopup="dialog"
              className="rounded p-0.5 text-shell-muted hover:bg-shell-hover hover:text-white"
            >
              <Plus className="size-4" />
            </button>
          }
        >
          {projects.map((project) => (
            <li key={project.id}>
              <ProjectLink project={project} current={pathname.startsWith(`/projects/${project.id}`)} />
            </li>
          ))}
          {projects.length === 0 ? (
            <li>
              <button
                type="button"
                onClick={() => openDialog({ kind: "project" })}
                className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-xs text-shell-muted hover:bg-shell-hover hover:text-white"
              >
                <Plus className="size-3.5" aria-hidden />
                Create your first project
              </button>
            </li>
          ) : null}
        </Group>
      </nav>

      <div className="shrink-0 border-t border-shell-line p-2">
        <button
          type="button"
          onClick={() => openDialog({ kind: "invite" })}
          aria-haspopup="dialog"
          className="flex h-8 w-full items-center justify-center gap-2 rounded-md border border-shell-line text-sm text-shell-text hover:bg-shell-hover hover:text-white"
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

function ProjectLink({ project, current }: { project: SidebarProject; current: boolean }) {
  return (
    <Link href={`/projects/${project.id}`} aria-current={current ? "page" : undefined} className={NAV_LINK} title={project.name}>
      {/* Asana's project icon: a small colored rounded square. */}
      <span aria-hidden className={`ml-0.5 size-3 shrink-0 rounded-[3px] ${projectColorClass(project.id)}`} />
      <span className="truncate">{project.name}</span>
    </Link>
  );
}

// A collapsible group (More, Starred, Projects). Open state is remembered per person in the sidebar
// cookie; a group holding the current page stays open.
function Group({
  group,
  title,
  icon: Icon,
  action,
  forceOpen = false,
  indent = false,
  children,
}: {
  group: SidebarGroup;
  title: string;
  icon?: LucideIcon;
  action?: ReactNode;
  forceOpen?: boolean;
  indent?: boolean;
  children: ReactNode;
}) {
  const { sidebar, setGroupOpen } = useShell();
  const listId = useId();
  const open = sidebar.groups[group] || forceOpen;

  return (
    <div>
      <div className="group/heading flex items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setGroupOpen(group, !open)}
          className={
            Icon
              ? `${NAV_LINK} min-w-0 flex-1 text-left`
              : "flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md px-1 text-left text-xs font-medium text-shell-muted hover:text-white"
          }
        >
          {Icon ? <Icon className={NAV_ICON} aria-hidden /> : null}
          {Icon ? <span className="flex-1 truncate">{title}</span> : null}
          <ChevronRight
            aria-hidden
            className={`size-3.5 shrink-0 text-shell-muted transition-transform ${open ? "rotate-90" : ""}`}
          />
          {Icon ? null : <span className="truncate">{title}</span>}
        </button>
        {action}
      </div>
      <ul id={listId} hidden={!open} className={`mt-px flex-col gap-px ${open ? "flex" : ""} ${indent ? "pl-3" : ""}`}>
        {children}
      </ul>
    </div>
  );
}
