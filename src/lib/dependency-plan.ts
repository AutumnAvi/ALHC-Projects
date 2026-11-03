// Nov 2 notes (batch 16, 125): what moving tasks does to the tasks that depend on them — the same rule
// as public.preview_dependency_shifts() in 20261102050000_nov2_batch16_a.sql (the unit tests and suite
// zz47 share the vectors). The browser runs it to move dependents on screen at once (Auto-shift) while
// the database does the real change with the same plan.
//
// The rule:
//   * A task starts on its start date, else its due date (a milestone on its due day); it ends on its
//     due date, else its start date. Its length is counted in workdays of the workspace's workweek
//     (Sunday–Thursday unless an admin changed it; all seven days = calendar days).
//   * A link asks for a start: finish-to-start / start-to-start = the predecessor's due / start plus the
//     lag (in workdays), on a workday; finish-to-finish / start-to-finish ask that of the due date, so
//     the start is that many workdays (the task's length) before it.
//   * Every dependent of a moved task that now starts earlier than a moved predecessor asks is pushed
//     to the latest such start, whichever way the predecessor moved — a conflict always resolves. With
//     "pull earlier" (Auto-shift, or ticked in Ask me), a dependent whose moved predecessors all moved
//     earlier comes earlier by the same number of days (on a workday), never before what its links ask.
//   * Moved dependents keep their length in workdays and push their own dependents (chains).
//   * Completed tasks and tasks the person can't edit stay where they are (listed, not moved further).
//
// Nov 3 notes (batch 19, 148): the Timeline's drags pick how dependents move with modifier keys
// (timelineDragHow): a plain drag moves only the task, Alt (Option) pushes dependents only as far as
// their links ask (planDependencyShifts without pulling), and Shift moves them along by the same amount
// (planMoveAlong, mirrored by public.preview_dependency_move_along() in 20261103020000_nov3_batch19_a.sql).

import { addWorkdays } from "@/lib/workdays";
import type { DependencyKind, ShiftMove, ShiftPlanRow } from "@/lib/dependencies";

export type PlanTask = {
  id: string;
  title: string;
  startOn: string | null;
  dueOn: string | null;
  kind?: string | null;
  completed?: boolean;
  // Missing = editable (the browser only plans for tasks the person can drag).
  canEdit?: boolean;
};

export type PlanLink = { predecessorId: string; successorId: string; kind: DependencyKind; lagDays: number };

const DAY = 86_400_000;

function toTime(date: string) {
  return Date.parse(`${date}T00:00:00Z`);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toTime(to) - toTime(from)) / DAY);
}

function plusDays(date: string, days: number): string {
  return new Date(toTime(date) + days * DAY).toISOString().slice(0, 10);
}

function isBusiness(workWeek: readonly number[]) {
  const size = new Set(workWeek).size;
  return size > 0 && size < 7;
}

// The first workday on or after `date`.
export function rollToWorkday(date: string, workWeek: readonly number[]): string {
  return addWorkdays(date, 0, isBusiness(workWeek), workWeek) ?? date;
}

function addDays(date: string, days: number, workWeek: readonly number[]): string {
  return addWorkdays(date, days, isBusiness(workWeek), workWeek) ?? plusDays(date, days);
}

// Workdays from `from` to `to`, negative when `to` is earlier (calendar days without a workweek).
export function signedWorkdaySteps(from: string, to: string, workWeek: readonly number[]): number {
  return to >= from ? workdaySteps(from, to, workWeek) : -workdaySteps(to, from, workWeek);
}

// Workdays in (from, to] (calendar days without a workweek); 0 when `to` isn't after `from`.
export function workdaySteps(from: string, to: string, workWeek: readonly number[]): number {
  const total = daysBetween(from, to);
  if (total <= 0) return 0;
  if (!isBusiness(workWeek)) return total;
  const week = new Set(workWeek);
  let steps = 0;
  const start = toTime(from);
  for (let i = 1; i <= total; i += 1) {
    if (week.has(new Date(start + i * DAY).getUTCDay())) steps += 1;
  }
  return steps;
}

