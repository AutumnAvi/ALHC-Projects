// Nov 4 notes, batch 22 (M1): the screen loaders' JSON → the app's types (src/lib/screen-shapes.ts).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  archivedFirst,
  effectiveRoles,
  parseAppShell,
  parseMyTaskBundle,
  parseProjectFrame,
  parseViewerMember,
  type ProjectRow,
} from "@/lib/screen-shapes";

const project = (id: string, extra: Partial<ProjectRow> = {}): ProjectRow => ({
  id,
  name: `Project ${id}`,
  description: null,
  sort_order: 0,
  approval_completes_task: false,
  status: "on_track",
  status_note: null,
  status_updated_at: null,
  status_updated_by: null,
  archived_at: null,
  team_id: "team",
  visibility: "private",
  ...extra,
});

test("viewer_member: allowlisted, name, and picture; anything else reads as not allowlisted", () => {
  assert.deepEqual(parseViewerMember({ version: 1, allowlisted: true, profile: { full_name: "Ana", avatar_url: null } }), {
    allowlisted: true,
    fullName: "Ana",
    avatarUrl: null,
  });
  assert.deepEqual(parseViewerMember({ allowlisted: false, profile: null }), { allowlisted: false, fullName: null, avatarUrl: null });
  assert.deepEqual(parseViewerMember(null), { allowlisted: false, fullName: null, avatarUrl: null });
});

test("app_shell: projects, archived ones, roles capped by the archive, avatars, and tags", () => {
  const shell = parseAppShell({
    version: 1,
    workspace: {
      id: "w",
      name: "ALHC",
      default_team_id: "team",
      logo_path: "w/logo.png",
      email_sender_name: null,
      tags_enabled: false,
      goals_enabled: true,
      work_week: [1, 2, 3, 4, 5],
    },
    is_workspace_admin: true,
    unread_count: 7,
    projects: [
      project("a"),
      project("b", { archived_at: "2026-11-01T00:00:00+00:00" }),
      project("c", { archived_at: "2026-11-03T00:00:00+00:00" }),
    ],
    own_roles: [
      { project_id: "a", role: "owner" },
      { project_id: "b", role: "admin" },
      { project_id: "x", role: "not-a-role" },
    ],
    star_ids: ["a"],
    folders: [{ id: "f", name: "Mine", collapsed: true, sort_order: 2 }],
    folder_placements: [{ project_id: "a", folder_id: "f", sort_order: 1 }],
    preferences: {
      subtask_hide_completed: true,
      subtask_assigned_to_me: false,
      subtask_sort: "due_asc",
      open_personal_view: true,
      expanded_task_ids: ["t1"],
      my_tasks_checked: "hide",
      work_week: [],
    },
    profiles: [
      { id: "p1", email: "a@x", full_name: "Ana", avatar_url: "https://img/a.png" },
      { id: "p2", email: "b@x", full_name: null, avatar_url: null },
    ],
    tags: [{ id: "t", name: "Flag", color: "red", palette_color: "rose", archived_at: null, created_by: null }],
  });
  assert.deepEqual(shell.projects.map((p) => p.id), ["a"]);
  assert.deepEqual(shell.archivedProjects.map((p) => p.id), ["c", "b"], "newest archive first");
  assert.equal(shell.readableProjects.length, 3);
  assert.equal(shell.ownRoles.get("b"), "admin", "the person's own role");
  assert.equal(shell.myRoles.get("b"), "viewer", "an archived project counts as Viewer");
  assert.equal(shell.myRoles.get("a"), "owner");
  assert.equal(shell.ownRoles.has("x"), false, "unknown roles are left out");
  assert.deepEqual(shell.avatars, { p1: "https://img/a.png" });
  assert.equal(shell.tags[0].color, "rose", "palette color first");
  assert.deepEqual(shell.visibleTags, [], "tags off: none shown");
  assert.equal(shell.tagsEnabled, false);
  assert.equal(shell.goalsEnabled, true);
  assert.equal(shell.isWorkspaceAdmin, true);
  assert.equal(shell.unreadCount, 7);
  assert.deepEqual(shell.workWeek, [1, 2, 3, 4, 5]);
  assert.equal(shell.personalWorkWeek, null, "no own workdays");
  assert.equal(shell.myTasksChecked, "hide");
  assert.equal(shell.openPersonalView, true);
  assert.deepEqual(shell.expandedTaskIds, ["t1"]);
  assert.equal(shell.subtaskPrefs.hideCompleted, true);
  assert.deepEqual(shell.folders, {
    folders: [{ id: "f", name: "Mine", collapsed: true, sortOrder: 2 }],
    placements: [{ projectId: "a", folderId: "f", sortOrder: 1 }],
  });
  assert.equal(shell.workspace?.logoPath, "w/logo.png");
});

test("app_shell: an empty answer (not allowlisted) is an empty shell with the defaults", () => {
  const shell = parseAppShell({ version: 1, workspace: null, projects: [], profiles: [], tags: [], preferences: null });
  assert.equal(shell.workspace, null);
  assert.deepEqual(shell.projects, []);
  assert.equal(shell.tagsEnabled, false);
  assert.equal(shell.goalsEnabled, false);
  assert.deepEqual(shell.workWeek, [0, 1, 2, 3, 4], "Sunday–Thursday");
  assert.equal(shell.myTasksChecked, "sink");
  assert.deepEqual(shell.subtaskPrefs, { hideCompleted: false, assignedToMe: false, sort: "manual" });
});

test("archivedFirst / effectiveRoles match listArchivedProjects / listMyProjectRoles", () => {
  const rows = [project("a"), project("b", { archived_at: "2026-01-01" }), project("c", { archived_at: "2026-02-01" })];
  assert.deepEqual(archivedFirst(rows).map((p) => p.id), ["c", "b"]);
  const own = new Map([["a", "editor" as const], ["c", "owner" as const]]);
  assert.deepEqual([...effectiveRoles(own, rows)], [["a", "editor"], ["c", "viewer"]]);
});

