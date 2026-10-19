import type { Metadata } from "next";
import { CircleCheck, House, UsersRound } from "lucide-react";
import { MyTasksWidget } from "@/components/home/my-tasks-widget";
import { PeopleWidget } from "@/components/home/people-widget";
import { ProjectsWidget } from "@/components/home/projects-widget";
import { TaskPaneSlot } from "@/components/task/task-pane";
import { PageHeader } from "@/components/ui";
import { requireMember } from "@/lib/auth";
import { listArchivedProjects, listFrequentCollaborators, listMyTasks, listProjects, listStarredProjectIds } from "@/lib/data";
import {
  RECENT_COMPLETED_LIMIT,
  completedThisWeek,
  firstName,
  greetingFor,
  hourIn,
  longDateIn,
  plural,
  splitHomeTasks,
} from "@/lib/home";
import { getViewerTimeZone } from "@/lib/timezone";
import { todayIn } from "@/lib/workload";

export const metadata: Metadata = { title: "Home" };

// Every collaborator counts toward "My week"; the People widget shows them all (it scrolls).
const COLLABORATOR_LIMIT = 500;

// Home (Asana parity, batch 5): the date and a greeting in the viewer's time zone, a "My week" summary,
// then the My tasks, Projects, and People widgets. `?task=` opens the task pane next to it.
export default async function HomePage({ searchParams }: PageProps<"/">) {
  const { task } = await searchParams;
  const openTaskId = typeof task === "string" ? task : null;
  const member = await requireMember();
  const timeZone = await getViewerTimeZone();
  const today = todayIn(timeZone);
  const [{ open, completed }, projects, archived, starredIds, collaborators] = await Promise.all([
    listMyTasks(member.id),
    listProjects(),
    listArchivedProjects(),
    listStarredProjectIds(),
    listFrequentCollaborators(COLLABORATOR_LIMIT),
  ]);

  const tasks = splitHomeTasks(open, completed, today);
  const doneThisWeek = completedThisWeek(completed, today, timeZone);
  // Only the latest completed tasks are read: when all of them are from this week there may be more.
  const doneLabel =
    completed.length >= RECENT_COMPLETED_LIMIT && doneThisWeek === completed.length
      ? `${doneThisWeek}+ tasks completed`
      : plural(doneThisWeek, "task completed", "tasks completed");

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader icon={House} title="Home" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col items-center px-gutter pb-6 pt-8 text-center">
          <p className="text-sm text-zinc-500">{longDateIn(timeZone)}</p>
          <h2 className="mt-1 text-3xl font-medium tracking-tight text-zinc-900">
            {greetingFor(hourIn(timeZone))}, {firstName(member.name, member.email)}
          </h2>
          <p className="mt-4 inline-flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-full bg-zinc-100 px-4 py-1.5 text-sm text-zinc-600">
            <span className="font-medium text-zinc-800">My week</span>
            <span aria-hidden className="h-4 w-px bg-zinc-300" />
            <span className="inline-flex items-center gap-1.5">
              <CircleCheck className="size-4 text-zinc-500" aria-hidden />
              {doneLabel}
            </span>
            <span className="inline-flex items-center gap-1.5" data-tooltip="People who share a project with you">
              <UsersRound className="size-4 text-zinc-500" aria-hidden />
              {plural(collaborators.length, "collaborator")}
              <span className="sr-only"> (people who share a project with you)</span>
            </span>
          </p>
        </div>
        {/* A size container: two columns only when there's room, also with the task pane open. */}
        <div className="@container px-gutter pb-10">
          <div className="grid gap-4 @4xl:grid-cols-2">
            <MyTasksWidget tasks={tasks} />
            <ProjectsWidget
              projects={projects.map(({ id, name }) => ({ id, name }))}
              starredIds={starredIds}
              archivedCount={archived.length}
            />
            <PeopleWidget collaborators={collaborators} />
          </div>
        </div>
      </div>
      <TaskPaneSlot taskId={openTaskId} />
    </main>
  );
}
