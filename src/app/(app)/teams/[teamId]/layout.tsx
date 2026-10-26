import { notFound } from "next/navigation";
import { TeamHeader } from "@/components/teams/team-header";
import { canManageTeam, getTeam, getWorkspace, listTeamJoinRequests } from "@/lib/data";
import { requireTeamView } from "./require-team";

// A team page: the header (name, "…" menu, member avatars) and the tabs Overview, Members, All work, and
// Calendar. Since Oct 26 notes (batch 4) only the team's members and workspace admins open it; everyone
// else is sent to "You're not part of this team" before anything about the team is read. A team never
// grants project access, so each tab shows only the team's projects the viewer may see.
export default async function TeamLayout({ children, params }: LayoutProps<"/teams/[teamId]">) {
  const { teamId } = await params;
  await requireTeamView(teamId);
  const [team, canManage, workspace, requests] = await Promise.all([
    getTeam(teamId),
    canManageTeam(teamId),
    getWorkspace(),
    listTeamJoinRequests(teamId),
  ]);
  if (!team) notFound();
  // People asking to join show as a count on the Members tab for those who decide (leads, workspace admins).

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TeamHeader
        teamId={team.id}
        name={team.name}
        members={team.members.map((m) => ({ profileId: m.profileId, name: m.name }))}
        canManage={canManage}
        isDefault={workspace?.defaultTeamId === team.id}
        requestCount={canManage ? requests.length : 0}
      />
      <main className="min-h-0 flex-1 overflow-auto">{children}</main>
    </div>
  );
}
