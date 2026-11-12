"use client";

// The Ask me prompt of a date change (dependency-shift.tsx), split out in Nov 12 notes (batch 40, item 7)
// so it loads with the screens that change dates instead of with every signed-in page.
import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Settings2 } from "lucide-react";
import { Dialog } from "@/components/dialog";
import { shiftLabel } from "@alhc/core/dependencies";
import {
  movesOf,
  primaryShiftPlan,
  shiftConfirmLabel,
  shiftDirection,
  shiftPromptText,
  span,
  type ShiftPrompt,
} from "./dependency-shift";

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
