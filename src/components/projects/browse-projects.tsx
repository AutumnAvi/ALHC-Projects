"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FolderKanban, Globe, Lock } from "lucide-react";
import { ProjectStatusBadge } from "@/components/project-status-badge";
import { useServerAction } from "@/components/toast";
import { EmptyState } from "@/components/ui";
import { joinProject } from "@/lib/actions";
import { ROLE_LABELS, isProjectRole } from "@/lib/roles";
import { VISIBILITY_LABELS, type BrowseProject } from "@/lib/workspace";

// Projects the viewer may see: their own, plus team-visible projects of their teams (Join = Editor).
// Private projects of others never reach this list.
export function BrowseProjectList({
  projects,
  groupByTeam = true,
  emptyHint,
}: {
  projects: BrowseProject[];
  groupByTeam?: boolean;
  emptyHint?: string;
}) {
  const [pending, run] = useServerAction();
  const router = useRouter();
  if (projects.length === 0) {
    return (
      <EmptyState icon={FolderKanban} title="No projects to show" size="inline">
        {emptyHint ?? "Projects you’re in and projects shared with your teams show up here."}
      </EmptyState>
    );
  }
  const groups = groupByTeam
    ? [...new Map(projects.map((p) => [p.teamId, p.teamName] as const))].map(([teamId, teamName]) => ({
        teamId,
        teamName,
        rows: projects.filter((p) => p.teamId === teamId),
      }))
    : [{ teamId: "", teamName: "", rows: projects }];

  return (
    <div className="flex flex-col gap-5">
      {groups.map((group) => (
        <section key={group.teamId || "all"} aria-label={group.teamName || "Projects"}>
          {groupByTeam ? (
            <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">
              <Link href={`/teams/${group.teamId}`} className="hover:text-zinc-900">
                {group.teamName}
              </Link>
            </h2>
          ) : null}
          <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
            {group.rows.map((p) => {
              const member = p.myRole !== null;
              return (
                <li key={p.projectId} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <span
                    aria-hidden
                    className={`ml-0.5 size-2.5 shrink-0 rounded-sm ${member ? "bg-accent-500" : "bg-zinc-300"}`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm">
                      {member ? (
                        <Link href={`/projects/${p.projectId}`} className="truncate font-medium text-zinc-900 hover:underline">
                          {p.name}
                        </Link>
                      ) : (
                        <span className="truncate font-medium text-zinc-900">{p.name}</span>
                      )}
                      {p.archived ? <span className="chip">Archived</span> : null}
                    </p>
                    <p className="truncate text-xs text-zinc-500">
                      {p.description || "No description"} · {p.memberCount} {p.memberCount === 1 ? "member" : "members"}
                    </p>
                  </div>
                  <span className="chip" title={VISIBILITY_LABELS[p.visibility]}>
                    {p.visibility === "team" ? <Globe className="size-3" aria-hidden /> : <Lock className="size-3" aria-hidden />}
                    {p.visibility === "team" ? "Team" : "Private"}
                  </span>
                  <ProjectStatusBadge status={p.status} />
                  {member ? (
                    <span className="chip w-24 justify-center bg-accent-50 text-accent-700">
                      {isProjectRole(p.myRole) ? ROLE_LABELS[p.myRole] : "Member"}
                    </span>
                  ) : p.archived ? (
                    <span className="w-24 text-center text-xs text-zinc-400">Can’t join</span>
                  ) : (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        run(async () => {
                          const result = await joinProject(p.projectId);
                          if (!result.error) router.push(`/projects/${p.projectId}`);
                          return result;
                        })
                      }
                      aria-label={`Join ${p.name}`}
                      className="btn-secondary w-24"
                    >
                      Join
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
