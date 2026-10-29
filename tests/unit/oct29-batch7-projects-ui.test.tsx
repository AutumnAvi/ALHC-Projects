// Oct 29 notes, batch 7 — 55b (no home project), the app's UI: the number chips (every number in the
// pane, wrapping; the first number and "+N" with its list in tight places), the last-project Remove flow
// (delete the task instead, to the Trash), and no "home" anywhere a person reads.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { MyTasksWidget } from "@/components/home/my-tasks-widget";
import { MyTasksView } from "@/components/my-tasks/my-tasks-view";
import { InboxCard } from "@/components/inbox/inbox-card";
import { TrashView } from "@/components/project/trash-view";
import { SearchResults } from "@/components/search/search-results";
import { ShellProvider } from "@/components/shell/shell-context";
import { MoreTaskNumbers, TaskNumberBadge, TaskNumberChips } from "@/components/task/task-number";
import { TaskProjects } from "@/components/task/task-projects";
import { ToastProvider } from "@/components/toast";
import type { AwaitingApproval, InboxItem, MyTask, TaskDetail, TrashedTask } from "@/lib/data";
import { moreTaskNumbers, numberChips, paneTaskNumbers, type TaskNumber } from "@/lib/request-numbers";
import { DEFAULT_SIDEBAR_PREFS } from "@/lib/sidebar-prefs";
import { LAST_PROJECT_CODE, LAST_PROJECT_MESSAGE, lastProjectQuestion, removeFromProjectOrDelete } from "@/lib/task-projects";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const member = { id: "me", email: "me@example.com", name: "Me", avatarUrl: null };

