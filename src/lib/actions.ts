"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { getWorkspace } from "@/lib/data";
import { MAX_ATTACHMENT_BYTES } from "@/lib/attachments";
import { drainOutbox } from "@/lib/email";
import { isFieldType, isOptionColor, type FieldOption } from "@/lib/fields";
import {
  isChoice,
  isQuestionType,
  parseQuestions,
  validateSubmission,
  type FormAnswers,
  type FormQuestion,
} from "@/lib/forms";
import { isTriggerType, type RuleAction, type RuleCondition } from "@/lib/rules";
import { isUuid } from "@/lib/ids";
import { isFrequency, recurrenceJson, type Recurrence } from "@/lib/recurrence";
import { isProjectRole } from "@/lib/roles";
import {
  VIEW_LAYOUTS,
  isIsoDate,
  isViewLayout,
  isWidgetKind,
  parseFilters,
  parseViewConfig,
  toJson,
  type ViewConfig,
  type ViewFilters,
  type WidgetKind,
} from "@/lib/views";
import type { Json } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

export type ActionResult = { error?: string };

const ORDER_STEP = 1024;
const DEFAULT_SECTIONS = ["To do", "In progress", "Done"];
const START_AFTER_DUE = "The start date must be on or before the due date";

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

// Any write can make rules queue email, so deliver the outbox once the response is sent.
function deliverQueuedEmail() {
  after(async () => {
    try {
      await drainOutbox();
    } catch (error) {
      console.error("Email delivery failed", error);
    }
  });
}

async function run(fn: () => Promise<void>): Promise<ActionResult> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof InputError) return { error: error.message };
    if (error instanceof DbError) return { error: error.message };
    throw error;
  }
  deliverQueuedEmail();
  refresh();
  return {};
}

const NOT_ALLOWED = "Your role in this project doesn’t allow that";

type DbResult = { error: { message: string; code?: string; hint?: string | null } | null };

// Row-level security errors name tables; members just need to know their role doesn't allow it.
function check(result: DbResult) {
  const error = result.error;
  if (!error) return;
  if (error.code === "42501" && error.message.includes("row-level security")) throw new DbError(NOT_ALLOWED);
  throw new DbError(error.hint ? `${error.message}. ${error.hint}` : error.message);
}

// RLS turns a forbidden UPDATE into "0 rows" rather than an error; use with .select("id").
function checkUpdated(result: DbResult & { data: unknown[] | null }) {
  check(result);
  if (!result.data?.length) throw new DbError(NOT_ALLOWED);
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
// Members (all checks — role, allowlist, last owner — live in the SQL RPCs)
// ---------------------------------------------------------------------------------------------

function role(value: unknown): string {
  if (!isProjectRole(value)) throw new InputError("Choose a role");
  return value;
}

export async function inviteProjectMember(
  projectId: string,
  email: string,
  memberRole: string,
): Promise<ActionResult> {
  return run(async () => {
    const address = text(email, "Email", { max: 320 }).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new InputError("Enter a valid email address");
    const supabase = await createClient();
    check(
      await supabase.rpc("add_project_member", {
        target_project: id(projectId),
        member_email: address,
        member_role: role(memberRole),
      }),
    );
  });
}

export async function changeProjectMemberRole(
  projectId: string,
  profileId: string,
  memberRole: string,
): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("update_project_member_role", {
        target_project: id(projectId),
        target_profile: id(profileId, "person"),
        new_role: role(memberRole),
      }),
    );
  });
}

export async function removeProjectMember(projectId: string, profileId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("remove_project_member", {
        target_project: id(projectId),
        target_profile: id(profileId, "person"),
      }),
    );
  });
}

// Leaving loses access, so send the person home instead of re-rendering a project they can't see.
export async function leaveProject(projectId: string, profileId: string): Promise<ActionResult> {
  const result = await removeProjectMember(projectId, profileId);
  if (!result.error) redirect("/");
  return result;
}

