// Nov 1 notes, batch 9a — the app's side (the database's is suite zz38): Trash retention labels (66), the
// form editor's card layout and Branch button (67, 68), verified domains (69), no second Email question
// (71), "Original request" files (72), links to tasks and projects in comments (10.3), pinned comments
// (10.4), and the approval decisions (approvers only; the guided setup).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { VerifiedDomainsSettings } from "@/components/admin/verified-domains-settings";
import { ApprovalToggle } from "@/components/complete-toggle";
import { FormEditor } from "@/components/forms/form-editor";
import { ProjectAccessProvider } from "@/components/project/project-access";
import { ShellProvider } from "@/components/shell/shell-context";
import { MentionText } from "@/components/task/comment-parts";
import { OriginalRequestFiles } from "@/components/task/task-attachments";
import { ToastProvider } from "@/components/toast";
import { appLinkIds, appLinkSegments, parseAppLink, projectLinkUrl, taskLinkUrl } from "@/lib/app-links";
import { approvalSetupProblem, approvalSetupSummary, defaultApprovalSetup } from "@/lib/approval-setup";
import { canRespondToSubmitter } from "@/lib/comment-email";
import type { TaskAttachment } from "@/lib/data";
import {
  EMAIL_QUESTION_NOTE,
  branchUnavailableReason,
  domainsInWords,
  emailOnDomains,
  ensureNameQuestion,
  insertBranchQuestion,
  showInBranch,
  type FormDef,
  type FormQuestion,
} from "@/lib/forms";
import { DEFAULT_SIDEBAR_PREFS } from "@/lib/sidebar-prefs";
import { TRASH_RETENTION_DAYS, trashDaysLeft, trashDeletesInLabel } from "@/lib/trash";
import { conversationNote, normalizeDomainInput } from "@/lib/verified-domains";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const member = { id: "me", email: "me@example.com", name: "Me", avatarUrl: null };

