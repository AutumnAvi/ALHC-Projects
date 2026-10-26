// Oct 26 notes (batch 4), items 4 and 5: calendar events (not tasks) on the project and team Calendars,
// drawn distinctly next to task bars and added / changed only by people who can edit; and Calendar bars
// that show a task's name first with its number tiny after it.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { CalendarGrid, type CalendarItem } from "@/components/calendar/calendar-grid";
import { CalendarEventDialog } from "@/components/calendar/calendar-events";
import { CalendarView } from "@/components/project/calendar-view";
import { ProjectAccessProvider } from "@/components/project/project-access";
import { ShellProvider } from "@/components/shell/shell-context";
import { TeamCalendar } from "@/components/teams/team-calendar";
import { ToastProvider } from "@/components/toast";
import {
  defaultEventDay,
  eventAriaLabel,
  eventBarTime,
  eventInputFrom,
  eventInputProblem,
  eventRowFrom,
  eventShortWhen,
  eventWhenText,
  localTimeOf,
  moreLabel,
  toCalendarEvent,
  zonedInstant,
  type CalendarEvent,
  type CalendarEventInput,
} from "@/lib/calendar-events";
import { calendarVisibleDays } from "@/lib/date-input";
import type { ProjectTask } from "@/lib/data";
import { DEFAULT_SIDEBAR_PREFS } from "@/lib/sidebar-prefs";
import type { ProjectRole } from "@/lib/roles";
import type { TeamCalendarTask } from "@/lib/teams";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const member = { id: "me", email: "me@example.com", name: "Me", avatarUrl: null };

function render(node: ReactNode, role: ProjectRole | null = null, path = "/projects/p1/views/v1") {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value={path}>
        <SearchParamsContext.Provider value={new URLSearchParams() as never}>
          <ShellProvider
            member={member as never}
            isWorkspaceAdmin={false}
            workspace={{ name: "ALHC", logoUrl: null }}
            initialSidebar={DEFAULT_SIDEBAR_PREFS}
          >
            <ToastProvider>
              <ProjectAccessProvider role={role}>{node}</ProjectAccessProvider>
            </ToastProvider>
          </ShellProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "e1",
    title: "Kickoff",
    notes: null,
    startOn: "2026-11-03",
    endOn: "2026-11-03",
    startAt: null,
    endAt: null,
    timeZone: "America/New_York",
    createdBy: null,
    createdByName: null,
    createdAt: "2026-10-26T12:00:00Z",
    ...overrides,
  };
}

const input = (overrides: Partial<CalendarEventInput> = {}): CalendarEventInput => ({
  title: "Kickoff",
  notes: null,
  startOn: "2026-11-03",
  endOn: null,
  startTime: null,
  endTime: null,
  timeZone: "America/New_York",
  ...overrides,
});

function task(overrides: Partial<CalendarItem> = {}): CalendarItem {
  return {
    id: "t1",
    title: "Logo refresh",
    startOn: null,
    dueOn: "2026-11-04",
    completed: false,
    milestone: false,
    overdue: false,
    canEdit: true,
    dotClass: "bg-zinc-300",
    ...overrides,
  };
}

const NOVEMBER = calendarVisibleDays("2026-11-01", "month");

test("a typed time on a day in the person's zone becomes the right instant", () => {
  assert.equal(zonedInstant("2026-11-03", "19:30", "America/New_York"), "2026-11-04T00:30:00.000Z");
  assert.equal(zonedInstant("2026-07-01", "09:00", "America/New_York"), "2026-07-01T13:00:00.000Z");
  assert.equal(zonedInstant("2026-11-03", "09:00", "Asia/Kolkata"), "2026-11-03T03:30:00.000Z");
  assert.equal(zonedInstant("2026-11-03", "09:00", "UTC"), "2026-11-03T09:00:00.000Z");
  // The spring-forward gap: 2:30 AM doesn't exist, so it's 3:30 AM (EDT).
  assert.equal(zonedInstant("2026-03-08", "02:30", "America/New_York"), "2026-03-08T07:30:00.000Z");
  // The fall-back hour happens twice: the first one.
  assert.equal(zonedInstant("2026-11-01", "01:30", "America/New_York"), "2026-11-01T05:30:00.000Z");
  assert.equal(localTimeOf("2026-11-04T00:30:00.000Z", "America/New_York"), "19:30");
  assert.equal(eventBarTime({ startAt: "2026-11-03T14:00:00Z", timeZone: "America/New_York" }), "9:00 AM");
  assert.equal(eventBarTime({ startAt: null, timeZone: "UTC" }), null);
});

