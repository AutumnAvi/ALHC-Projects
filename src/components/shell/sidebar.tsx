"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  Briefcase,
  CircleCheck,
  House,
  Inbox,
  LayoutTemplate,
  LogOut,
  Plus,
  Search,
  Settings,
  Target,
  Users,
} from "lucide-react";
import { Avatar } from "@/components/avatar";
import { NewPortfolioForm } from "@/components/shell/new-portfolio-form";
import { NewProjectForm } from "@/components/shell/new-project-form";
import { UnreadBadge, useUnreadCount } from "@/components/shell/unread-count";
import type { Member } from "@/lib/auth";
import { formatProgress } from "@/lib/portfolios";

type SidebarProject = { id: string; name: string };
// percent: portfolio progress over the projects the viewer can read; null = no tasks.
type SidebarPortfolio = { id: string; name: string; percent: number | null };

const NAV_LINK =
  "group/nav flex h-8 items-center gap-2 rounded-md px-2 text-sm text-zinc-700 hover:bg-zinc-200/60 aria-[current=page]:bg-zinc-200/80 aria-[current=page]:font-medium aria-[current=page]:text-zinc-900";
const SECTION_HEADING = "text-2xs font-semibold uppercase tracking-wider text-zinc-500";
const ADD_BUTTON = "rounded p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-900 aria-expanded:bg-zinc-200 aria-expanded:text-zinc-900";
const EMPTY_LINK = "flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-xs text-zinc-500 hover:bg-zinc-200/60 hover:text-zinc-900";

