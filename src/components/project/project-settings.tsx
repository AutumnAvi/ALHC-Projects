"use client";

import { useState } from "react";
import { useServerAction } from "@/components/toast";
import { saveRequestNumbering, updateProjectWorkflow } from "@/lib/actions";
import type { Project, RequestSequence } from "@/lib/data";

const inputClass =
  "rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm focus:border-accent-500 focus:outline-none";

function preview(prefix: string, pad: number, n: number) {
  return `${prefix}${String(n).padStart(pad, "0")}`;
}

export function ProjectSettings({
  project,
  sequence,
}: {
  project: Project;
  sequence: RequestSequence | null;
}) {
  const [pending, run] = useServerAction();
  const [enabled, setEnabled] = useState(sequence?.enabled ?? false);
  const [prefix, setPrefix] = useState(sequence?.prefix ?? "Req #");
  const [padWidth, setPadWidth] = useState(sequence?.pad_width ?? 0);
  const [addToTitle, setAddToTitle] = useState(sequence?.add_to_title ?? true);
  const [assignTo, setAssignTo] = useState<"all_tasks" | "form_submissions">(
    (sequence?.assign_to as "all_tasks" | "form_submissions") ?? "form_submissions",
  );
  const lastNumber = sequence?.last_number ?? 0;
  const [nextNumber, setNextNumber] = useState(String(lastNumber + 1));
  const next = Number.parseInt(nextNumber, 10);

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-gutter py-5">
      <section className="rounded-lg border border-zinc-200 p-5" aria-labelledby="req-heading">
        <h2 id="req-heading" className="text-sm font-semibold text-zinc-900">
          Request numbers
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          Give tasks in this project a sequential number like{" "}
          <span className="font-medium text-zinc-900">{preview(prefix, padWidth, Math.max(lastNumber + 1, 1))}</span>.
          Numbers are unique per project, assigned atomically, and never reused.
        </p>
        <form
          className="mt-4 grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(() =>
              saveRequestNumbering(project.id, {
                enabled,
                prefix,
                padWidth,
                addToTitle,
                assignTo,
                nextNumber: Number.isInteger(next) && next !== lastNumber + 1 ? next : null,
              }),
            );
          }}
        >
          <label className="flex items-center gap-2 text-sm text-zinc-800 sm:col-span-2">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.currentTarget.checked)}
              className="size-4 accent-zinc-900"
            />
            Number requests in this project
          </label>
          <div className="flex flex-col gap-1">
            <label htmlFor="req-prefix" className="text-xs font-medium text-zinc-600">
              Prefix
            </label>
            <input
              id="req-prefix"
              value={prefix}
              maxLength={20}
              onChange={(e) => setPrefix(e.currentTarget.value)}
              className={inputClass}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="req-pad" className="text-xs font-medium text-zinc-600">
              Minimum digits
            </label>
            <input
              id="req-pad"
              type="number"
              min={0}
              max={8}
              value={padWidth}
              onChange={(e) => setPadWidth(Math.min(8, Math.max(0, Number(e.currentTarget.value) || 0)))}
              className={inputClass}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="req-scope" className="text-xs font-medium text-zinc-600">
              Number
            </label>
            <select
              id="req-scope"
              value={assignTo}
              onChange={(e) => setAssignTo(e.currentTarget.value as "all_tasks" | "form_submissions")}
              className={inputClass}
            >
              <option value="form_submissions">Form submissions only</option>
              <option value="all_tasks">Every new task</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="req-next" className="text-xs font-medium text-zinc-600">
              Next number
            </label>
            <input
              id="req-next"
              type="number"
              min={lastNumber + 1}
              value={nextNumber}
              onChange={(e) => setNextNumber(e.currentTarget.value)}
              className={inputClass}
            />
            <span className="text-xs text-zinc-500">
              {lastNumber > 0 ? `Last issued: ${preview(prefix, padWidth, lastNumber)}. ` : ""}Numbers can only move
              forward.
            </span>
          </div>
          <label className="flex items-center gap-2 text-sm text-zinc-800 sm:col-span-2">
            <input
              type="checkbox"
              checked={addToTitle}
              onChange={(e) => setAddToTitle(e.currentTarget.checked)}
              className="size-4 accent-zinc-900"
            />
            Add “[{preview(prefix, padWidth, Math.max(lastNumber + 1, 1))}]” to the start of the task name
          </label>
          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={pending}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              Save numbering
            </button>
          </div>
        </form>
      </section>

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
