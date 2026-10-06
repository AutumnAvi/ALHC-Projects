import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { displayName } from "@/components/avatar";
import { GoalDetail } from "@/components/goals/goal-detail";
import {
  getGoal,
  getGoalViewer,
  listGoalLinks,
  listGoalProgress,
  listGoalStatusUpdates,
  listGoals,
  listPortfolios,
  listProfiles,
  listProjects,
  listTeams,
} from "@/lib/data";
import { NO_PROGRESS } from "@/lib/goals";
import { getViewerTimeZone } from "@/lib/timezone";
import { todayIn } from "@/lib/workload";

export async function generateMetadata({ params }: PageProps<"/goals/[goalId]">): Promise<Metadata> {
  const { goalId } = await params;
  const goal = await getGoal(goalId);
  return { title: goal ? `${goal.title} · Goals` : "Goal" };
}

// One goal: progress (as this viewer sees it), sub-goals, links to projects / portfolios the viewer
// can open, and the status update feed. Links to anything the viewer can't open are hidden by RLS and
// only counted.
export default async function GoalPage({ params }: PageProps<"/goals/[goalId]">) {
  const { goalId } = await params;
  const goal = await getGoal(goalId);
  if (!goal) notFound();
  const [goals, progress, viewer, links, updates, profiles, teams, projects, portfolios, timeZone] = await Promise.all([
    listGoals(),
    listGoalProgress(),
    getGoalViewer(),
    listGoalLinks(goalId),
    listGoalStatusUpdates(goalId),
    listProfiles(),
    listTeams(),
    listProjects(),
    listPortfolios(),
    getViewerTimeZone(),
  ]);

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <GoalDetail
        key={goal.id}
        goal={goal}
        progress={progress.get(goal.id) ?? NO_PROGRESS}
        viewer={viewer}
        goals={goals}
        progressById={Object.fromEntries(progress)}
        links={links}
        updates={updates}
        people={profiles.map((p) => ({ id: p.id, name: displayName(p) }))}
        teams={teams.map((t) => ({ id: t.id, name: t.name }))}
        projects={projects.map((p) => ({ id: p.id, name: p.name }))}
        portfolios={portfolios.map((p) => ({ id: p.id, name: p.name }))}
        today={todayIn(timeZone)}
      />
    </main>
  );
}
