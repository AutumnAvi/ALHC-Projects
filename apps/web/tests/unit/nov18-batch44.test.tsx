// Nov 18 notes (batch 44): the approval moved to its own section with a status heading under the name
// (item 2), an approval made only by its finished setup (item 3), the add row that wouldn't close (item 4),
// @mention chips in the comment box (item 5), the review pages' Submit always in reach (item 1), and the
// Files page's in-place preview (item 7). Item 6 (tab overrides) is in packages/core/tests.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { ProjectAccessProvider } from "@/components/project/project-access";
import { ProjectFiles } from "@/components/project/project-files";
import { ToastProvider } from "@/components/toast";
import { previewStep } from "@/components/file-preview-overlay";
import { ApprovalSetupDialog } from "@/components/task/approval-setup-dialog";
import { ApprovalStatusHeading, ApprovalTaskBanner, approvalHeadingText, approvalSectionId } from "@/components/task/task-approval-banner";
import { MentionTextarea } from "@/components/task/mention-textarea";
import { claimAddRow, openAddRowIds } from "@/lib/add-row";
import {
  addChipLink,
  bodyToDisplay,
  chipText,
  displayToBody,
  isMentionChip,
  NO_CHIP_LINKS,
  removeChipAt,
  seedMentionPeople,
  tidyDisplay,
  wrapMentions,
} from "@/lib/link-chips";
import type { Profile } from "@alhc/core/api/people/model";
import type { ProjectFile } from "@alhc/core/api/projects/model";
import type { ApprovalRound, TaskApprovalInfo, TaskDetail } from "@alhc/core/api/task-pane/model";

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
  { id: "dana", email: "dana@example.com", full_name: "Dana Lee", avatar_url: null },
];

const notSent: TaskApprovalInfo = { approverIds: ["sam"], mode: "any", dueOn: null, status: "not_sent", paused: false, waitingOnMe: false, rounds: [] };

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
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
    createdAt: "2026-11-18T00:00:00Z",
    updatedAt: "2026-11-18T00:00:00Z",
    source: "manual",
    requestLabel: null,
    canAssignRequestNumber: false,
    submission: null,
    submitterResponses: false,
    replyThread: null,
    approvals: [],
    approval: notSent,
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
    memberRoles: { sam: "commenter", dana: "editor" },
    tagIds: [],
    isPrivate: false,
    privateReaderIds: [],
    ...overrides,
  };
}

const source = (path: string) => fs.readFileSync(path, "utf8");

// ---------------------------------------------------------------------------------------------
// Item 2: a status heading under the name, the approval as its own section
// ---------------------------------------------------------------------------------------------

test("item 2: the heading under the name says the state and links to the section", () => {
  assert.equal(approvalHeadingText(notSent), "Approval: Not sent");
  assert.equal(approvalHeadingText({ ...notSent, status: "pending" }), "Waiting for approval");
  assert.equal(approvalHeadingText({ ...notSent, status: "changes_requested" }), "Approval: Changes requested");
  assert.equal(approvalHeadingText({ ...notSent, approverIds: [] }), "Approval: setup not finished");

  const html = render(<ApprovalStatusHeading task={task()} profiles={people} />);
  assert.match(html, /<button[^>]*data-approval-heading="not_sent"[^>]*aria-controls="approval-section-t1"/);
  assert.match(html, /Approval: Not sent/);
  assert.match(html, /aria-label="Approver: Sam Approver"/, "the approver's face");
  assert.equal(approvalSectionId("t1"), "approval-section-t1");
  assert.equal(renderToStaticMarkup(<ApprovalStatusHeading task={task({ kind: "task", approval: null })} profiles={people} />), "", "nothing on other tasks");
});

test("item 2: the section has its own dark header, every action, and the approver's compact review", () => {
  const round: ApprovalRound = {
    id: "r1",
    number: 2,
    status: "pending",
    mode: "any",
    dueOn: null,
    finalText: null,
    attachmentIds: ["a1"],
    moreSteps: false,
    afterApproval: "complete",
    moveSectionName: null,
    sentBy: "dana",
    sentAt: "2026-11-18T00:00:00Z",
    decidedBy: null,
    decidedAt: null,
    withdrawnAt: null,
    acknowledgedAt: null,
    requests: [{ id: "req-me", approverId: "me", status: "pending" } as never],
  } as unknown as ApprovalRound;
  const approver = task({
    viewerRole: "commenter",
    approval: { ...notSent, approverIds: ["me"], status: "pending", waitingOnMe: true, rounds: [round] },
    attachments: [{ id: "a1", fileName: "flyer.png", contentType: "image/png", sizeBytes: 10, createdAt: "2026-11-18T00:00:00Z" } as never],
  });
  const html = render(<ApprovalTaskBanner task={approver} profiles={people} memberId="me" />);
  assert.match(html, /<section id="approval-section-t1" tabindex="-1"/);
  assert.match(html, /data-approval-header=""/);
  assert.match(html, /Waiting for approval · Round 2/);
  assert.match(html, /data-approval-open-review=""/, "Open review (full screen)");
  assert.match(html, /data-approver-review="compact"/, "and the compact review of the files, in the section");
  assert.match(html, />Reject<\/button>/);
  assert.match(html, /Hand off…/);
});

