// Nov 10 notes 184–187: the external reviewer starts collapsed, "When it's approved" is on the setup
// screen, an unfinished approval is flagged, and the add-task kind control sits to the left of the name.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { ProjectAccessProvider } from "@/components/project/project-access";
import { AddTaskInput } from "@/components/project/shared";
import { ToastProvider } from "@/components/toast";
import { ApprovalSetupDialog } from "@/components/task/approval-setup-dialog";
import { SendForApprovalDialog } from "@/components/task/send-for-approval-dialog";
import { TWO_STAGE_FOLLOW_UP_NOTE, TWO_STEP_NOTE } from "@alhc/core/external-review";
import type { Profile } from "@alhc/core/api/people/model";
import type { TaskApprovalInfo, TaskDetail } from "@alhc/core/api/task-pane/model";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };

function render(node: ReactNode) {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value="/projects/p1/list">
        <SearchParamsContext.Provider value={new URLSearchParams() as never}>
          <ToastProvider>
            <ProjectAccessProvider role="editor">{node}</ProjectAccessProvider>
          </ToastProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

const people: Profile[] = [
  { id: "sam", email: "sam@example.com", full_name: "Sam Approver", avatar_url: null },
];

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
  const approval: TaskApprovalInfo = {
    approverIds: [],
    mode: "any",
    dueOn: null,
    status: "not_sent",
    paused: false,
    waitingOnMe: false,
    rounds: [],
  };
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
    assigneeId: null,
    homeProjectId: "p1",
    createdAt: "2026-11-10T00:00:00Z",
    updatedAt: "2026-11-10T00:00:00Z",
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
    viewerRole: "editor",
    memberRoles: { sam: "commenter" },
    tagIds: [],
    isPrivate: false,
    privateReaderIds: [],
    ...overrides,
  };
}

function setup(overrides: Partial<TaskDetail> = {}) {
  return render(<ApprovalSetupDialog task={task(overrides)} profiles={people} onClose={() => {}} />);
}

test("184: the outside reviewer starts collapsed, and When it’s approved is on the setup screen", () => {
  const html = setup();
  assert.match(html, /aria-expanded="false"/);
  // Batch 45: "Outside reviewer" everywhere (the role's name in the task card).
  assert.match(html, /Outside reviewer/);
  assert.match(html, /\(optional\)/);
  assert.doesNotMatch(html, /Outside reviewer’s email/, "the fields stay inside the closed section");
  assert.doesNotMatch(html, /data-two-step-note=""/);
  assert.match(html, /data-when-approved=""/);
  assert.match(html, /When it’s approved/);
  assert.match(html, /Complete the task/);
  assert.match(html, /Done/);
  assert.doesNotMatch(html, />Next</, "the follow-up is not behind a second step");
  // Batch 45: no Order or outside due date without an outside reviewer.
  assert.doesNotMatch(html, /data-review-order=""/);
  assert.match(html, /data-approval-preview=""/, "the live preview is at the top");
});

