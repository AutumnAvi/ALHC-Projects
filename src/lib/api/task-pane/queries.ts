// Big move 1: the task-pane area's reads. Every function takes the caller's ApiContext first and reads only
// through ctx.db (RLS decides); no Next.js here.
import { getViewer } from "@/lib/api/auth/queries";
import { COMMENT_PAGE_SIZE, type CommentPage, olderCursor, parseCommentPage } from "@/lib/api/comments/model";
import {
  loadCommentPins,
  loadCommentRefs,
  loadReplyThread,
  withReplyFiles,
  withReviewChecks,
} from "@/lib/api/comments/queries";
import { type ApiContext, type Db, read } from "@/lib/api/core/context";
import { isMissingColumn, maybe, rows, rpcMissing } from "@/lib/api/core/db";
import { listFieldsForProjects } from "@/lib/api/fields/queries";
import { numbersFromPlaces, placesFromLabels, taskNumbersFrom } from "@/lib/api/numbers/model";
import {
  firstVisibleNumbers,
  loadTaskNumbers,
  visibleTaskNumbers,
  visibleTaskPlacesOrNull,
} from "@/lib/api/numbers/queries";
import { listProfiles } from "@/lib/api/people/queries";
import { listMyProjectRoles, listProjects } from "@/lib/api/projects/queries";
import { listTaskTagIds, listVisibleTags } from "@/lib/api/tags/queries";
import {
  type ApprovalRound,
  type DependencyCandidateGroup,
  parseSubmitterConversation,
  type StoryEmailStatus,
  type SubmitterConversation,
  TASK_RUN_LIMIT,
  type TaskApproval,
  type TaskApprovalInfo,
  type TaskComment,
  type TaskDetail,
  type TaskEmailActivity,
  type TaskExtras,
  type TaskExtrasPart,
  type TaskPaneContext,
  type TaskPanePayload,
  type TaskPaneRows,
  type TaskRuleRun,
} from "@/lib/api/task-pane/model";
import { legacyPaneLabel, SUBTASK_COLUMNS, toSubtaskItems } from "@/lib/api/tasks/model";
import { projectCriticalPath, withRequestLabels, withSubtaskApprovals } from "@/lib/api/tasks/queries";
import { listTeams } from "@/lib/api/teams/queries";
import { commentEmailStatus, parseCommentEmail } from "@/lib/comment-email";
import { parseDependencyKind } from "@/lib/dependencies";
import { type DeliveryStatus, isDeliveryEvent } from "@/lib/email-schedules";
import { submissionRequesterName } from "@/lib/forms";
import { isUuid } from "@/lib/ids";
import { REACTIONS } from "@/lib/reactions";
import { parseRecurrence } from "@/lib/recurrence";
import { numberWithItsProject } from "@/lib/request-numbers";
import { hasRole, isProjectRole, PROJECT_ROLES as ROLE_ORDER, type ProjectRole } from "@/lib/roles";
import { toFieldDef } from "@/lib/row-mappers";
import { runReason } from "@/lib/rules";
import { partialOf } from "@/lib/run-outcome";
import type { Json, Tables } from "@/lib/supabase/database.types";
import { type AfterApproval, parseApprovalTaskStatus, parseTaskKind } from "@/lib/task-kinds";

const EMAIL_STATUSES = ["pending", "sending", "sent", "mocked", "failed"] as const;

function isEmailStatus(value: string): value is StoryEmailStatus["status"] {
  return (EMAIL_STATUSES as readonly string[]).includes(value);
}

async function loadTaskPaneRows(supabase: Db, taskId: string): Promise<TaskPaneRows | null> {
  if (!isUuid(taskId)) return null;
  const result = await supabase.rpc("task_pane_rows", {
    target_task: taskId,
    comment_page_size: COMMENT_PAGE_SIZE,
    run_limit: TASK_RUN_LIMIT,
  });
  if (rpcMissing(result.error)) return null;
  if (result.error) throw new Error(`Failed to load task: ${result.error.message}`);
  return result.data && typeof result.data === "object" && !Array.isArray(result.data) ? (result.data as TaskPaneRows) : null;
}