function render(node: ReactNode) {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value="/projects/p1/list">
        <SearchParamsContext.Provider value={new URLSearchParams() as never}>
          <ShellProvider member={member as never} isWorkspaceAdmin={false} workspace={{ name: "ALHC", logoUrl: null }} initialSidebar={DEFAULT_SIDEBAR_PREFS}>
            <ToastProvider>
              <ProjectAccessProvider role="admin">{node}</ProjectAccessProvider>
            </ToastProvider>
          </ShellProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

const DAY = 24 * 60 * 60 * 1000;
const T = "11111111-1111-4111-8111-111111111111";
const P = "22222222-2222-4222-8222-222222222222";

// ---------------------------------------------------------------------------------------------
// 66. Trash retention
// ---------------------------------------------------------------------------------------------

test("66: items in the Trash say how many days they have left (90 days)", () => {
  const now = Date.parse("2026-11-01T12:00:00Z");
  assert.equal(TRASH_RETENTION_DAYS, 90);
  assert.equal(trashDaysLeft(new Date(now).toISOString(), now), 90, "just deleted");
  assert.equal(trashDaysLeft(new Date(now - 10 * DAY).toISOString(), now), 80);
  assert.equal(trashDeletesInLabel(new Date(now - 10 * DAY).toISOString(), now), "Deletes in 80 days");
  assert.equal(trashDeletesInLabel(new Date(now - 89 * DAY - 1000).toISOString(), now), "Deletes in 1 day");
  assert.equal(trashDeletesInLabel(new Date(now - 95 * DAY).toISOString(), now), "Deletes today", "past 90 days: the next run");
  assert.equal(trashDaysLeft("not a date", now), 90);
});

// ---------------------------------------------------------------------------------------------
// 10.3. Links to tasks and projects in comments
// ---------------------------------------------------------------------------------------------

test("10.3: app links are recognised (task and project URLs), other URLs stay text", () => {
  assert.deepEqual(parseAppLink(`https://app.example.com/projects/${P}?task=${T}`), { kind: "task", taskId: T, projectId: P });
  assert.deepEqual(parseAppLink(`https://x.vercel.app/my-tasks?task=${T}`), { kind: "task", taskId: T, projectId: null });
  assert.deepEqual(parseAppLink(`https://app.example.com/projects/${P}/views/abc`), { kind: "project", projectId: P });
  assert.equal(parseAppLink("https://example.com/projects/not-a-uuid"), null);
  assert.equal(parseAppLink("https://example.com/about"), null);

  const body = `See https://a.b/projects/${P}?task=${T}. And https://a.b/projects/${P}, plus https://google.com.`;
  const segments = appLinkSegments(body);
  assert.deepEqual(
    segments.map((s) => (s.type === "text" ? s.text : `[${s.link.kind}]`)),
    ["See ", "[task]", ". And ", "[project]", ", plus https://google.com."],
    "trailing punctuation stays text",
  );
  assert.deepEqual(appLinkIds([body, `https://a.b/inbox?tab=x&task=${T}`]), { taskIds: [T], projectIds: [P] });
  assert.equal(taskLinkUrl("https://a.b", T, P), `https://a.b/projects/${P}?task=${T}`);
  assert.equal(taskLinkUrl("https://a.b", T, null), `https://a.b/my-tasks?task=${T}`);
  assert.equal(projectLinkUrl("https://a.b", P), `https://a.b/projects/${P}`);
});

test("10.3: a comment shows linked tasks and projects as named chips; unreadable ones as Private link", () => {
  const other = "33333333-3333-4333-8333-333333333333";
  const body = `Done like https://a.b/projects/${P}?task=${T} in https://a.b/projects/${P} — not https://a.b/my-tasks?task=${other}`;
  const html = render(
    <MentionText body={body} people={[]} refs={{ tasks: { [T]: { title: "Spring flyer", projectId: P } }, projects: { [P]: { name: "Marketing" } } }} />,
  );
  assert.match(html, /data-app-link="task"[^>]*>.*Spring flyer/, "the task's name, opening it in the pane");
  assert.match(html, new RegExp(`href="/projects/${P}"[^>]*data-app-link="project"|data-app-link="project"[^>]*href="/projects/${P}"`));
  assert.match(html, />Marketing</);
  assert.match(html, /data-app-link="private"/, "a task the reader can't open");
  assert.ok(!html.includes(`task=${other}">`), "never a link to it");
  // Without refs (project Messages), text stays as typed.
  assert.ok(!/data-app-link/.test(render(<MentionText body={body} people={[]} />)));
});

// ---------------------------------------------------------------------------------------------
// 67, 68, 71. The form editor
// ---------------------------------------------------------------------------------------------

const choice: FormQuestion = {
  id: "q-type",
  type: "single_select",
  label: "What do you need?",
  options: [
    { id: "o-print", label: "Print" },
    { id: "o-web", label: "Web" },
  ],
};
const text: FormQuestion = { id: "q-size", type: "short_text", label: "Size" };

test("68: branching helpers: show a later question for an answer, or add a new one right after the branch", () => {
  const qs = ensureNameQuestion([choice, text]);
  const shown = showInBranch(qs, "q-type", "q-size", "o-print", true);
  assert.deepEqual(shown.find((q) => q.id === "q-size")?.show_if, { question_id: "q-type", option_ids: ["o-print"] });
  const off = showInBranch(shown, "q-type", "q-size", "o-print", false);
  assert.equal(off.find((q) => q.id === "q-size")?.show_if, undefined);

  const added = insertBranchQuestion(shown, "q-type", "o-web", { id: "q-new", type: "short_text", label: "" });
  const ids = added.map((q) => q.id);
  assert.ok(ids.indexOf("q-new") === ids.indexOf("q-size") + 1, "after the question the branch already shows");
  assert.deepEqual(added.find((q) => q.id === "q-new")?.show_if, { question_id: "q-type", option_ids: ["o-web"] });

  assert.equal(branchUnavailableReason(choice), null);
  assert.match(branchUnavailableReason(text) ?? "", /Only Single choice, Multiple choice, and Checkbox/);
});

function form(questions: FormQuestion[], over: Partial<FormDef> = {}): FormDef {
  return {
    id: "f1",
    projectId: "p1",
    title: "Requests",
    description: null,
    questions,
    destinationSectionId: null,
    acceptingResponses: true,
    sendConfirmation: false,
    confirmationMessage: null,
    ...over,
  };
}

test("67, 68: each card starts with its type and Required, and every question has a Branch button", () => {
  const html = render(
    <FormEditor form={form([choice, text])} sections={[]} fields={[]} origin="https://a.b" batch4 real1 canEdit closeHref="/projects/p1/forms" />,
  );
  // The first card is open: its type picker and Required come before the question's label box.
  const open = html.slice(html.indexOf('-body"'));
  assert.ok(open.indexOf('data-question-top=""') >= 0, "the top row");
  assert.ok(open.indexOf('data-question-top=""') < open.indexOf("-label\""), "type and Required come first");
  assert.ok((html.match(/>Branch</g) ?? []).length >= 2, "a Branch button on each question but the name question");
  assert.match(html, /aria-label="Branch: Only Single choice/, "a short answer says why it can't branch");
});

test("71: a second Email question isn't offered (the form already asks for the submitter's email)", () => {
  assert.equal(EMAIL_QUESTION_NOTE, "The form already asks for the submitter’s email.");
});

// ---------------------------------------------------------------------------------------------
// 69. Verified domains
// ---------------------------------------------------------------------------------------------

test("69: domains are cleaned like the database does, and checked exactly", () => {
  assert.equal(normalizeDomainInput(" @AutumnHC.net "), "autumnhc.net");
  assert.equal(normalizeDomainInput("ana@autumnlakemarketing.com"), "autumnlakemarketing.com");
  assert.equal(normalizeDomainInput("https://example.com/path"), "example.com");
  assert.equal(normalizeDomainInput("not a domain"), null);
  assert.equal(normalizeDomainInput("localhost"), null);
  assert.ok(emailOnDomains("Ana@AutumnHC.net", ["autumnhc.net"]));
  assert.ok(!emailOnDomains("ana@sub.autumnhc.net", ["autumnhc.net"]), "exact domain");
  assert.ok(!emailOnDomains("ana@gmail.com", ["autumnhc.net"]));
  assert.equal(domainsInWords(["autumnhc.net", "autumnlakemarketing.com"]), "autumnhc.net or autumnlakemarketing.com");
});

test("69: workers are told when a request's email conversation is off, and the checkbox goes", () => {
  const off = conversationNote({ allowed: false, reason: "unverified", email: "pat@gmail.com", domain: "gmail.com" });
  assert.match(off ?? "", /Email conversation is off: pat@gmail.com isn’t on a verified domain/);
  assert.equal(conversationNote({ allowed: true, reason: "verified", email: "a@autumnhc.net", domain: "autumnhc.net" }), null);
  assert.match(conversationNote({ allowed: true, reason: "override_request", email: "p@gmail.com", domain: "gmail.com" }) ?? "", /turned on email for this request/);
  const task = { source: "form", isSubtask: false, submission: { email: "pat@gmail.com" }, submitterResponses: true, viewerRole: "editor" };
  assert.ok(canRespondToSubmitter(task), "no status loaded: as before");
  assert.ok(!canRespondToSubmitter({ ...task, submitterConversation: { allowed: false } }), "off: no Send response to submitter");
  assert.ok(canRespondToSubmitter({ ...task, submitterConversation: { allowed: true } }));
});

test("69: Admin console → Security lists the domains with the switch", () => {
  const html = render(
    <VerifiedDomainsSettings
      conversationsVerifiedOnly
      domains={[
        { id: "d1", domain: "autumnhc.net", createdAt: "2026-11-01T00:00:00Z" },
        { id: "d2", domain: "autumnlakemarketing.com", createdAt: "2026-11-01T00:00:00Z" },
      ]}
    />,
  );
  assert.match(html, /data-verified-domain="autumnhc.net"/);
  assert.match(html, /data-verified-domain="autumnlakemarketing.com"/);
  assert.match(html, /Only verified domains get email conversations on requests/);
  assert.match(html, /aria-label="Remove autumnhc.net"/);
  assert.match(html, />Add domain</);
});

// ---------------------------------------------------------------------------------------------
// 72. Original request files
// ---------------------------------------------------------------------------------------------

test("72: files from the form show under the description as the Original request", () => {
  const file = (over: Partial<TaskAttachment>): TaskAttachment => ({
    id: "a1",
    fileName: "brief.png",
    contentType: "image/png",
    sizeBytes: 10,
    uploadedBy: "me",
    createdAt: "2026-11-01T00:00:00Z",
    source: "form",
    ...over,
  });
  const html = render(
    <OriginalRequestFiles
      attachments={[file({}), file({ id: "a2", fileName: "spec.pdf", contentType: "application/pdf" }), file({ id: "a3", fileName: "later.png", source: "upload" })]}
    />,
  );
  assert.match(html, /Original request · 2 files from the form/);
  assert.match(html, /aria-label="Preview brief.png"/, "an image previews in the lightbox");
  assert.match(html, /href="\/attachments\/a2\?preview=1"/, "a PDF opens in the browser's viewer");
  assert.ok(!html.includes("later.png"), "files added later stay in Attachments only");
  assert.ok(!/Original request/.test(render(<OriginalRequestFiles attachments={[file({ source: "upload" })]} />)), "nothing without form files");
});

// ---------------------------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------------------------

test("approvals (a): an approved task's control for non-approvers is an inert Approved", () => {
  const html = render(<ApprovalToggle mode="approved" title="Spring flyer" />);
  assert.match(html, /data-approval-toggle="approved"/);
  assert.match(html, /aria-disabled="true"/);
  assert.match(html, /was approved: its approver completes it/);
});

test("approvals (b): the guided setup — approvers, then what happens after approval", () => {
  const draft = defaultApprovalSetup();
  assert.equal(draft.followUp, "complete", "complete by default");
  assert.equal(draft.mode, "any");
  assert.equal(draft.reminders, true);
  assert.equal(approvalSetupProblem("approvers", draft), "Choose at least one approver");
  const ready = { ...draft, approverIds: ["a"] };
  assert.equal(approvalSetupProblem("approvers", ready), null);
  assert.equal(approvalSetupProblem("after", { ...ready, followUp: "move_section" }), "Choose the section to move it to");
  assert.equal(approvalSetupSummary(ready, ["Ana"]), "Ana approves it, then the task is completed.");
  assert.equal(
    approvalSetupSummary({ ...ready, approverIds: ["a", "b"], mode: "all", followUp: "move_section", sectionId: "s" }, ["Ana", "Ben"], "Ready to publish"),
    "Ana and Ben all approve it, then it moves to “Ready to publish”.",
  );
  assert.equal(approvalSetupSummary({ ...ready, followUp: "notify" }, ["Ana"]), "Ana approves it, then the assignee is notified.");
});
