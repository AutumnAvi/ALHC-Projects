import type { Json } from "@/lib/supabase/database.types";

// Dependency kinds and lag (mirror task_dependencies_kind_check / task_dependencies_lag_days_check and
// set_task_dependency()). finish_to_start: the successor starts on or after the predecessor's due date +
// lag and can't be completed while the predecessor is open. start_to_start: the successor starts on or
// after the predecessor's start + lag; it never blocks completion. Since Automations V3:
// finish_to_finish: the successor's due date is on or after the predecessor's + lag, and it can't be
// completed while the predecessor is open; start_to_finish: the successor's due date is on or after the
// predecessor's start + lag, and it can't be completed until the predecessor starts.
export const DEPENDENCY_KINDS = [
  { value: "finish_to_start", label: "Finish → start", short: "FS" },
  { value: "start_to_start", label: "Start → start", short: "SS" },
  { value: "finish_to_finish", label: "Finish → finish", short: "FF" },
  { value: "start_to_finish", label: "Start → finish", short: "SF" },
] as const;

// Kinds that anchor on the predecessor's start, and kinds that hold the successor's due date.
export function fromPredecessorStart(kind: string) {
  return kind === "start_to_start" || kind === "start_to_finish";
}
export function toSuccessorFinish(kind: string) {
  return kind === "finish_to_finish" || kind === "start_to_finish";
}

// Kinds that block completing the successor while the predecessor is open (start_to_finish: until it
// starts, which the database checks).
export function blocksCompletion(kind: string) {
  return kind !== "start_to_start";
}

export type DependencyKind = (typeof DEPENDENCY_KINDS)[number]["value"];

export const MAX_LAG_DAYS = 365;

export function isDependencyKind(value: unknown): value is DependencyKind {
  return DEPENDENCY_KINDS.some((k) => k.value === value);
}

export function parseDependencyKind(value: unknown): DependencyKind {
  return isDependencyKind(value) ? value : "finish_to_start";
}

export function isLagDays(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && Math.abs(value) <= MAX_LAG_DAYS;
}

export function dependencyKindLabel(kind: DependencyKind) {
  return DEPENDENCY_KINDS.find((k) => k.value === kind)?.label ?? kind;
}

// "+2 days", "−1 day" ("" for no lag).
export function lagLabel(lagDays: number) {
  if (!lagDays) return "";
  const n = Math.abs(lagDays);
  return `${lagDays > 0 ? "+" : "−"}${n} day${n === 1 ? "" : "s"}`;
}

// One line for a link, e.g. "Finish → start +2 days".
export function dependencyLabel(kind: DependencyKind, lagDays: number) {
  const lag = lagLabel(lagDays);
  return lag ? `${dependencyKindLabel(kind)} ${lag}` : dependencyKindLabel(kind);
}

type Dated = { startOn: string | null; dueOn: string | null; kind?: string };

function addDays(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// A task's anchor dates as the database uses them: start = start date, else due date (a milestone starts on
// its due day); due = due date, else start date.
export function anchorsOf(task: Dated) {
  const start = task.kind === "milestone" ? task.dueOn : (task.startOn ?? task.dueOn);
  return { start, due: task.dueOn ?? task.startOn };
}

// The earliest day the successor may start (or, for *_to_finish links, finish) under this link (null
// when the predecessor has no dates).
export function earliestStart(pred: Dated, kind: DependencyKind, lagDays: number) {
  const { start, due } = anchorsOf(pred);
  const anchor = fromPredecessorStart(kind) ? start : due;
  return anchor ? addDays(anchor, lagDays) : null;
}

// True when the successor starts (or finishes) before the link allows (a red arrow on Timeline).
export function dependencyConflict(pred: Dated, succ: Dated, kind: DependencyKind, lagDays: number) {
  const earliest = earliestStart(pred, kind, lagDays);
  const anchors = anchorsOf(succ);
  const held = toSuccessorFinish(kind) ? anchors.due : anchors.start;
  return Boolean(earliest && held && held < earliest);
}

// ---------------------------------------------------------------------------------------------
// Auto-shift (preview_dependency_shift / apply_dependency_shift / undo_dependency_shift)
// ---------------------------------------------------------------------------------------------

export type ShiftPlanRow = {
  taskId: string;
  title: string;
  startOn: string | null;
  dueOn: string | null;
  newStart: string | null;
  newDue: string | null;
  shiftDays: number;
  status: "move" | "skipped";
  reason: string | null;
};

export type ShiftChange = {
  task_id: string;
  title: string | null;
  old_start_on: string | null;
  old_due_on: string | null;
  new_start_on: string | null;
  new_due_on: string | null;
};

export type ShiftSkip = { taskId: string; title: string | null; reason: string };

export type ShiftResult = { changes: ShiftChange[]; skipped: ShiftSkip[] };

export type UndoResult = { restored: string[]; skipped: ShiftSkip[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : null);

function parseSkips(value: unknown): ShiftSkip[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter(isObj).map((s) => ({ taskId: String(s.task_id ?? ""), title: str(s.title), reason: str(s.reason) ?? "" }))
    : [];
}

export function parseShiftResult(value: Json | null): ShiftResult {
  if (!isObj(value)) return { changes: [], skipped: [] };
  const changes = Array.isArray(value.changes)
    ? (value.changes as unknown[]).filter(isObj).map((c) => ({
        task_id: String(c.task_id ?? ""),
        title: str(c.title),
        old_start_on: str(c.old_start_on),
        old_due_on: str(c.old_due_on),
        new_start_on: str(c.new_start_on),
        new_due_on: str(c.new_due_on),
      }))
    : [];
  return { changes, skipped: parseSkips(value.skipped) };
}

export function parseUndoResult(value: Json | null): UndoResult {
  if (!isObj(value)) return { restored: [], skipped: [] };
  const restored = Array.isArray(value.restored)
    ? (value.restored as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  return { restored, skipped: parseSkips(value.skipped) };
}

export function shiftLabel(days: number) {
  return `${days > 0 ? "+" : "−"}${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"}`;
}

// Several tasks at once (preview_dependency_shifts / apply_dependency_shifts): each move gives the new
// dates; a date left out (undefined) keeps the task's current one, null clears it. pullEarlier also moves
// dependents earlier when their predecessors move earlier (keeping the gap).
export const MAX_SHIFT_MOVES = 200;

export type ShiftMove = { taskId: string; startOn?: string | null; dueOn?: string | null };

// Oct 27 notes (batch 6): what a date change does to dependent tasks, per project
// (projects.dependency_shift; dependency_shift_mode() in the database picks it for a change).
export const DEPENDENCY_SHIFT_MODES = ["auto", "ask", "off"] as const;
export type DependencyShiftMode = (typeof DEPENDENCY_SHIFT_MODES)[number];

export const DEPENDENCY_SHIFT_OPTIONS: Record<DependencyShiftMode, { label: string; description: string }> = {
  auto: {
    label: "Auto-shift",
    description: "Dependent tasks move with their blockers right away — later or earlier, keeping the gap. Undo stays available.",
  },
  ask: {
    label: "Ask me",
    description: "Show which dependent tasks would move (later or earlier) and let me choose.",
  },
  off: {
    label: "Off",
    description: "Only the task you change moves. Dependent tasks keep their dates.",
  },
};

export function parseDependencyShiftMode(value: unknown): DependencyShiftMode {
  return value === "auto" || value === "off" ? value : "ask";
}
