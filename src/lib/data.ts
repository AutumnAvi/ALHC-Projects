import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { displayName } from "@/components/avatar";
import { getViewer } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/ids";
import { parseColumnWidths, type ColumnWidths } from "@/lib/column-widths";
import { isFieldType, parseOptions, type FieldDef, type FieldOption, type FieldType, type LibraryField } from "@/lib/fields";
import { parseQuestions, type FormDef, type PublicForm } from "@/lib/forms";
import {
  parsePresetInputs,
  toRuleDef,
  type RuleDef,
  type RulePreset,
  type RuleRun,
} from "@/lib/rules";
import { parseRecurrence, type Recurrence } from "@/lib/recurrence";
import { isReactionKey, REACTIONS, type ReactionKey } from "@/lib/reactions";
import { commentEmailStatus, parseCommentEmail, type CommentEmail } from "@/lib/comment-email";
import {
  isDeliveryStatus,
  toProjectIntegrations,
  type EmailDelivery,
  type IntegrationDelivery,
  type ProjectIntegrations,
} from "@/lib/integrations-shared";
import {
  PROJECT_ROLES as ROLE_ORDER,
  hasRole,
  isPortfolioRole,
  isProjectRole,
  type PortfolioRole,
  type ProjectRole,
} from "@/lib/roles";
import { EMPTY_COUNTS, isPortfolioFieldType, type PortfolioCounts, type PortfolioFieldType } from "@/lib/portfolios";
import type { CriticalPath, TaskSchedule } from "@/lib/critical-path";
import { parseDependencyKind, type DependencyKind } from "@/lib/dependencies";
import { parseSubtaskTitles, parseTemplateSummary, type TemplateSummary } from "@/lib/templates";
import {
  MY_TASKS_LAYOUT_COOKIE,
  isMyTaskSectionKind,
  isMyTasksLayout,
  type MyTaskPlacement,
  type MyTaskSection,
  type MyTasksLayout,
} from "@/lib/my-tasks";
import type { WorkloadTask } from "@/lib/workload";
import {
  isGoalStatus,
  isProgressMode,
  type Goal,
  type GoalProgress,
  type GoalStatus,
  type GoalViewer,
} from "@/lib/goals";
import {
  TEAM_CALENDAR_LIMIT,
  isTeamRole,
  type CuratedWorkItem,
  type TeamCalendarTask,
  type TeamRole,
} from "@/lib/teams";
import { INBOX_LIMIT, type InboxTab } from "@/lib/inbox";
import { resolveNotificationSettings, type NotificationSettings } from "@/lib/notifications";
import {
  DEFAULT_EMAIL_PREFERENCES,
  isDeliveryEvent,
  isDigestFrequency,
  isReportKind,
  isScheduleFrequency,
  type DeliveryStatus,
  type EmailPreferences,
  type ReportSchedule,
} from "@/lib/email-schedules";
import { PROFILE_ACTIVITY_LIMIT, PROFILE_TASK_LIMIT } from "@/lib/people";
import {
  WORKSPACE_ASSETS_BUCKET,
  isProjectVisibility,
  type BrowseProject,
  type InviteEmailStatus,
  type PendingInvite,
  type WorkspaceMember,
} from "@/lib/workspace";
import { toTag, type Tag } from "@/lib/tags";
import { isCalendarFeedScope, type CalendarFeed } from "@/lib/calendar-feeds";
import { toStatusTemplate, type StatusTemplate } from "@/lib/status-templates";
import type { Json, Tables } from "@/lib/supabase/database.types";
import { isInboundCallStatus, type InboundCall, type InboundEndpoint } from "@/lib/inbound-shared";
import {
  approvalTaskRequest,
  parseApprovalTaskStatus,
  parseTaskKind,
  type ApprovalTaskStatus,
  type TaskKind,
} from "@/lib/task-kinds";
import {
  isPersonalWidgetKind,
  isSeriesInterval,
  parseReportFilters,
  reportFiltersJson,
  type PersonalDashboard,
  type PersonalWidget,
  type ReportFilters,
  type SeriesInterval,
} from "@/lib/reports";
import {
  isViewLayout,
  isWidgetKind,
  parseFilters,
  parseViewConfig,
  toJson,
  type DashboardWidget,
  type ProjectView,
  type ViewFilters,
  type ViewSort,
} from "@/lib/views";

// Every read in the app goes through this module, and every query here filters deleted_at IS NULL —
// except listTrashedTasks(), which reads soft-deleted tasks for the Trash page on purpose. RLS keeps
// soft-deleted rows readable (trashed tasks: Editors and above only) so restore stays possible.

export type Project = Pick<
  Tables<"projects">,
  | "id"
  | "name"
  | "description"
  | "sort_order"
  | "approval_completes_task"
  | "status"
  | "status_note"
  | "status_updated_at"
  | "status_updated_by"
  | "archived_at"
  | "team_id"
  | "visibility"
>;

const PROJECT_COLUMNS =
  "id, name, description, sort_order, approval_completes_task, status, status_note, status_updated_at, status_updated_by, archived_at, team_id, visibility";
export type Section = Pick<Tables<"sections">, "id" | "project_id" | "name" | "sort_order">;
export type Profile = Pick<Tables<"profiles">, "id" | "email" | "full_name" | "avatar_url">;

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
  // Incomplete finish-to-start predecessors the task is waiting on (that the viewer can read).
  blockedBy: number;
  kind: TaskKind;
  // Approval tasks: the status of the assignee's request (null: none yet, or not an approval task).
  approvalStatus: ApprovalTaskStatus | null;
  // Active tag links (ids; look names and colors up in listTags()).
  tagIds: string[];
  // Comments on the task (not deleted), for the speech-bubble count on List rows and Board cards.
  commentCount: number;
};

export type TaskMembership = {
  projectId: string;
  projectName: string;
  sectionId: string | null;
  isHome: boolean;
  sections: Pick<Section, "id" | "name">[];
};

export type TaskDetail = {
  id: string;
  title: string;
  kind: TaskKind;
  notes: string | null;
  completedAt: string | null;
  startOn: string | null;
  dueOn: string | null;
  startAt: string | null;
  dueAt: string | null;
  timeZone: string | null;
  recurrence: Recurrence | null;
  recurrenceSeq: number;
  // The occurrence spawned when this one was completed (if it still exists).
  nextOccurrenceId: string | null;
  dependencies: TaskDependency[];
  // Incomplete finish-to-start predecessors the viewer can't open (they still block completion).
  hiddenBlockers: number;
  // Tasks that can be linked: active tasks of projects where the viewer is an Editor (the task's own
  // projects first, then others), plus the other tasks and subtasks of the same task tree.
  dependencyCandidates: DependencyCandidateGroup[];
  // Projects (with sections) where the viewer is an Editor among the task's projects (a subtask: its root's).
  editableProjectIds: string[];
  // Slack / critical path in each of the task's projects (project_critical_path); empty without a due date.
  schedule: (TaskSchedule & { projectId: string; projectName: string })[];
  assigneeId: string | null;
  // Null for a private task (and its subtasks): no project; only its creator and assignee can read it.
  homeProjectId: string | null;
  createdAt: string;
  updatedAt: string;
  source: string;
  requestLabel: string | null;
  canAssignRequestNumber: boolean;
  submission: { email: string; formId: string; formTitle: string | null; createdAt: string } | null;
  // The database has Comments and reply by email (20261014030000): responses to a form's submitter can
  // be sent (see canRespondToSubmitter()).
  submitterResponses: boolean;
  approvals: TaskApproval[];
  // Direct subtasks, in order.
  subtasks: SubtaskItem[];
  // Set for a subtask: its parent, and the way up from the top-level task (root first) for the breadcrumb.
  parentTaskId: string | null;
  ancestors: { id: string; title: string; completedAt: string | null }[];
  // A subtask's memberships are its root task's (read-only in its pane: subtasks never have their own).
  isSubtask: boolean;
  memberships: TaskMembership[];
  fields: FieldDef[];
  fieldValues: Record<string, Json>;
  followerIds: string[];
  attachments: TaskAttachment[];
  // Attachments that stayed in Asana (imported as name + link, no file copy).
  attachmentLinks: TaskAttachmentLink[];
  comments: TaskComment[];
  // Non-deleted comments on the task (the Comments tab). `comments` is the newest page.
  commentTotal: number;
  // Set when an older page exists. The pane passes it to loadOlderComments.
  olderComments: { beforeAt: string; beforeId: string } | null;
  stories: TaskStory[];
  // The viewer's highest role across the task's projects (null: read access through nothing).
  viewerRole: ProjectRole | null;
  // Best role of each member of the task's visible projects: who can be assigned, follow, approve.
  memberRoles: Record<string, ProjectRole>;
  tagIds: string[];
  // People who liked the task, oldest first.
  likeProfileIds: string[];
  // A private task (no project; for a subtask: its top-level task is private). Only its top-level task's
  // creator and assignee (privateReaderIds) can read it, so only they can be assigned or follow.
  isPrivate: boolean;
  privateReaderIds: string[];
};

export type TaskDependency = {
  id: string;
  // blocked_by: the other task comes first; blocking: the other task waits on this one.
  relation: "blocked_by" | "blocking";
  kind: DependencyKind;
  lagDays: number;
  taskId: string;
  title: string;
  completedAt: string | null;
  // The other task is a subtask (it has no projects of its own).
  isSubtask: boolean;
};

export type DependencyCandidateGroup = { key: string; label: string; tasks: { id: string; title: string }[] };

// Imported Asana attachments (name + link), and a duplicated task's links to the original's files
// (attachmentId: opened through /attachments/<id>, which checks access to the original).
export type TaskAttachmentLink = { id: string; source: string; name: string; url: string | null; attachmentId: string | null };

export type TaskAttachment = {
  id: string;
  fileName: string;
  contentType: string | null;
  sizeBytes: number;
  uploadedBy: string;
  createdAt: string;
};

export type TaskApproval = {
  id: string;
  subtaskId: string | null;
  approverId: string;
  requestedBy: string | null;
  ruleName: string | null;
  note: string | null;
  status: "pending" | "approved" | "changes_requested" | "rejected" | "cancelled";
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
};

export type TaskComment = {
  id: string;
  authorId: string | null;
  ruleName: string | null;
  // Empty for a deleted comment (shown as a "Comment deleted" placeholder).
  body: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  mentionIds: string[];
  // Active reactions, in the fixed REACTIONS order; only emoji someone used.
  reactions: { emoji: ReactionKey; profileIds: string[] }[];
  // A response emailed to the form's submitter, or the submitter's emailed reply (no author).
  email: CommentEmail | null;
};

export type TaskStory = {
  id: string;
  actorId: string | null;
  kind: string;
  data: Json;
  createdAt: string;
  // email_queued stories: the email's live delivery state (null when the row is gone, e.g. purged).
  email?: StoryEmailStatus | null;
};

export type StoryEmailStatus = {
  status: "pending" | "sending" | "sent" | "mocked" | "failed";
  error: string | null;
  attempts: number;
  maxAttempts: number;
  // What Resend reported after sending (Real features 3; null before anything was reported).
  delivery?: DeliveryStatus | null;
};

const EMAIL_STATUSES = ["pending", "sending", "sent", "mocked", "failed"] as const;
function isEmailStatus(value: string): value is StoryEmailStatus["status"] {
  return (EMAIL_STATUSES as readonly string[]).includes(value);
}

type QueryResult<T> = { data: T; error: { message: string } | null };

function maybe<T>(result: QueryResult<T>, what: string): T {
  if (result.error) throw new Error(`Failed to load ${what}: ${result.error.message}`);
  return result.data;
}

function rows<T>(result: QueryResult<T[] | null>, what: string): T[] {
  return maybe(result, what) ?? [];
}

export type Workspace = {
  id: string;
  name: string;
  defaultTeamId: string | null;
  logoPath: string | null;
  // Public URL of the logo (the workspace-assets bucket is public), or null.
  logoUrl: string | null;
  emailSenderName: string | null;
};

export const getWorkspace = cache(async (): Promise<Workspace | null> => {
  const supabase = await createClient();
  const result = await supabase
    .from("workspaces")
    .select("id, name, default_team_id, logo_path, email_sender_name")
    .is("deleted_at", null)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  const row = maybe(result, "workspace");
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    defaultTeamId: row.default_team_id,
    logoPath: row.logo_path,
    logoUrl: row.logo_path ? supabase.storage.from(WORKSPACE_ASSETS_BUCKET).getPublicUrl(row.logo_path).data.publicUrl : null,
    emailSenderName: row.email_sender_name,
  };
});

// Active projects the viewer can read: the sidebar, Home, and every project picker. Archived projects
// are left out (listArchivedProjects); listReadableProjects has both, for labelling tasks.
export const listProjects = cache(async (): Promise<Project[]> =>
  (await listReadableProjects()).filter((p) => p.archived_at === null),
);

// Starred projects (Asana parity, batch 1): the viewer's own stars, oldest first (RLS: own rows only).
// The sidebar keeps the ones it can also read (listProjects), so a star on a project the viewer lost, or
// one that was archived or deleted, shows nothing. A missing table (a preview deployed before its
// migration is applied) reads as no stars rather than breaking the app shell.
export const listStarredProjectIds = cache(async (): Promise<string[]> => {
  const supabase = await createClient();
  const result = await supabase.from("project_stars").select("project_id").is("deleted_at", null).order("starred_at");
  if (result.error) {
    console.error(`[stars] couldn't load starred projects: ${result.error.message}`);
    return [];
  }
  return (result.data ?? []).map((row) => row.project_id);
});

export const listArchivedProjects = cache(async (): Promise<Project[]> =>
  (await listReadableProjects())
    .filter((p) => p.archived_at !== null)
    .sort((a, b) => b.archived_at!.localeCompare(a.archived_at!)),
);

export const listReadableProjects = cache(async (): Promise<Project[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("projects")
    .select(PROJECT_COLUMNS)
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  return rows(result, "projects");
});

export const getProject = cache(async (projectId: string): Promise<Project | null> => {
  const supabase = await createClient();
  const result = await supabase
    .from("projects")
    .select(PROJECT_COLUMNS)
    .eq("id", projectId)
    .is("deleted_at", null)
    .maybeSingle();
  return maybe(result, "project");
});

// The viewer's role in a project, or null when they are not a member.
export const getProjectRole = cache(async (projectId: string): Promise<ProjectRole | null> => {
  const supabase = await createClient();
  const role = maybe(await supabase.rpc("project_role", { target_project: projectId }), "project role");
  return isProjectRole(role) ? role : null;
});

// The viewer's effective role in every project they belong to: archived projects count as Viewer
// (read-only for everyone, like project_role() in the database).
export const listMyProjectRoles = cache(async (): Promise<Map<string, ProjectRole>> => {
  const [own, projects] = await Promise.all([listOwnProjectRoles(), listReadableProjects()]);
  const archived = new Set(projects.filter((p) => p.archived_at !== null).map((p) => p.id));
  return new Map([...own].map(([projectId, role]) => [projectId, archived.has(projectId) ? "viewer" : role] as const));
});

// The viewer's own membership role, archived or not (who may archive / unarchive: Admin+).
export const listOwnProjectRoles = cache(async (): Promise<Map<string, ProjectRole>> => {
  const { user } = await getViewer();
  if (!user) return new Map();
  const supabase = await createClient();
  const result = await supabase
    .from("project_members")
    .select("project_id, role")
    .eq("profile_id", user.id)
    .is("deleted_at", null);
  return new Map(
    rows(result, "project roles")
      .filter((m) => isProjectRole(m.role))
      .map((m) => [m.project_id, m.role as ProjectRole] as const),
  );
});

export type ProjectMember = {
  profileId: string;
  role: ProjectRole;
  // Full name, else the email (displayName()).
  name: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  addedAt: string;
};

export const listProjectMembers = cache(async (projectId: string): Promise<ProjectMember[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("project_members")
    .select(
      "profile_id, role, created_at, profile:profiles!project_members_profile_id_fkey!inner(email, full_name, avatar_url)",
    )
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("created_at");
  return rows(result, "members")
    .filter((m) => isProjectRole(m.role))
    .map((m) => ({
      profileId: m.profile_id,
      role: m.role as ProjectRole,
      name: displayName(m.profile),
      email: m.profile.email,
      fullName: m.profile.full_name,
      avatarUrl: m.profile.avatar_url,
      addedAt: m.created_at,
    }));
});

// People in the workspace: profiles whose address is still on the allowlist (removed people left out).
// The search palette's People and the Share dialog's invite search.
export const listActivePeople = cache(async (): Promise<{ id: string; name: string; email: string }[]> => {
  const supabase = await createClient();
  const [profiles, allowed] = await Promise.all([
    listProfiles(),
    supabase.from("allowed_emails").select("email").is("removed_at", null),
  ]);
  if (allowed.error) return [];
  const active = new Set((allowed.data ?? []).map((row) => row.email.toLowerCase()));
  return profiles
    .filter((p) => active.has(p.email.toLowerCase()))
    .map((p) => ({ id: p.id, name: displayName(p), email: p.email }));
});

export const listProfiles = cache(async (): Promise<Profile[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("profiles")
    .select("id, email, full_name, avatar_url")
    .order("full_name");
  return rows(result, "people");
});

export const listSections = cache(async (projectId: string): Promise<Section[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("sections")
    .select("id, project_id, name, sort_order")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  return rows(result, "sections");
});

function rpcMissing(error: { code?: string } | null | undefined) {
  return error?.code === "PGRST202" || error?.code === "42883";
}

function projectTasksFromCards(data: Json): ProjectTask[] {
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
      kind: parseTaskKind(card.kind),
      approvalStatus: parseApprovalTaskStatus(card.approval_status),
      tagIds: Array.isArray(card.tag_ids) ? card.tag_ids.filter((tagId): tagId is string => typeof tagId === "string") : [],
      commentCount: typeof card.comment_count === "number" ? card.comment_count : 0,
    });
  }
  return tasks;
}

// Calendar and Timeline tasks for one date window (project_schedule_cards). Null when that
// function is not there yet: the caller keeps the full project_task_cards list.
export const listProjectSchedule = cache(
  async (
    projectId: string,
    filters: ViewFilters,
    timeZone: string,
    range: { start: string; end: string } | null,
    schedule: "calendar" | "timeline",
  ): Promise<ProjectTask[] | null> => {
    const supabase = await createClient();
    const result = await supabase.rpc("project_schedule_cards", {
      target_project: projectId,
      filters: toJson(filters),
      tz: timeZone,
      range_start: range?.start ?? null,
      range_end: range?.end ?? null,
      schedule,
    });
    if (rpcMissing(result.error)) return null;
    if (result.error) throw new Error(`Failed to load tasks: ${result.error.message}`);
    return projectTasksFromCards(result.data);
  },
);

// One read for the cards a project view draws (project_task_cards). A database without that
// function falls back to the row queries.
export const listProjectTasks = cache(async (projectId: string): Promise<ProjectTask[]> => {
  const supabase = await createClient();
  const cards = await supabase.rpc("project_task_cards", { target_project: projectId });
  if (!cards.error) return projectTasksFromCards(cards.data);
  if (rpcMissing(cards.error)) return listProjectTasksFromRows(projectId);
  throw new Error(`Failed to load tasks: ${cards.error.message}`);
});

// One page of cards per group (project_task_card_page). Null when that function is not
// there yet: the caller keeps the full project_task_cards list.
export type ProjectTaskGroupPage = {
  key: string;
  total: number;
  nextId: string | null;
  nextSortOrder: number | null;
  tasks: ProjectTask[];
};

export const listProjectTaskPage = cache(
  async (
    projectId: string,
    filters: ViewFilters,
    timeZone: string,
    groupBy: string,
    sorts: ViewSort[],
    pageSize: number,
    limits: Record<string, number>,
  ): Promise<ProjectTaskGroupPage[] | null> => {
    const supabase = await createClient();
    const result = await supabase.rpc("project_task_card_page", {
      target_project: projectId,
      filters: toJson(filters),
      tz: timeZone,
      group_by: groupBy,
      sorts: sorts as Json,
      page_size: pageSize,
      limits: limits as Json,
    });
    if (rpcMissing(result.error)) return null;
    if (result.error) throw new Error(`Failed to load tasks: ${result.error.message}`);
    if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) return [];
    const groups = (result.data as { groups?: Json }).groups;
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
  },
);

// Active tasks per section, including ones the current view hides (delete-section checks).
// Null when the function is not there yet; the page then counts the tasks it already loaded.
export const listSectionTaskCounts = cache(async (projectId: string): Promise<Record<string, number> | null> => {
  const supabase = await createClient();
  const result = await supabase.rpc("project_section_task_counts", { target_project: projectId });
  if (rpcMissing(result.error)) return null;
  if (result.error) throw new Error(`Failed to load section counts: ${result.error.message}`);
  if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) return {};
  const counts: Record<string, number> = {};
  for (const [sectionId, count] of Object.entries(result.data)) {
    if (typeof count === "number") counts[sectionId] = count;
  }
  return counts;
});

