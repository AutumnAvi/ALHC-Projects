import type { Metadata } from "next";
import Link from "next/link";
import { Users } from "lucide-react";
import { NewTeamForm } from "@/components/teams/new-team-form";
import { EmptyState } from "@/components/ui";
import { SettingsCard } from "@/components/workspace/settings-chrome";
import { getWorkspace, isWorkspaceAdmin, listTeams } from "@/lib/data";

export const metadata: Metadata = { title: "Teams · Workspace settings" };

// Settings → Workspace → Teams: every team, which one is the default, and starting a new one (anyone).
export default async function WorkspaceTeamsPage() {
  const [workspace, admin, teams] = await Promise.all([getWorkspace(), isWorkspaceAdmin(), listTeams()]);
  return (
    <>
      <SettingsCard
        id="workspace-new-team"
        title="Start a team"
        description="Every project belongs to a team. Anyone can start a team and becomes its lead; leads and workspace admins manage it."
        isAdmin={admin}
      >
        <NewTeamForm />
      </SettingsCard>
      <SettingsCard
        id="workspace-teams"
        title={
          <>
            Teams <span className="font-normal text-zinc-500">· {teams.length}</span>
          </>
        }
        description="New members join the default team automatically. Change the default on General."
        isAdmin={admin}
        flush
      >
        {teams.length === 0 ? (
          <EmptyState icon={Users} title="No teams yet" size="inline">
            Start one above.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {teams.map((team) => {
              const leads = team.members.filter((m) => m.role === "lead").map((m) => m.name);
              return (
                <li key={team.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <Users className="size-4 shrink-0 text-zinc-400" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <Link href={`/teams/${team.id}`} className="text-sm font-medium text-zinc-900 hover:underline">
                      {team.name}
                    </Link>
                    <p className="truncate text-xs text-zinc-500">
                      {team.members.length} {team.members.length === 1 ? "person" : "people"}
                      {leads.length ? ` · Led by ${leads.join(", ")}` : ""}
                    </p>
                  </div>
                  {team.id === workspace?.defaultTeamId ? <span className="chip bg-accent-50 text-accent-700">Default team</span> : null}
                  <Link href={`/projects/browse?team=${team.id}`} className="btn-ghost">
                    Projects
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </SettingsCard>
    </>
  );
}