export function Sidebar({
  member,
  projects,
  portfolios,
  unreadCount,
}: {
  member: Member;
  projects: SidebarProject[];
  portfolios: SidebarPortfolio[];
  unreadCount: number;
}) {
  const pathname = usePathname();
  const [creating, setCreating] = useState(false);
  const [creatingPortfolio, setCreatingPortfolio] = useState(false);
  const unread = useUnreadCount(unreadCount, member.id, "sidebar");
  const links = [
    { href: "/", label: "Home", icon: House },
    { href: "/my-tasks", label: "My Tasks", icon: CircleCheck },
    { href: "/inbox", label: "Inbox", icon: Inbox },
    { href: "/goals", label: "Goals", icon: Target },
    { href: "/teams", label: "Teams", icon: Users },
    { href: "/templates", label: "Templates", icon: LayoutTemplate },
  ];

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 md:flex">
      <Link href="/" className="flex h-bar shrink-0 items-center gap-2 px-4">
        <span
          aria-hidden
          className="flex size-6 items-center justify-center rounded-md bg-zinc-900 text-xs font-semibold text-white"
        >
          A
        </span>
        <span className="text-sm font-semibold tracking-tight">ALHC Projects</span>
      </Link>

      <form action="/search" role="search" className="px-3 pb-2">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400"
            aria-hidden
          />
          <label htmlFor="sidebar-search" className="sr-only">
            Search tasks
          </label>
          <input
            id="sidebar-search"
            name="q"
            type="search"
            placeholder="Search"
            className="control w-full pl-8"
          />
        </div>
      </form>

      <nav aria-label="Primary" className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-2 pb-4">
        <ul className="flex flex-col gap-px">
          {links.map(({ href, label, icon: Icon }) => (
            <li key={href}>
              <Link
                href={href}
                aria-current={
                  pathname === href || (href !== "/" && pathname.startsWith(`${href}/`)) ? "page" : undefined
                }
                className={NAV_LINK}
              >
                <Icon className="size-4 text-zinc-500 group-aria-[current=page]/nav:text-zinc-900" />
                {label}
                {href === "/inbox" ? <UnreadBadge count={unread} /> : null}
              </Link>
            </li>
          ))}
        </ul>

        <div>
          <div className="flex h-7 items-center justify-between px-2">
            <h2 className={SECTION_HEADING}>Projects</h2>
            <button
              type="button"
              onClick={() => setCreating((v) => !v)}
              aria-label="New project"
              aria-expanded={creating}
              className={ADD_BUTTON}
            >
              <Plus className="size-4" />
            </button>
          </div>
          {creating ? (
            <div className="px-1 pb-2">
              <NewProjectForm compact onDone={() => setCreating(false)} />
            </div>
          ) : null}
          <ul className="flex flex-col gap-px">
            {projects.map((project) => {
              const active = pathname.startsWith(`/projects/${project.id}`);
              return (
                <li key={project.id}>
                  <Link
                    href={`/projects/${project.id}`}
                    aria-current={active ? "page" : undefined}
                    className={NAV_LINK}
                  >
                    <ProjectGlyph active={active} />
                    <span className="truncate">{project.name}</span>
                  </Link>
                </li>
              );
            })}
            {projects.length === 0 && !creating ? (
              <li>
                <button type="button" onClick={() => setCreating(true)} className={EMPTY_LINK}>
                  <Plus className="size-3.5" aria-hidden />
                  Create your first project
                </button>
              </li>
            ) : null}
          </ul>
        </div>

        <div>
          <div className="flex h-7 items-center justify-between px-2">
            <h2 className={SECTION_HEADING}>
              <Link href="/portfolios" className="hover:text-zinc-900">
                Portfolios
              </Link>
            </h2>
            <button
              type="button"
              onClick={() => setCreatingPortfolio((v) => !v)}
              aria-label="New portfolio"
              aria-expanded={creatingPortfolio}
              className={ADD_BUTTON}
            >
              <Plus className="size-4" />
            </button>
          </div>
          {creatingPortfolio ? (
            <div className="px-1 pb-2">
              <NewPortfolioForm compact onDone={() => setCreatingPortfolio(false)} />
            </div>
          ) : null}
          <ul className="flex flex-col gap-px">
            {portfolios.map((portfolio) => {
              const active = pathname === `/portfolios/${portfolio.id}` || pathname.startsWith(`/portfolios/${portfolio.id}/`);
              return (
                <li key={portfolio.id}>
                  <Link
                    href={`/portfolios/${portfolio.id}`}
                    aria-current={active ? "page" : undefined}
                    className={NAV_LINK}
                  >
                    <Briefcase className="size-3.5 shrink-0 text-zinc-400" />
                    <span className="min-w-0 flex-1 truncate">{portfolio.name}</span>
                    {portfolio.percent !== null ? (
                      <span className="shrink-0 text-xs tabular-nums text-zinc-500">
                        <span className="sr-only">, progress </span>
                        {formatProgress(portfolio.percent)}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
            {portfolios.length === 0 && !creatingPortfolio ? (
              <li>
                <button type="button" onClick={() => setCreatingPortfolio(true)} className={EMPTY_LINK}>
                  <Plus className="size-3.5" aria-hidden />
                  Group projects in a portfolio
                </button>
              </li>
            ) : null}
          </ul>
        </div>
      </nav>

      <div className="flex items-center gap-2 border-t border-zinc-200 px-3 py-2">
        <Avatar name={member.name} size="md" />
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-sm font-medium text-zinc-900">{member.name}</p>
          <p className="truncate text-xs text-zinc-500">{member.email}</p>
        </div>
        <Link
          href="/settings/workspace"
          aria-label="Workspace settings"
          title="Workspace settings"
          aria-current={pathname === "/settings/workspace" ? "page" : undefined}
          className="btn-icon hover:bg-zinc-200 aria-[current=page]:bg-zinc-200 aria-[current=page]:text-zinc-900"
        >
          <Settings className="size-4" />
        </Link>
        <form action="/auth/signout" method="post">
          <button
            type="submit"
            aria-label="Sign out"
            title="Sign out"
            className="btn-icon hover:bg-zinc-200"
          >
            <LogOut className="size-4" />
          </button>
        </form>
      </div>
    </aside>
  );
}

// A small square in place of a folder icon, like Asana's project swatch; accent when the project is open.
function ProjectGlyph({ active }: { active: boolean }) {
  return (
    <span
      aria-hidden
      className={`ml-0.5 mr-0.5 size-2.5 shrink-0 rounded-sm ${active ? "bg-accent-500" : "bg-zinc-300 group-hover/nav:bg-zinc-400"}`}
    />
  );
}