export async function transferProjectOwnership(projectId: string, profileId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("transfer_project_ownership", {
        target_project: id(projectId),
        target_profile: id(profileId, "person"),
      }),
    );
  });
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

function optionalDate(value: string | null, label: string): string | null {
  if (value && !isIsoDate(value)) throw new InputError(`Invalid ${label}`);
  return value || null;
}

// An instant (ISO 8601 with offset or Z) for due/start times.
function optionalInstant(value: string | null, label: string): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new InputError(`Invalid ${label}`);
  }
  return new Date(value).toISOString();
}

function timeZone(value: unknown): string {
  if (typeof value !== "string" || value.length > 64) throw new InputError("Invalid time zone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    throw new InputError("Invalid time zone");
  }
  return value;
}

// Dates are plain days; times are optional instants. Setting a time also sets its date (the database
// keeps due_on/start_on equal to the local date in timeZone), and moving only the date keeps the time.
export async function updateTask(
  taskId: string,
  patch: {
    title?: string;
    notes?: string | null;
    assigneeId?: string | null;
    startOn?: string | null;
    dueOn?: string | null;
    startAt?: string | null;
    dueAt?: string | null;
    timeZone?: string;
  },
): Promise<ActionResult> {
  return run(async () => {
    const update: {
      title?: string;
      notes?: string | null;
      assignee_id?: string | null;
      start_on?: string | null;
      due_on?: string | null;
      start_at?: string | null;
      due_at?: string | null;
      time_zone?: string;
    } = {};
    if (patch.title !== undefined) update.title = text(patch.title, "Task name");
    if (patch.notes !== undefined) update.notes = optionalText(patch.notes);
    if (patch.assigneeId !== undefined) {
      update.assignee_id = patch.assigneeId ? id(patch.assigneeId, "assignee") : null;
    }
    if (patch.startOn !== undefined) update.start_on = optionalDate(patch.startOn, "start date");
    if (patch.dueOn !== undefined) update.due_on = optionalDate(patch.dueOn, "due date");
    if (patch.startAt !== undefined) update.start_at = optionalInstant(patch.startAt, "start time");
    if (patch.dueAt !== undefined) update.due_at = optionalInstant(patch.dueAt, "due time");
    if (patch.timeZone !== undefined) update.time_zone = timeZone(patch.timeZone);
    if (update.start_on && update.due_on && update.start_on > update.due_on) {
      throw new InputError(START_AFTER_DUE);
    }
    if (update.start_at && update.due_at && update.start_at > update.due_at) {
      throw new InputError(START_AFTER_DUE);
    }
    const supabase = await createClient();
    const result = await supabase.from("tasks").update(update).eq("id", id(taskId)).select("id");
    if (/tasks_start_(on_before_due_on|at_before_due_at)/.test(result.error?.message ?? "")) {
      throw new InputError(START_AFTER_DUE);
    }
    checkUpdated(result);
  });
}

function recurrence(value: Recurrence | null): Json | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || !isFrequency(value.freq)) throw new InputError("Invalid repeat");
  const interval = Number(value.interval);
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) {
    throw new InputError("Repeat every 1 to 365 days, weeks, months, or years");
  }
  const weekdays = Array.isArray(value.weekdays)
    ? value.weekdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    : [];
  const input = value.ends;
  let ends: Recurrence["ends"];
  if (!input || input.type === "never") {
    ends = { type: "never" };
  } else if (input.type === "after") {
    if (!(Number.isInteger(input.count) && input.count >= 1 && input.count <= 1000)) {
      throw new InputError("A repeat can end after 1 to 1000 occurrences");
    }
    ends = { type: "after", count: input.count };
  } else if (input.type === "until") {
    if (!isIsoDate(input.until)) throw new InputError("Choose the date the repeat ends");
    ends = { type: "until", until: input.until };
  } else {
    throw new InputError("Invalid repeat end");
  }
  return recurrenceJson({
    freq: value.freq,
    interval,
    weekdays,
    ends,
    timezone: value.timezone ? timeZone(value.timezone) : undefined,
  });
}

