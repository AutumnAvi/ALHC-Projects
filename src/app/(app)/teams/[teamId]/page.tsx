import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TeamDetail } from "@/components/teams/team-detail";
import { requireMember } from "@/lib/auth";
import { canManageTeam, getTeam, listGoalProgress, listGoals, listTeamProjects } from "@/lib/data";

export async function generateMetadata({ params }: PageProps<"/teams/[teamId]">): Promise<Metadata> {
  const { teamId } = await params;
  const team = await getTeam(teamId);
  return { title: team ? `${team.name} · Teams` : "Team" };
}

// A team: its members (everyone allowlisted can see them), the projects it was added to that the
// viewer can already open, and its goals. Leads and workspace admins manage it.
export default async function TeamPage({ params }: PageProps<"/teams/[teamId]">) {
  const { teamId } = await params;
  const [member, team, canManage, projects, goals, progress] = await Promise.all([
    requireMember(),
    getTeam(teamId),
    canManageTeam(teamId),
    listTeamProjects(teamId),
    listGoals(),
    listGoalProgress(),
  ]);
  if (!team) notFound();

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <TeamDetail
        key={team.id}
        team={team}
        viewerId={member.id}
        canManage={canManage}
        projects={projects}
        goals={goals.filter((g) => g.teamId === team.id)}
        progress={Object.fromEntries(progress)}
      />
    </main>
  );
}
