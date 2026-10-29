// Oct 29 notes, batch 7 — item 52 (the app's side; the database's is suite zz36's T1 part): only an
// approval task's approvers complete it. Everyone else's complete control is "Ready for approval" (the
// pane's send flow), "Waiting for approval" while a round is pending, or "Approve" for an approver whose
// decision is open — in the pane, List, Board, My tasks, Home, and subtask rows — plus the compact
// approval banner.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { ApprovalToggle } from "@/components/complete-toggle";
import { MyTasksWidget } from "@/components/home/my-tasks-widget";
import { MyTasksView } from "@/components/my-tasks/my-tasks-view";
import { BoardView } from "@/components/project/board-view";
import { ListView } from "@/components/project/list-view";
import { ProjectAccessProvider } from "@/components/project/project-access";
import { ShellProvider } from "@/components/shell/shell-context";
import { RowCompleteControl } from "@/components/task/row-complete-control";
import { ApprovalTaskBanner } from "@/components/task/task-approval-banner";
import { TaskDetailPanel } from "@/components/task/task-detail-panel";
import { TaskPanePreview } from "@/components/task/task-pane-preview";
import { ToastProvider } from "@/components/toast";
import {
  APPROVAL_ROLE_CANT_DECIDE,
  APPROVAL_ROLE_CANT_SEND,
  READY_FOR_APPROVAL_REASON,
  cantDecideMessage,
  cantSendMessage,
  completeModeLabel,
  completeModeOf,
  completeModeRowLabel,
  completeModeTooltip,
  rowCompleteMode,
  shortcutApprovalAction,
} from "@/lib/approval-complete";
import type { ApprovalRound, MyTask, Profile, ProjectTask, Section, SubtaskItem, TaskApproval, TaskApprovalInfo, TaskDetail } from "@/lib/data";
import { MY_TASK_ACTIONS } from "@/lib/my-task-rules";
import type { ProjectRole } from "@/lib/roles";
import { stepOutcomeLabel, stepTone, testHeadline, type RuleTestResult } from "@/lib/rule-steps";
import { ACTIONS } from "@/lib/rules";
import { DEFAULT_SIDEBAR_PREFS } from "@/lib/sidebar-prefs";
import { seedFromMyTask, seedFromProjectTask, seedFromSubtask } from "@/lib/task-seed";
import { parseViewConfig } from "@/lib/views";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const member = { id: "me", email: "me@example.com", name: "Me", avatarUrl: null };