async function listProjectTasksFromRows(projectId: string): Promise<ProjectTask[]> {
  const supabase = await createClient();
  const memberships = rows(
    await supabase
      .from("task_projects")
      .select(
        "section_id, sort_order, task:tasks!inner(id, title, completed_at, start_on, due_on, assignee_id, home_project_id, created_at, recurrence, kind)",
      )
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .is("task.deleted_at", null)
      .order("sort_order"),
    "tasks",
  );

  const taskIds = memberships.map((m) => m.task.id);
  if (taskIds.length === 0) return [];

  const approvalTaskIds = memberships.filter((m) => m.task.kind === "approval").map((m) => m.task.id);
  const [subtasks, otherMemberships, values, blockers, approvalRequests, tagIds, commentCounts] = await Promise.all([
    supabase
      .from("tasks")
      .select("parent_task_id, completed_at")
      .in("parent_task_id", taskIds)
      .is("deleted_at", null),
    supabase
      .from("task_projects")
      .select("task_id, project:projects!inner(id)")
      .in("task_id", taskIds)
      .is("deleted_at", null)
      .is("project.deleted_at", null),
    supabase
      .from("task_field_values")
      .select("task_id, field_id, value, field:custom_fields!inner(project_id)")
      .in("task_id", taskIds)
      .eq("field.project_id", projectId)
      .is("field.deleted_at", null)
      .not("value", "is", null),
    supabase
      .from("task_dependencies")
      .select("successor_id, predecessor:tasks!task_dependencies_predecessor_id_fkey!inner(id)")
      .in("successor_id", taskIds)
      .eq("kind", "finish_to_start")
      .is("deleted_at", null)
      .is("predecessor.deleted_at", null)
      .is("predecessor.completed_at", null),
    approvalTaskIds.length
      ? supabase
          .from("approval_requests")
          .select("task_id, subtask_id, approver_id, status, created_at")
          .in("task_id", approvalTaskIds)
          .is("subtask_id", null)
          .is("deleted_at", null)
          .neq("status", "cancelled")
      : Promise.resolve({ data: [], error: null }),
    listTaskTagIds(taskIds),
    listCommentCounts(taskIds),
  ]);

  const approvalsByTask = new Map<string, { subtaskId: string | null; approverId: string; status: string; createdAt: string }[]>();
  for (const a of rows(approvalRequests, "approvals")) {
    const list = approvalsByTask.get(a.task_id) ?? [];
    list.push({ subtaskId: a.subtask_id, approverId: a.approver_id, status: a.status, createdAt: a.created_at });
    approvalsByTask.set(a.task_id, list);
  }

  const blockedBy = new Map<string, number>();
  for (const d of rows(blockers, "dependencies")) {
    blockedBy.set(d.successor_id, (blockedBy.get(d.successor_id) ?? 0) + 1);
  }

  const fieldValues = new Map<string, Record<string, Json>>();
  for (const v of rows(values, "field values")) {
    const record = fieldValues.get(v.task_id) ?? {};
    record[v.field_id] = v.value;
    fieldValues.set(v.task_id, record);
  }

  const subtaskStats = new Map<string, { total: number; done: number }>();
  for (const s of rows(subtasks, "subtasks")) {
    if (!s.parent_task_id) continue;
    const stat = subtaskStats.get(s.parent_task_id) ?? { total: 0, done: 0 };
    stat.total += 1;
    if (s.completed_at) stat.done += 1;
    subtaskStats.set(s.parent_task_id, stat);
  }

  const projectCounts = new Map<string, number>();
  for (const m of rows(otherMemberships, "task projects")) {
    projectCounts.set(m.task_id, (projectCounts.get(m.task_id) ?? 0) + 1);
  }

  return memberships.map((m) => ({
    id: m.task.id,
    title: m.task.title,
    completedAt: m.task.completed_at,
    startOn: m.task.start_on,
    dueOn: m.task.due_on,
    assigneeId: m.task.assignee_id,
    homeProjectId: m.task.home_project_id ?? projectId,
    createdAt: m.task.created_at,
    sectionId: m.section_id,
    sortOrder: m.sort_order,
    subtaskCount: subtaskStats.get(m.task.id)?.total ?? 0,
    subtaskDoneCount: subtaskStats.get(m.task.id)?.done ?? 0,
    projectCount: projectCounts.get(m.task.id) ?? 1,
    fieldValues: fieldValues.get(m.task.id) ?? {},
    recurring: m.task.recurrence !== null,
    blockedBy: blockedBy.get(m.task.id) ?? 0,
    kind: parseTaskKind(m.task.kind),
    approvalStatus: parseApprovalTaskStatus(
      approvalTaskRequest(parseTaskKind(m.task.kind), m.task.assignee_id, approvalsByTask.get(m.task.id) ?? [])?.status,
    ),
    tagIds: tagIds.get(m.task.id) ?? [],
    commentCount: commentCounts.get(m.task.id) ?? 0,
  }));
}

// Comments per task the viewer can read, not deleted: one grouped count in SQL (task_comment_counts,
// invoker, so comments RLS decides). A preview deployed before 20261011020000_asana_parity_2.sql shows no
// counts rather than failing the page.
export async function listCommentCounts(taskIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (taskIds.length === 0) return counts;
  const supabase = await createClient();
  const result = await supabase.rpc("task_comment_counts", { task_ids: taskIds });
  if (result.error) {
    console.error(`[comments] couldn't count comments: ${result.error.message}`);
    return counts;
  }
  for (const row of result.data ?? []) counts.set(row.task_id, Number(row.comment_count));
  return counts;
}

const COMMENT_PAGE_SIZE = 100;

export type CommentPage = {
  comments: TaskComment[];
  hasMore: boolean;
  total: number;
};

function commentFromPageRow(
  row: Record<string, Json | undefined>,
  outbox: Map<string, { status: CommentEmail["status"]; error: string | null }>,
): TaskComment | null {
  if (typeof row.id !== "string" || typeof row.created_at !== "string") return null;
  const deleted = row.deleted_at != null;
  const byEmoji = new Map<ReactionKey, string[]>();
  if (!deleted && Array.isArray(row.reactions)) {
    const reactions = row.reactions.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const reaction = item as Record<string, Json | undefined>;
      return [
        {
          emoji: reaction.emoji,
          profileId: reaction.profile_id,
          at: typeof reaction.created_at === "string" ? reaction.created_at : "",
        },
      ];
    });
    reactions.sort((a, b) => a.at.localeCompare(b.at));
    for (const reaction of reactions) {
      if (!isReactionKey(reaction.emoji) || typeof reaction.profileId !== "string") continue;
      const ids = byEmoji.get(reaction.emoji) ?? [];
      ids.push(reaction.profileId);
      byEmoji.set(reaction.emoji, ids);
    }
  }
  const emailBase = deleted
    ? null
    : parseCommentEmail({
        email_direction: typeof row.email_direction === "string" ? row.email_direction : null,
        email_address: typeof row.email_address === "string" ? row.email_address : null,
        email_subject: typeof row.email_subject === "string" ? row.email_subject : null,
      });
  const sent = emailBase?.direction === "sent" ? outbox.get(row.id) : undefined;
  const ruleId = typeof row.rule_id === "string" ? row.rule_id : null;
  return {
    id: row.id,
    authorId: typeof row.author_id === "string" ? row.author_id : null,
    ruleName: ruleId ? (typeof row.rule_name === "string" ? row.rule_name : "Rule") : null,
    body: deleted ? "" : typeof row.body === "string" ? row.body : "",
    createdAt: row.created_at,
    editedAt: deleted || typeof row.edited_at !== "string" ? null : row.edited_at,
    deleted,
    mentionIds:
      deleted || !Array.isArray(row.mention_ids)
        ? []
        : row.mention_ids.filter((profileId): profileId is string => typeof profileId === "string"),
    reactions: REACTIONS.map(({ key }) => ({ emoji: key, profileIds: byEmoji.get(key) ?? [] })).filter(
      (reaction) => reaction.profileIds.length > 0,
    ),
    email: emailBase ? { ...emailBase, status: sent?.status ?? null, error: sent?.error ?? null } : null,
  };
}

function parseCommentPage(
  data: Json,
  outbox: Map<string, { status: CommentEmail["status"]; error: string | null }>,
): CommentPage {
  const root = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, Json | undefined>) : {};
  const raw = Array.isArray(root.comments) ? root.comments : [];
  const comments = raw.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const comment = commentFromPageRow(item as Record<string, Json | undefined>, outbox);
    return comment ? [comment] : [];
  });
  return {
    comments,
    hasMore: root.has_more === true,
    total: typeof root.total === "number" ? root.total : comments.filter((comment) => !comment.deleted).length,
  };
}

function olderCursor(page: CommentPage): { beforeAt: string; beforeId: string } | null {
  const oldest = page.comments[0];
  if (!page.hasMore || !oldest) return null;
  return { beforeAt: oldest.createdAt, beforeId: oldest.id };
}

// Newest page of a task's comments (task_comment_page), with sent-response status filled from the outbox.
// Null when that function is not on the database yet.
export async function loadTaskCommentPage(
  taskId: string,
  before?: { at: string; id: string } | null,
): Promise<CommentPage | null> {
  const supabase = await createClient();
  const result = await supabase.rpc("task_comment_page", {
    target_task: taskId,
    before_at: before?.at ?? null,
    before_id: before?.id ?? null,
    max_results: COMMENT_PAGE_SIZE,
  });
  if (result.error) {
    if (rpcMissing(result.error)) return null;
    throw new Error(`Failed to load comments: ${result.error.message}`);
  }
  const responseEmails = await supabase
    .from("email_outbox")
    .select("status, delivery_status, last_error, comment_id:payload->>comment_id")
    .eq("task_id", taskId)
    .eq("payload->>kind", "submitter_response")
    .order("created_at");
  const outbox = new Map(
    (responseEmails.error ? [] : (responseEmails.data ?? [])).map((row) => [
      String(row.comment_id),
      {
        status: commentEmailStatus(row),
        error: row.status === "failed" ? (typeof row.last_error === "string" ? row.last_error.slice(0, 200) : null) : null,
      },
    ]),
  );
  return parseCommentPage(result.data, outbox);
}

// ---------------------------------------------------------------------------------------------
// Tags (workspace-level names; links follow the task through RLS)
// ---------------------------------------------------------------------------------------------

// Every tag of the workspace, archived ones included (they stay on tasks), by name.
export const listTags = cache(async (): Promise<Tag[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("tags")
    .select("id, name, color, archived_at, created_by")
    .is("deleted_at", null)
    .order("name");
  return rows(result, "tags").map(toTag);
});

// Active tag ids per task, for the tasks the viewer can read (RLS).
export async function listTaskTagIds(taskIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (taskIds.length === 0) return out;
  const supabase = await createClient();
  for (let i = 0; i < taskIds.length; i += 300) {
    const result = await supabase
      .from("task_tags")
      .select("task_id, tag_id, tag:tags!inner(id)")
      .in("task_id", taskIds.slice(i, i + 300))
      .is("deleted_at", null)
      .is("tag.deleted_at", null);
    for (const r of rows(result, "task tags")) {
      const list = out.get(r.task_id) ?? [];
      list.push(r.tag_id);
      out.set(r.task_id, list);
    }
  }
  return out;
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
};

const SUBTASK_COLUMNS = "id, parent_task_id, title, completed_at, assignee_id, start_on, due_on, kind, subtask_order";

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
function toSubtaskItems(list: SubtaskRow[], children: { parent_task_id: string | null; completed_at: string | null }[]) {
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

// Every active subtask (all levels) under the given top-level tasks, for List's “Show subtasks”.
export const listSubtaskTrees = cache(async (rootIds: string[]): Promise<SubtaskItem[]> => {
  if (rootIds.length === 0) return [];
  const supabase = await createClient();
  const list = rows(
    await supabase.from("tasks").select(SUBTASK_COLUMNS).in("root_task_id", rootIds).is("deleted_at", null),
    "subtasks",
  );
  return toSubtaskItems(list, list);
});

// Critical path and slack over the project's readable tasks (read-only; see project_critical_path()).
export const projectCriticalPath = cache(async (projectId: string): Promise<CriticalPath> => {
  const supabase = await createClient();
  const result = await supabase.rpc("project_critical_path", { target_project: projectId });
  const tasks: CriticalPath["tasks"] = {};
  let skipped = 0;
  for (const r of rows(result, "critical path")) {
    if (r.skipped || r.slack_days === null) skipped += 1;
    else tasks[r.task_id] = { slackDays: r.slack_days, critical: r.critical };
  }
  return { tasks, skipped };
});

export type ProjectDependency = {
  id: string;
  predecessorId: string;
  successorId: string;
  kind: DependencyKind;
  lagDays: number;
};

// Active dependencies between two active tasks of a project (Timeline arrows), wherever they were made.
export const listProjectDependencies = cache(async (projectId: string): Promise<ProjectDependency[]> => {
  const supabase = await createClient();
  const result = await supabase.rpc("project_dependencies", { target_project: projectId });
  return rows(result, "dependencies").map((d) => ({
    id: d.id,
    predecessorId: d.predecessor_id,
    successorId: d.successor_id,
    kind: parseDependencyKind(d.kind),
    lagDays: d.lag_days,
  }));
});

export const getTaskDetail = cache(async (taskId: string): Promise<TaskDetail | null> => {
  const supabase = await createClient();
  const task = maybe(
    await supabase
      .from("tasks")
      .select(
        "id, title, kind, notes, completed_at, start_on, due_on, start_at, due_at, time_zone, recurrence, recurrence_seq, recurrence_next_id, assignee_id, home_project_id, created_at, updated_at, source, req_project_id, req_number, parent_task_id, root_task_id",
      )
      .eq("id", taskId)
      .is("deleted_at", null)
      .maybeSingle(),
    "task",
  );
  if (!task) return null;

  // A subtask lives in its root task's projects.
  const scopeTaskId = task.root_task_id ?? taskId;
  const [subtasks, memberships, tree] = await Promise.all([
    supabase
      .from("tasks")
      .select(SUBTASK_COLUMNS)
      .eq("parent_task_id", taskId)
      .is("deleted_at", null)
      .order("subtask_order")
      .order("created_at"),
    supabase
      .from("task_projects")
      .select("project_id, section_id, project:projects!inner(id, name)")
      .eq("task_id", scopeTaskId)
      .is("deleted_at", null)
      .is("project.deleted_at", null)
      .order("created_at"),
    // The whole task tree (root first): the breadcrumb, and dependency candidates within the tree.
    supabase
      .from("tasks")
      .select("id, title, completed_at, parent_task_id, deleted_at")
      .or(`id.eq.${scopeTaskId},root_task_id.eq.${scopeTaskId}`)
      .order("created_at")
      .limit(500),
  ]);
  const subtaskRows = rows(subtasks, "subtasks");
  const grandchildren = subtaskRows.length
    ? rows(
        await supabase
          .from("tasks")
          .select("parent_task_id, completed_at")
          .in(
            "parent_task_id",
            subtaskRows.map((r) => r.id),
          )
          .is("deleted_at", null),
        "subtasks",
      )
    : [];
  const treeById = new Map(rows(tree, "parent tasks").map((r) => [r.id, r] as const));
  const ancestors: TaskDetail["ancestors"] = [];
  for (let up = task.parent_task_id ? treeById.get(task.parent_task_id) : undefined; up && ancestors.length < 10; ) {
    ancestors.unshift({ id: up.id, title: up.title, completedAt: up.completed_at });
    up = up.parent_task_id ? treeById.get(up.parent_task_id) : undefined;
  }
  const isSubtask = task.parent_task_id !== null;

  const membershipRows = rows(memberships, "task projects");
  const projectIds = membershipRows.map((m) => m.project_id);
  const sections = projectIds.length
    ? rows(
        await supabase
          .from("sections")
          .select("id, project_id, name")
          .in("project_id", projectIds)
          .is("deleted_at", null)
          .order("sort_order"),
        "sections",
      )
    : [];

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
    projectIds.length ? listFieldsForProjects(projectIds) : Promise.resolve([]),
    supabase.from("task_field_values").select("field_id, value").eq("task_id", taskId),
    supabase
      .from("task_followers")
      .select("profile_id")
      .eq("task_id", taskId)
      .is("deleted_at", null)
      .order("created_at"),
    supabase
      .from("task_attachments")
      .select("id, file_name, content_type, size_bytes, uploaded_by, created_at")
      .eq("task_id", taskId)
      .is("deleted_at", null)
      .order("created_at"),
    supabase.rpc("task_comment_page", { target_task: taskId, max_results: COMMENT_PAGE_SIZE }),
    supabase
      .from("task_stories")
      .select("id, actor_id, kind, data, created_at")
      .eq("task_id", taskId)
      .order("created_at"),
    supabase
      .from("approval_requests")
      .select("id, subtask_id, approver_id, requested_by, rule_id, note, status, decided_at, decision_note, created_at")
      .eq("task_id", taskId)
      .is("deleted_at", null)
      .order("created_at"),
    supabase
      .from("form_submissions")
      .select("form_id, submitter_email, created_at")
      .eq("task_id", taskId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(1),
    task.req_number
      ? supabase.rpc("format_request_label", {
          target_project: task.req_project_id!,
          number: task.req_number,
        })
      : Promise.resolve({ data: null, error: null }),
    task.home_project_id
      ? supabase
          .from("request_sequences")
          .select("project_id")
          .eq("project_id", task.home_project_id)
          .eq("enabled", true)
          .is("deleted_at", null)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase.rpc("task_role", { target_task: taskId }),
    projectIds.length
      ? supabase
          .from("project_members")
          .select("profile_id, role")
          .in("project_id", projectIds)
          .is("deleted_at", null)
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from("task_dependencies")
      .select(
        "id, predecessor_id, successor_id, kind, lag_days, predecessor:tasks!task_dependencies_predecessor_id_fkey!inner(id, title, completed_at, parent_task_id), successor:tasks!task_dependencies_successor_id_fkey!inner(id, title, completed_at, parent_task_id)",
      )
      .or(`predecessor_id.eq.${taskId},successor_id.eq.${taskId}`)
      .is("deleted_at", null)
      .is("predecessor.deleted_at", null)
      .is("successor.deleted_at", null)
      .order("created_at"),
    task.recurrence_next_id
      ? supabase.from("tasks").select("id").eq("id", task.recurrence_next_id).is("deleted_at", null).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase
      .from("task_attachment_links")
      .select("id, source, name, url, attachment_id")
      .eq("task_id", taskId)
      .is("deleted_at", null)
      .order("created_at"),
    // Comments and reply by email (20261014030000): which comments were emailed to the form's submitter or
    // came back from them. A database without that update has no such columns (42703 → none, and no
    // "Send response to submitter").
    supabase
      .from("comments")
      .select("id, email_direction, email_address, email_subject")
      .eq("task_id", taskId)
      .not("email_direction", "is", null),
    supabase
      .from("email_outbox")
      .select("status, delivery_status, last_error, comment_id:payload->>comment_id")
      .eq("task_id", taskId)
      .eq("payload->>kind", "submitter_response")
      .order("created_at"),
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
  const myRoles = await listMyProjectRoles();
  const editableProjectIds = membershipRows.map((m) => m.project_id).filter((p) => hasRole(myRoles.get(p), "editor"));
  const treeCandidates = rows(tree, "task tree")
    .filter((r) => r.id !== taskId && r.deleted_at === null)
    .map((r) => ({ id: r.id, title: r.title }));
  const [dependencyCandidates, schedule, tagIds, blockerCount] = await Promise.all([
    hasRole(viewerProjectRole, "editor")
      ? listDependencyCandidates(
          taskId,
          membershipRows.map((m) => ({ id: m.project_id, name: m.project.name })),
          treeCandidates,
        )
      : Promise.resolve([]),
    task.due_on && !isSubtask
      ? Promise.all(
          membershipRows.map(async (m) => {
            const entry = (await projectCriticalPath(m.project_id)).tasks[taskId];
            return entry ? [{ ...entry, projectId: m.project_id, projectName: m.project.name }] : [];
          }),
        ).then((lists) => lists.flat())
      : Promise.resolve([]),
    listTaskTagIds([taskId]),
    supabase.rpc("open_blocker_count", { target_task: taskId }),
  ]);
  const dependencyRows = rows(dependencies, "dependencies");
  const visibleBlockers = dependencyRows.filter(
    (d) => d.successor_id === taskId && d.kind === "finish_to_start" && d.predecessor.completed_at === null,
  ).length;
  const isPrivate = task.home_project_id === null;
  const [storyRows, likes, privateRoot] = await Promise.all([
    withDependencyTitles(rows(stories, "activity")),
    supabase
      .from("task_likes")
      .select("profile_id")
      .eq("task_id", taskId)
      .is("deleted_at", null)
      .order("created_at")
      .then((r) => rows(r, "likes")),
    isPrivate
      ? supabase
          .from("tasks")
          .select("created_by, assignee_id")
          .eq("id", scopeTaskId)
          .maybeSingle()
          .then((r) => maybe(r, "private task"))
      : Promise.resolve(null),
  ]);

  let commentPage: CommentPage | null = null;
  if (!comments.error) {
    commentPage = parseCommentPage(comments.data, responseStatus);
    submitterResponses = true;
  } else if (!rpcMissing(comments.error)) {
    throw new Error(`Failed to load comments: ${comments.error.message}`);
  }
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
  const approvalRows = rows(approvals, "approvals");
  const submission = rows(submissions, "form submission")[0] ?? null;
  const ruleIds = [
    ...new Set(
      [...legacyComments.map((c) => c.rule_id), ...approvalRows.map((a) => a.rule_id)].filter(
        (ruleId): ruleId is string => Boolean(ruleId),
      ),
    ),
  ];
  const [ruleNames, formTitle] = await Promise.all([
    ruleIds.length
      ? supabase.from("rules").select("id, name").in("id", ruleIds)
      : Promise.resolve({ data: [], error: null }),
    submission
      ? supabase.from("forms").select("title").eq("id", submission.form_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  const ruleName = new Map(rows(ruleNames, "rules").map((r) => [r.id, r.name] as const));
  const emailStatus = await storyEmailStatuses(storyRows);
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
          ruleName: c.rule_id ? (ruleName.get(c.rule_id) ?? "Rule") : null,
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
    })),
    attachmentLinks: rows(attachmentLinks, "attachment links").map((a) => ({
      id: a.id,
      source: a.source,
      name: a.name,
      url: a.url,
      attachmentId: a.attachment_id,
    })),
    comments: taskComments,
    commentTotal,
    olderComments,
    stories: storyRows.map((st) => ({
      id: st.id,
      actorId: st.actor_id,
      kind: st.kind,
      data: st.data,
      createdAt: st.created_at,
      ...(st.kind === "email_queued" ? { email: emailStatus.get(storyEmailId(st.data) ?? "") ?? null } : {}),
    })),
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
    dependencyCandidates,
    editableProjectIds,
    schedule,
    assigneeId: task.assignee_id,
    homeProjectId: task.home_project_id,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    source: task.source,
    requestLabel: maybe(label, "request number"),
    canAssignRequestNumber: !task.req_number && !isSubtask && Boolean(maybe(numbering, "request numbering")),
    submission: submission
      ? {
          email: submission.submitter_email,
          formId: submission.form_id,
          formTitle: formTitle.data?.title ?? null,
          createdAt: submission.created_at,
        }
      : null,
    submitterResponses,
    approvals: approvalRows.map((a) => ({
      id: a.id,
      subtaskId: a.subtask_id,
      approverId: a.approver_id,
      requestedBy: a.requested_by,
      ruleName: a.rule_id ? (ruleName.get(a.rule_id) ?? "Rule") : null,
      note: a.note,
      status: a.status as TaskApproval["status"],
      decidedAt: a.decided_at,
      decisionNote: a.decision_note,
      createdAt: a.created_at,
    })),
    viewerRole: viewerProjectRole,
    memberRoles,
    tagIds: tagIds.get(taskId) ?? [],
    likeProfileIds: likes.map((l) => l.profile_id),
    isPrivate,
    privateReaderIds: [
      ...new Set([privateRoot?.created_by, privateRoot?.assignee_id].filter((p): p is string => Boolean(p))),
    ],
    subtasks: toSubtaskItems(subtaskRows, grandchildren),
    parentTaskId: task.parent_task_id,
    ancestors,
    isSubtask,
    memberships: membershipRows
      .map((m) => ({
        projectId: m.project_id,
        projectName: m.project.name,
        sectionId: m.section_id,
        isHome: m.project_id === task.home_project_id,
        sections: sections
          .filter((s) => s.project_id === m.project_id)
          .map(({ id, name }) => ({ id, name })),
      }))
      .sort((a, b) => Number(b.isHome) - Number(a.isHome)),
  };
});

const MAX_DEPENDENCY_CANDIDATES = 300;
const MAX_OTHER_CANDIDATE_PROJECTS = 10;
const MAX_OTHER_PROJECT_CANDIDATES = 100;

// Tasks the viewer can link to: the same task tree (other subtasks / the parent), active tasks of the
// task's projects where the viewer is an Editor, then of up to 10 other projects they edit (cross-project
// links need Editor on both tasks, which set_task_dependency checks again).
async function listDependencyCandidates(
  taskId: string,
  projects: { id: string; name: string }[],
  tree: { id: string; title: string }[],
): Promise<DependencyCandidateGroup[]> {
  const supabase = await createClient();
  const roles = await listMyProjectRoles();
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
  if (tree.length) groups.push({ key: "tree", label: "This task’s tree", tasks: tree.slice(0, MAX_DEPENDENCY_CANDIDATES) });
  for (const p of all) {
    const limit = own.includes(p) ? MAX_DEPENDENCY_CANDIDATES : MAX_OTHER_PROJECT_CANDIDATES;
    groups.push({
      key: p.id,
      label: own.includes(p) ? p.name : `${p.name} (another project)`,
      tasks: memberships
        .filter((m) => m.project_id === p.id)
        .sort((a, b) => Number(Boolean(a.task.completed_at)) - Number(Boolean(b.task.completed_at)))
        .slice(0, limit)
        .map((m) => ({ id: m.task.id, title: m.task.title })),
    });
  }
  return groups.filter((g) => g.tasks.length > 0);
}

// Dependency stories only store the other task's title when every reader of this task can read it
// (dependency_story_data); otherwise fill it in when the viewer can read the other task.
function storyEmailId(data: Json): string | null {
  const value = data && typeof data === "object" && !Array.isArray(data) ? data.email_id : null;
  return typeof value === "string" && isUuid(value) ? value : null;
}

// Live status of the emails behind email_queued stories (email_outbox is readable with the task).
async function storyEmailStatuses(stories: { kind: string; data: Json }[]): Promise<Map<string, StoryEmailStatus>> {
  const ids = [...new Set(stories.filter((s) => s.kind === "email_queued").map((s) => storyEmailId(s.data)))].filter(
    (id): id is string => Boolean(id),
  );
  if (ids.length === 0) return new Map();
  const supabase = await createClient();
  const result = await supabase
    .from("email_outbox")
    .select("id, status, last_error, attempts, max_attempts")
    .in("id", ids.slice(0, 200));
  const delivery = await deliveryStatuses(ids.slice(0, 200));
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
async function deliveryStatuses(ids: string[]): Promise<Map<string, DeliveryStatus>> {
  if (ids.length === 0 || !(await hasReal3Schema())) return new Map();
  const supabase = await createClient();
  const result = await supabase.from("email_outbox").select("id, delivery_status").in("id", ids).not("delivery_status", "is", null);
  if (result.error) return new Map();
  return new Map(
    (result.data ?? []).flatMap((e) => (isDeliveryEvent(e.delivery_status) ? [[e.id, e.delivery_status] as const] : [])),
  );
}

async function withDependencyTitles<T extends { kind: string; data: Json }>(stories: T[]): Promise<T[]> {
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
  const supabase = await createClient();
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

function toFieldDef(row: Tables<"custom_fields">): FieldDef {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    fieldType: row.field_type as FieldType,
    options: parseOptions(row.options),
    boundToSections: row.bound_to_sections,
    showInViews: row.show_in_views,
    sortOrder: row.sort_order,
    description: row.description ?? null,
    notifyOnChange: row.notify_on_change ?? false,
    inLibrary: row.in_library ?? false,
  };
}

// Asana parity, batch 4 (20261011040000_asana_parity_4.sql): field descriptions, the field library,
// field notifications, rule branches, and Heading / Email form questions. A preview deployed before the
// migration is applied hides them. The migration adds custom_fields.description last, so its presence
// means the whole batch is there.
export const hasBatch4Schema = cache(async (): Promise<boolean> => {
  const supabase = await createClient();
  const result = await supabase.from("custom_fields").select("description").limit(1);
  return !isMissingColumn(result.error);
});

// The workspace field library (list_field_library: name, type, description, and options of library
// fields, never their projects). Null without the migration.
export const listFieldLibrary = cache(async (): Promise<LibraryField[] | null> => {
  const supabase = await createClient();
  const result = await supabase.rpc("list_field_library");
  if (result.error?.code === "PGRST202") return null;
  return rows(result, "field library").flatMap((r) =>
    isFieldType(r.field_type)
      ? [{ fieldId: r.field_id, name: r.name, fieldType: r.field_type, description: r.description, options: parseOptions(r.options) }]
      : [],
  );
});

async function listFieldsForProjects(projectIds: string[]): Promise<FieldDef[]> {
  const supabase = await createClient();
  const result = await supabase
    .from("custom_fields")
    .select("*")
    .in("project_id", projectIds)
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  return rows(result, "fields").map(toFieldDef);
}

export const listProjectFields = cache(async (projectId: string) =>
  listFieldsForProjects([projectId]),
);

// Titles of the given tasks the viewer can read (parent labels for subtasks).
async function taskTitles(ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((v): v is string => Boolean(v)))];
  if (unique.length === 0) return new Map();
  const supabase = await createClient();
  const result = await supabase.from("tasks").select("id, title").in("id", unique);
  return new Map(rows(result, "parent tasks").map((t) => [t.id, t.title] as const));
}

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
};

