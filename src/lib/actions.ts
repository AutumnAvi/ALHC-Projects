"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { getWorkspace } from "@/lib/data";
import { MAX_ATTACHMENT_BYTES } from "@/lib/attachments";
import { isFieldType, isOptionColor, type FieldOption } from "@/lib/fields";
import { isUuid } from "@/lib/ids";
import type { Json } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

export type ActionResult = { error?: string };

const ORDER_STEP = 1024;
const DEFAULT_SECTIONS = ["To do", "In progress", "Done"];

class InputError extends Error {}
class DbError extends Error {}

function id(value: unknown, label = "id"): string {
  if (!isUuid(value)) throw new InputError(`Invalid ${label}`);
  return value;
}

function text(value: unknown, label: string, { max = 500 } = {}): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) throw new InputError(`${label} can’t be empty`);
  if (trimmed.length > max) throw new InputError(`${label} is too long`);
  return trimmed;
}

function optionalText(value: unknown, max = 20000): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length > max) throw new InputError("Text is too long");
  return trimmed || null;
}

async function run(fn: () => Promise<void>): Promise<ActionResult> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof InputError) return { error: error.message };
    if (error instanceof DbError) return { error: error.message };
    throw error;
  }
  refresh();
  return {};
}

function check(result: { error: { message: string; code?: string } | null }) {
  if (result.error) throw new DbError(result.error.message);
}

const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

export async function createProject(formData: FormData): Promise<ActionResult> {
  let projectId: string | null = null;
  const result = await run(async () => {
    const name = text(formData.get("name"), "Project name", { max: 200 });
    const supabase = await createClient();
    const workspace = await getWorkspace();
    if (!workspace) throw new DbError("No workspace is available");

    const { data: last } = await supabase
      .from("projects")
      .select("sort_order")
      .is("deleted_at", null)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();

    const inserted = await supabase
      .from("projects")
      .insert({
        workspace_id: workspace.id,
        name,
        sort_order: (last?.sort_order ?? 0) + ORDER_STEP,
      })
      .select("id")
      .single();
    check(inserted);
    projectId = inserted.data!.id;

    check(
      await supabase.from("sections").insert(
        DEFAULT_SECTIONS.map((sectionName, index) => ({
          project_id: projectId!,
          name: sectionName,
          sort_order: (index + 1) * ORDER_STEP,
        })),
      ),
    );
  });
  if (projectId && !result.error) redirect(`/projects/${projectId}/list`);
  return result;
}

export async function updateProject(
  projectId: string,
  patch: { name?: string; description?: string | null },
): Promise<ActionResult> {
  return run(async () => {
    const update: { name?: string; description?: string | null } = {};
    if (patch.name !== undefined) update.name = text(patch.name, "Project name", { max: 200 });
    if (patch.description !== undefined) update.description = optionalText(patch.description);
    const supabase = await createClient();
    check(await supabase.from("projects").update(update).eq("id", id(projectId)));
  });
}

export async function deleteProject(projectId: string): Promise<ActionResult> {
  const result = await run(async () => {
    const supabase = await createClient();
    check(
      await supabase.from("projects").update({ deleted_at: now() }).eq("id", id(projectId)),
    );
  });
  if (!result.error) redirect("/");
  return result;
}

// ---------------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------------

export async function createSection(projectId: string, name: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    const { data: last } = await supabase
      .from("sections")
      .select("sort_order")
      .eq("project_id", id(projectId))
      .is("deleted_at", null)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    check(
      await supabase.from("sections").insert({
        project_id: projectId,
        name: text(name, "Section name", { max: 200 }),
        sort_order: (last?.sort_order ?? 0) + ORDER_STEP,
      }),
    );
  });
}

export async function renameSection(sectionId: string, name: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase
        .from("sections")
        .update({ name: text(name, "Section name", { max: 200 }) })
        .eq("id", id(sectionId)),
    );
  });
}

export async function deleteSection(sectionId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.from("sections").update({ deleted_at: now() }).eq("id", id(sectionId)),
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------------------------

export async function createTask(
  projectId: string,
  sectionId: string | null,
  title: string,
): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("create_task", {
        target_project: id(projectId),
        target_section: sectionId ? id(sectionId, "section") : null,
        task_title: text(title, "Task name"),
      }),
    );
  });
}

