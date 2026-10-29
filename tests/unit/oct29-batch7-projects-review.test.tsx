// Oct 29 notes, batch 7 — 55b (no home project), fixes after review: a task whose other projects are all
// archived keeps its last active one (the pane asks to delete it instead); a number and the project named
// next to it are always picked together (blockers, parent candidates, the dependency picker, the team
// Calendar); the search palette spells out a result's other numbers while it's the highlighted one; and a
// review round's email and page name the project the database chose with the sender's access.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { ShellProvider } from "@/components/shell/shell-context";
import { TaskNumberBadge } from "@/components/task/task-number";
import { TeamCalendar } from "@/components/teams/team-calendar";
import { ToastProvider } from "@/components/toast";
import { calendarVisibleDays } from "@/lib/date-input";
import { numbersLedBy, numberWithItsProject, type TaskNumber, type TaskPlace } from "@/lib/request-numbers";
import { parseRoundProject } from "@/lib/review-checks";
import { DEFAULT_SIDEBAR_PREFS } from "@/lib/sidebar-prefs";
import {
  ARCHIVED_ONLY_CODE,
  ARCHIVED_ONLY_MESSAGE,
  LAST_PROJECT_CODE,
  LAST_PROJECT_MESSAGE,
  isLastProjectCode,
  isLastProjectError,
  lastProjectQuestion,
  lastProjectRefusal,
  removeFromProjectOrDelete,
} from "@/lib/task-projects";
import type { TeamCalendarTask } from "@/lib/teams";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const member = { id: "me", email: "me@example.com", name: "Me", avatarUrl: null };

