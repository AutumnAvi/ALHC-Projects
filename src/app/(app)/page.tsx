import type { Metadata } from "next";
import Link from "next/link";
import { FolderClosed, House, LayoutTemplate } from "lucide-react";
import { NewProjectForm } from "@/components/shell/new-project-form";
import { EmptyState, PageHeader } from "@/components/ui";
import { listProjects } from "@/lib/data";

export const metadata: Metadata = { title: "Home" };

export default async function HomePage() {
  const projects = await listProjects();

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader icon={House} title="Home" description="Projects you’re a member of" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-gutter py-6">
          <section aria-labelledby="new-project-heading" className="max-w-md">
            <h2 id="new-project-heading" className="text-sm font-semibold text-zinc-900">
              Start a project
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              You’ll be its owner. New projects start with “To do”, “In progress”, and “Done” sections.
            </p>
            <div className="mt-2">
              <NewProjectForm />
            </div>
            <Link
              href="/templates"
              className="mt-2 inline-flex items-center gap-1.5 text-xs text-accent-700 hover:underline"
            >
              <LayoutTemplate className="size-3.5" aria-hidden />
              Or start from a template
            </Link>
          </section>

          <section aria-labelledby="projects-heading" className="mt-8">
            <div className="flex items-baseline gap-2">
              <h2 id="projects-heading" className="text-sm font-semibold text-zinc-900">
                Projects
              </h2>
              {projects.length > 0 ? (
                <span className="text-xs tabular-nums text-zinc-400">{projects.length}</span>
              ) : null}
            </div>
            {projects.length === 0 ? (
              <div className="mt-3">
                <EmptyState icon={FolderClosed} title="No projects yet">
                  Create one above, or ask a project’s owner or admin to invite you.
                </EmptyState>
              </div>
            ) : (
              <ul className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {projects.map((project) => (
                  <li key={project.id}>
                    <Link
                      href={`/projects/${project.id}`}
                      className="group flex h-full items-start gap-2.5 rounded-lg border border-zinc-200 bg-white p-3 hover:border-zinc-300 hover:bg-zinc-50"
                    >
                      <span
                        aria-hidden
                        className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent-50 text-accent-700 group-hover:bg-accent-100"
                      >
                        <FolderClosed className="size-4" />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-zinc-900">{project.name}</span>
                        <span className="mt-0.5 line-clamp-2 block text-xs text-zinc-500">
                          {project.description || "No description"}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
