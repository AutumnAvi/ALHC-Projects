import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus, Users } from "lucide-react";
import { OpenDialogButton } from "@/components/shell/open-dialog-button";
import { EmptyState } from "@/components/ui";
import { SettingsCard } from "@/components/workspace/settings-chrome";
import { ADMIN_PATH_FOR_SETTINGS } from "@/lib/admin";
import { getWorkspace, isWorkspaceAdmin, listTeams } from "@/lib/data";

export const metadata: Metadata = { title: "Teams · Workspace settings" };

// Settings → Workspace → Teams (members): every team, which one is the default, and starting a new one
// (anyone). Workspace admins see this in Admin console → Teams.
export default async function WorkspaceTeamsPage() {
  if (await isWorkspaceAdmin()) redirect(ADMIN_PATH_FOR_SETTINGS["/settings/workspace/teams"]);
  const [workspace, teams] = await Promise.all([getWorkspace(), listTeams()]);
  return (
    <>
      <SettingsCard
        id="workspace-new-team"
        title="Start a team"
        description="Every project belongs to a team. Anyone can start a team and becomes its lead; leads and workspace admins manage it."
        isAdmin={false}
      >
        <OpenDialogButton dialog={{ kind: "team" }} className="btn-primary">
          <Plus className="size-3.5" aria-hidden />
          Create team
        </OpenDialogButton>
      </SettingsCard>
      <SettingsCard
        id="workspace-teams"
        title={
          <>
            Teams <span className="font-normal text-zinc-500">· {teams.length}</span>
          </>
        }
        description="New members join the default team automatically. Workspace admins choose the default team."
        isAdmin={false}
        flush
      >
        {teams.length === 0 ? (
          <EmptyState icon={Users} title="No teams yet" size="inline">
            Start one with Create team above.
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