function render(node: ReactNode, role: ProjectRole | null = "editor", pathname = "/projects/p1/list") {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value={pathname}>
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

// ---------------------------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------------------------

test("completeModeOf: only approvers tick an approval task; everyone else sends it, waits, or approves", () => {
  // Other kinds, and completed tasks (reopening), are unchanged.
  assert.equal(completeModeOf({ kind: "task", completed: false }), "complete");
  assert.equal(completeModeOf({ kind: "milestone", completed: false }), "complete");
  assert.equal(completeModeOf({ kind: "approval", completed: true, status: "approved" }), "complete");

  // THE BUG: before Ready for approval a non-approver (an Editor) could tick it complete.
  assert.equal(completeModeOf({ kind: "approval", completed: false, status: "not_sent" }), "ready");
  assert.equal(completeModeOf({ kind: "approval", completed: false, status: "not_sent", isApprover: false }), "ready");
  assert.equal(completeModeOf({ kind: "approval", completed: false, status: "changes_requested" }), "ready", "nor after changes requested");
  assert.equal(completeModeOf({ kind: "approval", completed: false, status: "rejected" }), "ready");
  assert.equal(completeModeOf({ kind: "approval", completed: false }), "ready", "status not known: not an approver");

  // Approvers complete it (no round pending).
  assert.equal(completeModeOf({ kind: "approval", completed: false, status: "not_sent", isApprover: true }), "complete");
  assert.equal(completeModeOf({ kind: "approval", completed: false, status: "changes_requested", isApprover: true }), "complete");

  // Pending: the approver whose decision is open approves; everyone else waits (approvers who decided too).
  assert.equal(completeModeOf({ kind: "approval", completed: false, status: "pending", isApprover: true, waitingOnMe: true }), "approve");
  assert.equal(completeModeOf({ kind: "approval", completed: false, status: "pending", isApprover: true }), "waiting");
  assert.equal(completeModeOf({ kind: "approval", completed: false, status: "pending" }), "waiting");

  assert.equal(
    rowCompleteMode({ kind: "approval", completedAt: null, approvalStatus: "not_sent", approvalIsApprover: true }),
    "complete",
  );
  assert.equal(rowCompleteMode({ kind: "approval", completedAt: null, approvalStatus: "not_sent" }), "ready");
  assert.equal(rowCompleteMode({ kind: "approval", completedAt: null, approvalStatus: "not_sent" }, true), "complete", "optimistic done");
});

test("labels, tooltips, and the shortcut's choice", () => {
  assert.equal(completeModeLabel("complete"), "Mark complete");
  assert.equal(completeModeLabel("complete", "milestone"), "Mark milestone complete");
  assert.equal(completeModeLabel("ready"), "Ready for approval");
  assert.equal(completeModeLabel("waiting"), "Waiting for approval");
  assert.equal(completeModeLabel("approve"), "Approve");
  assert.equal(completeModeRowLabel("ready", "Flyer"), "Ready for approval: “Flyer”");
  assert.equal(completeModeRowLabel("waiting", "Flyer"), "“Flyer” is waiting for approval");
  assert.equal(completeModeRowLabel("approve", "Flyer"), "Approve “Flyer”");
  assert.match(completeModeTooltip("ready"), /only its approvers can complete it/);
  assert.equal(shortcutApprovalAction("complete"), null);
  assert.equal(shortcutApprovalAction("ready"), "send");
  assert.equal(shortcutApprovalAction("approve"), "decide");
  assert.equal(shortcutApprovalAction("waiting"), "waiting");
  assert.equal(READY_FOR_APPROVAL_REASON, "Only its approvers can complete an approval task. Send it with Ready for approval.");
});

// ---------------------------------------------------------------------------------------------
// Row controls
// ---------------------------------------------------------------------------------------------

test("ApprovalToggle: Ready for approval, Waiting (focusable, does nothing), Approve", () => {
  const ready = render(<ApprovalToggle mode="ready" title="Flyer" />);
  assert.match(ready, /data-approval-toggle="ready"/);
  assert.match(ready, /aria-label="Ready for approval: “Flyer”"/);
  assert.match(ready, /data-tooltip="Ready for approval: only its approvers can complete it"/);
  assert.ok(!/role="checkbox"/.test(ready), "not a checkbox");

  const waiting = render(<ApprovalToggle mode="waiting" title="Flyer" />);
  assert.match(waiting, /aria-disabled="true"/);
  assert.match(waiting, /aria-label="“Flyer” is waiting for approval"/);
  assert.ok(!/ disabled=""/.test(waiting), "still focusable, so the tooltip reads");

  const approve = render(<ApprovalToggle mode="approve" title="Flyer" size="sm" />);
  assert.match(approve, /data-approval-toggle="approve"/);
  assert.match(approve, /aria-label="Approve “Flyer”"/);
});

const approvalRow = { id: "t9", title: "Approve the copy", kind: "approval" as const, completedAt: null };

test("RowCompleteControl: approvers get the checkbox; read-only rows a mark, except Approve and the assignee's send", () => {
  const ready = render(<RowCompleteControl task={{ ...approvalRow, approvalStatus: "not_sent" }} completed={false} onToggle={() => {}} />);
  assert.match(ready, /data-approval-toggle="ready"/);
  assert.ok(!/aria-label="Mark approval “Approve the copy” complete"/.test(ready));

  const approver = render(
    <RowCompleteControl task={{ ...approvalRow, approvalStatus: "not_sent", approvalIsApprover: true }} completed={false} onToggle={() => {}} />,
  );
  assert.match(approver, /role="checkbox"[^>]*aria-label="Mark approval “Approve the copy” complete"/);

  const waiting = render(<RowCompleteControl task={{ ...approvalRow, approvalStatus: "pending" }} completed={false} onToggle={() => {}} />);
  assert.match(waiting, /data-approval-toggle="waiting"/);

  const approve = render(
    <RowCompleteControl
      task={{ ...approvalRow, approvalStatus: "pending", approvalIsApprover: true, approvalWaitingOnMe: true }}
      completed={false}
      readOnly
      onToggle={() => {}}
    />,
  );
  assert.match(approve, /data-approval-toggle="approve"/, "a Commenter approver approves from the row");

  const viewer = render(<RowCompleteControl task={{ ...approvalRow, approvalStatus: "not_sent" }} completed={false} readOnly onToggle={() => {}} />);
  assert.match(viewer, /data-complete-readonly=""/, "a Viewer sees a mark");
  // assignedToMe = assigned to the viewer AND they can comment (approval_can_act: the assignee sends it
  // with Commenter+). A Viewer assignee's rows pass false and get the mark.
  const assignee = render(
    <RowCompleteControl task={{ ...approvalRow, approvalStatus: "not_sent" }} completed={false} readOnly assignedToMe onToggle={() => {}} />,
  );
  assert.match(assignee, /data-approval-toggle="ready"/, "a Commenter assignee sends it");
  const viewerAssignee = render(
    <RowCompleteControl task={{ ...approvalRow, approvalStatus: "not_sent" }} completed={false} readOnly assignedToMe={false} onToggle={() => {}} />,
  );
  assert.match(viewerAssignee, /data-complete-readonly=""/, "a Viewer assignee sees the mark");
  assert.ok(!/data-approval-toggle=/.test(viewerAssignee), "no Ready for approval they can't use");
  const readOnlyWaiting = render(<RowCompleteControl task={{ ...approvalRow, approvalStatus: "pending" }} completed={false} readOnly onToggle={() => {}} />);
  assert.match(readOnlyWaiting, /data-complete-readonly=""/);

  const done = render(<RowCompleteControl task={{ ...approvalRow, approvalStatus: "approved" }} completed onToggle={() => {}} />);
  assert.match(done, /role="checkbox" aria-checked="true"/, "reopening is unchanged");

  const blockedPlain = render(<RowCompleteControl task={{ ...approvalRow, kind: "task" }} completed={false} blocked={2} onToggle={() => {}} />);
  assert.match(blockedPlain, /data-blocked-toggle=""/);
});

test("completeModeOf: once the latest round is approved, the task completes normally (anyone who edits it)", () => {
  // Approved with More steps (the round didn't complete the task): the approval has been given.
  assert.equal(completeModeOf({ kind: "approval", completed: false, status: "approved" }), "complete", "a non-approver");
  assert.equal(completeModeOf({ kind: "approval", completed: false, status: "approved", isApprover: false }), "complete");
  assert.equal(completeModeOf({ kind: "approval", completed: false, status: "approved", isApprover: true }), "complete", "an approver");
  assert.equal(shortcutApprovalAction(completeModeOf({ kind: "approval", completed: false, status: "approved" })), null, "⌘/Ctrl+Enter completes");
  assert.equal(rowCompleteMode({ kind: "approval", completedAt: null, approvalStatus: "approved" }), "complete");
  assert.equal(completeModeLabel(completeModeOf({ kind: "approval", completed: false, status: "approved" }), "approval"), "Mark complete");

  // Until then the approver-only rule holds: no round, pending, changes requested, rejected, withdrawn
  // (reads as not sent), and paused (changes requested / rejected not yet acknowledged).
  for (const status of ["not_sent", "changes_requested", "rejected"] as const) {
    assert.equal(completeModeOf({ kind: "approval", completed: false, status }), "ready", status);
  }
  assert.equal(completeModeOf({ kind: "approval", completed: false, status: "pending" }), "waiting");

  const row = render(<RowCompleteControl task={{ ...approvalRow, approvalStatus: "approved" }} completed={false} onToggle={() => {}} />);
  assert.match(row, /role="checkbox" aria-checked="false"[^>]*aria-label="Mark approval “Approve the copy” complete"/, "a plain checkbox");
  assert.ok(!/data-approval-toggle=/.test(row), "no Ready for approval");
});

const section: Section = { id: "s1", project_id: "p1", name: "To do", sort_order: 1024 };

function task(over: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: "t1",
    title: "Approve the copy",
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
    kind: "approval",
    approvalStatus: "not_sent",
    tagIds: [],
    commentCount: 0,
    ...over,
  };
}

