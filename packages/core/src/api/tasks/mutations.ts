// Big move 1: the tasks area's writes (tasks, their dates, kind, repeat, completion, Trash, ordering,
// projects, bulk edits, and subtasks). Every function takes the caller's ApiContext first, validates its
// own input, writes only through ctx.db (RLS and the RPCs decide), and throws ApiError on any refusal; no
// Next.js here.
import { ORDER_STEP } from "../core/constants";
import type { ApiContext } from "../core/context";
import { check, checkUpdated, nowIso } from "../core/db";
import { ApiError, NOT_ALLOWED, invalid } from "../core/errors";
import {
  START_AFTER_DUE,
  id,
  optionalDate,
  optionalInstant,
  optionalText,
  text,
  timeZone,
} from "../core/validate";
import { recurrenceInput, taskKindInput } from "./inputs";
import { MAX_BULK_TASKS, parseBulkResult, type BulkOperation, type BulkResult } from "../../bulk";
import {
  isDuplicateTaskOptionKey,
  parseDuplicateTaskResult,
  type DuplicateTaskOptions,
  type DuplicateTaskResult,
} from "../../duplicate-task";
import type { Recurrence } from "../../recurrence";
import type { Json } from "../../supabase/database.types";
import type { TaskKind } from "../../task-kinds";
import { ARCHIVED_ONLY_MESSAGE, LAST_PROJECT_MESSAGE, lastProjectRefusal, type LastProjectCode } from "../../task-projects";

// ---------------------------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------------------------

export async function createTask(
  ctx: ApiContext,
  projectId: string,
  sectionId: string | null,
  title: string,
  kind: TaskKind = "task",
  // Asana's toolbar "+ Add task": the new task goes to the top of its section.
  atTop = false,
): Promise<{ taskId: string | undefined }> {
  const taskKind = taskKindInput(kind);
  const supabase = ctx.db;
  const created = await supabase.rpc("create_task", {
    target_project: id(projectId),
    target_section: sectionId ? id(sectionId, "section") : null,
    task_title: text(title, "Task name"),
  });
  check(created);
  const taskId = created.data ?? undefined;
  if (taskKind !== "task" && created.data) {
    checkUpdated(await supabase.from("tasks").update({ kind: taskKind }).eq("id", created.data).select("id"));
  }
  if (atTop && created.data) {
    let first = supabase
      .from("task_projects")
      .select("task_id, tasks!inner(deleted_at)")
      .eq("project_id", id(projectId))
      .is("deleted_at", null)
      .is("tasks.deleted_at", null)
      .neq("task_id", created.data)
      .order("sort_order")
      .limit(1);
    first = sectionId ? first.eq("section_id", id(sectionId, "section")) : first.is("section_id", null);
    const { data: top } = await first.maybeSingle();
    if (top) {
      check(
        await supabase.rpc("place_task", {
          target_task: created.data,
          target_project: id(projectId),
          target_section: sectionId ? id(sectionId, "section") : null,
          before_task: top.task_id,
        }),
      );
    }
  }
  return { taskId };
}

// Quick-add in My Tasks: a private task (no project) assigned to the caller. Only they and whoever they
// assign it to can read it until it's added to a project.
// With a section (the inline "Add task…" row of a My Tasks section), the task is placed at its end.
// Returns the new task's id (Create → Task offers to open it).
export async function createPrivateTask(
  ctx: ApiContext,
  title: string,
  mySectionId: string | null = null,
): Promise<{ taskId: string | undefined }> {
  const supabase = ctx.db;
  const created = await supabase.rpc("create_private_task", { task_title: text(title, "Task name", { max: 1000 }) });
  check(created);
  const taskId = created.data ?? undefined;
  if (mySectionId && created.data) {
    check(
      await supabase.rpc("place_my_task", {
        target_task: created.data,
        target_section: id(mySectionId, "section"),
        before_task: null,
      }),
    );
  }
  return { taskId };
}

// Duplicate a task (duplicate_task): the copy lands where the caller is an Editor (see the migration).
export async function duplicateTask(
  ctx: ApiContext,
  taskId: string,
  options: DuplicateTaskOptions,
): Promise<{ result: DuplicateTaskResult }> {
  const payload: Record<string, boolean | string> = {};
  for (const [key, value] of Object.entries(options ?? {})) {
    if (key === "title") {
      const title = optionalText(value, 1000);
      if (title) payload.title = title;
    } else if (isDuplicateTaskOptionKey(key) && typeof value === "boolean") {
      payload[key] = value;
    } else {
      throw invalid("Unknown duplicate option");
    }
  }
  const supabase = ctx.db;
  const response = await supabase.rpc("duplicate_task", { target_task: id(taskId, "task"), options: payload });
  check(response);
  const result = parseDuplicateTaskResult(response.data) ?? undefined;
  if (!result) throw new ApiError("failed", "The task couldn’t be duplicated");
  return { result };
}

