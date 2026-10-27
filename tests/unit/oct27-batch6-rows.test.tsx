// Oct 27 notes, batch 6 — list rows: subtasks open under their row (41), a blocked task's completion
// control is a lock (43), and every visible cell edits in place for Editors (46), in List, Board, and
// My tasks; plus My tasks' "Waiting on me to approve".
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { MyTasksView, expandableMyTasks, myTaskRootId } from "@/components/my-tasks/my-tasks-view";
import { BoardView } from "@/components/project/board-view";
import {
  applyRowPatches,
  blockedCount,
  blockedSkipMessage,
  flattenSubtaskRows,
  groupSubtasksByRoot,
  mergeDateEdit,
  mergeSubtaskTrees,
  rootsToLoad,
  rowExpanded,
  splitBlocked,
  subtaskRootIds,
} from "@/components/project/inline-cells";
import { ListView } from "@/components/project/list-view";
import { ProjectAccessProvider } from "@/components/project/project-access";
import { ShellProvider } from "@/components/shell/shell-context";
import { ToastProvider } from "@/components/toast";
import type { AwaitingApproval, MyTask, Profile, ProjectTask, Section, SubtaskItem } from "@/lib/data";
import type { FieldDef } from "@/lib/fields";
import { DEFAULT_SIDEBAR_PREFS } from "@/lib/sidebar-prefs";
import { subtasksByParent } from "@/lib/subtasks";
import { parseViewConfig } from "@/lib/views";
import type { ProjectRole } from "@/lib/roles";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const member = { id: "me", email: "me@example.com", name: "Me", avatarUrl: null };

function render(node: ReactNode, role: ProjectRole | null = null) {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value="/projects/p1/list">
        <SearchParamsContext.Provider value={new URLSearchParams() as never}>
          <ShellProvider member={member as never} isWorkspaceAdmin={false} workspace={{ name: "ALHC", logoUrl: null }} initialSidebar={DEFAULT_SIDEBAR_PREFS}>
            <ToastProvider>
              <ProjectAccessProvider role={role}>{node}</ProjectAccessProvider>
            </ToastProvider>
          </ShellProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

const section: Section = { id: "s1", project_id: "p1", name: "To do", sort_order: 1024 };
const amy: Profile = { id: "amy", email: "amy@example.com", full_name: "Amy Pond", avatar_url: null };

function task(over: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: "t1",
    title: "Write the brief",
    completedAt: null,
    startOn: null,
    dueOn: null,
    assigneeId: null,
    homeProjectId: "p1",
    createdAt: "2026-10-01T00:00:00Z",
    sectionId: "s1",
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
    ...over,
  };
}

function sub(id: string, parentId: string, over: Partial<SubtaskItem> = {}): SubtaskItem {
  return {
    id,
    parentId,
    title: `Subtask ${id}`,
    completedAt: null,
    assigneeId: null,
    startOn: null,
    dueOn: null,
    kind: "task",
    sortOrder: 1024,
    subtaskCount: 0,
    subtaskDoneCount: 0,
    ...over,
  };
}

const F1 = "00000000-0000-4000-8000-0000000000f1";
const priority: FieldDef = {
  id: F1,
  projectId: "p1",
  name: "Priority",
  fieldType: "single_select",
  options: [{ id: "o1", name: "High", color: "red" }],
  boundToSections: false,
  showInViews: true,
  sortOrder: 1,
  description: null,
  notifyOnChange: false,
  inLibrary: false,
};

const viewProps = {
  projectId: "p1",
  sections: [section],
  profiles: [amy],
  fields: [priority],
  config: parseViewConfig({}),
  tags: [],
  sectionTaskCounts: { s1: 2 },
};

// ---------------------------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------------------------

test("blocked: only open tasks with blockers count; shortcuts skip them with one toast", () => {
  assert.equal(blockedCount({ completedAt: null, blockedBy: 2 }), 2);
  assert.equal(blockedCount({ completedAt: "2026-10-27T00:00:00Z", blockedBy: 2 }), 0, "a completed task isn't blocked");
  assert.equal(blockedCount({ completedAt: null }), 0, "unknown = not blocked");
  const tasks = [
    { id: "a", title: "Spring flyer", completedAt: null, blockedBy: 2 },
    { id: "b", title: "Logo", completedAt: null, blockedBy: 0 },
    { id: "c", title: "Banner", completedAt: null, blockedBy: 1 },
  ];
  const { allowed, blocked } = splitBlocked(tasks);
  assert.deepEqual(allowed.map((t) => t.id), ["b"]);
  assert.deepEqual(blocked.map((t) => t.id), ["a", "c"]);
  assert.equal(blockedSkipMessage([tasks[0]]), "“Spring flyer” is blocked by 2 tasks");
  assert.equal(blockedSkipMessage([tasks[2]]), "“Banner” is blocked by 1 task");
  assert.equal(blockedSkipMessage(blocked), "“Spring flyer” is blocked by 2 tasks; 1 more blocked task was left open");
  assert.equal(blockedSkipMessage([]), null);
});

