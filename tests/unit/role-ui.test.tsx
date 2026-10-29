// Oct 26 notes — hide what a role can't do: Viewers and Commenters get no row checkboxes (so no bulk
// bar), no drag handles, no "Add task" / "Add section", and a completion mark that isn't a button;
// Editors keep all of it. One helper (permissionsFor) decides, everywhere.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { CompleteToggle } from "@/components/complete-toggle";
import { MyTasksView } from "@/components/my-tasks/my-tasks-view";
import { BoardView } from "@/components/project/board-view";
import { ListView } from "@/components/project/list-view";
import { ProjectAccessProvider } from "@/components/project/project-access";
import { ShellProvider } from "@/components/shell/shell-context";
import { ToastProvider } from "@/components/toast";
import { RolesExplainer } from "@/components/workspace/roles-explainer";
import { TaskDetailPanel } from "@/components/task/task-detail-panel";
import type { MyTask, ProjectTask, Section, TaskDetail } from "@/lib/data";
import { bestRole, permissionsFor } from "@/lib/permissions";
import { DEFAULT_SIDEBAR_PREFS } from "@/lib/sidebar-prefs";
import { parseViewConfig } from "@/lib/views";
import type { ProjectRole } from "@/lib/roles";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const member = { id: "me", email: "me@example.com", name: "Me", avatarUrl: null };