const viewProps = {
  projectId: "p1",
  sections: [section],
  profiles: [],
  fields: [],
  config: parseViewConfig({}),
  tags: [],
  sectionTaskCounts: { s1: 1 },
};

test("List and Board: a non-approver's control is Ready for approval; an approver's the checkbox", () => {
  const list = render(<ListView {...viewProps} tasks={[task()]} />);
  assert.match(list, /data-approval-toggle="ready"[^>]*>|aria-label="Ready for approval: “Approve the copy”"/);
  assert.ok(!/aria-label="Mark approval “Approve the copy” complete"/.test(list), "the bug: no checkbox for a non-approver");

  const mine = render(<ListView {...viewProps} tasks={[task({ approvalIsApprover: true })]} />);
  assert.match(mine, /aria-label="Mark approval “Approve the copy” complete"/);

  const pending = render(<ListView {...viewProps} tasks={[task({ approvalStatus: "pending" })]} />);
  assert.match(pending, /data-approval-toggle="waiting"/);
  const decide = render(<ListView {...viewProps} tasks={[task({ approvalStatus: "pending", approvalIsApprover: true, approvalWaitingOnMe: true })]} />);
  assert.match(decide, /data-approval-toggle="approve"/);

  const board = render(<BoardView {...viewProps} tasks={[task()]} />);
  assert.match(board, /data-approval-toggle="ready"/);
  assert.ok(!/aria-label="Mark approval “Approve the copy” complete"/.test(board));
});

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

