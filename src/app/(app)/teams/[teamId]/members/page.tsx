import { notFound } from "next/navigation";
import { TeamMembers } from "@/components/teams/team-members";
import { requireMember } from "@/lib/auth";
import { isEmailConfigured } from "@/lib/email";
import { canManageTeam, getTeam, getWorkspace, hasReal1Schema, listPendingInvites } from "@/lib/data";
import { isUuid } from "@/lib/ids";
import { teamTitle } from "../team-title";

export async function generateMetadata({ params }: PageProps<"/teams/[teamId]/members">) {
  const { teamId } = await params;
  return teamTitle(teamId, "Members");
}

// Members (everyone allowlisted sees them) and pending invites. Leads and workspace admins add people,
// change roles, and remove them; anyone can leave.
export default async function TeamMembersPage({ params }: PageProps<"/teams/[teamId]/members">) {
  const { teamId } = await params;
  if (!isUuid(teamId)) notFound();
  const [member, team, canManage, invites, workspace, resendable] = await Promise.all([
    requireMember(),
    getTeam(teamId),
    canManageTeam(teamId),
    listPendingInvites("team", teamId),
    getWorkspace(),
    hasReal1Schema(),
  ]);
  if (!team) notFound();

  return (
    <div className="px-gutter py-6">
      <TeamMembers
        key={team.id}
        teamId={team.id}
        teamName={team.name}
        members={team.members}
        viewerId={member.id}
        canManage={canManage}
        isDefault={workspace?.defaultTeamId === team.id}
        invites={invites}
        resendable={resendable && isEmailConfigured()}
      />
    </div>
  );
}
