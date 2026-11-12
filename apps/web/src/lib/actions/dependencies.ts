"use server";
// Big move 1: the dependencies area's Server Actions, thin wrappers around
// packages/core/src/api/dependencies/{queries,mutations}.ts. Only what Next.js does (re-rendering the page,
// delivering the outboxes after the response) stays here.
import { refresh } from "next/cache";
import type { ActionResult } from "@alhc/core/api/core/result";
import type { DateChangeOutcome, TaskBlocker } from "@alhc/core/api/dependencies/model";
import * as dependenciesApi from "@alhc/core/api/dependencies/mutations";
import * as dependenciesQueries from "@alhc/core/api/dependencies/queries";
import * as tasksQueries from "@alhc/core/api/tasks/queries";
import type { CriticalPath } from "@alhc/core/critical-path";
import type {
  DependencyKind,
  DependencyShiftMode,
  ShiftChange,
  ShiftMove,
  ShiftPlanRow,
  ShiftResult,
  UndoResult,
} from "@alhc/core/dependencies";
import { deliverQueuedEmail, readAction, run, runWith } from "@/lib/server/action";

export async function setTaskDependency(
  predecessorId: string,
  successorId: string,
  kind: DependencyKind = "finish_to_start",
  lagDays = 0,
): Promise<ActionResult> {
  return run((ctx) => dependenciesApi.setTaskDependency(ctx, predecessorId, successorId, kind, lagDays));
}

// What moving a task to these dates would do to the tasks that depend on it (nothing changes yet).
export async function previewDependencyShift(
  taskId: string,
  dates: { startOn: string | null; dueOn: string | null },
): Promise<{ error?: string; data?: ShiftPlanRow[] }> {
  return readAction((ctx) => dependenciesQueries.previewDependencyShift(ctx, taskId, dates));
}

// What moving several tasks at once (e.g. a bulk due date) would do to their dependents; pullEarlier
// also brings dependents earlier when their predecessors move earlier. Nothing changes yet.
export async function previewDependencyShifts(
  moves: ShiftMove[],
  pullEarlier = false,
): Promise<{ error?: string; data?: ShiftPlanRow[] }> {
  return readAction((ctx) => dependenciesQueries.previewDependencyShifts(ctx, moves, pullEarlier));
}

// Moves the tasks and the confirmed dependents; tasks that can't move are reported in skipped. The
// result's changes feed undoDependencyShift.
export async function applyDependencyShifts(
  moves: ShiftMove[],
  confirmedIds: string[],
  pullEarlier = false,
): Promise<ActionResult & { result?: ShiftResult }> {
  return runWith((ctx) => dependenciesApi.applyDependencyShifts(ctx, moves, confirmedIds, pullEarlier));
}

// Nov 3 notes (batch 19, 148): a Timeline drag (see dependenciesApi.moveTaskDatesWith).
export async function moveTaskDatesWith(
  moves: ShiftMove[],
  how: "only" | "along" | "push",
): Promise<ActionResult & { result?: ShiftResult }> {
  return runWith((ctx) => dependenciesApi.moveTaskDatesWith(ctx, moves, how));
}

// Moves the task and the confirmed dependents in one call; the result's changes feed undoDependencyShift.
export async function applyDependencyShift(
  taskId: string,
  dates: { startOn: string | null; dueOn: string | null },
  confirmedIds: string[],
): Promise<ActionResult & { result?: ShiftResult }> {
  return runWith((ctx) => dependenciesApi.applyDependencyShift(ctx, taskId, dates, confirmedIds));
}

// Puts back the dates a shift changed (tasks edited since keep their new dates and are reported).
export async function undoDependencyShift(changes: ShiftChange[]): Promise<ActionResult & { result?: UndoResult }> {
  return runWith((ctx) => dependenciesApi.undoDependencyShift(ctx, changes));
}

export async function removeTaskDependency(dependencyId: string): Promise<ActionResult> {
  return run((ctx) => dependenciesApi.removeTaskDependency(ctx, dependencyId));
}

export async function changeTaskDates(moves: ShiftMove[]): Promise<ActionResult & { outcome?: DateChangeOutcome }> {
  let outcome: DateChangeOutcome | undefined;
  // Not run()'s delivery and refresh: an "ask" outcome changed nothing, so it mustn't refresh the page
  // under the prompt.
  const result = await run(
    async (ctx) => {
      outcome = await dependenciesApi.changeTaskDates(ctx, moves);
    },
    { refresh: false, deliver: false },
  );
  if (result.error) return result;
  if (outcome?.kind === "done") {
    deliverQueuedEmail();
    refresh();
  }
  return { outcome };
}

export async function setDependencyShiftMode(projectId: string, mode: DependencyShiftMode): Promise<ActionResult> {
  return run((ctx) => dependenciesApi.setDependencyShiftMode(ctx, projectId, mode));
}

// 43. The open blockers of a task (the locked checkbox's hover card): the ones the viewer can read with
// their numbers and project names, plus how many more they can't open.
export async function loadTaskBlockers(taskId: string): Promise<{ error?: string; data?: { total: number; blockers: TaskBlocker[] } }> {
  return readAction((ctx) => dependenciesQueries.loadTaskBlockers(ctx, taskId));
}

// Nov 12 (batch 39, item 4): the Timeline's critical path and slack, asked for after the chart paints
// (the server only works it out up front while the Critical path switch is on). The person's own context.
export async function loadProjectCriticalPath(projectId: string): Promise<ActionResult & { data?: CriticalPath }> {
  return readAction((ctx) => tasksQueries.projectCriticalPath(ctx, projectId));
}