const startOf = (t: PlanTask) => (t.kind === "milestone" ? t.dueOn : (t.startOn ?? t.dueOn));
const dueOf = (t: PlanTask) => t.dueOn ?? t.startOn;
const maxDate = (a: string | null, b: string) => (a === null || b > a ? b : a);
const usesStart = (kind: DependencyKind) => kind === "start_to_start" || kind === "start_to_finish";
const constrainsDue = (kind: DependencyKind) => kind === "finish_to_finish" || kind === "start_to_finish";

type Moved = { os: string | null; od: string | null; ns: string | null; nd: string | null };

// The given tasks' old and new anchors (a move the task itself would refuse moves nothing).
function movedRoots(tasks: ReadonlyMap<string, PlanTask>, moves: readonly ShiftMove[]) {
  const moved = new Map<string, Moved>();
  for (const move of moves) {
    const src = tasks.get(move.taskId);
    if (!src || moved.has(src.id)) continue;
    let ns = move.startOn !== undefined ? move.startOn : src.startOn;
    const nd = move.dueOn !== undefined ? move.dueOn : src.dueOn;
    if (src.kind === "milestone") ns = null;
    if (ns && nd && ns > nd) continue;
    moved.set(src.id, {
      os: startOf(src),
      od: dueOf(src),
      ns: src.kind === "milestone" ? nd : (ns ?? nd),
      nd: nd ?? ns,
    });
  }
  return moved;
}

function linkMaps(links: readonly PlanLink[]) {
  const into = new Map<string, PlanLink[]>();
  const out = new Map<string, PlanLink[]>();
  for (const link of links) {
    if (!into.has(link.successorId)) into.set(link.successorId, []);
    into.get(link.successorId)!.push(link);
    if (!out.has(link.predecessorId)) out.set(link.predecessorId, []);
    out.get(link.predecessorId)!.push(link);
  }
  return { into, out };
}

export function planDependencyShifts({
  tasks,
  links,
  moves,
  pullEarlier,
  workWeek,
}: {
  tasks: ReadonlyMap<string, PlanTask>;
  links: readonly PlanLink[];
  moves: readonly ShiftMove[];
  pullEarlier: boolean;
  workWeek: readonly number[];
}): ShiftPlanRow[] {
  const moved = movedRoots(tasks, moves);
  if (moved.size === 0) return [];
  const { into, out } = linkMaps(links);

  // Every dependent reachable from the moved tasks, by its longest distance from them (then id), so a
  // task is planned after everything that can push it.
  const order = longestDistanceOrder(new Set(moved.keys()), out);

  const rows: ShiftPlanRow[] = [];
  for (const id of order) {
    const t = tasks.get(id);
    if (!t) continue;
    const cur = startOf(t);
    if (!cur) continue;
    const end = dueOf(t) ?? cur;
    const length = workdaySteps(cur, end, workWeek);

    let need: string | null = null;
    let pull: number | null = null;
    let floor: string | null = null;
    for (const link of into.get(id) ?? []) {
      const m = moved.get(link.predecessorId);
      let newAnchor: string | null;
      let oldAnchor: string | null;
      if (m) {
        newAnchor = usesStart(link.kind) ? m.ns : m.nd;
        oldAnchor = usesStart(link.kind) ? m.os : m.od;
      } else {
        const p = tasks.get(link.predecessorId);
        if (!p) continue;
        newAnchor = usesStart(link.kind) ? startOf(p) : dueOf(p);
        oldAnchor = newAnchor;
      }
      if (!newAnchor) continue;
      const asked = rollToWorkday(addDays(newAnchor, link.lagDays, workWeek), workWeek);
      const required = constrainsDue(link.kind) ? rollToWorkday(addDays(asked, -length, workWeek), workWeek) : asked;
      floor = maxDate(floor, required);
      if (!m) continue;
      if (required > cur) need = maxDate(need, required);
      else if (oldAnchor && newAnchor < oldAnchor) {
        const back = daysBetween(oldAnchor, newAnchor);
        pull = pull === null ? back : Math.max(pull, back);
      }
    }

    let newStart: string;
    if (need !== null) newStart = need;
    else if (pullEarlier && pull !== null) {
      let candidate = rollToWorkday(plusDays(cur, pull), workWeek);
      if (floor && floor > candidate) candidate = floor;
      if (candidate >= cur) continue;
      newStart = candidate;
    } else continue;

    const newDue = t.dueOn === null ? null : t.kind === "milestone" ? newStart : addDays(newStart, length, workWeek);
    const shiftDays = daysBetween(cur, newStart);
    const base = { taskId: id, title: t.title, startOn: t.startOn, dueOn: t.dueOn, shiftDays };
    if (t.completed) {
      rows.push({ ...base, newStart: t.startOn, newDue: t.dueOn, status: "skipped", reason: "Completed" });
      continue;
    }
    if (t.canEdit === false) {
      rows.push({ ...base, newStart: t.startOn, newDue: t.dueOn, status: "skipped", reason: "You can’t edit this task" });
      continue;
    }
    const nextStart = t.startOn === null || t.kind === "milestone" ? null : newStart;
    rows.push({ ...base, newStart: nextStart, newDue, status: "move", reason: null });
    moved.set(id, { os: cur, od: end, ns: newStart, nd: newDue ?? newStart });
  }
  return rows;
}

