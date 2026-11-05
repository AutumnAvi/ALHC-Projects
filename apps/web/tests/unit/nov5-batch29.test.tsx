// Nov 5 notes, batch 29 — 164 (an Inbox approval opens its review page, from the card and its "Open
// review" button), 165 (compact Attachments with Show all and Previews), and 166 (thumbnails on feedback
// pills; feedback subtasks named feedback first with the file as a chip that opens it). The pure rules are
// pinned in packages/core/tests/nov5-batch29.test.ts.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { InboxCard } from "@/components/inbox/inbox-card";
import { NeedsYouCard } from "@/components/home/needs-you-card";
import { ShellProvider } from "@/components/shell/shell-context";
import { ToastProvider } from "@/components/toast";
import { ProjectAccessProvider } from "@/components/project/project-access";
import { TaskAttachments, type AttachmentUpload } from "@/components/task/task-attachments";
import { ApprovalFeedback } from "@/components/task/task-approval-banner";
import { FeedbackSubtaskButton } from "@/components/task/feedback-subtask";
import { AssetThumb, assetThumbSrc } from "@/components/task/asset-thumb";
import { FileTypeIcon } from "@/components/task/file-type-icon";
import { PeopleDirectoryProvider, TaskTitleText, assetChipHref, titleHasChips, titleSegments } from "@/components/task/title-text";
import { DEFAULT_SIDEBAR_PREFS } from "@/lib/sidebar-prefs";
import type { InboxItem } from "@alhc/core/api/inbox/model";
import type { AwaitingApproval } from "@alhc/core/api/my-tasks/model";
import type { ApprovalRound, TaskApproval, TaskAttachment, TaskDetail } from "@alhc/core/api/task-pane/model";
import { assetRefLine } from "@alhc/core/title-assets";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const member = { id: "me", email: "me@example.com", name: "Me", avatarUrl: null };

