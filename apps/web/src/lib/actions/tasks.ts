"use server";
// Big move 1: the tasks area's Server Actions, thin wrappers around packages/core/src/api/tasks/mutations.ts (and
// two reads in packages/core/src/api/tasks/queries.ts). Only what Next.js does (cached pages, the request's context)
// stays here.
import type { ApiErrorCode } from "@alhc/core/api/core/errors";
import type { ActionResult } from "@alhc/core/api/core/result";
import type { ParentCandidate } from "@alhc/core/api/tasks/model";
import * as tasksApi from "@alhc/core/api/tasks/mutations";
import * as tasksQueries from "@alhc/core/api/tasks/queries";
import type { BulkOperation, BulkResult } from "@alhc/core/bulk";
import type { DuplicateTaskOptions, DuplicateTaskResult } from "@alhc/core/duplicate-task";
import type { Recurrence } from "@alhc/core/recurrence";
import type { RequestLabel } from "@alhc/core/request-numbers";
import { readAction, run, runWith, SCREEN_ONLY } from "@/lib/server/action";
import type { TaskKind } from "@alhc/core/task-kinds";
import type { LastProjectCode } from "@alhc/core/task-projects";


// ---------------------------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------------------------

export async function createTask(
  projectId: string,
  sectionId: string | null,
  title: string,
  kind: TaskKind = "task",
  // Asana's toolbar "+ Add task": the new task goes to the top of its section.
  atTop = false,
): Promise<ActionResult & { taskId?: string }> {
  return runWith((ctx) => tasksApi.createTask(ctx, projectId, sectionId, title, kind, atTop));
}

// Quick-add in My Tasks: a private task assigned to the caller. Returns the new task's id (Create → Task
// offers to open it).
export async function createPrivateTask(
  title: string,
  mySectionId: string | null = null,
): Promise<ActionResult & { taskId?: string }> {
  const result = await runWith((ctx) => tasksApi.createPrivateTask(ctx, title, mySectionId));
  return { ...result, taskId: result.error ? undefined : result.taskId };
}

export async function duplicateTask(
  taskId: string,
  options: DuplicateTaskOptions,
): Promise<ActionResult & { result?: DuplicateTaskResult }> {
  return runWith((ctx) => tasksApi.duplicateTask(ctx, taskId, options));
}

export async function setTaskKind(taskId: string, kind: TaskKind): Promise<ActionResult> {
  return run((ctx) => tasksApi.setTaskKind(ctx, taskId, kind));
}

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
  // Nov 12 notes (batch 40, item 1): the screen shows the change by itself (src/lib/patched-writes.ts), so
  // skip the refresh and keep the router's recently visited pages. Only a name, assignee, or description.
  screenOnly = false,
): Promise<ActionResult> {
  const patchedKeys = Object.keys(patch).every((key) => key === "title" || key === "assigneeId" || key === "notes");
  return run((ctx) => tasksApi.updateTask(ctx, taskId, patch), screenOnly && patchedKeys ? SCREEN_ONLY : {});
}

export async function setTaskRecurrence(taskId: string, rule: Recurrence | null): Promise<ActionResult> {
  return run((ctx) => tasksApi.setTaskRecurrence(ctx, taskId, rule));
}

// `screenOnly` (batch 40, item 1): see updateTask.
export async function setTaskCompleted(taskId: string, completed: boolean, screenOnly = false): Promise<ActionResult> {
  return run((ctx) => tasksApi.setTaskCompleted(ctx, taskId, completed), screenOnly ? SCREEN_ONLY : {});
}

export async function deleteTask(taskId: string): Promise<ActionResult> {
  return run((ctx) => tasksApi.deleteTask(ctx, taskId));
}

// Oct 26 notes (batch 4): the task is back in every project, My tasks, and search, so drop the browser's
// cached copies of those pages too (going back to the List shows it at once).
export async function restoreTask(taskId: string): Promise<ActionResult> {
  return run((ctx) => tasksApi.restoreTask(ctx, taskId), { revalidate: [["/", "layout"]] });
}

// Undo of a bulk delete: restores each task the delete trashed (restore_task checks Editor on each). A
// task that can't come back is skipped; the answer says how many did.
export async function restoreTasks(taskIds: string[]): Promise<ActionResult & { restored?: number; failed?: number }> {
  return runWith(
    async (ctx) => {
      let restored = 0;
      let failed = 0;
      for (const taskId of taskIds.slice(0, 200)) {
        try {
          await tasksApi.restoreTask(ctx, taskId);
          restored += 1;
        } catch {
          failed += 1;
        }
      }
      return { restored, failed };
    },
    { revalidate: [["/", "layout"]] },
  );
}

