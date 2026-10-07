"use client";

import { startTransition, useCallback, useState, useTransition, type ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { Dialog } from "@/components/dialog";
import { useNotify } from "@/components/toast";
import { applyDependencyShifts, previewDependencyShifts, undoDependencyShift, updateTask } from "@/lib/actions";
import { shiftLabel, type ShiftChange, type ShiftMove, type ShiftPlanRow } from "@/lib/dependencies";

export type DateChange = { startOn: string | null; dueOn: string | null };
export type MovedTask = { taskId: string } & DateChange;

type Options = {
  // Called inside the transition with the tasks about to move (the task itself first), for optimistic UI.
  onOptimistic?: (moves: MovedTask[]) => void;
  // Called when the change didn't happen (cancelled or refused), e.g. to reset an input.
  onRevert?: () => void;
};

type Choice = { confirmed: string[]; pull: boolean } | "only" | "cancel";

type Prompt = {
  // “Spring flyer”, or “8 tasks” for a bulk change.
  subject: string;
  many: boolean;
  push: ShiftPlanRow[];
  pull: ShiftPlanRow[];
  resolve: (choice: Choice) => void;
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
// The pull-earlier plan only matters when it pulls something earlier.
const pullAdds = (pull: ShiftPlanRow[]) => movesOf(pull).some((r) => r.shiftDays < 0);

// Date changes that respect dependencies. When moving tasks later would break the start of tasks that
// depend on them (by kind and lag, transitively), the person sees which ones would move — and which are
// skipped (completed, or they can't edit them) — and confirms before anything shifts. When a task moves
// earlier, the same prompt offers to pull its dependents earlier too (keeping the gap); nothing is pulled
// unless they tick it. The result toast offers Undo, which puts every moved date back. Without such
// dependents it is a plain date change.
export function useDependencyShift(): {
  changeDates: (task: { id: string; title: string }, dates: DateChange, options?: Options) => void;
  // Several tasks at once (a bulk due date). plain runs the change without shifting anything (no
  // dependents to move, or the person chose “Only move these tasks”).
  changeMany: (moves: ShiftMove[], subject: string, plain: () => void, options?: Options) => void;
  pending: boolean;
  dialog: ReactNode;
} {
  const notify = useNotify();
  const [pending, startShift] = useTransition();
  const [prompt, setPrompt] = useState<Prompt | null>(null);

  const undo = useCallback(
    (changes: ShiftChange[]) => {
      startTransition(async () => {
        const result = await undoDependencyShift(changes);
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

  // Preview (push, and pull earlier), ask when something would move, then apply or fall back to plain.
  const shift = useCallback(
    async (
      moves: ShiftMove[],
      subject: string,
      plain: () => Promise<boolean>,
      options: Options,
    ) => {
      const [push, pull] = await Promise.all([previewDependencyShifts(moves, false), previewDependencyShifts(moves, true)]);
      if (push.error) {
        notify(push.error);
        options.onRevert?.();
        return;
      }
      const pushPlan = push.data ?? [];
      const pullPlan = pull.data ?? [];
      if (movesOf(pushPlan).length === 0 && !pullAdds(pullPlan)) {
        if (!(await plain())) options.onRevert?.();
        return;
      }

      // Keep the transition (and the optimistic position) while the person decides.
      const choice = await new Promise<Choice>((resolve) =>
        setPrompt({
          subject,
          many: moves.length > 1,
          push: pushPlan,
          pull: pullAdds(pullPlan) ? pullPlan : [],
          resolve,
        }),
      );
      setPrompt(null);
      if (choice === "cancel") {
        options.onRevert?.();
        return;
      }
      if (choice === "only" || choice.confirmed.length === 0) {
        if (!(await plain())) options.onRevert?.();
        return;
      }
      const confirmed = new Set(choice.confirmed);
      const planned = movesOf(choice.pull ? pullPlan : pushPlan);
      startTransition(() =>
        options.onOptimistic?.(
          planned
            .filter((m) => confirmed.has(m.taskId))
            .map((m) => ({ taskId: m.taskId, startOn: m.newStart, dueOn: m.newDue })),
        ),
      );
      const result = await applyDependencyShifts(moves, choice.confirmed, choice.pull);
      if (result.error) {
        notify(result.error);
        options.onRevert?.();
        return;
      }
      const changes = result.result?.changes ?? [];
      const given = new Set(moves.map((m) => m.taskId));
      const moved = changes.filter((c) => !given.has(c.task_id)).length;
      const skipped = result.result?.skipped.length ?? 0;
      notify(
        `Moved ${subject} and ${moved === 1 ? "1 dependent task" : `${moved} dependent tasks`}${
          skipped ? ` (${skipped} left as ${skipped === 1 ? "it was" : "they were"})` : ""
        }`,
        changes.length ? { label: "Undo", onClick: () => undo(changes) } : undefined,
      );
    },
    [notify, undo],
  );

  const changeDates = useCallback(
    (task: { id: string; title: string }, dates: DateChange, options: Options = {}) => {
      startShift(async () => {
        options.onOptimistic?.([{ taskId: task.id, ...dates }]);
        await shift([{ taskId: task.id, ...dates }], `“${task.title}”`, async () => {
          const result = await updateTask(task.id, dates);
          if (result.error) notify(result.error);
          return !result.error;
        }, options);
      });
    },
    [notify, shift],
  );

  const changeMany = useCallback(
    (moves: ShiftMove[], subject: string, plain: () => void, options: Options = {}) => {
      startShift(async () => {
        await shift(moves, subject, async () => {
          plain();
          return true;
        }, options);
      });
    },
    [shift],
  );

  const dialog = prompt ? <ShiftDialog prompt={prompt} /> : null;
  return { changeDates, changeMany, pending, dialog };
}

function ShiftDialog({ prompt }: { prompt: Prompt }) {
  const canPull = prompt.pull.length > 0;
  const pushMoves = movesOf(prompt.push);
  const [pull, setPull] = useState(false);
  const plan = pull ? prompt.pull : prompt.push;
  const moves = movesOf(plan);
  const skipped = plan.filter((r) => r.status === "skipped");
  const [checked, setChecked] = useState(() => new Set(pushMoves.map((m) => m.taskId)));
  const count = moves.filter((m) => checked.has(m.taskId)).length;
  const these = prompt.many ? "these tasks" : "this task";

  function togglePull(next: boolean) {
    setPull(next);
    setChecked(new Set(movesOf(next ? prompt.pull : prompt.push).map((m) => m.taskId)));
  }

  return (
    <Dialog
      title={pushMoves.length ? "Move dependent tasks too?" : "Pull dependent tasks earlier?"}
      description={
        pushMoves.length
          ? `Moving ${prompt.subject} later would start ${
              pushMoves.length === 1 ? "a task that depends on it" : `${pushMoves.length} tasks that depend on it`
            } too early. Nothing moves until you choose.`
          : `Moving ${prompt.subject} earlier leaves a gap before the tasks that depend on it. They stay put unless you pull them earlier too.`
      }
      onClose={() => prompt.resolve("cancel")}
      width="max-w-lg"
    >
      {canPull ? (
        <label className="mb-3 flex items-start gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700">
          <input
            type="checkbox"
            className="mt-0.5 size-3.5 accent-zinc-900"
            checked={pull}
            onChange={(e) => togglePull(e.currentTarget.checked)}
          />
          <span>
            Also pull dependents earlier (keep the gap)
            <span className="block text-xs text-zinc-500">
              Each moves earlier by as much as the task it waits on, never before its other links allow.
            </span>
          </span>
        </label>
      ) : null}
      {moves.length ? (
        <fieldset>
          <legend className="text-xs font-medium text-zinc-700">Will move ({moves.length})</legend>
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
                    <span className="chip ml-1">{shiftLabel(m.shiftDays)}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : (
        <p className="text-sm text-zinc-500">Tick the option above to see which tasks would be pulled earlier.</p>
      )}
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
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={() => prompt.resolve("cancel")}>
          Cancel
        </button>
        {moves.length ? (
          <>
            <button type="button" className="btn-secondary" onClick={() => prompt.resolve("only")}>
              Only move {these}
            </button>
            <button
              type="button"
              className="btn-primary"
              data-autofocus
              disabled={count === 0}
              onClick={() => prompt.resolve({ confirmed: moves.filter((m) => checked.has(m.taskId)).map((m) => m.taskId), pull })}
            >
              {pull ? "Pull" : "Move"} {count === 1 ? "1 dependent" : `${count} dependents`} too
            </button>
          </>
        ) : (
          <button type="button" className="btn-primary" data-autofocus onClick={() => prompt.resolve("only")}>
            Move {these}
          </button>
        )}
      </div>
    </Dialog>
  );
}
