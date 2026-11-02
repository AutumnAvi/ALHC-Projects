// Nov 2 notes, batch 15 (items 107–118): roles, the sidebar, blocked tasks, approvals, Timeline, tabs,
// and views. Pure rules and server-renderable pieces; the database side is suite zz46.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RolesHelp } from "@/components/help/roles-help";
import { unblockCompleted } from "@/components/project/use-project-tasks";
import { ViewChangedPill } from "@/components/project/view-toolbar";
import { projectRoleOptions } from "@/components/role-picker";
import {
  approverDecision,
  approverDecisionNote,
  approverFileStatus,
  approverReviewFiles,
  approverReviewHref,
  parseStoredReview,
} from "@/lib/approver-review";
import { forgetCompletion, noteCompletion, openBlockerCount, recentCompletion, resetCompletionsForTests, COMPLETION_TTL_MS } from "@/lib/completion-store";
import type { ProjectTask, TaskAttachment } from "@/lib/data";
import { NAMED_ROLES_NOTE, ROLE_TABLES, ROLES_HELP_HREF } from "@/lib/role-help";
import { assignableRoles } from "@/lib/roles";
import { draggedProjectIds, pruneStarOverrides, withStarOverrides } from "@/lib/sidebar-folders";
import { isLastShownView, NO_VIEW_SETTINGS, openingView, projectTabList, type ProjectView } from "@/lib/views";

// ---- 107 ----------------------------------------------------------------------------------------

test("107: Commenter isn't offered at all while it's off — no greyed option, no Turn on link", () => {
  const off = projectRoleOptions({ grantable: assignableRoles("owner", false), allowCommenter: false });
  assert.deepEqual(off.map((o) => o.value), ["owner", "editor", "viewer"]);
  assert.ok(off.every((o) => !o.disabled || o.value === "owner"));
  const picker = fs.readFileSync("src/components/role-picker.tsx", "utf8");
  assert.ok(!/Turn on Commenter|COMMENTER_OFF_REASON/.test(picker), "the picker has no Turn on footer");
  const members = fs.readFileSync("src/components/project/members-manager.tsx", "utf8");
  assert.ok(!/turn on in Admin console/.test(members), "nor the Members legend");
});

// ---- 108 ----------------------------------------------------------------------------------------

