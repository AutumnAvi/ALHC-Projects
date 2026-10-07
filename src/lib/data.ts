import "server-only";
import { cache } from "react";
import { getViewer } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { parseOptions, type FieldDef, type FieldOption, type FieldType } from "@/lib/fields";
import { parseQuestions, type FormDef, type PublicForm } from "@/lib/forms";
import {
  parsePresetInputs,
  toRuleDef,
  type RuleDef,
  type RulePreset,
  type RuleRun,
} from "@/lib/rules";
import { parseRecurrence, type Recurrence } from "@/lib/recurrence";
import { REACTIONS, type ReactionKey } from "@/lib/reactions";
import { toProjectIntegrations, type ProjectIntegrations } from "@/lib/integrations-shared";
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
import { isMyTaskSectionKind, type MyTaskPlacement, type MyTaskSection } from "@/lib/my-tasks";
import type { WorkloadTask } from "@/lib/workload";
import {
  isGoalStatus,
  isProgressMode,
  type Goal,
  type GoalProgress,
  type GoalStatus,
  type GoalViewer,
} from "@/lib/goals";
import { isTeamRole, type TeamRole } from "@/lib/teams";
import { toTag, type Tag } from "@/lib/tags";
import type { Json, Tables } from "@/lib/supabase/database.types";
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
>;

const PROJECT_COLUMNS =
  "id, name, description, sort_order, approval_completes_task, status, status_note, status_updated_at, status_updated_by, archived_at";
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
  // Active tag links (ids; look names and colours up in listTags()).
  tagIds: string[];
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
};

export type TaskStory = {
  id: string;
  actorId: string | null;
  kind: string;
  data: Json;
  createdAt: string;
};

type QueryResult<T> = { data: T; error: { message: string } | null };

function maybe<T>(result: QueryResult<T>, what: string): T {
  if (result.error) throw new Error(`Failed to load ${what}: ${result.error.message}`);
  return result.data;
}

function rows<T>(result: QueryResult<T[] | null>, what: string): T[] {
  return maybe(result, what) ?? [];
}

export const getWorkspace = cache(async () => {
  const supabase = await createClient();
  const result = await supabase
    .from("workspaces")
    .select("id, name")
    .is("deleted_at", null)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  return maybe(result, "workspace");
});

// Active projects the viewer can read: the sidebar, Home, and every project picker. Archived projects
// are left out (listArchivedProjects); listReadableProjects has both, for labelling tasks.
export const listProjects = cache(async (): Promise<Project[]> =>
  (await listReadableProjects()).filter((p) => p.archived_at === null),
);

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
      email: m.profile.email,
      fullName: m.profile.full_name,
      avatarUrl: m.profile.avatar_url,
      addedAt: m.created_at,
    }));
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

