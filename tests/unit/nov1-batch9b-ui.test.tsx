// Nov 1 notes, batch 9b — the screens: the My tasks checklist (item 64) and the new Home (item 65),
// rendered on the server like the browser's first paint.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { LeadCards } from "@/components/home/lead-cards";
import { MyProjectsCard } from "@/components/home/my-projects-card";
import { NeedsYouCard } from "@/components/home/needs-you-card";
import { TodayCard } from "@/components/home/today-card";
import { MyTasksChecklist } from "@/components/my-tasks/my-tasks-checklist";
import { QuickAddBar } from "@/components/my-tasks/quick-add";
import { ShellProvider } from "@/components/shell/shell-context";
import { ToastProvider } from "@/components/toast";
import type { CheckedMode } from "@/lib/checklist";
import type { MyTask } from "@/lib/api/my-tasks/model";
import { parseHomeDashboard, progressOf } from "@/lib/home";
import { DEFAULT_SIDEBAR_PREFS } from "@/lib/sidebar-prefs";
import { myTasksLayoutOf } from "@/lib/my-tasks";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const member = { id: "me", email: "me@example.com", name: "Me", avatarUrl: null };

function render(node: ReactNode, path = "/my-tasks") {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value={path}>
        <SearchParamsContext.Provider value={new URLSearchParams() as never}>
          <ShellProvider member={member as never} isWorkspaceAdmin={false} workspace={{ name: "ALHC", logoUrl: null }} initialSidebar={DEFAULT_SIDEBAR_PREFS}>
            <ToastProvider>{node}</ToastProvider>
          </ShellProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

const TODAY = "2026-11-01";
const task = (id: string, title: string, extra: Partial<MyTask> = {}): MyTask => ({
  id,
  title,
  completedAt: null,
  dueOn: null,
  projectId: "p1",
  projectName: "Fall Campaign",
  kind: "task",
  parentTitle: null,
  canEdit: true,
  canComment: true,
  ...extra,
});

const open = [
  task("t-overdue", "Overdue thing", { dueOn: "2026-10-28" }),
  task("t-today", "Today thing", { dueOn: TODAY, recurring: true }),
  task("t-week", "This week thing", { dueOn: "2026-11-04" }),
  task("t-later", "Later thing", { dueOn: "2026-12-01" }),
  task("t-none", "No date thing"),
  task("t-new", "New from Dana", { datePrompt: true }),
  task("t-readonly", "Read only thing", { canEdit: false, canComment: false }),
];
const completed = [
  task("t-done-today", "Finished today", { completedAt: "2026-11-01T09:00:00Z", dueOn: TODAY }),
  task("t-done-old", "Finished last week", { completedAt: "2026-10-25T09:00:00Z" }),
];

function checklist(checked: CheckedMode) {
  return render(
    <MyTasksChecklist
      open={open}
      completed={completed}
      checked={checked}
      workWeek={[0, 1, 2, 3, 4]}
      projects={[{ id: "p1", name: "Fall Campaign" }]}
      people={[{ id: "u1", name: "Dana Diaz", email: "dana@example.com" }]}
      awaiting={[]}
      today={TODAY}
      timeZone="UTC"
    />,
  );
}

const order = (html: string, ...needles: string[]) => {
  const at = needles.map((n) => html.indexOf(n));
  assert.ok(at.every((i) => i >= 0), `all present: ${needles.join(", ")}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, `in order: ${needles.join(" < ")}`);
};

test("64: one list in automatic date groups, No date last and prominent", () => {
  const html = checklist("sink");
  order(html, ">Overdue<", ">Today<", ">This week<", ">Later<", ">No date<");
  order(html, "Overdue thing", "Today thing", "This week thing", "Later thing");
  assert.match(html, /id="checklist-none"[^>]*class="[^"]*border-dashed/, "No date is a card of its own");
  assert.ok(!html.includes("Asana"), "nothing Asana-styled");
  assert.ok(!html.includes("Recently assigned"), "no hand-filed buckets");
});

test("64: no-date rows have one-tap chips; new dateless assignments ask for a date", () => {
  const html = checklist("sink");
  const none = html.slice(html.indexOf('id="checklist-none"'));
  for (const label of [">Today<", ">Tomorrow<", ">This week<", "Pick date"]) assert.ok(none.includes(label), `chip ${label}`);
  assert.ok(html.includes("1 new task has"), "the Set a date banner");
  assert.ok(none.indexOf("New from Dana") < none.indexOf("No date thing"), "new dateless assignments first");
  assert.ok(none.includes("New · Set a date") && none.includes("Not now"));
  // A task the viewer can't edit gets no chips and a read-only mark.
  const readOnly = none.slice(none.indexOf("Read only thing"));
  assert.ok(!readOnly.slice(0, readOnly.indexOf("</li>")).includes("Pick date"));
});

test("64: checked items sink into a collapsed Done today; stay keeps them in place; hide tucks them away", () => {
  const sink = checklist("sink");
  assert.match(sink, /aria-expanded="false"[^>]*>[\s\S]*Done today/);
  assert.ok(!sink.includes("Finished today"), "collapsed: the row isn't drawn");
  assert.ok(!sink.includes(">Finished last week<"), "yesterday's ticks are gone (only in Completed earlier, collapsed)");
  assert.ok(sink.includes("Completed earlier (1)"));

  const stay = checklist("stay");
  assert.ok(stay.includes("Finished today"), "stay: struck through in its group");
  assert.match(stay, /line-through[^>]*>Finished today/);
  assert.ok(!stay.includes(">Done today<"));

  const hide = checklist("hide");
  assert.ok(hide.includes("Show 1 done today"));
  assert.ok(!hide.includes("Finished today"));
});

test("64: big tap targets, repeat marker, and the options menu", () => {
  const html = checklist("sink");
  assert.ok(html.includes("before:-inset-[11px]"), "the check's hit area reaches 44px");
  assert.ok(html.includes("text-[15px]"), "larger text than the rest of the app");
  assert.ok(html.includes(">Repeats<"), "repeating tasks are marked");
  assert.ok(html.includes("View options"));
  assert.ok(html.includes('role="combobox"'), "the quick add");
});

test("64: the view cookie opens the checklist unless a classic view was chosen", () => {
  assert.equal(myTasksLayoutOf(undefined), "checklist");
  assert.equal(myTasksLayoutOf("nonsense"), "checklist");
  assert.equal(myTasksLayoutOf("sections"), "sections");
  assert.equal(myTasksLayoutOf("due"), "due");
});

test("64: quick add renders as a labelled combobox", () => {
  const html = render(<QuickAddBar projects={[]} people={[]} />);
  assert.ok(html.includes(">Add a task<"), "a label for screen readers");
  assert.ok(html.includes('aria-autocomplete="list"'));
});

test("65: Home's Today is the checklist's Overdue and Today", () => {
  const html = render(
    <TodayCard
      open={open}
      completed={completed}
      checked="sink"
      workWeek={[0, 1, 2, 3, 4]}
      projects={[]}
      people={[]}
      laterCount={5}
      today={TODAY}
      timeZone="UTC"
    />,
    "/",
  );
  assert.ok(html.includes("Overdue thing") && html.includes("Today thing"));
  assert.ok(!html.includes("This week thing") && !html.includes("No date thing"), "the rest stays in My tasks");
  assert.ok(html.includes("5 more in My tasks"));
});

test("65: Needs you lists approvals, mentions, Inbox items, and new tasks without a date", () => {
  const html = render(
    <NeedsYouCard
      approvals={[
        { requestId: "r1", taskId: "a1", title: "Approve banner", requestLabel: null, projectId: "p1", projectName: "P", dueOn: TODAY, sentAt: "2026-10-31T10:00:00Z", roundNumber: 1, isApprovalTask: true },
      ]}
      mentions={[
        {
          id: "i1", kind: "mention", data: {}, actorId: "u1", readAt: null, archivedAt: null, bookmarkedAt: null, createdAt: "2026-11-01T08:00:00Z",
          taskId: "t1", taskTitle: "Spring flyer", parentTitle: null, commentBody: "hi", message: null, teamMessage: null, statusUpdate: null,
          project: null, approval: null, emailFrom: null,
        },
      ]}
      inbox={[]}
      unreadTotal={12}
      undatedCount={2}
      actors={[{ id: "u1", email: "dana@example.com", full_name: "Dana Diaz", avatar_url: null }]}
    />,
    "/",
  );
  order(html, "2 new tasks need a date", "Approvals waiting on you", "Approve banner", "Mentions", "Dana Diaz");
  assert.ok(html.includes("mentioned you on"));
  assert.ok(html.includes("Inbox · 12 unread"));
});

test("65: my projects with progress; the four lead cards only when the data has them", () => {
  const data = parseHomeDashboard({
    projects: [{ id: "p1", name: "Fall Campaign", status: "at_risk", status_set: true, starred: true, my_open: 3, total: 10, completed: 4, overdue: 1 }],
    lead: {
      project_count: 2,
      workspace_admin: false,
      week_start: "2026-11-01",
      load: { people: [{ profile_id: "u1", name: "Dana Diaz", open: 14, due_week: 12, overdue: 2 }], people_count: 1, unassigned: 3 },
      late: { overdue: 1, at_risk: 1, tasks: [{ id: "l1", title: "Late one", due_on: "2026-10-30", overdue: true, assignee_id: "u1", assignee_name: "Dana Diaz", project_id: "p1", project_name: "Fall Campaign" }] },
      health: [{ id: "p1", name: "Fall Campaign", status: "at_risk", status_set: true, total: 10, completed: 4, overdue: 1, done_week: 2 }],
      done: { total: 6, people: [{ profile_id: "u1", name: "Dana Diaz", count: 4 }, { profile_id: null, name: null, count: 2 }] },
    },
  });
  assert.equal(progressOf(4, 10), 40);
  assert.equal(progressOf(0, 0), null);
  const projects = render(<MyProjectsCard projects={data.projects} archivedCount={1} />, "/");
  assert.ok(projects.includes("Fall Campaign") && projects.includes('aria-valuenow="40"'));
  assert.ok(projects.includes("3 tasks for you") && projects.includes("At risk") && projects.includes("Archived projects (1)"));

  assert.ok(data.lead);
  const lead = render(<LeadCards lead={data.lead!} today={TODAY} />, "/");
  order(lead, "Team load", "Late &amp; at risk", "Project health", "Done this week");
  assert.ok(lead.includes("bg-red-500"), "over the soft cap reads red");
  assert.ok(lead.includes("3 open tasks with nobody assigned"));
  assert.ok(lead.includes("Late one") && lead.includes("Nobody assigned"));
  assert.ok(lead.includes("you lead"));
  assert.equal(parseHomeDashboard({ projects: [], lead: null }).lead, null, "no lead cards for everyone else");
  assert.deepEqual(parseHomeDashboard("garbage"), { projects: [], lead: null });
});