// Sets or clears a task's repeat rule; completing the task then creates the next occurrence.
export async function setTaskRecurrence(taskId: string, rule: Recurrence | null): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    checkUpdated(
      await supabase.from("tasks").update({ recurrence: recurrence(rule) }).eq("id", id(taskId)).select("id"),
    );
  });
}

export async function setTaskCompleted(taskId: string, completed: boolean): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    checkUpdated(
      await supabase
        .from("tasks")
        .update({ completed_at: completed ? now() : null })
        .eq("id", id(taskId))
        .select("id"),
    );
  });
}

export async function deleteTask(taskId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(await supabase.from("tasks").update({ deleted_at: now() }).eq("id", id(taskId)));
  });
}

export async function restoreTask(taskId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(await supabase.rpc("restore_task", { target_task: id(taskId) }));
  });
}

// Finish-to-start: `successorId` can't be completed until `predecessorId` is.
export async function addTaskDependency(predecessorId: string, successorId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("add_task_dependency", {
        predecessor: id(predecessorId, "task"),
        successor: id(successorId, "task"),
      }),
    );
  });
}

export async function removeTaskDependency(dependencyId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(await supabase.rpc("remove_task_dependency", { target_dependency: id(dependencyId, "dependency") }));
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

// ---------------------------------------------------------------------------------------------
// Request numbers + project workflow settings
// ---------------------------------------------------------------------------------------------

export async function saveRequestNumbering(
  projectId: string,
  input: {
    enabled: boolean;
    prefix: string;
    padWidth: number;
    addToTitle: boolean;
    assignTo: "all_tasks" | "form_submissions";
    nextNumber?: number | null;
  },
): Promise<ActionResult> {
  return run(async () => {
    const prefix = input.prefix.trim();
    if (prefix.length > 20) throw new InputError("Prefix is limited to 20 characters");
    if (!Number.isInteger(input.padWidth) || input.padWidth < 0 || input.padWidth > 8) {
      throw new InputError("Padding must be between 0 and 8 digits");
    }
    if (input.assignTo !== "all_tasks" && input.assignTo !== "form_submissions") {
      throw new InputError("Unknown numbering scope");
    }
    const row: {
      project_id: string;
      enabled: boolean;
      prefix: string;
      pad_width: number;
      add_to_title: boolean;
      assign_to: string;
      deleted_at: null;
      last_number?: number;
    } = {
      project_id: id(projectId),
      enabled: Boolean(input.enabled),
      prefix,
      pad_width: input.padWidth,
      add_to_title: Boolean(input.addToTitle),
      assign_to: input.assignTo,
      deleted_at: null,
    };
    if (input.nextNumber !== undefined && input.nextNumber !== null) {
      if (!Number.isInteger(input.nextNumber) || input.nextNumber < 1) {
        throw new InputError("The next number must be a positive whole number");
      }
      row.last_number = input.nextNumber - 1;
    }
    const supabase = await createClient();
    check(await supabase.from("request_sequences").upsert(row, { onConflict: "project_id" }));
  });
}

export async function updateProjectWorkflow(
  projectId: string,
  patch: { approvalCompletesTask: boolean },
): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase
        .from("projects")
        .update({ approval_completes_task: Boolean(patch.approvalCompletesTask) })
        .eq("id", id(projectId)),
    );
  });
}

export async function assignRequestNumber(taskId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(await supabase.rpc("assign_request_number", { target_task: id(taskId) }));
  });
}

// ---------------------------------------------------------------------------------------------
// Approvals (state changes go through RPCs; triggers write stories, inbox items, and fire rules)
// ---------------------------------------------------------------------------------------------

export async function requestApproval(
  taskId: string,
  input: { approverId: string; note?: string; asSubtask?: boolean; title?: string },
): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("request_approval", {
        target_task: id(taskId),
        approver: id(input.approverId, "approver"),
        approval_note: optionalText(input.note, 2000),
        as_subtask: input.asSubtask ?? true,
        subtask_title: optionalText(input.title, 500),
      }),
    );
  });
}

