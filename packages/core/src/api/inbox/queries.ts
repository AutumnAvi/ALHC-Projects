// Big move 1: the inbox area's reads. Every function takes the caller's ApiContext first and reads only
// through ctx.db (RLS decides); no Next.js here.
import { type ApiContext, read } from "../core/context";
import { rows, rpcMissing } from "../core/db";
import {
  type InboxItem,
  inboxItemsFromPage,
  type InboxMessageRow,
  type InboxStatusRow,
  type InboxTaskRow,
  type InboxTeamMessageRow,
  labelInboxWith,
} from "./model";
import { visibleTaskNumbers } from "../numbers/queries";
import type { TaskApproval } from "../task-pane/model";
import { taskTitles } from "../tasks/queries";
import { INBOX_LIMIT, type InboxTab, withoutTeamMessages } from "../../inbox";

// One Inbox tab, newest first, INBOX_LIMIT items. inbox_page does the four reads in one call.
// A database without that function uses the row queries. Team message items are left out: teams have
// no Messages tab since Oct 26 notes (batch 4), so they'd link nowhere (the threads are kept).
export const listInbox = read(async (ctx: ApiContext, tab: InboxTab = "activity"): Promise<InboxItem[]> => {
  const supabase = ctx.db;
  const page = await supabase.rpc("inbox_page", { inbox_tab: tab });
  if (page.error) {
    if (!rpcMissing(page.error)) throw new Error(`Failed to load inbox: ${page.error.message}`);
    return labelInbox(ctx, withoutTeamMessages(await listInboxFromRows(ctx, tab)));
  }
  return labelInbox(ctx, withoutTeamMessages(inboxItemsFromPage(page.data)));
});

async function labelInbox(ctx: ApiContext, items: InboxItem[]): Promise<InboxItem[]> {
  const numbers = await visibleTaskNumbers(ctx, items.map((item) => item.taskId).filter((id): id is string => Boolean(id)));
  return labelInboxWith(items, numbers);
}

