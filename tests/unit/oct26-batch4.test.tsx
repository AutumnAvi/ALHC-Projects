// Oct 26 notes, batch 4 — the parts that live in the browser: which view a project opens on (default
// view, your own view first), task numbers (badge + search by number), List groups that stay collapsed,
// Timeline's number badges and Draw dependencies, Browse's Archived section, and the lint guard that
// keeps browser confirm() / alert() out of src.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { ConfirmProvider } from "@/components/confirm";
import { ListView, scopedKeys, withScopedKeys } from "@/components/project/list-view";
import { ProjectAccessProvider } from "@/components/project/project-access";
import { TimelineView } from "@/components/project/timeline-view";
import { BrowseProjectsTable, type BrowseRow } from "@/components/projects/browse-projects-table";
import { ShellProvider } from "@/components/shell/shell-context";
import { TaskNumberBadge } from "@/components/task/task-number";
import { ToastProvider } from "@/components/toast";
import type { ProjectTask, Section } from "@/lib/data";
import { bareTaskTitle, matchesRequestLabel } from "@/lib/request-numbers";
import type { ProjectRole } from "@/lib/roles";
import { DEFAULT_SIDEBAR_PREFS } from "@/lib/sidebar-prefs";
import { FIXED_TABS, isFixedTab, openingView, parseViewConfig, personalCopyName, splitViews, type ProjectView } from "@/lib/views";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const member = { id: "me", email: "me@example.com", name: "Me", avatarUrl: null };