test("event input is checked like the database's CHECKs, in plain words", () => {
  assert.equal(eventInputProblem(input()), null);
  assert.match(eventInputProblem(input({ title: "   " })) ?? "", /name/);
  assert.match(eventInputProblem(input({ title: "x".repeat(201) })) ?? "", /200/);
  assert.match(eventInputProblem(input({ notes: "x".repeat(5001) })) ?? "", /5,000/);
  assert.match(eventInputProblem(input({ startOn: "2026-02-30" })) ?? "", /starts/);
  assert.match(eventInputProblem(input({ endOn: "2026-11-02" })) ?? "", /end before it starts/);
  assert.match(eventInputProblem(input({ endOn: "2027-11-05" })) ?? "", /366/);
  assert.match(eventInputProblem(input({ startTime: "9am" })) ?? "", /start time/);
  assert.match(eventInputProblem(input({ endTime: "10:00" })) ?? "", /start time before an end time/);
  assert.match(eventInputProblem(input({ startTime: "10:00", endTime: "09:00" })) ?? "", /end before it starts/);
  assert.equal(eventInputProblem(input({ startTime: "22:00", endTime: "01:00", endOn: "2026-11-04" })), null);
  assert.match(eventInputProblem(input({ timeZone: "Mars/Olympus" })) ?? "", /time zone/);

  const made = eventRowFrom(input({ title: "  Kickoff  ", notes: "  ", startTime: "09:00", endTime: "10:30" }));
  assert.ok("row" in made);
  assert.deepEqual(made.row, {
    title: "Kickoff",
    notes: null,
    start_on: "2026-11-03",
    end_on: "2026-11-03",
    start_at: "2026-11-03T14:00:00.000Z",
    end_at: "2026-11-03T15:30:00.000Z",
    time_zone: "America/New_York",
  });
  const allDay = eventRowFrom(input({ endOn: "2026-11-05" }));
  assert.ok("row" in allDay && allDay.row.start_at === null && allDay.row.end_on === "2026-11-05");
  assert.deepEqual(eventRowFrom(input({ title: "" })), { error: "Give the event a name." });
});

test("an event reads the same in words everywhere (its own time zone)", () => {
  const timed = event({ startAt: "2026-11-03T14:00:00Z", endAt: "2026-11-03T15:00:00Z" });
  assert.equal(eventAriaLabel(event({ startAt: "2026-11-03T14:00:00Z" }), 2026), "Event: Kickoff, Nov 3, 9:00 AM");
  assert.equal(eventShortWhen(timed, 2026), "Nov 3, 9:00 AM – 10:00 AM");
  assert.equal(eventShortWhen(event(), 2025), "Nov 3, 2026");
  assert.equal(eventShortWhen(event({ startOn: "2026-11-09", endOn: "2026-11-13" }), 2026), "Nov 9 to Nov 13");
  assert.equal(eventWhenText(timed), "Tuesday, November 3, 2026 · 9:00 AM – 10:00 AM");
  assert.equal(
    eventWhenText(event({ startOn: "2026-11-09", endOn: "2026-11-13" })),
    "Monday, November 9, 2026 – Friday, November 13, 2026",
  );
  // Editing starts from the saved event.
  assert.deepEqual(eventInputFrom(timed), {
    title: "Kickoff",
    notes: null,
    startOn: "2026-11-03",
    endOn: null,
    startTime: "09:00",
    endTime: "10:00",
    timeZone: "America/New_York",
  });
  assert.equal(
    toCalendarEvent({
      id: "e9",
      title: "Offsite",
      notes: null,
      start_on: "2026-11-20",
      end_on: "2026-11-20",
      start_at: null,
      end_at: null,
      time_zone: "Not/AZone",
      created_by: null,
      created_at: "2026-10-26T00:00:00Z",
    }).timeZone,
    "UTC",
  );
});