// Nov 3 notes (batch 19, 148): Shift + drag on the Timeline — every task that waits on the part of the task
// that moved (its end for finish-to-start / finish-to-finish links, its start for start links) moves along
// by the same number of days, chained, so every gap stays the same:
//   * a dependent's shift is the largest change of a moved predecessor's anchor for its links, counted in
//     workdays (later wins over earlier); its start moves by that many workdays (a shift of 0 keeps it);
//   * it never starts before what a moved predecessor's link asks (so a conflict still resolves), and moving
//     earlier never takes it before what any of its links allows;
//   * it keeps its length in workdays; completed tasks and tasks the person can't edit stay (listed), and
//     nothing is followed through them.
export function planMoveAlong({
  tasks,
  links,
  moves,
  workWeek,
}: {
  tasks: ReadonlyMap<string, PlanTask>;
  links: readonly PlanLink[];
  moves: readonly ShiftMove[];
  workWeek: readonly number[];
}): ShiftPlanRow[] {
  const moved = movedRoots(tasks, moves);
  if (moved.size === 0) return [];
  const { into, out } = linkMaps(links);
  const order = longestDistanceOrder(new Set(moved.keys()), out);

  const rows: ShiftPlanRow[] = [];
  for (const id of order) {
    const t = tasks.get(id);
    if (!t) continue;
    const cur = startOf(t);
    if (!cur) continue;
    const end = dueOf(t) ?? cur;
    const length = workdaySteps(cur, end, workWeek);

    let shift: number | null = null;
    let need: string | null = null;
    let floor: string | null = null;
    for (const link of into.get(id) ?? []) {
      const m = moved.get(link.predecessorId);
      let newAnchor: string | null;
      if (m) {
        newAnchor = usesStart(link.kind) ? m.ns : m.nd;
        const oldAnchor = usesStart(link.kind) ? m.os : m.od;
        if (newAnchor && oldAnchor) {
          const delta = signedWorkdaySteps(oldAnchor, newAnchor, workWeek);
          shift = shift === null ? delta : Math.max(shift, delta);
        }
      } else {
        const p = tasks.get(link.predecessorId);
        if (!p) continue;
        newAnchor = usesStart(link.kind) ? startOf(p) : dueOf(p);
      }
      if (!newAnchor) continue;
      const asked = rollToWorkday(addDays(newAnchor, link.lagDays, workWeek), workWeek);
      const required = constrainsDue(link.kind) ? rollToWorkday(addDays(asked, -length, workWeek), workWeek) : asked;
      floor = maxDate(floor, required);
      if (m) need = maxDate(need, required);
    }
    // Not reached through a moved task (e.g. only through a completed one): it stays.
    if (shift === null) continue;

    let newStart = shift === 0 ? cur : addDays(cur, shift, workWeek);
    if (need && need > newStart) newStart = need;
    if (shift < 0 && floor && floor > newStart) newStart = floor;
    if (newStart === cur) continue;

    const newDue = t.dueOn === null ? null : t.kind === "milestone" ? newStart : addDays(newStart, length, workWeek);
    const shiftDays = daysBetween(cur, newStart);
    const base = { taskId: id, title: t.title, startOn: t.startOn, dueOn: t.dueOn, shiftDays };
    if (t.completed) {
      rows.push({ ...base, newStart: t.startOn, newDue: t.dueOn, status: "skipped", reason: "Completed" });
      continue;
    }
    if (t.canEdit === false) {
      rows.push({ ...base, newStart: t.startOn, newDue: t.dueOn, status: "skipped", reason: "You can’t edit this task" });
      continue;
    }
    const nextStart = t.startOn === null || t.kind === "milestone" ? null : newStart;
    rows.push({ ...base, newStart: nextStart, newDue, status: "move", reason: null });
    moved.set(id, { os: cur, od: end, ns: newStart, nd: newDue ?? newStart });
  }
  return rows;
}