test("project_frame: the rows map as the per-table reads map them", () => {
  const frame = parseProjectFrame({
    version: 1,
    project: { ...project("p"), sections_locked: true },
    role: "editor",
    access_status: null,
    views: [
      { id: "v1", project_id: "p", name: "List", layout: "list", config: {}, sort_order: 1, owner_id: null },
      { id: "v2", project_id: "p", name: "Mine", layout: "nope", config: {}, sort_order: 2, owner_id: "me" },
    ],
    view_settings: { default_view_id: "v1", hidden_tabs: ["files", "bogus"], hidden_view_ids: null },
    task_templates: [
      { id: "tt", project_id: "p", name: "T", title: "Do it", notes: null, subtasks: ["a"], field_values: [{}, {}], assignee_id: null, updated_at: "x" },
    ],
    fields: [],
    field_sharing: [
      { field_id: "f", library_field_id: null, is_source: true, is_shared: true, placement_count: 2, definition_editable: true, definition_manageable: false },
    ],
    forms: [],
    rules: [],
    members: [
      { profile_id: "u1", role: "owner", created_at: "t1", profile: { email: "a@x", full_name: " ", avatar_url: null } },
      { profile_id: "u2", role: "guest", created_at: "t2", profile: { email: "b@x", full_name: "Ben", avatar_url: null } },
    ],
    sections: [{ id: "s", project_id: "p", name: "Doing", sort_order: 1 }],
    status_templates: [],
    numbering: null,
    personal: { column_widths: { task: 400 }, collapsed_groups: ["section::x", 5], show_completed: true, view_configs: [{ view_id: "v1", config: { group_by: "none" } }] },
  });
  assert.equal(frame.project?.id, "p");
  assert.equal("sections_locked" in (frame.project ?? {}), false, "the project row keeps getProject's columns");
  assert.equal(frame.sectionsLocked, true);
  assert.equal(frame.role, "editor");
  assert.deepEqual(frame.views.map((v) => [v.id, v.layout, v.ownerId]), [["v1", "list", null], ["v2", "list", "me"]]);
  assert.deepEqual(frame.viewSettings, { defaultViewId: "v1", hiddenTabs: ["files"], hiddenViewIds: [] });
  assert.equal(frame.taskTemplates[0].fieldValueCount, 2);
  assert.equal(frame.fieldSharing.f.placementCount, 2);
  assert.deepEqual(frame.members.map((m) => [m.profileId, m.name]), [["u1", "a@x"]], "unknown roles left out; name falls back to email");
  assert.deepEqual(frame.columnWidths, { task: 400 });
  assert.deepEqual(frame.collapsedGroups, ["section::x"]);
  assert.equal(frame.showCompleted, true);
  assert.equal(frame.personalConfigs.get("v1")?.group_by, "none");
  assert.equal(frame.numbering, null);
});

test("project_frame: a project the person can't open has nothing but the access status", () => {
  const frame = parseProjectFrame({ version: 1, project: null, role: null, access_status: "can_request", personal: {} });
  assert.equal(frame.project, null);
  assert.equal(frame.role, null);
  assert.equal(frame.accessStatus, "can_request");
  assert.deepEqual(frame.views, []);
  assert.deepEqual(frame.members, []);
  assert.deepEqual(frame.viewSettings, { defaultViewId: null, hiddenTabs: [], hiddenViewIds: [] });
  assert.deepEqual(frame.columnWidths, {});
  assert.equal(frame.showCompleted, null);
});

test("my_task_bundle: blocker counts keep only open blockers; missing parts are empty", () => {
  const bundle = parseMyTaskBundle({
    version: 1,
    cards: { open: [], completed: [] },
    labels: {},
    access_tasks: [{ id: "t", root_task_id: null, home_project_id: "p", created_by: "me", assignee_id: "me" }],
    access_memberships: [{ task_id: "t", project_id: "p" }],
    blocker_counts: { t: 2, u: 0 },
    children: [],
    approval_states: {},
    awaiting: { requests: [{ id: "r", task_id: "t", round_id: null, created_at: "x" }] },
  });
  assert.deepEqual([...bundle.blockerCounts], [["t", 2]]);
  assert.equal(bundle.accessTasks.length, 1);
  assert.equal(bundle.awaiting.requests.length, 1);
  assert.deepEqual(bundle.awaiting.tasks, []);
  assert.deepEqual(parseMyTaskBundle(null).accessTasks, []);
});

test("the migration: invoker, stable, empty search_path, authenticated only, nothing removed", () => {
  const sql = fs.readFileSync(
    path.join(process.cwd(), "supabase/migrations/20261104030000_nov4_batch22_a.sql"),
    "utf8",
  );
  assert.equal(/^security definer$/im.test(sql), false, "no SECURITY DEFINER");
  assert.equal(/\b(drop|delete)\b/i.test(sql), false, "additive: no DROP / DELETE (no tail needed)");
  const functions = [...sql.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(functions, [
    "viewer_member",
    "app_shell",
    "project_frame",
    "project_view_page",
    "my_task_bundle",
    "my_tasks_screen",
    "home_screen",
    "task_pane_rows",
  ]);
  for (const name of functions) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon;`), `${name}: revoked`);
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to authenticated;`), `${name}: granted`);
  }
  assert.equal((sql.match(/security invoker/g) ?? []).length, functions.length);
  assert.equal((sql.match(/^stable$/gm) ?? []).length, functions.length);
  assert.equal((sql.match(/^set search_path = ''$/gm) ?? []).length, functions.length);
});
