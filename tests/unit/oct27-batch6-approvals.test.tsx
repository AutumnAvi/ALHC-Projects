// Oct 27 notes, batch 6 (items 45 / 45b, the app's side; the database's is suite zz35): approval tasks
// with separate approvers, Ready for approval, Approve / Request changes / Reject with notes, paused
// rounds and "Feedback received", Withdraw, Hand off, the history, the Approval filter, Inbox reminders;
// plus the pane's locked Mark complete (item 43) and per-project numbers (item 39).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { InboxCard, approvalReminderOf, approvalReminderText } from "@/components/inbox/inbox-card";
import {
  APPROVAL_FILTER_ORDER,
  FilterEditor,
  approvalFilterLabel,
  filterChips,
  toggleApprovalFilter,
} from "@/components/project/filter-editor";
import { ProjectAccessProvider } from "@/components/project/project-access";
import { ShellProvider } from "@/components/shell/shell-context";
import { ToastProvider } from "@/components/toast";
import {
  ApprovalDecisionForm,
  ApprovalTaskBanner,
  approvedOutcome,
  canActOnApproval,
  canSubmitDecision,
  decisionNoteRule,
  decisionSubmitLabel,
  requestOutcome,
} from "@/components/task/task-approval-banner";
import { legacyApprovals } from "@/components/task/task-approvals";
import { TaskDetailPanel } from "@/components/task/task-detail-panel";
import {
  SendForApprovalDialog,
  afterApprovalOf,
  canSendForApproval,
  joinNames,
  sendForApprovalProblem,
} from "@/components/task/send-for-approval-dialog";
import type { ApprovalRound, InboxItem, Profile, TaskApproval, TaskApprovalInfo, TaskDetail } from "@/lib/data";
import { DEFAULT_SIDEBAR_PREFS } from "@/lib/sidebar-prefs";
import type { ProjectRole } from "@/lib/roles";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const member = { id: "me", email: "me@example.com", name: "Me", avatarUrl: null };