export async function decideApproval(
  approvalId: string,
  decision: "approved" | "changes_requested" | "rejected",
  note?: string,
): Promise<ActionResult> {
  return run(async () => {
    if (!["approved", "changes_requested", "rejected"].includes(decision)) {
      throw new InputError("Unknown decision");
    }
    const supabase = await createClient();
    check(
      await supabase.rpc("decide_approval", {
        target_approval: id(approvalId),
        decision,
        decision_note: optionalText(note, 2000),
      }),
    );
  });
}

export async function cancelApproval(approvalId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(await supabase.rpc("cancel_approval", { target_approval: id(approvalId) }));
  });
}

export async function resubmitApproval(approvalId: string, note?: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("resubmit_approval", {
        target_approval: id(approvalId),
        approval_note: optionalText(note, 2000),
      }),
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------------------------

function cleanQuestions(value: unknown): FormQuestion[] {
  if (!Array.isArray(value) || value.length > 100) throw new InputError("Forms are limited to 100 questions");
  const parsed = parseQuestions(value as Json);
  if (parsed.length !== value.length) throw new InputError("A question is missing its label or type");
  const seen = new Set<string>();
  return parsed.map((q) => {
    if (!q.id || q.id.length > 64 || seen.has(q.id)) throw new InputError("Question ids must be unique");
    const parentIsEarlier = q.show_if ? seen.has(q.show_if.question_id) : true;
    seen.add(q.id);
    if (!isQuestionType(q.type)) throw new InputError("Unknown question type");
    const question: FormQuestion = { ...q, label: text(q.label, "Question", { max: 500 }) };
    if (q.help !== undefined) question.help = optionalText(q.help, 1000) ?? undefined;
    if (!question.help) delete question.help;
    if (isChoice(q.type)) {
      const options = (q.options ?? []).map((o) => ({ id: o.id, label: text(o.label, "Option", { max: 200 }) }));
      if (options.length === 0) throw new InputError(`Add at least one option to “${question.label}”`);
      question.options = options;
    } else {
      delete question.options;
    }
    if (!parentIsEarlier || question.show_if?.option_ids.length === 0) delete question.show_if;
    return question;
  });
}

export async function createForm(projectId: string, title: string): Promise<ActionResult> {
  let formId: string | null = null;
  const result = await run(async () => {
    const supabase = await createClient();
    const sections = await supabase
      .from("sections")
      .select("id")
      .eq("project_id", id(projectId))
      .is("deleted_at", null)
      .order("sort_order")
      .limit(1);
    const inserted = await supabase
      .from("forms")
      .insert({
        project_id: projectId,
        title: text(title, "Form name", { max: 200 }),
        destination_section_id: sections.data?.[0]?.id ?? null,
        questions: [
          {
            id: crypto.randomUUID(),
            type: "short_text",
            label: "What do you need?",
            required: true,
            maps_to: { target: "title" },
          },
          {
            id: crypto.randomUUID(),
            type: "long_text",
            label: "Details",
            maps_to: { target: "notes" },
          },
        ],
      })
      .select("id")
      .single();
    check(inserted);
    formId = inserted.data!.id;
  });
  if (formId && !result.error) redirect(`/projects/${projectId}/forms/${formId}`);
  return result;
}

export async function updateForm(
  formId: string,
  patch: {
    title?: string;
    description?: string | null;
    questions?: FormQuestion[];
    destinationSectionId?: string | null;
    acceptingResponses?: boolean;
    sendConfirmation?: boolean;
    confirmationMessage?: string | null;
  },
): Promise<ActionResult> {
  return run(async () => {
    const update: {
      title?: string;
      description?: string | null;
      questions?: Json;
      destination_section_id?: string | null;
      accepting_responses?: boolean;
      send_confirmation?: boolean;
      confirmation_message?: string | null;
    } = {};
    if (patch.title !== undefined) update.title = text(patch.title, "Form name", { max: 200 });
    if (patch.description !== undefined) update.description = optionalText(patch.description, 5000);
    if (patch.questions !== undefined) update.questions = cleanQuestions(patch.questions) as Json;
    if (patch.destinationSectionId !== undefined) {
      update.destination_section_id = patch.destinationSectionId ? id(patch.destinationSectionId, "section") : null;
    }
    if (patch.acceptingResponses !== undefined) update.accepting_responses = Boolean(patch.acceptingResponses);
    if (patch.sendConfirmation !== undefined) update.send_confirmation = Boolean(patch.sendConfirmation);
    if (patch.confirmationMessage !== undefined) {
      update.confirmation_message = optionalText(patch.confirmationMessage, 2000);
    }
    const supabase = await createClient();
    check(await supabase.from("forms").update(update).eq("id", id(formId)));
  });
}

export async function deleteForm(formId: string, projectId: string): Promise<ActionResult> {
  const result = await run(async () => {
    const supabase = await createClient();
    check(await supabase.from("forms").update({ deleted_at: now() }).eq("id", id(formId)));
  });
  if (!result.error) redirect(`/projects/${id(projectId)}/forms`);
  return result;
}

export type SubmitFormResult = {
  error?: string;
  fieldErrors?: Record<string, string>;
  requestLabel?: string | null;
  message?: string | null;
};

// Public: callable by anonymous visitors. Validation runs here and again in submit_form.
export async function submitForm(
  formId: string,
  input: { email: string; answers: FormAnswers; website?: string },
): Promise<SubmitFormResult> {
  if (!isUuid(formId)) return { error: "This form does not exist" };
  // Honeypot: real visitors never see or fill the "website" input.
  if (input.website) return { requestLabel: null, message: null };
  const supabase = await createClient();
  const form = await supabase.rpc("get_public_form", { target_form: formId });
  const data = form.data && typeof form.data === "object" && !Array.isArray(form.data) ? form.data : null;
  if (form.error || !data) return { error: "This form does not exist" };
  const questions = parseQuestions(data.questions ?? []);
  const email = input.email.trim() || (typeof data.viewer_email === "string" ? data.viewer_email : "");
  const { errors, clean } = validateSubmission(questions, email, input.answers ?? {});
  if (Object.keys(errors).length) return { error: "Check the highlighted answers", fieldErrors: errors };

  const result = await supabase.rpc("submit_form", {
    target_form: formId,
    submitter_email: email,
    answers: clean as Json,
  });
  if (result.error) return { error: result.error.message };
  const out = (result.data ?? {}) as { request_label?: string | null; message?: string | null };
  deliverQueuedEmail();
  return { requestLabel: out.request_label ?? null, message: out.message ?? null };
}

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

type RuleInput = {
  name: string;
  triggerType: string;
  triggerConfig: Record<string, Json>;
  conditions: RuleCondition[];
  actions: RuleAction[];
};

function ruleRow(input: RuleInput) {
  if (!isTriggerType(input.triggerType)) throw new InputError("Choose a trigger");
  if (!Array.isArray(input.actions) || input.actions.length === 0) throw new InputError("Add at least one action");
  return {
    name: text(input.name, "Rule name", { max: 200 }),
    trigger_type: input.triggerType,
    trigger_config: (input.triggerConfig ?? {}) as Json,
    conditions: (input.conditions ?? []) as Json,
    actions: input.actions as Json,
  };
}

export async function createRule(projectId: string, input: RuleInput): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    const { data: last } = await supabase
      .from("rules")
      .select("sort_order")
      .eq("project_id", id(projectId))
      .is("deleted_at", null)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    check(
      await supabase
        .from("rules")
        .insert({ project_id: projectId, ...ruleRow(input), sort_order: (last?.sort_order ?? 0) + ORDER_STEP }),
    );
  });
}

