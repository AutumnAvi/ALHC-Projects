import { notFound } from "next/navigation";
import { MessagesSquare } from "lucide-react";
import { TeamMessageThreadList } from "@/components/messages/messages";
import { EmptyState } from "@/components/ui";
import { requireMember } from "@/lib/auth";
import { canPostTeamMessage, getTeam, listActivePeople, listProfiles, listTeamMessageThreads } from "@/lib/data";
import { isUuid } from "@/lib/ids";
import { teamTitle } from "../team-title";
import { teamMessageCandidates } from "./candidates";

export async function generateMetadata({ params }: PageProps<"/teams/[teamId]/messages">) {
  const { teamId } = await params;
  return teamTitle(teamId, "Messages");
}

// Team Messages (Real features 2): threads everyone who can see the team reads (RLS: can_read_team);
// the team's members, leads, and workspace admins post. A new thread tells every team member.
export default async function TeamMessagesPage({ params }: PageProps<"/teams/[teamId]/messages">) {
  const { teamId } = await params;
  if (!isUuid(teamId)) notFound();
  const [member, team, threads, canPost, profiles, people] = await Promise.all([
    requireMember(),
    getTeam(teamId),
    listTeamMessageThreads(teamId),
    canPostTeamMessage(teamId),
    listProfiles(),
    listActivePeople(),
  ]);
  if (!team) notFound();
  if (threads === null) {
    return (
      <div className="mx-auto w-full max-w-2xl px-gutter py-8">
        <EmptyState icon={MessagesSquare} title="Team messages need this release’s database update">
          It isn’t applied to this workspace yet, so {team.name} can’t post messages here. Project Messages work as
          usual.
        </EmptyState>
      </div>
    );
  }
  return (
    <TeamMessageThreadList
      teamId={team.id}
      teamName={team.name}
      canPost={canPost}
      threads={threads}
      profiles={profiles}
      candidates={teamMessageCandidates(profiles, new Set(people.map((p) => p.id)), team, member.id)}
    />
  );
}