// Every task reachable from the roots through the links, by its longest distance from them (then id), so
// a task is planned after everything that can move it.
function longestDistanceOrder(roots: ReadonlySet<string>, out: ReadonlyMap<string, PlanLink[]>): string[] {
  const depth = new Map<string, number>();
  let frontier = [...roots].map((id) => ({ id, d: 0 }));
  while (frontier.length) {
    const next: { id: string; d: number }[] = [];
    for (const { id, d } of frontier) {
      for (const link of out.get(id) ?? []) {
        const s = link.successorId;
        if (d + 1 > 200) continue;
        if ((depth.get(s) ?? 0) < d + 1) {
          depth.set(s, d + 1);
          next.push({ id: s, d: d + 1 });
        }
      }
    }
    frontier = next;
  }
  return [...depth.entries()]
    .filter(([id]) => !roots.has(id))
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([id]) => id);
}

// How many tasks wait on this one, directly or down a chain (for the Timeline's drag hint).
export function dependentCount(taskId: string, links: readonly PlanLink[]): number {
  return longestDistanceOrder(new Set([taskId]), linkMaps(links).out).length;
}

// ---------------------------------------------------------------------------------------------
// Nov 3 notes (batch 19, 148): the Timeline's drag modifiers
// ---------------------------------------------------------------------------------------------

// How a Timeline drag treats the tasks that depend on the dragged one. The project's Settings →
// Dependencies (Auto-shift / Ask me / Off) applies to date changes everywhere else; on the Timeline the
// keys held when the bar is dropped decide:
//   only   plain drag or resize: only this task moves (a red line shows if a dependent now starts too early);
//   along  Shift: its dependents move along by the same amount, chained (every gap stays the same);
//   push   Alt (Option on a Mac): its dependents move only as far as their links ask (nothing earlier).
export type TimelineDragHow = "only" | "along" | "push";

export function timelineDragHow(keys: { shiftKey: boolean; altKey: boolean }): TimelineDragHow {
  if (keys.shiftKey) return "along";
  if (keys.altKey) return "push";
  return "only";
}

export const TIMELINE_DRAG_KEYS: { keys: string; what: string }[] = [
  { keys: "Drag", what: "Move or resize only this task" },
  { keys: "Shift + drag", what: "Move its dependent tasks along by the same amount (keeps every gap)" },
  { keys: "Alt + drag", what: "Push its dependent tasks only as far as their links need (Option on a Mac)" },
  { keys: "Esc", what: "Cancel the drag" },
];

// The line shown while a bar is being dragged.
export function timelineDragHint(how: TimelineDragHow, dependents: number, moving: number): string {
  if (dependents === 0) return "Only this task moves (nothing depends on it). Esc cancels.";
  const all = dependents === 1 ? "its 1 dependent task" : `its ${dependents} dependent tasks`;
  if (how === "along") {
    return moving === 0
      ? `Shift: ${all} move along by the same amount — none needs to move for this change. Esc cancels.`
      : `Shift: ${moving === 1 ? "1 dependent task moves" : `${moving} dependent tasks move`} along by the same amount. Esc cancels.`;
  }
  if (how === "push") {
    return moving === 0
      ? `Alt: ${all} still fit — none needs to move. Esc cancels.`
      : `Alt: ${moving === 1 ? "1 dependent task is" : `${moving} dependent tasks are`} pushed just far enough. Esc cancels.`;
  }
  return `Only this task moves. Hold Shift to move ${all} along, or Alt (Option) to push ${dependents === 1 ? "it" : "them"} only as far as needed. Esc cancels.`;
}