test("item 2: the pane draws the heading under the name and the section between description and subtasks", () => {
  const pane = source("src/components/task/task-detail-panel.tsx");
  assert.ok(pane.indexOf("<ApprovalStatusHeading") > pane.indexOf("<PaneTitle"));
  const fields = pane.slice(pane.indexOf("<dl className={`mt-3 ${PANE_FIELDS}`}>"), pane.indexOf("</dl>"));
  assert.ok(!fields.includes("Approval"), "no Approval row in the field list");
  assert.ok(pane.indexOf("<ApprovalTaskBanner") > pane.indexOf("<TaskDescription") && pane.indexOf("<ApprovalTaskBanner") < pane.indexOf("<TaskSubtasks"));
  assert.match(pane, /<ApprovalStateProvider task=\{task\}>/, "one shared optimistic copy for the heading and the section");
});

// ---------------------------------------------------------------------------------------------
// Item 3: an approval only once the setup is done
// ---------------------------------------------------------------------------------------------

test("item 3: making a task an approval opens the setup in make mode, and Cancel changes nothing", () => {
  const html = render(<ApprovalSetupDialog task={task({ kind: "task", approval: null })} profiles={people} make onClose={() => {}} />);
  assert.match(html, /Make this an approval/);
  assert.match(html, /It becomes an approval task only when you finish here\. Until then nothing changes\./);
  assert.match(html, /data-approval-setup="make"/);
  assert.match(html, />Make it an approval</);
  assert.match(html, /data-approval-setup-skip="">Cancel</);
  assert.doesNotMatch(html, /Skip for now/);

  const dialog = source("src/components/task/approval-setup-dialog.tsx");
  assert.match(dialog, /setUpApprovalTask\(task\.id/, "Done saves everything in one action");
  assert.doesNotMatch(dialog, /setTaskApprovers|setApprovalFollowUp|saveExternalReviewer/, "never piece by piece from the browser");

  const menu = source("src/components/task/task-more-menu.tsx");
  const changeKind = menu.slice(menu.indexOf("async function changeKind"), menu.indexOf("// Close or reopen the request"));
  assert.match(changeKind, /if \(kind === "approval"\) \{\s*if \(onApprovalSetup\) onApprovalSetup\(\);\s*else requestApprovalAction\(task\.id, "convert"\);\s*return;/);
  const rows = source("src/components/project/shared.tsx");
  assert.match(rows, /const made: TaskKind = asApproval \? "task" : kind;/, "a row added as Approval is a plain task until its setup is done");
  assert.match(rows, /approvalAction\(result\.taskId, "convert"\)/);
  // A template's approval task is a plain task until its setup is done, from the row and the toolbar.
  for (const file of ["src/components/project/shared.tsx", "src/components/project/view-toolbar.tsx"]) {
    assert.match(source(file), /result\.approvalSetup && result\.taskId\) approvalAction\(result\.taskId, "convert"\)/, file);
  }
  assert.match(source("src/lib/actions/templates.ts"), /\{ approvalAfterSetup: true \}/);
  // While Done saves, the setup can't be closed (it would say nothing changed while the save goes on).
  assert.match(dialog, /async function requestClose\(\) \{[^}]*if \(pending\) return;/);
  assert.match(dialog, /disabled=\{pending\}\s+className="btn-ghost mr-auto text-zinc-500"\s+data-approval-setup-skip=""/);
});

// ---------------------------------------------------------------------------------------------
// Item 4: one add row, and it always closes
// ---------------------------------------------------------------------------------------------

test("item 4: opening an add row closes any other open one", () => {
  const closed: string[] = [];
  const releaseA = claimAddRow("a", () => closed.push("a"));
  claimAddRow("b", () => closed.push("b"));
  assert.deepEqual(closed, ["a"], "the first row closed when the second opened");
  assert.deepEqual(openAddRowIds(), ["b"]);
  releaseA();
  assert.deepEqual(openAddRowIds(), ["b"], "a stale release never drops the row that's open");
  const releaseC = claimAddRow("c", () => closed.push("c"));
  assert.deepEqual(closed, ["a", "b"]);
  releaseC();
  assert.deepEqual(openAddRowIds(), []);
});

test("item 4: Escape, a click outside, or leaving the row closes it and puts it back to Task", () => {
  const rows = source("src/components/project/shared.tsx");
  const close = rows.slice(rows.indexOf("  const close = () => {"), rows.indexOf("  const closeRef"));
  assert.match(close, /setKind\("task"\)/, "closing resets the kind");
  assert.match(rows, /e\.key === "Escape" && !e\.defaultPrevented/, "Escape anywhere in the row");
  assert.match(rows, /document\.addEventListener\("pointerdown", onPointerDown, true\)/, "a press outside");
  assert.match(rows, /onMouseDown=\{\(e\) => e\.preventDefault\(\)\}/, "picking a kind keeps focus in the name box");
  assert.match(rows, /claimAddRow\(rowId/, "one add row open at a time");
});

// ---------------------------------------------------------------------------------------------
// Item 5: @mentions as chips while typing
// ---------------------------------------------------------------------------------------------

test("item 5: a picked person is a chip in the box; the body keeps the plain token", () => {
  const dana = [people[1]];
  const display = wrapMentions("Thanks @Dana Lee for this", dana);
  assert.equal(display, `Thanks ${chipText("@Dana Lee")} for this`);
  assert.equal(displayToBody(display, NO_CHIP_LINKS), "Thanks @Dana Lee for this", "nothing changes in what's saved");
  // Only whole tokens, as the database reads them: "@Dana Leex" isn't "@Dana Lee", but "@Dana" (her email
  // name, followed by a space) is still her.
  assert.equal(wrapMentions("Thanks @Dana Leex", dana), `Thanks ${chipText("@Dana")} Leex`);
  assert.equal(wrapMentions("Thanks @Danax", dana), "Thanks @Danax");
  assert.equal(wrapMentions(bodyToDisplay("hi @dana", NO_CHIP_LINKS), dana), `hi ${chipText("@dana")}`, "the email name too");
  assert.ok(isMentionChip("@Dana Lee"));
  assert.ok(!isMentionChip("Launch plan"));
  // Backspace right after the chip removes all of it.
  const caret = display.indexOf(" for");
  const removed = removeChipAt(display, caret, "Backspace");
  assert.equal(removed?.display, "Thanks  for this");
  assert.deepEqual(seedMentionPeople("cc @Sam Approver", people).map((p) => p.id), ["sam"], "a comment being edited opens with its chips");

  const html = renderToStaticMarkup(
    <MentionTextarea value="Thanks @Dana Lee" onValueChange={() => {}} candidates={people} aria-label="Comment" />,
  );
  assert.match(html, /data-mention-chip=""[^>]*>⁢@Dana Lee⁣<\/span>/, "drawn blue in the box");
  assert.match(html, /bg-accent-50 text-accent-700/, "the posted pill's colors");
});

test("item 5: typing never makes a chip (only picking does), so the caret and the @ picker stay put", () => {
  const dana = [people[1]];
  // Dana was picked earlier in this box; typing her name again by hand stays text while it's typed.
  const picked = `cc ${chipText("@Dana Lee")} and @Dana`;
  assert.equal(tidyDisplay(picked, NO_CHIP_LINKS, dana), picked, "nothing added, nothing taken away");
  assert.equal(tidyDisplay("hi @Dana Lee", NO_CHIP_LINKS, dana), "hi @Dana Lee", "a hand-typed token isn't wrapped");
  // A chip cut in two, or a picked one typed over, is text from then on.
  assert.equal(tidyDisplay(`hi ${chipText("@Dana Lee").slice(0, -1)}`, NO_CHIP_LINKS, dana), "hi @Dana Lee");
  assert.equal(tidyDisplay(`hi ${chipText("@Dana X")}`, NO_CHIP_LINKS, dana), "hi @Dana X");
  // It reads back as the same body.
  for (const raw of [picked, `x ${chipText("@Dana X")} y`]) {
    assert.equal(displayToBody(tidyDisplay(raw, NO_CHIP_LINKS, dana), NO_CHIP_LINKS), displayToBody(raw, NO_CHIP_LINKS));
  }
  // A task named "@Dana Lee" never takes Dana's chip (a link's chip name never starts with "@").
  const link = addChipLink(NO_CHIP_LINKS, "https://app.test/projects/11111111-1111-4111-8111-111111111111?task=22222222-2222-4222-8222-222222222222", "@Dana Lee");
  assert.equal(link.label, "Dana Lee");
  const both = `${chipText("@Dana Lee")} ${chipText(link.label)}`;
  assert.equal(displayToBody(both, link.links), "@Dana Lee https://app.test/projects/11111111-1111-4111-8111-111111111111?task=22222222-2222-4222-8222-222222222222");
  assert.equal(tidyDisplay(both, link.links, dana), both);

  // The box keeps its own text while it's typed in, and the task name saves the plain text it reported.
  const box = source("src/components/task/mention-textarea.tsx");
  assert.match(box, /const tidied = tidyDisplay\(raw, chipLinks, mentionPeople\);\s*setBoxText\(tidied\);/);
  const pane = source("src/components/task/task-detail-panel.tsx");
  assert.match(pane, /onBlur=\{\(\) => save\(draft \?\? title\)\}/, "never the textarea's value (it has the chip marks)");
  assert.doesNotMatch(pane, /save\(e\.currentTarget\.value\)/);
});

// ---------------------------------------------------------------------------------------------
// Item 1: Submit always in reach
// ---------------------------------------------------------------------------------------------

test("item 1: the review page's answer and the approver review's Submit never need a scroll", () => {
  const portal = source("src/components/review/review-portal.tsx");
  assert.match(portal, /aria-label="Your review"\s+className="[^"]*lg:sticky lg:top-4[^"]*lg:max-h-\[calc\(100dvh-6rem\)\][^"]*lg:overflow-y-auto/);
  assert.match(portal, /data-review-answer=""\s+className="fixed inset-x-0 bottom-0[^"]*lg:sticky lg:bottom-0/, "a fixed bar on phones, pinned to the column's bottom on wide screens");
  const approver = source("src/components/task/approver-review.tsx");
  assert.match(approver, /full \? "sticky bottom-0 z-10/);
  // A sticky bar can't rise above its own block: the page's details and text are drawn inside the review,
  // and a text-only round's decisions are pinned too.
  assert.match(approver, />\s*\{intro\}/);
  const page = source("src/components/task/approver-review-page.tsx");
  assert.match(page, /intro=\{\s*<>\s*<ReviewTaskDetailsPanel details=\{details\} \/>\s*\{finalText\}/);
  assert.match(page, /className="sticky bottom-0 z-10[^"]*"\s+data-approve-decide=""/);
});

// ---------------------------------------------------------------------------------------------
// Item 7: Files open in place
// ---------------------------------------------------------------------------------------------

test("item 7: a file opens in the preview right here (never a new tab), and arrows move through the files", () => {
  const files: ProjectFile[] = [
    { id: "f1", fileName: "logo.png", contentType: "image/png", sizeBytes: 2048, taskId: "t1", taskTitle: "Logo", uploadedBy: "sam", source: "upload", createdAt: "2026-11-18T00:00:00Z" } as ProjectFile,
    { id: "f2", fileName: "brief.docx", contentType: null, sizeBytes: 4096, taskId: "t2", taskTitle: "Brief", uploadedBy: "sam", source: "upload", createdAt: "2026-11-18T00:00:00Z" } as ProjectFile,
  ];
  const html = render(<ProjectFiles projectId="p1" files={files} uploaderNames={{ sam: "Sam" }} />);
  assert.match(html, /aria-label="Preview logo\.png"/);
  assert.match(html, /aria-label="Preview brief\.docx"/, "every kind of file opens the preview (others get a card)");
  assert.doesNotMatch(html, /target="_blank"/, "no new tab");
  assert.match(html, /href="\/attachments\/f1\?download"/, "Download stays");
  assert.equal(previewStep("ArrowRight", 1, 2), 0, "wraps forward");
  assert.equal(previewStep("ArrowLeft", 0, 2), 1, "wraps back");
  assert.equal(previewStep("ArrowRight", 0, 1), null, "one file: nothing to move to");
  assert.equal(previewStep("Enter", 0, 2), null);
  // A click in a PDF hands the keys to the browser's viewer; they come back once the pointer leaves it.
  const overlay = source("src/components/file-preview-overlay.tsx");
  assert.match(overlay, /tabIndex=\{-1\}\s+onMouseLeave=\{\(e\) => onLeaveFrame\(e\.currentTarget\)\}/);
  assert.match(overlay, /if \(document\.activeElement === frame\) closeRef\.current\?\.focus/);
});