function render(node: ReactNode, pathname = "/teams/team1/calendar") {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value={pathname}>
        <SearchParamsContext.Provider value={new URLSearchParams() as never}>
          <ShellProvider member={member as never} isWorkspaceAdmin={false} workspace={{ name: "ALHC", logoUrl: null }} initialSidebar={DEFAULT_SIDEBAR_PREFS}>
            <ToastProvider>{node}</ToastProvider>
          </ShellProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

// ---------------------------------------------------------------------------------------------
// The last active project
// ---------------------------------------------------------------------------------------------

test("the database's two last-project refusals are told apart", () => {
  assert.equal(ARCHIVED_ONLY_CODE, "archived_only");
  assert.equal(
    ARCHIVED_ONLY_MESSAGE,
    "This is the task’s only active project: its other projects are archived. Unarchive one or add the task to another project first, or move the task to the Trash.",
  );
  assert.equal(lastProjectRefusal({ code: "23514", details: "last_project", message: LAST_PROJECT_MESSAGE }), LAST_PROJECT_CODE);
  assert.equal(lastProjectRefusal({ code: "23514", details: "archived_only", message: ARCHIVED_ONLY_MESSAGE }), ARCHIVED_ONLY_CODE);
  assert.equal(lastProjectRefusal({ code: "23514", details: null, message: ARCHIVED_ONLY_MESSAGE }), ARCHIVED_ONLY_CODE, "by its message");
  assert.equal(lastProjectRefusal({ code: "23514", details: null, message: LAST_PROJECT_MESSAGE }), LAST_PROJECT_CODE, "by its message");
  assert.equal(lastProjectRefusal({ code: "42501", details: "archived_only", message: "no" }), null, "only a check violation");
  assert.equal(lastProjectRefusal({ code: "23514", details: null, message: "The start date must be on or before the due date" }), null);
  assert.equal(lastProjectRefusal(null), null);
  assert.ok(isLastProjectError({ code: "23514", details: "archived_only", message: ARCHIVED_ONLY_MESSAGE }));
  assert.ok(isLastProjectCode("last_project") && isLastProjectCode("archived_only"));
  assert.ok(!isLastProjectCode("other") && !isLastProjectCode(undefined));
});

test("Remove from a task's last active project: asks to delete it instead, saying its other projects are archived", async () => {
  assert.deepEqual(lastProjectQuestion("Brochure", "Launch", ARCHIVED_ONLY_CODE), {
    title: "“Brochure” is only active in Launch",
    message: "Its other projects are archived. Delete the task instead? It goes to the Trash and you can restore it.",
    confirmLabel: "Delete task",
    tone: "danger",
  });
  assert.equal(lastProjectQuestion("Brochure", "Launch").title, "“Brochure” is only in Launch", "the plain case is unchanged");

  const asked: string[] = [];
  const calls: string[] = [];
  const outcome = await removeFromProjectOrDelete({
    remove: async () => (calls.push("remove"), { error: ARCHIVED_ONLY_MESSAGE, code: ARCHIVED_ONLY_CODE }),
    ask: async (refusal) => (asked.push(refusal), calls.push("ask"), true),
    deleteTask: async () => (calls.push("delete"), {}),
  });
  assert.deepEqual(outcome, { kind: "deleted" });
  assert.deepEqual(calls, ["remove", "ask", "delete"]);
  assert.deepEqual(asked, ["archived_only"], "the question knows which refusal it was");

  const kept = await removeFromProjectOrDelete({
    remove: async () => ({ error: ARCHIVED_ONLY_MESSAGE, code: ARCHIVED_ONLY_CODE }),
    ask: async () => false,
    deleteTask: async () => {
      throw new Error("nothing is deleted when they say no");
    },
  });
  assert.deepEqual(kept, { kind: "kept" });
});

// ---------------------------------------------------------------------------------------------
// A number and its project, picked together
// ---------------------------------------------------------------------------------------------

const label = (text: string) => ({ text, wrap: false });
const Y: TaskPlace = { projectId: "y", projectName: "Y unnumbered", label: null };
const A: TaskPlace = { projectId: "a", projectName: "Launch", label: label("A-4") };
const W: TaskPlace = { projectId: "w", projectName: "Website", label: label("W-2") };

test("a badge names the project that issued its number, never another one", () => {
  // The blocker card / parent picker: first in Y (no numbers), then in A.
  assert.deepEqual(numberWithItsProject([Y, A]), { label: label("A-4"), projectId: "a", projectName: "Launch" });
  // No number anywhere: the first project, name only.
  assert.deepEqual(numberWithItsProject([Y]), { label: null, projectId: "y", projectName: "Y unnumbered" });
  assert.deepEqual(numberWithItsProject(undefined), { label: null, projectId: null, projectName: null }, "a private task");

  // A row that stands for a project (the dependency picker's group, a calendar bar): its own number first.
  assert.deepEqual(numberWithItsProject([A, W], { projectId: "w", projectName: "Website" }), {
    label: label("W-2"),
    projectId: "w",
    projectName: "Website",
  });
  // That project doesn't number the task: the first number, with the project it's from.
  assert.deepEqual(numberWithItsProject([Y, A], { projectId: "y", projectName: "Y unnumbered" }), {
    label: label("A-4"),
    projectId: "a",
    projectName: "Launch",
  });
  // Nothing numbers it: the row's own project, name only.
  assert.deepEqual(numberWithItsProject([Y], { projectId: "y", projectName: "Y unnumbered" }), {
    label: null,
    projectId: "y",
    projectName: "Y unnumbered",
  });
});

test("numbers led by the project a row names, the rest in the stable order", () => {
  const numbers: TaskNumber[] = [
    { projectId: "a", projectName: "Launch", label: label("L-1") },
    { projectId: "w", projectName: "Website", label: label("W-1") },
    { projectId: "d", projectName: "Design", label: label("D-7") },
  ];
  assert.deepEqual(
    numbersLedBy(numbers, "w").map((n) => n.label.text),
    ["W-1", "L-1", "D-7"],
  );
  assert.equal(numbersLedBy(numbers, "zzz"), numbers, "a project that doesn't number it: unchanged");
  assert.deepEqual(numbersLedBy(null, "w"), []);
});

const NOVEMBER = calendarVisibleDays("2026-11-01", "month");

function teamCalendar(task: TeamCalendarTask) {
  return render(
    <TeamCalendar
      teamId="team1"
      month="2026-11"
      today="2026-11-12"
      days={NOVEMBER}
      tasks={[task]}
      projectCount={1}
      capped={false}
      events={[]}
      canEditEvents={false}
    />,
  );
}

const flyer: TeamCalendarTask = {
  id: "t1",
  title: "Flyer",
  startOn: null,
  dueOn: "2026-11-05",
  completedAt: null,
  assigneeId: null,
  kind: "task",
  projectId: "w",
  projectName: "Website",
  canEdit: false,
  requestLabel: label("W-1"),
  taskNumbers: [
    { projectId: "w", projectName: "Website", label: label("W-1") },
    { projectId: "a", projectName: "Launch", label: label("L-1") },
  ],
  numberProjectName: null,
};

test("team Calendar: the bar's project's own number goes with its name", () => {
  const html = teamCalendar(flyer);
  assert.match(html, /<span>W-1<\/span>[^]*?>\+1<[^]*?<span aria-hidden="true">·<\/span><span class="truncate">Website<\/span>/);
  assert.match(html, /, also L-1 in Launch/);
});

test("team Calendar: a number from another project is named with that project, not the bar's", () => {
  const html = teamCalendar({
    ...flyer,
    requestLabel: label("L-1"),
    taskNumbers: [{ projectId: "a", projectName: "Launch", label: label("L-1") }],
    numberProjectName: "Launch",
  });
  assert.match(html, /<span>L-1<\/span><span aria-hidden="true">·<\/span><span class="truncate">Launch<\/span>/);
  assert.doesNotMatch(html, /<span>L-1<\/span><span aria-hidden="true">·<\/span><span class="truncate">Website<\/span>/);
  // Where it is still reads: in Website (screen readers and the tooltip say whose number it is).
  assert.match(html, / in Website, numbered in Launch/);
  assert.match(html, /data-tooltip="L-1 Flyer · Website \(numbered in Launch\)"/);
});

// ---------------------------------------------------------------------------------------------
// The search palette's "+N" by keyboard
// ---------------------------------------------------------------------------------------------

test("a palette result spells out its other numbers while it's the highlighted option", () => {
  const numbers: TaskNumber[] = [
    { projectId: "a", projectName: "Launch", label: label("Req #1") },
    { projectId: "d", projectName: "Design", label: label("Design #14") },
    { projectId: "w", projectName: "Website", label: label("WEB-3") },
  ];
  const html = renderToStaticMarkup(
    <div role="option" aria-selected>
      <TaskNumberBadge numbers={numbers} more="inline-selected" />
    </div>,
  );
  // "+2" hides and "· Design #14 · WEB-3" shows under an aria-selected option (the palette's highlighted
  // result: focus stays in its input, so the option itself never has focus).
  assert.match(html, /class="[^"]*in-aria-selected:hidden[^"]*">\+2</);
  assert.match(html, /class="hidden in-aria-selected:inline">· Design #14 · WEB-3</);
  assert.match(html, /, also Design #14 in Design, WEB-3 in Website/, "screen readers hear them all");
  // The other inline modes are unchanged.
  const quiet = renderToStaticMarkup(<TaskNumberBadge numbers={numbers} more="inline-quiet" />);
  assert.doesNotMatch(quiet, /in-aria-selected/);
});

// ---------------------------------------------------------------------------------------------
// A review round's project
// ---------------------------------------------------------------------------------------------

test("a review round's project comes from the database (the email names the page's project)", () => {
  assert.deepEqual(parseRoundProject({ id: "r1", project_id: "p1", project_name: "Website" }), { id: "p1", name: "Website" });
  assert.equal(parseRoundProject({ id: "r1", project_id: null, project_name: null }), null, "a private task: none");
  assert.equal(parseRoundProject({ id: "r1" }), null, "a database without this release: none");
  assert.equal(parseRoundProject(null), null);
});