export async function moveTask(
  taskId: string,
  projectId: string,
  sectionId: string | null,
  sortOrder?: number,
): Promise<ActionResult> {
  return run((ctx) => tasksApi.moveTask(ctx, taskId, projectId, sectionId, sortOrder));
}

export async function placeTask(
  taskId: string,
  projectId: string,
  sectionId: string | null,
  beforeId: string | null,
): Promise<ActionResult> {
  return run((ctx) => tasksApi.placeTask(ctx, taskId, projectId, sectionId, beforeId));
}

export async function placeSection(sectionId: string, beforeId: string | null): Promise<ActionResult> {
  return run((ctx) => tasksApi.placeSection(ctx, sectionId, beforeId));
}

export async function bulkEditTasks(
  taskIds: string[],
  operation: BulkOperation,
): Promise<ActionResult & { result?: BulkResult }> {
  return runWith((ctx) => tasksApi.bulkEditTasks(ctx, taskIds, operation));
}

export async function addTaskToProject(taskId: string, projectId: string): Promise<ActionResult> {
  return run((ctx) => tasksApi.addTaskToProject(ctx, taskId, projectId));
}

// The task's last project (or its last one that isn't archived) can't be removed: then `code` is
// "last_project" / "archived_only" and the pane offers to delete the task instead.
export async function removeTaskFromProject(
  taskId: string,
  projectId: string,
): Promise<Omit<ActionResult, "code"> & { code?: ApiErrorCode | LastProjectCode }> {
  const refused: { code: LastProjectCode | null } = { code: null };
  const result = await run(async (ctx) => {
    try {
      await tasksApi.removeTaskFromProject(ctx, taskId, projectId);
    } catch (error) {
      refused.code = tasksApi.lastProjectRefusalOf(error);
      throw error;
    }
  });
  return refused.code ? { ...result, code: refused.code } : result;
}

// ---------------------------------------------------------------------------------------------
// Subtasks
// ---------------------------------------------------------------------------------------------

export async function createSubtask(
  parentId: string,
  title: string,
  beforeId?: string | null,
  options?: { blockParent?: boolean },
): Promise<ActionResult & { taskId?: string }> {
  return runWith((ctx) => tasksApi.createSubtask(ctx, parentId, title, beforeId, options));
}

export async function createSubtaskFromFeedback(
  parentId: string,
  title: string,
  notes: string,
): Promise<ActionResult & { taskId?: string }> {
  return runWith((ctx) => tasksApi.createSubtaskFromFeedback(ctx, parentId, title, notes));
}

export async function updateSubtask(
  subtaskId: string,
  patch: { title?: string; completed?: boolean },
): Promise<ActionResult> {
  return run((ctx) => tasksApi.updateSubtask(ctx, subtaskId, patch));
}

export async function convertToSubtask(taskId: string, parentId: string): Promise<ActionResult> {
  return run((ctx) => tasksApi.convertToSubtask(ctx, taskId, parentId));
}

export async function convertToTask(
  taskId: string,
  projectId?: string | null,
  sectionId?: string | null,
  options: { blockParent?: boolean } = {},
): Promise<ActionResult> {
  return run((ctx) => tasksApi.convertToTask(ctx, taskId, projectId, sectionId, options));
}

export async function placeSubtask(subtaskId: string, beforeId: string | null): Promise<ActionResult> {
  return run((ctx) => tasksApi.placeSubtask(ctx, subtaskId, beforeId));
}

export async function deleteSubtask(subtaskId: string): Promise<ActionResult> {
  return run((ctx) => tasksApi.deleteSubtask(ctx, subtaskId));
}

// ---------------------------------------------------------------------------------------------
// Reads the browser calls
// ---------------------------------------------------------------------------------------------

export async function searchSubtaskParents(taskId: string, query: string): Promise<{ error?: string; data?: ParentCandidate[] }> {
  return readAction((ctx) => tasksQueries.searchSubtaskParents(ctx, taskId, query));
}

export async function loadProjectLabels(projectId: string, taskIds: string[]): Promise<{ error?: string; data?: Record<string, RequestLabel> }> {
  return readAction((ctx) => tasksQueries.loadProjectLabels(ctx, projectId, taskIds));
}
