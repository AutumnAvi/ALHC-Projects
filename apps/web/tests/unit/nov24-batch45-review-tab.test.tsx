// Nov 24 batch 45: the task card's Review tab (task-review-tab.tsx), rendered on the server: the strip's
// per-reviewer chips, the viewer's card, the comments on the file, and the merged rounds.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { ToastProvider } from "@/components/toast";
import { TaskReviewTab } from "@/components/task/task-review-tab";
import type { Profile } from "@alhc/core/api/people/model";
import type { ApprovalRound, TaskApprovalInfo, TaskDetail } from "@alhc/core/api/task-pane/model";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };

function render(node: ReactNode) {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value="/projects/p1/list">
        <SearchParamsContext.Provider value={new URLSearchParams() as never}>
          <ToastProvider>{node}</ToastProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

const people: Profile[] = [
  { id: "avi", email: "avi@example.com", full_name: "Avi W.", avatar_url: null },
  { id: "cg", email: "cg@example.com", full_name: "CA Green", avatar_url: null },
];

const round = (over: Partial<ApprovalRound>): ApprovalRound => ({
  id: "r2",
  number: 2,
  status: "pending",
  mode: "any",
  finalText: null,
  attachmentIds: ["a1", "a2"],
  moreSteps: false,
  afterApproval: "complete",
  moveSectionId: null,
  moveSectionName: null,
  dueOn: "2026-12-11",
  sentBy: "cg",
  sentAt: "2026-12-09T10:14:00Z",
  decidedBy: null,
  decidedAt: null,
  acknowledgedAt: null,
  withdrawnAt: null,
  requests: [
    {
      id: "q2",
      subtaskId: null,
      approverId: "avi",
      requestedBy: "cg",
      ruleName: null,
      note: null,
      status: "pending",
      decidedAt: null,
      decisionNote: null,
      createdAt: "2026-12-09T10:14:00Z",
      roundId: "r2",
    },
  ],
  ...over,
});

const round1 = round({
  id: "r1",
  number: 1,
  status: "changes_requested",
  sentAt: "2026-12-05T10:00:00Z",
  decidedAt: "2026-12-08T10:00:00Z",
  requests: [
    {
      id: "q1",
      subtaskId: null,
      approverId: "avi",
      requestedBy: "cg",
      ruleName: null,
      note: null,
      status: "changes_requested",
      decidedAt: "2026-12-08T10:00:00Z",
      decisionNote: "✗ holiday-flyer-v2.png: Logo crowding the footer.\n✓ holiday-flyer-print.pdf: approved",
      createdAt: "2026-12-05T10:00:00Z",
      roundId: "r1",
    },
  ],
});

const approval = (rounds: ApprovalRound[]): TaskApprovalInfo => ({
  approverIds: ["avi"],
  mode: "any",
  dueOn: "2026-12-11",
  status: rounds[0]?.status === "pending" ? "pending" : "changes_requested",
  paused: false,
  waitingOnMe: true,
  rounds,
});

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "t1",
    title: "Holiday party flyer",
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
    assigneeId: "cg",
    homeProjectId: "p1",
    createdAt: "2026-11-18T00:00:00Z",
    updatedAt: "2026-11-18T00:00:00Z",
    source: "manual",
    requestLabel: null,
    canAssignRequestNumber: false,
    submission: null,
    submitterResponses: false,
    replyThread: null,
    approvals: [],
    approval: approval([round({}), round1]),
    projectNumbers: {},
    subtasks: [],
    parentTaskId: null,
    ancestors: [],
    isSubtask: false,
    memberships: [{ projectId: "p1", projectName: "Marketing Requests", sectionId: "s1", sections: [{ id: "s1", name: "Design" }] }],
    fields: [],
    fieldValues: {},
    followerIds: [],
    attachments: [
      { id: "a1", fileName: "holiday-flyer-v2.png", contentType: "image/png", sizeBytes: 2100000, uploadedBy: "cg", createdAt: "2026-12-09T00:00:00Z" },
      { id: "a2", fileName: "holiday-flyer-print.pdf", contentType: "application/pdf", sizeBytes: 4800000, uploadedBy: "cg", createdAt: "2026-12-09T00:00:00Z" },
    ],
    attachmentLinks: [],
    comments: [],
    commentTotal: 0,
    olderComments: null,
    stories: [],
    mentionTeams: [],
    viewerRole: "editor",
    memberRoles: { avi: "commenter", cg: "editor" },
    tagIds: [],
    isPrivate: false,
    privateReaderIds: [],
    externalReview: {
      reviewer: { email: "sarah.k@glenoaks-al.com", name: "Sarah K.", source: "task" },
      saved: { email: "sarah.k@glenoaks-al.com", name: "Sarah K." },
      plan: { order: "sequential", dueOn: "2026-12-15" },
      latest: null,
    },
    ...overrides,
  };
}

test("the approver sees the per-file review in the card, the outside reviewer waits for them", () => {
  const html = render(<TaskReviewTab task={task()} profiles={people} memberId="avi" />);
  assert.match(html, /data-review-tab=""/);
  // Strip: both files, each with the team chip (Avi, reviewing) — the outside chips wait for the loaded rounds.
  assert.match(html, /holiday-flyer-v2\.png/);
  assert.match(html, /data-file-chip="team:pending"/);
  // The card: Team approver · You with Approve file / Has feedback for the shown file.
  assert.match(html, /Team approver<span class="normal-case"> · You<\/span>/);
  assert.match(html, /data-approver-review="panel"/);
  assert.match(html, /Approve file/);
  assert.match(html, /Has feedback/);
  // The outside reviewer gets it after the approver (sequential order).
  assert.match(html, /gets it after you/);
  assert.match(html, /Sarah gets the email link once you approve both files\./);
  // Comments on the shown file: the round 1 note by the team approver, in blue.
  assert.match(html, /data-review-comment="team"/);
  assert.match(html, /Logo crowding the footer\./);
  assert.match(html, /Sarah’s pins will show here in yellow after the review\./);
  // Rounds, newest first: round 2 waiting on Avi (blue), round 1 changes requested by Avi.
  const r2 = html.indexOf("Waiting on Avi");
  const r1 = html.indexOf("Changes requested by Avi");
  assert.ok(r2 > 0 && r1 > r2, "round 2 above round 1");
  assert.match(html, /Comment on this file/);
});

test("someone else sees the team's state, not the decision controls", () => {
  const html = render(<TaskReviewTab task={task()} profiles={people} memberId="cg" />);
  assert.doesNotMatch(html, /data-approver-review="panel"/);
  assert.match(html, /Waiting on Avi/);
  assert.match(html, /gets it after the team/);
});

test("a plain task without any review says so", () => {
  const html = render(<TaskReviewTab task={task({ kind: "task", approval: null, externalReview: undefined })} profiles={people} memberId="cg" />);
  assert.match(html, /data-review-tab="empty"/);
  assert.match(html, /No review yet/);
});
