import type { Metadata } from "next";
import { Compass, Plus } from "lucide-react";
import { displayName } from "@/components/avatar";
import { BrowseProjectsTable } from "@/components/projects/browse-projects-table";
import { OpenDialogButton } from "@/components/shell/open-dialog-button";
import { PageHeader } from "@/components/ui";
import { requireMember } from "@/lib/auth";
import { browseProjectPeople, browseProjects, listProfiles, listTeams } from "@/lib/data";
import { isUuid } from "@/lib/ids";

export const metadata: Metadata = { title: "Browse projects" };

// Every project the viewer is allowed to see: their own, plus projects shared with their teams (Join
// makes them an Editor). Private projects stay hidden from everyone who isn't a member, workspace
// admins included. ?team=<id> starts with the Teams filter set to that team.
export default async function BrowseProjectsPage({ searchParams }: PageProps<"/projects/browse">) {
  const params = await searchParams;
  const teamId = typeof params.team === "string" && isUuid(params.team) ? params.team : null;
  const [member, projects, people, teams, profiles] = await Promise.all([
    requireMember(),
    browseProjects(null),
    browseProjectPeople(null),
    listTeams(),
    listProfiles(),
  ]);
  const joinable = projects.filter((p) => p.myRole === null && !p.archived).length;
  const rows = projects.map((p) => {
    const extra = people?.get(p.projectId);
    return {
      ...p,
      ownerIds: extra?.ownerIds ?? null,
      memberIds: extra?.memberIds ?? null,
      modifiedAt: extra?.modifiedAt ?? null,
    };
  });

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        icon={Compass}
        title="Browse projects"
        description={
          joinable
            ? `${joinable} ${joinable === 1 ? "project" : "projects"} you can join`
            : "Your projects and the ones shared with your teams"
        }
        actions={
          <OpenDialogButton dialog={{ kind: "project" }} className="btn-primary h-8 px-3">
            <Plus className="size-4" aria-hidden />
            Create project
          </OpenDialogButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-gutter py-5">
          <BrowseProjectsTable
            projects={rows}
            people={profiles.map((p) => ({ id: p.id, name: displayName(p) }))}
            teams={teams.map((t) => ({ id: t.id, name: t.name }))}
            meId={member.id}
            initialTeamId={teamId && teams.some((t) => t.id === teamId) ? teamId : null}
            peopleKnown={people !== null}
          />
          <p className="mt-6 text-xs text-zinc-500">
            Private projects only appear for their members. Ask a project’s owner or admin to invite you.
          </p>
        </div>
      </div>
    </main>
  );
}
