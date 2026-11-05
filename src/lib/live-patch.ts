// Nov 4 notes, batch 26 (M3): live updates through Realtime Broadcast. The database sends small messages
// on private topics (20261104050000_nov4_batch26_a.sql, alhc_live_route); this module reads them and turns
// them into in-place patches of what a screen already shows. Pure, so the rules are unit-tested.
//
// A message: { v: 1, table, op: "INSERT" | "UPDATE", at: ISO time (database clock), rows: [...] }. Each
// row has only the keys its topic may see, plus "_changed" (the sent keys that changed) on updates.
// Rows removed outright send nothing; a soft delete is an update with deleted_at set, and a trashed task
// is a tombstone ({ id, parent_task_id, root_task_id, deleted_at }).
//
// Anything a patch can't build from the message (a new task in a List, a new story) asks the caller to
// refetch: "refresh" (the page) or "refetch" (only the open task pane).

import type { InboxItem } from "@/lib/api/inbox/model";
import type { MyTask } from "@/lib/api/my-tasks/model";
import type { ProjectTask, SubtaskItem } from "@/lib/api/tasks/model";
import type { TaskComment, TaskDetail } from "@/lib/api/task-pane/model";
import { REACTIONS, type ReactionKey } from "@/lib/reactions";
import type { Json } from "@/lib/supabase/database.types";

// A change to a project's tasks as List / Board / Calendar / Timeline overlay it (the web app's
// components/project/use-project-tasks.ts): an optimistic edit, or one a live message carried.
export type TaskChange =
  | { type: "complete"; taskId: string; completed: boolean }
  | { type: "move"; taskId: string; sectionId: string | null; sortOrder: number }
  | { type: "assign"; taskId: string; assigneeId: string | null }
  | { type: "field"; taskId: string; fieldId: string; value: Json }
  | { type: "due"; taskId: string; dueOn: string | null }
  | { type: "dates"; taskId: string; startOn: string | null; dueOn: string | null }
  | { type: "tags"; taskId: string; tagIds: string[] }
  | { type: "title"; taskId: string; title: string }
  // Nov 4 notes, batch 26: a live update took the task out of this project (trashed, removed) — or put
  // it back, which cancels an earlier "gone" until the server's copy arrives.
  | { type: "presence"; taskId: string; present: boolean };

export const LIVE_TABLES = [
  "tasks",
  "task_projects",
  "comments",
  "comment_reactions",
  "task_stories",
  "rule_runs",
  "inbox_items",
  "email_outbox",
  "approval_requests",
  "review_checks",
  "project_messages",
  "project_message_reactions",
  "task_field_values",
  "task_attachments",
  "task_followers",
  "task_tags",
] as const;
export type LiveTable = (typeof LIVE_TABLES)[number];

export type LiveRow = Record<string, unknown>;
export type LiveMessage = { table: LiveTable; op: "INSERT" | "UPDATE"; at: number; rows: LiveRow[] };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TOPIC = new RegExp(`^alhc:(project|task|user):${UUID}$`);

export const projectTopic = (projectId: string) => `alhc:project:${projectId.toLowerCase()}`;
export const taskTopic = (taskId: string) => `alhc:task:${taskId.toLowerCase()}`;
export const userTopic = (profileId: string) => `alhc:user:${profileId.toLowerCase()}`;
export const isLiveTopic = (topic: string) => TOPIC.test(topic);

export function parseLiveMessage(payload: unknown): LiveMessage | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.v !== 1 || typeof p.table !== "string" || !(LIVE_TABLES as readonly string[]).includes(p.table)) return null;
  if (p.op !== "INSERT" && p.op !== "UPDATE") return null;
  if (!Array.isArray(p.rows)) return null;
  const rows = p.rows.filter((r): r is LiveRow => Boolean(r) && typeof r === "object" && !Array.isArray(r));
  const at = typeof p.at === "string" ? Date.parse(p.at) : NaN;
  return { table: p.table as LiveTable, op: p.op, at: Number.isFinite(at) ? at : Date.now(), rows };
}

// ---------------------------------------------------------------------------------------------------
// Row helpers