test("subtask rows under a List row follow the same rule", () => {
  const html = render(
    <ListView
      {...viewProps}
      tasks={[task({ kind: "task", approvalStatus: null, subtaskCount: 2 })]}
      subtasks={[
        sub("a", "t1", { title: "Legal sign-off", kind: "approval", approvalStatus: "not_sent" }),
        sub("b", "t1", { title: "Brand sign-off", kind: "approval", approvalStatus: "not_sent", approvalIsApprover: true, sortOrder: 2048 }),
      ]}
      expandedTaskIds={["t1"]}
    />,
  );
  assert.match(html, /aria-label="Ready for approval: “Legal sign-off”"/);
  assert.match(html, /aria-label="Mark approval “Brand sign-off” complete"/);
});

const myTask = (over: Partial<MyTask> = {}): MyTask => ({
  id: "m1",
  title: "Approve the copy",
  completedAt: null,
  dueOn: null,
  projectId: "p1",
  projectName: "Launch",
  kind: "approval",
  parentTitle: null,
  canEdit: true,
  approvalStatus: "not_sent",
  ...over,
});

test("My tasks and Home: the assignee's approval task is theirs to send, even without edit rights", () => {
  const myProps = {
    completed: [],
    bulk: { viewerId: "me", people: [], projects: [] },
    layout: "sections" as const,
    sections: [{ id: "ms1", kind: "recently_assigned" as const, name: "Recently assigned", sortOrder: 1024 }],
    placements: {},
  };
  const html = render(
    <MyTasksView
      {...myProps}
      open={[
        myTask(),
        myTask({ id: "m2", title: "Read-only approval", canEdit: false, canComment: true }),
        myTask({ id: "m3", title: "Mine to approve", approvalIsApprover: true }),
        myTask({ id: "m4", title: "Viewer approval", canEdit: false, canComment: false }),
        // Older data without canComment: the same as canEdit (a read-only row gets the mark).
        myTask({ id: "m5", title: "Unknown role approval", canEdit: false }),
      ]}
    />,
    null,
    "/my-tasks",
  );
  assert.match(html, /aria-label="Ready for approval: “Approve the copy”"/);
  assert.match(html, /aria-label="Ready for approval: “Read-only approval”"/, "a Commenter assignee sends it");
  assert.match(html, /aria-label="Mark approval “Mine to approve” complete"/);
  // THE REVIEW BUG: a Viewer assignee got Ready for approval, then "Only you or an Editor can send it".
  assert.ok(!/aria-label="Ready for approval: “Viewer approval”"/.test(html), "a Viewer assignee can't send it");
  assert.ok(!/aria-label="Ready for approval: “Unknown role approval”"/.test(html));
  const rowOf = (markup: string, id: string) => {
    const start = markup.indexOf(`data-task-row="${id}"`);
    return markup.slice(start, markup.indexOf("</li>", start));
  };
  assert.match(rowOf(html, "m4"), /data-complete-readonly=""/, "the Viewer assignee's row has the read-only mark");

  const home = render(
    <MyTasksWidget
      tasks={{ upcoming: [myTask(), myTask({ id: "h2", title: "Viewer home approval", canEdit: false, canComment: false })], overdue: [], completed: [] }}
    />,
    null,
    "/",
  );
  assert.match(home, /aria-label="Ready for approval: “Approve the copy”"/);
  assert.ok(!/aria-label="Ready for approval: “Viewer home approval”"/.test(home), "Home: a Viewer assignee gets the mark too");

  // "Waiting on me to approve": an approval task's round is decided from its row (Approve opens the
  // decision in the pane); an older request (an approval subtask) keeps the plain mark.
  const awaiting = render(
    <MyTasksView
      {...myProps}
      open={[]}
      awaiting={[
        { requestId: "q1", taskId: "w1", title: "Spring flyer", requestLabel: null, projectId: "p1", projectName: "Launch", dueOn: null, sentAt: "2026-10-20T10:00:00Z", roundNumber: 2, isApprovalTask: true },
        { requestId: "q2", taskId: "w2", title: "Legal check", requestLabel: null, projectId: "p1", projectName: "Launch", dueOn: null, sentAt: "2026-10-20T10:00:00Z", roundNumber: null, isApprovalTask: false },
      ]}
    />,
    null,
    "/my-tasks",
  );
  assert.match(awaiting, /aria-label="Approve “Spring flyer”"[^>]*data-approval-toggle="approve"/, "Approve on the round's row");
  assert.ok(!/aria-label="Approve “Legal check”"/.test(awaiting), "an older request keeps the plain mark");
});