//   activity = not archived, archive = archived, bookmarks = bookmarked (archived or not),
//   mentioned = @mentions (archived or not).
async function listInboxFromRows(ctx: ApiContext, tab: InboxTab = "activity"): Promise<InboxItem[]> {
  const supabase = ctx.db;

  // The tab as a PostgREST filter: [column, operator, value].
  const [column, operator, value]: [string, string, string | null] =
    tab === "archive"
      ? ["archived_at", "not.is", null]
      : tab === "bookmarks"
        ? ["bookmarked_at", "not.is", null]
        : tab === "mentioned"
          ? ["kind", "eq", "mention"]
          : ["archived_at", "is", null];

  const base = "id, kind, data, actor_id, read_at, archived_at, bookmarked_at, created_at";
  const taskColumns = `${base}, task:tasks!inner(id, title, parent_task_id), comment:comments(id, body, deleted_at)`;
  const messageColumns = `${base}, message:project_messages!inner(id, project_id, thread_id, title, body, deleted_at, project:projects!inner(name))`;
  const [taskResult, messageResult, teamResult, statusResult] = await Promise.all([
    supabase
      .from("inbox_items")
      .select(taskColumns)
      .is("task.deleted_at", null)
      .filter(column, operator, value)
      .order("created_at", { ascending: false })
      .limit(INBOX_LIMIT)
      .overrideTypes<InboxTaskRow[], { merge: false }>(),
    supabase
      .from("inbox_items")
      .select(messageColumns)
      .is("task_id", null)
      .is("message.deleted_at", null)
      .is("message.project.deleted_at", null)
      .filter(column, operator, value)
      .order("created_at", { ascending: false })
      .limit(INBOX_LIMIT)
      .overrideTypes<InboxMessageRow[], { merge: false }>(),
    // Real features 2: team messages and status updates.
    supabase
      .from("inbox_items")
      .select(
        `${base}, team_message:team_messages!inner(id, team_id, thread_id, title, body, deleted_at, team:teams!inner(name, deleted_at))`,
      )
      .is("task_id", null)
      .is("team_message.deleted_at", null)
      .is("team_message.team.deleted_at", null)
      .filter(column, operator, value)
      .order("created_at", { ascending: false })
      .limit(INBOX_LIMIT)
      .overrideTypes<InboxTeamMessageRow[], { merge: false }>(),
    supabase
      .from("inbox_items")
      .select(
        `${base}, status_update:project_status_updates!inner(id, project_id, status, title, note, project:projects!inner(name, deleted_at))`,
      )
      .is("task_id", null)
      .is("status_update.project.deleted_at", null)
      .filter(column, operator, value)
      .order("created_at", { ascending: false })
      .limit(INBOX_LIMIT)
      .overrideTypes<InboxStatusRow[], { merge: false }>(),
  ]);
  const items = rows(taskResult, "inbox");
  const messageItems = rows(messageResult, "inbox messages");
  const teamItems = rows(teamResult, "inbox team messages");
  const statusItems = rows(statusResult, "inbox status updates");

  const approvalIds = [
    ...new Set(
      items.flatMap((item) => {
        const d = item.data;
        if (item.kind !== "approval_requested" || !d || typeof d !== "object" || Array.isArray(d)) return [];
        return typeof d.approval_id === "string" ? [d.approval_id] : [];
      }),
    ),
  ];
  // Comments with no actor and no rule may be a form submitter's emailed reply: name the address.
  const replyCommentIds = items
    .filter((item) => item.actor_id === null && item.comment && !item.comment.deleted_at)
    .map((item) => item.comment!.id);
  const [parentTitle, approvalRows, replySenders] = await Promise.all([
    taskTitles(ctx, items.map((item) => item.task.parent_task_id)),
    approvalIds.length
      ? supabase
          .from("approval_requests")
          .select("id, status, approver_id")
          .in("id", approvalIds)
          .is("deleted_at", null)
          .then((r) => rows(r, "approvals"))
      : Promise.resolve([]),
    replyCommentIds.length
      ? supabase
          .from("comments")
          .select("id, email_address")
          .in("id", replyCommentIds)
          .eq("email_direction", "received")
          // A database without 20261014030000_comments_email.sql has no such columns: no senders.
          .then((r) => new Map((r.error ? [] : (r.data ?? [])).map((c) => [c.id, c.email_address] as const)))
      : Promise.resolve(new Map<string, string | null>()),
  ]);
  const approvals = new Map(approvalRows.map((a) => [a.id, a] as const));
  // A reply's thread may be deleted (its replies are hidden then) and needs its title.
  const threadIds = [...new Set(messageItems.map((m) => m.message.thread_id).filter((t): t is string => t !== null))];
  const threads = threadIds.length
    ? new Map(
        rows(
          await supabase.from("project_messages").select("id, title, deleted_at").in("id", threadIds),
          "message threads",
        ).map((t) => [t.id, t] as const),
      )
    : new Map<string, { id: string; title: string | null; deleted_at: string | null }>();
  const teamThreadIds = [
    ...new Set(teamItems.map((m) => m.team_message.thread_id).filter((t): t is string => t !== null)),
  ];
  const teamThreads = teamThreadIds.length
    ? new Map(
        rows(
          await supabase.from("team_messages").select("id, title, deleted_at").in("id", teamThreadIds),
          "team message threads",
        ).map((t) => [t.id, t] as const),
      )
    : new Map<string, { id: string; title: string | null; deleted_at: string | null }>();

  const taskItems: InboxItem[] = items
    .filter((item) => !item.comment?.deleted_at)
    .map((item) => ({
      id: item.id,
      kind: item.kind as InboxItem["kind"],
      data: item.data,
      actorId: item.actor_id,
      readAt: item.read_at,
      archivedAt: item.archived_at,
      bookmarkedAt: item.bookmarked_at ?? null,
      createdAt: item.created_at,
      taskId: item.task.id,
      taskTitle: item.task.title,
      parentTitle: item.task.parent_task_id ? (parentTitle.get(item.task.parent_task_id) ?? null) : null,
      commentBody: item.comment?.body ?? null,
      emailFrom: item.comment ? (replySenders.get(item.comment.id) ?? null) : null,
      message: null,
      teamMessage: null,
      statusUpdate: null,
      project: null,
      approval: (() => {
        const d = item.data;
        const approvalId =
          item.kind === "approval_requested" && d && typeof d === "object" && !Array.isArray(d) && typeof d.approval_id === "string"
            ? d.approval_id
            : null;
        const a = approvalId ? approvals.get(approvalId) : undefined;
        return a ? { id: a.id, status: a.status as TaskApproval["status"], approverId: a.approver_id } : null;
      })(),
    }));
  const messages: InboxItem[] = messageItems.flatMap((item) => {
    const m = item.message;
    const thread = m.thread_id ? threads.get(m.thread_id) : null;
    if (m.thread_id && (!thread || thread.deleted_at)) return [];
    return [
      {
        id: item.id,
        kind: item.kind as InboxItem["kind"],
        data: item.data,
        actorId: item.actor_id,
        readAt: item.read_at,
        archivedAt: item.archived_at,
        bookmarkedAt: item.bookmarked_at ?? null,
        createdAt: item.created_at,
        taskId: null,
        taskTitle: (thread ? thread.title : m.title) ?? "Message",
        parentTitle: null,
        commentBody: m.body,
        message: { id: m.id, threadId: m.thread_id ?? m.id, projectId: m.project_id, projectName: m.project.name },
        teamMessage: null,
        statusUpdate: null,
        project: null,
        approval: null,
      emailFrom: null,
      },
    ];
  });
  const teamMessages: InboxItem[] = teamItems.flatMap((item) => {
    const m = item.team_message;
    const thread = m.thread_id ? teamThreads.get(m.thread_id) : null;
    if (m.thread_id && (!thread || thread.deleted_at)) return [];
    return [
      {
        id: item.id,
        kind: item.kind as InboxItem["kind"],
        data: item.data,
        actorId: item.actor_id,
        readAt: item.read_at,
        archivedAt: item.archived_at,
        bookmarkedAt: item.bookmarked_at ?? null,
        createdAt: item.created_at,
        taskId: null,
        taskTitle: (thread ? thread.title : m.title) ?? "Message",
        parentTitle: null,
        commentBody: m.body,
        message: null,
        teamMessage: { id: m.id, threadId: m.thread_id ?? m.id, teamId: m.team_id, teamName: m.team.name },
        statusUpdate: null,
        project: null,
        approval: null,
      emailFrom: null,
      },
    ];
  });
  const statusUpdates: InboxItem[] = statusItems.map((item) => {
    const u = item.status_update;
    return {
      id: item.id,
      kind: item.kind as InboxItem["kind"],
      data: item.data,
      actorId: item.actor_id,
      readAt: item.read_at,
      archivedAt: item.archived_at,
      bookmarkedAt: item.bookmarked_at ?? null,
      createdAt: item.created_at,
      taskId: null,
      taskTitle: u.project.name,
      parentTitle: null,
      commentBody: u.note,
      message: null,
      teamMessage: null,
      statusUpdate: { id: u.id, projectId: u.project_id, projectName: u.project.name, status: u.status, title: u.title },
      project: null,
      approval: null,
      emailFrom: null,
    };
  });
  // Newest first; items made in the same transaction keep a stable order.
  return [...taskItems, ...messages, ...teamMessages, ...statusUpdates]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, INBOX_LIMIT);
}

export const countUnreadInbox = read(async (ctx: ApiContext) => {
  const supabase = ctx.db;
  const counted = await supabase.rpc("inbox_unread_count");
  if (!counted.error) return counted.data ?? 0;
  if (!rpcMissing(counted.error)) throw new Error(`Failed to load inbox count: ${counted.error.message}`);
  const { count, error } = await supabase
    .from("inbox_items")
    .select("id", { count: "exact", head: true })
    .is("read_at", null)
    .is("archived_at", null);
  if (error) throw new Error(`Failed to load inbox count: ${error.message}`);
  return count ?? 0;
});
