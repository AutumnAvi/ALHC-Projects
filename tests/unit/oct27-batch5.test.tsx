// Oct 27 notes, batch 5 (the app's side; the database's is suite zz34): Lock section order (Owner
// settings), Show / Hide completed per person per project, the paperclip on List rows, the Subtasks
// organize menu, no likes, the bulk bar above the task pane, and "Followers" (not "Collaborators").
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { ListView } from "@/components/project/list-view";
import { ProjectAccessProvider } from "@/components/project/project-access";
import { AttachmentCount } from "@/components/project/task-meta";
import { ShellProvider } from "@/components/shell/shell-context";
import { ToastProvider } from "@/components/toast";
import { TaskDetailPanel } from "@/components/task/task-detail-panel";
import { SubtaskPrefsProvider } from "@/components/task/subtask-prefs";
import type { ProjectTask, Section, TaskDetail } from "@/lib/data";
import {
  DEFAULT_SUBTASK_PREFS,
  isOrganized,
  organizeSubtasks,
  organizeSummary,
  parseSubtaskPrefs,
  type SubtaskPrefs,
} from "@/lib/subtask-view";
import { DEFAULT_SIDEBAR_PREFS } from "@/lib/sidebar-prefs";
import { completionOf, completionStateLabel, parseViewConfig, withCompletionOf, withShowCompleted } from "@/lib/views";
import type { ProjectRole } from "@/lib/roles";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const member = { id: "me", email: "me@example.com", name: "Me", avatarUrl: null };

function render(node: ReactNode, role: ProjectRole | null = null, sectionsLocked = false) {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value="/projects/p1/list">
        <SearchParamsContext.Provider value={new URLSearchParams() as never}>
          <ShellProvider member={member as never} isWorkspaceAdmin={false} workspace={{ name: "ALHC", logoUrl: null }} initialSidebar={DEFAULT_SIDEBAR_PREFS}>
            <ToastProvider>
              <ProjectAccessProvider role={role} sectionsLocked={sectionsLocked}>
                {node}
              </ProjectAccessProvider>
            </ToastProvider>
          </ShellProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

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
  commentCount: 2,
  attachmentCount: 3,
};
const viewProps = {
  projectId: "p1",
  sections: [section, { ...section, id: "s2", name: "Doing", sort_order: 2048 }],
  tasks: [task],
  profiles: [],
  fields: [],
  config: parseViewConfig({}),
  tags: [],
  sectionTaskCounts: { s1: 1 },
};

// ---------------------------------------------------------------------------------------------
// 1. Lock section order
// ---------------------------------------------------------------------------------------------

test("locked sections: Editors can't rename, add, or reorder them; Owners still can", () => {
  const editorLocked = render(<ListView {...viewProps} />, "editor", true);
  assert.ok(!editorLocked.includes('id="section-s1"'), "the section name isn't an edit box");
  assert.ok(!/Add section/.test(editorLocked), "no Add section");
  const handles = (html: string) => (html.match(/title="Drag to reorder"/g) ?? []).length;
  assert.match(editorLocked, /aria-label="Sections are locked"/, "a lock says why");
  assert.match(editorLocked, /Add task/, "tasks are still added");

  const editorOpen = render(<ListView {...viewProps} />, "editor", false);
  assert.ok(editorOpen.includes('id="section-s1"'), "unlocked: Editors rename");
  assert.equal(handles(editorOpen) - handles(editorLocked), 2, "locked: no section drag handles (task rows keep theirs)");
  assert.match(editorOpen, /Add section/);

  const ownerLocked = render(<ListView {...viewProps} />, "owner", true);
  assert.ok(ownerLocked.includes('id="section-s1"'), "Owners rename while locked");
  assert.match(ownerLocked, /Add section/, "and add");
});

// ---------------------------------------------------------------------------------------------
// 2. Show / Hide completed
// ---------------------------------------------------------------------------------------------