const str = (row: LiveRow, key: string): string | null => (typeof row[key] === "string" ? (row[key] as string) : null);
const has = (row: LiveRow, key: string) => Object.prototype.hasOwnProperty.call(row, key);
// An insert (no _changed) counts every key as changed.
export function rowChanged(row: LiveRow, key: string): boolean {
  const changed = row._changed;
  if (!Array.isArray(changed)) return has(row, key);
  return changed.includes(key);
}
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const isRemoved = (row: LiveRow) => str(row, "deleted_at") !== null;

// ---------------------------------------------------------------------------------------------------
// A project's List / Board / Calendar / Timeline (topic alhc:project:<id>). `tasks` = what the view shows
// now. Returns the changes to overlay (use-project-tasks: kept until the server's copy agrees) and whether
// the page needs its server render (a task it doesn't show yet, a type change, a subtask count).

export function projectLiveChanges(
  message: LiveMessage,
  projectId: string,
  tasks: readonly ProjectTask[],
): { changes: TaskChange[]; refresh: boolean } {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const changes: TaskChange[] = [];
  let refresh = false;

  for (const row of message.rows) {
    if (message.table === "tasks") {
      const id = str(row, "id");
      if (!id) continue;
      const parent = str(row, "parent_task_id");
      if (parent) {
        // A subtask: its parent's x/y count (and Show subtasks rows) come from the server.
        if (byId.has(parent) && ["title", "completed_at", "deleted_at", "assignee_id", "due_on", "start_on"].some((k) => rowChanged(row, k)))
          refresh = true;
        continue;
      }
      const task = byId.get(id);
      if (isRemoved(row)) {
        if (task) changes.push({ type: "presence", taskId: id, present: false });
        continue;
      }
      if (!task) {
        // New here, restored, or it may now match the view's filters.
        changes.push({ type: "presence", taskId: id, present: true });
        refresh = true;
        continue;
      }
      if (rowChanged(row, "kind") && has(row, "kind") && row.kind !== task.kind) refresh = true;
      if (has(row, "title") && typeof row.title === "string" && row.title !== task.title)
        changes.push({ type: "title", taskId: id, title: row.title });
      if (has(row, "completed_at") && Boolean(row.completed_at) !== Boolean(task.completedAt))
        changes.push({ type: "complete", taskId: id, completed: Boolean(row.completed_at) });
      const startOn = has(row, "start_on") ? str(row, "start_on") : task.startOn;
      const dueOn = has(row, "due_on") ? str(row, "due_on") : task.dueOn;
      if (startOn !== task.startOn || dueOn !== task.dueOn) changes.push({ type: "dates", taskId: id, startOn, dueOn });
      if (has(row, "assignee_id") && str(row, "assignee_id") !== task.assigneeId)
        changes.push({ type: "assign", taskId: id, assigneeId: str(row, "assignee_id") });
    } else if (message.table === "task_projects") {
      const id = str(row, "task_id");
      if (!id || str(row, "project_id") !== projectId) continue;
      const task = byId.get(id);
      if (isRemoved(row)) {
        if (task) changes.push({ type: "presence", taskId: id, present: false });
        continue;
      }
      if (!task) {
        changes.push({ type: "presence", taskId: id, present: true });
        refresh = true;
        continue;
      }
      const sectionId = has(row, "section_id") ? str(row, "section_id") : task.sectionId;
      const sortOrder = typeof row.sort_order === "number" ? row.sort_order : task.sortOrder;
      if (sectionId !== task.sectionId || sortOrder !== task.sortOrder)
        changes.push({ type: "move", taskId: id, sectionId, sortOrder });
    } else if (message.table === "task_field_values") {
      const id = str(row, "task_id");
      const fieldId = str(row, "field_id");
      const task = id ? byId.get(id) : undefined;
      if (!id || !fieldId || !task || !has(row, "value")) continue;
      const value = (row.value ?? null) as Json;
      if (!sameJson(task.fieldValues[fieldId], value)) changes.push({ type: "field", taskId: id, fieldId, value });
    } else if (message.table === "task_tags") {
      const id = str(row, "task_id");
      const tagId = str(row, "tag_id");
      const task = id ? byId.get(id) : undefined;
      if (!id || !tagId || !task) continue;
      // Several links of one task in one message build on each other.
      let current = task.tagIds;
      for (const c of changes) if (c.type === "tags" && c.taskId === id) current = c.tagIds;
      const next = isRemoved(row) ? current.filter((t) => t !== tagId) : current.includes(tagId) ? current : [...current, tagId];
      if (next.length !== current.length) changes.push({ type: "tags", taskId: id, tagIds: next });
    }
  }
  return { changes, refresh };
}