test("subtask trees: roots, grouping, merging (the server's copy wins), and patches", () => {
  const items = [sub("a", "t1"), sub("a1", "a"), sub("a1x", "a1"), sub("b", "t2")];
  assert.deepEqual([...subtaskRootIds(items)].sort(), ["t1", "t2"]);
  const grouped = groupSubtasksByRoot(items, ["t1", "t2", "t3"]);
  assert.deepEqual(grouped.get("t1")?.map((s) => s.id), ["a", "a1", "a1x"]);
  assert.deepEqual(grouped.get("t3"), [], "a root without subtasks gets an empty tree");

  const server = [sub("a", "t1", { title: "Fresh" })];
  const client = { t1: { items: [sub("a", "t1", { title: "Stale" }), sub("old", "t1")] }, t2: { items: [sub("b", "t2")] } };
  const merged = mergeSubtaskTrees(server, client, new Set(["t1"]));
  assert.deepEqual(merged.map((s) => [s.id, s.title]), [["a", "Fresh"], ["b", "Subtask b"]], "t1 comes from the server only");

  const patched = applyRowPatches(merged, { b: { title: "Renamed", dueOn: "2026-11-02" } });
  assert.equal(patched[1].title, "Renamed");
  assert.equal(patched[1].dueOn, "2026-11-02");
  assert.equal(applyRowPatches(merged, {}), merged, "no patches: the same list");
});

test("expanded rows: kept per person, every row with Show subtasks, nested levels flattened in order", () => {
  const expanded = new Set(["t1", "a"]);
  assert.equal(rowExpanded("t1", { showAll: false, expanded, collapsed: new Set() }), true);
  assert.equal(rowExpanded("t2", { showAll: false, expanded, collapsed: new Set() }), false);
  assert.equal(rowExpanded("t2", { showAll: true, expanded, collapsed: new Set() }), true, "Show subtasks opens every row");
  assert.equal(rowExpanded("t2", { showAll: true, expanded, collapsed: new Set(["t2"]) }), false, "unless closed for this visit");

  const childrenOf = subtasksByParent([
    sub("a", "t1", { sortOrder: 1, subtaskCount: 1 }),
    sub("b", "t1", { sortOrder: 2 }),
    sub("a1", "a", { sortOrder: 1 }),
  ]);
  const open = flattenSubtaskRows("t1", "Write the brief", childrenOf, (id) => expanded.has(id));
  assert.deepEqual(
    open.map((r) => [r.item.id, r.depth, r.parentTitle, r.hasChildren, r.expanded]),
    [
      ["a", 1, "Write the brief", true, true],
      ["a1", 2, "Subtask a", false, false],
      ["b", 1, "Write the brief", false, false],
    ],
  );
  const closed = flattenSubtaskRows("t1", "Write the brief", childrenOf, () => false);
  assert.deepEqual(closed.map((r) => r.item.id), ["a", "b"], "a closed subtask hides its own subtasks");

  const rows = [
    { id: "t1", rootId: "t1" },
    { id: "t2", rootId: "t2" },
    { id: "t3", rootId: "t3" },
  ];
  const isExpanded = (id: string) => id !== "t3";
  assert.deepEqual(
    rootsToLoad({ rows, isExpanded, serverRoots: new Set(["t1"]), client: {}, version: 0 }),
    ["t2"],
    "open rows the server didn't load",
  );
  assert.deepEqual(rootsToLoad({ rows, isExpanded, serverRoots: new Set(["t1"]), client: { t2: { version: 0 } }, version: 0 }), []);
  assert.deepEqual(
    rootsToLoad({ rows, isExpanded, serverRoots: new Set(["t1"]), client: { t2: { version: 0 } }, version: 1 }),
    ["t2"],
    "after a server render, trees loaded here are read again",
  );
});

