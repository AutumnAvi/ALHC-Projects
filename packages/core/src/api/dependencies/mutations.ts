// Big move 1: the dependencies area's writes (dependency links, date changes that move dependent tasks,
// Undo, the project's dependency shifting setting). Every function takes the caller's ApiContext first,
// validates its own input, writes only through ctx.db (RLS and the RPCs decide), and throws ApiError on
// any refusal; no Next.js here.
import type { ApiContext } from "../core/context";
import { check, checkUpdated } from "../core/db";
import { NOT_ALLOWED, invalid } from "../core/errors";
import { START_AFTER_DUE, id, optionalDate } from "../core/validate";
import { shiftMovesInput } from "./inputs";
import { toPlanRows, type DateChangeOutcome } from "./model";
import {
  MAX_SHIFT_MOVES,
  isDependencyKind,
  isLagDays,
  parseDependencyShiftMode,
  parseShiftResult,
  parseUndoResult,
  type DependencyKind,
  type DependencyShiftMode,
  type ShiftChange,
  type ShiftMove,
  type ShiftResult,
  type UndoResult,
} from "../../dependencies";

export async function setTaskDependency(
  ctx: ApiContext,
  predecessorId: string,
  successorId: string,
  kind: DependencyKind = "finish_to_start",
  lagDays = 0,
): Promise<void> {
  if (!isDependencyKind(kind)) throw invalid("Unknown dependency type");
  if (!isLagDays(lagDays)) throw invalid("Lag is a whole number of days between -365 and 365");
  const supabase = ctx.db;
  check(
    await supabase.rpc("set_task_dependency", {
      predecessor: id(predecessorId, "task"),
      successor: id(successorId, "task"),
      dependency_kind: kind,
      dependency_lag: lagDays,
    }),
  );
}

// Moves the tasks and the confirmed dependents; tasks that can't move are reported in skipped. The
// result's changes feed undoDependencyShift.
export async function applyDependencyShifts(
  ctx: ApiContext,
  moves: ShiftMove[],
  confirmedIds: string[],
  pullEarlier = false,
): Promise<{ result: ShiftResult }> {
  if (!Array.isArray(confirmedIds) || confirmedIds.length > 500) throw invalid("Too many tasks to move at once");
  const supabase = ctx.db;
  const response = await supabase.rpc("apply_dependency_shifts", {
    moves: shiftMovesInput(moves),
    confirmed_tasks: [...new Set(confirmedIds.map((t) => id(t, "task")))],
    pull_earlier: pullEarlier === true,
  });
  if (/tasks_start_(on_before_due_on|at_before_due_at)/.test(response.error?.message ?? "")) {
    throw invalid(START_AFTER_DUE);
  }
  check(response);
  return { result: parseShiftResult(response.data) };
}