// Task, milestone, or approval. The database clears a milestone's start date and opens (or cancels)
// the assignee's approval request; an assignee below Commenter is refused for approval tasks.
export async function setTaskKind(ctx: ApiContext, taskId: string, kind: TaskKind): Promise<void> {
  const supabase = ctx.db;
  checkUpdated(await supabase.from("tasks").update({ kind: taskKindInput(kind) }).eq("id", id(taskId)).select("id"));
}

// Dates are plain days; times are optional instants. Setting a time also sets its date (the database
// keeps due_on/start_on equal to the local date in timeZone), and moving only the date keeps the time.
export async function updateTask(
  ctx: ApiContext,
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
): Promise<void> {
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
    throw invalid(START_AFTER_DUE);
  }
  if (update.start_at && update.due_at && update.start_at > update.due_at) {
    throw invalid(START_AFTER_DUE);
  }
  const supabase = ctx.db;
  const result = await supabase.from("tasks").update(update).eq("id", id(taskId)).select("id");
  if (/tasks_start_(on_before_due_on|at_before_due_at)/.test(result.error?.message ?? "")) {
    throw invalid(START_AFTER_DUE);
  }
  checkUpdated(result);
}

// Sets or clears a task's repeat rule; completing the task then creates the next occurrence.
export async function setTaskRecurrence(ctx: ApiContext, taskId: string, rule: Recurrence | null): Promise<void> {
  const supabase = ctx.db;
  checkUpdated(
    await supabase.from("tasks").update({ recurrence: recurrenceInput(rule) }).eq("id", id(taskId)).select("id"),
  );
}

export async function setTaskCompleted(ctx: ApiContext, taskId: string, completed: boolean): Promise<void> {
  const supabase = ctx.db;
  checkUpdated(
    await supabase
      .from("tasks")
      .update({ completed_at: completed ? nowIso() : null })
      .eq("id", id(taskId))
      .select("id"),
  );
}

export async function deleteTask(ctx: ApiContext, taskId: string): Promise<void> {
  await trashTask(ctx, id(taskId));
}

// Nov 2 security fix (note 119): moving a task or subtask to the Trash goes through trash_task, which
// refuses below Editor with a reason. A plain update that RLS filters out changes nothing and returns no
// error, so the app used to say "moved to the Trash" when nothing had changed. Without this release's
// database the update is checked for a changed row instead.
async function trashTask(ctx: ApiContext, taskId: string): Promise<void> {
  const supabase = ctx.db;
  const trashed = await supabase.rpc("trash_task", { target_task: taskId });
  if (trashed.error?.code === "PGRST202") {
    checkUpdated(
      await supabase.from("tasks").update({ deleted_at: nowIso() }).eq("id", taskId).select("id"),
      TRASH_NOT_ALLOWED,
    );
    return;
  }
  check(trashed, TRASH_NOT_ALLOWED);
}

const TRASH_NOT_ALLOWED = "Only Editors and above can delete tasks";

// Oct 26 notes (batch 4): the task is back in every project, My tasks, and search, so the caller drops
// the browser's cached copies of those pages too (going back to the List shows it at once).
export async function restoreTask(ctx: ApiContext, taskId: string): Promise<void> {
  const supabase = ctx.db;
  check(await supabase.rpc("restore_task", { target_task: id(taskId) }));
}

async function lastSortOrder(ctx: ApiContext, projectId: string, sectionId: string | null) {
  const supabase = ctx.db;
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
  ctx: ApiContext,
  taskId: string,
  projectId: string,
  sectionId: string | null,
  sortOrder?: number,
): Promise<void> {
  const targetSection = sectionId ? id(sectionId, "section") : null;
  const order =
    sortOrder !== undefined && Number.isFinite(sortOrder)
      ? sortOrder
      : (await lastSortOrder(ctx, id(projectId), targetSection)) + ORDER_STEP;
  const supabase = ctx.db;
  checkUpdated(
    await supabase
      .from("task_projects")
      .update({ section_id: targetSection, sort_order: order })
      .eq("task_id", id(taskId))
      .eq("project_id", id(projectId))
      .select("task_id"),
  );
}

// Places a task in a section of one of its projects, before `beforeId` (null = end of the section).
// The database picks the midpoint and reindexes the section when the gap gets too small.
export async function placeTask(
  ctx: ApiContext,
  taskId: string,
  projectId: string,
  sectionId: string | null,
  beforeId: string | null,
): Promise<void> {
  const supabase = ctx.db;
  check(
    await supabase.rpc("place_task", {
      target_task: id(taskId, "task"),
      target_project: id(projectId, "project"),
      target_section: sectionId ? id(sectionId, "section") : null,
      before_task: beforeId ? id(beforeId, "task") : null,
    }),
  );
}

