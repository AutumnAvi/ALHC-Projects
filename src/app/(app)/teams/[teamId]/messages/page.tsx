import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight, MessagesSquare } from "lucide-react";
import { EmptyState } from "@/components/ui";
import { browseProjects, getTeam } from "@/lib/data";
import { isUuid } from "@/lib/ids";
import { projectColorClass } from "@/lib/project-colors";
import { teamTabHref } from "@/lib/teams";
import { teamTitle } from "../team-title";

export async function generateMetadata({ params }: PageProps<"/teams/[teamId]/messages">) {
  const { teamId } = await params;
  return teamTitle(teamId, "Messages");
}

// Team messages aren't built yet (messages belong to projects). Rather than a fake thread list, this
// says so and points at the Messages tab of each of the team's projects the viewer is in.
export default async function TeamMessagesPage({ params }: PageProps<"/teams/[teamId]/messages">) {
  const { teamId } = await params;
  if (!isUuid(teamId)) notFound();
  const [team, projects] = await Promise.all([getTeam(teamId), browseProjects(teamId)]);
  if (!team) notFound();
  const mine = projects
    .filter((p) => p.myRole !== null)
    .sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name));

  return (
    <div className="mx-auto w-full max-w-2xl px-gutter py-8">
      <EmptyState icon={MessagesSquare} title="Team messages are coming later">
        You can’t post to the whole team yet. Until then, start a conversation in one of the team’s projects:
        everyone in that project can read it and reply.
      </EmptyState>

      <section aria-labelledby="team-message-projects" className="mt-8">
        <h2 id="team-message-projects" className="text-sm font-semibold text-zinc-900">
          Post in a project
        </h2>
        {mine.length === 0 ? (
          <p className="mt-1 text-sm text-zinc-500">
            You’re not in any of {team.name}’s projects yet.{" "}
            <Link href={teamTabHref(team.id, "work")} className="text-accent-700 hover:underline">
              Find one to join in All work
            </Link>
            .
          </p>
        ) : (
          <>
            <p className="mt-0.5 text-xs text-zinc-500">{team.name}’s projects you’re a member of.</p>
            <ul className="mt-3 divide-y divide-zinc-100 rounded-lg border border-zinc-200">
              {mine.map((p) => (
                <li key={p.projectId}>
                  <Link
                    href={`/projects/${p.projectId}/messages`}
                    className="flex items-center gap-3 px-3 py-2.5 hover:bg-zinc-50"
                  >
                    <span aria-hidden className={`size-3 shrink-0 rounded-[3px] ${projectColorClass(p.projectId)}`} />
                    <span className="min-w-0 flex-1 truncate text-sm text-zinc-900">{p.name}</span>
                    {p.archived ? <span className="chip shrink-0">Archived · read-only</span> : null}
                    <span className="shrink-0 text-xs text-zinc-500">Messages</span>
                    <ChevronRight className="size-4 shrink-0 text-zinc-400" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
