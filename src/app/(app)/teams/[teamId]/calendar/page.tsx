import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarDays } from "lucide-react";
import { TaskPaneSlot } from "@/components/task/task-pane";
import { TeamCalendar } from "@/components/teams/team-calendar";
import { EmptyState } from "@/components/ui";
import { getTeam, listTeamCalendarTasks } from "@/lib/data";
import { teamCalendarDays, teamTabHref } from "@/lib/teams";
import { getViewerTimeZone } from "@/lib/timezone";
import { isIsoDate } from "@/lib/views";
import { todayIn } from "@/lib/workload";
import { requireTeamView } from "../require-team";
import { teamTitle } from "../team-title";

export async function generateMetadata({ params }: PageProps<"/teams/[teamId]/calendar">) {
  const { teamId } = await params;
  return teamTitle(teamId, "Calendar");
}

// The team Calendar: one month (?d= picks it, default this month in the viewer's time zone) of tasks
// scheduled in the team's projects the viewer is a member of (a task spans its start to its due date).
// Projects they could only join, and private projects of others, are never read. People who can edit a
// task drag it (Real features 4). ?task= opens the task pane here.
export default async function TeamCalendarPage({ params, searchParams }: PageProps<"/teams/[teamId]/calendar">) {
  const [{ teamId }, query] = await Promise.all([params, searchParams]);
  await requireTeamView(teamId);
  const anchor = typeof query.d === "string" && isIsoDate(query.d) ? query.d : null;
  const openTaskId = typeof query.task === "string" ? query.task : null;
  const today = todayIn(await getViewerTimeZone());
  const month = (anchor ?? today).slice(0, 7);
  const days = teamCalendarDays(month);
  const [team, calendar] = await Promise.all([
    getTeam(teamId),
    listTeamCalendarTasks(teamId, days[0], days[days.length - 1]),
  ]);
  if (!team) notFound();

  return (
    <>
      {calendar.projectCount === 0 ? (
        <div className="px-gutter py-6">
          <EmptyState
            icon={CalendarDays}
            title="No projects to show yet"
            action={
              <Link href={teamTabHref(team.id, "work")} className="btn-secondary">
                See all work
              </Link>
            }
          >
            The Calendar shows tasks due in {team.name}’s projects you’re a member of. Join one of the team’s public
            projects in All work, or ask a project’s admin to invite you.
          </EmptyState>
        </div>
      ) : (
        <TeamCalendar
          key={month}
          teamId={team.id}
          month={month}
          today={today}
          days={days}
          tasks={calendar.tasks}
          projectCount={calendar.projectCount}
          capped={calendar.capped}
        />
      )}
      <TaskPaneSlot taskId={openTaskId} />
    </>
  );
}
