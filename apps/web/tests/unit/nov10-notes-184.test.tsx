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

test("184: external reviewer starts collapsed, and When it’s approved is on the setup screen", () => {
  const html = setup();
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /External reviewer/);
  assert.match(html, /\(optional\)/);
  assert.doesNotMatch(html, /External reviewer’s email/, "the fields stay inside the closed section");
  assert.doesNotMatch(html, /data-two-step-note=""/);
  assert.match(html, /data-when-approved=""/);
  assert.match(html, /When it’s approved/);
  assert.match(html, /Complete the task/);
  assert.match(html, /Done/);
  assert.doesNotMatch(html, />Next</, "the follow-up is not behind a second step");
});

test("184: a saved reviewer or a form requester opens the section, and a two-stage setup says the task stays open", () => {
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
  assert.match(saved, /it stays open/);
  assert.doesNotMatch(saved, /data-when-approved=""/, "the single-stage choice is not offered");

  const form = setup({
    submission: { email: "requester@client.com", name: "Riley", formId: "f", formTitle: "Request", createdAt: "2026-11-10T00:00:00Z" },
  });
  assert.match(form, /aria-expanded="true"/, "a form request shows the reviewer");
  assert.match(form, /value="requester@client.com"/);
  assert.match(form, new RegExp(TWO_STAGE_FOLLOW_UP_NOTE.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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
