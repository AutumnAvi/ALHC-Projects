import type { Json } from "@/lib/supabase/database.types";

// Dependency kinds and lag (mirror task_dependencies_kind_check / task_dependencies_lag_days_check and
// set_task_dependency()). finish_to_start: the successor starts on or after the predecessor's due date +
// lag and can't be completed while the predecessor is open. start_to_start: the successor starts on or
// after the predecessor's start + lag; it never blocks completion.
export const DEPENDENCY_KINDS = [
  { value: "finish_to_start", label: "Finish → start", short: "FS" },
  { value: "start_to_start", label: "Start → start", short: "SS" },
] as const;

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

// The earliest day the successor may start under this link (null when the predecessor has no dates).
export function earliestStart(pred: Dated, kind: DependencyKind, lagDays: number) {
  const { start, due } = anchorsOf(pred);
  const anchor = kind === "start_to_start" ? start : due;
  return anchor ? addDays(anchor, lagDays) : null;
}

// True when the successor starts before the link allows (a red arrow on Timeline).
export function dependencyConflict(pred: Dated, succ: Dated, kind: DependencyKind, lagDays: number) {
  const earliest = earliestStart(pred, kind, lagDays);
  const start = anchorsOf(succ).start;
  return Boolean(earliest && start && start < earliest);
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
