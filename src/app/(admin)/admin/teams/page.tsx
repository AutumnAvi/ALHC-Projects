import type { Metadata } from "next";
import Link from "next/link";
import { Plus, UsersRound } from "lucide-react";
import { AdminPage } from "@/components/admin/admin-chrome";
import { Avatar } from "@/components/avatar";
import { OpenDialogButton } from "@/components/shell/open-dialog-button";
import { EmptyState } from "@/components/ui";
import { requireWorkspaceAdmin } from "@/lib/admin-guard";
import { getWorkspace, listTeams } from "@/lib/data";

export const metadata: Metadata = { title: "Teams · Admin console" };

// Admin console → Teams: every team in the workspace (teams are workspace-level, so everyone sees the
// same list), who leads it, how many people are in it, and which one is the default team. A team never
// opens a project by itself, so nothing here says anything about projects.
export default async function AdminTeamsPage() {
  await requireWorkspaceAdmin();
  const [workspace, teams] = await Promise.all([getWorkspace(), listTeams()]);

  return (
    <AdminPage
      title="Teams"
      description="Every team in the workspace. Anyone can start one; its leads and workspace admins manage it."
      actions={
        <OpenDialogButton dialog={{ kind: "team" }} className="btn-primary h-8">
          <Plus className="size-4" aria-hidden />
          Create team
        </OpenDialogButton>
      }
    >
      <p className="text-sm text-zinc-600">
        New members join the default team automatically, and new projects go into it unless someone picks another
        team. Change the default team in{" "}
        <Link href="/admin/organization" className="text-accent-700 hover:underline">
          Organization
        </Link>
        .
      </p>

      {teams.length === 0 ? (
        <EmptyState
          icon={UsersRound}
          title="No teams yet"
          action={
            <OpenDialogButton dialog={{ kind: "team" }} className="btn-secondary">
              <Plus className="size-3.5" aria-hidden />
              Create team
            </OpenDialogButton>
          }
        >
          Teams group the people who work together. Every project belongs to one.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200">
          <table className="w-full min-w-[40rem] border-collapse text-sm">
            <caption className="sr-only">Teams in the workspace</caption>
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs text-zinc-500">
                <th scope="col" className="px-3 py-2 font-medium">
                  Name
                </th>
                <th scope="col" className="w-40 px-3 py-2 font-medium">
                  Members
                </th>
                <th scope="col" className="w-56 px-3 py-2 font-medium">
                  Leads
                </th>
              </tr>
            </thead>
            <tbody>
              {teams.map((team) => {
                const leads = team.members.filter((m) => m.role === "lead");
                const shown = team.members.slice(0, 4);
                const count = team.members.length;
                return (
                  <tr key={team.id} className="border-b border-zinc-100 last:border-b-0 hover:bg-zinc-50">
                    <th scope="row" className="px-3 py-2 text-left font-normal">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-500">
                          <UsersRound className="size-4" />
                        </span>
                        <div className="min-w-0">
                          <p className="flex min-w-0 items-center gap-2">
                            <Link href={`/teams/${team.id}`} className="truncate font-medium text-zinc-900 hover:underline">
                              {team.name}
                            </Link>
                            {team.id === workspace?.defaultTeamId ? (
                              <span className="chip shrink-0 bg-accent-50 text-accent-700">Default</span>
                            ) : null}
                          </p>
                          {team.description ? <p className="truncate text-xs text-zinc-500">{team.description}</p> : null}
                        </div>
                      </div>
                    </th>
                    <td className="px-3 py-2">
                      {count === 0 ? (
                        <span className="text-xs text-zinc-400">No one yet</span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="flex -space-x-1" aria-hidden>
                            {shown.map((m) => (
                              <span key={m.profileId} className="rounded-full ring-2 ring-white">
                                <Avatar name={m.name} />
                              </span>
                            ))}
                          </span>
                          <span className="text-xs tabular-nums text-zinc-600">
                            {count} {count === 1 ? "person" : "people"}
                          </span>
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-zinc-600">
                      {leads.length ? (
                        <span className="line-clamp-2">{leads.map((m) => m.name).join(", ")}</span>
                      ) : (
                        <span className="text-zinc-400">No lead</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </AdminPage>
  );
}