// ---------------------------------------------------------------------------------------------
// The pane
// ---------------------------------------------------------------------------------------------

const people: Profile[] = [
  { id: "me", email: "me@example.com", full_name: "Me Myself", avatar_url: null },
  { id: "sam", email: "sam@example.com", full_name: "Sam Approver", avatar_url: null },
  { id: "lee", email: "lee@example.com", full_name: "Lee Second", avatar_url: null },
  { id: "ann", email: "ann@example.com", full_name: "Ann Assignee", avatar_url: null },
];

function request(overrides: Partial<TaskApproval> = {}): TaskApproval {
  return {
    id: "req-sam",
    subtaskId: null,
    approverId: "sam",
    requestedBy: "ann",
    ruleName: null,
    note: null,
    status: "pending",
    decidedAt: null,
    decisionNote: null,
    createdAt: "2026-10-20T10:00:00Z",
    roundId: "r1",
    cancelReason: null,
    handoffTo: null,
    handoffNote: null,
    ...overrides,
  };
}

function round(overrides: Partial<ApprovalRound> = {}): ApprovalRound {
  return {
    id: "r1",
    number: 1,
    status: "pending",
    mode: "any",
    finalText: "Final copy",
    attachmentIds: [],
    moreSteps: false,
    afterApproval: "complete",
    moveSectionId: null,
    moveSectionName: null,
    dueOn: null,
    sentBy: "ann",
    sentAt: "2026-10-20T10:00:00Z",
    decidedBy: null,
    decidedAt: null,
    acknowledgedAt: null,
    withdrawnAt: null,
    requests: [request()],
    ...overrides,
  };
}

function info(overrides: Partial<TaskApprovalInfo> = {}): TaskApprovalInfo {
  return { approverIds: ["sam"], mode: "any", dueOn: null, status: "not_sent", paused: false, waitingOnMe: false, rounds: [], ...overrides };
}

function approvalTask(viewerRole: ProjectRole, approval: TaskApprovalInfo, overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "t1",
    title: "Spring flyer",
    kind: "approval",
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
    editableProjectIds: ["p1"],
    assigneeId: "ann",
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
    approval,
    projectNumbers: {},
    subtasks: [],
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
    memberRoles: { me: viewerRole, sam: "commenter", lee: "editor", ann: "editor" },
    tagIds: [],
    isPrivate: false,
    privateReaderIds: [],
    ...overrides,
  };
}

const pane = (task: TaskDetail) => render(<TaskDetailPanel task={task} projects={[]} profiles={people} memberId="me" tags={[]} />);

