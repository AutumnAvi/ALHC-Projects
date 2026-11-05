// Big move 1: the dependencies area's types and pure mappers (dependency links, date shifts, the open
// blockers of a task). No database here; safe in the browser.
import type { DependencyShiftMode, ShiftChange, ShiftPlanRow, ShiftResult } from "../../dependencies";
import type { RequestLabel } from "../../request-numbers";

// What a date change did: moved (with the project's dependency shifting), or a plan to ask about first.
export type DateChangeOutcome =
  | { kind: "done"; mode: DependencyShiftMode; changes: ShiftChange[]; skipped: ShiftResult["skipped"] }
  | { kind: "ask"; push: ShiftPlanRow[]; pull: ShiftPlanRow[] };

// 43. The open blockers of a task (the locked checkbox's hover card): the ones the viewer can read with
// their numbers and project names, plus how many more they can't open.
export type TaskBlocker = { id: string; title: string; label: RequestLabel | null; projectName: string | null; isSubtask: boolean };

// A shift plan's rows as the database returns them (preview_dependency_shifts and friends).
export type ShiftPlanDbRow = {
  task_id: string;
  title: string;
  start_on: string | null;
  due_on: string | null;
  new_start: string | null;
  new_due: string | null;
  shift_days: number;
  status: string;
  reason: string | null;
};

export function toPlanRows(data: ShiftPlanDbRow[]): ShiftPlanRow[] {
  return data.map((r) => ({
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
