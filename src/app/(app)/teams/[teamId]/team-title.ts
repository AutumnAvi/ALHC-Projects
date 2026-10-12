import type { Metadata } from "next";
import { getTeam } from "@/lib/data";
import { isUuid } from "@/lib/ids";

// The browser title of a team tab: "<tab> · <team>" (the Overview is just "<team> · Teams").
export async function teamTitle(teamId: string, tab: string | null): Promise<Metadata> {
  const team = isUuid(teamId) ? await getTeam(teamId) : null;
  if (!team) return { title: "Team" };
  return { title: tab ? `${tab} · ${team.name}` : `${team.name} · Teams` };
}
