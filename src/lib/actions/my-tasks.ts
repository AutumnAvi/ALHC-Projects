"use server";
// Big move 1: the my-tasks area's Server Actions, thin wrappers around src/lib/api/my-tasks/mutations.ts
// (and one read, loadSubtaskRows, from its queries.ts). Only what Next.js does stays here.
import type { ActionResult } from "@/lib/api/core/result";
import type { QuickAddTaskInput } from "@/lib/api/my-tasks/model";
import * as myTasksApi from "@/lib/api/my-tasks/mutations";
import * as myTasksQueries from "@/lib/api/my-tasks/queries";
import type { SubtaskItem } from "@/lib/api/tasks/model";
import type { CheckedMode } from "@/lib/checklist";
import { readAction, run, runWith } from "@/lib/server/action";

// ---------------------------------------------------------------------------------------------
// My Tasks sections and placements
// ---------------------------------------------------------------------------------------------

export async function createMyTaskSection(name: string): Promise<ActionResult> {
  return run((ctx) => myTasksApi.createMyTaskSection(ctx, name));
}

// Only custom sections can be renamed or deleted (the database refuses the system ones).
export async function renameMyTaskSection(sectionId: string, name: string): Promise<ActionResult> {
  return run((ctx) => myTasksApi.renameMyTaskSection(ctx, sectionId, name));
}

// Its tasks move to the end of Recently assigned (database trigger).
export async function deleteMyTaskSection(sectionId: string): Promise<ActionResult> {
  return run((ctx) => myTasksApi.deleteMyTaskSection(ctx, sectionId));
}

export async function placeMyTaskSection(sectionId: string, beforeId: string | null): Promise<ActionResult> {
  return run((ctx) => myTasksApi.placeMyTaskSection(ctx, sectionId, beforeId));
}

// Places one of the viewer's tasks in one of their sections, before `beforeId` (null = end).
export async function placeMyTask(taskId: string, sectionId: string, beforeId: string | null): Promise<ActionResult> {
  return run((ctx) => myTasksApi.placeMyTask(ctx, taskId, sectionId, beforeId));
}

// ---------------------------------------------------------------------------------------------
// Quick add
// ---------------------------------------------------------------------------------------------

export async function quickAddTask(input: QuickAddTaskInput): Promise<ActionResult & { taskId?: string; note?: string }> {
  return runWith((ctx) => myTasksApi.quickAddTask(ctx, input));
}

// ---------------------------------------------------------------------------------------------
// The checklist
// ---------------------------------------------------------------------------------------------

// Nov 1 notes (batch 9b): "Checked items" on My tasks (stay | sink | hide), saved on the account. Saved
// quietly: no re-render, nothing to deliver.
export async function setMyTasksChecked(mode: CheckedMode): Promise<ActionResult> {
  return run((ctx) => myTasksApi.setMyTasksChecked(ctx, mode), { refresh: false, deliver: false });
}

// Nov 1 notes (batch 9b): "Not now" on a task's "Set a date" prompt.
export async function dismissDatePrompt(taskId: string): Promise<ActionResult> {
  return run((ctx) => myTasksApi.dismissDatePrompt(ctx, taskId));
}

// Undo a tick (the checklist's Undo): reopens the task, and moves the next occurrence a repeating task
// just made to the Trash.
export async function undoTaskCompleted(taskId: string): Promise<ActionResult> {
  return run((ctx) => myTasksApi.undoTaskCompleted(ctx, taskId));
}

// ---------------------------------------------------------------------------------------------
// Expanded rows
// ---------------------------------------------------------------------------------------------

// Saved quietly: no re-render, nothing to deliver.
export async function setTaskRowExpanded(taskId: string, expanded: boolean): Promise<ActionResult> {
  return run((ctx) => myTasksApi.setTaskRowExpanded(ctx, taskId, expanded), { refresh: false, deliver: false });
}

// The subtask tree under some rows (expanding a row), numbered as projectId numbers them.
export async function loadSubtaskRows(rootIds: string[], projectId?: string | null): Promise<{ error?: string; data?: SubtaskItem[] }> {
  return readAction((ctx) => myTasksQueries.loadSubtaskRows(ctx, rootIds, projectId));
}