function render(node: ReactNode, pathname = "/my-tasks") {
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

const P = (n: number) => `00000000-0000-4000-8000-0000000000a${n}`;
const n = (i: number, text: string, projectName: string, wrap = false): TaskNumber => ({ projectId: P(i), projectName, label: { text, wrap } });
const three: TaskNumber[] = [n(1, "Req #1", "Launch", true), n(2, "Design #14", "Website"), n(3, "WEB-3", "Ops")];
const six: TaskNumber[] = [...three, n(4, "MKT-8", "Marketing"), n(5, "SAL-2", "Sales"), n(6, "HR-40", "People")];

// ---------------------------------------------------------------------------------------------
// The "+N" and the chips (pure logic)
// ---------------------------------------------------------------------------------------------

test("+N: the others after the first number, the full list for hover, every other number for screen readers", () => {
  assert.equal(moreTaskNumbers(undefined), null);
  assert.equal(moreTaskNumbers([]), null);
  assert.equal(moreTaskNumbers(three.slice(0, 1)), null, "one number: no +N");
  assert.equal(moreTaskNumbers([three[0], { ...three[1], label: { text: "  ", wrap: false } }]), null, "a blank label isn't a number");

  const more = moreTaskNumbers(three)!;
  assert.equal(more.count, 2);
  assert.equal(more.text, "+2");
  assert.equal(more.list, "[Req #1] · Launch\nDesign #14 · Website\nWEB-3 · Ops", "one per line, first included, with projects");
  assert.equal(more.others, "Design #14 · WEB-3");
  assert.equal(more.spoken, "Design #14 in Website, WEB-3 in Ops");
  // A database without task_project_labels has no project names.
  assert.equal(
    moreTaskNumbers([
      { projectId: null, projectName: null, label: { text: "A-1", wrap: false } },
      { projectId: null, projectName: null, label: { text: "B-2", wrap: false } },
    ])!.spoken,
    "B-2",
  );
});

test("the pane's chips: every number in the stable order; the project on screen is marked, nothing moves", () => {
  const chips = numberChips(three, P(2));
  assert.deepEqual(
    chips.map((c) => [c.text, c.current, c.spoken]),
    [
      ["[Req #1]", false, "[Req #1] in Launch"],
      ["Design #14", true, "Design #14 in Website"],
      ["WEB-3", false, "WEB-3 in Ops"],
    ],
  );
  assert.ok(numberChips(three).every((c) => !c.current), "outside a project none is current");
  assert.ok(numberChips(three, P(9)).every((c) => !c.current), "a project without its own number marks none");
  assert.deepEqual(numberChips(null), []);
});

test("the pane's numbers: task_project_labels' list, else each listed project's own number, else the one label", () => {
  const memberships = [
    { projectId: P(1), projectName: "Launch" },
    { projectId: P(2), projectName: "Website" },
  ];
  assert.deepEqual(paneTaskNumbers({ taskNumbers: three, memberships, projectNumbers: {}, requestLabel: null }), three);
  assert.deepEqual(
    paneTaskNumbers({
      taskNumbers: [],
      memberships,
      projectNumbers: { [P(2)]: { text: "Design #14", wrap: false } },
      requestLabel: { text: "Req #1", wrap: true },
    }),
    [n(2, "Design #14", "Website")],
  );
  assert.deepEqual(paneTaskNumbers({ memberships: [], projectNumbers: null, requestLabel: { text: "Req #1", wrap: true } }), [
    { projectId: null, projectName: null, label: { text: "Req #1", wrap: true } },
  ]);
  assert.deepEqual(paneTaskNumbers({ memberships, requestLabel: null }), [], "no numbers, no chips");
});

// ---------------------------------------------------------------------------------------------
// The one component
// ---------------------------------------------------------------------------------------------

test("TaskNumberBadge: the first number and +N; inside a link the list is on hover, spelled out on keyboard focus, and read out", () => {
  const html = renderToStaticMarkup(<TaskNumberBadge numbers={three} />);
  assert.match(html, /<span>\[Req #1\]<\/span>/, "the first number");
  assert.match(html, /data-tooltip="\[Req #1\] · Launch\nDesign #14 · Website\nWEB-3 · Ops"/);
  assert.match(html, />\+2<\/span>/);
  assert.match(html, /in-focus-visible:hidden/, "+N gives way to the list while the link has keyboard focus");
  assert.match(html, /hidden in-focus-visible:inline[^>]*>· Design #14 · WEB-3</);
  assert.match(html, /class="sr-only">, also Design #14 in Website, WEB-3 in Ops</);
  assert.doesNotMatch(html, /<button/, "nothing focusable inside a link");

  const quiet = renderToStaticMarkup(<TaskNumberBadge numbers={three} more="inline-quiet" />);
  assert.doesNotMatch(quiet, /in-focus-visible/, "a list option / calendar bar doesn't spell them out");
  assert.match(quiet, /, also Design #14 in Website/);

  const one = renderToStaticMarkup(<TaskNumberBadge numbers={three.slice(0, 1)} />);
  assert.doesNotMatch(one, /\+\d/, "one number: no +N");
  assert.match(one, /\[Req #1\]/);
  // An explicit label still wins (the screen's own project), and the older API is unchanged.
  assert.match(renderToStaticMarkup(<TaskNumberBadge label={{ text: "WEB-3", wrap: false }} numbers={three} />), /<span>WEB-3<\/span>/);
  assert.equal(renderToStaticMarkup(<TaskNumberBadge numbers={[]} />), "");
});

test("MoreTaskNumbers: a real button (hover, focus, or tap lists them) outside links; nothing for one number", () => {
  const html = renderToStaticMarkup(<MoreTaskNumbers numbers={three} />);
  assert.match(html, /<button type="button" draggable="false" data-more-numbers=""/);
  assert.match(html, /aria-label="2 more numbers: Design #14 in Website, WEB-3 in Ops"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, />\+2<\/button>/);
  assert.equal(renderToStaticMarkup(<MoreTaskNumbers numbers={three.slice(0, 1)} />), "");
  assert.equal(renderToStaticMarkup(<MoreTaskNumbers numbers={undefined} />), "");
  assert.match(renderToStaticMarkup(<MoreTaskNumbers numbers={three.slice(0, 2)} />), /aria-label="1 more number: Design #14 in Website"/);
});

test("TaskNumberChips: six projects wrap onto more lines, each chip naming its project; the current one marked", () => {
  const html = renderToStaticMarkup(<TaskNumberChips numbers={six} currentProjectId={P(5)} />);
  assert.match(html, /<ul aria-label="Task numbers" data-task-numbers="" class="flex flex-wrap/);
  assert.equal((html.match(/<li /g) ?? []).length, 6);
  const order = ["[Req #1]", "Design #14", "WEB-3", "MKT-8", "SAL-2", "HR-40"].map((t) => html.indexOf(`data-task-number="">${t}<`));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), "the stable order");
  assert.match(html, /data-tooltip="Sales" data-current-number=""/);
  assert.equal((html.match(/data-current-number/g) ?? []).length, 1);
  assert.match(html, /class="sr-only">SAL-2 in Sales \(this project\)</);
  assert.match(renderToStaticMarkup(<TaskNumberChips numbers={six.slice(0, 1)} />), /aria-label="Task number"/);
  assert.equal(renderToStaticMarkup(<TaskNumberChips numbers={[]} />), "");
});

// ---------------------------------------------------------------------------------------------
// Tight places
// ---------------------------------------------------------------------------------------------

function myTask(overrides: Partial<MyTask> = {}): MyTask {
  return {
    id: "t1",
    title: "[Req #1] Brochure",
    completedAt: null,
    dueOn: null,
    projectId: P(1),
    projectName: "Launch",
    kind: "task",
    parentTitle: null,
    requestLabel: { text: "Req #1", wrap: true },
    taskNumbers: three,
    canEdit: true,
    ...overrides,
  };
}

test("Home → My tasks: the name with its first number, then a +N button that lists them all", () => {
  const html = render(<MyTasksWidget tasks={{ upcoming: [myTask()], overdue: [], completed: [] }} />, "/");
  assert.match(html, />\[Req #1\] Brochure</);
  assert.match(html, /aria-label="2 more numbers: Design #14 in Website, WEB-3 in Ops"/);
  const single = render(<MyTasksWidget tasks={{ upcoming: [myTask({ taskNumbers: three.slice(0, 1) })], overdue: [], completed: [] }} />, "/");
  assert.doesNotMatch(single, /data-more-numbers/, "one project, no +N");
});

test("My tasks: +N right after the name on editable and read-only rows and in Waiting on me", () => {
  const awaiting: AwaitingApproval[] = [
    {
      requestId: "r1",
      taskId: "t9",
      title: "Spring flyer",
      requestLabel: three[0].label,
      taskNumbers: three.slice(0, 2),
      projectId: P(1),
      projectName: "Launch",
      dueOn: null,
      sentAt: "2026-10-25T10:00:00Z",
      roundNumber: 1,
      isApprovalTask: true,
    },
  ];
  const html = render(
    <MyTasksView
      completed={[]}
      bulk={{ viewerId: "me", people: [], projects: [] }}
      layout="sections"
      sections={[{ id: "ms1", kind: "recently_assigned", name: "Recently assigned", sortOrder: 1024 }]}
      placements={{}}
      open={[myTask(), myTask({ id: "t2", title: "[Req #2] Read only", canEdit: false, taskNumbers: three.slice(1) })]}
      awaiting={awaiting}
    />,
  );
  // Editable: rename button, then +2, then the open-details arrow.
  assert.match(html, /aria-label="Rename “\[Req #1\] Brochure”"[^]*?aria-label="2 more numbers: Design #14 in Website, WEB-3 in Ops"/);
  assert.match(html, /aria-label="1 more number: WEB-3 in Ops"/, "read-only rows too");
  assert.match(html, /aria-label="1 more number: Design #14 in Website"/, "Waiting on me to approve");
  assert.doesNotMatch(html, /[Hh]ome project/);
});

function inboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "i1",
    kind: "comment",
    data: {},
    actorId: null,
    readAt: null,
    archivedAt: null,
    bookmarkedAt: null,
    createdAt: "2026-10-29T00:00:00Z",
    taskId: "t1",
    taskTitle: "[Req #1] Brochure",
    parentTitle: null,
    commentBody: "Looks good",
    message: null,
    teamMessage: null,
    statusUpdate: null,
    project: null,
    approval: null,
    emailFrom: null,
    taskNumbers: three,
    ...overrides,
  };
}

test("Inbox: +N right after the task's name inside the card's link (hover list, read out, spelled out on focus)", () => {
  const html = render(
    <ul>
      <InboxCard
        item={inboxItem()}
        actor={undefined}
        state={{ read: false, archived: false, bookmarked: false }}
        density="detailed"
        active={false}
        href="/inbox?task=t1"
        memberId="me"
        bookmarks={false}
        onOpen={() => {}}
        onRead={() => {}}
        onArchive={() => {}}
        onBookmark={() => {}}
        onDecide={() => {}}
      />
    </ul>,
    "/inbox",
  );
  assert.match(html, /\[Req #1\] Brochure<\/span><span class="inline-flex shrink-0 items-center ml-1 align-baseline">/);
  assert.match(html, /data-tooltip="\[Req #1\] · Launch\nDesign #14 · Website\nWEB-3 · Ops"/);
  assert.match(html, /, also Design #14 in Website, WEB-3 in Ops/);
  assert.match(html, /relative z-\[1\]/, "above the card's stretched link, so hovering shows the list");
});

test("Search: the first number and +N in front of the name", () => {
  const html = render(
    <SearchResults
      query="brochure"
      tags={[]}
      results={[
        {
          id: "t1",
          title: "Brochure",
          label: three[0].label,
          numbers: three,
          notes: null,
          completed: false,
          dueOn: null,
          projectId: P(1),
          projectName: "Launch",
          tagIds: [],
        },
      ]}
    />,
    "/search",
  );
  assert.match(html, /<span>\[Req #1\]<\/span><span aria-hidden="true" data-tooltip=/);
  assert.match(html, />\+2</);
  assert.match(html, /, also Design #14 in Website, WEB-3 in Ops/);
});

// ---------------------------------------------------------------------------------------------
// Removing a project, and no "home"
// ---------------------------------------------------------------------------------------------

test("Remove from a project that isn't the last: removed there, nothing asked", async () => {
  const calls: string[] = [];
  const outcome = await removeFromProjectOrDelete({
    remove: async () => (calls.push("remove"), {}),
    ask: async () => (calls.push("ask"), true),
    deleteTask: async () => (calls.push("delete"), {}),
  });
  assert.deepEqual(outcome, { kind: "removed" });
  assert.deepEqual(calls, ["remove"]);
});

test("Remove from the last project: asks to delete the task instead; yes deletes it (to the Trash), no keeps it", async () => {
  const refused = { error: LAST_PROJECT_MESSAGE, code: LAST_PROJECT_CODE };
  const calls: string[] = [];
  const yes = await removeFromProjectOrDelete({
    remove: async () => (calls.push("remove"), refused),
    ask: async () => (calls.push("ask"), true),
    deleteTask: async () => (calls.push("delete"), {}),
  });
  assert.deepEqual(yes, { kind: "deleted" });
  assert.deepEqual(calls, ["remove", "ask", "delete"]);

  calls.length = 0;
  const no = await removeFromProjectOrDelete({
    remove: async () => (calls.push("remove"), refused),
    ask: async () => (calls.push("ask"), false),
    deleteTask: async () => (calls.push("delete"), {}),
  });
  assert.deepEqual(no, { kind: "kept" });
  assert.deepEqual(calls, ["remove", "ask"], "nothing deleted");

  const failed = await removeFromProjectOrDelete({
    remove: async () => refused,
    ask: async () => true,
    deleteTask: async () => ({ error: "Your role in this project doesn’t allow that" }),
  });
  assert.deepEqual(failed, { kind: "error", error: "Your role in this project doesn’t allow that" });

  let asked = false;
  const other = await removeFromProjectOrDelete({
    remove: async () => ({ error: "Not found" }),
    ask: async () => ((asked = true), true),
    deleteTask: async () => ({}),
  });
  assert.deepEqual(other, { kind: "error", error: "Not found" });
  assert.equal(asked, false, "only the last-project refusal asks");

  // What the dialog says (useConfirm's options).
  assert.deepEqual(lastProjectQuestion("Brochure", "Launch"), {
    title: "“Brochure” is only in Launch",
    message: "Delete the task instead? It goes to the Trash and you can restore it.",
    confirmLabel: "Delete task",
    tone: "danger",
  });
});

function paneTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "t1",
    title: "Brochure",
    isSubtask: false,
    isPrivate: false,
    ancestors: [],
    memberships: [{ projectId: P(1), projectName: "Launch", sectionId: null, sections: [] }],
    editableProjectIds: [P(1), P(2)],
    projectNumbers: { [P(1)]: { text: "Req #1", wrap: true } },
    ...overrides,
  } as TaskDetail;
}

test("the pane's Projects row: no house icon or Make home; every project has Remove, the only one too", () => {
  const one = render(<TaskProjects task={paneTask()} addableProjects={[]} canEdit />, `/projects/${P(1)}/list`);
  assert.match(one, /aria-label="More for Launch"/, "the only project can be removed (the database asks to delete instead)");
  assert.doesNotMatch(one, /[Hh]ome/);
  const two = render(
    <TaskProjects
      task={paneTask({
        memberships: [
          { projectId: P(1), projectName: "Launch", sectionId: null, sections: [] },
          { projectId: P(2), projectName: "Website", sectionId: null, sections: [] },
        ],
      })}
      addableProjects={[]}
      canEdit
    />,
    `/projects/${P(1)}/list`,
  );
  assert.ok(two.indexOf("Launch") < two.indexOf("Website"), "in the order the task was added to them");
  assert.match(two, /aria-label="More for Launch"/);
  assert.match(two, /aria-label="More for Website"/);
  assert.doesNotMatch(two, /[Hh]ome/);
  const viewer = render(<TaskProjects task={paneTask()} addableProjects={[]} canEdit={false} />);
  assert.doesNotMatch(viewer, /More for/, "below Editor nothing to remove");
  // An Editor of Launch who only views Website: Website's section and removal aren't theirs to change
  // (task_projects' RLS needs Editor in that project; the remove would change nothing).
  const mixed = render(
    <TaskProjects
      task={paneTask({
        memberships: [
          { projectId: P(1), projectName: "Launch", sectionId: null, sections: [] },
          { projectId: P(2), projectName: "Website", sectionId: null, sections: [] },
        ],
        editableProjectIds: [P(1)],
      })}
      addableProjects={[]}
      canEdit
    />,
  );
  assert.match(mixed, /aria-label="More for Launch"/);
  assert.match(mixed, /aria-label="Section in Launch: No section\. Change"/);
  assert.doesNotMatch(mixed, /More for Website/, "no Remove where the viewer isn't an Editor");
  assert.doesNotMatch(mixed, /Section in Website/, "and no section menu there");
});

test("the Trash names a task's other projects, never a home project", () => {
  const tasks: TrashedTask[] = [
    { id: "t1", title: "Brochure", deletedAt: "2026-10-29T00:00:00Z", deletedBy: null, otherProjectNames: ["Website", "Ops"], completedAt: null, parentTitle: null },
    { id: "t2", title: "Poster", deletedAt: "2026-10-29T00:00:00Z", deletedBy: null, otherProjectNames: [], completedAt: null, parentTitle: null },
  ];
  const html = render(<TrashView tasks={tasks} profiles={[]} />, `/projects/${P(1)}/settings/trash`);
  assert.match(html, / · also in Website, Ops/);
  assert.doesNotMatch(html, /home project/i);
});