// ---------------------------------------------------------------------------------------------------
// The task pane (topic alhc:task:<id>): the task's own row, its subtasks, comments, reactions, followers,
// tags, and removed files are patched; anything else refetches just this task (GET /api/task-pane).

export type PanePatch = { detail: TaskDetail; changed: boolean; refetch: boolean; reviews: boolean };

const APP_LINK = /\/projects\/[0-9a-f-]{36}|[?&]task=[0-9a-f-]{36}/i;

function reactionsWith(comment: TaskComment, emoji: string, profileId: string, add: boolean): TaskComment {
  const current = new Map(comment.reactions.map((r) => [r.emoji as string, r.profileIds]));
  const ids = current.get(emoji) ?? [];
  const nextIds = add ? (ids.includes(profileId) ? ids : [...ids, profileId]) : ids.filter((p) => p !== profileId);
  if (nextIds.length === ids.length && nextIds.every((p, i) => p === ids[i])) return comment;
  current.set(emoji, nextIds);
  const reactions = REACTIONS.map(({ key }) => ({ emoji: key as ReactionKey, profileIds: current.get(key) ?? [] })).filter(
    (r) => r.profileIds.length > 0,
  );
  return { ...comment, reactions };
}

function patchComments(list: TaskComment[], id: string, patch: (c: TaskComment) => TaskComment): TaskComment[] {
  let changed = false;
  const next = list.map((c) => {
    if (c.id !== id) return c;
    const p = patch(c);
    if (p !== c) changed = true;
    return p;
  });
  return changed ? next : list;
}

function patchSubtask(sub: SubtaskItem, row: LiveRow): SubtaskItem {
  const next: SubtaskItem = {
    ...sub,
    title: has(row, "title") && typeof row.title === "string" ? row.title : sub.title,
    completedAt: has(row, "completed_at") ? str(row, "completed_at") : sub.completedAt,
    assigneeId: has(row, "assignee_id") ? str(row, "assignee_id") : sub.assigneeId,
    startOn: has(row, "start_on") ? str(row, "start_on") : sub.startOn,
    dueOn: has(row, "due_on") ? str(row, "due_on") : sub.dueOn,
    sortOrder: typeof row.subtask_order === "number" ? row.subtask_order : sub.sortOrder,
  };
  const same =
    next.title === sub.title &&
    next.completedAt === sub.completedAt &&
    next.assigneeId === sub.assigneeId &&
    next.startOn === sub.startOn &&
    next.dueOn === sub.dueOn &&
    next.sortOrder === sub.sortOrder;
  return same ? sub : next;
}

