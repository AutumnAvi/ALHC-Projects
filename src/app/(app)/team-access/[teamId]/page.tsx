import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { NoTeamAccess } from "@/components/teams/no-team-access";
import { getTeam, getTeamAccessStatus } from "@/lib/data";
import { isUuid } from "@/lib/ids";

export const metadata: Metadata = { title: "Team", robots: { index: false } };

// Oct 26 notes (batch 4): where the team layout sends someone who isn't part of the team (its own route,
// so no team page renders next to it). A deleted or unknown team is a 404; a member goes straight to the
// team. The team's name is public (the Teams directory lists every team), nothing else about it is read.
export default async function TeamAccessPage({ params }: PageProps<"/team-access/[teamId]">) {
  const { teamId } = await params;
  if (!isUuid(teamId)) notFound();
  const [access, team] = await Promise.all([getTeamAccessStatus(teamId), getTeam(teamId)]);
  if (access === "member") redirect(`/teams/${teamId}`);
  if (access === "missing" || !team) notFound();
  return <NoTeamAccess teamId={teamId} teamName={team.name} status={access} />;
}