export async function placeSection(ctx: ApiContext, sectionId: string, beforeId: string | null): Promise<void> {
  const supabase = ctx.db;
  check(
    await supabase.rpc("place_section", {
      target_section: id(sectionId, "section"),
      before_section: beforeId ? id(beforeId, "section") : null,
    }),
  );
}

function bulkOperation(input: BulkOperation): Json {
  switch (input?.action) {
    case "complete":
    case "reopen":
    case "delete":
      return { action: input.action };
    case "assign":
      return { action: "assign", assignee_id: input.assignee_id ? id(input.assignee_id, "assignee") : null };
    case "set_due":
      return { action: "set_due", due_on: optionalDate(input.due_on, "due date") };
    case "move_section":
    case "add_to_project":
      return {
        action: input.action,
        project_id: id(input.project_id, "project"),
        section_id: input.section_id ? id(input.section_id, "section") : null,
      };
    case "my_section":
      return { action: "my_section", section_id: id(input.section_id, "section") };
    case "add_tag":
    case "remove_tag":
      return { action: input.action, tag_id: id(input.tag_id, "tag") };
    case "set_field":
      if (input.value !== null && JSON.stringify(input.value).length > 20000) throw invalid("Value is too long");
      return { action: "set_field", field_id: id(input.field_id, "field"), value: input.value ?? null };
    default:
      throw invalid("Unknown bulk action");
  }
}

// One operation on up to 200 tasks. Tasks that can't be changed are skipped with a reason (the rest
// still go through); stories, inbox items, and rules fire per task as for single edits.
export async function bulkEditTasks(
  ctx: ApiContext,
  taskIds: string[],
  operation: BulkOperation,
): Promise<{ result: BulkResult }> {
  if (!Array.isArray(taskIds) || taskIds.length === 0) throw invalid("Select at least one task");
  const ids = [...new Set(taskIds.map((t) => id(t, "task")))];
  if (ids.length > MAX_BULK_TASKS) throw invalid(`Select at most ${MAX_BULK_TASKS} tasks at a time`);
  const supabase = ctx.db;
  const op = bulkOperation(operation);
  // My Tasks sections are personal, so they have their own RPC (same result shape).
  const response =
    operation.action === "my_section"
      ? await supabase.rpc("move_my_tasks", { target_tasks: ids, target_section: id(operation.section_id, "section") })
      : await supabase.rpc("bulk_update_tasks", { target_tasks: ids, operation: op });
  check(response);
  return { result: parseBulkResult(response.data) };
}

export async function addTaskToProject(ctx: ApiContext, taskId: string, projectId: string): Promise<void> {
  const order = (await lastSortOrder(ctx, id(projectId), null)) + ORDER_STEP;
  const supabase = ctx.db;
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
}

// Removes the task from one project only (Oct 29 notes, 55b: there is no home project; the database
// keeps its internal pointer on one of the task's other projects). The task's last project can't be
// removed: then the refusal's `detail` is the database's error, whose code lastProjectRefusalOf() reads
// ("last_project": the pane offers to delete the task instead). Nor can its last project that isn't
// archived ("archived_only": nobody could edit it in the archived ones).
export async function removeTaskFromProject(ctx: ApiContext, taskId: string, projectId: string): Promise<void> {
  const supabase = ctx.db;
  const response = await supabase
    .from("task_projects")
    .update({ deleted_at: nowIso() })
    .eq("task_id", id(taskId))
    .eq("project_id", id(projectId))
    .is("deleted_at", null)
    .select("task_id");
  const refused = lastProjectRefusal(response.error);
  if (refused) {
    throw new ApiError("invalid", refused === "archived_only" ? ARCHIVED_ONLY_MESSAGE : LAST_PROJECT_MESSAGE, response.error);
  }
  check(response);
  if (!response.data?.length) {
    // Nothing changed: it was already out of that project (fine), or the person's role there (RLS:
    // Editor of that project) doesn't allow it — say so instead of pretending.
    const still = await supabase
      .from("task_projects")
      .select("task_id")
      .eq("task_id", taskId)
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .maybeSingle();
    if (still.data) throw new ApiError("forbidden", NOT_ALLOWED);
  }
}

// Which "can't remove the task's last project" refusal an error removeTaskFromProject threw is (null for
// anything else).
export function lastProjectRefusalOf(error: unknown): LastProjectCode | null {
  return error instanceof ApiError ? lastProjectRefusal(error.detail) : null;
}

// ---------------------------------------------------------------------------------------------
// Subtasks
// ---------------------------------------------------------------------------------------------