function render(node: ReactNode, pathname = "/inbox") {
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

const FILE = "0f1e2d3c-4b5a-4968-8776-655443322110";

// ---------------------------------------------------------------------------------------------
// 164: Inbox approval items open the review page
// ---------------------------------------------------------------------------------------------

function inboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "i1",
    kind: "approval_requested",
    data: { approval_id: "req-me" },
    actorId: null,
    readAt: null,
    archivedAt: null,
    bookmarkedAt: null,
    createdAt: "2026-11-05T09:00:00Z",
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

const card = (item: InboxItem, density: "detailed" | "compact" = "detailed") =>
  render(
    <ul>
      <InboxCard
        item={item}
        actor={undefined}
        state={{ read: false, archived: false, bookmarked: false }}
        density={density}
        active={false}
        href="/inbox?task=t1"
        memberId="me"
        bookmarks={false}
        onOpen={() => {}}
        onRead={() => {}}
        onArchive={() => {}}
        onBookmark={() => {}}
      />
    </ul>,
  );

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

test("164: a pending request, a resubmission, and both reminders open the review page — the card and its button", () => {
  const variants: Record<string, InboxItem> = {
    request: inboxItem(),
    resubmitted: inboxItem({ data: { approval_id: "req-me", resubmitted: true } }),
    dueSoon: inboxItem({ data: { approval_id: "req-me", reminder: "due_soon", due_on: "2026-11-06" } }),
    overdue: inboxItem({ data: { approval_id: "req-me", reminder: "overdue", due_on: "2026-11-04" } }),
  };
  for (const [name, item] of Object.entries(variants)) {
    for (const density of ["detailed", "compact"] as const) {
      const html = card(item, density);
      assert.match(html, /data-inbox-review-link=""/, `${name} ${density}: the card's own link`);
      assert.match(html, /data-inbox-open-review=""[^>]*>.*Open review<\/a>/, `${name} ${density}: the Open review button`);
      assert.deepEqual(hrefs(html), ["/approve/t1", "/approve/t1"], `${name} ${density}: nothing opens just the task`);
      assert.ok(!/>Approve<|>Request changes<|>Reject</.test(html), `${name} ${density}: still no decisions here (note 159)`);
    }
  }
});

test("164: decided, cancelled, or someone else's requests open the task as before", () => {
  for (const status of ["approved", "changes_requested", "rejected", "cancelled"] as const) {
    const html = card(inboxItem({ approval: { id: "req-me", status, approverId: "me" } }));
    assert.ok(!/Open review/.test(html), status);
    assert.ok(!hrefs(html).includes("/approve/t1"), status);
  }
  const other = card(inboxItem({ approval: { id: "req-sam", status: "pending", approverId: "sam" } }));
  assert.ok(!/Open review/.test(other));
  const comment = card(inboxItem({ kind: "comment", data: {}, approval: null, commentBody: "Nice" }));
  assert.ok(!hrefs(comment).includes("/approve/t1"));
});

function awaiting(overrides: Partial<AwaitingApproval> = {}): AwaitingApproval {
  return {
    requestId: "req-me",
    taskId: "t1",
    title: "Spring flyer",
    requestLabel: null,
    projectId: "p1",
    projectName: "Launch",
    dueOn: null,
    sentAt: "2026-11-05T09:00:00Z",
    roundNumber: 2,
    isApprovalTask: true,
    ...overrides,
  };
}

test("164: Home's Needs you sends approval rounds and approval Inbox items to the review page", () => {
  const html = render(
    <NeedsYouCard
      approvals={[awaiting(), awaiting({ requestId: "old", taskId: "t2", roundNumber: null, isApprovalTask: false })]}
      mentions={[]}
      inbox={[inboxItem({ id: "i2", data: { approval_id: "req-me", reminder: "overdue" } })]}
      unreadTotal={1}
      undatedCount={0}
      actors={[]}
    />,
    "/",
  );
  assert.match(html, /<a data-needs-you-review=""[^>]*href="\/approve\/t1">.*?Open review/, "a round: Open review");
  assert.ok(!hrefs(html).includes("/approve/t2"), "an older request without a round opens its task");
  assert.equal(hrefs(html).filter((h) => h === "/approve/t1").length, 2, "the reminder in From your Inbox too");
});

test("164: My tasks' Waiting on me to approve rows have Open review; emails already link the review page", () => {
  const view = fs.readFileSync(new URL("../../src/components/my-tasks/my-tasks-view.tsx", import.meta.url), "utf8");
  const row = view.slice(view.indexOf("export function AwaitingRow"));
  assert.match(row, /href=\{approverReviewHref\(item\.taskId\)\}[\s\S]*?Open review/);
  const email = fs.readFileSync(new URL("../../src/lib/email.ts", import.meta.url), "utf8");
  assert.match(email, /item_kind\) === "approval_requested" && taskId && isUuid\(taskId\) \? approverReviewHref\(taskId\)/);
});

// ---------------------------------------------------------------------------------------------
// 165: compact Attachments
// ---------------------------------------------------------------------------------------------

function file(n: number, name = `file-${n}.pdf`, contentType: string | null = "application/pdf"): TaskAttachment {
  return { id: `a${n}`, fileName: name, contentType, sizeBytes: 2048 * n, uploadedBy: "me", createdAt: "2026-11-05T09:00:00Z" };
}

const upload: AttachmentUpload = { input: <input type="file" hidden />, pick: () => {}, add: () => {}, uploading: 0, error: null };

const files = [file(1, "logo.png", "image/png"), file(2), file(3, "budget.xlsx", null), file(4), file(5), file(6), file(7)];

const attachments = (view: "compact" | "all" | "previews", canEdit = true, list = files) =>
  render(<TaskAttachments attachments={list} upload={upload} canEdit={canEdit} initialView={view} />, "/projects/p1/list");