test("Show / Hide completed sets the completion filter, and Save view keeps the view's own", () => {
  const view = parseViewConfig({ filters: { completion: "completed", completed_within_days: 7, text: "brief" } });
  const shown = withShowCompleted(view, true);
  assert.equal(completionOf(shown.filters), "all");
  assert.equal(shown.filters?.completed_within_days, undefined, "no 'in the last N days' left behind");
  assert.equal(shown.filters?.text, "brief", "other filters stay");
  const hidden = withShowCompleted(view, false);
  assert.equal(completionOf(hidden.filters), "incomplete");
  assert.equal(hidden.filters?.completion, undefined, "incomplete is the default (no key)");
  assert.equal(completionOf(withShowCompleted(parseViewConfig({}), false).filters), "incomplete");
  assert.equal(parseViewConfig({}).filters, undefined);
  assert.deepEqual(withShowCompleted(parseViewConfig({}), false), parseViewConfig({}), "hiding on a plain view changes nothing");

  const restored = withCompletionOf(shown, view);
  assert.equal(restored.filters?.completion, "completed");
  assert.equal(restored.filters?.completed_within_days, 7);
  assert.equal(restored.filters?.text, "brief");

  assert.equal(completionStateLabel("incomplete"), "Incomplete tasks");
  assert.equal(completionStateLabel("all"), "All tasks");
  assert.equal(completionStateLabel("completed"), "Completed tasks");
});

// ---------------------------------------------------------------------------------------------
// 3. Paperclip on List rows
// ---------------------------------------------------------------------------------------------

test("List rows show a paperclip with the attachment count (and nothing without files)", () => {
  const html = render(<ListView {...viewProps} />, "viewer");
  assert.match(html, /title="3 attachments"/);
  assert.match(html, /<span class="sr-only"> attachments<\/span>/, "screen readers hear it");
  assert.equal(renderToStaticMarkup(<AttachmentCount count={0} />), "");
  assert.equal(renderToStaticMarkup(<AttachmentCount count={undefined} />), "");
  assert.match(renderToStaticMarkup(<AttachmentCount count={1} />), /title="1 attachment"/);
});

// ---------------------------------------------------------------------------------------------
// 4. Subtasks organize menu
// ---------------------------------------------------------------------------------------------

const subs = [
  { id: "a", completedAt: null, assigneeId: "zed", dueOn: "2026-11-05", sortOrder: 1 },
  { id: "b", completedAt: "2026-10-20T00:00:00Z", assigneeId: "me", dueOn: null, sortOrder: 2 },
  { id: "c", completedAt: null, assigneeId: null, dueOn: "2026-11-01", sortOrder: 3 },
  { id: "d", completedAt: null, assigneeId: "me", dueOn: "2026-11-09", sortOrder: 4 },
];
const names: Record<string, string> = { zed: "Zed", me: "Amy" };
const organize = (prefs: Partial<SubtaskPrefs>) =>
  organizeSubtasks(subs, { ...DEFAULT_SUBTASK_PREFS, ...prefs }, "me", (id) => names[id] ?? "").map((s) => s.id);

test("Subtasks: filter and sort, remembered per person", () => {
  assert.deepEqual(organize({}), ["a", "b", "c", "d"], "manual order");
  assert.deepEqual(organize({ hideCompleted: true }), ["a", "c", "d"]);
  assert.deepEqual(organize({ assignedToMe: true }), ["b", "d"]);
  assert.deepEqual(organize({ assignedToMe: true, hideCompleted: true }), ["d"]);
  assert.deepEqual(organize({ sort: "assignee" }), ["b", "d", "a", "c"], "by name, unassigned last");
  assert.deepEqual(organize({ sort: "due_asc" }), ["c", "a", "d", "b"], "earliest first, undated last");
  assert.deepEqual(organize({ sort: "due_desc" }), ["d", "a", "c", "b"], "latest first, undated still last");
  assert.equal(isOrganized(DEFAULT_SUBTASK_PREFS), false);
  assert.equal(organizeSummary(4, 4, DEFAULT_SUBTASK_PREFS), null);
  assert.equal(
    organizeSummary(1, 4, { hideCompleted: true, assignedToMe: true, sort: "due_asc" }),
    "Showing 1 of 4 · completed hidden, assigned to me, sorted by due date (earliest first)",
  );
  assert.deepEqual(parseSubtaskPrefs({ subtask_hide_completed: true, subtask_assigned_to_me: false, subtask_sort: "assignee" }), {
    hideCompleted: true,
    assignedToMe: false,
    sort: "assignee",
  });
  assert.deepEqual(parseSubtaskPrefs({ sort: "nonsense" }), DEFAULT_SUBTASK_PREFS, "unknown values fall back");
});

