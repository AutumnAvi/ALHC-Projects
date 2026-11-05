// Big move 1: the tasks area's types and pure mappers (no database access; safe to import anywhere,
// the browser included).
import { maybe, type QueryResult } from "../core/db";
import type { DependencyKind } from "../../dependencies";
import { bestRole, permissionsFor } from "../../permissions";
import { type RequestLabel, requestLabelFrom } from "../../request-numbers";
import type { ProjectRole } from "../../roles";
import type { AccessTaskRow } from "../../screen-shapes";
import type { Json } from "../../supabase/database.types";
import { type ApprovalTaskStatus, parseApprovalTaskStatus, parseTaskKind, type TaskKind } from "../../task-kinds";

export type ProjectTask = {
  id: string;
  title: string;
  completedAt: string | null;
  startOn: string | null;
  dueOn: string | null;
  assigneeId: string | null;
  homeProjectId: string;
  createdAt: string;
  sectionId: string | null;
  sortOrder: number;
  subtaskCount: number;
  subtaskDoneCount: number;
  projectCount: number;
  fieldValues: Record<string, Json>;
  recurring: boolean;
  // Links that hold up completing the task (open predecessors the viewer can read; since Oct 27 notes,
  // batch 6, every kind the completion check counts, not only finish-to-start).
  blockedBy: number;
  // Nov 2 notes (batch 15, 111): which visible tasks those are, so completing one here unblocks this
  // row at once (completion-store.ts). Absent on a database without the batch 15 update.
  blockerIds?: string[];
  kind: TaskKind;
  // Approval tasks: the latest round's status (Not sent before the first); null for other kinds.
  approvalStatus: ApprovalTaskStatus | null;
  // Changes requested / rejected and not marked received yet (Oct 27 notes, batch 6).
  approvalPaused?: boolean;
  // A pending round waits on the viewer's decision.
  approvalWaitingOnMe?: boolean;
  // The viewer is one of its approvers (Oct 29 notes, batch 7: only approvers complete an approval task;
  // everyone else's complete control is "Ready for approval"). Missing = not known.
  approvalIsApprover?: boolean;
  // Active tag links (ids; look names and colors up in listTags()).
  tagIds: string[];
  // Comments on the task (not deleted), for the speech-bubble count on List rows and Board cards.
  commentCount: number;
  // Files and attachment links on the task (not removed), for the paperclip on List rows (Oct 27 notes,
  // batch 5; project_task_cards). Missing = not known (an older database, or a card built elsewhere).
  attachmentCount?: number;
  // Shown in front of the name while numbering is on, with its project's bracket setting. The stored
  // title stays bare.
  requestLabel?: RequestLabel | null;
};

export function projectTasksFromCards(data: Json): ProjectTask[] {
  if (!Array.isArray(data)) return [];
  const tasks: ProjectTask[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const card = item as Record<string, Json | undefined>;
    if (typeof card.id !== "string") continue;
    const fieldValues =
      card.field_values && typeof card.field_values === "object" && !Array.isArray(card.field_values)
        ? (card.field_values as Record<string, Json>)
        : {};
    tasks.push({
      id: card.id,
      title: typeof card.title === "string" ? card.title : "",
      completedAt: typeof card.completed_at === "string" ? card.completed_at : null,
      startOn: typeof card.start_on === "string" ? card.start_on : null,
      dueOn: typeof card.due_on === "string" ? card.due_on : null,
      assigneeId: typeof card.assignee_id === "string" ? card.assignee_id : null,
      homeProjectId: typeof card.home_project_id === "string" ? card.home_project_id : "",
      createdAt: typeof card.created_at === "string" ? card.created_at : "",
      sectionId: typeof card.section_id === "string" ? card.section_id : null,
      sortOrder: typeof card.sort_order === "number" ? card.sort_order : 0,
      subtaskCount: typeof card.subtask_count === "number" ? card.subtask_count : 0,
      subtaskDoneCount: typeof card.subtask_done_count === "number" ? card.subtask_done_count : 0,
      projectCount: typeof card.project_count === "number" ? card.project_count : 1,
      fieldValues,
      recurring: card.recurring === true,
      blockedBy: typeof card.blocked_by === "number" ? card.blocked_by : 0,
      blockerIds: Array.isArray(card.blocker_ids) ? card.blocker_ids.filter((x): x is string => typeof x === "string") : undefined,
      kind: parseTaskKind(card.kind),
      approvalStatus: parseTaskKind(card.kind) === "approval" ? (parseApprovalTaskStatus(card.approval_status) ?? "not_sent") : null,
      approvalPaused: card.approval_paused === true,
      approvalWaitingOnMe: card.approval_waiting_on_me === true,
      approvalIsApprover: card.approval_is_approver === true,
      tagIds: Array.isArray(card.tag_ids) ? card.tag_ids.filter((tagId): tagId is string => typeof tagId === "string") : [],
      commentCount: typeof card.comment_count === "number" ? card.comment_count : 0,
      attachmentCount: typeof card.attachment_count === "number" ? card.attachment_count : 0,
    });
  }
  return tasks;
}