test("184 / batch 45: a saved reviewer or a form requester opens the section; a two-stage setup keeps the follow-up choice", () => {
  const saved = setup({
    approval: {
      approverIds: ["sam"],
      mode: "any",
      dueOn: null,
      status: "not_sent",
      paused: false,
      waitingOnMe: false,
      rounds: [],
    },
    externalReview: {
      reviewer: { email: "jordan@client.com", name: "Jordan Lee", source: "task" },
      saved: { email: "jordan@client.com", name: "Jordan Lee" },
      latest: null,
    },
  });
  assert.match(saved, /aria-expanded="true"/);
  assert.match(saved, /value="jordan@client.com"/);
  assert.match(saved, /data-two-step-note=""/);
  assert.match(saved, new RegExp(TWO_STEP_NOTE.slice(0, 24).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(saved, /data-two-stage-note=""/);
  // Batch 45: the step runs by itself once the last stage approves, so the choice is offered here too.
  assert.match(saved, /runs by itself once the outside reviewer has approved too/);
  assert.match(saved, /data-when-approved=""/);
  assert.match(saved, /When everyone has approved/);
  assert.match(saved, /data-review-order=""/, "the Order shows once someone reviews from outside");
  assert.match(saved, /Team first, then outside/);
  assert.match(saved, /At the same time/);
  assert.match(saved, /Outside reviewer due/);
  assert.match(saved, /data-plan-pill="outside"/, "the preview draws the outside reviewer");

  const form = setup({
    submission: { email: "requester@client.com", name: "Riley", formId: "f", formTitle: "Request", createdAt: "2026-11-10T00:00:00Z" },
  });
  assert.match(form, /aria-expanded="true"/, "a form request shows the reviewer");
  assert.match(form, /value="requester@client.com"/);
  // Two-stage (and its note) needs a team approver too.
  assert.doesNotMatch(form, /data-two-stage-note=""/);
  const formWithApprover = setup({
    submission: { email: "requester@client.com", name: "Riley", formId: "f", formTitle: "Request", createdAt: "2026-11-10T00:00:00Z" },
    approval: { approverIds: ["sam"], mode: "any", dueOn: null, status: "not_sent", paused: false, waitingOnMe: false, rounds: [] },
  });
  assert.match(formWithApprover, new RegExp(TWO_STAGE_FOLLOW_UP_NOTE.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

// Nov 24 batch 45: the setup's live preview follows the plan, the parallel order is offered with an outside
// reviewer (locked while a round is open), and the send dialog says the outside reviewer is emailed too.
const approvalInfo = (over: Partial<TaskApprovalInfo> = {}): TaskApprovalInfo => ({
  approverIds: ["sam"],
  mode: "any",
  dueOn: null,
  status: "not_sent",
  paused: false,
  waitingOnMe: false,
  rounds: [],
  ...over,
});
const sarah = { email: "sarah.k@glenoaks-al.com", name: "Sarah K." };

test("batch 45: a parallel plan draws Team above Outside and says what happens in plain words", () => {
  const html = setup({
    approval: approvalInfo(),
    externalReview: { reviewer: { ...sarah, source: "task" }, saved: sarah, plan: { order: "parallel", dueOn: "2026-12-15" }, latest: null },
  });
  assert.match(html, /data-track-row="parallel"/);
  assert.match(html, /data-plan-pill="outside"[^>]*><span>Outside: Sarah · due Dec 15</);
  assert.match(html, /data-review-order-option="parallel"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-review-order-option="parallel"/);
  assert.match(html, /while Sarah reviews by email/);
  assert.doesNotMatch(html, /data-review-order-locked=""/);
  assert.match(html, /data-approval-setup-cancel=""/, "Skip for now, Cancel, and Done");
});

test("batch 45: the order can't change while a round is open", () => {
  const pendingRound = {
    id: "r1", number: 1, status: "pending" as const, mode: "any" as const, finalText: "x", attachmentIds: [], moreSteps: false,
    afterApproval: "complete" as const, moveSectionId: null, moveSectionName: null, dueOn: null, sentBy: null, sentAt: "2026-12-09T10:00:00Z",
    decidedBy: null, decidedAt: null, acknowledgedAt: null, withdrawnAt: null, requests: [],
  };
  const html = setup({
    approval: approvalInfo({ status: "pending", rounds: [pendingRound] }),
    externalReview: { reviewer: { ...sarah, source: "task" }, saved: sarah, plan: { order: "sequential", dueOn: null }, latest: null },
  });
  assert.match(html, /data-review-order-locked=""/);
  assert.match(html, /<button[^>]*disabled=""[^>]*data-review-order-option="parallel"|data-review-order-option="parallel"[^>]*disabled=""/);
});

test("batch 45: sending in the parallel order says the outside reviewer gets the link at the same time", () => {
  const two = {
    approval: approvalInfo(),
    externalReview: { reviewer: { ...sarah, source: "task" as const }, saved: sarah, plan: { order: "parallel" as const, dueOn: null }, latest: null },
  };
  const html = render(<SendForApprovalDialog task={task({ ...two, kind: "approval" })} profiles={people} onClose={() => {}} />);
  assert.match(html, /data-review-order="parallel"/);
  assert.match(html, /also emails Sarah K\. at sarah\.k@glenoaks-al\.com the review link at the same time/);
  assert.match(html, /data-when-approved=""/, "the follow-up choice shows for two-stage tasks too");
  assert.match(html, /When everyone has approved/);
  const sequential = render(
    <SendForApprovalDialog
      task={task({ ...two, kind: "approval", externalReview: { ...two.externalReview, plan: { order: "sequential", dueOn: null } } })}
      profiles={people}
      onClose={() => {}}
    />,
  );
  assert.match(sequential, /After the team approves/);
});

test("187: the add-task kind control is a segmented group to the left of the name, Task selected", () => {
  const html = render(<AddTaskInput projectId="p1" sectionId="s1" variant="row" defaultOpen />);
  const kind = html.indexOf('data-add-task-kind="segmented"');
  const name = html.indexOf("Task name, then Enter");
  assert.ok(kind >= 0 && name > kind, "the kind control comes before the name");
  assert.match(html, /role="radiogroup" aria-label="Type of the new task"/);
  assert.match(html, /role="radio"[^>]*aria-checked="true"[^>]*>[\s\S]*?Task/);
  assert.match(html, />Milestone</);
  assert.match(html, />Approval</);
  assert.match(html, /@lg\/add:inline-flex/, "wide rows show the buttons");
  assert.match(html, /@lg\/add:hidden/, "narrow rows fall back to a menu on the left");
  assert.ok(html.indexOf("add-task-kind") < name, "the narrow menu is also on the left");
});