test("row date edits: only what changed, milestones have no start, a late start takes the due date", () => {
  const current = { startOn: "2026-11-01", dueOn: "2026-11-05" };
  assert.deepEqual(mergeDateEdit(current, { dueOn: "2026-11-07" }), { startOn: "2026-11-01", dueOn: "2026-11-07" });
  assert.deepEqual(mergeDateEdit(current, { startOn: "2026-11-09" }), { startOn: "2026-11-09", dueOn: "2026-11-09" });
  assert.equal(mergeDateEdit(current, { dueOn: "2026-11-05" }), null, "no change, no save");
  assert.deepEqual(mergeDateEdit({ startOn: null, dueOn: null }, { startOn: "2026-11-01", dueOn: "2026-11-03" }, true), {
    startOn: null,
    dueOn: "2026-11-03",
  });
  assert.deepEqual(mergeDateEdit(current, { startOn: null, dueOn: null }), { startOn: null, dueOn: null });
});

// ---------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------

test("List: an expand arrow only on rows with subtasks", () => {
  const html = render(
    <ListView {...viewProps} tasks={[task(), task({ id: "t2", title: "Pick the photos", sortOrder: 2048, subtaskCount: 2, subtaskDoneCount: 1 })]} />,
    "viewer",
  );
  assert.match(html, /aria-label="Show subtasks of “Pick the photos”"/);
  assert.ok(!/subtasks of “Write the brief”/.test(html), "no arrow without subtasks");
  assert.match(html, /<button[^>]*aria-expanded="false"[^>]*aria-label="Show subtasks of “Pick the photos”"/);
  assert.ok(!html.includes("data-subtask-row"), "closed: no subtask rows");
});

