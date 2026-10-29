"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useOptimistic, useState, useTransition } from "react";
import { AddEventButton, useCalendarEvents } from "@/components/calendar/calendar-events";
import { CalendarGrid, type CalendarDates, type CalendarDrag, type CalendarItem } from "@/components/calendar/calendar-grid";
import { SyncCalendarButton } from "@/components/calendar/sync-calendar-dialog";
import { PeriodNav } from "@/components/project/view-chrome";
import { useOpenTaskId } from "@/components/shell/right-panel";
import { useDependencyShift } from "@/components/task/dependency-shift";
import { defaultEventDay, type CalendarEvent } from "@/lib/calendar-events";
import { monthLabel, shiftMonth } from "@/lib/date-input";
import { projectColorClass } from "@/lib/project-colors";
import { displayTaskTitle } from "@/lib/request-numbers";
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
// Since Oct 26 notes (batch 4) it also shows the team's calendar events (not tasks): the team's members,
// leads, and workspace admins add, change, and remove them; everyone who can see the team reads them.
// A task's number is drawn tiny after its name, with its project's name.
export function TeamCalendar({
  teamId,
  month,
  today,
  days,
  tasks,
  projectCount,
  capped,
  events = null,
  canEditEvents = false,
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
  // The team's events in these weeks; null on a database without calendar events.
  events?: CalendarEvent[] | null;
  // The viewer is one of the team's members, a lead, or a workspace admin (can_post_team_message).
  canEditEvents?: boolean;
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
  const calendarEvents = useCalendarEvents({
    scope: { teamId },
    events,
    canEdit: canEditEvents,
    defaultDay: defaultEventDay(days, today, month),
  });

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
    const fullTitle = displayTaskTitle(task.title, task.requestLabel);
    // The number's own project (Oct 29 notes, 55b): the bar's project numbers it, or the badge names the
    // project the shown number is from — never one project's number next to another's name.
    const numberedElsewhere = Boolean(task.requestLabel && task.numberProjectName);
    return {
      id: task.id,
      title: task.title,
      // The number (when its project numbers tasks) and the project, tiny after the name.
      label: task.requestLabel,
      numbers: task.taskNumbers,
      projectName: numberedElsewhere ? task.numberProjectName : task.projectName,
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
        requestLabel: task.requestLabel,
        completed,
        kind: parseTaskKind(task.kind),
        dueOn: task.dueOn,
        startOn: task.startOn,
        projectName: task.projectName,
      }),
      dotClass: projectColorClass(task.projectId),
      srDetail: ` in ${task.projectName}${numberedElsewhere ? `, numbered in ${task.numberProjectName}` : ""}`,
      tooltip: `${fullTitle} · ${task.projectName}${numberedElsewhere ? ` (numbered in ${task.numberProjectName})` : ""}`,
    };
  });
  const label = monthLabel(month);
  const touches = (first: string, last: string) => first <= `${month}-31` && last >= `${month}-01`;
  const inMonth =
    shown.filter((t) => touches(t.startOn ?? t.dueOn, t.dueOn)).length +
    calendarEvents.events.filter((e) => touches(e.startOn, e.endOn)).length;
  const editable = shown.some((t) => t.canEdit);
  const source =
    projectCount === 0
      ? "This team’s events (you aren’t in any of its projects yet, so no tasks show)"
      : `Tasks in this team’s ${projectCount === 1 ? "project" : `${projectCount} projects`} you’re a member of${
          events !== null ? ", and the team’s events" : ""
        }`;

  return (
    <div className="flex min-h-0 flex-1 flex-col px-gutter py-3">
      {shift.dialog}
      {calendarEvents.dialog}
      <PeriodNav
        label={label}
        prevLabel="Previous month"
        nextLabel="Next month"
        onPrev={() => goTo(`${shiftMonth(month, -1)}-01`)}
        onNext={() => goTo(`${shiftMonth(month, 1)}-01`)}
        onToday={() => goTo(null)}
      >
        <div className="flex items-center gap-1">
          {calendarEvents.canAdd ? <AddEventButton onClick={() => calendarEvents.add()} /> : null}
          <SyncCalendarButton scope="team" targetId={teamId} />
        </div>
      </PeriodNav>
      <p className="mb-2 text-xs text-zinc-500">
        {source}
        {inMonth === 0 ? ` · Nothing is scheduled in ${label}` : ""}
        {capped ? ` · Showing the first ${TEAM_CALENDAR_LIMIT.toLocaleString("en-US")} tasks` : ""}
      </p>

      <div aria-busy={navigating} className={`flex min-h-0 flex-1 flex-col ${navigating ? "opacity-60 transition-opacity" : ""}`}>
        <CalendarGrid
          days={days}
          month={month}
          today={today}
          items={items}
          events={calendarEvents.events}
          onOpenEvent={calendarEvents.open}
          onAddEvent={calendarEvents.canAdd ? calendarEvents.add : undefined}
          drag={drag}
          onDragChange={setDrag}
          onChange={(item, dates) => {
            const task = shown.find((t) => t.id === item.id);
            if (!task) return;
            shift.changeDates(
              { id: task.id, title: displayTaskTitle(task.title, task.requestLabel) },
              dates,
              { onOptimistic: (moves) => applyMoves(moves), projectId: task.projectId },
            );
          }}
          label={`Tasks and events, ${label}`}
        />
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        {editable
          ? "Drag a task to another day to move it (its start date moves too), drag its left or right end to change its start or due date, or use its calendar button. Tasks you can only view can’t be moved."
          : "Tasks run from their start date to their due date. Your role in these projects lets you view them, not move them."}
        {calendarEvents.canAdd
          ? " Events (in violet) aren’t tasks: click one to change it, or use Add event."
          : calendarEvents.events.length > 0
            ? " Events (in violet) aren’t tasks: click one for its details."
            : ""}
      </p>
    </div>
  );
}