test("the pane's Mark complete: Ready for approval for non-approvers, Mark complete for approvers, Approve, Waiting", () => {
  const editor = pane(approvalTask("editor", info()));
  assert.match(editor, /data-complete-mode="ready"/, "the bug: an Editor who isn't an approver gets Ready for approval");
  assert.match(editor, />Ready for approval<\/button>/);
  assert.ok(!/aria-pressed="false"[^>]*>(?:<svg[^>]*>.*?<\/svg>)?Mark complete</.test(editor), "no Mark complete for them");

  const approver = pane(approvalTask("editor", info({ approverIds: ["me"] })));
  assert.match(approver, /aria-pressed="false"/, "an approver who edits it completes it");
  assert.match(approver, />Mark complete<\/button>/);

  const deciding = pane(
    approvalTask("commenter", info({ approverIds: ["me"], status: "pending", waitingOnMe: true, rounds: [round({ requests: [request({ id: "req-me", approverId: "me" })] })] })),
  );
  assert.match(deciding, /data-complete-mode="approve"/, "an approver whose decision is open gets Approve, Commenters too");

  const waiting = pane(approvalTask("editor", info({ status: "pending", rounds: [round()] })));
  assert.match(waiting, /data-complete-mode="waiting"/);
  assert.match(waiting, /<button type="button" disabled=""[^>]*>(?:<svg[^>]*>.*?<\/svg>)?Waiting for approval<\/button>/);

  const viewer = pane(approvalTask("viewer", info()));
  assert.ok(!/data-complete-mode=/.test(viewer), "a Viewer gets the read-only note");

  // An approver later lowered to Viewer can't decide anymore (decide_approval needs Commenter+).
  const demoted = pane(
    approvalTask("viewer", info({ approverIds: ["me"], status: "pending", waitingOnMe: true, rounds: [round({ requests: [request({ id: "req-me", approverId: "me" })] })] })),
  );
  assert.ok(!/data-complete-mode="approve"/.test(demoted), "no Approve for a Viewer");

  const plain = pane(approvalTask("editor", info(), { kind: "task", approval: null }));
  assert.match(plain, />Mark complete<\/button>/, "other kinds are unchanged");
});

test("the pane: after an approval with More steps, anyone who edits the task gets plain Mark complete", () => {
  const approved = round({
    status: "approved",
    moreSteps: true,
    afterApproval: "notify",
    decidedBy: "sam",
    decidedAt: "2026-10-21T10:00:00Z",
    requests: [request({ status: "approved" })],
  });
  const editor = pane(approvalTask("editor", info({ status: "approved", rounds: [approved] })));
  assert.match(editor, /aria-pressed="false"/, "the approval has been given: the ordinary toggle");
  assert.match(editor, />Mark complete<\/button>/);
  assert.ok(!/data-complete-mode=/.test(editor), "not Ready for approval, not Waiting");
  const viewer = pane(approvalTask("viewer", info({ status: "approved", rounds: [approved] })));
  assert.ok(!/>Mark complete<\/button>/.test(viewer), "a Viewer still can't");
});

