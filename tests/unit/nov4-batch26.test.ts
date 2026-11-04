// Nov 4 notes, batch 26 (M3): live updates through Realtime Broadcast. The patch reducers (pure) that turn
// the database's messages into in-place changes of a List, the task pane, My tasks, and the Inbox, plus
// static checks of the migration and the wiring.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { overlayProjectTasks } from "@/components/project/use-project-tasks";
import type { InboxItem } from "@/lib/api/inbox/model";
import type { MyTask } from "@/lib/api/my-tasks/model";
import type { ProjectTask } from "@/lib/api/tasks/model";
import type { TaskComment, TaskDetail } from "@/lib/api/task-pane/model";
import {
  LIVE_TABLES,
  applyInboxPatches,
  applyMyTaskPatches,
  inboxLivePatches,
  isLiveTopic,
  mergePatches,
  myTaskLivePatches,
  parseLiveMessage,
  patchTaskDetail,
  projectLiveChanges,
  projectTopic,
  pruneInboxPatches,
  pruneMyTaskPatches,
  rowChanged,
  taskTopic,
  userTopic,
  type LiveMessage,
  type LiveRow,
  type LiveTable,
} from "@/lib/live-patch";

const P = "00000000-0000-4000-8000-0000000000a1";
const T1 = "00000000-0000-4000-8000-000000000001";
const T2 = "00000000-0000-4000-8000-000000000002";
const S1 = "00000000-0000-4000-8000-000000000011";
const ME = "00000000-0000-4000-8000-0000000000e1";
const OTHER = "00000000-0000-4000-8000-0000000000e2";

const msg = (table: LiveTable, rows: LiveRow[], op: "INSERT" | "UPDATE" = "UPDATE"): LiveMessage => ({
  table,
  op,
  at: Date.parse("2026-11-04T12:00:00Z"),
  rows,
});

function task(id: string, extra: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id,
    title: "Flyer",
    completedAt: null,
    startOn: null,
    dueOn: "2026-11-10",
    assigneeId: null,
    homeProjectId: P,
    createdAt: "2026-11-01T00:00:00Z",
    sectionId: null,
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
  };
}

// ---- Messages and topics ------------------------------------------------------------------------

test("messages are read defensively; topics are ours only", () => {
  const m = parseLiveMessage({ v: 1, table: "tasks", op: "UPDATE", at: "2026-11-04T12:00:00.000000Z", rows: [{ id: T1 }, null, 3] });
  assert.ok(m);
  assert.equal(m.rows.length, 1);
  assert.equal(m.at, Date.parse("2026-11-04T12:00:00Z"));
  assert.equal(parseLiveMessage({ v: 2, table: "tasks", op: "UPDATE", rows: [] }), null);
  assert.equal(parseLiveMessage({ v: 1, table: "profiles", op: "UPDATE", rows: [] }), null, "unknown table");
  assert.equal(parseLiveMessage({ v: 1, table: "tasks", op: "TRUNCATE", rows: [] }), null);
  assert.equal(parseLiveMessage(null), null);

  assert.equal(projectTopic(P.toUpperCase()), `alhc:project:${P}`);
  assert.ok(isLiveTopic(taskTopic(T1)) && isLiveTopic(userTopic(ME)) && isLiveTopic(projectTopic(P)));
  assert.ok(!isLiveTopic("realtime:alhc:project:x") && !isLiveTopic(`alhc:team:${P}`) && !isLiveTopic("room1"));

  assert.ok(rowChanged({ title: "a" }, "title"), "an insert: every key counts");
  assert.ok(!rowChanged({ title: "a", _changed: ["due_on"] }, "title"));
  assert.ok(rowChanged({ title: "a", _changed: ["title"] }, "title"));
});

