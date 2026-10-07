import type { Metadata } from "next";
import Link from "next/link";
import { Archive, FolderClosed } from "lucide-react";
import { ArchivedProjectActions } from "@/components/project/archived-banner";
import { EmptyState, PageHeader } from "@/components/ui";
import { listArchivedProjects, listOwnProjectRoles } from "@/lib/data";
import { hasRole } from "@/lib/roles";

export const metadata: Metadata = { title: "Archived projects" };

// Archived projects the viewer is a member of (RLS: members only, workspace admins included).
export default async function ArchivedProjectsPage() {
  const [projects, roles] = await Promise.all([listArchivedProjects(), listOwnProjectRoles()]);

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        icon={Archive}
        title="Archived projects"
        description="Read-only projects you’re a member of, out of the sidebar, Home, and pickers"
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-gutter py-6">
          {projects.length === 0 ? (
            <EmptyState icon={Archive} title="No archived projects">
              When a project admin or owner archives a project (project … menu → Archive project), it moves here.
              It stays readable by its members, and admins can unarchive it.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200">
              {projects.map((project) => (
                <li key={project.id} className="flex min-h-row items-center gap-3 px-3 py-2">
                  <FolderClosed className="size-4 shrink-0 text-zinc-400" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <Link href={`/projects/${project.id}`} className="block truncate text-sm font-medium text-zinc-900 hover:underline">
                      {project.name}
                    </Link>
                    <span className="block text-xs text-zinc-500">
                      Archived {new Date(project.archived_at!).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                    </span>
                  </span>
                  {hasRole(roles.get(project.id), "admin") ? <ArchivedProjectActions projectId={project.id} /> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </main>
  );
}
