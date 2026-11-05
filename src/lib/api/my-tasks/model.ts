// Big move 1: the my-tasks area's types and pure mappers (no database access; safe to import anywhere,
// the browser included).
import type { ApprovalRowState } from "@/lib/api/tasks/model";
import type { Recurrence } from "@/lib/recurrence";
import { displayTaskTitle, numbersOf, type RequestLabel, type TaskNumber, type TaskPlace } from "@/lib/request-numbers";
import type { Json } from "@/lib/supabase/database.types";
import { type ApprovalTaskStatus, parseTaskKind, type TaskKind } from "@/lib/task-kinds";

export type MyTask = {
  id: string;
  title: string;
  completedAt: string | null;
  dueOn: string | null;
  // Null for a private task (no project: only its creator and assignee can read it).
  projectId: string | null;
  projectName: string | null;
  kind: TaskKind;
  // Subtasks: the parent task's title ("in <parent>").
  parentTitle: string | null;
  // The request number with its project's bracket setting (task numbering on), else null. Since Oct 29
  // notes (55b) the first of taskNumbers (no home project).
  requestLabel?: RequestLabel | null;
  // Every number the task has in projects the viewer can read, in the stable order (the chips' "+N").
  taskNumbers?: TaskNumber[];
  // The viewer may edit it (task_role() ≥ Editor; editableTaskIds()). Being assigned only needs read
  // access, so a Viewer or Commenter sees the task without a checkbox or a clickable complete control.
  canEdit: boolean;
  // The viewer may comment on it (task_role() ≥ Commenter; taskAccessSets()). An approval task's assignee
  // sends it for approval with Commenter+ (approval_can_act), so a Viewer assignee gets a read-only mark
  // (Oct 29 notes, batch 7). Missing: the same as canEdit.
  canComment?: boolean;
  // Oct 27 notes (batch 6): open blockers (the completion check's count), direct subtasks (the row's
  // expand arrow), and an approval task's status.
  blockedBy?: number;
  subtaskCount?: number;
  subtaskDoneCount?: number;
  approvalStatus?: ApprovalTaskStatus | null;
  approvalPaused?: boolean;
  // Oct 29 notes (batch 7): a pending round waits on the viewer, and whether they approve it.
  approvalWaitingOnMe?: boolean;
  approvalIsApprover?: boolean;
  // A subtask's top-level task (its expanded tree loads by that); null for a top-level task.
  rootTaskId?: string | null;
  // Nov 1 notes (batch 9b): the checklist's extras — the start date (kept when the due date changes), a
  // repeat rule is set, when the task was assigned to the viewer, and whether to ask them for a date
  // (someone else gave it to them lately with no date, and they haven't said "Not now").
  startOn?: string | null;
  recurring?: boolean;
  assignedAt?: string | null;
  datePrompt?: boolean;
};

export function myTasksFromCards(data: Json): { open: MyTask[]; completed: MyTask[] } {
  const empty = { open: [] as MyTask[], completed: [] as MyTask[] };
  if (!data || typeof data !== "object" || Array.isArray(data)) return empty;
  const page = data as { open?: Json; completed?: Json };
  const mapList = (value: Json | undefined): MyTask[] => {
    if (!Array.isArray(value)) return [];
    const tasks: MyTask[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, Json | undefined>;
      if (typeof row.id !== "string") continue;
      tasks.push({
        id: row.id,
        title: typeof row.title === "string" ? row.title : "",
        completedAt: typeof row.completed_at === "string" ? row.completed_at : null,
        dueOn: typeof row.due_on === "string" ? row.due_on : null,
        projectId: typeof row.project_id === "string" ? row.project_id : null,
        projectName: typeof row.project_name === "string" ? row.project_name : null,
        kind: parseTaskKind(row.kind),
        parentTitle: typeof row.parent_title === "string" ? row.parent_title : null,
        canEdit: true,
        startOn: typeof row.start_on === "string" ? row.start_on : null,
        recurring: row.recurring === true,
        assignedAt: typeof row.assigned_at === "string" ? row.assigned_at : null,
        datePrompt: row.date_prompt === true,
      });
    }
    return tasks;
  };
  return { open: mapList(page.open), completed: mapList(page.completed) };
}

