import { notFound } from "next/navigation";
import { TeamGoalsCard, TeamMembersCard } from "@/components/teams/team-cards";
import { CuratedWork, TeamDescription, type CurationCandidate } from "@/components/teams/team-overview";
import { requireMember } from "@/lib/auth";
import {
  browseProjects,
  canManageTeam,
  getTeam,
  getWorkspace,
  listGoalProgress,
  listGoals,
  listPortfolios,
  listReadableProjects,
  listTeamCuratedWork,
} from "@/lib/data";
import { isUuid } from "@/lib/ids";
import { teamTabHref, type CuratedWorkItem } from "@/lib/teams";
import { teamTitle } from "./team-title";

export async function generateMetadata({ params }: PageProps<"/teams/[teamId]">) {
  const { teamId } = await params;
  return teamTitle(teamId, null);
}

// Team Overview (Asana parity, batch 5): the description and Curated work on the left, the Members and
// Goals cards on the right. Curated items show only to people who can open them (RLS), so two people
// can see different lists; nothing here grants access to a project.
export default async function TeamOverviewPage({ params }: PageProps<"/teams/[teamId]">) {
  const { teamId } = await params;
  if (!isUuid(teamId)) notFound();
  const [member, team, canManage, workspace, curated, readable, portfolios, teamProjects, goals, progress] =
    await Promise.all([
      requireMember(),
      getTeam(teamId),
      canManageTeam(teamId),
      getWorkspace(),
      listTeamCuratedWork(teamId),
      listReadableProjects(),
      listPortfolios(),
      browseProjects(teamId),
      listGoals(),
      listGoalProgress(),
    ]);
  if (!team) notFound();

  // Team members curate too (can_curate_team), not only leads and workspace admins.
  const canCurate = canManage || team.members.some((m) => m.profileId === member.id);
  // A project's status shows only once someone set it (a new project defaults to "on track").
  const statusSet = new Set(readable.filter((p) => p.status_updated_at !== null).map((p) => p.id));
  const items = curated?.map((item) => ({
    ...item,
    status: item.kind === "project" && statusSet.has(item.targetId) ? item.status : null,
  }));

  const pinned = new Set(curated?.map((item) => `${item.kind}:${item.targetId}`) ?? []);
  const candidates: CurationCandidate[] =
    canCurate && curated
      ? [
          ...readable
            .filter((p) => p.archived_at === null)
            .map((p) => ({ kind: "project" as const, id: p.id, name: p.name })),
          ...portfolios.map((p) => ({ kind: "portfolio" as const, id: p.id, name: p.name })),
        ]
          .filter((c) => !pinned.has(`${c.kind}:${c.id}`))
          .sort((a, b) => a.name.localeCompare(b.name))
      : [];

  // Without this release's migration: the team's projects the viewer is in, read-only.
  const fallback: CuratedWorkItem[] = teamProjects
    .filter((p) => p.myRole !== null)
    .sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name))
    .map((p, index) => ({
      id: `project:${p.projectId}`,
      kind: "project",
      targetId: p.projectId,
      name: p.name,
      description: p.description,
      status: statusSet.has(p.projectId) ? p.status : null,
      archived: p.archived,
      sortOrder: index,
    }));

  return (
    <div className="grid w-full gap-x-10 gap-y-8 px-gutter py-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
      <div className="flex min-w-0 flex-col gap-8">
        <TeamDescription
          teamId={team.id}
          description={team.description}
          canManage={canManage}
          isDefault={workspace?.defaultTeamId === team.id}
        />
        <CuratedWork
          teamId={team.id}
          items={items ?? null}
          fallback={fallback}
          canCurate={canCurate}
          candidates={candidates}
          workHref={teamTabHref(team.id, "work")}
        />
      </div>
      <aside className="flex min-w-0 flex-col gap-6">
        <TeamMembersCard
          members={team.members}
          viewerId={member.id}
          canManage={canManage}
          membersHref={teamTabHref(team.id, "members")}
        />
        <TeamGoalsCard teamId={team.id} goals={goals.filter((g) => g.teamId === team.id)} progress={progress} />
      </aside>
    </div>
  );
}
