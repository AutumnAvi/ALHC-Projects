import { redirect } from "next/navigation";
import { teamTabHref } from "@/lib/teams";
import { requireTeamView } from "../../require-team";

// Teams have no Messages tab since Oct 26 notes (batch 4): an old link to a thread (an email, an Inbox
// item from before) opens the team's Overview. The threads are kept in the database.
export default async function TeamMessageThreadPage({ params }: PageProps<"/teams/[teamId]/messages/[messageId]">) {
  const { teamId } = await params;
  await requireTeamView(teamId);
  redirect(teamTabHref(teamId, "overview"));
}