export async function updateTask(
  taskId: string,
  patch: { title?: string; notes?: string | null; assigneeId?: string | null; dueOn?: string | null },
): Promise<ActionResult> {
  return run(async () => {
    const update: {
      title?: string;
      notes?: string | null;
      assignee_id?: string | null;
      due_on?: string | null;
    } = {};
    if (patch.title !== undefined) update.title = text(patch.title, "Task name");
    if (patch.notes !== undefined) update.notes = optionalText(patch.notes);
    if (patch.assigneeId !== undefined) {
      update.assignee_id = patch.assigneeId ? id(patch.assigneeId, "assignee") : null;
    }
    if (patch.dueOn !== undefined) {
      if (patch.dueOn && !/^\d{4}-\d{2}-\d{2}$/.test(patch.dueOn)) {
        throw new InputError("Invalid due date");
      }
      update.due_on = patch.dueOn || null;
    }
    const supabase = await createClient();
    check(await supabase.from("tasks").update(update).eq("id", id(taskId)));
  });
}

export async function setTaskCompleted(taskId: string, completed: boolean): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase
        .from("tasks")
        .update({ completed_at: completed ? now() : null })
        .eq("id", id(taskId)),
    );
  });
}

export async function deleteTask(taskId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(await supabase.from("tasks").update({ deleted_at: now() }).eq("id", id(taskId)));
  });
}

async function lastSortOrder(projectId: string, sectionId: string | null) {
  const supabase = await createClient();
  let query = supabase
    .from("task_projects")
    .select("sort_order")
    .eq("project_id", projectId)
    .is("deleted_at", null);
  query = sectionId ? query.eq("section_id", sectionId) : query.is("section_id", null);
  const { data } = await query.order("sort_order", { ascending: false }).limit(1).maybeSingle();
  return data?.sort_order ?? 0;
}

// Moves a task within one of its projects. Without sortOrder the task goes to the end of the section.
export async function moveTask(
  taskId: string,
  projectId: string,
  sectionId: string | null,
  sortOrder?: number,
): Promise<ActionResult> {
  return run(async () => {
    const targetSection = sectionId ? id(sectionId, "section") : null;
    const order =
      sortOrder !== undefined && Number.isFinite(sortOrder)
        ? sortOrder
        : (await lastSortOrder(id(projectId), targetSection)) + ORDER_STEP;
    const supabase = await createClient();
    check(
      await supabase
        .from("task_projects")
        .update({ section_id: targetSection, sort_order: order })
        .eq("task_id", id(taskId))
        .eq("project_id", id(projectId)),
    );
  });
}

export async function addTaskToProject(taskId: string, projectId: string): Promise<ActionResult> {
  return run(async () => {
    const order = (await lastSortOrder(id(projectId), null)) + ORDER_STEP;
    const supabase = await createClient();
    check(
      await supabase.from("task_projects").upsert(
        {
          task_id: id(taskId),
          project_id: projectId,
          section_id: null,
          sort_order: order,
          deleted_at: null,
        },
        { onConflict: "task_id,project_id" },
      ),
    );
  });
}

export async function removeTaskFromProject(
  taskId: string,
  projectId: string,
): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase
        .from("task_projects")
        .update({ deleted_at: now() })
        .eq("task_id", id(taskId))
        .eq("project_id", id(projectId)),
    );
  });
}

export async function setHomeProject(taskId: string, projectId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase
        .from("tasks")
        .update({ home_project_id: id(projectId) })
        .eq("id", id(taskId)),
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Subtasks
// ---------------------------------------------------------------------------------------------

export async function createSubtask(taskId: string, title: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    const { data: last } = await supabase
      .from("subtasks")
      .select("sort_order")
      .eq("task_id", id(taskId))
      .is("deleted_at", null)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    check(
      await supabase.from("subtasks").insert({
        task_id: taskId,
        title: text(title, "Subtask name"),
        sort_order: (last?.sort_order ?? 0) + ORDER_STEP,
      }),
    );
  });
}

export async function updateSubtask(
  subtaskId: string,
  patch: { title?: string; completed?: boolean },
): Promise<ActionResult> {
  return run(async () => {
    const update: { title?: string; completed_at?: string | null } = {};
    if (patch.title !== undefined) update.title = text(patch.title, "Subtask name");
    if (patch.completed !== undefined) update.completed_at = patch.completed ? now() : null;
    const supabase = await createClient();
    check(await supabase.from("subtasks").update(update).eq("id", id(subtaskId)));
  });
}

export async function deleteSubtask(subtaskId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.from("subtasks").update({ deleted_at: now() }).eq("id", id(subtaskId)),
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Comments + followers
// ---------------------------------------------------------------------------------------------

export async function addComment(taskId: string, body: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase
        .from("comments")
        .insert({ task_id: id(taskId), body: text(body, "Comment", { max: 10000 }) }),
    );
  });
}

export async function deleteComment(commentId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    const result = await supabase
      .from("comments")
      .update({ deleted_at: now() })
      .eq("id", id(commentId))
      .select("id");
    check(result);
    if (!result.data?.length) throw new InputError("You can only delete your own comments");
  });
}

