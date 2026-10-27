"use client";

import { useOptimistic } from "react";
import { useServerAction } from "@/components/toast";
import { setDependencyShiftMode, updateProjectWorkflow } from "@/lib/actions";
import type { Project } from "@/lib/data";
import { DEPENDENCY_SHIFT_MODES, DEPENDENCY_SHIFT_OPTIONS, type DependencyShiftMode } from "@/lib/dependencies";

export function ProjectSettings({ project }: { project: Project }) {
  const [pending, run] = useServerAction();

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-gutter py-5">
      <section className="rounded-lg border border-zinc-200 p-5" aria-labelledby="approvals-settings-heading">
        <h2 id="approvals-settings-heading" className="text-sm font-semibold text-zinc-900">
          Approvals
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          Deciding an approval always records the decision and completes its approval subtask (when approved or
          rejected). Optionally, approving also completes the task itself.
        </p>
        <label className="mt-3 flex items-center gap-2 text-sm text-zinc-800">
          <input
            type="checkbox"
            defaultChecked={project.approval_completes_task}
            disabled={pending}
            onChange={(e) => {
              const approvalCompletesTask = e.currentTarget.checked;
              run(() => updateProjectWorkflow(project.id, { approvalCompletesTask }));
            }}
            className="size-4 accent-zinc-900"
          />
          Complete the task when an approval on it is approved
        </label>
      </section>
    </div>
  );
}

// Settings → General → Dependencies (Oct 27 notes, batch 6): what happens to dependent tasks when a
// task's dates change — Auto-shift, Ask me (the default), or Off. Admins and Owners change it (the
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
        or earlier, keeping the same gap. This applies everywhere dates change: the task, Calendar, Timeline,
        Workload, and bulk edits.
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
          Only the project’s Admins and Owners change this.
        </p>
      )}
    </section>
  );
}
