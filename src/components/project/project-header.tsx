"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  FileInput,
  List,
  Settings,
  SlidersHorizontal,
  SquareKanban,
  Trash2,
  Workflow,
} from "lucide-react";
import { useServerAction } from "@/components/toast";
import { deleteProject, updateProject } from "@/lib/actions";
import type { Project } from "@/lib/data";

export function ProjectHeader({ project }: { project: Project }) {
  const pathname = usePathname();
  const [pending, run] = useServerAction();
  const base = `/projects/${project.id}`;

  const tabs = [
    { href: `${base}/list`, label: "List", icon: List },
    { href: `${base}/board`, label: "Board", icon: SquareKanban },
    { href: `${base}/fields`, label: "Fields", icon: SlidersHorizontal },
    { href: `${base}/forms`, label: "Forms", icon: FileInput },
    { href: `${base}/rules`, label: "Rules", icon: Workflow },
    { href: `${base}/settings`, label: "Settings", icon: Settings },
  ];

  function saveName(value: string) {
    const name = value.trim();
    if (name && name !== project.name) run(() => updateProject(project.id, { name }));
  }

  function saveDescription(value: string) {
    if (value.trim() !== (project.description ?? "")) {
      run(() => updateProject(project.id, { description: value }));
    }
  }

  return (
    <header className="border-b border-zinc-200 px-6 pt-4">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <label htmlFor="project-name" className="sr-only">
            Project name
          </label>
          <input
            id="project-name"
            key={`name-${project.name}`}
            defaultValue={project.name}
            maxLength={200}
            onBlur={(e) => saveName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                e.currentTarget.value = project.name;
                e.currentTarget.blur();
              }
            }}
            className="-mx-1.5 w-full rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-xl font-semibold tracking-tight hover:border-zinc-200 focus:border-zinc-300 focus:outline-none"
          />
          <label htmlFor="project-description" className="sr-only">
            Project description
          </label>
          <input
            id="project-description"
            key={`desc-${project.description ?? ""}`}
            defaultValue={project.description ?? ""}
            placeholder="Add a short description"
            onBlur={(e) => saveDescription(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            className="-mx-1.5 mt-0.5 w-full rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-sm text-zinc-600 placeholder:text-zinc-400 hover:border-zinc-200 focus:border-zinc-300 focus:outline-none"
          />
        </div>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            if (window.confirm(`Delete “${project.name}”? Its tasks stay recoverable in the database.`)) {
              run(() => deleteProject(project.id));
            }
          }}
          className="mt-1 inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-zinc-500 hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
        >
          <Trash2 className="size-4" />
          <span className="sr-only sm:not-sr-only">Delete project</span>
        </button>
      </div>

      <nav aria-label="Project views" className="mt-3 flex gap-1 overflow-x-auto">
        {tabs.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className="-mb-px inline-flex items-center gap-1.5 border-b-2 border-transparent px-2.5 pb-2.5 pt-1 text-sm text-zinc-600 hover:text-zinc-900 aria-[current=page]:border-zinc-900 aria-[current=page]:font-medium aria-[current=page]:text-zinc-900"
            >
              <Icon className="size-4" />
              {label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