test("List: an open row shows its subtasks, indented per level; nested rows open too", () => {
  const tasks = [task({ id: "t1", subtaskCount: 2 })];
  const subtasks = [sub("a", "t1", { sortOrder: 1, subtaskCount: 1 }), sub("b", "t1", { sortOrder: 2 }), sub("a1", "a")];
  const html = render(<ListView {...viewProps} tasks={tasks} subtasks={subtasks} expandedTaskIds={["t1", "a"]} />, "editor");
  assert.match(html, /aria-label="Hide subtasks of “Write the brief”"/);
  assert.match(html, /<ul aria-label="Subtasks of “Write the brief”">/);
  const order = [...html.matchAll(/data-subtask-row="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["a", "a1", "b"], "a's own subtask sits right under it");
  // Editors: 3.25rem to the parent's arrow, then 1.5rem per level.
  assert.match(html, /data-subtask-row="a"[\s\S]*?padding-left:4\.75rem/);
  assert.match(html, /data-subtask-row="a1"[\s\S]*?padding-left:6\.25rem/);
  assert.match(html, /aria-label="Hide subtasks of “Subtask a”"/, "a subtask with subtasks has its own arrow");
  // Nested rows edit in place for Editors.
  assert.match(html, /aria-label="Rename “Subtask a1”"/);
  assert.match(html, /aria-label="Assignee of “Subtask b”: nobody\. Change"/);
  assert.match(html, /aria-label="Due date of “Subtask b”: none\. Change"/);
  assert.match(html, /aria-label="Mark “Subtask b” complete"/);

  const viewer = render(<ListView {...viewProps} tasks={tasks} subtasks={subtasks} expandedTaskIds={["t1"]} />, "viewer");
  assert.deepEqual([...viewer.matchAll(/data-subtask-row="([^"]+)"/g)].map((m) => m[1]), ["a", "b"], "a1 stays under its closed parent");
  assert.ok(!/Rename “Subtask|Assignee of “Subtask|Mark “Subtask b” complete/.test(viewer), "viewers edit nothing");
  assert.match(viewer, /data-subtask-row="a"[\s\S]*?padding-left:2\.25rem/);
});

test("List: Show subtasks opens every row", () => {
  const html = render(
    <ListView
      {...viewProps}
      config={parseViewConfig({ show_subtasks: true })}
      tasks={[task({ id: "t1", subtaskCount: 1 })]}
      subtasks={[sub("a", "t1")]}
    />,
    "viewer",
  );
  assert.match(html, /aria-label="Hide subtasks of “Write the brief”"/);
  assert.match(html, /data-subtask-row="a"/);
});

test("List: a blocked task's completion control is a lock, never a checkbox", () => {
  const html = render(
    <ListView {...viewProps} tasks={[task({ blockedBy: 2 }), task({ id: "t2", title: "Logo", sortOrder: 2048 })]} />,
    "editor",
  );
  assert.match(html, /data-blocked-toggle=""[^>]*aria-label="“Write the brief” is blocked by 2 tasks/);
  assert.ok(!/aria-label="Mark “Write the brief” complete"/.test(html), "no checkbox to try");
  assert.match(html, /aria-label="Mark “Logo” complete"/, "unblocked rows keep theirs");
  const done = render(<ListView {...viewProps} tasks={[task({ blockedBy: 2, completedAt: "2026-10-20T00:00:00Z" })]} config={parseViewConfig({ filters: { completion: "all" } })} />, "editor");
  assert.ok(!done.includes("data-blocked-toggle"), "a completed task isn't locked");
});

test("List: Editors edit every visible cell in place; Viewers get the values only", () => {
  const config = parseViewConfig({ columns: ["assignee", "due", "start", "section", `field:${F1}`] });
  const tasks = [task({ assigneeId: "amy", dueOn: "2026-11-02", fieldValues: { [F1]: "o1" } })];
  const editor = render(<ListView {...viewProps} config={config} tasks={tasks} />, "editor");
  assert.match(editor, /aria-label="Assignee of “Write the brief”: Amy Pond\. Change"/);
  assert.match(editor, /aria-label="Due date of “Write the brief”: Nov 2\. Change"/);
  assert.match(editor, /aria-label="Start date of “Write the brief”: none\. Change"/);
  assert.match(editor, /aria-label="Section of “Write the brief”: To do\. Change"/);
  assert.match(editor, /aria-label="Priority of “Write the brief”: High\. Change"/);

  const viewer = render(<ListView {...viewProps} config={config} tasks={tasks} />, "viewer");
  assert.ok(!/ of “Write the brief”: [^"]*\. Change"/.test(viewer), "no inline editors below Editor");
  assert.match(viewer, /Amy Pond/, "the values still show");
  assert.match(viewer, /High/);
});

test("List: every custom field type gets its editor", () => {
  const field = (id: string, name: string, fieldType: FieldDef["fieldType"], extra: Partial<FieldDef> = {}): FieldDef => ({
    ...priority,
    id,
    name,
    fieldType,
    options: [],
    ...extra,
  });
  const uuid = (n: number) => `00000000-0000-4000-8000-00000000010${n}`;
  const fields = [
    field(uuid(1), "Notes", "text"),
    field(uuid(2), "Points", "number"),
    field(uuid(3), "Launch", "date"),
    field(uuid(4), "Approved", "boolean"),
    field(uuid(5), "Channels", "multi_select", { options: [{ id: "c1", name: "Email", color: "blue" }] }),
    field(uuid(6), "Reviewers", "people"),
    field(uuid(7), "Status", "single_select", { boundToSections: true }),
  ];
  const html = render(
    <ListView
      {...viewProps}
      fields={fields}
      config={parseViewConfig({ columns: fields.map((f) => `field:${f.id}`) })}
      tasks={[task({ fieldValues: { [uuid(1)]: "Draft", [uuid(2)]: 3, [uuid(4)]: true } })]}
    />,
    "editor",
  );
  assert.match(html, /aria-label="Notes of “Write the brief”: Draft\. Change"/);
  assert.match(html, /aria-label="Points of “Write the brief”: 3\. Change"/);
  assert.match(html, /aria-label="Launch of “Write the brief”: empty\. Change"/);
  assert.match(html, /<input type="checkbox" aria-label="Approved of “Write the brief”"[^>]*checked=""/);
  assert.match(html, /aria-label="Channels of “Write the brief”\. Change"/);
  assert.match(html, /aria-label="Reviewers of “Write the brief”\. Change"/);
  assert.match(html, /aria-label="Status of “Write the brief”: To do\. Change"/);
});

// ---------------------------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------------------------

test("Board: a blocked card's completion control is a lock", () => {
  const html = render(<BoardView {...viewProps} tasks={[task({ blockedBy: 1 })]} />, "editor");
  assert.match(html, /data-blocked-toggle=""[^>]*aria-label="“Write the brief” is blocked by 1 task/);
  assert.ok(!/aria-label="Mark “Write the brief” complete"/.test(html));
});

// ---------------------------------------------------------------------------------------------
// My tasks
// ---------------------------------------------------------------------------------------------

const myTask = (over: Partial<MyTask> = {}): MyTask => ({
  id: "m1",
  title: "Plan the launch",
  completedAt: null,
  dueOn: null,
  projectId: "p1",
  projectName: "Launch",
  kind: "task",
  parentTitle: null,
  canEdit: true,
  ...over,
});
const myProps = {
  completed: [],
  bulk: { viewerId: "me", people: [], projects: [] },
  layout: "sections" as const,
  sections: [{ id: "ms1", kind: "recently_assigned" as const, name: "Recently assigned", sortOrder: 1024 }],
  placements: {},
};

test("My tasks: rows with subtasks open under them; nested rows edit in place", () => {
  assert.equal(myTaskRootId(myTask()), "m1");
  assert.equal(myTaskRootId({ ...myTask(), rootTaskId: "root" } as MyTask), "root");
  assert.deepEqual(expandableMyTasks([myTask({ subtaskCount: 2 }), myTask({ id: "m2" })]), [{ id: "m1", rootId: "m1" }]);

  const closed = render(<MyTasksView {...myProps} open={[myTask({ subtaskCount: 1 }), myTask({ id: "m2", title: "Other" })]} />);
  assert.match(closed, /aria-label="Show subtasks of “Plan the launch”"/);
  assert.ok(!/subtasks of “Other”/.test(closed));

  const open = render(
    <MyTasksView
      {...myProps}
      open={[myTask({ subtaskCount: 1 })]}
      expandedTaskIds={["m1"]}
      subtasks={[sub("s1", "m1", { title: "Book the venue", assigneeId: "amy" })]}
      profiles={[amy]}
    />,
  );
  assert.match(open, /aria-label="Hide subtasks of “Plan the launch”"/);
  assert.match(open, /data-subtask-row="s1"/);
  assert.match(open, /aria-label="Rename “Book the venue”"/);
  assert.match(open, /aria-label="Assignee of “Book the venue”: Amy Pond\. Change"/);
  assert.match(open, /aria-label="Due date of “Book the venue”: none\. Change"/);
});

test("My tasks: blocked rows are locked; editable rows rename and change the due date in place", () => {
  const html = render(
    <MyTasksView
      {...myProps}
      open={[
        myTask({ blockedBy: 3 }),
        myTask({ id: "m2", title: "Read only", canEdit: false, dueOn: "2026-11-04" }),
        myTask({ id: "m3", title: "Approve the copy", kind: "approval", approvalStatus: "pending" }),
      ]}
    />,
  );
  assert.match(html, /data-blocked-toggle=""[^>]*aria-label="“Plan the launch” is blocked by 3 tasks/);
  assert.ok(!/aria-label="Mark “Plan the launch” complete"/.test(html));
  assert.match(html, /aria-label="Rename “Plan the launch”"/);
  assert.match(html, /aria-label="Due date of “Plan the launch”: none\. Change"/);
  assert.ok(!/Rename “Read only”|Due date of “Read only”/.test(html), "read-only rows edit nothing");
  assert.match(html, /Pending approval|Pending/, "approval tasks show their status");
});

test("My tasks: Waiting on me to approve sits at the top with the project, due date, and round", () => {
  const awaiting: AwaitingApproval[] = [
    {
      requestId: "r1",
      taskId: "t9",
      title: "Spring flyer",
      requestLabel: { text: "Task #12", wrap: true },
      projectId: "p1",
      projectName: "Launch",
      dueOn: "2026-11-03",
      sentAt: "2026-10-25T10:00:00Z",
      roundNumber: 2,
      isApprovalTask: true,
    },
  ];
  const html = render(<MyTasksView {...myProps} open={[myTask()]} awaiting={awaiting} />);
  assert.match(html, /Waiting on me to approve/);
  assert.match(html, /data-awaiting-row="t9"/);
  assert.match(html, /\[Task #12\] Spring flyer/);
  assert.match(html, /Round 2/);
  assert.match(html, /Launch/);
  assert.ok(html.indexOf('id="group-awaiting"') < html.indexOf('id="group-ms1"'), "above the sections");
  assert.ok(!/aria-label="Select “Spring flyer”"/.test(html), "not selectable");

  const none = render(<MyTasksView {...myProps} open={[myTask()]} />);
  assert.ok(!none.includes("Waiting on me to approve"), "hidden while empty");
  const onlyApprovals = render(<MyTasksView {...myProps} layout="due" sections={[]} open={[]} awaiting={awaiting} />);
  assert.match(onlyApprovals, /Waiting on me to approve/, "shown even with nothing assigned");
});