function render(node: ReactNode, role: ProjectRole | null = "editor", search = "") {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value="/projects/p1/views/v1">
        <SearchParamsContext.Provider value={new URLSearchParams(search) as never}>
          <ShellProvider
            member={member as never}
            isWorkspaceAdmin={false}
            workspace={{ name: "ALHC", logoUrl: null }}
            initialSidebar={DEFAULT_SIDEBAR_PREFS}
          >
            <ConfirmProvider>
              <ToastProvider>
                <ProjectAccessProvider role={role}>{node}</ProjectAccessProvider>
              </ToastProvider>
            </ConfirmProvider>
          </ShellProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

const view = (id: string, ownerId: string | null, sortOrder: number): ProjectView => ({
  id,
  projectId: "p1",
  name: id,
  layout: "list",
  config: parseViewConfig({}),
  sortOrder,
  ownerId,
});

test("a project opens on its default view, or on your own view when you asked for that", () => {
  const views = [view("list", null, 1), view("board", null, 2), view("mine", "me", 3)];
  assert.deepEqual(
    splitViews(views).shared.map((v) => v.id),
    ["list", "board"],
  );
  assert.deepEqual(
    splitViews(views).mine.map((v) => v.id),
    ["mine"],
  );
  assert.equal(openingView(views, { defaultViewId: null, hiddenTabs: [] }, false)?.id, "list", "the first shared tab");
  assert.equal(openingView(views, { defaultViewId: "board", hiddenTabs: [] }, false)?.id, "board", "the owner's default");
  assert.equal(openingView(views, { defaultViewId: "board", hiddenTabs: [] }, true)?.id, "mine", "your own view first");
  assert.equal(
    openingView([view("list", null, 1)], { defaultViewId: "gone", hiddenTabs: [] }, true)?.id,
    "list",
    "without a view of your own (or with a removed default) the first shared tab",
  );
  assert.equal(openingView([], { defaultViewId: null, hiddenTabs: [] }, false), null);
  assert.equal(personalCopyName("Board"), "My Board");
  assert.equal(personalCopyName("x".repeat(120)).length, 100);
  assert.deepEqual(
    FIXED_TABS.map((t) => t.key),
    ["overview", "dashboard", "messages", "workload", "files"],
  );
  assert.ok(isFixedTab("files") && !isFixedTab("calendar"));
});

test("task numbers: a muted badge, and the dependency picker finds a task by its number", () => {
  const label = { text: "Task #12", wrap: true };
  assert.equal(matchesRequestLabel(label, "12"), true);
  assert.equal(matchesRequestLabel(label, "#12"), true);
  assert.equal(matchesRequestLabel(label, "task #12"), true);
  assert.equal(matchesRequestLabel(label, "[Task #12]"), true);
  assert.equal(matchesRequestLabel(label, "13"), false);
  assert.equal(matchesRequestLabel(label, "1"), false, "a number matches whole, not as a substring");
  assert.equal(matchesRequestLabel(label, "s"), false, "a word without a number never matches every task");
  assert.equal(matchesRequestLabel(label, "task"), false);
  assert.equal(matchesRequestLabel(label, "Bug #12"), false, "another label's words");
  assert.equal(matchesRequestLabel({ text: "Req #484.1", wrap: false }, "484"), true, "a subtask under 484");
  assert.equal(matchesRequestLabel(null, "12"), false, "no number, no match");
  assert.equal(bareTaskTitle("[Task #12] Logo", label), "Logo", "an old baked-in label comes off the name");

  const badge = renderToStaticMarkup(<TaskNumberBadge label={label} projectName="Website" />);
  assert.match(badge, /\[Task #12\]/);
  assert.match(badge, /Website/);
  assert.match(badge, /text-zinc-400/, "muted");
  assert.equal(renderToStaticMarkup(<TaskNumberBadge label={null} />), "", "nothing without a number");
});

const section: Section = { id: "s1", project_id: "p1", name: "To do", sort_order: 1024 };
const task = (id: string, title: string, extra: Partial<ProjectTask> = {}): ProjectTask => ({
  id,
  title,
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
  commentCount: 0,
  ...extra,
});
const listProps = {
  projectId: "p1",
  sections: [section],
  tasks: [task("t1", "Write the brief")],
  profiles: [],
  fields: [],
  config: parseViewConfig({}),
  tags: [],
  sectionTaskCounts: { s1: 1 },
};

test("List groups you collapsed stay collapsed when the List opens again", () => {
  const open = render(<ListView {...listProps} />);
  assert.match(open, /Write the brief/);
  assert.match(open, /aria-label="Collapse group"/);
  const collapsed = render(<ListView {...listProps} collapsedGroups={["section::section-s1"]} />);
  assert.ok(!collapsed.includes("Write the brief"), "the collapsed section's tasks aren't drawn");
  assert.match(collapsed, /aria-label="Expand group"/);
  // Kept per grouping: a key saved while grouped by assignee doesn't collapse the section.
  const other = render(<ListView {...listProps} collapsedGroups={["assignee::section-s1"]} />);
  assert.match(other, /Write the brief/);
  assert.deepEqual([...scopedKeys(new Set(["section::a", "assignee::b"]), "section::")], ["a"]);
  assert.deepEqual(
    [...withScopedKeys(new Set(["section::a", "assignee::b"]), "section::", new Set(["c"]))].sort(),
    ["assignee::b", "section::c"],
  );
});

test("Timeline: number badges on rows, and Draw dependencies for Editors only", () => {
  const props = {
    projectId: "p1",
    sections: [section],
    tasks: [
      task("t1", "Design", { startOn: "2026-10-26", dueOn: "2026-10-28", requestLabel: { text: "Task #7", wrap: false } }),
      task("t2", "Build", { dueOn: "2026-10-30" }),
    ],
    profiles: [],
    fields: [],
    config: parseViewConfig({}),
    windowed: true,
    today: "2026-10-26",
    anchor: "2026-10-26",
    zoom: "week" as const,
  };
  const editor = render(<TimelineView {...props} />, "editor");
  assert.match(editor, /Draw dependencies/);
  assert.match(editor, /<button[^>]*aria-pressed="false"[^>]*data-tooltip="Drag from one task to another/, "a toggle, off at first");
  assert.match(editor, /data-timeline-task="t1"/, "rows are drop targets");
  assert.match(editor, /Task #7<\/span>/, "the number is its own badge");
  assert.ok(!/>Task #7 Design</.test(editor), "not glued to the front of the name");
  const viewer = render(<TimelineView {...props} />, "viewer");
  assert.ok(!viewer.includes("Draw dependencies"), "Viewers can't draw dependencies");
});

test("Browse projects keeps archived projects in their own section", () => {
  const row = (projectId: string, name: string, archived: boolean): BrowseRow => ({
    projectId,
    name,
    description: null,
    teamId: "team",
    teamName: "Team",
    visibility: "private",
    status: "on_track",
    archived,
    memberCount: 1,
    myRole: "owner",
    ownerIds: ["me"],
    memberIds: ["me"],
    modifiedAt: null,
  });
  const html = render(
    <BrowseProjectsTable
      projects={[row("a", "Live project", false), row("b", "Old project", true)]}
      people={[{ id: "me", name: "Me" }]}
      teams={[{ id: "team", name: "Team" }]}
      meId="me"
      initialTeamId={null}
      peopleKnown
    />,
  );
  const archivedAt = html.indexOf('id="browse-archived-heading"');
  assert.ok(archivedAt > 0, "an Archived section");
  assert.ok(html.indexOf("Live project") < archivedAt, "active projects first");
  assert.ok(html.indexOf("Old project") > archivedAt, "archived ones under the Archived heading");
});

test("ESLint refuses browser confirm() / alert() / prompt() in src, and allows the in-app modal", async () => {
  const { ESLint } = await import("eslint");
  const eslint = new ESLint({ cwd: process.cwd() });
  const lint = async (code: string) => {
    const [result] = await eslint.lintText(code, { filePath: "src/components/zz-lint-probe.tsx" });
    return result.messages.filter((m) => m.ruleId === "no-alert" || m.ruleId === "no-restricted-properties");
  };
  assert.ok((await lint(`export function a() { if (window.confirm("Delete?")) return 1; }\n`)).length > 0, "window.confirm");
  assert.ok((await lint(`export function a() { alert("Hi"); }\n`)).length > 0, "alert");
  assert.ok((await lint(`export function a() { return window.prompt("Name?"); }\n`)).length > 0, "window.prompt");
  assert.equal(
    (
      await lint(
        `"use client";\nimport { useConfirm } from "@/components/confirm";\nexport function A() {\n  const confirm = useConfirm();\n  return <button onClick={async () => { if (await confirm({ title: "Delete?" })) console.log(1); }} />;\n}\n`,
      )
    ).length,
    0,
    "the in-app confirm is fine",
  );
});