export async function updateRule(ruleId: string, input: RuleInput): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(await supabase.from("rules").update(ruleRow(input)).eq("id", id(ruleId)));
  });
}

export async function setRuleEnabled(ruleId: string, enabled: boolean): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(await supabase.from("rules").update({ enabled: Boolean(enabled) }).eq("id", id(ruleId)));
  });
}

export async function deleteRule(ruleId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.from("rules").update({ deleted_at: now(), enabled: false }).eq("id", id(ruleId)),
    );
  });
}

export async function installRulePreset(
  projectId: string,
  presetKey: string,
  inputs: Record<string, Json>,
  enable: boolean,
): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("install_rule_preset", {
        target_project: id(projectId),
        preset: text(presetKey, "Preset", { max: 100 }),
        inputs: inputs as Json,
        enable: Boolean(enable),
      }),
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Saved views
// ---------------------------------------------------------------------------------------------

async function nextOrder(table: "project_views" | "dashboard_widgets", projectId: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from(table)
    .select("sort_order")
    .eq("project_id", id(projectId))
    .is("deleted_at", null)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.sort_order ?? 0) + ORDER_STEP;
}

export async function createView(
  projectId: string,
  input: { name?: string; layout: string; config?: ViewConfig },
): Promise<ActionResult> {
  let viewId: string | null = null;
  const result = await run(async () => {
    if (!isViewLayout(input.layout)) throw new InputError("Unknown view layout");
    const fallback = VIEW_LAYOUTS.find((l) => l.value === input.layout)!.label;
    const supabase = await createClient();
    const inserted = await supabase
      .from("project_views")
      .insert({
        project_id: id(projectId),
        name: text(input.name || fallback, "View name", { max: 100 }),
        layout: input.layout,
        config: toJson(parseViewConfig(input.config ?? {})),
        sort_order: await nextOrder("project_views", projectId),
      })
      .select("id")
      .single();
    check(inserted);
    viewId = inserted.data!.id;
  });
  if (viewId && !result.error) redirect(`/projects/${projectId}/views/${viewId}`);
  return result;
}