function render(node: ReactNode, pathname = "/projects/p1/list") {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value={pathname}>
        <SearchParamsContext.Provider value={new URLSearchParams() as never}>
          <ShellProvider member={member as never} isWorkspaceAdmin={false} workspace={{ name: "ALHC", logoUrl: null }} initialSidebar={DEFAULT_SIDEBAR_PREFS}>
            <ToastProvider>
              <ProjectAccessProvider role="editor">{node}</ProjectAccessProvider>
            </ToastProvider>
          </ShellProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

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
    note: "Final copy",
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
    finalText: "Final copy for the spring flyer",
    attachmentIds: ["f1"],
    moreSteps: false,
    afterApproval: "complete",
    moveSectionId: null,
    moveSectionName: null,
    dueOn: "2026-10-30",
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

function approvalTask(viewerRole: ProjectRole, approval: TaskApprovalInfo | null, overrides: Partial<TaskDetail> = {}): TaskDetail {
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
    memberships: [
      { projectId: "p1", projectName: "Launch", sectionId: "s1", sections: [{ id: "s1", name: "To do" }, { id: "s2", name: "Review" }] },
    ],
    fields: [],
    fieldValues: {},
    followerIds: [],
    attachments: [{ id: "f1", fileName: "flyer.pdf", contentType: "application/pdf", sizeBytes: 1000, uploadedBy: "ann", createdAt: "2026-10-19T00:00:00Z" }],
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

const banner = (task: TaskDetail) => render(<ApprovalTaskBanner task={task} profiles={people} memberId="me" />);
const button = (html: string, label: string) => new RegExp(`<button[^>]*>(?:<svg[^>]*>.*?</svg>)?${label}</button>`).test(html);

// ---------------------------------------------------------------------------------------------
// The approval panel, state by state
// ---------------------------------------------------------------------------------------------

test("not sent: the assignee (or an Editor) gets Ready for approval; Viewers only read", () => {
  const assignee = banner(approvalTask("commenter", info(), { assigneeId: "me" }));
  assert.match(assignee, /data-approval-status="not_sent"/);
  assert.match(assignee, /Not sent/);
  assert.ok(button(assignee, "Ready for approval"), "the assignee sends it");
  assert.match(assignee, /Not sent yet\. When it’s ready, Ready for approval sends it to Sam Approver\./);
  assert.ok(!button(assignee, "Approve"), "no decision before it's sent");

  const editor = banner(approvalTask("editor", info()));
  assert.ok(button(editor, "Ready for approval"), "any Editor can send it too");
  assert.match(editor, /Change/, "Editors choose the approvers");
  assert.match(editor, /Who decides/);
  assert.match(editor, /Any one can approve/);
  assert.match(editor, /Approval due/);

  const viewer = banner(approvalTask("viewer", info()));
  assert.ok(!/Ready for approval<\/button>/.test(viewer), "Viewers can't send");
  assert.ok(!/>Change</.test(viewer), "or change approvers");
  assert.match(viewer, /Sam Approver/, "but see who approves");

  const noApprover = banner(approvalTask("editor", info({ approverIds: [] })));
  assert.match(noApprover, /Choose who approves this, then send it with Ready for approval\./);
  assert.match(noApprover, /data-tooltip="Choose an approver first"/);
  assert.match(noApprover, /Add approver/);
});

test("pending: an approver sees Approve / Request changes / Reject and Hand off; the assignee sees Withdraw", () => {
  const pendingRound = round({ requests: [request({ id: "req-me", approverId: "me" })] });
  const approver = banner(
    approvalTask("commenter", info({ approverIds: ["me"], status: "pending", waitingOnMe: true, rounds: [pendingRound] })),
  );
  assert.match(approver, /data-approval-status="pending"/);
  assert.match(approver, /Waiting on you to approve\./);
  assert.match(approver, /Your decision/);
  assert.ok(button(approver, "Approve") && button(approver, "Request changes") && button(approver, "Reject"));
  assert.match(approver, /Hand off…/);
  assert.ok(!button(approver, "Withdraw"), "a Commenter approver who didn't send it can't withdraw it");
  assert.match(approver, /What’s being approved/);
  assert.match(approver, /Final copy for the spring flyer/);
  assert.match(approver, /flyer\.pdf/);
  assert.ok(!button(approver, "Ready for approval"), "it's already sent");

  const assignee = banner(approvalTask("commenter", info({ status: "pending", rounds: [round()] }), { assigneeId: "me" }));
  assert.match(assignee, /Waiting on Sam Approver to approve\./);
  assert.ok(button(assignee, "Withdraw"));
  assert.ok(!button(assignee, "Approve"), "the assignee doesn't decide");
  assert.ok(!/Hand off/.test(assignee));

  const twoAny = banner(
    approvalTask("editor", info({ approverIds: ["sam", "lee"], status: "pending", rounds: [round({ requests: [request(), request({ id: "req-lee", approverId: "lee" })] })] })),
  );
  assert.match(twoAny, /Waiting on Sam Approver or Lee Second to approve\./, "any one can approve");
  assert.ok(!/Reassign/.test(twoAny), "an Editor can't change approvers while it's pending");
  const admin = banner(approvalTask("admin", info({ status: "pending", rounds: [round()] })));
  assert.match(admin, /Reassign/, "project Owners / Admins reassign");
  const twoAll = banner(
    approvalTask("editor", info({ approverIds: ["sam", "lee"], mode: "all", status: "pending", rounds: [round({ mode: "all", requests: [request({ status: "approved", decidedAt: "2026-10-21T00:00:00Z" }), request({ id: "req-lee", approverId: "lee" })] })] })),
  );
  assert.match(twoAll, /Waiting on Lee Second to approve\./, "everyone must approve: only who's left");
  assert.match(twoAll, /Everyone must approve/);
});

test("changes requested / rejected: paused until the assignee marks it received, with the note up front", () => {
  const changes = round({
    status: "changes_requested",
    decidedBy: "sam",
    decidedAt: "2026-10-21T00:00:00Z",
    requests: [request({ status: "changes_requested", decisionNote: "Make the logo bigger", decidedAt: "2026-10-21T00:00:00Z" })],
  });
  const paused = banner(approvalTask("commenter", info({ status: "changes_requested", paused: true, rounds: [changes] }), { assigneeId: "me" }));
  assert.match(paused, /data-approval-paused="true"/);
  assert.match(paused, /Paused/);
  assert.match(paused, /Sam Approver requested changes\. Paused until you mark the feedback received\./);
  assert.match(paused, /data-approval-decision-note=""/);
  assert.match(paused, /Make the logo bigger/);
  assert.ok(button(paused, "Feedback received"));
  assert.ok(!button(paused, "Ready for approval"), "not until the feedback is marked received");

  const someoneElse = banner(approvalTask("commenter", info({ status: "changes_requested", paused: true, rounds: [changes] })));
  assert.ok(!button(someoneElse, "Feedback received"), "only the assignee or an Editor");
  assert.match(someoneElse, /Waiting on Ann Assignee to mark the feedback received\./);

  const rejected = banner(
    approvalTask(
      "editor",
      info({
        status: "rejected",
        paused: true,
        rounds: [round({ status: "rejected", decidedBy: "sam", requests: [request({ status: "rejected", decisionNote: "Off brand" })] })],
      }),
    ),
  );
  assert.ok(button(rejected, "Rejection received"));
  assert.match(rejected, /Sam Approver rejected this\./);
  assert.match(rejected, /Off brand/);

  const acknowledged = banner(
    approvalTask("commenter", info({ status: "changes_requested", paused: false, rounds: [{ ...changes, acknowledgedAt: "2026-10-22T00:00:00Z" }] }), {
      assigneeId: "me",
    }),
  );
  assert.ok(button(acknowledged, "Ready for approval"), "after Feedback received it can go again");
  assert.ok(!button(acknowledged, "Feedback received"));
  assert.match(acknowledged, /Back with you: send it again with Ready for approval\./);
  assert.match(acknowledged, /Feedback marked received/, "the history says so");
});

test("approved: the outcome (completed, moved to a section, or more steps) and the history", () => {
  const done = banner(
    approvalTask(
      "editor",
      info({
        status: "approved",
        rounds: [round({ status: "approved", decidedBy: "sam", requests: [request({ status: "approved", decisionNote: "Ship it" })] })],
      }),
      { completedAt: "2026-10-22T00:00:00Z" },
    ),
  );
  assert.match(done, /Approved by Sam Approver\. Approving it completed the task\./);
  assert.match(done, /Ship it/);
  assert.ok(!button(done, "Ready for approval") && !/Send for approval again/.test(done), "a completed task isn't sent again");

  const moved = banner(
    approvalTask(
      "editor",
      info({
        status: "approved",
        rounds: [
          round({
            status: "approved",
            moreSteps: true,
            afterApproval: "move_section",
            moveSectionId: "s2",
            moveSectionName: "Review",
            requests: [request({ status: "approved" })],
          }),
          round({
            id: "r0",
            number: 0,
            status: "withdrawn",
            withdrawnAt: "2026-10-19T00:00:00Z",
            requests: [request({ id: "old", status: "cancelled", cancelReason: "handed_off", handoffTo: "lee", handoffNote: "I’m away" })],
          }),
        ],
      }),
    ),
  );
  assert.match(moved, /Moved to Review\. More steps to go\./);
  assert.match(moved, /Send for approval again/, "more steps: it can go round again");
  assert.match(moved, /History · 2 rounds/);
  assert.match(moved, /Round 1 · Approved/);
  assert.match(moved, /Round 0 · Withdrawn/);
  assert.match(moved, /Handed off to Lee Second/);
  assert.match(moved, /I’m away/);
  assert.match(moved, /On approval: move it to Review, don’t complete/);
});

test("decision notes: required for Request changes, recommended (and prompted) for Approve and Reject", () => {
  assert.equal(decisionNoteRule("changes_requested"), "required");
  assert.equal(decisionNoteRule("approved"), "recommended");
  assert.equal(decisionNoteRule("rejected"), "recommended");
  assert.equal(canSubmitDecision("changes_requested", "  "), false);
  assert.equal(canSubmitDecision("changes_requested", "Bigger logo"), true);
  assert.equal(canSubmitDecision("approved", ""), true);
  assert.equal(decisionSubmitLabel("approved", ""), "Approve without a note");
  assert.equal(decisionSubmitLabel("approved", "Great"), "Approve");
  assert.equal(decisionSubmitLabel("rejected", ""), "Reject without a note");
  assert.equal(decisionSubmitLabel("changes_requested", ""), "Request changes");

  const changes = render(<ApprovalDecisionForm idPrefix="x" pending={false} recipientName="Ann" onDecide={() => {}} initialDecision="changes_requested" />);
  assert.match(changes, /What needs to change\?/);
  assert.match(changes, /\(required\)/);
  assert.match(changes, /aria-required="true"/);
  assert.match(changes, /<button type="submit" disabled=""[^>]*>Request changes<\/button>/, "can't send without a note");
  assert.match(changes, /Add a note saying what needs to change before you send it\./);

  const approve = render(<ApprovalDecisionForm idPrefix="x" pending={false} recipientName="Ann" onDecide={() => {}} initialDecision="approved" />);
  assert.match(approve, /Add a note/);
  assert.match(approve, /\(recommended\)/);
  assert.match(approve, /A short note helps Ann know what’s next\./);
  assert.match(approve, />Approve without a note</);
  assert.ok(!/type="submit" disabled/.test(approve), "Approve works without a note");
});

test("who acts, outcomes, and the legacy list leaving round requests to the panel", () => {
  assert.equal(canActOnApproval({ viewerRole: "commenter", assigneeId: "me" }, "me"), true, "the assignee");
  assert.equal(canActOnApproval({ viewerRole: "editor", assigneeId: "ann" }, "me"), true, "an Editor");
  assert.equal(canActOnApproval({ viewerRole: "commenter", assigneeId: "ann" }, "me"), false);
  assert.equal(canActOnApproval({ viewerRole: "viewer", assigneeId: "me" }, "me"), false, "a Viewer assignee can't");

  assert.equal(requestOutcome({ status: "cancelled", cancelReason: "handed_off" }, "Lee"), "Handed off to Lee");
  assert.equal(requestOutcome({ status: "cancelled", cancelReason: "round_closed" }), "No decision needed");
  assert.equal(requestOutcome({ status: "cancelled", cancelReason: "withdrawn" }), "Withdrawn");
  assert.equal(requestOutcome({ status: "changes_requested", cancelReason: null }), "Requested changes");
  assert.equal(approvedOutcome({ afterApproval: "notify", moveSectionName: null }), "More steps to go.");
  assert.equal(approvedOutcome({ afterApproval: "complete", moveSectionName: null }), "Approving it completed the task.");

  const legacy = request({ id: "legacy", roundId: null });
  assert.deepEqual(
    legacyApprovals([request(), legacy]).map((a) => a.id),
    ["legacy"],
  );
});

// ---------------------------------------------------------------------------------------------
// Ready for approval: the dialog's rules
// ---------------------------------------------------------------------------------------------

test("Ready for approval needs the final text or a file, and a section when moving it", () => {
  const base = { finalText: "", attachmentIds: [] as string[], moreSteps: false, choice: "notify" as const, moveSectionId: null };
  assert.equal(sendForApprovalProblem(base), "Add the final text or at least one file");
  assert.equal(canSendForApproval(base), false);
  assert.equal(canSendForApproval({ ...base, finalText: "Here it is" }), true);
  assert.equal(canSendForApproval({ ...base, attachmentIds: ["f1"] }), true);
  assert.equal(
    sendForApprovalProblem({ ...base, finalText: "x", moreSteps: true, choice: "move_section" }),
    "Choose the section to move it to",
  );
  assert.equal(canSendForApproval({ ...base, finalText: "x", moreSteps: true, choice: "move_section", moveSectionId: "s2" }), true);
  assert.equal(sendForApprovalProblem({ ...base, finalText: "x".repeat(10001) }), "The final text is limited to 10,000 characters");

  assert.equal(afterApprovalOf(false, "move_section"), "complete", "without More steps it completes");
  assert.equal(afterApprovalOf(true, "move_section"), "move_section");
  assert.equal(afterApprovalOf(true, "notify"), "notify");

  assert.equal(joinNames(["Sam"]), "Sam");
  assert.equal(joinNames(["Sam", "Lee"]), "Sam and Lee");
  assert.equal(joinNames(["Sam", "Lee", "Kim"]), "Sam, Lee, and Kim");
});

test("the Ready for approval dialog: final text, the task's files, review check, and More steps", () => {
  const first = render(<SendForApprovalDialog task={approvalTask("editor", info())} profiles={people} onClose={() => {}} />);
  assert.match(first, /Ready for approval/);
  assert.match(first, /Goes to Sam Approver\./);
  assert.match(first, /Final text/);
  assert.match(first, /flyer\.pdf/);
  assert.match(first, /More steps after approval — don’t complete/);
  assert.match(first, /Otherwise approving it completes the task\./);
  assert.ok(!/review check/.test(first), "the review check option needs ticked files");

  // A new round starts from the last one's text and files, so the review check option is there.
  const again = render(
    <SendForApprovalDialog
      task={approvalTask("editor", info({ status: "changes_requested", rounds: [round({ status: "changes_requested", acknowledgedAt: "2026-10-22T00:00:00Z" })] }))}
      profiles={people}
      onClose={() => {}}
    />,
  );
  assert.match(again, /Final copy for the spring flyer/);
  assert.match(again, /Also send a review check of these files to Sam Approver/);

  const commenter = render(
    <SendForApprovalDialog task={approvalTask("commenter", info({ rounds: [round({ status: "withdrawn" })] }), { assigneeId: "me" })} profiles={people} onClose={() => {}} />,
  );
  assert.ok(!/review check/.test(commenter), "review checks are made by Editors+");

  const noFiles = render(<SendForApprovalDialog task={approvalTask("editor", info(), { attachments: [] })} profiles={people} onClose={() => {}} />);
  assert.match(noFiles, /This task has no files yet\. Attach them with the paperclip/);
});

// ---------------------------------------------------------------------------------------------
// The Approval filter
// ---------------------------------------------------------------------------------------------

const context = { sections: [], profiles: people, fields: [] };

test("the Filter editor has an Approval section with Waiting on me first, and chips for it", () => {
  assert.equal(APPROVAL_FILTER_ORDER[0], "waiting_on_me");
  assert.equal(new Set(APPROVAL_FILTER_ORDER).size, 7);
  const chips = filterChips({ approval: ["pending", "waiting_on_me"] }, context);
  const chip = chips.find((c) => c.key === "approval");
  assert.ok(chip);
  assert.equal(chip.label, "Approval: Waiting on me to approve, Pending approval");
  assert.deepEqual(chip.remove(), {});
  assert.equal(approvalFilterLabel(["paused"]), "Approval: Paused (feedback not received yet)");

  const once = toggleApprovalFilter({}, "rejected");
  assert.deepEqual(once.approval, ["rejected"]);
  const twice = toggleApprovalFilter(once, "waiting_on_me");
  assert.deepEqual(twice.approval, ["waiting_on_me", "rejected"], "kept in the menu's order");
  assert.deepEqual(toggleApprovalFilter(toggleApprovalFilter({}, "approved"), "approved"), {}, "unticking the last one drops the key");

  const html = render(<FilterEditor filters={{ approval: ["waiting_on_me"] }} onChange={() => {}} context={context} idPrefix="f" />);
  assert.match(html, /<legend[^>]*>Approval<\/legend>/);
  const waiting = html.indexOf("Waiting on me to approve");
  const notSent = html.indexOf("Not sent");
  assert.ok(waiting > 0 && notSent > waiting, "Waiting on me to approve comes first");
  assert.match(html, /<input type="checkbox"[^>]*checked=""[^>]*\/><span class="truncate">Waiting on me to approve/);
});

// ---------------------------------------------------------------------------------------------
// The pane: Mark complete while pending or blocked, per-project numbers
// ---------------------------------------------------------------------------------------------

test("the pane: Mark complete waits for a pending approval; a blocked task's button is locked and lists the blockers", () => {
  const pending = render(
    <TaskDetailPanel task={approvalTask("editor", info({ status: "pending", rounds: [round()] }))} projects={[]} profiles={people} memberId="me" tags={[]} />,
  );
  assert.match(pending, /<button type="button" disabled=""[^>]*data-tooltip="Waiting for approval[^"]*"/);
  assert.match(pending, /aria-label="Approval"/, "the approval panel is at the top");
  assert.match(pending, />Assignee</, "the assignee is the assignee, not the approver");

  const blocked = render(
    <TaskDetailPanel
      task={approvalTask("editor", null, {
        kind: "task",
        approval: null,
        dependencies: [
          { id: "d1", relation: "blocked_by", kind: "finish_to_start", lagDays: 0, taskId: "t0", title: "Copy", completedAt: null, isSubtask: false },
        ],
        hiddenBlockers: 1,
      })}
      projects={[]}
      profiles={people}
      memberId="me"
      tags={[]}
    />,
  );
  assert.match(blocked, /data-blocked-complete=""/);
  assert.match(blocked, /aria-disabled="true"/);
  assert.match(blocked, /aria-label="Mark complete: blocked by 2 tasks\. Show them"/);
  assert.ok(!/data-blocked-complete=""[^>]*disabled=""/.test(blocked), "focusable, so hover / focus / tap show the blockers");
});

test("item 39: inside a project the pane shows that project's number", () => {
  const task = approvalTask("editor", info(), {
    requestLabel: { text: "Task #3", wrap: true },
    projectNumbers: { p1: { text: "Task #3", wrap: true }, p2: { text: "WEB-12", wrap: false } },
  });
  const inP2 = render(<TaskDetailPanel task={task} projects={[]} profiles={people} memberId="me" tags={[]} />, "/projects/p2/views/v1");
  assert.match(inP2, /data-task-number="">WEB-12</);
  const home = render(<TaskDetailPanel task={task} projects={[]} profiles={people} memberId="me" tags={[]} />, "/my-tasks");
  assert.match(home, /data-task-number="">\[Task #3\]</, "outside projects: the home project's number");
  const unknown = render(<TaskDetailPanel task={task} projects={[]} profiles={people} memberId="me" tags={[]} />, "/projects/p9/list");
  assert.match(unknown, /data-task-number="">\[Task #3\]</, "a project without its own number falls back");
});

// ---------------------------------------------------------------------------------------------
// The Inbox: reminders, and decisions with notes
// ---------------------------------------------------------------------------------------------

function inboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "i1",
    kind: "approval_requested",
    data: { approval_id: "req-me", reminder: "overdue", due_on: "2026-10-25" },
    actorId: null,
    readAt: null,
    archivedAt: null,
    bookmarkedAt: null,
    createdAt: "2026-10-26T00:00:00Z",
    taskId: "t1",
    taskTitle: "Spring flyer",
    parentTitle: null,
    commentBody: null,
    message: null,
    teamMessage: null,
    statusUpdate: null,
    project: null,
    approval: { id: "req-me", status: "pending", approverId: "me" },
    emailFrom: null,
    ...overrides,
  };
}

const card = (item: InboxItem) =>
  render(
    <ul>
      <InboxCard
        item={item}
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

test("Inbox reminders read 'Reminder: approval due tomorrow / overdue', and approvers decide from them", () => {
  assert.equal(approvalReminderOf(inboxItem()), "overdue");
  assert.equal(approvalReminderOf(inboxItem({ data: { approval_id: "x", reminder: "due_soon" } })), "due_soon");
  assert.equal(approvalReminderOf(inboxItem({ data: { approval_id: "x" } })), null);
  assert.equal(approvalReminderOf(inboxItem({ kind: "approval_decided" })), null);
  assert.equal(approvalReminderText("due_soon"), "Reminder: approval due tomorrow");
  assert.equal(approvalReminderText("overdue"), "Reminder: approval overdue");

  const overdue = card(inboxItem());
  assert.match(overdue, /Reminder: approval overdue/);
  assert.match(overdue, /Approval due Oct 25/);
  assert.ok(!/Someone/.test(overdue), "a reminder has no actor");
  assert.ok(button(overdue, "Approve") && button(overdue, "Request changes"), "the approver can decide right there");

  const soon = card(inboxItem({ data: { approval_id: "req-me", reminder: "due_soon", due_on: "2026-10-28" } }));
  assert.match(soon, /Reminder: approval due tomorrow/);

  const notMine = card(inboxItem({ approval: { id: "req-sam", status: "pending", approverId: "sam" } }));
  assert.ok(!button(notMine, "Approve"), "only the request's approver decides");
  const decided = card(inboxItem({ data: { approval_id: "req-me" }, approval: { id: "req-me", status: "approved", approverId: "me" } }));
  assert.ok(!button(decided, "Approve"), "only while it's pending");
  assert.match(decided, /You approved this/);
});