export function patchTaskDetail(detail: TaskDetail, message: LiveMessage): PanePatch {
  let d = detail;
  let refetch = false;
  let reviews = false;
  const set = (next: TaskDetail) => {
    d = next;
  };

  for (const row of message.rows) {
    switch (message.table) {
      case "tasks": {
        const id = str(row, "id");
        if (id === d.id) {
          if (isRemoved(row) || (rowChanged(row, "kind") && row.kind !== d.kind)) {
            refetch = true;
            break;
          }
          // A repeating task's next occurrence, and an approval's completion, come from the server.
          if (rowChanged(row, "completed_at") && (d.recurrence || d.kind === "approval")) refetch = true;
          const next: TaskDetail = {
            ...d,
            title: has(row, "title") && typeof row.title === "string" ? row.title : d.title,
            notes: has(row, "notes") ? str(row, "notes") : d.notes,
            completedAt: has(row, "completed_at") ? str(row, "completed_at") : d.completedAt,
            startOn: has(row, "start_on") ? str(row, "start_on") : d.startOn,
            dueOn: has(row, "due_on") ? str(row, "due_on") : d.dueOn,
            startAt: has(row, "start_at") ? str(row, "start_at") : d.startAt,
            dueAt: has(row, "due_at") ? str(row, "due_at") : d.dueAt,
            timeZone: has(row, "time_zone") ? str(row, "time_zone") : d.timeZone,
            assigneeId: has(row, "assignee_id") ? str(row, "assignee_id") : d.assigneeId,
          };
          const keys = ["title", "notes", "completedAt", "startOn", "dueOn", "startAt", "dueAt", "timeZone", "assigneeId"] as const;
          if (keys.some((k) => next[k] !== d[k])) set(next);
        } else if (id && str(row, "parent_task_id") === d.id) {
          const known = d.subtasks.find((s) => s.id === id);
          if (isRemoved(row)) {
            if (known) set({ ...d, subtasks: d.subtasks.filter((s) => s.id !== id) });
          } else if (!known || (rowChanged(row, "kind") && row.kind !== known.kind)) {
            refetch = true;
          } else {
            const patched = patchSubtask(known, row);
            if (patched !== known) {
              const subtasks = d.subtasks.map((s) => (s.id === id ? patched : s));
              subtasks.sort((a, b) => a.sortOrder - b.sortOrder);
              set({ ...d, subtasks });
            }
          }
        }
        break;
      }
      case "comments": {
        const id = str(row, "id");
        if (!id || str(row, "task_id") !== d.id) break;
        const known = d.comments.find((c) => c.id === id) ?? d.pinnedComments?.find((c) => c.id === id);
        if (!known) {
          if (isRemoved(row)) break;
          // Emailed comments, automation comments, review outcomes, and links to tasks / projects need
          // the server (cards, names, the names of what's linked).
          const body = str(row, "body") ?? "";
          if (row.email === true || str(row, "rule_id") || str(row, "review_check_id") || str(row, "pinned_at") || APP_LINK.test(body)) {
            refetch = true;
            break;
          }
          const comment: TaskComment = {
            id,
            authorId: str(row, "author_id"),
            ruleName: null,
            ruleId: null,
            body,
            createdAt: str(row, "created_at") ?? new Date(message.at).toISOString(),
            editedAt: str(row, "edited_at"),
            deleted: false,
            mentionIds: Array.isArray(row.mention_ids) ? row.mention_ids.filter((m): m is string => typeof m === "string") : [],
            reactions: [],
            email: null,
            reviewCheckId: null,
            pinnedAt: null,
            pinnedBy: null,
          };
          const comments = [...d.comments, comment].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          set({ ...d, comments, commentTotal: d.commentTotal + 1 });
          break;
        }
        if (rowChanged(row, "pinned_at") && str(row, "pinned_at") !== (known.pinnedAt ?? null)) refetch = true;
        const removed = isRemoved(row);
        const patch = (c: TaskComment): TaskComment => {
          const next: TaskComment = removed
            ? { ...c, deleted: true, body: "", editedAt: null, mentionIds: [], reactions: [] }
            : {
                ...c,
                body: typeof row.body === "string" ? row.body : c.body,
                editedAt: has(row, "edited_at") ? str(row, "edited_at") : c.editedAt,
                mentionIds: Array.isArray(row.mention_ids)
                  ? row.mention_ids.filter((m): m is string => typeof m === "string")
                  : c.mentionIds,
              };
          const same =
            next.deleted === c.deleted &&
            next.body === c.body &&
            next.editedAt === c.editedAt &&
            sameJson(next.mentionIds, c.mentionIds) &&
            next.reactions === c.reactions;
          return same ? c : next;
        };
        const comments = patchComments(d.comments, id, patch);
        const pinned = d.pinnedComments ? patchComments(d.pinnedComments, id, patch) : d.pinnedComments;
        if (comments !== d.comments || pinned !== d.pinnedComments) {
          const wasLive = !known.deleted;
          set({
            ...d,
            comments,
            pinnedComments: removed ? pinned?.filter((c) => c.id !== id) : pinned,
            commentTotal: removed && wasLive ? Math.max(0, d.commentTotal - 1) : d.commentTotal,
          });
        }
        break;
      }
      case "comment_reactions": {
        const commentId = str(row, "comment_id");
        const profileId = str(row, "profile_id");
        const emoji = str(row, "emoji");
        if (!commentId || !profileId || !emoji) break;
        const patch = (c: TaskComment) => (c.deleted ? c : reactionsWith(c, emoji, profileId, !isRemoved(row)));
        const comments = patchComments(d.comments, commentId, patch);
        const pinned = d.pinnedComments ? patchComments(d.pinnedComments, commentId, patch) : d.pinnedComments;
        if (comments !== d.comments || pinned !== d.pinnedComments) set({ ...d, comments, pinnedComments: pinned });
        break;
      }
      case "task_followers": {
        const profileId = str(row, "profile_id");
        if (!profileId || str(row, "task_id") !== d.id) break;
        const on = !isRemoved(row);
        if (on !== d.followerIds.includes(profileId))
          set({ ...d, followerIds: on ? [...d.followerIds, profileId] : d.followerIds.filter((p) => p !== profileId) });
        break;
      }
      case "task_tags": {
        const tagId = str(row, "tag_id");
        if (!tagId || str(row, "task_id") !== d.id) break;
        const on = !isRemoved(row);
        if (on !== d.tagIds.includes(tagId)) set({ ...d, tagIds: on ? [...d.tagIds, tagId] : d.tagIds.filter((t) => t !== tagId) });
        break;
      }
      case "task_attachments": {
        const id = str(row, "id");
        if (!id) break;
        if (isRemoved(row)) {
          if (d.attachments.some((a) => a.id === id)) set({ ...d, attachments: d.attachments.filter((a) => a.id !== id) });
        } else if (!d.attachments.some((a) => a.id === id)) {
          refetch = true;
        }
        break;
      }
      case "review_checks":
        reviews = true;
        refetch = true;
        break;
      case "task_stories":
      case "rule_runs":
      case "email_outbox":
      case "approval_requests":
      case "task_field_values":
        refetch = true;
        break;
      default:
        break;
    }
  }
  return { detail: d, changed: d !== detail, refetch, reviews };
}

