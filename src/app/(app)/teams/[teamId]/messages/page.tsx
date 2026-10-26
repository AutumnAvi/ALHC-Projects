import { redirect } from "next/navigation";
import { teamTabHref } from "@/lib/teams";
import { requireTeamView } from "../require-team";

// Teams have no Messages tab since Oct 26 notes (batch 4): an old link (an email, a bookmark) opens the
// team's Overview. The threads are kept in the database.
export default async function TeamMessagesPage({ params }: PageProps<"/teams/[teamId]/messages">) {
  const { teamId } = await params;
  await requireTeamView(teamId);
  redirect(teamTabHref(teamId, "overview"));
}
