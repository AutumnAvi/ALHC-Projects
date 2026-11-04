// Nov 2 security fix (note 119): "a project Viewer can delete tasks". The database refused it all along
// (RLS), but the app's delete actions didn't check that a row changed, so a Delete control on a page
// whose role had gone stale "worked" without changing anything. These pin the app side: deleting goes
// through trash_task (which says why it can't), soft deletes check a row changed, Viewers and Commenters
// get no Delete or edit controls, and a Commenter removes only themselves as a follower.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { ProjectAccessProvider } from "@/components/project/project-access";
import { ShellProvider } from "@/components/shell/shell-context";
import { ToastProvider } from "@/components/toast";
import { TaskDetailPanel } from "@/components/task/task-detail-panel";
import type { TaskDetail } from "@/lib/api/task-pane/model";
import { followerChange, permissionsFor } from "@/lib/permissions";
import { DEFAULT_SIDEBAR_PREFS } from "@/lib/sidebar-prefs";
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

const actions = readFileSync(new URL("../../src/lib/actions.ts", import.meta.url), "utf8");
const bodyOf = (name: string) => {
  const start = actions.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const next = actions.indexOf("\nexport ", start + 10);
  return actions.slice(start, next < 0 ? undefined : next);
};

test("deleting a task or subtask goes through trash_task and never trusts a silent zero-row update", () => {
  assert.match(bodyOf("deleteTask"), /trashTask\(/);
  assert.match(bodyOf("deleteSubtask"), /trashTask\(/);
  assert.match(actions, /rpc\("trash_task"/);
  for (const name of ["deleteField", "deleteAttachment", "deleteForm", "deleteRule", "deleteWidget", "deleteProject", "setRuleEnabled", "renameSection"]) {
    assert.match(bodyOf(name), /checkUpdated\(/, `${name} checks that a row changed`);
  }
});

test("Viewers and Commenters can't edit; only Editors and above can", () => {
  for (const role of ["viewer", "commenter"] as const) assert.equal(permissionsFor(role).canEdit, false, role);
  for (const role of ["editor", "admin", "owner"] as const) assert.equal(permissionsFor(role).canEdit, true, role);
});

test("followers: Commenters follow, unfollow themselves, and add people; only Editors remove others", () => {
  const viewer = permissionsFor("viewer");
  const commenter = permissionsFor("commenter");
  const editor = permissionsFor("editor");
  assert.equal(followerChange(viewer, "me", "me", false), null, "viewers don't follow from the pane");
  assert.equal(followerChange(commenter, "me", "me", false), "add");
  assert.equal(followerChange(commenter, "me", "me", true), "remove");
  assert.equal(followerChange(commenter, "me", "you", false), "add");
  assert.equal(followerChange(commenter, "me", "you", true), null, "a commenter can't remove someone else");
  assert.equal(followerChange(editor, "me", "you", true), "remove");
});

test("the pane: no remove-follower control on others below Editor, and no Delete or edit controls", () => {
  const profiles = [
    { id: "me", email: "me@example.com", full_name: "Me", avatar_url: null },
    { id: "you", email: "you@example.com", full_name: "Yan You", avatar_url: null },
  ];
  const pane = (role: ProjectRole) =>
    render(
      <TaskDetailPanel
        task={{ ...paneTask(role), followerIds: ["you"] }}
        projects={[]}
        profiles={profiles as never}
        memberId="me"
        tags={[]}
      />,
    );
  for (const role of ["viewer", "commenter"] as const) {
    const html = pane(role);
    assert.ok(!/Remove Yan You as a follower/.test(html), `${role}: can't remove another follower`);
    assert.ok(!/Delete task|Delete subtask/.test(html), `${role}: no Delete`);
    assert.ok(!/Add subtask|Attach files/.test(html), `${role}: nothing to add`);
  }
  assert.match(pane("editor"), /Remove Yan You as a follower/, "editors remove followers");
});