test("Add event starts on today when it's in view, else the period's first day; +N more counts events", () => {
  assert.equal(defaultEventDay(NOVEMBER, "2026-11-12", "2026-11"), "2026-11-12");
  assert.equal(defaultEventDay(NOVEMBER, "2026-10-26", "2026-11"), "2026-11-01");
  const week = calendarVisibleDays("2026-11-12", "week");
  assert.equal(defaultEventDay(week, "2026-10-26", null), week[0]);
  assert.equal(moreLabel(2, 0), "2 more tasks");
  assert.equal(moreLabel(0, 1), "1 more event");
  assert.equal(moreLabel(1, 1), "2 more items");
});

test("the grid draws an event distinctly, next to a task bar", () => {
  const html = render(
    <CalendarGrid
      days={NOVEMBER}
      month="2026-11"
      today="2026-11-01"
      items={[task()]}
      events={[event({ startAt: "2026-11-03T14:00:00Z" })]}
      drag={null}
      onDragChange={() => {}}
      onChange={() => {}}
      onOpenEvent={() => {}}
      label="Tasks and events, November 2026"
    />,
    "editor",
  );
  // The event: a button (not a task link), violet, with its time in front, never draggable.
  const eventButton = html.match(/<button[^>]*data-calendar-event="e1"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
  assert.ok(eventButton, "an event bar");
  assert.match(eventButton, /aria-label="Event: Kickoff, Nov 3, 9:00 AM"/);
  assert.match(eventButton, /bg-violet-50/);
  assert.match(eventButton, /draggable="false"/);
  assert.match(eventButton, /9:00 AM<\/span>Kickoff/);
  assert.ok(!/line-through/.test(eventButton), "never struck through");
  // The task: a link that opens the pane, draggable for an editor.
  assert.match(html, /<a[^>]*data-calendar-task=""[^>]*href="[^"]*task=t1"|<a[^>]*href="[^"]*task=t1"[^>]*data-calendar-task=""/);
  assert.match(html, /Logo refresh/);
});

test("a numbered task's bar shows the name first and the number tiny after it", () => {
  const html = render(
    <CalendarGrid
      days={NOVEMBER}
      month="2026-11"
      today="2026-11-01"
      items={[task({ title: "Logo refresh", label: { text: "Task #3", wrap: true } })]}
      drag={null}
      onDragChange={() => {}}
      onChange={() => {}}
      label="Tasks, November 2026"
    />,
    "viewer",
  );
  const name = html.indexOf(">Logo refresh</span>");
  const badge = html.indexOf("text-[10px]");
  assert.ok(name > 0 && badge > name, "the name comes before the tiny number");
  assert.match(html, />\[Task #3\]<\/span>/);
  // Screen readers and the tooltip get the full "[Task #3] Logo refresh".
  assert.match(html, /<span class="sr-only">\[Task #3\] Logo refresh, due/);
  assert.match(html, /data-tooltip="\[Task #3\] Logo refresh"/);
});

function projectTask(overrides: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: "t1",
    title: "Logo refresh",
    completedAt: null,
    startOn: null,
    dueOn: "2026-11-04",
    assigneeId: null,
    homeProjectId: "p1",
    createdAt: "2026-10-01T00:00:00Z",
    sectionId: null,
    sortOrder: 1024,
    subtaskCount: 0,
    subtaskDoneCount: 0,
    projectCount: 1,
    fieldValues: {},
    recurring: false,
    blockedBy: 0,
    kind: "task",
    approvalStatus: null,
    tagIds: [],
    commentCount: 0,
    requestLabel: null,
    ...overrides,
  } as ProjectTask;
}

function projectCalendar(role: ProjectRole, events: CalendarEvent[] | null, tasks: ProjectTask[] = [projectTask()]) {
  return render(
    <CalendarView
      projectId="p1"
      tasks={tasks}
      profiles={[]}
      windowed
      today="2026-11-12"
      anchor="2026-11-12"
      mode="month"
      days={NOVEMBER}
      events={events}
    />,
    role,
  );
}

const addEventButton = (html: string) => /<button[^>]*>(<svg[^>]*>[\s\S]*?<\/svg>)?Add event<\/button>/.test(html);

test("Add event is offered to people who can edit, never to viewers or without the database update", () => {
  assert.ok(addEventButton(projectCalendar("editor", [])), "an Editor adds events");
  assert.ok(addEventButton(projectCalendar("owner", [])), "so does an Owner");
  for (const role of ["viewer", "commenter"] as const) {
    const html = projectCalendar(role, [event()]);
    assert.ok(!addEventButton(html), `${role}: no Add event`);
    assert.match(html, /aria-label="Event: Kickoff, Nov 3"/, `${role}: still sees the event`);
  }
  assert.ok(!addEventButton(projectCalendar("editor", null)), "no calendar_events table: nothing to add");

  const teamTask: TeamCalendarTask = {
    id: "t2",
    title: "Banner",
    startOn: null,
    dueOn: "2026-11-05",
    completedAt: null,
    assigneeId: null,
    kind: "task",
    projectId: "p2",
    projectName: "Website",
    canEdit: false,
    requestLabel: { text: "WEB-12", wrap: false },
  };
  const team = (canEditEvents: boolean) =>
    render(
      <TeamCalendar
        teamId="team1"
        month="2026-11"
        today="2026-11-12"
        days={NOVEMBER}
        tasks={[teamTask]}
        projectCount={1}
        capped={false}
        events={[event({ id: "e2", title: "Team offsite", startOn: "2026-11-20", endOn: "2026-11-20" })]}
        canEditEvents={canEditEvents}
      />,
      null,
      "/teams/team1/calendar",
    );
  const memberView = team(true);
  assert.ok(addEventButton(memberView), "team members add events");
  assert.match(memberView, /aria-label="Event: Team offsite, Nov 20"/);
  assert.ok(!addEventButton(team(false)), "people who only read the team don't");
  // The team Calendar's task: the name first, then the number and its project, tiny.
  const name = memberView.indexOf(">Banner</span>");
  const number = memberView.indexOf(">WEB-12</span>");
  assert.ok(name > 0 && number > name, "name before number");
  assert.match(memberView, />Website<\/span>/);
});

test("the No due date tray's chips also put the name first", () => {
  const html = projectCalendar("viewer", [], [projectTask({ id: "t3", dueOn: null, title: "Brief", requestLabel: { text: "Task #9", wrap: true } })]);
  const name = html.indexOf(">Brief</span>");
  const number = html.indexOf(">[Task #9]</span>");
  assert.ok(name > 0 && number > name, "name before number in the tray");
  assert.match(html, /title="\[Task #9\] Brief"/);
});

test("an event's dialog: details for everyone, edit fields only for editors", () => {
  const saved = event({ notes: "Bring the deck", createdByName: "Avi", startAt: "2026-11-03T14:00:00Z" });
  const readOnly = render(
    <CalendarEventDialog scope={{ projectId: "p1" }} event={saved} day="2026-11-03" canEdit={false} onClose={() => {}} />,
    "viewer",
  );
  assert.match(readOnly, /Tuesday, November 3, 2026 · 9:00 AM/);
  assert.match(readOnly, /Bring the deck/);
  assert.match(readOnly, /Added by Avi/);
  assert.ok(!/<input/.test(readOnly) && !/Delete/.test(readOnly), "no fields or Delete for a viewer");

  const editable = render(
    <CalendarEventDialog scope={{ projectId: "p1" }} event={saved} day="2026-11-03" canEdit onClose={() => {}} />,
    "editor",
  );
  assert.match(editable, /Edit event/);
  assert.match(editable, /value="Kickoff"/);
  assert.match(editable, /aria-label="Start time"/);
  assert.match(editable, />Delete<\/button>/);
  assert.match(editable, />Save<\/button>/);

  const adding = render(
    <CalendarEventDialog scope={{ teamId: "team1" }} event={null} day="2026-11-12" canEdit onClose={() => {}} />,
  );
  assert.match(adding, /Add event/);
  assert.match(adding, /Thursday, November 12, 2026/);
  assert.ok(!/>Delete<\/button>/.test(adding), "nothing to delete yet");
});