function myTasksFromCards(data: Json): { open: MyTask[]; completed: MyTask[] } {
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
      });
    }
    return tasks;
  };
  return { open: mapList(page.open), completed: mapList(page.completed) };
}

// Tasks come back only when the viewer can read them (membership in one of their projects, or a
// private task they created or are assigned). Each is labelled with its home project when the viewer can
// see it, else another visible project; private tasks (and their subtasks) have no project.
// my_task_cards does that in one read. A database without the function uses the row queries.
export const listMyTasks = cache(async (profileId: string) => {
  const { user } = await getViewer();
  if (user?.id === profileId) {
    const supabase = await createClient();
    const cards = await supabase.rpc("my_task_cards");
    if (!cards.error) return myTasksFromCards(cards.data);
    if (!rpcMissing(cards.error)) throw new Error(`Failed to load my tasks: ${cards.error.message}`);
  }
  return listMyTasksFromRows(profileId);
});

async function listMyTasksFromRows(profileId: string) {
  const supabase = await createClient();
  const select =
    "id, title, completed_at, due_on, home_project_id, kind, root_task_id, parent_task_id";
  const [open, done, projects] = await Promise.all([
    supabase
      .from("tasks")
      .select(select)
      .eq("assignee_id", profileId)
      .is("deleted_at", null)
      .is("completed_at", null)
      .order("due_on", { nullsFirst: false })
      .order("created_at"),
    supabase
      .from("tasks")
      .select(select)
      .eq("assignee_id", profileId)
      .is("deleted_at", null)
      .not("completed_at", "is", null)
      .order("completed_at", { ascending: false })
      .limit(30),
    listReadableProjects(),
  ]);
  const openRows = rows(open, "my tasks");
  const doneRows = rows(done, "completed tasks");
  const projectName = new Map(projects.map((p) => [p.id, p.name] as const));
  // A subtask is labelled with a project of its root task (it has no memberships of its own).
  const scopeId = (t: { id: string; root_task_id: string | null }) => t.root_task_id ?? t.id;
  const taskIds = [...new Set([...openRows, ...doneRows].map(scopeId))];
  const [memberships, parentTitle] = await Promise.all([
    taskIds.length
      ? supabase
          .from("task_projects")
          .select("task_id, project_id")
          .in("task_id", taskIds)
          .is("deleted_at", null)
          .order("created_at")
          .then((result) => rows(result, "task projects"))
      : [],
    taskTitles([...openRows, ...doneRows].map((t) => t.parent_task_id)),
  ]);

  const toMyTask = (t: (typeof openRows)[number]): MyTask | null => {
    const isPrivate = t.home_project_id === null;
    const projectId =
      t.home_project_id && projectName.has(t.home_project_id)
        ? t.home_project_id
        : memberships.find((m) => m.task_id === scopeId(t) && projectName.has(m.project_id))?.project_id;
    if (!projectId && !isPrivate) return null;
    return {
      id: t.id,
      title: t.title,
      completedAt: t.completed_at,
      dueOn: t.due_on,
      projectId: projectId ?? null,
      projectName: projectId ? projectName.get(projectId)! : null,
      kind: parseTaskKind(t.kind),
      parentTitle: t.parent_task_id ? (parentTitle.get(t.parent_task_id) ?? null) : null,
    };
  };
  const present = (t: MyTask | null): t is MyTask => t !== null;
  return {
    open: openRows.map(toMyTask).filter(present),
    completed: doneRows.map(toMyTask).filter(present),
  };
}

// The viewer's My Tasks sections and where each open task assigned to them sits. my_tasks_layout()
// seeds the sections on first use and puts newly assigned tasks at the top of Recently assigned.
export const listMyTaskLayout = cache(
  async (): Promise<{ sections: MyTaskSection[]; placements: Record<string, MyTaskPlacement> }> => {
    const supabase = await createClient();
    const layout = rows(await supabase.rpc("my_tasks_layout"), "my tasks layout");
    const result = await supabase
      .from("my_task_sections")
      .select("id, kind, name, sort_order")
      .is("deleted_at", null)
      .order("sort_order")
      .order("created_at");
    const sections = rows(result, "my tasks sections").flatMap((s) =>
      isMyTaskSectionKind(s.kind) ? [{ id: s.id, kind: s.kind, name: s.name, sortOrder: s.sort_order }] : [],
    );
    const placements: Record<string, MyTaskPlacement> = {};
    for (const row of layout) placements[row.task_id] = { sectionId: row.section_id, sortOrder: row.sort_order };
    return { sections, placements };
  },
);

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
  // Asana parity, batch 5: the Bookmarks tab. Always null on a database without
  // 20261012050000_asana_parity_5.sql (hasBatch5Schema()).
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
  // approval_requested items: the request now (its approver decides it from the Inbox while pending).
  approval: { id: string; status: TaskApproval["status"]; approverId: string } | null;
  // A form submitter's emailed reply (Comments and reply by email): who sent it (no actor).
  emailFrom: string | null;
};

export type { InboxTab } from "@/lib/inbox";

// Asana parity, batch 5 (20261012050000_asana_parity_5.sql): Inbox bookmarks, team curated work, and
// the Admin console's last activity. A preview deployed before the migration is applied hides them. The
// migration adds inbox_items.bookmarked_at last, so its presence means the whole batch is there.
export const hasBatch5Schema = cache(async (): Promise<boolean> => {
  const supabase = await createClient();
  const result = await supabase.from("inbox_items").select("bookmarked_at").limit(1);
  return !isMissingColumn(result.error);
});

// Is 20261013010000_real_1.sql applied? Its last statement makes email_forwarding_addresses readable, so
// a preview without it hides Resend on pending invites, form file questions, and email forwarding.
export const hasReal1Schema = cache(async (): Promise<boolean> => {
  const supabase = await createClient();
  const result = await supabase.from("email_forwarding_addresses").select("id").limit(1);
  return !result.error;
});

// Is 20261013020000_real_2.sql applied? Its last statement before the tail makes notification_settings
// readable, so a preview without it keeps the old Notifications tab, says team messages need the update,
// and shows last sign-ins only. (Its tail, applied by hand, only lets team message and status update
// notifications into the Inbox.)
export const hasReal2Schema = cache(async (): Promise<boolean> => {
  const supabase = await createClient();
  const result = await supabase.from("notification_settings").select("kind").limit(1);
  return !result.error;
});

// Is 20261014010000_real_3.sql applied? Its last statement makes email_preferences readable, so a
// preview without it hides the digest and report-email settings, Schedule email on Reports, and the Admin
// console's delivery tracking and suppression list (each says it needs the database update).
export const hasReal3Schema = cache(async (): Promise<boolean> => {
  const supabase = await createClient();
  const result = await supabase.from("email_preferences").select("profile_id").limit(1);
  return !result.error;
});

// Is 20261014020000_real_4.sql applied? Its last statement makes project_status_templates readable, so a
// preview without it hides Status templates and calendar links (each says it needs the database update).
// The calendar drag and the streamed CSV export need nothing new from the database.
export const hasReal4Schema = cache(async (): Promise<boolean> => {
  const supabase = await createClient();
  const result = await supabase.from("project_status_templates").select("id").limit(1);
  return !result.error;
});

// A project's status templates (Customize → Status templates, and the status update panel's picker):
// RLS shows them to the project's Viewers+. Empty on a database without Real features 4.
export const listStatusTemplates = cache(async (projectId: string): Promise<StatusTemplate[]> => {
  if (!(await hasReal4Schema())) return [];
  const supabase = await createClient();
  const result = await supabase
    .from("project_status_templates")
    .select("id, name, status, title, sections, sort_order, created_by")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  return rows(result, "status templates").map(toStatusTemplate);
});

