import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProjectOverview } from "@/components/project/project-overview";
import {
  getGoalViewer,
  getProject,
  getProjectOverviewInfo,
  listGoals,
  listProjectGoalLinks,
  listProjectMembers,
  listProjectStatusUpdates,
  listProjectStories,
} from "@/lib/data";
import { goalEditable, periodLabel } from "@/lib/goals";
import { sortActivity, type ProjectActivityItem } from "@/lib/project-page";
import { compareMembers } from "@/lib/roles";

export async function generateMetadata({ params }: PageProps<"/projects/[projectId]/overview">): Promise<Metadata> {
  const { projectId } = await params;
  const project = await getProject(projectId);
  return { title: project ? `${project.name} · Overview` : "Overview" };
}

// Asana's Overview tab: the description, project roles, connected goals, and on the right "What's the
// status?" (status, latest update, due date) above the project's activity. Everything is read with the
// viewer's client (project Viewers+; goal links only for projects they can read).
export default async function ProjectOverviewPage({ params }: PageProps<"/projects/[projectId]/overview">) {
  const { projectId } = await params;
  const [project, info, members, updates, stories, links, goals, viewer] = await Promise.all([
    getProject(projectId),
    getProjectOverviewInfo(projectId),
    listProjectMembers(projectId),
    listProjectStatusUpdates(projectId),
    listProjectStories(projectId),
    listProjectGoalLinks(projectId),
    listGoals(),
    getGoalViewer(),
  ]);
  if (!project || !info) notFound();

  const linked = new Set(links.map((l) => l.goal.id));
  const activity: ProjectActivityItem[] = sortActivity([
    ...updates.map(
      (u): ProjectActivityItem => ({
        kind: "status",
        id: `status-${u.id}`,
        at: u.createdAt,
        status: u.status,
        title: u.title,
        note: u.note,
        by: u.authorName,
      }),
    ),
    ...members.map((m): ProjectActivityItem => ({ kind: "joined", id: `joined-${m.profileId}`, at: m.addedAt, name: m.name })),
    ...stories.map(
      (s): ProjectActivityItem => ({ kind: "story", id: `story-${s.id}`, at: s.createdAt, story: s.kind, by: s.actorName, fromName: s.fromName }),
    ),
    { kind: "created", id: "created", at: info.createdAt, by: info.createdByName },
  ]);

  return (
    <main className="min-h-0 flex-1 overflow-auto">
      <ProjectOverview
        projectId={project.id}
        description={project.description}
        dueOn={info.dueOn}
        status={project.status}
        statusSet={project.status_updated_at !== null}
        latestUpdate={updates[0] ?? null}
        members={members.map(({ profileId, name, role }) => ({ profileId, name, role })).sort(compareMembers)}
        goals={links.map(({ linkId, goal }) => ({
          linkId,
          id: goal.id,
          title: goal.title,
          status: goal.status,
          period: periodLabel(goal.periodStart, goal.periodEnd),
          editable: goalEditable(goal, viewer),
        }))}
        connectable={goals
          .filter((g) => !linked.has(g.id) && goalEditable(g, viewer))
          .map((g) => ({ id: g.id, title: g.title }))
          .sort((a, b) => a.title.localeCompare(b.title))}
        activity={activity}
      />
    </main>
  );
}
