// Big move 1: the inbox area's types and pure mappers (no database access; safe to import anywhere,
// the browser included).
import type { TaskApproval } from "@/lib/api/task-pane/model";
import { displayTaskTitle, type TaskNumber } from "@/lib/request-numbers";
import type { Json } from "@/lib/supabase/database.types";

export type InboxItem = {
  id: string;
  kind:
    | "assigned"
    | "comment"
    | "mention"
    | "completed"
    | "approval_requested"
    | "approval_decided"
    | "rule"
    | "message"
    | "status_update";
  data: Json;
  actorId: string | null;
  readAt: string | null;
  archivedAt: string | null;
  // Asana parity, batch 5: the Bookmarks tab.
  bookmarkedAt: string | null;
  createdAt: string;
  // Task items: the task. Message items (Messages tab): null, and `message` (project) or `teamMessage`
  // (team, Real features 2) is set; taskTitle then holds the thread's title. Status update items
  // (Real features 2): null, `statusUpdate` is set, taskTitle is the project's name and commentBody the
  // update's summary.
  taskId: string | null;
  taskTitle: string;
  // Subtasks: the parent task's title.
  parentTitle: string | null;
  commentBody: string | null;
  message: { id: string; threadId: string; projectId: string; projectName: string } | null;
  teamMessage: { id: string; threadId: string; teamId: string; teamName: string } | null;
  statusUpdate: { id: string; projectId: string; projectName: string; status: string; title: string | null } | null;
  // Automations V3 (batch D): an item about a project (a portfolio rule's notification or status
  // reminder): taskTitle is the project's name and commentBody the message.
  project: { id: string; name: string } | null;
  // approval_requested items: the request now (its approver decides it from the Inbox while pending).
  approval: { id: string; status: TaskApproval["status"]; approverId: string } | null;
  // A form submitter's emailed reply (Comments and reply by email): who sent it (no actor).
  emailFrom: string | null;
  // Task items: every number the task has in projects the viewer can read, in the stable order (Oct 29
  // notes, 55b); taskTitle carries the first one in front of the name.
  taskNumbers?: TaskNumber[];
};

type InboxRowBase = {
  id: string;
  kind: string;
  data: Json;
  actor_id: string | null;
  read_at: string | null;
  archived_at: string | null;
  bookmarked_at?: string | null;
  created_at: string;
};

export type InboxTaskRow = InboxRowBase & {
  task: { id: string; title: string; parent_task_id: string | null };
  comment: { id: string; body: string; deleted_at: string | null } | null;
};

export type InboxTeamMessageRow = InboxRowBase & {
  team_message: {
    id: string;
    team_id: string;
    thread_id: string | null;
    title: string | null;
    body: string;
    deleted_at: string | null;
    team: { name: string };
  };
};

export type InboxStatusRow = InboxRowBase & {
  status_update: {
    id: string;
    project_id: string;
    status: string;
    title: string | null;
    note: string | null;
    project: { name: string };
  };
};

export type InboxMessageRow = InboxRowBase & {
  message: {
    id: string;
    project_id: string;
    thread_id: string | null;
    title: string | null;
    body: string;
    deleted_at: string | null;
    project: { name: string };
  };
};

function inboxString(value: Json | undefined): string | null {
  return typeof value === "string" ? value : null;
}

export function inboxItemsFromPage(data: Json): InboxItem[] {
  if (!Array.isArray(data)) return [];
  const items: InboxItem[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, Json | undefined>;
    if (typeof row.id !== "string" || typeof row.kind !== "string" || typeof row.created_at !== "string") continue;
    const message = objectOrNull(row.message);
    const teamMessage = objectOrNull(row.team_message);
    const statusUpdate = objectOrNull(row.status_update);
    const project = objectOrNull(row.project);
    const approval = objectOrNull(row.approval);
    items.push({
      id: row.id,
      kind: row.kind as InboxItem["kind"],
      data: row.data ?? {},
      actorId: inboxString(row.actor_id),
      readAt: inboxString(row.read_at),
      archivedAt: inboxString(row.archived_at),
      bookmarkedAt: inboxString(row.bookmarked_at),
      createdAt: row.created_at,
      taskId: inboxString(row.task_id),
      taskTitle: typeof row.task_title === "string" ? row.task_title : "",
      parentTitle: inboxString(row.parent_title),
      commentBody: inboxString(row.comment_body),
      emailFrom: inboxString(row.email_from),
      message:
        message && typeof message.id === "string" && typeof message.project_id === "string"
          ? {
              id: message.id,
              threadId: typeof message.thread_id === "string" ? message.thread_id : message.id,
              projectId: message.project_id,
              projectName: typeof message.project_name === "string" ? message.project_name : "",
            }
          : null,
      teamMessage:
        teamMessage && typeof teamMessage.id === "string" && typeof teamMessage.team_id === "string"
          ? {
              id: teamMessage.id,
              threadId: typeof teamMessage.thread_id === "string" ? teamMessage.thread_id : teamMessage.id,
              teamId: teamMessage.team_id,
              teamName: typeof teamMessage.team_name === "string" ? teamMessage.team_name : "",
            }
          : null,
      statusUpdate:
        statusUpdate && typeof statusUpdate.id === "string" && typeof statusUpdate.project_id === "string"
          ? {
              id: statusUpdate.id,
              projectId: statusUpdate.project_id,
              projectName: typeof statusUpdate.project_name === "string" ? statusUpdate.project_name : "",
              status: typeof statusUpdate.status === "string" ? statusUpdate.status : "",
              title: inboxString(statusUpdate.title),
            }
          : null,
      project:
        project && typeof project.id === "string"
          ? { id: project.id, name: typeof project.name === "string" ? project.name : "" }
          : null,
      approval:
        approval && typeof approval.id === "string" && typeof approval.approver_id === "string"
          ? {
              id: approval.id,
              status: approval.status as NonNullable<InboxItem["approval"]>["status"],
              approverId: approval.approver_id,
            }
          : null,
    });
  }
  return items;
}

function objectOrNull(value: Json | undefined): Record<string, Json | undefined> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, Json | undefined>;
}

export function labelInboxWith(items: InboxItem[], numbers: Map<string, TaskNumber[]>): InboxItem[] {
  if (numbers.size === 0) return items;
  return items.map((item) => {
    const taskNumbers = item.taskId ? numbers.get(item.taskId) : undefined;
    return taskNumbers?.length
      ? { ...item, taskTitle: displayTaskTitle(item.taskTitle, taskNumbers[0].label), taskNumbers }
      : item;
  });
}
