// Oct 27 notes, batch 6 (the app's side): dependency date shifting that works the same both ways with a
// per-project setting (44), Make a subtask of… / Convert to main task… (42), and each project's own
// number on the pane's project chips (39).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { DependencyShiftSettings } from "@/components/project/project-settings";
import { ShellProvider } from "@/components/shell/shell-context";
import { ToastProvider } from "@/components/toast";
import {
  ShiftDialog,
  primaryShiftPlan,
  shiftConfirmLabel,
  shiftDirection,
  shiftPromptText,
  shiftToastText,
} from "@/components/task/dependency-shift";
import {
  ConvertToMainTaskDialog,
  MAKE_SUBTASK_NOTE,
  MakeSubtaskDialog,
  canConvertSubtaskRow,
  convertMenuItem,
  describeParentCandidate,
  mainTaskNote,
  nextActiveIndex,
} from "@/components/task/task-convert";
import { TaskProjects } from "@/components/task/task-projects";
import type { TaskDetail } from "@/lib/data";
import { DEFAULT_SIDEBAR_PREFS } from "@/lib/sidebar-prefs";
import type { ShiftChange, ShiftPlanRow } from "@/lib/dependencies";
import type { ProjectRole } from "@/lib/roles";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const member = { id: "me", email: "me@example.com", name: "Me", avatarUrl: null };

