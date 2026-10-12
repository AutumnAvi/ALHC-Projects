import type { Metadata } from "next";
import Link from "next/link";
import { Plus, Users } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { OpenDialogButton } from "@/components/shell/open-dialog-button";
import { EmptyState, PageHeader } from "@/components/ui";
import { requireMember } from "@/lib/auth";
import { getWorkspace, listTeams, type Team } from "@/lib/data";

export const metadata: Metadata = { title: "Teams" };

// The workspace's team directory. Everyone allowlisted sees every team and its members; anyone can create
// one (Create team, the shell's New team dialog) and becomes its lead. Every project belongs to a team;
// team members can find and join the team's public projects (Browse projects).
export default async function TeamsPage() {
  const [member, teams, workspace] = await Promise.all([requireMember(), listTeams(), getWorkspace()]);
  const mine = teams.filter((t) => t.members.some((m) => m.profileId === member.id));
  const others = teams.filter((t) => !mine.includes(t));
  const create = (
    <OpenDialogButton dialog={{ kind: "team" }} className="btn-primary h-8 px-3">
      <Plus className="size-4" aria-hidden />
      Create team
    </OpenDialogButton>
  );

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        icon={Users}
        title="Teams"
        description="Who works together, for goals and adding people to projects in one go"
        actions={create}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-gutter py-6">
          {teams.length === 0 ? (
            <EmptyState icon={Users} title="No teams yet" action={create}>
              Create the first team, then add people by email. Teams can own goals and be added to projects together.
            </EmptyState>
          ) : (
            <div className="flex flex-col gap-8">
              {[
                { key: "mine", title: "Your teams", list: mine },
                { key: "others", title: mine.length ? "More teams" : "All teams", list: others },
              ].map(({ key, title, list }) =>
                list.length ? (
                  <section key={key} aria-labelledby={`teams-${key}`}>
                    <h2 id={`teams-${key}`} className="text-sm font-semibold text-zinc-900">
                      {title} <span className="font-normal tabular-nums text-zinc-500">· {list.length}</span>
                    </h2>
                    <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {list.map((team) => (
                        <li key={team.id}>
                          <TeamCard team={team} viewerId={member.id} isDefault={team.id === workspace?.defaultTeamId} />
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null,
              )}
            </div>
          )}
          <p className="mt-8 max-w-2xl text-xs text-zinc-500">
            Anyone can create a team and becomes its lead. Leads and workspace admins manage a team. Team members can
            find and join the team’s public projects; private projects still need an invite.
          </p>
        </div>
      </div>
    </main>
  );
}

function TeamCard({ team, viewerId, isDefault }: { team: Team; viewerId: string; isDefault: boolean }) {
  const mine = team.members.find((m) => m.profileId === viewerId);
  const leads = team.members.filter((m) => m.role === "lead").map((m) => m.name);
  const shown = team.members.slice(0, 4);
  return (
    <Link
      href={`/teams/${team.id}`}
      className="flex h-full flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-4 hover:border-zinc-300 hover:shadow-sm"
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-500 text-white">
          <Users className="size-4" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-900">{team.name}</span>
        <span className="flex shrink-0 gap-1">
          {isDefault ? <span className="chip bg-accent-50 text-accent-700">Default</span> : null}
          {mine ? <span className="chip">{mine.role === "lead" ? "You lead" : "Member"}</span> : null}
        </span>
      </span>
      <span className={`line-clamp-2 text-xs ${team.description ? "text-zinc-600" : "text-zinc-400"}`}>
        {team.description || "No description"}
      </span>
      <span className="mt-auto flex min-w-0 items-center gap-2 pt-1">
        {shown.length ? (
          <span className="flex shrink-0 -space-x-1">
            {shown.map((m) => (
              <span key={m.profileId} className="rounded-full ring-2 ring-white">
                <Avatar name={m.name} size="sm" />
              </span>
            ))}
          </span>
        ) : null}
        <span className="min-w-0 truncate text-xs text-zinc-500">
          {team.members.length} {team.members.length === 1 ? "person" : "people"}
          {leads.length ? ` · Led by ${leads.join(", ")}` : ""}
        </span>
      </span>
    </Link>
  );
}
