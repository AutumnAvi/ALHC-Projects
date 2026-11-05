// Nov 4 notes, batch 28 (M4): optimistic edits every screen sees. A rename, completion, date, or assignee
// change made on one screen (the pane, a List row, the My tasks checklist) is written into the client data
// cache too, so every other screen showing the task — the List beside the pane, the pane beside the List,
// Home's Today — draws it at once instead of after the write's refresh.
//
// Rollback: an edit is tagged with its write (optimistic-session's token) and disappears the moment the
// write fails (or a bulk write skips that task). Otherwise it lasts until EDIT_GRACE_MS after the write
// ends — by then the write's refresh has given every screen the server's copy — and each screen stops
// applying it as soon as its own copy already shows it.

import type { QueryClient } from "@tanstack/query-core";
import type { MyTaskPatch } from "../live-patch";
import type { TaskDetail } from "../api/task-pane/model";
import { queryKeys } from "./keys";

export type TaskEdit =
  | { type: "title"; taskId: string; title: string }
  | { type: "complete"; taskId: string; completed: boolean }
  | { type: "due"; taskId: string; dueOn: string | null }
  | { type: "dates"; taskId: string; startOn: string | null; dueOn: string | null }
  | { type: "assign"; taskId: string; assigneeId: string | null };

export type TaggedEdit = { token: number; edit: TaskEdit; at: number };

export const EDIT_GRACE_MS = 4_000;
// An edit whose write never reported its end (nothing waits longer than this).
export const EDIT_TTL_MS = 60_000;
const MAX_EDITS = 300;

const EDIT_TYPES = new Set(["title", "complete", "due", "dates", "assign"]);

export function isTaskEdit(change: { type: string }): change is TaskEdit {
  return EDIT_TYPES.has(change.type);
}

export type EditStatus = {
  failed: (token: number) => boolean;
  dropped: (token: number, taskId: string) => boolean;
  endedAt: (token: number) => number | undefined;
};

const editKey = (edit: TaskEdit) => `${edit.taskId}:${edit.type}`;

// Without `now`, only failed / skipped writes count (time is the prune timer's job).
function expired(item: TaggedEdit, status: EditStatus, now?: number): boolean {
  if (status.failed(item.token) || status.dropped(item.token, item.edit.taskId)) return true;
  if (now === undefined) return false;
  const ended = item.token === 0 ? item.at : status.endedAt(item.token);
  if (ended !== undefined && now - ended > EDIT_GRACE_MS) return true;
  return now - item.at > EDIT_TTL_MS;
}

// The edits still in force, the latest per task and kind of edit, in the order they were made.
export function liveEdits(items: readonly TaggedEdit[], status: EditStatus, now?: number): TaggedEdit[] {
  const kept = items.filter((item) => !expired(item, status, now));
  const latest = new Map<string, number>();
  kept.forEach((item, index) => latest.set(editKey(item.edit), index));
  return kept.filter((item, index) => latest.get(editKey(item.edit)) === index);
}

export function readEdits(client: QueryClient): TaggedEdit[] {
  return client.getQueryData<TaggedEdit[]>(queryKeys.taskEdits()) ?? [];
}

export function addTaskEdits(client: QueryClient, token: number, edits: readonly TaskEdit[], now = Date.now()) {
  if (edits.length === 0) return;
  const next = [...readEdits(client), ...edits.map((edit) => ({ token, edit, at: now }))];
  client.setQueryData<TaggedEdit[]>(queryKeys.taskEdits(), next.slice(-MAX_EDITS));
}

// Drops what expired. Returns when the next one expires (null: nothing left).
export function pruneTaskEdits(client: QueryClient, status: EditStatus, now = Date.now()): number | null {
  const items = readEdits(client);
  if (items.length === 0) return null;
  const kept = items.filter((item) => !expired(item, status, now));
  if (kept.length !== items.length) client.setQueryData<TaggedEdit[]>(queryKeys.taskEdits(), kept);
  let next: number | null = null;
  for (const item of kept) {
    const ended = item.token === 0 ? item.at : status.endedAt(item.token);
    const at = Math.min(item.at + EDIT_TTL_MS, ended !== undefined ? ended + EDIT_GRACE_MS : Infinity);
    next = next === null ? at : Math.min(next, at);
  }
  return next;
}

// ---------------------------------------------------------------------------------------------------
// Applying them

function editsByTask(edits: readonly TaggedEdit[]) {
  const map = new Map<string, TaggedEdit[]>();
  for (const item of edits) {
    const list = map.get(item.edit.taskId);
    if (list) list.push(item);
    else map.set(item.edit.taskId, [item]);
  }
  return map;
}

// The pane's detail with the edits made elsewhere. Dates only touch a date-only task (a time would have
// to move with its date; the pane's own refetch brings that).
export function applyEditsToDetail(detail: TaskDetail, edits: readonly TaggedEdit[]): TaskDetail {
  let next = detail;
  for (const { edit, at } of edits) {
    if (edit.taskId !== detail.id) continue;
    switch (edit.type) {
      case "title":
        if (next.title !== edit.title) next = { ...next, title: edit.title };
        break;
      case "complete":
        if (Boolean(next.completedAt) !== edit.completed)
          next = { ...next, completedAt: edit.completed ? new Date(at).toISOString() : null };
        break;
      case "assign":
        if (next.assigneeId !== edit.assigneeId) next = { ...next, assigneeId: edit.assigneeId };
        break;
      case "due":
        if (!next.dueAt && next.dueOn !== edit.dueOn) next = { ...next, dueOn: edit.dueOn };
        break;
      case "dates":
        if (!next.dueAt && !next.startAt && (next.dueOn !== edit.dueOn || next.startOn !== edit.startOn))
          next = { ...next, dueOn: edit.dueOn, startOn: edit.startOn };
        break;
    }
  }
  return next;
}

// The same edits as My tasks patches (live-patch's shape): a task handed to someone else leaves the list.
export function editsAsMyTaskPatches(edits: readonly TaggedEdit[], memberId: string | null): Map<string, MyTaskPatch> {
  const patches = new Map<string, MyTaskPatch>();
  for (const [taskId, list] of editsByTask(edits)) {
    const patch: MyTaskPatch = {};
    for (const { edit, at } of list) {
      if (edit.type === "title") patch.title = edit.title;
      else if (edit.type === "complete") patch.completedAt = edit.completed ? new Date(at).toISOString() : null;
      else if (edit.type === "due") patch.dueOn = edit.dueOn;
      else if (edit.type === "dates") {
        patch.dueOn = edit.dueOn;
        patch.startOn = edit.startOn;
      } else if (edit.type === "assign" && memberId && edit.assigneeId !== memberId) patch.gone = true;
    }
    if (Object.keys(patch).length > 0) patches.set(taskId, patch);
  }
  return patches;
}