export async function updateView(
  viewId: string,
  patch: { name?: string; config?: ViewConfig },
): Promise<ActionResult> {
  return run(async () => {
    const update: { name?: string; config?: Json } = {};
    if (patch.name !== undefined) update.name = text(patch.name, "View name", { max: 100 });
    if (patch.config !== undefined) update.config = toJson(parseViewConfig(patch.config));
    const supabase = await createClient();
    check(await supabase.from("project_views").update(update).eq("id", id(viewId)));
  });
}

export async function duplicateView(viewId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: view } = await supabase
    .from("project_views")
    .select("project_id, name, layout, config")
    .eq("id", id(viewId))
    .is("deleted_at", null)
    .maybeSingle();
  if (!view) return { error: "This view no longer exists" };
  return createView(view.project_id, {
    name: `${view.name} copy`.slice(0, 100),
    layout: view.layout,
    config: parseViewConfig(view.config),
  });
}

export async function deleteView(viewId: string): Promise<ActionResult> {
  let projectId: string | null = null;
  const result = await run(async () => {
    const supabase = await createClient();
    const { data: view } = await supabase
      .from("project_views")
      .select("project_id")
      .eq("id", id(viewId))
      .is("deleted_at", null)
      .maybeSingle();
    if (!view) throw new InputError("This view no longer exists");
    const { count } = await supabase
      .from("project_views")
      .select("id", { count: "exact", head: true })
      .eq("project_id", view.project_id)
      .is("deleted_at", null);
    if ((count ?? 0) <= 1) throw new InputError("A project needs at least one view");
    check(await supabase.from("project_views").update({ deleted_at: now() }).eq("id", viewId));
    projectId = view.project_id;
  });
  if (projectId && !result.error) redirect(`/projects/${projectId}`);
  return result;
}