// ---------------------------------------------------------------------------------------------------
// My tasks and Home's Today (topic alhc:user:<me>): tasks assigned to the person. A patch lasts until the
// server's copy agrees with it (or no longer has the task).

export type MyTaskPatch = {
  title?: string;
  completedAt?: string | null;
  dueOn?: string | null;
  startOn?: string | null;
  gone?: boolean;
};

export function myTaskLivePatches(
  message: LiveMessage,
  memberId: string,
  known: ReadonlySet<string>,
): { patches: [string, MyTaskPatch][]; refresh: boolean } {
  const patches: [string, MyTaskPatch][] = [];
  let refresh = false;
  if (message.table !== "tasks") return { patches, refresh };
  for (const row of message.rows) {
    const id = str(row, "id");
    if (!id) continue;
    if (isRemoved(row) || (has(row, "assignee_id") && str(row, "assignee_id") !== memberId)) {
      if (known.has(id)) patches.push([id, { gone: true }]);
      continue;
    }
    if (!known.has(id)) {
      refresh = true;
      continue;
    }
    const patch: MyTaskPatch = { gone: false };
    if (has(row, "title") && typeof row.title === "string") patch.title = row.title;
    if (has(row, "completed_at")) patch.completedAt = str(row, "completed_at");
    if (has(row, "due_on")) patch.dueOn = str(row, "due_on");
    if (has(row, "start_on")) patch.startOn = str(row, "start_on");
    patches.push([id, patch]);
  }
  return { patches, refresh };
}

function patchMyTask(task: MyTask, patch: MyTaskPatch): MyTask {
  return {
    ...task,
    title: patch.title ?? task.title,
    completedAt: patch.completedAt !== undefined ? patch.completedAt : task.completedAt,
    dueOn: patch.dueOn !== undefined ? patch.dueOn : task.dueOn,
    startOn: patch.startOn !== undefined ? patch.startOn : task.startOn,
  };
}

// The server copy already shows the patch (or no longer has the task): drop it.
export function myTaskPatchAbsorbed(task: MyTask | undefined, patch: MyTaskPatch): boolean {
  if (!task) return true;
  if (patch.gone) return false;
  return (
    (patch.title === undefined || patch.title === task.title) &&
    (patch.completedAt === undefined || Boolean(patch.completedAt) === Boolean(task.completedAt)) &&
    (patch.dueOn === undefined || patch.dueOn === task.dueOn) &&
    (patch.startOn === undefined || patch.startOn === (task.startOn ?? null))
  );
}

