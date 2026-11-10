"use client";

import { useOptimistic } from "react";
import { Hash } from "lucide-react";
import { useServerAction } from "@/components/toast";
import { OPEN_CUSTOMIZE_EVENT, type OpenCustomizeDetail } from "@/components/project/customize-panel";
import { setDependencyShiftMode } from "@/lib/actions/dependencies";
import { nextTaskLabel } from "@alhc/core/customize";
import type { TaskNumbering } from "@alhc/core/request-numbers";
import { DEPENDENCY_SHIFT_MODES, DEPENDENCY_SHIFT_OPTIONS, type DependencyShiftMode } from "@alhc/core/dependencies";

// Settings → General → Task numbering (flaw audit C45): one editor for numbering, Customize → Task
// numbering. Here a short summary and a button that opens it.
export function TaskNumberingSummary({ projectId, numbering }: { projectId: string; numbering: TaskNumbering | null }) {
  const on = Boolean(numbering?.enabled);
  return (
    <section className="rounded-lg border border-zinc-200 p-5" aria-labelledby="numbering-summary-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="numbering-summary-heading" className="text-sm font-semibold text-zinc-900">
          Task numbering
        </h2>
        <button
          type="button"
          className="btn-secondary"
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent<OpenCustomizeDetail>(OPEN_CUSTOMIZE_EVENT, { detail: { projectId, view: "numbers" } }),
            )
          }
        >
          <Hash className="size-3.5" aria-hidden /> Change in Customize
        </button>
      </div>
      <p className="mt-1 text-sm text-zinc-600">
        {on && numbering
          ? `On. The next task gets ${nextTaskLabel(numbering)}.`
          : "Off. Turn it on to give each new task a number like Task #12."}
      </p>
    </section>
  );
}

// Settings → General → Dependencies (Oct 27 notes, batch 6): what happens to dependent tasks when a
// task's dates change — Auto-shift, Ask me (the default), or Off. Owners change it (the
// database refuses anyone else); everyone else sees it read-only. The prompt links here (#dependencies).
export function DependencyShiftSettings({
  projectId,
  mode,
  canEdit,
}: {
  projectId: string;
  mode: DependencyShiftMode;
  canEdit: boolean;
}) {
  const [pending, run] = useServerAction();
  const [current, setCurrent] = useOptimistic(mode);

  return (
    <section id="dependencies" className="scroll-mt-4 rounded-lg border border-zinc-200 p-5" aria-labelledby="dependencies-settings-heading">
      <h2 id="dependencies-settings-heading" className="text-sm font-semibold text-zinc-900">
        Dependencies
      </h2>
      <p className="mt-1 text-sm text-zinc-600">
        Tasks can wait on other tasks. When a task moves, the tasks that depend on it can move with it, later
        or earlier, keeping the same gap. This applies everywhere dates change: the task, Calendar, Workload,
        and bulk edits (Timeline drags use Shift / Alt instead).
      </p>
      <fieldset className="mt-3 min-w-0" disabled={!canEdit || pending} aria-describedby={canEdit ? undefined : "dependencies-read-only"}>
        <legend className="text-xs font-medium text-zinc-700">When a task’s dates change</legend>
        <div className="mt-1.5 flex flex-col gap-1.5">
          {DEPENDENCY_SHIFT_MODES.map((value) => {
            const option = DEPENDENCY_SHIFT_OPTIONS[value];
            const checked = current === value;
            return (
              <label
                key={value}
                className={`flex items-start gap-2.5 rounded-md border px-3 py-2 text-sm ${
                  checked ? "border-accent-300 bg-accent-50" : "border-zinc-200"
                } ${canEdit ? "cursor-pointer hover:border-zinc-300" : "cursor-default"}`}
              >
                <input
                  type="radio"
                  name="dependency-shift"
                  value={value}
                  checked={checked}
                  onChange={() => {
                    if (value === current) return;
                    run(
                      () => setDependencyShiftMode(projectId, value),
                      () => setCurrent(value),
                    );
                  }}
                  className="mt-0.5 size-4 accent-accent-600"
                />
                <span className="min-w-0">
                  <span className="font-medium text-zinc-900">
                    {option.label}
                    {value === "ask" ? <span className="ml-1.5 text-xs font-normal text-zinc-500">(default)</span> : null}
                  </span>
                  <span className="block text-xs text-zinc-600">{option.description}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      {canEdit ? null : (
        <p id="dependencies-read-only" className="mt-2 text-xs text-zinc-500">
          Only the project’s Owners change this.
        </p>
      )}
    </section>
  );
}