test("165: compact by default — the first names with an icon, no previews, Show all N", () => {
  const html = render(<TaskAttachments attachments={files} upload={upload} canEdit />, "/projects/p1/list");
  assert.match(html, /data-attachments-view="compact"/);
  assert.match(html, /data-attachments-list=""/);
  for (const name of ["logo.png", "file-2.pdf", "budget.xlsx", "file-4.pdf"]) assert.ok(html.includes(`>${name}<`), name);
  for (const name of ["file-5.pdf", "file-6.pdf", "file-7.pdf"]) assert.ok(!html.includes(`>${name}<`), `${name} is behind Show all`);
  assert.ok(!/<img/.test(html), "no thumbnails in the compact list");
  assert.match(html, /data-file-kind="image"/);
  assert.match(html, /data-file-kind="pdf"/);
  assert.match(html, /data-file-kind="sheet"/);
  assert.match(html, />Show all 7<\/button>/, "next to the heading");
  assert.match(html, />Show 3 more<\/button>/, "and at the bottom");
  assert.match(html, /aria-label="Previews"/);
  // Open, download, remove, and upload stay.
  assert.match(html, /aria-label="Preview logo\.png"/, "an image opens the lightbox");
  assert.match(html, /href="\/attachments\/a2\?preview=1"/, "a PDF opens in the browser's viewer");
  assert.match(html, /href="\/attachments\/a3"/, "anything else downloads");
  assert.match(html, /href="\/attachments\/a2\?download"/);
  assert.match(html, /aria-label="Remove attachment file-2\.pdf"/);
  assert.match(html, /aria-label="Attach files"/);
});

test("165: Show all lists every name; Previews is the card grid as before", () => {
  const all = attachments("all");
  for (const f of files) assert.ok(all.includes(`>${f.fileName}<`), f.fileName);
  assert.match(all, />Show fewer<\/button>/);
  assert.ok(!/<img/.test(all));

  const previews = attachments("previews");
  assert.match(previews, /data-attachments-view="previews"/);
  assert.match(previews, /<img[^>]*src="\/attachments\/a1\?preview=1"/, "image thumbnails");
  assert.match(previews, /Up to 25 MB each/);
  assert.match(previews, />Attach files<\/button>/, "the Attach card");
  assert.ok(!/Show all/.test(previews));
  for (const f of files) assert.ok(previews.includes(`>${f.fileName}<`), f.fileName);
});

