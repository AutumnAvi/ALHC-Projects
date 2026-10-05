import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { parseOptions, type FieldDef, type FieldType } from "@/lib/fields";
import type { Json, Tables } from "@/lib/supabase/database.types";

// Every read in the app goes through this module, and every query here filters deleted_at IS NULL.
// RLS deliberately does not hide soft-deleted rows so that restore stays possible later.

export type Project = Pick<Tables<"projects">, "id" | "name" | "description" | "sort_order">;
export type Section = Pick<Tables<"sections">, "id" | "project_id" | "name" | "sort_order">;
export type Profile = Pick<Tables<"profiles">, "id" | "email" | "full_name" | "avatar_url">;

export type ProjectTask = {
  id: string;
  title: string;
  completedAt: string | null;
  dueOn: string | null;
  assigneeId: string | null;
  homeProjectId: string;
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
  dueOn: string | null;
  assigneeId: string | null;
  homeProjectId: string;
  createdAt: string;
  updatedAt: string;
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

export type TaskComment = {
  id: string;
  authorId: string;
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
    .select("id, name, description, sort_order")
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  return rows(result, "projects");
});

export const getProject = cache(async (projectId: string): Promise<Project | null> => {
  const supabase = await createClient();
  const result = await supabase
    .from("projects")
    .select("id, name, description, sort_order")
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
        "section_id, sort_order, task:tasks!inner(id, title, completed_at, due_on, assignee_id, home_project_id)",
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
    dueOn: m.task.due_on,
    assigneeId: m.task.assignee_id,
    homeProjectId: m.task.home_project_id,
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
        "id, title, notes, completed_at, due_on, assignee_id, home_project_id, created_at, updated_at",
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

  const [fields, values, followers, attachments, comments, stories] = await Promise.all([
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
      .select("id, author_id, body, created_at, comment_mentions(profile_id)")
      .eq("task_id", taskId)
      .is("deleted_at", null)
      .order("created_at"),
    supabase
      .from("task_stories")
      .select("id, actor_id, kind, data, created_at")
      .eq("task_id", taskId)
      .order("created_at"),
  ]);

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
    comments: rows(comments, "comments").map((c) => ({
      id: c.id,
      authorId: c.author_id,
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
    dueOn: task.due_on,
    assigneeId: task.assignee_id,
    homeProjectId: task.home_project_id,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
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
  kind: "assigned" | "comment" | "mention" | "completed";
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
      "id, kind, actor_id, read_at, created_at, task:tasks!inner(id, title), comment:comments(body, deleted_at)",
    )
    .is("task.deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(100);
  return rows(result, "inbox")
    .filter((item) => !item.comment?.deleted_at)
    .map((item) => ({
      id: item.id,
      kind: item.kind as InboxItem["kind"],
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