// The signed-in person's live calendar links (own rows by RLS), with what each covers named through RLS
// too: a project or team they can no longer open reads as null. Null on a database without Real
// features 4.
export const listMyCalendarFeeds = cache(async (): Promise<CalendarFeed[] | null> => {
  if (!(await hasReal4Schema())) return null;
  const supabase = await createClient();
  const result = await supabase
    .from("calendar_feeds")
    .select("id, scope, project_id, team_id, token_hint, token_rotated_at, last_fetched_at, created_at")
    .is("revoked_at", null)
    .order("created_at");
  if (result.error) return null;
  const feeds = result.data ?? [];
  const projectIds = [...new Set(feeds.flatMap((f) => (f.project_id ? [f.project_id] : [])))];
  const teamIds = [...new Set(feeds.flatMap((f) => (f.team_id ? [f.team_id] : [])))];
  const [projects, teams] = await Promise.all([
    projectIds.length
      ? supabase.from("projects").select("id, name").in("id", projectIds).is("deleted_at", null)
      : Promise.resolve({ data: [], error: null }),
    teamIds.length
      ? supabase.from("teams").select("id, name").in("id", teamIds).is("deleted_at", null)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const names = new Map<string, string>([
    ...(projects.data ?? []).map((p) => [p.id, p.name] as const),
    ...(teams.data ?? []).map((t) => [t.id, t.name] as const),
  ]);
  return feeds.flatMap((f) =>
    isCalendarFeedScope(f.scope)
      ? [
          {
            id: f.id,
            scope: f.scope,
            projectId: f.project_id,
            teamId: f.team_id,
            targetName: f.scope === "my_tasks" ? "My tasks" : (names.get(f.project_id ?? f.team_id ?? "") ?? null),
            hint: f.token_hint,
            createdAt: f.created_at,
            rotatedAt: f.token_rotated_at,
            lastFetchedAt: f.last_fetched_at,
          },
        ]
      : [],
  );
});

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
type InboxTaskRow = InboxRowBase & {
  task: { id: string; title: string; parent_task_id: string | null };
  comment: { id: string; body: string; deleted_at: string | null } | null;
};
type InboxTeamMessageRow = InboxRowBase & {
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
type InboxStatusRow = InboxRowBase & {
  status_update: {
    id: string;
    project_id: string;
    status: string;
    title: string | null;
    note: string | null;
    project: { name: string };
  };
};
type InboxMessageRow = InboxRowBase & {
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

function inboxItemsFromPage(data: Json): InboxItem[] {
  if (!Array.isArray(data)) return [];
  const items: InboxItem[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, Json | undefined>;
    if (typeof row.id !== "string" || typeof row.kind !== "string" || typeof row.created_at !== "string") continue;
    const message = objectOrNull(row.message);
    const teamMessage = objectOrNull(row.team_message);
    const statusUpdate = objectOrNull(row.status_update);
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

// One Inbox tab, newest first, INBOX_LIMIT items. inbox_page does the four reads in one call.
// A database without that function uses the row queries.
export const listInbox = cache(async (tab: InboxTab = "activity"): Promise<InboxItem[]> => {
  const supabase = await createClient();
  const page = await supabase.rpc("inbox_page", { inbox_tab: tab });
  if (!page.error) return inboxItemsFromPage(page.data);
  if (!rpcMissing(page.error)) throw new Error(`Failed to load inbox: ${page.error.message}`);
  return listInboxFromRows(tab);
});

//   activity = not archived, archive = archived, bookmarks = bookmarked (archived or not),
//   mentioned = @mentions (archived or not).
// Without this release's migration there are no bookmarks: that tab is empty and every item's
// bookmarkedAt is null.
async function listInboxFromRows(tab: InboxTab = "activity"): Promise<InboxItem[]> {
  const supabase = await createClient();
  const [bookmarks, real2] = await Promise.all([hasBatch5Schema(), hasReal2Schema()]);
  if (tab === "bookmarks" && !bookmarks) return [];

  // The tab as a PostgREST filter: [column, operator, value].
  const [column, operator, value]: [string, string, string | null] =
    tab === "archive"
      ? ["archived_at", "not.is", null]
      : tab === "bookmarks"
        ? ["bookmarked_at", "not.is", null]
        : tab === "mentioned"
          ? ["kind", "eq", "mention"]
          : ["archived_at", "is", null];

  const taskColumns = bookmarks
    ? "id, kind, data, actor_id, read_at, archived_at, bookmarked_at, created_at, task:tasks!inner(id, title, parent_task_id), comment:comments(id, body, deleted_at)"
    : "id, kind, data, actor_id, read_at, archived_at, created_at, task:tasks!inner(id, title, parent_task_id), comment:comments(id, body, deleted_at)";
  const messageColumns = bookmarks
    ? "id, kind, data, actor_id, read_at, archived_at, bookmarked_at, created_at, message:project_messages!inner(id, project_id, thread_id, title, body, deleted_at, project:projects!inner(name))"
    : "id, kind, data, actor_id, read_at, archived_at, created_at, message:project_messages!inner(id, project_id, thread_id, title, body, deleted_at, project:projects!inner(name))";
  const base = bookmarks
    ? "id, kind, data, actor_id, read_at, archived_at, bookmarked_at, created_at"
    : "id, kind, data, actor_id, read_at, archived_at, created_at";
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
    // Real features 2: team messages and status updates (none on a database without its migration).
    real2
      ? supabase
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
          .overrideTypes<InboxTeamMessageRow[], { merge: false }>()
      : Promise.resolve({ data: [] as InboxTeamMessageRow[], error: null }),
    real2
      ? supabase
          .from("inbox_items")
          .select(
            `${base}, status_update:project_status_updates!inner(id, project_id, status, title, note, project:projects!inner(name, deleted_at))`,
          )
          .is("task_id", null)
          .is("status_update.project.deleted_at", null)
          .filter(column, operator, value)
          .order("created_at", { ascending: false })
          .limit(INBOX_LIMIT)
          .overrideTypes<InboxStatusRow[], { merge: false }>()
      : Promise.resolve({ data: [] as InboxStatusRow[], error: null }),
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
    taskTitles(items.map((item) => item.task.parent_task_id)),
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
      approval: null,
      emailFrom: null,
    };
  });
  // Newest first; items made in the same transaction keep a stable order.
  return [...taskItems, ...messages, ...teamMessages, ...statusUpdates]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, INBOX_LIMIT);
}

// ---------------------------------------------------------------------------------------------
// Project Messages (threads + replies; RLS: project Viewer+ reads)
// ---------------------------------------------------------------------------------------------

export type MessageReaction = { emoji: ReactionKey; profileIds: string[] };

export type ProjectMessage = {
  id: string;
  authorId: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  mentionIds: string[];
  reactions: MessageReaction[];
};

export type MessageThreadSummary = {
  id: string;
  title: string;
  body: string;
  authorId: string;
  createdAt: string;
  lastActivityAt: string;
  replyCount: number;
};

export type MessageThread = ProjectMessage & {
  projectId: string;
  title: string;
  lastActivityAt: string;
  replies: ProjectMessage[];
};

const MESSAGE_COLUMNS =
  "id, project_id, thread_id, title, body, author_id, created_at, edited_at, last_activity_at, project_message_mentions(profile_id), project_message_reactions(emoji, profile_id, deleted_at, created_at)";

type MessageRow = {
  id: string;
  body: string;
  author_id: string;
  created_at: string;
  edited_at: string | null;
  project_message_mentions: { profile_id: string }[];
  project_message_reactions: { emoji: string; profile_id: string; deleted_at: string | null; created_at: string }[];
};

function toProjectMessage(row: MessageRow): ProjectMessage {
  return toMessage(row, row.project_message_mentions, row.project_message_reactions);
}

// A project or team message (same shape; the mention / reaction tables differ).
function toMessage(
  row: { id: string; body: string; author_id: string; created_at: string; edited_at: string | null },
  mentions: { profile_id: string }[],
  reactions: { emoji: string; profile_id: string; deleted_at: string | null; created_at: string }[],
): ProjectMessage {
  const active = reactions.filter((r) => !r.deleted_at).sort((a, b) => a.created_at.localeCompare(b.created_at));
  return {
    id: row.id,
    authorId: row.author_id,
    body: row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    mentionIds: mentions.map((m) => m.profile_id),
    reactions: REACTIONS.flatMap(({ key }) => {
      const profileIds = active.filter((r) => r.emoji === key).map((r) => r.profile_id);
      return profileIds.length ? [{ emoji: key, profileIds }] : [];
    }),
  };
}

// Threads of a project, most recently active first.
export const listMessageThreads = cache(async (projectId: string): Promise<MessageThreadSummary[]> => {
  const supabase = await createClient();
  const threads = rows(
    await supabase
      .from("project_messages")
      .select("id, title, body, author_id, created_at, last_activity_at")
      .eq("project_id", projectId)
      .is("thread_id", null)
      .is("deleted_at", null)
      .order("last_activity_at", { ascending: false })
      .limit(200),
    "messages",
  );
  if (threads.length === 0) return [];
  const replies = rows(
    await supabase
      .from("project_messages")
      .select("thread_id")
      .in(
        "thread_id",
        threads.map((t) => t.id),
      )
      .is("deleted_at", null),
    "replies",
  );
  const counts = new Map<string, number>();
  for (const r of replies) if (r.thread_id) counts.set(r.thread_id, (counts.get(r.thread_id) ?? 0) + 1);
  return threads.map((t) => ({
    id: t.id,
    title: t.title ?? "Untitled",
    body: t.body,
    authorId: t.author_id,
    createdAt: t.created_at,
    lastActivityAt: t.last_activity_at,
    replyCount: counts.get(t.id) ?? 0,
  }));
});

// One thread with its replies (oldest first); null when missing, deleted, or unreadable.
export const getMessageThread = cache(async (threadId: string): Promise<MessageThread | null> => {
  const supabase = await createClient();
  const thread = maybe(
    await supabase
      .from("project_messages")
      .select(MESSAGE_COLUMNS)
      .eq("id", threadId)
      .is("thread_id", null)
      .is("deleted_at", null)
      .maybeSingle(),
    "message",
  );
  if (!thread) return null;
  const replies = rows(
    await supabase
      .from("project_messages")
      .select(MESSAGE_COLUMNS)
      .eq("thread_id", threadId)
      .is("deleted_at", null)
      .order("created_at"),
    "replies",
  );
  return {
    ...toProjectMessage(thread),
    projectId: thread.project_id,
    title: thread.title ?? "Untitled",
    lastActivityAt: thread.last_activity_at,
    replies: replies.map(toProjectMessage),
  };
});

// ---------------------------------------------------------------------------------------------
// Team Messages (Real features 2: threads + replies; RLS: whoever can see the team reads)
// ---------------------------------------------------------------------------------------------

export type TeamThreadSummary = MessageThreadSummary & { following: boolean };

export type TeamMessageThread = ProjectMessage & {
  teamId: string;
  title: string;
  lastActivityAt: string;
  replies: ProjectMessage[];
  // Who follows the thread (gets its replies in the Inbox), in the order they started.
  followerIds: string[];
};

const TEAM_MESSAGE_COLUMNS =
  "id, team_id, thread_id, title, body, author_id, created_at, edited_at, last_activity_at, team_message_mentions(profile_id), team_message_reactions(emoji, profile_id, deleted_at, created_at)";

type TeamMessageRow = {
  id: string;
  team_id: string;
  title: string | null;
  body: string;
  author_id: string;
  created_at: string;
  edited_at: string | null;
  last_activity_at: string;
  team_message_mentions: { profile_id: string }[];
  team_message_reactions: { emoji: string; profile_id: string; deleted_at: string | null; created_at: string }[];
};

const toTeamMessage = (row: TeamMessageRow) => toMessage(row, row.team_message_mentions, row.team_message_reactions);

// A team's threads, most recently active first, with whether the viewer follows each. Null on a
// database without 20261013020000_real_2.sql.
export const listTeamMessageThreads = cache(async (teamId: string): Promise<TeamThreadSummary[] | null> => {
  if (!(await hasReal2Schema())) return null;
  const { user } = await getViewer();
  const supabase = await createClient();
  const threads = rows(
    await supabase
      .from("team_messages")
      .select("id, title, body, author_id, created_at, last_activity_at")
      .eq("team_id", teamId)
      .is("thread_id", null)
      .is("deleted_at", null)
      .order("last_activity_at", { ascending: false })
      .limit(200),
    "team messages",
  );
  if (threads.length === 0) return [];
  const ids = threads.map((t) => t.id);
  const [replies, follows] = await Promise.all([
    supabase.from("team_messages").select("thread_id").in("thread_id", ids).is("deleted_at", null),
    user
      ? supabase
          .from("team_message_followers")
          .select("thread_id")
          .in("thread_id", ids)
          .eq("profile_id", user.id)
          .is("deleted_at", null)
      : Promise.resolve({ data: [] as { thread_id: string }[], error: null }),
  ]);
  const counts = new Map<string, number>();
  for (const r of rows(replies, "team message replies")) {
    if (r.thread_id) counts.set(r.thread_id, (counts.get(r.thread_id) ?? 0) + 1);
  }
  const following = new Set(rows(follows, "team message follows").map((f) => f.thread_id));
  return threads.map((t) => ({
    id: t.id,
    title: t.title ?? "Untitled",
    body: t.body,
    authorId: t.author_id,
    createdAt: t.created_at,
    lastActivityAt: t.last_activity_at,
    replyCount: counts.get(t.id) ?? 0,
    following: following.has(t.id),
  }));
});

// One team thread with its replies (oldest first) and followers; null when missing, removed,
// unreadable, or on a database without this release's migration.
export const getTeamMessageThread = cache(async (threadId: string): Promise<TeamMessageThread | null> => {
  if (!(await hasReal2Schema())) return null;
  const supabase = await createClient();
  const thread = maybe(
    await supabase
      .from("team_messages")
      .select(TEAM_MESSAGE_COLUMNS)
      .eq("id", threadId)
      .is("thread_id", null)
      .is("deleted_at", null)
      .maybeSingle()
      .overrideTypes<TeamMessageRow | null, { merge: false }>(),
    "team message",
  );
  if (!thread) return null;
  const [replies, followers] = await Promise.all([
    supabase
      .from("team_messages")
      .select(TEAM_MESSAGE_COLUMNS)
      .eq("thread_id", threadId)
      .is("deleted_at", null)
      .order("created_at")
      .overrideTypes<TeamMessageRow[], { merge: false }>(),
    supabase
      .from("team_message_followers")
      .select("profile_id")
      .eq("thread_id", threadId)
      .is("deleted_at", null)
      .order("created_at"),
  ]);
  return {
    ...toTeamMessage(thread),
    teamId: thread.team_id,
    title: thread.title ?? "Untitled",
    lastActivityAt: thread.last_activity_at,
    replies: rows(replies, "team message replies").map(toTeamMessage),
    followerIds: rows(followers, "team message followers").map((f) => f.profile_id),
  };
});

// Can the viewer post in this team's Messages (its members, leads, and workspace admins)?
export const canPostTeamMessage = cache(async (teamId: string): Promise<boolean> => {
  if (!(await hasReal2Schema())) return false;
  const supabase = await createClient();
  const result = await supabase.rpc("can_post_team_message", { target_team: teamId });
  return !result.error && result.data === true;
});

export const countUnreadInbox = cache(async () => {
  const supabase = await createClient();
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

export const searchTasks = cache(async (query: string) => {
  const supabase = await createClient();
  const result = await supabase.rpc("search_tasks", { query, max_results: 50 });
  return rows(result, "search results");
});

// ---------------------------------------------------------------------------------------------
// Trash: soft-deleted tasks of a project (RLS shows them to Editors and above only)
// ---------------------------------------------------------------------------------------------

export type TrashedTask = {
  id: string;
  title: string;
  deletedAt: string;
  deletedBy: string | null;
  homeProjectId: string | null;
  homeProjectName: string | null;
  completedAt: string | null;
  // Subtasks trashed on their own (with their parent still active): the parent's title.
  parentTitle: string | null;
};

const TRASH_LIMIT = 200;

// The one read in this module that asks for deleted rows on purpose: tasks with an active membership in
// the project whose task row is soft-deleted, newest first.
export const listTrashedTasks = cache(async (projectId: string): Promise<TrashedTask[]> => {
  const supabase = await createClient();
  const trashed = rows(
    await supabase
      .from("tasks")
      .select("id, title, deleted_at, completed_at, home_project_id, task_projects!inner(project_id)")
      .eq("task_projects.project_id", projectId)
      .is("task_projects.deleted_at", null)
      .not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false })
      .limit(TRASH_LIMIT),
    "trash",
  );
  // Subtasks have no memberships: list the ones trashed on their own (their parent is active, so
  // restoring works) whose root task is in this project. Ones trashed with their parent come back
  // with it.
  const trashedSubtasks = rows(
    await supabase
      .from("tasks")
      .select(
        "id, title, deleted_at, completed_at, home_project_id, root_task_id, parent_task_id",
      )
      .not("root_task_id", "is", null)
      .not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false })
      .limit(TRASH_LIMIT),
    "trashed subtasks",
  );
  const rootIds = [...new Set(trashedSubtasks.map((t) => t.root_task_id!))];
  const parentIds = [...new Set(trashedSubtasks.map((t) => t.parent_task_id!))];
  const [rootsHere, activeParents] = await Promise.all([
    rootIds.length
      ? supabase
          .from("task_projects")
          .select("task_id")
          .eq("project_id", projectId)
          .in("task_id", rootIds)
          .is("deleted_at", null)
          .then((result) => new Set(rows(result, "task projects").map((m) => m.task_id)))
      : new Set<string>(),
    parentIds.length
      ? supabase
          .from("tasks")
          .select("id, title")
          .in("id", parentIds)
          .is("deleted_at", null)
          .then((result) => new Map(rows(result, "parent tasks").map((t) => [t.id, t.title] as const)))
      : new Map<string, string>(),
  ]);
  const all = [
    ...trashed.map((t) => ({ ...t, parentTitle: null as string | null })),
    ...trashedSubtasks
      .filter((t) => rootsHere.has(t.root_task_id!) && activeParents.has(t.parent_task_id!))
      .map((t) => ({ ...t, parentTitle: activeParents.get(t.parent_task_id!) ?? null })),
  ]
    .sort((a, b) => b.deleted_at!.localeCompare(a.deleted_at!))
    .slice(0, TRASH_LIMIT);
  if (all.length === 0) return [];

  const [stories, projects] = await Promise.all([
    supabase
      .from("task_stories")
      .select("task_id, actor_id, created_at")
      .in(
        "task_id",
        all.map((t) => t.id),
      )
      .eq("kind", "deleted")
      .order("created_at", { ascending: false }),
    listReadableProjects(),
  ]);
  const deletedBy = new Map<string, string | null>();
  for (const story of rows(stories, "deletions")) {
    if (!deletedBy.has(story.task_id)) deletedBy.set(story.task_id, story.actor_id);
  }
  const projectName = new Map(projects.map((p) => [p.id, p.name] as const));
  return all.map((t) => ({
    id: t.id,
    title: t.title,
    deletedAt: t.deleted_at!,
    deletedBy: deletedBy.get(t.id) ?? null,
    homeProjectId: t.home_project_id,
    homeProjectName: t.home_project_id ? (projectName.get(t.home_project_id) ?? null) : null,
    completedAt: t.completed_at,
    parentTitle: t.parentTitle,
  }));
});

// ---------------------------------------------------------------------------------------------
// Workflows: forms, rules, request numbers
// ---------------------------------------------------------------------------------------------

function toFormDef(row: Tables<"forms">): FormDef {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    questions: parseQuestions(row.questions),
    destinationSectionId: row.destination_section_id,
    acceptingResponses: row.accepting_responses,
    sendConfirmation: row.send_confirmation,
    confirmationMessage: row.confirmation_message,
  };
}

export type FormSummary = FormDef & { submissionCount: number; lastSubmittedAt: string | null };

export const listProjectForms = cache(async (projectId: string): Promise<FormSummary[]> => {
  const supabase = await createClient();
  const forms = rows(
    await supabase
      .from("forms")
      .select("*")
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .order("created_at"),
    "forms",
  );
  if (forms.length === 0) return [];
  const submissions = rows(
    await supabase
      .from("form_submissions")
      .select("form_id, created_at")
      .in(
        "form_id",
        forms.map((f) => f.id),
      )
      .is("deleted_at", null),
    "form submissions",
  );
  return forms.map((row) => {
    const mine = submissions.filter((s) => s.form_id === row.id);
    return {
      ...toFormDef(row),
      submissionCount: mine.length,
      lastSubmittedAt: mine.map((s) => s.created_at).sort().at(-1) ?? null,
    };
  });
});

export const getForm = cache(async (formId: string): Promise<FormDef | null> => {
  const supabase = await createClient();
  const row = maybe(
    await supabase.from("forms").select("*").eq("id", formId).is("deleted_at", null).maybeSingle(),
    "form",
  );
  return row ? toFormDef(row) : null;
});

// Works for anonymous visitors: goes through the SECURITY DEFINER get_public_form RPC.
export const getPublicForm = cache(async (formId: string): Promise<PublicForm | null> => {
  const supabase = await createClient();
  const data = maybe(await supabase.rpc("get_public_form", { target_form: formId }), "form");
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return {
    id: String(data.id),
    title: String(data.title),
    description: typeof data.description === "string" ? data.description : null,
    acceptingResponses: data.accepting_responses === true,
    questions: parseQuestions(data.questions ?? []),
    viewerEmail: typeof data.viewer_email === "string" ? data.viewer_email : null,
  };
});

export const listProjectRules = cache(async (projectId: string): Promise<RuleDef[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("rules")
    .select("id, project_id, name, enabled, trigger_type, trigger_config, conditions, actions, preset_key")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  return rows(result, "rules").map(toRuleDef);
});

export const listRecentRuleRuns = cache(async (ruleIds: string[]): Promise<RuleRun[]> => {
  if (ruleIds.length === 0) return [];
  const supabase = await createClient();
  const runs = rows(
    await supabase
      .from("rule_runs")
      .select("id, rule_id, task_id, status, detail, created_at")
      .in("rule_id", ruleIds)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(50),
    "rule runs",
  );
  const taskIds = [...new Set(runs.map((r) => r.task_id).filter((t): t is string => Boolean(t)))];
  const tasks = taskIds.length
    ? rows(
        await supabase.from("tasks").select("id, title").in("id", taskIds).is("deleted_at", null),
        "tasks",
      )
    : [];
  const titles = new Map(tasks.map((t) => [t.id, t.title] as const));
  return runs.map((r) => ({
    id: r.id,
    ruleId: r.rule_id,
    taskId: r.task_id && titles.has(r.task_id) ? r.task_id : null,
    taskTitle: r.task_id ? (titles.get(r.task_id) ?? null) : null,
    status: r.status as RuleRun["status"],
    detail: r.detail,
    createdAt: r.created_at,
  }));
});

export const listRulePresets = cache(async (): Promise<RulePreset[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("rule_presets")
    .select("key, name, description, inputs, rules")
    .is("deleted_at", null)
    .order("sort_order");
  return rows(result, "rule presets").map((p) => ({
    key: p.key,
    name: p.name,
    description: p.description,
    inputs: parsePresetInputs(p.inputs),
    ruleCount: Array.isArray(p.rules) ? p.rules.length : 1,
  }));
});

export type RequestSequence = Pick<
  Tables<"request_sequences">,
  "enabled" | "prefix" | "pad_width" | "add_to_title" | "assign_to" | "last_number"
>;

export const getRequestSequence = cache(async (projectId: string): Promise<RequestSequence | null> => {
  const supabase = await createClient();
  const result = await supabase
    .from("request_sequences")
    .select("enabled, prefix, pad_width, add_to_title, assign_to, last_number")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .maybeSingle();
  return maybe(result, "request numbering");
});

// Redacted Slack / webhook defaults (hosts + last 4 characters, never the URL or secret). Admin+ only:
// below Admin the RPC refuses, so this returns null without asking.
export const getProjectIntegrations = cache(async (projectId: string): Promise<ProjectIntegrations | null> => {
  if (!hasRole(await getProjectRole(projectId), "admin")) return null;
  const supabase = await createClient();
  const result = await supabase.rpc("get_project_integrations", { target_project: projectId });
  return toProjectIntegrations(maybe(result, "integration settings"));
});

