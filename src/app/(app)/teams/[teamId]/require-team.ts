import "server-only";
import { notFound, redirect } from "next/navigation";
import { getTeamAccessStatus } from "@/lib/data";
import { isUuid } from "@/lib/ids";

// Oct 26 notes (batch 4): only a team's members (and workspace admins) open it. Everyone else goes to
// "You're not part of this team" (/team-access/<id>, its own route, because a layout doesn't stop its
// pages from rendering); a deleted or unknown team is the plain 404. The layout and every tab call it,
// before reading anything about the team. team_access_status is read once per request (cached).
export async function requireTeamView(teamId: string): Promise<void> {
  if (!isUuid(teamId)) notFound();
  const access = await getTeamAccessStatus(teamId);
  if (access === "missing") notFound();
  if (access !== "member") redirect(`/team-access/${teamId}`);
}