export function applyMyTaskPatches(
  open: readonly MyTask[],
  completed: readonly MyTask[],
  patches: ReadonlyMap<string, MyTaskPatch>,
): { open: MyTask[]; completed: MyTask[] } {
  if (patches.size === 0) return { open: open as MyTask[], completed: completed as MyTask[] };
  const nextOpen: MyTask[] = [];
  const nextDone: MyTask[] = [];
  const movedDone: MyTask[] = [];
  for (const task of open) {
    const patch = patches.get(task.id);
    if (patch?.gone) continue;
    const next = patch ? patchMyTask(task, patch) : task;
    if (next.completedAt) movedDone.push(next);
    else nextOpen.push(next);
  }
  for (const task of completed) {
    const patch = patches.get(task.id);
    if (patch?.gone) continue;
    const next = patch ? patchMyTask(task, patch) : task;
    if (next.completedAt) nextDone.push(next);
    else nextOpen.push(next);
  }
  return { open: nextOpen, completed: [...movedDone, ...nextDone] };
}

export function pruneMyTaskPatches(
  open: readonly MyTask[],
  completed: readonly MyTask[],
  patches: ReadonlyMap<string, MyTaskPatch>,
): Map<string, MyTaskPatch> {
  const byId = new Map([...open, ...completed].map((t) => [t.id, t]));
  const next = new Map<string, MyTaskPatch>();
  for (const [id, patch] of patches) if (!myTaskPatchAbsorbed(byId.get(id), patch)) next.set(id, patch);
  return next;
}

// ---------------------------------------------------------------------------------------------------
// The Inbox (topic alhc:user:<me>): read / archived / bookmarked changes are patched; a new item needs the
// server (its wording, actor, task).

export type InboxPatch = { readAt?: string | null; archivedAt?: string | null; bookmarkedAt?: string | null };

export function inboxLivePatches(
  message: LiveMessage,
  known: ReadonlySet<string>,
): { patches: [string, InboxPatch][]; refresh: boolean } {
  const patches: [string, InboxPatch][] = [];
  let refresh = false;
  if (message.table !== "inbox_items") return { patches, refresh };
  for (const row of message.rows) {
    const id = str(row, "id");
    if (!id) continue;
    if (!known.has(id)) {
      if (message.op === "INSERT") refresh = true;
      continue;
    }
    const patch: InboxPatch = {};
    if (has(row, "read_at")) patch.readAt = str(row, "read_at");
    if (has(row, "archived_at")) patch.archivedAt = str(row, "archived_at");
    if (has(row, "bookmarked_at")) patch.bookmarkedAt = str(row, "bookmarked_at");
    patches.push([id, patch]);
  }
  return { patches, refresh };
}

const inboxSame = (item: InboxItem, patch: InboxPatch) =>
  (patch.readAt === undefined || Boolean(patch.readAt) === Boolean(item.readAt)) &&
  (patch.archivedAt === undefined || Boolean(patch.archivedAt) === Boolean(item.archivedAt)) &&
  (patch.bookmarkedAt === undefined || Boolean(patch.bookmarkedAt) === Boolean(item.bookmarkedAt));

export function applyInboxPatches(items: readonly InboxItem[], patches: ReadonlyMap<string, InboxPatch>): InboxItem[] {
  if (patches.size === 0) return items as InboxItem[];
  return items.map((item) => {
    const patch = patches.get(item.id);
    if (!patch || inboxSame(item, patch)) return item;
    return {
      ...item,
      readAt: patch.readAt !== undefined ? patch.readAt : item.readAt,
      archivedAt: patch.archivedAt !== undefined ? patch.archivedAt : item.archivedAt,
      bookmarkedAt: patch.bookmarkedAt !== undefined ? patch.bookmarkedAt : item.bookmarkedAt,
    };
  });
}

export function pruneInboxPatches(items: readonly InboxItem[], patches: ReadonlyMap<string, InboxPatch>): Map<string, InboxPatch> {
  const byId = new Map(items.map((i) => [i.id, i]));
  const next = new Map<string, InboxPatch>();
  for (const [id, patch] of patches) {
    const item = byId.get(id);
    if (item && !inboxSame(item, patch)) next.set(id, patch);
  }
  return next;
}

// Merge patches for one id (later keys win).
export function mergePatches<P extends object>(current: ReadonlyMap<string, P>, incoming: [string, P][]): Map<string, P> {
  const next = new Map(current);
  for (const [id, patch] of incoming) next.set(id, { ...next.get(id), ...patch });
  return next;
}