// Delivery log for Settings → Deliveries (Admin+; the RPC refuses anyone else, so this returns null
// without asking). Hints, statuses, and times only — never a URL, secret, or signature.
export const listIntegrationDeliveries = cache(async (projectId: string): Promise<IntegrationDelivery[] | null> => {
  if (!hasRole(await getProjectRole(projectId), "admin")) return null;
  const supabase = await createClient();
  const result = await supabase.rpc("list_integration_deliveries", { target_project: projectId, max_results: 200 });
  return rows(result, "delivery log").map((row) => ({
    id: row.id,
    channel: row.channel === "slack" ? "slack" : "webhook",
    taskId: row.task_id,
    taskTitle: row.task_title,
    ruleId: row.rule_id,
    ruleName: row.rule_name,
    targetHint: row.target_hint,
    status: isDeliveryStatus(row.status) ? row.status : "pending",
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    responseStatus: row.response_status,
    lastError: row.last_error,
    signed: row.signed,
    nextAttemptAt: row.next_attempt_at,
    sentAt: row.sent_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
});

// The signed-in person's "Email me about comments" setting (own row; on when unreadable).
export const getEmailCommentsSetting = cache(async (profileId: string): Promise<boolean> => {
  const supabase = await createClient();
  const result = await supabase.from("profiles").select("email_comments").eq("id", profileId).maybeSingle();
  return maybe(result, "profile")?.email_comments ?? true;
});

// Everything the Settings modal (and /settings/profile) shows about the signed-in person: their name,
// workspace role, teams, the comment-email switch, when they joined, and how they sign in.
export type MySettings = {
  name: string;
  email: string;
  isWorkspaceAdmin: boolean;
  workspaceName: string;
  teams: { id: string; name: string; lead: boolean }[];
  emailComments: boolean;
  // Real features 2: the Inbox / Email switch per kind (null on a database without its migration).
  notifications: NotificationSettings | null;
  // Real features 3: the Inbox digest and report email switches (null on a database without its migration).
  emailPreferences: EmailPreferences | null;
  joinedAt: string | null;
  signInMethod: "google" | "password";
  // How My tasks opens (the my_tasks_layout cookie), for Settings → Display.
  myTasksLayout: MyTasksLayout;
};

// The person's forwarding address row (made on first use) and their latest forwarded emails (Real
// features 1). Null when this release's database update isn't applied.
export const getMyForwarding = cache(
  async (): Promise<{
    token: string;
    defaultProjectId: string | null;
    recent: { id: string; status: string; reason: string | null; taskId: string | null; projectId: string | null; attachments: number; createdAt: string }[];
    taskTitles: Map<string, string>;
  } | null> => {
    const supabase = await createClient();
    const address = await supabase.rpc("my_forwarding_address");
    if (address.error || !address.data) return null;
    const recent = await supabase
      .from("email_forwards")
      .select("id, status, reason, task_id, project_id, attachments, created_at")
      .order("created_at", { ascending: false })
      .limit(5);
    const forwards = recent.data ?? [];
    const taskIds = forwards.flatMap((f) => (f.task_id ? [f.task_id] : []));
    const titles = taskIds.length
      ? await supabase.from("tasks").select("id, title").in("id", taskIds).is("deleted_at", null)
      : { data: [] };
    return {
      token: address.data.token,
      defaultProjectId: address.data.default_project_id,
      recent: forwards.map((f) => ({
        id: f.id,
        status: f.status,
        reason: f.reason,
        taskId: f.task_id,
        projectId: f.project_id,
        attachments: f.attachments,
        createdAt: f.created_at,
      })),
      taskTitles: new Map((titles.data ?? []).map((t) => [t.id, t.title] as const)),
    };
  },
);

export const getMySettings = cache(async (): Promise<MySettings | null> => {
  const { user, allowlisted } = await getViewer();
  if (!user || !allowlisted) return null;
  const supabase = await createClient();
  const [profile, admin, teams, workspace, cookieStore, notificationRows, emailPreferences] = await Promise.all([
    supabase.from("profiles").select("full_name, email_comments, joined_at").eq("id", user.id).maybeSingle(),
    isWorkspaceAdmin(),
    listTeams(),
    getWorkspace(),
    cookies(),
    supabase.from("notification_settings").select("kind, inbox, email"),
    getMyEmailPreferences(),
  ]);
  const layout = cookieStore.get(MY_TASKS_LAYOUT_COOKIE)?.value;
  const row = maybe(profile, "profile");
  const meta = user.user_metadata ?? {};
  const email = user.email ?? "";
  const name =
    row?.full_name?.trim() || (meta.full_name as string | undefined) || (meta.name as string | undefined) || email;
  const providers = (user.app_metadata?.providers as string[] | undefined) ?? [user.app_metadata?.provider as string];
  return {
    name,
    email,
    isWorkspaceAdmin: admin,
    workspaceName: workspace?.name ?? "ALHC Projects",
    teams: teams.flatMap((team) => {
      const me = team.members.find((m) => m.profileId === user.id);
      return me ? [{ id: team.id, name: team.name, lead: me.role === "lead" }] : [];
    }),
    emailComments: row?.email_comments ?? true,
    notifications: notificationRows.error
      ? null
      : resolveNotificationSettings(notificationRows.data ?? [], row?.email_comments ?? true),
    emailPreferences,
    joinedAt: row?.joined_at ?? null,
    signInMethod: providers.includes("google") ? "google" : "password",
    myTasksLayout: isMyTasksLayout(layout) ? layout : "sections",
  };
});

// Emails about the project's tasks for Settings → Deliveries (Admin+; null below Admin). Never a body.
export const listEmailDeliveries = cache(async (projectId: string): Promise<EmailDelivery[] | null> => {
  if (!hasRole(await getProjectRole(projectId), "admin")) return null;
  const supabase = await createClient();
  const result = await supabase.rpc("list_email_deliveries", { target_project: projectId, max_results: 200 });
  const emails = rows(result, "email log");
  const delivery = await deliveryStatuses(emails.map((row) => row.id));
  return emails.map((row) => ({
    id: row.id,
    kind: row.kind,
    recipient: row.recipient,
    taskId: row.task_id,
    taskTitle: row.task_title,
    ruleName: row.rule_name,
    status: isDeliveryStatus(row.status) && row.status !== "cancelled" ? row.status : "pending",
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    nextAttemptAt: row.next_attempt_at,
    sentAt: row.sent_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveryStatus: delivery.get(row.id) ?? null,
  }));
});

// Inbound webhook endpoints of a project (Admin+; RLS returns nothing to anyone else). The token hash
// and signing secret columns aren't readable by clients at all — only the hint and whether one is set.
export const listInboundEndpoints = cache(async (projectId: string): Promise<InboundEndpoint[] | null> => {
  if (!hasRole(await getProjectRole(projectId), "admin")) return null;
  const supabase = await createClient();
  const [endpoints, calls] = await Promise.all([
    supabase
      .from("inbound_endpoints")
      .select(
        "id, project_id, name, section_id, assignee_id, tag_ids, enabled, token_hint, token_rotated_at, signing_secret_set_at, created_by, created_at",
      )
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .order("created_at"),
    supabase
      .from("inbound_calls")
      .select("endpoint_id, created_at")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(500),
  ]);
  const lastCall = new Map<string, string>();
  for (const call of rows(calls, "inbound calls")) {
    if (!lastCall.has(call.endpoint_id)) lastCall.set(call.endpoint_id, call.created_at);
  }
  return rows(endpoints, "inbound endpoints").map((row) => ({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    sectionId: row.section_id,
    assigneeId: row.assignee_id,
    tagIds: row.tag_ids ?? [],
    enabled: row.enabled,
    tokenHint: row.token_hint,
    tokenRotatedAt: row.token_rotated_at,
    signed: row.signing_secret_set_at !== null,
    signingSecretSetAt: row.signing_secret_set_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    lastCallAt: lastCall.get(row.id) ?? null,
  }));
});

// The latest calls to the project's inbound endpoints (Admin+): status, HTTP status, the created task
// (its title only when the viewer can read it), error, and warnings — never a body, token, or signature.
export const listInboundCalls = cache(async (projectId: string): Promise<InboundCall[] | null> => {
  if (!hasRole(await getProjectRole(projectId), "admin")) return null;
  const supabase = await createClient();
  const calls = rows(
    await supabase
      .from("inbound_calls")
      .select("id, endpoint_id, status, http_status, task_id, error, warnings, idempotency_key, created_at")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(100),
    "inbound calls",
  );
  const taskIds = [...new Set(calls.flatMap((c) => (c.task_id ? [c.task_id] : [])))];
  const titles = new Map<string, string>();
  if (taskIds.length) {
    const tasks = rows(
      await supabase.from("tasks").select("id, title").in("id", taskIds).is("deleted_at", null),
      "inbound tasks",
    );
    for (const t of tasks) titles.set(t.id, t.title);
  }
  return calls.map((row) => ({
    id: row.id,
    endpointId: row.endpoint_id,
    status: isInboundCallStatus(row.status) ? row.status : "failed",
    httpStatus: row.http_status,
    taskId: row.task_id,
    taskTitle: row.task_id ? (titles.get(row.task_id) ?? null) : null,
    error: row.error,
    warnings: Array.isArray(row.warnings) ? row.warnings.filter((w): w is string => typeof w === "string") : [],
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  }));
});

// ---------------------------------------------------------------------------------------------
// Views & Insights: saved views, filtering, dashboard widgets + metrics
// ---------------------------------------------------------------------------------------------

function toProjectView(row: Tables<"project_views">): ProjectView {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    layout: isViewLayout(row.layout) ? row.layout : "list",
    config: parseViewConfig(row.config),
    sortOrder: row.sort_order,
  };
}

export const listProjectViews = cache(async (projectId: string): Promise<ProjectView[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("project_views")
    .select("*")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  return rows(result, "views").map(toProjectView);
});

export const getProjectView = cache(async (viewId: string): Promise<ProjectView | null> => {
  const supabase = await createClient();
  const row = maybe(
    await supabase.from("project_views").select("*").eq("id", viewId).is("deleted_at", null).maybeSingle(),
    "view",
  );
  return row ? toProjectView(row) : null;
});

// Ids of the project's tasks that match a view filter, evaluated by filter_project_tasks() under RLS.
export async function filterProjectTaskIds(
  projectId: string,
  filters: ViewFilters,
  timeZone: string,
): Promise<Set<string>> {
  const supabase = await createClient();
  const result = await supabase.rpc("filter_project_tasks", {
    target_project: projectId,
    filters: toJson(filters),
    tz: timeZone,
  });
  return new Set(rows(result, "filtered tasks").map((r) => r.task_id));
}

export const listDashboardWidgets = cache(async (projectId: string): Promise<DashboardWidget[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("dashboard_widgets")
    .select("*")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  return rows(result, "dashboard widgets").flatMap((row) =>
    isWidgetKind(row.kind)
      ? [
          {
            id: row.id,
            projectId: row.project_id,
            kind: row.kind,
            title: row.title,
            filters: parseFilters(row.filters),
            sortOrder: row.sort_order,
          },
        ]
      : [],
  );
});

export type MetricBucket = { bucket: string | null; count: number };

export async function projectMetrics(
  projectId: string,
  filters: ViewFilters,
  groupBy: "none" | "section" | "assignee",
  timeZone: string,
): Promise<MetricBucket[]> {
  const supabase = await createClient();
  const result = await supabase.rpc("project_metrics", {
    target_project: projectId,
    filters: toJson(filters),
    group_by: groupBy,
    tz: timeZone,
  });
  return rows(result, "metrics").map((r) => ({ bucket: r.bucket, count: Number(r.task_count) }));
}

// ---------------------------------------------------------------------------------------------
// Portfolios. RLS shows a portfolio only to its members, and a portfolio's projects only when the
// viewer can also read the project; reports (portfolio_report) apply the same rule.
// ---------------------------------------------------------------------------------------------

export type Portfolio = Pick<Tables<"portfolios">, "id" | "name" | "notes" | "created_at">;

export const listPortfolios = cache(async (): Promise<Portfolio[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("portfolios")
    .select("id, name, notes, created_at")
    .is("deleted_at", null)
    .order("name")
    .order("created_at");
  return rows(result, "portfolios");
});

export const getPortfolio = cache(async (portfolioId: string): Promise<Portfolio | null> => {
  const supabase = await createClient();
  const result = await supabase
    .from("portfolios")
    .select("id, name, notes, created_at")
    .eq("id", portfolioId)
    .is("deleted_at", null)
    .maybeSingle();
  return maybe(result, "portfolio");
});

// The viewer's role in a portfolio, or null when they are not a member.
export const getPortfolioRole = cache(async (portfolioId: string): Promise<PortfolioRole | null> => {
  const supabase = await createClient();
  const role = maybe(await supabase.rpc("portfolio_role", { target_portfolio: portfolioId }), "portfolio role");
  return isPortfolioRole(role) ? role : null;
});

export type PortfolioMember = {
  profileId: string;
  role: PortfolioRole;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  addedAt: string;
};

export const listPortfolioMembers = cache(async (portfolioId: string): Promise<PortfolioMember[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("portfolio_members")
    .select(
      "profile_id, role, created_at, profile:profiles!portfolio_members_profile_id_fkey!inner(email, full_name, avatar_url)",
    )
    .eq("portfolio_id", portfolioId)
    .is("deleted_at", null)
    .order("created_at");
  return rows(result, "portfolio members")
    .filter((m) => isPortfolioRole(m.role))
    .map((m) => ({
      profileId: m.profile_id,
      role: m.role as PortfolioRole,
      email: m.profile.email,
      fullName: m.profile.full_name,
      avatarUrl: m.profile.avatar_url,
      addedAt: m.created_at,
    }));
});

export type PortfolioProject = Project & { portfolioSortOrder: number };

// Active projects of a portfolio that the viewer can read, in portfolio order.
export const listPortfolioProjects = cache(async (portfolioId: string): Promise<PortfolioProject[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("portfolio_projects")
    .select(`sort_order, created_at, project:projects!portfolio_projects_project_id_fkey!inner(${PROJECT_COLUMNS})`)
    .eq("portfolio_id", portfolioId)
    .is("deleted_at", null)
    .is("project.deleted_at", null)
    .order("sort_order")
    .order("created_at");
  return rows(result, "portfolio projects").map((row) => ({ ...row.project, portfolioSortOrder: row.sort_order }));
});

// How many of the portfolio's projects the viewer isn't a member of (left out of every number).
export const countHiddenPortfolioProjects = cache(async (portfolioId: string): Promise<number> => {
  const supabase = await createClient();
  const result = await supabase.rpc("portfolio_hidden_project_count", { target_portfolio: portfolioId });
  return Number(maybe(result, "hidden projects") ?? 0);
});

export type PortfolioReportRow = PortfolioCounts & { bucket: string | null };

export async function portfolioReport(
  portfolioId: string,
  groupBy: "none" | "project" | "assignee",
  timeZone: string,
): Promise<PortfolioReportRow[]> {
  const supabase = await createClient();
  const result = await supabase.rpc("portfolio_report", {
    target_portfolio: portfolioId,
    group_by: groupBy,
    tz: timeZone,
  });
  return rows(result, "portfolio report").map((r) => ({
    bucket: r.bucket,
    total: Number(r.task_count),
    completed: Number(r.completed_count),
    incomplete: Number(r.incomplete_count),
    overdue: Number(r.overdue_count),
    completedRecent: Number(r.completed_recent_count),
  }));
}

export async function portfolioTotals(portfolioId: string, timeZone: string): Promise<PortfolioCounts> {
  const [row] = await portfolioReport(portfolioId, "none", timeZone);
  return row ?? EMPTY_COUNTS;
}

// Progress for every portfolio the viewer can read (sidebar), keyed by portfolio id.
export const listPortfolioProgress = cache(
  async (): Promise<Map<string, { total: number; completed: number }>> => {
    const supabase = await createClient();
    const result = await supabase.rpc("list_portfolio_progress");
    return new Map(
      rows(result, "portfolio progress").map((r) => [
        r.portfolio_id,
        { total: Number(r.task_count), completed: Number(r.completed_count) },
      ]),
    );
  },
);

// ---------------------------------------------------------------------------------------------
// Portfolio depth: nested portfolios, portfolio fields, rollups, timeline, project status history.
// Links to a nested portfolio show only to Viewers+ of both; rollups and values only cover projects the
// viewer can read (20261006060000_critical_path_portfolios.sql).
// ---------------------------------------------------------------------------------------------

export type PortfolioChild = { id: string; name: string; sortOrder: number };

// Nested portfolios the viewer can see, in order.
export const listPortfolioChildren = cache(async (portfolioId: string): Promise<PortfolioChild[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("portfolio_children")
    .select("sort_order, created_at, child:portfolios!portfolio_children_child_id_fkey!inner(id, name)")
    .eq("parent_id", portfolioId)
    .is("deleted_at", null)
    .is("child.deleted_at", null)
    .order("sort_order")
    .order("created_at");
  return rows(result, "nested portfolios").map((r) => ({ id: r.child.id, name: r.child.name, sortOrder: r.sort_order }));
});

export type RollupProject = {
  id: string;
  name: string;
  status: string;
  statusNote: string | null;
  // The portfolio the project sits in directly, and the nested portfolio it came through (null = own).
  portfolioId: string;
  groupId: string | null;
  sortOrder: number;
};

// Every readable project of the portfolio and its visible nested portfolios, once each.
export const listPortfolioRollupProjects = cache(async (portfolioId: string): Promise<RollupProject[]> => {
  const supabase = await createClient();
  const result = await supabase.rpc("portfolio_rollup_projects", { target_portfolio: portfolioId });
  return rows(result, "portfolio rollup").map((r) => ({
    id: r.project_id,
    name: r.name,
    status: r.status,
    statusNote: r.status_note,
    portfolioId: r.portfolio_id,
    groupId: r.group_id,
    sortOrder: r.sort_order,
  }));
});

export type PortfolioTimelineRow = RollupProject & {
  startOn: string | null;
  dueOn: string | null;
  openTasks: number;
};

export async function portfolioTimeline(portfolioId: string): Promise<PortfolioTimelineRow[]> {
  const supabase = await createClient();
  const result = await supabase.rpc("portfolio_timeline", { target_portfolio: portfolioId });
  return rows(result, "portfolio timeline").map((r) => ({
    id: r.project_id,
    name: r.name,
    status: r.status,
    statusNote: r.status_note,
    portfolioId: r.portfolio_id,
    groupId: r.group_id,
    sortOrder: r.sort_order,
    startOn: r.start_on,
    dueOn: r.due_on,
    openTasks: Number(r.open_task_count),
  }));
}

export type PortfolioMilestone = { projectId: string; taskId: string; title: string; dueOn: string };

// Open milestones of every readable project in the rollup (direct or nested), for the portfolio Timeline.
export async function listPortfolioMilestones(portfolioId: string): Promise<PortfolioMilestone[]> {
  const supabase = await createClient();
  const result = await supabase.rpc("portfolio_milestones", { target_portfolio: portfolioId });
  return rows(result, "portfolio milestones").map((r) => ({
    projectId: r.project_id,
    taskId: r.task_id,
    title: r.title,
    dueOn: r.due_on,
  }));
}

export type PortfolioField = {
  id: string;
  name: string;
  fieldType: PortfolioFieldType;
  options: FieldOption[];
  sortOrder: number;
};

export const listPortfolioFields = cache(async (portfolioId: string): Promise<PortfolioField[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("portfolio_fields")
    .select("id, name, field_type, options, sort_order")
    .eq("portfolio_id", portfolioId)
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  return rows(result, "portfolio fields").flatMap((f) =>
    isPortfolioFieldType(f.field_type)
      ? [{ id: f.id, name: f.name, fieldType: f.field_type, options: parseOptions(f.options), sortOrder: f.sort_order }]
      : [],
  );
});

// Values by project id, then field id. RLS leaves out projects the viewer can't read.
export const listPortfolioFieldValues = cache(
  async (portfolioId: string): Promise<Record<string, Record<string, Json>>> => {
    const supabase = await createClient();
    const result = await supabase
      .from("portfolio_field_values")
      .select("project_id, field_id, value")
      .eq("portfolio_id", portfolioId)
      .not("value", "is", null);
    const out: Record<string, Record<string, Json>> = {};
    for (const r of rows(result, "portfolio field values")) {
      if (r.value === null) continue;
      (out[r.project_id] ??= {})[r.field_id] = r.value;
    }
    return out;
  },
);

export type ProjectStatusUpdate = {
  id: string;
  projectId: string;
  status: string;
  // The status panel's title (Asana parity, batch 2); null for older updates and plain status changes.
  title: string | null;
  note: string | null;
  authorName: string | null;
  createdAt: string;
};

const STATUS_UPDATE_COLUMNS =
  "id, project_id, status, title, note, created_at, author:profiles!project_status_updates_author_id_fkey(full_name, email)";
// Before 20261011020000_asana_parity_2.sql (a preview deployed ahead of its migration): no title.
const STATUS_UPDATE_COLUMNS_UNTITLED =
  "id, project_id, status, note, created_at, author:profiles!project_status_updates_author_id_fkey(full_name, email)";

function toStatusUpdate(r: {
  id: string;
  project_id: string;
  status: string;
  title?: string | null;
  note: string | null;
  created_at: string;
  author: { full_name: string | null; email: string } | null;
}): ProjectStatusUpdate {
  return {
    id: r.id,
    projectId: r.project_id,
    status: r.status,
    title: r.title ?? null,
    note: r.note,
    authorName: r.author ? r.author.full_name?.trim() || r.author.email : null,
    createdAt: r.created_at,
  };
}

// Postgres "undefined column": a column this release reads hasn't been migrated yet.
function isMissingColumn(error: { code?: string } | null) {
  return error?.code === "42703";
}

// A project's status history, newest first (project Viewers+).
export const listProjectStatusUpdates = cache(async (projectId: string): Promise<ProjectStatusUpdate[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("project_status_updates")
    .select(STATUS_UPDATE_COLUMNS)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (isMissingColumn(result.error)) {
    const untitled = await supabase
      .from("project_status_updates")
      .select(STATUS_UPDATE_COLUMNS_UNTITLED)
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(50);
    return rows(untitled, "status history").map(toStatusUpdate);
  }
  return rows(result, "status history").map(toStatusUpdate);
});

// The latest status update of each project (for portfolio columns), keyed by project id.
export async function listLatestStatusUpdates(projectIds: string[]): Promise<Map<string, ProjectStatusUpdate>> {
  const latest = new Map<string, ProjectStatusUpdate>();
  if (projectIds.length === 0) return latest;
  const supabase = await createClient();
  const result = await supabase
    .from("project_status_updates")
    .select(STATUS_UPDATE_COLUMNS)
    .in("project_id", projectIds)
    .order("created_at", { ascending: false })
    .limit(2000);
  const updates = isMissingColumn(result.error)
    ? rows(
        await supabase
          .from("project_status_updates")
          .select(STATUS_UPDATE_COLUMNS_UNTITLED)
          .in("project_id", projectIds)
          .order("created_at", { ascending: false })
          .limit(2000),
        "status updates",
      ).map(toStatusUpdate)
    : rows(result, "status updates").map(toStatusUpdate);
  for (const update of updates) {
    if (!latest.has(update.projectId)) latest.set(update.projectId, update);
  }
  return latest;
}

// ---------------------------------------------------------------------------------------------
// Project page (Asana parity, batch 2): the Overview tab and the Share dialog. Every read uses the
// viewer's client, so RLS decides: project rows, members, stories, and team records for project
// Viewers+, goal links only for projects the viewer can read. Workspace admins get nothing extra.
// ---------------------------------------------------------------------------------------------

function personName(person: { full_name: string | null; email: string } | null): string | null {
  return person ? displayName(person) : null;
}

export type ProjectOverviewInfo = { createdAt: string; createdByName: string | null; dueOn: string | null };

// When and by whom the project was created, and its due date (projects.due_on; a preview deployed
// before 20261011020000_asana_parity_2.sql reads no due date).
export const getProjectOverviewInfo = cache(async (projectId: string): Promise<ProjectOverviewInfo | null> => {
  const supabase = await createClient();
  const result = await supabase
    .from("projects")
    .select("created_at, due_on, creator:profiles!projects_created_by_fkey(full_name, email)")
    .eq("id", projectId)
    .is("deleted_at", null)
    .maybeSingle();
  if (isMissingColumn(result.error)) {
    const row = maybe(
      await supabase
        .from("projects")
        .select("created_at, creator:profiles!projects_created_by_fkey(full_name, email)")
        .eq("id", projectId)
        .is("deleted_at", null)
        .maybeSingle(),
      "project",
    );
    return row ? { createdAt: row.created_at, createdByName: personName(row.creator), dueOn: null } : null;
  }
  const row = maybe(result, "project");
  return row ? { createdAt: row.created_at, createdByName: personName(row.creator), dueOn: row.due_on } : null;
});

export type ProjectStoryKind = "created_from_template" | "duplicated" | "archived" | "unarchived";
export type ProjectStoryItem = {
  id: string;
  kind: ProjectStoryKind;
  actorName: string | null;
  // The template or source project name, as it was at copy time.
  fromName: string | null;
  createdAt: string;
};

const PROJECT_STORY_KINDS: readonly string[] = ["created_from_template", "duplicated", "archived", "unarchived"];

// Project-level history (project_stories: copies, archive / unarchive), newest first.
export const listProjectStories = cache(async (projectId: string): Promise<ProjectStoryItem[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("project_stories")
    .select("id, kind, data, created_at, actor:profiles(email, full_name)")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(50);
  return rows(result, "project history").flatMap((story): ProjectStoryItem[] => {
    if (!PROJECT_STORY_KINDS.includes(story.kind)) return [];
    const data = story.data && typeof story.data === "object" && !Array.isArray(story.data) ? story.data : {};
    const name = story.kind === "duplicated" ? data.source_project_name : data.template_name;
    return [
      {
        id: story.id,
        kind: story.kind as ProjectStoryKind,
        actorName: personName(story.actor),
        fromName: typeof name === "string" ? name : null,
        createdAt: story.created_at,
      },
    ];
  });
});

export type ProjectGoalLink = { linkId: string; goal: Goal };

// Goals this project is connected to (goal_links; RLS shows a link only to people who can read the
// project, and goals are readable by everyone allowlisted).
export const listProjectGoalLinks = cache(async (projectId: string): Promise<ProjectGoalLink[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("goal_links")
    .select(`id, goal:goals!goal_links_goal_id_fkey(${GOAL_COLUMNS}, deleted_at)` as const)
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("created_at");
  return rows(result, "connected goals").flatMap((r): ProjectGoalLink[] =>
    r.goal && r.goal.deleted_at === null ? [{ linkId: r.id, goal: toGoal(r.goal) }] : [],
  );
});

export type ProjectTeamAccess = { teamId: string; name: string; role: string };

// Teams added to the project with a group invite (team_projects: a record of the invite, readable with
// the project). The people themselves are ordinary members.
export const listProjectTeamAccess = cache(async (projectId: string): Promise<ProjectTeamAccess[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("team_projects")
    .select("team_id, role, team:teams!team_projects_team_id_fkey(name, deleted_at)")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("created_at");
  return rows(result, "teams on the project").flatMap((r): ProjectTeamAccess[] =>
    r.team && r.team.deleted_at === null ? [{ teamId: r.team_id, name: r.team.name, role: r.role }] : [],
  );
});

// ---------------------------------------------------------------------------------------------
// Imports (Admin+ read; RLS returns nothing below Admin)
// ---------------------------------------------------------------------------------------------

export type ImportRun = {
  id: string;
  source: string;
  status: "running" | "completed" | "failed";
  fileNames: string[];
  summary: Record<string, unknown>;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export const listImportRuns = cache(async (projectId: string): Promise<ImportRun[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("import_runs")
    .select("id, source, status, file_names, summary, created_by, created_at, finished_at, creator:profiles(email, full_name)")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(20);
  return rows(result, "imports").map((r) => ({
    id: r.id,
    source: r.source,
    status: r.status === "completed" || r.status === "failed" ? r.status : "running",
    fileNames: r.file_names ?? [],
    summary: r.summary && typeof r.summary === "object" && !Array.isArray(r.summary) ? (r.summary as Record<string, unknown>) : {},
    createdBy: r.created_by,
    createdByName: r.creator ? (r.creator.full_name ?? r.creator.email) : null,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  }));
});

// ---------------------------------------------------------------------------------------------
// Templates (see 20261006020000_templates.sql)
// ---------------------------------------------------------------------------------------------

export type ProjectTemplate = {
  id: string;
  name: string;
  description: string | null;
  summary: TemplateSummary;
  isExample: boolean;
  // Only set when the viewer can still read the source project.
  sourceProject: { id: string; name: string } | null;
  createdByName: string | null;
  // Who saved it (the gallery's "Your templates").
  createdBy: string | null;
  updatedAt: string;
  // Admin+ of the live source project, or a workspace admin: rename, replace, delete.
  canManage: boolean;
};

// Workspace templates: everyone allowlisted can see and use them.
export const listProjectTemplates = cache(async (): Promise<ProjectTemplate[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("project_templates")
    .select("id, name, description, summary, is_example, source_project_id, created_by, updated_at, creator:profiles(email, full_name)")
    .is("deleted_at", null)
    .order("is_example", { ascending: false })
    .order("name");
  const templates = rows(result, "templates");
  const sourceIds = [...new Set(templates.map((t) => t.source_project_id).filter((id): id is string => Boolean(id)))];
  const [sources, manage] = await Promise.all([
    sourceIds.length
      ? supabase.from("projects").select("id, name").in("id", sourceIds).is("deleted_at", null)
      : Promise.resolve({ data: [] as { id: string; name: string }[], error: null }),
    Promise.all(
      templates.map(async (t) =>
        maybe(await supabase.rpc("can_manage_project_template", { target_template: t.id }), "template access"),
      ),
    ),
  ]);
  const sourceNames = new Map(rows(sources, "template sources").map((p) => [p.id, p.name]));
  return templates.map((t, index) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    summary: parseTemplateSummary(t.summary),
    isExample: t.is_example,
    sourceProject:
      t.source_project_id && sourceNames.has(t.source_project_id)
        ? { id: t.source_project_id, name: sourceNames.get(t.source_project_id)! }
        : null,
    createdByName: t.creator ? (t.creator.full_name ?? t.creator.email) : null,
    createdBy: t.created_by,
    updatedAt: t.updated_at,
    canManage: manage[index] === true,
  }));
});

export type TaskTemplate = {
  id: string;
  projectId: string;
  name: string;
  title: string;
  notes: string | null;
  subtasks: string[];
  fieldValueCount: number;
  assigneeId: string | null;
  updatedAt: string;
};

type TaskTemplateRow = Pick<
  Tables<"task_templates">,
  "id" | "project_id" | "name" | "title" | "notes" | "subtasks" | "field_values" | "assignee_id" | "updated_at"
>;

function toTaskTemplate(t: TaskTemplateRow): TaskTemplate {
  return {
    id: t.id,
    projectId: t.project_id,
    name: t.name,
    title: t.title,
    notes: t.notes,
    subtasks: parseSubtaskTitles(t.subtasks),
    fieldValueCount: Array.isArray(t.field_values) ? t.field_values.length : 0,
    assigneeId: t.assignee_id,
    updatedAt: t.updated_at,
  };
}

const TASK_TEMPLATE_COLUMNS = "id, project_id, name, title, notes, subtasks, field_values, assignee_id, updated_at";

export const listTaskTemplates = cache(async (projectId: string): Promise<TaskTemplate[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("task_templates")
    .select(TASK_TEMPLATE_COLUMNS)
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  return rows(result, "task templates").map(toTaskTemplate);
});

// Every task template the viewer can see (RLS: Viewer+ of its project), for the gallery.
export const listAllTaskTemplates = cache(async (): Promise<(TaskTemplate & { projectName: string })[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("task_templates")
    .select(`${TASK_TEMPLATE_COLUMNS}, project:projects!inner(name, deleted_at)`)
    .is("deleted_at", null)
    .is("project.deleted_at", null)
    .order("name");
  return rows(result, "task templates").map((t) => ({ ...toTaskTemplate(t), projectName: t.project.name }));
});

export type ProjectOrigin = {
  kind: "created_from_template" | "duplicated";
  // Template or source project name, as it was at copy time.
  fromName: string | null;
  fromProjectId: string | null;
  actorName: string | null;
  createdAt: string;
};

// How the project was made, when the copy engine made it (one project story per created project).
export const getProjectOrigin = cache(async (projectId: string): Promise<ProjectOrigin | null> => {
  const supabase = await createClient();
  const result = await supabase
    .from("project_stories")
    .select("kind, data, created_at, actor:profiles(email, full_name)")
    .eq("project_id", projectId)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  const story = maybe(result, "project history");
  if (!story || (story.kind !== "created_from_template" && story.kind !== "duplicated")) return null;
  const data = story.data && typeof story.data === "object" && !Array.isArray(story.data) ? story.data : {};
  const name = story.kind === "duplicated" ? data.source_project_name : data.template_name;
  return {
    kind: story.kind,
    fromName: typeof name === "string" ? name : null,
    fromProjectId: story.kind === "duplicated" && typeof data.source_project_id === "string" ? data.source_project_id : null,
    actorName: story.actor ? (story.actor.full_name ?? story.actor.email) : null,
    createdAt: story.created_at,
  };
});

// ---------------------------------------------------------------------------------------------
// Workspace admin (see 20261006030000_workspace_admin_comments.sql). Being a workspace admin never
// grants project access: every read below still goes through project RLS.
// ---------------------------------------------------------------------------------------------

export type WorkspaceAdmin = {
  profileId: string;
  name: string;
  email: string;
  addedAt: string;
};

export const isWorkspaceAdmin = cache(async (): Promise<boolean> => {
  const supabase = await createClient();
  return maybe(await supabase.rpc("is_workspace_admin", {}), "workspace admin check") === true;
});

export const listWorkspaceAdmins = cache(async (workspaceId: string): Promise<WorkspaceAdmin[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("workspace_admins")
    .select("profile_id, created_at, profile:profiles!workspace_admins_profile_id_fkey(email, full_name)")
    .eq("workspace_id", workspaceId)
    .is("deleted_at", null)
    .order("created_at");
  return rows(result, "workspace admins").map((a) => ({
    profileId: a.profile_id,
    name: a.profile?.full_name?.trim() || a.profile?.email || "Unknown",
    email: a.profile?.email ?? "",
    addedAt: a.created_at,
  }));
});

export type WorkspaceImportRun = ImportRun & { projectId: string; projectName: string };

// Past imports across the workspace. RLS shows a workspace admin the runs of projects they can read
// (any role), and project admins their own projects' runs; nothing else.
export const listWorkspaceImportRuns = cache(async (): Promise<WorkspaceImportRun[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("import_runs")
    .select(
      "id, project_id, source, status, file_names, summary, created_by, created_at, finished_at, creator:profiles(email, full_name), project:projects!inner(name, deleted_at)",
    )
    .is("deleted_at", null)
    .is("project.deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(50);
  return rows(result, "imports").map((r) => ({
    id: r.id,
    projectId: r.project_id,
    projectName: r.project.name,
    source: r.source,
    status: r.status === "completed" || r.status === "failed" ? r.status : "running",
    fileNames: r.file_names ?? [],
    summary: r.summary && typeof r.summary === "object" && !Array.isArray(r.summary) ? (r.summary as Record<string, unknown>) : {},
    createdBy: r.created_by,
    createdByName: r.creator ? (r.creator.full_name ?? r.creator.email) : null,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  }));
});

// ---------------------------------------------------------------------------------------------
// Workload (SECURITY INVOKER RPCs: only tasks the viewer can read are ever counted)
// ---------------------------------------------------------------------------------------------

type WorkloadRow = {
  task_id: string;
  title: string;
  assignee_id: string;
  start_on: string | null;
  due_on: string;
  value: number | null;
  project_id: string;
  can_edit: boolean;
};

const toWorkloadTask = (r: WorkloadRow): WorkloadTask => ({
  id: r.task_id,
  title: r.title,
  assigneeId: r.assignee_id,
  startOn: r.start_on,
  dueOn: r.due_on,
  value: r.value === null ? null : Number(r.value),
  projectId: r.project_id,
  canEdit: r.can_edit,
});

export async function projectWorkload(
  projectId: string,
  rangeStart: string,
  rangeEnd: string,
  valueFieldId: string | null,
): Promise<WorkloadTask[]> {
  const supabase = await createClient();
  const result = await supabase.rpc("project_workload", {
    target_project: projectId,
    range_start: rangeStart,
    range_end: rangeEnd,
    value_field: valueFieldId,
  });
  return rows(result, "workload").map(toWorkloadTask);
}

export async function portfolioWorkload(
  portfolioId: string,
  rangeStart: string,
  rangeEnd: string,
  valueFieldName: string | null,
): Promise<WorkloadTask[]> {
  const supabase = await createClient();
  const result = await supabase.rpc("portfolio_workload", {
    target_portfolio: portfolioId,
    range_start: rangeStart,
    range_end: rangeEnd,
    value_field_name: valueFieldName,
  });
  return rows(result, "workload").map(toWorkloadTask);
}

// Weekly capacity per person in a project's or a portfolio's workload.
export const listWorkloadCapacities = cache(
  async (scope: "project" | "portfolio", scopeId: string): Promise<Record<string, number>> => {
    const supabase = await createClient();
    const result = await supabase
      .from("workload_capacities")
      .select("profile_id, weekly_capacity")
      .eq(scope === "project" ? "project_id" : "portfolio_id", scopeId)
      .is("deleted_at", null);
    const out: Record<string, number> = {};
    for (const row of rows(result, "capacities")) out[row.profile_id] = Number(row.weekly_capacity);
    return out;
  },
);

// Number fields of a set of projects (workload "measure by" choices).
export async function listNumberFields(projectIds: string[]): Promise<FieldDef[]> {
  if (projectIds.length === 0) return [];
  return (await listFieldsForProjects(projectIds)).filter((f) => f.fieldType === "number");
}

// ---------------------------------------------------------------------------------------------
// Teams directory (see 20261006050000_goals_teams.sql). Teams are workspace-level: everyone
// allowlisted reads them. A team never grants project access; team_projects rows are only visible to
// people who can already read the project.
// ---------------------------------------------------------------------------------------------

export type TeamPerson = { profileId: string; role: TeamRole; name: string; email: string; addedAt: string };

export type Team = {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  members: TeamPerson[];
};

type TeamRow = {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  team_members: {
    profile_id: string;
    role: string;
    created_at: string;
    deleted_at: string | null;
    profile: { email: string; full_name: string | null } | null;
  }[];
};

const TEAM_COLUMNS =
  "id, name, description, created_at, team_members!team_members_team_id_fkey(profile_id, role, created_at, deleted_at, profile:profiles!team_members_profile_id_fkey(email, full_name))";

function toTeam(row: TeamRow): Team {
  const roleOrder = (role: TeamRole) => (role === "lead" ? 0 : 1);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    members: row.team_members
      .filter((m) => m.deleted_at === null && isTeamRole(m.role))
      .map((m) => ({
        profileId: m.profile_id,
        role: m.role as TeamRole,
        name: m.profile?.full_name?.trim() || m.profile?.email || "Unknown",
        email: m.profile?.email ?? "",
        addedAt: m.created_at,
      }))
      .sort((a, b) => roleOrder(a.role) - roleOrder(b.role) || a.name.localeCompare(b.name)),
  };
}

export const listTeams = cache(async (): Promise<Team[]> => {
  const supabase = await createClient();
  const result = await supabase.from("teams").select(TEAM_COLUMNS).is("deleted_at", null).order("name");
  return rows(result, "teams").map((row) => toTeam(row as TeamRow));
});

export const getTeam = cache(async (teamId: string): Promise<Team | null> => {
  const supabase = await createClient();
  const result = await supabase.from("teams").select(TEAM_COLUMNS).eq("id", teamId).is("deleted_at", null).maybeSingle();
  const row = maybe(result, "team");
  return row ? toTeam(row as TeamRow) : null;
});

export const canManageTeam = cache(async (teamId: string): Promise<boolean> => {
  const supabase = await createClient();
  return maybe(await supabase.rpc("can_manage_team", { target_team: teamId }), "team role") === true;
});

// ---------------------------------------------------------------------------------------------
// Workspace people (Asana feel, batch 2): the allowlist is readable by everyone allowlisted, so the
// Members page reads it with the viewer's client. Invite email status comes back for workspace admins
// only (RLS on email_outbox).
// ---------------------------------------------------------------------------------------------

export const listWorkspaceMembers = cache(async (): Promise<WorkspaceMember[]> => {
  const supabase = await createClient();
  const workspace = await getWorkspace();
  const [allowed, profiles, admins, teamRows, invites] = await Promise.all([
    supabase
      .from("allowed_emails")
      .select("email, invited_at, removed_at, created_at, inviter:profiles!allowed_emails_invited_by_fkey(full_name)")
      .order("email"),
    supabase.from("profiles").select("id, email, full_name, joined_at"),
    workspace
      ? supabase.from("workspace_admins").select("profile_id").eq("workspace_id", workspace.id).is("deleted_at", null)
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from("team_members")
      .select("profile_id, team:teams!team_members_team_id_fkey!inner(id, name, deleted_at)")
      .is("deleted_at", null)
      .is("team.deleted_at", null),
    supabase
      .from("email_outbox")
      .select("to_email, status, last_error, sent_at, created_at")
      .is("task_id", null)
      .eq("payload->>kind", "invite")
      .order("created_at", { ascending: false })
      .limit(500),
  ]);
  const byEmail = new Map(rows(profiles, "people").map((p) => [p.email.toLowerCase(), p] as const));
  const adminIds = new Set(rows(admins, "workspace admins").map((a) => a.profile_id));
  const teamsByProfile = new Map<string, { id: string; name: string }[]>();
  for (const m of rows(teamRows, "team memberships")) {
    const list = teamsByProfile.get(m.profile_id) ?? [];
    list.push({ id: m.team.id, name: m.team.name });
    teamsByProfile.set(m.profile_id, list);
  }
  const latestInvite = new Map<string, WorkspaceMember["inviteEmail"]>();
  for (const o of rows(invites, "invite emails")) {
    if (!latestInvite.has(o.to_email)) {
      latestInvite.set(o.to_email, { status: o.status, lastError: o.last_error, sentAt: o.sent_at, createdAt: o.created_at });
    }
  }
  return rows(allowed, "workspace members")
    .map((a): WorkspaceMember => {
      const profile = byEmail.get(a.email) ?? null;
      return {
        email: a.email,
        profileId: profile?.id ?? null,
        name: profile?.full_name?.trim() || a.email,
        role: profile && adminIds.has(profile.id) ? "admin" : "member",
        // Active once they've signed in with a confirmed address (profiles.joined_at); a profile alone can
        // be an unconfirmed sign-up.
        status: a.removed_at ? "removed" : profile?.joined_at ? "active" : "invited",
        teams: profile ? (teamsByProfile.get(profile.id) ?? []).sort((x, y) => x.name.localeCompare(y.name)) : [],
        invitedAt: a.invited_at,
        invitedByName: a.inviter?.full_name?.trim() || null,
        addedAt: a.created_at,
        removedAt: a.removed_at,
        inviteEmail: latestInvite.get(a.email) ?? null,
      };
    })
    .sort((x, y) => Number(y.role === "admin") - Number(x.role === "admin") || x.name.localeCompare(y.name));
});

// Pending invites (people who haven't signed in yet) for one project, portfolio, or team. RLS: with
// the target (project / portfolio Viewer+, teams: everyone allowlisted).
export const listPendingInvites = cache(
  async (target: "project" | "portfolio" | "team", targetId: string): Promise<PendingInvite[]> => {
    const supabase = await createClient();
    const column = target === "project" ? "project_id" : target === "portfolio" ? "portfolio_id" : "team_id";
    const result = await supabase
      .from("pending_memberships")
      .select("id, email, role, created_at, inviter:profiles!pending_memberships_created_by_fkey(full_name)")
      .eq(column, targetId)
      .is("applied_at", null)
      .is("deleted_at", null)
      .order("created_at");
    const invites = rows(result, "pending invites");
    // Their invite emails (Real features 1; the outbox policy shows them only to the people who manage
    // the invite, so everyone else just sees "Invited").
    const emails = invites.length
      ? await supabase
          .from("email_outbox")
          .select("payload, status, last_error, sent_at, created_at")
          .is("task_id", null)
          .eq("payload->>kind", "invite")
          .in(
            "payload->>pending_id",
            invites.map((r) => r.id),
          )
          .order("created_at", { ascending: false })
      : { data: [], error: null };
    const latest = new Map<string, InviteEmailStatus>();
    for (const o of emails.data ?? []) {
      const pendingId = o.payload && typeof o.payload === "object" && !Array.isArray(o.payload) ? o.payload.pending_id : null;
      if (typeof pendingId === "string" && !latest.has(pendingId)) {
        latest.set(pendingId, { status: o.status, lastError: o.last_error, sentAt: o.sent_at, createdAt: o.created_at });
      }
    }
    return invites.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      invitedAt: r.created_at,
      invitedByName: r.inviter?.full_name?.trim() || null,
      inviteEmail: latest.get(r.id) ?? null,
      lastEmailAt: latest.get(r.id)?.createdAt ?? null,
    }));
  },
);