// Subtasks are tasks (parent_task_id). Assignee, dates, notes, and fields go through updateTask and
// friends like any task; these cover creating, renaming, completing, ordering, and deleting from a list.

// Returns the new subtask's id (Nov 2 notes, batch 16: the pane's pending row gives way to it).
export async function createSubtask(
  ctx: ApiContext,
  parentId: string,
  title: string,
  beforeId?: string | null,
  options?: { blockParent?: boolean },
): Promise<{ taskId: string | undefined }> {
  const supabase = ctx.db;
  const args = {
    parent_task: id(parentId, "task"),
    task_title: text(title, "Subtask name"),
    before_task: beforeId ? id(beforeId, "subtask") : null,
  };
  // Nov 3 notes (batch 19, 147): "Blocks the parent" makes the new subtask block its parent in the same
  // transaction (create_subtask + set_task_dependency, Editor on both).
  const created = options?.blockParent
    ? await supabase.rpc("create_subtask_blocking_parent", args)
    : await supabase.rpc("create_subtask", args);
  check(created);
  return { taskId: typeof created.data === "string" ? created.data : undefined };
}

// Nov 2 notes (batch 17, 131): a subtask made from a piece of feedback (an approver's requested changes,
// a submitter's emailed reply, a review's outcome): its title from the feedback and a description with
// the full text and a link back to the task the feedback is on. Editors of the task (create_subtask and
// the tasks update policy decide). Returns the new subtask's id, like createSubtask (pending-creates.ts).
export async function createSubtaskFromFeedback(
  ctx: ApiContext,
  parentId: string,
  title: string,
  notes: string,
): Promise<{ taskId: string | undefined }> {
  const supabase = ctx.db;
  const created = await supabase.rpc("create_subtask", {
    parent_task: id(parentId, "task"),
    task_title: text(title, "Subtask name"),
    before_task: null,
  });
  check(created);
  const taskId = typeof created.data === "string" ? created.data : undefined;
  const description = optionalText(notes);
  if (taskId && description) {
    checkUpdated(await supabase.from("tasks").update({ notes: description }).eq("id", taskId).select("id"));
  }
  return { taskId };
}

export async function updateSubtask(
  ctx: ApiContext,
  subtaskId: string,
  patch: { title?: string; completed?: boolean },
): Promise<void> {
  const update: { title?: string; completed_at?: string | null } = {};
  if (patch.title !== undefined) update.title = text(patch.title, "Subtask name");
  if (patch.completed !== undefined) update.completed_at = patch.completed ? nowIso() : null;
  const supabase = ctx.db;
  checkUpdated(await supabase.from("tasks").update(update).eq("id", id(subtaskId)).select("id"));
}

// Moves a subtask before another one under the same parent (null = to the end).
// Makes a task a subtask of another task (Editor on both; it leaves its projects) — tags, fields, comments,
// and dependencies stay with it.
export async function convertToSubtask(ctx: ApiContext, taskId: string, parentId: string): Promise<void> {
  const supabase = ctx.db;
  check(await supabase.rpc("convert_to_subtask", { target_task: id(taskId, "task"), new_parent: id(parentId, "task") }));
}

// Makes a subtask a top-level task of a project the viewer edits. The pane always names one (the first of
// the tree's projects the viewer edits, by default; Oct 29 notes, 55b); without one the database picks.
// Nov 2 notes (batch 16, 123): `blockParent` also makes the new task block the task it came from (one
// transaction: convert_subtask_to_task).
export async function convertToTask(
  ctx: ApiContext,
  taskId: string,
  projectId?: string | null,
  sectionId?: string | null,
  options: { blockParent?: boolean } = {},
): Promise<void> {
  const supabase = ctx.db;
  const args = {
    target_task: id(taskId, "task"),
    target_project: projectId ? id(projectId, "project") : null,
    target_section: sectionId ? id(sectionId, "section") : null,
  };
  if (options.blockParent === true) {
    const both = await supabase.rpc("convert_subtask_to_task", { ...args, block_parent: true });
    if (both.error?.code === "PGRST202") throw invalid("Blocking the parent task needs this release’s database update");
    check(both);
    return;
  }
  check(await supabase.rpc("convert_to_task", args));
}

export async function placeSubtask(ctx: ApiContext, subtaskId: string, beforeId: string | null): Promise<void> {
  const supabase = ctx.db;
  check(
    await supabase.rpc("place_subtask", {
      target_task: id(subtaskId, "subtask"),
      before_task: beforeId ? id(beforeId, "subtask") : null,
    }),
  );
}

export async function deleteSubtask(ctx: ApiContext, subtaskId: string): Promise<void> {
  await trashTask(ctx, id(subtaskId));
}