// Nov 3 notes (batch 19, 148): a Timeline drag. The keys held decide what its dependents do
// (timelineDragHow in packages/core/src/dependency-plan.ts), not the project's Settings → Dependencies:
//   only   just the given tasks move;
//   push   their dependents move only as far as their links ask (nothing earlier);
//   along  their dependents move along by the same amount (preview_dependency_move_along; a database
//          without it pulls / pushes them with the usual plan instead).
// Every task still moves through apply_dependency_shifts, which checks the person can edit it; the
// result's changes feed undoDependencyShift.
export async function moveTaskDatesWith(
  ctx: ApiContext,
  moves: ShiftMove[],
  how: "only" | "along" | "push",
): Promise<{ result: ShiftResult }> {
  if (how !== "only" && how !== "along" && how !== "push") throw invalid("Choose how dependent tasks move");
  const input = shiftMovesInput(moves);
  const givenIds = new Set(input.map((m) => m.task_id as string));
  const supabase = ctx.db;
  let applyMoves: Record<string, string | null>[] = input;
  let confirmed: string[] = [];
  let pullEarlier = false;
  let planSkipped: ShiftResult["skipped"] = [];
  let alongIds = new Set<string>();
  if (how === "push") {
    const plan = await supabase.rpc("preview_dependency_shifts", { moves: input, pull_earlier: false });
    check(plan);
    confirmed = toPlanRows(plan.data ?? []).filter((r) => r.status === "move").map((r) => r.taskId);
  } else if (how === "along") {
    const plan = await supabase.rpc("preview_dependency_move_along", { moves: input });
    if (plan.error?.code === "PGRST202") {
      // Before this release's database update: the usual plan, pulling earlier too.
      const fallback = await supabase.rpc("preview_dependency_shifts", { moves: input, pull_earlier: true });
      check(fallback);
      confirmed = toPlanRows(fallback.data ?? []).filter((r) => r.status === "move").map((r) => r.taskId);
      pullEarlier = true;
    } else {
      check(plan);
      const rows = toPlanRows(plan.data ?? []);
      const along = rows.filter((r) => r.status === "move");
      if (input.length + along.length > MAX_SHIFT_MOVES) {
        throw invalid(`That would move more than ${MAX_SHIFT_MOVES} tasks at once`);
      }
      alongIds = new Set(along.map((r) => r.taskId));
      applyMoves = [...input, ...along.map((r) => ({ task_id: r.taskId, start_on: r.newStart, due_on: r.newDue }))];
      planSkipped = rows
        .filter((r) => r.status !== "move")
        .map((r) => ({ taskId: r.taskId, title: r.title, reason: r.reason ?? "" }));
    }
  }
  const response = await supabase.rpc("apply_dependency_shifts", {
    moves: applyMoves,
    confirmed_tasks: [...new Set(confirmed)],
    pull_earlier: pullEarlier,
  });
  if (/tasks_start_(on_before_due_on|at_before_due_at)/.test(response.error?.message ?? "")) {
    throw invalid(START_AFTER_DUE);
  }
  check(response);
  const parsed = parseShiftResult(response.data);
  // The database lists the plan's other dependents as "not part of the confirmed change": with these keys
  // they were never meant to move, so only refusals of tasks this change did move are worth saying.
  const skipped =
    how === "push"
      ? parsed.skipped.filter((s) => s.reason !== "Not part of the confirmed change")
      : [...parsed.skipped.filter((s) => givenIds.has(s.taskId) || alongIds.has(s.taskId)), ...planSkipped];
  return { result: { changes: parsed.changes, skipped } };
}

// Moves the task and the confirmed dependents in one call; the result's changes feed undoDependencyShift.
export async function applyDependencyShift(
  ctx: ApiContext,
  taskId: string,
  dates: { startOn: string | null; dueOn: string | null },
  confirmedIds: string[],
): Promise<{ result: ShiftResult }> {
  const startOn = optionalDate(dates.startOn, "start date");
  const dueOn = optionalDate(dates.dueOn, "due date");
  if (startOn && dueOn && startOn > dueOn) throw invalid(START_AFTER_DUE);
  if (!Array.isArray(confirmedIds) || confirmedIds.length > 500) throw invalid("Too many tasks to move at once");
  const supabase = ctx.db;
  const response = await supabase.rpc("apply_dependency_shift", {
    target_task: id(taskId, "task"),
    new_start_on: startOn,
    new_due_on: dueOn,
    confirmed_tasks: [...new Set(confirmedIds.map((t) => id(t, "task")))],
  });
  if (/tasks_start_(on_before_due_on|at_before_due_at)/.test(response.error?.message ?? "")) {
    throw invalid(START_AFTER_DUE);
  }
  check(response);
  return { result: parseShiftResult(response.data) };
}