function render(node: ReactNode) {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value="/projects/p1/list">
        <SearchParamsContext.Provider value={new URLSearchParams() as never}>
          <ShellProvider member={member as never} isWorkspaceAdmin={false} workspace={{ name: "ALHC", logoUrl: null }} initialSidebar={DEFAULT_SIDEBAR_PREFS}>
            <ToastProvider>{node}</ToastProvider>
          </ShellProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

// ---------------------------------------------------------------------------------------------
// 44. Dependency date shifting
// ---------------------------------------------------------------------------------------------

const row = (taskId: string, shiftDays: number, status: "move" | "skipped" = "move"): ShiftPlanRow => ({
  taskId,
  title: `Task ${taskId}`,
  startOn: "2026-11-02",
  dueOn: "2026-11-04",
  newStart: status === "move" ? (shiftDays > 0 ? "2026-11-05" : "2026-10-30") : null,
  newDue: status === "move" ? (shiftDays > 0 ? "2026-11-07" : "2026-11-01") : null,
  shiftDays,
  status,
  reason: status === "skipped" ? "Completed" : null,
});

test("moving later: the push plan is the prompt's, and it asks to move dependents later", () => {
  const push = [row("a", 3), row("b", 3), row("c", 3, "skipped")];
  assert.equal(shiftDirection(push, []), "later");
  const primary = primaryShiftPlan(push, []);
  assert.equal(primary.pull, false);
  assert.equal(primary.plan, push);
  const text = shiftPromptText("later", "“Logo”", { later: 2, earlier: 0 });
  assert.equal(text.title, "Move dependent tasks later too?");
  assert.match(text.description, /Moving “Logo” later would start 2 tasks that depend on it too early/);
  assert.equal(shiftConfirmLabel("later", 2), "Move 2 dependents too");
  assert.equal(shiftConfirmLabel("later", 1), "Move 1 dependent too");
});

test("moving earlier: pulling is the primary choice, not a hidden extra", () => {
  // Nothing would be pushed; the pull plan pulls two tasks earlier.
  const push: ShiftPlanRow[] = [];
  const pull = [row("a", -2), row("b", -2)];
  assert.equal(shiftDirection(push, pull), "earlier");
  const primary = primaryShiftPlan(push, pull);
  assert.equal(primary.pull, true);
  assert.equal(primary.plan, pull);
  const text = shiftPromptText("earlier", "“Logo”", { later: 0, earlier: 2 });
  assert.equal(text.title, "Pull dependent tasks earlier too?");
  assert.match(text.description, /Moving “Logo” earlier leaves a gap before 2 tasks that depend on it/);
  assert.equal(shiftConfirmLabel("earlier", 2), "Pull 2 dependents earlier");
});

test("both ways at once (a start earlier, a due date later): the pull plan holds both", () => {
  const push = [row("a", 3)];
  const pull = [row("a", 3), row("b", -1)];
  assert.equal(shiftDirection(push, pull), "both");
  assert.equal(primaryShiftPlan(push, pull).plan, pull);
  assert.equal(shiftDirection([], []), null, "nothing to move");
  assert.equal(shiftPromptText("both", "8 tasks", { later: 1, earlier: 1 }, true).title, "Move dependent tasks too?");
});

const change = (taskId: string, from: string, to: string): ShiftChange => ({
  task_id: taskId,
  title: `Task ${taskId}`,
  old_start_on: null,
  old_due_on: from,
  new_start_on: null,
  new_due_on: to,
});

test("the toast says what moved, which way, and what was left alone", () => {
  const later = shiftToastText({
    subject: "“Logo”",
    given: ["t"],
    changes: [change("t", "2026-11-02", "2026-11-05"), change("a", "2026-11-04", "2026-11-07"), change("b", "2026-11-06", "2026-11-09")],
    skipped: [],
  });
  assert.equal(later, "Moved “Logo” and 2 dependent tasks later");
  const earlier = shiftToastText({
    subject: "“Logo”",
    given: ["t"],
    changes: [change("t", "2026-11-05", "2026-11-02"), change("a", "2026-11-07", "2026-11-04")],
    skipped: [{ taskId: "c", title: "Task c", reason: "Completed" }],
  });
  assert.equal(earlier, "Moved “Logo” and 1 dependent task earlier; 1 dependent task was left as it was (Completed)");
  assert.equal(
    shiftToastText({ subject: "“Logo”", given: ["t"], changes: [change("t", "2026-11-02", "2026-11-05")], skipped: [] }),
    null,
    "a task that moved alone needs no toast",
  );
  assert.equal(
    shiftToastText({
      subject: "3 tasks",
      given: ["t", "u", "v"],
      changes: [change("t", "2026-11-02", "2026-11-05"), change("u", "2026-11-02", "2026-11-05")],
      skipped: [{ taskId: "v", title: "Task v", reason: "You can’t edit it" }],
    }),
    "Updated the dates of 2 of 3 tasks",
    "a bulk change always says how many took the date",
  );
});

test("the Ask me prompt lists what moves (with the direction), what won't, and links to the setting", () => {
  const prompt = {
    subject: "“Logo”",
    many: false,
    push: [],
    pull: [row("a", -2), row("c", 0, "skipped")],
    projectId: "p1",
    resolve() {},
  };
  const html = render(<ShiftDialog prompt={prompt} />);
  assert.match(html, /Pull dependent tasks earlier too\?/);
  assert.match(html, /Will move earlier \(1\)/);
  assert.match(html, /Task a/);
  assert.match(html, /−2 days/);
  assert.match(html, /Won’t move \(1\)/);
  assert.match(html, /Completed/);
  assert.match(html, /Only move this task/);
  assert.match(html, /Pull 1 dependent earlier/);
  assert.match(html, /href="\/projects\/p1\/settings#dependencies"/);
  assert.match(html, /Project settings → Dependencies/);
});

test("Settings → Dependencies: three choices, Ask me by default, read-only below Admin", () => {
  const admin = render(<DependencyShiftSettings projectId="p1" mode="ask" canEdit />);
  assert.match(admin, /id="dependencies"/);
  assert.match(admin, /When a task’s dates change/);
  for (const label of ["Auto-shift", "Ask me", "Off"]) assert.match(admin, new RegExp(`>${label}<`));
  assert.equal((admin.match(/type="radio"/g) ?? []).length, 3);
  assert.match(admin, /<input[^>]*checked=""[^>]*value="ask"/, "Ask me is chosen");
  assert.equal((admin.match(/checked=""/g) ?? []).length, 1, "only one");
  assert.ok(!/<fieldset[^>]*disabled/.test(admin), "Admins can change it");
  assert.ok(!/Only the project’s Admins and Owners/.test(admin));

  const editor = render(<DependencyShiftSettings projectId="p1" mode="auto" canEdit={false} />);
  assert.match(editor, /<fieldset[^>]*disabled=""/, "read-only below Admin");
  assert.match(editor, /<input[^>]*checked=""[^>]*value="auto"/);
  assert.match(editor, /Only the project’s Admins and Owners change this/);
});

test("every date change in the app goes through useDependencyShift, and the settings page loads the mode", () => {
  const subtasks = readFileSync("src/components/task/task-subtasks.tsx", "utf8");
  assert.match(subtasks, /shift\.changeDates\(subtask, dates/, "subtask dates too");
  const bar = readFileSync("src/components/bulk/bulk-bar.tsx", "utf8");
  assert.match(bar, /shift\.changeMany\(ids\.map\(\(taskId\) => \(\{ taskId, dueOn \}\)\), taskCount\(ids\.length\), null, \{/, "a bulk due date goes through changeTaskDates, not the bulk path");
  const page = readFileSync("src/app/(app)/projects/[projectId]/settings/page.tsx", "utf8");
  assert.match(page, /getDependencyShiftMode\(projectId\)/);
  assert.match(page, /canEdit=\{hasRole\(role, "admin"\)\}/);
  const shift = readFileSync("src/components/task/dependency-shift.tsx", "utf8");
  assert.match(shift, /changeTaskDates\(moves\)/);
  assert.ok(!/previewDependencyShift/.test(shift), "one server call, no separate previews");
});

// ---------------------------------------------------------------------------------------------
// 42. Convert
// ---------------------------------------------------------------------------------------------

const paneTask = (viewerRole: ProjectRole | null, extra: Partial<TaskDetail> = {}): TaskDetail =>
  ({
    id: "t1",
    title: "Write the brief",
    kind: "task",
    notes: null,
    completedAt: null,
    startOn: null,
    dueOn: null,
    dependencies: [],
    hiddenBlockers: 0,
    editableProjectIds: viewerRole === "editor" || viewerRole === "owner" ? ["p1"] : [],
    assigneeId: null,
    homeProjectId: "p1",
    requestLabel: { text: "Task #12", wrap: false },
    projectNumbers: { p1: { text: "Task #12", wrap: false }, p2: { text: "WEB-4", wrap: false } },
    approvals: [],
    subtasks: [],
    parentTaskId: null,
    ancestors: [],
    isSubtask: false,
    memberships: [
      { projectId: "p1", projectName: "Launch", sectionId: "s1", sections: [{ id: "s1", name: "To do" }] },
      { projectId: "p2", projectName: "Website", sectionId: null, sections: [] },
    ],
    viewerRole,
    memberRoles: {},
    isPrivate: false,
    ...extra,
  }) as unknown as TaskDetail;

test("the “…” menu: Make a subtask of… for a task, Convert to main task… for a subtask, nothing for Viewers", () => {
  assert.deepEqual(convertMenuItem(paneTask("editor")), { label: "Make a subtask of…", to: "subtask" });
  const subtask = paneTask("editor", { isSubtask: true, parentTaskId: "t0", ancestors: [{ id: "t0", title: "Root", completedAt: null }] });
  assert.deepEqual(convertMenuItem(subtask), { label: "Convert to main task…", to: "task" });
  assert.equal(convertMenuItem(paneTask("viewer")), null, "Viewers convert nothing");
  assert.equal(convertMenuItem(paneTask("commenter")), null, "nor Commenters");
  assert.equal(
    convertMenuItem({ ...subtask, editableProjectIds: [] } as TaskDetail),
    null,
    "a subtask needs a project of its tree the viewer edits",
  );
  const menu = readFileSync("src/components/task/task-more-menu.tsx", "utf8");
  assert.match(menu, /convertMenuItem\(task\)/);
});

test("a subtask row's “…” offers Convert to main task… to Editors, never for approval subtasks", () => {
  assert.equal(canConvertSubtaskRow(paneTask("editor"), false), true);
  assert.equal(canConvertSubtaskRow(paneTask("editor"), true), false, "approval subtasks stay");
  assert.equal(canConvertSubtaskRow(paneTask("viewer"), false), false);
  const rows = readFileSync("src/components/task/task-subtasks.tsx", "utf8");
  assert.match(rows, /canConvertSubtaskRow\(task, Boolean\(approval\)\)[\s\S]*Convert to main task…/);
});

test("Make a subtask of…: a searchable combobox and what happens, in plain words", () => {
  const html = render(<MakeSubtaskDialog taskId="t1" title="Write the brief" onClose={() => {}} />);
  assert.match(html, /Make a subtask of…/);
  assert.match(html, /role="combobox"/);
  assert.match(html, /role="listbox"/);
  assert.match(html, /Loading tasks…/);
  assert.ok(html.includes(MAKE_SUBTASK_NOTE));
  assert.match(html, /It leaves its projects and keeps its comments, files, followers, and number/);
  assert.match(html, /Make it a subtask<\/button>/);
  assert.match(html, /disabled=""[^>]*>Make it a subtask/, "nothing picked yet");

  assert.equal(
    describeParentCandidate({ id: "x", title: "Homepage", label: { text: "Task #7", wrap: false }, projectName: "Website", isSubtask: true, completed: false }),
    "Homepage, Task #7, in Website, a subtask",
  );
  assert.equal(nextActiveIndex("ArrowDown", 0, 3), 1);
  assert.equal(nextActiveIndex("ArrowDown", 2, 3), 2, "stays at the end");
  assert.equal(nextActiveIndex("ArrowUp", 0, 3), 0);
  assert.equal(nextActiveIndex("End", 0, 3), 2);
  assert.equal(nextActiveIndex("a", 0, 3), null);
  assert.equal(nextActiveIndex("ArrowDown", 0, 0), null);
});

test("Convert to main task…: a project of its tree you edit, a section, and its new number", () => {
  const task = paneTask("editor", { editableProjectIds: ["p1", "p2"] });
  const html = render(
    <ConvertToMainTaskDialog taskId="st1" title="Draft copy" memberships={task.memberships} editableProjectIds={task.editableProjectIds} onClose={() => {}} />,
  );
  assert.match(html, /Convert to main task/);
  assert.match(html, /“Draft copy” leaves its parent task/);
  assert.match(html, />Launch</, "the home project first");
  assert.match(html, /No section|To do/);
  assert.ok(html.includes(mainTaskNote("Launch")));
  assert.match(html, /It gets Launch’s next number and keeps its comments, files, followers, and subtasks/);

  const none = render(<ConvertToMainTaskDialog taskId="st1" title="Draft copy" memberships={task.memberships} editableProjectIds={[]} onClose={() => {}} />);
  assert.match(none, /You aren’t an Editor of a project of its top-level task/);
});

// ---------------------------------------------------------------------------------------------
// 39. Each project's number on its chip
// ---------------------------------------------------------------------------------------------

test("the pane's project chips show the task's number in each project", () => {
  const html = render(<TaskProjects task={paneTask("editor")} addableProjects={[]} canEdit />);
  assert.match(html, /Launch<\/span>[\s\S]*Task #12/);
  assert.match(html, /Website<\/span>[\s\S]*WEB-4/);
  assert.match(html, /aria-label="Website, WEB-4"/);
  const unnumbered = render(<TaskProjects task={paneTask("editor", { projectNumbers: {} })} addableProjects={[]} canEdit />);
  assert.ok(!/Task #12/.test(unnumbered), "no number, no badge");
  const subtask = render(
    <TaskProjects
      task={paneTask("viewer", { isSubtask: true, ancestors: [{ id: "t0", title: "Root", completedAt: null }], projectNumbers: { p1: { text: "Task #12.1", wrap: false } } })}
      addableProjects={[]}
      canEdit={false}
    />,
  );
  assert.match(subtask, /Task #12\.1/, "a subtask's chips too");
});

test("the List CSV labels tasks with that project's own numbers", () => {
  const exports = readFileSync("src/lib/exports.ts", "utf8");
  assert.match(exports, /requestLabelsInWith\(supabase, projectId, /);
});
