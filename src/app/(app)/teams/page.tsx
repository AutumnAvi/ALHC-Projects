import type { Metadata } from "next";
import Link from "next/link";
import { Users } from "lucide-react";
import { NewTeamForm } from "@/components/teams/new-team-form";
import { EmptyState, PageHeader } from "@/components/ui";
import { requireMember } from "@/lib/auth";
import { listTeams } from "@/lib/data";

export const metadata: Metadata = { title: "Teams" };

// The workspace's team directory. Everyone allowlisted sees every team and its members; a team never
// grants access to projects by itself.
export default async function TeamsPage() {
  const [member, teams] = await Promise.all([requireMember(), listTeams()]);

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader icon={Users} title="Teams" description="Who works together, for goals and adding people to projects in one go" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-gutter py-6">
          <section aria-labelledby="new-team-heading" className="max-w-md">
            <h2 id="new-team-heading" className="text-sm font-semibold text-zinc-900">
              Start a team
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              Anyone can start one and becomes its lead. Leads and workspace admins manage a team. Being on a team
              doesn’t open any project: a project admin can add the whole team from the project’s Members page.
            </p>
            <div className="mt-2">
              <NewTeamForm />
            </div>
          </section>

          <h2 className="mt-8 text-sm font-semibold text-zinc-900">All teams</h2>
          {teams.length === 0 ? (
            <div className="mt-3">
              <EmptyState icon={Users} title="No teams yet">
                Create the first one above, then add people by email. Teams can own goals and be added to projects
                together.
              </EmptyState>
            </div>
          ) : (
            <ul className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {teams.map((team) => {
                const mine = team.members.find((m) => m.profileId === member.id);
                const leads = team.members.filter((m) => m.role === "lead").map((m) => m.name);
                return (
                  <li key={team.id}>
                    <Link
                      href={`/teams/${team.id}`}
                      className="flex h-full flex-col gap-1.5 rounded-lg border border-zinc-200 bg-white p-3 hover:border-zinc-300 hover:bg-zinc-50"
                    >
                      <span className="flex items-center gap-2 text-sm font-medium text-zinc-900">
                        <Users className="size-4 text-zinc-400" aria-hidden />
                        <span className="truncate">{team.name}</span>
                        {mine ? <span className="chip ml-auto">{mine.role === "lead" ? "You lead" : "Member"}</span> : null}
                      </span>
                      <span className="line-clamp-2 text-xs text-zinc-500">{team.description || "No description"}</span>
                      <span className="mt-auto truncate text-xs text-zinc-600">
                        {team.members.length} {team.members.length === 1 ? "person" : "people"}
                        {leads.length ? ` · Led by ${leads.join(", ")}` : ""}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </main>
  );
}