test("the client knows the same 16 tables the migration sends", () => {
  const sql = fs.readFileSync("supabase/migrations/20261104050000_nov4_batch26_a.sql", "utf8");
  const head = sql.split(/\n-- TAIL/)[0];
  const list = head.match(/foreach name in array array\[([\s\S]*?)\] loop/);
  assert.ok(list);
  const tables = [...list[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(tables, [...LIVE_TABLES].sort());
  assert.equal(LIVE_TABLES.length, 16);
});

// ---- Project views --------------------------------------------------------------------------------

test("a List patches renames, completions, dates, assignees in place", () => {
  const tasks = [task(T1)];
  const { changes, refresh } = projectLiveChanges(
    msg("tasks", [
      {
        id: T1,
        title: "Spring flyer",
        completed_at: "2026-11-04T12:00:00Z",
        due_on: "2026-11-12",
        start_on: null,
        assignee_id: OTHER,
        kind: "task",
        _changed: ["title", "completed_at", "due_on", "assignee_id"],
      },
    ]),
    P,
    tasks,
  );
  assert.equal(refresh, false, "nothing needs the server");
  assert.deepEqual(
    changes.map((c) => c.type),
    ["title", "complete", "dates", "assign"],
  );
  const shown = overlayProjectTasks(tasks, changes);
  assert.equal(shown[0].title, "Spring flyer");
  assert.ok(shown[0].completedAt);
  assert.equal(shown[0].dueOn, "2026-11-12");
  assert.equal(shown[0].assigneeId, OTHER);
  // Once the server's copy says the same, the overlay changes nothing.
  const server = [task(T1, { title: "Spring flyer", completedAt: "x", dueOn: "2026-11-12", assigneeId: OTHER })];
  assert.deepEqual(overlayProjectTasks(server, changes), server);
});

test("trashed or removed tasks leave the List; new or restored ones ask the server", () => {
  const tasks = [task(T1)];
  const trashed = projectLiveChanges(msg("tasks", [{ id: T1, deleted_at: "2026-11-04T12:00:00Z" }]), P, tasks);
  assert.deepEqual(trashed.changes, [{ type: "presence", taskId: T1, present: false }]);
  assert.equal(overlayProjectTasks(tasks, trashed.changes).length, 0);

  const removed = projectLiveChanges(
    msg("task_projects", [{ task_id: T1, project_id: P, section_id: null, sort_order: 1024, deleted_at: "2026-11-04T12:00:00Z" }]),
    P,
    tasks,
  );
  assert.deepEqual(removed.changes, [{ type: "presence", taskId: T1, present: false }]);

  const added = projectLiveChanges(msg("task_projects", [{ task_id: T2, project_id: P, section_id: null, sort_order: 1, deleted_at: null }], "INSERT"), P, tasks);
  assert.equal(added.refresh, true);

  // Restored after a live removal: "present" cancels the removal (same key, later), then is dropped.
  const restored = projectLiveChanges(msg("tasks", [{ id: T1, title: "Flyer", deleted_at: null, _changed: ["deleted_at"] }]), P, []);
  assert.equal(restored.refresh, true);
  assert.equal(overlayProjectTasks(tasks, [...trashed.changes, ...restored.changes]).length, 1);
});

test("section moves, field values, and tags are patched; other projects' rows are ignored", () => {
  const tasks = [task(T1, { tagIds: ["tag-a"] })];
  const moved = projectLiveChanges(msg("task_projects", [{ task_id: T1, project_id: P, section_id: S1, sort_order: 2048, deleted_at: null }]), P, tasks);
  assert.deepEqual(moved.changes, [{ type: "move", taskId: T1, sectionId: S1, sortOrder: 2048 }]);
  const elsewhere = projectLiveChanges(msg("task_projects", [{ task_id: T1, project_id: T2, section_id: S1, sort_order: 1, deleted_at: null }]), P, tasks);
  assert.deepEqual(elsewhere, { changes: [], refresh: false });

  const field = projectLiveChanges(msg("task_field_values", [{ task_id: T1, field_id: "f1", value: 42 }]), P, tasks);
  assert.deepEqual(field.changes, [{ type: "field", taskId: T1, fieldId: "f1", value: 42 }]);

  const tags = projectLiveChanges(
    msg("task_tags", [
      { id: "l1", task_id: T1, tag_id: "tag-b", deleted_at: null },
      { id: "l2", task_id: T1, tag_id: "tag-a", deleted_at: "2026-11-04T12:00:00Z" },
    ]),
    P,
    tasks,
  );
  assert.deepEqual(tags.changes.at(-1), { type: "tags", taskId: T1, tagIds: ["tag-b"] }, "links of one message build on each other");
});

test("a subtask change refreshes only a List showing its parent; a type change refreshes", () => {
  const tasks = [task(T1)];
  const sub = (parent: string) => msg("tasks", [{ id: T2, parent_task_id: parent, completed_at: "x", _changed: ["completed_at"] }]);
  assert.equal(projectLiveChanges(sub(T1), P, tasks).refresh, true);
  assert.equal(projectLiveChanges(sub(S1), P, tasks).refresh, false);
  const kind = projectLiveChanges(msg("tasks", [{ id: T1, kind: "milestone", title: "Flyer", _changed: ["kind"] }]), P, tasks);
  assert.equal(kind.refresh, true);
});

// ---- The task pane --------------------------------------------------------------------------------

function comment(id: string, extra: Partial<TaskComment> = {}): TaskComment {
  return {
    id,
    authorId: OTHER,
    ruleName: null,
    body: "Hi",
    createdAt: "2026-11-04T10:00:00Z",
    editedAt: null,
    deleted: false,
    mentionIds: [],
    reactions: [],
    email: null,
    ...extra,
  };
}

function detail(extra: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: T1,
    title: "Flyer",
    kind: "task",
    notes: null,
    completedAt: null,
    startOn: null,
    dueOn: null,
    startAt: null,
    dueAt: null,
    timeZone: null,
    recurrence: null,
    assigneeId: null,
    subtasks: [
      { id: T2, parentId: T1, title: "Copy", completedAt: null, assigneeId: null, startOn: null, dueOn: null, kind: "task", sortOrder: 1024, subtaskCount: 0, subtaskDoneCount: 0 },
    ],
    comments: [comment("c1")],
    pinnedComments: [],
    commentTotal: 1,
    followerIds: [ME],
    tagIds: [],
    attachments: [{ id: "a1", fileName: "x.png", contentType: "image/png", sizeBytes: 1, uploadedBy: ME, createdAt: "2026-11-01T00:00:00Z" }],
    ...extra,
  } as unknown as TaskDetail;
}

test("the pane patches its own row and its subtasks", () => {
  const d = detail();
  const own = patchTaskDetail(d, msg("tasks", [{ id: T1, title: "Spring flyer", notes: "Two sides", due_on: "2026-11-20", _changed: ["title", "notes", "due_on"] }]));
  assert.ok(own.changed && !own.refetch);
  assert.equal(own.detail.title, "Spring flyer");
  assert.equal(own.detail.notes, "Two sides");
  assert.equal(own.detail.dueOn, "2026-11-20");
  assert.equal(d.title, "Flyer", "the cached copy isn't mutated");

  const sub = patchTaskDetail(d, msg("tasks", [{ id: T2, parent_task_id: T1, completed_at: "2026-11-04T12:00:00Z", _changed: ["completed_at"] }]));
  assert.equal(sub.detail.subtasks[0].completedAt, "2026-11-04T12:00:00Z");
  assert.ok(!sub.refetch);
  const gone = patchTaskDetail(d, msg("tasks", [{ id: T2, parent_task_id: T1, deleted_at: "2026-11-04T12:00:00Z" }]));
  assert.equal(gone.detail.subtasks.length, 0);
  const added = patchTaskDetail(d, msg("tasks", [{ id: S1, parent_task_id: T1, title: "New" }], "INSERT"));
  assert.ok(added.refetch && !added.changed, "a new subtask comes from the server (counts, numbers)");

  const trashed = patchTaskDetail(d, msg("tasks", [{ id: T1, deleted_at: "2026-11-04T12:00:00Z" }]));
  assert.ok(trashed.refetch, "the pane shows the Trash state from the server");
  const repeating = patchTaskDetail(detail({ recurrence: { freq: "weekly" } as never }), msg("tasks", [{ id: T1, completed_at: "x", _changed: ["completed_at"] }]));
  assert.ok(repeating.refetch, "a repeat's next occurrence comes from the server");
});

test("comments are added, edited, and removed in place; special ones refetch", () => {
  const d = detail();
  const added = patchTaskDetail(
    d,
    msg("comments", [{ id: "c2", task_id: T1, author_id: OTHER, body: "Looks good @Me", created_at: "2026-11-04T11:00:00Z", mention_ids: [ME], email: false }], "INSERT"),
  );
  assert.ok(added.changed && !added.refetch);
  assert.deepEqual(added.detail.comments.map((c) => c.id), ["c1", "c2"]);
  assert.deepEqual(added.detail.comments[1].mentionIds, [ME]);
  assert.equal(added.detail.commentTotal, 2);

  for (const extra of [{ email: true }, { rule_id: "r1" }, { review_check_id: "rc" }, { body: `see /projects/${P}?task=${T2}` }]) {
    const p = patchTaskDetail(d, msg("comments", [{ id: "c3", task_id: T1, author_id: OTHER, body: "x", created_at: "2026-11-04T11:00:00Z", ...extra }], "INSERT"));
    assert.ok(p.refetch && !p.changed, `refetch for ${JSON.stringify(extra)}`);
  }

  const edited = patchTaskDetail(d, msg("comments", [{ id: "c1", task_id: T1, body: "Hi there", edited_at: "2026-11-04T11:00:00Z", mention_ids: [], _changed: ["body", "edited_at"] }]));
  assert.equal(edited.detail.comments[0].body, "Hi there");
  assert.equal(edited.detail.comments[0].editedAt, "2026-11-04T11:00:00Z");

  const removed = patchTaskDetail(d, msg("comments", [{ id: "c1", task_id: T1, body: "", deleted_at: "2026-11-04T11:00:00Z" }]));
  assert.ok(removed.detail.comments[0].deleted);
  assert.equal(removed.detail.comments[0].body, "");
  assert.equal(removed.detail.commentTotal, 0);

  const otherTask = patchTaskDetail(d, msg("comments", [{ id: "c9", task_id: T2, body: "x" }], "INSERT"));
  assert.ok(!otherTask.changed && !otherTask.refetch);
});

test("reactions, followers, tags, and removed files are patched", () => {
  const d = detail();
  const liked = patchTaskDetail(d, msg("comment_reactions", [{ id: "r1", comment_id: "c1", profile_id: ME, emoji: "heart", deleted_at: null }], "INSERT"));
  assert.deepEqual(liked.detail.comments[0].reactions, [{ emoji: "heart", profileIds: [ME] }]);
  const both = patchTaskDetail(liked.detail, msg("comment_reactions", [{ id: "r2", comment_id: "c1", profile_id: OTHER, emoji: "thumbs_up", deleted_at: null }], "INSERT"));
  assert.deepEqual(both.detail.comments[0].reactions.map((r) => r.emoji), ["thumbs_up", "heart"], "in the fixed order");
  const unliked = patchTaskDetail(both.detail, msg("comment_reactions", [{ id: "r1", comment_id: "c1", profile_id: ME, emoji: "heart", deleted_at: "x" }]));
  assert.deepEqual(unliked.detail.comments[0].reactions, [{ emoji: "thumbs_up", profileIds: [OTHER] }]);

  const follow = patchTaskDetail(d, msg("task_followers", [{ task_id: T1, profile_id: OTHER, deleted_at: null }], "INSERT"));
  assert.deepEqual(follow.detail.followerIds, [ME, OTHER]);
  const unfollow = patchTaskDetail(d, msg("task_followers", [{ task_id: T1, profile_id: ME, deleted_at: "x" }]));
  assert.deepEqual(unfollow.detail.followerIds, []);

  const tagged = patchTaskDetail(d, msg("task_tags", [{ id: "l1", task_id: T1, tag_id: "tag-a", deleted_at: null }], "INSERT"));
  assert.deepEqual(tagged.detail.tagIds, ["tag-a"]);

  const fileGone = patchTaskDetail(d, msg("task_attachments", [{ id: "a1", deleted_at: "x" }]));
  assert.equal(fileGone.detail.attachments.length, 0);
  assert.ok(patchTaskDetail(d, msg("task_attachments", [{ id: "a2", deleted_at: null }], "INSERT")).refetch);
});

test("activity, runs, approvals, emails, and field values refetch the pane; reviews reload the tab", () => {
  const d = detail();
  for (const table of ["task_stories", "rule_runs", "approval_requests", "email_outbox", "task_field_values"] as const) {
    const p = patchTaskDetail(d, msg(table, [{ id: "x", task_id: T1 }], "INSERT"));
    assert.ok(p.refetch && !p.changed && !p.reviews, table);
  }
  const review = patchTaskDetail(d, msg("review_checks", [{ id: "rc", status: "approved" }]));
  assert.ok(review.refetch && review.reviews);
});

// ---- My tasks -------------------------------------------------------------------------------------

function myTask(id: string, extra: Partial<MyTask> = {}): MyTask {
  return { id, title: "Flyer", completedAt: null, dueOn: null, projectId: P, projectName: "Web", kind: "task", parentTitle: null, canEdit: true, ...extra };
}

test("My tasks: patches move completions, drop reassigned work, and ask for new assignments", () => {
  const open = [myTask(T1), myTask(T2)];
  const completed: MyTask[] = [];
  const known = new Set([T1, T2]);
  const done = myTaskLivePatches(msg("tasks", [{ id: T1, assignee_id: ME, completed_at: "2026-11-04T12:00:00Z", title: "Flyer", due_on: null, start_on: null }]), ME, known);
  const handed = myTaskLivePatches(msg("tasks", [{ id: T2, assignee_id: OTHER, _changed: ["assignee_id"] }]), ME, known);
  let patches = mergePatches(new Map(), [...done.patches, ...handed.patches]);
  const shown = applyMyTaskPatches(open, completed, patches);
  assert.deepEqual(shown.open.map((t) => t.id), []);
  assert.deepEqual(shown.completed.map((t) => t.id), [T1]);

  const fresh = myTaskLivePatches(msg("tasks", [{ id: S1, assignee_id: ME, title: "New" }]), ME, known);
  assert.ok(fresh.refresh && fresh.patches.length === 0);

  // Handed back to me later: the newer patch isn't "gone" any more.
  patches = mergePatches(patches, myTaskLivePatches(msg("tasks", [{ id: T2, assignee_id: ME, title: "Flyer" }]), ME, known).patches);
  assert.deepEqual(applyMyTaskPatches(open, completed, patches).open.map((t) => t.id), [T2]);

  // The server catches up: absorbed patches go.
  const server = { open: [myTask(T2)], completed: [myTask(T1, { completedAt: "y" })] };
  assert.equal(pruneMyTaskPatches(server.open, server.completed, patches).size, 0);
  // No patches: the same arrays (no extra renders).
  const same = applyMyTaskPatches(open, completed, new Map());
  assert.equal(same.open, open);
});

// ---- The Inbox ------------------------------------------------------------------------------------

test("Inbox: read / archived / bookmarked change in place; a new item asks the server", () => {
  const items = [{ id: "i1", readAt: null, archivedAt: null, bookmarkedAt: null } as unknown as InboxItem];
  const read = inboxLivePatches(msg("inbox_items", [{ id: "i1", read_at: "2026-11-04T12:00:00Z", archived_at: null, bookmarked_at: null }]), new Set(["i1"]));
  const patches = mergePatches(new Map(), read.patches);
  const shown = applyInboxPatches(items, patches);
  assert.equal(shown[0].readAt, "2026-11-04T12:00:00Z");
  assert.equal(pruneInboxPatches([{ ...items[0], readAt: "z" }], patches).size, 0);
  assert.equal(pruneInboxPatches(items, patches).size, 1);
  const added = inboxLivePatches(msg("inbox_items", [{ id: "i2", read_at: null }], "INSERT"), new Set(["i1"]));
  assert.ok(added.refresh);
  assert.ok(!inboxLivePatches(msg("rule_runs", [{ id: "x" }], "INSERT"), new Set()).refresh, "other tables are ignored");
});

// ---- The migration and the wiring -----------------------------------------------------------------

test("the migration: additive above the tail, the tail only retires the publication, policies only about alhc topics", () => {
  const sql = fs.readFileSync("supabase/migrations/20261104050000_nov4_batch26_a.sql", "utf8");
  const [head, tail] = sql.split(/\n-- TAIL/);
  assert.equal(sql.match(/^-- TAIL/gm)?.length, 1, "one line starts the tail (the migration-applier stops there)");
  assert.ok(tail, "has a tail");
  assert.doesNotMatch(head, /\b(drop|delete)\b/i);
  assert.match(tail, /alter publication supabase_realtime drop table public\.%I/);
  assert.doesNotMatch(tail, /\bdelete\b/i);
  assert.match(head, /for each statement execute function public\.alhc_live_capture\(\)/);
  assert.match(head, /as restrictive for select to authenticated/);
  assert.match(head, /as restrictive for insert to anon, authenticated/);
  for (const secret of ["to_email", "token_hash", "recipient_email", "email_address", "storage_path"]) {
    assert.ok(!new RegExp(`'${secret}'`).test(head), `${secret} is never sent`);
  }
});

test("no Postgres Changes subscription is left; every live screen uses a private topic", () => {
  const files = [
    "src/components/project/project-live.tsx",
    "src/components/task/task-pane-host.tsx",
    "src/components/my-tasks/use-live-my-tasks.ts",
    "src/components/inbox/use-live-inbox.ts",
    "src/components/shell/unread-count.tsx",
    "src/components/rules/rule-feedback.tsx",
    "src/components/messages/messages.tsx",
    "src/components/task/task-live-refresh.tsx",
  ];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(text, /postgres_changes|openRealtimeChannel|useRealtimeRefresh/, file);
    assert.match(text, /(projectTopic|taskTopic|userTopic)\(/, file);
  }
  const live = fs.readFileSync("src/lib/live.ts", "utf8");
  assert.match(live, /config: \{ private: true \}/);
  assert.match(live, /"broadcast", \{ event: "\*" \}/);
  assert.ok(!fs.existsSync("src/lib/realtime.ts"));
  for (const file of ["src/components/my-tasks/my-tasks-checklist.tsx", "src/components/my-tasks/my-tasks-view.tsx", "src/components/home/today-card.tsx"]) {
    assert.match(fs.readFileSync(file, "utf8"), /useLiveMyTasks\(serverOpen, serverCompleted(, loadedAt)?\)/, file);
  }
});