export const getTaskDetail = read(async (ctx: ApiContext, taskId: string): Promise<TaskDetail | null> => {
  const supabase = ctx.db;
  // Nov 4 notes (batch 22, M1): the pane's reads come back in one call (task_pane_rows) when the database
  // has it; each read below then takes its rows from there (same columns), else runs as before.
  const pane = await loadTaskPaneRows(supabase, taskId);
  const fromPane = <T,>(key: string, read: () => PromiseLike<T>): Promise<T> =>
    pane ? Promise.resolve({ data: pane[key] ?? null, error: null } as T) : Promise.resolve(read());
  const task = maybe(
    await fromPane("task", () => supabase
      .from("tasks")
      .select(
        "id, title, kind, notes, completed_at, start_on, due_on, start_at, due_at, time_zone, recurrence, recurrence_seq, recurrence_next_id, assignee_id, home_project_id, created_at, updated_at, source, req_project_id, req_number, parent_task_id, root_task_id",
      )
      .eq("id", taskId)
      .is("deleted_at", null)
      .maybeSingle()),
    "task",
  );
  if (!task) return null;

  // A subtask lives in its root task's projects.
  const scopeTaskId = task.root_task_id ?? taskId;
  const isPrivate = task.home_project_id === null;
  // A subtask of a form task answers the request's submitter (its top-level task's submission).
  const readSubmission = () =>
    supabase
      .from("form_submissions")
      .select("form_id, submitter_email, created_at, answers")
      .eq("task_id", scopeTaskId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(1);
  // Reads that need only the task row start now and are awaited at the end, so they add no round trip.
  const early = Promise.all([
    listMyProjectRoles(ctx),
    pane
      ? Promise.resolve(new Map([[taskId, Array.isArray(pane.tag_ids) ? (pane.tag_ids as string[]) : []]]))
      : listTaskTagIds(ctx, [taskId]),
    fromPane("blocker_count", () => supabase.rpc("open_blocker_count", { target_task: taskId })),
    isPrivate
      ? fromPane("private_root", () => supabase
          .from("tasks")
          .select("created_by, assignee_id")
          .eq("id", scopeTaskId)
          .maybeSingle())
          .then((r) => maybe(r, "private task"))
      : Promise.resolve(null),
    listTeams(ctx),
    pane ? Promise.resolve(numbersFromPlaces(placesFromLabels(pane.labels))) : visibleTaskNumbers(ctx, [taskId]),
    pane ? Promise.resolve(taskNumbersFrom(pane.task_numbers)) : loadTaskNumbers(supabase, taskId),
    task.kind === "approval" ? loadApprovalInfo(supabase, taskId) : Promise.resolve(null),
  ]);
  // Marked handled now; awaiting it below still throws its error.
  early.catch(() => {});
  const [subtasks, memberships, tree] = await Promise.all([
    fromPane("subtasks", () => supabase
      .from("tasks")
      .select(SUBTASK_COLUMNS)
      .eq("parent_task_id", taskId)
      .is("deleted_at", null)
      .order("subtask_order")
      .order("created_at")),
    fromPane("memberships", () => supabase
      .from("task_projects")
      .select("project_id, section_id, project:projects!inner(id, name, sections(id, name, sort_order, deleted_at))")
      .eq("task_id", scopeTaskId)
      .is("deleted_at", null)
      .is("project.deleted_at", null)
      .order("created_at")
      .order("project_id")),
    // The whole task tree (root first): the breadcrumb, subtask counts, and Convert's candidates.
    fromPane("tree", () => supabase
      .from("tasks")
      .select("id, title, completed_at, parent_task_id, deleted_at")
      .or(`id.eq.${scopeTaskId},root_task_id.eq.${scopeTaskId}`)
      .order("created_at")
      .limit(500)),
  ]);
  const subtaskRows = rows(subtasks, "subtasks");
  const treeRows = rows(tree, "parent tasks");
  const subtaskIds = new Set(subtaskRows.map((r) => r.id));
  // The tree already holds the subtasks' own subtasks (x/y counts) unless it hit its limit.
  const grandchildren = !subtaskRows.length
    ? []
    : treeRows.length < 500
      ? treeRows.filter((r) => r.deleted_at === null && r.parent_task_id !== null && subtaskIds.has(r.parent_task_id))
      : rows(
          await supabase
            .from("tasks")
            .select("parent_task_id, completed_at")
            .in("parent_task_id", [...subtaskIds])
            .is("deleted_at", null),
          "subtasks",
        );
  const treeById = new Map(treeRows.map((r) => [r.id, r] as const));
  const ancestors: TaskDetail["ancestors"] = [];
  for (let up = task.parent_task_id ? treeById.get(task.parent_task_id) : undefined; up && ancestors.length < 10; ) {
    ancestors.unshift({ id: up.id, title: up.title, completedAt: up.completed_at });
    up = up.parent_task_id ? treeById.get(up.parent_task_id) : undefined;
  }
  const isSubtask = task.parent_task_id !== null;

  const membershipRows = rows(memberships, "task projects");
  const projectIds = membershipRows.map((m) => m.project_id);
  // Sections come embedded in the memberships read (one round trip less).
  const sections = membershipRows.flatMap((m) =>
    (m.project.sections ?? [])
      .filter((sec) => sec.deleted_at === null)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((sec) => ({ id: sec.id, project_id: m.project_id, name: sec.name })),
  );

  const [
    fields,
    values,
    followers,
    attachments,
    comments,
    stories,
    approvals,
    submissions,
    label,
    numbering,
    viewerRole,
    projectMembers,
    dependencies,
    nextOccurrence,
    attachmentLinks,
    commentEmails,
    responseEmails,
  ] = await Promise.all([
    pane
      ? Promise.resolve((Array.isArray(pane.fields) ? (pane.fields as Tables<"custom_fields">[]) : []).map(toFieldDef))
      : projectIds.length ? listFieldsForProjects(ctx, projectIds) : Promise.resolve([]),
    fromPane("values", () => supabase.from("task_field_values").select("field_id, value").eq("task_id", taskId)),
    fromPane("followers", () => supabase
      .from("task_followers")
      .select("profile_id")
      .eq("task_id", taskId)
      .is("deleted_at", null)
      .order("created_at")),
    fromPane("attachments", () => supabase
      .from("task_attachments")
      .select("id, file_name, content_type, size_bytes, uploaded_by, created_at, source")
      .eq("task_id", taskId)
      .is("deleted_at", null)
      .order("created_at")),
    fromPane("comment_page", () => supabase.rpc("task_comment_page", { target_task: taskId, max_results: COMMENT_PAGE_SIZE })),
    fromPane("stories", () => supabase
      .from("task_stories")
      .select("id, actor_id, kind, data, created_at")
      .eq("task_id", taskId)
      .order("created_at")),
    fromPane("approvals", () => supabase
      .from("approval_requests")
      .select("*")
      .eq("task_id", taskId)
      .is("deleted_at", null)
      .order("created_at")),
    pane
      ? Promise.resolve({ data: pane.submission ? [pane.submission] : [], error: null } as unknown as Awaited<ReturnType<typeof readSubmission>>)
      : readSubmission(),
    task.req_number
      ? fromPane("request_label", () => supabase.rpc("format_request_label", {
          target_project: task.req_project_id!,
          number: task.req_number!,
        }))
      : Promise.resolve({ data: null, error: null }),
    task.home_project_id
      ? fromPane("numbering", () => supabase
          .from("request_sequences")
          .select("*")
          .eq("project_id", task.home_project_id!)
          .eq("enabled", true)
          .is("deleted_at", null)
          .maybeSingle())
      : Promise.resolve({ data: null, error: null }),
    fromPane("task_role", () => supabase.rpc("task_role", { target_task: taskId })),
    projectIds.length
      ? fromPane("project_members", () => supabase
          .from("project_members")
          .select("profile_id, role")
          .in("project_id", projectIds)
          .is("deleted_at", null))
      : Promise.resolve({ data: [], error: null }),
    fromPane("dependencies", () => supabase
      .from("task_dependencies")
      .select(
        "id, predecessor_id, successor_id, kind, lag_days, predecessor:tasks!task_dependencies_predecessor_id_fkey!inner(id, title, completed_at, parent_task_id), successor:tasks!task_dependencies_successor_id_fkey!inner(id, title, completed_at, parent_task_id)",
      )
      .or(`predecessor_id.eq.${taskId},successor_id.eq.${taskId}`)
      .is("deleted_at", null)
      .is("predecessor.deleted_at", null)
      .is("successor.deleted_at", null)
      .order("created_at")),
    task.recurrence_next_id
      ? fromPane("next_occurrence", () => supabase.from("tasks").select("id").eq("id", task.recurrence_next_id!).is("deleted_at", null).maybeSingle())
      : Promise.resolve({ data: null, error: null }),
    fromPane("attachment_links", () => supabase
      .from("task_attachment_links")
      .select("id, source, name, url, attachment_id")
      .eq("task_id", taskId)
      .is("deleted_at", null)
      .order("created_at")),
    // Comments and reply by email (20261014030000): which comments were emailed to the form's submitter or
    // came back from them. A database without that update has no such columns (42703 → none, and no
    // "Send response to submitter").
    fromPane("comment_emails", () => supabase
      .from("comments")
      .select("id, email_direction, email_address, email_subject")
      .eq("task_id", taskId)
      .not("email_direction", "is", null)),
    fromPane("response_emails", () => supabase
      .from("email_outbox")
      .select("status, delivery_status, last_error, comment_id:payload->>comment_id")
      .eq("task_id", taskId)
      .eq("payload->>kind", "submitter_response")
      .order("created_at")),
  ]);

  let submitterResponses = !commentEmails.error;
  if (commentEmails.error && !isMissingColumn(commentEmails.error)) {
    console.error(`[comments] couldn't read email comments: ${commentEmails.error.message}`);
  }
  const responseStatus = new Map(
    (responseEmails.error ? [] : (responseEmails.data ?? [])).map((o) => [
      String(o.comment_id),
      {
        status: commentEmailStatus(o),
        error: o.status === "failed" ? (typeof o.last_error === "string" ? o.last_error.slice(0, 200) : null) : null,
      },
    ]),
  );
  const emailOf = new Map(
    (commentEmails.error ? [] : (commentEmails.data ?? [])).flatMap((c) => {
      const email = parseCommentEmail(c);
      if (!email) return [];
      const outbox = email.direction === "sent" ? responseStatus.get(c.id) : undefined;
      return [[c.id, { ...email, status: outbox?.status ?? null, error: outbox?.error ?? null }] as const];
    }),
  );

  const memberRoles: Record<string, ProjectRole> = {};
  for (const m of rows(projectMembers, "task members")) {
    if (!isProjectRole(m.role)) continue;
    const current = memberRoles[m.profile_id];
    if (!current || ROLE_ORDER.indexOf(m.role) < ROLE_ORDER.indexOf(current)) memberRoles[m.profile_id] = m.role;
  }
  const role = maybe(viewerRole, "task role");
  const viewerProjectRole = isProjectRole(role) ? role : null;
  const dependencyRows = rows(dependencies, "dependencies");
  const visibleBlockers = dependencyRows.filter(
    (d) => d.successor_id === taskId && (d.kind === "finish_to_start" || d.kind === "finish_to_finish") && d.predecessor.completed_at === null,
  ).length;
  if (comments.error && !rpcMissing(comments.error)) {
    throw new Error(`Failed to load comments: ${comments.error.message}`);
  }
  const storyList = rows(stories, "activity");
  const approvalRows = rows(approvals, "approvals");
  const submission = rows(submissions, "form submission")[0] ?? null;
  const approvalRuleIds = [...new Set(approvalRows.map((a) => a.rule_id).filter((ruleId): ruleId is string => Boolean(ruleId)))];
  // Everything that needed the reads above, in one wave, plus the reads started after the task row.
  const [
    replyThread,
    storyRows,
    emailStatus,
    pagedComments,
    approvalRuleNames,
    formTitle,
    [myRoles, tagIds, blockerCount, privateRoot, teams, taskNumberLists, projectNumbers, approvalInfo],
    subtaskItems,
    submitterConversation,
    pins,
    automationActivity,
  ] = await Promise.all([
    loadReplyThread(supabase, taskId, pane ? { data: pane.reply_thread ?? null, error: null } : undefined),
    withDependencyTitles(ctx, storyList),
    storyEmailStatuses(ctx, storyList),
    comments.error ? Promise.resolve(null) : withReplyFiles(supabase, parseCommentPage(comments.data, responseStatus)).then((page) => withReviewChecks(supabase, page)),
    approvalRuleIds.length
      ? supabase.from("rules").select("id, name").in("id", approvalRuleIds)
      : Promise.resolve({ data: [], error: null }),
    submission
      ? supabase.from("forms").select("title, questions").eq("id", submission.form_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    early,
    withSubtaskApprovals(supabase, toSubtaskItems(subtaskRows, grandchildren)).then((items) => withRequestLabels(ctx, items)),
    submission ? loadSubmitterConversation(ctx, taskId) : Promise.resolve(null),
    loadCommentPins(supabase, taskId, responseStatus, pane ? { pinned: pane.pinned_comments, events: pane.pin_events } : undefined),
    loadTaskAutomationAndEmail(supabase, taskId, pane ? { runs: pane.rule_runs, email: pane.email_activity } : undefined),
  ]);
  const editableProjectIds = membershipRows.map((m) => m.project_id).filter((p) => hasRole(myRoles.get(p), "editor"));

  const commentPage: CommentPage | null = pagedComments;
  if (commentPage) submitterResponses = true;
  const legacyComments = commentPage
    ? []
    : rows(
        await supabase
          .from("comments")
          .select(
            "id, author_id, rule_id, body, created_at, edited_at, deleted_at, comment_mentions(profile_id), comment_reactions(emoji, profile_id, deleted_at, created_at)",
          )
          .eq("task_id", taskId)
          .order("created_at"),
        "comments",
      );
  // Rule names for approvals, plus rule comments on a database without task_comment_page (rare).
  const legacyRuleIds = [
    ...new Set(legacyComments.map((c) => c.rule_id).filter((ruleId): ruleId is string => Boolean(ruleId))),
  ].filter((ruleId) => !approvalRuleIds.includes(ruleId));
  const ruleNameRows = [
    ...rows(approvalRuleNames, "rules"),
    ...(legacyRuleIds.length ? rows(await supabase.from("rules").select("id, name").in("id", legacyRuleIds), "rules") : []),
  ];
  const ruleName = new Map(ruleNameRows.map((r) => [r.id, r.name] as const));
  const taskComments = commentPage
    ? commentPage.comments
    : legacyComments.map((c) => {
        const deleted = c.deleted_at !== null;
        const active = deleted
          ? []
          : c.comment_reactions
              .filter((r) => r.deleted_at === null)
              .sort((a, b) => a.created_at.localeCompare(b.created_at));
        return {
          id: c.id,
          authorId: c.author_id,
          ruleName: c.rule_id ? (ruleName.get(c.rule_id) ?? "Automation") : null,
          ruleId: c.rule_id,
          body: deleted ? "" : c.body,
          createdAt: c.created_at,
          editedAt: deleted ? null : c.edited_at,
          deleted,
          mentionIds: deleted ? [] : c.comment_mentions.map((m) => m.profile_id),
          reactions: REACTIONS.map(({ key }) => ({
            emoji: key,
            profileIds: active.filter((r) => r.emoji === key).map((r) => r.profile_id),
          })).filter((r) => r.profileIds.length > 0),
          email: emailOf.get(c.id) ?? null,
        };
      });
  const commentTotal = commentPage ? commentPage.total : taskComments.filter((c) => !c.deleted).length;
  const olderComments = commentPage ? olderCursor(commentPage) : null;

  return {
    fields,
    fieldValues: Object.fromEntries(
      rows(values, "field values").map((v) => [v.field_id, v.value] as const),
    ),
    followerIds: rows(followers, "followers").map((f) => f.profile_id),
    attachments: rows(attachments, "attachments").map((a) => ({
      id: a.id,
      fileName: a.file_name,
      contentType: a.content_type,
      sizeBytes: a.size_bytes,
      uploadedBy: a.uploaded_by,
      createdAt: a.created_at,
      source: a.source,
    })),
    attachmentLinks: rows(attachmentLinks, "attachment links").map((a) => ({
      id: a.id,
      source: a.source,
      name: a.name,
      url: a.url,
      attachmentId: a.attachment_id,
    })),
    comments: await withRuleProjects(supabase, taskComments, automationActivity.ruleProjects),
    pinnedComments: await withRuleProjects(supabase, pins.pinned, automationActivity.ruleProjects),
    ruleRuns: automationActivity.runs,
    emailActivity: automationActivity.email,
    // The description's # links too (Nov 3 notes, batch 18, 133).
    commentRefs: await loadCommentRefs(supabase, [...[...taskComments, ...pins.pinned].map((c) => c.body), task.notes ?? ""]),
    commentTotal,
    mentionTeams: teams.map((t) => ({
      id: t.id,
      name: t.name,
      members: t.members.map((m) => ({ id: m.profileId, name: m.name, email: m.email })),
    })),
    olderComments,
    stories: [
      ...storyRows.map((st) => ({
        id: st.id,
        actorId: st.actor_id,
        kind: st.kind,
        data: st.data,
        createdAt: st.created_at,
        ...(st.kind === "email_queued" ? { email: emailStatus.get(storyEmailId(st.data) ?? "") ?? null } : {}),
      })),
      ...pins.events,
    ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    id: task.id,
    title: task.title,
    kind: parseTaskKind(task.kind),
    notes: task.notes,
    completedAt: task.completed_at,
    startOn: task.start_on,
    dueOn: task.due_on,
    startAt: task.start_at,
    dueAt: task.due_at,
    timeZone: task.time_zone,
    recurrence: parseRecurrence(task.recurrence),
    recurrenceSeq: task.recurrence_seq,
    nextOccurrenceId: maybe(nextOccurrence, "next occurrence")?.id ?? null,
    dependencies: dependencyRows.map((d) => {
      const blockedBy = d.successor_id === taskId;
      const other = blockedBy ? d.predecessor : d.successor;
      return {
        id: d.id,
        relation: blockedBy ? ("blocked_by" as const) : ("blocking" as const),
        kind: parseDependencyKind(d.kind),
        lagDays: d.lag_days,
        taskId: other.id,
        title: other.title,
        completedAt: other.completed_at,
        isSubtask: other.parent_task_id !== null,
      };
    }),
    hiddenBlockers: Math.max(0, (maybe(blockerCount, "blockers") ?? 0) - visibleBlockers),
    editableProjectIds,
    assigneeId: task.assignee_id,
    homeProjectId: task.home_project_id === null ? null : (membershipRows[0]?.project_id ?? null),
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    source: task.source,
    requestLabel: taskNumberLists.get(task.id)?.[0]?.label ?? legacyPaneLabel(numbering, label),
    taskNumbers: taskNumberLists.get(task.id) ?? [],
    canAssignRequestNumber: !task.req_number && !isSubtask && Boolean(maybe(numbering, "request numbering")),
    submission: submission
      ? {
          email: submission.submitter_email,
          name: submissionRequesterName(formTitle.data?.questions ?? [], submission.answers),
          formId: submission.form_id,
          formTitle: formTitle.data?.title ?? null,
          createdAt: submission.created_at,
        }
      : null,
    submitterResponses,
    submitterConversation,
    replyThread,
    approvals: approvalRows.map((a) => ({
      id: a.id,
      subtaskId: a.subtask_id,
      approverId: a.approver_id,
      requestedBy: a.requested_by,
      ruleName: a.rule_id ? (ruleName.get(a.rule_id) ?? "Automation") : null,
      note: a.note,
      status: a.status as TaskApproval["status"],
      decidedAt: a.decided_at,
      decisionNote: a.decision_note,
      createdAt: a.created_at,
      roundId: a.round_id ?? null,
      cancelReason: a.cancel_reason ?? null,
      handoffTo: a.handoff_to ?? null,
      handoffNote: a.handoff_note ?? null,
    })),
    approval: approvalInfo,
    projectNumbers,
    viewerRole: viewerProjectRole,
    memberRoles,
    viewerProjectRoles: Object.fromEntries(
      membershipRows.flatMap((m) => {
        const projectRole = myRoles.get(m.project_id);
        return projectRole ? [[m.project_id, projectRole] as const] : [];
      }),
    ),
    tagIds: tagIds.get(taskId) ?? [],
    isPrivate,
    privateReaderIds: [
      ...new Set([privateRoot?.created_by, privateRoot?.assignee_id].filter((p): p is string => Boolean(p))),
    ],
    subtasks: subtaskItems,
    parentTaskId: task.parent_task_id,
    ancestors,
    isSubtask,
    memberships: membershipRows.map((m) => ({
      projectId: m.project_id,
      projectName: m.project.name,
      sectionId: m.section_id,
      sections: sections
        .filter((s) => s.project_id === m.project_id)
        .map(({ id, name }) => ({ id, name })),
    })),
  };
});

export async function getTaskExtras(ctx: ApiContext, taskId: string, part: TaskExtrasPart): Promise<TaskExtras | null> {
  if (!isUuid(taskId)) return null;
  const supabase = ctx.db;
  const task = maybe(
    await supabase.from("tasks").select("id, due_on, parent_task_id, root_task_id").eq("id", taskId).is("deleted_at", null).maybeSingle(),
    "task",
  );
  if (!task) return null;
  const scopeTaskId = task.root_task_id ?? taskId;
  const [memberships, tree, viewerRole] = await Promise.all([
    supabase
      .from("task_projects")
      .select("project_id, project:projects!inner(id, name)")
      .eq("task_id", scopeTaskId)
      .is("deleted_at", null)
      .is("project.deleted_at", null)
      .order("created_at"),
    supabase
      .from("tasks")
      .select("id, title, deleted_at")
      .or(`id.eq.${scopeTaskId},root_task_id.eq.${scopeTaskId}`)
      .order("created_at")
      .limit(500),
    supabase.rpc("task_role", { target_task: taskId }),
  ]);
  const membershipRows = rows(memberships, "task projects");
  const role = maybe(viewerRole, "task role");
  const treeCandidates = rows(tree, "task tree")
    .filter((r) => r.id !== taskId && r.deleted_at === null)
    .map((r) => ({ id: r.id, title: r.title }));
  const [dependencyCandidates, schedule] = await Promise.all([
    part === "candidates" && hasRole(isProjectRole(role) ? role : null, "editor")
      ? listDependencyCandidates(
          ctx, taskId,
          membershipRows.map((m) => ({ id: m.project_id, name: m.project.name })),
          treeCandidates,
        )
      : Promise.resolve([]),
    part === "schedule" && task.due_on && task.parent_task_id === null
      ? Promise.all(
          membershipRows.map(async (m) => {
            const entry = (await projectCriticalPath(ctx, m.project_id)).tasks[taskId];
            return entry ? [{ ...entry, projectId: m.project_id, projectName: m.project.name }] : [];
          }),
        ).then((lists) => lists.flat())
      : Promise.resolve([]),
  ]);
  return { dependencyCandidates, schedule };
}

async function loadTaskPaneContext(ctx: ApiContext): Promise<TaskPaneContext | null> {
  const { user, allowlisted } = await getViewer(ctx);
  if (!user || !allowlisted) return null;
  const [projects, profiles, roles, tags] = await Promise.all([listProjects(ctx), listProfiles(ctx), listMyProjectRoles(ctx), listVisibleTags(ctx)]);
  return {
    memberId: user.id,
    projects: projects.map(({ id, name }) => ({ id, name, canAdd: hasRole(roles.get(id), "editor") })),
    profiles,
    tags,
  };
}

export async function loadTaskPanePayload(ctx: ApiContext, taskId: string, withContext = true): Promise<TaskPanePayload> {
  const loadedAt = Date.now();
  const [task, context] = await Promise.all([
    isUuid(taskId) ? getTaskDetail(ctx, taskId) : Promise.resolve(null),
    withContext ? loadTaskPaneContext(ctx) : Promise.resolve(null),
  ]);
  return { task, context, loadedAt };
}

const MAX_DEPENDENCY_CANDIDATES = 300;

const MAX_OTHER_CANDIDATE_PROJECTS = 10;

const MAX_OTHER_PROJECT_CANDIDATES = 100;

// Tasks the viewer can link to: the same task tree (other subtasks / the parent), active tasks of the
// task's projects where the viewer is an Editor, then of up to 10 other projects they edit (cross-project
// links need Editor on both tasks, which set_task_dependency checks again).
async function listDependencyCandidates(
  ctx: ApiContext, taskId: string,
  projects: { id: string; name: string }[],
  tree: { id: string; title: string }[],
): Promise<DependencyCandidateGroup[]> {
  const supabase = ctx.db;
  const roles = await listMyProjectRoles(ctx);
  const own = projects.filter((p) => hasRole(roles.get(p.id), "editor"));
  const ownIds = new Set(projects.map((p) => p.id));
  const otherIds = [...roles.entries()]
    .filter(([projectId, role]) => !ownIds.has(projectId) && hasRole(role, "editor"))
    .map(([projectId]) => projectId);
  const others = otherIds.length
    ? rows(
        await supabase
          .from("projects")
          .select("id, name")
          .in("id", otherIds)
          .is("deleted_at", null)
          .order("name")
          .limit(MAX_OTHER_CANDIDATE_PROJECTS),
        "projects",
      )
    : [];
  const all = [...own, ...others];
  const memberships = all.length
    ? rows(
        await supabase
          .from("task_projects")
          .select("project_id, task:tasks!inner(id, title, completed_at)")
          .in(
            "project_id",
            all.map((p) => p.id),
          )
          .is("deleted_at", null)
          .is("task.deleted_at", null)
          .neq("task_id", taskId)
          .order("sort_order")
          .limit(MAX_DEPENDENCY_CANDIDATES * all.length),
        "dependency candidates",
      )
    : [];
  const groups: DependencyCandidateGroup[] = [];
  const treeGroup: DependencyCandidateGroup = {
    key: "tree",
    label: "This task’s tree",
    tasks: tree.slice(0, MAX_DEPENDENCY_CANDIDATES),
  };
  // Oct 26 notes (batch 4): the task's own projects come first (in the order it was added to them; Oct 29
  // notes, 55b), then its tree, then the other projects the viewer edits.
  for (const p of all) {
    const limit = own.includes(p) ? MAX_DEPENDENCY_CANDIDATES : MAX_OTHER_PROJECT_CANDIDATES;
    if (p === others[0] && treeGroup.tasks.length) groups.push(treeGroup);
    groups.push({
      key: p.id,
      label: own.includes(p) ? p.name : `${p.name} (another project)`,
      tasks: memberships
        .filter((m) => m.project_id === p.id)
        .sort((a, b) => Number(Boolean(a.task.completed_at)) - Number(Boolean(b.task.completed_at)))
        .slice(0, limit)
        .map((m) => ({ id: m.task.id, title: m.task.title, projectName: own.includes(p) ? null : p.name })),
    });
  }
  if (others.length === 0 && treeGroup.tasks.length) groups.push(treeGroup);
  const shown = groups.filter((g) => g.tasks.length > 0);
  // Numbers for every task offered (labels the viewer may see), so the picker shows and searches them. A
  // project's group shows each task's number there; a task it doesn't number shows its first number with
  // that number's own project, so a project's name never sits next to another project's number (Oct 29
  // notes, 55b). The tree's tasks show their first number.
  const ids = shown.flatMap((g) => g.tasks.map((t) => t.id));
  const places = await visibleTaskPlacesOrNull(ctx, ids);
  if (!places) {
    const labels = await firstVisibleNumbers(ctx, ids);
    return shown.map((g) => ({ ...g, tasks: g.tasks.map((t) => ({ ...t, label: labels.get(t.id) ?? null })) }));
  }
  const byId = new Map(all.map((p) => [p.id, p] as const));
  return shown.map((g) => {
    const project = byId.get(g.key);
    return {
      ...g,
      tasks: g.tasks.map((t) => {
        if (!project) return { ...t, label: numberWithItsProject(places.get(t.id)).label };
        const paired = numberWithItsProject(places.get(t.id), { projectId: project.id, projectName: project.name });
        // The task's own projects come without a name (the group's heading says it), unless the number
        // is another project's.
        const named = own.includes(project) ? paired.projectId !== project.id : true;
        return { ...t, label: paired.label, projectName: named ? paired.projectName : null };
      }),
    };
  });
}

// Dependency stories only store the other task's title when every reader of this task can read it
// (dependency_story_data); otherwise fill it in when the viewer can read the other task.
function storyEmailId(data: Json): string | null {
  const value = data && typeof data === "object" && !Array.isArray(data) ? data.email_id : null;
  return typeof value === "string" && isUuid(value) ? value : null;
}

// Live status of the emails behind email_queued stories (email_outbox is readable with the task).
async function storyEmailStatuses(ctx: ApiContext, stories: { kind: string; data: Json }[]): Promise<Map<string, StoryEmailStatus>> {
  const ids = [...new Set(stories.filter((s) => s.kind === "email_queued").map((s) => storyEmailId(s.data)))].filter(
    (id): id is string => Boolean(id),
  );
  if (ids.length === 0) return new Map();
  const supabase = ctx.db;
  const result = await supabase
    .from("email_outbox")
    .select("id, status, last_error, attempts, max_attempts")
    .in("id", ids.slice(0, 200));
  const delivery = await deliveryStatuses(ctx, ids.slice(0, 200));
  return new Map(
    rows(result, "email status").map((e) => [
      e.id,
      {
        status: isEmailStatus(e.status) ? e.status : "pending",
        error: e.status === "failed" || e.status === "pending" ? e.last_error : null,
        attempts: e.attempts,
        maxAttempts: e.max_attempts,
        delivery: delivery.get(e.id) ?? null,
      },
    ]),
  );
}

// What Resend reported for these emails (Real features 3), read through email_outbox's RLS like the rest
// of the row. Empty on a database without the migration (the column doesn't exist there).
export async function deliveryStatuses(ctx: ApiContext, ids: string[]): Promise<Map<string, DeliveryStatus>> {
  if (ids.length === 0) return new Map();
  const supabase = ctx.db;
  const result = await supabase.from("email_outbox").select("id, delivery_status").in("id", ids).not("delivery_status", "is", null);
  if (result.error) return new Map();
  return new Map(
    (result.data ?? []).flatMap((e) => (isDeliveryEvent(e.delivery_status) ? [[e.id, e.delivery_status] as const] : [])),
  );
}

async function withDependencyTitles<T extends { kind: string; data: Json }>(ctx: ApiContext, stories: T[]): Promise<T[]> {
  const isDep = (k: string) => k === "dependency_added" || k === "dependency_removed" || k === "dependency_changed";
  const missing = [
    ...new Set(
      stories.flatMap((st) => {
        const d = st.data;
        if (!isDep(st.kind) || !d || typeof d !== "object" || Array.isArray(d) || typeof d.task_title === "string") return [];
        return typeof d.task_id === "string" ? [d.task_id] : [];
      }),
    ),
  ];
  if (missing.length === 0) return stories;
  const supabase = ctx.db;
  const titles = new Map(
    rows(await supabase.from("tasks").select("id, title").in("id", missing.slice(0, 200)), "tasks").map(
      (t) => [t.id, t.title] as const,
    ),
  );
  return stories.map((st) => {
    const d = st.data;
    if (!isDep(st.kind) || !d || typeof d !== "object" || Array.isArray(d) || typeof d.task_id !== "string") return st;
    const title = titles.get(d.task_id);
    return title && typeof d.task_title !== "string" ? { ...st, data: { ...d, task_title: title } } : st;
  });
}

const ROUND_STATUSES = new Set(["pending", "approved", "changes_requested", "rejected", "withdrawn"]);

// An approval task's approvers, settings, state, and rounds (each with its requests). Null on a database
// without approval rounds.
async function loadApprovalInfo(supabase: Db, taskId: string): Promise<TaskApprovalInfo | null> {
  const [approvers, settings, rounds, requests, state, followUp] = await Promise.all([
    supabase.from("task_approvers").select("profile_id, created_at").eq("task_id", taskId).is("deleted_at", null).order("created_at"),
    supabase.from("task_approval_settings").select("mode, due_on").eq("task_id", taskId).maybeSingle(),
    supabase.from("approval_rounds").select("*").eq("task_id", taskId).order("round_number", { ascending: false }),
    supabase.from("approval_requests").select("*").eq("task_id", taskId).not("round_id", "is", null).is("deleted_at", null).order("created_at"),
    supabase.rpc("task_approval_state", { target_task: taskId }),
    supabase.from("task_approval_settings").select("after_approval, after_section_id, reminders").eq("task_id", taskId).maybeSingle(),
  ]);
  if (approvers.error || rounds.error || state.error) return null;
  const followUpRow = followUp.error ? null : followUp.data;
  const roundRows = rounds.data ?? [];
  const sectionIds = [...new Set(roundRows.map((r) => r.move_section_id).filter((id): id is string => Boolean(id)))];
  const sections = sectionIds.length
    ? ((await supabase.from("sections").select("id, name").in("id", sectionIds)).data ?? [])
    : [];
  const sectionName = new Map(sections.map((sec) => [sec.id, sec.name] as const));
  const byRound = new Map<string, TaskApproval[]>();
  for (const a of requests.data ?? []) {
    if (!a.round_id) continue;
    const list = byRound.get(a.round_id) ?? [];
    list.push({
      id: a.id,
      subtaskId: a.subtask_id,
      approverId: a.approver_id,
      requestedBy: a.requested_by,
      ruleName: null,
      note: a.note,
      status: a.status as TaskApproval["status"],
      decidedAt: a.decided_at,
      decisionNote: a.decision_note,
      createdAt: a.created_at,
      roundId: a.round_id,
      cancelReason: a.cancel_reason,
      handoffTo: a.handoff_to,
      handoffNote: a.handoff_note,
    });
    byRound.set(a.round_id, list);
  }
  const value = state.data && typeof state.data === "object" && !Array.isArray(state.data) ? (state.data as Record<string, Json>) : {};
  return {
    followUp: followUp.error
      ? null
      : {
          afterApproval:
            followUpRow?.after_approval === "complete" || followUpRow?.after_approval === "move_section" || followUpRow?.after_approval === "notify"
              ? followUpRow.after_approval
              : null,
          sectionId: followUpRow?.after_section_id ?? null,
          reminders: followUpRow?.reminders ?? true,
        },
    approverIds: (approvers.data ?? []).map((a) => a.profile_id),
    mode: settings.data?.mode === "all" ? "all" : "any",
    dueOn: settings.data?.due_on ?? null,
    status: parseApprovalTaskStatus(value.status) ?? "not_sent",
    paused: value.paused === true,
    waitingOnMe: value.waiting_on_me === true,
    rounds: roundRows.map((r) => ({
      id: r.id,
      number: r.round_number,
      status: (ROUND_STATUSES.has(r.status) ? r.status : "pending") as ApprovalRound["status"],
      mode: r.mode === "all" ? "all" : "any",
      finalText: r.final_text,
      attachmentIds: r.attachment_ids ?? [],
      moreSteps: r.more_steps,
      afterApproval: (r.after_approval === "move_section" || r.after_approval === "notify" ? r.after_approval : "complete") as AfterApproval,
      moveSectionId: r.move_section_id,
      moveSectionName: r.move_section_id ? (sectionName.get(r.move_section_id) ?? null) : null,
      dueOn: r.due_on,
      sentBy: r.sent_by,
      sentAt: r.sent_at,
      decidedBy: r.decided_by,
      decidedAt: r.decided_at,
      acknowledgedAt: r.acknowledged_at,
      withdrawnAt: r.withdrawn_at,
      requests: byRound.get(r.id) ?? [],
    })),
  };
}

export async function loadSubmitterConversation(ctx: ApiContext, taskId: string): Promise<SubmitterConversation | null> {
  const supabase = ctx.db;
  const { data, error } = await supabase.rpc("submitter_conversation_status", { target_task: taskId });
  if (error || !data || typeof data !== "object" || Array.isArray(data)) return null;
  return parseSubmitterConversation(data as Record<string, Json | undefined>);
}

const RUN_STATUSES = ["succeeded", "scheduled", "skipped", "failed"] as const;

// The task's automation runs (rule_runs: RLS shows runs of automations in projects the viewer can read)
// and what came in by email (task_email_activity: read with the task). Both read with the viewer's own
// client; a database without this release's update has no email activity (an empty list).
async function loadTaskAutomationAndEmail(
  supabase: Db,
  taskId: string,
  preRead?: { runs: Json | undefined; email: Json | undefined },
): Promise<{ runs: TaskRuleRun[]; email: TaskEmailActivity[]; ruleProjects: Map<string, string> }> {
  type RunRow = { id: string; rule_id: string; status: string; detail: Json; created_at: string; rule: { name: string; project_id: string } | null };
  type EmailRow = { id: string; kind: string; sender_email: string; sender_profile_id: string | null; subject: string | null; comment_id: string | null; created_at: string };
  const [runs, email] = preRead
    ? [
        { data: (Array.isArray(preRead.runs) ? preRead.runs : []) as unknown as RunRow[], error: null },
        { data: (Array.isArray(preRead.email) ? preRead.email : []) as unknown as EmailRow[], error: null },
      ]
    : await Promise.all([
    supabase
      .from("rule_runs")
      .select("id, rule_id, status, detail, created_at, rule:rules(name, project_id)")
      .eq("task_id", taskId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(TASK_RUN_LIMIT),
    supabase
      .from("task_email_activity")
      .select("id, kind, sender_email, sender_profile_id, subject, comment_id, created_at")
      .eq("task_id", taskId)
      .order("created_at")
      .limit(200),
  ]);
  if (runs.error) console.error(`[rules] couldn't load a task's automation runs: ${runs.error.message}`);
  const ruleProjects = new Map<string, string>();
  const ruleRuns = (runs.error ? [] : (runs.data ?? []))
    .flatMap((r): TaskRuleRun[] => {
      const rule = Array.isArray(r.rule) ? r.rule[0] : r.rule;
      if (!rule || !(RUN_STATUSES as readonly string[]).includes(r.status)) return [];
      ruleProjects.set(r.rule_id, rule.project_id);
      const detail = r.detail && typeof r.detail === "object" && !Array.isArray(r.detail) ? r.detail : {};
      const reason = r.status === "failed" ? runReason(r.detail) : typeof detail.reason === "string" ? detail.reason : null;
      return [
        {
          id: r.id,
          ruleId: r.rule_id,
          ruleName: rule.name,
          projectId: rule.project_id,
          status: r.status as TaskRuleRun["status"],
          reason,
          createdAt: r.created_at,
          partial: partialOf(r.status, r.detail),
        },
      ];
    })
    .reverse();
  const emailRows = email.error ? [] : (email.data ?? []);
  return {
    runs: ruleRuns,
    ruleProjects,
    email: emailRows.flatMap((e): TaskEmailActivity[] =>
      e.kind === "task_created" || e.kind === "comment_added"
        ? [
            {
              id: e.id,
              kind: e.kind,
              senderEmail: e.sender_email,
              senderProfileId: e.sender_profile_id,
              subject: e.subject,
              commentId: e.comment_id,
              createdAt: e.created_at,
            },
          ]
        : [],
    ),
  };
}

// Automation comments learn their automation's project (for the "Automation · <name>" link) — from the
// task's runs when they're there, else from the automations the viewer can read.
export async function withRuleProjects(
  supabase: Db,
  comments: TaskComment[],
  known: Map<string, string> = new Map(),
): Promise<TaskComment[]> {
  const missing = [
    ...new Set(comments.flatMap((c) => (c.ruleId && !known.has(c.ruleId) ? [c.ruleId] : []))),
  ];
  const projects = new Map(known);
  if (missing.length) {
    const result = await supabase.from("rules").select("id, project_id").in("id", missing.slice(0, 200));
    for (const rule of result.error ? [] : (result.data ?? [])) projects.set(rule.id, rule.project_id);
  }
  return comments.map((c) => (c.ruleId ? { ...c, ruleProjectId: projects.get(c.ruleId) ?? null } : c));
}