export const listProjectTasks = cache(async (projectId: string): Promise<ProjectTask[]> => {
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
  const [subtasks, otherMemberships, values, blockers, approvalRequests, tagIds] = await Promise.all([
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
  }));
});

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
    supabase
      .from("comments")
      .select(
        "id, author_id, rule_id, body, created_at, edited_at, deleted_at, comment_mentions(profile_id), comment_reactions(emoji, profile_id, deleted_at, created_at)",
      )
      .eq("task_id", taskId)
      .order("created_at"),
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
  ]);

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

  const commentRows = rows(comments, "comments");
  const approvalRows = rows(approvals, "approvals");
  const submission = rows(submissions, "form submission")[0] ?? null;
  const ruleIds = [
    ...new Set(
      [...commentRows.map((c) => c.rule_id), ...approvalRows.map((a) => a.rule_id)].filter(
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
    comments: commentRows.map((c) => {
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
      };
    }),
    stories: storyRows.map((st) => ({
      id: st.id,
      actorId: st.actor_id,
      kind: st.kind,
      data: st.data,
      createdAt: st.created_at,
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
  };
}

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

// Tasks come back only when RLS lets the viewer read them (membership in one of their projects, or a
// private task they created or are assigned). Each is labelled with its home project when the viewer can
// see it, else another visible project; private tasks (and their subtasks) have no project.
export const listMyTasks = cache(async (profileId: string) => {
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
});

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
    | "message";
  data: Json;
  actorId: string | null;
  readAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  // Task items: the task. Message items (Messages tab): null, and `message` is set; taskTitle then
  // holds the thread's title.
  taskId: string | null;
  taskTitle: string;
  // Subtasks: the parent task's title.
  parentTitle: string | null;
  commentBody: string | null;
  message: { id: string; threadId: string; projectId: string; projectName: string } | null;
  // approval_requested items: the request now (its approver decides it from the Inbox while pending).
  approval: { id: string; status: TaskApproval["status"]; approverId: string } | null;
};

export type InboxTab = "active" | "archived";

// The Inbox tab (not archived) or the Archived tab; newest first, 100 at most.
export const listInbox = cache(async (tab: InboxTab = "active"): Promise<InboxItem[]> => {
  const supabase = await createClient();
  let query = supabase
    .from("inbox_items")
    .select(
      "id, kind, data, actor_id, read_at, archived_at, created_at, task:tasks!inner(id, title, parent_task_id), comment:comments(body, deleted_at)",
    )
    .is("task.deleted_at", null);
  query = tab === "archived" ? query.not("archived_at", "is", null) : query.is("archived_at", null);
  const result = await query.order("created_at", { ascending: false }).limit(100);
  const items = rows(result, "inbox");
  let messageQuery = supabase
    .from("inbox_items")
    .select(
      "id, kind, data, actor_id, read_at, archived_at, created_at, message:project_messages!inner(id, project_id, thread_id, title, body, deleted_at, project:projects!inner(name))",
    )
    .is("task_id", null)
    .is("message.deleted_at", null)
    .is("message.project.deleted_at", null);
  messageQuery = tab === "archived" ? messageQuery.not("archived_at", "is", null) : messageQuery.is("archived_at", null);
  const approvalIds = [
    ...new Set(
      items.flatMap((item) => {
        const d = item.data;
        if (item.kind !== "approval_requested" || !d || typeof d !== "object" || Array.isArray(d)) return [];
        return typeof d.approval_id === "string" ? [d.approval_id] : [];
      }),
    ),
  ];
  const [parentTitle, messageItems, approvalRows] = await Promise.all([
    taskTitles(items.map((item) => item.task.parent_task_id)),
    messageQuery.order("created_at", { ascending: false }).limit(100).then((r) => rows(r, "inbox messages")),
    approvalIds.length
      ? supabase
          .from("approval_requests")
          .select("id, status, approver_id")
          .in("id", approvalIds)
          .is("deleted_at", null)
          .then((r) => rows(r, "approvals"))
      : Promise.resolve([]),
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

  const taskItems: InboxItem[] = items
    .filter((item) => !item.comment?.deleted_at)
    .map((item) => ({
      id: item.id,
      kind: item.kind as InboxItem["kind"],
      data: item.data,
      actorId: item.actor_id,
      readAt: item.read_at,
      archivedAt: item.archived_at,
      createdAt: item.created_at,
      taskId: item.task.id,
      taskTitle: item.task.title,
      parentTitle: item.task.parent_task_id ? (parentTitle.get(item.task.parent_task_id) ?? null) : null,
      commentBody: item.comment?.body ?? null,
      message: null,
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
        createdAt: item.created_at,
        taskId: null,
        taskTitle: (thread ? thread.title : m.title) ?? "Message",
        parentTitle: null,
        commentBody: m.body,
        message: { id: m.id, threadId: m.thread_id ?? m.id, projectId: m.project_id, projectName: m.project.name },
        approval: null,
      },
    ];
  });
  return [...taskItems, ...messages].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
});

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
  const active = row.project_message_reactions
    .filter((r) => !r.deleted_at)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  return {
    id: row.id,
    authorId: row.author_id,
    body: row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    mentionIds: row.project_message_mentions.map((m) => m.profile_id),
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

export const countUnreadInbox = cache(async () => {
  const supabase = await createClient();
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
  note: string | null;
  authorName: string | null;
  createdAt: string;
};

const STATUS_UPDATE_COLUMNS =
  "id, project_id, status, note, created_at, author:profiles!project_status_updates_author_id_fkey(full_name, email)";

function toStatusUpdate(r: {
  id: string;
  project_id: string;
  status: string;
  note: string | null;
  created_at: string;
  author: { full_name: string | null; email: string } | null;
}): ProjectStatusUpdate {
  return {
    id: r.id,
    projectId: r.project_id,
    status: r.status,
    note: r.note,
    authorName: r.author ? r.author.full_name?.trim() || r.author.email : null,
    createdAt: r.created_at,
  };
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
  for (const r of rows(result, "status updates")) {
    if (!latest.has(r.project_id)) latest.set(r.project_id, toStatusUpdate(r));
  }
  return latest;
}

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
  updatedAt: string;
  // Admin+ of the live source project, or a workspace admin: rename, replace, delete.
  canManage: boolean;
};

// Workspace templates: everyone allowlisted can see and use them.
export const listProjectTemplates = cache(async (): Promise<ProjectTemplate[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("project_templates")
    .select("id, name, description, summary, is_example, source_project_id, updated_at, creator:profiles(email, full_name)")
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

export type TeamProject = { projectId: string; name: string; status: string; role: string; addedAt: string };

// Projects the team was added to, limited by RLS to the ones the viewer can already read.
export const listTeamProjects = cache(async (teamId: string): Promise<TeamProject[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("team_projects")
    .select("role, created_at, project:projects!team_projects_project_id_fkey!inner(id, name, status)")
    .eq("team_id", teamId)
    .is("deleted_at", null)
    .is("project.deleted_at", null)
    .order("created_at");
  return rows(result, "team projects").map((r) => ({
    projectId: r.project.id,
    name: r.project.name,
    status: r.project.status,
    role: r.role,
    addedAt: r.created_at,
  }));
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
