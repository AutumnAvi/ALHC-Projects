// Nov 1 notes, batch 11 (notes 73–75): emails are hard-coded (no design editor), controls a role can't use
// are hidden rather than greyed out, and the personal email digest lists tasks due or overdue next to
// unread Inbox items, on workdays only, from the no-reply sender. The database's side is suite zz41.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { ConfirmProvider } from "@/components/confirm";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import { ProjectAccessProvider } from "@/components/project/project-access";
import { ShellProvider } from "@/components/shell/shell-context";
import { ToastProvider } from "@/components/toast";
import { ADMIN_SECTIONS } from "@/lib/admin";
import { NO_REPLY_NOTE, type OutboxRow } from "@/lib/email-layout";
import { digestTaskWhen, renderDigestEmail, type DigestTask } from "@/lib/email-scheduled";
import { digestDaysNote, digestWeekday, digestWorkWeek } from "@/lib/email-schedules";
import type { ProjectRole } from "@/lib/roles";
import { DEFAULT_SIDEBAR_PREFS } from "@/lib/sidebar-prefs";

process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const member = { id: "me", email: "me@example.com", name: "Me", avatarUrl: null };

function render(node: ReactNode, role: ProjectRole | null) {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value="/projects/p1/dashboard">
        <SearchParamsContext.Provider value={new URLSearchParams() as never}>
          <ShellProvider member={member as never} isWorkspaceAdmin={false} workspace={{ name: "ALHC", logoUrl: null }} initialSidebar={DEFAULT_SIDEBAR_PREFS}>
            <ToastProvider>
              <ConfirmProvider>
                <ProjectAccessProvider role={role}>{node}</ProjectAccessProvider>
              </ConfirmProvider>
            </ToastProvider>
          </ShellProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

function row(payload: Record<string, unknown>): OutboxRow {
  return {
    id: "00000000-0000-4000-8000-0000000000e1",
    task_id: null,
    rule_id: null,
    to_email: "pia@example.net",
    template: "custom",
    subject: null,
    payload,
    status: "sending",
    attempts: 1,
    last_error: null,
    provider_message_id: null,
    send_after: "2026-11-01T00:00:00Z",
    sent_at: null,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    deleted_at: null,
    to_profile_id: "pia",
    comment_id: null,
    max_attempts: 5,
    delivery_status: null,
    delivery_event_at: null,
    delivery_detail: null,
  } as OutboxRow;
}

const TOKEN = "a".repeat(64);
const tasks: DigestTask[] = [
  { task_id: "t1", title: "Overdue report", due_on: "2026-10-29", overdue: true, project_name: "Brand", path: "/projects/p1?task=t1" },
  { task_id: "t2", title: "Due today", due_on: "2026-11-01", overdue: false, project_name: null, path: "/my-tasks?task=t2" },
];

// 75 ---------------------------------------------------------------------------------------------------

test("75: digests go out on workdays only — never Friday or Saturday by default", () => {
  assert.deepEqual(digestWorkWeek(null), [0, 1, 2, 3, 4], "Sunday–Thursday");
  assert.deepEqual(digestWorkWeek([4, 1, 1, 9]), [1, 4], "cleaned and sorted");
  assert.equal(digestWeekday(1, null), 1, "Monday stays");
  assert.equal(digestWeekday(5, null), 0, "a Friday weekly digest reads as Sunday");
  assert.equal(digestWeekday(6, null), 0, "Saturday too");
  assert.equal(digestWeekday(5, [1, 2, 3, 4, 5]), 5, "a Monday–Friday workspace keeps Friday");
  assert.equal(digestDaysNote(null), "Only sent on workdays — never on a Friday or Saturday.");
  assert.equal(digestDaysNote([0, 1, 2, 3, 4, 5, 6]), "Sent any day of the week.");
});

test("75: the digest lists tasks due or overdue, then unread Inbox items, from the no-reply sender", () => {
  const email = renderDigestEmail(
    row({ kind: "digest", frequency: "daily", total: 1, task_total: 2, today: "2026-11-01", time_zone: "UTC", unsubscribe_token: TOKEN }),
    [
      {
        item_id: "i1",
        kind: "assigned",
        data: {},
        created_at: "2026-11-01T09:00:00Z",
        parts: { actor_name: "Rhona", title: "Flyer", group_key: "p1", group_label: "Brand", path: "/my-tasks" },
      },
    ],
    null,
    tasks,
  );
  assert.equal(email.subject, "Your daily digest: 2 tasks due or overdue · 1 unread notification");
  assert.ok(email.text.includes("Your tasks due today and overdue"));
  assert.ok(email.text.includes("- Overdue report (Overdue · was due Oct 29 · Brand) — https://app.example.com/projects/p1?task=t1"));
  assert.ok(email.text.includes("- Due today (Due today) — https://app.example.com/my-tasks?task=t2"));
  assert.ok(email.text.includes("Unread in your Inbox"));
  assert.ok(email.text.includes("Rhona assigned you “Flyer”"));
  assert.ok(email.text.indexOf("Overdue report") < email.text.indexOf("Rhona assigned"), "tasks first");
  assert.ok(email.text.includes(NO_REPLY_NOTE) && email.html.includes(NO_REPLY_NOTE), "the do-not-reply footnote");
  assert.ok(email.text.includes("workdays only"));
  assert.ok(email.html.includes("https://app.example.com/email/off?t="), "the Turn off link stays");
  assert.ok(email.html.includes("Open My tasks"));
});

test("75: a tasks-only digest, and a weekly one", () => {
  const daily = renderDigestEmail(row({ kind: "digest", frequency: "daily", total: 0, task_total: 1, today: "2026-11-01" }), [], null, [tasks[1]]);
  assert.equal(daily.subject, "Your daily digest: 1 task due or overdue");
  assert.ok(!daily.text.includes("Unread in your Inbox"));
  const weekly = renderDigestEmail(row({ kind: "digest", frequency: "weekly", total: 0, task_total: 1, today: "2026-11-01" }), [], null, [
    { ...tasks[1], due_on: "2026-11-04" },
  ]);
  assert.equal(weekly.subject, "Your weekly digest: 1 task due this week");
  assert.ok(weekly.text.includes("Your tasks due this week"));
  assert.ok(weekly.text.includes("Due Nov 4"));
  assert.equal(digestTaskWhen({ due_on: "2026-11-01", overdue: false }, "2026-11-01"), "Due today");
  // An Inbox-only digest still reads as before.
  const inbox = renderDigestEmail(row({ kind: "digest", frequency: "daily", total: 1 }), [
    { item_id: "i1", kind: "comment", data: {}, created_at: "2026-11-01T09:00:00Z", parts: { actor_name: "Rhona", title: "Flyer" } },
  ]);
  assert.equal(inbox.subject, "Your daily digest: 1 unread notification");
  assert.ok(inbox.html.includes("Open Inbox"));
});

test("75: the digest setting is first in Settings → Notifications and the drain reads the tasks", () => {
  const panel = readFileSync("src/components/settings/settings-panel.tsx", "utf8");
  assert.ok(panel.indexOf("<EmailDigestSettings") < panel.indexOf("<NotificationMatrix"), "above the per-kind table");
  assert.match(panel, /workWeek=\{data\.me\.workWeek\}/);
  const digest = readFileSync("src/components/settings/email-digest-settings.tsx", "utf8");
  assert.match(digest, /Email digest/);
  assert.match(digest, /options=\{workdays\.map/, "the weekday picker lists workdays only");
  const email = readFileSync("src/lib/email.ts", "utf8");
  assert.match(email, /admin\.rpc\("digest_email_tasks"/);
});

// 73 ---------------------------------------------------------------------------------------------------

test("73: no email design editor anywhere; emails use the built-in look", () => {
  assert.ok(!ADMIN_SECTIONS.some((s) => (s.key as string) === "emails"), "no Emails section in the Admin console");
  assert.ok(!existsSync("src/components/email-designs/email-design-editor.tsx"));
  assert.ok(!existsSync("src/lib/email-design-actions.ts"));
  assert.match(readFileSync("src/app/(admin)/admin/emails/page.tsx", "utf8"), /redirect\("\/admin\/email"\)/);
  assert.match(readFileSync("src/app/(app)/projects/[projectId]/settings/emails/page.tsx", "utf8"), /redirect\(/);
  assert.ok(!readFileSync("src/components/project/customize-panel.tsx", "utf8").includes("settings/emails"));
  const email = readFileSync("src/lib/email.ts", "utf8");
  assert.match(email, /DESIGN_DEFAULTS\[kind\]/, "the drain applies the built-in design");
  assert.ok(!email.includes("designFromJson(kind, ctx.design)"), "never the stored one");
  assert.ok(!readFileSync("src/lib/review-actions.ts", "utf8").includes("resolve_email_design"));
});

// 74 ---------------------------------------------------------------------------------------------------

test("74: the Dashboard has no widget controls below Editor", () => {
  const widgets = [{ widget: { id: "w1", projectId: "p1", kind: "count" as const, title: "Open", filters: {}, sortOrder: 1024 }, buckets: [] }];
  const context = { sections: [], profiles: [], fields: [], tags: [] };
  const viewer = render(<DashboardView projectId="p1" widgets={widgets as never} context={context as never} />, "viewer");
  assert.ok(!viewer.includes("Add widget"), "no Add widget");
  assert.ok(!viewer.includes("Options for Open"), "no widget menu");
  const editor = render(<DashboardView projectId="p1" widgets={widgets as never} context={context as never} />, "editor");
  assert.ok(editor.includes("Add widget") && editor.includes("Options for Open"));
  const empty = render(<DashboardView projectId="p1" widgets={[]} context={context as never} />, "viewer");
  assert.ok(!empty.includes("Add starter widgets"));
});

test("74: management pages hide what the role can't use instead of disabling it", () => {
  const access = readFileSync("src/components/project/project-access.tsx", "utf8");
  assert.ok(!access.includes("export function RoleGate"), "no disabled-fieldset gate any more");
  for (const page of ["fields", "rules", "forms", "dashboard", "settings"]) {
    assert.ok(!readFileSync(`src/app/(app)/projects/[projectId]/${page}/page.tsx`, "utf8").includes("RoleGate"), page);
  }
  const form = readFileSync("src/components/forms/form-editor.tsx", "utf8");
  assert.match(form, /\{canEdit \? \(\s*<section aria-label="Edit the form"/, "the form editor's editing side is for Admins+ only");
  assert.ok(!form.includes("View only: project admins and owners edit forms."));
  const canvas = readFileSync("src/components/rules/rule-canvas.tsx", "utf8");
  assert.ok(!canvas.includes("View only: project admins and owners change automations."));
  assert.match(canvas, /\{revealed \|\| !canEdit \? null/, "no Test button below Admin");
  const settings = readFileSync("src/app/(app)/projects/[projectId]/settings/page.tsx", "utf8");
  assert.match(settings, /hasRole\(role, "editor"\) \? \(/);
  const chrome = readFileSync("src/components/workspace/settings-chrome.tsx", "utf8");
  assert.ok(!chrome.includes("<fieldset disabled"), "workspace settings cards show values, not disabled forms");
});
