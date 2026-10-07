"use client";

import { startTransition, useCallback, useState, useTransition, type ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { Dialog } from "@/components/dialog";
import { useNotify } from "@/components/toast";
import { applyDependencyShift, previewDependencyShift, undoDependencyShift, updateTask } from "@/lib/actions";
import { shiftLabel, type ShiftChange, type ShiftPlanRow } from "@/lib/dependencies";

export type DateChange = { startOn: string | null; dueOn: string | null };
export type MovedTask = { taskId: string } & DateChange;

type Options = {
  // Called inside the transition with the tasks about to move (the task itself first), for optimistic UI.
  onOptimistic?: (moves: MovedTask[]) => void;
  // Called when the change didn't happen (cancelled or refused), e.g. to reset an input.
  onRevert?: () => void;
};

type Prompt = {
  title: string;
  plan: ShiftPlanRow[];
  resolve: (choice: { confirmed: string[] } | "only" | "cancel") => void;
};

function shortDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function span(start: string | null, due: string | null) {
  if (start && due && start !== due) return `${shortDate(start)} – ${shortDate(due)}`;
  return shortDate(due ?? start);
}

// Date changes that respect dependencies. When moving a task later would break the start of tasks that
// depend on it (by kind and lag, transitively), the person sees which ones would move — and which are
// skipped (completed, or they can't edit them) — and confirms before anything shifts; the result toast
// offers Undo, which puts every moved date back. Without such dependents it is a plain date change.
export function useDependencyShift(): {
  changeDates: (task: { id: string; title: string }, dates: DateChange, options?: Options) => void;
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

  const changeDates = useCallback(
    (task: { id: string; title: string }, dates: DateChange, options: Options = {}) => {
      startShift(async () => {
        options.onOptimistic?.([{ taskId: task.id, ...dates }]);
        const preview = await previewDependencyShift(task.id, dates);
        if (preview.error) {
          notify(preview.error);
          options.onRevert?.();
          return;
        }
        const plan = preview.data ?? [];
        const moves = plan.filter((r) => r.status === "move");
        if (moves.length === 0) {
          const result = await updateTask(task.id, dates);
          if (result.error) {
            notify(result.error);
            options.onRevert?.();
          }
          return;
        }

        // Keep the transition (and the optimistic position) while the person decides.
        const choice = await new Promise<{ confirmed: string[] } | "only" | "cancel">((resolve) =>
          setPrompt({ title: task.title, plan, resolve }),
        );
        setPrompt(null);
        if (choice === "cancel") {
          options.onRevert?.();
          return;
        }
        if (choice === "only") {
          const result = await updateTask(task.id, dates);
          if (result.error) {
            notify(result.error);
            options.onRevert?.();
          }
          return;
        }
        const confirmed = new Set(choice.confirmed);
        startTransition(() =>
          options.onOptimistic?.([
            { taskId: task.id, ...dates },
            ...moves.filter((m) => confirmed.has(m.taskId)).map((m) => ({ taskId: m.taskId, startOn: m.newStart, dueOn: m.newDue })),
          ]),
        );
        const result = await applyDependencyShift(task.id, dates, choice.confirmed);
        if (result.error) {
          notify(result.error);
          options.onRevert?.();
          return;
        }
        const changes = result.result?.changes ?? [];
        const moved = Math.max(0, changes.length - 1);
        const skipped = result.result?.skipped.length ?? 0;
        notify(
          `Moved “${task.title}” and ${moved === 1 ? "1 dependent task" : `${moved} dependent tasks`}${
            skipped ? ` (${skipped} left as ${skipped === 1 ? "it was" : "they were"})` : ""
          }`,
          changes.length ? { label: "Undo", onClick: () => undo(changes) } : undefined,
        );
      });
    },
    [notify, undo],
  );

  const dialog = prompt ? <ShiftDialog prompt={prompt} /> : null;
  return { changeDates, pending, dialog };
}

function ShiftDialog({ prompt }: { prompt: Prompt }) {
  const moves = prompt.plan.filter((r) => r.status === "move");
  const skipped = prompt.plan.filter((r) => r.status === "skipped");
  const [checked, setChecked] = useState(() => new Set(moves.map((m) => m.taskId)));
  const count = checked.size;

  return (
    <Dialog
      title="Move dependent tasks too?"
      description={`Moving “${prompt.title}” later would start ${
        moves.length === 1 ? "a task that depends on it" : `${moves.length} tasks that depend on it`
      } too early. Nothing moves until you choose.`}
      onClose={() => prompt.resolve("cancel")}
      width="max-w-lg"
    >
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
        <button type="button" className="btn-secondary" onClick={() => prompt.resolve("only")}>
          Only move this task
        </button>
        <button
          type="button"
          className="btn-primary"
          data-autofocus
          disabled={count === 0}
          onClick={() => prompt.resolve({ confirmed: [...checked] })}
        >
          Move {count === 1 ? "1 dependent" : `${count} dependents`} too
        </button>
      </div>
    </Dialog>
  );
}
