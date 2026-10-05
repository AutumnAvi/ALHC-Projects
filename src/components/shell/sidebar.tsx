"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { FolderClosed, House, LogOut, Plus } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { NewProjectForm } from "@/components/shell/new-project-form";
import type { Member } from "@/lib/auth";

type SidebarProject = { id: string; name: string };

export function Sidebar({ member, projects }: { member: Member; projects: SidebarProject[] }) {
  const pathname = usePathname();
  const [creating, setCreating] = useState(false);

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 md:flex">
      <div className="flex h-14 items-center gap-2.5 px-4">
        <span
          aria-hidden
          className="flex size-7 items-center justify-center rounded-md bg-zinc-900 text-xs font-semibold text-white"
        >
          A
        </span>
        <span className="text-sm font-semibold tracking-tight">ALHC Projects</span>
      </div>

      <nav aria-label="Primary" className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-2 pb-4">
        <Link
          href="/"
          aria-current={pathname === "/" ? "page" : undefined}
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-zinc-700 hover:bg-zinc-200/60 aria-[current=page]:bg-zinc-200/80 aria-[current=page]:font-medium aria-[current=page]:text-zinc-900"
        >
          <House className="size-4 text-zinc-500" />
          Home
        </Link>

        <div>
          <div className="flex items-center justify-between px-2 pb-1">
            <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">Projects</h2>
            <button
              type="button"
              onClick={() => setCreating((v) => !v)}
              aria-label="New project"
              aria-expanded={creating}
              className="rounded p-0.5 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900"
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
                    href={`/projects/${project.id}/list`}
                    aria-current={active ? "page" : undefined}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-zinc-700 hover:bg-zinc-200/60 aria-[current=page]:bg-zinc-200/80 aria-[current=page]:font-medium aria-[current=page]:text-zinc-900"
                  >
                    <FolderClosed className="size-4 shrink-0 text-zinc-400" />
                    <span className="truncate">{project.name}</span>
                  </Link>
                </li>
              );
            })}
            {projects.length === 0 && !creating ? (
              <li className="px-2 py-1 text-xs text-zinc-500">No projects yet.</li>
            ) : null}
          </ul>
        </div>
      </nav>

      <div className="flex items-center gap-2 border-t border-zinc-200 px-3 py-3">
        <Avatar name={member.name} size="md" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-zinc-900">{member.name}</p>
          <p className="truncate text-xs text-zinc-500">{member.email}</p>
        </div>
        <form action="/auth/signout" method="post">
          <button
            type="submit"
            aria-label="Sign out"
            title="Sign out"
            className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900"
          >
            <LogOut className="size-4" />
          </button>
        </form>
      </div>
    </aside>
  );
}
