// Big move 1: the dependencies area's reads: what a date change would do to dependent tasks (nothing
// changes yet), and a task's open blockers. Every function takes the caller's ApiContext first and reads
// only through ctx.db (RLS and the invoker RPCs decide); no Next.js here.
import type { ApiContext } from "@/lib/api/core/context";
import { check } from "@/lib/api/core/db";
import { invalid } from "@/lib/api/core/errors";
import { START_AFTER_DUE, id, optionalDate } from "@/lib/api/core/validate";
import { shiftMovesInput } from "@/lib/api/dependencies/inputs";
import { toPlanRows, type TaskBlocker } from "@/lib/api/dependencies/model";
import { numbersWithTheirProjects } from "@/lib/api/numbers/queries";
import type { ShiftMove, ShiftPlanRow } from "@/lib/dependencies";
import type { Json } from "@/lib/supabase/database.types";

// What moving a task to these dates would do to the tasks that depend on it (nothing changes yet).
export async function previewDependencyShift(
  ctx: ApiContext,
  taskId: string,
  dates: { startOn: string | null; dueOn: string | null },
): Promise<ShiftPlanRow[]> {
  const startOn = optionalDate(dates.startOn, "start date");
  const dueOn = optionalDate(dates.dueOn, "due date");
  if (startOn && dueOn && startOn > dueOn) throw invalid(START_AFTER_DUE);
  const supabase = ctx.db;
  const result = await supabase.rpc("preview_dependency_shift", {
    target_task: id(taskId, "task"),
    new_start_on: startOn,
    new_due_on: dueOn,
  });
  check(result);
  return (result.data ?? []).map((r) => ({
    taskId: r.task_id,
    title: r.title,
    startOn: r.start_on,
    dueOn: r.due_on,
    newStart: r.new_start,
    newDue: r.new_due,
    shiftDays: r.shift_days,
    status: r.status === "move" ? ("move" as const) : ("skipped" as const),
    reason: r.reason,
  }));
}

// What moving several tasks at once (e.g. a bulk due date) would do to their dependents; pullEarlier
// also brings dependents earlier when their predecessors move earlier. Nothing changes yet.
export async function previewDependencyShifts(ctx: ApiContext, moves: ShiftMove[], pullEarlier = false): Promise<ShiftPlanRow[]> {
  const supabase = ctx.db;
  const result = await supabase.rpc("preview_dependency_shifts", {
    moves: shiftMovesInput(moves),
    pull_earlier: pullEarlier === true,
  });
  check(result);
  return toPlanRows(result.data ?? []);
}

// 43. The open blockers of a task (the locked checkbox's hover card): the ones the viewer can read with
// their numbers and project names, plus how many more they can't open.
export async function loadTaskBlockers(ctx: ApiContext, taskId: string): Promise<{ total: number; blockers: TaskBlocker[] }> {
  const supabase = ctx.db;
  const result = await supabase.rpc("task_open_blockers", { target_task: id(taskId, "task") });
  check(result);
  const value = (result.data && typeof result.data === "object" && !Array.isArray(result.data) ? result.data : {}) as Record<string, Json>;
  const list = Array.isArray(value.blockers) ? value.blockers : [];
  const rowsOf = list.filter((b): b is Record<string, Json> => Boolean(b) && typeof b === "object" && !Array.isArray(b));
  const named = await numbersWithTheirProjects(
    ctx,
    rowsOf.map((b) => ({ id: String(b.id), projectId: typeof b.home_project_id === "string" ? b.home_project_id : null })),
  );
  const blockers = rowsOf.map((b) => ({
    id: String(b.id),
    title: typeof b.title === "string" ? b.title : "",
    label: named.get(String(b.id))?.label ?? null,
    projectName: named.get(String(b.id))?.projectName ?? null,
    isSubtask: typeof b.parent_task_id === "string",
  }));
  return { total: typeof value.total === "number" ? value.total : blockers.length, blockers };
}