// Browse projects: the viewer's own projects plus team-visible projects of their teams. Private
// projects of others never come back (workspace admins included).
export const browseProjects = cache(async (teamId?: string | null): Promise<BrowseProject[]> => {
  const supabase = await createClient();
  const result = await supabase.rpc("browse_projects", { target_team: teamId ?? null });
  return rows(result, "projects to browse").map((r) => ({
    projectId: r.project_id,
    name: r.name,
    description: r.description,
    teamId: r.team_id,
    teamName: r.team_name,
    visibility: isProjectVisibility(r.visibility) ? r.visibility : "private",
    status: r.status,
    archived: r.archived,
    memberCount: r.member_count,
    myRole: r.my_role,
  }));
});

// The Browse projects table's people and last-modified time (Asana parity, batch 4), for exactly the
// rows browse_projects returns, keyed by project. Null on a database without
// 20261011040000_asana_parity_4.sql (the table then shows member counts only).
export type BrowseProjectPeople = { ownerIds: string[]; memberIds: string[]; modifiedAt: string | null };

export const browseProjectPeople = cache(
  async (teamId?: string | null): Promise<Map<string, BrowseProjectPeople> | null> => {
    const supabase = await createClient();
    const result = await supabase.rpc("browse_project_people", { target_team: teamId ?? null });
    if (result.error?.code === "PGRST202") return null;
    return new Map(
      rows(result, "project people").map((r) => [
        r.project_id,
        { ownerIds: r.owner_ids ?? [], memberIds: r.member_ids ?? [], modifiedAt: r.modified_at },
      ]),
    );
  },
);

