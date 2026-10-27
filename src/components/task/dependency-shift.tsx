"use client";

import Link from "next/link";
import { startTransition, useCallback, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { ArrowRight, Settings2 } from "lucide-react";
import { Dialog } from "@/components/dialog";
import { useNotify } from "@/components/toast";
import { applyDependencyShifts, changeTaskDates, undoDependencyShift } from "@/lib/actions";
import { currentMutationToken, dropTokenTasks, holdTaskChanges } from "@/lib/optimistic-session";
import {
  shiftLabel,
  type ShiftChange,
  type ShiftMove,
  type ShiftPlanRow,
  type ShiftResult,
  type ShiftSkip,
} from "@/lib/dependencies";
import { invalidateTaskPanes } from "./task-pane-store";

export type DateChange = { startOn: string | null; dueOn: string | null };
export type MovedTask = { taskId: string } & DateChange;

type Options = {
  // Called with the tasks that move, for optimistic UI: first the changed task(s) at once (before the
  // server answers), later the dependents that moved with them.
  onOptimistic?: (moves: MovedTask[]) => void;
  // Called when the change didn't happen (cancelled or refused), e.g. to reset an input.
  onRevert?: () => void;
  // Called just before the confirm dialog opens (e.g. to close the date picker it would sit under).
  onPrompt?: () => void;
  // The project whose Settings → Dependencies decides how its dependents move (the prompt links there).
  projectId?: string | null;
  // Several tasks at once: which of the given tasks moved and which couldn't (a bulk change's summary).
  onResult?: (result: { moved: string[]; skipped: ShiftSkip[] }) => void;
};

export type ShiftChoice = { confirmed: string[]; pull: boolean } | "only" | "cancel";

// What the prompt shows (exported for tests).
export type ShiftPrompt = {
  // “Spring flyer”, or “8 tasks” for a bulk change.
  subject: string;
  many: boolean;
  push: ShiftPlanRow[];
  pull: ShiftPlanRow[];
  projectId: string | null;
  resolve: (choice: ShiftChoice) => void;
};

function shortDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function span(start: string | null, due: string | null) {
  if (start && due && start !== due) return `${shortDate(start)} – ${shortDate(due)}`;
  return shortDate(due ?? start);
}

const movesOf = (plan: ShiftPlanRow[]) => plan.filter((r) => r.status === "move");
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

// ---------------------------------------------------------------------------------------------
// Pure rules (unit-tested)
// ---------------------------------------------------------------------------------------------

export type ShiftDirection = "later" | "earlier" | "both";

// Which way the dependents of a change would go: pushed later, pulled earlier (keeping the gap), or both
// (e.g. a start moved earlier and a due date moved later). Null when nothing would move.
export function shiftDirection(push: ShiftPlanRow[], pull: ShiftPlanRow[]): ShiftDirection | null {
  const later = movesOf(push).length > 0 || movesOf(pull).some((r) => r.shiftDays > 0);
  const earlier = movesOf(pull).some((r) => r.shiftDays < 0);
  if (later && earlier) return "both";
  if (later) return "later";
  if (earlier) return "earlier";
  return null;
}

// The plan the prompt shows. The pull plan already holds the pushes too, so whenever something would move
// earlier it is the one to show (moving a task earlier: pulling is the choice, not a hidden extra); else
// the push plan.
export function primaryShiftPlan(push: ShiftPlanRow[], pull: ShiftPlanRow[]): { plan: ShiftPlanRow[]; pull: boolean } {
  return movesOf(pull).some((r) => r.shiftDays < 0) ? { plan: pull, pull: true } : { plan: push, pull: false };
}

// What the prompt asks, in plain words.
export function shiftPromptText(
  direction: ShiftDirection,
  subject: string,
  counts: { later: number; earlier: number },
  many = false,
): { title: string; description: string } {
  const it = many ? "them" : "it";
  const depends = (n: number) => (n === 1 ? `a task that depends on ${it}` : `${n} tasks that depend on ${it}`);
  if (direction === "earlier") {
    return {
      title: "Pull dependent tasks earlier too?",
      description: `Moving ${subject} earlier leaves a gap before ${depends(counts.earlier)}. Pull ${plural(counts.earlier, "it", "them")} earlier by the same amount to keep the gap, or leave ${plural(counts.earlier, "it", "them")} where ${plural(counts.earlier, "it is", "they are")}.`,
    };
  }
  if (direction === "both") {
    return {
      title: "Move dependent tasks too?",
      description: `Changing the dates of ${subject} would start ${depends(counts.later)} too early, and leaves a gap before ${depends(counts.earlier)}. Choose which ones move with ${it}.`,
    };
  }
  return {
    title: "Move dependent tasks later too?",
    description: `Moving ${subject} later would start ${depends(counts.later)} too early. Nothing else moves until you choose.`,
  };
}

// The primary button of the prompt.
export function shiftConfirmLabel(direction: ShiftDirection, count: number) {
  const n = plural(count, "1 dependent", `${count} dependents`);
  return direction === "earlier" ? `Pull ${n} earlier` : `Move ${n} too`;
}

// Later (+1), earlier (−1), or the same day (0) for one moved task.
function changeSign(c: ShiftChange) {
  const before = c.old_due_on ?? c.old_start_on;
  const after = c.new_due_on ?? c.new_start_on;
  if (before && after && before !== after) return after > before ? 1 : -1;
  const s0 = c.old_start_on;
  const s1 = c.new_start_on;
  if (s0 && s1 && s0 !== s1) return s1 > s0 ? 1 : -1;
  return 0;
}

// The toast after a change: “Moved “Spring flyer” and 2 dependent tasks later”, plus the dependents
// left alone (completed, or you can't edit them). Null when a single task moved alone (nothing to say).
// Several tasks (a bulk change) always get a line.
export function shiftToastText({
  subject,
  given,
  changes,
  skipped,
}: {
  subject: string;
  given: string[];
  changes: ShiftChange[];
  skipped: ShiftSkip[];
}): string | null {
  const givenSet = new Set(given);
  const many = given.length > 1;
  const dependents = changes.filter((c) => !givenSet.has(c.task_id));
  const leftAlone = skipped.filter((s) => !givenSet.has(s.taskId));
  const movedGiven = changes.filter((c) => givenSet.has(c.task_id)).length;
  const later = dependents.filter((c) => changeSign(c) > 0).length;
  const earlier = dependents.filter((c) => changeSign(c) < 0).length;
  const way = later && !earlier ? " later" : earlier && !later ? " earlier" : "";
  const lead = many
    ? `Updated the dates of ${movedGiven === given.length ? subject : `${movedGiven} of ${given.length} tasks`}`
    : `Moved ${subject}`;
  const kept = leftAlone.length
    ? `${leftAlone.length} dependent ${plural(leftAlone.length, "task", "tasks")} ${plural(leftAlone.length, "was", "were")} left as ${plural(leftAlone.length, "it was", "they were")}${leftAlone.length === 1 && leftAlone[0].reason ? ` (${leftAlone[0].reason})` : ""}`
    : "";
  // Nothing else moved (Off, “Only move this task”, or no dependents): no news for one task.
  if (dependents.length === 0) return many ? lead : null;
  const deps = plural(dependents.length, "1 dependent task", `${dependents.length} dependent tasks`);
  const text = many ? `${lead} and moved ${deps}${way}` : `${lead} and ${deps}${way}`;
  return kept ? `${text}; ${kept}` : text;
}

// ---------------------------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------------------------

// Date changes that respect dependencies, both ways, the same everywhere (pane, subtasks, Calendar,
// Timeline, Workload, bulk due dates). The changed task moves on screen at once; then one server call
// (changeTaskDates) does what the project's Settings → Dependencies says:
//   Auto-shift  the task and every dependent move right away — later when it moves later, earlier
//               (keeping the gap) when it moves earlier — and the toast offers Undo;
//   Ask me      when dependents would move, nothing else changes until the person picks which ones in the
//               prompt (later and earlier the same way); otherwise the task just moves;
//   Off         only the task moves.
// Dependents that can't move (completed, or the person can't edit them) are listed and left alone.
export function useDependencyShift(): {
  changeDates: (task: { id: string; title: string }, dates: DateChange, options?: Options) => void;
  // Several tasks at once (a bulk due date). `plain` is kept for older callers and no longer run:
  // changeTaskDates applies the change itself.
  changeMany: (moves: ShiftMove[], subject: string, plain: (() => void) | null, options?: Options) => void;
  pending: boolean;
  dialog: ReactNode;
} {
  const notify = useNotify();
  const [pending, startShift] = useTransition();
  const [prompt, setPrompt] = useState<ShiftPrompt | null>(null);
  // An open prompt whose screen goes away counts as Cancel (so its held changes are let go).
  const openPrompt = useRef<ShiftPrompt | null>(null);
  useEffect(
    () => () => {
      openPrompt.current?.resolve("cancel");
    },
    [],
  );

  const undo = useCallback(
    (changes: ShiftChange[]) => {
      startTransition(async () => {
        const result = await undoDependencyShift(changes);
        invalidateTaskPanes();
        if (result.error) return notify(result.error);
        const restored = result.result?.restored.length ?? 0;
        const kept = result.result?.skipped ?? [];
        notify(
          kept.length === 0
            ? `Undone: ${restored === 1 ? "1 task is" : `${restored} tasks are`} back on their previous dates`
            : `Undid ${restored} of ${restored + kept.length}; ${kept.length === 1 ? "1 task" : `${kept.length} tasks`} changed since kept ${kept.length === 1 ? "its" : "their"} new dates`,
        );
      });
    },
    [notify],
  );

  // What a finished change says: dependents shown in their new place, Undo when they moved, tasks that
  // couldn't move dropped from the optimistic overlay.
  const report = useCallback(
    (moves: ShiftMove[], subject: string, result: ShiftResult, options: Options) => {
      const given = moves.map((m) => m.taskId);
      const givenSet = new Set(given);
      const { changes, skipped } = result;
      const dependents = changes.filter((c) => !givenSet.has(c.task_id));
      if (dependents.length) {
        startTransition(() =>
          options.onOptimistic?.(dependents.map((c) => ({ taskId: c.task_id, startOn: c.new_start_on, dueOn: c.new_due_on }))),
        );
      }
      if (skipped.length) dropTokenTasks(currentMutationToken(), skipped.map((s) => s.taskId));
      options.onResult?.({
        moved: changes.filter((c) => givenSet.has(c.task_id)).map((c) => c.task_id),
        skipped: skipped.filter((s) => givenSet.has(s.taskId)),
      });
      const text = shiftToastText({ subject, given, changes, skipped });
      if (text) notify(text, dependents.length ? { label: "Undo", onClick: () => undo(changes) } : undefined);
      invalidateTaskPanes();
    },
    [notify, undo],
  );

  const shift = useCallback(
    async (moves: ShiftMove[], subject: string, options: Options): Promise<boolean> => {
      const answer = await changeTaskDates(moves);
      if (answer.error || !answer.outcome) {
        notify(answer.error ?? "Couldn’t change the dates");
        options.onRevert?.();
        return false;
      }
      const outcome = answer.outcome;
      if (outcome.kind === "done") {
        report(moves, subject, outcome, options);
        return true;
      }

      // Ask me: keep the transition (and the optimistic position) while the person decides.
      options.onPrompt?.();
      const choice = await new Promise<ShiftChoice>((resolve) => {
        const next: ShiftPrompt = {
          subject,
          many: moves.length > 1,
          push: outcome.push,
          pull: outcome.pull,
          projectId: options.projectId ?? null,
          resolve: (value) => {
            openPrompt.current = null;
            resolve(value);
          },
        };
        openPrompt.current = next;
        setPrompt(next);
      });
      setPrompt(null);
      if (choice === "cancel") {
        options.onRevert?.();
        return false;
      }
      const confirmed = choice === "only" ? [] : choice.confirmed;
      const pull = choice !== "only" && choice.pull;
      if (confirmed.length) {
        const chosen = new Set(confirmed);
        const plan = movesOf(pull ? outcome.pull : outcome.push).filter((m) => chosen.has(m.taskId));
        startTransition(() => options.onOptimistic?.(plan.map((m) => ({ taskId: m.taskId, startOn: m.newStart, dueOn: m.newDue }))));
      }
      const applied = await applyDependencyShifts(moves, confirmed, pull);
      if (applied.error || !applied.result) {
        notify(applied.error ?? "Couldn’t change the dates");
        options.onRevert?.();
        return false;
      }
      // One task that couldn't move: say why and put it back.
      const refused = moves.length === 1 ? applied.result.skipped.find((s) => s.taskId === moves[0].taskId) : undefined;
      if (refused) {
        notify(refused.reason || "Your role doesn’t allow changing this task’s dates");
        options.onRevert?.();
        return false;
      }
      report(moves, subject, applied.result, options);
      return true;
    },
    [notify, report],
  );

  const changeDates = useCallback(
    (task: { id: string; title: string }, dates: DateChange, options: Options = {}) => {
      startShift(async () => {
        // The prompt outlives one transition. Hold the optimistic dates until the save lands, and drop
        // them if the person cancels or the database refuses.
        const held = holdTaskChanges();
        let ok = false;
        try {
          // Instant: the task moves on screen before the server answers.
          options.onOptimistic?.([{ taskId: task.id, ...dates }]);
          ok = await shift([{ taskId: task.id, ...dates }], `“${task.title}”`, options);
        } finally {
          if (ok) held.ok();
          else held.cancel();
        }
      });
    },
    [shift],
  );

  const changeMany = useCallback(
    // `plain` is accepted for compatibility only (see the type above).
    (moves: ShiftMove[], subject: string, _plain: (() => void) | null, options: Options = {}) => {
      startShift(async () => {
        const held = holdTaskChanges();
        let ok = false;
        try {
          // Moves that give both dates can be drawn at once.
          const full = moves.filter((m): m is MovedTask => m.startOn !== undefined && m.dueOn !== undefined);
          if (full.length) options.onOptimistic?.(full.map((m) => ({ taskId: m.taskId, startOn: m.startOn, dueOn: m.dueOn })));
          ok = await shift(moves, subject, options);
        } finally {
          if (ok) held.ok();
          else held.cancel();
        }
      });
    },
    [shift],
  );

  const dialog = prompt ? <ShiftDialog prompt={prompt} /> : null;
  return { changeDates, changeMany, pending, dialog };
}

// The Ask me prompt: later and earlier the same way — one list of what would move, each with a
// checkbox (all ticked), what won't, and a link to the project's setting.
export function ShiftDialog({ prompt }: { prompt: ShiftPrompt }) {
  const direction = shiftDirection(prompt.push, prompt.pull) ?? "later";
  const { plan } = primaryShiftPlan(prompt.push, prompt.pull);
  const moves = movesOf(plan);
  const skipped = plan.filter((r) => r.status === "skipped");
  const [checked, setChecked] = useState(() => new Set(moves.map((m) => m.taskId)));
  const chosen = moves.filter((m) => checked.has(m.taskId));
  const these = prompt.many ? "these tasks" : "this task";
  const { title, description } = shiftPromptText(
    direction,
    prompt.subject,
    { later: moves.filter((m) => m.shiftDays > 0).length, earlier: moves.filter((m) => m.shiftDays < 0).length },
    prompt.many,
  );
  const legend = direction === "later" ? "Will move later" : direction === "earlier" ? "Will move earlier" : "Will move";

  return (
    <Dialog title={title} description={description} onClose={() => prompt.resolve("cancel")} width="max-w-lg">
      {moves.length ? (
        <fieldset>
          <legend className="text-xs font-medium text-zinc-700">
            {legend} ({moves.length})
          </legend>
          <ul className="mt-1.5 max-h-60 divide-y divide-zinc-100 overflow-y-auto rounded-md border border-zinc-200">
            {moves.map((m) => (
              <li key={m.taskId}>
                <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5">
                  <input
                    type="checkbox"
                    className="size-3.5 accent-zinc-900"
                    checked={checked.has(m.taskId)}
                    onChange={(e) => {
                      const next = new Set(checked);
                      if (e.currentTarget.checked) next.add(m.taskId);
                      else next.delete(m.taskId);
                      setChecked(next);
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate text-zinc-800">{m.title}</span>
                  <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-zinc-500">
                    {span(m.startOn, m.dueOn)}
                    <ArrowRight className="size-3" aria-label="to" />
                    <span className="text-zinc-900">{span(m.newStart, m.newDue)}</span>
                    <span className={`chip ml-1 ${m.shiftDays < 0 ? "text-accent-700" : ""}`}>
                      {shiftLabel(m.shiftDays)}
                      <span className="sr-only">{m.shiftDays < 0 ? " earlier" : " later"}</span>
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}
      {skipped.length ? (
        <div className="mt-3">
          <h3 className="text-xs font-medium text-zinc-700">Won’t move ({skipped.length})</h3>
          <ul className="mt-1.5 divide-y divide-zinc-100 rounded-md border border-zinc-200">
            {skipped.map((s) => (
              <li key={s.taskId} className="flex items-center gap-2 px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate text-zinc-600">{s.title}</span>
                <span className="shrink-0 text-xs text-zinc-500">{s.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="mt-3 flex items-center gap-1.5 text-xs text-zinc-500">
        <Settings2 className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
        {prompt.projectId ? (
          <span>
            Change how this project handles this:{" "}
            <Link
              href={`/projects/${prompt.projectId}/settings#dependencies`}
              onClick={() => prompt.resolve("cancel")}
              className="font-medium text-accent-700 hover:underline"
            >
              Project settings → Dependencies
            </Link>
          </span>
        ) : (
          <span>Change how a project handles this in its Project settings → Dependencies.</span>
        )}
      </p>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={() => prompt.resolve("cancel")}>
          Cancel
        </button>
        <button type="button" className="btn-secondary" onClick={() => prompt.resolve("only")}>
          Only move {these}
        </button>
        {moves.length ? (
          <button
            type="button"
            className="btn-primary"
            data-autofocus
            disabled={chosen.length === 0}
            onClick={() =>
              prompt.resolve({ confirmed: chosen.map((m) => m.taskId), pull: chosen.some((m) => m.shiftDays < 0) })
            }
          >
            {shiftConfirmLabel(direction, chosen.length)}
          </button>
        ) : null}
      </div>
    </Dialog>
  );
}
