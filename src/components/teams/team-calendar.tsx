"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useOptimistic, useState, useTransition } from "react";
import { CalendarGrid, type CalendarDates, type CalendarDrag, type CalendarItem } from "@/components/calendar/calendar-grid";
import { SyncCalendarButton } from "@/components/calendar/sync-calendar-dialog";
import { PeriodNav } from "@/components/project/view-chrome";
import { useOpenTaskId } from "@/components/shell/right-panel";
import { useDependencyShift } from "@/components/task/dependency-shift";
import { monthLabel, shiftMonth } from "@/lib/date-input";
import { projectColorClass } from "@/lib/project-colors";
import { parseTaskKind } from "@/lib/task-kinds";
import { TEAM_CALENDAR_LIMIT, type TeamCalendarTask } from "@/lib/teams";

type Move = { taskId: string } & CalendarDates;

// The team Calendar: a month of tasks in the team's projects the viewer is a member of, each a bar from its
// start date to its due date. Since Real features 4 people who can edit a task (Editor+ in its project by
// their own role) drag it to another day, drag its ends, or use its calendar button; others see it
// read-only. Changes go through the task pane's path (useDependencyShift → updateTask / the shift RPCs),
// so activity, notifications, rules, and due-date triggers follow as for any edit; the move shows at once
// and rolls back with the error when the database refuses it. The month comes from ?d= (the server loads
// exactly the visible weeks); a task opens in the pane on this page (?task=).
export function TeamCalendar({
  teamId,
  month,
  today,
  days,
  tasks,
  projectCount,
  capped,
}: {
  teamId: string;
  // "YYYY-MM"
  month: string;
  // The viewer's local day (tz cookie), so server and browser agree on "today" and "overdue".
  today: string;
  // Whole weeks, Sunday first (teamCalendarDays).
  days: string[];
  tasks: TeamCalendarTask[];
  projectCount: number;
  capped: boolean;
}) {
  // The task whose pane is open (instant: no server render on open / close; Oct 19 notes).
  const openTaskId = useOpenTaskId();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [navigating, startTransition] = useTransition();
  const [drag, setDrag] = useState<CalendarDrag | null>(null);
  const shift = useDependencyShift();
  const [shown, applyMoves] = useOptimistic(tasks, (current, moves: Move[]) =>
    current.flatMap((t) => {
      const move = moves.find((m) => m.taskId === t.id);
      if (!move) return [t];
      // A task whose due date was cleared leaves the calendar until the page refreshes.
      if (!move.dueOn) return [];
      return [{ ...t, startOn: move.startOn && move.startOn < move.dueOn ? move.startOn : null, dueOn: move.dueOn }];
    }),
  );

  function hrefWith(changes: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    const query = params.toString();
    return query ? `${pathname}?${query}` : pathname;
  }

  function goTo(d: string | null) {
    startTransition(() => router.push(hrefWith({ d }), { scroll: false }));
  }

  const items: CalendarItem[] = shown.map((task) => {
    const completed = Boolean(task.completedAt);
    const overdue = !completed && task.dueOn < today;
    const milestone = task.kind === "milestone";
    return {
      id: task.id,
      title: task.title,
      startOn: milestone ? null : task.startOn,
      dueOn: task.dueOn,
      completed,
      milestone,
      overdue,
      canEdit: task.canEdit,
      open: openTaskId === task.id,
      // The pane's preview of a clicked bar.
      seed: () => ({
        id: task.id,
        title: task.title,
        completed,
        kind: parseTaskKind(task.kind),
        dueOn: task.dueOn,
        startOn: task.startOn,
        projectName: task.projectName,
      }),
      dotClass: projectColorClass(task.projectId),
      srDetail: ` in ${task.projectName}`,
      tooltip: `${task.title} · ${task.projectName}`,
    };
  });
  const label = monthLabel(month);
  const inMonth = shown.filter((t) => t.dueOn.startsWith(month) || (t.startOn ?? t.dueOn).startsWith(month)).length;
  const editable = shown.some((t) => t.canEdit);

  return (
    <div className="flex min-h-0 flex-1 flex-col px-gutter py-3">
      {shift.dialog}
      <PeriodNav
        label={label}
        prevLabel="Previous month"
        nextLabel="Next month"
        onPrev={() => goTo(`${shiftMonth(month, -1)}-01`)}
        onNext={() => goTo(`${shiftMonth(month, 1)}-01`)}
        onToday={() => goTo(null)}
      >
        <SyncCalendarButton scope="team" targetId={teamId} />
      </PeriodNav>
      <p className="mb-2 text-xs text-zinc-500">
        Tasks in this team’s {projectCount === 1 ? "project" : `${projectCount} projects`} you’re a member of
        {inMonth === 0 ? ` · Nothing is scheduled in ${label}` : ""}
        {capped ? ` · Showing the first ${TEAM_CALENDAR_LIMIT.toLocaleString("en-US")} tasks` : ""}
      </p>

      <div aria-busy={navigating} className={`flex min-h-0 flex-1 flex-col ${navigating ? "opacity-60 transition-opacity" : ""}`}>
        <CalendarGrid
          days={days}
          month={month}
          today={today}
          items={items}
          drag={drag}
          onDragChange={setDrag}
          onChange={(item, dates) => {
            const task = shown.find((t) => t.id === item.id);
            if (!task) return;
            shift.changeDates(task, dates, { onOptimistic: (moves) => applyMoves(moves) });
          }}
          label={`Tasks, ${label}`}
        />
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        {editable
          ? "Drag a task to another day to move it (its start date moves too), drag its left or right end to change its start or due date, or use its calendar button. Tasks you can only view can’t be moved."
          : "Tasks run from their start date to their due date. Your role in these projects lets you view them, not move them."}
      </p>
    </div>
  );
}