export async function setFollowing(
  taskId: string,
  profileId: string,
  following: boolean,
): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.from("task_followers").upsert(
        {
          task_id: id(taskId),
          profile_id: id(profileId, "person"),
          deleted_at: following ? null : now(),
        },
        { onConflict: "task_id,profile_id" },
      ),
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Custom fields
// ---------------------------------------------------------------------------------------------

function fieldOptions(value: unknown): FieldOption[] {
  if (!Array.isArray(value) || value.length > 100) throw new InputError("Invalid options");
  const seen = new Set<string>();
  return value.map((option) => {
    const o = option as Partial<FieldOption>;
    if (typeof o.id !== "string" || !o.id || o.id.length > 64 || seen.has(o.id)) {
      throw new InputError("Invalid option id");
    }
    seen.add(o.id);
    return {
      id: o.id,
      name: text(o.name, "Option name", { max: 100 }),
      color: isOptionColor(o.color) ? o.color : "zinc",
    };
  });
}

export async function createField(
  projectId: string,
  input: { name: string; fieldType: string; boundToSections?: boolean },
): Promise<ActionResult> {
  return run(async () => {
    if (!isFieldType(input.fieldType)) throw new InputError("Unknown field type");
    const bound = Boolean(input.boundToSections);
    if (bound && input.fieldType !== "single_select") {
      throw new InputError("Only single-select fields can mirror sections");
    }
    const supabase = await createClient();
    const { data: last } = await supabase
      .from("custom_fields")
      .select("sort_order")
      .eq("project_id", id(projectId))
      .is("deleted_at", null)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    const result = await supabase.from("custom_fields").insert({
      project_id: projectId,
      name: text(input.name, "Field name", { max: 100 }),
      field_type: input.fieldType,
      bound_to_sections: bound,
      show_in_views: bound,
      sort_order: (last?.sort_order ?? 0) + ORDER_STEP,
    });
    if (result.error?.code === "23505") {
      throw new InputError("This project already has a section-bound field");
    }
    check(result);
  });
}

export async function updateField(
  fieldId: string,
  patch: { name?: string; options?: FieldOption[]; showInViews?: boolean },
): Promise<ActionResult> {
  return run(async () => {
    const update: { name?: string; options?: Json; show_in_views?: boolean } = {};
    if (patch.name !== undefined) update.name = text(patch.name, "Field name", { max: 100 });
    if (patch.options !== undefined) update.options = fieldOptions(patch.options);
    if (patch.showInViews !== undefined) update.show_in_views = Boolean(patch.showInViews);
    const supabase = await createClient();
    check(await supabase.from("custom_fields").update(update).eq("id", id(fieldId)));
  });
}

export async function deleteField(fieldId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.from("custom_fields").update({ deleted_at: now() }).eq("id", id(fieldId)),
    );
  });
}

export async function setFieldValue(
  taskId: string,
  fieldId: string,
  value: Json,
): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.from("task_field_values").upsert(
        { task_id: id(taskId), field_id: id(fieldId, "field"), value },
        { onConflict: "task_id,field_id" },
      ),
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Attachments (bytes are uploaded from the browser straight to Storage; this records metadata)
// ---------------------------------------------------------------------------------------------

export async function registerAttachment(input: {
  taskId: string;
  storagePath: string;
  fileName: string;
  contentType: string | null;
  sizeBytes: number;
}): Promise<ActionResult> {
  return run(async () => {
    const taskId = id(input.taskId);
    if (!input.storagePath.startsWith(`${taskId}/`) || input.storagePath.includes("..")) {
      throw new InputError("Invalid attachment path");
    }
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 0) {
      throw new InputError("Invalid file size");
    }
    if (input.sizeBytes > MAX_ATTACHMENT_BYTES) throw new InputError("Files are limited to 25 MB");
    const supabase = await createClient();
    check(
      await supabase.from("task_attachments").insert({
        task_id: taskId,
        storage_path: input.storagePath,
        file_name: text(input.fileName, "File name", { max: 255 }),
        content_type: input.contentType?.slice(0, 255) || null,
        size_bytes: input.sizeBytes,
      }),
    );
  });
}

export async function deleteAttachment(attachmentId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase
        .from("task_attachments")
        .update({ deleted_at: now() })
        .eq("id", id(attachmentId)),
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------------------------

export async function markInboxRead(itemIds: string[] | "all"): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    let query = supabase.from("inbox_items").update({ read_at: now() }).is("read_at", null);
    if (itemIds !== "all") query = query.in("id", itemIds.map((itemId) => id(itemId)));
    check(await query);
  });
}

export async function markInboxUnread(itemId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(await supabase.from("inbox_items").update({ read_at: null }).eq("id", id(itemId)));
  });
}
