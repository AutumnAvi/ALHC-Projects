import "server-only";
import { cache } from "react";
import { getViewer } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { parseOptions, type FieldDef, type FieldType } from "@/lib/fields";
import { parseQuestions, type FormDef, type PublicForm } from "@/lib/forms";
import {
  parsePresetInputs,
  toRuleDef,
  type RuleDef,
  type RulePreset,
  type RuleRun,
} from "@/lib/rules";
import { parseRecurrence, type Recurrence } from "@/lib/recurrence";
import {
  PROJECT_ROLES as ROLE_ORDER,
  hasRole,
  isPortfolioRole,
  isProjectRole,
  type PortfolioRole,
  type ProjectRole,
} from "@/lib/roles";
import { EMPTY_COUNTS, type PortfolioCounts } from "@/lib/portfolios";
import type { Json, Tables } from "@/lib/supabase/database.types";
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
>;

const PROJECT_COLUMNS =
  "id, name, description, sort_order, approval_completes_task, status, status_note, status_updated_at, status_updated_by";
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
  // Incomplete predecessors (finish-to-start dependencies) the task is waiting on.
  blockedBy: number;
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
  // Tasks that can be linked: active tasks of the task's projects where the viewer is an Editor.
  dependencyCandidates: { projectId: string; projectName: string; tasks: { id: string; title: string }[] }[];
  assigneeId: string | null;
  homeProjectId: string;
  createdAt: string;
  updatedAt: string;
  source: string;
  requestLabel: string | null;
  canAssignRequestNumber: boolean;
  submission: { email: string; formId: string; formTitle: string | null; createdAt: string } | null;
  approvals: TaskApproval[];
  subtasks: Pick<Tables<"subtasks">, "id" | "title" | "completed_at" | "sort_order">[];
  memberships: TaskMembership[];
  fields: FieldDef[];
  fieldValues: Record<string, Json>;
  followerIds: string[];
  attachments: TaskAttachment[];
  comments: TaskComment[];
  stories: TaskStory[];
  // The viewer's highest role across the task's projects (null: read access through nothing).
  viewerRole: ProjectRole | null;
  // Best role of each member of the task's visible projects: who can be assigned, follow, approve.
  memberRoles: Record<string, ProjectRole>;
};

export type TaskDependency = {
  id: string;
  // blocked_by: the other task must finish first; blocking: the other task waits on this one.
  relation: "blocked_by" | "blocking";
  taskId: string;
  title: string;
  completedAt: string | null;
};

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
  body: string;
  createdAt: string;
  mentionIds: string[];
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

export const listProjects = cache(async (): Promise<Project[]> => {
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

// The viewer's own role in every project they belong to.
export const listMyProjectRoles = cache(async (): Promise<Map<string, ProjectRole>> => {
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
        "section_id, sort_order, task:tasks!inner(id, title, completed_at, start_on, due_on, assignee_id, home_project_id, created_at, recurrence)",
      )
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .is("task.deleted_at", null)
      .order("sort_order"),
    "tasks",
  );

  const taskIds = memberships.map((m) => m.task.id);
  if (taskIds.length === 0) return [];

  const [subtasks, otherMemberships, values, blockers] = await Promise.all([
    supabase
      .from("subtasks")
      .select("task_id, completed_at")
      .in("task_id", taskIds)
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
      .is("deleted_at", null)
      .is("predecessor.deleted_at", null)
      .is("predecessor.completed_at", null),
  ]);

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
    const stat = subtaskStats.get(s.task_id) ?? { total: 0, done: 0 };
    stat.total += 1;
    if (s.completed_at) stat.done += 1;
    subtaskStats.set(s.task_id, stat);
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
    homeProjectId: m.task.home_project_id,
    createdAt: m.task.created_at,
    sectionId: m.section_id,
    sortOrder: m.sort_order,
    subtaskCount: subtaskStats.get(m.task.id)?.total ?? 0,
    subtaskDoneCount: subtaskStats.get(m.task.id)?.done ?? 0,
    projectCount: projectCounts.get(m.task.id) ?? 1,
    fieldValues: fieldValues.get(m.task.id) ?? {},
    recurring: m.task.recurrence !== null,
    blockedBy: blockedBy.get(m.task.id) ?? 0,
  }));
});

export type ProjectDependency = { id: string; predecessorId: string; successorId: string };

// Active dependencies of a project (for Timeline arrows). Both tasks must still be active.
export const listProjectDependencies = cache(async (projectId: string): Promise<ProjectDependency[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("task_dependencies")
    .select(
      "id, predecessor_id, successor_id, predecessor:tasks!task_dependencies_predecessor_id_fkey!inner(id), successor:tasks!task_dependencies_successor_id_fkey!inner(id)",
    )
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .is("predecessor.deleted_at", null)
    .is("successor.deleted_at", null);
  return rows(result, "dependencies").map((d) => ({
    id: d.id,
    predecessorId: d.predecessor_id,
    successorId: d.successor_id,
  }));
});