// Teams the viewer is in (active), for the New project team picker; the default team is always
// offered too (anyone may put a project there).
export const listMyTeamIds = cache(async (): Promise<Set<string>> => {
  const { user } = await getViewer();
  if (!user) return new Set();
  const supabase = await createClient();
  const result = await supabase.from("team_members").select("team_id").eq("profile_id", user.id).is("deleted_at", null);
  return new Set(rows(result, "your teams").map((r) => r.team_id));
});

// ---------------------------------------------------------------------------------------------
// Goals (workspace-level; progress is computed per viewer and never counts unreadable projects)
// ---------------------------------------------------------------------------------------------

const GOAL_COLUMNS =
  "id, title, notes, team_id, parent_id, owner_id, period_start, period_end, status, progress_mode, manual_progress, created_at";

function toGoal(row: Pick<
  Tables<"goals">,
  | "id"
  | "title"
  | "notes"
  | "team_id"
  | "parent_id"
  | "owner_id"
  | "period_start"
  | "period_end"
  | "status"
  | "progress_mode"
  | "manual_progress"
  | "created_at"
>): Goal {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    teamId: row.team_id,
    parentId: row.parent_id,
    ownerId: row.owner_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    status: isGoalStatus(row.status) ? row.status : "on_track",
    progressMode: isProgressMode(row.progress_mode) ? row.progress_mode : "manual",
    manualProgress: row.manual_progress,
    createdAt: row.created_at,
  };
}

export const listGoals = cache(async (): Promise<Goal[]> => {
  const supabase = await createClient();
  const result = await supabase.from("goals").select(GOAL_COLUMNS).is("deleted_at", null).order("created_at");
  return rows(result, "goals").map(toGoal);
});

export const getGoal = cache(async (goalId: string): Promise<Goal | null> => {
  const supabase = await createClient();
  const result = await supabase.from("goals").select(GOAL_COLUMNS).eq("id", goalId).is("deleted_at", null).maybeSingle();
  const row = maybe(result, "goal");
  return row ? toGoal(row) : null;
});

export const listGoalProgress = cache(async (): Promise<Map<string, GoalProgress>> => {
  const supabase = await createClient();
  const result = await supabase.rpc("goal_progress", {});
  return new Map(
    rows(result, "goal progress").map((r) => [
      r.goal_id,
      {
        progress: r.progress === null ? null : Number(r.progress),
        taskCount: r.task_count === null ? null : Number(r.task_count),
        completedCount: r.completed_count === null ? null : Number(r.completed_count),
        hiddenProjects: Number(r.hidden_project_count ?? 0),
        subGoalCount: Number(r.sub_goal_count ?? 0),
      },
    ]),
  );
});

// What the viewer needs to know to show edit controls (the database decides for real).
export const getGoalViewer = cache(async (): Promise<GoalViewer> => {
  const { user } = await getViewer();
  if (!user) return { id: "", isWorkspaceAdmin: false, leadTeamIds: [] };
  const supabase = await createClient();
  const [admin, leads] = await Promise.all([
    isWorkspaceAdmin(),
    supabase.from("team_members").select("team_id").eq("profile_id", user.id).eq("role", "lead").is("deleted_at", null),
  ]);
  return {
    id: user.id,
    isWorkspaceAdmin: admin,
    leadTeamIds: rows(leads, "team leads").map((r) => r.team_id),
  };
});

export type GoalLink = {
  id: string;
  kind: "project" | "portfolio";
  targetId: string;
  name: string;
  status: string | null;
};

// Links the viewer can see (RLS hides links to projects and portfolios they can't open).
export const listGoalLinks = cache(async (goalId: string): Promise<GoalLink[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("goal_links")
    .select(
      "id, project_id, portfolio_id, project:projects!goal_links_project_id_fkey(id, name, status, deleted_at), portfolio:portfolios!goal_links_portfolio_id_fkey(id, name, deleted_at)",
    )
    .eq("goal_id", goalId)
    .is("deleted_at", null)
    .order("created_at");
  return rows(result, "goal links").flatMap((r): GoalLink[] => {
    if (r.project && r.project.deleted_at === null) {
      return [{ id: r.id, kind: "project", targetId: r.project.id, name: r.project.name, status: r.project.status }];
    }
    if (r.portfolio && r.portfolio.deleted_at === null) {
      return [{ id: r.id, kind: "portfolio", targetId: r.portfolio.id, name: r.portfolio.name, status: null }];
    }
    return [];
  });
});

export type GoalStatusUpdate = {
  id: string;
  status: GoalStatus;
  body: string | null;
  authorId: string | null;
  authorName: string;
  createdAt: string;
};

export const listGoalStatusUpdates = cache(async (goalId: string): Promise<GoalStatusUpdate[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("goal_status_updates")
    .select("id, status, body, author_id, created_at, author:profiles!goal_status_updates_author_id_fkey(email, full_name)")
    .eq("goal_id", goalId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(100);
  return rows(result, "status updates").map((r) => ({
    id: r.id,
    status: isGoalStatus(r.status) ? r.status : "on_track",
    body: r.body,
    authorId: r.author_id,
    authorName: r.author?.full_name?.trim() || r.author?.email || "Someone",
    createdAt: r.created_at,
  }));
});

// ---------------------------------------------------------------------------------------------
// Reporting and export. Every number comes from SECURITY INVOKER RPCs that only count projects the
// viewer can read (RLS plus has_project_role per project); unreadable projects are only ever a count
// (workspace_hidden_project_count). Personal dashboards are owner-only (RLS).
// ---------------------------------------------------------------------------------------------

export type ReportRow = PortfolioCounts & { bucket: string | null; projectId: string | null };

export async function workspaceReport(
  filters: ReportFilters,
  groupBy: "none" | "project" | "assignee" | "section",
  timeZone: string,
): Promise<ReportRow[]> {
  const supabase = await createClient();
  const result = await supabase.rpc("workspace_report", {
    filters: reportFiltersJson(filters),
    group_by: groupBy,
    tz: timeZone,
  });
  return rows(result, "report").map((r) => ({
    bucket: r.bucket,
    projectId: r.project_id,
    total: Number(r.task_count),
    completed: Number(r.completed_count),
    incomplete: Number(r.incomplete_count),
    overdue: Number(r.overdue_count),
    completedRecent: Number(r.completed_recent_count),
  }));
}

export async function workspaceTotals(filters: ReportFilters, timeZone: string): Promise<PortfolioCounts> {
  const [row] = await workspaceReport(filters, "none", timeZone);
  return row ?? EMPTY_COUNTS;
}

export type SeriesPoint = { start: string; count: number };

export async function reportCompletedSeries(
  filters: ReportFilters,
  interval: SeriesInterval,
  timeZone: string,
): Promise<SeriesPoint[]> {
  const supabase = await createClient();
  const result = await supabase.rpc("report_completed_series", {
    filters: reportFiltersJson(filters),
    bucket_interval: interval,
    tz: timeZone,
  });
  return rows(result, "completed series").map((r) => ({ start: r.bucket_start, count: Number(r.completed_count) }));
}

export type OverdueTask = {
  taskId: string;
  title: string;
  projectId: string;
  assigneeId: string | null;
  dueOn: string;
  daysOverdue: number;
  parentTaskId: string | null;
};

export async function reportOverdueTasks(filters: ReportFilters, timeZone: string, max = 200): Promise<OverdueTask[]> {
  const supabase = await createClient();
  const result = await supabase.rpc("report_overdue_tasks", {
    filters: reportFiltersJson(filters),
    tz: timeZone,
    max_results: max,
  });
  return rows(result, "overdue tasks").map((r) => ({
    taskId: r.task_id,
    title: r.title,
    projectId: r.project_id,
    assigneeId: r.assignee_id,
    dueOn: r.due_on,
    daysOverdue: Number(r.days_overdue),
    parentTaskId: r.parent_task_id,
  }));
}

export type AllProjectsRow = {
  id: string;
  name: string;
  status: string;
  statusNote: string | null;
  counts: PortfolioCounts;
};

export async function allProjectsReport(timeZone: string): Promise<AllProjectsRow[]> {
  const supabase = await createClient();
  const result = await supabase.rpc("all_projects_report", { tz: timeZone });
  return rows(result, "all-projects report").map((r) => ({
    id: r.project_id,
    name: r.name,
    status: r.status,
    statusNote: r.status_note,
    counts: {
      total: Number(r.task_count),
      completed: Number(r.completed_count),
      incomplete: Number(r.incomplete_count),
      overdue: Number(r.overdue_count),
      completedRecent: Number(r.completed_recent_count),
    },
  }));
}

// How many active projects the viewer can't read (a number only; never names or ids).
export const countHiddenWorkspaceProjects = cache(async (): Promise<number> => {
  const supabase = await createClient();
  const result = await supabase.rpc("workspace_hidden_project_count");
  return Number(maybe(result, "hidden projects") ?? 0);
});

export type SectionLabel = { id: string; name: string; projectId: string };

// Names of sections (by id) the viewer can read, for report labels.
export async function listSectionLabels(ids: string[]): Promise<Map<string, SectionLabel>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const supabase = await createClient();
  const result = await supabase.from("sections").select("id, name, project_id").in("id", unique);
  return new Map(rows(result, "sections").map((s) => [s.id, { id: s.id, name: s.name, projectId: s.project_id }]));
}

export const listPersonalDashboards = cache(async (): Promise<PersonalDashboard[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("personal_dashboards")
    .select("id, name, sort_order, created_at")
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  return rows(result, "dashboards").map((d) => ({
    id: d.id,
    name: d.name,
    sortOrder: d.sort_order,
    createdAt: d.created_at,
  }));
});

export const getPersonalDashboard = cache(async (dashboardId: string): Promise<PersonalDashboard | null> => {
  const supabase = await createClient();
  const row = maybe(
    await supabase
      .from("personal_dashboards")
      .select("id, name, sort_order, created_at")
      .eq("id", dashboardId)
      .is("deleted_at", null)
      .maybeSingle(),
    "dashboard",
  );
  return row ? { id: row.id, name: row.name, sortOrder: row.sort_order, createdAt: row.created_at } : null;
});

export const listPersonalWidgets = cache(async (dashboardId: string): Promise<PersonalWidget[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("personal_dashboard_widgets")
    .select("*")
    .eq("dashboard_id", dashboardId)
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  return rows(result, "dashboard widgets").flatMap((w) =>
    isPersonalWidgetKind(w.kind)
      ? [
          {
            id: w.id,
            dashboardId: w.dashboard_id,
            kind: w.kind,
            title: w.title,
            filters: parseReportFilters(w.filters),
            interval: isSeriesInterval(w.series_interval) ? w.series_interval : "week",
            sortOrder: w.sort_order,
          },
        ]
      : [],
  );
});

// The viewer's own List column widths for a project (list_column_widths, own rows only by RLS).
export const getListColumnWidths = cache(async (projectId: string): Promise<ColumnWidths> => {
  if (!isUuid(projectId)) return {};
  const supabase = await createClient();
  const { data } = await supabase.from("list_column_widths").select("widths").eq("project_id", projectId).maybeSingle();
  return parseColumnWidths(data?.widths);
});

// Files tab: every active attachment on the project's active tasks and their subtasks (read through
// RLS, so only tasks the viewer can read), newest first.
export type ProjectFile = {
  id: string;
  fileName: string;
  contentType: string | null;
  sizeBytes: number;
  uploadedBy: string;
  // Where it came from (Real features 1): uploaded in the app, a form submitter's file, or a forwarded
  // email's attachment. A form file's uploadedBy is a stand-in (the form's creator), so Files says "Form".
  source: "upload" | "form" | "email";
  createdAt: string;
  taskId: string;
  taskTitle: string;
};

const FILE_COLUMNS = "id, file_name, content_type, size_bytes, uploaded_by, created_at, deleted_at";
const MAX_PROJECT_FILES = 500;

export const listProjectFiles = cache(async (projectId: string): Promise<ProjectFile[]> => {
  if (!isUuid(projectId)) return [];
  const supabase = await createClient();
  type FileRow = {
    id: string;
    file_name: string;
    content_type: string | null;
    size_bytes: number;
    uploaded_by: string;
    created_at: string;
    deleted_at: string | null;
    // With Real features 1's database update: upload | form | email.
    source?: string;
  };
  type TaskRow = { id: string; title: string; deleted_at: string | null; task_attachments: FileRow[] };
  const columns = (await hasReal1Schema()) ? `${FILE_COLUMNS}, source` : FILE_COLUMNS;
  const files: ProjectFile[] = [];
  const add = (task: TaskRow) => {
    if (task.deleted_at) return;
    for (const f of task.task_attachments ?? []) {
      if (f.deleted_at) continue;
      files.push({
        id: f.id,
        fileName: f.file_name,
        contentType: f.content_type,
        sizeBytes: f.size_bytes,
        uploadedBy: f.uploaded_by,
        source: f.source === "form" || f.source === "email" ? f.source : "upload",
        createdAt: f.created_at,
        taskId: task.id,
        taskTitle: task.title,
      });
    }
  };

  const memberships = await supabase
    .from("task_projects")
    .select(`task_id, tasks!inner(id, title, deleted_at, task_attachments(${columns}))`)
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .limit(5000);
  const taskIds: string[] = [];
  for (const row of rows(memberships, "project files")) {
    const task = row.tasks as unknown as TaskRow;
    taskIds.push(task.id);
    add(task);
  }
  // Subtasks have no memberships: they live under their top-level task.
  for (let i = 0; i < taskIds.length; i += 200) {
    const subtasks = await supabase
      .from("tasks")
      .select(`id, title, deleted_at, task_attachments(${columns})`)
      .in("root_task_id", taskIds.slice(i, i + 200))
      .is("deleted_at", null);
    for (const task of rows(subtasks, "subtask files")) add(task as unknown as TaskRow);
  }
  return files.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MAX_PROJECT_FILES);
});

// ---------------------------------------------------------------------------------------------
// Asana parity, batch 5: Home's People widget, the team page (curated work, calendar), and the
// Admin console (last activity, invite deliveries). Everything reads with the viewer's own client.
// ---------------------------------------------------------------------------------------------

export type Collaborator = { id: string; name: string; email: string; sharedProjects: number };

// People who share the most active projects with the viewer (Home → People). project_members is
// readable for the projects the viewer is in (project Viewer+), so this only ever counts projects they
// can open; people removed from the workspace are left out. PostgREST returns at most 1,000 rows a
// request, so the memberships of the viewer's active projects are read page by page (in a stable order).
const COLLABORATOR_PAGE = 1000;
const COLLABORATOR_MAX_ROWS = 20_000;

export const listFrequentCollaborators = cache(async (limit = 12): Promise<Collaborator[]> => {
  const { user } = await getViewer();
  if (!user) return [];
  const supabase = await createClient();
  const [projects, people] = await Promise.all([listProjects(), listActivePeople()]);
  if (projects.length === 0) return [];
  const shared = new Map<string, Set<string>>();
  for (let from = 0; from < COLLABORATOR_MAX_ROWS; from += COLLABORATOR_PAGE) {
    const page = rows(
      await supabase
        .from("project_members")
        .select("project_id, profile_id")
        .in("project_id", projects.map((p) => p.id))
        .is("deleted_at", null)
        .neq("profile_id", user.id)
        .order("id")
        .range(from, from + COLLABORATOR_PAGE - 1),
      "project members",
    );
    for (const m of page) {
      const set = shared.get(m.profile_id) ?? new Set<string>();
      set.add(m.project_id);
      shared.set(m.profile_id, set);
    }
    if (page.length < COLLABORATOR_PAGE) break;
  }
  return people
    .filter((p) => p.id !== user.id && shared.has(p.id))
    .map((p) => ({ ...p, sharedProjects: shared.get(p.id)!.size }))
    .sort((a, b) => b.sharedProjects - a.sharedProjects || a.name.localeCompare(b.name))
    .slice(0, limit);
});

