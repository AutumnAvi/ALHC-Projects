import "server-only";
import { cache } from "react";
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

// Every read in the app goes through this module, and every query here filters deleted_at IS NULL.
// RLS deliberately does not hide soft-deleted rows so that restore stays possible later.

export type Project = Pick<
  Tables<"projects">,
  "id" | "name" | "description" | "sort_order" | "approval_completes_task"
>;
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
    .select("id, name, description, sort_order, approval_completes_task")
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  return rows(result, "projects");
});

export const getProject = cache(async (projectId: string): Promise<Project | null> => {
  const supabase = await createClient();
  const result = await supabase
    .from("projects")
    .select("id, name, description, sort_order, approval_completes_task")
    .eq("id", projectId)
    .is("deleted_at", null)
    .maybeSingle();
  return maybe(result, "project");
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
        "section_id, sort_order, task:tasks!inner(id, title, completed_at, start_on, due_on, assignee_id, home_project_id, created_at)",
      )
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .is("task.deleted_at", null)
      .order("sort_order"),
    "tasks",
  );

  const taskIds = memberships.map((m) => m.task.id);
  if (taskIds.length === 0) return [];

  const [subtasks, otherMemberships, values] = await Promise.all([
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
  ]);

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
  }));
});

export const getTaskDetail = cache(async (taskId: string): Promise<TaskDetail | null> => {
  const supabase = await createClient();
  const task = maybe(
    await supabase
      .from("tasks")
      .select(
        "id, title, notes, completed_at, start_on, due_on, assignee_id, home_project_id, created_at, updated_at, source, req_project_id, req_number",
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

  const [fields, values, followers, attachments, comments, stories, approvals, submissions, label, numbering] =
    await Promise.all([
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

export const listMyTasks = cache(async (profileId: string) => {
  const supabase = await createClient();
  const select =
    "id, title, completed_at, due_on, project:projects!tasks_home_project_id_fkey!inner(id, name)";
  const [open, done] = await Promise.all([
    supabase
      .from("tasks")
      .select(select)
      .eq("assignee_id", profileId)
      .is("deleted_at", null)
      .is("completed_at", null)
      .is("project.deleted_at", null)
      .order("due_on", { nullsFirst: false })
      .order("created_at"),
    supabase
      .from("tasks")
      .select(select)
      .eq("assignee_id", profileId)
      .is("deleted_at", null)
      .not("completed_at", "is", null)
      .is("project.deleted_at", null)
      .order("completed_at", { ascending: false })
      .limit(30),
  ]);
  const toMyTask = (t: {
    id: string;
    title: string;
    completed_at: string | null;
    due_on: string | null;
    project: { id: string; name: string };
  }): MyTask => ({
    id: t.id,
    title: t.title,
    completedAt: t.completed_at,
    dueOn: t.due_on,
    projectId: t.project.id,
    projectName: t.project.name,
  });
  return {
    open: rows(open, "my tasks").map(toMyTask),
    completed: rows(done, "completed tasks").map(toMyTask),
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