// One page of cards per group (project_task_card_page). Null when that function is not
// there yet: the caller keeps the full project_task_cards list.
export type ProjectTaskGroupPage = {
  key: string;
  total: number;
  nextId: string | null;
  nextSortOrder: number | null;
  tasks: ProjectTask[];
};

// project_task_card_page()'s groups (shared with the batch 22 project_view_page loader).
export function taskGroupPagesFrom(data: Json | null | undefined): ProjectTaskGroupPage[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const groups = (data as { groups?: Json }).groups;
  if (!Array.isArray(groups)) return [];
  const pages: ProjectTaskGroupPage[] = [];
  for (const item of groups) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const group = item as Record<string, Json | undefined>;
    if (typeof group.key !== "string") continue;
    pages.push({
      key: group.key,
      total: typeof group.total === "number" ? group.total : 0,
      nextId: typeof group.next_id === "string" ? group.next_id : null,
      nextSortOrder: typeof group.next_sort_order === "number" ? group.next_sort_order : null,
      tasks: projectTasksFromCards(group.cards ?? []),
    });
  }
  return pages;
}

export function withPageLabels(pages: ProjectTaskGroupPage[], labels: Map<string, RequestLabel>): ProjectTaskGroupPage[] {
  return pages.map((page) => ({
    ...page,
    tasks: page.tasks.map((task) => ({ ...task, requestLabel: labels.get(task.id) ?? null })),
  }));
}

// task_request_labels / task_request_labels_in answers ({ task id: label }) as a map.
export function requestLabelMap(data: Json | null | undefined): Map<string, RequestLabel> {
  const labels = new Map<string, RequestLabel>();
  const map = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  for (const [taskId, value] of Object.entries(map)) {
    const label = requestLabelFrom(value);
    if (label) labels.set(taskId, label);
  }
  return labels;
}

// project_section_task_counts()'s answer as a record.
export function sectionCountsFrom(data: Json | null | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!data || typeof data !== "object" || Array.isArray(data)) return counts;
  for (const [sectionId, count] of Object.entries(data)) {
    if (typeof count === "number") counts[sectionId] = count;
  }
  return counts;
}

// The pane on a database without req_label: format_request_label() while the home sequence is on.
export function legacyPaneLabel(
  numbering: QueryResult<{ wrap_brackets?: boolean | null } | null>,
  label: QueryResult<string | null>,
): RequestLabel | null {
  const sequence = maybe(numbering, "request numbering");
  const text = sequence ? maybe(label, "request number") : null;
  return text ? { text, wrap: sequence?.wrap_brackets !== false } : null;
}

// A subtask as listed under its parent (the pane, List with “Show subtasks”).
export type SubtaskItem = {
  id: string;
  parentId: string;
  title: string;
  completedAt: string | null;
  assigneeId: string | null;
  startOn: string | null;
  dueOn: string | null;
  kind: TaskKind;
  sortOrder: number;
  subtaskCount: number;
  subtaskDoneCount: number;
  // The request number with its project's bracket setting (task numbering on), else null.
  requestLabel?: RequestLabel | null;
  // Open blockers (the completion check's count; Oct 27 notes, batch 6). Missing = not loaded.
  blockedBy?: number;
  // Approval subtasks (Oct 29 notes, batch 7): the latest round's status and the viewer's part in it, so
  // the row draws the right complete control. Missing = not loaded.
  approvalStatus?: ApprovalTaskStatus | null;
  approvalPaused?: boolean;
  approvalWaitingOnMe?: boolean;
  approvalIsApprover?: boolean;
};

export const SUBTASK_COLUMNS = "id, parent_task_id, title, completed_at, assignee_id, start_on, due_on, kind, subtask_order";

type SubtaskRow = {
  id: string;
  parent_task_id: string | null;
  title: string;
  completed_at: string | null;
  assignee_id: string | null;
  start_on: string | null;
  due_on: string | null;
  kind: string;
  subtask_order: number;
};