export const getTaskDetail = cache(async (taskId: string): Promise<TaskDetail | null> => {
  const supabase = await createClient();
  const task = maybe(
    await supabase
      .from("tasks")
      .select(
        "id, title, notes, completed_at, start_on, due_on, start_at, due_at, time_zone, recurrence, recurrence_seq, recurrence_next_id, assignee_id, home_project_id, created_at, updated_at, source, req_project_id, req_number",
      )
      .eq("id", taskId)
      .is("deleted_at", null)
      .maybeSingle(),
    "task",
  );
  if (!task) return null;

  const [subtasks, memberships] = await Promise.all([
    supabase
      .from("subtasks")
      .select("id, title, completed_at, sort_order")
      .eq("task_id", taskId)
      .is("deleted_at", null)
      .order("sort_order")
      .order("created_at"),
    supabase
      .from("task_projects")
      .select("project_id, section_id, project:projects!inner(id, name)")
      .eq("task_id", taskId)
      .is("deleted_at", null)
      .is("project.deleted_at", null)
      .order("created_at"),
  ]);

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
      .select("id, author_id, rule_id, body, created_at, comment_mentions(profile_id)")
      .eq("task_id", taskId)
      .is("deleted_at", null)
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
    supabase
      .from("request_sequences")
      .select("project_id")
      .eq("project_id", task.home_project_id)
      .eq("enabled", true)
      .is("deleted_at", null)
      .maybeSingle(),
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
        "id, predecessor_id, successor_id, predecessor:tasks!task_dependencies_predecessor_id_fkey!inner(id, title, completed_at), successor:tasks!task_dependencies_successor_id_fkey!inner(id, title, completed_at)",
      )
      .or(`predecessor_id.eq.${taskId},successor_id.eq.${taskId}`)
      .is("deleted_at", null)
      .is("predecessor.deleted_at", null)
      .is("successor.deleted_at", null)
      .order("created_at"),
    task.recurrence_next_id
      ? supabase.from("tasks").select("id").eq("id", task.recurrence_next_id).is("deleted_at", null).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  const memberRoles: Record<string, ProjectRole> = {};
  for (const m of rows(projectMembers, "task members")) {
    if (!isProjectRole(m.role)) continue;
    const current = memberRoles[m.profile_id];
    if (!current || ROLE_ORDER.indexOf(m.role) < ROLE_ORDER.indexOf(current)) memberRoles[m.profile_id] = m.role;
  }
  const role = maybe(viewerRole, "task role");
  const viewerProjectRole = isProjectRole(role) ? role : null;
  const dependencyCandidates = hasRole(viewerProjectRole, "editor")
    ? await listDependencyCandidates(taskId, membershipRows.map((m) => ({ id: m.project_id, name: m.project.name })))
    : [];

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
    comments: commentRows.map((c) => ({
      id: c.id,
      authorId: c.author_id,
      ruleName: c.rule_id ? (ruleName.get(c.rule_id) ?? "Rule") : null,
      body: c.body,
      createdAt: c.created_at,
      mentionIds: c.comment_mentions.map((m) => m.profile_id),
    })),
    stories: rows(stories, "activity").map((st) => ({
      id: st.id,
      actorId: st.actor_id,
      kind: st.kind,
      data: st.data,
      createdAt: st.created_at,
    })),
    id: task.id,
    title: task.title,
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
    dependencies: rows(dependencies, "dependencies").map((d) => {
      const blockedBy = d.successor_id === taskId;
      const other = blockedBy ? d.predecessor : d.successor;
      return {
        id: d.id,
        relation: blockedBy ? ("blocked_by" as const) : ("blocking" as const),
        taskId: other.id,
        title: other.title,
        completedAt: other.completed_at,
      };
    }),
    dependencyCandidates,
    assigneeId: task.assignee_id,
    homeProjectId: task.home_project_id,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    source: task.source,
    requestLabel: maybe(label, "request number"),
    canAssignRequestNumber: !task.req_number && Boolean(maybe(numbering, "request numbering")),
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
    subtasks: rows(subtasks, "subtasks"),
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

// Active tasks that share a project with the task, in projects where the viewer can edit.
async function listDependencyCandidates(taskId: string, projects: { id: string; name: string }[]) {
  if (projects.length === 0) return [];
  const supabase = await createClient();
  const roles = await listMyProjectRoles();
  const editable = projects.filter((p) => hasRole(roles.get(p.id), "editor"));
  if (editable.length === 0) return [];
  const result = await supabase
    .from("task_projects")
    .select("project_id, task:tasks!inner(id, title, completed_at)")
    .in(
      "project_id",
      editable.map((p) => p.id),
    )
    .is("deleted_at", null)
    .is("task.deleted_at", null)
    .neq("task_id", taskId)
    .order("sort_order")
    .limit(MAX_DEPENDENCY_CANDIDATES * editable.length);
  const memberships = rows(result, "dependency candidates");
  return editable.map((p) => ({
    projectId: p.id,
    projectName: p.name,
    tasks: memberships
      .filter((m) => m.project_id === p.id)
      .sort((a, b) => Number(Boolean(a.task.completed_at)) - Number(Boolean(b.task.completed_at)))
      .slice(0, MAX_DEPENDENCY_CANDIDATES)
      .map((m) => ({ id: m.task.id, title: m.task.title })),
  }));
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

export type MyTask = {
  id: string;
  title: string;
  completedAt: string | null;
  dueOn: string | null;
  projectId: string;
  projectName: string;
};

// Tasks come back only when RLS lets the viewer read them (membership in one of their projects).
// Each is labelled with its home project when the viewer can see it, else another visible project.
export const listMyTasks = cache(async (profileId: string) => {
  const supabase = await createClient();
  const select = "id, title, completed_at, due_on, home_project_id";
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
    listProjects(),
  ]);
  const openRows = rows(open, "my tasks");
  const doneRows = rows(done, "completed tasks");
  const projectName = new Map(projects.map((p) => [p.id, p.name] as const));
  const taskIds = [...openRows, ...doneRows].map((t) => t.id);
  const memberships = taskIds.length
    ? rows(
        await supabase
          .from("task_projects")
          .select("task_id, project_id")
          .in("task_id", taskIds)
          .is("deleted_at", null)
          .order("created_at"),
        "task projects",
      )
    : [];

  const toMyTask = (t: (typeof openRows)[number]): MyTask | null => {
    const projectId = projectName.has(t.home_project_id)
      ? t.home_project_id
      : memberships.find((m) => m.task_id === t.id && projectName.has(m.project_id))?.project_id;
    if (!projectId) return null;
    return {
      id: t.id,
      title: t.title,
      completedAt: t.completed_at,
      dueOn: t.due_on,
      projectId,
      projectName: projectName.get(projectId)!,
    };
  };
  const present = (t: MyTask | null): t is MyTask => t !== null;
  return {
    open: openRows.map(toMyTask).filter(present),
    completed: doneRows.map(toMyTask).filter(present),
  };
});

