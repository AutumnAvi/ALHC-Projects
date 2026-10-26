import { notFound } from "next/navigation";
import { TeamMembers } from "@/components/teams/team-members";
import { requireMember } from "@/lib/auth";
import { isEmailConfigured } from "@/lib/email";
import {
  canManageTeam,
  getTeam,
  getWorkspace,
  hasReal1Schema,
  listActivePeople,
  listUnjoinedAddresses,
  listPendingInvites,
  listTeamJoinRequests,
} from "@/lib/data";
import { teamMemberCandidates } from "@/lib/teams";
import { requireTeamView } from "../require-team";
import { teamTitle } from "../team-title";

export async function generateMetadata({ params }: PageProps<"/teams/[teamId]/members">) {
  const { teamId } = await params;
  return teamTitle(teamId, "Members");
}

// Members (the team's members and workspace admins see them), people asking to join, and pending
// invites. Leads and workspace admins add people from the workspace, decide on requests, change roles,
// and remove people; anyone can leave.
export default async function TeamMembersPage({ params }: PageProps<"/teams/[teamId]/members">) {
  const { teamId } = await params;
  await requireTeamView(teamId);
  const [member, team, canManage, invites, workspace, resendable, people, requests, waiting] = await Promise.all([
    requireMember(),
    getTeam(teamId),
    canManageTeam(teamId),
    listPendingInvites("team", teamId),
    getWorkspace(),
    hasReal1Schema(),
    listActivePeople(),
    listTeamJoinRequests(teamId),
    listUnjoinedAddresses(),
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
        candidates={
          canManage
            ? teamMemberCandidates(
                people,
                team.members.map((m) => m.profileId),
              )
            : []
        }
        waitingEmails={canManage ? waiting : []}
        requests={canManage ? requests : []}
      />
    </div>
  );
}
