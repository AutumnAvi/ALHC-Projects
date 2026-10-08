import type { Metadata } from "next";
import Link from "next/link";
import { Compass } from "lucide-react";
import { BrowseProjectList } from "@/components/projects/browse-projects";
import { PageHeader } from "@/components/ui";
import { requireMember } from "@/lib/auth";
import { browseProjects, listTeams } from "@/lib/data";
import { isUuid } from "@/lib/ids";

export const metadata: Metadata = { title: "Browse projects" };

// Every project the viewer is allowed to see: their own, plus projects shared with their teams (Join
// makes them an Editor). Private projects stay hidden from everyone who isn't a member, workspace
// admins included. ?team=<id> narrows to one team.
export default async function BrowseProjectsPage({ searchParams }: PageProps<"/projects/browse">) {
  const params = await searchParams;
  const teamId = typeof params.team === "string" && isUuid(params.team) ? params.team : null;
  const [member, projects, teams] = await Promise.all([requireMember(), browseProjects(teamId), listTeams()]);
  const myTeams = teams.filter((t) => t.members.some((m) => m.profileId === member.id));
  const team = teamId ? teams.find((t) => t.id === teamId) : null;
  const joinable = projects.filter((p) => p.myRole === null && !p.archived).length;

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        icon={Compass}
        title="Browse projects"
        description={
          joinable
            ? `${joinable} ${joinable === 1 ? "project" : "projects"} you can join`
            : "Your projects and the ones shared with your teams"
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-gutter py-5">
          <nav aria-label="Filter by team" className="mb-4 flex flex-wrap gap-1.5">
            <Link href="/projects/browse" aria-current={!teamId ? "page" : undefined} className="chip px-2 py-0.5 hover:bg-zinc-200 aria-[current=page]:bg-zinc-900 aria-[current=page]:text-white">
              All teams
            </Link>
            {myTeams.map((t) => (
              <Link
                key={t.id}
                href={`/projects/browse?team=${t.id}`}
                aria-current={teamId === t.id ? "page" : undefined}
                className="chip px-2 py-0.5 hover:bg-zinc-200 aria-[current=page]:bg-zinc-900 aria-[current=page]:text-white"
              >
                {t.name}
              </Link>
            ))}
          </nav>
          <BrowseProjectList
            projects={projects}
            groupByTeam={!teamId}
            emptyHint={
              team
                ? `Nothing in ${team.name} you can see yet. Projects set to “Public to team” appear here for everyone on the team.`
                : "Projects you’re in, and projects set to “Public to team” in your teams, show up here."
            }
          />
          <p className="mt-6 text-xs text-zinc-500">
            Private projects only appear for their members. Ask a project’s owner or admin to invite you.
          </p>
        </div>
      </div>
    </main>
  );
}