export type InboxItem = {
  id: string;
  kind:
    | "assigned"
    | "comment"
    | "mention"
    | "completed"
    | "approval_requested"
    | "approval_decided"
    | "rule";
  data: Json;
  actorId: string | null;
  readAt: string | null;
  createdAt: string;
  taskId: string;
  taskTitle: string;
  commentBody: string | null;
};

export const listInbox = cache(async (): Promise<InboxItem[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("inbox_items")
    .select(
      "id, kind, data, actor_id, read_at, created_at, task:tasks!inner(id, title), comment:comments(body, deleted_at)",
    )
    .is("task.deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(100);
  return rows(result, "inbox")
    .filter((item) => !item.comment?.deleted_at)
    .map((item) => ({
      id: item.id,
      kind: item.kind as InboxItem["kind"],
      data: item.data,
      actorId: item.actor_id,
      readAt: item.read_at,
      createdAt: item.created_at,
      taskId: item.task.id,
      taskTitle: item.task.title,
      commentBody: item.comment?.body ?? null,
    }));
});

export const countUnreadInbox = cache(async () => {
  const supabase = await createClient();
  const { count, error } = await supabase
    .from("inbox_items")
    .select("id", { count: "exact", head: true })
    .is("read_at", null);
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
  homeProjectId: string;
  homeProjectName: string | null;
  completedAt: string | null;
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
  if (trashed.length === 0) return [];

  const [stories, projects] = await Promise.all([
    supabase
      .from("task_stories")
      .select("task_id, actor_id, created_at")
      .in(
        "task_id",
        trashed.map((t) => t.id),
      )
      .eq("kind", "deleted")
      .order("created_at", { ascending: false }),
    listProjects(),
  ]);
  const deletedBy = new Map<string, string | null>();
  for (const story of rows(stories, "deletions")) {
    if (!deletedBy.has(story.task_id)) deletedBy.set(story.task_id, story.actor_id);
  }
  const projectName = new Map(projects.map((p) => [p.id, p.name] as const));
  return trashed.map((t) => ({
    id: t.id,
    title: t.title,
    deletedAt: t.deleted_at!,
    deletedBy: deletedBy.get(t.id) ?? null,
    homeProjectId: t.home_project_id,
    homeProjectName: projectName.get(t.home_project_id) ?? null,
    completedAt: t.completed_at,
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