// A team's Curated work in order, only the items the viewer can open (RLS). Null on a database without
// 20261012050000_asana_parity_5.sql.
export const listTeamCuratedWork = cache(async (teamId: string): Promise<CuratedWorkItem[] | null> => {
  const supabase = await createClient();
  const result = await supabase
    .from("team_curated_work")
    .select(
      "id, project_id, portfolio_id, sort_order, project:projects(id, name, description, status, archived_at, deleted_at), portfolio:portfolios(id, name, notes, deleted_at)",
    )
    .eq("team_id", teamId)
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  if (result.error && ["PGRST205", "42P01", "PGRST200"].includes(result.error.code ?? "")) return null;
  return rows(result, "curated work").flatMap((row): CuratedWorkItem[] => {
    if (row.project && !row.project.deleted_at) {
      return [
        {
          id: row.id,
          kind: "project",
          targetId: row.project.id,
          name: row.project.name,
          description: row.project.description,
          status: row.project.status,
          archived: row.project.archived_at !== null,
          sortOrder: row.sort_order,
        },
      ];
    }
    if (row.portfolio && !row.portfolio.deleted_at) {
      return [
        {
          id: row.id,
          kind: "portfolio",
          targetId: row.portfolio.id,
          name: row.portfolio.name,
          description: row.portfolio.notes,
          status: null,
          archived: false,
          sortOrder: row.sort_order,
        },
      ];
    }
    return [];
  });
});

// Tasks due from `from` to `to` (local days, inclusive) in the team's projects the viewer is a member
// of — the team Calendar. Public-to-team projects the viewer hasn't joined and private projects of
// others are never read (browse_projects only lists the former, with no role, and RLS hides tasks).
// Top-level tasks only (subtasks have no memberships); a multi-homed task shows once, under its first
// team project.
export async function listTeamCalendarTasks(
  teamId: string,
  from: string,
  to: string,
): Promise<{ tasks: TeamCalendarTask[]; projectCount: number; capped: boolean }> {
  const projects = (await browseProjects(teamId)).filter((p) => p.myRole !== null);
  if (projects.length === 0) return { tasks: [], projectCount: 0, capped: false };
  const byId = new Map(projects.map((p) => [p.projectId, p] as const));
  const supabase = await createClient();
  // Tasks whose span (start date, else due date, through the due date) touches the visible weeks.
  const result = await supabase
    .from("task_projects")
    .select("project_id, task:tasks!inner(id, title, start_on, due_on, completed_at, assignee_id, kind, deleted_at)")
    .in("project_id", [...byId.keys()])
    .is("deleted_at", null)
    .is("task.deleted_at", null)
    .gte("task.due_on", from)
    .or(`start_on.lte.${to},due_on.lte.${to}`, { referencedTable: "task" })
    .order("project_id")
    .limit(TEAM_CALENDAR_LIMIT);
  const tasks = new Map<string, TeamCalendarTask>();
  const list = rows(result, "team calendar");
  for (const row of list) {
    const t = row.task;
    if (!t.due_on) continue;
    const project = byId.get(row.project_id);
    // The viewer's own role in the project (an archived project caps everyone at Viewer); a task in
    // several of the team's projects is editable through any of them. The database decides on save.
    const canEdit = Boolean(project && !project.archived && hasRole(isProjectRole(project.myRole) ? project.myRole : null, "editor"));
    const seen = tasks.get(t.id);
    if (seen) {
      if (canEdit) seen.canEdit = true;
      continue;
    }
    tasks.set(t.id, {
      id: t.id,
      title: t.title,
      startOn: t.start_on && t.start_on <= t.due_on ? t.start_on : null,
      dueOn: t.due_on,
      completedAt: t.completed_at,
      assigneeId: t.assignee_id,
      kind: t.kind,
      projectId: row.project_id,
      projectName: project?.name ?? "Project",
      canEdit,
    });
  }
  const sorted = [...tasks.values()].sort(
    (a, b) => (a.startOn ?? a.dueOn).localeCompare(b.startOn ?? b.dueOn) || a.dueOn.localeCompare(b.dueOn) || a.title.localeCompare(b.title),
  );
  return { tasks: sorted, projectCount: projects.length, capped: list.length >= TEAM_CALENDAR_LIMIT };
}

// When each allowlisted address last signed in (Admin console → Users). Null when the viewer isn't a
// workspace admin, or on a database without 20261012050000_asana_parity_5.sql.
export const listWorkspaceMemberActivity = cache(async (): Promise<Map<string, string | null> | null> => {
  const supabase = await createClient();
  const result = await supabase.rpc("list_workspace_member_activity");
  if (result.error && ["PGRST202", "42501", "42883"].includes(result.error.code ?? "")) return null;
  return new Map(rows(result, "member activity").map((r) => [r.email.toLowerCase(), r.last_sign_in_at] as const));
});

export type MemberActivity = { signedInAt: string | null; activeAt: string | null };

// Each allowlisted person's last sign-in and last activity (Admin console → Users), by lowercased
// address: list_member_last_activity (Real features 2) — workspace admins get everyone. Falls back to
// sign-ins only (activeAt undefined → the UI says so) on a database without it; null when the viewer
// isn't a workspace admin or neither function exists.
export const listMemberLastActivity = cache(
  async (): Promise<{ byEmail: Map<string, MemberActivity>; activityTracked: boolean } | null> => {
    const supabase = await createClient();
    const result = await supabase.rpc("list_member_last_activity", {});
    if (!result.error) {
      return {
        byEmail: new Map(
          (result.data ?? []).map((r) => [r.email.toLowerCase(), { signedInAt: r.last_sign_in_at, activeAt: r.last_active_at }] as const),
        ),
        activityTracked: true,
      };
    }
    if (!["PGRST202", "42883"].includes(result.error.code ?? "")) {
      throw new Error(`Failed to load member activity: ${result.error.message}`);
    }
    const signIns = await listWorkspaceMemberActivity();
    if (!signIns) return null;
    return {
      byEmail: new Map([...signIns].map(([email, at]) => [email, { signedInAt: at, activeAt: null }] as const)),
      activityTracked: false,
    };
  },
);

export type InviteDelivery = {
  id: string;
  email: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  sentAt: string | null;
  createdAt: string;
  // What Resend reported after sending (Real features 3).
  deliveryStatus: DeliveryStatus | null;
};

// The latest workspace invite emails (Admin console → Email). RLS: workspace admins read invite rows;
// everyone else gets none.
export const listInviteDeliveries = cache(async (limit = 50): Promise<InviteDelivery[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("email_outbox")
    .select("id, to_email, status, attempts, max_attempts, last_error, sent_at, created_at")
    .is("task_id", null)
    .eq("payload->>kind", "invite")
    .order("created_at", { ascending: false })
    .limit(limit);
  const invites = rows(result, "invite emails");
  const delivery = await deliveryStatuses(invites.map((r) => r.id));
  return invites.map((r) => ({
    id: r.id,
    email: r.to_email,
    status: r.status,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    lastError: r.last_error,
    sentAt: r.sent_at,
    createdAt: r.created_at,
    deliveryStatus: delivery.get(r.id) ?? null,
  }));
});

// ---------------------------------------------------------------------------------------------
// Email extras (Real features 3): the person's digest / report email switches, their scheduled report
// emails, and the Admin console's delivery overview and suppression list. Every read uses the viewer's
// own client: email_preferences and report_schedules are own rows only; the overview and the list are
// workspace admins only (and never carry a subject, body, task, or project).
// ---------------------------------------------------------------------------------------------

// Null on a database without the migration; the defaults when the person never changed anything.
export const getMyEmailPreferences = cache(async (): Promise<EmailPreferences | null> => {
  if (!(await hasReal3Schema())) return null;
  const supabase = await createClient();
  const result = await supabase
    .from("email_preferences")
    .select("digest, digest_hour, digest_weekday, time_zone, report_emails, digest_next_at, digest_last_sent_at")
    .maybeSingle();
  if (result.error) return null;
  const r = result.data;
  if (!r) return DEFAULT_EMAIL_PREFERENCES;
  return {
    digest: isDigestFrequency(r.digest) ? r.digest : "off",
    hour: r.digest_hour,
    weekday: r.digest_weekday,
    timeZone: r.time_zone,
    reportEmails: r.report_emails,
    nextDigestAt: r.digest_next_at,
    lastDigestAt: r.digest_last_sent_at,
  };
});

// The viewer's own scheduled report emails (owner-only RLS), newest first; removed ones left out. Null on
// a database without the migration.
export const listReportSchedules = cache(async (): Promise<ReportSchedule[] | null> => {
  if (!(await hasReal3Schema())) return null;
  const supabase = await createClient();
  const result = await supabase
    .from("report_schedules")
    .select(
      "id, name, report, filters, frequency, weekday, month_day, send_hour, time_zone, recipients, paused_at, next_run_at, last_run_at, last_sent_at, last_sent_count, created_at",
    )
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  return rows(result, "scheduled report emails").map((r) => ({
    id: r.id,
    name: r.name,
    report: isReportKind(r.report) ? r.report : "overview",
    filters: parseReportFilters(r.filters),
    frequency: isScheduleFrequency(r.frequency) ? r.frequency : "weekly",
    weekday: r.weekday,
    monthDay: r.month_day,
    hour: r.send_hour,
    timeZone: r.time_zone,
    recipients: r.recipients,
    pausedAt: r.paused_at,
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at,
    lastSentAt: r.last_sent_at,
    lastSentCount: r.last_sent_count,
    createdAt: r.created_at,
  }));
});

export type WorkspaceEmailDelivery = {
  id: string;
  kind: string;
  recipient: string;
  inWorkspace: boolean;
  status: string;
  deliveryStatus: DeliveryStatus | null;
  deliveryDetail: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  deliveryEventAt: string | null;
  suppressed: boolean;
};

// Admin console → Email: the latest emails of every kind (workspace admins; null for anyone else or on a
// database without the migration).
export const listWorkspaceEmailDeliveries = cache(async (limit = 100): Promise<WorkspaceEmailDelivery[] | null> => {
  if (!(await hasReal3Schema())) return null;
  const supabase = await createClient();
  const result = await supabase.rpc("list_workspace_email_deliveries", { max_results: limit });
  if (result.error) return null;
  return (result.data ?? []).map((r) => ({
    id: r.id,
    kind: r.kind,
    recipient: r.recipient,
    inWorkspace: r.in_workspace,
    status: r.status,
    deliveryStatus: isDeliveryEvent(r.delivery_status) ? r.delivery_status : null,
    deliveryDetail: r.delivery_detail,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    lastError: r.last_error,
    createdAt: r.created_at,
    sentAt: r.sent_at,
    deliveryEventAt: r.delivery_event_at,
    suppressed: r.suppressed,
  }));
});

export type WorkspaceEmailSummary = {
  sent: number;
  delivered: number;
  delayed: number;
  bounced: number;
  complained: number;
  failed: number;
  waiting: number;
  suppressedAddresses: number;
};

export const workspaceEmailSummary = cache(async (days = 30): Promise<WorkspaceEmailSummary | null> => {
  if (!(await hasReal3Schema())) return null;
  const supabase = await createClient();
  const result = await supabase.rpc("workspace_email_summary", { window_days: days });
  const r = result.error ? null : result.data?.[0];
  if (!r) return null;
  return {
    sent: Number(r.sent),
    delivered: Number(r.delivered),
    delayed: Number(r.delayed),
    bounced: Number(r.bounced),
    complained: Number(r.complained),
    failed: Number(r.failed),
    waiting: Number(r.waiting),
    suppressedAddresses: Number(r.suppressed_addresses),
  };
});

export type EmailSuppression = {
  id: string;
  email: string;
  inWorkspace: boolean;
  reason: string;
  detail: string | null;
  emailKind: string | null;
  createdAt: string;
};

// The active suppression list (workspace admins only, through list_email_suppressions: addresses outside
// the workspace masked). Null for anyone else or on a database without the migration.
export const listEmailSuppressions = cache(async (): Promise<EmailSuppression[] | null> => {
  if (!(await hasReal3Schema())) return null;
  const supabase = await createClient();
  const result = await supabase.rpc("list_email_suppressions");
  if (result.error) return null;
  return (result.data ?? []).map((r) => ({
    id: r.id,
    email: r.email,
    inWorkspace: r.in_workspace,
    reason: r.reason,
    detail: r.detail,
    emailKind: r.email_kind,
    createdAt: r.created_at,
  }));
});

// ---------------------------------------------------------------------------------------------
// Person profile pages (Real features 2): /people/<id>. Everything reads with the viewer's own client,
// so the open tasks, activity, and projects shown are only ones RLS lets the viewer read; the
// workspace-wide last activity time comes from list_member_last_activity only for workspace admins and
// the person themselves.
// ---------------------------------------------------------------------------------------------

export type PersonTask = {
  id: string;
  title: string;
  dueOn: string | null;
  completedAt: string | null;
  kind: string;
  // The project to name: the home project when the viewer can read it, else another readable one;
  // null for a private task.
  projectName: string | null;
  isSubtask: boolean;
};

export type PersonActivity = {
  id: string;
  at: string;
  kind: "story" | "comment";
  // Stories: the story kind (activityVerb()); comments: "comment".
  verb: string;
  taskId: string;
  taskTitle: string;
  // Comments: the first line of the comment.
  excerpt: string | null;
  // Back-to-back story lines of the same kind on the same task are folded into one (at = the newest).
  times: number;
};

export type PersonProfile = {
  id: string;
  name: string;
  email: string;
  joinedAt: string | null;
  status: "active" | "invited" | "removed" | "not_in_workspace";
  isWorkspaceAdmin: boolean;
  teams: { id: string; name: string; role: TeamRole }[];
  // Projects both can open: the person's memberships RLS shows the viewer (projects the viewer is in).
  projects: { id: string; name: string; role: string; archived: boolean }[];
  openTasks: PersonTask[];
  // How many open tasks assigned to them the viewer can read (openTasks shows the first PROFILE_TASK_LIMIT).
  openTaskCount: number;
  recentlyCompleted: PersonTask[];
  activity: PersonActivity[];
  // "workspace": from list_member_last_activity (workspace admins, or the person themselves);
  // "visible": the newest activity the viewer can read; null when there's none.
  lastActivity: { at: string | null; signedInAt: string | null; scope: "workspace" | "visible" };
};

const PERSON_TASK_COLUMNS = "id, title, due_on, completed_at, kind, home_project_id, parent_task_id, root_task_id";

export const getPersonProfile = cache(async (profileId: string): Promise<PersonProfile | null> => {
  if (!isUuid(profileId)) return null;
  const { user } = await getViewer();
  if (!user) return null;
  const supabase = await createClient();
  const profile = maybe(
    await supabase.from("profiles").select("id, email, full_name, joined_at").eq("id", profileId).maybeSingle(),
    "person",
  );
  if (!profile) return null;
  const email = profile.email.toLowerCase();
  const self = profileId === user.id;
  const [allowed, admin, viewerIsAdmin, teamRows, memberRows, openResult, doneResult, stories, comments, readable] =
    await Promise.all([
      supabase.from("allowed_emails").select("removed_at").eq("email", email).maybeSingle(),
      supabase.from("workspace_admins").select("id").eq("profile_id", profileId).is("deleted_at", null).limit(1),
      isWorkspaceAdmin(),
      supabase
        .from("team_members")
        .select("role, team:teams!team_members_team_id_fkey!inner(id, name, deleted_at)")
        .eq("profile_id", profileId)
        .is("deleted_at", null)
        .is("team.deleted_at", null),
      supabase
        .from("project_members")
        .select("role, project:projects!inner(id, name, archived_at, deleted_at)")
        .eq("profile_id", profileId)
        .is("deleted_at", null)
        .is("project.deleted_at", null),
      supabase
        .from("tasks")
        .select(PERSON_TASK_COLUMNS, { count: "exact" })
        .eq("assignee_id", profileId)
        .is("completed_at", null)
        .is("deleted_at", null)
        .order("due_on", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(PROFILE_TASK_LIMIT),
      supabase
        .from("tasks")
        .select(PERSON_TASK_COLUMNS)
        .eq("assignee_id", profileId)
        .not("completed_at", "is", null)
        .is("deleted_at", null)
        .order("completed_at", { ascending: false })
        .limit(10),
      supabase
        .from("task_stories")
        .select("id, kind, created_at, task:tasks!inner(id, title, deleted_at, source, created_at)")
        .eq("actor_id", profileId)
        .is("task.deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(PROFILE_ACTIVITY_LIMIT * 2),
      supabase
        .from("comments")
        .select("id, body, created_at, task:tasks!inner(id, title, deleted_at)")
        .eq("author_id", profileId)
        .is("deleted_at", null)
        .is("task.deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(PROFILE_ACTIVITY_LIMIT),
      listReadableProjects(),
    ]);

  const projectNames = new Map(readable.map((p) => [p.id, p.name] as const));
  const openRows = rows(openResult, "their open tasks");
  const doneRows = rows(doneResult, "their completed tasks");
  // Tasks whose home project the viewer can't open (multi-homed into one they can): name a readable one.
  const unnamed = [...openRows, ...doneRows]
    .filter((t) => t.home_project_id && !projectNames.has(t.home_project_id))
    .map((t) => t.root_task_id ?? t.id);
  const otherProject = new Map<string, string>();
  if (unnamed.length) {
    for (const m of rows(
      await supabase.from("task_projects").select("task_id, project_id").in("task_id", [...new Set(unnamed)]).is("deleted_at", null),
      "task projects",
    )) {
      const name = projectNames.get(m.project_id);
      if (name && !otherProject.has(m.task_id)) otherProject.set(m.task_id, name);
    }
  }
  const toTask = (t: (typeof openRows)[number]): PersonTask => ({
    id: t.id,
    title: t.title,
    dueOn: t.due_on,
    completedAt: t.completed_at,
    kind: t.kind,
    projectName: t.home_project_id
      ? (projectNames.get(t.home_project_id) ?? otherProject.get(t.root_task_id ?? t.id) ?? null)
      : null,
    isSubtask: t.parent_task_id !== null,
  });

  // Activity the viewer can read: task stories they caused (not the ones an inbound webhook wrote in
  // their name while creating a task) and their comments, newest first.
  const activity: PersonActivity[] = [
    ...rows(stories, "their activity")
      .filter((s) => !(s.task.source === "inbound" && s.created_at === s.task.created_at))
      .map((s) => ({
        id: `story-${s.id}`,
        at: s.created_at,
        kind: "story" as const,
        verb: s.kind,
        taskId: s.task.id,
        taskTitle: s.task.title,
        excerpt: null,
        times: 1,
      })),
    ...rows(comments, "their comments").map((c) => ({
      id: `comment-${c.id}`,
      at: c.created_at,
      kind: "comment" as const,
      verb: "comment",
      taskId: c.task.id,
      taskTitle: c.task.title,
      excerpt: c.body.split("\n").find((line) => line.trim())?.trim().slice(0, 200) ?? null,
      times: 1,
    })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .reduce<PersonActivity[]>((list, item) => {
      const last = list[list.length - 1];
      if (last && item.kind === "story" && last.kind === "story" && last.verb === item.verb && last.taskId === item.taskId) {
        last.times += 1;
      } else {
        list.push(item);
      }
      return list;
    }, [])
    .slice(0, PROFILE_ACTIVITY_LIMIT);

  let lastActivity: PersonProfile["lastActivity"] = { at: activity[0]?.at ?? null, signedInAt: null, scope: "visible" };
  if (self || viewerIsAdmin) {
    const result = await supabase.rpc("list_member_last_activity", { target_profile: profileId });
    const row = result.error ? null : (result.data?.[0] ?? null);
    if (row) lastActivity = { at: row.last_active_at, signedInAt: row.last_sign_in_at, scope: "workspace" };
  }

  const allowedRow = maybe(allowed, "allowlist entry");
  return {
    id: profile.id,
    name: displayName(profile),
    email: profile.email,
    joinedAt: profile.joined_at,
    status: !allowedRow
      ? "not_in_workspace"
      : allowedRow.removed_at
        ? "removed"
        : profile.joined_at
          ? "active"
          : "invited",
    isWorkspaceAdmin: rows(admin, "workspace admins").length > 0,
    teams: rows(teamRows, "their teams")
      .filter((m) => isTeamRole(m.role))
      .map((m) => ({ id: m.team.id, name: m.team.name, role: m.role as TeamRole }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    projects: rows(memberRows, "their projects")
      .map((m) => ({ id: m.project.id, name: m.project.name, role: m.role, archived: m.project.archived_at !== null }))
      .sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name)),
    openTasks: openRows.map(toTask),
    openTaskCount: openResult.count ?? openRows.length,
    recentlyCompleted: doneRows.map(toTask),
    activity,
    lastActivity,
  };
});