// Swaps a view or widget with its neighbour (direction -1 = earlier, 1 = later).
async function moveRow(table: "project_views" | "dashboard_widgets", rowId: string, direction: number) {
  const supabase = await createClient();
  const { data: row } = await supabase
    .from(table)
    .select("project_id")
    .eq("id", id(rowId))
    .is("deleted_at", null)
    .maybeSingle();
  if (!row) throw new InputError("This item no longer exists");
  const { data: siblings } = await supabase
    .from(table)
    .select("id, sort_order")
    .eq("project_id", row.project_id)
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  const list = siblings ?? [];
  const index = list.findIndex((s) => s.id === rowId);
  const target = index + (direction < 0 ? -1 : 1);
  if (index === -1 || target < 0 || target >= list.length) return;
  [list[index], list[target]] = [list[target], list[index]];
  for (const [i, item] of list.entries()) {
    const order = (i + 1) * ORDER_STEP;
    if (item.sort_order !== order) {
      check(await supabase.from(table).update({ sort_order: order }).eq("id", item.id));
    }
  }
}

export async function moveView(viewId: string, direction: -1 | 1): Promise<ActionResult> {
  return run(() => moveRow("project_views", viewId, direction));
}

// ---------------------------------------------------------------------------------------------
// Dashboard widgets
// ---------------------------------------------------------------------------------------------

const STARTER_WIDGETS: { kind: WidgetKind; title: string; filters: ViewFilters }[] = [
  { kind: "count", title: "Incomplete tasks", filters: {} },
  { kind: "count", title: "Overdue", filters: { due: { kind: "overdue" } } },
  { kind: "count", title: "Completed in the last 7 days", filters: { completion: "completed", completed_within_days: 7 } },
  { kind: "by_section", title: "Incomplete by section", filters: {} },
  { kind: "by_assignee", title: "Incomplete by assignee", filters: {} },
];

export async function installStarterWidgets(projectId: string): Promise<ActionResult> {
  return run(async () => {
    const start = await nextOrder("dashboard_widgets", projectId);
    const supabase = await createClient();
    check(
      await supabase.from("dashboard_widgets").insert(
        STARTER_WIDGETS.map((w, i) => ({
          project_id: projectId,
          kind: w.kind,
          title: w.title,
          filters: toJson(w.filters),
          sort_order: start + i * ORDER_STEP,
        })),
      ),
    );
  });
}

export async function createWidget(
  projectId: string,
  input: { kind: string; title: string; filters?: ViewFilters },
): Promise<ActionResult> {
  return run(async () => {
    if (!isWidgetKind(input.kind)) throw new InputError("Unknown widget type");
    const supabase = await createClient();
    check(
      await supabase.from("dashboard_widgets").insert({
        project_id: id(projectId),
        kind: input.kind,
        title: text(input.title, "Widget title", { max: 100 }),
        filters: toJson(parseFilters(input.filters ?? {})),
        sort_order: await nextOrder("dashboard_widgets", projectId),
      }),
    );
  });
}

export async function updateWidget(
  widgetId: string,
  patch: { kind?: string; title?: string; filters?: ViewFilters },
): Promise<ActionResult> {
  return run(async () => {
    const update: { kind?: string; title?: string; filters?: Json } = {};
    if (patch.kind !== undefined) {
      if (!isWidgetKind(patch.kind)) throw new InputError("Unknown widget type");
      update.kind = patch.kind;
    }
    if (patch.title !== undefined) update.title = text(patch.title, "Widget title", { max: 100 });
    if (patch.filters !== undefined) update.filters = toJson(parseFilters(patch.filters));
    const supabase = await createClient();
    check(await supabase.from("dashboard_widgets").update(update).eq("id", id(widgetId)));
  });
}

export async function deleteWidget(widgetId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.from("dashboard_widgets").update({ deleted_at: now() }).eq("id", id(widgetId)),
    );
  });
}

export async function moveWidget(widgetId: string, direction: -1 | 1): Promise<ActionResult> {
  return run(() => moveRow("dashboard_widgets", widgetId, direction));
}
