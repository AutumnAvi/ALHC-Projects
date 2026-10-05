"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { getWorkspace } from "@/lib/data";
import { isUuid } from "@/lib/ids";
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

function check(result: { error: { message: string } | null }) {
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
    const inserted = await supabase
      .from("tasks")
      .insert({ home_project_id: id(projectId), title: text(title, "Task name") })
      .select("id")
      .single();
    check(inserted);
    // The home membership is created by a database trigger, already ordered last in the project.
    if (sectionId) {
      check(
        await supabase
          .from("task_projects")
          .update({ section_id: id(sectionId) })
          .eq("task_id", inserted.data!.id)
          .eq("project_id", projectId),
      );
    }
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