// Rows → items in sibling order, each with its own direct-subtask counts (from the same rows when
// the whole tree was loaded, else from `children`).
export function toSubtaskItems(list: SubtaskRow[], children: { parent_task_id: string | null; completed_at: string | null }[]) {
  const stats = new Map<string, { total: number; done: number }>();
  for (const c of children) {
    if (!c.parent_task_id) continue;
    const stat = stats.get(c.parent_task_id) ?? { total: 0, done: 0 };
    stat.total += 1;
    if (c.completed_at) stat.done += 1;
    stats.set(c.parent_task_id, stat);
  }
  return list
    .filter((r) => r.parent_task_id)
    .map((r) => ({
      id: r.id,
      parentId: r.parent_task_id!,
      title: r.title,
      completedAt: r.completed_at,
      assigneeId: r.assignee_id,
      startOn: r.start_on,
      dueOn: r.due_on,
      kind: parseTaskKind(r.kind),
      sortOrder: r.subtask_order,
      subtaskCount: stats.get(r.id)?.total ?? 0,
      subtaskDoneCount: stats.get(r.id)?.done ?? 0,
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

export type ProjectDependency = {
  id: string;
  predecessorId: string;
  successorId: string;
  kind: DependencyKind;
  lagDays: number;
};

// The rights part of taskAccessSets, from rows already read: the tasks (and their top-level tasks), the
// top-level tasks' live projects, and the viewer's effective roles. Pure, so the batch 22 screen loaders
// (my_task_bundle) and the chunked reads above decide the same way.
export function accessFromRows(
  taskIds: readonly string[],
  taskRows: readonly AccessTaskRow[],
  memberships: readonly { task_id: string; project_id: string }[],
  roles: Map<string, ProjectRole>,
  userId: string,
): { editable: Set<string>; commentable: Set<string> } {
  const editable = new Set<string>();
  const commentable = new Set<string>();
  type Row = AccessTaskRow;
  const wanted = new Set(taskIds);
  const byId = new Map(taskRows.map((t) => [t.id, t] as const));
  const tasks = [...byId.values()].filter((t) => wanted.has(t.id));
  const rootOf = (t: Row) => t.root_task_id ?? t.id;
  const projectsOf = new Map<string, string[]>();
  for (const m of memberships) projectsOf.set(m.task_id, [...(projectsOf.get(m.task_id) ?? []), m.project_id]);
  for (const task of tasks) {
    const root = byId.get(rootOf(task));
    if (!root) continue;
    if (root.home_project_id === null) {
      if (root.created_by === userId || root.assignee_id === userId) {
        editable.add(task.id);
        commentable.add(task.id);
      }
      continue;
    }
    const role = bestRole([root.home_project_id, ...(projectsOf.get(root.id) ?? [])].map((p) => roles.get(p)));
    const permissions = permissionsFor(role);
    if (permissions.canEdit) editable.add(task.id);
    if (permissions.canComment) commentable.add(task.id);
  }
  return { editable, commentable };
}

// ---------------------------------------------------------------------------------------------
// Trash: soft-deleted tasks of a project (RLS shows them to Editors and above only)
// ---------------------------------------------------------------------------------------------

export type TrashedTask = {
  id: string;
  title: string;
  deletedAt: string;
  deletedBy: string | null;
  // The task's other projects the viewer can read (Oct 29 notes, 55b: no home project), in the order it
  // was added to them; restoring brings it back there too.
  otherProjectNames: string[];
  completedAt: string | null;
  // Subtasks trashed on their own (with their parent still active): the parent's title.
  parentTitle: string | null;
};

// Oct 29 notes (batch 7, item 52): what an approval task's complete control needs to know — the latest
// round's status, paused, whether it waits on the viewer, and whether the viewer approves it. One call
// (task_approval_states); a database without it asks task_approval_state per task (at most 200), and an
// older one leaves the viewer's part unknown.
export type ApprovalRowState = Pick<SubtaskItem, "approvalStatus" | "approvalPaused" | "approvalWaitingOnMe" | "approvalIsApprover">;

export function approvalRowState(value: Json | undefined): ApprovalRowState {
  const state = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, Json>) : {};
  return {
    approvalStatus: parseApprovalTaskStatus(state.status) ?? "not_sent",
    approvalPaused: state.paused === true,
    approvalWaitingOnMe: state.waiting_on_me === true,
    approvalIsApprover: typeof state.is_approver === "boolean" ? state.is_approver : undefined,
  };
}

// 42. "Make a subtask of…": tasks the viewer edits that this task can go under (searchable). Read by
// GET /api/task-pane/<id>/parents (Nov 2 notes, batch 16, 124) with the person's own client.
export type ParentCandidate = { id: string; title: string; label: RequestLabel | null; projectName: string | null; isSubtask: boolean; completed: boolean };