test("165: a few files show without Show all; viewers can't remove or attach", () => {
  const few = attachments("compact", true, files.slice(0, 3));
  assert.ok(!/Show all|more<\/button>/.test(few));
  const viewer = attachments("compact", false);
  assert.ok(!/Remove attachment|aria-label="Attach files"/.test(viewer));
  assert.match(viewer, /aria-label="Download logo\.png"/);
  const source = fs.readFileSync(new URL("../../src/components/task/task-attachments.tsx", import.meta.url), "utf8");
  assert.match(source, /onDrop=\{/, "files can be dropped on the section");
  assert.match(source, /upload\.add\(e\.dataTransfer\.files\)/);
});

// ---------------------------------------------------------------------------------------------
// 166: feedback pills, titles, and file chips
// ---------------------------------------------------------------------------------------------

test("166: a thumbnail is the image itself, else the stored first-page picture; the icon is the fallback", () => {
  assert.equal(assetThumbSrc("a1", "logo.png", "image/png"), "/attachments/a1?preview=1");
  assert.equal(assetThumbSrc("a2", "brief.pdf", "application/pdf"), "/attachments/a2?thumb=1");
  assert.match(render(<AssetThumb fileId="a1" fileName="logo.png" contentType="image/png" />), /data-asset-thumb="image"[^>]*><img[^>]*src="\/attachments\/a1\?preview=1"/);
  assert.match(render(<AssetThumb fileId={null} fileName="brief.pdf" />), /data-asset-thumb="icon"/);
  assert.match(render(<FileTypeIcon fileName="clip.mov" />), /data-file-kind="video"/);
  const route = fs.readFileSync(new URL("../../src/app/attachments/[id]/route.ts", import.meta.url), "utf8");
  assert.match(route, /searchParams\.get\("thumb"\) === "1"/);
  assert.match(route, /signedThumbnailUrl\(api, id, attachment/, "signed with the viewer's own client");
});

function request(overrides: Partial<TaskApproval> = {}): TaskApproval {
  return {
    id: "req-sam",
    subtaskId: null,
    approverId: "sam",
    requestedBy: "ann",
    ruleName: null,
    note: null,
    status: "changes_requested",
    decidedAt: "2026-11-05T10:00:00Z",
    decisionNote: "✗ logo.png: Do better\n✓ brief.pdf: approved",
    createdAt: "2026-11-05T09:00:00Z",
    roundId: "r1",
    cancelReason: null,
    handoffTo: null,
    handoffNote: null,
    ...overrides,
  };
}

function round(): ApprovalRound {
  return {
    id: "r1",
    number: 1,
    status: "changes_requested",
    mode: "any",
    finalText: null,
    attachmentIds: ["a1", "a2"],
    moreSteps: false,
    afterApproval: "complete",
    moveSectionId: null,
    moveSectionName: null,
    dueOn: null,
    sentBy: "ann",
    sentAt: "2026-11-05T09:00:00Z",
    decidedBy: "sam",
    decidedAt: "2026-11-05T10:00:00Z",
    acknowledgedAt: null,
    withdrawnAt: null,
    requests: [request()],
  };
}

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
    assigneeId: "ann",
    homeProjectId: "p1",
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    source: "manual",
    requestLabel: null,
    canAssignRequestNumber: false,
    submission: null,
    submitterResponses: false,
    replyThread: null,
    approvals: [],
    approval: { approverIds: ["sam"], mode: "any", dueOn: null, status: "changes_requested", paused: false, waitingOnMe: false, rounds: [round()] },
    projectNumbers: {},
    subtasks: [],
    parentTaskId: null,
    ancestors: [],
    isSubtask: false,
    memberships: [{ projectId: "p1", projectName: "Launch", sectionId: "s1", sections: [{ id: "s1", name: "To do" }] }],
    fields: [],
    fieldValues: {},
    followerIds: [],
    attachments: [file(1, "logo.png", "image/png"), file(2, "brief.pdf", "application/pdf")],
    attachmentLinks: [],
    comments: [],
    commentTotal: 0,
    olderComments: null,
    stories: [],
    mentionTeams: [],
    viewerRole: "editor",
    memberRoles: { me: "editor", sam: "commenter", ann: "editor" },
    tagIds: [],
    isPrivate: false,
    privateReaderIds: [],
    ...overrides,
  };
}

test("166: each file's feedback pill carries a tiny picture of the file", () => {
  const html = render(<ApprovalFeedback task={task()} profiles={[]} memberId="me" />, "/projects/p1/list");
  const pills = [...html.matchAll(/data-feedback-pill="([a-z_]+)">(.*?)<\/span><\/button>/g)];
  assert.equal(pills.length, 2);
  const logo = pills.find((p) => p[2].includes("logo.png"))!;
  assert.equal(logo[1], "changes_requested");
  assert.match(logo[2], /data-asset-thumb="image"[^>]*><img[^>]*src="\/attachments\/a1\?preview=1"/, "an image shows itself");
  const brief = pills.find((p) => p[2].includes("brief.pdf"))!;
  assert.match(brief[2], /src="\/attachments\/a2\?thumb=1"/, "a PDF its stored first page");
});

