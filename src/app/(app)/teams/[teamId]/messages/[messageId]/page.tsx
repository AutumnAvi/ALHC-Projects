import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TeamMessageThreadView } from "@/components/messages/messages";
import { requireMember } from "@/lib/auth";
import { canPostTeamMessage, getTeam, getTeamMessageThread, listActivePeople, listProfiles } from "@/lib/data";
import { isUuid } from "@/lib/ids";
import { teamMessageCandidates } from "../candidates";

export async function generateMetadata({
  params,
}: PageProps<"/teams/[teamId]/messages/[messageId]">): Promise<Metadata> {
  const { messageId } = await params;
  const thread = isUuid(messageId) ? await getTeamMessageThread(messageId) : null;
  return { title: thread ? `${thread.title} · Messages` : "Messages" };
}

// One team thread, its replies, and who follows it. A removed, missing, or unreadable thread (or one of
// another team) 404s.
export default async function TeamMessageThreadPage({ params }: PageProps<"/teams/[teamId]/messages/[messageId]">) {
  const { teamId, messageId } = await params;
  if (!isUuid(teamId) || !isUuid(messageId)) notFound();
  const [member, team, thread, canPost, profiles, people] = await Promise.all([
    requireMember(),
    getTeam(teamId),
    getTeamMessageThread(messageId),
    canPostTeamMessage(teamId),
    listProfiles(),
    listActivePeople(),
  ]);
  if (!team || !thread || thread.teamId !== teamId) notFound();
  return (
    <TeamMessageThreadView
      thread={thread}
      teamName={team.name}
      canPost={canPost}
      profiles={profiles}
      candidates={teamMessageCandidates(profiles, new Set(people.map((p) => p.id)), team, member.id)}
      memberId={member.id}
    />
  );
}