test("the compact approval banner: one row of approvers (locked in), status, and actions; the rest behind Details", () => {
  const html = render(<ApprovalTaskBanner task={approvalTask("editor", info({ approverIds: ["sam", "lee"] }))} profiles={people} memberId="me" />);
  const row = html.slice(html.indexOf('data-approval-row=""'), html.indexOf('data-approval-details=""'));
  assert.match(row, />Approvers</, "the label");
  assert.match(row, /Sam Approver/);
  assert.match(row, /Lee Second/);
  assert.equal(row.match(/data-approver-lock=""/g)?.length, 2, "each approver locked in");
  assert.match(row, /Not sent/, "the status pill");
  assert.match(row, /data-approval-headline-sr="">Not sent yet\./, "screen readers get the pill's tooltip while Details is closed");
  assert.match(row, />Ready for approval<\/button>/, "the viewer's primary action");
  assert.match(row, /aria-expanded="false"[^>]*>Details/, "Details is closed by default");
  assert.ok(!/Who decides/.test(row), "how they decide is in Details");
  assert.match(html, /data-approval-details="" hidden=""|hidden=""[^>]*data-approval-details=""/, "Details starts hidden");
  assert.match(html, /Who decides/);
  assert.match(html, /Approval due/);

  const one = render(<ApprovalTaskBanner task={approvalTask("editor", info())} profiles={people} memberId="me" />);
  assert.match(one, />Approver</, "one approver: singular");

  const none = render(<ApprovalTaskBanner task={approvalTask("editor", info({ approverIds: [] }))} profiles={people} memberId="me" />);
  const noneRow = none.slice(none.indexOf('data-approval-row=""'), none.indexOf('data-approval-details=""'));
  assert.match(noneRow, /No approver yet/);
  assert.match(noneRow, /Add approver/, "with nobody approving yet, Add approver is right in the row");

  const deciding = render(
    <ApprovalTaskBanner
      task={approvalTask("commenter", info({ approverIds: ["me"], status: "pending", waitingOnMe: true, rounds: [round({ requests: [request({ id: "req-me", approverId: "me" })] })] }))}
      profiles={people}
      memberId="me"
    />,
  );
  const decidingRow = deciding.slice(deciding.indexOf('data-approval-row=""'), deciding.indexOf('data-approval-details=""'));
  assert.match(decidingRow, /role="group" aria-label="Your decision"/);
  assert.match(decidingRow, />Approve<\/button>/);
  assert.match(decidingRow, />Request changes<\/button>/);
  assert.match(decidingRow, />Reject<\/button>/);
  assert.match(decidingRow, /aria-label="Waiting"/, "their own request shows as waiting");
});

test("seeds and the instant preview know the button too", () => {
  const seed = seedFromProjectTask(task());
  assert.equal(seed.completeMode, "ready");
  assert.equal(seedFromProjectTask(task({ approvalIsApprover: true })).completeMode, "complete");
  assert.equal(seedFromMyTask(myTask({ approvalStatus: "pending", approvalWaitingOnMe: true, approvalIsApprover: true })).completeMode, "approve");
  assert.equal(seedFromSubtask(sub("x", "t1", { kind: "approval", approvalStatus: "pending" }), { title: "Parent" }).completeMode, "waiting");

  const preview = render(<TaskPanePreview seed={seed} />);
  assert.match(preview, /Ready for approval/);
  assert.match(preview, />Assignee</, "an approval task's assignee is the assignee");
});

test("toasts for a stale row control: the assignee is told it's their role, never “Only you or an Editor…”", () => {
  // A Viewer assignee (approval_can_act needs Commenter+ for the assignee).
  assert.equal(cantSendMessage(true, "you"), APPROVAL_ROLE_CANT_SEND);
  assert.ok(!/Only you/.test(cantSendMessage(true, "you")));
  assert.equal(cantSendMessage(false, "Dana"), "Only Dana or an Editor can send it for approval");
  // An approver lowered to Viewer while still asked (decide_approval needs Commenter+), or no longer asked.
  assert.equal(cantDecideMessage(true), APPROVAL_ROLE_CANT_DECIDE);
  assert.equal(cantDecideMessage(false), "Your decision on this approval isn’t open anymore");
});

test("rules: Mark complete waits for the approval, and the run log says Skipped", () => {
  const complete = ACTIONS.find((a) => a.value === "complete_task");
  assert.ok(complete && /Approval tasks are skipped until they’re approved/.test(complete.description ?? ""), complete?.description);
  const mine = MY_TASK_ACTIONS.find((a) => a.value === "complete_task");
  assert.ok(mine && /Approval tasks are skipped until they’re approved/.test(mine.description ?? ""), mine?.description);

  // The engine logs outcome "skipped" ("Approval tasks are completed by their approvers") until approved.
  assert.equal(stepOutcomeLabel("skipped"), "Skipped", "a label, not the raw key");
  assert.equal(stepTone("skipped"), "unchanged");
  const result: RuleTestResult = {
    taskId: "t1",
    taskTitle: "Logo",
    triggerType: "manual",
    branches: [],
    chosenBranch: 0,
    steps: [
      { step: 1, type: "complete_task", input: null, outcome: "skipped", result: "Approval tasks are completed by their approvers", error: null, afterWait: false },
      { step: 2, type: "add_comment", input: null, outcome: "done", result: "Commented", error: null, afterWait: false },
    ],
    error: null,
    invalid: false,
  };
  assert.equal(testHeadline(result), "1 step would run", "a skipped step isn't a step that would run");
});