test("108: the form preview has no Edit buttons for people who can't edit the form", () => {
  const editor = fs.readFileSync("src/components/forms/form-editor.tsx", "utf8");
  assert.match(editor, /onSelect=\{\s*canEdit/, "selection only for people who edit");
  assert.match(editor, /\{onSelect \? \(\s*<button/, "and the Edit button only then");
});

// ---- 109 ----------------------------------------------------------------------------------------

test("109: the roles page explains every role, in a table per kind, and is linked from Share, Members, and the Admin console", () => {
  assert.deepEqual(ROLE_TABLES.map((t) => t.id), ["workspace-roles", "project-roles", "portfolio-roles", "team-roles"]);
  for (const table of ROLE_TABLES) {
    for (const row of table.rows) {
      assert.deepEqual(Object.keys(row.allowed).sort(), table.columns.map((c) => c.key).sort(), `${table.id}: ${row.label}`);
    }
  }
  const project = ROLE_TABLES.find((t) => t.id === "project-roles")!;
  const deleting = project.rows.find((r) => /Delete tasks/.test(r.label))!;
  assert.deepEqual(deleting.allowed, { owner: true, editor: true, commenter: false, viewer: false }, "note 119: only Editors and Owners delete");
  assert.ok(project.rows.find((r) => /Comment/.test(r.label))!.allowed.commenter);
  const html = renderToStaticMarkup(<RolesHelp allowCommenter />);
  assert.match(html, /Workspace roles/);
  assert.match(html, />Commenter</);
  assert.ok(html.includes(NAMED_ROLES_NOTE.slice(0, 40)), "named project roles are explained");
  assert.ok(!/>Commenter</.test(renderToStaticMarkup(<RolesHelp allowCommenter={false} />)), "no Commenter column while it's off");
  for (const file of ["src/components/project/share-dialog.tsx", "src/components/project/members-manager.tsx", "src/components/workspace/roles-explainer.tsx"]) {
    assert.match(fs.readFileSync(file, "utf8"), /ROLES_HELP_HREF/, file);
  }
  assert.equal(ROLES_HELP_HREF, "/help/roles");
  assert.ok(fs.existsSync("src/app/(app)/help/roles/page.tsx"));
});

// ---- 110 ----------------------------------------------------------------------------------------

test("110: saved stars stay until the props agree, then later changes win; a drag carries the selection", () => {
  assert.deepEqual(withStarOverrides(["a"], { b: true }), ["a", "b"]);
  assert.deepEqual(withStarOverrides(["a", "b"], { a: false }), ["b"]);
  const overrides = { b: true, c: false };
  assert.equal(pruneStarOverrides(["c"], overrides), overrides, "nothing caught up: the same object");
  assert.deepEqual(pruneStarOverrides(["b", "c"], overrides), { c: false }, "b caught up");
  assert.deepEqual(pruneStarOverrides([], overrides), { b: true }, "c caught up (unstarred)");
  assert.deepEqual(pruneStarOverrides(["b"], { b: true }), {});
  assert.deepEqual(draggedProjectIds("a", ["a", "b"]), ["a", "b"]);
  assert.deepEqual(draggedProjectIds("c", ["a", "b"]), ["c"], "an unselected row drags alone");
  const sidebar = fs.readFileSync("src/components/shell/sidebar-projects.tsx", "utf8");
  assert.match(sidebar, /projects\.filter\(\(p\) => !starredSet\.has\(p\.id\)\)/, "a starred project isn't listed under Projects too");
  const actions = fs.readFileSync("src/lib/actions.ts", "utf8");
  const starring = actions.slice(actions.indexOf("export async function setProjectsStarred"), actions.indexOf("// Oct 26 notes (batch 3): personal sidebar folders"));
  assert.match(starring, /revalidatePath\("\/", "layout"\)/, "the sidebar's layout is revalidated");
});

// ---- 111 ----------------------------------------------------------------------------------------

const card = (id: string, extra: Partial<ProjectTask> = {}) => ({ id, completedAt: null, blockedBy: 0, blockerIds: [], ...extra }) as unknown as ProjectTask;

test("111: completing a blocker here unblocks its tasks at once; a refusal takes it back; notes expire", () => {
  resetCompletionsForTests();
  const blocked = { blockedBy: 2, blockerIds: ["a"] };
  assert.equal(openBlockerCount(blocked), 2);
  noteCompletion("a", true);
  assert.equal(recentCompletion("a"), true);
  assert.equal(openBlockerCount(blocked), 1, "a hidden blocker still counts");
  forgetCompletion("a", true);
  assert.equal(openBlockerCount(blocked), 2);
  noteCompletion("a", true, 1000);
  assert.equal(recentCompletion("a", 1000 + COMPLETION_TTL_MS + 1), undefined, "a minute later the server's answer is back in charge");

  resetCompletionsForTests();
  const tasks = [card("a"), card("b", { blockedBy: 1, blockerIds: ["a"] })];
  assert.equal(unblockCompleted(tasks, 0), tasks, "nothing completed: same list");
  const done = [card("a", { completedAt: "2026-11-02T10:00:00Z" }), card("b", { blockedBy: 1, blockerIds: ["a"] })];
  assert.equal(unblockCompleted(done, 0)[1].blockedBy, 0, "completed in the list's overlay");
  noteCompletion("a", true);
  assert.equal(unblockCompleted(tasks, 1)[1].blockedBy, 0, "completed in the pane");
  resetCompletionsForTests();
});

// ---- 114 ----------------------------------------------------------------------------------------

const file = (id: string, fileName: string): TaskAttachment => ({ id, fileName, contentType: null, sizeBytes: 10, uploadedBy: "x", createdAt: "" });

test("114: the approver's review: every file reviewed before Submit, the decision derived, each file in the note", () => {
  const assets = approverReviewFiles({ attachmentIds: ["f1", "gone", "f2"] }, [file("f1", "a.png"), file("f2", "b.pdf")]);
  assert.deepEqual(assets.map((a) => a.name), ["a.png", "b.pdf"], "removed files drop out");
  assert.equal(approverDecision(assets, {}), null, "nothing reviewed: no answer");
  assert.equal(approverDecision(assets, { f1: { approved: true, note: "" } }), null, "one left");
  assert.equal(approverDecision(assets, { f1: { approved: true, note: "" }, f2: { approved: true, note: "" } }), "approved");
  const mixed = { f1: { approved: true, note: "" }, f2: { approved: false, note: "Logo too small" } };
  assert.equal(approverFileStatus("f2", mixed), "feedback");
  assert.equal(approverDecision(assets, mixed), "changes_requested");
  assert.equal(approverDecisionNote(assets, mixed, "Close!"), "✓ a.png: approved\n✗ b.pdf: Logo too small\n\nClose!");
  assert.ok(approverDecisionNote(assets, { f1: { approved: false, note: "x".repeat(3000) } }, "").length <= 2000, "fits decide_approval");
  assert.deepEqual(parseStoredReview("not json"), { files: {}, overall: "" });
  assert.deepEqual(parseStoredReview('{"files":{"f1":{"approved":true}},"overall":"hi"}'), { files: { f1: { approved: true, note: "" } }, overall: "hi" });
  assert.equal(approverReviewHref("t1"), "/approve/t1");
});

// ---- 116 ----------------------------------------------------------------------------------------

test("116: dependency lines can be selected and removed; the critical path is a show / hide switch", () => {
  const timeline = fs.readFileSync("src/components/project/timeline-view.tsx", "utf8");
  assert.match(timeline, /data-dependency-line/);
  assert.match(timeline, /e\.key === "Delete" \|\| e\.key === "Backspace"/);
  assert.match(timeline, /removeTaskDependency\(depId\)/);
  assert.match(timeline, /closest\("\[data-dependency-line\]"\)\) return;/, "lines stay clickable while drawing");
  assert.match(timeline, /role="switch"[\s\S]{0,80}aria-checked=\{showCritical\}/);
  assert.match(timeline, /Show critical path/);
});

// ---- 117 ----------------------------------------------------------------------------------------

const view = (id: string, layout: ProjectView["layout"], ownerId: string | null = null) =>
  ({ id, projectId: "p", name: id, layout, config: {}, sortOrder: 0, ownerId }) as unknown as ProjectView;

test("117: every tab can be hidden (one view stays shown), the project link skips hidden views", () => {
  const views = [view("list", "list"), view("board", "board"), view("mine", "list", "me")];
  const tabs = projectTabList(views, { ...NO_VIEW_SETTINGS, hiddenTabs: ["files"], hiddenViewIds: ["board"] });
  assert.deepEqual(tabs.map((t) => t.key), ["overview", "list", "board", "dashboard", "messages", "workload", "files"], "personal views aren't listed");
  assert.deepEqual(tabs.filter((t) => t.hidden).map((t) => t.key), ["board", "files"]);
  assert.equal(isLastShownView(views, ["board"], "list"), true, "list is the last one shown");
  assert.equal(isLastShownView(views, [], "list"), false);
  assert.equal(openingView(views, { defaultViewId: "board", hiddenTabs: [], hiddenViewIds: ["board"] }, false)?.id, "list", "a hidden default isn't opened");
});

// ---- 118 ----------------------------------------------------------------------------------------

test("118: a changed view shows an obvious pill with Save for me, Save as default (when allowed), and Reset", () => {
  const props = { pending: false, onSaveForMe: () => {}, onSaveForEveryone: () => {}, onReset: () => {} };
  const owner = renderToStaticMarkup(<ViewChangedPill {...props} ownView={false} canSaveForEveryone />);
  assert.match(owner, /You changed this view/);
  assert.match(owner, /Save for me/);
  assert.match(owner, /Save as default for everyone/);
  assert.match(owner, />Reset</);
  const editor = renderToStaticMarkup(<ViewChangedPill {...props} ownView={false} canSaveForEveryone={false} />);
  assert.ok(!/Save as default/.test(editor), "below Owner: hidden, not greyed out");
  const own = renderToStaticMarkup(<ViewChangedPill {...props} ownView canSaveForEveryone />);
  assert.match(own, /Save view/);
  assert.ok(!/Save as default/.test(own));
});