// Puts back the dates a shift changed (tasks edited since keep their new dates and are reported).
export async function undoDependencyShift(ctx: ApiContext, changes: ShiftChange[]): Promise<{ result: UndoResult }> {
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > 501) throw invalid("Nothing to undo");
  const payload = changes.map((c) => ({
    task_id: id(c.task_id, "task"),
    old_start_on: optionalDate(c.old_start_on, "start date"),
    old_due_on: optionalDate(c.old_due_on, "due date"),
    new_start_on: optionalDate(c.new_start_on, "start date"),
    new_due_on: optionalDate(c.new_due_on, "due date"),
  }));
  const supabase = ctx.db;
  const response = await supabase.rpc("undo_dependency_shift", { changes: payload });
  check(response);
  return { result: parseUndoResult(response.data) };
}

export async function removeTaskDependency(ctx: ApiContext, dependencyId: string): Promise<void> {
  const supabase = ctx.db;
  check(await supabase.rpc("remove_task_dependency", { target_dependency: id(dependencyId, "dependency") }));
}

// Oct 27 notes (batch 6, 44): every date change. The project's dependency shifting decides
// (dependency_shift_mode over the tasks): Off moves only the tasks, Auto-shift moves dependents later and
// earlier (keeping the gap), Ask me moves straight away when nothing else would move and otherwise answers
// the plans to ask about ("ask": nothing changed, so the caller mustn't refresh the page under the prompt).
export async function changeTaskDates(ctx: ApiContext, moves: ShiftMove[]): Promise<DateChangeOutcome> {
  const input = shiftMovesInput(moves);
  const ids = moves.map((m) => id(m.taskId, "task"));
  const supabase = ctx.db;
  const [modeResult, push, pull] = await Promise.all([
    supabase.rpc("dependency_shift_mode", { task_ids: ids }),
    supabase.rpc("preview_dependency_shifts", { moves: input, pull_earlier: false }),
    supabase.rpc("preview_dependency_shifts", { moves: input, pull_earlier: true }),
  ]);
  const mode: DependencyShiftMode = modeResult.error ? "ask" : parseDependencyShiftMode(modeResult.data);
  check(push);
  check(pull);
  const pushPlan = toPlanRows(push.data ?? []);
  const pullPlan = toPlanRows(pull.data ?? []);
  const pushes = pushPlan.filter((r) => r.status === "move");
  const pulls = pullPlan.filter((r) => r.status === "move" && r.shiftDays < 0);
  if (mode === "ask" && (pushes.length > 0 || pulls.length > 0)) {
    return { kind: "ask", push: pushPlan, pull: pulls.length > 0 ? pullPlan : [] };
  }
  const confirmed = mode === "auto" ? pullPlan.filter((r) => r.status === "move").map((r) => r.taskId) : [];
  const applied = await supabase.rpc("apply_dependency_shifts", {
    moves: input,
    confirmed_tasks: [...new Set(confirmed)],
    pull_earlier: mode === "auto",
  });
  if (/tasks_start_(on_before_due_on|at_before_due_at)/.test(applied.error?.message ?? "")) {
    throw invalid(START_AFTER_DUE);
  }
  check(applied);
  const parsed = parseShiftResult(applied.data);
  // A task the person moved and couldn't: say why (the others still moved).
  const given = new Set(ids);
  const refused = parsed.skipped.find((skip) => given.has(skip.taskId));
  if (refused && moves.length === 1) throw invalid(refused.reason || NOT_ALLOWED);
  return { kind: "done", mode, changes: parsed.changes, skipped: parsed.skipped };
}

export async function setDependencyShiftMode(ctx: ApiContext, projectId: string, mode: DependencyShiftMode): Promise<void> {
  if (!["auto", "ask", "off"].includes(mode)) throw invalid("Choose Auto-shift, Ask me, or Off");
  const supabase = ctx.db;
  const result = await supabase.from("projects").update({ dependency_shift: mode }).eq("id", id(projectId, "project")).select("id");
  if (result.error && /dependency_shift/.test(result.error.message)) {
    throw invalid("This setting needs this release's database update");
  }
  checkUpdated(result);
}
