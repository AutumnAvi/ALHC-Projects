import { notFound } from "next/navigation";
import { TeamHeader } from "@/components/teams/team-header";
import { canManageTeam, getTeam, getWorkspace } from "@/lib/data";
import { isUuid } from "@/lib/ids";

// A team page: the header (name, "…" menu, member avatars) and the tabs Overview, Members, All work,
// Messages, and Calendar. Everyone allowlisted can open any team; a team never grants project access,
// so each tab shows only the team's projects the viewer may see.
export default async function TeamLayout({ children, params }: LayoutProps<"/teams/[teamId]">) {
  const { teamId } = await params;
  if (!isUuid(teamId)) notFound();
  const [team, canManage, workspace] = await Promise.all([getTeam(teamId), canManageTeam(teamId), getWorkspace()]);
  if (!team) notFound();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TeamHeader
        teamId={team.id}
        name={team.name}
        members={team.members.map((m) => ({ profileId: m.profileId, name: m.name }))}
        canManage={canManage}
        isDefault={workspace?.defaultTeamId === team.id}
      />
      <main className="min-h-0 flex-1 overflow-auto">{children}</main>
    </div>
  );
}