test("166: Create subtask names it feedback first, then the file — and knows subtasks named the old way", () => {
  const fresh = render(<FeedbackSubtaskButton task={task()} feedback="Do better" from="Sam" file={{ id: "a1", name: "logo.png" }} legacyTitle="logo.png: Do better" />);
  assert.match(fresh, /data-feedback-subtask=""/);
  const made = (title: string) =>
    render(
      <FeedbackSubtaskButton
        task={task({ subtasks: [{ id: "s1", parentId: "t1", title, completedAt: null, assigneeId: null, startOn: null, dueOn: null, kind: "task", sortOrder: 1024, subtaskCount: 0, subtaskDoneCount: 0 }] })}
        feedback="Do better"
        from="Sam"
        file={{ id: "a1", name: "logo.png" }}
        legacyTitle="logo.png: Do better"
      />,
    );
  assert.match(made("Do better — logo.png"), /Subtask created/);
  assert.match(made("logo.png: Do better"), /Subtask created/, "one made before note 166");
  assert.ok(!/Subtask created/.test(made("Something else")));
  const source = fs.readFileSync(new URL("../../src/components/task/feedback-subtask.tsx", import.meta.url), "utf8");
  assert.match(source, /feedbackSubtaskNotes\(\{ feedback, from, link: taskLink\(task\), asset, origin \}\)/, "the description carries the file's id");
});

const people = [{ id: "dana", name: "Dana Lee", email: "dana@example.com" }];
// Only the router (nested chips use it): the markup alone, without the providers' toast dock.
const bare = (node: ReactNode) => renderToStaticMarkup(<AppRouterContext.Provider value={router as never}>{node}</AppRouterContext.Provider>);

test("166: the file in a name is a chip that opens it; @person chips still work beside it", () => {
  const assets = [{ id: FILE, name: "logo.png", contentType: "image/png" }];
  const html = bare(
    <PeopleDirectoryProvider people={people}>
      <TaskTitleText title="Ask @Dana Lee to redo — logo.png" assets={assets} />
    </PeopleDirectoryProvider>,
  );
  assert.match(html, /<a data-title-mention="dana"[^>]*href="\/people\/dana">@Dana Lee<\/a>/);
  assert.match(html, new RegExp(`<a href="/attachments/${FILE}\\?preview=1" target="_blank"[^>]*data-title-asset="${FILE}"[^>]*>.*logo\\.png</span></a>`));
  assert.match(html, /Ask <\/span>/);
  // Inside a row's link it's a span that opens the file without opening the task.
  const nested = bare(<TaskTitleText title="Do better — logo.png" assets={assets} nested />);
  assert.match(nested, new RegExp(`<span role="link"[^>]*data-title-asset="${FILE}"`));
  assert.ok(!/<a /.test(nested));
  // Without files, the name is as before.
  assert.equal(bare(<TaskTitleText title="Do better — logo.png" />), "Do better — logo.png");
  assert.equal(assetChipHref({ id: FILE, name: "notes.docx" }), `/attachments/${FILE}`, "non-previewable files download");
  assert.ok(titleHasChips("Do better — logo.png", [], assets));
  assert.ok(!titleHasChips("Do better", [], assets));
  assert.deepEqual(
    titleSegments("@Dana Lee: logo.png", people, assets).map((s) => s.kind),
    ["person", "text", "asset"],
  );
});

test("166: the subtask's pane title and the parent's subtask list draw the chip (by id from the description, by name from the parent's files)", () => {
  const pane = fs.readFileSync(new URL("../../src/components/task/task-detail-panel.tsx", import.meta.url), "utf8");
  assert.match(pane, /titleAssetsFor\(task\.notes, task\.attachments\.map/);
  assert.match(pane, /<TaskTitleText title=\{title\} people=\{people\} assets=\{assets\} \/>/);
  const list = fs.readFileSync(new URL("../../src/components/task/task-subtasks.tsx", import.meta.url), "utf8");
  assert.match(list, /task\.attachments\.map\(\(a\) => \(\{ id: a\.id, name: a\.fileName, contentType: a\.contentType \}\)\)/);
  assert.match(list, /<TaskTitleText title=\{subtask\.title\} people=\{people\} assets=\{assets\} \/>/);
  assert.match(assetRefLine({ id: FILE, name: "logo.png" }), /^File: logo\.png \(\/attachments\//);
});
