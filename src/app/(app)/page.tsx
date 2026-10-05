import type { Metadata } from "next";
import Link from "next/link";
import { FolderClosed } from "lucide-react";
import { NewProjectForm } from "@/components/shell/new-project-form";
import { listProjects } from "@/lib/data";

export const metadata: Metadata = { title: "Home" };

export default async function HomePage() {
  const projects = await listProjects();

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <p className="mt-1 text-sm text-zinc-600">
          Projects you’re a member of. Pick one to open it, or start a new one — you’ll be its owner.
        </p>

        <div className="mt-6 max-w-md">
          <NewProjectForm />
        </div>

        {projects.length === 0 ? (
          <div className="mt-10 rounded-xl border border-dashed border-zinc-300 px-6 py-12 text-center">
            <FolderClosed className="mx-auto size-8 text-zinc-300" />
            <h2 className="mt-3 text-sm font-medium text-zinc-900">No projects yet</h2>
            <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-600">
              You’re not a member of any project. Create one above, or ask a project’s owner or admin to
              invite you. New projects start with “To do”, “In progress”, and “Done” sections.
            </p>
          </div>
        ) : (
          <ul className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
              <li key={project.id}>
                <Link
                  href={`/projects/${project.id}`}
                  className="flex h-full flex-col rounded-xl border border-zinc-200 bg-white p-4 transition hover:border-zinc-300 hover:shadow-sm"
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-zinc-900">
                    <FolderClosed className="size-4 text-zinc-400" />
                    <span className="truncate">{project.name}</span>
                  </span>
                  <span className="mt-1.5 line-clamp-2 text-sm text-zinc-500">
                    {project.description || "No description"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