const paneTask = (viewerRole: ProjectRole, followerIds: string[] = []): TaskDetail =>
  ({
    id: "t1",
    title: "Write the brief",
    kind: "task",
    notes: null,
    completedAt: null,
    startOn: null,
    dueOn: null,
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
    subtasks: [
      { id: "st1", parentId: "t1", title: "Done one", completedAt: "2026-10-02T00:00:00Z", assigneeId: null, dueOn: null, startOn: null, kind: "task", sortOrder: 1, subtaskCount: 0, subtaskDoneCount: 0 },
      { id: "st2", parentId: "t1", title: "Open one", completedAt: null, assigneeId: "me", dueOn: null, startOn: null, kind: "task", sortOrder: 2, subtaskCount: 0, subtaskDoneCount: 0 },
    ],
    parentTaskId: null,
    ancestors: [],
    isSubtask: false,
    memberships: [{ projectId: "p1", projectName: "Launch", sectionId: "s1", isHome: true, sections: [{ id: "s1", name: "To do" }] }],
    fields: [],
    fieldValues: {},
    followerIds,
    attachments: [],
    attachmentLinks: [],
    comments: [],
    commentTotal: 0,
    olderComments: null,
    stories: [],
    mentionTeams: [],
    viewerRole,
    memberRoles: { me: viewerRole, you: "editor" },
    tagIds: [],
    isPrivate: false,
    privateReaderIds: [],
  }) as unknown as TaskDetail;

const people = [
  { id: "me", email: "me@example.com", full_name: "Me Myself", avatar_url: null },
  { id: "you", email: "you@example.com", full_name: "Yuri You", avatar_url: null },
];

test("the pane's Subtasks: an Organize menu, and a hidden completed subtask stays out of the list", () => {
  const plain = render(<TaskDetailPanel task={paneTask("editor")} projects={[]} profiles={people} memberId="me" tags={[]} />);
  assert.match(plain, /Organize/);
  assert.match(plain, /Done one/);
  assert.match(plain, /1 of 2 done/);
  const filtered = render(
    <SubtaskPrefsProvider initial={{ hideCompleted: true, assignedToMe: false, sort: "manual" }}>
      <TaskDetailPanel task={paneTask("editor")} projects={[]} profiles={people} memberId="me" tags={[]} />
    </SubtaskPrefsProvider>,
  );
  assert.ok(!/Done one/.test(filtered), "completed hidden");
  assert.match(filtered, /Open one/);
  assert.match(filtered, /Showing 1 of 2 · completed hidden/);
  assert.match(filtered, /Show all in manual order/);
});

// ---------------------------------------------------------------------------------------------
// 10. No likes · 12. Followers
// ---------------------------------------------------------------------------------------------

test("the pane has no like button; its footer says Followers with an obvious Add / remove / Follow", () => {
  const html = render(<TaskDetailPanel task={paneTask("editor", ["you"])} projects={[]} profiles={people} memberId="me" tags={[]} />);
  assert.ok(!/\blike\b|Like this task|Unlike/i.test(html.replace(/likely/gi, "")), "no likes");
  assert.ok(!/Collaborator/i.test(html), "never 'Collaborators'");
  assert.match(html, />Followers</);
  assert.match(html, /Add follower/);
  assert.match(html, /aria-label="Remove Yuri You as a follower"/);
  assert.match(html, /Follow task/, "the viewer isn't following yet");
  const following = render(<TaskDetailPanel task={paneTask("editor", ["me"])} projects={[]} profiles={people} memberId="me" tags={[]} />);
  assert.match(following, /Unfollow/);
  assert.match(following, /aria-label="Stop following this task"/);
  const viewer = render(<TaskDetailPanel task={paneTask("viewer", ["you"])} projects={[]} profiles={people} memberId="me" tags={[]} />);
  assert.ok(!/Add follower|Remove Yuri You/.test(viewer), "Viewers can't change followers");
  assert.match(viewer, />Followers</, "but see who follows");
});

// ---------------------------------------------------------------------------------------------
// 11. The bulk bar stays above / beside the task pane
// ---------------------------------------------------------------------------------------------

test("the bulk bar sits above the pane and, with the side pane open, next to it", () => {
  const bar = readFileSync("src/components/bulk/bulk-bar.tsx", "utf8");
  assert.match(bar, /data-bulk-bar=""\s+className="fixed bottom-4 left-1\/2 z-40/, "above the pane (z-30)");
  const css = readFileSync("src/app/globals.css", "utf8");
  assert.match(css, /\.app-shell:has\(\[data-task-pane="side"\]\) \[data-bulk-bar\] \{[^}]*left: calc\(var\(--sidebar-w/);
  const pane = readFileSync("src/components/task/task-pane-frame.tsx", "utf8");
  assert.match(pane, /absolute inset-y-0 right-0 z-30/, "the pane stays below it");
});