function render(node: ReactNode, role: ProjectRole | null = null) {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value="/projects/p1/list">
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

// A clickable completion control is a <button role="checkbox">; a read-only one is a role="img" mark.
const clickableComplete = (html: string) => /<button[^>]*role="checkbox"/.test(html);
const rowCheckbox = (html: string) => /<input[^>]*type="checkbox"[^>]*aria-label="Select/.test(html);

test("permissionsFor: one place turns a role into what the UI may offer", () => {
  assert.deepEqual(
    (["viewer", "commenter", "editor", "admin", "owner"] as const).map((role) => {
      const p = permissionsFor(role);
      return [role, p.canView, p.canComment, p.canEdit, p.canManage, p.isOwner];
    }),
    [
      ["viewer", true, false, false, false, false],
      ["commenter", true, true, false, false, false],
      ["editor", true, true, true, false, false],
      ["admin", true, true, true, true, false],
      ["owner", true, true, true, true, true],
    ],
  );
  assert.equal(permissionsFor(null).canView, false);
  assert.equal(permissionsFor("viewer").readOnlyNote, "View only");
  assert.equal(permissionsFor("commenter").readOnlyNote, "You can comment on this task");
  assert.equal(permissionsFor("editor").readOnlyNote, null);
  assert.equal(bestRole(["viewer", undefined, "editor", "commenter"]), "editor");
  assert.equal(bestRole([null, undefined]), null);
});

test("a read-only completion mark is not a button and has nothing to click", () => {
  for (const kind of ["task", "milestone", "approval"] as const) {
    const html = renderToStaticMarkup(<CompleteToggle kind={kind} completed={false} readOnly label="Mark “A” complete" />);
    assert.ok(!html.includes("<button"), `${kind}: no button`);
    assert.ok(!html.includes('role="checkbox"'), `${kind}: not a checkbox`);
    assert.ok(!/hover:/.test(html), `${kind}: no hover state`);
    assert.match(html, /role="img"/);
  }
  const done = renderToStaticMarkup(<CompleteToggle completed readOnly label="x" />);
  assert.match(done, /aria-label="Task completed"/);
  const editable = renderToStaticMarkup(<CompleteToggle completed={false} onToggle={() => {}} label="Mark “A” complete" />);
  assert.ok(clickableComplete(editable), "editors keep the button");
});

const section: Section = { id: "s1", project_id: "p1", name: "To do", sort_order: 1024 };
const task: ProjectTask = {
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
};
const viewProps = {
  projectId: "p1",
  sections: [section],
  tasks: [task],
  profiles: [],
  fields: [],
  config: parseViewConfig({}),
  tags: [],
  sectionTaskCounts: { s1: 1 },
};

test("List: Viewers and Commenters get no checkbox, drag handle, add rows, or clickable completion", () => {
  for (const role of ["viewer", "commenter"] as const) {
    const html = render(<ListView {...viewProps} />, role);
    assert.ok(html.includes("Write the brief"), `${role}: the task is listed`);
    assert.ok(!rowCheckbox(html), `${role}: no row checkbox (so no selection and no bulk bar)`);
    assert.ok(!clickableComplete(html), `${role}: completion is read-only`);
    assert.ok(!html.includes("Drag to reorder"), `${role}: no drag handle`);
    assert.ok(!/Add task/.test(html), `${role}: no Add task`);
    assert.ok(!/Add section/.test(html), `${role}: no Add section`);
    assert.ok(!html.includes('id="section-s1"'), `${role}: the section name isn't an edit box`);
  }
  const editor = render(<ListView {...viewProps} />, "editor");
  assert.ok(rowCheckbox(editor), "editors select rows");
  assert.ok(clickableComplete(editor), "editors complete tasks");
  assert.match(editor, /Add task/);
});

test("Board: Viewers and Commenters get no draggable cards, add boxes, or clickable completion", () => {
  for (const role of ["viewer", "commenter"] as const) {
    const html = render(<BoardView {...viewProps} />, role);
    assert.ok(html.includes("Write the brief"));
    assert.ok(!clickableComplete(html), `${role}: completion is read-only`);
    assert.ok(!/draggable="true"/.test(html), `${role}: nothing to drag`);
    assert.ok(!/Add task|Add section/.test(html), `${role}: nothing to add`);
  }
  const editor = render(<BoardView {...viewProps} />, "editor");
  assert.ok(clickableComplete(editor));
  assert.match(editor, /Add task/);
});

const myTask = (id: string, title: string, canEdit: boolean): MyTask => ({
  id,
  title,
  completedAt: null,
  dueOn: null,
  projectId: "p1",
  projectName: "Launch",
  kind: "task",
  parentTitle: null,
  canEdit,
});

test("My tasks: a task the viewer can only read has no checkbox and no clickable completion", () => {
  const html = render(
    <MyTasksView
      open={[myTask("a", "Read-only task", false)]}
      completed={[]}
      bulk={{ viewerId: "me", people: [], projects: [] }}
      layout="due"
      sections={[]}
      placements={{}}
    />,
  );
  // The due-date layout waits for the browser's date; the sections layout renders rows on the server.
  const sections = render(
    <MyTasksView
      open={[myTask("a", "Read-only task", false), myTask("b", "My own task", true)]}
      completed={[]}
      bulk={{ viewerId: "me", people: [], projects: [] }}
      layout="sections"
      sections={[{ id: "ms1", kind: "recently_assigned", name: "Recently assigned", sortOrder: 1024 }]}
      placements={{ a: { sectionId: "ms1", sortOrder: 1 }, b: { sectionId: "ms1", sortOrder: 2 } }}
    />,
  );
  assert.ok(html.length > 0);
  assert.ok(sections.includes("Read-only task") && sections.includes("My own task"));
  assert.ok(!/aria-label="Select “Read-only task”"/.test(sections), "no checkbox on the read-only task");
  assert.ok(!/aria-label="Mark “Read-only task” complete"/.test(sections), "no complete button on the read-only task");
  assert.match(sections, /aria-label="Task not completed"/);
  assert.match(sections, /aria-label="Select “My own task”"/, "an editable task keeps its checkbox");
  assert.match(sections, /aria-label="Mark “My own task” complete"/, "and its complete button");
});

test("the roles box is three short lines", () => {
  const html = renderToStaticMarkup(<RolesExplainer isAdmin={false} allowCommenter={false} />);
  assert.match(html, /Workspace role<\/strong> = what you manage in the app\./);
  assert.match(html, /Project role<\/strong> = what you can do in one project\./);
  assert.match(html, /Owner<\/strong> = whoever runs that project\./);
  assert.equal((html.match(/<li>/g) ?? []).length, 3);
});

const paneTask = (viewerRole: ProjectRole): TaskDetail => ({
  id: "t1",
  title: "Write the brief",
  kind: "task",
  notes: "Some notes",
  completedAt: null,
  startOn: null,
  dueOn: "2026-11-02",
  startAt: null,
  dueAt: null,
  timeZone: null,
  recurrence: null,
  recurrenceSeq: 1,
  nextOccurrenceId: null,
  dependencies: [],
  hiddenBlockers: 0,
  editableProjectIds: [],
  assigneeId: null,
  homeProjectId: "p1",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  source: "manual",
  requestLabel: null,
  canAssignRequestNumber: false,
  submission: null,
  submitterResponses: false,
  replyThread: null,
  approvals: [],
  approval: null,
  projectNumbers: {},
  subtasks: [
    {
      id: "st1",
      title: "Draft outline",
      completedAt: null,
      assigneeId: null,
      dueOn: null,
      startOn: null,
      kind: "task",
      subtaskCount: 0,
      subtaskDoneCount: 0,
    } as unknown as TaskDetail["subtasks"][number],
  ],
  parentTaskId: null,
  ancestors: [],
  isSubtask: false,
  memberships: [{ projectId: "p1", projectName: "Launch", sectionId: "s1", sections: [{ id: "s1", name: "To do" }] }],
  fields: [],
  fieldValues: {},
  followerIds: [],
  attachments: [],
  attachmentLinks: [],
  comments: [],
  commentTotal: 0,
  olderComments: null,
  stories: [],
  mentionTeams: [],
  viewerRole,
  memberRoles: { me: viewerRole },
  tagIds: [],
  isPrivate: false,
  privateReaderIds: [],
});

test("task pane: Viewers and Commenters see the task read-only; Commenters keep the comment box", () => {
  const pane = (role: ProjectRole) =>
    render(<TaskDetailPanel task={paneTask(role)} projects={[]} profiles={[]} memberId="me" tags={[]} />);
  for (const role of ["viewer", "commenter"] as const) {
    const html = pane(role);
    assert.ok(!/Mark complete/.test(html), `${role}: no Mark complete button`);
    assert.ok(!clickableComplete(html), `${role}: subtasks' completion is read-only`);
    assert.ok(!html.includes('<textarea id="task-title"'), `${role}: the name isn't an edit box`);
    assert.match(html, /<h2 id="task-title"[^>]*>Write the brief<\/h2>/);
    assert.ok(!html.includes('id="task-notes"'), `${role}: the description isn't an edit box`);
    assert.ok(!html.includes('id="subtask-st1"'), `${role}: subtask names aren't edit boxes`);
    assert.ok(!/Add subtask|Attach files|Add to projects/.test(html), `${role}: nothing to add`);
  }
  assert.match(pane("viewer"), /View only/);
  assert.ok(!/Add a comment/.test(pane("viewer")), "Viewers can't comment");
  assert.match(pane("commenter"), /You can comment on this task/);
  assert.match(pane("commenter"), /Add a comment/, "Commenters keep the comment box");
  const editor = pane("editor");
  assert.match(editor, /Mark complete/);
  assert.ok(clickableComplete(editor), "editors tick subtasks");
  assert.ok(editor.includes('<textarea id="task-title"'));
});