// My tasks' rows with their numbers, rights, and extras (shared by labelMyTasks and the batch 22 screen
// loaders, which read the same pieces in one call).
export function assembleMyTasks(
  page: { open: MyTask[]; completed: MyTask[] },
  numbers: Map<string, TaskNumber[]>,
  access: { editable: Set<string>; commentable: Set<string> },
  extras: Map<string, Partial<MyTask>>,
) {
  const apply = (task: MyTask): MyTask => {
    const taskNumbers = numbers.get(task.id) ?? [];
    const label = taskNumbers[0]?.label ?? null;
    return {
      ...task,
      ...extras.get(task.id),
      requestLabel: label,
      taskNumbers,
      title: displayTaskTitle(task.title, label),
      canEdit: access.editable.has(task.id),
      canComment: access.commentable.has(task.id),
    };
  };
  return { open: page.open.map(apply), completed: page.completed.map(apply) };
}

// The extras of My tasks' open rows from rows already read (blockers, subtasks, approval states, roots).
export function myTaskExtrasFrom(
  blocked: Map<string, number>,
  children: readonly { parent_task_id: string | null; completed_at: string | null }[],
  states: Map<string, ApprovalRowState>,
  roots: readonly { id: string; root_task_id: string | null }[],
): Map<string, Partial<MyTask>> {
  const extras = new Map<string, Partial<MyTask>>();
  for (const [taskId, count] of blocked) extras.set(taskId, { ...extras.get(taskId), blockedBy: count });
  for (const r of roots) extras.set(r.id, { ...extras.get(r.id), rootTaskId: r.root_task_id });
  for (const c of children) {
    if (!c.parent_task_id) continue;
    const prev = extras.get(c.parent_task_id) ?? {};
    extras.set(c.parent_task_id, {
      ...prev,
      subtaskCount: (prev.subtaskCount ?? 0) + 1,
      subtaskDoneCount: (prev.subtaskDoneCount ?? 0) + (c.completed_at ? 1 : 0),
    });
  }
  for (const [taskId, state] of states) extras.set(taskId, { ...extras.get(taskId), ...state });
  return extras;
}

// Tasks waiting on the viewer's approval (pending requests where they are the approver; round requests
// only while their round is pending). My tasks shows them in "Waiting on me to approve".
export type AwaitingApproval = {
  requestId: string;
  taskId: string;
  title: string;
  requestLabel: RequestLabel | null;
  // Every number the viewer can read, stable order (Oct 29 notes, 55b); requestLabel is the first.
  taskNumbers?: TaskNumber[];
  // The first project the task was added to that the viewer can read (the stable rule).
  projectId: string | null;
  projectName: string | null;
  // The approval due date (approval tasks), else the task's due date.
  dueOn: string | null;
  sentAt: string;
  roundNumber: number | null;
  isApprovalTask: boolean;
};

// Waiting on me to approve, from rows already read (shared with the batch 22 screen loaders).
export function awaitingFrom(
  requests: readonly { id: string; task_id: string; round_id: string | null; created_at: string }[],
  tasks: readonly { id: string; title: string; kind: string; due_on: string | null; completed_at: string | null }[],
  rounds: readonly { id: string; status: string; due_on: string | null; round_number: number }[],
  places: Map<string, TaskPlace[]>,
  access: { editable: Set<string>; commentable: Set<string> },
): AwaitingApproval[] {
  const taskById = new Map(tasks.map((t) => [t.id, t] as const));
  const roundById = new Map(rounds.map((r) => [r.id, r] as const));
  const seen = new Set<string>();
  const out: AwaitingApproval[] = [];
  for (const r of requests) {
    const task = taskById.get(r.task_id);
    if (!task || seen.has(task.id) || !access.commentable.has(task.id)) continue;
    const round = r.round_id ? roundById.get(r.round_id) : null;
    if (r.round_id && round?.status !== "pending") continue;
    seen.add(task.id);
    const place = places.get(task.id) ?? [];
    const taskNumbers = numbersOf(place);
    out.push({
      requestId: r.id,
      taskId: task.id,
      title: task.title,
      requestLabel: taskNumbers[0]?.label ?? null,
      taskNumbers,
      projectId: place[0]?.projectId ?? null,
      projectName: place[0]?.projectName ?? null,
      dueOn: round?.due_on ?? task.due_on,
      sentAt: r.created_at,
      roundNumber: round?.round_number ?? null,
      isApprovalTask: task.kind === "approval",
    });
  }
  return out;
}

// What the My tasks / Home quick-add bar sends (parsed in the browser by parseQuickAdd).
export type QuickAddTaskInput = {
  title: string;
  projectId?: string | null;
  // The @person typed in the bar: a follower, never the assignee.
  mentionId?: string | null;
  dueOn?: string | null;
  repeat?: { freq: Recurrence["freq"]; interval: number; weekdays: number[]; fromCompletion: boolean } | null;
  timeZone?: string;
};
